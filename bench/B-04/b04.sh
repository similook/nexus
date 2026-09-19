#!/usr/bin/env bash
#
# B-04 — what the gVisor TUN stack costs.
#
# Run `./b04.sh doctor` first. It checks the device can actually be measured and tells you
# what to fix if not.
#
# See README.md in this directory for the methodology and, more importantly, for what these
# numbers do and do not support.

set -uo pipefail

# Git Bash rewrites anything that looks like a Unix path into a Windows one, which turns
# /data/local/tmp into C:/Program Files/Git/data/local/tmp and produces a confusing
# "No such file or directory" from the device rather than from the host.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

ADB="${ADB:-adb}"
PKG="${PKG:-io.nexus.app}"
CORE_PROC="${PKG}:core"
DEV_DIR=/data/local/tmp
RESULTS="$(cd "$(dirname "$0")" && pwd)/results"

SAMPLE_INTERVAL="${SAMPLE_INTERVAL:-5}"

# How often a delta (screen-off) arm takes an intermediate contamination probe. Must be a
# multiple of 30, which is the resolution of the wait loop.
DELTA_PROBE_S="${DELTA_PROBE_S:-120}"

say()  { printf '%s\n' "$*"; }
warn() { printf '  !! %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

adbsh() { "$ADB" shell "$@"; }

# Host paths need the OPPOSITE treatment to device paths.
#
# MSYS_NO_PATHCONV above stops Git Bash mangling /data/local/tmp into
# C:/Program Files/Git/data/local/tmp, which is required or the device never sees the right
# filename. But adb.exe is a WINDOWS binary, so any HOST path handed to it has to be in
# Windows form - and with conversion disabled it arrives as /c/app/... which Windows cannot
# resolve.
#
# So: device paths pass through untouched, host paths go through cygpath. Both directions,
# one helper.
#
# Symptom when this is missing: the sampler runs perfectly, the CSV exists on the device, and
# the run dies at `adb push`/`adb pull` - at the START of an arm, or worse, at the very END of
# a 30-minute one.
#
# `command -v` rather than assuming cygpath: this script should also work from WSL, macOS and
# Linux, where paths are already correct and no conversion is wanted.
hostpath() {
    if command -v cygpath >/dev/null 2>&1; then
        cygpath -w "$1"
    else
        printf '%s' "$1"
    fi
}

# One CSV row of every counter, read in a SINGLE adb round trip.
#
# WHY THIS EXISTS AT ALL
#
# The on-device sampler loop does not survive an idle arm. Unplugged with the screen off,
# Android suspends the application processor; a shell `sleep` holds no wakelock, so the whole
# sampler freezes with it. A 5-minute arm came back with ONE sample instead of sixty - the
# script reported success and the data was worthless.
#
# Waking the device 60 times to sample it would also defeat the point: the thing being
# measured is what the phone draws when nothing is happening, and a sampler that prevents
# sleep measures a phone that never sleeps.
#
# So idle arms are measured by DIFFERENCE, not by averaging samples. Two reads, far apart,
# with the device left alone in between. Every metric here is a monotonic counter, so a delta
# across the window is exactly as accurate as summing a thousand samples would have been.
snapshot() {
    "$ADB" shell '
        BAT=$(dumpsys battery 2>/dev/null | head -22)
        UAH=$(echo "$BAT" | grep "Charge counter" | tr -dc "0-9")
        MV=$(echo "$BAT" | grep "^  voltage:" | tr -dc "0-9")
        TUN=$(grep -E "^[[:space:]]*tun[0-9]+:" /proc/net/dev 2>/dev/null | head -1)
        if [ -n "$TUN" ]; then
            RX=$(echo "$TUN" | awk "{gsub(/.*:/,\"\",\$1); print \$2}")
            TX=$(echo "$TUN" | awk "{print \$10}")
        else
            RX=0; TX=0
        fi
        PID=$(pidof '"$CORE_PROC"' 2>/dev/null | awk "{print \$1}")
        if [ -n "$PID" ] && [ -r "/proc/$PID/stat" ]; then
            JIF=$(awk "{print \$14 + \$15}" /proc/$PID/stat 2>/dev/null)
        else
            PID=0; JIF=0
        fi
        if dumpsys power 2>/dev/null | grep -qE "mWakefulness=Awake"; then S=1; else S=0; fi
        echo "$(date +%s),${UAH:-0},${MV:-0},$RX,$TX,${PID:-0},${JIF:-0},$S"
    ' 2>/dev/null | tr -d '
'
}

# ─────────────────────────────────────────────────────────────────────────────────────────
# doctor
# ─────────────────────────────────────────────────────────────────────────────────────────

cmd_doctor() {
    say "== device =="
    local model sdk
    model=$(adbsh getprop ro.product.model | tr -d '\r')
    sdk=$(adbsh getprop ro.build.version.sdk | tr -d '\r')
    say "  $model, Android SDK $sdk"

    say ""
    say "== signals =="

    local bat uah mv
    bat=$(adbsh 'dumpsys battery | head -22')
    uah=$(echo "$bat" | grep 'Charge counter' | tr -dc '0-9')
    mv=$(echo "$bat" | grep '^  voltage:' | tr -dc '0-9')

    if [ -n "$uah" ]; then
        say "  coulomb counter    ${uah} uAh  (OK)"
    else
        warn "coulomb counter unreadable — energy numbers will not be available"
    fi
    [ -n "$mv" ] && say "  voltage            ${mv} mV  (OK)" || warn "voltage unreadable"

    if adbsh 'grep -qE "^[[:space:]]*tun[0-9]+:" /proc/net/dev' 2>/dev/null; then
        say "  tun0 byte counters OK"
    else
        warn "no tun interface — connect the tunnel before running a load arm"
    fi

    local pid
    pid=$(adbsh "pidof $CORE_PROC" | tr -d '\r' | awk '{print $1}')
    if [ -n "$pid" ]; then
        say "  core process       pid $pid  (OK)"
    else
        warn "$CORE_PROC not running — start the tunnel first"
    fi

    # Direct fuel-gauge sysfs is SELinux-blocked for the shell user on most retail devices.
    # Say so explicitly, because every battery-benchmarking guide on the internet tells you
    # to read it and it is worth knowing immediately that yours cannot.
    if adbsh 'cat /sys/class/power_supply/battery/current_now' >/dev/null 2>&1; then
        say "  sysfs current_now  readable (bonus: finer resolution than the coulomb counter)"
    else
        say "  sysfs current_now  blocked by SELinux — using the coulomb counter instead"
    fi

    say ""
    say "== measurement preconditions =="

    if echo "$bat" | grep -q 'USB powered: true'; then
        warn "DEVICE IS PLUGGED IN. Every energy number will be meaningless."
        say ""
        say "     Switch adb to Wi-Fi and unplug:"
        say "       $ADB tcpip 5555"
        say "       $ADB shell ip route | grep -o 'src [0-9.]*'   # the phone's IP"
        say "       # unplug the cable, then:"
        say "       $ADB connect <phone-ip>:5555"
    else
        say "  on battery — OK"
    fi

    local level
    level=$(echo "$bat" | grep '^  level:' | tr -dc '0-9')
    if [ -n "$level" ] && [ "$level" -lt 30 ]; then
        warn "battery at ${level}% — below ~30% many devices throttle and the drain curve is not linear. Charge to 60-80% first."
    fi

    say ""
    say "== what this device can measure =="
    say "  CPU seconds of the core process per GB through tun0   (primary, low noise)"
    say "  mAh drawn over a fixed wall-clock window              (secondary, coarse)"
    say ""
    say "  The coulomb counter moves in 5000 uAh steps on this device class, so a 5-minute"
    say "  arm may show only a couple of steps. Use 30+ minute arms for energy, and rely on"
    say "  the CPU metric for anything shorter."
}

# ─────────────────────────────────────────────────────────────────────────────────────────
# arm
# ─────────────────────────────────────────────────────────────────────────────────────────

usage_arm() {
    cat <<'USAGE'
usage: b04.sh arm <label> <minutes> [--load URL] [--screen-on]

  <label>        goes in the filename, e.g. gvisor-idle, gvisor-load, none-idle
  <minutes>      arm duration. 30+ for energy numbers; 5 is enough for CPU-per-byte.
  --load URL     open URL in the browser to generate traffic through the tunnel.
                 Implies --screen-on, because a download needs a foreground app.
  --screen-on    keep the display on (an idle arm should NOT use this)
USAGE
}

cmd_arm() {
    local label="${1:-}" minutes="${2:-}"
    shift 2 || { usage_arm; exit 1; }
    [ -n "$label" ] && [ -n "$minutes" ] || { usage_arm; exit 1; }

    local load_url="" screen_on=0
    while [ $# -gt 0 ]; do
        case "$1" in
            --load)      load_url="${2:-}"; screen_on=1; shift 2 ;;
            --screen-on) screen_on=1; shift ;;
            *) die "unknown option: $1" ;;
        esac
    done

    local duration=$(( minutes * 60 ))
    local stamp; stamp=$(date +%Y%m%d-%H%M%S)
    local name="${label}-${stamp}"
    local dev_csv="${DEV_DIR}/b04-${name}.csv"

    mkdir -p "$RESULTS"

    say "== arm: $label =="
    say "  duration   ${minutes} min"
    say "  sampling   every ${SAMPLE_INTERVAL}s"
    say "  screen     $([ "$screen_on" = 1 ] && echo on || echo off)"
    [ -n "$load_url" ] && say "  load       $load_url"

    if adbsh 'dumpsys battery | head -22' | grep -q 'USB powered: true'; then
        warn "device is plugged in — energy numbers from this arm are not usable"
        warn "run './b04.sh doctor' for how to switch adb to Wi-Fi"
    fi

    local csv="$RESULTS/${name}.csv"
    local header="t,uah,mv,tun_rx,tun_tx,core_pid,core_jiffies,screen_on"

    if [ "$screen_on" = 1 ]; then
        adbsh input keyevent KEYCODE_WAKEUP >/dev/null 2>&1
        adbsh svc power stayon true >/dev/null 2>&1
    else
        adbsh svc power stayon false >/dev/null 2>&1
        sleep 2
        adbsh input keyevent KEYCODE_SLEEP >/dev/null 2>&1
    fi

    if [ -n "$load_url" ]; then
        # No wget, curl or busybox on a retail Android image, so the only bulk HTTP client
        # available without pushing a third-party binary is the browser. The rate is not
        # controlled; that is fine, because the metric is CPU-seconds PER BYTE and both terms
        # are measured.
        adbsh am start -a android.intent.action.VIEW -d "$load_url" >/dev/null 2>&1
        say "  load started in the browser"
    fi

    # ── MEASUREMENT STRATEGY ─────────────────────────────────────────────────────────────
    #
    # Screen off (an idle arm): DELTA. Two reads far apart, device left to suspend between
    # them. An on-device sampler cannot work here - unplugged with the screen off the
    # application processor suspends, a shell `sleep` holds no wakelock, and the loop freezes
    # with it. A 5-minute arm came back with one sample instead of sixty.
    #
    # Waking the phone to sample it would be worse than useless: the quantity being measured
    # is what it draws when nothing is happening.
    #
    # Screen on (a load arm): CONTINUOUS. Nothing is suspending, the display is already
    # dominating the power budget, and the per-sample detail is worth having.
    # ─────────────────────────────────────────────────────────────────────────────────────

    mkdir -p "$RESULTS"

    if [ "$screen_on" = 1 ]; then
        say "  mode       continuous (screen on, device will not suspend)"

        local push_err
        if ! push_err=$("$ADB" push "$(hostpath "$(dirname "$0")/device-sampler.sh")"                         "${DEV_DIR}/b04-sampler.sh" 2>&1 >/dev/null); then
            die "could not push the sampler: ${push_err:-no error text from adb}"
        fi
        adbsh chmod 755 "${DEV_DIR}/b04-sampler.sh"
        adbsh rm -f "${dev_csv}" "${dev_csv}.complete" >/dev/null 2>&1
        adbsh "nohup /system/bin/sh ${DEV_DIR}/b04-sampler.sh ${dev_csv} ${duration} ${SAMPLE_INTERVAL} ${CORE_PROC} >/dev/null 2>&1 &"

        say "  running - leave the device alone for ${minutes} minutes"
        local waited=0
        while [ "$waited" -lt "$duration" ]; do
            sleep 30
            waited=$(( waited + 30 ))
            printf '
  %d/%d min' "$(( waited / 60 ))" "$minutes"
        done
        printf '
'
        sleep "$SAMPLE_INTERVAL"

        local pull_err
        if ! pull_err=$("$ADB" pull "$dev_csv" "$(hostpath "$csv")" 2>&1 >/dev/null); then
            say ""
            warn "pull failed: ${pull_err:-no error text from adb}"
            warn "the samples are still on the device - recover them with:"
            warn "  $ADB pull $dev_csv"
            die "could not pull $dev_csv"
        fi
        adbsh rm -f "$dev_csv" "${dev_csv}.complete" >/dev/null 2>&1
    else
        say "  mode       delta (screen off, device allowed to suspend)"

        printf '%s
' "$header" > "$csv"

        local first; first=$(snapshot)
        [ -n "$first" ] || die "could not read the opening snapshot"
        printf '%s
' "$first" >> "$csv"

        # How many battery broadcasts already exist, so only the ones this arm produces are
        # counted. See the note where they are collected, below.
        local bcast_before
        bcast_before=$(adbsh 'dumpsys battery 2>/dev/null' | grep -c 'ACTION_BATTERY_CHANGED')

        say "  running - leave the device alone for ${minutes} minutes"
        local waited=0
        while [ "$waited" -lt "$duration" ]; do
            sleep 30
            waited=$(( waited + 30 ))
            printf '
  %d/%d min' "$(( waited / 60 ))" "$minutes"
            # Intermediate contamination probe.
            #
            # NOT for averaging - the deltas come from the endpoints. This exists to catch
            # a display that switched on mid-arm, which two reads cannot see and which
            # silently reports the drain of a lit screen as idle current. That exact
            # failure produced a confident "850 mA" for an idle phone with no tunnel.
            #
            # Each probe is one adb round trip and briefly wakes the application
            # processor, so it does perturb what is being measured. It perturbs every arm
            # identically, and ~15 brief wakeups over 30 minutes is a far smaller error
            # than mistaking a screen-on window for idle.
            if [ $(( waited % DELTA_PROBE_S )) -eq 0 ] && [ "$waited" -lt "$duration" ]; then
                local mid; mid=$(snapshot)
                [ -n "$mid" ] && printf '%s
' "$mid" >> "$csv"
            fi
        done
        printf '
'

        local last; last=$(snapshot)
        [ -n "$last" ] || die "could not read the closing snapshot"
        printf '%s
' "$last" >> "$csv"

        # ── MEASURED CURRENT, not a counter delta ────────────────────────────────────────
        #
        # Samsung logs a real fuel-gauge reading - current_avg, in mA, negative while
        # discharging - into the battery broadcast log every few minutes. On this device that
        # is the ONLY usable energy signal: `Charge counter` refreshes only when the level
        # changes by 1%, so it sat frozen at 1705000 through a 90-second check and would not
        # move reliably even across a 30-minute arm.
        #
        # Taking only the broadcasts that appeared DURING the arm, by count rather than by
        # parsing the log's timestamps, which carry no year and would need date arithmetic to
        # compare safely across midnight.
        local sidecar="${csv%.csv}.current.csv"
        printf 'ma
' > "$sidecar"
        adbsh 'dumpsys battery 2>/dev/null'             | grep 'ACTION_BATTERY_CHANGED'             | tail -n "+$(( bcast_before + 1 ))"             | grep -o 'current_avg:-\?[0-9]*'             | cut -d: -f2             | tr -d '
' >> "$sidecar"

        local readings
        readings=$(( $(wc -l < "$sidecar") - 1 ))
        if [ "$readings" -gt 0 ]; then
            say "  current    $readings fuel-gauge reading(s) captured"
        else
            warn "no fuel-gauge readings in this window - the arm is shorter than the"
            warn "broadcast interval (~4 min on this device). Use 20+ minutes."
        fi
    fi

    adbsh svc power stayon false >/dev/null 2>&1
    say "  saved $csv"
    say ""
    # hostpath again, same reason as adb: on Windows this is very likely the native
    # python.exe, which cannot open /c/app/... any more than adb.exe could.
    python "$(hostpath "$(dirname "$0")/analyze.py")" "$(hostpath "$csv")"
}

cmd_report() {
    [ -d "$RESULTS" ] || die "no results yet — run an arm first"
    # The shell expands the glob into MSYS paths, so each is converted individually
    # before python sees it.
    local converted=()
    local f
    for f in "$RESULTS"/*.csv; do
        [ -e "$f" ] || continue
        converted+=("$(hostpath "$f")")
    done
    [ ${#converted[@]} -gt 0 ] || die "no result CSVs in $RESULTS"
    python "$(hostpath "$(dirname "$0")/analyze.py")" "${converted[@]}"
}

case "${1:-}" in
    doctor) shift; cmd_doctor "$@" ;;
    arm)    shift; cmd_arm "$@" ;;
    report) shift; cmd_report "$@" ;;
    *)
        cat <<'USAGE'
b04.sh — measure what the gVisor TUN stack costs

  ./b04.sh doctor                     check the device can be measured
  ./b04.sh arm <label> <minutes> ...  run one arm
  ./b04.sh report                     summarise every arm collected so far

Start with doctor. See README.md for the matrix to run and how to read it.
USAGE
        exit 1 ;;
esac
