//! IPA sideload for the web page (tools/sweet-install-ipa.sh without a Mac): the `.ipa` zip in, a ustar archive of
//! `<Name>.app/...` out, ready for `tar -x -C /Applications` on the phone and `sweetuicache` to register it.
//!
//! Every Mach-O of the bundle is PAC-stripped (arm64e -> ARMv8.0, a no-op for arm64 code) and re-signed ad hoc, keeping
//! its identifier, flags and entitlements; inside-out, so each bundle's main executable is sealed last, with a fresh
//! `_CodeSignature/CodeResources` over its final files. FairPlay-encrypted code (an App Store download) is refused: it
//! cannot run here and rewriting it would corrupt it. The provisioning profile is dropped (nothing checks it here).

use crate::bundle::{self, Item};
use crate::io::{bad, Src};
use std::collections::BTreeMap;
use std::io::Result;

/// What [`prepare`] made.
pub struct Prepared {
    /// `Name.app`
    pub app: String,
    pub bundle_id: String,
    pub version: String,
    /// the archive: `Name.app/...`, directories 755, Mach-Os 755, other files 644
    pub tar: Vec<u8>,
    pub machos: usize,
    /// Mach-Os that had pointer-authentication code rewritten
    pub pac_rewritten: usize,
    pub bundles_sealed: usize,
    pub files: usize,
}

fn is_macho(d: &[u8]) -> bool {
    d.len() >= 32 && matches!(&d[..4], [0xcf, 0xfa, 0xed, 0xfe] | [0xca, 0xfe, 0xba, 0xbe] | [0xca, 0xfe, 0xba, 0xbf])
}

/// True if a slice carries LC_ENCRYPTION_INFO(_64) with cryptid != 0.
fn fairplay(d: &[u8]) -> bool {
    for base in crate::macho::slices(d) {
        let Ok(lcs) = crate::macho::load_commands(d, base) else { continue };
        for lc in lcs {
            if (lc.cmd == 0x21 || lc.cmd == 0x2c) && lc.off + 20 <= d.len() && crate::bytes::u32le(d, lc.off + 16) != 0 {
                return true;
            }
        }
    }
    false
}

fn plist_str(info: Option<&[u8]>, key: &str) -> Option<String> {
    let v = crate::plist::parse(info?).ok()?;
    v.get(key).and_then(|x| x.as_str()).map(str::to_string)
}

/// Unpacks, rewrites and re-seals `ipa`; the tar is in the result.
pub fn prepare(ipa: Src) -> Result<Prepared> {
    let z = crate::zip::Zip::open(ipa)?;
    let app = z
        .entries
        .iter()
        .filter_map(|e| e.name.strip_prefix("Payload/"))
        .filter_map(|n| n.split('/').next())
        .find(|n| n.ends_with(".app"))
        .ok_or_else(|| bad("no Payload/*.app in this file: not an IPA"))?
        .to_string();
    if app.contains("..") || app.contains('\\') {
        return Err(bad(format!("odd app folder name {app:?}")));
    }
    let prefix = format!("Payload/{app}/");
    // the bundle's files, paths relative to Payload/ ("Name.app/...")
    let mut files: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    for e in &z.entries {
        let Some(rel) = e.name.strip_prefix("Payload/") else { continue };
        if !e.name.starts_with(&prefix) || e.name.ends_with('/') {
            continue;
        }
        if rel.split('/').any(|c| c == ".." || c.is_empty()) {
            return Err(bad(format!("refusing path {:?}", e.name)));
        }
        let name = rel.rsplit('/').next().unwrap_or(rel);
        // old seals are rewritten below; the profile is not used by anything here
        if rel.contains("/_CodeSignature/") || name == "embedded.mobileprovision" || name == ".DS_Store" {
            continue;
        }
        files.insert(rel.to_string(), z.read_all(e)?);
    }
    let info = files.get(&format!("{app}/Info.plist")).cloned();
    let bundle_id = plist_str(info.as_deref(), "CFBundleIdentifier").unwrap_or_default();
    let version = plist_str(info.as_deref(), "CFBundleShortVersionString").unwrap_or_default();

    let machos: Vec<String> = files.iter().filter(|(_, d)| is_macho(d)).map(|(p, _)| p.clone()).collect();
    for p in &machos {
        if fairplay(&files[p]) {
            return Err(bad(format!(
                "{p} is FairPlay-encrypted (an App Store download): it cannot run here; use a decrypted IPA"
            )));
        }
    }
    let dir_of = |p: &str| p.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default();
    let is_main = |files: &BTreeMap<String, Vec<u8>>, p: &str| -> bool {
        let (dir, name) = p.rsplit_once('/').unwrap_or(("", p));
        let info = files.get(&format!("{dir}/Info.plist"));
        let dir_name = dir.rsplit('/').next().unwrap_or(dir);
        bundle::is_main_executable(info.map(|v| v.as_slice()), dir_name, name)
    };
    // deepest first; in one folder the bundle's main executable last (its seal covers its siblings' final bytes)
    let mut order: Vec<(usize, bool, String)> =
        machos.iter().map(|p| (p.matches('/').count(), is_main(&files, p), p.clone())).collect();
    order.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));

    let (mut pac, mut sealed) = (0usize, 0usize);
    for (_, main, p) in &order {
        let mut d = files[p].clone();
        let rep = crate::pacstrip::strip(&mut d, &crate::pacstrip::Options { write: true, ..Default::default() })?;
        if rep.summary() != "no PAC code" && !rep.summary().is_empty() {
            pac += 1;
        }
        let (mut info_plist, mut cr) = (None, None);
        if *main {
            let dir = dir_of(p);
            let pre = format!("{dir}/");
            let exe = p.rsplit('/').next().unwrap_or(p);
            let mut items: Vec<(String, Item)> = Vec::new();
            for (q, data) in files.range(pre.clone()..) {
                let Some(rel) = q.strip_prefix(&pre) else { break };
                if rel == exe {
                    continue;
                }
                items.push((rel.to_string(), Item::file(data)));
            }
            let res = bundle::code_resources(&items);
            files.insert(format!("{dir}/_CodeSignature/CodeResources"), res.clone());
            info_plist = files.get(&format!("{dir}/Info.plist")).cloned();
            cr = Some(res);
            sealed += 1;
        }
        let signed = if crate::codesign::identity(&d).is_some() {
            crate::codesign::resign(&d, info_plist, cr)?
        } else {
            // never signed: a new ad-hoc signature named after the bundle (main executable) or the file
            let ident = if *main {
                plist_str(info_plist.as_deref(), "CFBundleIdentifier").unwrap_or_else(|| p.rsplit('/').next().unwrap_or(p).to_string())
            } else {
                p.rsplit('/').next().unwrap_or(p).trim_end_matches(".dylib").to_string()
            };
            let params = crate::codesign::Params { ident, flags: 0, entitlements: None, info_plist, code_resources: cr, page_shift: None };
            crate::codesign::sign(&d, &params)?
        };
        files.insert(p.clone(), signed);
    }

    // the archive, folders first
    let mut dirs: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for p in files.keys() {
        let mut cur = String::new();
        for c in p.split('/').collect::<Vec<_>>().split_last().map(|(_, d)| d.to_vec()).unwrap_or_default() {
            if !cur.is_empty() {
                cur.push('/');
            }
            cur.push_str(c);
            dirs.insert(cur.clone());
        }
    }
    let mut tar = Vec::new();
    for d in &dirs {
        tar_entry(&mut tar, &format!("{d}/"), b"", 0o755, b'5')?;
    }
    for (p, d) in &files {
        tar_entry(&mut tar, p, d, if is_macho(d) { 0o755 } else { 0o644 }, b'0')?;
    }
    tar.extend_from_slice(&[0u8; 1024]);
    Ok(Prepared { app, bundle_id, version, tar, machos: machos.len(), pac_rewritten: pac, bundles_sealed: sealed, files: files.len() })
}

/// One ustar header (+ data, padded to 512). Names over 100 bytes use the 155-byte prefix field.
fn tar_entry(out: &mut Vec<u8>, path: &str, data: &[u8], mode: u32, kind: u8) -> Result<()> {
    let mut h = [0u8; 512];
    let (prefix, name) = if path.len() <= 100 {
        ("", path)
    } else {
        let cut = path[..path.len().min(156)].rfind('/').filter(|&i| path.len() - i - 1 <= 100 && i <= 155);
        match cut {
            Some(i) => (&path[..i], &path[i + 1..]),
            None => return Err(bad(format!("path too long for the archive: {path}"))),
        }
    };
    h[..name.len()].copy_from_slice(name.as_bytes());
    let oct = |h: &mut [u8; 512], at: usize, len: usize, v: u64| {
        let s = format!("{:0w$o}", v, w = len - 1);
        h[at..at + len - 1].copy_from_slice(s.as_bytes());
    };
    oct(&mut h, 100, 8, mode as u64);
    oct(&mut h, 108, 8, 0); // uid root
    oct(&mut h, 116, 8, 80); // gid admin, as the shell script's chown 0:80
    oct(&mut h, 124, 12, data.len() as u64);
    oct(&mut h, 136, 12, 0);
    h[148..156].copy_from_slice(b"        ");
    h[156] = kind;
    h[257..263].copy_from_slice(b"ustar\0");
    h[263..265].copy_from_slice(b"00");
    h[345..345 + prefix.len()].copy_from_slice(prefix.as_bytes());
    let sum: u32 = h.iter().map(|&b| b as u32).sum();
    let s = format!("{:06o}\0 ", sum);
    h[148..156].copy_from_slice(s.as_bytes());
    out.extend_from_slice(&h);
    out.extend_from_slice(data);
    let pad = (512 - data.len() % 512) % 512;
    out.extend(std::iter::repeat_n(0u8, pad));
    Ok(())
}
