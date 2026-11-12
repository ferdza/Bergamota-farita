#!/usr/bin/env python3
"""Adds Chlorophyll (the GPU userland) to a berga-tools.zip as bgmtl/<file>, so Renegade installs it and wires backboardd by default.

  add-chlorophyll.py BERGA_TOOLS.zip CHLOROPHYLL_IOS18.zip [OUT.zip]

Takes usr/local/lib/bgmtl/{bgmtl-inject,libchlorophyll,libdrm.2}.dylib out of chlorophyll-ios18.zip (the artifact of
.github/workflows/chlorophyll.yml), lists them in berga-tools.json (SHA-256 and size, which Renegade checks on read) and
writes the zip again (in place without OUT) with its berga-tools.zip.sha256 next to it. Anything else in the Chlorophyll zip
(tests, licences) stays out. Python standard library only; the input bundle is never changed before the output verified.
"""
import hashlib
import json
import os
import sys
import tempfile
import zipfile

FILES = ('bgmtl-inject.dylib', 'libchlorophyll.dylib', 'libdrm.2.dylib')
SRC = 'usr/local/lib/bgmtl/'


def main(argv):
    if len(argv) not in (3, 4):
        sys.exit(__doc__)
    tools, chl = argv[1], argv[2]
    out = argv[3] if len(argv) == 4 else tools
    with zipfile.ZipFile(chl) as c:
        have = set(c.namelist())
        miss = [f for f in FILES if SRC + f not in have]
        if miss:
            sys.exit('%s: missing %s' % (chl, ', '.join(SRC + m for m in miss)))
        new = {'bgmtl/' + f: c.read(SRC + f) for f in FILES}
    with zipfile.ZipFile(tools) as z:
        manifest = json.loads(z.read('berga-tools.json'))
        keep = [(i, z.read(i.filename)) for i in z.infolist() if i.filename != 'berga-tools.json' and not i.filename.startswith('bgmtl/')]
    manifest['files'] = [e for e in manifest['files'] if not e['path'].startswith('bgmtl/')]
    for p, d in new.items():
        manifest['files'].append({'path': p, 'sha256': hashlib.sha256(d).hexdigest(), 'size': len(d)})
    manifest['files'].sort(key=lambda e: e['path'])
    fd, tmp = tempfile.mkstemp(suffix='.zip', dir=os.path.dirname(os.path.abspath(out)))
    os.close(fd)
    try:
        with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as z:
            for i, d in keep:
                z.writestr(i, d)
            for p, d in new.items():
                z.writestr(zipfile.ZipInfo(p, (2026, 1, 1, 0, 0, 0)), d, zipfile.ZIP_DEFLATED)
            z.writestr('berga-tools.json', json.dumps(manifest, indent=1) + '\n')
        with zipfile.ZipFile(tmp) as z:       # verify what was written, as Renegade will
            m = json.loads(z.read('berga-tools.json'))
            for e in m['files']:
                d = z.read(e['path'])
                if hashlib.sha256(d).hexdigest() != e['sha256'] or len(d) != e['size']:
                    sys.exit('verification failed for ' + e['path'])
        os.replace(tmp, out)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    with open(out, 'rb') as f:
        h = hashlib.sha256(f.read()).hexdigest()
    with open(out + '.sha256', 'w') as f:
        f.write('%s  %s\n' % (h, os.path.basename(out)))
    print('%s: +%d Chlorophyll files, %d listed, sha256 %s' % (out, len(new), len(manifest['files']), h[:12]))


if __name__ == '__main__':
    main(sys.argv)
