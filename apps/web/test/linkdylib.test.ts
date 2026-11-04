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
