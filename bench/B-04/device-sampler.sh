#!/system/bin/sh
#
# B-04 device-side sampler. Pushed to /data/local/tmp and run with nohup.
#
# WHY IT RUNS ON THE DEVICE RATHER THAN BEING DRIVEN BY adb FROM THE HOST
#
# The measurement requires the phone to be UNPLUGGED, which means adb is over Wi-Fi, which
# means the link can drop. A host-driven sampler loses the run when that happens. This one
# writes locally and the host collects the file afterwards, so a dropped connection costs
# nothing. It also avoids adb round-trip jitter in the timestamps.
#
# Usage: device-sampler.sh <out.csv> <duration_s> <interval_s> <core_process_name>

set -u

OUT="$1"
DURATION="$2"
INTERVAL="$3"
PROC="$4"

echo "t,uah,mv,tun_rx,tun_tx,core_pid,core_jiffies,screen_on" > "$OUT"

END=$(( $(date +%s) + DURATION ))

while [ "$(date +%s)" -lt "$END" ]; do
    TS=$(date +%s)

    # head -22 is load-bearing on Samsung: dumpsys battery appends a long log of historical
    # ACTION_BATTERY_CHANGED broadcasts after the live state, and grepping the whole thing
    # picks up stale values from hours ago.
    BAT=$(dumpsys battery 2>/dev/null | head -22)
    UAH=$(echo "$BAT" | grep 'Charge counter' | tr -dc '0-9')
    # Anchored: "Max charging voltage" also matches a loose grep and is always 0.
    MV=$(echo "$BAT" | grep '^  voltage:' | tr -dc '0-9')

    TUN=$(grep -E '^[[:space:]]*tun[0-9]+:' /proc/net/dev 2>/dev/null | head -1)
    if [ -n "$TUN" ]; then
        RX=$(echo "$TUN" | awk '{gsub(/.*:/,"",$1); print $2}')
        TX=$(echo "$TUN" | awk '{print $10}')
    else
        RX=0
        TX=0
    fi

    # The pid is recorded on every sample, not once. If the core process is killed and
    # restarts mid-run its CPU counter resets to zero, and a delta across that boundary is
    # a large negative number that would otherwise be averaged in as if it were real.
    PID=$(pidof "$PROC" 2>/dev/null | awk '{print $1}')
    if [ -n "$PID" ] && [ -r "/proc/$PID/stat" ]; then
        # Fields 14 and 15 are utime and stime in clock ticks. CLK_TCK is 100 on Android,
        # so one tick is 10 ms.
        JIF=$(awk '{print $14 + $15}' "/proc/$PID/stat" 2>/dev/null)
    else
        PID=0
        JIF=0
    fi

    # Display state, because the screen dominates absolute current draw. Recorded rather than
    # assumed: a notification or an accidental touch turns it on mid-run and silently ruins
    # an idle arm.
    if dumpsys power 2>/dev/null | grep -qE 'mWakefulness=Awake'; then
        SCREEN=1
    else
        SCREEN=0
    fi

    echo "$TS,${UAH:-0},${MV:-0},$RX,$TX,${PID:-0},${JIF:-0},$SCREEN" >> "$OUT"

    sleep "$INTERVAL"
done

echo "done" >> "$OUT.complete"
