// The link-layer brain of the live log: given raw Ethernet frames from the phone's CDC-ECM interface,
// answer its ARP for 192.168.7.1 and turn the UDP/5140 datagrams into text lines. Pure and unit-tested;
// the WebUSB plumbing that feeds it lives in usbnet.ts.

import { buildArpReply, buildEthernet, eqBytes, ETH_ARP, HOST_IP, HOST_MAC, isArpRequestFor, LOG_PORT, parseArp, parseEthernet, parseIpStr, udpToPort } from "./ethernet.ts";

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

  constructor(selfMac: Uint8Array = HOST_MAC, selfIp: Uint8Array = parseIpStr(HOST_IP)) {
    this.selfMac = selfMac;
    this.selfIp = selfIp;
  }

  handle(frame: Uint8Array): Handled {
    const eth = parseEthernet(frame);
    if (!eth) return {};
    if (eth.ethertype === ETH_ARP) {
      const arp = parseArp(eth.payload);
      if (arp && isArpRequestFor(arp, this.selfIp)) {
        this.arpReplies++;
        const reply = buildEthernet(arp.sha, this.selfMac, ETH_ARP, buildArpReply(arp, this.selfMac, this.selfIp));
        return { reply };
      }
      return {};
    }
    const logBytes = udpToPort(frame, LOG_PORT);
    return logBytes ? { logBytes } : {};
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
