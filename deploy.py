#!/usr/bin/env python3
"""Install verified files atomically, retaining a rollback for each destination.

Does not change MCP configuration, pairing keys, or any Figma document.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import stat
import uuid

ROOT = Path(__file__).resolve().parent
# server.py goes last: the running 2.1 server notices that file and reloads.
FILES = (
    'updater.py', 'test_updater.py', 'updates.py', 'version.json', 'test_updates.py', 'bridge_queue.py', 'multi_bridge.py', 'build_plugin.py', 'deploy.py', 'legacy_tests.py', 'upstream_tests.py', 'test_multi_bridge.py',
    'test_server.py', 'test_bridge_queue.py', 'test_deploy.py',
    'tests/test_connection.mjs', 'plugin/src/connection.js', 'plugin/src/ui.html',
    'plugin/manifest.json', 'plugin/code.js', 'plugin/ui.html',
    'skill/figma-local/SKILL.md', 'README.md', 'CHANGELOG.md', 'VERIFICATION.json', 'install.sh', 'server.py',
)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def atomic_write(path, data, mode):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name('.' + path.name + '.figma-stage-' + uuid.uuid4().hex)
    try:
        with temporary.open('xb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(mode)
        os.replace(str(temporary), str(path))
    finally:
        if temporary.exists():
            temporary.unlink()


def install(destination, source=ROOT, writer=atomic_write, files=FILES):
    source, destination = Path(source).resolve(), Path(destination).expanduser().resolve()
    changes = []
    for name in files:
        path = source / name
        payload = path.read_bytes()
        target = destination / name
        old = target.read_bytes() if target.is_file() else None
        if old == payload:
            continue
        if target.exists() and not target.is_file():
            raise ValueError('Destination is not a regular file: ' + str(target))
        changes.append((name, payload, stat.S_IMODE(path.stat().st_mode), old,
                        stat.S_IMODE(target.stat().st_mode) if old is not None else None))
    if not changes:
        return {'changed': 0, 'destination': str(destination), 'backup': None}
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:6]
    backup = destination / '.backups' / stamp
    backup.mkdir(parents=True, exist_ok=False)
    entries = []
    for name, payload, mode, old, old_mode in changes:
        if old is not None:
            atomic_write(backup / name, old, old_mode)
        entries.append({'path': name, 'existed': old is not None, 'old_mode': old_mode,
                        'installed_sha256': digest(payload)})
    metadata = {'destination': str(destination), 'files': entries}
    atomic_write(backup / 'deployment.json', json.dumps(metadata, indent=2).encode(), 0o600)
    written = []
    try:
        for name, payload, mode, old, old_mode in changes:
            writer(destination / name, payload, mode)
            written.append((name, old, old_mode))
    except BaseException:
        for name, old, old_mode in reversed(written):
            if old is None:
                (destination / name).unlink()
            else:
                atomic_write(destination / name, old, old_mode)
        raise
    return {'changed': len(changes), 'destination': str(destination), 'backup': str(backup)}


def restore(backup):
    backup = Path(backup).expanduser().resolve()
    metadata = json.loads((backup / 'deployment.json').read_text())
    destination = Path(metadata['destination'])
    # Refuse to overwrite changes made after the install.
    for entry in metadata['files']:
        target = destination / entry['path']
        if not target.is_file() or digest(target.read_bytes()) != entry['installed_sha256']:
            raise ValueError('File changed after installation: ' + str(target))
    for entry in reversed(metadata['files']):
        target = destination / entry['path']
        if entry['existed']:
            atomic_write(target, (backup / entry['path']).read_bytes(), entry['old_mode'])
        else:
            target.unlink()
    return {'restored': len(metadata['files']), 'destination': str(destination)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('destination', nargs='?')
    parser.add_argument('--restore')
    args = parser.parse_args()
    if args.restore:
        result = restore(args.restore)
    elif args.destination:
        result = install(args.destination)
    else:
        parser.error('Pass a destination or --restore BACKUP_FOLDER')
    print(json.dumps(result, ensure_ascii=False))
