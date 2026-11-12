# Audit: userland builder (Renegade), web flasher, install protocol

Scope: `tools/renegade-rs`, `tools/renegade` (Python), `apps/web`, `.github/workflows/{pages,xnu,chlorophyll}.yml`, `docs/INSTALL.md`.
Target device: OnePlus 6T (fajita). Branch base: `claude/exciting-wozniak-wcmfap` (866fb63). No code was changed.

Evidence tags: **OBSERVED** = read in the code or run here; **INFERRED** = follows from the code but not executed; **UNVERIFIED** = needs the device or an external check.

Ran here: `cargo test --release --no-fail-fast`, `cargo clippy --all-targets` (tools/renegade-rs), `npm ci && npm run check && npm test` (apps/web), `npm audit`.
Results: svelte-check 0 errors / 0 warnings; `npm test` 35 pass, 4 skipped (the WASM patcher tests skip because the module is not built); 5 failing Rust tests (diagnosed below); clippy 28 warnings in the library (listed in section 7).

---

## 1. Test-failure diagnosis (the 5 tests that fail in this sandbox)

The sandbox runs as uid 0 on Linux. `cargo test` stops at the first failing test binary (`hfswrite`), so `tests/tweaks.rs` only runs with `--no-fail-fast`.

| Test | Cause | Class | Evidence |
|---|---|---|---|
| `hfswrite::root_build_from_a_folder` | `source_tree()` (tests/hfswrite.rs:89-93) extracts `/Library` with `renegade-rs hfs ... getdir`, which writes the folder as `Cafe` + U+0301 (NFD, as HFS stores it). It then hard-links into `Library/Café/` written NFC (precomposed). macOS (APFS/HFS+) is normalization-insensitive so the path resolves; ext4/overlayfs on Linux compares bytes, so `ENOENT` at line 93 (second `fs::hard_link(...).unwrap()`). Not related to uid. | Test portability bug (macOS-only assumption). Not a product bug. | OBSERVED: `find` on the extracted tree prints `Café`. |
| `tweaks_match_root_tweaks18`, `tweaks_with_quiet_...`, `tweaks_on_the_tree_...` | Rust prints 36 lines, Python 52: the missing ones are all `OWNER <path> 0 0`. `DirFs::chown` (src/tweaks.rs:~97), `TreeFs::chown` (src/tweaks.rs:1040, `skip_owner`) and `renegade-rs.rs:210` drop any chown equal to the owner of the running process. Python `OwnerRecorder._record` (root_tweaks18.py:842) does the same only `and not self.real`; `rplat.real_owners()` is true on Linux as root, so Python records everything. Running the same test binary as uid 65534 (`setpriv --reuid=65534`): these three pass. | Environment (root). But also a real parity gap: Rust has no equivalent of the Python "real owners" mode, so `renegade-rs root DIR` run as root on Linux omits every root:wheel entry from the owner map (the on-disk owner of freshly written files is then what decides; see F-17). | OBSERVED (diff of the two outputs; reruns as nobody). |
| `tweaks_with_tools_match_root_tweaks18` | Fails for a second, independent reason, even as non-root: Rust emits `chlorophyll: not in the tools bundle (bgmtl-inject.dylib, libchlorophyll.dylib, libdrm.2.dylib): backboardd stays on the CPU renderer`, which `root_tweaks18.py` never prints (docs/INSTALL.md: "The Python builder still wires only Mercury's poster"). The test asserts line-for-line equality. | Real, stale test: parity drifted when `tools::chlorophyll()` was added. | OBSERVED (as nobody 3 of 4 pass, this one fails). |

Fix proposal (effort S, about 1 hour):
1. hfswrite test: build the path with `"Cafe\u{301}"` (or `.nfd()`), or skip when the FS is normalization-sensitive.
2. tweaks tests: either `#[cfg_attr(..., ignore)]` when `geteuid()==0`, or give `DirFs`/`TreeFs` a `record_all_owners` switch and set `RENEGADE_REAL_OWNERS`/the Python equivalent in the fixture. The switch is the better fix, it removes the F-17 gap.
3. chlorophyll line: strip lines starting with `chlorophyll:` in the comparison (like the existing `strip_src`), and add a Rust-only test.
4. CI: nothing in `.github/workflows` runs `cargo test` or `npm test` (see F-12); these failures go unnoticed because the author's loop is macOS-only.

---

## 2. Findings (P0 to P3)

Format: ID, severity, location, status tag, why, fix, effort.

### P0

No P0 (data loss of data the user has not already agreed to lose, brick, or remote code execution) was found in what could be read here. F-01 and F-02 are the closest and are marked P1 because the flasher only writes `userdata`, `boot` and `logo` (fastboot.ts `ALLOWED_PARTITIONS`, command allow-list in `allowed()`), which cannot touch modem, persist or the bootloaders.

### P1

**F-01 P1 (brick risk on the wrong phone). `apps/web/src/lib/flasher.ts: SUPPORTED_PRODUCTS`, `phoneProblems`.** OBSERVED/INFERRED. The gate accepts `product` = `sdm845`. That string is the SoC, not the model: OnePlus's ABL reports it for the OnePlus 6T, and (INFERRED, same ABL family) for the OnePlus 6 and other SDM845 phones. The page would then offer to overwrite `userdata` and `boot` of a phone the kernel and ADT were never built for. The `boot` flash on an A/B phone is the dangerous one (F-02). Fix: after the `product` check, require a second discriminator before enabling writes: e.g. `getvar:variant`/`hw-revision`/`serialno` pattern (UNVERIFIED which variables the 6T ABL answers; read `fastboot getvar all` on a device and store the list in `docs/FAJITA.md`), or the partition-size signature (`userdata` size for 6T 128/256 GB). Also show the full `getvar all` in the confirmation sheet. Effort S-M.

**F-02 P1. `apps/web/src/lib/fastboot.ts: allowed()`, `ALLOWED_PARTITIONS`; `ConfirmStep.svelte`.** INFERRED. `flash:boot` is allowed with no slot suffix. On the 6T (A/B) the ABL decides which slot gets written. Android is not backed up by the page. The confirmation only says "Nothing else is touched", and the type-to-confirm is the partition name. The AGENTS.md policy (confirm each destructive step, keep backups) is not enforced in the UI: there is no "I have a backup of persist/modem/boot" checkbox and no reading of `current-slot`/`slot-count`. Fix: read `current-slot`, show which slot `boot` will hit, require typing the slot; make `userdata` the only default-enabled target and put `boot`/`logo` behind Advanced; add a mandatory "backups done" checkbox with the backup hint from docs. Effort S.

**F-03 P1. `apps/web/src/lib/flasher.ts: checkImage` (userdata branch) + `sparse.ts: parseImage` + `patcher.ts: storedImages`.** OBSERVED. `SparseWriter::new` writes 28 zero bytes and only `finish()` writes the real header (sparse.rs:268, 250). A patch that is cancelled, crashes (OOM trap) or loses the tab leaves `bergamota-userdata.simg` in OPFS with a zeroed header. `Advanced.svelte` lists every `*.img|*.simg` in OPFS and the user can pick it; `parseImage` then treats a non-sparse file as a raw image, and the only userdata check is `size >= 64 MiB`. Result: a truncated, headerless file is flashed over `userdata` (or any 100 MB random file, e.g. an Android system.img). Fix: for `userdata` require either the sparse magic or an HFS+/HFSX volume header (`H+`/`HX` at offset 1024 of the expanded image, and for raw images the `HX` signature), and require the image's expanded size to match what the build reported; mark partial images (write to `bergamota-userdata.simg.partial`, rename on success; delete in `cancelPatch`). Effort S.

**F-04 P1. `apps/web/src/livelog/sshsession.svelte.ts: installIpa`, `removeApp` (lines ~330-376).** OBSERVED. The only protection is a name regex. `installIpa` runs `rm -rf '/Applications/<name>.app' && tar -xf -` as root; an IPA whose bundle folder is `SpringBoard.app`, `MobileSafari.app`, `PosterBoard.app` (or any system app) deletes that system app first, and if `tar` then fails the app is simply gone (no staging directory, no atomic swap). The doc comment on `removeApp` even says "system apps are refused by the name check only", but no such list exists. Same for "Remove an app". Fix: deny-list by checking `/Applications/<name>.app` against the stock app list captured at patch time (Renegade can write `/usr/local/share/renegade/stock-apps`), or only allow replacing apps that carry a marker (`_Sideloaded` file written by the install); extract to `/Applications/.stage-XXXX` and `mv` atomically. Effort S-M.

**F-05 P1 (supply chain). `apps/web/scripts/fetch-tools.sh`, `.github/workflows/pages.yml` (fetch/add steps), `tools/renegade-rs/src/tools.rs: Tools::from_zip`.** OBSERVED. The binaries that run as root on the phone (dropbear, dash, toybox, BlueTool stub, bgl*, sweet* helpers, Chlorophyll dylibs injected into backboardd) come from (a) `gh release download` of the newest `berga-tools-vN` of another account (`ry-diffusion/Bergamota`, picked by `sort_by(tonumber) | last`, so whoever can publish a higher tag wins), with a `.sha256` fetched from the same release (integrity against corruption only), and (b) the `chlorophyll-ios18` release of this repo, merged with no hash check, built from a mutable branch (`chlorophyll_ref` default `ios26`, `git clone ... && checkout` with no commit pin). `Tools::from_zip` verifies each file against `berga-tools.json` that is inside the same zip, so it protects against nothing hostile. The artifact is deployed to the public Pages site, so a tampered release reaches every user's root. Fix: pin the berga-tools tag and its SHA-256 in the repo (`apps/web/tools.lock`), fail the build on mismatch; pin Chlorophyll to a commit SHA and record it in `BUILD.txt`; sign the bundle (minisign/cosign or GitHub artifact attestations) and verify in the workflow; build berga-tools in this repo instead of fetching it from another account. Effort M.

**F-06 P1 (reproducibility/safety of the box the phone boots). `.github/workflows/pages.yml`.** OBSERVED. Fetches from a release whose absence silently degrades the product: `gh release download chlorophyll-ios18` failure is a warning, the site is published without Chlorophyll; for `berga-tools` a failed fetch fails the build, fine. Combined with F-05 there is no step that checks the final `berga-tools.zip` content before deploy (e.g. a smoke test that every file in the manifest exists and is a Mach-O of the right arch). Fix: add a verify step (`python3 tools/berga-tools/verify.py`) and run `cargo test --test chlorophyll` and `npm test` before `upload-pages-artifact`. Effort S.

### P2

**F-07 P2. `apps/web/src/lib/fastboot.ts: withTimeout`, `command`, `download`.** OBSERVED. The timeout rejects but does not cancel the pending `transferIn`. After a timeout (the 10-minute `flash:` or a 60 s `download`), the page may call `reboot-bootloader`/another command while the old IN transfer is still outstanding; the next reply is then consumed by the stale read and the protocol desynchronizes (a `FAIL`/`OKAY` attributed to the wrong command, `getvar` returning a flash result). Fix: on timeout call `usb.reset()`/close the device and force the user through Connect again; or keep one read loop that demultiplexes replies. Effort M.

**F-08 P2. `apps/web/src/lib/flasher.ts: flash`.** OBSERVED. Each piece is a full sparse image flashed with `flash:userdata`; after Stop (`shouldStop`) or a cable drop, `userdata` holds a partially written root and the UI says "stopped"/"flash again" but does not warn that the phone will not boot iOS or Android now, and there is no read-back or hash verification of what was written (fastboot has none; OnePlus ABL offers none). Fix: say so; persist a "flash in progress" marker in `localStorage` to warn on next page load; after the last piece, verify via the Bergamota fastboot (`getvar:userdata-crc` if added to Enxerto, UNVERIFIED) or at first boot with the HFS volume header check. Effort M.

**F-09 P2. `tools/renegade-rs/src/rootbuild.rs: build`, `volume_size`.** OBSERVED. The volume is `used + 6 GiB` rounded up, at least 24 GiB: on a 128 GB 6T (userdata about 100 GB+) iOS gets about 8-9 GiB of free space for apps, photos, caches and logs, and HFS+ cannot be grown online. The size is not a UI option (`BuildConfig` in wasm.ts has no `volumeSize`). Fix: expose a "use the whole partition" choice fed by `partition-size:userdata` from fastboot (the sparse image's trailing DONT_CARE costs nothing; the bitmap of 100 GB / 4 KiB is about 3 MiB); default to e.g. 64 GiB. Effort S.

**F-10 P2. `tools/renegade-rs/src/zip.rs: Zip::read_all`, `Zip::open`.** OBSERVED. Entry sizes come from the central directory and are bounded only by 2 GiB each; `read_vec(csize as usize)` allocates the compressed size unchecked and `decompress_to_vec_with_limit(size+1)` allocates up to the claimed 2 GiB. In wasm32 (4 GiB linear memory, no growth failure handling) a malicious IPA/zip (sideload path takes arbitrary user IPAs; `ipa::prepare` holds every file twice: `files` plus `files[p].clone()` plus the tar) aborts with `unreachable`, which `session.svelte.ts` maps to the last log line. Fix: cap the sum of sizes for `prepare` (e.g. 1 GiB), reject ratio > 200:1, process in a streaming tar writer. Effort M.

**F-11 P2. `apps/web/src/livelog/*` (host key), `lib/ssh.ts` option `hostKey`.** OBSERVED. `SshClient` has an `hostKey` callback "Default: accept", and `sshsession.svelte.ts: connect` never sets it: the fingerprint is displayed but never pinned or compared. Dropbear generates its host keys at the first connection (`-R`), so there is no root-time key to compare against. On a point-to-point USB link the risk is small but real (a second composite device, a malicious hub). Fix: trust on first use per phone (store `fingerprint` keyed by USB serial in `localStorage`, warn loudly if it changes); better, have Renegade generate the host key at build time (needs an ed25519 keygen in Rust: `ed25519-dalek` is a small dependency) and print the fingerprint in the patch log. Effort S-M.

**F-12 P2 (CI gap). `.github/workflows/pages.yml`.** OBSERVED. The deploy job never runs `npm run check`, `npm test`, `cargo test` or `cargo clippy`; PRs are not built at all (`on: push` paths + dispatch). The failing tests of section 1 are invisible. Also wasm tests are skipped unless the module is built (`npm test` prints 4 skipped). Fix: a `ci.yml` on `pull_request` with ubuntu runner: `cargo test --no-fail-fast` as non-root, `cargo clippy -- -D warnings` after fixing section 7, `npm ci && npm run build:wasm && npm run check && npm test`. Effort S.

**F-13 P2 (Actions hygiene). `.github/workflows/*.yml`.** OBSERVED. Actions pinned to major tags (`actions/checkout@v4`, `setup-node@v4`, `upload-pages-artifact@v3`, `deploy-pages@v4`, `cache@v4`) rather than SHAs; `rustup target add` unpinned toolchain (no `rust-toolchain.toml`), `brew install` unpinned, `pip install meson mako ...` unpinned in chlorophyll.yml. `chlorophyll.yml` has `permissions: contents: write` for the whole job including the Mesa/Chlorophyll build steps that run third-party code (a compromised dependency could rewrite releases or push to the repo); only the final publish step needs it. `${{ inputs.chlorophyll_ref }}` and `xcode_version` are interpolated straight into `run:` (shell injection by anyone who can dispatch, who already has write access; low but easy to fix with `env:`). `pages.yml` uses `GH_TOKEN: ${{ github.token }}` to read another repo's releases: works for public repos only. Fix: pin by SHA (dependabot for actions), split the publish into a second job with `contents: write`, pass inputs via `env`. Effort S.

**F-14 P2. `docs/INSTALL.md` (new-user path).** OBSERVED. See section 5 for the complete list; the main gaps: no prerequisites list (unlocked bootloader, Android backup, `fastboot getvar` product check), step 2 requires a Mac-style toolchain and private inputs (`dtb/`, GPU firmware pulled from the user's own partitions, a CI run number, `gh`), the three steps are in a different order than they are done (the boot image must exist before step 3 but step 1 flashes userdata first), no recovery path back to Android, and "never hard-reset" with no explanation of how to power off a frozen phone.

**F-15 P2. `apps/web/src/patcher/worker.ts`, `session.svelte.ts: startPatch`.** OBSERVED. The patch takes about an hour (README: "the full run takes about an hour over HTTP", local File is faster) in a Web Worker with a wake lock, but: no checkpoint/resume (a tab crash restarts from zero), `bergamota-userdata.simg` is deleted at the start of each attempt (`discardImage()`) before the new one succeeds, and the 17-22 GiB estimate is checked against `navigator.storage.estimate()` only. Fix: build into a `.partial` name (F-03), keep the last good image until the new one finishes, and surface the key-wait state in the title so the user does not leave the tab. Effort S.

**F-16 P2. `tools/renegade-rs/src/tools.rs: Tools::from_zip`.** OBSERVED. The manifest is parsed by `split("\"path\"")` and `split('"')` string slicing, not JSON: a path or value containing the text `"path"` shifts the parse; files not under `ssh/`, `sweetnet/`, `bergamota-gl/`, `bgmtl/` are silently ignored while the manifest-listed ones not present in the zip are never reported (a missing listed file produces no error). Fix: parse with the existing flat JSON parser or a tiny dedicated one, and fail if a manifest entry has no file. Effort S.

**F-17 P2. `tools/renegade-rs/src/tweaks.rs: DirFs::chown`, `bin/renegade-rs.rs:210`.** OBSERVED/INFERRED. As described in section 1: dropping chowns equal to the process owner is right for non-root (the files are then root-mapped by `--default-root`), but when the builder runs as root the semantics differ from Python's `real` mode. UNVERIFIED whether any resulting image differs (new files are created as root so the default owner is also root); it is a latent divergence that the failing tests hide. Fix: explicit `--record-all-owners`, used by tests and by `root-ipsw`. Effort S.

### P3

**F-18 P3. `tools/renegade-wasm/src/lib.rs: HostOut::seek`.** OBSERVED. `SeekFrom::End(d)`/`Current(d)` use `(self.len as i64 + d) as u64`: a negative result wraps to a huge offset instead of an error. Reachable only through the writer's own seeks (header rewrite), so low. Fix: `checked_add_signed` and error.

**F-19 P3. `tools/renegade-wasm/src/lib.rs: parse_flat`.** OBSERVED. The hand-written JSON string parser does not decode `\uXXXX` (it keeps `u` and the digits) and silently ignores trailing garbage. The SSH key and PEMs pass through it: a key comment with non-BMP characters is JSON-escaped by `JSON.stringify` only for control characters, so today it is fine; a future field with `\u` would be corrupted. Fix: reuse `plist`/a real JSON decoder or reject `\u`.

**F-20 P3. `apps/web/src/patcher/wasm.ts: build`, `rootbuild::Config.now`.** OBSERVED. `now: Date.now()` is baked into the HFS volume dates and new-file mtimes, so two builds of the same IPSW differ; the Python/CLI path has `--date`. For reproducibility and to compare images (hash of the sparse file) use the IPSW's build date or `SOURCE_DATE_EPOCH`. Effort S.

**F-21 P3. `tools/renegade-rs/src/zip.rs: crc32`.** OBSERVED. Bitwise CRC (8 iterations per byte): about 10x slower than a table or `crc32fast`; matters for `read_all` of big plists/IPA members in wasm. Fix: table-driven.

**F-22 P3. `tools/renegade-rs/src/ipa.rs: prepare`.** OBSERVED. Zip symlinks and unix modes are ignored (every member becomes a regular file, mode 755 only for Mach-Os): frameworks with `Versions/Current` symlinks and shell scripts lose their link/exec bit. Only the first `*.app` of `Payload/` is taken. The entitlements of the IPA are kept verbatim in the ad-hoc signature (docs/CSOPS.md: AMFI is relaxed on this kernel, so a sideloaded app can claim private entitlements): acceptable for a developer device, but the page should show the entitlement list before sending. Effort S-M.

**F-23 P3 (i18n/accessibility). `apps/web/src`.** OBSERVED. UI copy is English in `flash/*` and `livelog/*`; mixed with Portuguese/French fragments elsewhere (see section 4). `ConfirmStep.svelte` uses `aria-label` on the type-to-confirm input, but progress and the log have no `role="status"/aria-live`, error messages in `ConnectStep`/`FlashStep` are not announced, the red `.warn` block relies on colour plus text (fine) but white text on `--warn` has not been contrast-checked (UNVERIFIED). Fix: `aria-live="polite"` regions for stage/progress/errors; extract strings into a small `i18n.ts` dictionary (en, pt-BR) so languages cannot mix.

**F-24 P3. `apps/web` dependencies.** OBSERVED. `npm audit`: 5 vulnerabilities (2 low, 2 moderate, 1 high); the high one is `undici 7.0.0-7.30.0`, pulled by `wrangler` (dev tool only, not shipped), `deepmerge` has no fix. Not reachable from the shipped page; update `wrangler` with the next maintenance bump and keep `npm audit --omit=dev` in CI (it is clean for shipped code: UNVERIFIED, run it in CI).

**F-25 P3. `apps/web/worker/index.ts` (`/api/fcs-key`).** OBSERVED. Good: strict URL regex, size and prefix check. Remaining: `redirect: "follow"` lets the fetch follow a redirect off the allow-listed host (the final content is still validated by the `BEGIN PRIVATE KEY` prefix and 4096-byte cap, but SSRF to any host that returns such text is possible); no rate limit. Use `redirect: "manual"` and re-validate the Location. The Wrangler config embeds an `account_id` (not a secret).

**F-26 P3. `apps/web/public/_headers`.** OBSERVED. A solid CSP (`default-src 'self'`, `connect-src 'self'`, no inline scripts). Note that it only applies on the Cloudflare host: GitHub Pages ignores `_headers`, so the production URL in INSTALL.md (`ferdza.github.io`) has no CSP, no COOP and no `Permissions-Policy`, and no `/api/fcs-key` relay (the user must fetch Apple's key by hand; `waitForKeys`). Fix: add a `<meta http-equiv="Content-Security-Policy">` in `index.html` (works on Pages) and document which host is canonical.

---

## 3. What others do better

Sources: local clones under the scratchpad `refs/` (read only, nothing run): `oosexgang_hackios-xnu-kernel` (`docs/install.md`, `tools/backup-partitions.py`, `tools/flash-fingerprint.sh`, `tools/doctor.sh`, `sysimage/ipsw-member.py`, `tools/jb-preinstall.py`) and `UniXNU_UniXNU` (`docs/guide/userdata.md`, `docs/porting/dual-system-partition.md`, `docs/porting/arm64e.md`). Web research was not done this session (rate-limit interruption): everything below is from those clones. The claims about those projects are OBSERVED in their docs/scripts, not tested.

| Area | Bergamota-farita today | What others do | Idea to take |
|---|---|---|---|
| Root build speed and size | Re-writes the whole OS into a fresh HFSX (about 15 GiB used, 24 GiB volume), PAC-strips about 3,200 Mach-Os, rewrites the dyld cache; about an hour over HTTP (README), no resume | UniXNU (`guide/userdata.md`): the IPSW's OS and SystemOS disk images are placed unchanged in windows behind a manifest the kernel reads; no per-file rewrite, so the build is a copy with a dry-run report (window offsets, sizes, hashes, capacity). HackiOS `ipsw-member.py`: streams one member from the IPSW, never holds it in memory | Keep Renegade (needed: arm64e to arm64), but add a `--dry-run` report with sizes, hashes and the partition capacity check; cache stage outputs (dyld cache, Mach-O plan) keyed by IPSW build + Renegade version so re-patching only redoes tweaks |
| First boot | Launchd job runs `renegade-firstboot.sh` (app registration, wallpaper, up to 3 tries, retry loops of 10 minutes) | UniXNU `guide/skip-setup.md`, `mobilegestalt.md`: setup skipping and device identity as documented, separate steps. HackiOS `jb-preinstall.py`: packages unpacked into the root at build time so the first boot has nothing to download | Move app registration into the image (pre-built LaunchServices cache) where possible; log the first-boot result to a file the web page can read back over SSH |
| SSH | Dropbear, key-only, host keys generated on the phone at first connection (`-R`), the browser accepts any host key (F-11) | HackiOS: no network daemons by default, every action logged | Generate host keys at build time and show the fingerprint in the patch log; TOFU pin in the page |
| App install | Page re-signs an IPA in WASM and untars as root over SSH; replaces by name with no staging (F-04) | HackiOS `jb-preinstall.py`: nothing of a package's own scripts is run, only plain files plus the dpkg database, newest version first | Staging dir + atomic move; stock-app deny list; show entitlements before install |
| Updates | None: a new release means re-patching the IPSW and re-flashing the whole `userdata` | HackiOS: installs into the inactive slot only; system image read-only | A "tools update" over SSH (the page already has "Install a .zip"): version-stamp `/usr/local/share/renegade/version` and let the page diff it against the site's bundle |
| Recovery | The page flashes `userdata`/`boot`/`logo`; Android is erased; recovery is "boot with sweetdenypath" or re-flash. No backup taken or verified | HackiOS `docs/install.md` seven rules: look first and keep what was there (partitions to be touched, GPT head/tail, `boot`, `vbmeta` copied and hashed twice), only the inactive slot, never the partitions that cannot be remade, every write read back, a way back that does not need the host, dry run by default, everything logged. `backup-partitions.py` hashes each partition before and after the copy. `flash-fingerprint.sh` proves nothing else changed. UniXNU `dual-system-partition.md`: carve a new `unixnu` partition off the end of `userdata` (F2FS shrink from TWRP), so Android survives | (1) a backup step/script modelled on `backup-partitions.py`; (2) record `fastboot getvar all` and the GPT in the install log; (3) offer the carve option so Android is not forced to go (AGENTS.md approves erasing for the owner; other users should get the safer default); (4) read-back verification (F-08) |
| Pre-flight checks | None beyond `product` | HackiOS `tools/doctor.sh`: read-only host and phone check that says what to do about each problem | A "Check my setup" panel: browser, WebUSB, OPFS quota, free disk, bootloader unlocked, slot, battery level |

---

## 4. i18n, accessibility, UX consistency (apps/web)

- OBSERVED: the page declares `lang="en"` and all of `flash/*` is English, but `livelog/LiveLog.svelte` mixes French (`Vérifier`, `Vérifier l'état actuel du téléphone`, `Installer l'IPA`, lines about 160 and 286-308) with English labels such as `aria-label="IPA to install"` on the same row. There is no dictionary: strings are literals in the `.svelte` and `.ts` files, so a language cannot be switched and mixed text slips in. Fix: `src/lib/i18n.ts` with `en` first, extract the strings of `LiveLog.svelte`, `session.svelte.ts` and `flasher.ts`. (F-23)
- OBSERVED: an emoji leads the refresh pill; screen readers read "circular arrows". Give icon buttons an `aria-label`.
- INFERRED: progress and errors are not in live regions; a flash can take 10+ minutes and a screen-reader user gets no updates. Add `role="status"` to the progress text and `role="alert"` to `flashError`/`connectError`/`patchError`.
- OBSERVED: the typed-confirmation input is labelled (good); the destructive button is `disabled` until the text matches, with no explanation for assistive tech (`aria-describedby`).
- OBSERVED: `beforeunload` blocks the tab only while flashing, not while patching (about an hour): closing the tab mid-patch silently loses the work (F-15).

---

## 5. docs/INSTALL.md end to end: gaps and risky steps

Walk-through as a new user with a OnePlus 6T:

| # | Step in the doc | Gap or risk | Tag |
|---|---|---|---|
| 5.1 | Before step 1 | No prerequisites: unlocked bootloader (the page says "Unlock it first (Xiaomi's unlock tool)", which is wrong for a OnePlus), a full Android backup, charge level, the exact phone model and slot state | OBSERVED (flasher.ts `phoneProblems`) |
| 5.2 | "Drop `iPhone11,8_18.7.8_22H352_Restore.ipsw`" | Does not say where to get the IPSW, its size (about 6 GB), or that 17 GiB of browser storage are needed; Chrome's quota depends on the disk holding the profile (F-15). A wrong IPSW errors only after opening | OBSERVED |
| 5.3 | "paste your SSH public key" | If skipped, the root has no way in at all and the doc does not say so. A key with a passphrase is refused with a long recipe by the live-log page | OBSERVED |
| 5.4 | "patch, then flash `userdata`" | The patch takes about an hour; on GitHub Pages there is no `/api/fcs-key` relay so the user must fetch Apple's key by hand (`waitForKeys`), which INSTALL.md never mentions | OBSERVED |
| 5.5 | Order of steps | Step 1 flashes userdata, step 2 builds the boot image with `dtb/<board>/dtb` and GPU firmware pulled from the user's own Android partitions (`tools/gpu-fw-pull.sh`), plus a green *xnu* CI run. A user who follows the numbers has erased Android before finding out step 2 needs Android's partitions. Reorder: backup, pull dtb/firmware, build boot image, flash userdata last | OBSERVED |
| 5.6 | "Boot once" | Nothing is written to `boot`, so every power cycle returns to the stock boot. The doc never says how iOS is booted later (a persistent install needs `flash:boot`, allowed by the page but not described) | INFERRED |
| 5.7 | Safety net | "Never hard-reset iOS": the root is an unjournaled HFS+, but INSTALL.md gives no way to power off a hung phone or to repair after a dirty shutdown (only FAJITA.md known issues mention the cause) | OBSERVED |
| 5.8 | Recovery to Android | Absent: no documented route back, and the page cannot restore it | OBSERVED |
| 5.9 | Boot image secrets | "The OEM zap firmware is inside the ADT: never publish the image": correct, but `build-boot.sh` does not itself write to a git-ignored path (`.gitignore` covers `enxerto/out/` only) | INFERRED |
| 5.10 | Chlorophyll line | The doc tells the user to run two workflows if the `chlorophyll:` line is missing; an end user cannot run the maintainers' workflows. Make it a maintainer note and have the site refuse to publish without the release (F-06) | OBSERVED |
| 5.11 | Canonical URL | INSTALL.md points to `ferdza.github.io/Bergamota-farita/flash/` (no CSP, no key relay, F-26) while `wrangler.jsonc` defines `bergamota.zesmoi.com.br`: two hosts with different headers and behaviour, no statement of which is canonical | OBSERVED |

---

## 6. Hardening list (concrete, ordered)

1. Second phone identity check and slot-aware `boot` flash (F-01, F-02). S.
2. Refuse headerless/non-HFS images for `userdata`; write patch output as `.partial` and rename on success (F-03, F-15). S.
3. Staging + deny-list for IPA install and "Remove an app" (F-04). S-M.
4. Lock the tools supply chain: tag + SHA pin file, commit-pinned Chlorophyll, signed bundle, build berga-tools in-tree (F-05, F-06). M.
5. CI on pull requests: `cargo test` as non-root, clippy `-D warnings`, `npm run check`, `npm test`, wasm build, `npm audit --omit=dev` (F-12). S.
6. Pin actions by SHA, split `contents: write` into the publish job, pass inputs through `env` (F-13). S.
7. Fix the 5 failing tests (section 1) and add `record_all_owners` (F-17). S.
8. Host key at build time or TOFU pin in the page (F-11). S-M.
9. Timeouts that reset the USB device (F-07); post-flash verification (F-08). M.
10. Zip/IPA resource caps (F-10); `Tools::from_zip` real JSON and missing-file errors (F-16). S-M.
11. Whole-partition volume option (F-09). S.
12. Backup step modelled on HackiOS `backup-partitions.py` and a "check my setup" panel (section 3). M.
13. i18n dictionary and live regions (section 4). S-M.
14. CSP meta tag for the Pages host (F-26); `redirect: "manual"` in the relay (F-25). S.
15. Reorder INSTALL.md; add prerequisites, recovery and canonical-URL sections (section 5). S.

---

## 7. Code quality, clippy, duplication, parity

- OBSERVED (F-27, P3): `cargo clippy --all-targets` in tools/renegade-rs: 28 library warnings, all style: 18 `needless_borrow` (src/apfs/mod.rs 346-384 and 505, src/apfs/file.rs 200 and 252, src/apfs/fs.rs 369-370, src/apfs/obj.rs 59, src/apfs/lzbitmap.rs 39, src/rootbuild.rs 46 and 48), 4 `type_complexity`, 3 `collapsible_if`, 2 `manual_saturating_arithmetic`, 2 `manual_is_multiple_of`, and 1 in `bin/renegade-rs.rs:1082`. None points at a bug; `cargo clippy --fix` clears most. Gate it in CI (F-12).
- OBSERVED (F-28, P3, S): about 72 `unwrap()`/`expect()` outside tests in the library (aea.rs, codesign.rs:364, dsc.rs:207, hfs.rs, hfswrite.rs 275-318, tools.rs 417/512/554, tweaks.rs 490-495). Most follow a check; in wasm a panic becomes `unreachable` and the UI only shows the previous log line (session.svelte.ts). Install a panic hook in `renegade-wasm` that sends the message and location through `host.event`.
- OBSERVED (F-29, P3, S): `tools.rs: install()` records the owner for `dst.new` instead of `dst` (copied from the Python temp-file behaviour); the `OWNER ...new` entries are dead weight in the owner map (14 of them in the diff of section 1). Record for `dst` in both implementations.
- OBSERVED (F-30, P3): dead `let _ = DROPBEAR_KEY;` and a log line "no dropbearkey for the host (Linux: apt install dropbear-bin)" printed in the browser path, where host keys are not generated by design.
- OBSERVED (F-31, P2, M): duplication and parity. `tools/renegade/root_tweaks18.py` (1,512 lines) and `renegade-rs/src/tweaks.rs` + `tools.rs` (1,854 lines) implement the same tweaks; `tools/img2simg.py` and `tools/renegade/img2simg.py` are two different copies (64 and 88 lines); `tools/sweet-root-tweaks.py` (386 lines) is a third tweak implementation. The two paths already diverge (chlorophyll, host-key handling, `real` owners, the README "Not ported yet" list). Declare Rust canonical and freeze Python as a test oracle, delete the other copies, or move shared data (job names, plist keys, file lists) into one data file that both read.
- OBSERVED (F-32, P3): the jailbreak stage (Python only) downloads Procursus, Sileo and TrollStore at build time (`jailbreak.py` lines 55-71); its docstring says only the Linux `ldid` is SHA-256 pinned. UNVERIFIED whether the payload hashes are pinned. The browser path does not use it. Pin every URL by hash.
- OBSERVED (F-33, P3): no `cargo audit`/`cargo deny` in CI; `ureq = "2"` (CLI only) is the only network dependency.

---

## 8. Summary table

| Severity | Findings |
|---|---|
| P0 | none |
| P1 | F-01, F-02, F-03, F-04, F-05, F-06 |
| P2 | F-07 to F-17, F-31 |
| P3 | F-18 to F-30, F-32, F-33 |

Total: 33 findings, plus the 11 install-protocol rows of section 5 and the 7 comparison rows of section 3.

Not done in this session (rate-limit interruption): web research (hackiosx.dev, unixnu.com, blacktop/ipsw), deep reading of `dsc.rs` (cache rewrite, FIPS HMAC) and `hfswrite.rs` invariants, `ipstack.ts` and `ssh.ts` protocol correctness (only the host-key and key-handling paths were read), WASM memory measurements, and the Python `mkroot-full.py` flow. Treat the absence of findings there as UNVERIFIED, not as clean.
