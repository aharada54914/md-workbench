"""Extract only the pinned non-product spike subset into WORK_DIR/assets."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import zipfile

WAR_SHA256 = '6ee1ce19242bbabf348c52e41e1fe17057d57236e731acf48d7a3710ca50c375'
MANIFEST_SHA256 = '1e46b33115fc440cd871ea8d6bc7ea9caeb419fd9792b6b7afc0d645e6e488ef'


def require(condition, message):
    # Explicit checks also execute under python -O.
    if not condition:
        raise ValueError(message)


def safe_path(name):
    require(isinstance(name, str) and 0 < len(name) <= 500, 'Invalid path length')
    require(not re.search(r'[\\\x00-\x1f:]', name), 'Invalid path characters')
    require(all(p and p not in ('.', '..') for p in name.split('/')), 'Unsafe path')
    require(not PurePosixPath(name).is_absolute(), 'Absolute path')


def read_manifest():
    source = Path(__file__).with_name('manifest.json')
    require(source.stat().st_size <= 600_000, 'Manifest too large')
    raw = source.read_bytes()
    require(hashlib.sha256(raw).hexdigest() == MANIFEST_SHA256, 'Fixed manifest digest mismatch')
    m = json.loads(raw)
    require(m['version'] == '31.4.5' and m['warSha256'] == WAR_SHA256, 'Wrong version')
    require(len(m['files']) == 2308, 'Wrong file count')
    seen = set()
    for entry in m['files']:
        safe_path(entry['path'])
        require(entry['path'] not in seen, 'Duplicate path')
        seen.add(entry['path'])
        require(type(entry['bytes']) is int and 0 <= entry['bytes'] <= 30_000_000, 'Invalid size')
        require(re.fullmatch('[a-f0-9]{64}', entry['sha256']) is not None, 'Invalid digest')
    require(sum(e['bytes'] for e in m['files']) == 36_332_532, 'Wrong total size')
    return m


def extract(work_dir):
    base = Path(work_dir).resolve(strict=True)
    archive = base / 'drawio.war'
    require(archive.is_file() and not archive.is_symlink(), 'Require regular drawio.war')
    require(archive.stat().st_size == 53_739_401, 'Wrong WAR size')
    require(hashlib.sha256(archive.read_bytes()).hexdigest() == WAR_SHA256, 'Fixed WAR digest mismatch')
    m = read_manifest()
    out = base / 'assets'
    require(not out.exists() and not out.is_symlink(), 'assets must be absent; refusing overwrite')
    with zipfile.ZipFile(archive) as z:
        entries = z.infolist()
        require(len(entries) < 5000 and len({e.filename for e in entries}) == len(entries), 'Archive count/duplicates')
        require(sum(e.file_size for e in entries) < 160_000_000, 'Archive too large')
        for entry in entries:
            safe_path(entry.filename.rstrip('/'))
            require(not stat.S_ISLNK(entry.external_attr >> 16), 'Archive symlink')
        # Validate all selected bytes before creating output.
        for item in m['files']:
            data = z.read(item['path'])
            require(len(data) == item['bytes'] and hashlib.sha256(data).hexdigest() == item['sha256'], 'Asset mismatch')
        out.mkdir(mode=0o700)
        try:
            for item in m['files']:
                target = out / item['path']
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open('xb') as file:
                    file.write(z.read(item['path']))
        except BaseException:
            shutil.rmtree(out)
            raise
    print(f'Extracted {len(m["files"])} verified files into {out}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work-dir', required=True)
    extract(parser.parse_args().work_dir)
