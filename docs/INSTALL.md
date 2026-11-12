# Install Bergamota-farita (iOS 18 on the Poco F1 and the OnePlus 6T): one protocol, GPU 3D on by default

The same three steps for `beryllium` (Poco F1) and `fajita` (OnePlus 6T). Nothing has to be enabled afterwards: the root the
page builds already contains the GPU userland (Chlorophyll) wired into backboardd, and the boot image carries the GPU boot-args.

| Part | Where it comes from | GPU default |
|---|---|---|
| **Root** (userdata) | the web installer: *Patch IPSW + flash* (Renegade in the browser) | `berga-tools.zip` carries Chlorophyll (`bgmtl/*`); Renegade copies it to `/usr/local/lib/bgmtl` and links the inject into `backboardd` (weak, original kept as `backboardd.orig`), armed in direct mode |
| **Boot image** | `tools/install/build-boot.sh <board>` (Linux or macOS) | `sweetgpu=8` + governor + the direct scan-out framebuffer, from `tools/renegade/gpu-default-args.txt` |
| **Phone** | the Bergamota fastboot page: *Boot once* (nothing is written to `boot`) | nothing to switch on |

## 1. Root (web installer)

<https://ferdza.github.io/Bergamota-farita/flash/> (Chrome/Edge on a desktop). Drop `iPhone11,8_18.7.8_22H352_Restore.ipsw`, paste
your SSH public key, patch, then flash `userdata` (erases Android's data, nothing else is written; keep your backups). The patch log
must show a `chlorophyll:` line (`libraries in /usr/local/lib/bgmtl; backboardd links ... armed in direct mode`). If it says
`not in the tools bundle`, the site was published before the `chlorophyll-ios18` release existed: run the *chlorophyll* workflow, then
re-run *web (GitHub Pages)*, and patch again. The root still works, on the CPU renderer.

## 2. Boot image

```bash
D22AP_IPSW_URL=<iPhone10,3 IPSW URL> tools/install/build-boot.sh fajita      # or: beryllium
```

It needs, once: `dtb/<board>/dtb` (your phone's stock DTB), the GPU firmware in `research/gpu-fw/` (`tools/gpu-fw-pull.sh`, read-only from
your own Android partitions) and a green *xnu* CI run (downloaded with `gh`, or `KERNEL=file`). The OEM zap firmware is inside the ADT:
never publish the image. `GPU=0` builds a CPU-renderer image without firmware.

## 3. Boot

Bergamota fastboot page: *Flash an image -> Enxerto (boot) -> your image -> Boot once*. The first iOS boot takes minutes.

## Safety net (all of it is already in the install)

- The load command in backboardd is **weak**: if the inject is missing or hidden, dyld starts backboardd without it.
- At each start the inject checks `/private/var/tmp/bgmtl-bb.off` (kill switch, also written by its own dead-man after bad launches),
  that the kernel's GPU is up (`sweetgpu=8`) and that it can make the Metal device. Otherwise backboardd runs stock (CPU).
- Recovery without SSH: boot with `sweetdenypath=/usr/local/lib/bgmtl/bgmtl-inject.dylib`. With SSH: the page's *GPU off* /
  *Restore backboardd*.
- Never hard-reset iOS (long Power, Power + Vol down): the root is an unjournaled HFS+ (`docs/FAJITA.md`, known issues).

## Developer notes

- Chlorophyll is built by `.github/workflows/chlorophyll.yml` (macOS runner) and published as the `chlorophyll-ios18` release of this
  repository; `.github/workflows/pages.yml` merges it into `berga-tools.zip` with `tools/berga-tools/add-chlorophyll.py` (hashes added to
  `berga-tools.json`) before building the site. Renegade (`tools/renegade-rs/src/tools.rs`, `chlorophyll()`, tests in `tests/chlorophyll.rs`)
  does nothing, and says so in its log, when the three files are not in the bundle.
- The Python builder (`tools/renegade/root_tweaks18.py`) still wires only Mercury's poster (`bgmtl`); the browser path is the supported one.
- GPL v2 is accepted for new userland pieces (2026-11-12 decision); keep GPL code out of the XNU kernel patches (APSL 2.0 is not GPL
  compatible for a distributed kernel binary).
