"""Command line for the Pi.

  python3 -m visitor_pi serve       run the server, badge reader and nightly backup
  python3 -m visitor_pi set-pin     set or change the admin PIN
  python3 -m visitor_pi show-key    print the kiosk key the tablet needs
  python3 -m visitor_pi backup-now  run a backup right away

The config file is /etc/visitor-pi/config.json (override with --config). Keys:
  data_dir     where the database and photos live (default /var/lib/visitor-pi)
  port         web server port (default 8080)
  backup_dir   the mounted network folder for nightly backups
  backup_hour  hour of the night to back up, 0-23 (default 2)
"""
import argparse
import getpass
import json
import os
import sys
import threading
from datetime import datetime

from .backup import run_backup, schedule
from .nfc import run_reader
from .server import serve
from .store import Store

DEFAULTS = {'data_dir': '/var/lib/visitor-pi', 'port': 8080, 'backup_dir': '', 'backup_hour': 2}


def log(msg):
    print(f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')} {msg}", flush=True)


def load_config(path):
    cfg = dict(DEFAULTS)
    if path and os.path.exists(path):
        with open(path) as f:
            cfg.update(json.load(f))
    return cfg


def main(argv=None):
    p = argparse.ArgumentParser(prog='visitor_pi', description='Shock Tech visitor kiosk server for a Raspberry Pi')
    p.add_argument('command', choices=['serve', 'set-pin', 'show-key', 'backup-now'])
    p.add_argument('--config', default=os.environ.get('VISITOR_PI_CONFIG', '/etc/visitor-pi/config.json'))
    args = p.parse_args(argv)
    cfg = load_config(args.config)
    store = Store(cfg['data_dir'])

    if args.command == 'show-key':
        print(store.kiosk_key)
    elif args.command == 'set-pin':
        pin = os.environ.get('VISITOR_PI_PIN') or getpass.getpass('New admin PIN (6 to 8 digits): ')
        if not os.environ.get('VISITOR_PI_PIN') and getpass.getpass('Repeat it: ') != pin:
            sys.exit("The PINs don't match.")
        res = store.set_pin(pin)
        sys.exit(0 if res['ok'] else 'The PIN must be 6 to 8 digits.')
    elif args.command == 'backup-now':
        res = run_backup(store, cfg['backup_dir'])
        print(json.dumps(res, indent=2))
        sys.exit(0 if res['ok'] else 1)
    else:
        if not store.setting('admin_pin'):
            log('No admin PIN yet: run "python3 -m visitor_pi set-pin" (the admin screen stays locked until then).')

        def on_tap(tag):
            with store.lock:
                res = store.tap_badge(tag, 'Badge tap at the Pi reader')
            if res['result'] == 'signed_out':
                log(f"Signed out {res['name']} (badge {res['badge']}) at the Pi reader")
            elif res['result'] == 'not_out':
                log(f"Badge {res['badge']} tapped at the Pi reader, but it isn't checked out")
            else:
                log('A tag that isn\'t linked to any badge was tapped at the Pi reader')

        threading.Thread(target=run_reader, args=(store, log, on_tap), name='nfc', daemon=True).start()
        if cfg['backup_dir']:
            schedule(store, cfg['backup_dir'], int(cfg['backup_hour']), log)
        else:
            log('No backup_dir set: nightly backups are off.')
        serve(store, cfg, log)


if __name__ == '__main__':
    main()
