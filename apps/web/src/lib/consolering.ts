// The kernel's persistent console log (xnu patch 0047, bsd/dev/sweet_ufs.c): every console byte of this boot
// goes to a 4 MiB RAM ring, flushed every 10 s to the last 1 + 1024 blocks (4 KiB) of the root partition.
// Block 0: "SWEETLOG" | u32 version | u32 ring size | u64 total bytes written | u64 flush sequence;
// the ring follows, byte n of the stream at ring offset n % size. Same as tools/sweet-log.py.

export const RING_BLOCKS = 1025;

export type ConsoleRing = { text: string; version: number; size: number; total: number; seq: number; wrapped: boolean; panic: boolean };

export class ConsoleRingError extends Error {}

export function decodeConsoleRing(area: Uint8Array): ConsoleRing {
  if (area.length < 4096 + 32) throw new ConsoleRingError(`only ${area.length} bytes read (want ${RING_BLOCKS * 4096})`);
  const magic = new TextDecoder().decode(area.subarray(0, 8));
  if (magic !== "SWEETLOG") throw new ConsoleRingError("no SWEETLOG header there (the log was never flushed, or this is not the area)");
  const dv = new DataView(area.buffer, area.byteOffset, area.byteLength);
  const version = dv.getUint32(8, true);
  const size = dv.getUint32(12, true);
  const total = Number(dv.getBigUint64(16, true));
  const seq = Number(dv.getBigUint64(24, true));
  const ring = area.subarray(4096, 4096 + size);
  if (ring.length < size) throw new ConsoleRingError(`ring cut short: ${ring.length} of ${size} bytes`);
  let bytes: Uint8Array;
  if (total <= size) bytes = ring.subarray(0, total);
  else {
    const start = total % size;
    bytes = new Uint8Array(size);
    bytes.set(ring.subarray(start), 0);
    bytes.set(ring.subarray(0, start), size - start);
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/\r/g, "");
  return { text, version, size, total, seq, wrapped: total > size, panic: seq === 0xffffffff };
}

/**
 * Shell for the phone: finds the size of the raw root device by halving (dd past its end reads nothing),
 * then writes the log area to stdout. Read only. The size goes to stderr as "blocks N".
 */
export const READ_RING_CMD = [
  "export PATH=$PATH:/usr/sbin:/sbin:/usr/local/bin:/bin:/usr/bin",
  "D=/dev/rufsroot0",
  `[ -r $D ] || { echo "no readable $D on this root" >&2; exit 2; }`,
  `command -v dd >/dev/null 2>&1 || { echo "no dd on this root" >&2; exit 3; }`,
  "ok() { [ $(( $(dd if=$D bs=4096 skip=$1 count=1 2>/dev/null | wc -c) )) -eq 4096 ]; }",
  "lo=0; hi=1024",
  "while ok $hi; do lo=$hi; hi=$((hi * 2)); done",
  "while [ $((hi - lo)) -gt 1 ]; do m=$(((lo + hi) / 2)); if ok $m; then lo=$m; else hi=$m; fi; done",
  `n=$((lo + 1)); echo "blocks $n" >&2`,
  `[ $n -gt ${RING_BLOCKS * 2} ] || { echo "device too small ($n blocks)" >&2; exit 4; }`,
  `dd if=$D bs=4096 skip=$((n - ${RING_BLOCKS})) count=${RING_BLOCKS} 2>/dev/null`,
].join("\n");
