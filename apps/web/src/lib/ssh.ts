// A small SSH-2 client for the phone's dropbear, in the page: RFC 4253 transport, RFC 4252 publickey auth,
// RFC 4254 session channels, RFC 8731 curve25519-sha256. Algorithms: kex curve25519-sha256, host key and user
// key ssh-ed25519, cipher aes128-ctr/aes256-ctr, mac hmac-sha2-256, no compression. Crypto is @noble (audited,
// pure JS). Runs over any byte stream (the page's TCP stack, or a Node socket in the tests). Server-initiated
// rekeys are handled; we never start one.

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { ctr } from "@noble/ciphers/aes.js";
import type { Ed25519Key } from "./sshkey.ts";

export class SshError extends Error {}

const MSG = {
  DISCONNECT: 1, IGNORE: 2, UNIMPLEMENTED: 3, DEBUG: 4, SERVICE_REQUEST: 5, SERVICE_ACCEPT: 6, EXT_INFO: 7,
  KEXINIT: 20, NEWKEYS: 21, KEX_ECDH_INIT: 30, KEX_ECDH_REPLY: 31,
  USERAUTH_REQUEST: 50, USERAUTH_FAILURE: 51, USERAUTH_SUCCESS: 52, USERAUTH_BANNER: 53, USERAUTH_PK_OK: 60,
  GLOBAL_REQUEST: 80, REQUEST_SUCCESS: 81, REQUEST_FAILURE: 82,
  CHANNEL_OPEN: 90, CHANNEL_OPEN_CONFIRMATION: 91, CHANNEL_OPEN_FAILURE: 92, CHANNEL_WINDOW_ADJUST: 93,
  CHANNEL_DATA: 94, CHANNEL_EXTENDED_DATA: 95, CHANNEL_EOF: 96, CHANNEL_CLOSE: 97, CHANNEL_REQUEST: 98,
  CHANNEL_SUCCESS: 99, CHANNEL_FAILURE: 100,
} as const;

const CLIENT_ID = "SSH-2.0-BergamotaWeb_1.0";
const KEX = ["curve25519-sha256", "curve25519-sha256@libssh.org"];
const HOSTKEY = ["ssh-ed25519"];
const CIPHERS = ["aes128-ctr", "aes256-ctr"];
const MACS = ["hmac-sha2-256"];
const WINDOW = 2 * 1024 * 1024;
const MAX_PACKET = 32768;

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- wire encoding
export class W {
  private parts: Uint8Array[] = [];
  private n = 0;
  raw(b: Uint8Array) {
    this.parts.push(b);
    this.n += b.length;
    return this;
  }
  u8(x: number) {
    return this.raw(Uint8Array.of(x));
  }
  bool(x: boolean) {
    return this.u8(x ? 1 : 0);
  }
  u32(x: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, x >>> 0, false);
    return this.raw(b);
  }
  bytes(b: Uint8Array) {
    return this.u32(b.length).raw(b);
  }
  str(s: string) {
    return this.bytes(enc.encode(s));
  }
  mpint(b: Uint8Array) {
    let i = 0;
    while (i < b.length && b[i] === 0) i++;
    let v = b.subarray(i);
    if (v.length && v[0] & 0x80) {
      const p = new Uint8Array(v.length + 1);
      p.set(v, 1);
      v = p;
    }
    return this.bytes(v);
  }
  out(): Uint8Array {
    const o = new Uint8Array(this.n);
    let k = 0;
    for (const p of this.parts) {
      o.set(p, k);
      k += p.length;
    }
    return o;
  }
}

export class R {
  off = 0;
  b: Uint8Array;
  private v: DataView;
  constructor(b: Uint8Array) {
    this.b = b;
    this.v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  need(n: number) {
    if (this.off + n > this.b.length) throw new SshError("truncated message");
  }
  u8() {
    this.need(1);
    return this.b[this.off++];
  }
  bool() {
    return this.u8() !== 0;
  }
  u32() {
    this.need(4);
    const x = this.v.getUint32(this.off, false);
    this.off += 4;
    return x;
  }
  bytes() {
    const n = this.u32();
    this.need(n);
    const r = this.b.subarray(this.off, this.off + n);
    this.off += n;
    return r;
  }
  str() {
    return dec.decode(this.bytes());
  }
  list() {
    const s = this.str();
    return s ? s.split(",") : [];
  }
}

function pick(ours: string[], theirs: string[], what: string): string {
  const a = ours.find((x) => theirs.includes(x));
  if (!a) throw new SshError(`no common ${what} (phone offers: ${theirs.join(",") || "none"})`);
  return a;
}

function concat(...p: Uint8Array[]): Uint8Array {
  const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let k = 0;
  for (const x of p) {
    o.set(x, k);
    k += x.length;
  }
  return o;
}

/** 128-bit big-endian counter += n blocks (AES-CTR state across packets). */
function ctrAdd(iv: Uint8Array, n: number) {
  for (let i = 15; i >= 0 && n > 0; i--) {
    const s = iv[i] + (n & 0xff);
    iv[i] = s & 0xff;
    n = Math.floor(n / 256) + (s >> 8);
  }
}

interface Dir {
  key: Uint8Array;
  iv: Uint8Array;
  mac: Uint8Array;
}

/** SHA256 fingerprint of a host key blob, as ssh prints it ("SHA256:…"). */
export function fingerprint(blob: Uint8Array): string {
  return "SHA256:" + btoa(String.fromCharCode(...sha256(blob))).replace(/=+$/, "");
}

export interface SshOptions {
  user?: string;
  key: Ed25519Key;
  /** Called with the phone's host key fingerprint; return false to refuse it. Default: accept. */
  hostKey?: (fp: string) => boolean | Promise<boolean>;
  log?: (s: string) => void;
}

export class SshChannel {
  ondata: (b: Uint8Array) => void = () => {};
  onstderr: (b: Uint8Array) => void = () => {};
  onclose: () => void = () => {};
  exitCode: number | null = null;
  remoteId = 0;
  closed = false;
  eofSent = false;
  private remoteWindow = 0;
  private remoteMax = MAX_PACKET;
  private localWindow = WINDOW;
  private windowWaiters: (() => void)[] = [];
  private replies: { resolve: (ok: boolean) => void }[] = [];
  readonly done: Promise<number | null>;
  private finish!: (c: number | null) => void;
  opened!: { resolve: () => void; reject: (e: Error) => void };

  private ssh: SshClient;
  readonly localId: number;

  constructor(ssh: SshClient, localId: number) {
    this.ssh = ssh;
    this.localId = localId;
    this.done = new Promise((r) => (this.finish = r));
  }

  /** internal */
  confirm(remoteId: number, window: number, max: number) {
    this.remoteId = remoteId;
    this.remoteWindow = window;
    this.remoteMax = Math.min(max, MAX_PACKET);
  }

  /** internal: dispatch a channel message */
  handle(type: number, r: R) {
    switch (type) {
      case MSG.CHANNEL_WINDOW_ADJUST:
        this.remoteWindow += r.u32();
        for (const w of this.windowWaiters.splice(0)) w();
        break;
      case MSG.CHANNEL_DATA:
      case MSG.CHANNEL_EXTENDED_DATA: {
        const ext = type === MSG.CHANNEL_EXTENDED_DATA ? r.u32() : 0;
        const d = r.bytes();
        this.localWindow -= d.length;
        if (this.localWindow < WINDOW / 2) {
          this.ssh.send(new W().u8(MSG.CHANNEL_WINDOW_ADJUST).u32(this.remoteId).u32(WINDOW - this.localWindow).out());
          this.localWindow = WINDOW;
        }
        (ext === 1 ? this.onstderr : this.ondata)(d.slice());
        break;
      }
      case MSG.CHANNEL_EOF:
        break;
      case MSG.CHANNEL_REQUEST: {
        const name = r.str();
        const want = r.bool();
        if (name === "exit-status") this.exitCode = r.u32();
        if (want) this.ssh.send(new W().u8(MSG.CHANNEL_FAILURE).u32(this.remoteId).out());
        break;
      }
      case MSG.CHANNEL_SUCCESS:
      case MSG.CHANNEL_FAILURE:
        this.replies.shift()?.resolve(type === MSG.CHANNEL_SUCCESS);
        break;
      case MSG.CHANNEL_CLOSE:
        if (!this.closed) this.ssh.send(new W().u8(MSG.CHANNEL_CLOSE).u32(this.remoteId).out());
        this.closed = true;
        this.ssh.dropChannel(this);
        for (const w of this.windowWaiters.splice(0)) w();
        for (const q of this.replies.splice(0)) q.resolve(false);
        this.onclose();
        this.finish(this.exitCode);
        break;
    }
  }

  private request(name: string, body: Uint8Array, want = true): Promise<boolean> {
    const p = want ? new Promise<boolean>((resolve) => this.replies.push({ resolve })) : Promise.resolve(true);
    this.ssh.send(new W().u8(MSG.CHANNEL_REQUEST).u32(this.remoteId).str(name).bool(want).raw(body).out());
    return p;
  }

  pty(cols: number, rows: number, term = "xterm-256color") {
    return this.request("pty-req", new W().str(term).u32(cols).u32(rows).u32(0).u32(0).bytes(Uint8Array.of(0)).out());
  }
  shell() {
    return this.request("shell", new Uint8Array(0));
  }
  exec(command: string) {
    return this.request("exec", new W().str(command).out());
  }
  resize(cols: number, rows: number) {
    if (!this.closed) void this.request("window-change", new W().u32(cols).u32(rows).u32(0).u32(0).out(), false);
  }

  /** Writes stdin, honouring the phone's channel window (so a big upload streams instead of piling up). */
  async write(data: Uint8Array) {
    let off = 0;
    while (off < data.length) {
      if (this.closed) throw new SshError("channel closed");
      if (this.remoteWindow <= 0) {
        await new Promise<void>((r) => this.windowWaiters.push(r));
        continue;
      }
      const n = Math.min(data.length - off, this.remoteWindow, this.remoteMax - 64);
      await this.ssh.sendAsync(new W().u8(MSG.CHANNEL_DATA).u32(this.remoteId).bytes(data.subarray(off, off + n)).out());
      this.remoteWindow -= n;
      off += n;
    }
  }

  eof() {
    if (this.closed || this.eofSent) return;
    this.eofSent = true;
    this.ssh.send(new W().u8(MSG.CHANNEL_EOF).u32(this.remoteId).out());
  }

  close() {
    if (this.closed) return;
    this.ssh.send(new W().u8(MSG.CHANNEL_CLOSE).u32(this.remoteId).out());
  }
}

type Waiter = { types: number[]; resolve: (m: { type: number; r: R; raw: Uint8Array }) => void; reject: (e: Error) => void };

export class SshClient {
  serverId = "";
  hostFingerprint = "";
  onclose: (err?: Error) => void = () => {};
  closed = false;

  private writeOut: (b: Uint8Array) => Promise<void>;
  private inbuf: Uint8Array = new Uint8Array(0);
  private gotIdent = false;
  private seqIn = 0;
  private seqOut = 0;
  private dirIn: Dir | null = null;
  private dirOut: Dir | null = null;
  private pendingIn: Dir | null = null;
  /** Set when NEWKEYS arrived: stop parsing (the bytes after it use keys kex() is still computing). */
  private awaitKeys = false;
  private sessionId: Uint8Array | null = null;
  private waiters: Waiter[] = [];
  private queue: { type: number; r: R; raw: Uint8Array }[] = [];
  private channels = new Map<number, SshChannel>();
  private nextChannel = 0;
  private kexing = false;
  private held: Uint8Array[] = []; // non-kex packets held during a rekey
  private ourKexInit: Uint8Array | null = null;
  private outChain: Promise<void> = Promise.resolve();
  private log: (s: string) => void;
  private opts: SshOptions;

  constructor(writeOut: (b: Uint8Array) => Promise<void>, opts: SshOptions) {
    this.writeOut = writeOut;
    this.opts = opts;
    this.log = opts.log ?? (() => {});
  }

  /** Feed bytes received from the transport. */
  feed(b: Uint8Array) {
    if (this.closed) return;
    this.inbuf = this.inbuf.length ? concat(this.inbuf, b) : b.slice();
    try {
      this.parse();
    } catch (e) {
      this.fail(e as Error);
    }
  }

  /** Transport closed under us. */
  transportClosed(err?: Error) {
    this.fail(err ?? new SshError("connection closed by the phone"));
  }

  private fail(err: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) w.reject(err);
    for (const c of [...this.channels.values()]) c.handle(MSG.CHANNEL_CLOSE, new R(new Uint8Array(0)));
    this.onclose(err);
  }

  disconnect() {
    if (this.closed) return;
    try {
      this.send(new W().u8(MSG.DISCONNECT).u32(11).str("bye").str("").out());
    } catch {
      /* closing anyway */
    }
    this.fail(new SshError("disconnected"));
  }

  // ---- packet layer
  private parse() {
    if (!this.gotIdent) {
      for (;;) {
        const nl = this.inbuf.indexOf(10);
        if (nl < 0) return;
        const line = dec.decode(this.inbuf.subarray(0, nl)).replace(/\r$/, "");
        this.inbuf = this.inbuf.subarray(nl + 1);
        if (line.startsWith("SSH-")) {
          if (!line.startsWith("SSH-2.0-") && !line.startsWith("SSH-1.99-")) throw new SshError(`unsupported protocol ${line}`);
          this.serverId = line;
          this.gotIdent = true;
          break;
        }
      }
    }
    for (;;) {
      const d = this.dirIn;
      const block = d ? 16 : 8;
      if (this.inbuf.length < block) return;
      let first: Uint8Array;
      if (d) first = ctr(d.key, d.iv.slice()).decrypt(this.inbuf.subarray(0, 16));
      else first = this.inbuf.subarray(0, block);
      const len = new DataView(first.buffer, first.byteOffset, 4).getUint32(0, false);
      if (len > 256 * 1024 || len < 5) throw new SshError(`bad packet length ${len}`);
      const total = 4 + len;
      const macLen = d ? 32 : 0;
      if (this.inbuf.length < total + macLen) return;
      let plain: Uint8Array;
      if (d) {
        plain = ctr(d.key, d.iv.slice()).decrypt(this.inbuf.subarray(0, total));
        ctrAdd(d.iv, total / 16);
        const want = hmac(sha256, d.mac, concat(new W().u32(this.seqIn).out(), plain));
        const got = this.inbuf.subarray(total, total + macLen);
        let diff = 0;
        for (let i = 0; i < 32; i++) diff |= want[i] ^ got[i];
        if (diff) throw new SshError("MAC check failed (corrupted or tampered stream)");
      } else plain = this.inbuf.slice(0, total);
      this.inbuf = this.inbuf.subarray(total + macLen);
      this.seqIn = (this.seqIn + 1) >>> 0;
      const pad = plain[4];
      const payload = plain.slice(5, total - pad);
      this.dispatch(payload);
      if (this.awaitKeys) return; // resumed by kex() once the inbound keys are installed
    }
  }

  private dispatch(payload: Uint8Array) {
    const type = payload[0];
    const r = new R(payload);
    r.off = 1;
    if (type === MSG.IGNORE || type === MSG.DEBUG || type === MSG.UNIMPLEMENTED || type === MSG.EXT_INFO) return;
    if (type === MSG.DISCONNECT) {
      r.u32();
      throw new SshError(`the phone closed SSH: ${r.str()}`);
    }
    if (type === MSG.NEWKEYS) this.awaitKeys = true;
    if (type === MSG.KEXINIT && this.sessionId && !this.kexing) {
      // server-initiated rekey
      void this.kex(payload).catch((e) => this.fail(e));
      return;
    }
    if (type === MSG.GLOBAL_REQUEST) {
      r.str();
      if (r.bool()) this.send(Uint8Array.of(MSG.REQUEST_FAILURE));
      return;
    }
    if (type >= MSG.CHANNEL_WINDOW_ADJUST && type <= MSG.CHANNEL_FAILURE) {
      const c = this.channels.get(r.u32());
      if (c) c.handle(type, r);
      return;
    }
    if (type === MSG.CHANNEL_OPEN_CONFIRMATION || type === MSG.CHANNEL_OPEN_FAILURE) {
      const c = this.channels.get(r.u32());
      if (!c) return;
      if (type === MSG.CHANNEL_OPEN_CONFIRMATION) {
        c.confirm(r.u32(), r.u32(), r.u32());
        c.opened.resolve();
      } else {
        r.u32();
        this.channels.delete(c.localId);
        c.opened.reject(new SshError(`channel refused: ${r.str()}`));
      }
      return;
    }
    const m = { type, r, raw: payload };
    const i = this.waiters.findIndex((w) => w.types.includes(type));
    if (i >= 0) this.waiters.splice(i, 1)[0].resolve(m);
    else this.queue.push(m);
  }

  private expect(...types: number[]): Promise<{ type: number; r: R; raw: Uint8Array }> {
    const i = this.queue.findIndex((m) => types.includes(m.type));
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    if (this.closed) return Promise.reject(new SshError("SSH closed"));
    return new Promise((resolve, reject) => this.waiters.push({ types, resolve, reject }));
  }

  private frame(payload: Uint8Array): Uint8Array {
    const d = this.dirOut;
    const block = d ? 16 : 8;
    let pad = block - ((5 + payload.length) % block);
    if (pad < 4) pad += block;
    const len = 1 + payload.length + pad;
    const pkt = new Uint8Array(4 + len);
    new DataView(pkt.buffer).setUint32(0, len, false);
    pkt[4] = pad;
    pkt.set(payload, 5);
    crypto.getRandomValues(pkt.subarray(5 + payload.length));
    let out: Uint8Array = pkt;
    if (d) {
      const mac = hmac(sha256, d.mac, concat(new W().u32(this.seqOut).out(), pkt));
      const c = ctr(d.key, d.iv.slice()).encrypt(pkt);
      ctrAdd(d.iv, pkt.length / 16);
      out = concat(c, mac);
    }
    this.seqOut = (this.seqOut + 1) >>> 0;
    return out;
  }

  /** Queue a packet (ordered); during a rekey only kex packets go out. */
  send(payload: Uint8Array) {
    void this.sendAsync(payload);
  }

  sendAsync(payload: Uint8Array): Promise<void> {
    const t = payload[0];
    const kexMsg = t === MSG.KEXINIT || t === MSG.NEWKEYS || t === MSG.KEX_ECDH_INIT || t === MSG.DISCONNECT;
    if (this.kexing && !kexMsg) {
      this.held.push(payload);
      return this.outChain;
    }
    const bytes = this.frame(payload);
    this.outChain = this.outChain.then(() => this.writeOut(bytes));
    return this.outChain;
  }

  // ---- key exchange
  private kexInit(): Uint8Array {
    const cookie = crypto.getRandomValues(new Uint8Array(16));
    const w = new W().u8(MSG.KEXINIT).raw(cookie);
    for (const l of [KEX, HOSTKEY, CIPHERS, CIPHERS, MACS, MACS, ["none"], ["none"], [], []]) w.str(l.join(","));
    return w.bool(false).u32(0).out();
  }

  private async kex(serverKexInit?: Uint8Array) {
    this.kexing = true;
    const ours = this.kexInit();
    this.ourKexInit = ours;
    void this.sendAsync(ours);
    const theirs = serverKexInit ?? (await this.expect(MSG.KEXINIT)).raw;
    const r = new R(theirs);
    r.off = 17;
    const [kexs, hks, encCS, encSC, macCS, macSC] = [r.list(), r.list(), r.list(), r.list(), r.list(), r.list()];
    pick(KEX, kexs, "key exchange");
    pick(HOSTKEY, hks, "host key type");
    const cCS = pick(CIPHERS, encCS, "cipher"), cSC = pick(CIPHERS, encSC, "cipher");
    pick(MACS, macCS, "MAC");
    pick(MACS, macSC, "MAC");

    const eph = x25519.utils.randomSecretKey();
    const qc = x25519.getPublicKey(eph);
    void this.sendAsync(new W().u8(MSG.KEX_ECDH_INIT).bytes(qc).out());
    const rep = (await this.expect(MSG.KEX_ECDH_REPLY)).r;
    const ks = rep.bytes();
    const qs = rep.bytes();
    const sig = rep.bytes();
    const k = x25519.getSharedSecret(eph, qs); // RFC 8731: the 32 bytes, read big-endian, as an mpint
    const h = sha256(new W().str(CLIENT_ID).str(this.serverId).bytes(ours).bytes(theirs).bytes(ks).bytes(qc).bytes(qs).mpint(k).out());

    const kr = new R(ks);
    if (kr.str() !== "ssh-ed25519") throw new SshError("host key is not ed25519");
    const hostPub = kr.bytes();
    const sr = new R(sig);
    if (sr.str() !== "ssh-ed25519") throw new SshError("host signature is not ed25519");
    if (!ed25519.verify(sr.bytes(), h, hostPub)) throw new SshError("the phone's host key signature is invalid");
    const fp = fingerprint(ks);
    if (!this.sessionId) {
      this.hostFingerprint = fp;
      if (this.opts.hostKey && !(await this.opts.hostKey(fp))) throw new SshError(`host key ${fp} refused`);
      this.sessionId = h;
    } else if (fp !== this.hostFingerprint) throw new SshError("the host key changed during a rekey");

    const kmp = new W().mpint(k).out();
    const derive = (letter: string, n: number) => {
      let out: Uint8Array = sha256(concat(kmp, h, enc.encode(letter), this.sessionId!));
      while (out.length < n) out = concat(out, sha256(concat(kmp, h, out)));
      return out.slice(0, n);
    };
    const klen = (c: string) => (c === "aes256-ctr" ? 32 : 16);
    const outDir: Dir = { iv: derive("A", 16), key: derive("C", klen(cCS)), mac: derive("E", 32) };
    this.pendingIn = { iv: derive("B", 16), key: derive("D", klen(cSC)), mac: derive("F", 32) };

    const nk = this.sendAsync(Uint8Array.of(MSG.NEWKEYS)); // framed now, with the old keys
    this.dirOut = outDir; // every packet framed after this point uses the new keys
    await nk;
    await this.expect(MSG.NEWKEYS);
    // parsing stopped right after NEWKEYS: install the inbound keys, then resume on the buffered bytes
    this.dirIn = this.pendingIn;
    this.pendingIn = null;
    this.awaitKeys = false;
    this.feed(new Uint8Array(0));
    this.kexing = false;
    for (const p of this.held.splice(0)) void this.sendAsync(p);
    this.log(`SSH keys: ${cCS} / hmac-sha2-256, host ${fp}`);
  }

  /** Version exchange, key exchange and publickey login. */
  async connect(): Promise<void> {
    await this.writeOut(enc.encode(CLIENT_ID + "\r\n"));
    await this.kex();
    this.send(new W().u8(MSG.SERVICE_REQUEST).str("ssh-userauth").out());
    await this.expect(MSG.SERVICE_ACCEPT);
    const user = this.opts.user ?? "root";
    const { seed, pub } = this.opts.key;
    const blob = new W().str("ssh-ed25519").bytes(pub).out();
    const toSign = new W().bytes(this.sessionId!).u8(MSG.USERAUTH_REQUEST).str(user).str("ssh-connection").str("publickey").bool(true).str("ssh-ed25519").bytes(blob).out();
    const sig = new W().str("ssh-ed25519").bytes(ed25519.sign(toSign, seed)).out();
    this.send(new W().u8(MSG.USERAUTH_REQUEST).str(user).str("ssh-connection").str("publickey").bool(true).str("ssh-ed25519").bytes(blob).bytes(sig).out());
    for (;;) {
      const m = await this.expect(MSG.USERAUTH_SUCCESS, MSG.USERAUTH_FAILURE, MSG.USERAUTH_BANNER);
      if (m.type === MSG.USERAUTH_SUCCESS) return;
      if (m.type === MSG.USERAUTH_FAILURE)
        throw new SshError("the phone refused this key (Permission denied, publickey): the root was patched with a different public key");
    }
  }

  async openSession(): Promise<SshChannel> {
    const c = new SshChannel(this, this.nextChannel++);
    const opened = new Promise<void>((resolve, reject) => (c.opened = { resolve, reject }));
    this.channels.set(c.localId, c);
    this.send(new W().u8(MSG.CHANNEL_OPEN).str("session").u32(c.localId).u32(WINDOW).u32(MAX_PACKET).out());
    await opened;
    return c;
  }

  /** Runs one command; resolves with its stdout, stderr and exit code. */
  async run(command: string, stdin?: Uint8Array): Promise<{ stdout: Uint8Array; stderr: Uint8Array; code: number | null }> {
    const c = await this.openSession();
    const out: Uint8Array[] = [], err: Uint8Array[] = [];
    c.ondata = (b) => out.push(b);
    c.onstderr = (b) => err.push(b);
    if (!(await c.exec(command))) throw new SshError(`the phone refused to run: ${command}`);
    if (stdin) await c.write(stdin);
    c.eof();
    const code = await c.done;
    return { stdout: concat(...out), stderr: concat(...err), code };
  }

  dropChannel(c: SshChannel) {
    this.channels.delete(c.localId);
  }
}
