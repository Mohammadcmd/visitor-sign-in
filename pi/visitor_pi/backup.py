"""Nightly backup to a network folder (an office PC's shared folder or a NAS,
mounted on the Pi; see pi/README.md).

The backup folder holds:
  database/visitors-YYYY-MM-DD.db   one copy per night, the last 30 kept
  photos/                           a mirror of every visitor photo (new files are copied)
"""
import json
import os
import shutil
import sqlite3
import threading
import time
from datetime import datetime

KEEP_NIGHTS = 30
# Put this file in a backup folder that isn't a mount point to allow it (e.g. a USB drive's subfolder).
MARKER = '.visitor-pi-backup-target'


def run_backup(store, dest):
    """Copies the database and photos to dest. Records the outcome for the dashboard and kiosk."""
    started = datetime.now()
    result = {'at': started.isoformat(timespec='seconds'), 'path': dest, 'ok': False}
    try:
        if not dest:
            raise RuntimeError('No backup folder is set (backup_dir in the config file).')
        if not os.path.isdir(dest):
            raise RuntimeError(f'The backup folder {dest} is not there. Is the network folder mounted?')
        # An unmounted mount point is just an empty folder on the Pi's own card: backing up
        # there would protect nothing. Accept a real mount, or a folder marked on purpose.
        if not os.path.ismount(dest) and not os.path.exists(os.path.join(dest, MARKER)):
            raise RuntimeError(f'The network folder is not mounted at {dest}, so nothing was backed up.')
        probe = os.path.join(dest, '.visitor-pi-write-test')
        with open(probe, 'w') as f:
            f.write('ok')
        os.remove(probe)

        db_dir = os.path.join(dest, 'database')
        os.makedirs(db_dir, exist_ok=True)
        target = os.path.join(db_dir, f"visitors-{started.strftime('%Y-%m-%d')}.db")
        tmp = target + '.part'
        # SQLite's online backup gives a consistent copy even while the kiosk is in use.
        with store.lock:
            out = sqlite3.connect(tmp)
            try:
                store.db.backup(out)
            finally:
                out.close()
        os.replace(tmp, target)
        snapshots = sorted(n for n in os.listdir(db_dir) if n.startswith('visitors-') and n.endswith('.db'))
        for old in snapshots[:-KEEP_NIGHTS]:
            os.remove(os.path.join(db_dir, old))

        copied = 0
        for root, _, files in os.walk(store.photo_dir):
            rel = os.path.relpath(root, store.photo_dir)
            out_dir = os.path.join(dest, 'photos', rel)
            os.makedirs(out_dir, exist_ok=True)
            for name in files:
                src, dst = os.path.join(root, name), os.path.join(out_dir, name)
                if not os.path.exists(dst) or os.path.getsize(dst) != os.path.getsize(src):
                    shutil.copy2(src, dst)
                    copied += 1
        result.update(ok=True, database=os.path.basename(target), photosCopied=copied,
                      seconds=round((datetime.now() - started).total_seconds(), 1))
    except Exception as err:  # reported on the dashboard; never crashes the server
        result['error'] = str(err)
    with store.lock:
        store.set_setting('last_backup', json.dumps(result))
    return result


def schedule(store, dest, hour, log):
    """Background thread: one backup a night at `hour` (local time)."""
    def loop():
        done_for = None
        while True:
            now = datetime.now()
            if now.hour == hour and done_for != now.date():
                done_for = now.date()
                r = run_backup(store, dest)
                log(f"Backup {'done' if r['ok'] else 'FAILED'}: {r.get('error') or r.get('database')}")
            time.sleep(60)
    threading.Thread(target=loop, name='backup', daemon=True).start()
