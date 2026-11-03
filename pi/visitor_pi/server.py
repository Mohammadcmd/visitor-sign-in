"""The Pi's web server, on the local network only.

  POST /api              the kiosk app (see web/js/api.js)
  GET  /                 the records dashboard for office computers (admin PIN)
  /dash/...              the dashboard's data, actions, CSV downloads and photos
"""
import csv
import io
import json
import os
import re
from datetime import datetime, timedelta, timezone
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from .backup import run_backup

STATIC = os.path.join(os.path.dirname(__file__), 'static')
MAX_BODY = 6 * 1024 * 1024
SESSION = 'visitor_pi_session'
STATIC_TYPES = {'.html': 'text/html; charset=utf-8', '.png': 'image/png', '.js': 'text/javascript',
                '.css': 'text/css', '.svg': 'image/svg+xml'}


def csv_cell(v):
    """Cells starting with = + - @ would run as formulas in Excel; prefix them."""
    s = '' if v is None else str(v)
    return "'" + s if s[:1] in ('=', '+', '-', '@') else s


def to_csv(header, rows):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(header)
    for r in rows:
        w.writerow([csv_cell(x) for x in r])
    return buf.getvalue().encode('utf-8-sig')  # BOM so Excel reads accents correctly


def make_handler(store, config, log):
    backup_dir = config.get('backup_dir', '')

    class Handler(BaseHTTPRequestHandler):
        server_version = 'VisitorPi'

        def log_message(self, fmt, *args):  # quieter than the default access log
            pass

        # ---------------------------------------------------- plumbing

        def send(self, code, body=b'', ctype='application/json', headers=None):
            if isinstance(body, (dict, list)):
                body = json.dumps(body).encode()
            elif isinstance(body, str):
                body = body.encode()
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('X-Content-Type-Options', 'nosniff')
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def cors(self):
            # The kiosk app runs from its own origin inside the tablet; the kiosk key guards /api.
            return {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type'}

        def body_json(self):
            n = int(self.headers.get('Content-Length') or 0)
            if n > MAX_BODY:
                raise ValueError('too large')
            return json.loads(self.rfile.read(n) or b'{}')

        def token(self):
            c = cookies.SimpleCookie(self.headers.get('Cookie') or '')
            return c[SESSION].value if SESSION in c else None

        def authed(self):
            return store.check_admin(self.token())

        def note_url(self):
            host = self.headers.get('Host')
            if host:
                store.dashboard_url = f'http://{host}/'

        # ---------------------------------------------------- routes

        def do_OPTIONS(self):
            self.send(204, b'', 'text/plain', self.cors())

        def do_POST(self):
            path = urlparse(self.path).path
            self.note_url()
            try:
                req = self.body_json()
            except ValueError:
                return self.send(400, {'ok': False, 'error': 'bad_request'}, headers=self.cors())

            if path == '/api':
                try:
                    out = store.handle(req)
                except Exception as err:  # one bad call must never take the server down
                    log(f"Error in {req.get('action') if isinstance(req, dict) else '?'}: {err!r}")
                    out = {'ok': False, 'error': 'server'}
                return self.send(200, out, headers=self.cors())

            if path == '/dash/login':
                with store.lock:
                    res = store.admin_login(req.get('pin'))
                if not res.get('ok'):
                    return self.send(200, res)
                cookie = f"{SESSION}={res['token']}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200"
                return self.send(200, {'ok': True}, headers={'Set-Cookie': cookie})
            if path == '/dash/logout':
                store.tokens.pop(self.token(), None)
                return self.send(200, {'ok': True}, headers={'Set-Cookie': f'{SESSION}=; Path=/; Max-Age=0'})

            if not self.authed():
                return self.send(401, {'ok': False, 'error': 'admin'})
            with store.lock:
                if path == '/dash/signout':
                    return self.send(200, store.admin_sign_out(req.get('visitId')))
                if path == '/dash/undo':
                    # From the dashboard, a sign-out can be undone for 30 minutes (a mistaken tap at the Pi).
                    return self.send(200, store.undo_sign_out(req.get('visitId'), window=30 * 60))
            if path == '/dash/backup':
                return self.send(200, run_backup(store, backup_dir))
            return self.send(404, {'ok': False, 'error': 'not_found'})

        def do_GET(self):
            url = urlparse(self.path)
            path, q = url.path, {k: v[0] for k, v in parse_qs(url.query).items()}
            self.note_url()
            if path in ('/', '/index.html'):
                return self.static('dashboard.html')
            if path.startswith('/static/'):
                return self.static(path[len('/static/'):])
            if path == '/health':
                return self.send(200, {'ok': True})
            if not path.startswith('/dash/'):
                return self.send(404, 'Not found', 'text/plain')
            if not self.authed():
                return self.send(401, {'ok': False, 'error': 'admin'})
            with store.lock:
                if path == '/dash/summary':
                    return self.send(200, self.summary())
                if path == '/dash/visits':
                    return self.send(200, {'ok': True, 'visits': self.visits(q)})
                if path == '/dash/visitors':
                    return self.send(200, {'ok': True, 'visitors': self.visitors(q)})
                if path == '/dash/badges':
                    return self.send(200, store.admin_badges())
                if path == '/dash/visits.csv':
                    return self.csv_visits(q)
                if path == '/dash/visitors.csv':
                    return self.csv_visitors()
                if path.startswith('/dash/photo/'):
                    return self.photo(path[len('/dash/photo/'):])
            return self.send(404, {'ok': False, 'error': 'not_found'})

        # ---------------------------------------------------- dashboard data

        def summary(self):
            s = store.admin_status()
            inside = store.admin_inside()['inside']
            since = (datetime.now(timezone.utc) - timedelta(minutes=30)).strftime('%Y-%m-%dT%H:%M:%S')
            recent = [dict(r) for r in store.db.execute(
                'SELECT id, first, last, company, badge, signed_out, signed_out_by FROM visits '
                'WHERE signed_out >= ? ORDER BY signed_out DESC', (since,))]
            day_ago = (datetime.now(timezone.utc) - timedelta(hours=24)).strftime('%Y-%m-%dT%H:%M:%S')
            last_day = store.db.execute('SELECT COUNT(*) FROM visits WHERE signed_in >= ?', (day_ago,)).fetchone()[0]
            return {'ok': True, 'status': s, 'inside': inside, 'recent': recent,
                    'visits24h': last_day, 'backupDir': backup_dir}

        def visits(self, q):
            sql, args = 'SELECT * FROM visits WHERE 1=1', []
            if q.get('from'):
                sql += ' AND signed_in >= ?'
                args.append(q['from'])
            if q.get('to'):
                sql += ' AND signed_in < ?'
                args.append(q['to'] + 'T99')
            if q.get('q'):
                sql += " AND (first || ' ' || last || ' ' || company || ' ' || visiting) LIKE ?"
                args.append('%' + q['q'] + '%')
            sql += ' ORDER BY signed_in DESC LIMIT 1000'
            return [dict(r) for r in store.db.execute(sql, args)]

        def visitors(self, q):
            sql, args = 'SELECT * FROM visitors', []
            if q.get('q'):
                sql += " WHERE (first || ' ' || last || ' ' || company) LIKE ?"
                args.append('%' + q['q'] + '%')
            sql += ' ORDER BY last_visit DESC LIMIT 1000'
            out = []
            for r in store.db.execute(sql, args):
                v = dict(r)
                photo = store.db.execute('SELECT file FROM photos WHERE visitor_id = ? ORDER BY id DESC LIMIT 1',
                                         (r['id'],)).fetchone()
                v['photo'] = f"/dash/photo/{photo['file']}" if photo else ''
                v['photoCount'] = store.db.execute('SELECT COUNT(*) FROM photos WHERE visitor_id = ?', (r['id'],)).fetchone()[0]
                out.append(v)
            return out

        def csv_visits(self, q):
            rows = self.visits(q)
            body = to_csv(['Signed in', 'Signed out', 'First Name', 'Last Name', 'Company', 'Visiting', 'Purpose',
                           'Kind', 'Badge', 'How they signed in', 'Signed out by', 'Visitor ID', 'Visit ID'],
                          [[r['signed_in'], r['signed_out'], r['first'], r['last'], r['company'], r['visiting'],
                            r['purpose'], r['kind'], r['badge'], r['method'], r['signed_out_by'], r['visitor_id'], r['id']]
                           for r in rows])
            return self.download(body, f"visits-{datetime.now().strftime('%Y-%m-%d')}.csv")

        def csv_visitors(self):
            rows = store.db.execute('SELECT * FROM visitors ORDER BY last, first')
            body = to_csv(['First Name', 'Last Name', 'Company', 'Who are you visiting at Shock Tech?',
                           'Purpose of your visit', 'Citizenship status', 'Country of citizenship',
                           'Visitor acknowledgment', 'Quick entry', 'Registered', 'Last visit', 'Visit count', 'Visitor ID'],
                          [[r['first'], r['last'], r['company'], r['visiting'], r['purpose'], r['citizenship'], r['country'],
                            r['acknowledgment'], 'Yes' if r['quick_entry'] else 'No', r['registered'], r['last_visit'],
                            r['visit_count'], r['id']] for r in rows])
            return self.download(body, f"visitors-{datetime.now().strftime('%Y-%m-%d')}.csv")

        def download(self, body, name):
            self.send(200, body, 'text/csv; charset=utf-8', {'Content-Disposition': f'attachment; filename="{name}"'})

        def photo(self, rel):
            # Only <visitor id>/<file name>, never anything outside the photo folder.
            if not re.match(r'^P[A-Z0-9]{8}/[^/\\]+\.(jpg|png|webp)$', rel or ''):
                return self.send(404, {'ok': False, 'error': 'not_found'})
            full = os.path.realpath(os.path.join(store.photo_dir, rel))
            if not full.startswith(os.path.realpath(store.photo_dir) + os.sep) or not os.path.isfile(full):
                return self.send(404, {'ok': False, 'error': 'not_found'})
            with open(full, 'rb') as f:
                ext = rel.rsplit('.', 1)[1]
                self.send(200, f.read(), 'image/jpeg' if ext == 'jpg' else f'image/{ext}',
                          {'Cache-Control': 'private, max-age=86400'})

        def static(self, name):
            if not re.match(r'^[\w.-]+$', name):
                return self.send(404, 'Not found', 'text/plain')
            full = os.path.join(STATIC, name)
            if not os.path.isfile(full):
                return self.send(404, 'Not found', 'text/plain')
            with open(full, 'rb') as f:
                self.send(200, f.read(), STATIC_TYPES.get(os.path.splitext(name)[1], 'application/octet-stream'))

    return Handler


def serve(store, config, log):
    port = int(config.get('port', 8080))
    httpd = ThreadingHTTPServer((config.get('host', '0.0.0.0'), port), make_handler(store, config, log))
    log(f'Visitor Pi listening on port {port}')
    httpd.serve_forever()
