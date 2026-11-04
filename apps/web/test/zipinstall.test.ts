import { test } from "node:test";
import assert from "node:assert/strict";
import { planZip, modeFor } from "../src/lib/zipinstall.ts";

const macho = Uint8Array.of(0xcf, 0xfa, 0xed, 0xfe, 0, 0);
const text = new TextEncoder().encode("hello");

test("modes", () => {
  assert.equal(modeFor(macho), "755");
  assert.equal(modeFor(Uint8Array.of(0xca, 0xfe, 0xba, 0xbe)), "755");
  assert.equal(modeFor(text), "644");
});

test("only user trees, no traversal", () => {
  const p = planZip({
    "usr/local/lib/bgmtl/libchlorophyll.dylib": macho,
    "var/root/chl-test/bg_render.metallib": text,
    "var/root/chl-test/": new Uint8Array(0),
    "BUILD.txt": text,
    "System/Library/Frameworks/Metal.framework/Metal": macho,
    "usr/local/../../etc/passwd": text,
    "usr/lib/dyld": macho,
    "var/root/a b": text,
  });
  assert.deepEqual(p.install.map((f) => [f.path, f.mode]), [
    ["/usr/local/lib/bgmtl/libchlorophyll.dylib", "755"],
    ["/var/root/chl-test/bg_render.metallib", "644"],
  ]);
  assert.deepEqual(p.skipped.sort(), ["BUILD.txt", "System/Library/Frameworks/Metal.framework/Metal", "usr/lib/dyld", "usr/local/../../etc/passwd", "var/root/a b"].sort());
});
