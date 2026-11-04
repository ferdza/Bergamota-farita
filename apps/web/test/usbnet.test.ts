// UsbNet.open against fake WebUSB devices: the CDC-ECM function (claims comm + data, alt 1, packet filter) and
// Bergamota's own vendor link of kernel 0256 (one interface, no alternate, no class request).
import { test } from "node:test";
import assert from "node:assert/strict";
import { UsbNet } from "../src/lib/usbnet.ts";

type Ep = { endpointNumber: number; direction: "in" | "out"; type: "bulk" | "interrupt"; packetSize: number };
const bulk = (n: number, d: "in" | "out"): Ep => ({ endpointNumber: n, direction: d, type: "bulk", packetSize: 512 });

function fake(interfaces: { interfaceNumber: number; alternates: { alternateSetting: number; interfaceClass: number; interfaceSubclass: number; interfaceProtocol: number; endpoints: Ep[] }[] }[]) {
  const calls: string[] = [];
  const dev = {
    opened: false,
    productName: "x",
    configuration: null as unknown,
    configurations: [{ configurationValue: 1, interfaces }],
    async open() { calls.push("open"); this.opened = true; },
    async selectConfiguration(v: number) { calls.push(`config ${v}`); this.configuration = this.configurations[0]; },
    async claimInterface(n: number) { calls.push(`claim ${n}`); },
    async selectAlternateInterface(n: number, a: number) { calls.push(`alt ${n} ${a}`); },
    async controlTransferOut(s: { request: number }) { calls.push(`class 0x${s.request.toString(16)}`); return { status: "ok" }; },
  };
  return { dev, calls };
}

test("raw vendor link: one claim, nothing else", async () => {
  const { dev, calls } = fake([{ interfaceNumber: 0, alternates: [{ alternateSetting: 0, interfaceClass: 0xff, interfaceSubclass: 0x42, interfaceProtocol: 1, endpoints: [bulk(1, "in"), bulk(1, "out")] }] }]);
  const net = await UsbNet.open(dev as unknown as USBDevice);
  assert.equal(net.raw, true);
  assert.deepEqual(calls, ["open", "config 1", "claim 0"]);
});

test("CDC-ECM: comm + data, alternate 1, packet filter", async () => {
  const { dev, calls } = fake([
    { interfaceNumber: 0, alternates: [{ alternateSetting: 0, interfaceClass: 2, interfaceSubclass: 6, interfaceProtocol: 0, endpoints: [{ endpointNumber: 2, direction: "in", type: "interrupt", packetSize: 16 }] }] },
    { interfaceNumber: 1, alternates: [
      { alternateSetting: 0, interfaceClass: 0x0a, interfaceSubclass: 0, interfaceProtocol: 0, endpoints: [] },
      { alternateSetting: 1, interfaceClass: 0x0a, interfaceSubclass: 0, interfaceProtocol: 0, endpoints: [bulk(1, "in"), bulk(1, "out")] },
    ] },
  ]);
  const net = await UsbNet.open(dev as unknown as USBDevice);
  assert.equal(net.raw, false);
  assert.deepEqual(calls, ["open", "config 1", "claim 0", "claim 1", "alt 1 1", "class 0x43"]);
});

test("another vendor interface is not ours", async () => {
  const { dev } = fake([{ interfaceNumber: 0, alternates: [{ alternateSetting: 0, interfaceClass: 0xff, interfaceSubclass: 0x42, interfaceProtocol: 3, endpoints: [bulk(1, "in"), bulk(1, "out")] }] }]);
  await assert.rejects(UsbNet.open(dev as unknown as USBDevice), /no network interface/);
});
