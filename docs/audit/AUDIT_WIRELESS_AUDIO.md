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
