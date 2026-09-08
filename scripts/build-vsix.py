#!/usr/bin/env python3
"""Build a .vsix from dist/ (vite build output) without npm/vsce."""
import json
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT_FILES = ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md']


def main() -> int:
    pkg = json.load(open(os.path.join(ROOT, 'package.json')))
    version = pkg['version']
    name = pkg['name']

    os.chdir(ROOT)
    if not os.path.exists('dist/extension.js'):
        print('dist/extension.js not found — run `npm run build` first', file=sys.stderr)
        return 1

    manifest = open('packaging/extension.vsixmanifest').read().replace('@@VERSION@@', version)
    content_types = open(os.path.join('packaging', '[Content_Types].xml')).read()

    os.makedirs('dist', exist_ok=True)
    vsix = os.path.join('dist', f'{name}-{version}.vsix')

    with zipfile.ZipFile(vsix, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', content_types)
        z.writestr('extension.vsixmanifest', manifest)
        for root, _, files in os.walk('dist'):
            for f in files:
                if f.endswith('.vsix'):
                    continue
                p = os.path.join(root, f)
                z.write(p, f'extension/{os.path.relpath(p, "dist")}')
        for f in ROOT_FILES:
            if os.path.exists(f):
                z.write(f, f'extension/{f}')

    print(vsix)
    return 0


if __name__ == '__main__':
    sys.exit(main())
