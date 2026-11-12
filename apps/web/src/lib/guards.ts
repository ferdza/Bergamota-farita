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
  /** `getvar has-slot:boot` ("yes"/"no"); null when absent. */
  hasSlotBoot?: string | null;
}

/** The slot `flash:boot` must name on this phone ("a"/"b"), or null for a phone without slots (plain `flash:boot`). */
export function bootSlot(s: SlotInfo): "a" | "b" | null {
  return isAB(s) && s.hasSlotBoot === "yes" ? normalizeSlot(s.currentSlot) : null;
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
  } else if (partition === "boot" && isAB(s) && s.hasSlotBoot !== "yes") {
    out.push("This phone has two boot slots but does not confirm that boot is slotted (getvar has-slot:boot), so the page will not guess the partition name.");
  }
  if ((partition === "boot" || partition === "userdata") && !backupAck) {
    out.push(`Tick the backup box first: ${partition} is overwritten and cannot be restored from this page.`);
  }
  return out;
}

export const BACKUP_TEXT =
  "I have a backup of this phone's boot, modem, persist and Android data (docs/INSTALL.md), or I accept losing them.";

// ---------------------------------------------------------------------------------------------------------------
// F-01: which phone is this, really
// ---------------------------------------------------------------------------------------------------------------

/**
 * `getvar product` is the SoC ("sdm845") on the OnePlus ABL, so it cannot tell a OnePlus 6T from a OnePlus 6 or any other
 * SDM845 phone (Lineage's board-info files use `board=sdm845` for both). No fastboot variable that separates them has
 * been captured from a real 6T yet (docs/reference-snippets/FLASHER_GUARDS.md), so:
 *  - "exact": the product string names the phone itself (Poco F1's "beryllium", Enxerto's own fastboot "fajita"), or the
 *    getvar fingerprint of a captured 6T matches (FAJITA_FINGERPRINTS, empty until someone captures one);
 *  - "unverified": product sdm845 and nothing contradicts it. Writes need the user to type OVERRIDE_PHRASE after seeing
 *    the variables the phone answered;
 *  - "refused": anything else, or contradicting evidence (one boot slot: the 6T is A/B).
 */
export interface IdentityInfo {
  product: string | null;
  kind: "abl" | "bergamota";
  slotCount: number | null;
  /** every getvar the page asked (name -> value) */
  vars: [string, string][];
}

export type Verdict = { level: "exact"; name: string } | { level: "unverified"; name: string } | { level: "refused"; reason: string };

export const OVERRIDE_PHRASE = "this is a OnePlus 6T";

/** getvar fingerprints of a real, captured OnePlus 6T ABL: every listed variable must equal. Empty until captured. */
export const FAJITA_FINGERPRINTS: Record<string, string>[] = [];

export function identityVerdict(p: IdentityInfo): Verdict {
  const v = new Map(p.vars);
  if (p.product === "beryllium") return { level: "exact", name: "Poco F1" };
  if (p.kind === "bergamota" && p.product === "fajita") return { level: "exact", name: "OnePlus 6T" };
  if (p.product === "sdm845") {
    if (p.slotCount !== null && p.slotCount < 2) return { level: "refused", reason: `It says product "sdm845" but has ${p.slotCount} boot slot(s); the OnePlus 6T is A/B. This is another phone.` };
    if (FAJITA_FINGERPRINTS.some((f) => Object.entries(f).every(([k, val]) => v.get(k) === val))) return { level: "exact", name: "OnePlus 6T" };
    return { level: "unverified", name: "OnePlus 6T?" };
  }
  return { level: "refused", reason: `Unsupported phone: it says it is "${p.product ?? "unknown"}". Bergamota supports Poco F1 and OnePlus 6T.` };
}

/** Problems for the connect step: refused phones, and unverified ones until the user typed the phrase. */
export function identityProblems(p: IdentityInfo, typed: string): string[] {
  const v = identityVerdict(p);
  if (v.level === "refused") return [v.reason];
  if (v.level === "unverified" && typed.trim() !== OVERRIDE_PHRASE) {
    return [
      `This phone reports "sdm845", which every OnePlus 6, 6T and other Snapdragon 845 phones do: the page cannot confirm it is a OnePlus 6T. ` +
        `Check the variables below (Settings > About phone says "ONEPLUS A6013" on a 6T), then type "${OVERRIDE_PHRASE}" to continue.`,
    ];
  }
  return [];
}

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
    `echo "[1/4] receiving and unpacking ${app.replace(/"/g, "")}"`,
    `tar -xf - -C "$S" || { rm -rf "$S"; echo "tar failed: nothing changed"; exit 23; }`,
    `[ -d "$S"/${A} ] || { rm -rf "$S"; echo "the archive has no ${app.replace(/"/g, "")}: nothing changed"; exit 24; }`,
    `${owner ? `chown -R ${owner} "$S"/${A} && ` : ""}chmod -R u+rwX,go+rX "$S"/${A} || { rm -rf "$S"; exit 25; }`,
    `rm -rf "$S.old"; if [ -d ${A} ]; then mv ${A} "$S.old" || { rm -rf "$S"; exit 26; }; fi`,
    `if mv "$S"/${A} ${A}; then rm -rf "$S.old" "$S"; else [ -d "$S.old" ] && mv "$S.old" ${A}; rm -rf "$S"; echo "move failed: old copy restored"; exit 27; fi`,
    `mkdir -p ${q(markerDir)} && : > ${M}`,
    `echo "[2/4] installed in ${appsDir}, registering with LaunchServices"`,
    `if command -v timeout >/dev/null 2>&1; then timeout 90 ${q(uic)} ${A} 2>&1; else ${q(uic)} ${A} 2>&1; fi; echo "[3/4] sweetuicache exit $? (124 = timed out after 90 s)"`,
    `echo "[4/4] done"`,
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
