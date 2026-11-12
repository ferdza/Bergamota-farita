//! Journal reservation in hfswrite (docs/FIXES_2026-11.md P-B): what `newfs_hfs -J` leaves for XNU's hfs to finish at
//! the first writable mount (Journal Info Block flagged "needs init", two hidden root files, bit 13 of the attributes).
//! Pure in-memory tests, no mount and no external tools.

use renegade::hfs::Volume;
use renegade::hfswrite::{build, Entry, Kind, Options};
use sha2::{Digest, Sha256};

fn tree() -> Vec<Entry> {
    let e = |path: &str, kind: Kind| Entry { path: path.into(), kind, uid: 0, gid: 0, perm: 0o755, mtime: 1_700_000_000, link_group: None };
    vec![
        e("", Kind::Dir),
        e("usr", Kind::Dir),
        e("usr/hello", Kind::File { len: 5000, source: 0 }),
        e("bin", Kind::Symlink { target: "usr".into() }),
    ]
}

fn image(journal: Option<u32>) -> (Vec<u8>, renegade::hfswrite::Stats) {
    let mut out: Vec<u8> = Vec::new();
    let o = Options { size: Some(8 << 20), date: 1_700_000_000, journal, ..Default::default() };
    let st = build(&tree(), &o, &mut out, &mut |_, sink| sink(&[0x42; 5000])).unwrap();
    assert_eq!(out.len(), 8 << 20, "the last block (alternate header) closes the image");
    (out, st)
}

fn be32(b: &[u8], o: usize) -> u32 {
    u32::from_be_bytes(b[o..o + 4].try_into().unwrap())
}
fn be64(b: &[u8], o: usize) -> u64 {
    u64::from_be_bytes(b[o..o + 8].try_into().unwrap())
}

/// The bitmap bit of `block`.
fn allocated(img: &[u8], vh: &[u8], block: u32) -> bool {
    let bs = be32(vh, 40) as usize;
    let alloc_start = be32(vh, 112 + 16) as usize; // allocation file, first extent
    img[alloc_start * bs + (block / 8) as usize] & (0x80 >> (block % 8)) != 0
}

#[test]
fn default_volume_is_unjournaled_and_unchanged() {
    let (img, st) = image(None);
    let vh = &img[1024..1536];
    assert_eq!(&vh[..2], b"HX");
    assert_eq!(be32(vh, 4), 0x8000_0100, "attributes exactly as before");
    assert_eq!(be32(vh, 12), 0, "no journalInfoBlock");
    let v = Volume::open(&img[..]).unwrap();
    assert!(v.child(2, ".journal").is_none() && v.child(2, ".journal_info_block").is_none());
    assert_eq!(st.files, 2); // hello + the symlink
}

#[test]
fn journaled_volume_reserves_jib_and_journal() {
    let (plain, pst) = image(None);
    let jsize = 1 << 20;
    let (img, st) = image(Some(jsize));
    let vh = &img[1024..1536];
    let bs = be32(vh, 40);
    assert_eq!(bs, 4096);
    // volume header: journaled bit, JIB block, the unmounted bit and the node-fix bit kept, 'HX', '10.0'
    assert_eq!(be32(vh, 4), 0x8000_0100 | 0x2000);
    assert_eq!(&vh[8..12], b"10.0", "the kernel writes HFSJ itself; the host must not");
    let jib_block = be32(vh, 12);
    assert!(jib_block > 1);
    assert_eq!(st.files, pst.files + 2);
    assert_eq!(be32(vh, 32), pst.files + 2, "fileCount counts the two hidden files");
    assert_eq!(be32(&plain[1024..1536], 64) + 2, be32(vh, 64), "nextCatalogID +2");
    // the alternate header is identical
    assert_eq!(&img[img.len() - 1024..img.len() - 512], vh);

    // Journal Info Block: InFS | NeedInit, offset and size in BYTES, 0xdb filler after the 180-byte struct
    let jib = &img[(jib_block * bs) as usize..((jib_block + 1) * bs) as usize];
    assert_eq!(be32(jib, 0), 0x5);
    assert!(jib[4..36].iter().all(|&b| b == 0), "device signature zero (journal in the file system)");
    let off = be64(jib, 36);
    let size = be64(jib, 44);
    assert_eq!(size, jsize as u64);
    assert_eq!(off % bs as u64, 0);
    assert!(jib[52..180].iter().all(|&b| b == 0));
    assert!(jib[180..].iter().all(|&b| b == 0xdb));
    let jrnl_block = (off / bs as u64) as u32;
    assert_eq!(jrnl_block, jib_block + 1, "the journal follows the JIB: one contiguous run");

    // both regions are allocated, the free count dropped by exactly their blocks
    for b in jib_block..jrnl_block + (jsize / bs) {
        assert!(allocated(&img, vh, b), "block {b} must be in the bitmap");
    }
    assert_eq!(be32(&plain[1024..1536], 48) - be32(vh, 48), 1 + jsize / bs);
    // the journal must not overlap file data or metadata: first byte after it is free or file data placed later
    assert!(jrnl_block + jsize / bs <= be32(vh, 52), "nextAllocation is past the journal");

    // the catalog has the two hidden files in the root folder with one extent each
    let v = Volume::open(&img[..]).unwrap();
    let jf = v.child(2, ".journal").expect(".journal in the root");
    let jif = v.child(2, ".journal_info_block").expect(".journal_info_block in the root");
    let (len, ext) = v.file_extents(jf.cnid, jf.rec.unwrap());
    assert_eq!(len, jsize as u64);
    assert_eq!(ext, vec![(jrnl_block, jsize / bs)]);
    let (len, ext) = v.file_extents(jif.cnid, jif.rec.unwrap());
    assert_eq!(len, bs as u64);
    assert_eq!(ext, vec![(jib_block, 1)]);
    // Finder info 'jrnl' / 'hfs+', invisible + name locked
    let (ftype, fcreator) = v.finder_info(jf.rec.unwrap());
    assert_eq!((ftype, fcreator), (u32::from_be_bytes(*b"jrnl"), u32::from_be_bytes(*b"hfs+")));
    // the ordinary files are still there and readable
    let hello = v.lookup("usr/hello", false).unwrap().unwrap();
    assert_eq!(v.read_file(hello).unwrap(), vec![0x42; 5000]);
}

#[test]
fn journal_size_is_validated() {
    let o = |j| Options { size: Some(8 << 20), journal: Some(j), ..Default::default() };
    let try_build = |j| build(&tree(), &o(j), &mut Vec::<u8>::new(), &mut |_, sink| sink(&[0; 5000]));
    assert!(try_build(1000).is_err(), "not a multiple of the block size");
    assert!(try_build(128 * 1024).is_err(), "below 256 KiB");
    assert!(try_build(4 << 30).is_err(), "above 2 GiB");
    assert!(try_build(16 << 20).is_err(), "does not fit the 8 MiB volume");
}

#[test]
fn in_place_edit_guard_allows_only_an_uninitialised_journal() {
    use renegade::hfsedit::{apply_owners, OwnerMap};
    let (mut img, _) = image(Some(1 << 20));
    let map = OwnerMap::new();
    assert!(apply_owners(&mut img, &map, true).is_ok(), "NeedInit still set: nothing is in the journal");
    // once the kernel created the journal it clears NeedInit; then in-place edits must be refused
    let jib_block = be32(&img[1024..1536], 12) as usize;
    let bs = 4096;
    let flags = be32(&img, jib_block * bs) & !0x4;
    img[jib_block * bs..jib_block * bs + 4].copy_from_slice(&flags.to_be_bytes());
    assert!(apply_owners(&mut img, &map, true).is_err());
}

/// The default (unjournaled) image bytes are pinned, so a change to the writer cannot alter what is flashed today.
/// The digest was produced with the writer BEFORE the journal option existed (same test image, `journal` absent).
#[test]
fn default_image_digest_is_pinned() {
    let (img, _) = image(None);
    let d = Sha256::digest(&img);
    let hex: String = d.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, PINNED, "the unjournaled output changed");
}
const PINNED: &str = "737a6c0f949612521f195a6fefdfbd4d7db8589ceb3025a9010115f4ae273add";
