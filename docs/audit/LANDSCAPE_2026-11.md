# iOS on Android hardware: landscape map, 2026-11-12

Status of this document: written incrementally (each section is committed on its own). Sections marked DRAFT are
still being filled. Everything about other projects is untrusted third-party data: nothing was run or built.

## 0. Method, evidence tags and limits

Sources, in order of weight:

- **V = verified in repo**: a file was read in a local read-only clone under
  `/tmp/claude-0/-home-user-Bergamota-farita/f3a6144f-169f-5d24-8f9c-9f901920a199/scratchpad/refs/`
  (`hackios-xnu-kernel` = `oosexgang_hackios-xnu-kernel`, `UniXNU_UniXNU`, `LMasterPiec3_ios-sweet`, `MakrSas_ios-topaz`,
  `IOS4Amethyst_AdrenoMetal`, `urielc918_ios-switch`, `ry-diffusion_Chlorophyll`). Note the clones are snapshots: topaz is dated
  2026-10-22 (local HEAD), UniXNU 2026-11-12, so topaz has certainly moved on.
- **R = README / docs claim** read on the web (WebFetch of a repo page or hackiosx.dev) but not checked against code.
- **S = GitHub search metadata** (`gh api search/repositories`: pushed_at, licence, stars, description). Reliable for
  existence/date/licence, says nothing about whether the code works.
- **P = press, P? = rumour**: none found yet in this pass (see section 5, open items).
- A claim from one project's page about another project (for example HakiOS's comparison table) is R at best.

Limits of this pass: the repo REST API for individual repos (`gh api repos/OWNER/NAME`) is refused for everything except
search, so licence/last-push come from search results. `projects.html#community-ports` of hackiosx.dev was fetched (R).
Telegram, X, reddit and YouTube were not reachable/searched yet (open items).

## 1. Projects found (DRAFT: table 1a verified-in-clone entries, 1b search/R-only entries)

Abbreviations: ok = claimed working, part = partial, no = stated missing, ? = not stated.
"xnu" is the open-source xnu version the kernel is built from.

### 1a. Projects read in local clones (V unless marked)

| Project | Device / SoC | iOS (userland) / xnu | Licence | Last activity | Claimed state (source) |
|---|---|---|---|---|---|
| **dipa-studio/ios-sweet** (origin of the whole family; copy LMasterPiec3/ios-sweet is the active tree, see below) | Redmi Note 10 Pro `sweet`, SM7150, Adreno 618 | 16.7.16 (iPhone X) / xnu-8796 | MIT (S: spdx MIT on dipa-studio; LICENSE read in urielc918 copy: "Copyright (c) 2026 dipa-studio"); XNU patches APSL-2.0 (V in ios-switch README) | S: dipa-studio pushed 2026-10-23, 1354 stars | hackiosx.dev (R): home/lock screen, touch, buttons, 8 cores, storage; no Wi-Fi/BT/audio/GPU/battery (this was the state at the time of the page) |
| **LMasterPiec3/ios-sweet** (same README title "ios-sweet", 224 patches, no LICENSE file seen at root; unclear whether it is the maintainers' main repo or a derivative: NEEDS CHECK) | `sweet`, SM7150, A618 | 16.7.16 / xnu-8796 | no LICENSE at root (V: ls). third_party/ and `userspace/native-metal/HAKIOS-LICENSE.txt` exist | README dated 2026-11-09 (V) | **README (V, claims)**: boot, touch (Goodix GT9896 over GENI I2C), buttons (SPMI), **GPU: native Metal on A618 (AIR->NIR->ir3, own kernel NativeAdreno) ~37 fps animations, no stable 60**, **Wi-Fi WCN3990 WPA2 + DHCP, instant scan list (userspace daemon `wland`)**, **Bluetooth WCN3990 H4 transport + pairing + audio to BT headphones**, **speaker audio via ADSP (APR AFE/ADM, Awinic amps)**, haptics (AW8624), cellular calls (SMS/data unfinished, IPA data path patches 0192-0194,0241), sensors via ADSP SEE streamed to HID (auto-rotate/compass untested), battery (PM6150 gauge, charge counting), sleep/wake, USB CDC-ECM + SSH + file server. Missing: mic, cameras, GPS, SEP, iServices. Known bug: modem crash ~1 boot in 3 |
| **oosexgang/hackios-xnu-kernel (HakiOS)** | POCO X5 Pro 5G `redwood`, SM7325 (sc7280), Adreno 642L; also MT6768 Infinix Hot 20 (separate repo), QEMU virt | Darwin/iOS **16.5** userland / xnu-8796.121.2 (V: README, CHANGELOG sources) | kernel patch + drivers APSL-2.0; rest MIT (V: LICENSE header, LICENSE.APSL) | CHANGELOG 2026-11-05 v2.3.4; README news 2026-11-04 (V) | **V (devices/redwood.md generated from device.conf)**: display, touch (Goodix GT9916/FocalTech FT3680 SPI), buttons, 8 cores @2.4 GHz, GPU Adreno 642L GLES via Mesa and Metal (window server draws via Metal: swipes 100-104 fps measured, 120 not reached; 110-115 at 828x1792; README 2026-11-04), UFS read + persistent var, audio speakers+mic via ADSP, battery level via ADSP (charging under this kernel: no), haptic AW86927, camera (Camera.app), **Wi-Fi WCN6750 with Linux ath11k via a LinuxKPI shim (`wifi/lx`), joined a network**, Bluetooth: no (read-only pin look), cellular: partial (modem boots, SIM bound, IPA data path + QMI WDS written, no registration yet), thermal partial |
| **UniXNU/UniXNU** + SoC/device repos | catalogue of 355 device records (V: `devices.toml`); reference device Xiaomi Pad 6S Pro `sheng`, SM8550, Adreno 740 | iPadOS **27.0.1 (24A446)**, 26.5.2, 17.7.11, macOS 27.3 profiles (V: `profiles/os`); xnu-10063 for arm64 profile, `patches/xnu-12377` for arm64e (V dir listing) | BSD-2-Clause-Patent (V: LICENSE); component repos AdrenoMetal and Adreno740 are MIT (S) | pushed 2026-11-12 (V local HEAD date, S) | **V (docs/devices, docs/drivers)** on sheng: UEFI boot, GPU A740 native kernel driver with 2-ring preemption + Metal via metal2vulkan+Turnip (verified composition on sheng per AdrenoMetal README), touch, display, UFS, **Ath12kWifi** (Linux v7.0.14 ath12k+mac80211+cfg80211 on XNU, WCN7850, wpa_supplicant 2.12, en0 + Apple80211 for wifid, WPA2-PSK), **QcaBluetooth** (Linux btqca.c over GENI UART, H4 into bluetoothd via UART.SK), **QcomDwc3** (derived from Apple's AppleUSBXDCI/XHCI, unchanged configd/lockdownd), **QcomBaseband** (AppleBaseband/ABM/CommCenter bridge; worked example SC7180 "Coachz": LTE registered, IPv4 data over IPA; eSIM partial). HackiOS's own docs say sheng lacks Wi-Fi/BT/USB (older page), the repo docs are newer: trust repo |
| **MakrSas/ios-topaz** | Redmi Note 12 4G `topaz`, SM6225 (khaje), Adreno 610 | 16.7.16 / xnu-8796 | not stated on repo page (R); borrowed HackiOS parts: APSL-2.0 kernel, MIT userspace (V CREDITS.md) | local clone HEAD 2026-10-22 (V); S: forks keep appearing | **V**: Wi-Fi via own kernel driver `TopazModem` (patches 0113-0130): modem PAS boot via TZ from `modem_a`, GLINK/QRTR, pd-mapper/tftp/rmtfs, **WLFW QMI, copy engines, HTC/WMI/HTT, scan, association, WPA2 4-way handshake in kernel** (chip family WCN3988/WCN3990-class, ath10k-snoc style), Apple80211 for wifid (0900); Adreno 610 via Mesa freedreno (0901-0947); 4K-page kernel + 8 cores AMP (0140-0141); audio ADSP (0144); battery gauge (0091); direct MDP scanout (0092). Frame rate 25-35 fps (V README) |
| **IOS4Amethyst/AdrenoMetal** (= UniXNU/AdrenoMetal) | Metal frontend for Adreno via metal2vulkan + Turnip | n/a | MIT (V LICENSE "NativeMetal contributors") | 2026-11-12 (S for UniXNU/AdrenoMetal) | V: bridge/offline wire protocol, plugin, shader cache, frame diagnostics docs |
| **ry-diffusion/Chlorophyll** (Bergamota's Metal driver; our upstream) | Poco F1, Adreno 630 | iOS 18.7.8, also iOS 26.6.2 notes (V IOS26.md) | README says MIT, but AIR frontend files come from hackios userland (MIT); S shows NOASSERTION | S: pushed 2026-10-26 | V: AIR->NIR->ir3 Metal on Gallium measured 14-35 fps swipes; Turnip runtime `chl` 27/27 checks on phone at 5-7.5 us/draw (docs/TURNIP.md); we already carry its perf patches |
| **urielc918/ios-switch** | Nintendo Switch (Erista, Tegra X1), 4K-page xnu | 16.7.16 / xnu-8796 | MIT + APSL-2.0 patches; hekate GPLv2 only as register reference (V) | README status 2026-11-05; S pushed 2026-11-08 | V README: lock screen on panel, touch+buttons, 4 cores, SD DMA, battery, clock; CPU-drawn, no GPU; patches 0960-0988 |

### 1b. Projects known from search metadata or web pages only (S/R)

(DRAFT: filled in the next commit.)

## 2. Per-subsystem best known implementation (DRAFT)

(To be written.)

## 3. Ranked list of 15 techniques/features for the OnePlus 6T (DRAFT)

(To be written.)

## 4. Corrections to docs/FORKS_SURVEY.md (DRAFT)

(To be written.)

## 5. Open items / repos to clone

(To be written.)
