import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FastbootDevice } from "../src/lib/fastboot.ts";
import { checkImage, flash, identify, phoneProblems } from "../src/lib/flasher.ts";
import { FastbootError } from "../src/lib/fastboot.ts";
import { bootSlot, identityProblems, identityVerdict, OVERRIDE_PHRASE, appNameProblem, bundleIdProblem, confirmPhrase, hfsVolumeProblem, installScript, installUserScript, normalizeSlot, readExpanded, removeScript, writeProblems } from "../src/lib/guards.ts";
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
  assert.match(writeProblems("boot", { currentSlot: "a", slotCount: 2, hasSlotBoot: "yes" }, false)[0], /backup box/);
  assert.match(writeProblems("userdata", { currentSlot: "a", slotCount: 2 }, false)[0], /backup box/);
  assert.deepEqual(writeProblems("boot", { currentSlot: "a", slotCount: 2, hasSlotBoot: "yes" }, true), []);
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

// ---- F-01: identity beyond product=sdm845 ---------------------------------------------------------------------------

const SDM = { ...ABL, product: "sdm845", "slot-count": "2", "current-slot": "a", "has-slot:boot": "yes" };

test("F-01: product sdm845 alone is unverified and needs the typed phrase", async () => {
  const info = await identify(await FastbootDevice.open(new FakePhone(4096, SDM).usb()));
  assert.equal(identityVerdict({ product: info.product, kind: info.kind, slotCount: info.slotCount, vars: info.vars }).level, "unverified");
  const p = phoneProblems(info);
  assert.equal(p.length, 1);
  assert.match(p[0], /cannot confirm it is a OnePlus 6T/);
  assert.deepEqual(phoneProblems(info, "this is a oneplus 6t"), p, "the phrase is case-sensitive");
  assert.deepEqual(phoneProblems(info, `  ${OVERRIDE_PHRASE} `), []);
});

test("F-01: another SDM845 phone with one slot is refused outright, the override does not help", async () => {
  const info = await identify(await FastbootDevice.open(new FakePhone(4096, { ...SDM, "slot-count": "1" }).usb()));
  assert.match(phoneProblems(info, OVERRIDE_PHRASE)[0], /another phone/);
});

test("F-01: beryllium and Enxerto's fajita are exact, unknown products are refused", async () => {
  const bery = await identify(await FastbootDevice.open(new FakePhone(4096, ABL).usb()));
  assert.deepEqual(phoneProblems(bery), []);
  const enx = await identify(await FastbootDevice.open(new FakePhone(4096, { ...ABL, product: "fajita", "version-bootloader": "bergamota-3", "bergamota-flash": "1" }).usb()));
  assert.equal(enx.kind, "bergamota");
  assert.deepEqual(phoneProblems(enx), []);
  // a plain ABL claiming "fajita" is not Enxerto: not accepted without the phrase path (it is not sdm845 either)
  const abl = await identify(await FastbootDevice.open(new FakePhone(4096, { ...ABL, product: "fajita" }).usb()));
  assert.match(phoneProblems(abl)[0], /Unsupported phone/);
  for (const prod of ["sagit", "enchilada", "", "SDM845", "sdm845 "]) {
    assert.match(identityProblems({ product: prod, kind: "abl", slotCount: 2, vars: [] }, OVERRIDE_PHRASE)[0] ?? "", /Unsupported/, prod);
  }
  assert.match(identityProblems({ product: null, kind: "abl", slotCount: null, vars: [] }, OVERRIDE_PHRASE)[0], /unknown/);
});

test("F-01: the read-only identity variables are collected for the user to see", async () => {
  const info = await identify(await FastbootDevice.open(new FakePhone(4096, { ...SDM, secure: "no", "partition-size:modem_a": "0x4000000" }).usb()));
  const names = info.vars.map(([k]) => k);
  for (const n of ["product", "secure", "slot-count", "current-slot", "has-slot:boot", "partition-size:modem_a"]) assert.ok(names.includes(n), n);
});

// ---- F-02: boot is flashed to the named slot -----------------------------------------------------------------------------

test("F-02: boot goes to boot_<current-slot>, never the bare name, on an A/B phone", async () => {
  const phone = new FakePhone(1 << 20, { ...SDM, "current-slot": "_b", "partition-size:boot": "0x100000" });
  const fb = await FastbootDevice.open(phone.usb());
  const info = await identify(fb);
  const boot = new Uint8Array(200 * 1024);
  boot.set(new TextEncoder().encode("ANDROID!"));
  const src = bufferSource(boot);
  const checked = await checkImage(src, "boot.img", "boot", info);
  assert.deepEqual(checked.problems, []);
  assert.equal(bootSlot(info), "b");
  await flash({ fb, src, partition: "boot", checked, onProgress: () => {}, slot: bootSlot(info) });
  assert.ok(phone.log.includes("flash:boot_b"), phone.log.join(","));
  assert.ok(!phone.log.includes("flash:boot"));
});

test("F-02: the slot can only be attached to boot, and only a/b", async () => {
  const phone = new FakePhone(4096, SDM);
  const fb = await FastbootDevice.open(phone.usb());
  // @ts-expect-error deliberately wrong
  await assert.rejects(fb.flash("userdata", "a"), FastbootError);
  // @ts-expect-error deliberately wrong
  await assert.rejects(fb.flash("boot", "c"), FastbootError);
  const cmd = (fb as unknown as { command(c: string): Promise<unknown> }).command.bind(fb);
  for (const c of ["flash:boot_c", "flash:boot_ab", "flash:userdata_a", "flash:modem_a", "flash:boot_a "]) await assert.rejects(cmd(c), /not an allowed command/, c);
  assert.deepEqual(phone.log, []);
});

test("F-02: has-slot:boot must be confirmed on an A/B phone", () => {
  assert.match(writeProblems("boot", { currentSlot: "a", slotCount: 2, hasSlotBoot: null }, true)[0], /has-slot:boot/);
  assert.deepEqual(writeProblems("boot", { currentSlot: "a", slotCount: 2, hasSlotBoot: "yes" }, true), []);
  assert.equal(bootSlot({ currentSlot: "a", slotCount: 2, hasSlotBoot: "no" }), null);
  assert.equal(bootSlot({ currentSlot: null, slotCount: null }), null);
});

test("normal-app install: own bundle container and data container, ids kept on reinstall, removed together", () => {
  const s = sandbox();
  const B = join(s.d, "bundles"), D = join(s.d, "data");
  const BU = "11111111-2222-3333-4444-555555555555", DU = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
  try {
    mkdirSync(B, { recursive: true });
    mkdirSync(D, { recursive: true });
    let r = sh(installUserScript("My Game.app", "org.example.game", BU, DU, s.marks, s.uic, B, D, ""), tarOf({ "My Game.app/Info.plist": "v1", "My Game.app/My Game": "bin" }));
    assert.match(r.stdout, /\[5\/5\] sweetuicache exit 0/, r.stdout + r.stderr);
    assert.ok(existsSync(join(B, BU, "My Game.app", "Info.plist")));
    for (const d of ["Documents", "Library/Caches", "Library/Preferences", "tmp"]) assert.ok(existsSync(join(D, DU, d)), d);
    assert.match(readFileSync(join(D, DU, ".com.apple.mobile_container_manager.metadata.plist"), "utf8"), /org\.example\.game.*DUPLACEHOLDER|MCMMetadataContentClass<\/key><integer>2/s);
    assert.ok(readFileSync(join(D, DU, ".com.apple.mobile_container_manager.metadata.plist"), "utf8").includes(DU), "data metadata names its own uuid");
    assert.ok(readFileSync(join(B, BU, ".com.apple.mobile_container_manager.metadata.plist"), "utf8").includes(BU));
    assert.equal(readFileSync(join(s.marks, "My Game.app"), "utf8").trim(), `${BU} ${DU}`);
    assert.match(readFileSync(join(s.d, "uic.log"), "utf8"), new RegExp(`uic -U ${B}/${BU}/My Game.app ${D}/${DU}`));
    // a reinstall with fresh ids keeps the first ones (and the data)
    writeFileSync(join(D, DU, "Documents", "save.dat"), "progress");
    r = sh(installUserScript("My Game.app", "org.example.game", "99999999-2222-3333-4444-555555555555", "99999999-BBBB-CCCC-DDDD-EEEEEEEEEEEE", s.marks, s.uic, B, D, ""), tarOf({ "My Game.app/Info.plist": "v2" }));
    assert.equal(readFileSync(join(B, BU, "My Game.app", "Info.plist"), "utf8"), "v2");
    assert.equal(readFileSync(join(D, DU, "Documents", "save.dat"), "utf8"), "progress");
    // remove deletes both containers and the marker
    r = sh(removeScript("My Game.app", s.apps, s.marks, s.uic, B, D));
    assert.match(r.stdout, /removed/, r.stdout + r.stderr);
    assert.ok(!existsSync(join(B, BU)) && !existsSync(join(D, DU)) && !existsSync(join(s.marks, "My Game.app")));
  } finally {
    rmSync(s.d, { recursive: true, force: true });
  }
});
