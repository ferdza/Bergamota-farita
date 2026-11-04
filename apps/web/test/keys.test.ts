import { test } from "node:test";
import assert from "node:assert/strict";
import { keyUrls, neededBytes, pemProblem } from "../src/patcher/patcher.ts";

test("pemProblem accepts Apple's PEM and refuses anything else", () => {
  const pem = "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg\n-----END PRIVATE KEY-----\n";
  assert.equal(pemProblem(pem), null);
  assert.equal(pemProblem("  " + pem + "  "), null, "surrounding whitespace is fine");
  assert.match(pemProblem("<html>301 Moved</html>")!, /not the key file/);
  assert.match(pemProblem("-----BEGIN PRIVATE KEY-----\n" + "A".repeat(5000) + "\n-----END PRIVATE KEY-----")!, /too big/);
});

test("keyUrls lists each needed key once", () => {
  const info = {
    images: [
      { name: "a", path: "a", encrypted: true, keyUrl: "https://wkms-public.apple.com/fcs-keys/K1" },
      { name: "b", path: "b", encrypted: true, keyUrl: "https://wkms-public.apple.com/fcs-keys/K1" },
      { name: "c", path: "c", encrypted: true, keyUrl: "https://wkms-public.apple.com/fcs-keys/K2" },
      { name: "d", path: "d", encrypted: false, keyUrl: null },
    ],
  } as unknown as Parameters<typeof keyUrls>[0];
  assert.deepEqual(keyUrls(info), ["https://wkms-public.apple.com/fcs-keys/K1", "https://wkms-public.apple.com/fcs-keys/K2"]);
});

test("storage need follows the profile (iOS 18 root is smaller)", () => {
  assert.equal(neededBytes("ios18"), 17 * 2 ** 30);
  assert.equal(neededBytes("ios26"), 22 * 2 ** 30);
  assert.equal(neededBytes(null), 22 * 2 ** 30, "unknown profile: the largest");
});
