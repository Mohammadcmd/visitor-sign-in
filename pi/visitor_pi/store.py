"""Everything the kiosk can ask for, stored in one SQLite database on the Pi.

These are the actions the tablet app calls through web/js/api.js, with the
same JSON replies as its demo mode. Photos are saved as JPEG files under
<data>/photos/<visitor id>/.
"""
import base64
import hashlib
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timezone

from .matching import company_words, name_key, near, normalize_tag, same_company

CITIZENSHIP_OPTIONS = [
    'U.S. citizen',
    'Lawful permanent resident (green card holder)',
    'Protected individual (asylee or refugee)',
    'Not a U.S. citizen or permanent resident',
]
WRITE_ACTIONS = {'register', 'addFaceSample', 'setQuickEntry', 'assignBadge', 'tapAtWelcome',
                 'undoSignOut', 'adminSignOut', 'adminAddBadge', 'adminLinkTag', 'adminRetireBadge',
                 'adminRestoreBadge', 'adminSetPin'}
ADMIN_TOKEN_TTL = 15 * 60
REPLAY_TTL = 30 * 60
MAX_TEXT = 120
MAX_PHOTO_CHARS = 4 * 1024 * 1024
PHOTO_RE = re.compile(r'^data:image/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$')
SCHEMA = """
CREATE TABLE IF NOT EXISTS visitors (
  id TEXT PRIMARY KEY, first TEXT, last TEXT, company TEXT, visiting TEXT, purpose TEXT,
  citizenship TEXT, country TEXT, acknowledgment TEXT, quick_entry INTEGER DEFAULT 0,
  registered TEXT, last_visit TEXT, visit_count INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS visits (
  id TEXT PRIMARY KEY, visitor_id TEXT, first TEXT, last TEXT, company TEXT, visiting TEXT,
  purpose TEXT, kind TEXT, badge TEXT, method TEXT, signed_in TEXT, signed_out TEXT,
  signed_out_by TEXT);
CREATE INDEX IF NOT EXISTS visits_open ON visits (signed_out, visitor_id);
CREATE TABLE IF NOT EXISTS badges (
  badge TEXT PRIMARY KEY COLLATE NOCASE, tag TEXT, status TEXT DEFAULT 'available', holder TEXT,
  visitor_id TEXT, visit_id TEXT, since TEXT, note TEXT, added TEXT);
CREATE TABLE IF NOT EXISTS faces (
  id INTEGER PRIMARY KEY AUTOINCREMENT, visitor_id TEXT, descriptor TEXT, captured TEXT,
  source TEXT, photo TEXT);
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, visitor_id TEXT, file TEXT, label TEXT, taken TEXT);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS replays (rid TEXT PRIMARY KEY, response TEXT, at REAL);
"""


def now_iso():
    t = datetime.now(timezone.utc)
    return t.strftime('%Y-%m-%dT%H:%M:%S.') + f'{t.microsecond // 1000:03d}Z'


def clean(s):
    """Visitor text: trimmed, collapsed, length-capped."""
    return re.sub(r'\s+', ' ', '' if s is None else str(s)).strip()[:MAX_TEXT]


def random_code(n):
    alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    return ''.join(secrets.choice(alphabet) for _ in range(n))


def is_descriptor(d):
    return isinstance(d, list) and len(d) == 128 and all(isinstance(x, (int, float)) for x in d)


def is_photo(s):
    return isinstance(s, str) and len(s) < MAX_PHOTO_CHARS and bool(PHOTO_RE.match(s))


def pin_hash(salt, pin):
    return hashlib.sha256(f'{salt}:{pin}'.encode()).hexdigest()


def is_us_person(c):
    return c in CITIZENSHIP_OPTIONS[:3]


class Store:
    def __init__(self, data_dir):
        self.data_dir = data_dir
        self.photo_dir = os.path.join(data_dir, 'photos')
        os.makedirs(self.photo_dir, exist_ok=True)
        self.db_path = os.path.join(data_dir, 'visitors.db')
        self.db = sqlite3.connect(self.db_path, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.executescript(SCHEMA)
        self.lock = threading.RLock()
        self.tokens = {}            # admin token -> expiry
        self.pin_fails = []         # times of recent wrong PINs
        self.dashboard_url = ''     # set by the web server, shown in the kiosk's Settings
        if not self.setting('kiosk_key'):
            self.set_setting('kiosk_key', secrets.token_urlsafe(24))

    # ------------------------------------------------------------ settings

    def setting(self, key, default=None):
        row = self.db.execute('SELECT value FROM settings WHERE key = ?', (key,)).fetchone()
        return row['value'] if row else default

    def set_setting(self, key, value):
        self.db.execute('INSERT INTO settings (key, value) VALUES (?, ?) '
                        'ON CONFLICT(key) DO UPDATE SET value = excluded.value', (key, value))

    @property
    def kiosk_key(self):
        return self.setting('kiosk_key')

    # ------------------------------------------------------------ entry point

    def handle(self, req):
        """One API call from the kiosk: {key, action, args, rid}."""
        if not isinstance(req, dict) or not secrets.compare_digest(str(req.get('key') or ''), self.kiosk_key):
            return {'ok': False, 'error': 'kiosk_key'}
        rid = req.get('rid')
        rid = rid if isinstance(rid, str) and re.match(r'^[A-Za-z0-9-]{6,64}$', rid) else ''
        action = req.get('action')
        with self.lock:
            if rid and action in WRITE_ACTIONS:
                self.db.execute('DELETE FROM replays WHERE at < ?', (time.time() - REPLAY_TTL,))
                seen = self.db.execute('SELECT response FROM replays WHERE rid = ?', (rid,)).fetchone()
                if seen:
                    return json.loads(seen['response'])
            out = self.dispatch(action, req.get('args') or {})
            if rid and action in WRITE_ACTIONS:
                self.db.execute('INSERT OR REPLACE INTO replays (rid, response, at) VALUES (?, ?, ?)',
                                (rid, json.dumps(out), time.time()))
            return out

    def dispatch(self, action, a):
        public = {
            'ping': lambda: {'ok': True, 'citizenship': CITIZENSHIP_OPTIONS},
            'faceIndex': self.face_index,
            'register': lambda: self.register(a),
            'findVisitor': lambda: self.find_visitor(a),
            'addFaceSample': lambda: self.add_face_sample(a),
            'setQuickEntry': lambda: self.set_quick_entry(a),
            'assignBadge': lambda: self.assign_badge(a),
            'tapAtWelcome': lambda: self.tap_badge(a.get('tag'), 'Badge tap at kiosk'),
            'undoSignOut': lambda: self.undo_sign_out(a.get('visitId')),
            'adminLogin': lambda: self.admin_login(a.get('pin')),
        }
        if action in public:
            return public[action]()
        if not self.check_admin(a.get('token')):
            return {'ok': False, 'error': 'admin'}
        admin = {
            'adminInside': self.admin_inside,
            'adminBadges': self.admin_badges,
            'adminStatus': self.admin_status,
            'adminSetPin': lambda: self.set_pin(a.get('pin')),
            'adminSignOut': lambda: self.admin_sign_out(a.get('visitId')),
            'adminAddBadge': lambda: self.add_badge(a.get('badge'), a.get('tag')),
            'adminLinkTag': lambda: self.link_tag(a.get('badge'), a.get('tag')),
            'adminRetireBadge': lambda: self.retire_badge(a.get('badge'), True),
            'adminRestoreBadge': lambda: self.retire_badge(a.get('badge'), False),
        }
        if action in admin:
            return admin[action]()
        return {'ok': False, 'error': 'unknown_action'}

    # ------------------------------------------------------------ visitors

    def register(self, a):
        v = {k: clean(a.get(k)) for k in ('first', 'last', 'company', 'visiting', 'purpose', 'citizenship', 'country')}
        v['company'] = v['company'] or 'N/A'
        missing = [k for k in ('first', 'last', 'visiting', 'purpose', 'citizenship') if not v[k]]
        if v['citizenship'] not in CITIZENSHIP_OPTIONS:
            missing.append('citizenship')
        if v['citizenship'] == CITIZENSHIP_OPTIONS[0]:
            v['country'] = 'United States'
        if not v['country']:
            missing.append('country')
        if a.get('agreed') is not True:
            missing.append('agreed')
        if not is_photo(a.get('photo')):
            missing.append('photo')
        if missing:
            return {'ok': False, 'error': 'missing', 'fields': missing}

        vid = 'P' + random_code(8)
        stamp = now_iso()
        quick = a.get('quickEntry') is True
        self.db.execute(
            'INSERT INTO visitors (id, first, last, company, visiting, purpose, citizenship, country, '
            'acknowledgment, quick_entry, registered, last_visit, visit_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)',
            (vid, v['first'], v['last'], v['company'], v['visiting'], v['purpose'], v['citizenship'], v['country'],
             f'Agreed to the Shock Tech visitor rules on the kiosk ({stamp})', int(quick), stamp, stamp))
        photo = self.save_photo(vid, a['photo'], 'signup')
        if quick and is_descriptor(a.get('descriptor')):
            self.add_face_row(vid, a['descriptor'], 'signup', photo)
        return {'ok': True, 'visitor': {'id': vid, 'first': v['first'], 'last': v['last'],
                                        'company': v['company'], 'quickEntry': quick}}

    def find_visitor(self, a):
        first, last, company = name_key(a.get('first')), name_key(a.get('last')), company_words(a.get('company'))
        if not first or not last:
            return {'ok': False, 'error': 'fullname'}
        matches = []
        for r in self.db.execute('SELECT * FROM visitors ORDER BY last_visit DESC'):
            if not near(name_key(r['first']), first) or not near(name_key(r['last']), last):
                continue
            if company and not same_company(company_words(r['company']), company):
                continue
            matches.append({'id': r['id'], 'first': r['first'], 'last': r['last'], 'company': r['company'],
                            'quickEntry': bool(r['quick_entry']), 'lastVisit': (r['last_visit'] or '')[:10]})
            if len(matches) == 5:
                break
        return {'ok': True, 'matches': matches}

    def face_index(self):
        people = {r['id']: {'id': r['id'], 'first': r['first'], 'last': r['last'], 'company': r['company'],
                            'descriptors': []}
                  for r in self.db.execute('SELECT * FROM visitors WHERE quick_entry = 1')}
        for r in self.db.execute('SELECT visitor_id, descriptor FROM faces ORDER BY id'):
            p = people.get(r['visitor_id'])
            if p:
                try:
                    d = json.loads(r['descriptor'])
                    if is_descriptor(d):
                        p['descriptors'].append(d)
                except ValueError:
                    pass
        out = []
        for p in people.values():
            p['descriptors'] = p['descriptors'][-12:]
            if p['descriptors']:
                out.append(p)
        return {'ok': True, 'people': out}

    def add_face_sample(self, a):
        r = self.visitor(a.get('visitorId'))
        if not r:
            return {'ok': False, 'error': 'not_found'}
        if not r['quick_entry']:
            return {'ok': True, 'saved': False}
        if not is_photo(a.get('photo')) or not is_descriptor(a.get('descriptor')):
            return {'ok': False, 'error': 'missing'}
        source = clean(a.get('source')) or 'return'
        photo = self.save_photo(r['id'], a['photo'], source)
        self.add_face_row(r['id'], a['descriptor'], source, photo)
        return {'ok': True, 'saved': True}

    def set_quick_entry(self, a):
        r = self.visitor(a.get('visitorId'))
        if not r:
            return {'ok': False, 'error': 'not_found'}
        on = bool(a.get('on'))
        self.db.execute('UPDATE visitors SET quick_entry = ? WHERE id = ?', (int(on), r['id']))
        if not on:
            self.db.execute('DELETE FROM faces WHERE visitor_id = ?', (r['id'],))
        return {'ok': True}

    def visitor(self, vid):
        return self.db.execute('SELECT * FROM visitors WHERE id = ?', (str(vid or ''),)).fetchone() if vid else None

    def add_face_row(self, vid, descriptor, source, photo):
        rounded = [round(float(x), 4) for x in descriptor]
        self.db.execute('INSERT INTO faces (visitor_id, descriptor, captured, source, photo) VALUES (?,?,?,?,?)',
                        (vid, json.dumps(rounded), now_iso(), source, photo))

    def save_photo(self, vid, data_url, label):
        m = PHOTO_RE.match(data_url)
        ext = 'jpg' if m.group(1) == 'jpeg' else m.group(1)
        folder = os.path.join(self.photo_dir, vid)
        os.makedirs(folder, exist_ok=True)
        label = re.sub(r'[^a-z0-9-]', '', label.lower())[:20] or 'photo'
        name = f"{datetime.now().strftime('%Y-%m-%d_%H%M%S')}_{secrets.token_hex(2)}_{label}.{ext}"
        with open(os.path.join(folder, name), 'wb') as f:
            f.write(base64.b64decode(m.group(2)))
        rel = f'{vid}/{name}'
        self.db.execute('INSERT INTO photos (visitor_id, file, label, taken) VALUES (?,?,?,?)', (vid, rel, label, now_iso()))
        return rel

    # ------------------------------------------------------------ badges and visits

    def badge_by_tag(self, tag):
        t = normalize_tag(tag)
        if not t:
            return None
        for r in self.db.execute('SELECT * FROM badges WHERE tag IS NOT NULL AND tag != ""'):
            if normalize_tag(r['tag']) == t:
                return r
        return None

    def assign_badge(self, a):
        p = self.visitor(a.get('visitorId'))
        if not p:
            return {'ok': False, 'error': 'not_found'}
        b = self.badge_by_tag(a.get('tag'))
        if not b:
            return {'ok': False, 'error': 'badge_unknown'}
        if b['status'] == 'retired':
            return {'ok': False, 'error': 'badge_retired', 'badge': b['badge']}
        if b['status'] == 'in use':
            if b['visitor_id'] == p['id']:
                return {'ok': True, 'badge': b['badge'], 'already': True}
            return {'ok': False, 'error': 'badge_in_use', 'badge': b['badge']}

        # One open visit per person: a second badge replaces the first.
        open_visit = self.db.execute('SELECT * FROM visits WHERE visitor_id = ? AND signed_out IS NULL '
                                     'ORDER BY signed_in DESC LIMIT 1', (p['id'],)).fetchone()
        if open_visit:
            self.sign_out(open_visit, f"Switched to badge {b['badge']}")

        stamp, visit_id = now_iso(), 'S' + random_code(8)
        self.db.execute(
            'INSERT INTO visits (id, visitor_id, first, last, company, visiting, purpose, kind, badge, method, signed_in) '
            'VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            (visit_id, p['id'], p['first'], p['last'], p['company'], clean(a.get('visiting')) or p['visiting'],
             clean(a.get('purpose')) or p['purpose'],
             'Visitor' if is_us_person(p['citizenship']) else 'Foreign national', b['badge'],
             clean(a.get('method')) or 'kiosk', stamp))
        self.db.execute("UPDATE badges SET status = 'in use', holder = ?, visitor_id = ?, visit_id = ?, since = ? "
                        'WHERE badge = ?', (f"{p['first']} {p['last']}", p['id'], visit_id, stamp, b['badge']))
        self.db.execute('UPDATE visitors SET last_visit = ?, visit_count = visit_count + 1 WHERE id = ?', (stamp, p['id']))
        return {'ok': True, 'badge': b['badge'], 'visitId': visit_id}

    def tap_badge(self, tag, by):
        """A badge tapped at the welcome screen or on the Pi's own reader: sign the holder out."""
        b = self.badge_by_tag(tag)
        if not b:
            return {'ok': True, 'result': 'unknown'}
        if b['status'] != 'in use':
            return {'ok': True, 'result': 'not_out', 'badge': b['badge']}
        visit = self.db.execute('SELECT * FROM visits WHERE id = ?', (b['visit_id'],)).fetchone()
        if visit:
            self.sign_out(visit, by)
        else:
            self.release_badge(b['badge'])
        return {'ok': True, 'result': 'signed_out', 'badge': b['badge'], 'name': b['holder'],
                'first': visit['first'] if visit else b['holder'], 'visitId': b['visit_id']}

    def undo_sign_out(self, visit_id, window=90):
        visit = self.db.execute('SELECT * FROM visits WHERE id = ?', (str(visit_id or ''),)).fetchone()
        if not visit:
            return {'ok': False, 'error': 'not_found'}
        out = visit['signed_out']
        if not out or (datetime.now(timezone.utc) - parse_iso(out)).total_seconds() > window:
            return {'ok': False, 'error': 'too_late'}
        b = self.db.execute('SELECT * FROM badges WHERE badge = ?', (visit['badge'],)).fetchone()
        if not b or b['status'] == 'in use':
            return {'ok': False, 'error': 'badge_in_use'}
        self.db.execute('UPDATE visits SET signed_out = NULL, signed_out_by = NULL WHERE id = ?', (visit['id'],))
        self.db.execute("UPDATE badges SET status = 'in use', holder = ?, visitor_id = ?, visit_id = ?, since = ? "
                        'WHERE badge = ?', (f"{visit['first']} {visit['last']}", visit['visitor_id'], visit['id'],
                                            visit['signed_in'], b['badge']))
        return {'ok': True}

    def sign_out(self, visit, by):
        self.db.execute('UPDATE visits SET signed_out = ?, signed_out_by = ? WHERE id = ?', (now_iso(), by, visit['id']))
        b = self.db.execute('SELECT * FROM badges WHERE badge = ?', (visit['badge'],)).fetchone()
        if b and b['visit_id'] == visit['id']:
            self.release_badge(b['badge'])

    def release_badge(self, badge):
        self.db.execute("UPDATE badges SET status = 'available', holder = NULL, visitor_id = NULL, visit_id = NULL, "
                        'since = NULL WHERE badge = ?', (badge,))

    # ------------------------------------------------------------ admin

    def admin_login(self, pin):
        cutoff = time.time() - 600
        self.pin_fails = [t for t in self.pin_fails if t > cutoff]
        if len(self.pin_fails) >= 10:
            return {'ok': False, 'error': 'locked'}
        if not self.pin_matches(str(pin or '')):
            self.pin_fails.append(time.time())
            time.sleep(0.7)
            return {'ok': False, 'error': 'pin'}
        token = secrets.token_urlsafe(24)
        self.tokens[token] = time.time() + ADMIN_TOKEN_TTL
        return {'ok': True, 'token': token, 'ttl': ADMIN_TOKEN_TTL}

    def pin_matches(self, pin):
        stored = self.setting('admin_pin')
        if not stored:
            return False
        h = json.loads(stored)
        return secrets.compare_digest(h['hash'], pin_hash(h['salt'], pin))

    def set_pin(self, pin):
        pin = str(pin or '')
        if not re.match(r'^\d{6,8}$', pin):
            return {'ok': False, 'error': 'pin_format'}
        salt = secrets.token_hex(16)
        at = now_iso()
        self.set_setting('admin_pin', json.dumps({'salt': salt, 'hash': pin_hash(salt, pin), 'at': at}))
        return {'ok': True, 'at': at}

    def check_admin(self, token):
        if not token:
            return False
        now = time.time()
        for t in [t for t, exp in self.tokens.items() if exp < now]:
            del self.tokens[t]
        if token not in self.tokens:
            return False
        self.tokens[token] = now + ADMIN_TOKEN_TTL  # sliding expiry
        return True

    def admin_inside(self):
        rows = self.db.execute('SELECT * FROM visits WHERE signed_out IS NULL ORDER BY last, first')
        return {'ok': True, 'inside': [{
            'visitId': r['id'], 'visitorId': r['visitor_id'], 'first': r['first'], 'last': r['last'],
            'company': r['company'], 'visiting': r['visiting'], 'kind': r['kind'], 'badge': r['badge'],
            'since': r['signed_in']} for r in rows]}

    def admin_badges(self):
        rows = self.db.execute('SELECT * FROM badges')
        return {'ok': True, 'badges': [{
            'badge': r['badge'], 'tag': r['tag'] or '', 'status': r['status'] or 'available',
            'holder': r['holder'] or '', 'since': r['since'] or ''} for r in rows]}

    def admin_sign_out(self, visit_id):
        visit = self.db.execute('SELECT * FROM visits WHERE id = ?', (str(visit_id or ''),)).fetchone()
        if not visit:
            return {'ok': False, 'error': 'not_found'}
        if not visit['signed_out']:
            self.sign_out(visit, 'Admin')
        return {'ok': True}

    def add_badge(self, badge=None, tag=None):
        no = re.sub(r'[^A-Za-z0-9.\-]', '', clean(badge))[:20]
        if not no:
            nums = [int(m.group(1)) for (b,) in self.db.execute('SELECT badge FROM badges')
                    for m in [re.match(r'^V(\d+)$', b, re.I)] if m]
            no = f'V{max(nums, default=0) + 1}'
        if self.db.execute('SELECT 1 FROM badges WHERE badge = ?', (no,)).fetchone():
            return {'ok': False, 'error': 'badge_exists', 'badge': no}
        t = normalize_tag(tag)
        moved = self.unlink_tag(t) if t else ''
        self.db.execute("INSERT INTO badges (badge, tag, status, added) VALUES (?, ?, 'available', ?)", (no, t, now_iso()))
        return {'ok': True, 'badge': no, 'movedFrom': moved}

    def link_tag(self, badge, tag):
        b = self.db.execute('SELECT * FROM badges WHERE badge = ?', (str(badge or ''),)).fetchone()
        if not b:
            return {'ok': False, 'error': 'not_found'}
        t = normalize_tag(tag)
        if not t:
            return {'ok': False, 'error': 'tag'}
        moved = self.unlink_tag(t)
        self.db.execute('UPDATE badges SET tag = ? WHERE badge = ?', (t, b['badge']))
        return {'ok': True, 'movedFrom': '' if moved == b['badge'] else moved}

    def unlink_tag(self, tag):
        existing = self.badge_by_tag(tag)
        if not existing:
            return ''
        self.db.execute("UPDATE badges SET tag = '' WHERE badge = ?", (existing['badge'],))
        return existing['badge']

    def retire_badge(self, badge, retire):
        b = self.db.execute('SELECT * FROM badges WHERE badge = ?', (str(badge or ''),)).fetchone()
        if not b:
            return {'ok': False, 'error': 'not_found'}
        if retire and b['status'] == 'in use':
            return {'ok': False, 'error': 'badge_in_use'}
        self.db.execute('UPDATE badges SET status = ? WHERE badge = ?', ('retired' if retire else 'available', b['badge']))
        return {'ok': True}

    def admin_status(self):
        count = lambda t: self.db.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]  # noqa: E731 (fixed table names)
        stored = self.setting('admin_pin')
        backup = json.loads(self.setting('last_backup') or '{}')
        return {
            'ok': True, 'backend': 'pi',
            'sheetName': f'Raspberry Pi ({os.uname().nodename})',
            'sheetUrl': self.dashboard_url, 'storage': self.data_dir,
            'counts': {'visitors': count('visitors'), 'visits': count('visits'), 'badges': count('badges')},
            'pinChangedAt': json.loads(stored)['at'] if stored else '',
            'pinSource': 'settings' if stored else 'none',
            'backup': backup, 'serverTime': now_iso(),
        }


def parse_iso(s):
    return datetime.strptime(s[:19], '%Y-%m-%dT%H:%M:%S').replace(tzinfo=timezone.utc)
