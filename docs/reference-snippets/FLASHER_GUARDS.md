# Flasher guards: identifying a OnePlus 6T over fastboot, slots, partial-image safety

Legend: OBSERVED = seen in a fetched page/file or in our repo; INFERRED; UNVERIFIED = recalled / not found. Sources are web pages fetched through WebFetch/WebSearch
(summaries by the tool, so quotes are short or paraphrased). **I found NO real `fastboot getvar all` dump of a OnePlus 6T** (searched: XDA/Lineage wiki/pmos/mobile-nixos/GitHub gists/forums); the
only things known about the 6T ABL come from our own device notes. Treat every "typical ABL variable" below as UNVERIFIED until the first dump from the user's phone is stored (section 6).

## 1. What is known about the 6T ABL (OBSERVED)

- `docs/FAJITA.md` line 22: `fastboot getvar product` on the user's 6T ABL = **`sdm845`** (confirmed on-device 2026-11-03). Enxerto's own fastboot (`enxerto/build.sh` `-DFB_PRODUCT`) answers `fajita`.
- `apps/web/src/lib/flasher.ts` `SUPPORTED_PRODUCTS` accepts `beryllium`, `sdm845`, `fajita`; `identify()` reads only `product`, `version-bootloader`, `unlocked`, `max-download-size`, `partition-size:{userdata,boot,logo}`.
- A restore guide for the 6T (gist ahnafnafee/OnePlus6T-Restore.md, via WebFetch) uses `fastboot getvar product` ("product: sdm845 is fine"), `fastboot getvar current-slot` (a|b), `fastboot oem device-info`
  (expects "Device unlocked: true"), and flashes `boot_a/boot_b`, `dtbo_a/dtbo_b`, `vbmeta_a/vbmeta_b`. It mentions no `variant` or `hw-revision`.
- Lineage device trees: `android_device_oneplus_fajita/board-info.txt` = `require board=sdm845|OnePlus6T`; `android_device_oneplus_enchilada/board-info.txt` = `require board=sdm845|OnePlus6`
  (both OBSERVED, branch lineage-22.2). AOSP fastboot checks `require board=` against `getvar product`, alternatives separated by `|` (INFERRED from fastboot behaviour; the README fetched does not describe it).
  => the 6 and the 6T both report `sdm845`; the second alternative is only for ABLs that report a model string. **`product == sdm845` cannot discriminate 6 vs 6T**, even in Lineage's own check.
- Other sdm845 phones answer the same product: a forum post (earlybird.club, "FAILED (remote: unknown command) on LG G7 Thinq", via WebFetch summary) shows an LG G7 `getvar all` with `product: sdm845`,
  `hw-revision: 20001`, `secure: yes`, `unlocked: no`, `max-download-size: 536870912`, variant "SDM UFS", `current-slot: b`. So: any SDM845 phone with an unlocked ABL would pass today's gate.
  (This is an LG; the `variant`/`hw-revision` strings there are Qualcomm-ABL-generic, not necessarily the OnePlus values.)
- Models: 6T = codename fajita, model numbers A6010 (Lineage 'variant1') / A6013 (T-Mobile, 'variant2') per wiki.lineageos.org/devices/fajita (paraphrase; page lists variants, not the numbers I quote: A6010/A6013 UNVERIFIED).
  6 = enchilada (A6000/A6003). Userdata sizes: 6T 128/256 GB; 6 64/128/256 GB (recalled): size overlaps, so partition sizes do **not** separate 6 and 6T (INFERRED).

## 2. Variables to read (AOSP / Qualcomm ABL convention)

AOSP fastboot README (android.googlesource.com/platform/system/core/+/HEAD/fastboot/README.md, OBSERVED): `version` (protocol, 0.4), `version-bootloader`, `version-baseband`, `product`, `serialno`, `secure`
(`yes` = signature required), `is-userspace` (`yes` = fastbootd), `is-logical:<p>`. Unknown variables should FAIL. The README does not list `variant`, `hw-revision`, `slot-count`, `current-slot`, `has-slot`,
`max-download-size`, `partition-size`, `partition-type`, `unlocked`; the AOSP A/B docs (source.android.com/docs/core/ota/ab/ab_implement, via search) say `slot-count` returns the number of slots (2) and
`has-slot:<name>` returns yes/no for the partition name without suffix.

| var | use | on the 6T ABL |
|---|---|---|
| `product` | first gate | `sdm845` (OBSERVED) |
| `unlocked` / `secure` | must be `yes` / `no` for writes (`oem device-info` as a second source, "Device unlocked: true") | UNVERIFIED value text; the 6T restore guide uses `oem device-info` |
| `slot-count` | `2` on A/B (UNVERIFIED on 6T ABL; the Bergamota fastboot answers `0`, `BERGAMOTA_FASTBOOT.md` line 54) | expect 2; if FAIL treat as unknown, refuse boot writes |
| `current-slot` | `a`/`b` (LG G7 dump shows `b`; the 6T guide reads it) | UNVERIFIED format: with or without leading underscore (fastboot.js strips a leading `_`) |
| `has-slot:boot`, `has-slot:userdata` | `yes` / `no` | UNVERIFIED; expect boot yes, userdata no |
| `is-userspace` | `no` in bootloader fastboot | UNVERIFIED |
| `max-download-size` | LG dump 0x20000000 (536870912) | UNVERIFIED on 6T; flasher already parses dec/hex |
| `partition-size:userdata`, `partition-type:userdata` | size check | UNVERIFIED (BERGAMOTA_FASTBOOT.md line 154 records Bergamota's own answer, "about 109643 MiB", not the ABL's) |
| `variant`, `hw-revision`, `version-bootloader`, `serialno` | identity record | UNVERIFIED names/values on OnePlus; LG dump has variant "SDM UFS", hw-revision 20001 (do not copy these) |
| `project-name`/OnePlus-specific | maybe | UNVERIFIED; OnePlus builds expose a `ro.boot.project_name` (6T 18801, recalled) to Android, not necessarily to fastboot |

## 3. Suggested guard (answer to "which discriminate")

Because no getvar is known to separate 6T from 6/other sdm845, use layers, all non-destructive, and capture evidence:
1. `product == sdm845` (necessary, not sufficient), `unlocked == yes`, `secure == no` if the var exists.
2. `slot-count == 2` and `has-slot:boot == yes` (a real A/B Qualcomm phone). Refuse boot flashing otherwise.
3. Partition fingerprint: query `partition-size:` for a few names that exist on the 6T GPT (`boot_a`, `dtbo_a`, `vbmeta_a`, `modem_a`, `bluetooth_a`, `userdata`, `abl_a`, `xbl_a`) and compare to the values stored
   from the user's phone (section 6). Values of enchilada differ for several (INFERRED: 6 and 6T have different firmware sizes), unknown without a dump from a 6.
4. Evidence on a booted Enxerto: Enxerto sees the ABL DTB: compare its `/` `compatible`/`model` (after the DTBO overlay) against what the user's 6T gives (record it once with `oem dtb`, audit F-27/F-35);
   refuse to start a payload on a mismatch. UNVERIFIED what the string is (mainline names it `oneplus,fajita`; the downstream/overlaid DTB may differ).
5. Human confirmation: show the full `getvar all` dump (collected with `getvar:all`, INFO lines) and require ticking "this is a OnePlus 6T (A6010/A6013)" before enabling Flash (cheap, catches a 6 owner).
6. Store the dump into the install log and, once, into `docs/FAJITA.md` (without serialno) so a later whitelist can be pinned to `version-bootloader`/`hw-revision` seen there. AGENTS.md: keep serial numbers out of git.

## 4. Slot handling for `flash:boot`

- AOSP fastboot (host tool) resolves a slotted partition itself: `has-slot:<p>` yes => appends `_<current-slot>` unless `--slot` is given (INFERRED from fastboot docs; the README fetched does not state it).
  fastboot.js (kdrag0n, via docs page kdrag0n.github.io/fastboot.js/docs/fastboot.js.html, licence not shown there; GitHub repo says MIT per our own `fastboot.ts` header, UNVERIFIED): `flashBlob`
  asks `has-slot:<partition>`; if `yes` it flashes `<partition>_<current-slot>`; `current-slot` has a leading underscore stripped, fallback 'a' on error (the e.foundation fork commit).
- Our `apps/web/src/lib/fastboot.ts` sends the literal `flash:boot` / `flash:logo` / `flash:userdata` (allow-list regex at `allowed()`, line ~19). On a OnePlus ABL the bare name's behaviour is UNVERIFIED
  (the OnePlus ABL may or may not alias `boot` to the active slot). **Do the host tool's job**: `has-slot:boot` => `flash:boot_<current-slot>`; refuse if `has-slot` fails; allow-list `boot_a`/`boot_b` and
  `logo_a`/`logo_b` (names UNVERIFIED for logo; check `partition-size:logo_a`), keep userdata unsuffixed. Never `set_active` from the page (AUDIT_BOOT_CHAIN R4: the runbook does it by hand).
- `fastboot boot` writes nothing; on the 6T it works best with the matching active slot (audit boot chain F-14, forum-sourced, UNVERIFIED).
- Record `current-slot` and `slot-successful:a/b`, `slot-retry-count:*` in the log before touching anything (audit).

## 5. What other flashers do for device checks and partial-image safety

| Tool | Device check | Partial-write safety | Source |
|---|---|---|---|
| AOSP `fastboot flashall`/`update` | `android-info.txt`/`board-info.txt` `require board=a\|b`, `require version-bootloader=`, compared to getvar `product` / `version-bootloader`; aborts on mismatch | sparse split to `max-download-size`; each chunk `download`+`flash`; no atomicity, no read-back | fastboot README (partial), Lineage `board-info.txt` (OBSERVED) |
| fastboot.js / GrapheneOS web installer | factory images carry `android-info.txt`; the web installer checks the board requirement against the device before flashing (forum statement, via search, UNVERIFIED code) | splits raw images with `Sparse.splitBlob` to `max-download-size`, capped at 1 GiB, default 512 MiB when unknown; **no retries** of USB transfers, getvar timeout 10 s, `FAIL` normalised to undefined | docs page above (OBSERVED) |
| Google web flasher (flash.android.com), Pixel Flasher, Heimdall-like web tools | not fetched | not fetched | UNVERIFIED, not read |
| ours | `product` only; allow-list of commands/partitions | none beyond size check | `flasher.ts`, `fastboot.ts` |

Guards worth copying (ideas, no code): board requirement alternatives list (`sdm845|OnePlus6T`) plus a second variable; `max-download-size` clamp and 512 MiB default; strip/normalise `current-slot`; treat `FAIL`
as "unknown" and refuse writes; refuse `userdata` flash if the image's first sparse chunk does not contain an HFS+ header at 1024 (audit F-03); write the image to a `.partial` name until complete; after
the last piece run Bergamota's `oem verify:1` (read-back, `BERGAMOTA_FASTBOOT.md` line 93) or compare `oem hash`-style checks (`tools/bergamota-flash.py hash userdata --length`).

## 6. How to get the missing facts (small, safe)
Run once on the user's 6T in ABL fastboot: `fastboot getvar all 2>&1 | tee dump.txt` plus `fastboot oem device-info`, `fastboot getvar partition-size:userdata`, `has-slot:boot`, `current-slot`, `slot-count`
(read-only). Commit a copy with `serialno`/`imei` removed to `docs/FAJITA.md` (a "getvar fingerprint" table). Also dump the 6 (enchilada) only if a 6 owner is available: not needed for the 6T guard.

## 7. Where I looked and found nothing
- Real OnePlus 6T/6 `getvar all`: not on the pages returned (XDA threads not fetched in full, Lineage wiki install pages, mobile-nixos fajita page, pmOS deviceinfo (no getvar), ayakael pmaports,
  gist OnePlus6T-Restore). Not fetched: XDA OnePlus 6T unlock threads, GitHub issues in fastboot tools.
- GrapheneOS `factory.ts`/`web-install.js` and fastboot.js `fastboot.ts` raw sources returned 404 for the paths I guessed; I used the generated docs page and search summaries instead.
- Licence: Lineage device trees Apache-2.0 (not checked), AOSP README Apache-2.0, fastboot.js MIT (UNVERIFIED here): everything above is facts/ideas; no code was copied.
