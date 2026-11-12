// The flasher's state: which path (patch an IPSW, or flash an image), the phone, the chosen image and the
// flash itself. One instance per page.

import { ALLOWED_PARTITIONS, FastbootDevice, FastbootError, type LogKind, type Partition } from "../lib/fastboot.ts";
import { bootImage, checkImage, flash, identify, phoneProblems, SAFE_PIECE, type Checked, type PhoneInfo, type Progress } from "../lib/flasher.ts";
import { blobSource, type ByteSource } from "../lib/sparse.ts";
import { discardImage, fetchKey, fetchTools, keyUrls, neededBytes, Patcher, pemProblem, sshKeyProblem, storageRoom } from "../patcher/patcher.ts";
import { profileForIpsw } from "../lib/profiles.ts";
import type { BuildSummary, IpswInfo } from "../patcher/wasm.ts";

export type Path = "patch" | "image";
export const STEPS: Record<Path, string[]> = {
  patch: ["IPSW", "Patch", "Connect", "Confirm", "Flash"],
  image: ["Connect", "Choose", "Confirm", "Flash"],
};

export interface LogLine {
  kind: LogKind;
  text: string;
  at: number;
}

/** The patcher's stages in the order the module reports them, with what to tell the user. */
export const PATCH_STAGES: [string, string][] = [
  ["open", "Open the IPSW and decrypt its disk images"],
  ["copy", "Merge the root and the cryptexes"],
  ["scan", "Find the programs among 235,000 files"],
  ["tweaks", "Apply Bergamota's first-boot changes"],
  ["macho", "Rewrite and re-sign every program"],
  ["cache", "Rewrite the shared cache"],
  ["seal", "Write the HFS+ root as a sparse image"],
];

export interface Picked {
  name: string;
  size: number;
  from: "file" | "browser";
  src: ByteSource;
}

class Session {
  path = $state<Path>(location.hash === "#image" ? "image" : "patch");
  step = $state(0);
  advanced = $state(false);

  fb = $state.raw<FastbootDevice | null>(null);
  phone = $state.raw<PhoneInfo | null>(null);
  phoneProblems = $state.raw<string[]>([]);
  connecting = $state(false);
  connectError = $state<string | null>(null);

  ipsw = $state.raw<File | null>(null);

  patchState = $state<"idle" | "running" | "done" | "error">("idle");
  patchError = $state<string | null>(null);
  patchStage = $state<string>("");
  patchNote = $state("");
  patchBytes = $state({ done: 0, total: 0 });
  patchStartedAt = $state(0);
  sshKey = $state(safeGet("bergamota.sshKey"));
  patchInfo = $state.raw<IpswInfo | null>(null);
  patchSummary = $state.raw<BuildSummary | null>(null);
  /** Chlorophyll (GPU 3D) in the root: set from the build's own `chlorophyll:` log line; null until the tweaks ran. */
  patchGpu = $state<{ ok: boolean; text: string } | null>(null);
  private patcher: Patcher | null = null;
  // Apple's AEA keys the user must fetch by hand when this host has no /api/fcs-key relay (GitHub Pages)
  keysNeeded = $state<string[]>([]);
  keysGot = $state<Record<string, string>>({});
  keyError = $state<string | null>(null);
  /** The pre-check said the browser's quota is short; the user may skip it (Chrome can misjudge the disk). */
  roomShort = $state(false);
  ignoreRoom = $state(false);
  private keyWaiter: { resolve: (p: Record<string, string>) => void; reject: (e: Error) => void } | null = null;

  partition = $state<Partition>("userdata");
  picked = $state.raw<Picked | null>(null);
  checked = $state.raw<Checked | null>(null);
  checking = $state(false);
  checkError = $state<string | null>(null);

  pieceCap = $state(SAFE_PIECE);
  rebootWhenDone = $state(true);
  // the Flash screen is shared by two operations: writing a partition, and booting an image once (no write)
  op = $state<"flash" | "boot">("flash");
  flashState = $state<"idle" | "flashing" | "done" | "stopped" | "error">("idle");
  flashError = $state<string | null>(null);
  progress = $state.raw<Progress | null>(null);
  stopRequested = $state(false);
  rebooted = $state(false);

  log = $state<LogLine[]>([]);

  get steps() {
    return STEPS[this.path];
  }
  get stepName() {
    return this.steps[this.step];
  }

  setPath(p: Path) {
    if (this.flashState === "flashing") return;
    this.path = p;
    history.replaceState(null, "", p === "image" ? "#image" : location.pathname);
    // keep the phone; restart the flow at the first step that is not done
    this.step = p === "image" ? (this.phone && !this.phoneProblems.length ? 1 : 0) : this.ipsw ? 1 : 0;
  }

  go(name: string) {
    const i = this.steps.indexOf(name);
    if (i >= 0) this.step = i;
  }

  addLog(kind: LogKind, text: string) {
    this.log.push({ kind, text, at: Date.now() });
    if (this.log.length > 500) this.log.splice(0, this.log.length - 500);
  }

  async connect(dev?: USBDevice) {
    if (this.connecting || this.flashState === "flashing") return;
    this.connecting = true;
    this.connectError = null;
    try {
      if (this.fb) await this.fb.close();
      const fb = dev ? await FastbootDevice.open(dev) : await FastbootDevice.request();
      fb.log = (k, t) => this.addLog(k, t);
      this.addLog("note", `opened ${fb.usb.productName ?? "fastboot device"} (${hex(fb.usb.vendorId)}:${hex(fb.usb.productId)})`);
      const phone = await identify(fb);
      this.fb = fb;
      this.phone = phone;
      this.phoneProblems = phoneProblems(phone);
      if (this.picked) await this.recheck();
    } catch (e) {
      const err = e as Error;
      // closing the picker is not an error
      if (err.name !== "NotFoundError") this.connectError = explainUsb(err);
    } finally {
      this.connecting = false;
    }
  }

  disconnected(dev: USBDevice) {
    if (this.fb?.usb !== dev) return;
    this.addLog("note", "the phone was disconnected");
    this.fb = null;
    if (this.flashState === "flashing") {
      this.flashState = "error";
      this.flashError = "The phone disconnected during the flash. Plug it back in (it stays in fastboot) and flash again: the image is written from the start.";
    }
    if (this.flashState !== "done") this.phone = null;
  }

  async pick(file: File | Blob, name: string, from: Picked["from"]) {
    this.picked = { name, size: file.size, from, src: blobSource(file) };
    await this.recheck();
  }

  private checkGen = 0;

  async recheck() {
    if (!this.picked) return;
    // A slow check (an 18 GB sparse root) can finish after a newer one (a boot.img picked meanwhile):
    // only the latest check may write its result, or the wrong image's verdict shows up.
    const gen = ++this.checkGen;
    const { src, name } = this.picked;
    const partition = this.partition;
    this.checking = true;
    this.checkError = null;
    this.checked = null;
    try {
      const c = await checkImage(src, name, partition, this.phone, this.pieceCap);
      if (gen === this.checkGen) this.checked = c;
    } catch (e) {
      if (gen === this.checkGen) this.checkError = (e as Error).message;
    } finally {
      if (gen === this.checkGen) this.checking = false;
    }
  }

  /** Runs the in-browser patcher over the chosen IPSW; the image lands in OPFS and becomes the picked image. */
  async startPatch() {
    const ipsw = this.ipsw;
    if (!ipsw || this.patchState === "running") return;
    this.patchState = "running";
    this.patchError = null;
    this.patchStage = "open";
    this.patchNote = "";
    this.patchBytes = { done: 0, total: 0 };
    this.patchStartedAt = performance.now();
    this.patchSummary = null;
    this.patchGpu = null;
    let lock: WakeLockSentinel | null = null;
    try {
      lock = await navigator.wakeLock?.request("screen").catch(() => null) ?? null;
      // persistent storage is never evicted, and some Chrome builds report a larger quota once granted
      await navigator.storage.persist?.().catch(() => false);
      const room = await storageRoom(neededBytes(profileForIpsw(ipsw.name).profile?.id));
      this.roomShort = !room.ok;
      if (!room.ok && !this.ignoreRoom) {
        const gb = (n: number) => (n / 2 ** 30).toFixed(1);
        throw new Error(
          `This browser can use only ${gb(room.free)} GB here; the root image needs about ${gb(room.needed)} GB. ` +
            `Chrome's limit follows the free space of the disk that holds the browser profile (no flag changes it): ` +
            `free about ${gb(room.needed - room.free)} GB more on that disk (with Flatpak Chrome: the disk of ~/.var/app), ` +
            `or delete old images under Advanced → Browser storage, then try again. ` +
            `If that disk does have the room (Chrome can misjudge it, e.g. Flatpak on an immutable system: compare with chrome://quota-internals), use "Patch anyway".`,
        );
      }
      await discardImage();
      this.patcher?.terminate();
      const p = (this.patcher = new Patcher());
      p.onEvent = (e) => {
        if (e.kind === "stage") this.patchStage = e.text;
        else if (e.kind === "bytes") this.patchBytes = { done: e.done, total: e.total };
        else {
          this.patchNote = e.text;
          this.addLog("note", e.text);
          if (e.text.startsWith("chlorophyll:")) this.patchGpu = { ok: /libraries in/.test(e.text), text: e.text };
        }
      };
      const info = await p.open(ipsw);
      this.patchInfo = info;
      const tools = await fetchTools();
      if (!tools) {
        this.addLog("note", "no tools bundle on this site: the root gets no SSH server, no first-boot helpers and no GPU userland");
        this.patchGpu = { ok: false, text: "chlorophyll: no tools bundle on this site" };
      }
      const key = this.sshKey.trim();
      if (key && sshKeyProblem(key)) throw new Error(sshKeyProblem(key)!);
      safeSet("bergamota.sshKey", key);
      // Apple's decryption keys: through the relay when the host has one, else from the user (see keysNeeded)
      const pems: Record<string, string> = {};
      const urls = keyUrls(info);
      for (const u of urls) {
        try {
          pems[u] = await fetchKey(u);
        } catch {
          /* no relay on this host: asked below */
        }
      }
      const missing = urls.filter((u) => !pems[u]);
      if (missing.length) {
        this.addLog("note", `no key relay on this host: waiting for ${missing.length} key file(s) from the user`);
        Object.assign(pems, await this.waitForKeys(missing));
      }
      const { file, summary } = await p.build(info, { sshKey: key, pems }, tools ?? undefined);
      this.patchSummary = summary;
      this.patchState = "done";
      await this.pick(file, file.name, "browser");
    } catch (e) {
      this.patchState = "error";
      const m = (e as Error).message;
      // a Rust panic aborts the module with a bare "unreachable"; the module logged the reason just before
      this.patchError = /unreachable|out of memory|memory access/i.test(m) && this.patchNote ? `${this.patchNote} (${m})` : m;
      if (/QuotaExceeded|quota/i.test(m) && this.ignoreRoom)
        this.patchError = `Chrome really stopped the writes: its storage limit for this site is too small (${m}). Check chrome://quota-internals, or run Chrome with a profile on a disk it measures correctly (--user-data-dir=…).`;
    } finally {
      this.patcher?.terminate();
      this.patcher = null;
      await lock?.release().catch(() => {});
    }
  }

  private waitForKeys(urls: string[]): Promise<Record<string, string>> {
    this.keysNeeded = urls;
    this.keysGot = {};
    this.keyError = null;
    return new Promise((resolve, reject) => (this.keyWaiter = { resolve, reject }));
  }

  /** The user dropped (or pasted) the key file for `url`. Resumes the patch once every key is in. */
  provideKey(url: string, text: string) {
    const problem = pemProblem(text);
    if (problem) {
      this.keyError = problem;
      return;
    }
    this.keyError = null;
    this.keysGot = { ...this.keysGot, [url]: text.trim() + "\n" };
    if (this.keysNeeded.every((u) => this.keysGot[u])) {
      const got = this.keysGot;
      this.keysNeeded = [];
      this.keyWaiter?.resolve(got);
      this.keyWaiter = null;
    }
  }

  cancelPatch() {
    this.keyWaiter?.reject(new Error("cancelled"));
    this.keyWaiter = null;
    this.keysNeeded = [];
    this.patcher?.terminate();
    this.patcher = null;
    this.patchState = "idle";
  }

  /** Forget the currently chosen image (e.g. it was just deleted from browser storage). */
  forgetPicked() {
    this.checkGen++;
    this.checking = false;
    this.picked = null;
    this.checked = null;
    this.checkError = null;
  }

  async setPartition(p: Partition) {
    if (!(ALLOWED_PARTITIONS as readonly string[]).includes(p)) return;
    this.partition = p;
    await this.recheck();
  }

  /** Boot the chosen (boot) image once with `fastboot boot`: nothing is written, the phone just runs it. */
  async startBoot() {
    const { fb, picked, checked } = this;
    if (!fb || !picked || !checked || checked.problems.length || this.phoneProblems.length) return;
    if (this.partition !== "boot") return;
    this.op = "boot";
    this.flashState = "flashing";
    this.flashError = null;
    this.stopRequested = false;
    this.rebooted = false;
    this.progress = null;
    this.go("Flash");
    let lock: WakeLockSentinel | null = null;
    try {
      lock = await navigator.wakeLock?.request("screen");
    } catch {
      /* not allowed: fine */
    }
    let phase: Progress["phase"] = "sending";
    try {
      await bootImage({
        fb,
        src: picked.src,
        onProgress: (p) => {
          phase = p.phase;
          this.progress = p;
        },
      });
      this.flashState = "done";
      this.rebooted = true; // the phone left fastboot and is running the image
    } catch (e) {
      // the phone can drop off USB the instant it jumps to the image; that is a successful boot, not a failure
      if ((phase as string) === "writing" && e instanceof Error && /disconnect|no answer|USB (read|write) failed|device.*lost|transfer/i.test(e.message)) {
        this.flashState = "done";
        this.rebooted = true;
      } else {
        this.flashState = "error";
        this.flashError = e instanceof FastbootError ? e.message : explainUsb(e as Error);
      }
    } finally {
      await lock?.release().catch(() => {});
    }
  }

  async startFlash() {
    const { fb, picked, checked } = this;
    if (!fb || !picked || !checked || checked.problems.length || this.phoneProblems.length) return;
    this.op = "flash";
    this.flashState = "flashing";
    this.flashError = null;
    this.stopRequested = false;
    this.rebooted = false;
    this.progress = null;
    this.go("Flash");
    let lock: WakeLockSentinel | null = null;
    try {
      lock = await navigator.wakeLock?.request("screen");
    } catch {
      /* not allowed: fine */
    }
    try {
      const ok = await flash({
        fb,
        src: picked.src,
        partition: this.partition,
        checked,
        onProgress: (p) => (this.progress = p),
        shouldStop: () => this.stopRequested,
      });
      this.flashState = ok ? "done" : "stopped";
      if (ok && this.rebootWhenDone) {
        await fb.reboot();
        this.rebooted = true;
      }
    } catch (e) {
      this.flashState = "error";
      this.flashError = e instanceof FastbootError ? e.message : explainUsb(e as Error);
    } finally {
      await lock?.release().catch(() => {});
    }
  }

  async reboot() {
    if (!this.fb) return;
    try {
      await this.fb.reboot();
      this.rebooted = true;
    } catch (e) {
      this.flashError = (e as Error).message;
    }
  }

  resetFlash() {
    this.flashState = "idle";
    this.flashError = null;
    this.progress = null;
    this.go("Confirm");
  }
}

function safeGet(k: string): string {
  try {
    return localStorage.getItem(k) ?? "";
  } catch {
    return "";
  }
}
function safeSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private window: fine */
  }
}

function hex(n: number) {
  return (n ?? 0).toString(16).padStart(4, "0");
}

function explainUsb(e: Error): string {
  const m = e.message || String(e);
  if (e.name === "SecurityError") return "The browser blocked USB access. WebUSB needs Chrome or Edge, on https or localhost, and it is off in some managed browsers.";
  if (e.name === "NetworkError" || /Unable to claim|claim interface|Access denied/i.test(m))
    return "The phone is busy or the browser has no permission. Close fastboot/adb and the Bergamota app, then replug. On Linux add the udev rule below; on Windows the device needs the WinUSB driver.";
  return m;
}

export const session = new Session();

if (FastbootDevice.supported()) {
  navigator.usb.addEventListener("connect", (e) => {
    // a phone this site was already allowed to use came back (fastboot detected automatically)
    if (!session.fb) FastbootDevice.known().then((d) => { if (d.includes(e.device)) session.connect(e.device); });
  });
  navigator.usb.addEventListener("disconnect", (e) => session.disconnected(e.device));
  FastbootDevice.known().then((d) => { if (d[0]) session.connect(d[0]); });
}

window.addEventListener("beforeunload", (e) => {
  if (session.flashState === "flashing") e.preventDefault();
});

// dev server only: lets the browser drive the flow against test/helpers.ts's FakePhone (stripped from builds)
if (import.meta.env.DEV) (window as unknown as { __session: Session }).__session = session;
