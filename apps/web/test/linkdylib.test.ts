// Renegade.linkDylib through the real WebAssembly module (skipped unless src/patcher/renegade.wasm is built).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { Renegade, PatcherError } from "../src/patcher/wasm.ts";

const wasmPath = new URL("../src/patcher/renegade.wasm", import.meta.url);
const fixture = new URL("../../../tools/renegade-rs/tests/fixtures/exe", import.meta.url);
const skip = !existsSync(wasmPath) || !existsSync(fixture);

test("linkDylib adds a weak load command and refuses a second one", { skip }, async () => {
  const r = await Renegade.standalone(readFileSync(wasmPath));
  const bin = new Uint8Array(readFileSync(fixture));
  // the fixture has 32 bytes of header slack: a long path does not fit, and says so
  assert.throws(() => r.linkDylib(bin, "/usr/local/lib/bgmtl/bgmtl-inject.dylib"), (e: Error) => e instanceof PatcherError && /no slack/.test(e.message));
  const out = r.linkDylib(bin, "/a.dyl");
  assert.ok(Buffer.from(out).includes(Buffer.from("/a.dyl\0")));
  assert.throws(() => r.linkDylib(out, "/a.dyl"), /already links/);
});

test("prepareIpa turns an IPA into a tar of Name.app (WASM)", { skip }, async () => {
  const { zipSync } = await import("fflate");
  const r = await Renegade.standalone(readFileSync(wasmPath));
  const fx = (n: string) => new Uint8Array(readFileSync(new URL(`../../../tools/renegade-rs/tests/fixtures/${n}`, import.meta.url)));
  const info = new TextEncoder().encode(
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>exe</string><key>CFBundleIdentifier</key><string>org.t</string></dict></plist>',
  );
  const ipa = zipSync({ "Payload/T.app/Info.plist": info, "Payload/T.app/exe": fx("exe"), "Payload/T.app/Frameworks/libfix.dylib": fx("libfix.dylib") });
  const { tar, meta } = r.prepareIpa(ipa);
  assert.equal(meta.app, "T.app");
  assert.equal(meta.bundleId, "org.t");
  assert.equal(meta.machos, 2);
  assert.equal(meta.bundlesSealed, 1);
  assert.equal(new TextDecoder().decode(tar.subarray(257, 262)), "ustar");
  assert.throws(() => r.prepareIpa(zipSync({ "a.txt": new Uint8Array(1) })), /not an IPA/);
});
