//! link_dylib (the web page's "wire Chlorophyll into backboardd"): weak load command added, ad-hoc signature kept valid.
use renegade::tools::{has_dylib, link_dylib};

fn fixture() -> Vec<u8> {
    let b = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/exe")).unwrap();
    // the fixture may be unsigned: sign it ad hoc first, as every binary of the root is
    if renegade::codesign::identity(&b).is_some() { b } else { renegade::codesign::resign(&b, None, None).unwrap() }
}

fn lc_cmds(d: &[u8]) -> Vec<(u32, String)> {
    let u = |o: usize| u32::from_le_bytes(d[o..o + 4].try_into().unwrap());
    let (mut off, mut out) = (32usize, vec![]);
    for _ in 0..u(16) {
        let (cmd, sz) = (u(off), u(off + 4) as usize);
        if matches!(cmd, 0xC | 0x8000_0018) {
            let no = u(off + 8) as usize;
            let nm = &d[off + no..off + sz];
            let z = nm.iter().position(|&c| c == 0).unwrap();
            out.push((cmd, String::from_utf8_lossy(&nm[..z]).into_owned()));
        }
        off += sz;
    }
    out
}

#[test]
fn weak_inject_resigned() {
    let bin = fixture();
    let id = renegade::codesign::identity(&bin).unwrap();
    // the fixture has 32 bytes of header slack (a system binary has far more): a short path fits
    let p = "/a.dyl";
    let out = link_dylib(&bin, p, true).unwrap();
    assert!(has_dylib(&out, p));
    assert!(lc_cmds(&out).contains(&(0x8000_0018, p.to_string())), "{:?}", lc_cmds(&out));
    let id2 = renegade::codesign::identity(&out).unwrap();
    assert_eq!(id.ident, id2.ident);
    assert_eq!(id.entitlements, id2.entitlements);
    // a second time is refused, not doubled
    assert!(link_dylib(&out, p, true).is_err());
}

#[test]
fn strong_link() {
    let out = link_dylib(&fixture(), "/b.dyl", false).unwrap();
    assert!(lc_cmds(&out).contains(&(0xC, "/b.dyl".to_string())));
}

#[test]
fn no_slack_is_an_error() {
    let e = link_dylib(&fixture(), "/usr/local/lib/bgmtl/bgmtl-inject.dylib", true).unwrap_err();
    assert!(e.to_string().contains("no slack"), "{e}");
}
