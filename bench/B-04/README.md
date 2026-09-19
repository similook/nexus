# B-04 — what the gVisor TUN stack costs

`singboxConfig.ts` runs the **gVisor** TUN stack, overriding ADR-0001 §5.4, which mandates
`system`. The override is justified on correctness — `system` carried UDP and silently dropped
TCP on device — but it was taken **without measuring what gVisor costs**, and the file says so.

This directory closes that gap.

---

## What is actually measurable, and what is not

Almost every Android battery-benchmarking guide tells you to read
`/sys/class/power_supply/battery/current_now`. On a retail device you cannot:

```
$ adb shell cat /sys/class/power_supply/battery/current_now
Permission denied
```

SELinux blocks it for the `shell` user. Verified on the reference device (Galaxy A33 5G,
Android 16). `./b04.sh doctor` checks yours and says which path it will use.

What *is* reachable, and what each is good for:

| Signal | Source | Good for | Not good for |
|---|---|---|---|
| **Core CPU time** | `/proc/<pid>/stat`, fields 14+15 | The stack cost. Per-process, ~10 ms resolution, unaffected by screen or radio | Absolute battery claims |
| **tun0 bytes** | `/proc/net/dev` | Normalising CPU per byte | — |
| **Coulomb counter** | `dumpsys battery` → `Charge counter` (µAh) | Real energy drawn | Short runs — it steps in 5 mAh |
| **Voltage** | `dumpsys battery` → `voltage` | Converting mAh to mWh | — |
| `batterystats --charged <pkg>` | `dumpsys` | Cross-check | A quotable number — it is **modelled** from a vendor power profile, not measured |

That last row matters. `batterystats` per-UID mAh is a lookup table multiplied by observed
time, not a reading from the fuel gauge. Under `CLAUDE.md`'s rule it can only ever be cited as
an estimate, so this harness does not build on it.

### The two-metric design

**CPU seconds per GB is the primary metric.** gVisor's cost *is* CPU — it reassembles TCP in
userspace instead of letting the kernel do it. That shows up as process CPU time directly,
with no display power, radio state or fuel-gauge quantisation in the way. It is also the metric
that stays valid with the screen on, which the load arms require.

**Measured current is the secondary metric.** It is what the product claim is actually about.
On the reference device it comes from `current_avg` in the battery broadcast log — a real
fuel-gauge reading in mA, emitted every ~4 minutes. The coulomb counter is used only as a
fallback, because it refreshes lazily and a delta taken across a short window attributes a step
that accumulated over a much longer period to the wrong arm.

**Idle arms are measured by DIFFERENCE, not by sampling.** Unplugged with the screen off the
application processor suspends, and a shell `sleep` loop holds no wakelock — it freezes with
the device. A 5-minute arm came back with one sample instead of sixty and the script reported
success. Two endpoint reads plus periodic contamination probes replaced it; every metric here
is a monotonic counter, so a delta is exactly as accurate as an average would have been.

**Load arms keep the continuous sampler.** The screen is on, nothing is suspending, and the
per-sample detail is worth having.

Each number is taken where it is trustworthy rather than forcing both out of one run.

---

## If it fails on Windows

Two path-conversion traps, both already handled in `b04.sh`, both worth knowing if you edit it:

**Device paths must NOT be converted.** Git Bash rewrites anything starting with `/` into a
Windows path, so `/data/local/tmp` becomes `C:/Program Files/Git/data/local/tmp` and the device
reports a file it was never asked for. `MSYS_NO_PATHCONV=1` at the top of the script stops that.

**Host paths MUST be converted.** `adb.exe` and `python.exe` are native Windows binaries and
cannot open `/c/app/...`. With conversion disabled they have to be given Windows paths
explicitly, which is what `hostpath()` does. Miss it and the symptom is misleading: the sampler
runs perfectly, the CSV sits on the device, and the run dies at `adb pull` — at the *end* of a
30-minute arm.

Both directions in one script, opposite treatment. If you add a new `adb` or `python` call,
wrap every host-side argument in `hostpath` and leave every device-side one bare.

---

## Before you start

```bash
cd bench/B-04
./b04.sh doctor
```

Fix whatever it complains about. Two things matter most:

**The device must be unplugged.** USB power makes every energy number meaningless — the
counter reflects charging, not drain. So adb has to run over Wi-Fi:

```bash
adb tcpip 5555
adb shell ip route | grep -o 'src [0-9.]*'    # the phone's IP
# unplug the cable now
adb connect <phone-ip>:5555
```

**Wireless adb drops.** Unplugging kills the USB connection and the adb server sometimes
restarts without it. Re-attach before every arm — the script fails fast with `could not read
the opening snapshot` rather than producing an empty result, but that costs you the arm:

```bash
adb connect <phone-ip>:5555 && adb devices
```

**Battery between 40% and 85%.** Below ~30% many devices throttle and the discharge curve stops
being linear; above ~90% the charge counter behaves oddly right after a full charge.

Also, for the run to mean anything: aeroplane-mode-off, one SIM, Wi-Fi in a consistent state
across arms, no other VPN installed, and the phone left alone. Background app churn is the
single largest source of variance here, so run the arms back to back in one sitting rather
than across a day.

---

## The matrix

```bash
# 1. Floor: no tunnel at all. Everything else is read against this.
#    Disconnect in the app first.
./b04.sh arm none-idle 30

# 2. Idle tunnel, gVisor. Connected, no payload, screen off.
#    This is the arm the product claim rests on.
./b04.sh arm gvisor-idle 30

# 3. Idle tunnel, system stack.
#    Change TUN_STACK in clients/web/src/core/singboxConfig.ts, rebuild, reinstall.
./b04.sh arm system-idle 30

# 4. Sustained load, gVisor.
./b04.sh arm gvisor-load 10 --load "https://speed.cloudflare.com/__down?bytes=2000000000"

# 5. Sustained load, mixed stack (system TCP + gVisor UDP), if it works on your node.
./b04.sh arm mixed-load 10 --load "https://speed.cloudflare.com/__down?bytes=2000000000"

./b04.sh report
```

### There is no `system-load` arm, and that is the point

You cannot measure `system` under TCP load, because **`system` does not carry TCP** on this
setup — that is the defect that forced the override in the first place. A `system-load` arm
would measure an empty tunnel and report a flattering number for a stack that does not work.

So the honest comparison is:

- **idle:** gVisor vs system vs no tunnel — all three run, all three comparable.
- **load:** gVisor vs `mixed` vs no tunnel. `mixed` is the real alternative, since it puts TCP
  back on the kernel path while keeping gVisor for UDP. If `mixed` works and is materially
  cheaper, that is the finding, and ADR-0001 should be amended to `mixed` rather than gVisor.

### Repeat before believing

Run each arm at least three times, interleaved rather than grouped:

```
none-idle, gvisor-idle, system-idle, none-idle, gvisor-idle, system-idle, ...
```

Battery drain drifts with temperature, charge level and whatever the OS decided to do in the
background. Grouping all the gVisor runs together bakes that drift into the comparison.
Interleaving cancels it. Report the median, and if the spread between repeats is larger than
the difference between arms, **you have not measured anything** — say so rather than picking
the run that agrees with you.

---

## Reading the output

```
=== gvisor-load-20260918-153012 ===
  duration          10.0 min   (120 samples)
  core CPU          148.3 s  (24.72% of one core)
  tun0 traffic      1840.2 MB   (24.54 Mbit/s)
  CPU per GB        81 s/GB   <- the stack cost
  screen on         100% of samples   (EXPECTED for a load arm)
```

- **CPU per GB** is the number to compare between stacks. It only appears once an arm has moved
  at least 100 MB; below that the denominator is too small to divide by and the figure would be
  noise dressed as a measurement.
- **`ENERGY SUPPRESSED`** on an idle arm means the display came on during it. No current
  figure is printed at all, and the arm is excluded from the comparison table.

  This is not caution for its own sake. A contaminated 6-minute arm on the reference device
  reported **850 mA / 3148 mW for an idle phone with no tunnel connected** — roughly an order
  of magnitude high, and entirely plausible-looking next to a real number. Re-run the arm.
- **drawn … (+/- 5 quantisation)** is the counter's step size, reported because "40 mAh" and
  "40 ± 5 mAh" are different claims.

---

## Writing the results up

Results are **not** claims until they are in two places.

**1. `bench/README.md`** gets the run: date, device, build, arm parameters, raw medians, and
the spread across repeats. That is the citation target — `CLAUDE.md` requires every performance
figure in the repo to point at a run here.

**2. The root `README.md`** currently says, under Limitations:

> **gVisor's CPU cost is unmeasured.** The battery thesis this project is built on is a design
> argument, not yet a benchmark result.

Once B-04 has produced a median across three interleaved repeats, replace that bullet with the
measured figure and a link to the run. If the result is unflattering, it still goes in — the
point of having a bench directory is that the number decides, not the marketing.

**3. `docs/adr/ADR-0001-core-engine-selection.md`** gets an amendment recording what §5.4's
mandate actually costs, and whether `mixed` supersedes gVisor.

### If gVisor turns out to be expensive

That is a real possible outcome and the honest response is one of:

- switch to `mixed` if it carries TCP and costs less, or
- keep gVisor and **change the claim**, positioning on correctness and leak resistance rather
  than battery.

What must not happen is keeping the claim and not publishing the number.
