# CPU frequency governor v2 (patches 0268-0271)

Target: OnePlus 6T (fajita, SDM845, Kryo 385: CPU0-3 Cortex-A55 = cluster0, CPU4-7 Cortex-A75 = cluster1; 60 Hz AMOLED,
3700 mAh). The beryllium (Poco F1) is the same SoC and the same code path: the driver is gated by
`sweet_board_beryllium()`, which the fajita ADT satisfies because it also lists `xiaomi,beryllium` (docs/FAJITA.md);
nothing here is beryllium-only and nothing new is gated on a board name. The OSM cpufreq-hw blocks are the ones the
old driver already used (A55 0x17d43000, A75 0x17d45800).

Status: **written and host-tested, never run on a phone.** CI (macOS) has not compiled it. See "Verified vs guessed".

## 1. Review of the v1 governor (patches 0190, 0192, 0218, 0258; `bsd/dev/sweet_cpufreq.c`)

Observed in the code (function names are the v1 ones):

| # | Where | Finding | Effect |
|---|---|---|---|
| 1 | `cf_thread` loop, `GOV_PERIOD_MS` | 25 ms windows. A thread that starts running is seen at the end of the window (0-25 ms, plus timer slop) and the clock moves at the next step. | At 60 Hz one frame is 16.7 ms: the first 1-2 frames of a swipe run at the idle clock. Matches the measured symptom (SpringBoard/backboardd main threads saturate while swiping). |
| 2 | `cf_gov_step`, `load >= GOV_JUMP_PCT` | Saturation jumps straight to the cluster ceiling (A75: 2803 MHz). Below 90% the clock is proportional (`khz[cur] * load / 80`). | Overshoot: a 10 ms burst costs the top state; combined with #3 the cluster dwells there for about a second. |
| 3 | `cf_gov_step`, `GOV_DOWN_SAMPLES` / `GOV_DOWN_STEP` | Down needs 3 samples (75 ms), then at most 2 LUT states per decision. From the top of the 28-state A75 table to the bottom takes ~1 s. | Power wasted after every burst; no way to tell "frame gap" from "idle". |
| 4 | `cf_cluster_load` | Cluster load = busiest CPU (good: one busy thread raises a 4-core cluster). Idle accounting is `recount_processor_usage` through `sweet_processor_idle_time`; it adds the in-progress idle stretch (`osfmk/kern/recount.c`, `recount_processor_usage`), so a CPU sleeping in WFI is not read as busy. Integer percent. | OK. Weakness: a thread that hops between cores spreads its load; shorter windows reduce that. |
| 5 | `cf_gov_step` | Frequency invariance is only implied: `need = khz[cur] * load / 80` uses the clock read at the END of the window. A clock change inside the window (the touch hook writes PERF_STATE from the touch thread) is not seen. | Mis-sized request on the window after a touch. |
| 6 | `cf_gov_step`, little boost (`BOOST_SAT_SAMPLES` = 40, `BOOST_STEP` = 2) | The A55 ceiling is raised only after 1 s of saturation, then by 2 states per second. Default ON since 0247. | From the 50% cap (902 MHz) to 1766 MHz takes ~5 s. Interactive work that spills onto the A55 (when no A75 is idle) is slow for seconds. |
| 7 | `sweet_input_boost`, `in_idx` | Every touch event puts the A75 at its cap (max) and the A55 at 1766 MHz (`sweetcpuinput_khz`) for 300 ms, then drops in one step. | Blunt (full power on a finger rest), contradicts the A55 cap, no decay. |
| 8 | `cf_gov_step`, `cf_offcap` | Display off for 5 s: both clusters pinned to state 0 and the governor returns before looking at load. The thread still wakes 40 times a second. | Background work (USB net, sync) gets 300 MHz whatever it needs; no wake pulse when the screen comes on. |
| 9 | `cf_sysctl`, `cf_readback` | `idx` / `cur_khz` / time-in-state come from PERF_STATE, which is the *requested* state. OSM/LMh limits (thermal, current) are invisible; `cf_readback` compares only once at setup. | Thermal throttling cannot be seen from kern.sweet_cpufreq. Not fixed (would need the OSM cycle counters; not read here). |
| 10 | `CPUFREQ_LUT_MAX` = 27 | The Linux sdm845.dtsi lists 28 A75 operating points (300 .. 2803.2 MHz). If the hardware LUT has 28 rows, the top state is never used. | Check the boot log (`LUT[..]` lines): if the last printed A75 row is 2745600 kHz, row 27 exists. Left unchanged on purpose: reading a row past a 27-row LUT could fail the monotonic check and skip the domain. |
| 11 | locking | None. `sweet_input_boost` (touch thread) and the governor thread both write PERF_STATE and `d->req` / `d->changes` unsynchronised. | Benign (statistics can lose a count; a request can be overwritten by the other thread's value for one window). `cf_in_until` is a 64-bit store, atomic on arm64. |
| 12 | `cf_sleep_ms` | `assert_wait_deadline` with default urgency/leeway at default kernel priority; the A55 may be busy. v1 has no counter for late wakeups. | v2 adds `samples`, `late`, `win_max_us` so the phone shows the real window jitter. |
| 13 | `cf_sysctl` | 2048-byte buffer, `cf_cat` truncates silently. Estimated ~1.9 KB with 27 states. | Raised to 3072 in 0269 (v1 keys come first, so truncation could only cut new keys). |

## 2. The new policy (from understanding of schedutil, PELT frequency invariance, the Android `interactive` governor and WALT)

References for the ideas (read, not copied; XNU is APSL and cannot take GPL code): Linux `kernel/sched/cpufreq_schedutil.c`
(frequency = 1.25 x utilisation x max, up/down rate limits, iowait boost), `kernel/sched/pelt.c` (frequency-invariant
utilisation), `drivers/cpufreq/qcom-cpufreq-hw.c` (the OSM block, already used by v1), `arch/arm64/boot/dts/qcom/sdm845.dtsi`
(OPP lists, `capacity-dmips-mhz` 611 / 1024, `dynamic-power-coefficient` 154 / 442), `Documentation/scheduler/sched-capacity.rst`;
Android `interactive` (hispeed_freq, go_hispeed_load, boostpulse) and Qualcomm WALT (window based load). Not taken over:
iowait boost (XNU has no iowait signal here), the energy model (the scheduler does not consult it), PELT decay (windows are
short enough).

All arithmetic is in `bsd/dev/sweet_cpugov.h` (patch 0268, pure integer C, host tested):

- `busy` per CPU per window (`cg_busy`), 0..1024.
- Frequency invariant work `inv = busy * avg_khz / top_khz` (`cg_inv_util`), `avg_khz` = mean of the clock at window start and end.
- Cluster value = max over its CPUs (`busy_max`); `inv_eff` = max(this window, previous window): a frame period of memory.
- Wanted clock = `inv_eff * top * headroom` (default 125%, i.e. 80% target utilisation) -> smallest LUT state >= it (`cg_want_khz`, `cg_pick_idx`).
- Saturated window (busiest CPU >= 85% busy, `sweetcpugov_go`): the real demand is unknown, so at least the "hispeed" state (50% of max for both clusters) at once, then 25% steps (`cg_target_idx`). The A75 reaches hispeed in one 8 ms window and the top in about four (host test).
- Asymmetric rate limit (`cg_step`): up at once; down only after the demand has stayed below the current state for `sweetcpugov_down_ms` (48 ms, about three frames) without a break, then straight to the wanted state.
- Window 8 ms (`sweetcpugov_ms`), half a frame at 60 Hz.

Patch 0270, boost: a touch event (`sweet_input_boost`, interface unchanged, also drives the GPU governor) puts the A75 at
`sweetcpuinput_big_khz` (default 1459200) and the A55 at `sweetcpuinput_little_khz` (default 902400, its cap) immediately
(MMIO store from the touch thread). The floor is held for `sweetgpuinputms` (300) after the last event and then decays one
LUT state per `sweetcpuinput_decay_ms` (16) (`cg_floor_idx`). `sweet_cpufreq_boost(ms)` / `sysctl -w kern.sweet_cpufreq_boost=<ms>`
holds the A75 floor the same way for animation bursts (the display path can call it later; nothing calls it yet).
Little cap: the A55 ceiling stays at 50% of max while it serves background work. It is lifted to `sweetcpufreq_little_boost_max`
(100%) when the cluster is saturated at its ceiling and either interactive work is spilling onto it (touch floor running, or
the A75's busiest core >= 70% busy: the scheduler's steering fills the A75 first) at once, or the saturation has lasted
`sweetcpugov_lift_ms` (100 ms, v1: 1 s); it drops back after `sweetcpugov_calm_ms` (250) below 50% busy (`cg_lift_update`).
`sweetcpufreq_little_boost=0` keeps the cap fixed.

Patch 0271, screen off: after 5 s with the display off (and no floor running) the ceilings become `sweetcpugov_off_big` /
`sweetcpugov_off_little` (25% of max: A75 652.8 MHz, A55 480 MHz) and the window lengthens to `sweetcpugov_off_ms` (50). The
governor keeps running inside that ceiling, so background work gets what it needs up to the ceiling instead of 300 MHz. When
the display comes on, the A75 gets a 200 ms pulse. `sweetcpufreq_offcap=0` disables the screen-off policy.

## 3. Boot-args (all optional)

| Arg | Default | Meaning |
|---|---|---|
| `sweetcpugov=1` | 2 | **1 = the old v1 governor unchanged (rollback)**; 2 = v2 |
| `sweetcpugov_ms` | 8 | window, 4..50 |
| `sweetcpugov_headroom` | 125 | percent, 100..200 |
| `sweetcpugov_go` | 85 | saturated busy %, 50..100 |
| `sweetcpugov_down_ms` | 48 | hold-down, 0..2000 |
| `sweetcpugov_hispeed_big` / `_little` | 50 / 50 | saturation jump, % of max (10..100) |
| `sweetcpuinput_big_khz` / `_little_khz` | 1459200 / 902400 | touch floors (0 = none); the v1 arg `sweetcpuinput_khz` only applies to v1 |
| `sweetcpuinput_decay_ms` | 16 | floor decay per LUT state |
| `sweetcpugov_lift_ms` / `_calm_ms` | 100 / 250 | A55 ceiling lift / drop |
| `sweetcpugov_off_ms` / `_off_big` / `_off_little` | 50 / 25 / 25 | screen-off window and ceilings |
| existing | | `sweetcpufreq=gov\|fixed\|off`, `sweetcpufreq_little_max`, `_big_max`, `sweetcpufreq_little_boost[_max]`, `sweetcpufreq_offcap`, `sweetinputboost`, `sweetgpuinputms`, `sweetamp*` keep their meaning |

Out-of-range values fall back to the default and are not logged except through the percent args.

## 4. kern.sweet_cpufreq (format "v1", keys only added)

All v1 keys are unchanged. Added on line 1: `gov gov_ms headroom down_ms samples late win_max_us in_big_khz in_little_khz in_decay_ms
pulses pulse_on offcap off_active off_ms wake_pulses`; on each cluster line (after `tis_ms=`): `busy_max busy_avg inv hispeed_khz ups
downs holds in_floor_khz lifts lifted off_khz`. `period_ms` now shows the v2 window. `load` is the busiest CPU's busy %. Definitions
are in the header comment of `bsd/dev/sweet_cpufreq.c`. `kern.sweet_cpufreq_boost` is new (write ms, read pulse count).

## 5. Testing on the 6T

Boot as usual with a temporary `fastboot boot` image (docs/BERGAMOTA_FASTBOOT.md); never a hard reset (the OnePlus ABL arms
CrashDump on any reset). Over ssh/USB net:

1. `sysctl kern.sweet_cpufreq`: `gov=2`, `samples` growing about 125 per second with the display on, `late` close to 0, `win_max_us`
   not much above 8000 (if it is tens of ms the governor thread is being starved: that, not the policy, is then the problem).
2. Idle: both clusters at their lowest `idx` (`ups`/`downs` not moving), `busy_max` 0-3.
3. Swipe the home screen for ~10 s, then read again: A75 `tis_ms` shifts to the 1.4 GHz+ states, `ups` rises, `holds` rises (frame
   gaps absorbed), A55 stays at or below 902 MHz unless `lifted=1`. Compare with `sweetcpugov=1` on the same gesture.
4. `sysctl -w kern.sweet_cpufreq_boost=300`, immediately read: `pulse_on=1`, cluster1 `in_floor_khz` 1459200, `idx` at or above it; 0.5 s later back down.
5. Screen off for 10 s (power button): line 1 `off_active=1`, cluster ceilings `off_khz`, window 50 ms; screen on: `wake_pulses` +1.
6. Battery: compare `tis_ms` totals and discharge over 10 minutes idle and 10 minutes of scrolling, v1 vs v2.

Rollback (no hard reset): boot the next temporary image with `sweetcpugov=1` (old governor, bit for bit the old behaviour) or
`sweetcpufreq=off` (no governor at all). The GPU governor and the touch hook are shared and unaffected.

## 6. Risks

- Untested on hardware; the first boot may show an unexpected interaction with the scheduler steering (patch 0191, and the scheduler
  patches 0264-0267 of another series, which this series does not touch: it keeps calling `sweet_amp_enable()` as before).
- 8 ms windows cost about 125 wakeups/s of one kernel thread on an A55 (screen on); measure battery.
- Down-hold 48 ms and the two-window memory deliberately keep the clock up across frame gaps; that is power for smoothness.
- `PERF_STATE` is a request: under OSM/LMh throttling the real clock is lower than reported and utilisation is over-estimated
  (it asks for more, harmless, but the counters then overstate the clock).
- Races listed in finding 11 stay; the worst is one 8 ms window in which a touch floor is lowered and re-raised.
- Hunks of 0269-0271 touch `bsd/dev/sweet_cpufreq.c` only; if the scheduler series edits `cf_amp_setup` or the header comment, a context conflict is possible.

## 7. Verified vs guessed

Verified here (Linux host): the arithmetic and closed-loop behaviour in `xnu/sched-test/test_cpugov.c` (904 checks: unit, LUT edges,
idle, single busy core ramp, step load, burst then idle, boost decay, little lift) through `python3 xnu/sched-test/run-cpugov-test.py`
(extracts the header from patch 0268 and compiles it with gcc -Wall -Wextra -Werror); every hunk of 0268-0271 applies in order on
a scratch repo rebuilt from 0093, 0190-0192, 0213, 0218, 0247, 0258 (`git apply`, result identical to the working copy);
`tools/check-patches.py` passes; the final `sweet_cpufreq.c` passes `gcc -fsyntax-only` against stub kernel headers.

Not verified: compilation against real XNU headers (CI will); everything involving hardware: that 8 ms timer wakeups are honoured,
that the default floors/hispeed/headroom feel right, the scheduler interplay, power. Defaults are reasoned, not measured.
