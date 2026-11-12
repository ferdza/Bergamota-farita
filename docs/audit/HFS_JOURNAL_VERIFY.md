# Our journaled-HFS+ reservation checked against Apple's hfs source (2026-11-12)

Checked: `tools/renegade-rs/src/hfswrite.rs` (`Options::journal`), `tests/hfsjournal.rs`, `docs/reference-snippets/HFS_JOURNAL.md`, against
`refs/apple-oss-distributions_hfs` at tag **hfs-715.100.10** (single-commit clone, `d1bac2f`; APSL 2.0, facts and structure only, no code copied). Our kernel pins
**hfs-677.81.4** (`0026-sweet-builtin-hfs.patch`), which is not in the clone: the journal paths below have been stable for years but that is INFERRED, not diffed.
OBSERVED = read in the file cited; INFERRED = my reasoning. Paths below are relative to the clone; `hfs_*` = `core/`.

## Verdict

The layout matches what `newfs_hfs -J` writes and what `hfs_late_journal_init` accepts. Real-hardware evidence from sibling ports (a `mkfs.hfsplus -J` root booting on a phone and on an
SD-card Switch, with journal creation at first mount and replay after hard resets, see `OTHER_6T_PORT_LESSONS.md` section 6) supports the approach. **Four real mismatches/risks**
(M1-M4: two will make a journaled root fail to mount or to remount; fix before the first device test) and several cosmetic differences (C1-C6).

## What matches (OBSERVED on both sides)

| Item | Ours | Apple |
|---|---|---|
| JIB struct | flags@0, offset@36, size@44, rest zero to 180, 0xdb filler after, big-endian (`hfswrite.rs:707-714`; test `hfsjournal.rs:74-81`) | `struct JournalInfoBlock` packed: flags u32, device_signature[8], offset u64, size u64, ext_jnl_uuid (uuid_string_t, 37), machine_serial_num[48], reserved = 32*4-37-48 = 43: 180 bytes, offset@36 size@44 (`hfs_format.h:794-811`); `WriteJournalInfo` memset 0xdb then zero the struct (`newfs_hfs/makehfs.c:1436-1437`). uuid_string_t=37 is from `<uuid/uuid.h>`, not in the clone (INFERRED, consistent with 180) |
| JIB flags | `InFS|NeedInit` = 0x5 | `kJIJournalInFSMask` 1 | `kJIJournalNeedInitMask` 4 (`hfs_format.h:814-816`; `makehfs.c:1439,1466`) |
| offset/size units | bytes from volume start (`jr*bs`, `jb*bs`) | `journalBlock * blockSize`, `journalSize` (`makehfs.c:1475-1476`); kernel compares `jib_offset / blockSize` with the `.journal` start block and `jib_size` with `blockCount*blockSize` (`hfs_vfsutils.c:2780-2795`) |
| VH | attributes `0x8000_0100 \| 0x2000`, `journalInfoBlock`, `lastMountedVersion '10.0'`, fileCount+2, nextCatalogID+2 (`hfswrite.rs:662-664`, `put32(.. 12 ..)`) | `Unmounted \| UnusedNodeFix`, `\|= Journaled`, `lastMountedVersion = kHFSPlusMountVersion`, `fileCount = 2`, `nextCatalogID += 2`, JIB = next block (`makehfs.c:691,700,743-754`) |
| Hidden files | root parent (2), names `.journal`, `.journal_info_block`, flags 0x0002 (thread exists), mode `S_IFREG`, link count 1, type `jrnl`, creator `hfs+`, fdFlags 0x5000 = kIsInvisible 0x4000 + kNameLocked 0x1000, one extent each, thread records (`hfswrite.rs:620-633`) | `makehfs.c:1716-1830`; `hfs_macos_defs.h:203-205` (`kNameLocked 0x1000`, `kIsInvisible 0x4000`); `kJournalFileType 0x6a726e6c` 'jrnl' (`makehfs.c:122`); `kHFSPlusCreator 0x6866732B` (`hfs_format.h:122`) |
| Root valence | +2 (`hfswrite.rs:541-543`) | `valence = journaled ? 2 : 0` (`makehfs.c:1683`) |
| Journal follows JIB, contiguous, bitmap marks both | `jrnl_block == jib_block+1`, `next_block` advanced (`hfswrite.rs:474-484`, test `:83,87,91`) | `journalBlock = journalInfoBlock + 1`; `blocksUsed += 1 + journal blocks` (`makehfs.c:754-767`) |
| Unmounted bit kept | `0x100` set | **required**: a writable mount with `jnl == NULL` and the bit clear returns EINVAL "cannot mount dirty non-journaled volumes" (`hfs_vfsutils.c:203-208`); at that point the journal is not open yet on a first mount, so the bit must be set. Keep it (do not "clean up" to bit-clear) |
| Early init skipped | `lastMountedVersion '10.0'` | `hfs_early_journal_init` only if `== kHFSJMountVersion` and journaled bit (`hfs_vfsops.c:1583-1585`); otherwise `hfs_mounthfsplus` ends with `hfs_late_journal_init` when journaled && version != 'HFSJ' && `jnl == NULL` (`hfs_vfsutils.c:722-727`) |
| Kernel creates the header | none written by the host | `hfs_late_journal_init`: if NeedInit or relocated -> `journal_create(...)` writes magic `0x4a4e4c78`, endian `0x12345678`, start=end=`phys_blksz`, size, jhdr_size=`phys_blksz`, random sequence, checksum (`hfs_vfsutils.c:2866-2884`; `hfs_journal.c:1827-1856`; `hfs_journal.h:126-127`), then clears NeedInit and rewrites the JIB (`:2917-2927`) |
| Flush | n/a | `hfs_flushvolumeheader` writes `attributes = vcbAtrb`, `journalInfoBlock = vcbJinfoBlock` (read from the VH at mount, `hfs_vfsutils.c:252`) and `lastMountedVersion = 'HFSJ'` iff `jnl` (`hfs_vfsops.c:3727-3733`); the alternate VH must have the same blockSize and a valid signature (`:3650-3665`). Ours writes identical primary and alternate headers |
| Stale journal body | zeros / don't-care | harmless: `journal_create` only reads the old header, avoids its sequence number if magic matches, and sets start == end so the body is never read (`hfs_journal.c:1795-1823`) |

## Mismatches that matter

**M1 (P1, INFERRED from code, second mount): catalog extent may have an odd block count.** `hfswrite.rs:19` `CAT_NODE = 8192` but the allocation block is 4096, and
`cat_blocks_est = blocks_of(cat_bytes_est.max(16*CAT_NODE))` (`:454`) is not rounded to a multiple of 2; the VH fork gets `cat_blocks_est` blocks as its single extent (`:689`).
Apple: when `hfsmp->jnl != NULL`, `BTOpenPath` fails with `fsBTInvalidNodeErr` unless `NodesAreContiguous()` (`BTree.c:335-347`), and `NodesAreContiguous` returns FALSE if any extent's
`blockCount & (nodeSize/blockSize - 1)` is non-zero (`FileExtentMapping.c:1947-1957`, `ExtentsAreIntegral` `:1891-1920`). On the **first** mount `jnl` is still NULL when the B-trees open (late init
runs afterwards), so it passes; from the **second** mount `lastMountedVersion == 'HFSJ'` -> early init opens the journal first -> an odd catalog extent fails the mount (EINVAL/ENXIO class), i.e. a root that
boots once and never again. Unjournaled mounts never hit this. The attributes file is 8 blocks (even) and the extents file node = block size, so only the catalog is at risk (parity depends on the tree). **Fix:
round `cat_blocks_est` up to an even number (a multiple of `CAT_NODE/bs`) when `journal` is set (or always), and add a test that asserts the catalog extent count % 2 == 0.**

**M2 (P2): journal size limits do not match the kernel.** Ours accepts `256 KiB..=2 GiB`, multiple of the block size (`hfswrite.rs:413`; test `hfsjournal.rs:116-117`).
Kernel: `journal_create` needs `256 KiB <= size <= 0x80000000` **and `size >= phys_blksz * (phys_blksz / 16)`** (block_info is 16 bytes, `hfs_journal.h:55-61`) = **1 MiB for a 4096-byte device
block** (`hfs_journal.c:1733-1745`, `:1738`); `journal_open` (every later mount) allows only `<= 1 GiB` (`:1904`) and the same minimum (`:1910`). So 256 KiB..1 MiB-4096 passes our check and fails `journal_create`
-> mount fails; 1..2 GiB creates fine once and fails at the next mount. Device block is 4096 on the 6T (`fastboot getvar` logical block 0x1000, `6T_FACTS.md` 1.2; patch 0028 answers `DKIOCGETBLOCKSIZE` = `su.secsize`,
and edi194's shim logged 4 KiB). newfs_hfs itself clamps to the sector-size minimum and at most 512 MiB (`newfs_hfs.c:1050-1157`). **Fix: accept `max(1 MiB, bs*(bs/16)) ..= 1 GiB` (keep the 8 MiB default).**

**M3 (P2): the "first boot must be rootrw" statement is not quite right.** `HFS_JOURNAL.md` section 3 point 5 says journal creation needs a writable mount. In `hfs_late_journal_init` the
read-only early return is excluded for the root file system (`vfs_flags & MNT_ROOTFS == 0`, `hfs_vfsutils.c:2842`; `:2575` for early init), so a read-only **root** mount still runs `journal_create` (a device-level
write). Consequence for us: nothing breaks, but the header may be written even before `rootrw` takes effect, and that write needs `DKIOCSYNCHRONIZE` working on the root device (patch 0030 does; `DKIOCGETFEATURES` is
unimplemented so the kernel uses full flushes, `hfs_journal.c:1626-1637`). Update the doc, no code change.

**M4 (P3, INFERRED): durability window.** Until the first `hfs_flushvolumeheader` with `jnl` set, the on-disk VH still says `'10.0'` (flush before late init is skipped: `hfs_vfsutils.c:709-711` needs `jnl`).
A hard reset in that window re-enters late init and calls `journal_open` with `JOURNAL_RESET` (`:2895`), which discards the journal: no replay protection until the VH says `'HFSJ'`. It is safe (not
corrupting), only less protective than later boots. Sibling logs show replay working afterwards (`urielc918_ios-switch/NOTES.md:406`). Mitigation: `sync` once early in userland.

## Cosmetic differences from `newfs_hfs` (no kernel check found; fsck_hfs skips the two ids for link-count checks, `CatalogCheck.c:956-960`)

| # | Ours | Apple |
|---|---|---|
| C1 | `.journal_info_block` = N, `.journal` = N+1 (`hfswrite.rs:420`); both at the end of the CNID space | `.journal` = nextFreeFileID, `.journal_info_block` = +1 (CNID 16, 17) (`makehfs.c:1736,1775`) |
| C2 | both dates = volume `date`; all four file-record dates set (`file_rec`) | `.journal` createDate+1, JIB file createDate; only create and content-mod set (`makehfs.c:1736-1740,1772-1776`) |
| C3 | ownerFlags `0x01` (UF_NODUMP) (`hfswrite.rs:625`) | source writes `(uint8_t)SWAP_BE16((uint16_t)UF_NODUMP)`: that is 0x00 on a little-endian host, 0x01 on big-endian (`makehfs.c:1742`). Intent equals ours; real LE output has 0. Kernel ignores it |
| C4 | JIB/journal placed after the attributes file | right after the allocation bitmap, before extents/catalog/attributes (`makehfs.c:741-760`): free placement, only contiguity matters |
| C5 | B-tree node sizes 8192/4096/8192 | journaled newfs_hfs sets larger nodes only when `nodeSize > blockSize` for the catalog/extents/attributes (`makehfs.c:782,800,824`); ours is valid (needs M1) |
| C6 | `volume < 128 MiB` gets 8 MiB min check only | newfs: <128 MiB -> 512 KiB (or sector minimum) (`newfs_hfs.c:1125-1148`); irrelevant for a 100+ GB root |

## Dependencies on our kernel glue (OBSERVED in our patches, INFERRED effect)

- `DKIOCGETBLOCKSIZE` -> `su.secsize` (`0028...patch:383`), `DKIOCGETPHYSICALBLOCKSIZE` -> `UFS_BLOCK`; `journal_create` requires `phys_blksz <= min_fs_blksz` (`hfs_journal.c:1749-1753`), i.e. the
  device logical size must not exceed the HFS logical size: both 4096. A `DKIOCSETBLOCKSIZE` fallback to 512 (`hfs_vfsops.c` ENXIO retry, ~`:1665`) would change `phys_blksz` mid-mount; not expected on the 6T.
- Write size queries: `DKIOCGETMAXBLOCKCOUNTWRITE` returns 0 and `...SEGMENTCOUNT*` returns 1 in 0028: `get_io_info` then yields 128 KiB writes and PAGE_SIZE reads (`hfs_journal.c:1645-1690`), fine.
- `DKIOCSYNCHRONIZE` implemented in `0030-sweet-ufs-writes.patch:160-161`; `DKIOCGETFEATURES` not, so no FUA/barrier/unmap (INFERRED: slower, correct).

## Recommended doc/test changes (not applied, per instructions)

1. `hfswrite.rs`: even catalog extent (M1); journal bounds (M2); optionally CNID order/dates (C1/C2).
2. `tests/hfsjournal.rs`: catalog `blockCount % (CAT_NODE/bs) == 0`; reject 512 KiB and 2 GiB; accept 1 MiB..1 GiB.
3. `HFS_JOURNAL.md`: fix section 3 point 5 (M3); record the `NodesAreContiguous` rule and the second-mount behaviour; cite sibling-port observations (OTHER_6T_PORT_LESSONS section 6).
4. First device test: image with `--journal 8m` on a throwaway `fastboot boot` + userdata, **boot twice** (the second boot is the one M1 would break) and `sweetreboot fastboot` between them; expect `hfs: Initializing the journal (joffset 0x... sz 0x800000)` on boot 1 and no such line on boot 2.
