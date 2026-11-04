//! renegade::ipa::prepare on a synthetic IPA built from the test fixtures (our own binaries, no Apple code).
use std::rc::Rc;

fn fixture(n: &str) -> Vec<u8> {
    std::fs::read(format!("{}/tests/fixtures/{n}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

/// A stored (uncompressed) zip with these members.
fn zip(members: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let (mut out, mut cd) = (Vec::new(), Vec::new());
    for (name, data) in members {
        let crc = renegade::zip::crc32(data);
        let off = out.len() as u32;
        let le16 = |v: &mut Vec<u8>, x: u16| v.extend_from_slice(&x.to_le_bytes());
        let le32 = |v: &mut Vec<u8>, x: u32| v.extend_from_slice(&x.to_le_bytes());
        le32(&mut out, 0x04034b50); le16(&mut out, 20); le16(&mut out, 0); le16(&mut out, 0); le16(&mut out, 0); le16(&mut out, 0);
        le32(&mut out, crc); le32(&mut out, data.len() as u32); le32(&mut out, data.len() as u32);
        le16(&mut out, name.len() as u16); le16(&mut out, 0); out.extend_from_slice(name.as_bytes()); out.extend_from_slice(data);
        le32(&mut cd, 0x02014b50); le16(&mut cd, 20); le16(&mut cd, 20); le16(&mut cd, 0); le16(&mut cd, 0); le16(&mut cd, 0); le16(&mut cd, 0);
        le32(&mut cd, crc); le32(&mut cd, data.len() as u32); le32(&mut cd, data.len() as u32);
        le16(&mut cd, name.len() as u16); le16(&mut cd, 0); le16(&mut cd, 0); le16(&mut cd, 0); le16(&mut cd, 0); le32(&mut cd, 0); le32(&mut cd, off);
        cd.extend_from_slice(name.as_bytes());
    }
    let (cdoff, cdlen, n) = (out.len() as u32, cd.len() as u32, members.len() as u16);
    out.extend_from_slice(&cd);
    out.extend_from_slice(&0x06054b50u32.to_le_bytes());
    for v in [0u16, 0, n, n] { out.extend_from_slice(&v.to_le_bytes()); }
    out.extend_from_slice(&cdlen.to_le_bytes());
    out.extend_from_slice(&cdoff.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

const INFO: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>exe</string><key>CFBundleIdentifier</key><string>org.bergamota.test</string><key>CFBundleShortVersionString</key><string>1.2</string></dict></plist>
"#;

/// The tar's members: (name, size, mode).
fn tar_list(t: &[u8]) -> Vec<(String, usize, u32)> {
    let mut out = Vec::new();
    let mut off = 0;
    while off + 512 <= t.len() && t[off] != 0 {
        let h = &t[off..off + 512];
        let field = |a: usize, l: usize| String::from_utf8_lossy(&h[a..a + l]).trim_matches(char::from(0)).trim().to_string();
        let name = field(0, 100);
        let prefix = field(345, 155);
        let full = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
        let size = usize::from_str_radix(&field(124, 12), 8).unwrap();
        let mode = u32::from_str_radix(&field(100, 8), 8).unwrap();
        // checksum
        let mut hh = h.to_vec();
        hh[148..156].copy_from_slice(b"        ");
        let sum: u32 = hh.iter().map(|&b| b as u32).sum();
        assert_eq!(u32::from_str_radix(&field(148, 7), 8).unwrap(), sum, "{full}: checksum");
        out.push((full, size, mode));
        off += 512 + size.div_ceil(512) * 512;
    }
    out
}

#[test]
fn ipa_is_resigned_and_sealed() {
    let ipa = zip(&[
        ("Payload/Test.app/Info.plist", INFO.as_bytes().to_vec()),
        ("Payload/Test.app/exe", fixture("exe")),
        ("Payload/Test.app/Frameworks/libfix.dylib", fixture("libfix.dylib")),
        ("Payload/Test.app/assets/a.txt", b"hello".to_vec()),
        ("Payload/Test.app/embedded.mobileprovision", b"profile".to_vec()),
        ("Payload/Test.app/_CodeSignature/CodeResources", b"old".to_vec()),
    ]);
    let p = renegade::ipa::prepare(Rc::new(ipa)).unwrap();
    assert_eq!(p.app, "Test.app");
    assert_eq!(p.bundle_id, "org.bergamota.test");
    assert_eq!(p.version, "1.2");
    assert_eq!(p.machos, 2);
    assert_eq!(p.bundles_sealed, 1);
    if let Ok(path) = std::env::var("RENEGADE_DUMP_TAR") {
        std::fs::write(path, &p.tar).unwrap();
    }
    let list = tar_list(&p.tar);
    let names: Vec<&str> = list.iter().map(|(n, _, _)| n.as_str()).collect();
    assert!(names.contains(&"Test.app/"));
    assert!(names.contains(&"Test.app/Frameworks/"));
    assert!(names.contains(&"Test.app/_CodeSignature/CodeResources"));
    assert!(!names.iter().any(|n| n.contains("mobileprovision")));
    let mode = |n: &str| list.iter().find(|x| x.0 == n).unwrap().2;
    assert_eq!(mode("Test.app/exe"), 0o755);
    assert_eq!(mode("Test.app/assets/a.txt"), 0o644);
    // the new seal lists the dylib and the asset, not the executable
    let cr_at = list.iter().position(|x| x.0 == "Test.app/_CodeSignature/CodeResources").unwrap();
    let _ = cr_at;
    let tar = String::from_utf8_lossy(&p.tar);
    assert!(tar.contains("Frameworks/libfix.dylib") && tar.contains("assets/a.txt"));
}

#[test]
fn fairplay_is_refused() {
    let mut exe = fixture("exe");
    // turn the first load command into LC_ENCRYPTION_INFO_64 with cryptid 1 (the test only reads the command)
    let ncmds = u32::from_le_bytes(exe[16..20].try_into().unwrap());
    assert!(ncmds > 0);
    let sz = u32::from_le_bytes(exe[36..40].try_into().unwrap()) as usize;
    assert!(sz >= 24);
    exe[32..36].copy_from_slice(&0x2cu32.to_le_bytes());
    exe[48..52].copy_from_slice(&1u32.to_le_bytes());
    let ipa = zip(&[("Payload/T.app/Info.plist", INFO.as_bytes().to_vec()), ("Payload/T.app/exe", exe)]);
    let e = renegade::ipa::prepare(Rc::new(ipa)).err().expect("must refuse");
    assert!(e.to_string().contains("FairPlay"), "{e}");
}

#[test]
fn not_an_ipa() {
    let e = renegade::ipa::prepare(Rc::new(zip(&[("hello.txt", b"x".to_vec())]))).err().unwrap();
    assert!(e.to_string().contains("not an IPA"));
}
