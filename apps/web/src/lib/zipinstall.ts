// "Install a .zip" over SSH: the zip is laid out as the paths its files go to on the phone (chlorophyll-ios18.zip from
// .github/workflows/chlorophyll.yml: usr/local/lib/bgmtl/..., var/root/chl-test/...). Only a few user-owned trees are writable
// this way, so a zip can never replace a system file; everything else is listed as skipped.

export const ZIP_ROOTS = ["usr/local/", "var/root/", "var/mobile/", "private/var/root/", "private/var/mobile/"];

export type ZipPlan = { install: { path: string; data: Uint8Array; mode: string }[]; skipped: string[] };

/** Mach-O (thin or fat) gets 755, anything else 644. */
export function modeFor(data: Uint8Array): string {
  if (data.length < 4) return "644";
  const be = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
  const le = ((data[3] << 24) | (data[2] << 16) | (data[1] << 8) | data[0]) >>> 0;
  const macho = [0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcafebabf];
  return macho.includes(be) || macho.includes(le) ? "755" : "644";
}

export function planZip(files: Record<string, Uint8Array>): ZipPlan {
  const plan: ZipPlan = { install: [], skipped: [] };
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith("/")) continue;
    const rel = name.replace(/^\.\//, "");
    const ok =
      ZIP_ROOTS.some((r) => rel.startsWith(r)) && /^[A-Za-z0-9._/+-]+$/.test(rel) && !rel.split("/").some((p) => p === ".." || p === "");
    if (!ok || rel.startsWith("__MACOSX/")) plan.skipped.push(rel);
    else plan.install.push({ path: "/" + rel, data, mode: modeFor(data) });
  }
  plan.install.sort((a, b) => a.path.localeCompare(b.path));
  return plan;
}
