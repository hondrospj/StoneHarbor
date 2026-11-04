#!/usr/bin/env python3
"""Prepare checksum-pinned browser-test vendors outside the checkout."""
import argparse
import hashlib
from pathlib import Path
import tempfile
import urllib.request

FILES = {
    'chart.js': ('https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
                 'd2af8974e95271638772e9e9524db5b9a6f58d6ec2d5d781400447b4a31c681e'),
    'leaflet.js': ('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
                   'db49d009c841f5ca34a888c96511ae936fd9f5533e90d8b2c4d57596f4e5641a'),
    'leaflet.css': ('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
                    'a7837102824184820dfa198d1ebcd109ff6d0ff9a2672a074b9a1b4d147d04c6')
}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--offline', action='store_true', help='Verify existing files without network access')
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    for name, (url, expected) in FILES.items():
        target = args.out / name
        if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest() == expected:
            print('Verified ' + name)
            continue
        if args.offline:
            raise SystemExit('Missing or mismatched vendor: ' + str(target))
        with urllib.request.urlopen(url, timeout=30) as response:
            data = response.read(8 * 1024 * 1024 + 1)
        if hashlib.sha256(data).hexdigest() != expected:
            raise SystemExit('Vendor checksum mismatch: ' + name)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=args.out, delete=False) as output:
                temporary = Path(output.name)
                output.write(data)
            temporary.replace(target)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        print('Cached ' + name)

if __name__ == '__main__':
    main()
