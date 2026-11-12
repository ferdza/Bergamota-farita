#!/usr/bin/env python3
"""Build and run the host test of bsd/dev/sweet_cpugov.h (patch 0268).

The header only exists inside the patch, so extract it (git apply into a scratch directory), compile
test_cpugov.c against that copy with gcc and run it. Exit status is the test's.
"""
import glob, os, subprocess, sys, tempfile

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.abspath(os.path.join(here, "..", ".."))
patches = sorted(glob.glob(os.path.join(root, "xnu/patches-11215/0268-*.patch")))
if len(patches) != 1:
    sys.exit("expected one xnu/patches-11215/0268-*.patch, found %d" % len(patches))

with tempfile.TemporaryDirectory() as d:
    r = subprocess.run(["git", "apply", "--include=bsd/dev/sweet_cpugov.h", patches[0]], cwd=d,
                       capture_output=True, text=True)
    if r.returncode:
        sys.exit("git apply failed: " + r.stderr)
    exe = os.path.join(d, "test_cpugov")
    cc = ["gcc", "-std=c99", "-O2", "-Wall", "-Wextra", "-Werror", "-I", d,
          os.path.join(here, "test_cpugov.c"), "-o", exe]
    r = subprocess.run(cc, capture_output=True, text=True)
    sys.stdout.write(r.stdout + r.stderr)
    if r.returncode:
        sys.exit("compile failed")
    sys.exit(subprocess.run([exe]).returncode)
