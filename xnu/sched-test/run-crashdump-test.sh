#!/bin/sh
# Host test of the fajita crash-dump disarm logic. Run from anywhere: sh xnu/sched-test/run-crashdump-test.sh
set -e
here=$(cd "$(dirname "$0")" && pwd)
out=${TMPDIR:-/tmp}/sweet_crashdump_test.$$
patch="$here/../patches-11215/0272-fajita-crashdump-off-scm.patch"
# the header in the patch must be the header under test
sed -n '/^+++ b\/bsd\/dev\/sweet_scm_logic.h/,/^diff --git/p' "$patch" | sed -n '/^@@/,$p' | sed '1d' | grep '^+' | sed 's/^+//' > "$out.hdr"
if ! diff -q "$out.hdr" "$here/sweet_scm_logic.h" >/dev/null; then
	echo "FAIL: header in $patch differs from $here/sweet_scm_logic.h"
	diff "$out.hdr" "$here/sweet_scm_logic.h" | head -10
	rm -f "$out.hdr"
	exit 1
fi
echo "header in patch 0272 == xnu/sched-test/sweet_scm_logic.h"
${CC:-cc} -std=gnu11 -Wall -Wextra -Werror -Wsign-compare -O2 -I"$here" -o "$out" "$here/test_crashdump.c"
"$out"
rm -f "$out" "$out.hdr"
