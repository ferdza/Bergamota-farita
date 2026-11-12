#!/usr/bin/env python3
"""Replaces (or adds) one file in a berga-tools.zip and updates berga-tools.json (SHA-256, size) and berga-tools.zip.sha256.

  replace-file.py BERGA_TOOLS.zip PATH_IN_ZIP NEW_FILE

Used by pages.yml to put the freshly built sweetnet/ios18/sweetuicache (release sweetuicache-ios18) into the bundle. Python standard library only."""
import hashlib, json, os, sys, tempfile, zipfile


def main(argv):
    if len(argv) != 4:
        sys.exit(__doc__)
    tools, path, new = argv[1:]
    data = open(new, 'rb').read()
    with zipfile.ZipFile(tools) as z:
        manifest = json.loads(z.read('berga-tools.json'))
        keep = [(i, z.read(i.filename)) for i in z.infolist() if i.filename not in ('berga-tools.json', path)]
    manifest['files'] = [e for e in manifest['files'] if e['path'] != path]
    manifest['files'].append({'path': path, 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)})
    manifest['files'].sort(key=lambda e: e['path'])
    fd, tmp = tempfile.mkstemp(suffix='.zip', dir=os.path.dirname(os.path.abspath(tools)))
    os.close(fd)
    with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as o:
        for i, d in keep:
            zi = zipfile.ZipInfo(i.filename, i.date_time)
            zi.external_attr = i.external_attr
            zi.compress_type = zipfile.ZIP_DEFLATED
            o.writestr(zi, d)
        zi = zipfile.ZipInfo(path, (2026, 1, 1, 0, 0, 0))
        zi.external_attr = 0o755 << 16
        zi.compress_type = zipfile.ZIP_DEFLATED
        o.writestr(zi, data)
        o.writestr('berga-tools.json', json.dumps(manifest, indent=1, sort_keys=True))
    with zipfile.ZipFile(tmp) as v:
        assert v.testzip() is None
    os.replace(tmp, tools)
    h = hashlib.sha256(open(tools, 'rb').read()).hexdigest()
    open(tools + '.sha256', 'w').write('%s  %s\n' % (h, os.path.basename(tools)))
    print('%s: %s replaced (%d bytes)' % (tools, path, len(data)))


main(sys.argv)
