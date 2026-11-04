import { test } from "node:test";
import assert from "node:assert/strict";
import { NetLogEngine, LineAssembler, classifyTags, USB, GPU, CRASH, WLAN } from "../src/lib/netlog.ts";
import { parseEthernet, parseArp, ETH_ARP, ETH_IPV4, HOST_MAC, parseIpStr, macToStr, ipToStr } from "../src/lib/ethernet.ts";

const PHONE_MAC = Uint8Array.from([0xaa, 0xbb, 0xcc, 0x00, 0x11, 0x22]);
const PHONE_IP = parseIpStr("192.168.7.2");
const HOST_IP = parseIpStr("192.168.7.1");
const BROADCAST = Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

function ethFrame(dst: Uint8Array, src: Uint8Array, ethertype: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(14 + payload.length);
  out.set(dst, 0);
  out.set(src, 6);
  out[12] = ethertype >> 8;
  out[13] = ethertype & 0xff;
  out.set(payload, 14);
  return out;
}

function arpRequest(tpa: Uint8Array): Uint8Array {
  const p = new Uint8Array(28);
  const v = new DataView(p.buffer);
  v.setUint16(0, 1, false);
  v.setUint16(2, ETH_IPV4, false);
  p[4] = 6;
  p[5] = 4;
  v.setUint16(6, 1, false); // request
  p.set(PHONE_MAC, 8);
  p.set(PHONE_IP, 14);
  p.set(new Uint8Array(6), 18); // target hw unknown
  p.set(tpa, 24);
  return ethFrame(BROADCAST, PHONE_MAC, ETH_ARP, p);
}

function udpFrame(dstPort: number, payload: Uint8Array, dstIp = HOST_IP): Uint8Array {
  const udp = new Uint8Array(8 + payload.length);
  const uv = new DataView(udp.buffer);
  uv.setUint16(0, 5555, false); // src port
  uv.setUint16(2, dstPort, false);
  uv.setUint16(4, udp.length, false);
  uv.setUint16(6, 0, false); // checksum 0 = not computed (legal for IPv4 UDP)
  udp.set(payload, 8);

  const ip = new Uint8Array(20 + udp.length);
  const iv = new DataView(ip.buffer);
  ip[0] = 0x45; // v4, ihl 5
  iv.setUint16(2, ip.length, false);
  ip[8] = 64; // ttl
  ip[9] = 17; // udp
  ip.set(PHONE_IP, 12);
  ip.set(dstIp, 16);
  ip.set(udp, 20);
  return ethFrame(HOST_MAC, PHONE_MAC, ETH_IPV4, ip);
}

test("engine answers an ARP request for 192.168.7.1 with our MAC", () => {
  const eng = new NetLogEngine();
  const { reply, logBytes } = eng.handle(arpRequest(HOST_IP));
  assert.equal(logBytes, undefined);
  assert.ok(reply, "an ARP reply is produced");
  const eth = parseEthernet(reply!)!;
  assert.equal(eth.ethertype, ETH_ARP);
  assert.equal(macToStr(eth.dst), macToStr(PHONE_MAC), "unicast back to the phone");
  assert.equal(macToStr(eth.src), macToStr(HOST_MAC));
  const arp = parseArp(eth.payload)!;
  assert.equal(arp.oper, 2, "reply");
  assert.equal(macToStr(arp.sha), macToStr(HOST_MAC));
  assert.equal(ipToStr(arp.spa), "192.168.7.1");
  assert.equal(ipToStr(arp.tpa), "192.168.7.2");
  assert.equal(eng.arpReplies, 1);
});

test("engine ignores an ARP for someone else", () => {
  const eng = new NetLogEngine();
  const { reply } = eng.handle(arpRequest(parseIpStr("192.168.7.9")));
  assert.equal(reply, undefined);
  assert.equal(eng.arpReplies, 0);
});

test("engine surfaces the UDP/5140 payload and nothing else", () => {
  const eng = new NetLogEngine();
  const text = new TextEncoder().encode("SWEET USB up\n");
  const { logBytes, reply } = eng.handle(udpFrame(5140, text));
  assert.equal(reply, undefined);
  assert.deepEqual(logBytes, text);
  // a datagram to another port is not log traffic
  assert.equal(eng.handle(udpFrame(22, text)).logBytes, undefined);
});

test("engine also accepts broadcast UDP/5140 (no ARP needed)", () => {
  const eng = new NetLogEngine();
  const text = new TextEncoder().encode("boot\n");
  const { logBytes } = eng.handle(udpFrame(5140, text, parseIpStr("255.255.255.255")));
  assert.deepEqual(logBytes, text);
});

test("LineAssembler splits on LF, trims CR, keeps partials, flushes runaways", () => {
  const la = new LineAssembler();
  assert.deepEqual(la.push(new TextEncoder().encode("one\r\ntwo\nthr")), ["one", "two"]);
  assert.deepEqual(la.push(new TextEncoder().encode("ee\n")), ["three"]);
  assert.deepEqual(la.push(new TextEncoder().encode("")), []);
  const runaway = "x".repeat(9000);
  assert.equal(la.push(new TextEncoder().encode(runaway))[0].length, 9000);
});

test("classifyTags matches the Mac app's tagging", () => {
  assert.equal(classifyTags("SWEET USB link up") & USB, USB);
  assert.equal(classifyTags("SWEET GPU submit") & GPU, GPU);
  assert.equal(classifyTags("SWEET WLAN join") & WLAN, WLAN);
  assert.equal(classifyTags("panic(cpu 0): Data Abort") & CRASH, CRASH);
  assert.equal(classifyTags("Kernel panic") & CRASH, CRASH);
  assert.equal(classifyTags("ordinary line"), 0);
});

test("announce() is a broadcast gratuitous ARP for our IP", () => {
  const eng = new NetLogEngine();
  const eth = parseEthernet(eng.announce())!;
  assert.equal(eth.ethertype, ETH_ARP);
  assert.equal(macToStr(eth.dst), "ff:ff:ff:ff:ff:ff");
  const arp = parseArp(eth.payload)!;
  assert.equal(ipToStr(arp.spa), "192.168.7.1");
  assert.equal(macToStr(arp.sha), macToStr(HOST_MAC));
});

test("engine counts what arrives, so 'no log' can be told from 'nothing at all'", () => {
  const eng = new NetLogEngine();
  eng.handle(arpRequest(HOST_IP));
  eng.handle(udpFrame(5140, new TextEncoder().encode("x\n")));
  eng.handle(udpFrame(53, new TextEncoder().encode("dns")));
  eng.handle(ethFrame(HOST_MAC, PHONE_MAC, 0x86dd, new Uint8Array(40))); // IPv6
  assert.deepEqual(
    { f: eng.stats.frames, a: eng.stats.arpRequests, ip: eng.stats.ipv4, log: eng.stats.logDatagrams, udp: eng.stats.otherUdp, port: eng.stats.lastUdpPort, other: eng.stats.otherEth },
    { f: 4, a: 1, ip: 2, log: 1, udp: 1, port: 53, other: 1 },
  );
  assert.equal(eng.arpReplies, 1);
});

test("whoHas() is a broadcast ARP request for the phone from our address", () => {
  const eng = new NetLogEngine();
  const eth = parseEthernet(eng.whoHas())!;
  assert.equal(macToStr(eth.dst), "ff:ff:ff:ff:ff:ff");
  const arp = parseArp(eth.payload)!;
  assert.equal(arp.oper, 1);
  assert.equal(ipToStr(arp.spa), "192.168.7.1");
  assert.equal(ipToStr(arp.tpa), "192.168.7.2");
  assert.equal(macToStr(arp.sha), macToStr(HOST_MAC));
});
