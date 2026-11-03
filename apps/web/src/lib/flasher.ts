// What the page does with a phone and an image: identify the phone, check the image against the partition,
// plan the pieces, and flash them one by one. Mirrors the Mac app's rules (apps/Bergamota UserdataFlash.swift):
// userdata / boot / logo only, boot must be an Android boot image of 1-64 MiB, logo 1-32 MiB, a root at least 64 MiB.

import { FastbootDevice, FastbootError, type Partition } from "./fastboot.ts";
import { parseImage, pieceBytes, planPieces, type ByteSource, type Image, type Piece } from "./sparse.ts";

export const MiB = 1 << 20;
/** ABL failed with one 3 GB transfer when fastboot could not read max-download-size; 512 MiB pieces work (Mac app). */
export const SAFE_PIECE = 512 * MiB;

export interface PhoneInfo {
  product: string | null;
  kind: "abl" | "bergamota";
  bootloader: string | null;
  unlocked: string | null;
  maxDownload: number | null;
  bergamotaFlash: boolean;
  usbSpeed: string | null;
  partitionSize: Partial<Record<Partition, number>>;
  vars: [string, string][];
}

export async function identify(fb: FastbootDevice): Promise<PhoneInfo> {
  const vars: [string, string][] = [];
  const get = async (name: string) => {
    const v = await fb.getvar(name);
    if (v !== null) vars.push([name, v]);
    return v;
  };
  const product = await get("product");
  const bootloader = await get("version-bootloader");
  const unlocked = await get("unlocked");
  const max = await get("max-download-size");
  const bergamota = bootloader?.startsWith("bergamota-") ?? false;
  const bergamotaFlash = bergamota && (await get("bergamota-flash")) === "1";
  const usbSpeed = bergamota ? await get("usb-speed") : null;
  const partitionSize: Partial<Record<Partition, number>> = {};
  for (const p of ["userdata", "boot", "logo"] as Partition[]) {
    const v = await get(`partition-size:${p}`);
    const n = v ? parseNumber(v) : null;
    if (n) partitionSize[p] = n;
  }
  return {
    product,
    kind: bergamota ? "bergamota" : "abl",
    bootloader,
    unlocked,
    maxDownload: max ? parseNumber(max) : null,
    bergamotaFlash,
    usbSpeed,
    partitionSize,
    vars,
  };
}

function parseNumber(v: string): number | null {
  const n = /^0x[0-9a-f]+$/i.test(v) ? parseInt(v, 16) : /^\d+$/.test(v) ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Phones the flasher supports, keyed by the fastboot `product` string -> display name.
 * Both are SDM845 and share the iOS-18 (iPhone11,8) root; they differ only in the boot
 * image (the board's Enxerto) and their device specifics in the kernel.
 * NOTE: confirm the OnePlus 6T's exact `fastboot getvar product` on-device; if it is not
 * literally "fajita", add that string here (the gate stays safe meanwhile — it blocks and
 * shows the real product so it can be added). */
export const SUPPORTED_PRODUCTS: Record<string, string> = {
  beryllium: "Poco F1",
  // OnePlus's ABL reports the SoC, not the codename: `fastboot getvar product` -> "sdm845"
  // on the OnePlus 6T (fajita). Confirmed on-device 2026-11-03.
  sdm845: "OnePlus 6T",
};

/** Friendly phone name for the UI, or the raw product string. */
export function productName(product: string | null): string {
  return (product && SUPPORTED_PRODUCTS[product]) ?? product ?? "unknown";
}

/** Reasons the page refuses to write to this phone at all. */
export function phoneProblems(p: PhoneInfo): string[] {
  const out: string[] = [];
  if (!p.product || !(p.product in SUPPORTED_PRODUCTS)) {
    const names = Object.values(SUPPORTED_PRODUCTS).join(" and ");
    out.push(`Unsupported phone: it says it is "${p.product ?? "unknown"}". Bergamota supports ${names}.`);
  }
  if (p.kind === "abl" && p.unlocked !== "yes") out.push("The bootloader is locked. Unlock it first (Xiaomi's unlock tool); a locked bootloader refuses every flash.");
  if (p.kind === "bergamota" && !p.bergamotaFlash) out.push("This Bergamota fastboot is too old to flash (no bergamota-flash). Use the phone's own fastboot: Power + Volume down.");
  return out;
}

/** Download size actually used: the phone's limit, capped (512 MiB by default). */
export function pieceSize(p: PhoneInfo, cap = SAFE_PIECE): number {
  return Math.min(p.maxDownload ?? SAFE_PIECE, cap);
}

export interface Checked {
  image: Image;
  pieces: Piece[];
  problems: string[];
}

/** Validates an image for a partition (and the phone, when known) and plans its pieces. */
export async function checkImage(src: ByteSource, name: string, partition: Partition, phone: PhoneInfo | null, cap = SAFE_PIECE): Promise<Checked> {
  const problems: string[] = [];
  const image = await parseImage(src);
  const size = src.size;
  if (partition === "userdata") {
    if (size < 64 * MiB) problems.push(`${name} is only ${fmtBytes(size)}: that is not an iOS root image.`);
  } else {
    if (image.sparse) problems.push(`${name} is a sparse image; ${partition} takes a plain image.`);
    if (partition === "boot") {
      // The ANDROID! header is the real check. The size floor is low on purpose: a bootloader-only
      // Enxerto (no kernel payload) is ~0.5 MiB, and `fastboot boot`-ing it is a valid bring-up test;
      // a full iOS boot image (Enxerto + kernel) is ~20 MiB. Both are well under 64 MiB.
      if (size < 64 * 1024 || size > 64 * MiB) problems.push(`${name}: a boot image must be 64 KiB – 64 MiB.`);
      const magic = new TextDecoder().decode(await src.read(0, 8));
      if (magic !== "ANDROID!") problems.push(`${name} is not an Android boot image (no ANDROID! header).`);
    }
    if (partition === "logo" && (size < MiB || size > 32 * MiB)) problems.push(`${name}: a logo image must be 1-32 MiB.`);
  }
  const limit = phone?.partitionSize[partition];
  if (limit && image.expandedBytes > limit) problems.push(`${name} expands to ${fmtBytes(image.expandedBytes)}, but ${partition} holds only ${fmtBytes(limit)}.`);
  const pieces = phone ? planPieces(image, pieceSize(phone, cap)) : planPieces(image, cap);
  if (!pieces.length) problems.push(`${name} contains no data to write.`);
  return { image, pieces, problems };
}

export interface Progress {
  piece: number;
  pieces: number;
  phase: "sending" | "writing" | "done";
  sentBytes: number;
  totalBytes: number;
  startedAt: number;
}

export interface FlashJob {
  fb: FastbootDevice;
  src: ByteSource;
  partition: Partition;
  checked: Checked;
  onProgress: (p: Progress) => void;
  /** Checked between pieces: stop cleanly after the current one. */
  shouldStop?: () => boolean;
}

/** Flashes every piece. Returns false when stopped early. */
export async function flash(job: FlashJob): Promise<boolean> {
  const { fb, src, partition, checked, onProgress } = job;
  if (checked.problems.length) throw new FastbootError(checked.problems[0]);
  const totalBytes = checked.pieces.reduce((n, p) => n + p.bytes, 0);
  const startedAt = performance.now();
  let sentBytes = 0;
  for (let i = 0; i < checked.pieces.length; i++) {
    if (i > 0 && job.shouldStop?.()) return false;
    const piece = checked.pieces[i];
    const report = (phase: Progress["phase"]) => onProgress({ piece: i + 1, pieces: checked.pieces.length, phase, sentBytes, totalBytes, startedAt });
    report("sending");
    await fb.download(piece.bytes, pieceBytes(src, checked.image, piece), (n) => {
      sentBytes += n;
      report("sending");
    });
    report("writing");
    await fb.flash(partition);
  }
  onProgress({ piece: checked.pieces.length, pieces: checked.pieces.length, phase: "done", sentBytes, totalBytes, startedAt });
  return true;
}

export interface BootJob {
  fb: FastbootDevice;
  src: ByteSource;
  onProgress: (p: Progress) => void;
}

/** Streams a plain boot image whole and runs it once with `fastboot boot`.
 * Nothing is written to any partition: the phone loads this image and boots it
 * now, and the next restart returns to normal. This is the Mac app's Boot Queue
 * and the safe way to try an Enxerto or kernel image during bring-up. */
export async function bootImage(job: BootJob): Promise<void> {
  const { fb, src, onProgress } = job;
  const total = src.size;
  const startedAt = performance.now();
  let sentBytes = 0;
  const report = (phase: Progress["phase"]) => onProgress({ piece: 1, pieces: 1, phase, sentBytes, totalBytes: total, startedAt });
  report("sending");
  await fb.download(total, rawBytes(src), (n) => {
    sentBytes += n;
    report("sending");
  });
  report("writing"); // here "writing" means the phone is loading and starting the image
  await fb.boot();
  onProgress({ piece: 1, pieces: 1, phase: "done", sentBytes: total, totalBytes: total, startedAt });
}

/** The whole source, verbatim, in buffers of `bufBytes` (a boot image is sent as-is, never resparsed). */
async function* rawBytes(src: ByteSource, bufBytes = 1 << 20): AsyncGenerator<Uint8Array> {
  for (let o = 0; o < src.size; o += bufBytes) yield await src.read(o, Math.min(bufBytes, src.size - o));
}

export function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} bytes`;
}

export function fmtDuration(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "–";
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m}:${String(r).padStart(2, "0")}`;
}
