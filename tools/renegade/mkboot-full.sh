#!/bin/bash
# Boot image for the FULL iOS root of the Renegade target (targets.py, RENEGADE_TARGET) on the userdata partition
# (rd=ufsroot0), no RAM disk.
#   tools/renegade/mkboot-full.sh [KERNEL] [ADT] [OUT.img]
# defaults (ios26): research/ios26/kernel/kernel.development.sweet (xnu-12377), enxerto/out/beryllium-n104-2x.adt
#           (tools/mkadt.py --identity n104ap --display-scale 2 --points 414x896), research/ios26/enxerto-boot-ios26full.img
#           (ios18: xnu/out-0139/kernel.development.sweet, ../ios-beryllium/shim/out/beryllium-hi-3x.adt)
# Test it with `fastboot boot OUT.img` (the phone must hold the image from tools/renegade/mkroot-full.sh
# flashed to userdata: docs/IOS18_PORT.md section 12). Nothing is flashed or booted here.
set -euo pipefail
cd "$(dirname "$0")/../.."
tg() { python3 -I tools/renegade/targets.py "$1"; }
NAME=$(tg name) WORK=$(tg work)
if [ "$NAME" = ios18 ]; then DEF_KERNEL=xnu/out-0139/kernel.development.sweet; else DEF_KERNEL=$WORK/kernel/kernel.development.sweet; fi
KERNEL=${1:-$DEF_KERNEL}
ADT=${2:-$(tg adt)}
OUT=${3:-$WORK/enxerto-boot-${NAME}full.img}
# RAM-disk cmdline of docs/IOS18_PORT.md section 9 with rd=md0 -> rd=ufsroot0 ufsrw=1 rootrw=1.
# ignition_level=1: dyld's libignition looks for the cache in /System/Library/Caches/com.apple.dyld only.
[ -n "${CMDLINE:-}" ] && CMDLINE_GIVEN=1
CMDLINE=${CMDLINE:-"debug=0xc serial=3 cpus=8 keepsyms=1 -noprogress rd=ufsroot0 unentitled_ios_sim_launch=1 ignition_level=1 wdt_test=no_user_checkin ufsrw=1 rootrw=1 launchd_unsecure_cache=1 wdt=-1 sweetfb_noconsole=1 sweetfb_hz=30 sweetfb_vsync=1 sweetfb_scale=1 sweetfb_flip=1 sweetusb=2 sweetbattery=1 sweetfb_hw=1 sweetarm64e=1 launchd_disable_all_timeouts=1"}
# GPU 3D on by default (SDM845 boards): the boot-args of tools/renegade/gpu-default-args.txt (sweetgpu=8 with the governor, boost,
# clock gating and idle slumber, the direct scan-out framebuffer Chlorophyll needs) are appended to the default CMDLINE. The
# Chlorophyll userland is already in the root (the web installer / Renegade adds it and wires backboardd), and the inject only
# runs while the kernel's GPU is up. GPU=0 builds the CPU-renderer image; a CMDLINE you pass yourself is used as is.
GPU=${GPU:-1}
BOARD_NAME=${BOARD:-beryllium}
if [ "$NAME" = ios18 ] && [ -z "${CMDLINE_GIVEN:-}" ] && [ "$GPU" != 0 ] && { [ "$BOARD_NAME" = beryllium ] || [ "$BOARD_NAME" = fajita ]; }; then
	GPU_ARGS=$(grep -v '^[[:space:]]*#' tools/renegade/gpu-default-args.txt | tr '\n' ' ' | sed 's/[[:space:]]*$//')
	CMDLINE="$CMDLINE $GPU_ARGS"
fi
# EXTRA_ARGS: more arguments for a test image (e.g. EXTRA_ARGS="sweetamp=2" to try the scheduler v2)
[ -z "${CMDLINE_GIVEN:-}" ] && [ -n "${EXTRA_ARGS:-}" ] && CMDLINE="$CMDLINE $EXTRA_ARGS"
# the boot header holds 607 characters of command line: refuse a longer one instead of cutting it in the middle of an argument
if [ "${#CMDLINE}" -gt 607 ]; then
	echo "error: the command line is ${#CMDLINE} characters, the boot header holds 607 (drop an argument or set GPU=0)" >&2
	exit 1
fi
mkdir -p enxerto/out
# Apple logo as Enxerto's last frame (docs: tools/mkapplelogo.py): read from the iOS root you built, never
# committed. APPLE_LOGO=0 skips it (the Bergamota screen stays), APPLE_LOGO_PNG=file uses an extracted PNG.
rm -f enxerto/applelogo.h
if [ "${APPLE_LOGO:-1}" != 0 ]; then
	ROOT_SIMG=${ROOT_SIMG:-$WORK/${NAME}-root-full.simg}
	[ -e "$ROOT_SIMG" ] || ROOT_SIMG=../ios-beryllium-$NAME/$WORK/${NAME}-root-full.simg
	if [ -n "${APPLE_LOGO_PNG:-}" ]; then LOGO_SRC=(--png "$APPLE_LOGO_PNG"); else LOGO_SRC=(--root "$ROOT_SIMG"); fi
	python3 tools/mkapplelogo.py "${LOGO_SRC[@]}" || echo "warning: no Apple logo (Bergamota screen stays)" >&2
fi
python3 tools/mkpayload.py "$KERNEL" "$ADT" enxerto/out/payload-${NAME}full.bin --cmdline "$CMDLINE"
# BOARD=fajita (OnePlus 6T) with DTB=dtb/fajita/dtb and a fajita ADT; default beryllium (Poco F1)
BOARD=${BOARD:-beryllium} enxerto/build.sh "$PWD/enxerto/out/payload-${NAME}full.bin"
cp enxerto/out/enxerto-boot.img "$OUT"
python3 tools/unpack_bootv2.py "$OUT" enxerto/out/check-${NAME}full >/dev/null 2>&1 && cmp enxerto/out/check-${NAME}full/ramdisk enxerto/out/payload-${NAME}full.bin && echo "payload check: ramdisk == payload"
ls -l "$OUT"
echo "cmdline: $CMDLINE"
