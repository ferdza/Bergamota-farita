// The link-layer brain of the live log: given raw Ethernet frames from the phone's CDC-ECM interface,
// answer its ARP for 192.168.7.1 and turn the UDP/5140 datagrams into text lines. Pure and unit-tested;
// the WebUSB plumbing that feeds it lives in usbnet.ts.

import { buildArpReply, buildEthernet, eqBytes, ETH_ARP, ETH_IPV4, HOST_IP, HOST_MAC, isArpRequestFor, LOG_PORT, parseArp, parseEthernet, parseIPv4, parseIpStr, parseUDP, PHONE_IP, PHONE_MAC, REPLAY_PORT, udpToPort } from "./ethernet.ts";
import { buildIPv4 } from "./ipstack.ts";

/** Log tags, in the same bit order as the Mac app (LogStore.swift) so saved logs read the same. */
export const LOG_TAGS = ["SWEET USB", "SWEET GPU", "SWEET WLAN", "SWEET FB", "CRASH"] as const;
export type LogTag = (typeof LOG_TAGS)[number];
export const USB = 1 << 0,
  GPU = 1 << 1,
  WLAN = 1 << 2,
  FB = 1 << 3,
  CRASH = 1 << 4;

/** Which tags a line carries (bitmask), mirroring LogStore.classify. */
export function classifyTags(s: string): number {
  let m = 0;
  if (s.includes("SWEET USB")) m |= USB;
  if (s.includes("SWEET GPU")) m |= GPU;
  if (s.includes("SWEET WLAN")) m |= WLAN;
  if (s.includes("SWEET FB")) m |= FB;
  if (/panic/i.test(s) || /crash/i.test(s) || /fatal/i.test(s) || s.includes("Data Abort") || /assertion failed/i.test(s)) m |= CRASH;
  return m;
}

export function tagBit(t: LogTag): number {
  return 1 << LOG_TAGS.indexOf(t);
}

/** Splits a byte stream into text lines on LF, trims a trailing CR, and keeps a partial line across reads. */
export class LineAssembler {
  private partial = "";
  private dec = new TextDecoder("utf-8", { fatal: false });

  push(bytes: Uint8Array): string[] {
    this.partial += this.dec.decode(bytes, { stream: true });
    const out: string[] = [];
    let nl: number;
    while ((nl = this.partial.indexOf("\n")) >= 0) {
      let line = this.partial.slice(0, nl);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      out.push(line);
      this.partial = this.partial.slice(nl + 1);
    }
    // a runaway line with no newline: flush so memory stays bounded (matches LogStore's 8 KiB guard)
    if (this.partial.length > 8192) {
      out.push(this.partial);
      this.partial = "";
    }
    return out;
  }
}

export interface Handled {
  /** An Ethernet frame to send back to the phone (an ARP reply), if any. */
  reply?: Uint8Array;
  /** The UDP/5140 payload, if this frame carried log bytes. */
  logBytes?: Uint8Array;
}

/** Stateless per-frame handling: ARP replies for our IP, and UDP/5140 payloads surfaced as log bytes. */
export class NetLogEngine {
  readonly selfMac: Uint8Array;
  readonly selfIp: Uint8Array;
  arpReplies = 0;
  /** What came in, so the page can tell "the phone sends nothing" from "it sends, but no log". */
  stats = { frames: 0, arpRequests: 0, ipv4: 0, logDatagrams: 0, otherUdp: 0, otherEth: 0, last: "", lastUdpPort: 0 };

  constructor(selfMac: Uint8Array = HOST_MAC, selfIp: Uint8Array = parseIpStr(HOST_IP)) {
    this.selfMac = selfMac;
    this.selfIp = selfIp;
  }

  handle(frame: Uint8Array): Handled {
    const eth = parseEthernet(frame);
    if (!eth) return {};
    const s = this.stats;
    s.frames++;
    if (eth.ethertype === ETH_ARP) {
      s.last = "ARP";
      const arp = parseArp(eth.payload);
      if (arp && arp.oper === 1) s.arpRequests++;
      if (arp && isArpRequestFor(arp, this.selfIp)) {
        this.arpReplies++;
        const reply = buildEthernet(arp.sha, this.selfMac, ETH_ARP, buildArpReply(arp, this.selfMac, this.selfIp));
        return { reply };
      }
      return {};
    }
    if (eth.ethertype !== ETH_IPV4) {
      s.otherEth++;
      s.last = `ethertype 0x${eth.ethertype.toString(16)}`;
      return {};
    }
    s.ipv4++;
    const ip = parseIPv4(eth.payload);
    const udp = ip && ip.proto === 17 ? parseUDP(ip.payload) : null;
    s.last = ip ? (udp ? `UDP ${udp.dstPort}` : `IPv4 proto ${ip.proto}`) : "IPv4 (bad)";
    const logBytes = udpToPort(frame, LOG_PORT);
    if (logBytes) s.logDatagrams++;
    else if (udp) {
      s.otherUdp++;
      s.lastUdpPort = udp.dstPort;
    }
    return logBytes ? { logBytes } : {};
  }

  /**
   * UDP "REPLAY" to the phone's port 5141 (kernel 0257): it sends its console again from the oldest byte of its
   * 4 MiB ring, i.e. the whole boot, which went out before the page listened and was lost. Older kernels ignore it.
   */
  replayRequest(): Uint8Array {
    const body = new TextEncoder().encode("REPLAY");
    const udp = new Uint8Array(8 + body.length);
    const v = new DataView(udp.buffer);
    v.setUint16(0, LOG_PORT, false);
    v.setUint16(2, REPLAY_PORT, false);
    v.setUint16(4, udp.length, false); // checksum 0 = none (allowed over IPv4)
    udp.set(body, 8);
    const ip = buildIPv4(this.selfIp, parseIpStr(PHONE_IP), 17, udp, (Math.random() * 0xffff) | 0);
    return buildEthernet(PHONE_MAC, this.selfMac, ETH_IPV4, ip);
  }

  /** ARP "who has 192.168.7.2": makes the phone answer and learn our MAC at once. */
  whoHas(target: Uint8Array = parseIpStr(PHONE_IP)): Uint8Array {
    const p = new Uint8Array(28);
    const v = new DataView(p.buffer);
    v.setUint16(0, 1, false);
    v.setUint16(2, 0x0800, false);
    p[4] = 6;
    p[5] = 4;
    v.setUint16(6, 1, false); // request
    p.set(this.selfMac, 8);
    p.set(this.selfIp, 14);
    p.set(target, 24); // tha stays zero
    return buildEthernet(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), this.selfMac, ETH_ARP, p);
  }

  /** A gratuitous ARP announcing 192.168.7.1 is at our MAC — primes the phone's table before it asks. */
  announce(): Uint8Array {
    const p = new Uint8Array(28);
    const v = new DataView(p.buffer);
    v.setUint16(0, 1, false);
    v.setUint16(2, 0x0800, false);
    p[4] = 6;
    p[5] = 4;
    v.setUint16(6, 2, false); // reply (gratuitous)
    p.set(this.selfMac, 8);
    p.set(this.selfIp, 14);
    p.set(this.selfMac, 18); // target = ourselves
    p.set(this.selfIp, 24);
    const broadcast = Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    return buildEthernet(broadcast, this.selfMac, ETH_ARP, p);
  }
}

export const _internal = { eqBytes };
