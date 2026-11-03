// A tiny, dependency-free Ethernet/ARP/IPv4/UDP layer, just enough to receive the phone's kernel log.
//
// Bergamota's USB networking is CDC-ECM (README: "CDC-ECM Ethernet … live kernel log on UDP 5140").
// The phone is 192.168.7.2 and sends its syslog as UDP datagrams to its router, 192.168.7.1 — the host.
// A real host has an OS network stack; in the browser there is none, so we are that stack at the link
// layer: we answer the phone's ARP for 192.168.7.1 with our own MAC, and then read the UDP/5140 frames
// it unicasts to us. This file is pure byte-twiddling (no WebUSB), so it is fully unit-tested.

export const HOST_IP = "192.168.7.1"; // us (the router, from the phone's point of view)
export const PHONE_IP = "192.168.7.2"; // the phone's ue0
export const LOG_PORT = 5140;
/** A locally-administered unicast MAC we present to the phone (bit 1 of the first octet = local). */
export const HOST_MAC = Uint8Array.from([0x02, 0xbe, 0x47, 0x0a, 0x01, 0x01]);

export const ETH_ARP = 0x0806;
export const ETH_IPV4 = 0x0800;
const ARP_REQUEST = 1;
const ARP_REPLY = 2;
const IP_PROTO_UDP = 17;

export interface EthFrame {
  dst: Uint8Array;
  src: Uint8Array;
  ethertype: number;
  payload: Uint8Array;
}

const be16 = (v: DataView, o: number) => v.getUint16(o, false);

export function parseEthernet(frame: Uint8Array): EthFrame | null {
  if (frame.length < 14) return null;
  const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return {
    dst: frame.subarray(0, 6),
    src: frame.subarray(6, 12),
    ethertype: be16(v, 12),
    payload: frame.subarray(14),
  };
}

export function buildEthernet(dst: Uint8Array, src: Uint8Array, ethertype: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(14 + payload.length);
  out.set(dst, 0);
  out.set(src, 6);
  out[12] = ethertype >> 8;
  out[13] = ethertype & 0xff;
  out.set(payload, 14);
  return out;
}

export interface Arp {
  oper: number;
  sha: Uint8Array; // sender hardware (MAC)
  spa: Uint8Array; // sender protocol (IPv4)
  tha: Uint8Array; // target hardware
  tpa: Uint8Array; // target protocol (IPv4)
}

export function parseArp(payload: Uint8Array): Arp | null {
  if (payload.length < 28) return null;
  const v = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  // Ethernet (1) + IPv4 (0x0800), 6-byte MAC, 4-byte IP
  if (be16(v, 0) !== 1 || be16(v, 2) !== ETH_IPV4 || payload[4] !== 6 || payload[5] !== 4) return null;
  return {
    oper: be16(v, 6),
    sha: payload.subarray(8, 14),
    spa: payload.subarray(14, 18),
    tha: payload.subarray(18, 24),
    tpa: payload.subarray(24, 28),
  };
}

/** The ARP reply that tells the phone "192.168.7.1 is at HOST_MAC", in answer to its request. */
export function buildArpReply(req: Arp, selfMac: Uint8Array, selfIp: Uint8Array): Uint8Array {
  const p = new Uint8Array(28);
  const v = new DataView(p.buffer);
  v.setUint16(0, 1, false); // htype ethernet
  v.setUint16(2, ETH_IPV4, false); // ptype IPv4
  p[4] = 6;
  p[5] = 4;
  v.setUint16(6, ARP_REPLY, false);
  p.set(selfMac, 8); // sha = us
  p.set(selfIp, 14); // spa = 192.168.7.1
  p.set(req.sha, 18); // tha = the phone
  p.set(req.spa, 24); // tpa = the phone's IP
  return p;
}

export function isArpRequestFor(arp: Arp, ip: Uint8Array): boolean {
  return arp.oper === ARP_REQUEST && eqBytes(arp.tpa, ip);
}

export interface Ipv4 {
  proto: number;
  src: Uint8Array;
  dst: Uint8Array;
  payload: Uint8Array;
}

export function parseIPv4(payload: Uint8Array): Ipv4 | null {
  if (payload.length < 20) return null;
  const version = payload[0] >> 4;
  const ihl = (payload[0] & 0x0f) * 4;
  if (version !== 4 || ihl < 20 || payload.length < ihl) return null;
  const v = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const totalLen = be16(v, 2);
  const end = Math.min(totalLen > 0 ? totalLen : payload.length, payload.length);
  return {
    proto: payload[9],
    src: payload.subarray(12, 16),
    dst: payload.subarray(16, 20),
    payload: payload.subarray(ihl, end),
  };
}

export interface Udp {
  srcPort: number;
  dstPort: number;
  payload: Uint8Array;
}

export function parseUDP(payload: Uint8Array): Udp | null {
  if (payload.length < 8) return null;
  const v = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const len = be16(v, 4); // includes the 8-byte header
  const end = len >= 8 ? Math.min(len, payload.length) : payload.length;
  return { srcPort: be16(v, 0), dstPort: be16(v, 2), payload: payload.subarray(8, end) };
}

/** Pull the UDP payload of a frame addressed to `port`, or null if the frame is not that. */
export function udpToPort(frame: Uint8Array, port: number): Uint8Array | null {
  const eth = parseEthernet(frame);
  if (!eth || eth.ethertype !== ETH_IPV4) return null;
  const ip = parseIPv4(eth.payload);
  if (!ip || ip.proto !== IP_PROTO_UDP) return null;
  const udp = parseUDP(ip.payload);
  if (!udp || udp.dstPort !== port) return null;
  return udp.payload;
}

// MAC / IPv4 text helpers.
export function macToStr(m: Uint8Array): string {
  return Array.from(m, (b) => b.toString(16).padStart(2, "0")).join(":");
}
export function ipToStr(ip: Uint8Array): string {
  return Array.from(ip).join(".");
}
export function parseIpStr(s: string): Uint8Array {
  const parts = s.split(".").map((n) => parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error(`bad IPv4 "${s}"`);
  return Uint8Array.from(parts);
}

export function eqBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
