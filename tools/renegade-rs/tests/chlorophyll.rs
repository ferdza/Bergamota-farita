//! chlorophyll(): the GPU userland goes into the root and backboardd links the inject, armed by default.
use renegade::tools::{chlorophyll_at, has_dylib, Tools};
use renegade::tweaks::{DirFs, Fs};
use std::collections::BTreeMap;

fn fixture() -> Vec<u8> {
    let b = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/exe")).unwrap();
    if renegade::codesign::identity(&b).is_some() { b } else { renegade::codesign::resign(&b, None, None).unwrap() }
}

fn bundle(all: bool) -> Tools {
    let mut f = BTreeMap::new();
    for n in ["bgmtl-inject.dylib", "libchlorophyll.dylib", "libdrm.2.dylib"].iter().take(if all { 3 } else { 2 }) {
        f.insert(format!("bgmtl/{n}"), n.as_bytes().to_vec());
    }
    Tools::from_files(f)
}

fn root(name: &str) -> (std::path::PathBuf, DirFs) {
    let d = std::env::temp_dir().join(format!("renegade-chl-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(d.join("usr/libexec")).unwrap();
    std::fs::write(d.join("usr/libexec/backboardd"), fixture()).unwrap();
    (d.clone(), DirFs::new(&d))
}

#[test]
fn wires_backboardd_and_arms_it() {
    let (d, mut fs) = root("ok");
    let before = std::fs::read(d.join("usr/libexec/backboardd")).unwrap();
    let mut log = vec![];
    chlorophyll_at(&mut fs, &mut log, &bundle(true), "/a.dyl", "/s.dyl").unwrap();
    assert!(log[0].starts_with("chlorophyll: libraries in"), "{log:?}");
    let now = std::fs::read(d.join("usr/libexec/backboardd")).unwrap();
    assert!(has_dylib(&now, "/a.dyl") && !has_dylib(&before, "/a.dyl"));
    assert_eq!(std::fs::read(d.join("usr/libexec/backboardd.orig")).unwrap(), before, "the pristine binary is kept");
    for f in ["bgmtl-inject.dylib", "libchlorophyll.dylib", "libdrm.2.dylib"] {
        assert!(d.join("usr/local/lib/bgmtl").join(f).is_file(), "{f}");
    }
    assert!(d.join("private/var/tmp/bgmtl-bb.arm").is_file() && d.join("private/var/tmp/bgmtl-bb.direct").is_file());
    // a second run wires from the kept original, not from the wired binary: still one load command
    let mut log2 = vec![];
    chlorophyll_at(&mut fs, &mut log2, &bundle(true), "/a.dyl", "/s.dyl").unwrap();
    assert_eq!(std::fs::read(d.join("usr/libexec/backboardd.orig")).unwrap(), before);
    assert!(has_dylib(&std::fs::read(d.join("usr/libexec/backboardd")).unwrap(), "/a.dyl"));
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn a_long_path_falls_back_to_the_short_symlink() {
    let (d, mut fs) = root("short");
    let mut log = vec![];
    let long = "/usr/local/lib/bgmtl/bgmtl-inject.dylib";
    chlorophyll_at(&mut fs, &mut log, &bundle(true), long, "/s.dyl").unwrap();
    assert!(log[0].starts_with("chlorophyll: libraries in"), "{log:?}");
    assert!(has_dylib(&std::fs::read(d.join("usr/libexec/backboardd")).unwrap(), "/s.dyl"));
    assert_eq!(fs.readlink("s.dyl").as_deref(), Some(long));
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn nothing_changes_without_every_file_or_a_backboardd() {
    let (d, mut fs) = root("missing");
    let before = std::fs::read(d.join("usr/libexec/backboardd")).unwrap();
    let mut log = vec![];
    chlorophyll_at(&mut fs, &mut log, &bundle(false), "/a.dyl", "/s.dyl").unwrap();
    assert!(log[0].contains("not in the tools bundle"), "{log:?}");
    assert_eq!(std::fs::read(d.join("usr/libexec/backboardd")).unwrap(), before);
    assert!(!d.join("usr/local/lib/bgmtl").exists() && !d.join("private/var/tmp/bgmtl-bb.arm").exists());
    std::fs::remove_file(d.join("usr/libexec/backboardd")).unwrap();
    let mut log = vec![];
    chlorophyll_at(&mut fs, &mut log, &bundle(true), "/a.dyl", "/s.dyl").unwrap();
    assert!(log[0].contains("no /usr/libexec/backboardd"), "{log:?}");
    let _ = std::fs::remove_dir_all(&d);
}
