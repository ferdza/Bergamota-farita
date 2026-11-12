# Audit: core platform drivers (OnePlus 6T / fajita, xnu-11215 series)

Date 2026-11-12. Scope: display/MDP/SMMU, UFS, USB device, touch, buttons, PMIC/SPMI/charger/battery/RTC,
reboot/poweroff/CrashDump, SMP/idle/cpufreq, GIC/timers, memory.
Method: the 231 patches of `xnu/patches-11215` were applied to a copy of `apple_xnu-11215` (all apply except the
HFS ones 0031/0041/0155, out of scope) and the resulting `bsd/dev/sweet_*.c` / `iokit/Kernel/arm/Sweet*.cpp`
were read. Reference: Linux master (WebFetch) and the local sparse Linux clone. Nothing was run on a phone.

Tags: **OBSERVED** = read in our code; **INFERRED** = follows from code + a reference; **UNVERIFIED** = needs a device/log.
Licence rule: XNU patches are APSL 2.0. Linux (GPL-2.0) is cited only as the source of an IDEA / register fact;
re-implement from understanding, do not paste.
Effort: S < 1 day, M 1-3 days, L > 3 days. Risk: what can break if done wrong.

---

## 0. Findings that matter most for the 6T (read this first)

| # | Finding | Tag | Prio |
|---|---|---|---|
| F-01 | The 6T fuel gauge is an external **TI bq27411 on i2c10 @0x55**, not the PMI8998 FG. `SweetBattery.cpp` / sweet_spmi read PMI8998 FG gen3 (SID 2, 0x40/0x41), which on fajita is not the authoritative gauge. | OBSERVED code + Linux DT | P1 |
| F-02 | The 6T panel is a **Samsung AMOLED** (`samsung,s6e3fc2x01-ams641rw`, DSI, brightness by DCS), there is **no WLED**. All backlight code (0242/0243/0246/0249, sweetfb_blfade) targets PMI8998 WLED and has no fajita gate. | OBSERVED + Linux DT | P1 |
| F-03 | CrashDump on any reset: kernel never clears the Qualcomm **download mode / SDI** (SCM calls), so any reset path enters CrashDump. | INFERRED | P0 |
| F-04 | iOS root is an **unjournaled HFS+**; kernel already builds `hfs_journal.c`; hard resets corrupt it (documented). | OBSERVED | P0 |
| F-05 | `sweet_smmu_map_sid` returns EBUSY (does not wait) when another thread holds the lock; USB then runs DMA with an unmapped stream = SoC reset. | OBSERVED | P1 |
| F-06 | UFS driver has no host error recovery (IS error bits only counted). | OBSERVED | P1 |

---

## 1. Reboot / poweroff / CrashDump (patches 0137, 0140, 0200s, 0260; `bsd/dev/sweet_reboot.c`)

What we have: PS_HOLD write (0x0c264000) -> 2 s -> PSCI SYSTEM_RESET; reason in PM8998 PON_SOFT_RB_SPARE (0x88f)
plus IMEM restart_reason (0x146bf65c); `BERG` magic for our own fastboot; `kPEHaltCPU` -> PSCI SYSTEM_OFF (0260);
UFS SYNCHRONIZE CACHE before the reset (`sweet_ufs_flush_final`). Gated by `sweet_board_beryllium()`, which the
fajita ADT satisfies.

**F-03 (P0, INFERRED) No download-mode/SDI disable.** FAJITA.md: OnePlus ABL arms CrashDump so *every* reset lands
there. Linux `drivers/firmware/qcom/qcom_scm.c` handles exactly this: `qcom_scm_set_download_mode(NODUMP)` (a masked
RMW of bits 5:4 at the TCSR `qcom,dload-mode` address through SCM IO read/write, or SCM boot call
`SVC_BOOT 0x01 / SET_DLOAD_MODE 0x10`), `qcom_scm_disable_sdi()` (`BOOT_SDI_CONFIG 0x09`, args 1,0) at probe, and
`qcom_scm_shutdown()` sets NODUMP so "a normal restart can occur after a clean shutdown". Our file uses only PSCI
(`smc #0`, fn 0x84000008/9) and the IMEM word `sr_imem[0]=0` (poweroff only, and only a guess that offset 0 is the
dload cookie: UNVERIFIED). Idea to copy: issue the same SMCCC SCM calls (service 1 cmd 0x10 with arg 0; service 1
cmd 0x09) from `sweet_reboot_restart`/`poweroff` and once at boot; the SMC convention is the same one already used
for PSCI. The TCSR address for sdm845 is not in mainline `sdm845.dtsi` (no `qcom,dload-mode` there, checked), so the
SCM-call variant is the one to try; `SCM_IO` (svc 5, cmd 1/2) read/write against a TCSR offset is the fallback.
Effort M, risk medium (a wrong SCM call can return error only; reset path unchanged on failure). Test with
`sweetreboot normal` on a throwaway boot.

**F-07 (P1, OBSERVED) Fallback ordering and the 2 s waits.** Restart: PS_HOLD, wait 2 s, then SYSTEM_RESET. If the
PMIC resets via PS_HOLD into CrashDump (F-03) the PSCI path is never tried. Reordering (PSCI SYSTEM_RESET first, as
Linux does through `psci_sys_reset` when no `restart` handler claims priority) is a cheap experiment. The brief
history in NOTES (2026-11-12: "PSCI SYSTEM_RESET before PS_HOLD" reverted because the build panicked, cause unknown)
means: do it as its own commit, boot-arg gated.

**F-08 (P2, OBSERVED) `sweet_reboot_poweroff` writes `sr_imem[0] = 0`** with no source for that offset (cookie
semantics unknown) - a stray write into IMEM used by other firmware. Remove unless a reference shows the offset.
`delay()` of 1 s inside a possibly non-preemptible path is fine; the final `while(1) wfi` is correct.

**F-09 (P2, OBSERVED) Panic path stays up** unless `sweetreboot=bootloader`: a panic never resets, so an unattended
phone is stuck on the panic screen drawing power; no panic log to flash except the UFS ring (sweet_ufs.c log).
Linux/Android use ramoops (`ramoops@0xac300000-0xac700000` is reserved on fajita per NOTES): writing the panic text
there survives a CrashDump/warm reset. Effort M, risk low.

---

## 2. SPMI / PMIC / RTC (0095, 0200, 0245; `bsd/dev/sweet_spmi.c`)

What we have: pmic-arb v5 observer reads (EXT_READL via `0x0e600000 + 0x80*apid`), write channels at
`0x0c600000 + 0x10000*apid`, a whitelist of writable registers, APID discovery by PPID, RTC offset kept in the
alarm data registers of the PM8998 RTC. Opcodes, status bits (DONE/FAIL/DENIED/DROPPED = 0x0e) and the offsets match
Linux `spmi-pmic-arb.c` v5 as far as read.

**F-10 (P2, OBSERVED) No interrupt/IRQ-owner handling, polling only** (`delay(1)` x1000). Fine at current rates; a
charger/FG interrupt (SMB2 `INT_RT_STS`) is never used, so plug/unplug is seen only on the 30 s read poll
(read-only default) or 3 s control poll.

**F-11 (P1, OBSERVED) Whitelist does not distinguish 6T hardware.** `sp_write_allowed`/`sweet_spmi_read` use the
beryllium branch for fajita (ADT lists both). On the 6T: SID 3 WLED writes are allowed but the panel has no WLED
(F-02): writes to WLED SYNC/BRIGHT are harmless but pointless, and the PMI8998 FG reads (0x40/0x41) are the wrong
gauge (F-01). Fix: consult `sweet_board_fajita()` before the beryllium branch in both functions.

**F-12 (P2, OBSERVED) Poison is permanent per APID** (`sp_poisoned[apid]`): one 1 ms-x1000 timeout disables the
peripheral for the boot (e.g. PON reason or RTC) with no retry. Linux retries after the arbiter reports done.
Add a timed un-poison after the status register shows idle. Effort S.

**F-13 (P3, OBSERVED) RTC offset in the alarm data registers.** Clever and documented; risk: if Android/TZ later
uses the same alarm (power-off alarm) the offset is overwritten, and `sr_offset` treats an armed alarm as "no
offset" (safe). Keep; note that RTC reads depend on `ctrl & EN`.

**F-14 (P3, OBSERVED) `sp_find_apid`** picks the last matching APID when none is owned by EE0; matches
Linux behaviour only approximately (Linux keeps the apid_to_ppid table per EE and rejects non-owned for writes).
Already refused at write time by the owner check. No action.

---

## 3. UFS storage and durability (0028, 0030, 0034, 0069, 0173, 0222; `bsd/dev/sweet_ufs.c`)

What we have: takes over the bootloader's UFSHCI, one transfer slot (UTRLDBR bit 0), **polled** (IE=0), 1 MiB bounce
buffer, 3 retries on transient SCSI/OCS, SYNCHRONIZE CACHE from a 5 s syncer thread and before reset, FUA via B_FUA
only with `ufsfua`, optional read-back verify, counters in `kern.sweet_ufs.*`, a 4 MiB persistent console ring at
the end of the partition, GPT lookup of `userdata`.

Good: slot clear on timeout uses `~1u` (correct UTRLCLR semantics, as Linux `ufshcd_clear_cmd`), bounded wait for the
device to release the window before reuse, writes bounds-checked inside the partition, UNIT ATTENTION/BUSY retried.

**F-04 (P0, OBSERVED) Unjournaled HFS+ root.** Renegade's writer (`hfswrite.rs`, `hfsedit.rs` refuses journaled
volumes) emits an unjournaled volume; the earlier iOS 16 root was built `mkfs.hfsplus -J`. The kernel already compiles
`hfs_journal.c` (0026). Even with the 5 s `VFS_SYNC(MNT_WAIT)` syncer, metadata is written in several non-atomic
steps; FAJITA.md documents real corruption (`HFSINC`, daemons loop). Options: (a) have Renegade write a journal
(Apple `hfs` source `core/hfs_journal.c`, APSL: journal info block + buffer layout) or (b) enable journaling on the
mounted volume at first boot through the HFS fsctl that `diskutil enableJournal` uses (UNVERIFIED which constant;
look at `hfs_vfsops.c` `HFS_ENABLE_JOURNALING`/`hfs_enable_journaling` in apple-oss-distributions/hfs, the repo we
already stage in 0026). The journal relies on DKIOCSYNCHRONIZE, which we implement. Effort M-L, risk medium (a
bad journal prevents mount; keep `rootrw` unjournaled fallback boot-arg). This is the single biggest data-loss fix.

**F-06 (P1, OBSERVED) No UFS error recovery.** `UFS_IS_ERR_MASK` bits (UE, ULLS link lost, DFES, UTPES, HCFES,
SBFES, CEFES) are counted and logged; nothing resets the host or re-establishes the link. A fatal IS error leaves
every later command timing out for 5 s x 4 attempts. Linux `ufshcd_err_handler`/`ufshcd_host_reset_and_restore`
(drivers/ufs/core/ufshcd.c) resets the host, re-links, restores the transfer list. For us: on fatal IS or two
consecutive timeouts, clear UTRLRSR, toggle HCE, re-run `ufs_take_over_host` equivalent, re-issue the command.
Hard: the link bring-up (UniPro/PHY) is done by ABL, so a full HCE reset may need the Qualcomm PHY init
(`ufs-qcom.c`, `phy-qcom-qmp-ufs.c`) that we do not have -> recovery limited to UTRLRSR restart + task-management
ABORT TASK. Effort L, risk high. Until then: after the first fatal error, flip the root read-only and flush log.

**F-15 (P1, OBSERVED) Timeout does not abort the device command.** After `UTRLCLR` we wait up to 100 ms for the
doorbell, then reuse the bounce buffer and retry. A device that still owns the data window (slow GC) could DMA later;
the code acknowledges this. Linux sends a Task Management ABORT TASK UPIU then clears. Effort M, risk medium.

**F-16 (P2, OBSERVED) Persistent log ring writes the userdata partition.** `sweet_log_thread` writes up to 4 MiB
every `ufslogsecs` (10 s) when console output changes and `-v` verbose boot output is on in daily args: sustained
write amplification on the user's only storage. It also takes `sweet_ufs_lock` for the whole flush (up to 4 MiB of
1 MiB writes + SYNCHRONIZE CACHE), stalling root I/O (SpringBoard hitches), and **stops permanently on the first write
error** (`return`). The area is "far behind the HFS image" but no runtime check that the HFS volume does not extend
into it (only the selftest parses the volume header). Fixes: write only dirty blocks (it already tracks pos), cap
the rate when the root is busy, retry instead of exit, check volume end once at start. Effort S-M.

**F-17 (P2, OBSERVED) Performance:** single slot, polled completion with a 50 us spin then 200 us sleeps, bounce copy
of every transfer, `strat` takes one global mutex, `DKIOCGETMAXSEGMENTCOUNT = 1`. The 5 s command timeout holds the
mutex. Idea: interrupts + multiple tags is large work (UFS runs in `ufs-qcom.c` with MCQ-less 32 slots); first cheap
step is queue depth 2-4 by chaining requests under the same mutex without the bounce for aligned buffers. Effort L.

**F-18 (P2, OBSERVED) Data coherence:** `dma_sync` is a real clean+invalidate by VA now (default `ufsdmasync=1`),
used with `civac` also on the receive side (safe only because the bounce is not dirty before DMA). OK. Note the
write path flushes with `dc civac` per line over 1 MiB (16k lines) per command: CPU cost; use `dc cvac` for
to-device and `ivac` for from-device (need `dc ivac` is privileged-allowed at EL1). Effort S.

**F-19 (P3, OBSERVED) 6T UFS specifics** (Linux `sdm845-oneplus-common.dtsi`): `reset-gpios = tlmm 150`,
`vcc-supply = l20a 2.95 V, 600 mA`. We never touch rails or reset (ABL's state is reused): fine, but UFS runtime
power (hibern8, clock gating, `vcc` off in suspend) is not managed: device stays active while screen off (P2 power).

---

## 4. USB device / CDC-ECM (0072-0077, 0081, 0084-0109, 0256, 0257; `bsd/dev/sweet_usb.c`)

What we have: DWC3 device with own event buffer polled by `ud_thread`, EP0 state machine, three data endpoints
(bulk OUT/IN, interrupt IN), one TRB per endpoint, CDC-ECM netif `ue0`, SMMU stream 0x740 mapped, VBUS forced by
QSCRATCH, optional raw vendor interface (0256), UDP log streaming (0257).

**F-20 (P2, OBSERVED) One buffer, one TRB in flight per direction.** RX has a single 2 KiB buffer re-armed only
after `ud_rx_done` copies the frame (poll interval 1 ms at best), TX one frame at a time. Upper bound ~1000
frames/s per direction (~12 Mbit/s), and a host burst while the RX TRB is idle NAKs. Linux `dwc3` uses a TRB ring
with a link TRB and the NCM gadget aggregates frames. Idea: 8-16 TRB ring + larger buffers, or CDC-NCM (needs host
driver support: macOS/Linux fine). Effort M-L.

**F-21 (P1, OBSERVED) RX completion is not validated.** `ud_rx_done` computes `len = UD_FRAME_MAX - (t[2] & 0xffffff)`
and never checks the TRB status field (bits 31:28 TRBSTS) or that HWO cleared; a short/errored/overrun transfer is
accepted as a frame of that length. Add the status check (Linux `dwc3_gadget_ep_reclaim_trb_*`). Effort S.

**F-22 (P2, OBSERVED) Cable detect is forced, never released.** `QSCRATCH` `UTMI_OTG_VBUS_VALID|SW_SESSVLD_SEL` are
set permanently at start (Linux `dwc3_qcom_vbus_override_enable(false)` on unplug via extcon/role switch). The
controller therefore always pulls D+ and the PHY stays powered with no cable; no suspend (DEVTEN = 0x7 only:
disconnect/reset/connect-done; no ULSTCHNG/suspend events, no `GUSB2PHYCFG.SUSPHY`, quirks cleared by fix&4).
Power cost small but constant; plus a host disconnect is seen only through DEVT disconnect. Use the charger's
USBIN/TYPE_C status (already read in sweet_charger.c) to toggle the override. Effort M.

**F-23 (P2, OBSERVED) Soft-reset policy is inconsistent in the code/comments.** `sweet_usb_fix_mask()` returns 7 on
beryllium (so `fix & 2` runs `sweet_usb_fix_core_reset()` and forces `do_reset=1`) while the comments above say the
soft reset was removed because the QMP PHY is not started (0089/0098). Reading the final order, the effective
behaviour on fajita is: PHY power-up, core+PHY soft reset, GCTL restore (`gctl_abl & ~(3<<6)`), GUCTL1 bits. It works
(observed on 6T), but the dead branch (`do_reset = beryllium?0:1`) misleads. Clean up and record the final recipe.

**F-24 (P3, OBSERVED) Misc:** `ud_epcmd` busy-waits up to 50 ms with `ud.lock` (mutex) held from the output path;
ENDTRANSFER is issued without waiting for the command-complete event (Linux waits/ignores per `DEPEVT_..`); TX frame
that is a multiple of 512 gets one pad byte instead of a ZLP (changes frame length; harmless for IP, wrong for a
raw/WebUSB consumer); `ud_if_detach` is empty so `ud.ifp` is never invalidated (use-after-detach impossible today
because it is never detached). `ud_log_thread` runs forever even with no host (the netif drops when `!configured`).

---

## 5. SMMU (0094, 0254; `bsd/dev/sweet_smmu.c`, credit anonbeat1/ios-sweet 0091)

What we have: one shared stage-1 context bank identity-mapping 8 GiB of DRAM as 1 GiB blocks (Normal NC),
SMR/S2CR programming for USB (0x740) and, on fajita, adoption of the MDP streams (0x880/0xc80) from ABL's bank.

**F-05 (P1, OBSERVED) `EBUSY` on lock contention.** `sweet_smmu_map_sid`/`adopt` do
`if (exchange(&smmu_lock,1)) return EBUSY;`. USB init (`sweet_usb_gadget_start`) and the framebuffer start from
different threads and `probe_sid` also takes the lock; the loser skips its SMR silently (USB only prints the return
value) and an unmatched stream faults -> "unidentified-stream fault during a live transfer resets the SoC" (the file
header's own warning). Replace with a spin-with-delay or a mutex, and make the USB caller abort `gadget_start` on
failure. Effort S, risk low.

**F-25 (P2, OBSERVED) Whole-DRAM RW identity map for every master.** No isolation: a mis-programmed USB/MDP/GPU
descriptor can overwrite kernel memory, and protected carve-outs rely on the hypervisor's stage 2. Acceptable for
bring-up; for robustness map only the pools the drivers use (UFS/USB DMA, scan-out pool). Effort L.

**F-26 (P3, OBSERVED) No fault visibility.** No global/context fault interrupt is enabled (CFIE set in SCTLR but no
handler); a fault shows up as a hypervisor reset/CrashDump with no log. Poll `SGFSR`/`CB_FSR` in the watchdog or the
log thread and print the fault address; invaluable for the next zero-copy debug. Effort S.

**F-27 (P3, OBSERVED)** `smmu_bank_create` picks the first context bank whose SCTLR.M is clear and not referenced by
a TRANSLATE S2CR; banks owned by the hypervisor/other VMs may read as free. Observed to work on the 6T; keep the
"read back S2CR" check (already there).

---

## 6. Display / MDP / scan-out (0079, 0091, 0096, 0126, 0127, 0129, 0211-0249, 0254, 0258; `SweetFramebuffer.cpp`, `sweet_fb.c`)

What we have: no DPU driver. The ABL splash scan-out is taken over by rewriting SSPP source address/stride, QSEED3
scaler, border colour and `CTL_FLUSH` on the existing pipe; page flipping among three buffers inside the 36 MiB
cont-splash region; zero-copy / scan-copy / GPU-blit variants; vsync emulated by a timer (`sweetfb_hz`).

**F-02 (P1, OBSERVED + Linux DT) Backlight/panel model is wrong for the 6T.** Linux `sdm845-oneplus-fajita.dts`:
`compatible = "samsung,s6e3fc2x01-ams641rw"`, TE gpio 10, reset gpio 6, supplies `l14a` + panel_vci 3.3 V. No WLED:
brightness is a DCS command (10-bit, `mipi_dsi_dcs_set_display_brightness_large`, max 1023) over DSI. Our
`blInit()` reads PMI8998 WLED (SID 3, 0xd8/0xd9); on the 6T that returns 0/off -> "pixel fallback": screen off is a
`memset` black while the OLED, DSI link and MDP keep scanning at full rate. Consequences (INFERRED): the brightness
slider does nothing, screen-off power is high (OLED black pixels are cheap but DDR/MDP/DSI stay on), and
`brightness-nits` (0243/0249) maps to a nonexistent device. To control brightness we must issue DSI DCS writes
(MIPI DSI command mode: DSI_CMD_MODE_DMA registers in the DSI controller, 0xae94000 on sdm845) - the same idea as
Linux `msm/dsi/dsi_host.c` `dsi_cmds2buf_tx` and the panel driver's `update_status` (clears LPM flag, writes
0x51-class command, restores). Panel init is not needed (ABL initialised it). Effort L, risk medium (a bad DSI
command FIFO write can stall the link; do it only in a vblank gap; keep a boot-arg). Reference for the command
sequence and timing: `drivers/gpu/drm/panel/panel-samsung-s6e3fc2x01.c`, brightness default 512/max 1023. Also needed
for true screen-off: DCS `set_display_off` + sleep-in (panel's own power-off sequence: ~160 ms) and MDP/INTF disable.

**F-28 (P2, OBSERVED) No real display power-down.** `RequestPowerChange(0)` = backlight 0 (or black memset). INTF
timing engine, DSI, MDP clocks and the fb DDR traffic continue at 60/30 Hz. Largest standby power item with the GPU
idle. Needs F-02 first.

**F-29 (P1, OBSERVED) `waitLatch` / flush are unbounded-by-design in hot paths:** 25 ms `IODelay` poll on
`CTL_FLUSH`; on timeout it only warns once and continues, so frames may tear and the same buffer may be written
while scanned (`scanReplaced` counts it). Acceptable, but the panic hook `sweet_fb_restore_boot_scanout` writes
MDP registers without checking the MDP is clocked/powered; OK while ABL left it on. Keep.

**F-30 (P2, OBSERVED) Raw MDP MMIO with plain `volatile` stores and `dsb sy` only at flush points;** register state
for restore is captured once (`sweet_mdp_restore`, max entries `SWEET_MDP_RESTORE_MAX`, silently dropped when full:
`SWEET_RESTORE_ADD` has no overflow report). If the list overflows the panic screen is wrong. Add an overflow log.

**F-31 (P2, INFERRED) Vsync is a software timer, not the panel TE/INTF interrupt.** Frame pacing, `latch` guess and
the `sweetfb_hz=30` default stem from this. The MDP INTF vsync interrupt (MDSS irq 115 on sdm845 via the
mdss intc) or at least the INTF frame counter (`INTF1+0xac`, already read in `mdpProbe`) could drive the clock. The
frame counter exists: use it to phase-lock the timer. Effort M. Reference: Linux `dpu_hw_intf.c` get_status / frame
count, `dpu_encoder` vsync irq.

**F-32 (P3, OBSERVED)** HUD/stat code (`hudRender`, `statsTick`, trace ring 128 entries, relaxed races) ships in the
daily kernel; races are benign but add per-frame cost. Gate by `sweetfb_hud`.

(Sections 7-12 continue below.)
