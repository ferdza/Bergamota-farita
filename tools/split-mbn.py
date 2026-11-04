#!/usr/bin/env python3
"""Split a squashed Qualcomm firmware (.mbn, one ELF) into the .mdt + .bNN files the PIL loaders read.

  split-mbn.py a630_zap.mbn OUTDIR      -> OUTDIR/a630_zap.mdt, OUTDIR/a630_zap.bNN

.mdt = the ELF header + program headers (segment 0, a PT_NULL covering them) followed directly by the hash
segment: the "split" layout Linux qcom_mdt_read_metadata() accepts (ehdr_size + hash_size == file size) and the
metadata Bergamota's zap loader (xnu patch 0103, sweet_a630_zap) hands to TrustZone PAS INIT_IMAGE as is.
.bNN = the bytes of program header NN, for every segment with data (the loader copies each non-hash PT_LOAD).
Nothing is changed: the signature covers these bytes, so the split is only a re-packaging. Keep the outputs out
of git (OEM firmware).
"""
import os
import struct
import sys

QCOM_MDT_TYPE_MASK = 7 << 24
QCOM_MDT_TYPE_HASH = 2 << 24


def split(mbn: bytes):
    if mbn[:4] != b"\x7fELF" or mbn[4] != 1 or mbn[5] != 1:
        raise SystemExit("not a little-endian ELF32 (Qualcomm images are)")
    phoff = struct.unpack_from("<I", mbn, 28)[0]
    phentsize, phnum = struct.unpack_from("<HH", mbn, 42)
    if phentsize != 32 or phnum == 0:
        raise SystemExit(f"unexpected program headers ({phnum} x {phentsize})")
    ph = [struct.unpack_from("<8I", mbn, phoff + 32 * i) for i in range(phnum)]
    hashes = [i for i, p in enumerate(ph) if p[6] & QCOM_MDT_TYPE_MASK == QCOM_MDT_TYPE_HASH]
    if len(hashes) != 1:
        raise SystemExit(f"expected one hash segment, found {len(hashes)}")
    h = ph[hashes[0]]
    ehdr_size = ph[0][4]  # segment 0's filesz covers the ELF header and the program headers
    if ehdr_size < phoff + 32 * phnum:
        raise SystemExit("segment 0 does not cover the program headers")
    mdt = mbn[:ehdr_size] + mbn[h[1]:h[1] + h[4]]
    segs = {}
    for i, (typ, off, _va, _pa, filesz, _memsz, flags, _al) in enumerate(ph):
        if i == 0 or i == hashes[0] or filesz == 0:
            continue
        if off + filesz > len(mbn):
            raise SystemExit(f"segment {i} runs past the end of the file")
        segs[i] = mbn[off:off + filesz]
    return mdt, segs


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    src, out = sys.argv[1], sys.argv[2]
    base = os.path.splitext(os.path.basename(src))[0]
    mdt, segs = split(open(src, "rb").read())
    os.makedirs(out, exist_ok=True)
    open(os.path.join(out, base + ".mdt"), "wb").write(mdt)
    print(f"{base}.mdt {len(mdt)} bytes")
    for i, b in segs.items():
        open(os.path.join(out, f"{base}.b{i:02d}"), "wb").write(b)
        print(f"{base}.b{i:02d} {len(b)} bytes")


if __name__ == "__main__":
    main()
