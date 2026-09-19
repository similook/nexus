#!/usr/bin/env python3
"""
Turn B-04 sample CSVs into numbers that can be quoted.

Every figure it prints is derived from a counter the device actually incremented. Nothing is
modelled, and nothing is extrapolated from a power profile — which is the difference between
this and `dumpsys batterystats`, whose per-UID mAh comes from a vendor lookup table rather
than from the fuel gauge.

  python analyze.py results/gvisor-idle-20260918-1200.csv
  python analyze.py results/*.csv
"""

import csv
import sys
from pathlib import Path

CLK_TCK = 100  # Android; confirmed with `getconf CLK_TCK` on the target device.


def load(path):
    with open(path, newline="") as handle:
        return [row for row in csv.DictReader(handle)]


def cpu_seconds(rows):
    """
    CPU time consumed by the core process across the run.

    Summed per-segment rather than taken as last-minus-first. The core lives in its own
    process and can be restarted mid-run (a reload, a crash, the OS reclaiming it); its jiffy
    counter restarts at zero when that happens, and a naive end-to-end delta would come out
    large and negative. Each contiguous run of one pid contributes its own delta.
    """
    total = 0
    segment_start = None
    previous = None

    for row in rows:
        pid = row["core_pid"]
        jif = int(row["core_jiffies"] or 0)

        if pid == "0":
            # Core not running for this sample. Close any open segment.
            if segment_start is not None and previous is not None:
                total += previous[1] - segment_start
            segment_start, previous = None, None
            continue

        if previous is None or previous[0] != pid:
            if segment_start is not None and previous is not None:
                total += previous[1] - segment_start
            segment_start = jif

        previous = (pid, jif)

    if segment_start is not None and previous is not None:
        total += previous[1] - segment_start

    return total / CLK_TCK


def summarise(path):
    rows = load(path)
    if len(rows) < 2:
        return {"name": Path(path).stem, "error": "fewer than 2 samples"}

    t0, t1 = int(rows[0]["t"]), int(rows[-1]["t"])
    duration_s = t1 - t0
    if duration_s <= 0:
        return {"name": Path(path).stem, "error": "zero-length run"}

    uah = [int(r["uah"] or 0) for r in rows if int(r["uah"] or 0) > 0]
    mv = [int(r["mv"] or 0) for r in rows if int(r["mv"] or 0) > 0]

    rx = int(rows[-1]["tun_rx"]) - int(rows[0]["tun_rx"])
    tx = int(rows[-1]["tun_tx"]) - int(rows[0]["tun_tx"])
    # A tun interface that went away and came back restarts its counters. Negative means the
    # interface was recreated mid-run, so the byte total is not trustworthy.
    tun_bytes = None if (rx < 0 or tx < 0) else rx + tx

    cpu_s = cpu_seconds(rows)
    screen_on_fraction = sum(1 for r in rows if r["screen_on"] == "1") / len(rows)

    # An idle arm is defined by the screen being off for ALL of it. If the display came on at
    # any point the energy figure describes a lit screen, not an idle tunnel, and it must not
    # be printed as though it were comparable - it is roughly an order of magnitude larger and
    # looks entirely plausible next to a real one.
    is_load_arm = "load" in Path(path).stem
    contaminated = (not is_load_arm) and screen_on_fraction > 0

    result = {
        "name": Path(path).stem,
        "duration_s": duration_s,
        "samples": len(rows),
        "cpu_s": cpu_s,
        "cpu_pct": 100.0 * cpu_s / duration_s,
        "tun_bytes": tun_bytes,
        "screen_on": screen_on_fraction,
        "mv_mean": sum(mv) / len(mv) if mv else None,
        "contaminated": contaminated,
    }

    # Measured current, if the arm collected any. Preferred over the coulomb-counter delta
    # wherever both exist: this is a fuel-gauge reading, while the counter is a quantised
    # accumulator that on some devices only refreshes on a 1% level change.
    sidecar = Path(path).with_suffix("").with_suffix(".current.csv")
    if not sidecar.exists():
        sidecar = Path(str(Path(path))[: -len(".csv")] + ".current.csv")
    if sidecar.exists():
        values = []
        for line in sidecar.read_text().splitlines()[1:]:
            line = line.strip()
            if not line:
                continue
            try:
                # Negative means discharging. Charging readings are dropped rather than
                # sign-flipped: a window that contains any of them was not a clean arm.
                ma = int(line)
            except ValueError:
                continue
            if ma < 0:
                values.append(-ma)
        if values:
            values.sort()
            mid = len(values) // 2
            result["ma_measured"] = (
                values[mid] if len(values) % 2 else (values[mid - 1] + values[mid]) / 2
            )
            result["ma_measured_n"] = len(values)
            result["ma_measured_range"] = (values[0], values[-1])

    if len(uah) >= 2:
        drawn_uah = uah[0] - uah[-1]  # counter counts down while discharging
        if drawn_uah > 0:
            mah = drawn_uah / 1000.0
            hours = duration_s / 3600.0
            result["mah"] = mah
            result["ma_mean"] = mah / hours
            if result["mv_mean"]:
                result["mw_mean"] = result["ma_mean"] * result["mv_mean"] / 1000.0
            # The counter moves in 5000 uAh steps on the devices this was built against, so
            # the quantisation error is +/- one step over the whole run. Reported, because a
            # 40 mAh result with +/-5 mAh of granularity is a different claim from 40 mAh.
            result["mah_quantisation"] = 5.0
        else:
            result["note"] = "counter did not move - arm too short, or device was charging"

    if tun_bytes is not None and tun_bytes > 0:
        result["mbit_s"] = (tun_bytes * 8) / duration_s / 1_000_000

    # MINIMUM TRAFFIC BEFORE A PER-BYTE FIGURE IS REPORTED AT ALL.
    #
    # Without this, an idle arm that moved 20 kB of keepalives divides a near-zero denominator
    # and prints something like "51282 s/GB" - a number with no meaning that looks exactly
    # like a measurement and would go straight into a document. An arm has to move real
    # traffic before its cost per byte means anything.
    MIN_BYTES_FOR_PER_GB = 100_000_000  # 100 MB
    if tun_bytes is not None and tun_bytes >= MIN_BYTES_FOR_PER_GB and cpu_s > 0:
        result["cpu_s_per_gb"] = cpu_s / (tun_bytes / 1_000_000_000)
    elif tun_bytes is not None and tun_bytes > 0:
        result["per_gb_note"] = (
            f"only {tun_bytes / 1_000_000:.1f} MB moved - too little for a per-GB figure "
            f"(need {MIN_BYTES_FOR_PER_GB // 1_000_000} MB)"
        )

    return result


def fmt(value, spec="{:.1f}", dash="-"):
    return dash if value is None else spec.format(value)


def main(paths):
    results = [summarise(p) for p in paths]

    for r in results:
        if "error" in r:
            print(f"{r['name']}: {r['error']}")
            continue

        print(f"\n=== {r['name']} ===")
        print(f"  duration          {r['duration_s'] / 60:.1f} min   ({r['samples']} samples)")
        print(f"  core CPU          {r['cpu_s']:.1f} s  ({r['cpu_pct']:.2f}% of one core)")

        if r.get("tun_bytes") is not None:
            print(f"  tun0 traffic      {r['tun_bytes'] / 1_000_000:.1f} MB"
                  f"   ({fmt(r.get('mbit_s'), '{:.2f}')} Mbit/s)")
        if r.get("cpu_s_per_gb"):
            print(f"  CPU per GB        {r['cpu_s_per_gb']:.0f} s/GB   <- the stack cost")
        elif r.get("per_gb_note"):
            print(f"  CPU per GB        {r['per_gb_note']}")

        if r.get("contaminated"):
            print(f"  ENERGY SUPPRESSED  the display was on for "
                  f"{r['screen_on'] * 100:.0f}% of this arm, so any current figure describes")
            print(f"                     a lit screen rather than an idle tunnel. Re-run it.")
        elif "ma_measured" in r:
            lo, hi = r["ma_measured_range"]
            print(f"  measured current  {r['ma_measured']:.0f} mA"
                  f"   (median of {r['ma_measured_n']}, range {lo}-{hi})")

        if "mah" in r and not r.get("contaminated"):
            print(f"  drawn             {r['mah']:.0f} mAh  (+/- {r['mah_quantisation']:.0f} quantisation)")
            print(f"  mean current      {r['ma_mean']:.0f} mA")
            if r.get("mw_mean"):
                print(f"  mean power        {r['mw_mean']:.0f} mW")
        elif "note" in r:
            print(f"  energy            {r['note']}")

        if r["screen_on"] > 0.01:
            marker = "EXPECTED for a load arm" if "load" in r["name"] else "!! UNEXPECTED"
            print(f"  screen on         {r['screen_on'] * 100:.0f}% of samples   ({marker})")

    for r in results:
        if "error" not in r:
            # One field for the comparison, whichever signal the device could actually give.
            r["ma_for_compare"] = r.get("ma_measured", r.get("ma_mean"))

    idle = [
        r for r in results
        if "error" not in r and not r.get("contaminated") and r.get("ma_for_compare") is not None
    ]
    if len(idle) >= 2:
        print("\n=== idle comparison ===")
        print("  (screen off throughout, so these are comparable)")
        base = min(idle, key=lambda r: r["ma_for_compare"])
        for r in sorted(idle, key=lambda r: r["ma_for_compare"]):
            delta = r["ma_for_compare"] - base["ma_for_compare"]
            suffix = "baseline" if r is base else f"+{delta:.0f} mA vs {base['name']}"
            print(f"  {r['name']:<34} {r['ma_for_compare']:>6.0f} mA   {suffix}")

    load = [r for r in results if "error" not in r and r.get("cpu_s_per_gb")]
    if len(load) >= 2:
        print("\n=== cost per byte ===")
        print("  (immune to display power, so load arms are comparable even with the screen on)")
        for r in sorted(load, key=lambda r: r["cpu_s_per_gb"]):
            print(f"  {r['name']:<34} {r['cpu_s_per_gb']:>6.0f} s/GB")

    print()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1:])
