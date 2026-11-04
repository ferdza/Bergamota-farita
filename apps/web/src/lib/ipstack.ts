// A small IPv4 + TCP client stack, enough for SSH to the phone over the CDC-ECM link the page already holds.
// We are 192.168.7.1 (the host); the phone is 192.168.7.2. Frames go in through onFrame() and out through
// the send callback. Client side only (we never listen), no IP fragmentation, no TCP options beyond MSS,
// no window scaling (so windows stay <= 65535), go-back-N retransmission. That is plenty on a USB cable.

import { buildEthernet, eqBytes, ETH_ARP, ETH_IPV4, HOST_IP, HOST_MAC, parseArp, parseEthernet, parseIPv4, parseIpStr, PHONE_IP } from "./ethernet.ts";

const PROTO_TCP = 6;
const FIN = 0x01, SYN = 0x02, RST = 0x04, PSH = 0x08, ACK = 0x10;
const MSS = 1460;
const RCV_WND = 65535;
const MAX_INFLIGHT = 32 * 1024; // bytes in flight, also capped by the peer's window

// 32-bit sequence arithmetic
const add = (a: number, b: number) => (a + b) >>> 0;
const sub = (a: number, b: number) => (a - b) | 0; // signed distance a - b
const lt = (a: number, b: number) => sub(a, b) < 0;

export function checksum(...parts: Uint8Array[]): number {
  let sum = 0;
  for (const p of parts) {
    for (let i = 0; i + 1 < p.length; i += 2) sum += (p[i] << 8) | p[i + 1];
    if (p.length & 1) sum += p[p.length - 1] << 8;
  }
  while (sum >> 16) sum = (sum & 0xffff) + (sum >>> 16);
  return ~sum & 0xffff;
}

export function buildIPv4(src: Uint8Array, dst: Uint8Array, proto: number, payload: Uint8Array, id: number): Uint8Array {
  const p = new Uint8Array(20 + payload.length);
  const v = new DataView(p.buffer);
  p[0] = 0x45;
  v.setUint16(2, p.length, false);
  v.setUint16(4, id & 0xffff, false);
  v.setUint16(6, 0x4000, false); // don't fragment
  p[8] = 64;
  p[9] = proto;
  p.set(src, 12);
  p.set(dst, 16);
  v.setUint16(10, checksum(p.subarray(0, 20)), false);
  p.set(payload, 20);
  return p;
}

export interface TcpSegment {
  srcPort: number;
  dstPort: number;
  seq: number;
  ack: number;
  flags: number;
  window: number;
  mss: number | null;
  payload: Uint8Array;
}

export function parseTcp(b: Uint8Array): TcpSegment | null {
  if (b.length < 20) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const off = (b[12] >> 4) * 4;
  if (off < 20 || off > b.length) return null;
  let mss: number | null = null;
  for (let i = 20; i < off; ) {
    const kind = b[i];
    if (kind === 0) break;
    if (kind === 1) {
      i++;
      continue;
    }
    const len = b[i + 1];
    if (len < 2) break;
    if (kind === 2 && len === 4) mss = v.getUint16(i + 2, false);
    i += len;
  }
  return { srcPort: v.getUint16(0, false), dstPort: v.getUint16(2, false), seq: v.getUint32(4, false), ack: v.getUint32(8, false), flags: b[13], window: v.getUint16(14, false), mss, payload: b.subarray(off) };
}

export function buildTcp(src: Uint8Array, dst: Uint8Array, s: Omit<TcpSegment, "mss"> & { mss?: number }): Uint8Array {
  const optLen = s.mss ? 4 : 0;
  const t = new Uint8Array(20 + optLen + s.payload.length);
  const v = new DataView(t.buffer);
  v.setUint16(0, s.srcPort, false);
  v.setUint16(2, s.dstPort, false);
  v.setUint32(4, s.seq >>> 0, false);
  v.setUint32(8, s.ack >>> 0, false);
  t[12] = ((20 + optLen) / 4) << 4;
  t[13] = s.flags;
  v.setUint16(14, s.window, false);
  if (s.mss) {
    t[20] = 2;
    t[21] = 4;
    v.setUint16(22, s.mss, false);
  }
  t.set(s.payload, 20 + optLen);
  const pseudo = new Uint8Array(12);
  pseudo.set(src, 0);
  pseudo.set(dst, 4);
  pseudo[9] = PROTO_TCP;
  new DataView(pseudo.buffer).setUint16(10, t.length, false);
  v.setUint16(16, checksum(pseudo, t), false);
  return t;
}

export class TcpError extends Error {}

type State = "syn-sent" | "established" | "fin-wait" | "closed";

/** One TCP connection from us to the phone. ondata gets bytes in order; write() resolves once buffered with room. */
export class TcpConn {
  ondata: (b: Uint8Array) => void = () => {};
  onclose: (err?: Error) => void = () => {};
  state: State = "syn-sent";
  readonly localPort: number;
  readonly remotePort: number;
  private stack: IpStack;
  private sndUna: number;
  private sndNxt: number;
  private rcvNxt = 0;
  private peerWnd = 1024;
  private peerMss = 536;
  private sendBuf: Uint8Array[] = []; // unacknowledged + unsent bytes, starting at sndUna
  private sendBufLen = 0;
  private finQueued = false;
  private finSent = false;
  private rto = 500;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private waiters: (() => void)[] = [];
  /** Segments that arrived ahead of a gap, by sequence number: delivered once the gap fills. */
  private ooo = new Map<number, Uint8Array>();
  private established!: { resolve: () => void; reject: (e: Error) => void };
  readonly ready: Promise<void>;

  constructor(stack: IpStack, localPort: number, remotePort: number) {
    this.stack = stack;
    this.localPort = localPort;
    this.remotePort = remotePort;
    this.sndUna = (Math.random() * 0xffffffff) >>> 0;
    this.sndNxt = this.sndUna;
    this.ready = new Promise((resolve, reject) => (this.established = { resolve, reject }));
  }

  /** Bytes buffered but not yet acknowledged. */
  get pending(): number {
    return this.sendBufLen;
  }

  open() {
    this.emit(SYN, this.sndNxt, new Uint8Array(0), MSS);
    this.sndNxt = add(this.sndNxt, 1);
    this.arm();
  }

  async write(data: Uint8Array): Promise<void> {
    if (this.state !== "established") throw new TcpError(`connection is ${this.state}`);
    if (!data.length) return;
    this.sendBuf.push(data.slice());
    this.sendBufLen += data.length;
    this.pump();
    // backpressure: wait while far more than one window is queued
    while (this.sendBufLen > 4 * MAX_INFLIGHT && this.state === "established") await new Promise<void>((r) => this.waiters.push(r));
  }

  close() {
    if (this.state !== "established") return;
    this.finQueued = true;
    this.state = "fin-wait";
    this.pump();
  }

  abort(err?: Error) {
    if (this.state === "closed") return;
    if (this.state !== "syn-sent") this.emit(RST | ACK, this.sndNxt, new Uint8Array(0));
    this.teardown(err);
  }

  private teardown(err?: Error) {
    const wasOpen = this.state !== "closed";
    this.state = "closed";
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stack.forget(this);
    for (const w of this.waiters.splice(0)) w();
    if (wasOpen) {
      this.established.reject(err ?? new TcpError("connection closed"));
      this.onclose(err);
    }
  }

  private emit(flags: number, seq: number, payload: Uint8Array, mss?: number) {
    this.stack.sendTcp({ srcPort: this.localPort, dstPort: this.remotePort, seq, ack: flags & SYN && !(flags & ACK) ? 0 : this.rcvNxt, flags, window: RCV_WND, payload, mss });
  }

  /** Bytes [from, from+len) of the send buffer (offset from sndUna). */
  private slice(from: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    let pos = 0, skip = from;
    for (const b of this.sendBuf) {
      if (skip >= b.length) {
        skip -= b.length;
        continue;
      }
      const take = Math.min(b.length - skip, len - pos);
      out.set(b.subarray(skip, skip + take), pos);
      pos += take;
      skip = 0;
      if (pos === len) break;
    }
    return out;
  }

  private pump() {
    if (this.state !== "established" && this.state !== "fin-wait") return;
    const limit = Math.min(this.peerWnd, MAX_INFLIGHT);
    for (;;) {
      const inflight = sub(this.sndNxt, this.sndUna);
      const unsent = this.sendBufLen - inflight;
      if (unsent <= 0 || inflight >= limit) break;
      const len = Math.min(unsent, this.peerMss, limit - inflight);
      if (len <= 0) break;
      this.emit(ACK | PSH, this.sndNxt, this.slice(inflight, len));
      this.sndNxt = add(this.sndNxt, len);
    }
    if (this.finQueued && !this.finSent && sub(this.sndNxt, this.sndUna) === this.sendBufLen) {
      this.emit(FIN | ACK, this.sndNxt, new Uint8Array(0));
      this.sndNxt = add(this.sndNxt, 1);
      this.finSent = true;
    }
    if (sub(this.sndNxt, this.sndUna) > 0) this.arm();
  }

  private arm() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.retransmit(), this.rto);
  }

  private retransmit() {
    this.timer = null;
    if (this.state === "closed") return;
    this.rto = Math.min(this.rto * 2, 8000);
    if (this.rto >= 8000 && this.state === "syn-sent") return this.teardown(new TcpError("the phone does not answer on this port"));
    if (this.state === "syn-sent") {
      this.emit(SYN, this.sndUna, new Uint8Array(0), MSS);
    } else {
      // go-back-N from the oldest unacknowledged byte
      this.sndNxt = this.sndUna;
      this.finSent = false;
      this.pump();
    }
    this.arm();
  }

  /** A segment for this connection arrived. */
  input(s: TcpSegment) {
    if (s.flags & RST) return this.teardown(new TcpError(this.state === "syn-sent" ? "connection refused" : "connection reset by the phone"));
    if (this.state === "syn-sent") {
      if ((s.flags & (SYN | ACK)) !== (SYN | ACK) || s.ack !== this.sndNxt) return;
      this.rcvNxt = add(s.seq, 1);
      this.sndUna = s.ack;
      this.peerWnd = s.window;
      this.peerMss = Math.min(s.mss ?? 536, MSS);
      this.state = "established";
      this.rto = 500;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.emit(ACK, this.sndNxt, new Uint8Array(0));
      this.established.resolve();
      return;
    }
    if (s.flags & ACK) {
      const acked = sub(s.ack, this.sndUna);
      if (acked > 0 && sub(s.ack, this.sndNxt) <= 0) {
        let drop = Math.min(acked, this.sendBufLen);
        this.sendBufLen -= drop;
        while (drop > 0 && this.sendBuf.length) {
          const b = this.sendBuf[0];
          if (b.length <= drop) {
            drop -= b.length;
            this.sendBuf.shift();
          } else {
            this.sendBuf[0] = b.subarray(drop);
            drop = 0;
          }
        }
        this.sndUna = s.ack;
        this.rto = 500;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        for (const w of this.waiters.splice(0)) w();
      }
      this.peerWnd = s.window;
    }
    let ackNow = false;
    if (s.payload.length) {
      let seq = s.seq;
      let data = s.payload;
      // trim what we already have (a retransmission that overlaps rcvNxt)
      const behind = sub(this.rcvNxt, seq);
      if (behind > 0) {
        data = behind >= data.length ? new Uint8Array(0) : data.subarray(behind);
        seq = this.rcvNxt;
      }
      if (data.length && seq === this.rcvNxt) {
        this.rcvNxt = add(this.rcvNxt, data.length);
        this.ondata(data.slice());
        // drain whatever was waiting behind the gap
        for (let more = true; more; ) {
          more = false;
          for (const [q, d] of this.ooo) {
            const over = sub(this.rcvNxt, q);
            if (over < 0) continue;
            this.ooo.delete(q);
            if (over < d.length) {
              const rest = d.subarray(over);
              this.rcvNxt = add(this.rcvNxt, rest.length);
              this.ondata(rest.slice());
            }
            more = true;
          }
        }
      } else if (data.length && sub(seq, this.rcvNxt) > 0 && sub(seq, this.rcvNxt) < RCV_WND && !this.ooo.has(seq)) {
        this.ooo.set(seq, data.slice());
      }
      ackNow = true; // in order: ack it; out of order: the duplicate ack makes the phone fast-retransmit
    }
    if (s.flags & FIN && add(s.seq, s.payload.length) === this.rcvNxt) {
      this.rcvNxt = add(this.rcvNxt, 1);
      this.emit(ACK, this.sndNxt, new Uint8Array(0));
      if (!this.finSent) {
        this.finQueued = true;
        this.pump();
      }
      return this.teardown();
    }
    if (ackNow) this.emit(ACK, this.sndNxt, new Uint8Array(0));
    if (this.state === "fin-wait" && this.finSent && this.sndUna === this.sndNxt) return this.teardown();
    this.pump();
  }
}

/** Demultiplexes TCP for 192.168.7.1 and builds frames toward the phone. */
export class IpStack {
  readonly selfMac: Uint8Array;
  readonly selfIp: Uint8Array;
  readonly peerIp: Uint8Array;
  peerMac: Uint8Array | null = null;
  private send: (frame: Uint8Array) => void;
  private conns = new Map<number, TcpConn>();
  private nextPort = 49152 + Math.floor(Math.random() * 8000);
  private ipId = (Math.random() * 0xffff) | 0;
  private macWaiters: (() => void)[] = [];

  constructor(send: (frame: Uint8Array) => void, selfMac = HOST_MAC, selfIp = parseIpStr(HOST_IP), peerIp = parseIpStr(PHONE_IP)) {
    this.send = send;
    this.selfMac = selfMac;
    this.selfIp = selfIp;
    this.peerIp = peerIp;
  }

  /** Feed every received frame; returns true when it was TCP for us. Learns the phone's MAC on the way. */
  onFrame(frame: Uint8Array): boolean {
    const eth = parseEthernet(frame);
    if (!eth) return false;
    if (eth.ethertype === ETH_ARP) {
      const arp = parseArp(eth.payload);
      if (arp && eqBytes(arp.spa, this.peerIp)) this.learn(arp.sha);
      return false;
    }
    if (eth.ethertype !== ETH_IPV4) return false;
    const ip = parseIPv4(eth.payload);
    if (!ip || !eqBytes(ip.src, this.peerIp)) return false;
    this.learn(eth.src);
    if (ip.proto !== PROTO_TCP || !eqBytes(ip.dst, this.selfIp)) return false;
    const seg = parseTcp(ip.payload);
    if (!seg) return true;
    const c = this.conns.get(seg.dstPort);
    if (c && c.remotePort === seg.srcPort) c.input(seg);
    else if (!(seg.flags & RST)) {
      // nobody here: reset, as a real stack would
      this.sendTcp({ srcPort: seg.dstPort, dstPort: seg.srcPort, seq: seg.flags & ACK ? seg.ack : 0, ack: add(seg.seq, seg.payload.length + (seg.flags & SYN ? 1 : 0)), flags: RST | ACK, window: 0, payload: new Uint8Array(0) });
    }
    return true;
  }

  private learn(mac: Uint8Array) {
    if (this.peerMac && eqBytes(this.peerMac, mac)) return;
    this.peerMac = mac.slice();
    for (const w of this.macWaiters.splice(0)) w();
  }

  /** Waits until the phone's MAC is known (from its ARP or any frame it sent). */
  async peer(timeoutMs = 3000): Promise<Uint8Array> {
    if (this.peerMac) return this.peerMac;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new TcpError("the phone did not show up on the USB network")), timeoutMs);
      this.macWaiters.push(() => (clearTimeout(t), resolve()));
    });
    return this.peerMac!;
  }

  async connect(port: number, timeoutMs = 10000): Promise<TcpConn> {
    await this.peer();
    let local = this.nextPort++;
    if (this.nextPort > 65000) this.nextPort = 49152;
    while (this.conns.has(local)) local++;
    const c = new TcpConn(this, local, port);
    this.conns.set(local, c);
    c.open();
    const t = setTimeout(() => c.abort(new TcpError(`no answer from the phone on port ${port}`)), timeoutMs);
    try {
      await c.ready;
    } finally {
      clearTimeout(t);
    }
    return c;
  }

  forget(c: TcpConn) {
    if (this.conns.get(c.localPort) === c) this.conns.delete(c.localPort);
  }

  sendTcp(s: Omit<TcpSegment, "mss"> & { mss?: number }) {
    if (!this.peerMac) return;
    const tcp = buildTcp(this.selfIp, this.peerIp, s);
    this.ipId = (this.ipId + 1) & 0xffff;
    this.send(buildEthernet(this.peerMac, this.selfMac, ETH_IPV4, buildIPv4(this.selfIp, this.peerIp, PROTO_TCP, tcp, this.ipId)));
  }
}
