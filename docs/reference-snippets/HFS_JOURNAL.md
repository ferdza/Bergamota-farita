# Journaled HFS+ root: reference pack (what Apple's hfs needs, what hfswrite.rs must emit)

Legend: OBSERVED = read in the fetched file; INFERRED; UNVERIFIED (recalled / not checked).
Licences: Apple `hfs` (apple-oss-distributions/hfs, pinned by our patch `xnu/patches-11215/0026-sweet-builtin-hfs.patch` to commit
`0379993f52127474b11c487ab3f3d4785212b60a`, hfs-677.81.4) is **APSL 2.0** (headers say so, OBSERVED for hfs_format.h, hfs_journal.h): may be adapted with an attribution
comment. Rust code below is ours. Files fetched by WebFetch from raw.githubusercontent.com at that sha; no line numbers available, cite by function.

## 1. Recommendation (simplest safe option)

**Emit exactly what `newfs_hfs -J` emits and let the kernel create the journal header on the first read-write mount.** Apple's own formatter does not write a journal header
either: it writes only the Journal Info Block with `kJIJournalNeedInitMask`, reserves the journal blocks, and adds two hidden catalog files; XNU's hfs calls
`journal_create()` when it sees NeedInit (OBSERVED, `WriteJournalInfo` in `newfs_hfs/makehfs.c`; `hfs_late_journal_init` in `core/hfs_vfsutils.c`).
No journal header, checksum or sequence numbers needed on the host. Alternatives rejected:
- Host writes a full journal header: possible (section 5) but duplicates `journal_create`, risks a bad checksum/size and gains nothing (open tolerates a bad header checksum, but not bad geometry).
- First-boot enable through `sysctl vfs.generic.hfs.enable_journaling` (`HFS_ENABLE_JOURNALING`, root only, args: JIB block, journal offset in blocks, size): it **requires `.journal_info_block` and `.journal` to
  already exist** and be contiguous, so the host still has to emit the files (OBSERVED `hfs_sysctl` in `core/hfs_vfsops.c`). It only adds a runtime step; skip.
- `fsck_hfs` at install: repairs, does not prevent corruption; keep it as a separate check, not a substitute.

## 2. What a journaled volume is (all OBSERVED unless marked)

Volume header (`HFSPlusVolumeHeader`, at byte 1024 of the volume, big-endian, also the alternate copy at size-1024; our writer already writes both):
| Offset | Field | Journaled value |
|---|---|---|
| 4 | attributes | add `kHFSVolumeJournaledMask` = 0x00002000 (bit 13); keep `kHFSVolumeUnmountedMask` 0x100 and `kHFSUnusedNodeFixMask` 0x80000000 as now |
| 8 | lastMountedVersion | newfs_hfs writes `kHFSPlusMountVersion` = '10.0' (0x31302E30, what hfswrite.rs writes already). The kernel writes 'HFSJ' (`kHFSJMountVersion` 0x4846534a) itself once it has the journal open; do not write 'HFSJ' on the host. |
| 12 | journalInfoBlock | allocation-block number of the JIB (0 = not journaled) |
| 32 | fileCount | +2 |
| 64 | nextCatalogID | +2 |
| 48 | freeBlocks | minus (1 + journal blocks); bitmap bits set for those blocks |

Journal Info Block (`struct JournalInfoBlock`, packed, 180 bytes, **big-endian on disk**; one allocation block, rest of the block is filler):
`u32 flags @0; u32 device_signature[8] @4; u64 offset @36; u64 size @44; char ext_jnl_uuid[37] @52; char machine_serial_num[48] @89; char reserved[43] @137`
(offsets INFERRED from the packed field sizes; `uuid_string_t` = 37 assumed). Flags: `kJIJournalInFSMask` 0x1, `kJIJournalOnOtherDeviceMask` 0x2, `kJIJournalNeedInitMask` 0x4.
newfs_hfs sets flags = InFS | NeedInit = 0x5, `offset = journal start block * block size` (**bytes from the start of the volume**), `size` = journal bytes. It first fills the sector with 0xdb and zeroes the 180-byte struct.

Two hidden files in the **root folder** (parent CNID 2), both catalog file records + their thread records (names as in `makehfs.c`: `.journal_info_block`, `.journal`):
| | `.journal_info_block` | `.journal` |
|---|---|---|
| fileID | next free + 1 | next free |
| flags | kHFSThreadExistsMask 0x0002 | same |
| data fork | 1 block, extent {jib_block, 1}, logicalSize = block size | extent {journal_block, n}, logicalSize = journal size, totalBlocks = ceil(size/bs) |
| BSD info | mode S_IFREG (no permissions bits), ownerFlags UF_NODUMP, linkCount 1 | same |
| Finder info | fdType 'jrnl' (0x6a726e6c, from search snippet, UNVERIFIED), fdCreator 'hfs+' (`kHFSPlusCreator`), fdFlags kIsInvisible 0x4000 + kNameLocked 0x1000 (values recalled, UNVERIFIED) | same |
| dates | createDate = content mod date = volume createDate (+1 for `.journal`) | |
Root folder valence +2, catalog leaf records +4 (2 files + 2 threads). HFSX is fine (case-sensitive compare, names are ASCII).
Placement is free but must be contiguous single extents (the sysctl path and the late-init check require the JIB to be 1 block and the journal one extent). newfs_hfs puts them right
after the bitmap; **putting them after the attributes file and before file data in hfswrite.rs (`next_block`, ~line 440, before "place file data") is equivalent.**

Journal sizing (OBSERVED `hfsplus_params()` in `newfs_hfs/newfs_hfs.c`): default `JOURNAL_DEFAULT_SIZE` = 8 MiB, plus 8 MiB per 100 GiB of volume (cap 64 steps, max 512 MiB);
volumes < 128 MiB get 512 KiB; `min_size = physSectorSize * (physSectorSize / 16)` = 1 MiB for 4096-byte sectors. Kernel side (`journal_create`): 256 KiB <= size <= 2 GiB
(`journal_open`: <= 1 GiB), size multiple of the device's physical block size (`DKIOCGETBLOCKSIZE`), `phys_blksz <= volume block size`.
=> **use 8 MiB for a 128/256 GB userdata root (volume < 100 GB is 8 MiB; a 100+ GB root would be 16 MiB; either is fine), block size 4096.**
UNVERIFIED: that our sweet UFS block device answers DKIOCGETBLOCKSIZE with 4096 (grep `DKIOCGETBLOCKSIZE` in `bsd/dev/sweet_ufs.c` before relying on it; Apple's code requires phys_blksz <= 4096).

## 3. What the kernel does at mount (OBSERVED `hfs_mountfs`, `hfs_MountHFSPlusVolume`, `hfs_early/late_journal_init`)

1. `hfs_early_journal_init` runs only if (journaled bit set) AND (lastMountedVersion == 'HFSJ') AND (no `journal_disable` arg). A freshly written image has '10.0' => **this path is skipped**.
2. `hfs_late_journal_init` then runs (journaled bit set, lastMountedVersion != 'HFSJ', jnl == NULL): looks up `.journal_info_block` and `.journal` in the catalog; if either is missing or has size 0 it silently
   clears the journaled bit (volume then mounts unjournaled); reads the JIB; fixes offset/size if the catalog extents disagree; if NeedInit (or a fixup was needed) calls `journal_create()` (writes **only the header block**:
   magic 'JNLx' = 0x4a4e4c78, endian 0x12345678, start = end = block size, size, jhdr_size = phys block size, random sequence base, checksum; then DKIOCSYNCHRONIZE), clears NeedInit and rewrites the JIB. Otherwise
   it opens with `JOURNAL_RESET` (discards any stale content).
3. Mounting writable without a journal and without the Unmounted bit => `EINVAL` ("cannot mount dirty non-journaled volumes"). Our unjournaled writer sets Unmounted (0x100), so it mounts today.
4. If journal setup fails on a writable mount: `HFS_NEED_JNL_RESET`, lastMountedVersion := 'FSK!' (forces fsck), and the **mount fails with EINVAL** (root cannot mount => no boot). This is the failure mode to guard.
5. Read-only mounts: never open or create the journal; `journal_is_clean()` is checked and a dirty journal fails the mount except for the root filesystem (`MNT_ROOTFS`). With NeedInit and no header, `journal_create` needs a writable
   mount; **the first boot must be `rootrw` (read-write root), as our boot already is for an unjournaled root.**
6. Requires working `DKIOCSYNCHRONIZE` (cache flush) for the barrier writes: audit says we implement it.

## 4. Our code today

- `tools/renegade-rs/src/hfswrite.rs` (687 lines): `build()` line 351. Layout `block 0 | bitmap | extents | catalog | attributes | file data | symlinks | last block`; VH written ~lines 600-640: `vh[0..2]="HX"`, version 5,
  attributes `0x8000_0100`, `vh[8..12]="10.0"` (so lastMountedVersion already matches `kHFSPlusMountVersion`), fileCount at 32, nextCatalogID at 64. Root folder valence adds 2 for the private dirs (`valence.entry(2) += 2`, ~line 487).
  Catalog size estimate `nrec = 2 * (order.len() + groups.len() + 3)` (line ~441): add 2 for 4 records. The private-dir records (~lines 500-515) are the model for two more hidden records.
- `tools/renegade-rs/src/hfsedit.rs` line 141 refuses a volume with attributes bit 13 ("volume is journaled"): in-place owner edits are not journaled. While the JIB still says NeedInit (no header, nothing in the journal)
  an edit of catalog records is as safe as on an unjournaled volume; relax the guard to that case only (read JIB flags at offset 0 of the JIB block; require `flags & 4`), never when NeedInit is clear.

- Our kernel glue (OBSERVED): `0026-sweet-builtin-hfs.patch` only compiles `core/hfs_journal.c` (builds `hfs_journal.o`) and sets no journal flag anywhere; `0031-sweet-read-write-root.patch` lets a *dirty
  non-journaled* root (Unmounted bit clear) mount read-write on `MNT_ROOTFS`, and `vfs_mountroot` honours boot-arg `rootrw=1` (clears MNT_RDONLY). `0028-sweet-ufs-root-device.patch` answers
  `DKIOCGETBLOCKSIZE` with `su.secsize` (the UFS LU sector size; value on the 6T not read here, expect 4096). So the journaled path is untested but its dependencies exist.
- Empty valid journal, direct answers: (a) VH attributes |= 0x2000, Unmounted bit may stay set; (b) journalInfoBlock at VH byte 12; (c) with JIB flags InFS|NeedInit the kernel creates the header at mount
  (`hfs_late_journal_init`), so reserving the area + JIB + the two catalog files is enough; (d) an already-initialised journal would be mounted by `hfs_early_journal_init` only if lastMountedVersion == 'HFSJ'
  and then `journal_open` validates: magic 'JNLx' (swapped magic accepted via JOURNAL_NEED_SWAP, so either endianness opens), start/end multiples of 512 and within size, size 256 KiB..1 GiB, jhdr_size nonzero;
  a wrong header checksum only logs. Host byte order for the header = little-endian on arm64.

## 5. Rust sketch for hfswrite.rs (ours; structure follows newfs_hfs, APSL attribution comment recommended)

```rust
// Journal geometry (as newfs_hfs: JIB block, then the journal, both after the metadata files)
pub struct JournalOpts { pub size: u32 }          // bytes, multiple of block size, 1 MiB..=2 GiB; default 8 MiB
let jblocks = opts.journal.map(|j| blocks_of(j.size as u64));
let jib_block = jblocks.map(|_| { let b = next_block; next_block += 1; b });
let jrnl_block = jblocks.map(|n| { let b = next_block; next_block += n; b });
// ... file records, in root (parent 2): `.journal` (cnid = next_cnid), `.journal_info_block` (cnid = next_cnid+1);
//     file_rec(0x02 /*thread exists*/, ..) with finder info fdType b"jrnl", fdCreator b"hfs+", fdFlags 0x5000 (invisible|name locked),
//     ownerFlags 0x01 (UF_NODUMP), mode 0o100000, link count 1, one extent each. valence(2) += 2; next_cnid += 2; st.files += 2;
// volume header:
put32(&mut vh, 4, 0x8000_0100 | 0x2000);          // journaled bit
put32(&mut vh, 12, jib_block);                    // journalInfoBlock
// JIB block (big-endian, 0xdb filler, then zero the 180-byte struct):
let mut jib = vec![0xdbu8; bs as usize];
jib[..180].fill(0);
jib[0..4].copy_from_slice(&0x0000_0005u32.to_be_bytes());                       // InFS | NeedInit
jib[36..44].copy_from_slice(&(jrnl_block as u64 * bs as u64).to_be_bytes());    // offset in bytes from volume start
jib[44..52].copy_from_slice(&(jblocks as u64 * bs as u64).to_be_bytes());       // size in bytes
out.write_at(jib_block as u64 * bs as u64, &jib)?;
out.write_at(jrnl_block as u64 * bs as u64, &vec![0u8; ...])?;                  // zero the journal body (stream in 1 MiB pieces; don't-care for sparse images)
```
Free-block accounting: `used = next_block + 1` already follows `next_block`, so advancing `next_block` for the two regions keeps the bitmap and `freeBlocks` right; bump `cat_blocks_est` by two records.
Tests (host): parse back JIB; `fsck_hfs -n` on macOS (UNVERIFIED how fsck_hfs treats a NeedInit JIB with no header; `newfs_hfs -J` output is accepted by it, so identical bytes are the safe bet);
Linux `fsck.hfsplus` (hfsprogs) does not understand journals (it refuses or ignores; treat as informational only).

Optional header written by the host (not recommended). `journal_header` is **host byte order** (little-endian on arm64): `i32 magic 0x4a4e4c78 @0; i32 endian 0x12345678 @4; i64 start @8; i64 end @16;
i64 size @24; i32 blhdr_size @32; u32 checksum @36; i32 jhdr_size @40; u32 sequence_num @44` (OBSERVED struct, offsets from natural alignment, INFERRED). start = end = jhdr_size (= device block size, 4096), size = journal bytes,
checksum = `calc_checksum` over the first 44 bytes (offsetof sequence_num) with the checksum field zero: `c = 0; for each byte b { c = (c << 8) ^ (c + b) }; checksum = !c` (OBSERVED algorithm), blhdr_size = derived from the
transaction buffer size (`size_up_tbuffer`, depends on `hw.memsize`; UNVERIFIED value) so the kernel-created header is the only safe source.

## 6. Risks and guards for the implementer

- Boot-arg/mount fallback: keep the unjournaled build selectable (`--journal` flag, default off until proven on the device). If the journaled mount fails the root does not mount (point 4 in section 3). `HFSFSMNT_EXTENDED_ARGS.journal_disable`
  only exists on the mount-args path; check how our built-in root mount (`bsd/sweet_hfs` glue / bsd_init patch) passes args before promising a boot-arg to skip journaling (UNVERIFIED).
- The journal lives in the same sparse userdata image: the journal body may be `DONT_CARE` chunks, the JIB and `.journal` extent must lie inside the volume; the flasher's size check (AUDIT_USERLAND F-03) must still see an `HX` header at 1024.
- Do not enable journaling on the iOS 16 images that other tools still edit in place (`hfsedit.rs`) without the guard change above.
- Hard-link directories: `HFS_DISABLE_JOURNALING` refuses with directory hardlinks (irrelevant for us, files only).

## 7. Where I looked and did not find
- `fsck_hfs` source (journal checks): not fetched; it lives in `apple-oss-distributions/hfs` `fsck_hfs/` (APSL) if the implementer needs to know what it requires of the JIB.
- The numeric `HFS_ENABLE_JOURNALING` constant and `kIsInvisible`/`kNameLocked`/`UF_NODUMP`/'jrnl' values were not in the fetched excerpts (values above recalled or from a search snippet; confirm in `hfs_format.h` / `hfs_fsctl.h` / `sys/stat.h`).
- The ios-sweet NOTES-sweet.md "Image v4 (JOURNALED)" text (`urielc918_ios-switch/docs/upstream/NOTES-sweet.md`) was cited by the audit; I did not re-read it here.
