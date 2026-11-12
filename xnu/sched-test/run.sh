#!/bin/sh
# Host test of the sweet_amp v2 logic. Run from anywhere: sh xnu/sched-test/run.sh
set -e
here=$(cd "$(dirname "$0")" && pwd)
out=${TMPDIR:-/tmp}/sweet_amp_test.$$
# 1. the header in the patch must be the header under test
patch="$here/../patches-11215/0264-sweet-amp2-decision-logic.patch"
sed -n '/^+++ b\/osfmk\/kern\/sweet_amp_logic.h/,/^diff --git/p' "$patch" | sed -n '/^@@/,$p' | sed '1d' | grep '^+' | sed 's/^+//' > "$out.hdr"
if ! diff -q "$out.hdr" "$here/sweet_amp_logic.h" >/dev/null; then
	echo "FAIL: header in $patch differs from $here/sweet_amp_logic.h"
	diff "$out.hdr" "$here/sweet_amp_logic.h" | head -10
	rm -f "$out.hdr"
	exit 1
fi
echo "header in patch 0264 == xnu/sched-test/sweet_amp_logic.h"
# 2. build with the strict flags the kernel uses and run
${CC:-cc} -std=gnu11 -Wall -Wextra -Werror -Wshorten-64-to-32 -Wsign-compare -O2 -I"$here" -o "$out" "$here/sweet_amp_test.c" 2>&1 || \
	${CC:-cc} -std=gnu11 -Wall -Wextra -Werror -Wsign-compare -O2 -I"$here" -o "$out" "$here/sweet_amp_test.c"
"$out"
rm -f "$out" "$out.hdr"
