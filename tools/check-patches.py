#!/usr/bin/env python3
"""Validate that every patch in xnu/patches-* has valid git patch syntax and uncorrupted hunks."""
import glob, os, shutil, subprocess, sys, tempfile

def check_series(dir_path):
    print(f"Checking patches in {os.path.relpath(dir_path)}...")
    errors = 0
    patches = sorted(glob.glob(os.path.join(dir_path, "*.patch")))
    for p in patches:
        d = tempfile.mkdtemp()
        subprocess.run(["git", "init", "-q", d], check=True)
        try:
            with open(p, errors="ignore") as f:
                for line in f:
                    if line.startswith("+++ b/"):
                        fname = line[6:].strip()
                        os.makedirs(os.path.join(d, os.path.dirname(fname)), exist_ok=True)
                        open(os.path.join(d, fname), "w").write("a\n" * 5000)
            res = subprocess.run(["git", "-C", d, "apply", "--check", os.path.abspath(p)], capture_output=True, text=True)
            if "corrupt patch" in res.stderr or "rustine corrompue" in res.stderr:
                print(f"  [CORRUPT] {os.path.basename(p)}: {res.stderr.splitlines()[0]}")
                errors += 1
        finally:
            shutil.rmtree(d)
    if errors == 0:
        print(f"  All {len(patches)} patches in {os.path.relpath(dir_path)} are structurally VALID!")
    return errors

if __name__ == "__main__":
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    errs = 0
    errs += check_series(os.path.join(root, "xnu/patches-11215"))
    if os.path.isdir(os.path.join(root, "xnu/patches-12377")):
        errs += check_series(os.path.join(root, "xnu/patches-12377"))
    sys.exit(1 if errs > 0 else 0)
