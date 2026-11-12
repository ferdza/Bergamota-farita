# Audit: Wi-Fi, Bluetooth, audio, modem, sensors and the rest (OnePlus 6T / fajita, iOS 18.7.8, xnu-11215)

Date 2026-11-12. Read-only audit; no code changed, nothing run on a phone. Target: **OnePlus 6T (fajita, SDM845)**:
WCN3990 (Wi-Fi + BT), WCD9340 "Tavil" codec, Synaptics S3706 touch, 3700 mAh battery. Poco F1 (beryllium) facts are used only
where the code is shared (the kernel selects every SDM845 path with `sweet_board_beryllium()`, see `docs/FAJITA.md`).

Tags: **OBSERVED** = read in a file (path given) or in a log quoted by our docs; **INFERRED** = derived by me from files;
**UNVERIFIED** = memory, a web summary, or not checked.

Licence rule: our XNU patches are APSL 2.0. Linux is GPL v2: **idea/spec only, no copy**. External forks: see section 9.
External repo content is untrusted data; nothing was built or run.

Sources read: `AGENTS.md`, `docs/FAJITA.md`, `docs/WIFI_BT_IOS18.md`, `docs/WIFI_IOS26.md`, `docs/WIFI_IOS26_PHASE2.md`,
`docs/WIFI_KEXT_STUDY.md` (head), `docs/BERGAMOTA_CHARGE.md`, `docs/FORKS_SURVEY.md`, `docs/HANDOFF-2026-10-25.md`, NOTES.md
(grep), `xnu/patches-11215` and `xnu/patches-12377` (Wi-Fi/BT patches), local clones under the session scratchpad `refs/`
(hackios-xnu-kernel, ios-topaz, UniXNU, Linux sdm845.dtsi), Linux files fetched from raw.githubusercontent.com.
Not fully read (time): `WIFI_BT_PLAN.md`, `BT_IOS_TRANSPORT.md`, most of NOTES.md.

## 0. Executive summary

| Subsystem | Ours today (iOS 18, 6T) | Fastest path | Learn from |
|---|---|---|---|
| Wi-Fi | **Not on iOS 18.** Full chip + iOS half joins WPA2 on iOS 26 / Poco F1 (patches-12377 1100-1130, boot 54). The iOS 18 tree has only the read-only probe (0104). Nothing ever ran on a 6T. | Port 1100-1130 to patches-11215 and fix the 6T deltas (1.4) | our `wlan26` work; ios-topaz 0113-0130 |
| Bluetooth | Works on Poco F1 / iOS 18 (Settings lists devices, 2026-10-24). Never booted on a 6T. A2DP / classic untested. | Boot the existing set on 6T, then test audio path | Linux btqca/hci_qca (spec only) |
| Audio | nothing | Speaker: ADSP PAS boot -> APR -> AFE QUAT_MI2S_RX + TFA9894 (no SLIMbus) | HackiOS `drivers/audio` |
| Modem / cellular | MPSS boots (prerequisite of Wi-Fi); no cellular stack | after Wi-Fi: QMI NAS/WDS/DMS over the existing QRTR, IPA | HackiOS `drivers/modem` |
| Sensors | nothing | SLPI PAS boot + QRTR sensor service, or stubbed values | nobody |
| Camera | nothing | out of scope for now | HackiOS `drivers/camera` |
| Vibration | nothing | motor part unknown (section 6) | HackiOS `drivers/haptic` (Awinic, redwood) |
| NFC / GPS | nothing | NFC PN553 on i2c3; GPS via modem QMI LOC | nobody |

No other SDM845 iOS port has any of these: edi194/ios-fajita ("Wi-Fi, Bluetooth, the modem, the camera ... not there yet"),
JaneAwA/iOS16_on_mix2s and wangshaofan82-png/UniXNU-enchilada-port (all not started), per their READMEs (WebFetch 2026-11-12).
Prior art is only our Poco F1 work, ios-topaz (SM6225 Wi-Fi) and HackiOS (SM7325 Wi-Fi/audio/haptic/camera/partial modem).

## 1. Wi-Fi (WCN3990)

### 1.1 Status table

| Project | Chip | State | Where |
|---|---|---|---|
| **Ours, iOS 26 / Poco F1** | WCN3990 | **WPA2-PSK join from Settings, DHCP, internet** (boot 54, 251 ms join, 17 MB in / 0.9 MB out in 150 s). MSS/MBA/MPSS, SMP2P, GLINK/QRTR, rmtfs, TFTP, pd-mapper, WLFW, CE, HTC, WMI, HTT, in-kernel WPA2 4-way, en0 + Apple80211 ioctls. OBSERVED (log-quoted) `docs/WIFI_IOS26.md` 5.x-6.3; `xnu/patches-12377/1100-1130` |
| **Ours, iOS 18 / Poco F1** | WCN3990 | only read-only probe `sweetwlan=1/3` (0104). Not ported. `docs/WIFI_BT_IOS18.md` s3 OBSERVED; 1100-1130 absent from `xnu/patches-11215` OBSERVED (`ls`) |
| **Ours, 6T** | WCN3990 | never run. `docs/FAJITA.md`: "`sweetwlan` stays 0 (off)". |
| ios-topaz (SM6225, iOS 16.7.16) | WCN6856-class, WLFW | scan, join, **WPA2-PSK in kernel**, keychain, Safari over HTTPS; patches 0113-0130 + 0900 (Apple80211 for wifid). `README.md` OBSERVED. WPA2 only, no PS |
| HackiOS (SM7325 redwood, iOS 16.5) | WCN6750 | "yes": Linux **ath11k** compiled into the kernel (`drivers/wifi/lx/`, `hakios.wifi.c`, `hakios.wlfw.c`, `hakios.apple80211.c`). `docs/index.md` OBSERVED |
| edi194 / JaneAwA / UniXNU-enchilada (SDM845) | | nothing |

Evidence on the iOS side: ios-topaz and HackiOS both run **iOS 16** wifid against a kernel-only `en0` + `SIOCGA80211/SIOCSA80211`
(`redwood_apple80211.c` header comment: "where the driver offers no user client, ioctls still"). So the ioctl fallback exists in
the iOS 16 IO80211 framework too; INFERRED it exists in iOS 18 (not checked on an iOS 18 shared cache: **UNVERIFIED**, the
single most important check before porting, see 1.3 step 0).

### 1.2 Blockers (iOS 18 / 6T)

1. The iOS half (`bsd/dev/sweet_80211.c`, `SweetNetwork.cpp`, 1100-1103/1130) was reverse-engineered against **IO80211 1565.3 of
   iOS 26** (`WIFI_IOS26.md` s1). On iOS 18 the same wifid/IO80211 framework may expect a kext or a different capability bitmap:
   UNVERIFIED. `docs/WIFI_BT_IOS18.md` s3.2 still claims an "Apple80211-lite" stand-in needs 4-8 weeks; the iOS 26 work disproves
   that (the stand-in was ~1 week) but only for iOS 26.
2. Chip half hard-codes **Poco F1** addresses and names (1.4). On a 6T these either fail or write into the wrong carve-out
   (section 1.4 lists the exact constants).
3. 11215 vs 12377 source drift: `0104`, `0136`, `0239` differ between `patches-11215` and `patches-12377` (OBSERVED, `cmp`), and
   1104-1130 sit on the 12377 variants. A rebase onto 11215 is needed (0170 `xnu11215-api-fixes` shows the API delta is small).
4. Boot-arg field is full (603-606 of 607 bytes, WIFI_IOS26_PHASE2 s2): `sweetwlan=5` folds the gates; must be in the fajita
   image args too.
5. TrustZone/hypervisor risk of the first MSS action on a OnePlus (P3 was "riskiest step" on Poco F1; the 6T ABL arms CrashDump,
   `FAJITA.md`): a bad address = CrashDump, not a reboot.

### 1.3 Ordered plan

| # | Step | Files | Effort | Risk | Phone? |
|---|---|---|---|---|---|
| 0 | Static check on the iOS 18.7.8 root: does IO80211.framework (dyld cache) have the "Falling back to IOCTL path", `_isInfraInterface`, same `CARD_CAPABILITIES` bitmap, same wifid `_LimitLoadToDeviceTree`? Same strings as listed in WIFI_IOS26 s1.2-1.3 | none (IDA on cache) | 0.5-1 d | none | no |
| 1 | Fix 6T deltas (1.4) in the *iOS 26* source first (one source of truth), make carve-outs ADT-driven (`/sweet-modem` node from `tools/mkadt.py` board table, as 0100 canvas-from-adt does for the display) | `bsd/dev/beryllium_wlan.c`, `tools/mkadt.py`, `tools/adt-wlan.py` | 1-2 d | low | no |
| 2 | Rebase 1100-1130 (+0104/0136/0239 deltas) onto `patches-11215`; `tools/check-patches.py`, CI build | `xnu/patches-11215/11xx-*` | 2-4 d | medium (API drift) | no (CI) |
| 3 | 6T read-only probe `sweetwlan=3` (inventory: partition names `modem_a`, files `image/mba.mbn`, `modem.mdt`, `wlanmdsp.mbn`, `bdwlan.*`, SMEM layout, carve-outs vs DT) | same | 0.5 d | low | **yes**, user present |
| 4 | MBA copy-only then MBA alive (`sweetmssstep=3`, then full stage 4), exactly the Poco F1 ladder 5.2-5.7 | 1106-1110 | 1 d | **high first time** (CrashDump on wrong XPU/SMMU) | yes |
| 5 | MPSS load + SMP2P + rmtfs + TFTP + pd-mapper + WLFW + CE + WMI + HTT: boot 39-49 ladder | 1111-1123 | 2-4 d if no 6T surprises | medium | yes (one boot per rung, can be batched after the first two work) |
| 6 | Long-lived service + iOS backend + WPA2 (WL1-WL4) | 1124-1130 | 1-2 d (already written) | medium | yes |
| 7 | iOS 18 delta: ADT `wlan` node, `sweet80211=3`, capability bitmap, ASSOC_DONE size; Settings join | 1100-1103, 1127, 1130 | 2-5 d | medium (UNVERIFIED iOS 18 behaviour) | yes |
| 8 | Living with it: IRQs instead of 1 ms polling, PS, SSR (WIFI_IOS26_PHASE2 WL5) | | open-ended | | yes |

Realistic total to "Settings joins WPA2 on the 6T under iOS 18": **1.5-3 weeks**, mostly gated by phone boots (5 of them), not code.

### 1.4 6T-specific deltas (defects waiting for the first fajita run)

Linux mainline uses the generic `sdm845.dtsi` carve-outs for OnePlus 6/6T (no override in `sdm845-oneplus-common.dtsi`, WebFetch
of the file) and **overrides them for the Poco F1** (`sdm845-xiaomi-beryllium-common.dtsi`). Our code carries the Poco F1 values:

| Constant | Our value (file) | Poco F1 (Linux dts) | 6T / generic sdm845.dtsi (local clone `refs/linux/.../sdm845.dtsi`) |
|---|---|---|---|
| `MSS_MPSS_PA` | 0x8e400000 (`1106`/`1111`) | mpss 0x8e400000 + 0x7800000 | **0x8e000000** + 0x7800000 |
| `MSS_MBA_PA` | 0x96900000 (`1106`) | mba 0x96900000 + 0x200000 | **0x96500000** + 0x200000. Note 0x96900000 lies **inside `slpi_mem` 0x96700000+0x1400000** on the 6T layout: writing the MBA there is a write into SLPI memory (XPU violation, likely CrashDump) |
| `WLFW_MSA_PA` | 0x8e300000 (`1117`) | wlan_msa 0x8e300000 | **0x8df00000** + 0x100000 |
| `RMTFS_MEM_PA` | 0xf6301000 (`1113`) | rmtfs 0xf6301000 + 0x200000 | OnePlus overrides: **0xf5b00000 + 0x202000**, client-id 1, vmid MSS_MSA, guard pages; plus `removed_region` 0x88f00000+0x1c00000 (sdm845.dtsi default rmtfs 0x88f00000 is kept reserved "to avoid random modem crashes") |
| `adsp_mem`, `cdsp`, `slpi` | n/a | 0x8c500000+0x1e00000, 0x96100000, 0x96b00000 | 0x8c500000+0x1a00000, 0x95d00000, 0x96700000 (matters for audio/sensors, sections 3, 5) |
| partition names | `"modem"`, `"bluetooth"` (`0104` `fat_mount`, `wl_inventory`; `ufs_part_locate` does exact `strcmp`) | non-A/B | 6T is A/B: expect `modem_a`/`modem_b`, `bluetooth_a`: INFERRED (GPT of the 6T not read; `FAJITA.md` only names `userdata`). Needs slot-suffix fallback (androidboot.slot_suffix from the DTB chosen node) |
| WLFW host cap | skipped (`1117` header: "beryllium sets `qcom,snoc-host-cap-skip-quirk`") | skip quirk | OnePlus sets **`qcom,snoc-host-cap-8bit-quirk`**: Linux ath10k `qmi.c` `ath10k_qmi_host_cap_send_sync` sends HOST_CAP (0x34) using the 8-bit message variant; the skip path is only for `SKIP_HOST_CAP_QUIRK`. A 6T firmware not given HOST_CAP may never finish the handshake. Add the 8-bit HOST_CAP variant to `wf_*` before MSA (OBSERVED in Linux source via `curl`, idea only) |
| Board data | `wf_bdf_load` picks `bdwlan.bNN`/`bdwlan.NNN`/`bdwlan.bin` from the modem partition by the board_id the firmware reports (`1117`) | `qcom,calibration-variant = "xiaomi_beryllium"` | `"oneplus_sdm845"`; which `bdwlan.*` the 6T modem partition carries is UNVERIFIED |
| Wi-Fi DMA pool | 0xe0100000, 12 MiB (`1118` `WCE_POOL_PA`) | free | also free on 6T (xnu RAM starts 0x9f800000... rmtfs now 0xf5b00000 > 0xe0d00000): INFERRED OK |
| Rails | `rh_wcn_rails` allow-list ldoa5 0.8 V, ldoa7 1.8 V, ldoa17 1.304 V, ldoa23/25 3.3 V (`0104` sweet_rpmh) | same | same rails in `sdm845-oneplus-common.dtsi` (`wcn3990-pmu`: s4a, l7a, l17a, l25a, l23a). **Extra: `swctrl-gpios = pm8998 gpio 3`** (input, pull-down) not handled by us; probably only status |
| `ARM64_BOARD` gating | `sweet_board_beryllium()` | | fajita ADT lists `xiaomi,beryllium` (FAJITA.md) so OK |

### 1.5 Other defects visible in code (file:function)

* `0104` `fat_mount()`/`fat_open`: FAT16 only, name matched exactly, `FAT_BUF_MAX` 64 KiB FAT: a bigger 6T `modem` FAT (FAT32 or ncl > 65524) returns ENXIO ("not FAT12/16") with no fallback. UNVERIFIED for the 6T.
* `1117` `wf_bdf_load`: silently falls back to `bdwlan.bin` when `bdwlan.bNN` is missing; wrong calibration would only show as bad RF performance.
* `1113` rmtfs is read-only with RAM copy for writes: the 6T (OnePlus) modem keeps calibration in `modemst1/2`, `fsg`; a RAM-only EFS means a fresh modem state every boot (fine for Wi-Fi, bad for cellular, section 4).
* `1127` handshake + `1128`: PMF/WPA3/TKIP not handled (`WIFI_IOS26.md` 6.3 "Not done yet"). Everything is polled at 1 ms (PHASE2 s2): battery cost on a 3700 mAh phone.
* `0035`/charger work is separate; no 6T Wi-Fi code uses `bq27441`. (Battery: see section 7.)

### 1.6 What to learn from others

* ios-topaz `0113-0130` (same stack on Redmi Note 12 4G, iOS 16): confirms the architecture and the Apple80211-ioctl route; adds nothing we lack (our chip half is further: it already has WCE/HTT details documented). Licence: **no LICENSE file** in the clone (checked `ls`); `CREDITS.md` says its HackiOS-derived kernel patches are APSL 2.0 but the rest is unlicensed => read only, do not copy.
* HackiOS `drivers/wifi/hakios.wlfw.c`, `hakios.apple80211.c` (APSL 2.0 for `drivers/`, `LICENSE` s1; MIT for the rest): may be adapted with notices, but they target ath11k/WCN6750 (QMI wlfw v1 for HW 2.0 with different messages), so only the Apple80211 ioctl map is directly useful, and we already have it.
* Linux (spec only): `drivers/net/wireless/ath/ath10k/{qmi.c,qmi_wlfw_v01.c,snoc.c,wmi-tlv.c,htt_rx.c}`, `drivers/remoteproc/qcom_q6v5_mss.c`, `drivers/soc/qcom/{smem,rmtfs_mem}.c`, `net/qrtr/`, `drivers/soc/qcom/qmi_interface.c`.

## 2. Bluetooth (WCN3990 over UART, QCA protocol)

### 2.1 Status table

| Project | State |
|---|---|
| **Ours, iOS 18 / Poco F1** | **Works to Settings listing devices** (combo9, 2026-10-24, user-checked, `docs/WIFI_BT_IOS18.md` 2.10): kernel UART (QUP SE6 @0x898000, GPIO 45-48), RPMh rails, QCA power pulses at 2400/115200 baud, firmware download at 3 Mbaud (rampatch `crbtfw21.tlv` + `crnv21.bin`, linux-firmware), in-band-sleep, kernel control `com.apple.uart.bluetooth` (0136), BlueTool stub, AKS key wrap for bluetoothd's keychain (0238), HCI compat layer for Apple's Broadcom-assuming stack (0239 v7), Skywalk privileges for the AudioPipe nexus (0250). OBSERVED (log-quoted) |
| Ours, 6T | **never booted.** Default image args contain no `sweetwlan=2 sweetbt=1 ...` (`tools/renegade/mkboot-full.sh` line 21 and `gpu-default-args.txt`: grep for `bt`/`wlan` empty, OBSERVED), so bluetoothd crash-loops; `FAJITA.md` "bluetoothd crash-loops: Bluetooth is not ported" is stale (it is ported, only off) |
| Ours, 12/iOS 26 | `sweetbt=1` in args, "no new result on iOS 26" (`HANDOFF-2026-10-25.md`) |
| HackiOS | **no** ("step one only: a read-only look at its pins", WCN6750; `drivers/bluetooth/hakios.bt.c` 6 KB) |
| ios-topaz | **no** (README: "No Bluetooth ...; bluetoothd relaunches constantly") |
| ch1tmdgus/ios-v60 (LG V60, QCA6390) | BT UART bring-up diagnostics + HCI version query only (`docs/FORKS_SURVEY.md` C) |
| UniXNU / edi194 / JaneAwA | none |

We are the **only project in the survey with working iOS Bluetooth**. Nobody to learn from; the spec is Linux
`drivers/bluetooth/{btqca.c,hci_qca.c}` (GPL: idea only) and Apple's own bluetoothd behaviour (already reverse-engineered in
`docs/BT_IOS_TRANSPORT.md`, `WIFI_BT_IOS18.md` 2.x).

### 2.2 Blockers and what is partial

1. **6T boot never done**; difference list is short (rails identical in Linux `sdm845-oneplus-common.dtsi`: s4a 1.8, l7a 1.8, l17a 1.3, l25a 3.3, l23a 3.3; UART `qup_uart6_4pin`, same SE6/GPIO 45-48 as beryllium; `max-speed 3200000`). Differences: the NVM file (`firmware-name = "OnePlus/enchilada/crnv21.bin"` in Linux; our root installs the generic linux-firmware `crnv21.bin` via `RENEGADE_BT_FW`), and PM8998 gpio 3 `swctrl`. INFERRED low risk; the SE6/QUP clock + RPMh code is SoC-level, not board-level.
2. The ADT node: `tools/mkadt.py` sets `bluetooth=True` for fajita (line ~94, OBSERVED), BT MAC is a **fixed synthetic 02:00:5e:77:b0:01 for every phone** (`BT_MAC`, mkadt.py:41): two phones in one room collide; bluetoothd ignores the env address (`WIFI_BT_IOS18`/NOTES bt18: `BT_DEVICE_ADDRESS` discarded) so the controller address is set with vendor 0xfc14 by the kernel. Better: derive from the SoC serial or the phone's real `/persist` BD addr (do not read persist without user OK; AGENTS rules).
3. **Audio over BT untested**: 0250 grants `PRIV_SKYWALK_REGISTER_USER_PIPE` so bluetoothd's AudioPipe constructor stops crashing, but "whether A2DP works end to end (the audio HAL side of the channel)" is UNVERIFIED (`WIFI_BT_IOS18` 2.12). NOTES 2026-11-12 mentions a "BT audio HAL park" in userland, i.e. the HAL side is parked, not working. Without any audio hardware driver (section 3), mediaserverd has no route; BT is the only audio sink possible early.
4. **0239 compat layer is a set of lies** (design risk, not a bug): unknown-command and Command-Disallowed statuses are rewritten to success; vendor commands get 16 padded parameter bytes; an 800 ms watchdog fakes completion. Apple's Broadcom vendor features (multi-advertising, LE offloads, duplicate filter, RSSI thresholds) silently do nothing. Expect: background BLE scanning/advertising oddities, Continuity/AirDrop discovery not working, classic HFP/A2DP details unverified. File: `xnu/patches-11215/0239-beryllium-bt-hci-compat.patch` (`bt_local_cmds` table, watchdog).
5. `/dev/btwake` absent (logged, harmless), 64-line HCI trace budget (`sweetbtlog`) too small, TCC identity warnings: cosmetic.
6. Boot-arg field budget (601/608 bytes) shared with Wi-Fi: `sweetwlan=2 sweetbt=1 sweetbtfast=1 sweetbtibs=1 sweetwlandelay=30` (~65 bytes) must fit with `sweetwlan=5` Wi-Fi: **both use `sweetwlan`**: stage 2 (BT) and stage 5 (Wi-Fi service) are mutually exclusive as one integer. Needs a bitmask or separate `sweetbt=` gate that also powers the rails. INFERRED from the two docs (`WIFI_BT_IOS18` 2.2 vs `WIFI_IOS26_PHASE2` s2); on iOS 26 boot args had `sweetwlan=2` and Wi-Fi booted with other gates (`sweetwlan=4`/`5` variants) so confirm.
7. Wi-Fi and BT share the WCN3990 rails/`ldoa7` (0117: an RPMh "off" vote panicked boot 0116hw): rail ownership must be refcounted between the BT stage and the Wi-Fi service (Linux: wcn3990-pmu regulator consumers). Not seen in code; INFERRED risk when both are enabled.

### 2.3 Ordered plan

| # | Step | Files | Effort | Risk | Phone? |
|---|---|---|---|---|---|
| 1 | Add BT args to the fajita image (`sweetwlan=2 sweetbt=1 sweetbtfast=1 sweetbtibs=1 sweetwlandelay=30`) in `tools/install/build-boot.sh fajita`; install `RENEGADE_BT_FW` firmware in the root; verify the 6T `bluetooth_a` partition NVM vs linux-firmware | `tools/renegade/mkboot-full.sh`, `tools/install/build-boot.sh`, root builder `tools.rs` `bluetooth_stub` | 0.5 d | low | yes: one boot |
| 2 | If HCI init fails on 6T: compare NVM (`OnePlus/enchilada/crnv21.bin` from postmarketOS `firmware-oneplus-sdm845`, or the phone's partition) | 0124 | 1 d | low | yes |
| 3 | Test pairing + A2DP/HFP with headphones; log `SWEET BT:` for rewritten opcodes; decide which Apple vendor commands deserve real emulation | 0239, `bsd/dev/beryllium_bt_hci.c` | 3-5 d | medium | yes |
| 4 | Unique BD_ADDR (serial-derived), `/dev/btwake` stub, BT/Wi-Fi rail refcount | `tools/mkadt.py`, 0104/0117 | 1-2 d | low | yes |
| 5 | Coexistence with Wi-Fi (`sweetwlan` split) | `beryllium_wlan.c` stage table | 1 d | medium | yes |

## 3. Audio (speaker, earpiece, microphones; WCD9340 "Tavil", ADSP)

### 3.1 Status table

| Project | State |
|---|---|
| **Ours** | **Nothing.** No audio patch in `xnu/patches-11215` or `-12377` (`ls | grep -i audio` empty). No ADSP boot, no APR, no codec. iOS side: iPhone X (D22) identity; mediaserverd/VirtualAudio only sees CoreAudio's Null device (NOTES l.841 documents a VirtualAudio SIGSEGV loop on iOS 16, since parked by root tweaks `root_tweaks18.py`) |
| HackiOS (SM7325 redwood, iOS 16.5) | **Speakers and microphone work** (`docs/index.md`, `devices/redwood.md`: "audio works, adsp=1 sound=4 mic=4"): `drivers/audio/hakios.adsp.c` (ADSP PAS boot via TZ image 1, SMP2P, GLINK, QRTR, **APR** `apr_audio_svc`), `hakios.sound.c` (ASM stream + ADM COPP + AFE port 0x9000 TDM), `hakios.speaker.c` (two Awinic AW88261 amps, I2C bit-banged, firmware config from the phone's `/vendor/etc/aw882xx_acf.bin`), `hakios.guard.c` (software speaker protection), `hakios.mic.c`; user side `userland/src/audio_plugin.c` = a CoreAudio **AudioServerPlugIn** presenting "Speaker", "Hawking", "Actuator", "Codec" devices that VirtualAudio.plugin routes through the iPhone X `d22_speaker_general` chain. OBSERVED (heads of the files) |
| ios-topaz (SM6225) | ADSP PAS boot + SMP2P + GLINK + QRTR + GPR (AudioReach) only: patches 0144-0146 (port of topaz-woa where the speaker works on Windows). README: "No ... audio". OBSERVED |
| edi194 / JaneAwA / UniXNU-enchilada / PalanBanana | nothing / not started / skeleton (PalanBanana "0084 WCD9375 audio" refuses to run, `FORKS_SURVEY` C) |
| Android/Linux on 6T | postmarketOS mainline: speaker and codec status UNVERIFIED (could not fetch the wiki: Anubis block). Linux `sdm845-oneplus-fajita.dts` deletes the speaker DAI link because "TFA9894 codec is unsupported", so only earpiece/headphone path (WCD9340) is described |

### 3.2 What the 6T needs (from Linux dts, spec only; OBSERVED via WebFetch of `sdm845-oneplus-common.dtsi`, `-fajita.dts`)

* DSP: ADSP (`adsp.mbn`, carve-out `adsp_mem` 0x8c500000 + 0x1a00000 on the generic layout, **not** Poco F1's 0x1e00000), booted by TZ PAS image id 1 like the MPSS path we already have for MSS (but MSS on SDM845 uses MBA, ADSP/CDSP/SLPI use **PAS**; `docs/WIFI_BT_IOS18.md` already notes "SDM845 MSS boots by MBA self-auth, not PAS").
* Speaker path: **TFA9894** (NXP) smart amp on i2c4 @0x34 (only a comment in the dts), fed by the SoC's **QUATERNARY_MI2S_RX** (sound card `speaker-dai-link`; Poco F1 uses TAS2559/60 on the same QUAT MI2S, i2c5 @0x4c). It needs NO SLIMbus and no WCD9340: ADSP AFE port + amp register init (+ the vendor `tfa98xx.cnt` container file from the phone's Android: UNVERIFIED which partition: `/vendor/firmware/` is in `system`/`vendor`, not in `modem`, so it needs a read of the Android vendor partition (user OK), or the OnePlus 6T firmware from postmarketOS `firmware-oneplus-sdm845`).
* Earpiece, headphones (6T has no jack: USB-C adapters/BT), analog mics: WCD9340 over **SLIMbus**. Linux needs `qcom-ngd-ctrl.c`: the apps-side NGD controller talks to the ADSP over QRTR service **0x0301** ("SLIMBUS_QMI_SVC_ID", version 1) to obtain the bus, then codec registers via SLIMbus messages, plus `wcd934x.c` (>10k lines of register tables; spec only). This is the heavy part: **do the speaker first, defer WCD9340**.
* Reset gpio 64 for WCD9340; mic bias 2.7 V; MCLK 9.6 MHz (`WCD934X_DEFAULT_MCLK_RATE`, Linux `sdm845.c`).
* Alert slider (3-position switch) is a GPIO key (Linux: "Vibrate" position only), fits the keys driver.

### 3.3 Blockers

1. No ADSP boot. Needs the PAS SCM calls (`qcom_scm_pas_init_image/mem_setup/auth_and_reset`, service 0x0C); xnu 0106-0111 only do MBA/MSS. HackiOS/topaz both wrote PAS code (HackiOS's is APSL 2.0 and ADSP-specific numbers are redwood: image 1, item 443/429, IPCC), SDM845 differs (**no IPCC**: SDM845 uses APCS/IPC bits via mailbox, as our 1112 SMP2P doorbell already does; SMP2P ADSP items 443/429 are the same family as Linux `smp2p` on SDM845 = remote pid 2).
2. APR (not GPR) service set: ASM, ADM, AFE on `apr_audio_svc` over GLINK: HackiOS shows the working order for redwood; Linux `sound/soc/qcom/qdsp6/{q6afe,q6asm,q6adm,q6routing}.c` is the spec.
3. The audio DSP reads sample buffers through the apps SMMU (HackiOS: stream 0x1801 with `qcom,smmu-sid-mask 0xf`; **SDM845 value UNVERIFIED**, from Linux `sdm845.dtsi` `q6asmdai`/`q6adm` iommus: check the local clone). The SDM845 hypervisor resets the SoC on an unmatched stream (`FORKS_SURVEY` A1): same lesson as USB/GPU, so reuse our SMMU context code (0094/0254).
4. The TFA9894 amp: I2C and firmware container unknown; **no protection without the DSP's speaker protection**: HackiOS wrote a software `guard` (gain, high-pass, power average, peak limiter) because the vendor speaker protection is in the DSP. Same risk on the 6T: a mis-driven amp can damage the speaker. Start at -20 dB below nominal like HackiOS `sound_below=160`.
5. iOS side: needs a HAL path. Our root has no VirtualAudio device for the 6T; HackiOS's plug-in approach (MIT, iOS 16.5, `userland/src/audio_plugin.c`) may be reusable but **iOS 18.7.8's VirtualAudio/coreaudiod layout is UNVERIFIED**.
6. Everything above shares `adsp_mem`/SMEM/IPC code with Wi-Fi (HackiOS had to put locks around the shared always-on mailbox and the SMEM allocator when Wi-Fi and ADSP ran together, `hakios.adsp.c` head). Ours: `beryllium_wlan.c` owns SMEM allocation; any audio code must go through its lock.

### 3.4 Ordered plan

| # | Step | Files | Effort | Risk | Phone? |
|---|---|---|---|---|---|
| 0 | Prereq: Wi-Fi chip half working on 6T (shared SMEM/GLINK/QRTR/TZ code) | section 1 | | | |
| 1 | PAS client (`init_image`, `mem_setup`, `auth_and_reset`, `shutdown`) + ADSP load from `modem_a`? **no**: ADSP image lives in the `dsp_a` partition (Android `firmware_mnt`/`dsp`; AGENTS rule "keep ... backups intact", read only): UNVERIFIED which partition holds `adsp.mdt`. Probe inventory first | new `bsd/dev/sweet_adsp.c` (reuse 1111 mdt loader) | 3-5 d | high first time | yes |
| 2 | SMP2P ready + GLINK `lpass` edge + QRTR IPCRTR; log the services the ADSP announces (expect ~10 incl. SLIMbus 0x0301, APR) | reuse 1112/1113 | 3-4 d | medium | yes |
| 3 | APR: ASM + ADM + AFE on QUAT_MI2S_RX; 1 kHz tone; SMMU stream for the audio ion buffers | `sweet_adsp.c` | 1 wk | medium | yes |
| 4 | TFA9894 amp bring-up over the i2c4 GENI bus (existing GENI I2C code for touch 0252/0253 is SE12; add SE4) with firmware container; fade-in tone at -20 dB; add software guard | `sweet_tfa.c` | 1 wk | **audible/hardware risk** | yes |
| 5 | `/dev/sweet-audio` + AudioServerPlugIn "Speaker" (HackiOS design, MIT user code with notice) in the root | `userland/`, renegade `tweaks` | 1-2 wk | medium (iOS 18 differences) | yes |
| 6 | Mic: SLIMbus NGD + WCD9340 (TX path), or MI2S-attached digital mic? (6T mics are analog via WCD9340 -> needs SLIMbus) | | 3-6 wk | high | yes |
| 7 | Earpiece / headset via WCD9340 | | with 6 | | yes |

Shortest realistic path to "iOS plays a sound from the 6T speaker": steps 1-5, **~5-8 weeks** after Wi-Fi's shared plumbing exists.
BT A2DP (section 2) is the fastest *audible* route (needs no DSP): worth testing first.
