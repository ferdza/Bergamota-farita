# What the other 6T / SDM845 ports learned that we lack (2026-11-12)

Sources (read-only; licences in `6T_FACTS.md`): `edi194_ios-fajita` (iOS 16.7.16 on the 6T; `NOTES-FAJITA.md` 5775 lines, no licence: ideas only),
`johnpanos_UniXNU-fajita` (6T, iPadOS 17, UEFI based) and `keyfan_UniXNU-enchilada-bringup` (OnePlus 6, same SoC) both BSD-2-Clause-Patent,
`WeiXiaoye_perseus-xnu` (Mi Mix 3, SDM845), `dipa-studio_ios-sweet` / `urielc918_ios-switch` (journaled HFS+ roots). OBSERVED = in a file; INFERRED = mine.
edi194's tree is the **iOS 16 / xnu-8796** line derived from ios-sweet, and its GPU ladder was ported from **our** `0103`/`GPU_A630_BRINGUP.md`
(`NOTES-FAJITA.md:1166-1202`), so most of its bugs are bugs in their re-implementation, not in ours.

## 1. The SMMU fault under the CP: cause and does it threaten our GPU?

What they see (`NOTES-FAJITA.md:5699-5775`, console172-174): `client fence timeout ... rptr==wptr, rbbm_status 0x800005 (CP busy, AHB master busy), ib1 rem 24 dwords,
ib2 rem 0, smmu cb1 fsr 0x402 far 0x80725600`, GX rail up (`gx_gdscr 0xf8222000`, hw_fault 0). `0x80725600` is the target of the first `CP_INDIRECT_BUFFER`
of the window server's 194-dword pass. Then `iovacheck` shows every page of the BO mapped at submit time (`bo 9 iova 0x80724000 size 4 MiB ok`) but, 2 s later,
`smmu cb1 far 0x80725600 pte 0`: **the page's PTE was removed while the CP was inside the BO** (`:5741-5767`). Only `sweet_gpu_vm_unmap()` writes a zero PTE. Their
last entry adds logging (0214) to find which caller did it; **the notes end there, unresolved.**

What they believe: not the rail (GX up), not a refused register, not the pipe (the kernel's own CP_INDIRECT_BUFFER test passes): a client-BO mapping problem. Earlier theories
they disproved: GX collapse (`:5545-5560`, 0209), wrong IOVA (iovacheck ok), SMR/S2CR writes (see 2.3).

The likely mechanisms they found on the way (all in *their* BO layer):
1. `gemNew()` wrapped carve-out RAM with `IOMemoryDescriptor::withPhysicalAddress()`; pmap treats those pages as managed ("physical with managed page" 30+ times per boot); when a BO
   was freed IOKit's device pager returned the pages to the VM while the arena reused them: two live owners, GPU writes into pages the VM reassigned, silent reset after ~1000 BOs
   (`:5657-5692`). Fix 0212: `IOBufferMemoryDescriptor` + explicit `dc civac/ivac` by KVA.
2. Per-page `gpu_tlb_invalidate()` in map (thousands per boot; performance only, `:5762`).
3. `kmem_alloc_contig`/IOBufferMemoryDescriptor can return pages **below `gPhysBase`**; any pmap/cache-attribute op on them panics (`phys_to_kv_range: illegal PA`,
   `:1978-1994`, `:2722-2735`, `:5315-5335`; their 0193/0194 make `flush_dcache`/`IOFlushProcessorCache` skip or translate them).

**Threat to our working GPU: low (INFERRED).** Our `0182-beryllium-gpu-adreno-iokit-user-client.patch` already allocates BOs with `IOBufferMemoryDescriptor::inTaskWithOptions(kernel_task...)`
(line 382), and `releaseGem` (lines 306-332) only unmaps when the last fence is done, otherwise it *leaks* the BO and its mapping on purpose ("freeing pages the GPU can still write
would corrupt the kernel"). That is exactly the invariant their bug violates. Residual risks worth a test: (a) the `SET_IOVA` remap path (`0182:463-467`, unmaps the old IOVA);
(b) `sweet_gpu_iova_free()` reusing an IOVA range while a fence is outstanding; (c) the below-`gPhysBase` panic (edi194 found it in the `--highmem` ADT, as we use;
`0127` already tests `gPhysBase`; grep our GPU/IOSurface paths for any `pmap_set_cache_attributes`/`flush_dcache` on pages from the free list); (d) log every >=1 MiB
`sweet_gpu_vm_unmap` like their 0214 to see an unexpected unmap. Their GPU never got past the binning pass (`RB_DBG_ECO_CNTL 0x8e04`, then `SP_FLOAT_CNTL`: "each first write to a 3D block
hangs" = block state never initialised, `:5337-5400`); our tree writes `RB_DBG_ECO_CNTL = 0x05100000` in the blit IB (`0240...patch:27-33`) and `PC_DBG_ECO_CNTL` in hw_init
(`0103:2072`), and renders, so that does not apply to us.

## 2. GPU bring-up lessons, in the order they hit them

1. A read of an unimplemented/halted GCC register (GCC+0x52000, HackiOS's a660 PLL vote offset) hangs the bus; a per-register probe that announces each read and flushes the log
   before it is the only way to name the culprit (`:75-110`, patches 0100/0101). (Ours: same style in 0103.)
2. The CX GDSC must be on before the GMU block reads (`adreno=8` proved it, `:1131-1133`). Their gate `if (level >= 8)` skipped stages 2a-2c for several boots and made every
   later conclusion about "dropped S2CR writes" worthless (`:1306-1316`): **always log that the power stage ran before interpreting a register read-back.**
3. SMMU (kgsl SMMU 0x5040000): `qcom,hyp_secure_alloc`, `sCR0` bit 21 made them think the stream table was hypervisor-owned and "froze the phone on S2CR writes" (`:1075-1093`);
   it was their unpowered block. Truth (`:1304-1335`): exact SMRs stick, masked ones do not; write the SMR/S2CR **pair**; run the impl-defs with the micro-MMU halted (0x6000).
   Same as our 0103/GPU_A630_BRINGUP.md section "0083 finding".
4. `uint32_t gmu_pa = (uint32_t)pa64` truncated the page-table PA and the GMU's first access reset the phone (`:1372-1376`). Keep PAs 64-bit; HFI table address register is 32-bit.
5. GMU registers are word indexed from the GMU base (byte = 4x vendor number); `hub_*`/`cb`/`hub_aon` gpucc clocks are a660, absent on SDM845 (`:1131-1146`).
6. Boot the GMU with the SMMU untouched (firmware does not touch RAM then); the three registers they were missing: `GMU_CX_GMU_WFI_CONFIG=0`, `PWR_COL_INTER_FRAME_CTRL=0x9c40400`,
   `RPMH_CTRL|=0xf11` (`:1190-1202`).
7. Zap: the OnePlus TZ accepts the zap in the same order as Bergamota (`PAS_GPU 13`, all segments). **perseus (Mi Mix 3, same SoC): TZ answers `PAS_INIT_IMAGE` with "interrupted"
   when called inline from the boot thread during `bsd_init`, success from a kernel thread; a short delay lets the loader's own SCM traffic finish** (`WeiXiaoye_perseus-xnu/docs/status-2026-11-09-gpu.md`, "configuration that works" item 3).
   Worth knowing if zap ever fails intermittently on a 6T boot.
8. Firmware on the 6T's own `vendor_a`: a630_gmu.bin 32768 B, a630_sqe.fw 32136 B (LineageOS 22.2); the OnePlus 6 OOS 10 has a630_sqe.fw 31980 B (`keyfan evidence/stage5-gpu-device-firmware.md:43`).
   Different SQE builds both work with their ladder.
9. After a GPU probe boot the log ring on the partition may describe an older boot; photograph the panel (`:1114-1122`). They also overwrote 4 KiB of the **root volume's allocation bitmap** by
   placing a log "status area" at block 8 of the userdata partition (`:5516-5526`): any raw log area must sit outside the HFS volume (ours is at the end; check `sweetlog` offsets).
10. A fence-timeout dump worth copying: IB1/IB2 base and remaining dwords, `RBBM_STATUS3` bit 24, both context banks' FSR/FAR/FSYNR0, per-block busy names, GX/CX GDSCR
    (`:5555-5566`, 0208). Our `0262`/`0186` have metrics; compare.

## 3. USB

- SDM845 needs its own GCC table: **master 0xf00c, sleep 0xf010, mock-utmi 0xf014, clkref 0x8c008** and the 6T is USB2-only (`usb_1_hsphy`, no QMP) (`NOTES-FAJITA.md:5527-5535`; mainline value
  confirmed). edi194's USB was still unproven in their notes. Ours works (FAJITA.md) but `0072-sweet-usb-probe.patch:67-75` lists the SM7150 table (0xf010/0xf014/0xf018/0x8c010): its
  `clocks_on` verdict is meaningless on the 6T. Fix the table (read-only probe).
- DWC3 DMA master is stream `0x740` (`iommus = <&apps_smmu 0x740 0>`, DT `qcom,smmu-s1-bypass`); UniXNU adopts the firmware's bypass entry instead of programming a bank (`johnpanos NOTES-ssh.md:19-20,79-83,139-143`).
- keyfan got CDC-ACM serial working on the OnePlus 6 under XNU (console206) after "adopt the firmware SMMU mapping": same idea as our `0094-beryllium-usb-guctl1-smmu`.

## 4. Reset, fastboot and the A/B slot (boot chain)

- **Reboot to fastboot from XNU was ignored by all four mechanisms on edi194's ABL** (IMEM restart_reason `0x77665500`, PON SOFT_RB_SPARE, BCB `boot-fastboot`, `bootonce-bootloader`;
  `:5537-5543`, 18:43:49 not in fastboot). Our FAJITA.md says `sweetreboot fastboot` works; that is not contradicted by evidence, but edi194's ABL was LineageOS' and differs. Keep the
  hard fallback (Power+VolUp 15 s).
- keyfan returns to recovery from a test boot with a watchdog plus an armed `misc` BCB (`enchilada-wdog=3`, "recovery after 641 s", `evidence/backlight208.md:10-30`; OnePlus 6/TWRP): a BCB in `misc` is honoured there.
- johnpanos: empty `boot_a`/`boot_b` make every reset land in fastboot, an image on the active slot makes `fastboot boot` fail with "Load Error", each reset spends a slot retry
  (`README.md:22`). keyfan measured the opposite on a healthy slot (slot-retry-count 7, stock boot image present, `fastboot boot` worked) and only a **second `fastboot boot` in the same
  bootloader session fails** (`README.md:353-372`). Flasher/runbook: check `slot-successful`/`slot-retry-count`, one boot per entry, send a `getvar` before blaming the image,
  header v0 is the safe fallback if v1 is refused (we boot v1 fine, FAJITA.md).
- Slot bits: Op6TSlot shows how a non-Android OS must mark the slot active in the GPT (`6T_FACTS.md` 1.7) or the ABL flips slots and then forces fastboot; relevant to any flow that flashes `boot_a`.
- CrashDump: stock tree has IMEM `dload_type@1c`, `diag_dload@c8`, TCSR_BOOT_MISC_DETECT `0x1fd3000` (see `6T_FACTS.md` 3.1-3.2). Idea for 0272/Enxerto (INFERRED, test with
  `sweetreboot normal`): clear the two recalled cookie words at IMEM+0x1c/+0x20 (read them first on a crash-pending boot and log them) and/or the TCSR dload bits, in addition to the SCM calls;
  `sweet_reboot.c` currently touches IMEM+0x65c only.
- perseus/edi194 both put persistent logs on raw partition ends; the ABL also leaves a 1 MiB log at `0x9fff7000` (`bootloader_log_mem`): dump it from Enxerto when debugging boots (format UNVERIFIED).

## 5. Touch (RMI4) details we can check against 0252/0253

(`docs/fajita-touch-rmi4-spec.md`, `johnpanos NOTES-touch.md`)
- TLMM tiles: NORTH 0x3900000, SOUTH 0x3d00000; **gpio88 (VIO) is in SOUTH** (CFG 0x03d58000); gpio99/125/49/50 NORTH. A driver that only maps NORTH silently writes the wrong pin.
- Reset 10 ms low then 200 ms settle; ATTN gpio125 has an internal pull-up; polled mode at 100 Hz works with no interrupt (edi194), UniXNU's optional IRQ path uses SPI 208 (TLMM summary) and
  warns of a shared-IRQ storm.
- S3706B clones: fixed PDT 0xe9 F34 / 0xe3 F01 / 0xdd F12 with 4-byte reads when the PDT scan is empty; F12 without descriptors: Data1 at the data base, ten 8-byte objects (88-byte read);
  downstream masks coordinates to 12 bits; `status & 0x80` = unconfigured (controller reset). Our AUDIT F-38 (no object-type filter) matches this.
- Raw maxima 1063x2326 with dead edges (edi194), so map by measured extent or F12 control 8 maxima, not a fixed 1080x2340.
- Unlike the GCC votes of the gauge, touch SE4 uses vote bit 26 and CBCR 0x184d4; mixing the two up is a documented mistake (`keyfan EnchiladaGaugeBoard.h:12-15`).

## 6. Journaled HFS+ root: evidence from siblings

- **ios-sweet booted a `mkfs.hfsplus -J` root (attr 0x80002100, JIB block 129, 8 MiB journal at byte 532480 flagged need-init) on a real phone to SpringBoard** (`dipa-studio_ios-sweet/NOTES.md:124,135`;
  QEMU log `hfs: Initializing the journal (joffset 0x3000 sz 0x80000)` then mounted). ios-switch (SD card, xnu-8796) logs `hfs: Initializing the journal`, and after a panic/power loss
  `jnl: replay_journal ... journal replay done`, `hfs: mounted iOSRoot` (`urielc918_ios-switch/NOTES.md:390,406-407,1112-1118`). So the NeedInit path and replay-after-hard-reset are
  observed on hardware with this kernel family: strong support for our `--journal` option (details and the remaining mismatches in `HFS_JOURNAL_VERIFY.md`).
- Linux `fsck.hfsplus -n` reports "Volume header needs minor repair" on every fresh journaled volume (ios-sweet `NOTES.md:135`); `-fy` on a device read-back "poisoned" an edi194 volume
  (`:3940-3978`). Do not use hfsprogs fsck as a gate for journaled images.

## 7. Concrete code ideas (file references are ours)

| # | Idea | Where | Source fact |
|---|---|---|---|
| 1 | 6T gauge probe: copy the OnePlus-6 recipe (GCC vote 0x5200c |= bits 20,21,24; poll halts 0x1800c/0x18010/0x18274; RCG 0x18278 DFS level for 19.2 MHz; TLMM NORTH gpio55/56 func1 2 mA no-pull; GENI FIFO init; 100 kHz; read 0x1c,0x04,0x02,0x10,0x0e,0x3c at 0x55 with both register maps and score plausibility). Read-only; fall back to PMI8998 only if the ack fails | new `bsd/dev/sweet_gauge.c` gated `sweet_board_fajita()`; reuse touch GENI helpers of `0252` | `6T_FACTS.md` 6.1-6.3 |
| 2 | Brightness/screen-off via one DCS 0x51 packet over DSI0 CMD DMA: DSI0 `0xae94000`, 8-byte buffer `03 00 39 c0 51 hi lo ff` in a PA < 4 GiB buffer, `dc civac`+`dsb sy`, TRIG_DMA, wait DMA_BUSY clear, CTRL restored; the 6T is command mode so also test whether MDP is mid-frame (TE) | replaces WLED path in `DISPLAY_HW.md` plan / `sweetfb_blfade` | 4.1-4.5 |
| 3 | `tools/mkadt.py`: clamp the fajita high bank by the real top (8 GB: 0x2_7c8a0000; 6 GB: no better than 0x1_FAE00000) or have Enxerto read `/memory` from the x0 FDT (edi194's shim proved ABL passes a live FDT, `:262-269`) | `mkadt.py:15-19,85-87`, `enxerto/` | 2.1-2.3 |
| 4 | Fix 0072 USB CBCR table to SDM845 | `xnu/patches-11215/0072-sweet-usb-probe.patch:67-75` | 3.4 |
| 5 | 0272 extension: log IMEM+0x1c/+0x20 and TCSR 0x1fd3000 at init (read-only), then optionally clear | `bsd/dev/sweet_reboot.c` | 3.1-3.2 |
| 6 | Alert slider: GPIOs 126/52/24 active-low, map to the ringer switch | HID (AUDIT F-40) | Linux dtsi:28-62 |
| 7 | GPU: log every large `sweet_gpu_vm_unmap`; test SET_IOVA remap and IOVA reuse with an outstanding fence | `0182` mapGem/releaseGem | section 1 |
| 8 | Flasher/Enxerto: read `current-slot`, `slot-successful`, `slot-retry-count` before `fastboot boot`; one boot per session; add `variant` and `hw-revision` to the fingerprint (`SDM UFS`, `20001`) | `apps/web/src/lib/flasher.ts`, `guards.ts` | 1.2, 1.9 |
| 9 | Zap robustness: if `PAS_INIT_IMAGE` returns "interrupted" retry from a kernel thread after a short delay | `0103` zap step | perseus |
| 10 | Dump `bootloader_log_mem` (0x9fff7000, 1 MiB) at Enxerto start into the persistent log | Enxerto / `sweet_log` | 2.8 |
