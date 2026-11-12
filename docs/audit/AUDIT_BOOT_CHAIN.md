# Audit: Enxerto and the boot chain on the OnePlus 6T (fajita)

Scope: `enxerto/` (C, start.S, fastboot, UFS, DWC3), the stock-ABL boot chain of the 6T, `tools/mkadt.py` / `mkpayload.py`,
how other projects boot, and a recovery runbook. Code was read at commit 866fb63; **no code was changed**.
Tags: **OBSERVED** = seen in code or in a command run here, or recorded in repo notes as seen on hardware; **INFERRED** = follows from code/docs but
not demonstrated; **UNVERIFIED** = needs hardware or a source not available here.

Run here (no aarch64 gcc in this sandbox, so `BOARD=fajita enxerto/build.sh` could not run):
- `fastboot.c sparse.c storage.c blake2b.c fastboot_test.c` built with `-fsanitize=address,undefined`: **511 checks, 0 failures, no ASan/UBSan error**
  (the only ASan output is leaked `strdup`s inside the test harness itself). OBSERVED.
- All 22 translation units compiled with `clang --target=aarch64-none-elf -ffreestanding -mgeneral-regs-only -mstrict-align -DBOARD_FAJITA`:
  zero errors; the only warnings are clang ignoring gcc's `optimize("no-tree-switch-conversion")`. OBSERVED. (A clang build would lose the
  no-switch-table protection; irrelevant while gcc is the build compiler.)
- `inflate_test.c` needs `-lz` (it is not run by `build.sh`; see F-23).

## Ranking summary

| ID | Rank | Title | Tag |
|---|---|---|---|
| F-01 | P0 | Every Enxerto reset path (panic, `reboot`, failed boot) probably ends in CrashDump on the 6T, i.e. a hard reset of an unjournaled HFS+ root | INFERRED (CrashDump) / OBSERVED (HFS damage) |
| F-02 | P1 | `reboot-bootloader` relies on IMEM alone; repo notes say IMEM alone did not select fastboot on SDM845 | INFERRED |
| F-03 | P1 | No payload integrity/authentication on the ABL-ramdisk path | OBSERVED |
| F-04 | P1 | `loader_check` does not bound the RAM window to real DRAM or exclude Enxerto, DTB, buffer, MMIO | OBSERVED |
| F-05 | P1 | The entire Enxerto flash/hash/erase path has never run on hardware | OBSERVED (docs) |
| F-06 | P1 | UFS host left pointing into Enxerto's image when the kernel starts | INFERRED |
| F-07 | P2 | Panic screen prints garbage for X30 | OBSERVED |
| F-08 | P2 | Boot stack has no guard; overflow corrupts .bss silently | OBSERVED |
| F-09 | P2 | Panic/crash information is lost on reset | OBSERVED |
| F-10 | P2 | GPT scan silently ignores a LUN (more than 128 entries etc.) | OBSERVED / UNVERIFIED for 6T |
| F-11 | P2 | UFS timeout aborts only the host slot | OBSERVED |
| F-12 | P2 | `slot-count 0` / allowlist names `boot`, `logo` are wrong for an A/B phone | OBSERVED |
| F-13 | P2 | Entry assumes EL1 with no check | OBSERVED / INFERRED |
| F-14 | P2 | Loader continues when the MMU window failed, only prints it | OBSERVED |
| F-15 | P2 | Early PMIC charger programming before any board gating | INFERRED (not audited in depth) |
| F-16 | P2 | Erase/flash have no confirmation; any USB host can wipe `userdata` | OBSERVED |
| F-17 | P3 | `entry_va` not validated to lie inside a segment | OBSERVED |
| F-18 | P3 | USB stack limits (timeouts, cold-boot PHY supplies, HS only) | OBSERVED |
| F-19 | P3 | Whole 32 MiB framebuffer block mapped Normal-NC | OBSERVED |
| F-20 | P3 | Fall-through to 120 s legacy diagnostics after a failed fastboot start | OBSERVED |
| F-21 | P3 | Dead milestone-2/3 test code still linked | OBSERVED |
| F-22 | P3 | UNMAP chunk size not taken from the device | OBSERVED |
| F-23 | P3 | `build.sh`: no `-Werror`, inflater test not run, host tests need the cross compiler | OBSERVED |

Findings F-24 onward (ABL, install path, ADT, other projects) follow in later sections.

## 1. Enxerto findings

### F-01 (P0) All reset paths probably lead to CrashDump on the 6T
- Where: `enxerto.c: reset()`, `bergamota.c: hw_reset()`, `boot_failed()`, `p_reboot()`; kernel side patch 0137.
- What: every exit writes IMEM `restart_reason` (0x146bf65c) and calls PSCI `SYSTEM_RESET`. `docs/FAJITA.md` records (OBSERVED on the 6T) that
  "the OnePlus ABL arms Qualcomm CrashDump: any reset lands there (Power + Vol up ~15 s to leave)". So a panic ("reset in 40 s"), `fastboot reboot`,
  `reboot-bootloader`, and the "back to ABL fastboot in 20 s" after a failed boot probably end in CrashDump, not in ABL fastboot or a normal boot
  (INFERRED: the doc speaks of the kernel's reset; nobody has recorded Enxerto's own reset on the 6T). Probable cause (INFERRED from Qualcomm msm-poweroff
  behaviour, see section 2): a download-mode cookie that the downstream kernel clears on every non-panic restart; XNU never clears it.
- Why it matters: this is how the unjournaled HFS+ root got damaged (NOTES 2026-11-04 "HFSINC"); each CrashDump entry is a hard reset.
- Fix: read the cookie location from the live IMEM/DT of a running Android 6T (`qcom,msm-imem-*` nodes), clear it in Enxerto's reset helpers and in kernel 0137,
  and write `PON_SOFT_RB_SPARE` (0x88f) like 0137. Test: `fastboot reboot` from Enxerto must reach ABL.
- Effort: 1-2 days with hardware. Reference: Linux `drivers/power/reset/qcom-pon.c`; downstream msm-poweroff `set_dload_mode()`.

### F-02 (P1) `reboot-bootloader` writes IMEM only
- Where: `bergamota.c: hw_reset(RESTART_BOOTLOADER)`. The 0137 notes say "IMEM alone did not select fastboot on SDM845, hence the PON byte".
  Enxerto never writes PON_SOFT_RB_SPARE. INFERRED that it does not land in ABL fastboot on the 6T; UNVERIFIED on hardware.
- Fix: as F-01; fall back to an on-screen "hold Power + Vol Down". Effort: small once F-01 is known.

### F-03 (P1) No payload authentication
- Where: `loader.c: loader_boot_payload(verify=0)` for the ABL ramdisk; `loader_check` only checks structure, never a hash.
- Why: on an unlocked bootloader anyone with the cable can run anything at EL1 (accepted by design), but a corrupted payload (flash glitch, truncated
  download) is also detected only by structure: a flipped bit in a compressed segment either fails inflate or silently yields a bad kernel.
- Fix: a BLAKE2b-256 over the payload in the header (blake2b.c is already linked), checked before the MMU window; refuse and show on mismatch. Signatures
  (Ed25519) only matter if the bootloader is ever relocked (it cannot be with a custom `boot`, see section 2). Effort: 0.5 day.
  Reference: U-Boot FIT hashes; UniXNU loader checksums (section 5).

### F-04 (P1) `loader_check` does not bound the destination window
- Where: `loader.c: loader_check()`. It requires segments inside `[phys_base, phys_base+mem_size)` and the ramdisk outside it, but `phys_base`/`mem_size`
  come from the untrusted header and are never checked against the DT `/memory` node, the Enxerto image, the DTB, the buffer/scratch area
  (0xb8000000 + 1 GiB) or MMIO (the L2 map is Device below 8 GiB, so a window at 0x0 would copy over GCC/UFS/IMEM). `s->vmaddr + pa_of_va_base` can wrap.
- Why: a mis-built payload (wrong phys base) can stall or hit a protected carve-out ("protected RAM = instant reset", NOTES), which on the 6T is CrashDump (F-01).
- Fix: parse `/memory` and `/reserved-memory` from the ABL DTB (fdt.c already walks /chosen), require the window inside memory and outside every reserved
  region and Enxerto's own image/buffer; use `__builtin_add_overflow`. Effort: 0.5 day.

### F-05 (P1) The Enxerto flash path has never run on hardware
- Where: `docs/BERGAMOTA_FASTBOOT.md` ("None of it has run on hardware ... UFS write / hash path least of all"). OBSERVED in the doc.
  What did run (NOTES 2026-11-04): ABL -> Enxerto, DWC3 enumeration ("Bergamota fastboot, unlocked"), `getvar product`, `boot`.
- Why: `docs/INSTALL.md` flashes `userdata` with **ABL's** fastboot, so Enxerto's writer is not on the install path today. If the delta tool
  (`bergamota-flash.py`) is adopted, a non-coherent-DMA writer never run on silicon is aimed at the user's only OS partition.
- Already good: hard allowlist, validated GPT, `oem verify` read-back, `oem selftest`.
- Fix: run the doc's "Hardware test plan" in order, starting with `oem selftest:userdata`; `logo`/`boot` do not exist on A/B (F-12), so use a scratch
  range of `userdata` with `--device-verify`. Effort: 1 day.

### F-06 (P1) UFS host still points into Enxerto's image at kernel entry
- Where: `ufs.c: ufs_init()` takes over UTRLBA/UTRLRSR (list in Enxerto's static `utrl`); there is no `ufs_stop()` and `bergamota.c: p_boot()` only calls
  `usb_dwc3_stop()` before `loader_boot_payload`. INFERRED: after flashing and then `boot`, the host runs with a list base inside memory the kernel
  overwrites; the UFS node has no `iommus`, so any stray doorbell DMAs over kernel memory. The kernel UFS driver likely re-initialises the list.
- Fix: `ufs_stop()`: wait for an empty doorbell, `UTRLRSR=0`, restore ABL's UTRLBA/UTRLBAU (save them at init); call from `p_boot` and before reset.
  Effort: 2 hours. Reference: Linux `ufshcd_hba_stop`.

### F-07 (P2) Panic screen prints garbage for X30
- Where: `start.S: exc_common` / `enxerto.c: exc_handler`. The frame is `sub sp,sp,#240` with x0..x28 at offsets 0..232; `regs[29]` (offset 232) is padding.
  The vector stub's stash (x29, x30) sits at `[sp+240]`, i.e. `regs[30]` = x29 and `regs[31]` = x30. OBSERVED by reading.
- Fix: print `regs[31]` for X30 and `regs[30]` for X29. 5 minutes.

### F-08 (P2) Stack has no guard and sits above .bss
- Where: `enxerto.ld`: `_bss_end`, then `. += 0x8000` (boot stack, grows down toward `.bss`), then 8 x 4 KiB secondary stacks. `scratch[8192]` (64 KiB) and the
  USB blocks are in `.bss`. An overflow silently corrupts `.bss` instead of faulting (MMU off, no guard page possible).
- Fix: a canary at the stack bottom checked in `ui_tick` and in the exception handler; or move the stack below `.bss`. 1 hour.

### F-09 (P2) Nothing survives a crash
- Where: `enxerto.c: exc_handler` draws a blue screen then `reset(40)`. No serial, no persistent record; `con_replay()` is RAM only. After the reset (F-01) it is gone.
- Fix: write the crash record (ESR/ELR/FAR/lr/stage) into the `ramoops` carve-out (0xb0000000, 4 MiB; fixed in the live DT per NOTES) and print it on the next
  Enxerto start; adopt the shim-nx pattern (section 5). UNVERIFIED that ramoops survives ABL's CrashDump reset. 0.5 day.

### F-10 (P2) GPT scan silently ignores a LUN
- Where: `storage.c: scan_lun()`: `nent > 128`, `esz != 128`, bad CRC or `elba + eb > first_usable` ignores the whole LUN; the later error is only "partition not found".
  The 6T's LUN 0 entry count is not recorded in the repo. UNVERIFIED for the 6T; fail-safe (nothing is written).
- Fix: accept up to 256 entries (enlarge the scratch offset layout) and report the refusal reason in `oem gpt`. 1 hour.

### F-11 (P2) UFS timeout is host-side only
- Where: `ufs.c: slot_abort()` writes UTRLCLR; no ABORT TASK is sent, so the device may still complete a timed-out command and DMA into a buffer already reused.
  The flash then fails (`x.left = 0`), bounding the damage to the partition being rewritten and to scratch.
- Fix: after a timeout send a task-management ABORT or reset the host (`HCE` toggle) before reusing buffers. 0.5 day. Reference: Linux `ufshcd_abort`.

### F-12 (P2) A/B semantics are wrong for the 6T
- Where: `fastboot.c: fb_var` (`slot-count` 0, `has-slot:*` no); allowlist `userdata`, `boot`, `logo`. The 6T has `boot_a/boot_b/logo_a/...`; only `userdata` exists
  unsuffixed (the docs say "an A/B layout simply offers no `boot`"). Consequences: (a) Enxerto cannot persist itself to `boot` on the 6T, so the install is always
  `fastboot boot` and a power cycle returns to Android: the safest design, keep it; (b) on a non-A/B Poco F1 `fastboot erase boot` deletes the only boot image (not a
  brick, ABL fastboot lives in `abl`, but needs stock `boot` restored).
- Fix: report `slot-count` from the GPT suffix scan and document the allowlist per board. 1 hour.

### F-13 (P2) Entry assumes EL1
- Where: `start.S: _start` programs `vbar_el1` with no `CurrentEL` check. NOTES (OBSERVED on a Qualcomm SDM845 phone): "Entry EL1, MMU off". Under the Qualcomm
  hypervisor ABL runs at EL1, so the "EL2 to EL1 handoff" does not exist here. If another bootloader entered at EL2 the vectors would be wrong and the phone would hang silently.
- Fix: read `CurrentEL`; at EL2 either drop to EL1 (HCR_EL2.RW, SPSR_EL2, ELR_EL2, eret) or print an error. 2 hours. Reference: Linux `arch/arm64/kernel/head.S`.

### F-14 (P2) Loader continues when the MMU window failed
- Where: `loader.c`: `mmu_rc` is only printed; the copy then runs uncached (about 10 MiB/min inflate, per the file header). Minutes of unchanged screen look like a hang and a
  user will power-cycle (F-01). Fix: show "MMU off, slow path" on the boot screen. 15 minutes.

### F-15 (P2) Charger programming at first instruction
- Where: `enxerto.c: enxerto_charger_init(dtb)` runs before anything else; `charger.c` programs ICL/FCC over SPMI (PMI8998). INFERRED: values tuned for the Poco F1
  may be applied on the 6T (Dash charging, different battery). **Not audited line by line.** Fix: gate on `BOARD_*`, cap to conservative values on fajita. 1 hour.

### F-16 (P2) No lock on destructive commands
- Where: `fastboot.c: fb_flash/fb_erase`. Any host that sees VID 18d1:4ee0 can `erase:userdata`. By design; AGENTS.md's per-step confirmation is a host-side convention.
  Fix: an on-screen confirm (Vol Up) before the first write per session. 2 hours.

### F-17 (P3) `entry_va` not validated
- `loader_check` never checks that `entry_va` lies in a segment; a bad header jumps into zeros. 10 minutes.

### F-18 (P3) USB robustness
- `usb_dwc3.c`: fixed timeouts (5 s command reply, 20 s per bulk TRB); `usb_power.c` cold-boot path is best-effort (PHY supplies not handled, doc says so); HS only;
  `usb_dwc3_stop` leaves the PHY powered (fine: iOS boots after it, OBSERVED). Link loss during a flash is handled well (data is already in RAM, `fb_drop_session`).
  Fix: none required; keep the cold-boot limitation in the runbook.

### F-19 (P3) Whole 32 MiB framebuffer block is Normal-NC
- `mmu.c`: `l2[FB_PHYS >> 25]` maps 0x9c000000..0x9e000000 Normal-NC (speculative reads allowed, unlike Device). If a neighbour in that block is XPU-protected on the 6T a
  speculative access could fault. Works today (OBSERVED: logo shown on the 6T). Fix: L3 table for the framebuffer pages only. 1 hour.

### F-20 (P3) Fall-through paths
- `enxerto.c: enxerto_main`: after a failed fastboot start, 30 s then the legacy diagnostics (15 s + 15 s + 120 s) program GICD/GICR with the MMU off, then `reset(20)`;
  the code after `reset(20)` is dead. Fix: hold on the error screen. 30 minutes.

### F-21 (P3) Dead test code linked
- `test_smp`, `secondary_main`, `psci_line` and the milestone-2/3 diagnostics stay in the image. Put behind `bergamota.diag=1` or delete.

### F-22 (P3) UNMAP limits
- `ufs.c: ufs_unmap` uses 64 Ki-block descriptors without reading the device's maximum UNMAP LBA count. A strict device returns CHECK CONDITION, then the code zero-fills only up to
  1 GiB, so `erase:userdata` fails safely. Fix: read the Geometry/Block Limits value. 2 hours.

### F-23 (P3) Build and test hygiene
- `build.sh` has no `-Werror`, does not run `inflate_test.c`, and runs the host tests only as part of the image build (so a machine without `aarch64-linux-gnu-gcc` cannot run
  the 511 protocol tests). Fix: a separate host-only test target with ASan/UBSan (this audit ran exactly that: clean). `--os_version 16.0.0 --os_patch_level 2025-06` are hard-coded:
  UNVERIFIED whether the 6T ABL compares them with rollback state for `fastboot boot` (see section 2).
