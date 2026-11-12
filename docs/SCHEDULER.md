# Scheduler for SDM845 (OnePlus 6T): sweet_amp v2

Target: OnePlus 6T (fajita, SDM845, Kryo 385: CPU0-3 Cortex-A55 "LITTLE", CPU4-7 Cortex-A75 "BIG"), kernel xnu-11215 with
our patch series. Nothing below was compiled or run (no XNU toolchain here); see "Verified / guessed" at the end.
All kernel code is under `#if defined(ARM64_BOARD_CONFIG_SWEET)` (global kernel machine flag, patch 0004), nothing is
beryllium-only: it works from the ADT-derived CPU topology (MPIDR Aff1 >= 4 = A75, `bsd/dev/sweet_cpufreq.c cf_amp_setup`).

## 1. Review of the previous scheduler (0191, "v1")

Observed facts: one published cluster (MAX_CPU_CLUSTERS == 1), no `__ARM_AMP__`, Clutch SMP dispatch table
(`osfmk/kern/sched_clutch.c sched_clutch_dispatch`). Findings, from reading the xnu-11215 source:

1. **Running threads are never moved.** `sched_clutch_dispatch.avoid_processor_enabled = FALSE`
   (sched_clutch.c), so the two places that could rebalance a running thread, `csw_check_locked()` and
   `thread_select()` (`avoid_processor`, sched_prim.c), are dead for Clutch. A heavy thread that woke while the A75s were
   busy stays on an A55 until it blocks. (Edge/AMP dispatch tables use exactly that hook; ours is not Edge.)
2. **Placement is by `base_pri` only** (v1 `sweet_amp_wanted_map`). base_pri is not QoS: unspecified-QoS daemons have
   base_pri 31 (BASEPRI_DEFAULT) and all went to the A75s; a CPU-bound utility thread (base_pri 20) never could.
   No utilisation, no task role (backboardd / SpringBoard).
3. **Realtime threads ignore the steering.** `choose_processor()` RT branch calls `choose_processor_for_realtime_thread()`
   which takes `lsb_first(primary_map)`: the lowest CPU id, i.e. an A55, first. The render server and audio threads are RT.
4. **Only the IDLE-hint case honours the class** (`choose_processor` hint switch, `case PROCESSOR_IDLE`). A hint that is
   RUNNING is used as part of the generic search, which picks the lowest `current_pri` over all CPUs regardless of class.
5. **When no idle core of the wanted class exists** the generic code takes any idle core (`lsb_first(idle_primary_map)`) or
   the lowest priority one: a low QoS thread can take the last idle A75 (the one a UI burst needs), and a UI thread can
   preempt an A55 although an A75 runs background work.
6. **SMT-less handling is correct**: `pset->is_SMT` false, every CPU is its own primary (`primary_map` = all CPUs),
   `idle_primary_map` and `lsb_next/lsb_first` work, the secondary loops are empty. No bug found there. The
   `cpu_preferred_last_chosen` round robin is only advanced in the "preferred" branches; the v1 branch does it itself.
7. **Shared run queue** (limit, not fixed): with one pset Clutch keeps one root hierarchy; `sched_steal_thread_enabled()`
   is `bit_count(pset_map) > 1` = false, there is no per-CPU queue. Class placement is therefore soft: it decides which
   idle CPU is woken (IPI); whichever CPU reaches `thread_select()` first takes the best thread. An A55 can pick a UI thread
   from the shared queue. v2 corrects that afterwards (migration at quantum expiry), it does not stop it.
8. Two-cluster topology (real `pset` per class) was **not** done: `MAX_CPU_CLUSTERS`/`__AMP__`/Edge are compile-time, the
   ADT/`ml_parse_cpu_topology` and `SweetCPU` assume one cluster, cluster-indexed perfcontrol/CLPC structures would need
   stubs. Not provably safe without a boot; the idle-class steering gets most of the benefit with a small diff.
9. Cosmetic: `cf_amp_setup()` still prints "base_pri >= N takes an A75 first" (sweet_cpufreq.c, owned by another agent,
   left alone); the real mode is in the new `SWEET AMP: scheduler mode ...` line and `kern.sweet_amp`.

## 2. Design (v2)

Ideas taken from the Linux scheduler (read-only reference clone: `kernel/sched/fair.c` fits_capacity / misfit tasks,
`pelt.c` geometric decay, `Documentation/scheduler/sched-capacity.rst`, `sched-energy.rst`, uclamp, SDM845 `capacity-dmips-mhz`
611 vs 1024 in `arch/arm64/boot/dts/qcom/sdm845.dtsi`; Android/WALT window idea). **No Linux code or table was copied**
(licence: XNU is APSL, Linux GPLv2); everything is re-implemented for XNU's structures and written fresh.

| Linux concept | Here |
|---|---|
| CPU capacity (scale 1024) | `SWAMP_CAP_LITTLE` 385, `SWAMP_CAP_BIG` 1024 = 611*1.77 GHz / (1024*2.80 GHz) (our numbers from the SDM845 DMIPS/MHz and max clocks; assumes top frequency) |
| PELT load/util, geometric decay | XNU already keeps one: `thread->cpu_usage`, run time aged by 5/8 per scheduler tick (125 ms, half life ~1.5 ticks) in `priority.c update_priority()`; `swamp_util_permille()` normalises it exactly like `thread_info()` (x3/5). Coarser than PELT's 32 ms (no extra thread_t field needed) |
| Capacity invariance | util permille is multiplied by the capacity of the class the thread ran on (100% busy on an A55 is 385) |
| WALT "running now" / burst | `ran_us` = time on core since `thread->computation_epoch` (set at dispatch). On core for >= 12 ms without blocking counts as saturated for that class, so the 125 ms average does not delay up-migration. iOS quanta (sched_clutch.c) are 10/8/6/4/2 ms (FG/IN/DF/UT/BG): a default thread reaches this at its second quantum expiry |
| `fits_capacity` (util*1.25 < cap) | `swamp_fits()`: util*5 < cap*4; a misfit on LITTLE wants BIG |
| Hysteresis | leaving BIG needs util*1.6 < LITTLE capacity (`swamp_fits_down`), no flapping band (tested) |
| uclamp min/max | `swamp_qos_floor/ceiling`: USER_INTERACTIVE floor 600, USER_INITIATED 500 (always misfit on LITTLE); MAINTENANCE/BACKGROUND and background-role tasks ceiling 230 (always fits LITTLE); foreground / SpringBoard (control) / backboardd (graphics server) task roles get util +25% |
| Misfit active balance | `thread_select()` treats "wrong class and a right-class core is free" like `avoid_processor`; idle A75 kicks (below) |
| EAS "cheapest core with spare capacity" | two classes only: a thread that fits LITTLE goes to LITTLE even if an A75 is idle; the reserve rule keeps one idle A75 for UI. Not an energy model (no OPP coefficients used) |
| Rate limit | per-thread dwell 40 ms << flips (max 640 ms), flips grow when moves come within 4 dwells |

Placement classes (`kern/sweet_amp_logic.h`, `swamp_wanted_class`): kernel_task threads (IOKit workloops, cpufreq thread) LITTLE
(as v1); background/maintenance QoS and background tasks LITTLE; UI/UIN QoS BIG; everything else (default, unspecified, utility)
by utilisation: light stays LITTLE, saturated goes BIG. Realtime user threads: idle A75 first.

### Patches (each gated by boot-args, `sweetamp=1` = v1 unchanged)

- **0264** `osfmk/kern/sweet_amp_logic.h`: new file, pure inline logic, no XNU dependencies, no behaviour change.
  The host test (`xnu/sched-test/`) compiles this very header.
- **0265** `thread.h` (+2 fields under `#if ARM64_BOARD_CONFIG_SWEET`), `sched_prim.c`: mode/boot-args, input gathering
  (`sweet_amp_thread_in`: `thread->effective_policy.thep_qos`, `task->effective_policy.tep_role`, `cpu_usage`),
  `sweet_amp_wanted_map` dispatches v1/v2, `choose_processor`: (a) wake placement by class (the old keep-hint / idle-class
  hooks now use the v2 class), (b) no idle core of the wanted class: BIG-wanting threads preempt a thread >= 8 priority points lower
  on an A75 (`sweet_amp_busy_victim`, same candidate rules as the generic scan), (c) low QoS threads cannot take the last `reserve` idle A75s
  (`sweet_amp_hide_big`: they are hidden from `idle_primary_map` and `preferred_idle_primary_map`), (d) RT user threads get an idle A75
  (`sweet_amp_rt_choose`, same candidate set as `choose_processor_for_realtime_thread` restricted to A75s), (e) counters.
- **0266** active migration, `sched_prim.c`: `sweet_amp_should_move()` called from `csw_check_locked()` (non committing: returns AST_PREEMPT,
  runs at quantum expiry and on any AST check) and from `thread_select()` (committing: sets `avoid_processor`, so the
  existing path adds AST_REBALANCE and re-places the thread via `thread_setrun` -> `choose_processor`; `thread_dispatch` adds
  SCHED_PREEMPT at quantum end so the target core reschedules at once). Idle balance: an A75 that goes idle in `thread_select` kicks (rebalance
  IPI, `sched_ipi_action(..., SCHED_IPI_EVENT_REBALANCE)`) an A55 whose thread marked itself a misfit (`sweet_amp_misfit_mask`),
  so the move does not wait for the next quantum.
- **0267** `bsd/dev/sweet_amp.c` (+`bsd/conf/files`): `kern.sweet_amp` string and the RW ints below.

### Boot-args and sysctls

| boot-arg | sysctl (root, live) | meaning |
|---|---|---|
| `sweetamp=0\|1\|2` (existing arg, read by `sweet_cpufreq.c` for on/off; default 1 (v1) until v2 is validated on the 6T; opt in with sweetamp=2 or live with the sysctl) | `kern.sweet_amp_mode` | 0 stock Clutch, 1 old v1 (base_pri), 2 v2 |
| `sweetamp_prio=N` | - | v1 threshold only |
| `sweetamp_reserve=N` (1) | `kern.sweet_amp_reserve` | idle A75s kept free from low QoS threads |
| `sweetamp_migrate=0\|1` (1) | `kern.sweet_amp_migrate` | active migration (0 = v2 placement only) |
| `sweetamp_kick=0\|1` (1) | `kern.sweet_amp_kick` | idle A75 kicks misfit A55 threads |

`kern.sweet_amp` (read-only, stable key=value, format documented at the top of `bsd/dev/sweet_amp.c`):

    sweet_amp v2 mode=v2 big=0xf0 little=0xf reserve=1 migrate=1 kick=1
    place want_big_on_big=.. want_big_on_little=.. want_little_on_little=.. want_little_on_big=.. rt_big=.. rt_little=.. victim=.. hidden=..
    migrate up_idle=.. up_preempt=.. down=.. held=.. misfit_marks=.. kicks=..
    params cap_little=385 cap_big=1024 burst_us=12000 min_run_us=2000 dwell_us=40000 victim_margin=8

## 3. Testing on the 6T

Never hard-reset the phone (OnePlus ABL arms CrashDump on any reset; the HFS+ root is unjournaled, docs/FAJITA.md). Everything
below is done over ssh on a running system, **rollback needs no reset**:

1. Boot the kernel with the series as usual. Console must show `SWEET AMP: scheduler mode 2 ... A75 mask 0xf0`.
2. `sysctl kern.sweet_amp` before/after a workload; `top`/`ps` for who runs where is not available, so use the counters:
   - opening an app / scrolling: `place want_big_on_big` and `rt_big` rise; `want_big_on_little` small (A75s busy).
   - a CPU hog (`yes > /dev/null`, default QoS): after ~12-20 ms `migrate up_idle` +1, then it stays; `held` should stay small.
   - `taskpolicy -b yes > /dev/null` (background): `want_little_on_little` rises, `want_little_on_big` ~0, `down` +1 if it started on an A75.
   - A/B: `sysctl -w kern.sweet_amp_mode=1` (v1) or `=0` (stock) and repeat; compare UI smoothness and `kern.sweet_cpufreq` time-in-state
     (A75 should idle more with v2 on light loads, A55 busier).
3. **Rollback, live:** `sysctl -w kern.sweet_amp_mode=1` (old behaviour) or `0` (stock). Partial: `kern.sweet_amp_migrate=0`, `kern.sweet_amp_kick=0`.
   For the next boot: boot-arg `sweetamp=1` (or `0`); change it with `fastboot boot` of a new image, or `sweetreboot fastboot` (flushes first,
   docs/REBOOT_MODE.md), never a power-button reset.

Expected effect: lighter daemon load stays on A55 (power), UI/RT threads on A75, hogs migrate up within ~2 quanta, background work does
not occupy the last A75. Risk: wrong class estimates (all numbers are guesses until measured), extra IPIs, a bug in the new hooks
(`thread_select` is hot and lock-sensitive; one panic would need a normal reboot, kernel panic reset is unavoidable then). Tunables are in
`sweet_amp_logic.h` (capacities, floors, dwell) and in the sysctls.

## 4. Verified vs guessed

Verified here:
- `xnu/sched-test/run.sh`: host gcc test of `sweet_amp_logic.h` (68 checks: util conversion against XNU's ageing, class table, hysteresis band,
  UI burst, heavy background, all-big-busy, ping-pong guard 35 moves vs 2000 in 20 s, reserve rule, mixed set); it also checks that the header in patch 0264
  is byte-identical to the tested one.
- Patches 0264-0267 apply in order with `git apply` on a scratch repo seeded from the real xnu-11215 tree (sched_prim.c, thread.h,
  bsd/conf/files, ...) after replaying the whole existing series (`tools/check-patches.py` also passes). The patches were generated from that tree.
- Lock/AST/context re-read against the real source: `thread_select` (thread and pset locked at the hook; the idle branch holds the pset lock when
  kicking and performs the IPI after `processor_balance` dropped it, like the existing `ast_processor` pattern), `csw_check_locked` (callers: `csw_check`
  with pset locked at splsched, `processor_setrun` on the current processor), `choose_processor` (pset locked, returns a candidate of the same kind the generic code
  returns), `thread_setrun` (accounting after the processor is chosen). `sched_ipi_action(dst, NULL, REBALANCE)` is the same call shape `thread_select` already uses for SMT.

Guessed / not verified (needs a compile and a phone):
- Nothing was compiled against XNU (types such as `cpumap_t`, `os_atomic_andnot`, `-Werror` warnings are checked by reading only). CI (xnu.yml, macOS) is the first compile.
- Capacities 385/1024, thresholds, floors, 12 ms burst, 40 ms dwell, margin 8, reserve 1: reasoned, not measured. cpu_usage is time based, not frequency invariant
  (the cpufreq governor changes the real capacity).
- Task role values for backboardd/SpringBoard (graphics server / control application): taken from `task_policy.c`; that the 6T userland really sets them is unchecked.
- `thread_t` gained 12 bytes under ARM64_BOARD_CONFIG_SWEET; all kernel TUs get that macro from MACHINE_FLAGS_ARM64_SWEET (0004), unchecked for every kext build.
- The shared Clutch queue (finding 7) may undo placement more than expected; the counters `place` and `migrate` show whether that happens.
