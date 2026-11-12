import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FastbootDevice } from "../src/lib/fastboot.ts";
import { checkImage, identify } from "../src/lib/flasher.ts";
import { appNameProblem, bundleIdProblem, confirmPhrase, hfsVolumeProblem, installScript, normalizeSlot, readExpanded, removeScript, writeProblems } from "../src/lib/guards.ts";
import { bufferSource, parseImage } from "../src/lib/sparse.ts";
import { FakePhone, makeSparse, withHfsHeader } from "./helpers.ts";

const ABL = { product: "beryllium", unlocked: "yes", "version-bootloader": "unknown", "max-download-size": "0x10000", "partition-size:userdata": "0x40000000", "partition-size:boot": "0x4000000" };

// ---- F-03: headerless / foreign images -------------------------------------------------------------------------

test("F-03: a sparse image with an HFS+ header passes, HFSX too", async () => {
  for (const kind of ["H+", "HX"] as const) {
    const img = withHfsHeader(makeSparse([{ type: "raw", blocks: 4 }, { type: "skip", blocks: 100 }]), kind);
    const src = bufferSource(img);
    assert.equal(await hfsVolumeProblem(src, await parseImage(src), "root.simg"), null, kind);
  }
});

test("F-03: a cancelled patch (28 zero bytes of header) and random data are refused", async () => {
  // SparseWriter::new writes 28 zero bytes and only finish() writes the real header
  const headerless = new Uint8Array(8 << 20);
  headerless.set(makeSparse([{ type: "raw", blocks: 1000 }]).subarray(28), 28);
  let src = bufferSource(headerless);
  let img = await parseImage(src);
  assert.equal(img.sparse, false);
  assert.match((await hfsVolumeProblem(src, img, "bergamota-userdata.simg"))!, /not a sparse image either/);
  // a foreign sparse image (e.g. an Android system.img) without the signature
  src = bufferSource(makeSparse([{ type: "raw", blocks: 8 }]));
  img = await parseImage(src);
  assert.match((await hfsVolumeProblem(src, img, "system.img"))!, /HFS\+ volume header/);
  // right signature but a wrong version (HFS standard "BD" or HFS+ with version 5) is not accepted
  const wrong = withHfsHeader(makeSparse([{ type: "raw", blocks: 4 }]));
  wrong[40 + 1027] = 5;
  src = bufferSource(wrong);
  assert.notEqual(await hfsVolumeProblem(src, await parseImage(src), "x"), null);
});

test("F-03: the header is found through FILL and DONT_CARE runs, and a gap reads as zeros", async () => {
  const src = bufferSource(makeSparse([{ type: "skip", blocks: 2 }, { type: "fill", blocks: 2 }]));
  const img = await parseImage(src);
  assert.deepEqual([...(await readExpanded(src, img, 1024, 4))], [0, 0, 0, 0]);
  assert.equal((await readExpanded(src, img, 2 * 4096, 4)).length, 4);
});

test("F-03: checkImage reports it for userdata only, with the size rule intact", async () => {
  const info = await identify(await FastbootDevice.open(new FakePhone(4096, ABL).usb()));
  const bad = bufferSource(makeSparse([{ type: "raw", blocks: 20 }]));
  const c = await checkImage(bad, "t.simg", "userdata", info);
  assert.ok(c.problems.some((p) => /HFS\+ volume header/.test(p)));
  const good = await checkImage(bufferSource(withHfsHeader(makeSparse([{ type: "raw", blocks: 20 }]))), "t.simg", "userdata", info);
  assert.deepEqual(good.problems.filter((p) => !/not an iOS root image/.test(p)), []);
  // boot images keep their own rule and are not subject to the HFS check
  const boot = new Uint8Array(2 << 20);
  boot.set(new TextEncoder().encode("ANDROID!"));
  assert.deepEqual((await checkImage(bufferSource(boot), "boot.img", "boot", info)).problems, []);
});

// ---- F-02: slots, typed phrase, backup gate ----------------------------------------------------------------------

test("F-02: slot parsing and the phrase the user must type", () => {
  assert.equal(normalizeSlot("a"), "a");
  assert.equal(normalizeSlot("_b"), "b");
  assert.equal(normalizeSlot("c"), null);
  assert.equal(normalizeSlot(null), null);
  assert.equal(confirmPhrase("userdata", { currentSlot: "a", slotCount: 2 }), "userdata");
  assert.equal(confirmPhrase("boot", { currentSlot: "a", slotCount: 2 }), "boot_a");
  assert.equal(confirmPhrase("boot", { currentSlot: "_b", slotCount: null }), "boot_b");
  assert.equal(confirmPhrase("boot", { currentSlot: null, slotCount: null }), "boot"); // a non-A/B phone
});

test("F-02: boot on an A/B phone with an unknown slot, and a missing backup tick, block the write", () => {
  const ab = { currentSlot: null, slotCount: 2 };
  assert.match(writeProblems("boot", ab, true)[0], /which one is active/);
  assert.match(writeProblems("boot", { currentSlot: "a", slotCount: 2 }, false)[0], /backup box/);
  assert.match(writeProblems("userdata", { currentSlot: "a", slotCount: 2 }, false)[0], /backup box/);
  assert.deepEqual(writeProblems("boot", { currentSlot: "a", slotCount: 2 }, true), []);
  assert.deepEqual(writeProblems("userdata", { currentSlot: null, slotCount: null }, true), []);
  assert.deepEqual(writeProblems("logo", ab, false), [], "logo is not gated by the backup box");
});

test("F-02: identify reads current-slot and slot-count", async () => {
  const info = await identify(await FastbootDevice.open(new FakePhone(4096, { ...ABL, "current-slot": "b", "slot-count": "2" }).usb()));
  assert.equal(info.currentSlot, "b");
  assert.equal(info.slotCount, 2);
  const none = await identify(await FastbootDevice.open(new FakePhone(4096, ABL).usb()));
  assert.equal(none.currentSlot, null);
  assert.equal(none.slotCount, null);
});

// ---- F-04: system apps -------------------------------------------------------------------------------------------

test("F-04: system app names and Apple bundle ids are refused", () => {
  for (const n of ["SpringBoard.app", "MobileSafari.app", "springboard.app", "PosterBoard.app", "Preferences.app", "App Store.app", "com.apple.Foo.app"]) {
    assert.match(appNameProblem(n)!, /system app/, n);
  }
  for (const n of ["../x.app", ".hidden.app", "a/b.app", "x;rm.app", "x'.app", "Foo", "Foo.app/..", ""]) {
    assert.match(appNameProblem(n)!, /refusing the app folder name/, n);
  }
  assert.equal(appNameProblem("My Game.app"), null);
  assert.equal(appNameProblem("Delta-1.2.app"), null);
  assert.match(bundleIdProblem("com.apple.mobilesafari")!, /Apple/);
  assert.equal(bundleIdProblem("org.example.game"), null);
  assert.throws(() => installScript("SpringBoard.app"), /system app/);
  assert.throws(() => removeScript("MobileSafari.app"), /system app/);
});

// The scripts are plain sh: run them in a temp folder with a fake sweetuicache to see what they really do.
function sandbox() {
  const d = mkdtempSync(join(tmpdir(), "bergamota-ipa-"));
  const apps = join(d, "Applications");
  const marks = join(d, "marks");
  mkdirSync(apps);
  const uic = join(d, "uic.sh");
  writeFileSync(uic, `#!/bin/sh\necho "uic $*" >> ${JSON.stringify(join(d, "uic.log"))}\n`, { mode: 0o755 });
  return { d, apps, marks, uic };
}
function tarOf(files: Record<string, string>): Buffer {
  const d = mkdtempSync(join(tmpdir(), "bergamota-tar-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(d, p, ".."), { recursive: true });
    writeFileSync(join(d, p), c);
  }
  const r = spawnSync("tar", ["-cf", "-", "-C", d, "."], { maxBuffer: 1 << 24 });
  rmSync(d, { recursive: true, force: true });
  return r.stdout;
}
const sh = (script: string, input?: Buffer) => spawnSync("sh", ["-c", script], { input, encoding: "utf8" });

test("F-04: install is staged, marks the app, and replaces only what it may", () => {
  const s = sandbox();
  try {
    const tar = tarOf({ "My Game.app/Info.plist": "org.example.game", "My Game.app/My Game": "bin" });
    let r = sh(installScript("My Game.app", s.apps, s.marks, s.uic, ""), tar);
    assert.match(r.stdout, /exit 0/, r.stdout + r.stderr);
    assert.ok(existsSync(join(s.apps, "My Game.app", "Info.plist")));
    assert.ok(existsSync(join(s.marks, "My Game.app")), "sideload marker written outside the bundle");
    assert.deepEqual(readFileSync(join(s.d, "uic.log"), "utf8").trim(), `uic ${"My Game.app"}`);
    assert.ok(!sh(`ls -A ${JSON.stringify(s.apps)}`).stdout.includes(".bergamota-stage"), "no staging folder left");
    // a reinstall replaces it
    r = sh(installScript("My Game.app", s.apps, s.marks, s.uic, ""), tarOf({ "My Game.app/Info.plist": "v2" }));
    assert.equal(readFileSync(join(s.apps, "My Game.app", "Info.plist"), "utf8"), "v2");
  } finally {
    rmSync(s.d, { recursive: true, force: true });
  }
});

test("F-04: an unmarked folder with an Apple bundle id is not replaced (and nothing is lost)", () => {
  const s = sandbox();
  try {
    mkdirSync(join(s.apps, "Gadget.app"));
    writeFileSync(join(s.apps, "Gadget.app", "Info.plist"), "com.apple.gadget");
    const r = sh(installScript("Gadget.app", s.apps, s.marks, s.uic, ""), tarOf({ "Gadget.app/Info.plist": "evil" }));
    assert.match(r.stdout, /refusing/);
    assert.equal(readFileSync(join(s.apps, "Gadget.app", "Info.plist"), "utf8"), "com.apple.gadget");
    assert.ok(!existsSync(join(s.marks, "Gadget.app")));
    const rm = sh(removeScript("Gadget.app", s.apps, s.marks, s.uic));
    assert.match(rm.stdout, /refusing/);
    assert.ok(existsSync(join(s.apps, "Gadget.app")));
  } finally {
    rmSync(s.d, { recursive: true, force: true });
  }
});

test("F-04: a broken archive leaves the installed app untouched", () => {
  const s = sandbox();
  try {
    sh(installScript("Keep.app", s.apps, s.marks, s.uic, ""), tarOf({ "Keep.app/Info.plist": "v1" }));
    // an archive that does not contain the app folder
    let r = sh(installScript("Keep.app", s.apps, s.marks, s.uic, ""), tarOf({ "Other.app/Info.plist": "x" }));
    assert.match(r.stdout, /nothing changed/);
    assert.equal(readFileSync(join(s.apps, "Keep.app", "Info.plist"), "utf8"), "v1");
    // not a tar at all
    r = sh(installScript("Keep.app", s.apps, s.marks, s.uic, ""), Buffer.from("this is not a tar archive".repeat(50)));
    assert.equal(readFileSync(join(s.apps, "Keep.app", "Info.plist"), "utf8"), "v1");
    assert.ok(!sh(`ls -A ${JSON.stringify(s.apps)}`).stdout.includes(".bergamota-stage"));
  } finally {
    rmSync(s.d, { recursive: true, force: true });
  }
});

test("F-04: a marked app can be removed", () => {
  const s = sandbox();
  try {
    sh(installScript("Tmp.app", s.apps, s.marks, s.uic, ""), tarOf({ "Tmp.app/Info.plist": "x" }));
    const r = sh(removeScript("Tmp.app", s.apps, s.marks, s.uic));
    assert.match(r.stdout, /removed/);
    assert.ok(!existsSync(join(s.apps, "Tmp.app")));
    assert.ok(!existsSync(join(s.marks, "Tmp.app")));
    assert.match(sh(removeScript("Tmp.app", s.apps, s.marks, s.uic)).stdout, /no such app/);
  } finally {
    rmSync(s.d, { recursive: true, force: true });
  }
});
