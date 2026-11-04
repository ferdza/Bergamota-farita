// State for the live-log page: drive the CDC-ECM link, answer ARP, collect UDP/5140 lines, and keep a
// bounded ring for the view. Frames arrive fast, so lines are buffered off-reactive and flushed to the
// reactive ring every 100 ms (the Mac app does the same with a 0.1 s timer).

import { UsbNet, UsbNetError } from "../lib/usbnet.ts";
import { classifyTags, LineAssembler, NetLogEngine, LOG_TAGS, type LogTag, tagBit } from "../lib/netlog.ts";
import { IpStack } from "../lib/ipstack.ts";

export interface Line {
  id: number;
  text: string;
  tags: number;
}

const RING = 20000; // lines kept in memory
export const MAX_VISIBLE = 3000; // lines handed to the DOM

class LogSession {
  state = $state<"idle" | "connecting" | "live" | "error">("idle");
  error = $state<string | null>(null);
  lines = $state<Line[]>([]);
  total = $state(0);
  linesPerSec = $state(0);
  arpReplies = $state(0);
  stats = $state({ frames: 0, arpRequests: 0, ipv4: 0, logDatagrams: 0, otherUdp: 0, otherEth: 0, last: "", lastUdpPort: 0 });
  linkUp = $state<boolean | null>(null);
  deviceName = $state<string | null>(null);
  /** Why the connect failed, when it is the computer's setup rather than the phone. */
  setup = $state<"access" | "busy" | null>(null);
  rawError = $state<string | null>(null);

  // view controls
  search = $state("");
  activeTags = $state<Set<LogTag>>(new Set());
  paused = $state(false);
  follow = $state(true);

  private net: UsbNet | null = null;
  private engine = new NetLogEngine();
  /** TCP/IP over the same link, for SSH (sshsession.svelte.ts). Recreated on every connect. */
  stack: IpStack | null = null;
  private assembler = new LineAssembler();
  private pending: Line[] = [];
  private nextId = 0;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private rateWindow: [number, number][] = [];

  get supported() {
    return UsbNet.supported() && (typeof window === "undefined" || window.isSecureContext);
  }

  async connect(dev?: USBDevice) {
    if (this.state === "connecting" || this.state === "live") return;
    this.state = "connecting";
    this.error = null;
    this.setup = null;
    this.rawError = null;
    try {
      const net = dev ? await UsbNet.open(dev) : await UsbNet.request();
      this.net = net;
      this.engine = new NetLogEngine();
      this.stack = new IpStack((f) => void net.send(f).catch(() => {}));
      this.deviceName = net.usb.productName ?? "USB networking device";
      this.state = "live";
      this.startFlush();
      // prime the phone's ARP table, then pump frames
      await net.send(this.engine.announce()).catch(() => {});
      await net.send(this.engine.whoHas()).catch(() => {});
      void net.pollNotifications();
      this.pump(net);
    } catch (e) {
      const err = e as Error;
      if (err.name === "NotFoundError") {
        this.state = "idle"; // the user closed the picker
      } else {
        this.state = "error";
        if (err instanceof UsbNetError && err.kind !== "other") {
          this.setup = err.kind;
          this.rawError = err.raw;
          this.error = null;
        } else {
          this.setup = null;
          this.rawError = `${err.name}: ${err.message}`;
          this.error = explain(err);
        }
      }
    }
  }

  private async pump(net: UsbNet) {
    try {
      for await (const frame of net.frames()) {
        const { reply, logBytes } = this.engine.handle(frame);
        this.stack?.onFrame(frame);
        if (reply) await net.send(reply).catch(() => {});
        if (logBytes) {
          for (const text of this.assembler.push(logBytes)) {
            this.pending.push({ id: this.nextId++, text, tags: classifyTags(text) });
          }
        }
      }
    } catch (e) {
      if (this.state === "live") {
        this.state = "error";
        this.error = (e as Error).message;
      }
    }
  }

  private startFlush() {
    this.flushTimer ??= setInterval(() => this.flush(), 100);
  }

  private flush() {
    this.stats = { ...this.engine.stats };
    this.arpReplies = this.engine.arpReplies;
    this.linkUp = this.net?.linkUp ?? null;
    const n = this.pending.length;
    this.updateRate(n);
    if (!n) return;
    this.total += n;
    if (!this.paused) {
      const next = this.lines.concat(this.pending);
      this.lines = next.length > RING ? next.slice(next.length - RING) : next;
    }
    this.pending.length = 0;
  }

  private updateRate(n: number) {
    const now = Date.now();
    this.rateWindow.push([now, n]);
    this.rateWindow = this.rateWindow.filter(([t]) => now - t <= 2000);
    this.linesPerSec = Math.round(this.rateWindow.reduce((s, [, c]) => s + c, 0) / 2);
  }

  toggleTag(t: LogTag) {
    const next = new Set(this.activeTags);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    this.activeTags = next;
  }

  /** The lines the view should show: tag + text filtered, capped to MAX_VISIBLE (most recent). */
  get visible(): Line[] {
    const mask = [...this.activeTags].reduce((m, t) => m | tagBit(t), 0);
    const needle = this.search.trim().toLowerCase();
    if (!mask && !needle) return this.lines.slice(Math.max(0, this.lines.length - MAX_VISIBLE));
    const out: Line[] = [];
    for (let i = this.lines.length - 1; i >= 0 && out.length < MAX_VISIBLE; i--) {
      const l = this.lines[i];
      if ((!mask || l.tags & mask) && (!needle || l.text.toLowerCase().includes(needle))) out.push(l);
    }
    return out.reverse();
  }

  /** A line from the page itself (SSH progress…), shown in the log as "# …". */
  note(text: string) {
    this.pending.push({ id: this.nextId++, text: `# ${text}`, tags: 0 });
  }

  /** Puts earlier history (the kernel buffer fetched over SSH) before what the page received live. */
  prependHistory(text: string, title: string) {
    const lines = text.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.length);
    const head: Line[] = [{ id: this.nextId++, text: `# ---- ${title} (${lines.length} lines) ----`, tags: 0 }];
    for (const t of lines) head.push({ id: this.nextId++, text: t, tags: classifyTags(t) });
    head.push({ id: this.nextId++, text: "# ---- live log ----", tags: 0 });
    this.lines = head.concat(this.lines);
    this.total += lines.length;
  }

  clear() {
    this.lines = [];
    this.pending.length = 0;
    this.total = 0;
  }

  save() {
    const text = this.lines.map((l) => l.text).join("\n") + "\n";
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    a.href = url;
    a.download = `bergamota-log-${stamp}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  async disconnect() {
    const net = this.net;
    this.net = null;
    this.stack = null;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.state = "idle";
    this.linesPerSec = 0;
    await net?.close().catch(() => {});
  }
}

function explain(e: Error): string {
  if (e.name === "SecurityError") return "The browser refused USB access for this page (it must be Chrome or Edge, on https).";
  return e.message || String(e);
}

export const TAGS = LOG_TAGS;
export const log = new LogSession();

if (typeof navigator !== "undefined" && UsbNet.supported()) {
  navigator.usb?.addEventListener("disconnect", () => {
    if (log.state === "live") log.disconnect();
  });
}
