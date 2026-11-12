# OnePlus 6T (fajita) facts from other projects' files (2026-11-12)

Purpose: resolve the "UNVERIFIED / recalled, not observed" items about the 6T in `docs/FIXES_2026-11.md` (0273, P-D),
`docs/reference-snippets/SDM845_6T_HW.md`, `docs/audit/AUDIT_BOOT_CHAIN.md` and `AUDIT_KERNEL_DRIVERS.md`.
Read-only study of the clones in `.../scratchpad/refs/` (below `refs/`). Nothing was built or run from them.

## Tags used

- **LIVE** = the value sits in a file that is itself a dump of / log from a real 6T (or the sibling OnePlus 6 where said). Strongest.
- **SRC** = read in a source file (Linux DTS, edk2 tables, other port's constants); describes the design, not a measurement.
- **INFERRED** = follows from the above, not seen. **UNVERIFIED** = still nobody's measurement.
- Decompiled DTB nodes are cited by node path: `refs/longjunyu2_mu_platforms_oneplus6t/dtb/fajita.dtb` (decoded with libfdt in the
  scratchpad, not committed; abbreviated **muDTB**). It carries the ABL-patched `/chosen/bootargs`, `/memory` and `kaslr-seed 0`, so it is a live
  merged tree of an **8 GB** 6T (INFERRED provenance; the repo does not say). `edk2-porting.../FdtBlob_compat/fajita.dtb` is the same tree with the bootargs
  replaced. (The bootargs hold a serial number and PARTUUIDs; not copied here.)

## Licences of the sources (we may only use facts/ideas from the first group)

| Source | Licence (checked) | Use |
|---|---|---|
| edi194_ios-fajita | **no LICENSE file** (all rights reserved) | facts/ideas only |
| joranv1_ios-sailfish | no LICENSE file | facts/ideas only |
| linux (dts, drivers) | GPL-2.0 (`COPYING`) | facts only, no code |
| edk2-porting_edk2-sdm845 | mixed `LICENSE` (Warkentin, Apple, ARM, Linaro, MS, Renegade...; contains `GPLDrivers/`) | facts only |
| longjunyu2_mu_platforms_oneplus6t | `LICENSE` BSD-2-Clause, but `Drivers/Op6tSlotDxe/README.md` says GPL v3 + extra terms; `.efi` binaries and `dtb/fajita.dtb` are vendor blobs | facts only |
| johnpanos_UniXNU-fajita, keyfan_UniXNU-enchilada-bringup | BSD-2-Clause-Patent (`LICENSE`) | code could be reused with notice; here facts only |
| dipa-studio_ios-sweet, NWylynko_ios-flame, LakoMoor_ios-beryllium, oosexgang_hakios-metal | MIT | idea/code with notice |
| WeiXiaoye_perseus-xnu | `LICENSE.md`: patches APSL-2.0, device/docs/scripts MIT | as stated |
| apple-oss-distributions_hfs, apple_xnu-11215 | APSL 2.0 (`APPLE_LICENSE`) | adapt with attribution |

## 1. Identity, storage, partitions

| # | Fact | Value | Evidence | Conf. |
|---|---|---|---|---|
| 1.1 | Board id | `qcom,board-id = <8 0 0x4971 0x29>` (0x4971 = 18801 = project name; hw_version 41) ; msm-id `0x141 0x20001` (SDM845 v2.1) | muDTB `/` ; bootargs `androidboot.project_name=18801 hw_version=41`; edi194 `NOTES-FAJITA.md:284-286`; Linux `sdm845-oneplus-fajita.dts:13` | LIVE |
| 1.2 | fastboot getvar (OnePlus ABL, LineageOS 22.2 on the phone) | `product:sdm845`, `variant:SDM UFS`, `hw-revision:20001`, `current-slot:b`, `slot-successful:a/b=yes`, `unlocked:yes`, `Device critical unlocked:false`, `parallel-download-flash:yes`, boot_a/boot_b 0x4000000, userdata `0x1B800BB000`, erase/logical block 0x1000 | edi194 `NOTES-FAJITA.md:225-232` | LIVE. Confirms product=`sdm845` (FIXES P-C F-01) and a 4 KiB block |
| 1.3 | ABL cannot read partitions | `fastboot fetch` unsupported | edi194 `NOTES-FAJITA.md:233-236` | LIVE |
| 1.4 | userdata GPT entry | LUN 0, **entry 17 (`sda17`)**, first LBA **0x186f40** (4 KiB LBAs); 128 GB/8 GB unit: 112640 MiB (`0x1B800BB000` = 112640.73 MiB); 256 GB unit: last_lba 0x3ad1ffa (229.17 GiB); (OnePlus 6 64 GB: same first LBA, last 0xe217fa) | edi194 `NOTES-FAJITA.md:538` (our shim log) and `:3223,:3834` (`sda17`); johnpanos `board.toml:31-35`; keyfan `board.toml:237-244` | LIVE |
| 1.5 | A/B naming confirmed | `androidboot.slot_suffix=_b`; partitions `boot_a`, `boot_b`, `system_a` (2.86 GiB), `vendor_a` (OnePlus 6: `/dev/sde16`, ext4), `dtbo_a`; `androidboot.dtbo_idx=2` | muDTB `/chosen/bootargs`; johnpanos `README.md:23`; keyfan `scripts/data/adreno-a630-device-firmware.json:8` | LIVE |
| 1.6 | `modem_a`, `bluetooth_a`, `dsp_a`, `persist`, `modemst1/2`, `fsg` exact names | **still no GPT listing in any clone.** Only indirect: `firmware_class.path=/vendor/firmware_mnt/image` (Android mounts the modem partition there), and edi194 backed up "every by-name entry" but never printed the list | muDTB bootargs; edi194 `NOTES-FAJITA.md:240-247` | UNVERIFIED (0273's `<name>_a` guess stays a guess; the pattern is standard Qualcomm A/B) |
| 1.7 | Slot state bytes in the GPT (for the A/B problem when a non-Android OS never marks the slot good) | boot_a flag byte at LBA2+0x536, boot_b at LBA3+0x336 (4 KiB LBAs); values 0x6F active, 0x07/0x0F/0x17/0x1F/0x27/0x2F/0x37 bootable, 0xBA unbootable; name check bytes at +0x538/+0x338 (`b.o.o.t._.a`). ABL flips slots then forces fastboot if the slot is not marked | longjunyu2 `Platforms/OnePlus6TPkg/Drivers/Op6tSlotDxe/slot.h:23-72`, `slot.c:45-135`, README | SRC (UEFI author's reverse engineering) |
| 1.8 | UFS | host `0x1d84000` (`androidboot.bootdevice=1d84000.ufshc`), UFS 2.1 (`ver=0x210` read by edi194's shim), SMMU stream `iommus = <&apps_smmu 0x100 0xf>` (UniXNU) | muDTB bootargs; edi194 `NOTES-FAJITA.md:259-262`; johnpanos `board.toml:169-172` | LIVE |
| 1.9 | ABL behaviour for `fastboot boot` (OxygenOS 11.1.2.2 ABL, 6T and OnePlus 6) | one `fastboot boot` per bootloader session (2nd = "Load Error"); a spent session can leave the bulk endpoint dead ("no link", even getvar); each reset spends one slot retry; header v1 "was refused, v0 loaded" on the 6T (conflicts with our observed v1 boot, FAJITA.md); large ramdisk accepted but 192 MiB never reached USB; boot ending in EDL 9008 is not recoverable by software, Power+Vol Up 15-20 s | johnpanos `README.md:22-23`, `board.toml:31,203-206`; keyfan `README.md:353-393` | LIVE (their ABL; ours may differ) |

## 2. Memory

| # | Fact | Value | Evidence | Conf. |
|---|---|---|---|---|
| 2.1 | DRAM banks, 8 GB 6T | `/memory reg = <0x80000000 +0x1_00000000>, <0x1_80000000 +0xfc8a0000>` -> contiguous 0x80000000..0x2_7c8a0000 (7.946 GiB, MemTotal 7824600 kB). OrangeFox `/proc/iomem`: `80000000-856fffff`, `85d00000-85dfffff`, `85f00000-85fbffff`, `8c417000-8c4fffff`, `97d00000-27c89ffff` | edi194 `NOTES-FAJITA.md:273-282`, `:1123-1126`; muDTB `/memory` | LIVE (two independent dumps agree) |
| 2.2 | edk2 8 GB map | `0xD0000000+0xB0000000` then `0x180000000+0xFC7A0000` (ends 0x2_7c7a0000, 1 MiB below the live end) | edk2-sdm845 `Silicon/Qualcomm/sdm845/Library/PlatformMemoryMapLib/PlatformMemoryMapLib.c:56-57` | SRC, consistent with 2.1 |
| 2.3 | edk2 6 GB / 4 GB / 10 GB maps (generic SDM845, **not 6T-specific**) | 6G: `0xD0000000+0x12AE00000` -> top **0x1_FAE00000**; 4G: `+0xADFA0000`; 10G: `+0x224AC0000` | same file `:52-59` | SRC. The 6 GB 6T top is therefore INFERRED, never measured. longjunyu2's older 6T map ends at 0x1_DF400000 (`DeviceMemoryMap.h:151-158`) |
| 2.4 | DRAM chip | Samsung, `ddr_row0_info=16`, `ddr_device_type=7` | muDTB bootargs, `/memory` | LIVE |
| 2.5 | Reserved regions (all live, identical to Linux where Linux has them) | hyp 0x85700000/0x600000; xbl 0x85e00000/0x100000; **removed_region 0x85fc0000/0x4b40000** (covers aop, cmd-db 0x85fe0000, smem 0x86000000, tz 0x86200000..); qseecom 0x8ab00000/0x1400000; camera 0x8bf00000/0x500000; ipa_fw 0x8c400000/0x10000; ipa_gsi 0x8c410000/0x5000; **gpu 0x8c415000/0x2000**; adsp 0x8c500000/0x1a00000; **wlan_fw 0x8df00000/0x100000**; **modem 0x8e000000/0x7800000**; video 0x95800000/0x500000; cdsp 0x95d00000/0x800000; **mba 0x96500000/0x200000**; **slpi 0x96700000/0x1400000**; spss 0x97b00000/0x100000; **cont_splash 0x9d400000/0x2400000** (no `no-map`); bootloader_log_mem 0x9fff7000/0x100000; param_mem 0xac200000/0x100000; **ramoops 0xac300000/0x400000** (record/console/ftrace 0x40000, pmsg 0x200000, devinfo 0x1000, ecc 0); mtp_mem 0xac700000/0xb00000; CMA/shared pools dynamic below 4 GiB. **No rmtfs region in the live tree.** | muDTB `/reserved-memory/*`; Linux `sdm845-oneplus-common.dtsi:125-165` | LIVE |
| 2.6 | rmtfs | Linux hard-codes `0xf5b00000/0x202000` (guard pages, vmid MSS_MSA) + `removed-region@88f00000/0x1c00000`; the downstream tree allocates it dynamically ("same address every time") | `sdm845-oneplus-common.dtsi:130-153` | SRC |
| 2.7 | Everything fixed is below 0xad200000 | so 0x1_00000000.. is clean RAM; also stated by edi194 (`NOTES-FAJITA.md:277-280`) | | LIVE |
| 2.8 | ABL log in DRAM | `bootloader_log_mem@9fff7000`, 1 MiB (edk2 sees an 0x8000 "Log Buffer" at the same base) | muDTB; edk2 `PlatformMemoryMapLib.c:44` | SRC; format UNVERIFIED |
| 2.9 | ABL framebuffer | 0x9d400000, 1080x2340, **stride 4320** (two ports render correctly with it; Mi 8/Mix 3 use 4352, so do not assume across phones) | edi194 `NOTES-FAJITA.md:352-356`; johnpanos `board.toml:179`; perseus `docs/status-2026-11-09-gpu.md` | LIVE |

## 3. SoC blocks relevant to the kernel

| # | Fact | Value | Evidence | Conf. |
|---|---|---|---|---|
| 3.1 | IMEM | `qcom,msm-imem@146bf000`: `mem_dump_table@10`, **`dload_type@1c` (4 B)**, `diag_dload@c8`, `restart_reason@65c`, `boot_stats@6b0`, `kaslr_offset@6d0`, `pil@94c` | muDTB `/soc/qcom,msm-imem@146bf000/*` | LIVE. **Answers AUDIT_BOOT_CHAIN F-01 "read the qcom,msm-imem-download_mode node"**: the node is named `dload_type` (compatible `qcom,msm-imem-dload-type`); the cookie words themselves (recalled 0xE47B337D / 0xCE14091A at +0x1c/+0x20 in downstream msm-poweroff) are UNVERIFIED |
| 3.2 | Download-mode TCSR | `/soc/restart@10ac000` (`qcom,pshold`): `pshold-base 0xc264000`, **`tcsr-boot-misc-detect 0x1fd3000`** | muDTB | LIVE. Gives the TCSR address 0272 says "nobody has found" |
| 3.3 | PMICs | SPMI `0xc440000`: pm8998 USID 0 (power-on@800 pon_1..3, rtc), pmi8998 USID 2, pm8005; PS_HOLD 0xc264000 | muDTB `/soc/qcom,spmi@c440000/*` | LIVE |
| 3.4 | USB | `ssusb@a600000` dwc3 core `0xa600000` (+0xcd00), QUSB2 HS PHY `0x88e2000`, `iommus = <&apps_smmu 0x740 0>`, `maximum-speed=high-speed` (USB2 only), GDSC `0xf004`; **SDM845 CBCRs: master 0xf00c, sleep 0xf010, mock-utmi 0xf014, clkref 0x8c008** (mainline gcc-sdm845.c, fetched). Our `0072-sweet-usb-probe.patch:67-75` uses the SM7150 table (0xf010/0xf014/0xf018/0x8c010): its report is wrong for the 6T (read-only probe, harmless) | muDTB `/soc/ssusb@a600000`; edi194 `NOTES-FAJITA.md:5527-5535`; johnpanos `NOTES-ssh.md:14-20` | LIVE/SRC |
| 3.5 | GPU | chip 0x06030001, kgsl-3d0 `0x5000000+0x40000`, GMU `0x506a000`, gpucc `0x5090000`, kgsl SMMU `0x5040000` (`qcom,hyp_secure_alloc`, `qcom,disable-atos`), `pas-id 13`, zap name `a630_zap`, highest-bank-bit 15, ubwc-mode 2 (read on the OnePlus 6; same SoC) | keyfan `evidence/stage5-gpu-device-tree.md:30-47`; edi194 `NOTES-FAJITA.md:1075-1093` | LIVE (6) |
| 3.6 | DSI | `qcom,dsi-ctrl-hw-v2.2`, DSI0 `0xae94000` (+0x400), DSI1 `0xae96000`, DSI PLL `0xae94a00` | muDTB `/soc/qcom,mdss_dsi_ctrl0@ae94000` | LIVE |

## 4. Panel (Samsung S6E3FC2X01, AMS641RW)

| # | Fact | Value | Evidence | Conf. |
|---|---|---|---|---|
| 4.1 | **Mode: COMMAND mode** (`dsi_cmd_mode`, `trigger_sw`, TE pin select 1, wr-mem-start 0x2c/continue 0x3c). ABL cmdline `msm_drm.dsi_display0=dsi_samsung_s6e3fc2x01_cmd_display`. Mainline Linux drives it in video-burst mode; the stock ABL/Android does not. On the OnePlus 6 (command-mode sofef00) the live DSI0 CTRL read `0x1f5` = CMD_MODE_EN, VID_MODE_EN=0 | muDTB `/soc/qcom,mdss_mdp@ae00000/qcom,mdss_dsi_samsung_s6e3fc2x01_cmd`, bootargs; keyfan `evidence/backlight208.md:46-56` | LIVE (6T tree); the ABL's DSI state on the 6T is INFERRED from it |
| 4.2 | Timing | 1080x2340@60, hfp 72, hbp 36, hpw 16, vfp 32, vbp 18, vpw 4, clockrate 1,037,000,000 (0x3dcf5d40), 68x145 mm, 4 lanes, burst, reset sequence {1,5ms},{0,2ms},{1,10ms} | muDTB same node (`...display-timings/timing@0`) | LIVE; matches Linux numbers in SDM845_6T_HW.md section 3 |
| 4.3 | Backlight | `bl_ctrl_dcs` (no WLED); **max 0x3ff, default 0xc8 (200)** (Linux driver default 512), min 1; DCS 0x51 with 16-bit big-endian payload (HBM-max command contains `03 51 03 ff`); HBM via `0xF0 5A 5A` unlock + 0x53 | muDTB same node (`qcom,mdss-brightness-*`, `hbm-max-brightness-command-on`) | LIVE |
| 4.4 | GPIOs/supplies | reset tlmm 6, vci tlmm 26 (3.3 V), poc tlmm 25 (1.8 V), TE tlmm 10, vddio vreg_l14a 1.88 V | muDTB (`platform-reset/vci/poc-gpio` = 0x6/0x1a/0x19); Linux `sdm845-oneplus-common.dtsi:570-585` | LIVE+SRC |
| 4.5 | A first DCS packet works on an OnePlus (6) through DSI0 CMD DMA | one 0x51 write `03 00 39 c0 51 02 00 ff` (long write header + payload + pad, 8 B), buffer PA `0xae01a000` (< 4 GiB, DMA_BASE is 32-bit), display SMMU bank in bypass (SCTLR.M=0), DSI0 mapped at `0xae94004`, `dc civac`+`dsb sy`, DMA_BUSY cleared; `IODisplayParameters.brightness` max 1023 published | keyfan `evidence/backlight210mode3.md:36-57`, `backlight209mode2.md:37`, `backlight211mode4.md` | LIVE (OnePlus 6; same SoC/DSI block). Not yet shown to change luminance |

## 5. Touch, input, sensors

| # | Fact | Value | Evidence | Conf. |
|---|---|---|---|---|
| 5.1 | Touch | Synaptics RMI4 (downstream `HWK,synaptics,s3320`, tx-rx 15x30, flags `oem,fajta`, `oem,support_1080x2340_tp`; mainline `syna,rmi4-s3706b`) at **0x20 on i2c@a90000 = QUP wrapper 1 SE4 ("i2c12")**, 400 kHz (ACPI `0x61A80`), ATTN **gpio125** (falling), RESET **gpio99**, VIO enable **gpio88** (SOUTH tile), SCL/SDA gpio49/50 function qup12, VDD **PM8998 ldoa28** 2.856..3.008 V; reset/startup delay 200 ms | muDTB `/soc/i2c@a90000/synaptics-rmi-ts@20`; Linux `sdm845-oneplus-common.dtsi:517-545`; edk2 `AcpiTables/fajita/DSDT.dsl:60746-60762` (TSC1: I2C 0x20, GpioInt 0x7D, GpioIo 0x63) | LIVE |
| 5.2 | Touch GCC/TLMM | GCC vote `0x5200c` bits 20,21 (AHB) + **26 (S4)**; S4 CBCR `0x184d4`, RCG `0x184d8`; TLMM base 0x3400000, NORTH +0x500000, **SOUTH +0x900000 (gpio88 CFG = 0x03d58000, not 0x03958000)**; vendor pinctrl group names gpio122 but irq-gpio says 125 (stale) | edi194 `docs/fajita-touch-rmi4-spec.md` sections 1-2 | SRC (derived from the live FDT) |
| 5.3 | Touch raw range | maxima seen 1063x2326 (edge dead zone) and `raw max x=595 y=2324` in a short test; UniXNU expects 1080x2340 default and a 12-bit mask in the downstream driver | edi194 `NOTES-FAJITA.md:44,5571`; johnpanos `NOTES-touch.md:45,205-207` | LIVE |
| 5.4 | Buttons | vol-down PM8998 gpio5, vol-up gpio6, power = PON `0x30`; Linux events `0xe9/0xea` as seen in our HID | Linux `sdm845-oneplus-common.dtsi:102-122`; edi194 `NOTES-FAJITA.md:25-26` | SRC+LIVE |
| 5.5 | Alert slider (tri-state) | tlmm **126 (Silent/top), 52 (Vibrate/middle), 24 (Ring/bottom)**, active low; hall sensor tlmm 124 | Linux `sdm845-oneplus-common.dtsi:28-62,76-84` | SRC (resolves AUDIT_KERNEL_DRIVERS F-40 GPIO list) |
| 5.6 | NFC | NXP PN553 at 0x28 on i2c@88c000 (i2c3), irq tlmm 63, enable tlmm 12, firmware tlmm 62; eSE `nxp,p61` on spi@880000 | Linux `...common.dtsi:488-505`; muDTB `/soc/i2c@88c000/pn5xx@28`, `/soc/spi@880000/ese@0` | LIVE |
| 5.7 | Fingerprint, vibrator | not in the merged tree (no `haptic`, `vibrat`, `fpc`, `goodix` strings); optical in-display sensor is expected in the DTBO (not dumped) | muDTB grep | UNVERIFIED |

## 6. Power: gauge, charger

| # | Fact | Value | Evidence | Conf. |
|---|---|---|---|---|
| 6.1 | Fuel gauge bus | **`i2c@a88000` (QUP wrapper 1 SE2, Linux "i2c10"), address 0x55, 100 kHz (`qcom,clk-freq-out 0x186a0`)**, gpio55/56 function qup10; downstream compat `ti,bq27541-battery`, mainline `ti,bq27411` | muDTB `/soc/i2c@a88000/bq27541-battery@55`; Linux `...common.dtsi:507-515`, `sdm845.dtsi` i2c10 | LIVE (6T DT) |
| 6.2 | Register map actually answering | On the OnePlus 6 the **bq27411 map** (SOC 0x1c, V 0x04, T 0x02, I 0x10, FCC 0x0e, DCAP 0x3c) scored 6/6 plausible, the bq27541 map 3/6: `soc=100 v=4326 i=0 t=145(0.1K) f=3153 d=3240` (six boots). DesignCapacity read **3240 mAh** (DT says 3300). Read-only, write-register-byte + repeated-start + 2-byte LE read | keyfan `evidence/stage7-gauge-device.md:17-38`, `stage7-gauge-multiboot.md` | LIVE (OnePlus 6); 6T register map/design value UNVERIFIED (expect bq27411 map; DesignCapacity unknown, DT 3700) |
| 6.3 | How the OnePlus 6 gauge was reached from XNU | GCC `0x5200c` OR bits 20|21|**24** (S2), halts M_AHB 0x1800c, S_AHB 0x18010, S2 0x18274, RCG 0x18278 DFS level for 19.2 MHz, TLMM NORTH gpio55/56 ctl = func1, 2 mA, no pull, GENI init FIFO mode, 100 kHz | keyfan `package/EnchiladaGaugeBoard.h:5-62`, `EnchiladaGaugeProbe.cpp:150-215` | LIVE (OnePlus 6) |
| 6.4 | No PMI8998 fuel gauge in use | the tree has `qcom,qpnp-smb2` (charger) and `qpnp-qnovo` under pmi8998 USID 2 but no `qpnp-fg` node; battery data comes from the external gauge | muDTB `/soc/qcom,spmi@c440000/qcom,pmi8998@2/*` | LIVE. Confirms AUDIT F-01: our PMI8998-FG reads (SweetBattery) cannot be right on the 6T |
| 6.5 | Same bus also hosts | `qcom,smb1355@8` and `@c` (two slave chargers, I2C-PMIC), **OnePlus Dash MCU `microchip,oneplus_fastchg@26`** (gpios: mcu-en 102, usb-sw-1 37, usb-sw-2 51, ap-clk 43, ap-data 44) | muDTB `/soc/i2c@a88000/*` | LIVE |
| 6.6 | Charger parameters (smb2) | usb-icl 1.8 A, dc-icl 1.2 A, fv-max 4.4 V, normal vbatmax 4400 mV / ibatmax 1950 mA, cutoff with charger 3250 mV, JEITA zones, `op,usb-check` tlmm 95 | muDTB `.../qcom,qpnp-smb2` | LIVE |
| 6.7 | Battery | 3700 mAh, 3.4..4.4 V, 1.8 A (Linux); edk2 `cust_pmic_batt.asl` (FCC 13890 mWh, "850_MTP") is a generic Qualcomm MTP template, **not** 6T data | Linux `sdm845-oneplus-fajita.dts:15-29`; edk2 `AcpiTables/fajita/cust_pmic_batt.asl` | SRC |
| 6.8 | Nothing charges under UEFI/XNU on the OnePlus ports | | johnpanos `README.md:24`; keyfan `README.md:393` | LIVE (matches our read-only charger default) |

## 7. Audio, buses

| # | Fact | Value | Evidence | Conf. |
|---|---|---|---|---|
| 7.1 | Speaker amp | **NXP TFA9894 @0x34 on i2c@890000 (QUP wrapper 0 SE4 = Linux i2c4), reset tlmm 69, status ok**; the MAX98927@0x3a node (OnePlus 6) is present but `disabled` | muDTB `/soc/i2c@890000/tfa98xx@34`, `max98927@3a`; Linux `sdm845-oneplus-fajita.dts:42-44,64-69` | LIVE |
| 7.2 | Which MI2S | The common DT's speaker link is **QUATERNARY_MI2S_RX** (1.536 MHz bit clock, 48 kHz, S16, 2 ch); fajita deletes the link only because the TFA9894 is unsupported; downstream names `msm-dai-q6-mi2s.3` | Linux `...common.dtsi:793-802`; keyfan `evidence/stage7-audio-feasibility.md:20-32` | SRC; "TFA9894 sits on the same link" INFERRED |
| 7.3 | Codec | WCD9340 (tavil) over SLIMbus, reset tlmm 64, mclk 9.6 MHz; headset switch FSA4480 @0x42 on i2c@89c000 | Linux `...common.dtsi:1109-1111`; muDTB `/soc/i2c@89c000/fsa4480@42` | LIVE |
| 7.4 | I2C/SE map | i2c@880000..89c000 = wrapper 0 SE0-7 (`i2c@88c000` = i2c3 NFC, `@890000` = i2c4 audio); i2c@a80000..a9c000 = wrapper 1 (`a88000` gauge SE2, `a90000` touch SE4) | muDTB; edi194 spec section 1 | LIVE |
| 7.5 | Wi-Fi/BT | WCN3990, `qcom,calibration-variant="oneplus_sdm845"`, snoc-host-cap-8bit quirk; wlan MSA 0x8df00000 | Linux `...common.dtsi:1095-1118` | SRC |

## 8. Claims in our docs: confirmed / corrected

| Our claim | Verdict |
|---|---|
| FIXES 0273 item 3: mba below slpi, mpss/wlan_msa/cont_splash/ramoops addresses | **Confirmed live** (2.5). rmtfs 0xf5b00000 is Linux-only; the live tree has no rmtfs node |
| FIXES 0273 item 3: "DRAM bank size of the 6/8 GB 6T is NOT known" | **Resolved for 8 GB** (2.1). 6 GB: only the generic edk2 map (top 0x1FAE00000). `tools/mkadt.py:15-19` `HIGH_MEM_SIZE 0xfcc00000` at 0x100000000 ends at 0x1_FCC00000: inside the 8 GB bank, but **1.9 MiB above the edk2 6 GB top** (INFERRED, unmeasured; clamp or read `/memory`) |
| FIXES 0273 / pack section 5: partition names `modem_a`/`bluetooth_a` | still UNVERIFIED (1.6); `boot_a`, `system_a`, `vendor_a`, `dtbo_a` and the `_a/_b` scheme confirmed |
| Pack section 3 and FIXES 0273 item 2: panel flags "VIDEO_BURST" | **Wrong for the stock firmware**: the ABL runs the panel in **command mode** (4.1); Linux's video-burst is mainline's own choice. A DSI0 CMD-DMA DCS write is then the device-proven route (4.5) |
| Pack section 3: brightness default 512 | Linux's value; downstream default is 200 (0xc8), max 1023 (4.3) |
| Pack section 2: gauge "bq27411 on i2c10 @0x55" | Bus/address **confirmed by the 6T tree** (6.1); register map confirmed only on the OnePlus 6 (6.2); the bq27541 name in the 6T tree is the vendor's label |
| AUDIT_BOOT_CHAIN F-35 (cont_splash size UNVERIFIED) | **Resolved**: 0x9d400000/0x2400000 live (2.5) |
| AUDIT_BOOT_CHAIN F-10 (6T LUN0 entry count unknown) | userdata is entry 17 (<128), first LBA 0x186f40 (1.4); fail-safe case unlikely |
| AUDIT_BOOT_CHAIN F-01 / KERNEL_DRIVERS F-03, 0272: IMEM cookie offset, TCSR address unknown | IMEM node `dload_type@1c`, `diag_dload@c8`, TCSR_BOOT_MISC_DETECT `0x1fd3000` found (3.1-3.2). Cookie values still recalled |
| AUDIT_BOOT_CHAIN F-27 (DTB the ABL gives a v1 `fastboot boot` image) | The live tree carries `androidboot.dtbo_idx=2` and the board nodes (touch, gauge, panel), i.e. the ABL applies the active slot's DTBO before our code sees x0 (INFERRED from 1.5/5.1) |
| `docs/BERGAMOTA_FASTBOOT.md:78,154`: userdata at block 0x2b8c00, ~109643 MiB | Those are another phone's (sweet) numbers (edi194 `NOTES.md:181`). The 6T: first LBA 0x186f40, 112640 MiB on 128 GB (1.4) |
| FAJITA.md: touch VDD ldoa28, VIO gpio88, reset 99, ATTN 125, i2c12 @0x20 | **Confirmed** (5.1) |
| FAJITA.md: "boot.img DTB is SoC-only, board nodes in DTBO" | Consistent with 5.1/1.5 |
| FAJITA.md: product `sdm845` | Confirmed on a real 6T (1.2); `variant:SDM UFS`, `hw-revision:20001` are the extra getvars for a fingerprint (not unique to the 6T) |
| 0072 USB probe CBCR table | SM7150's, not SDM845's (3.4) |
