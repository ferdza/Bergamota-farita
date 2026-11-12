# SDM845 / OnePlus 6T (fajita) hardware deltas: reference pack

Legend: OBSERVED = read in the file named; INFERRED; UNVERIFIED = recalled/not checked.
Licences: everything here comes from Linux (GPL-2.0, `arch/arm64/boot/dts/qcom/sdm845*.dts*`, `drivers/gpu/drm/panel/panel-samsung-s6e3fc2x01.c`, `drivers/power/supply/bq27xxx_battery*.c`,
`drm_mipi_dsi.c`, `drivers/gpu/drm/msm/registers/display/dsi.xml`) => **facts, addresses, sequence structure only; write your own code**. MIPI DCS opcode values are from the public MIPI DCS standard
(recalled, UNVERIFIED here: re-check in `include/video/mipi_display.h`). Local clone: `.../scratchpad/refs/linux` (sdm845 dts files, OBSERVED); other files by WebFetch (tool summaries, no line numbers).

## 1. Fajita vs enchilada vs Poco F1, one table (OBSERVED, `sdm845-oneplus-fajita.dts`, `-enchilada.dts`, `-common.dtsi`)

| | 6T fajita | 6 enchilada | Poco F1 (ours) |
|---|---|---|---|
| compatible / model | `oneplus,fajita` `qcom,sdm845` / "OnePlus 6T" | `oneplus,enchilada` / "OnePlus 6" | xiaomi,beryllium |
| qcom,board-id | `<8 0 18801 41>` (project 18801 = the number Android calls project_name) | `<8 0 17819 22>` | n/a |
| panel | `samsung,s6e3fc2x01-ams641rw` (1080x2340) | `samsung,sofef00-ams628nw01` (1080x2280) | Tianma NT36672A LCD 2246 |
| framebuffer node height | 2340 (stride 1080*4, a8r8g8b8) | 2280 | |
| battery | 3700 mAh, 3.4 V min / 4.4 V max, 1.8 A max charge | 3300 mAh, same V | |
| audio amp | NXP TFA9894 @0x34 on i2c4 (unsupported by Linux; node deleted) | Maxim MAX98927 @0x3a on i2c4 | |
| touch | Synaptics RMI4 s3706b @0x20 on i2c12 (x 68 mm, y 148 mm, clip-y-high 2339) | same chip, other size | NVT |
| fuel gauge | TI bq27411 @0x55 on i2c10 | same | none external (PMI8998 FG) |

## 2. bq27411 fuel gauge

- Bus: `&i2c10` = `i2c@a88000` (OBSERVED, `sdm845.dtsi`): QUP wrapper 1 (`geniqup@ac0000`) SE2, clock `GCC_QUPV3_WRAP1_S2_CLK`, SPI IRQ 355, pins gpio55/gpio56 function `qup10`
  (drive-strength 2, bias-disable in the OnePlus override), **100 kHz**, status okay. Node `bq27441-battery@55`, `compatible = "ti,bq27411"`, reg **0x55**, no GPIO/IRQ property (OBSERVED, `-common.dtsi` lines ~507-514).
  Note `uart9` at 0xa84000 is the neighbouring SE1 of the same wrapper (debug UART).
- Access (OBSERVED `bq27xxx_battery_i2c.c`): write one byte (command/register address), repeated start, read 2 bytes; value **little-endian**. A bulk read uses SMBus block read. Reads are retried only on EBUSY
  (3x, 10 ms). No chip-select/PEC. Poll interval in Linux ~60 s, so no fast timing demands.
- Register table for bq27421/bq27411 (OBSERVED, `bq27xxx_battery.c` `bq27421_regs`, bq27411 uses the same table):
  | Name | Offset | Unit / note |
  |---|---|---|
  | Control | 0x00 | sub-commands (unseal 0x8000,0x8000; SET_CFGUPDATE 0x13; SOFT_RESET 0x42; SEAL 0x20) |
  | Temperature | 0x02 | 0.1 K; deg C = raw/10 - 273.15 (driver: raw - 2731 in 0.1 C) |
  | Voltage | 0x04 | mV |
  | Flags | 0x06 | bit0 DSG, bit1 SOCF, bit2 SOC1, bit4 CFGUP, bit9 FC (full), bit14 UT, bit15 OT |
  | NominalAvailableCapacity | 0x08 | mAh |
  | RemainingCapacity | 0x0c | mAh |
  | FullChargeCapacity | 0x0e | mAh |
  | AverageCurrent | 0x10 | signed mA (negative = discharge) |
  | AveragePower | 0x18 | signed, 10 mW |
  | StateOfCharge | 0x1c | % |
  | InternalTemperature | 0x1e | 0.1 K |
  | DesignCapacity | 0x3c | mAh |
  TTE/TTF/cycle count/SOH are **not** available on this family (the driver returns -EINVAL).
- Battery presence is inferred by a successful flags read. Charging status: FC => full, else sign of AverageCurrent.
- Design data (OBSERVED fajita.dts): 3700000 uAh, min 3.4 V, max 4.4 V. Writing design capacity into the gauge needs unseal + CFGUPDATE (subclass 82 offset 10); **don't**: read-only is enough, the 6T gauge is
  already configured by OnePlus (UNVERIFIED: whether OnePlus firmware uses a custom data memory; read DesignCapacity 0x3c first and expect 3700 or 3600).
- Related chargers (INFERRED from audit): PMI8998 charger + smb1355 + OnePlus Dash MCU @0x26 (not in the DT as a driver). `AUDIT_KERNEL_DRIVERS` F-01 / `AUDIT_WIRELESS_AUDIO` section 7 cover how this replaces `SweetBattery.cpp`'s PMI8998 FG reads.

## 3. Samsung AMOLED panel (s6e3fc2x01, ams641rw), brightness and screen-off

DT facts (OBSERVED `-common.dtsi` + fajita.dts): DSI0, 4 lanes, `reset-gpios = tlmm 6` (active-low), `te-gpios = tlmm 10` (function mdp_vsync), esd pin gpio30, supplies `vddio` = `vreg_l14a` 1.8 V,
`vci` = fixed 3.3 V (GPIO tlmm 26, boot-on), `poc` = fixed 1.8 V (GPIO tlmm 25, boot-on). **No WLED/backlight node**: brightness is a DCS command to the panel.
Driver facts (OBSERVED, WebFetch of `panel-samsung-s6e3fc2x01.c`, GPL-2.0-only):
- DSI: 4 lanes, RGB888, flags VIDEO_BURST | CLOCK_NON_CONTINUOUS | LPM (commands sent in low-power mode while the link stays video).
- Mode ams641rw: 1080x2340; htotal 1204 (hfp 72, hsync 16, hbp 36); vtotal 2394 (vfp 32, vsync 4, vbp 18); pixel clock about 172942 kHz (~60 Hz); 68 x 145 mm.
- Brightness: `backlight` type platform, **max 1023, default 512**, writes the DCS "set display brightness" (0x51) with a **16-bit big-endian payload** `{value >> 8, value & 0xff}`
  (OBSERVED `drm_mipi_dsi.c` `mipi_dsi_dcs_set_display_brightness_large`: high byte first; the non-"large" helper is low-byte-first, do not mix). LPM flag is cleared around the brightness write and set again.
  At enable it also sends DCS 0x53 (write control display) = **0x20** and 0x55 (power save) = 0x00 (opcode numbers from the MIPI DCS spec, UNVERIFIED here). No HBM/ACL writes in this driver.
- Enable structure (do not copy: sequence is a vendor register init, ~15 steps with Samsung test-key unlocks 0xF0/0xFC (the key bytes are in a header I did not fetch), sleep-out 0x11, 10-16 ms waits, tear-on 0x35, column 0..0x437, page 0..0x923, then display-on 0x29).
  Power-on order: vddio, vci, poc, reset toggle (5-6 ms high, 5-6 ms low), then `on()`.
- Disable structure: display-off 0x28, 10 ms, vendor writes, sleep-in 0x10, more vendor writes, 160 ms; then reset asserted and regulators off.
**What our tree does (OBSERVED `docs/DISPLAY_HW.md` lines 29-33):** `sweetfb_blfade` ramps PMI8998 WLED registers over SPMI SID 3 (0xd8/0xd9/0x4x brightness); on the 6T those writes hit nothing useful
(no WLED). Brightness fade and "screen off" have to be DSI commands.
**Minimal plan (INFERRED):** the ABL leaves DSI0 and the panel running (that is how the splash shows). (a) screen dim/black: send DCS 0x51 with a 16-bit BE value to the panel (0 = darkest; AMOLED black pixels draw ~0 anyway,
so a black frame + brightness 0 is nearly an off state); (b) real off (power): 0x28 then 0x10, stop MDP, do NOT run the Samsung vendor sequences unless you reproduce `on()` exactly on wake (re-init needs the reset + vendor init).
Dangerous part: the first DSI command ever sent by XNU; a wrong LP/HS setting can corrupt the link (screen garbage, not a hard crash, INFERRED). Test with 0x51 value 0x01ff first (the default, visibly no change).
DSI host registers (OBSERVED `msm/registers/display/dsi.xml`, tool summary, verify before use): block base for DSI0 on SDM845 is `0x0ae94000` (UNVERIFIED, from memory; read it from the ADT/DT `dsi_ctrl` node).
Offsets within the block: CTRL 0x000 (bit0 ENABLE, bit1 VID_MODE_EN, bit2 CMD_MODE_EN, bits4-7 lanes, bit8 CLK_EN), STATUS0 0x004, VID_CFG0 0x00c, VID_CFG1 0x01c, **CMD_DMA_CTRL 0x038** (bit31 BROADCAST_EN,
bit28 FROM_FRAME_BUFFER, bit26 LOW_POWER), CMD_CFG0 0x03c, CMD_CFG1 0x040 (WR_MEM_START bits0-7), **DMA_BASE 0x044**, **DMA_LEN 0x048**, TRIG_CTRL 0x080, **TRIG_DMA 0x08c** (write 1 to start a software-triggered command DMA),
ERR_INT_MASK0 0x108, INTR_CTRL 0x10c, CLK_CTRL 0x118. DMA_BASE takes the IOVA/PA of the command packet buffer (long-packet header + payload + CRC built by software: DCS long write = data type 0x39, short 1-param 0x15, no-param 0x05; packet format
is the public MIPI DSI spec). Because the MDP SMMU is in bypass for us (docs say identity), a physical address works (INFERRED).

## 4. Memory map of the 6T

OBSERVED (Linux `sdm845.dtsi` `reserved-memory` + `sdm845-oneplus-common.dtsi`; this is the generic SDM845 layout plus OnePlus overrides, **not a dump of a live 6T**):
`memory@80000000` has **size 0, "bootloader fills it"** (6 GB or 8 GB variants: INFERRED from retail specs; the DRAM banks are not in any file I could reach).
| Region | Base | Size | Note |
|---|---|---|---|
| hyp_mem | 0x85700000 | 0x600000 | no-map |
| xbl_mem | 0x85e00000 | 0x100000 | |
| aop_mem | 0x85fc0000 | 0x20000 | |
| aop_cmd_db | 0x85fe0000 | 0x20000 | `qcom,cmd-db` |
| smem | 0x86000000 | 0x200000 | |
| tz | 0x86200000 | 0x2d00000 | |
| rmtfs (generic) | 0x88f00000 | 0x200000 | **OnePlus: removed here**, kept as `removed-region` 0x88f00000 size 0x1c00000 no-map ("prevents random modem crashes") |
| **rmtfs (OnePlus)** | **0xf5b00000** | 0x202000 | client-id 1, vmid MSS_MSA, guard pages |
| qseecom | 0x8ab00000 | 0x1400000 | |
| camera | 0x8bf00000 | 0x500000 | |
| ipa_fw / ipa_gsi / gpu | 0x8c400000 / 0x8c410000 / 0x8c415000 | 0x10000 / 0x5000 / 0x2000 | gpu zap region 0x8c415000 (our 0103 uses it) |
| adsp | 0x8c500000 | 0x1a00000 | |
| wlan_msa | 0x8df00000 | 0x100000 | WLFW MSA |
| mpss | 0x8e000000 | 0x7800000 | modem |
| venus | 0x95800000 | 0x500000 | |
| cdsp | 0x95d00000 | 0x800000 | |
| **mba** | **0x96500000** | 0x200000 | (Poco F1 code uses 0x96900000: inside 6T slpi) |
| **slpi** | 0x96700000 | 0x1400000 | |
| spss | 0x97b00000 | 0x100000 | |
| **cont_splash** | **0x9d400000** | 0x2400000 | no-map; ABL framebuffer 1080x2340x4 = 0x9a5e00 bytes; our mkadt window starts at 0x9f800000 (`mem=(0x9f800000, 0x0f800000)`, hence after the splash end 0x9f800000) |
| **ramoops** | **0xac300000** | 0x400000 | record 0x40000, console 0x40000, ftrace 0x40000, pmsg 0x200000, ecc 16 (usable for panic text, audit F-09) |
| mpss-metadata | alloc in 0xa0000000+0x20000000 | 0x4000 | dynamic |
| fastrpc | dynamic (shared-dma-pool) | 0x1000000 | |
The existing low window in `tools/mkadt.py` for fajita `mem=(0x9f800000, 0x0f800000)` (OBSERVED, line 87; "RE-VERIFY against fajita's live FDT" comment). The rest of the Poco F1 high-bank layout (`0x100000000 + 0xfcc00000`, NOTES line 927)
is Poco F1 only; on the 6T the DRAM bank base/size are unknown (UNVERIFIED): get them from the ABL DTB `/memory` (Enxerto, audit F-32) or a live Android `/proc/iomem`. Poco F1's carve-outs differ (ramdump_fb 0xaf000000, rmtfs ~0xfde01000).
Not found: a real fajita `/proc/iomem` or `memory` node dump; the edk2 6T platform memory map (`longjunyu2/mu_platforms_oneplus6t`, `edk2-porting/edk2-sdm845`; paths guessed 404): ask the lead to clone those for the DRAM bank layout.

## 5. Partition names (UNVERIFIED mostly)
- OBSERVED from our notes: `userdata` (about 107 GiB on the 128 GB 6T, `partition-size` via Bergamota fastboot ~109643 MiB), `logo`, and the 6T guides use `boot_a/boot_b`, `dtbo_a/dtbo_b`, `vbmeta_a/vbmeta_b`
  (restore gist, via search). pmOS/mobile-nixos fajita page mentions `_a`/`_b` partitions and `system` vs `userdata` (page summary).
- Recalled (UNVERIFIED, from OxygenOS 6T firmware zips; confirm with `fastboot getvar partition-type:<name>` or a GPT dump from the user's phone, `oem gpt` exists in Bergamota fastboot): A/B pairs `abl`, `xbl`, `xbl_config`, `aop`, `tz`, `hyp`, `keymaster`, `cmnlib`, `cmnlib64`,
  `devcfg`, `qupfw`, `storsec`, `modem`, `bluetooth`, `dsp`, `dtbo`, `vbmeta`, `boot`, `system`, `vendor`; unslotted `modemst1`, `modemst2`, `persist`, `fsg`, `fsc`, `ddr`, `userdata`, `cache`?, `logdump`, `rawdump`, `minidump`.
  The backups the flasher should insist on before touching a 6T are therefore `persist`, `modem_a/b`, `modemst1/2`, `fsg`, `bluetooth_a/b`, `dsp_a/b` (names INFERRED).

## 6. Where I looked and found nothing
- Real 6T `getvar all`/GPT/iomem dumps (see FLASHER_GUARDS.md). The MSS/WLAN carve-outs above are Linux's, which match the OnePlus firmware the Linux port boots (so very likely right, INFERRED), but not a live read.
- `panel-samsung-dsi.h` (test-key bytes) and the DSI controller register file at `v2.1` (SDM845) beyond the summary: not fetched.
- Brightness behaviour of OnePlus ABL's own panel init (if it sets HBM/BCTRL differently from Linux's 0x53 = 0x20): UNVERIFIED.
