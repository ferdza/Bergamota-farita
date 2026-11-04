// The page's side of the patcher: starts the worker, fetches the AEA key through this site's own /api/fcs-key
// (Apple's key host sends no CORS headers), and hands back the finished image as a File backed by OPFS.

import type { BuildConfig, BuildSummary, IpswInfo } from "./wasm.ts";
import type { FromWorker, ToWorker } from "./worker.ts";

export type PatchEvent = Extract<FromWorker, { type: "event" }>;

/** Disk the finished image and its work need in the browser's storage, per profile: the iOS 18 root is
 * 15.2 GiB (docs/IOS18_PORT.md), the iOS 26 root ~18 GiB; each gets ~2-4 GiB of margin. */
const NEEDED: Record<string, number> = { ios18: 17 * 2 ** 30, ios26: 22 * 2 ** 30 };
export const NEEDED_BYTES = NEEDED.ios26; // the largest, for copy that does not know the profile
export function neededBytes(profile?: string | null): number {
  return (profile && NEEDED[profile]) || NEEDED_BYTES;
}

export function patcherSupported(): boolean {
  return typeof Worker !== "undefined" && typeof WebAssembly !== "undefined" && typeof navigator.storage?.getDirectory === "function"; // createSyncAccessHandle exists only inside a worker
}

/** Chrome sizes an origin's quota from the FREE space of the disk holding the browser profile (no flag
 * raises it), so "not enough room" means: free space on that disk. */
export async function storageRoom(needed = NEEDED_BYTES): Promise<{ free: number; needed: number; ok: boolean }> {
  const est = await navigator.storage.estimate();
  const free = (est.quota ?? 0) - (est.usage ?? 0);
  return { free, needed, ok: free >= needed };
}

/** Through this site's /api/fcs-key relay (Cloudflare host only: a static host such as GitHub Pages has no
 * relay, and Apple's key host sends no CORS headers). Callers fall back to asking the user for the key file. */
export async function fetchKey(keyUrl: string): Promise<string> {
  const r = await fetch(`/api/fcs-key?url=${encodeURIComponent(keyUrl)}`);
  if (!r.ok) throw new Error(`Could not get the decryption key for Apple's image (${r.status}). Try again in a moment.`);
  const pem = await r.text();
  if (pemProblem(pem)) throw new Error("The key server answered with something that is not a key.");
  return pem;
}

/** The distinct key URLs an IPSW's encrypted images need. */
export function keyUrls(info: IpswInfo): string[] {
  return [...new Set(info.images.map((i) => i.keyUrl).filter((u): u is string => !!u))];
}

/** Checks a key the user supplied (downloaded from Apple's link); returns a problem or null. */
export function pemProblem(text: string): string | null {
  const t = text.trim();
  if (!t.startsWith("-----BEGIN PRIVATE KEY-----") || !t.includes("-----END PRIVATE KEY-----")) return "That is not the key file: it should start with -----BEGIN PRIVATE KEY-----.";
  if (t.length > 4096) return "That file is too big to be Apple's key.";
  return null;
}

export class Patcher {
  private worker: Worker;
  private pending: { resolve: (m: FromWorker) => void; reject: (e: Error) => void } | null = null;
  onEvent: (e: PatchEvent) => void = () => {};

  constructor() {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.type === "event") return this.onEvent(m);
      const p = this.pending;
      this.pending = null;
      if (m.type === "error") p?.reject(new Error(m.message));
      else p?.resolve(m);
    };
    this.worker.onerror = (e) => {
      const p = this.pending;
      this.pending = null;
      p?.reject(new Error(e.message || "the patcher stopped"));
    };
  }

  private call(m: ToWorker): Promise<FromWorker> {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.worker.postMessage(m);
    });
  }

  async open(ipsw: File): Promise<IpswInfo> {
    const r = await this.call({ type: "open", ipsw });
    return (r as Extract<FromWorker, { type: "info" }>).info as IpswInfo;
  }

  /** Runs the build and returns the image (a File in OPFS) with its summary. */
  async build(info: IpswInfo, config: BuildConfig = {}, tools?: File): Promise<{ file: File; summary: BuildSummary }> {
    const pems: Record<string, string> = { ...config.pems };
    for (const url of new Set(info.images.map((i) => i.keyUrl).filter((u): u is string => !!u))) pems[url] ??= await fetchKey(url);
    const r = await this.call({ type: "build", config: { ...config, pems, tools: !!tools }, tools });
    const summary = (r as Extract<FromWorker, { type: "done" }>).summary as BuildSummary;
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle("bergamota-userdata.simg");
    return { file: await fh.getFile(), summary };
  }

  terminate() {
    this.worker.terminate();
  }
}

/** The prebuilt on-device tools (SSH server, first-boot helpers) this site hosts: null when the site has none. */
export async function fetchTools(): Promise<File | null> {
  try {
    const r = await fetch(import.meta.env.BASE_URL + "tools/berga-tools.zip");
    if (!r.ok || !(r.headers.get("content-type") ?? "").match(/zip|octet-stream/)) return null;
    return new File([await r.blob()], "berga-tools.zip");
  } catch {
    return null;
  }
}

/** One-line check of an SSH public key; returns a problem or null. */
export function sshKeyProblem(key: string): string | null {
  const k = key.trim();
  if (!k) return null;
  if (k.includes("\n")) return "Paste one line: the contents of your id_ed25519.pub.";
  if (/PRIVATE KEY/.test(k)) return "That is a private key. Never paste it anywhere: use the .pub file.";
  if (!/^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp\d+|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/=]+( .*)?$/.test(k)) return "That is not an SSH public key (it starts with ssh-ed25519, ssh-rsa or ecdsa-).";
  return null;
}

/** Deletes the finished image from the browser's storage. */
export async function discardImage(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("bergamota-userdata.simg");
  } catch {
    /* none */
  }
}

export interface StoredImage {
  name: string;
  size: number;
  file: File;
}

/** Every image a patcher run left in this browser's private storage (OPFS). */
export async function storedImages(): Promise<StoredImage[]> {
  try {
    const root = await navigator.storage.getDirectory();
    const out: StoredImage[] = [];
    for await (const [name, h] of root as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      if (h.kind === "file" && /\.(s?img)$/i.test(name)) {
        const file = await (h as FileSystemFileHandle).getFile();
        out.push({ name, size: file.size, file });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** Deletes one image by name from the browser's private storage. */
export async function removeStored(name: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(name);
  } catch {
    /* already gone */
  }
}
