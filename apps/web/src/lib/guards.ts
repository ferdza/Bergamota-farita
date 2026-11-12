// Pure safety checks for the flasher and the app installer (docs/audit/AUDIT_USERLAND_INSTALL.md F-01..F-04).
// Nothing here talks to USB or SSH: every function takes plain data, so test/guards.test.ts covers it.

import type { Image, ByteSource } from "./sparse.ts";

// ---------------------------------------------------------------------------------------------------------------
// F-03: a userdata image must be a finished HFS+ / HFSX volume
// ---------------------------------------------------------------------------------------------------------------

/**
 * Reads `length` bytes at `offset` of the EXPANDED image (what would land on the partition): raw runs come from the
 * source, FILL runs repeat their u32, gaps (DONT_CARE) read as zeros. Only meant for tiny reads (a volume header).
 */
export async function readExpanded(src: ByteSource, img: Image, offset: number, length: number): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  const bs = img.blockSize;
  for (let i = 0; i < length; ) {
    const pos = offset + i;
    const block = Math.floor(pos / bs);
    const inBlock = pos - block * bs;
    const n = Math.min(length - i, bs - inBlock);
    const seg = img.segments.find((s) => block >= s.block && block < s.block + s.blocks);
    if (seg?.kind === "raw") {
      const got = await src.read(seg.offset + (block - seg.block) * bs + inBlock, n);
      out.set(got.subarray(0, n), i);
    } else if (seg?.kind === "fill") {
      for (let k = 0; k < n; k++) out[i + k] = (seg.value >>> (8 * ((inBlock + k) & 3))) & 0xff;
    }
    i += n;
  }
  return out;
}

/**
 * Returns a problem string, or null when the image starts like an HFS+ ("H+", version 4) or HFSX ("HX", version 5)
 * volume. The volume header sits 1024 bytes into the volume. A patch that was cancelled leaves a file whose sparse
 * header is still zeros (SparseWriter writes the real header in finish()); it reads as a raw image without this
 * signature, as does any random 100 MB file, so neither can be flashed over userdata.
 */
export async function hfsVolumeProblem(src: ByteSource, img: Image, name: string): Promise<string | null> {
  if (img.expandedBytes < 4096) return `${name} is too small to hold a volume header.`;
  const h = await readExpanded(src, img, 1024, 4);
  const sig = String.fromCharCode(h[0], h[1]);
  const version = (h[2] << 8) | h[3];
  if ((sig === "H+" && version === 4) || (sig === "HX" && version === 5)) return null;
  const sparseNote = img.sparse
    ? ""
    : " It is not a sparse image either: an unfinished or cancelled patch leaves such a file. Run the patch again and wait for it to finish.";
  return `${name} does not start with an HFS+ volume header (found ${JSON.stringify(sig)} v${version}), so it is not an iOS root.${sparseNote}`;
}

// ---------------------------------------------------------------------------------------------------------------
// F-02: slot awareness, typed confirmation and the backup gate
// ---------------------------------------------------------------------------------------------------------------

export interface SlotInfo {
  /** `getvar current-slot`: "a", "b", with or without a leading underscore; null when the variable is absent. */
  currentSlot: string | null;
  /** `getvar slot-count`; null when absent. */
  slotCount: number | null;
}

/** "a" / "b" from the strings ABLs use ("a", "_a", "b"), or null. */
export function normalizeSlot(v: string | null | undefined): "a" | "b" | null {
  const m = /^_?([ab])$/.exec((v ?? "").trim().toLowerCase());
  return m ? (m[1] as "a" | "b") : null;
}

/** True when the phone has A/B slots, i.e. a plain `flash:boot` goes to a slot the ABL picks. */
export function isAB(s: SlotInfo): boolean {
  return (s.slotCount ?? 0) > 1 || normalizeSlot(s.currentSlot) !== null;
}

/**
 * The text the user types to confirm a write. userdata/logo: the partition name. boot on an A/B phone: the slot
 * partition that `flash:boot` will hit ("boot_a"), so the user sees which slot is overwritten.
 */
export function confirmPhrase(partition: string, s: SlotInfo): string {
  if (partition !== "boot") return partition;
  const slot = normalizeSlot(s.currentSlot);
  return isAB(s) && slot ? `boot_${slot}` : "boot";
}

/** Reasons a write to `partition` must not be enabled yet, beyond the image checks. */
export function writeProblems(partition: string, s: SlotInfo, backupAck: boolean): string[] {
  const out: string[] = [];
  if (partition === "boot" && isAB(s) && !normalizeSlot(s.currentSlot)) {
    out.push("This phone has two boot slots but did not say which one is active (getvar current-slot), so the page cannot tell you which boot partition would be overwritten.");
  }
  if ((partition === "boot" || partition === "userdata") && !backupAck) {
    out.push(`Tick the backup box first: ${partition} is overwritten and cannot be restored from this page.`);
  }
  return out;
}

export const BACKUP_TEXT =
  "I have a backup of this phone's boot, modem, persist and Android data (docs/INSTALL.md), or I accept losing them.";

// ---------------------------------------------------------------------------------------------------------------
// F-04: IPA install / removal must never touch system apps
// ---------------------------------------------------------------------------------------------------------------

/** Folder name rule shared by install and removal. */
export const APP_NAME_RE = /^[A-Za-z0-9 ._+-]+\.app$/;

/**
 * Apple's stock app bundles on iOS 18 (folder names under /Applications) plus the processes that live there.
 * A conservative list: anything that is not on the user's own side-loaded list must not be replaced by an IPA.
 */
export const SYSTEM_APPS: readonly string[] = [
  "SpringBoard", "MobileSafari", "MobilePhone", "MobileSMS", "MobileMail", "MobileSlideShow", "MobileNotes", "MobileTimer",
  "MobileStore", "MobileAddressBook", "MobileCal", "Preferences", "Camera", "Photos", "Music", "Maps", "Weather", "Calculator",
  "Compass", "Contacts", "Calendar", "Clock", "FaceTime", "Files", "Health", "Home", "Magnifier", "Measure", "News", "Notes",
  "Reminders", "Stocks", "Tips", "Translate", "VoiceMemos", "Wallet", "Watch", "Podcasts", "Books", "Shortcuts", "Passbook",
  "AppStore", "iBooks", "MusicUI", "Spotlight", "PosterBoard", "FindMy", "Fitness", "Journal", "Freeform", "Sidecar", "Setup",
  "Diagnostics", "AACredentialAgent", "AXRemoteService", "BluetoothUIService", "CarPlay", "CheckerBoard", "ClipViewService",
  "DDActionsService", "FieldTest", "Print Center", "SafariViewService", "Siri", "TrustMe", "WebSheet", "WebContentAnalysisUI",
  "FTMInternal-4", "HealthPrivacyService", "InCallService", "MailCompositionService", "MessagesViewService", "MusicCoreUI",
  "Remote", "ScreenshotServicesService", "SharedWebCredentialViewService", "SIMSetupUIService", "SLYLoginService",
  "StoreKitUIService", "TVRemote", "WebViewService", "iCloud", "Apple TV Remote", "Find My", "Voice Memos", "App Store",
].map((n) => n.toLowerCase());

/** Why `app` ("Name.app") may not be installed over or removed, or null when its NAME is acceptable. */
export function appNameProblem(app: string): string | null {
  if (!APP_NAME_RE.test(app) || app.startsWith(".") || app.includes("..")) return `refusing the app folder name ${JSON.stringify(app)}`;
  const base = app.slice(0, -4).toLowerCase();
  if (SYSTEM_APPS.includes(base) || base.startsWith("com.apple.")) return `${app} is a system app (refused: replacing or deleting it can leave the phone without a home screen)`;
  return null;
}

/** An IPA whose bundle id is Apple's is never installed (it would shadow or replace a stock app). */
export function bundleIdProblem(bundleId: string): string | null {
  return /^com\.apple\./i.test(bundleId) ? `bundle id ${bundleId} belongs to Apple (refused)` : null;
}

export const SIDELOAD_DIR = "/usr/local/share/bergamota/sideloaded";

/** Single-quote for sh. */
function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The shell run on the phone to install an app from a tar on stdin. Safe by construction:
 *  - extracts into a staging folder first; /Applications is only touched by one `mv` after tar succeeded;
 *  - an existing /Applications/Name.app is replaced only if the phone's own sideload list (outside the bundle,
 *    so the code signature seal is untouched) has it, or if its Info.plist does not mention com.apple.;
 *  - the old copy is kept as a backup until the new one is in place, and put back if the move fails.
 * `appsDir`, `markerDir`, `uic` and `owner` (empty = no chown) are parameters only so the test can run the script in a temp folder.
 */
export function installScript(app: string, appsDir = "/Applications", markerDir = SIDELOAD_DIR, uic = "/usr/local/bin/sweetuicache", owner = "0:80"): string {
  const bad = appNameProblem(app);
  if (bad) throw new Error(bad);
  const A = q(app);
  const M = q(`${markerDir}/${app}`);
  return [
    "export PATH=$PATH:/usr/local/bin:/usr/bin:/bin",
    `cd ${q(appsDir)} || exit 20`,
    `S=.bergamota-stage-$$; rm -rf "$S"; mkdir "$S" || exit 21`,
    `if [ -d ${A} ] && [ ! -e ${M} ] && grep -qa 'com\\.apple\\.' ${A}/Info.plist 2>/dev/null; then echo "refusing: ${app.replace(/"/g, "")} looks like a system app (no sideload marker, Apple bundle id)"; rm -rf "$S"; exit 22; fi`,
    `tar -xf - -C "$S" || { rm -rf "$S"; echo "tar failed: nothing changed"; exit 23; }`,
    `[ -d "$S"/${A} ] || { rm -rf "$S"; echo "the archive has no ${app.replace(/"/g, "")}: nothing changed"; exit 24; }`,
    `${owner ? `chown -R ${owner} "$S"/${A} && ` : ""}chmod -R u+rwX,go+rX "$S"/${A} || { rm -rf "$S"; exit 25; }`,
    `rm -rf "$S.old"; if [ -d ${A} ]; then mv ${A} "$S.old" || { rm -rf "$S"; exit 26; }; fi`,
    `if mv "$S"/${A} ${A}; then rm -rf "$S.old" "$S"; else [ -d "$S.old" ] && mv "$S.old" ${A}; rm -rf "$S"; echo "move failed: old copy restored"; exit 27; fi`,
    `mkdir -p ${q(markerDir)} && : > ${M}`,
    `${q(uic)} ${A} 2>&1; echo "exit $?"`,
  ].join("; ");
}

/** The shell to remove a side-loaded app: refuses system apps, and apps without the marker that carry an Apple bundle id. */
export function removeScript(app: string, appsDir = "/Applications", markerDir = SIDELOAD_DIR, uic = "/usr/local/bin/sweetuicache"): string {
  const bad = appNameProblem(app);
  if (bad) throw new Error(bad);
  const A = q(app);
  const M = q(`${markerDir}/${app}`);
  return [
    `cd ${q(appsDir)} || exit 20`,
    `[ -d ${A} ] || { echo "no such app: ${app.replace(/"/g, "")}"; exit 21; }`,
    `if [ ! -e ${M} ] && grep -qa 'com\\.apple\\.' ${A}/Info.plist 2>/dev/null; then echo "refusing: ${app.replace(/"/g, "")} looks like a system app (no sideload marker, Apple bundle id)"; exit 22; fi`,
    `${q(uic)} -u ${A}; rm -rf ${A} && rm -f ${M} && echo removed ${A}`,
  ].join("; ");
}
