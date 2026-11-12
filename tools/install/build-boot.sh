#!/bin/bash
# The boot image of the unified install, one command (Linux or macOS, no Mac needed):
#   tools/install/build-boot.sh fajita|beryllium
# Builds the image that goes with the root the web installer flashes to userdata: Heartwood (the kernel from the newest green
# xnu.yml run), the Apple device tree seed, the GPU firmware inside the ADT, the boot-args with the GPU ON (tools/renegade/
# gpu-default-args.txt) and Enxerto around them. Nothing is flashed or booted. See docs/INSTALL.md.
#
# Inputs (device dumps and Apple files are never in git):
#   dtb/<board>/dtb          the SDM845 DTB of the phone's stock boot.img (docs/FAJITA.md step 1)
#   KERNEL=FILE              a kernel you built (default: xnu/out-<board>/kernel.development.sweet, else the newest green xnu.yml run via gh)
#   D22AP_IPSW_URL=URL       the iPhone X (iPhone10,3) IPSW URL; only its 33 KB DeviceTree member is fetched (once, cached in research/)
#   research/gpu-fw/         a630_gmu.bin a630_sqe.fw and the zap (a630_zap.mdt + .bNN, or a630_zap.mbn which is split here);
#                            tools/gpu-fw-pull.sh reads them from the phone's own Android partitions (read-only)
# Options through the environment: GPU=0 (CPU renderer image, no GPU firmware needed), OUT=FILE, REPO=owner/name for gh.
set -euo pipefail
cd "$(dirname "$0")/../.."
BOARD=${1:-}
case "$BOARD" in fajita | beryllium) ;; *) echo "usage: $0 fajita|beryllium" >&2; exit 2 ;; esac
GPU=${GPU:-1}
die() { echo "error: $*" >&2; exit 1; }

[ -f "dtb/$BOARD/dtb" ] || die "dtb/$BOARD/dtb is missing: the stock DTB of your phone (docs/FAJITA.md, 'Build the boot image', step 1)"

# 1. kernel
KERNEL=${KERNEL:-xnu/out-$BOARD/kernel.development.sweet}
if [ ! -f "$KERNEL" ]; then
	command -v gh >/dev/null || die "no $KERNEL and no gh to download one: pass KERNEL=FILE"
	REPO_ARG=()
	[ -n "${REPO:-}" ] && REPO_ARG=(-R "$REPO")
	RUN=$(gh run list "${REPO_ARG[@]}" -w xnu.yml -s success -L 1 --json databaseId -q '.[0].databaseId') || die "gh run list failed"
	[ -n "$RUN" ] || die "no green xnu.yml run: run the kernel workflow first (gh workflow run xnu.yml)"
	echo "kernel: xnu.yml run $RUN"
	gh run download "$RUN" "${REPO_ARG[@]}" -n xnu-kernel -D "xnu/out-$BOARD"
	KERNEL=xnu/out-$BOARD/kernel.development.sweet
fi
[ -f "$KERNEL" ] || die "$KERNEL not found in the downloaded artifact"

# 2. device tree seed (iPhone X identity, iOS 18 boots with it)
SEED=research/ipsw-x/d22ap.adt
if [ ! -f "$SEED" ]; then
	[ -n "${D22AP_IPSW_URL:-}" ] || die "$SEED is missing: set D22AP_IPSW_URL to the iPhone10,3 IPSW URL (only the 33 KB DeviceTree member is fetched)"
	mkdir -p research/ipsw-x
	python3 tools/remotezip.py "$D22AP_IPSW_URL" =Firmware/all_flash/DeviceTree.d22ap.im4p research/ipsw-x/d22
	python3 -c "import sys; sys.path.insert(0,'tools'); import adt; open('$SEED','wb').write(adt.load('research/ipsw-x/d22/Firmware/all_flash/DeviceTree.d22ap.im4p'))"
fi

# 3. GPU firmware (OEM files: they stay in research/, which is git-ignored, and in the image, which is never published)
FW=research/gpu-fw
GPU_FW=()
if [ "$GPU" != 0 ]; then
	if [ ! -f "$FW/a630_zap.mdt" ] && [ -f "$FW/a630_zap.mbn" ]; then
		python3 tools/split-mbn.py "$FW/a630_zap.mbn" "$FW"
	fi
	for f in a630_gmu.bin a630_sqe.fw a630_zap.mdt; do
		[ -f "$FW/$f" ] || die "$FW/$f is missing: tools/gpu-fw-pull.sh reads it from the phone (OrangeFox + adb, read-only); or GPU=0 for the CPU-renderer image"
	done
	GPU_FW=(--gpu-fw "$FW")
fi

# 4. ADT, then the boot image (GPU boot-args are the default of mkboot-full.sh)
mkdir -p enxerto/out research/ios18
ADT=enxerto/out/$BOARD-hi-3x.adt
python3 tools/mkadt.py "$ADT" --board "$BOARD" --highmem --display-scale 3 --identity d22ap "${GPU_FW[@]}"
[ "$(wc -c <"$ADT")" -gt 0 ] || die "empty ADT"
SUFFIX=; [ "$GPU" != 0 ] && SUFFIX=-gpu
OUT=${OUT:-research/ios18/enxerto-boot-ios18-$BOARD$SUFFIX.img}
RENEGADE_TARGET=ios18 APPLE_LOGO=${APPLE_LOGO:-0} BOARD=$BOARD GPU=$GPU tools/renegade/mkboot-full.sh "$KERNEL" "$ADT" "$OUT"
echo
echo "boot image: $OUT"
echo "next: flash the root (web installer), then 'Boot once' this image from the Bergamota fastboot page (docs/INSTALL.md)."
