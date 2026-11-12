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
