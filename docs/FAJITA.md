# Bergamota on the OnePlus 6T (`fajita`)

The OnePlus 6T is a Snapdragon 845 phone, the same SoC as the Poco F1 (`beryllium`). The port is a
**board delta** on top of the beryllium work: same kernel paths, same iOS 18 root, a fajita boot image.
Everything here was verified on a real 6T on 2026-11-04 unless marked otherwise.

| Part | State on fajita |
|---|---|
| Enxerto (bootloader) | ✅ boots from `fastboot boot`, Bergamota logo, own fastboot (`getvar product` = `fajita`) |
| Heartwood (kernel) | ✅ boots iOS 18.7.8 to SpringBoard, 8 cores, UFS, display 1080×2340 |
| USB networking | ✅ CDC-ECM, `192.168.7.2`, kernel log on UDP 5140, SSH (dropbear) |
| Touch (Synaptics S3706, RMI4) | 🟡 controller powered and answering; coordinates: fix in patch 0252 (not yet confirmed) |
| Buttons | ✅ |
| Battery level / charging | 🟡 charger read-only (observes SDP 500 mA); state-of-charge not yet confirmed |
| Wi-Fi, Bluetooth, audio, camera, modem | ❌ (as on beryllium) |

## What differs from beryllium

| | beryllium (Poco F1) | fajita (OnePlus 6T) | Where |
|---|---|---|---|
| Panel | 1080×2246 | 1080×2340 | `enxerto/board.h`, `tools/mkadt.py` |
| `fastboot getvar product` (ABL) | `beryllium` | **`sdm845`** (OnePlus reports the SoC) | `apps/web/src/lib/flasher.ts` |
| Bergamota fastboot product | `beryllium` | `fajita` (`-DFB_PRODUCT`) | `enxerto/build.sh` |
| Touch | Novatek/Focaltech | **Synaptics S3706, RMI4**, i2c12 (SE12) @0x20, VDD = PM8998 **ldoa28**, VIO gpio88, reset gpio99, ATTN gpio125 | patches 0252, 0253 |
| Crash handling | a reset reboots | **OnePlus ABL arms Qualcomm CrashDump**: any reset lands there (Power + Vol up ~15 s to leave) | — |
| Board-specific DT | in the boot.img DTB | the boot.img DTB is **SoC-only**; board nodes (touch…) are in the **DTBO** | — |

**The one rule that matters:** the kernel selects every SDM845 path with `sweet_board_beryllium()`, i.e. the
ADT `compatible` string `xiaomi,beryllium` (40 call sites in 25 patches). The fajita ADT therefore lists
`oneplus,fajita, xiaomi,beryllium, xiaomi,sweet, qcom,sdm845`. Without `xiaomi,beryllium` the kernel ran the
SM7150 (sweet) paths and the phone fell into CrashDump ~5 s after the kernel took the display (first boot).
Fajita-only code tests `sweet_board_fajita()` **before** `sweet_board_beryllium()`.

## Build the boot image (Linux, no Mac)

1. **DTB.** Take the stock `boot.img` of your 6T, extract the appended DTBs and keep the SDM845 v2.1 one
   (`msm-id 0x141/0x20001`) as `dtb/fajita/dtb` (gitignored: a device dump). The 6T's `boot.img` carries 3 SoC
   FDTs (v2.1/v2/v1); fdt0 = v2.1, 371 561 bytes.
2. **Enxerto alone** (safe first test, no kernel):
   ```sh
   BOARD=fajita bash enxerto/build.sh          # -> enxerto/out/enxerto-boot.img (~0.5 MiB)
   ```
   Debian's `mkbootimg` imports a `gki` module it does not use for header v1: put a stub
   `gki/generate_gki_certificate.py` on `PYTHONPATH`.
3. **Kernel.** `gh workflow run xnu.yml -R <you>/<fork> --ref fajita`, then
   `gh run download <id> -n xnu-kernel -D xnu/out-fajita`.
4. **D22AP device tree seed** (iOS 18 boots with the iPhone X identity): only the 33 KB member is fetched from
   Apple's iPhone X IPSW, never the whole file; `adt.load` needs `lzfse`:
   ```sh
   python3 tools/remotezip.py <iPhone10,3 IPSW URL> =Firmware/all_flash/DeviceTree.d22ap.im4p /tmp/d22
   python3 -c "import sys; sys.path.insert(0,'tools'); import adt; \
     open('research/ipsw-x/d22ap.adt','wb').write(adt.load('/tmp/d22/Firmware/all_flash/DeviceTree.d22ap.im4p'))"
   ```
   `research/` is gitignored: this is an Apple artifact.
5. **ADT + boot image:**
   ```sh
   python3 tools/mkadt.py enxerto/out/fajita-hi-3x.adt --board fajita --highmem --display-scale 3 --identity d22ap
   RENEGADE_TARGET=ios18 APPLE_LOGO=0 BOARD=fajita tools/renegade/mkboot-full.sh \
     xnu/out-fajita/kernel.development.sweet enxerto/out/fajita-hi-3x.adt research/ios18/enxerto-boot-ios18-fajita.img
   ```
   The ADT must be ~13.4 KB with no "no /product node" warning. Add `-v` to `CMDLINE` for an on-screen kernel log.

## Put iOS on the phone (the web flasher)

Site: <https://ferdza.github.io/Bergamota-farita/> (Chrome/Edge, desktop). The root is board-independent.

1. **Patch IPSW + flash**: drop `iPhone11,8_18.7.8_22H352_Restore.ipsw` (exact link on the IPSW step), paste the
   **contents of `~/.ssh/id_ed25519.pub`** (check it is your current key: the field remembers the last one),
   patch. On GitHub Pages the patch pauses once and asks you to open Apple's key link(s) and drop the key file.
   Needs ~17 GB in the browser's storage (if Chrome misjudges it, "Patch anyway").
2. **Advanced → Restart when done = no**, flash `userdata` (erases Android's data; nothing else is written).
3. **Flash an image → Enxerto (boot) → the fajita boot image → Boot once (test)**: nothing is written; a restart
   returns to Android's boot. First iOS boot takes minutes.

## Talk to the phone from Linux

The phone appears as `1209:0001` "Sweet iOS (USB Ethernet)"; the host side MAC is `02:00:5e:77:ee:01`.

- **SSH / ping (the OS owns the interface):**
  ```sh
  nmcli con add type ethernet ifname <iface> con-name berga ipv4.method manual ipv4.addresses 192.168.7.1/24 ipv6.method disabled
  nmcli con up berga && ssh root@192.168.7.2
  ```
- **Live kernel log in the browser** (`/log/`): once, a udev rule for `1209:0001`
  (`MODE="0660", TAG+="uaccess"`); each boot, unbind `cdc_ether` from the interface, then Connect. The page shows
  both commands. While the page holds the interface the OS cannot ping/ssh: it is one or the other.
- **Live log without the browser:** listen on UDP 5140 (`python3 -c "import socket;…bind(('',5140))…"`).

## Known issues (from the first boots' logs)

- ~29 extension/plugin processes (widgets, Intents, speech AUSPs) abort at one shared site (unslid pc
  `0x1d3a641dc`, lr `0x20d0b3c1c`): one cause, to symbolicate against the shared cache.
- `bluetoothd` crash-loops (`reason=1201`): Bluetooth is not ported.
- Clock starts in 1970 until network time sets the PM8998 RTC offset once (patch 0245).
- iOS reports the beryllium battery design capacity (not the 6T's 3700 mAh); cosmetic.
- Keep `sweetcharger` at its read-only default on fajita; `sweetwlan` stays 0 (off).
