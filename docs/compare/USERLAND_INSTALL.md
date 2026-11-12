# Userland, root builder and installer: comparison with the sibling ports (2026-11-12)

Read-only study. No code was run, nothing was changed except this file. Tags: **VERIFIED** = read in a file (cited as
repo:file:line, repos under the scratchpad `refs/`); **INFERRED** = follows from what was read; **RECALLED** = from memory or
from our own earlier notes, not re-read now. Benefit: P1 = likely fixes a current blocker or a boot/data risk, P2 = clear gain,
P3 = nice to have. Only ideas are proposed; see "Licences" before copying anything.

Our side (all VERIFIED unless noted): `tools/renegade-rs/src/tweaks.rs` (launchd 181, quiet 246, idle 391, stage_prefs 694,
bluetooth_env 736, iosroot_dirs 752, run 797), `rootbuild.rs` (journal 8 MiB default, 53-54), `data/firstboot.sh`,
`apps/web/src/livelog/sshsession.svelte.ts` (installIpa ~360, quietCrashLoops ~443), `tools/mkadt.py:333-354`,
`docs/CPU_IDLE.md`, `docs/BOOT_AND_ERRORS_2026-11.md:16-21`, `gpu/chlorophyll-patches/`.
Earlier audits already cover generic flasher/installer problems (`docs/audit/AUDIT_USERLAND_INSTALL.md`); this file adds only what the
sibling ports show.

## 1. Key open items first

### 1.1 MobileSafari abort (sig 6, ns 2 code 6)
* VERIFIED: ns 2 is `OS_REASON_SIGNAL` and ns 7/8/18 are LIBXPC/OBJC/LIBSYSTEM (apple_xnu-11215/bsd/sys/reason.h:111-132). So
  "ns 2 code 6" is a plain `abort()`/SIGABRT with no exit-reason payload. Our patch 0044 only prints text for
  `abort_with_payload` (`dipa-studio_ios-sweet/xnu/patches/0044-sweet-crash-log-reason.patch:7-11`). That is why there is no reason string.
  The message went to os_log or stderr, which is lost.
* **No sibling reports or fixes this abort.** Searched all refs for MobileSafari, WebContent, `dynamic-codesigning`, `allow-jit`,
  JavaScriptCore, JSC_, gigacage, jetsam in docs/notes: no hit for any of the JIT terms (VERIFIED, grep). None of them runs iOS 18
  Safari on a PAC-stripped root. Everything below is from iOS 16 ports, so it narrows causes only.
* What siblings found for Safari (all iOS 16, VERIFIED):
  - Blank pages or white bodies from 10-bit WebKit surfaces ('w30r', 'b3a8'): topaz fixed it with ADT `artwork-display-gamut = sRGB`
    (we have this, `tools/mkadt.py:352`); beryllium also overrides `display-gamut` (`LakoMoor_ios-beryllium/tools/mkadt.py:295`);
    flame remaps 10-bit surfaces to BGRA only for `com.apple.WebKit.WebContent` in the kernel (`NWylynko_ios-flame/xnu/patches/0124-flame-surf10-webcontent-only-link-bss.patch:68-73`,
    `HANDOFF.md:33`). Not an abort, but it is the same family: WebContent is the first client of surface formats nobody else uses.
  - Safari needed `SweetKeyStore` selectors 10/11 (key wrap/unwrap) answered, and wifid's power state agreeing with the kernel
    (`LakoMoor_ios-beryllium/NOTES.md:420,427,436`; patches 0134/0135). Guess in their notes, not proven.
  - flame: WebKit GPU-process prefs `WebKit2GPUProcessForDOMRendering=NO` (`NWylynko_ios-flame/HANDOFF.md:87,576-581`). Ours: no effect on blank pages
    (NOTES.md:720).
  - Safari's helpers (SafariSupport.bundle, webbookmarksd, safarifetcherd...) live only in the App cryptex and dyld does not look there at
    `ignition_level=1`; ios-sweet hard-links 19 cryptex files into the root (`LMasterPiec3_ios-sweet/NOTES.md:5488`). Our builder merges the
    cryptexes into one tree (tree.rs:143-161, rootbuild.rs:165) - INFERRED that this covers it; verify that
    `/usr/lib/libobjc-trampolines.dylib` and `libffi-trampolines` exist in a built root.
* Suggested change (P1): get the text before guessing. ios-sweet's `sweetdtlog=NAME,...` (0205) injects `OS_ACTIVITY_DT_MODE=YES` and
  `CFLOG_FORCE_STDERR=YES` into the environment of the named executables at exec, and routes their stderr through the existing /dev/null
  tee (`LMasterPiec3_ios-sweet/xnu/patches/0205-sweet-dtlog-daemon-oslog.patch:20-40`). We have 0048 (the tee) but not 0205 (VERIFIED: `ls xnu/patches-11215`). Re-implement
  (idea only, no licence file) and boot with `sweetdtlog=MobileSafari,com.apple.WebKit.WebContent`. Candidate causes to check once the
  text exists (INFERRED, not tested anywhere): JSC refusing to start without the JIT entitlement or with a failed
  `mprotect`/`vm_remap` for the JIT region (our IOS18_FEASIBILITY.md:89 plans `JSC_useJIT=0`, untested); a missing XPC service in the
  WebKit framework path; a jetsam memory limit read from JetsamProperties.
* Also cheap and independent: the web page's "Diagnostics" export should include `*.ips` from `/var/mobile/Library/Logs/CrashReporter`
  (BOOT_AND_ERRORS_2026-11.md:20 asks for it). No sibling does better: all use serial/console tees (VERIFIED: `*/tools/sweet-log-pull.sh`).

### 1.2 Settings icons/text missing, backboardd restarts, GPU allocation failures
* VERIFIED: Chlorophyll's own FIXES.md has this exact failure: "the kernel allows 4096 GEM handles per client and silently refuses
  the next; BO cache kept 15 s; fd_bo_new returned NULL" (`ry-diffusion_Chlorophyll/docs/FIXES.md:86-93`). Their fix is
  `patches/fd-bo-new-purge-retry.patch` (empty both BO caches, retry once) plus fence-wait retry and backtrace logging.
  It patches `src/freedreno/drm/freedreno_bo.c` (Gallium path). Our pin d3cb665 is the Turnip/Vulkan runtime (`gpu/chlorophyll-patches/README.md:11-22`), whose
  allocations go through `air/chl_vk.c:863,1090` ("would not allocate or map"), not `fd_bo_new`. INFERRED: that retry does not cover the failing
  call. Check whether `turnip-ios.patch` or `chl_vk.c` already closes idle handles on a refused `GEM_NEW` (`chl_vk.c:1114-1124` already has
  `sweet_drm_gem_close`).
  Suggested change (P1): in the Turnip path, on a failed GEM_NEW free idle cached BOs and retry once, and make the buffer failure skip the
  draw instead of failing the command buffer (their "black wallpaper" fix, `FIXES.md:105-109`). Our kernel side (0275: 16384 handles) only delays it.
* VERIFIED: edi194 found the same handle/BO lifetime class in a different driver: BOs wrapped around carve-out RAM were returned to the VM while
  the GPU still used them (`NOTES-FAJITA.md:5657-5692`); our own audit already concluded our `releaseGem` leaks on purpose, which is safe
  but is exactly what fills the handle table (`docs/audit/OTHER_6T_PORT_LESSONS.md` section 1). Cap or recycle instead of leak (P2).
* VERIFIED: beryllium's backboardd SIGSEGV was a texture upload that read past a read-only CA image (VM tag 51); the bridge now
  validates the readable range with `vm_region_recurse_64` and pads (`LakoMoor_ios-beryllium/NOTES.md:348-350`, `userland/ca-bridge/eagl.c pixels_guarded`).
  Applies to our restarts only if the SIGSEGV pc is in a texture copy; compare crash pc/VM tag first (P3, MIT).

### 1.3 bluetoothd crash loop
* VERIFIED: three siblings disable it through launchd's override list, as we do: beryllium `tools/sweet-root-tweaks.py:244-255`
  (`fairplayd.H2`, `bluetoothd`), sailfish removes fairplayd and the diagnostics jobs (`joranv1_ios-sailfish/tools/sweet-root-tweaks.py:81-99`).
  Beryllium gives the reason that matters (`:34-43`): a request queued on a respawning daemon is never answered and **deadlocked LaunchServices'
  app scan** (boots 47-48), so Settings extensions and widgets were missing until both were off. Ours disables bluetoothd only when the BlueTool
  stub is absent (`tweaks.rs:291-318`, `keep_bluetooth`); NOTES.md:182 still records the loop x12 with the stub path.
* Suggested change (P1): disable bluetoothd by default whenever there is no verified HCI transport, whatever the stub; make the stub opt-in
  (`bluetooth=1`). Beryllium's alternative is a real transport: `libsweet-bt.dylib` injected into bluetoothd and BlueTool by boot-arg
  `sweetinject` (`LakoMoor_ios-beryllium/userland/README.md:12`, MIT). Ours ships `BT_HCI_TRANSPORT` env instead (tweaks.rs:716-735).

## 2. Comparison table

| Our item (file) | Sibling item (repo:file:line) | Difference | Benefit | Suggested change |
|---|---|---|---|---|
| App extensions: no flag set (tweaks.rs run 797, none) | beryllium `tools/sweet-root-tweaks.py:34-38,244-249`; sailfish `tools/sweet-root-tweaks.py:25-34,138-145` | Both write `private/var/preferences/FeatureFlags/Domain/ExtensionKit.plist` = `enforce_xpc_cache_code_signing: Enabled=false`: extension point catalogs are checked through a detached signature against trust caches we lack, so every appex (wallpapers, widgets, Safari extensions) is refused. VERIFIED (iOS 16). We have no such flag (grep of tools/ and docs/: no hit). Our docs/EXTENSION_CACHE.md builds a catalog cache instead. | P1 | Add `extensions()` to tweaks.rs (+ python mirror); one plist, 2 minutes. Verify on iOS 18 that the flag name still exists (INFERRED: it is an ExtensionKit feature flag; name may differ). Fits the "Settings icons/text" and "Mercury/PosterBoard" symptoms. |
| `quiet()` throttles, `idle()` disables 6 jobs (tweaks.rs:246-405) | sailfish `tools/sweet-root-tweaks.py:84-87` | Sailfish removes ReportCrash, spindump, tailspind, aggregated(.addaily), voicemail vmd, fairplayd.H2 from launchd.plist ("ReportCrash alone ~60% of a core"). We only `killall ReportCrash` once from the web page (sshsession.svelte.ts:466) and list it as "no safe off switch" (CPU_IDLE.md). VERIFIED. | P2 | Park `ReportCrash` behind a flag (`--no-crashreporter`, off by default) or set its ThrottleInterval to 300. Keep CRASH lines from the kernel (0043/0044) as the record. Debug builds need ReportCrash for .ips, so tie it to the web "Quiet" button, not the default. |
| Migration: `LastSystemVersion` + `DMUserDataDisposition` only (tweaks.rs:694-700) | beryllium `:84-122,25-31` (also writes the ByHost file named by IOPlatformUUID); sailfish `:25,170-173` (does the opposite: leaves migration to run once with `/private/var/datamigrator/migrate`, because skipping it left LaunchServices 1 of 524 appex) | Two siblings with opposite findings, both iOS 16. Beryllium: without the ByHost file DataMigration ran every boot and held SpringBoard at the logo. Sailfish: skipping loses appex registration. VERIFIED. Ours has no ByHost file and no sentinel. | P2 | Check on the phone: does DataMigration run on every boot of our root (`datamigrator` in the log)? If yes add beryllium's ByHost write (UUID = SHA-1 of ECID+chip-id as XNU makes it; their function is only a formula, rewrite). If appex are missing see the ExtensionKit row first. |
| Stock apps: `staged_apps()` moves removable apps (tweaks.rs:826) | beryllium `:185-202` | Same idea, same behaviour (VERIFIED). Ours also writes the register-apps list and registers at first boot through `sweetuicache` (firstboot.sh:24-43). Beryllium relies on LaunchServices scanning /Applications by itself. | none | Nothing; our path is the more explicit one. |
| CoreAnimation prefs: not set | beryllium doc `tools/sweet-root-tweaks.py:45-50` (`CAEnableDeepFramebuffer`, `CAEnableFramebufferCompression`, `CAEnableIOSurfaceCompression` off in global prefs of mobile and root) | With a GPU renderer CA draws in 'b3a8' (10-bit + opacity planes); they found it with flame. We now also run a GPU renderer (Chlorophyll in backboardd). No grep hit in our tools (VERIFIED). | P2 | Add the three keys to `stage_prefs()` when Chlorophyll is in the bundle; boot-test on the 6T. Could explain "Metal failed to build render pipeline" or the blur/glass colour problems (INFERRED). |
| ADT: only `artwork-display-gamut` -> sRGB (mkadt.py:352) | beryllium `tools/mkadt.py:290-297` (also `display-gamut`) | MobileGestalt reads both on first boot (beryllium comment). Ours leaves `display-gamut`. VERIFIED. | P2 | Add `display-gamut` to the override list; one word. Relevant to Safari/WebKit surface formats (1.1). |
| Console log has no daemon os_log (0048 only for backboardd/SpringBoard) | ios-sweet `xnu/patches/0205...:20-40`; beryllium `tools/sweet-root-tweaks.py:59-63,141-171` (`--oslog` flag: OS_ACTIVITY_DT_MODE in launchd.plist for backboardd, SpringBoard, datamigrator) | Two methods: per-boot-arg exec env (kernel) or a plist flag (root). Ours has the plist trick only for the console job (tools.rs:609). | P1 | See 1.1. A `--oslog` flag in renegade-rs is the cheap half (no kernel change); the boot-arg is the flexible half. |
| First boot: launchd job runs `renegade-firstboot.sh` (appreg, wallpaper, jb post-install, 3 tries) | ios-sweet family: none (no first-boot script; stock apps and migration only, `*/tools/sweet-root-tweaks.py:125-153`); UniXNU: setup skipped at build time (`UniXNU_UniXNU/docs/guide/skip-setup.md`, RECALLED from the audit) | Ours is the only one that sets wallpaper and icon style at first boot through PosterBoard. Ours retries up to 120 x 5 s (firstboot.sh:35-41) and then marks done after 3 runs even on partial failure (firstboot.sh:121). | P3 | Keep. Consider recording the result in a file the web page reads (it already does for wallpaper). |
| Jetsam: nothing set (grep `HighWaterMark`, `memory limit` in tools/: no hit) | flame `HANDOFF.md:52-55` (a daemon lifts its own limit with `memorystatus_control SET_MEMLIMIT_PROPERTIES`; `JetsamProperties` in the launchd cache did not help); beryllium `NOTES.md:541` (launchd's default per-job limit of 6 MB killed their test tool); beryllium `NOTES.md:441` (driverkitd, pkreporter killed ns 1 code 7) | Their own helpers hit launchd's default memory limits; Apple daemons are not affected. We run bgl*/sweet* helpers and Chlorophyll in backboardd under the stock limits. INFERRED: backboardd on Chlorophyll plus texture pools could hit a limit. | P2 | When a helper dies with ns 1 (JETSAM) read the code: 7 = per-process limit. Give our own launchd jobs explicit `HighWaterMark`/`JetsamMemoryLimit` keys (renegade-rs add_job, tweaks.rs:537) and list the jetsam kills in the diag export. |
| Keybag: stub `systembag.kb` + `no-effaceable-storage` in ADT (tweaks.rs:752-770, mkadt.py:333-335) | beryllium `tools/mkiosroot.sh:17,127-131`, `tools/mkadt.py:274`; sailfish `tools/mkiosroot-mac.sh:82-87` | Same design. Keychain: beryllium made the in-kernel key store answer wrap/unwrap 10/11 like HackiOS's MiniAppleKeyStore, because Safari's keychain use failed (`NOTES.md:436`). VERIFIED. | P2 | Our kernel side: check `SweetKeyStore` selectors 10/11 in the 11215 patches (`grep SWEET AKS` in a boot log). Nothing to change in the builder. |
| Root journal: 8 MiB reserved by default (rootbuild.rs:53-54) | dipa/switch/beryllium/edi194 `tools/mkiosroot.sh:13-14` (journaled by `newfs_hfs -J`; "XNU replays the journal after a panic; Linux only mounts it with `-o force` and leaves it empty"); beryllium `mkiosroot.sh:138`, edi194 `:130` (a fresh journaled volume reads "needs minor repair" to Linux fsck -n) | Same goal. They rely on Apple's newfs and a Linux mount; we write the journal ourselves. BOOT_AND_ERRORS_2026-11.md:21 still says "default off" (stale; INSTALL.md:23 says on). VERIFIED. | P2 | Do not "fix" the fsck message; document it. Do not mount a journaled root with Linux read-write and leave a non-empty journal (replay on Linux hfsplus ignores it). Update the stale row. |
| Daemon replacement: `add_job` into launchd.plist (tweaks.rs:537) | edi194 `tools/hijack-daemon.sh:1-12` (stock launchd ignored /Library/LaunchDaemons and `org.sweet.*` for four boots; they rewrite ProgramArguments of a stock RunAtLoad job, e.g. DumpPanic) | A fallback if a job we add is not started. VERIFIED. | P3 | Note in INSTALL.md troubleshooting; keep our plist merge. |
| Update path: re-patch + reflash userdata | ios-sweet `tools/sweet-install-ssh.sh:1-25` (files pushed into the running root by the kernel file server, xnu 0168, boot-arg `sweetfiles=1`, TCP over USB, no reflash); flame `phone/` tools (RECALLED) | They push single files into a live root over USB. We have SSH over usbnet, which does the same once up, but nothing before SSH works and no kernel file server. VERIFIED. | P3 | A "push file" action on the web page over our SSH already works; the kernel file server is only needed if SSH is not up (idea, 0168 has no licence file). |
| SSH: dropbear, key-only, host keys on first connection (audit F-11) | ios-sweet `tools/sweet-install-ssh.sh:14-25` (`/private/etc/dropbear` 700, key generated on host in git-ignored dir); johnpanos `NOTES-ssh.md:1-60` (plans CDC-ECM over DWC3; no usbmuxd); hackios: none by default (RECALLED) | Nothing new for us; the design is the same except we generate nothing at build time. | P3 | Generate host keys at build time and show the fingerprint (audit F-11). |
| IPA install: re-sign in WASM, `rm -rf` + `tar` as root, `sweetuicache` (sshsession.svelte.ts:358-377) | UniXNU `scripts/appsync/README.md:1-25` (AppSync-style: hook MobileInstallation validation, FrontBoard launch trust and LSApplicationWorkspace so unsigned IPAs install with the stock installer, `unixnu-appinst` on device) | Their installer goes through installd and keeps a proper app record, survives reboot, and needs no per-app re-sign. It is GPL-3.0-or-later (adapted from AppSync Unified) and for iPadOS 27. We write files and register by hand. | P3 | Idea only (licence). Prefer our staging + deny-list fix (audit F-04) before any installd route. |
| Cryptex files: one merged tree | ios-sweet `NOTES.md:5488` and `tools/mkiosroot.sh` (19 cryptex-only files hard-linked into the root, symlinks copied: Linux hfsplus cannot hard-link symlinks); beryllium `tools/mkiosroot.sh:10-17` (same plus the dyld cache linked at `System/Library/Caches/com.apple.dyld`) | Same result by different means. | none | Confirm in a built root that the SystemOS dyld cache path ios-sweet/beryllium use is present (our dsc.rs writes the cache). |
| Chlorophyll inject into backboardd (tools.rs `chlorophyll()`) | beryllium `userland/README.md:12` (`sweetinject=LIB:prog` kernel boot-arg, no root edit; xnu 0114 allows groups) ; edi194 `tools/mk-bgmtl-bundle.sh` (RECALLED, name only) | We edit backboardd's load commands (weak link, `backboardd.orig`, /usr/local/bgi.dylib symlink when the header is full). Beryllium injects at exec from the kernel: no binary edit, trivial to turn off per boot. | P2 | We have `sweetinject` in the kernel? (grep `sweetinject` xnu/patches-11215: not checked). If yes, use it as the safe fallback when backboardd fails to start (a `bgmtl-bb.off` file exists already). |
| Safe-mode / crash cap | beryllium `tools/sweet-root-tweaks.py:12-14`, same in all ios-sweet family (`_PanicOnCrash` -> `_PanicOnCrasX`) | Same. Ours is tweaks.rs:181-190. | none | Nothing. |
| Resize/migration of the HFS volume | ios-sweet `NOTES.md:707-710` (kernel HFS+ has `HFSIOC_RESIZE_VOLUME`: resize the 16 GiB volume to the whole userdata afterwards, full backup first) | We size the volume at build time (used + 6 GiB, min 24 GiB, audit F-09). | P3 | Mention resize as the alternative to a bigger first image (RECALLED, not tested). |

## 3. What each sibling does that we do not

All VERIFIED in the files named, unless tagged.

* **dipa-studio/ios-sweet** (MIT): base of the family. `tools/sweet-root-tweaks.py` is the 153-line original (launchd _PanicOnCrasX, no CommCenter, containers,
  activation, audio). `tools/sweet-crash.py` symbolicates CRASH lines against the dyld cache (we have a copy). Nothing else userland-side.
* **LMasterPiec3/ios-sweet** (no licence file: ideas only): `sweetdtlog` daemon os_log tee (0205); `coreduetd` disabled (we adopted, CPU_IDLE.md);
  kernel file server 0168 + `tools/sweet-install-ssh.sh`; cryptex-only files hard-linked (`NOTES.md:5488`); `libobjc-trampolines` gap noted;
  resize of the HFS+ volume via the kernel (`NOTES.md:707-710`); `SystemAppMigrator` installing the staged apps after the resize (`:707-710`); iServices
  diagnostic image with `sweetdtlog=akd,adid,appstored,fairplayd.H2` (`:594,658`). Daemons disabled: coreduetd, dasd candidates (`:372`).
* **LakoMoor/ios-beryllium** (MIT, the richest root tweaks): ExtensionKit signature flag; `disabled.plist` fairplayd.H2 + bluetoothd; ByHost migration file;
  CA deep-framebuffer prefs; MediaToolbox `StartRecorderServer=false` (we have it, tweaks.rs:668); `--oslog`; ADT `display-gamut`;
  `sweetinject` BT/GL libraries; CA bridge with `pixels_guarded`; driverkitd/pkreporter jetsam note; stock-app move. First-boot jobs: none (all in the image).
  Logging: `tools/sweet-log-pull.sh`, `sweet-symbolicate.sh`. SSH: not in the files read.
* **joranv1/ios-sailfish** (no licence file): removes fairplayd, vmd, ReportCrash, spindump, tailspind, aggregated; `CA_BACKDROP_SCALE=1` on backboardd (CPU-renderer blur fix,
  `tools/sweet-root-tweaks.py:90-99`; only useful on the CPU renderer, so relevant when Chlorophyll is off); migration sentinel; ExtensionKit flag; stub keybag in `mkiosroot-mac.sh:82-87`.
* **MakrSas/ios-topaz** (no licence file): sRGB gamut fix for Safari (we ported it); rest of its tweaks script is the 153-line original.
* **urielc918/ios-switch** (MIT): same 153-line tweak set as ios-sweet; nothing extra in userland.
* **edi194/ios-fajita** (no licence file; same SoC and phone): tweak script is the 153-line original; adds `tools/hijack-daemon.sh`, `replace-daemon-binary.sh`, `restore-daemons.sh`,
  `install-tree-into-image.sh` (push files into a root image on Linux); GPU test jobs as launchd plists (`gputest.plist`, `iokittest.plist`). No first-boot job, no app install.
* **johnpanos/UniXNU-fajita**, **keyfan/UniXNU-enchilada-bringup** (BSD-2-Clause-Patent; iPadOS 17 / OnePlus 6): archive-based, no HFS+ root writer. `NOTES-userland.md:20-59`: setup
  skipped by seeding the Data volume, trust caches, `sheng-lite` (about 30 network/iCloud/photo jobs off, `BootWatchdogPolicy.c` per `NOTES-userland.md:20`), watchdogd off, a
  `text_fixups` list (SpringBoard AWAttentionAwareness deadlock, PosterBoard file-protection, BTAudioHALPlugin loop), `ml-timeout-lock-panic-scale=40`,
  `-apfs_shared_datavolume`, SSH planned over DWC3 CDC-ECM (`NOTES-ssh.md`). **We lack the "disable a whole set of cloud/network daemons" switch** and the AWAttentionAwareness fix (RECALLED
  from their table, patch itself not read).
* **NWylynko/ios-flame** (MIT, SM7325-class phone): WebContent-only 10-bit remap (0124); `wland` job with lifted jetsam limit; configd preferences reset so a Wi-Fi service exists
  (`HANDOFF.md:25-27`); prefs for WebKit GPU process. Wi-Fi first-boot job `org.iosonpixel.wland`, stamp in `/var/local`, off switch file (`HANDOFF.md:48-52`).
* **oosexgang/hackios-xnu-kernel** (two licences by directory, check before use): `userland/rc.jobs.safari` runs Safari scenarios as launchd jobs (`mg_test HasExtendedColorDisplay`,
  `battery_test open URL`); `tools/doctor.sh`, `tools/backup-partitions.py`, `tools/jb-preinstall.py` (already in audit section 3). `docs/ru/notes.md:1330-1331` says Safari opens example.com and its
  services start from the App cryptex.
* **WeiXiaoye/perseus-xnu** (licence: LICENSE.md, not read), SM8150/SDM845 Mi Mix 3: userland not compared; only its GPU zap timing note applies (OTHER_6T_PORT_LESSONS.md section 2.7).
* **SM6225/SM7325 ports** (topaz, flame, sailfish above): same tweak lineage; none has an app installer or a web flasher. None of the siblings has anything like our WebUSB flasher, WASM root
  builder, PAC stripper or dyld-cache rewriter (VERIFIED: no such files in their trees).

## 4. What we have that siblings lack (so nothing needs importing)

VERIFIED by the absence of the same files/keys in their trees: journaled root written by our own HFS+ writer without a Mac or Linux mount; ThrottleInterval/disabled.plist idle set
(CPU_IDLE.md); parking of speech/BlastDoor extension executables with a Restore path; first-boot wallpaper/icon style; web IPA install; Chlorophyll weak-link injection with
`backboardd.orig`; BT HCI env for bluetoothd; USB-net/SSH jobs; staged-apps registration list. Sibling jetsam/launchd handling is only the per-tool workaround above.

## 5. Ordered recommendations

1. P1 `sweetdtlog`-style exec environment (or `--oslog` plist flag) and a Safari/WebContent boot to read the abort text (1.1).
2. P1 ExtensionKit `enforce_xpc_cache_code_signing=false` in the root (table row 1); verify the flag name on iOS 18.
3. P1 Turnip path: on a refused GEM_NEW free idle BOs and retry, skip the draw on failure (1.2); keep the 16384-handle kernel change.
4. P1 bluetoothd off by default unless the HCI transport is verified (1.3).
5. P2 `display-gamut` sRGB, CoreAnimation deep-framebuffer prefs, jetsam limits for our jobs, ByHost migration check, ReportCrash switch.
6. P3 host keys at build time, update docs (journal row stale), kernel file server idea, AppSync-style installer (licence: ideas only).

## 6. Licences (checked from LICENSE files; nothing was copied)

* MIT: LakoMoor/ios-beryllium, NWylynko/ios-flame, dipa-studio/ios-sweet, urielc918/ios-switch, ry-diffusion/Chlorophyll (third-party parts MIT, per NOTICE.md). Code may be reused with the
  notice kept; AGENTS.md says credit goes in README.md only.
* BSD-2-Clause-Patent: UniXNU and the johnpanos/keyfan forks. The AppSync adapter inside UniXNU is GPL-3.0-or-later (README line 6-8): ideas only.
* hackios-xnu-kernel: "two licences apply, by directory" (LICENSE, LICENSE.APSL); not resolved here, ideas only.
* No LICENSE file found (all rights reserved by default): LMasterPiec3/ios-sweet, MakrSas/ios-topaz, joranv1/ios-sailfish, edi194/ios-fajita. Ideas only; rewrite from scratch.
* perseus-xnu: LICENSE.md present, not read; treat as ideas only.
* None of the files cited contains a secret, key or serial; the snippets quoted are file names and plain behaviour.
