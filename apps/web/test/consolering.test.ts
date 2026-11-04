import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeConsoleRing, ConsoleRingError, READ_RING_CMD, RING_BLOCKS } from "../src/lib/consolering.ts";

function area(stream: string, size = 4 << 20, seq = 7): Uint8Array {
  const a = new Uint8Array(4096 + size);
  a.set(new TextEncoder().encode("SWEETLOG"), 0);
  const dv = new DataView(a.buffer);
  dv.setUint32(8, 1, true);
  dv.setUint32(12, size, true);
  const b = new TextEncoder().encode(stream);
  dv.setBigUint64(16, BigInt(b.length), true);
  dv.setBigUint64(24, BigInt(seq), true);
  for (let i = 0; i < b.length; i++) a[4096 + (i % size)] = b[i];
  return a;
}

test("unwrapped ring", () => {
  const r = decodeConsoleRing(area("SWEET FB: hello\r\nline 2\n"));
  assert.equal(r.text, "SWEET FB: hello\nline 2\n");
  assert.equal(r.wrapped, false);
  assert.equal(r.seq, 7);
});

test("wrapped ring keeps the newest bytes in order", () => {
  const s = Array.from({ length: 30 }, (_, i) => `l${i}\n`).join("");
  const r = decodeConsoleRing(area(s, 64));
  assert.equal(r.wrapped, true);
  assert.equal(r.text, s.slice(-64));
});

test("no header", () => {
  assert.throws(() => decodeConsoleRing(new Uint8Array(RING_BLOCKS * 4096)), ConsoleRingError);
});

test("the phone script finds the size and reads the last area (on a file)", () => {
  const d = mkdtempSync(join(tmpdir(), "ring-"));
  const dev = join(d, "dev");
  const nblocks = 5000;
  const img = new Uint8Array(nblocks * 4096);
  img.set(area("boot line\n").subarray(0, RING_BLOCKS * 4096), (nblocks - RING_BLOCKS) * 4096);
  writeFileSync(dev, img);
  const out = execFileSync("sh", ["-c", READ_RING_CMD.replace("D=/dev/rufsroot0", `D=${dev}`)], { maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(out.length, RING_BLOCKS * 4096);
  assert.equal(decodeConsoleRing(new Uint8Array(out)).text, "boot line\n");
  void readFileSync;
});
