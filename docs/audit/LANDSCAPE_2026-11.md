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

### 1b. SDM845 projects (R from repo pages fetched 2026-11-12 unless marked; licence from S)

| Project | Device | iOS / xnu | Licence | Claimed state (R) |
|---|---|---|---|---|
| **edi194/ios-fajita** (S pushed 2026-11-11) | **OnePlus 6T fajita**, SDM845 (our device) | 16.7.16 / xnu-8796 (fork of ios-sweet, ~275 commits) | no licence shown (S: none) | README/NOTES-FAJITA (dated to 2026-10-24, commit log to 2026-11-06): lock/home screen, **RMI4 Synaptics touch** (I2C 0x20 on SE7, ldoa28 via RPMh), PM8998 keys, 8 cores, own UFS, panel console; **GPU a630 kernel ladder (adreno=9): GMU fw boots, HFI v1 both ways, GX on at 257 MHz; CP/zap/SMMU not yet (commits 2026-11-03..06: CP submit, SMMU translation fault, PTE removed under the CP, "IOKit owns buffer memory")**; **USB: 2026-11-05 commit "power the SDM845 controller up, with fajita's own clock offsets", no enumeration reported**; reboot-to-fastboot via qcom-pon/misc; no Wi-Fi (plan: port topaz 0113-0130), RTC reads 1969 |
| ferdza/ios-fajita, miguelgargs/fajita-ios (S) | fajita | 16 | none | copies/forks of the above, no new evidence |
| **johnpanos/UniXNU-fajita** (V in UniXNU docs/devices/fajita.md; S pushed 2026-10-27) | **fajita** | iPadOS 17.7.11 kernelcache, XNU 23.6.0 (xnu-10063) | NOASSERTION (S) | V: Mu-Silicium UEFI + UniXNU menu work on hardware via `fastboot boot`; XNU boots to root mount, "VM, scheduler, IOKit, AMFI, Sandbox, APFS start", **no storage driver**; 8.74 GiB iPadOS root flashed to userdata; payload volume flashed to `boot_a` because ABL refuses a large ramdisk; `fastboot set_active b` before each boot; firmware derived from the enchilada port (`scripts/make-fajita-uefi.py`) |
| **keyfan/UniXNU-enchilada-bringup** (S pushed 2026-11-12) | OnePlus 6 enchilada, SDM845 | iPadOS 17.7.11; xnu not stated | LICENSE present, type not shown; S NOASSERTION | UEFI menu 2026-10-28; XNU reaches `_bsd_init`, launchd pid 1 (2026-11-03); root volume read with zero failures; Data = writable RAM disk, UFS read-only; SpringBoard/backboardd have run (software composition); touch not working; GPU not working; **USB: `NativeDwc3` default-off probe, unconfirmed; log over USB CDC ACM (`SHLOG001`)**; NOTES-touch/ssh/userland/ios16 |
| dragon120820/UniXNU-enchilada, UniXNU-sdm845-common (V docs/devices/enchilada-dragon120820.md) | OnePlus 6 (A6003, 8 GB) | iOS 16.7.16 profile `ios-16.7.16-20H392` added by the author, xnu-8796.101.5 | NOASSERTION | V: "skeleton record", mostly planned; **useful hard facts**: ABL needs gzip Image + v1 header, bootstrap page table limit (8 pages cover 3 GiB, ARM_LARGE_MEMORY issue fixed by 0x80000000 owned memory), Mu-Silicium enchilada DTB vs 2.7 KB draft, SEC entry-arg HOB patch, `--target RELEASE` (DEBUG DXE ran out of pool), MMU-on stage probes reset the phone |
| wangshaofan82-png/UniXNU-enchilada-port, rou2ter/UniXNU-enchilada-bringup (S, devices.toml) | OnePlus 6 | ? | NOASSERTION | no evidence read |
| **WeiXiaoye/perseus-xnu** (S pushed 2026-11-09) | Xiaomi MIX 3 perseus, SDM845 | iOS 16.5 (20F66) / xnu-8796.121.2, HakiOS-based, edk2-sdm845 UEFI -> xnuloader | patches APSL-2.0, scripts MIT (R) | 8 cores, GICv3, APFS root + cryptex from UFS, UEFI framebuffer CPU rasterisation; **A630: Mesa freedreno + CoreAnimation reaches screen, CPU copies frames (tearing, ~35 ms pixel reorder)**; **touch driven by UEFI, kernel reads a shared page**; no USB/Wi-Fi/audio; charging unverified |
| JaneAwA/iOS16_on_mix2s, JaneAwA/polaris-ios14, luuu20309/UniXNU-polaris, quyunze0215/ios-sweet-polaris, SPRMD / lxsc-zk / PuszekReksio polaris repos | Mi MIX 2S polaris, SDM845 | iOS 16 (MIT, S) and a xnu-7195 (iOS 14) experiment | MIT / NOASSERTION | luuu20309 (V devices.toml): platform stage verified on hardware, no root; JaneAwA (S): Mu-Silicium + custom arm64 boot shim; no further evidence |
| hanyaa380/dipper-unixnu-bringup, e-xq/HackiOS-DiPPER-Audio | Mi 8 dipper, SDM845 | ? | MIT / NOASSERTION | V devices.toml (dipper): UEFI+menu+payload, XNU reaches BSD init, no root. **A repo named "HackiOS-DiPPER-Audio" (S 2026-11-10) suggests audio work on SDM845: not read** |
| **LakoMoor/ios-beryllium** (S pushed 2026-10-31) | **Poco F1** | iOS 16 | MIT | "port of ios-apollo", no status read (open item) |
| (ours) Bergamota / Bergamota-farita | Poco F1 / OnePlus 6T | 18.7.8 / xnu-11215.81.4 | per repo | see README |

### 1c. Other SoCs (R/S; most useful for subsystems that SDM845 shares)

| Project | Device / SoC | iOS / xnu | Licence | Claimed state (R) |
|---|---|---|---|---|
| **joranv1/ios-sailfish** | Pixel (2016) SD821, A530 | 16.7.16 / xnu-8796 | not stated | A530 UI via Mesa freedreno + own kernel GPU driver (GLES, UI 20-40 fps, no Metal), **Wi-Fi QCA6174 WPA2-PSK**, battery gauge + 1.5 A charging (PMI8994) |
| **NWylynko/ios-flame** | Pixel 4 flame SD855, A640 | 16.7.16 / xnu-8796 | not stated (CREDITS.md) | **Metal on Mesa Turnip via metal2vulkan, UI on GPU, swipes 20-26 fps**, **Wi-Fi WCN3990 via userland `wland`**, USB SSH (dropbear), file server, live log; no audio/BT/cellular (docs: NOTES.md, HANDOFF.md, METAL-NEXT.md) |
| **nonrootus/ios-sweet_k6a** | Redmi Note 12 Pro 4G, SM7150 A618 | 16.7.16 / xnu-8796.141.3, patches 0001-0225 | MIT + APSL patches | UI on GPU via freedreno, median frame 4-8 ms; **rootful jailbreak (Procursus, Sileo, OpenSSH, ElleKit)**; USB RNDIS + console, internet unstable; no Wi-Fi/BT/audio/modem |
| **limonetexd/ios-sweet-gpu** | sweet SM7150 A618 | 16.7.16 | MIT | branch `gpu`: Metal driver, lock/home/Control Centre composited by GPU, self-test 15 of 19; `METAL_FINDINGS.md` |
| **marnov999/ios26-sweet** | Mi 9T davinci SM7150 | **iOS 26 / xnu-12377, arm64e userland lowered to arm64 offline** | not stated | preparation only ("nothing built or booted"); measures ~29.3 M instructions to lower in the iPhone 11 cache; follows UniXNU-zeta PAC approach |
| **Aruvelut-123/UniXNU-raphael** | K20 Pro SM8150 | iOS 18.7.12 (22H390), xnu 11417.140.69, **arm64 kernelcache of iPad7,11 (A10, no PAC)** | BSD-2-Clause-Patent | boot image in progress, firmware blocked on UEFI |
| **Chengdong-Yu/UniXNU-pong** | Nothing Phone (2) SM8475 | iOS 18.6.2 arm64e, native 4K pages + PAC | not shown (NOASSERTION S) | native boot, writable UFS Data, **USB 480 Mbps normal, Wi-Fi QCA6490/ath11k working**, A730 stack integrated (README in Chinese) |
| Kaydn913/hackios-pixel7pro, iola1999/hackios-redmi-k90-annibale, jabarin123/warsaw-xnu-kernel-RedmiK90Ultra (xnu 12377), skglab-dev/ios-taoyao, Camgobeg/iospro-r8q, ... | Pixel 7 Pro (Tensor G2, Mali-G710), K90 SM8750, ... | HakiOS-derived | mixed | existence only (S) |
| squeeeezy/HelioDarwin | Infinix Note 12 MT6789 | 16 (topaz-based) | NOASSERTION | existence only (S); hackiosx lists POCO M8 5G (SD 6 Gen 3, SpringBoard + USB net, GPU in progress, mkukarin01 `kunzite`) and Galaxy S7 Exynos 8890 (wardevsa, setup screen + touch, CPU rendering) |
| MCI49312/ios-z3s-opus | Galaxy S20 Ultra Exynos 990 | 16 | none | existence only (S) |
| dex-community/ios-sweet-lg-g4 | LG G4 MSM8992 (LK) | 16 | MIT | existence only |
| arabaci0711-ux/ios-vince (cited in LMasterPiec3 docs) | Redmi 5 Plus vince | 16 | ? | V (secondhand): source ends at patch 0091, no BT |
| ch1tmdgus/ios-v60 | LG V60 SM8250 | ? | ? | hackiosx R: iOS UI, touch + buttons; BT UART bring-up diagnostics (from FORKS_SURVEY) |
| **urielc918/ios-switch** | Switch Tegra X1 | 16 | MIT | see 1a |
| **Snapintosh/Snapintosh** (+ SnapAdreno MIT, SnapQCC2072 MIT, SnapI2CHID MIT; S pushed 2026-10-25, 1255 stars) | ASUS A16 / Snapdragon X2 Elite (laptop), **macOS 27 stock kernel under an EL2 hypervisor** | macOS 27 | NOASSERTION, some GPL-2.0 files (per Chlorophyll TURNIP.md, V) | Adreno X2-90 IOGPU+display kext; different approach (hypervisor, stock kernel) |
| CrossDarwin/macOS-ForSheng, alghiffaryfa19/macOS-ForSheng, mataht/sheng-macos-link-lab | sheng macOS 26.5/27 | macOS | GPL-3.0 / MIT | existence only (S) |
| Droid-VM/macOS-DroidVM, UniXNU-droidvm | crosvm + Gunyah guest on Android phones | iPadOS 17.7.11 / macOS 27 | ? | V (UniXNU README, devices.toml): a virtualisation route, not bare metal |
| MovByte/AirWgsl, MovByte/WebMetal | Metal via WGSL/WebGPU for UniXNU | | | existence only (S) |

Not found: any press coverage (9to5mac, Android Authority, Pocket-lint) and any Telegram/X/YouTube evidence (see section 5).

## 2. Per-subsystem best known implementation (DRAFT)

(To be written.)

## 3. Ranked list of 15 techniques/features for the OnePlus 6T (DRAFT)

(To be written.)

## 4. Corrections to docs/FORKS_SURVEY.md (DRAFT)

(To be written.)

## 5. Open items / repos to clone

(To be written.)
