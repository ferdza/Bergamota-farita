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

## 2. Boot chain on the OnePlus 6T (stock ABL, A/B, CrashDump)

What is known (sources: repo notes = OBSERVED on the user's 6T; web = third-party forum/blog text, not official Qualcomm/OnePlus documents):

- ABL starts Enxerto from `fastboot boot` (header v1, gzip'd Image with the DTB appended; `build.sh`). The 6T is A/B: no `recovery` partition, TWRP-style images are
  run with `fastboot boot` (web: LineageOS/XDA guides, search results). Enxerto is entered at EL1, MMU off, x0 = ABL-patched DTB (NOTES: observed). The Qualcomm
  hypervisor owns EL2, so there is nothing to hand over (see F-13).
- The boot.img DTB is SoC-only; board nodes live in the DTBO (docs/FAJITA.md, OBSERVED). Enxerto only needs `/chosen`, `/memory`, the splash carve-out and IMEM
  from it, and the kernel gets the ADT, so the DTBO matters little (F-27).
- A reset after a non-Android OS lands in Qualcomm CrashDump (FAJITA.md OBSERVED; also a Windows-on-6T report: "shutting down still triggered CrashDump",
  edk2-porting/WOA-Drivers issue 26, web). Downstream `msm-poweroff.c` sets the download-mode cookie in IMEM (`qcom,msm-imem-download_mode`, magic words
  0xE47B337D / 0xCE14091A in older trees) only for panics or `RESTART_DLOAD`, and writes zeros to clear it on every other restart and on power-off (web: Android
  kernel/msm `msm-poweroff.c` fragments). XNU never writes those zeros. INFERRED: this is why any reset on the 6T ends in CrashDump. The exact IMEM offset on SDM845 is
  UNVERIFIED here: read the `qcom,msm-imem-download_mode` node of a running Android 6T.

### F-24 (P1) No clean power-off or return-to-ABL path anywhere
- Where: `fastboot.c` handles `reboot`, `reboot-bootloader`, `continue` only; Enxerto has no `PSCI SYSTEM_OFF` (0x84000008) and no `oem poweroff`; kernel `PE_halt_restart` for off is
  patch 0260 (NOTES 2026-11-12, "not redone, unverified").
- Why: the only way to turn the phone off from Enxerto fastboot or a panic screen is a long Power press, i.e. a hard reset, i.e. CrashDump plus HFS+ damage risk (F-01).
- Fix: `oem poweroff` (SYSTEM_OFF, after clearing the cookie as in F-01) and `oem reboot-android` (cookie cleared, restart reason 0, PON spare 0). Effort: 0.5 day once the cookie is known.

### F-25 (P1) Never relock; the unlocked-bootloader assumption is load-bearing
- Where: `fastboot.c` reports `unlocked yes`, `secure no` unconditionally; `build.sh` makes an unsigned boot.img (no AVB footer). UNVERIFIED on hardware but standard
  AVB behaviour: a locked bootloader rejects `fastboot boot` of an unsigned image, and relocking with modified `boot`/`userdata` is the classic brick. The runbook must say "do not run
  `fastboot flashing lock` / `fastboot oem lock`".
- Fix: Enxerto should read the real lock state from ABL's cmdline (`androidboot.verifiedbootstate=orange`, `androidboot.flash.locked=0`) and refuse writes if it is
  not as expected; the web flasher must not offer "relock". Effort: 1 hour.

### F-26 (P2) A/B slot state is invisible to the install path
- Where: `docs/INSTALL.md`, `apps/web` flasher, `fastboot.c` (`slot-count 0`). Web (Sailfish OS forum, via search): on the 6T `fastboot boot` of a recovery image works reliably only
  with a matching active slot ("confirm slot B is active, then fastboot boot"), and a TWRP image after an OxygenOS 11 update dropped into CrashDump (XDA crDroid thread, via search).
  INFERRED: the DTBO/firmware ABL picks follows the active slot; a half-updated device (slot A new, slot B old) may behave differently for `fastboot boot`.
  Also INFERRED (general A/B behaviour, not 6T-specific): booting Android repeatedly with an iOS `userdata` consumes the slot's retry counter and may flip slots.
- Fix: record `fastboot getvar current-slot` and `slot-successful:a/b` into the install log before touching anything; in the runbook add `fastboot --set-active=<slot>` back to the slot
  that was active. Effort: 1 hour. UNVERIFIED on the user's phone.

### F-27 (P2) `fastboot boot` with a header-v1 image has no DTBO of its own
- Where: `build.sh` (`mkbootimg --header_version 1`, no `--recovery_dtbo`). ABL applies a DTBO (the board/touch nodes, per FAJITA.md); which DTBO it applies for a header-v1
  `fastboot boot` image (the active slot's `dtbo_a/b`, or none) is UNVERIFIED. Enxerto's own needs (splash 0x9d400000, IMEM) are in the SoC DTB, which explains why it works.
- Why it matters: if Enxerto ever starts reading `/memory` or `/reserved-memory` for F-04 it must handle both the overlaid and the bare tree.
- Fix: dump the DTB Enxerto receives (`oem dtb` returning the blob over `upload`) on a real 6T once and commit the sanitized `/memory`/`/reserved-memory` summary. 2 hours.

### F-28 (P2) Hard-coded identity of the fastboot device
- Where: `fastboot.c` (`serialno` = bergamota0001, `unlocked yes`, `secure no`, `version-bootloader` bergamota-2), `usb_dwc3.c` descriptors, CDC-ECM MAC 02:00:5e:77:ee:01.
  Two phones on one host collide for `-s` selection and the host MAC/IP (192.168.7.x). Fix: derive the serial from the SoC serial (`androidboot.serialno` in the ABL cmdline). 1 hour.

### F-29 (P1) Unjournaled HFS+ plus hard resets is the real data-loss mechanism
- Where: Renegade's root writer (HFSX, unjournaled; FAJITA.md "Known issues", NOTES 2026-11-04 "HFSINC": 120 inconsistencies after repeated hard resets).
  The upstream ios-sweet line built its root journaled (`mkfs.hfsplus -J`, "Image v4 (JOURNALED)" in the reference clone `urielc918_ios-switch/docs/upstream/NOTES-sweet.md`).
- Why: until F-01/F-24 are fixed, every panic, every CrashDump and every long Power press is a hard reset.
- Fix: write the journal header in Renegade's HFS writer (or run `fsck.hfsplus` from Enxerto-side tooling before first boot), and add a clean `sync` + `reboot` before any Enxerto
  reset when iOS is running. Effort: 2-4 days for a journal; 1 day for an fsck-on-install step.

### F-30 (P2) Install erases the Android data without a restore plan in the tools
- Where: `docs/INSTALL.md` step 1 ("erases Android's data, nothing else is written"), AGENTS.md (user approved; confirm each destructive step). Android's `boot_a/b`, `system`, `vbmeta`, `persist`, `modem`
  stay intact, so Android itself is recoverable (it will offer a data reset / boot recovery). Not covered: the `metadata` partition and Android keystore state may refer to the erased `userdata` (INFERRED);
  and the AGENTS.md rule to preserve partition backups needs the backup to exist before the flash. Fix: the flasher should refuse to flash `userdata` until a backup of `persist`, `modem*`, `efs`
  (`fsg`, `modemst1/2`) exists in `backup/` (web: Windows-on-6T maintainers say LTE needs QCN/EFS backups before replacing the OS). 2 hours.

### Risks of the current `fastboot boot` + userdata install (summary)
1. Android is untouched except `userdata`; a power cycle returns to Android's ABL path (safe by design). OBSERVED design.
2. A failed `fastboot boot` lands in CrashDump or in ABL fastboot (web: "phone sits on the fastboot screen and does nothing" after a bad `fastboot boot`).
3. Interrupting the 15 GB `userdata` write leaves a half-written HFS+ (not a brick, re-flash).
4. Everything after the first boot depends on F-01/F-29.

## 3. ADT generation (`tools/mkadt.py`, `tools/mkpayload.py`)

Run here: `mkadt.py --board fajita --highmem --display-scale 3` and `--board beryllium` produce 10780 / 10764 byte trees (no /product: the D22AP seed is an Apple
artifact kept out of git, absent here). A diff against the real iPhone10,3 D22AP tree or other projects' ADTs **could not be done in this sandbox** (UNVERIFIED);
the method is given in F-39.

### F-31 (P1) `mkadt.py` succeeds (exit 0) without `/product`
- Where: `d22ap_product()` prints `warning: ... missing, no /product node` and returns None; `build()` then writes a tree without `/product` and the script exits 0 (OBSERVED: I ran it).
  Without `/product` MobileGestalt has no device class/artwork/home-button data and the userland misbehaves in ways that look like unrelated crashes. Today `mkboot-full.sh`/`build-boot.sh`
  would carry on and produce a flashable image. FAJITA.md tells the user "no 'no /product node' warning" by eye.
- Fix: exit non-zero unless `--allow-no-product`; size-check the ADT (~13.4 KB expected). 10 minutes.

### F-32 (P1) Kernel RAM window is hard-coded, not derived from the phone
- Where: `mkadt.py`: `HIGH_PHYS_BASE 0x100000000`, `HIGH_MEM_SIZE 0xfcc00000` (all DDR above 4 GiB, derived from the **Poco F1** live FDT), fajita low window `mem=(0x9f800000, 0x0f800000)` with the comment
  "RE-VERIFY against fajita's live FDT". The payload (`mkpayload.py`) copies it into `phys_base`/`mem_size`; Enxerto trusts it (F-04). The repo notes disagree about the F1's own layout
  (`<0x80000000 2G>,<0x1_00000000 0xfcc00000>` vs `<0x80000000 0xc0000000>,<0x1_40000000 0xbd4a0000>`), and the OnePlus 6T ships in 6 GB and 8 GB variants (INFERRED from
  retail specs; not in the repo). A window larger than the phone's DRAM or covering a carve-out is a wild write to protected memory: CrashDump.
- Fix: have Enxerto compute `dram-base/size` at boot from the ABL DTB `/memory` minus `/reserved-memory`, and patch the ADT (and boot_args) in place before copying it (UniXNU patches the DTB at boot, see section 4);
  keep the build-time value only as a cross-check that refuses to boot on mismatch. Effort: 1 day. Reference: UniXNU `DarwinBoot` window validation.

### F-33 (P2) `random-seed` is fixed per image
- Where: `mkadt.py`: `seed = os.urandom(256)` at build time; Enxerto copies the ADT verbatim. Every boot of one image gets the same seed. XNU mixes other entropy later, but early
  ASLR/stack-protector/kernel PRNG state is deterministic per image. Fix: Enxerto overwrites the 256 bytes at boot (cntpct jitter, the SoC PRNG block, UFS serial, ABL's `androidboot.*` hashes
  through BLAKE2b). 2 hours.

### F-34 (P2) Identity mismatch: iPhone X (A11) tree under an iPhone XR (A12) iOS 18 root
- Where: `IDENTITIES['d22ap']` (iPhone10,3, `chip-id 0x8015`), `FAJITA.md`: "iOS 18 boots with the iPhone X identity" while the root is iPhone11,8 (XR, A12, 0x8020). iOS 18 does not support the iPhone X.
  OBSERVED to boot to SpringBoard; INFERRED risks: `SupportedProductTypes`/`SupportedDeviceTypes` checks (softwareupdated, MobileAsset, restore), MobileGestalt keys derived from `chip-id`/`board-id`
  (`mkpayload.py` adds `board-id 6` = D22AP BDID), Image4/trust paths keyed on chip. Fix: build an `n841ap`/iPhone11,8 identity (tree from the iPhone11,8 IPSW, same method as `n104ap`) and A/B test.
  Effort: 1 day. Reference: `IDENTITIES` already supports `n104ap`.

### F-35 (P2) fajita framebuffer carve-out size is copied from beryllium
- Where: `BOARDS['fajita']['fb'] = (0x9d400000, 0x2400000)` (36 MiB); `board.h` has the same base. Base is "confirmed in the stock DTB"; the size is "verified against the iOS-16 fajita port's mkadt", not
  against the 6T stock DT. If the real `cont_splash` region is smaller, the kernel's framebuffer/scan-out (up to 1125x2436x4 backing plus copies) can write past it. UNVERIFIED. Fix: read the size from the
  DTB (`cont_splash_region` `reg`) in Enxerto and patch `sweet-fbcon`. 1 hour.

### F-36 (P3) Synthetic identifiers are identical on every phone
- `SWEET_ECID`, the Wi-Fi/Bluetooth MACs (`...:e0:02`, `...:b0:01`), CDC-ECM MAC and 192.168.7.0/24: two phones on one LAN or one USB host collide; `IOPlatformUUID` is derived from the ECID so
  all phones share a "unique" id (CFPreferences ByHost files, keychain-like state). Fix: derive them from the SoC serial in Enxerto's ADT patch step (F-32). 1 hour.

### F-37 (P2) `mkpayload.py` truncates the boot-args silently
- Where: `cl = cmdline.encode()[:BOOT_LINE_LENGTH - 1]` (607). `mkboot-full.sh` guards its own default (hard error above 607) but any other caller gets a cut-off last argument (an incomplete
  `sweetdenypath=` or `rootrw=` changes behaviour). Fix: raise instead of truncate. 5 minutes.

### F-38 (P3) `mkpayload.py` validation
- Uses `assert` for format checks (disabled under `python -O`), takes the entry only from `LC_UNIXTHREAD`, and does not check that the kernel plus ADT fit inside `mem_size`, or that segments do not overlap.
  The loader repeats most checks (good) but only for downloads (F-03/F-04). Fix: real exceptions plus overlap/fit checks, mirrored from `loader_check`. 1 hour.

### F-39 (P2) Missing-property audit against a real D22AP tree has never been automated
- The ADT is "the minimum that boots" (mkadt.py header). Properties real iBoot trees carry that iOS 18 may read are found one crash at a time (cryptexd/libimage4 needed `/chosen/manifest-properties`,
  mobileactivationd needed the security tuple, `/sbin/mount -P 1` needed `boot-manifest-hash`, per the code comments). Method to close it: (1) dump the real D22AP/N841AP trees with `tools/adt.py`
  (`research/` copies; Apple artifacts, not in git); (2) extract every `IORegistryEntryFromPath`/`IODeviceTree:` string and `PE_get_default`/`DTGetProperty`/`SecureDTLookupEntry` name from the shared cache and the
  XNU patches (`xnu/patches-11215`); (3) report properties present in the real tree and read by the above but absent in ours. Effort: 1-2 days. Output: a checked-in list of "known-needed" properties and a test in
  `tools/validate-repo.py`.

### F-40 (P3) `--lowpool` refuses the 6T
- `mkadt.py` rejects `--lowpool` unless `board == 'beryllium'`, yet docs mention zero-copy scan-out on fajita (`sweetfb_zc`). Today the kernel default (0xb0400000 + 252 MiB) is used; that
  overlaps the Enxerto download buffer (0xb8000000 + 1 GiB) only while the buffer is alive (OBSERVED in the comments, fine). Fix: allow `fajita` once the 6T carve-outs are verified (F-32/F-27).

### Highmem and display-scale logic (reading notes, OBSERVED)
- `--highmem` selects the upper DDR bank for the kernel (3.95 GiB) and leaves the whole low bank to ABL/TZ/carve-outs and to Enxerto's download buffer, which is why the loader refuses a payload that overlaps
  `[phys_base, +mem_size)` (`loader_check`). Without `--highmem` the kernel lives in a 248 MiB low window: too small for iOS 18 (FAJITA.md always uses `--highmem`). Make `--highmem` the only supported mode for iOS 18
  or fail loudly.
- `canvas = points x scale` (375x812 @3x = 1125x2436) is scaled onto the 1080x2340 panel by the kernel; aspect error 0.07 % (OK). `sweet-fbcon` (`reg/width/height/stride`) and `board.h` must change
  together: a single source of truth (generate `board.h` values from `BOARDS`) would remove that drift risk. 1 hour.

## 4. What to adopt from other projects

Sources read: local clones `UniXNU_UniXNU` (docs/concepts/boot-chain.md, docs/drivers/darwin-boot.md), `urielc918_ios-switch` (shim-nx README, upstream NOTES-sweet.md) and the web results
cited in section 5. U-Boot for `nabu`, iOSPlus10 `DarwinBoot` (SM8450) and hackiosx.dev were **not** fetched (UNVERIFIED; items marked "general" come from public knowledge of those tools, not from a source read here).

| Project | How it boots | Pattern worth adopting | Maps to |
|---|---|---|---|
| UniXNU / DarwinBoot (read) | Android bootloader -> BootShim (gzip'd, ARM64 image header) -> Mu/EDK2 UEFI FV -> UniXNU boot manager (TOML, kits) -> DarwinBoot -> XNU at EL1, MMU off | **Validation list before the jump**: Mach-O magic/cpu type/filetype, entry inside an executable segment, segments page aligned, non-overlapping and inside the window; trust-cache header/offset/sorted-hash checks; the ADT is copied with 64 KiB slack and **patched at boot** (global, entry, then `[entry.chosen]` last); boot-args built by the loader | F-04, F-17, F-32, F-33, F-36 |
| Mu / EDK2 for the 6T (`mu_platforms_oneplus6t`, WOA-Drivers issue 26; web, not fetched in full) | `fastboot boot uefi.img` on the same phone, same ABL | A second, independent description of the 6T memory map (FD base/size, reserved regions) to cross-check `HIGH_*` and the framebuffer region; UEFI also offers GOP, a shell and variables. Cost: a full firmware stack, and the same CrashDump on shutdown (WOA issue 26) | F-32, F-35 |
| ios-switch `shim-nx` (read) | hekate -> ATF -> shim -> XNU on Tegra | Blue PANIC screen with ESR/ELR/FAR **plus a log on the SD card**, "Volume-down at any time (also on the panic screen) reboots to RCM", self-tests at boot | F-09, F-07, F-24 |
| ios-sweet (read: NOTES-sweet) | same family as this repo | **Persistent console log**: kernel `_cnputs` ring written to the last 4 MiB of `userdata` every second with SYNCHRONIZE CACHE (patch 0047), read from recovery; **journaled HFS+** root (`mkfs.hfsplus -J`, "Image v4") | F-09, F-29 |
| U-Boot (general; nabu docs not read) | proper bootloader with env, fastboot, `bootm`/FIT | FIT-style hash/signature check of the payload; `fdt` fix-up commands (resize, set `/chosen`, `memory`); an environment for the command line instead of a rebuild per boot-arg | F-03, F-37 |
| iOSPlus10 DarwinBoot (SM8450; not read) | UEFI, per its docs | same loader protocol as UniXNU's DarwinBoot | F-04 |

### Concrete adoptions, ranked by value for the 6T

1. **Clear the Qualcomm download-mode cookie on every Enxerto exit and from the kernel reboot path** (F-01/F-24). Without it every other robustness item is moot on the 6T.
2. **Persistent crash/console log** (F-09): panic record into `ramoops`, plus the ios-sweet ring-in-userdata trick for the kernel. A `fastboot oem log` that returns it with `upload`.
3. **ADT patching in Enxerto** (F-32/F-33/F-35/F-36): memory window from the live DT, framebuffer carve-out size, per-boot random seed, ECID/MAC from the SoC serial. UniXNU does exactly this (copy + 64 KiB slack + patches).
4. **Payload verification** (F-03/F-04/F-17): BLAKE2b hash in the header (the primitive is already linked) and UniXNU's segment/entry rules. Signatures only if a locked-bootloader flow ever exists (it cannot on the 6T with a custom `boot`).
5. **Journaled HFS+** or an fsck step (F-29).
6. **A real recovery console in Enxerto fastboot**: `oem poweroff`, `oem reboot-android`, `oem log`, `oem dtb`, `oem cmdline:<args>` (one-shot override of the payload's boot-args held in RAM, so recovery boot-args such as `sweetdenypath=` need no rebuild), `oem getvar current-slot`. All can stay inside the existing allowlist model because none writes storage.
8. **EL2 handling** (F-13): not needed on Qualcomm (EL1 entry, hypervisor owns EL2). UEFI-based projects also leave at EL1 with the MMU off, so Enxerto's final handoff (`mmu_off_jump`, caches cleaned to PoC, MMU off, `x0 = boot_args`) is the same contract. Only add a `CurrentEL` guard.
9. **"kexec-like" warm reboot** (iOS -> Enxerto fastboot without a reset): keeps the CPU/PMIC state and sidesteps CrashDump entirely. Needs: Enxerto image kept in a reserved region (ADT `memory-map`), kernel parks CPUs 1-7 with PSCI CPU_OFF, quiesces UFS/USB/SMMU, then branches. Effort 3-5 days and a new class of bugs; only worth it if F-01's cookie turns out not to be the cause. UNVERIFIED feasibility.

## 5. Recovery runbook for the OnePlus 6T

Only steps found in a source are listed; each carries its source. Where sources disagree both are shown. Nothing below was run on a phone in this audit.

**Before anything destructive** (AGENTS.md + sources): keep the existing partition backups; additionally back up `persist`, the modem/EFS partitions (Windows-on-6T maintainers: LTE needs QCN/Modem+EFS saved
via TWRP or the MSM tool before the OS is replaced, WOA-Drivers issue 26). Confirm each destructive step with the user (AGENTS.md).

### R1. Leaving Qualcomm CrashDump
- Repo (OBSERVED by the user, docs/FAJITA.md): hold Power + Vol Up for ~15 s.
- Web (blogs, via search; unverified): hold Vol Up + Power ~10 s (powers off); another says Vol Up + Vol Down + Power 5-10 s; a third says that combination from the CrashDump screen goes to fastboot. They conflict:
  try Power + Vol Up first (the only one the user has seen work), then the three-key chord.
- UBports forum: "hold for bootmode as long as you humanly can, and when you can hold no more it should turn on."
- Do not repeat this on a running iOS (HFS+ risk, F-29); the order is: avoid the reset, not recover from it.

### R2. Getting to fastboot
- From a running iOS: `ssh root@192.168.7.2 sweetreboot fastboot` (docs/FAJITA.md, REBOOT_MODE.md). On the 6T this is itself UNVERIFIED because 0137 was written for beryllium (F-01/F-02).
- From Enxerto fastboot: `fastboot reboot-bootloader` (IMEM only, F-02) — may end in CrashDump.
- With the phone off: the standard key chord (Power + Vol Up + Vol Down) is mentioned in the web results above for the 6T; the exact chord for ABL fastboot was not confirmed from an official source here (UNVERIFIED).
- A bad `fastboot boot` can leave the phone "on the Fastboot Mode flashscreen and doing nothing" (XDA thread via search): hold the CrashDump/power-off combination (R1) and retry with the other slot active (R4).

### R3. EDL (9008) and the MSM Download Tool
- UBports forum (Windows tool, from a user): install the driver once while the phone is in CrashDump mode connected to the PC; then unplug and power off; start the MSM tool; "hold the volume up on the phone
  and at the same time just plug it to PC"; the tool detects the device and runs.
- Web (via search, several sources): the MSM tool talks to the phone over EDL and restores stock OxygenOS; "EDL flashing is not dependent on the bootloader state" (community reports).
  MSM restores the whole device (including `persist` and modem), so it is the last resort and **erases the iOS install and Android user data**; use it only when R1/R2/R4 fail and confirm with the user.
- Not found in any source read: a `fastboot oem edl` / `adb reboot edl` command for this ABL. Do not assume one exists.
- Charge: a user advises charging ~24 h or attaching to a powered-on PC before restore attempts (UBports forum; anecdotal).

### R4. Fastboot-level restore of Android (Linux)
- Slots: flash both A and B when restoring (LineageOS/XDA guides, via search). To keep the other slot, skip wiping data and skip `persist` (UBports forum, AntiDroid `flash_all.sh`, OnePlus 6T only).
- If `fastboot boot` of a recovery fails, confirm which slot is active (`fastboot getvar current-slot`) and switch (`fastboot --set-active=b`) before retrying (Sailfish OS forum, via search). If it persists, restore stock with the
  MSM tool (R3).
- Stock fastboot images: the XDA "stock fastboot ROMs for OnePlus 6T" thread (found via search; not fetched here).
- What the iOS install touched: only `userdata`. Android then offers a data reset; or `fastboot erase userdata`/`-w` from ABL (not from Enxerto, F-12).
- **Never** `fastboot flashing lock`/`oem lock` with modified partitions (F-25).

### R5. Rebuilding iOS afterwards
- If HFS+ errors appear (`SWEET HFSINC`, daemons crash-looping): re-flash the root (docs/FAJITA.md "Known issues"). Leave iOS only with `sweetreboot fastboot`/`normal` after a flush.
- Recovery boot-arg for the GPU inject: `sweetdenypath=/usr/local/lib/bgmtl/bgmtl-inject.dylib` (docs/FAJITA.md, INSTALL.md).

## Items not covered or not verifiable here

- `BOARD=fajita enxerto/build.sh` (needs `aarch64-linux-gnu-gcc`, `mkbootimg`, `cpio`; the stock DTB is a gitignored device dump) was not run; host tests and a clang cross-compile were (header of this file).
- `charger.c` (611 lines), `pmic.c`, `charge_mode.c`, `usb_power.c`, `console.c`, `bootui.c`, `inflate.c`, `fdt.c` were only skimmed for interfaces; F-15 is therefore flagged, not proven.
- Comparison with real iPhone11,8/D22AP ADTs and with other projects' ADTs (F-39) needs Apple artifacts that are not in this sandbox.
- No hardware: every "lands in CrashDump" statement about Enxerto's own reset is INFERRED.

## Sources

- Repo: `docs/FAJITA.md`, `docs/BERGAMOTA_FASTBOOT.md`, `docs/BERGAMOTA_CHARGE.md`, `docs/REBOOT_MODE.md`, `docs/INSTALL.md`, `NOTES.md` (2026-11-03/04 entries), `enxerto/*`, `tools/mkadt.py`, `tools/mkpayload.py`.
- Local read-only clones: UniXNU `docs/concepts/boot-chain.md`, `docs/drivers/darwin-boot.md`; ios-switch `shim-nx/README.md`, `docs/upstream/NOTES-sweet.md`.
- Web: UBports forum "Restore Bricked OnePlus 6T on Linux" (https://forums.ubports.com/topic/5715/restore-bricked-oneplus-6t-on-linux); edk2-porting/WOA-Drivers issue 26 (https://www.github.com/edk2-porting/WOA-Drivers/issues/26);
  Android `kernel/msm` `msm-poweroff.c` (https://android.googlesource.com/kernel/msm/+/a34dd933e47a58ae3569a59a854137683a62d7c1/drivers/power/reset/msm-poweroff.c);
  mobile-nixos fajita page (https://mobile.nixos.org/devices/oneplus-fajita.html); search results for CrashDump exit, `fastboot boot` on the 6T and slot behaviour (XDA crDroid thread, Sailfish OS forum, crDroid/LineageOS install pages; snippets only).
