#!/usr/bin/env bash
#
# Close out ADR-0003 Phase 2 and re-check Phase 3, on a real Linux box.
#
# =============================================================================================
# READ THIS BEFORE RUNNING IT ON A REMOTE SERVER
#
# The TUN test takes over the machine's default route. If you are connected over SSH and it
# goes wrong, you lose the box until someone reboots it from a console.
#
# Three things in this script exist only because of that, and none of them should be removed:
#
#   1. A DEADMAN SWITCH is armed the instant nexusd starts, targeted at that exact pid. It is
#      detached with setsid, so it survives your SSH session dying, and it kills nexusd after
#      --deadman seconds (default 90) whatever else happens. Total loss of the connection
#      self-heals. It targets a pid rather than the process name so it cannot take down an
#      unrelated nexusd the machine was legitimately running.
#
#   2. The default test routes `final: direct`, NOT through a proxy. The tun comes up,
#      auto_route captures traffic, and sing-box sends it straight back out the real
#      interface. That proves exactly what Phase 2 asks - "a TUN comes up and traffic flows
#      through it" - WITHOUT depending on a reachable proxy server. testdata/desktop/
#      tun-desktop.json points at example.com with a placeholder UUID; routing everything
#      into it would black-hole the box, SSH included.
#
#   3. Routing state is snapshotted before and diffed after, so "it came back" is checked
#      rather than assumed.
#
# To run the real-proxy test, pass --config <your.json> --i-have-console-access. That flag is
# not decoration: use it only when you can reach the machine without the network.
# =============================================================================================
set -uo pipefail

DEADMAN=90
MODE=all
CONFIG=""
CONSOLE_ACCESS=0
BIN_DIR="$(cd "$(dirname "$0")" && pwd)"

usage() {
    cat <<'USAGE'
verify-desktop-linux.sh [options] [all|ipc|tun]

  all   (default) the IPC contract, then the TUN test
  ipc   nexusd serve + nexusctl verify. No privileges, no routing changes, safe anywhere.
  tun   bring a real TUN up and prove traffic traverses it. NEEDS ROOT.

Options:
  --deadman <seconds>        auto-kill after N seconds (default 90, 0 disables - do not)
  --config <file>            use your own config instead of the generated direct-route one
  --i-have-console-access    required with --config; acknowledges you can recover the box
  --bin-dir <dir>            where nexusd / nexusctl live (default: this script's directory)

Examples:
  sudo ./verify-desktop-linux.sh ipc
  sudo ./verify-desktop-linux.sh tun
  sudo ./verify-desktop-linux.sh --config real.json --i-have-console-access tun
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        --deadman) DEADMAN="$2"; shift 2 ;;
        --config) CONFIG="$2"; shift 2 ;;
        --i-have-console-access) CONSOLE_ACCESS=1; shift ;;
        --bin-dir) BIN_DIR="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        all|ipc|tun) MODE="$1"; shift ;;
        *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
    esac
done

NEXUSD="$BIN_DIR/nexusd"
NEXUSCTL="$BIN_DIR/nexusctl"
WORK="$(mktemp -d)"
DEADMAN_PID=""
PASS=0
FAIL=0

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; FAIL=$((FAIL+1)); }
note() { printf '        %s\n' "$*"; }

# Kill only what this script started.
#
# An earlier draft used `pkill -x nexusd`, which would also kill a nexusd the machine was
# legitimately running - taking down someone's tunnel because a test script exited. Track PIDs
# instead.
CHILD_PIDS=""

cleanup() {
    for pid in $CHILD_PIDS; do
        kill -TERM "$pid" 2>/dev/null
    done
    sleep 1
    for pid in $CHILD_PIDS; do
        kill -KILL "$pid" 2>/dev/null
    done
    [ -n "$DEADMAN_PID" ] && kill "$DEADMAN_PID" 2>/dev/null
    rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------------------
preflight() {
    say "Preflight"

    for binary in "$NEXUSD" "$NEXUSCTL"; do
        if [ -x "$binary" ]; then
            ok "$(basename "$binary") present ($("$binary" version 2>/dev/null | head -1))"
        else
            bad "$binary is missing or not executable"
            note "build with: TARGETS=linux/amd64 ./scripts/build-desktop.sh"
            note "then scp build/desktop/nexusd-linux-amd64 to this box as 'nexusd'"
            exit 1
        fi
    done

    for tool in ip curl; do
        command -v "$tool" >/dev/null 2>&1 && ok "$tool available" || { bad "$tool is required"; exit 1; }
    done

    if [ -n "${SSH_CONNECTION:-}" ]; then
        note ""
        note "You are on SSH. The TUN test will take over this machine's default route."
        note "The deadman switch is set to ${DEADMAN}s and survives your session dying."
        note ""
    fi
}

require_root() {
    if [ "$(id -u)" -ne 0 ]; then
        bad "the TUN test needs root (creating a tun device and editing routes)"
        note "re-run with sudo, or grant the binary: setcap cap_net_admin,cap_net_raw+eip $NEXUSD"
        exit 1
    fi
    [ -c /dev/net/tun ] && ok "/dev/net/tun present" || { bad "/dev/net/tun missing - load the tun module"; exit 1; }
}

# arm_deadman <pid>
#
# Armed immediately after nexusd starts and targeted at that exact process, so it cannot take
# an unrelated daemon with it. The gap between exec and arming is milliseconds, and nexusd has
# not installed a route yet in that window - it is still parsing the config.
arm_deadman() {
    local target="$1"
    [ "$DEADMAN" -eq 0 ] && { note "deadman DISABLED - you are on your own"; return; }

    # setsid detaches it from this shell AND from the SSH session, so it still fires if the
    # connection drops. TERM first so nexusd can unwind its own routes; KILL is the backstop
    # for a teardown that has itself wedged.
    setsid sh -c "sleep $DEADMAN; kill -TERM $target 2>/dev/null; sleep 5; kill -KILL $target 2>/dev/null" \
        >/dev/null 2>&1 &
    DEADMAN_PID=$!
    ok "deadman armed on pid $target: dies in ${DEADMAN}s even if this session does"
}

# ---------------------------------------------------------------------------------------
# IPC contract  (safe: no privileges, no routing)
# ---------------------------------------------------------------------------------------
run_ipc() {
    say "IPC contract (Phase 3)"

    local socket="$WORK/nexusd.sock"
    "$NEXUSD" serve -s "$socket" -state "$WORK/state" >"$WORK/serve.log" 2>&1 &
    local pid=$!
    CHILD_PIDS="$CHILD_PIDS $pid"

    for _ in $(seq 1 30); do [ -S "$socket" ] && break; sleep 0.2; done

    if ! [ -S "$socket" ]; then
        bad "the daemon never created its socket"
        sed 's/^/        /' "$WORK/serve.log"
        return
    fi
    ok "daemon listening on a unix socket"

    # THE POINT OF RUNNING THIS HERE. Every check passed on Windows, where the socket is
    # AF_UNIX-on-Win32. This is the first time the same code meets a real unix socket, real
    # file permissions, and a real peer.
    if "$NEXUSCTL" -s "$socket" verify 2>&1 | sed 's/^/        /'; then
        ok "nexusctl verify"
    else
        bad "nexusctl verify reported failures"
    fi

    local mode
    mode=$(stat -c '%a' "$socket" 2>/dev/null)
    [ "$mode" = "600" ] && ok "socket is 0600 (owner only)" \
                        || bad "socket mode is $mode, expected 600"

    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
}

# ---------------------------------------------------------------------------------------
# TUN
# ---------------------------------------------------------------------------------------

# A config that brings a TUN up and routes straight back out.
#
# No proxy outbound, so there is nothing to be unreachable. auto_route still captures the
# machine's traffic and sing-box still has to carry every packet through the tun device and
# out again - which is precisely the thing Phase 2 has not yet proven works.
write_direct_config() {
    cat >"$WORK/tun-direct.json" <<'JSON'
{
  "log": { "level": "info", "timestamp": true },
  "inbounds": [
    {
      "type": "tun",
      "tag": "tun-in",
      "interface_name": "nexus-verify0",
      "address": ["172.19.0.1/30"],
      "mtu": 1500,
      "auto_route": true,
      "strict_route": false,
      "stack": "system"
    }
  ],
  "outbounds": [ { "type": "direct", "tag": "direct" } ],
  "route": { "rules": [{ "action": "sniff" }], "final": "direct" }
}
JSON
    echo "$WORK/tun-direct.json"
}

snapshot_routes() { ip route show; ip rule show 2>/dev/null; }

run_tun() {
    say "TUN bring-up (Phase 2 acceptance)"
    require_root

    local config
    if [ -n "$CONFIG" ]; then
        if [ "$CONSOLE_ACCESS" -ne 1 ]; then
            bad "--config needs --i-have-console-access"
            note "your config routes through a proxy; if that proxy is unreachable this box"
            note "loses its network until the deadman fires or someone reboots it"
            return
        fi
        config="$CONFIG"
        note "using YOUR config: $config"
    else
        config=$(write_direct_config)
        note "using a generated direct-route config (safe; proves the tun, not a proxy)"
    fi

    if ! "$NEXUSD" check -c "$config" >"$WORK/check.log" 2>&1; then
        bad "nexusd check rejected the config"
        sed 's/^/        /' "$WORK/check.log"
        return
    fi
    ok "config validates"

    snapshot_routes >"$WORK/routes.before"
    local links_before; links_before=$(ip -o link show | wc -l)

    "$NEXUSD" run -c "$config" >"$WORK/run.log" 2>&1 &
    local pid=$!
    CHILD_PIDS="$CHILD_PIDS $pid"
    arm_deadman "$pid"

    local up=0
    for _ in $(seq 1 50); do
        if ip link show nexus-verify0 >/dev/null 2>&1 || [ "$(ip -o link show | wc -l)" -gt "$links_before" ]; then
            up=1; break
        fi
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.2
    done

    if [ "$up" -ne 1 ]; then
        bad "no TUN device appeared"
        note "this is THE Phase 2 question - the log follows"
        sed 's/^/        /' "$WORK/run.log" | tail -25
        kill "$pid" 2>/dev/null
        return
    fi

    local tun
    tun=$(ip -o link show | awk -F': ' '{print $2}' | grep -E '^(nexus-verify0|tun[0-9]+|utun[0-9]+)$' | head -1)
    ok "TUN device up: $tun"
    ip -o addr show "$tun" 2>/dev/null | sed 's/^/        /'

    if ip route show | grep -q "$tun"; then
        ok "routes point at the tun"
        ip route show | grep "$tun" | sed 's/^/        /'
    else
        bad "no route references $tun - auto_route did not take"
    fi

    # THE ACTUAL ACCEPTANCE TEST: bytes move THROUGH the device, not merely past it.
    #
    # A curl that succeeds proves the box still has network; it does not prove the packets
    # went through the tun. The device's own RX counter is what proves that, so it is read
    # before and after.
    local rx_before rx_after
    rx_before=$(cat "/sys/class/net/$tun/statistics/rx_bytes" 2>/dev/null || echo 0)

    if curl -s --max-time 20 -o /dev/null -w '        HTTP %{http_code} in %{time_total}s\n' https://example.com; then
        ok "traffic flows while the tunnel is up"
    else
        bad "no traffic - the tun captured the route but did not carry packets"
    fi

    rx_after=$(cat "/sys/class/net/$tun/statistics/rx_bytes" 2>/dev/null || echo 0)
    if [ "$rx_after" -gt "$rx_before" ]; then
        ok "packets traversed $tun (rx $rx_before -> $rx_after bytes)"
    else
        bad "$tun rx counter did not move - traffic went around the tunnel, not through it"
    fi

    say "Teardown"
    kill -TERM "$pid" 2>/dev/null
    local stopped=0
    for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || { stopped=1; break; }; sleep 0.25; done

    if [ "$stopped" -eq 1 ]; then
        ok "nexusd exited on SIGTERM"
    else
        bad "nexusd did not exit within 15s - the deadman will handle it"
        kill -KILL "$pid" 2>/dev/null
    fi

    sleep 1
    ip link show "$tun" >/dev/null 2>&1 && bad "$tun still exists after shutdown" \
                                        || ok "$tun removed"

    snapshot_routes >"$WORK/routes.after"
    if diff -q "$WORK/routes.before" "$WORK/routes.after" >/dev/null; then
        ok "routing table restored exactly"
    else
        bad "routing table differs after teardown - this is the stale-route hazard (ADR-0003 §4.3)"
        diff "$WORK/routes.before" "$WORK/routes.after" | sed 's/^/        /'
    fi

    if curl -s --max-time 15 -o /dev/null https://example.com; then
        ok "network works after teardown"
    else
        bad "NO NETWORK AFTER TEARDOWN - reboot to recover"
    fi

    [ -n "$DEADMAN_PID" ] && kill "$DEADMAN_PID" 2>/dev/null && DEADMAN_PID=""
    note "log: $WORK/run.log (this directory is removed on exit; copy it if you need it)"
    tail -15 "$WORK/run.log" | sed 's/^/        /'
}

# ---------------------------------------------------------------------------------------

preflight
case "$MODE" in
    ipc) run_ipc ;;
    tun) run_tun ;;
    all) run_ipc; run_tun ;;
esac

say "Result"
printf '  %d passed, %d failed\n\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
