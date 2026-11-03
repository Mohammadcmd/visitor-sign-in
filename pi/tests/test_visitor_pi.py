"""Tests for the Raspberry Pi server. Run from pi/:  python3 -m unittest discover -s tests"""
import base64
import json
import os
import sqlite3
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from visitor_pi.backup import run_backup  # noqa: E402
from visitor_pi.nfc import TapDetector  # noqa: E402
from visitor_pi.server import make_handler  # noqa: E402
from visitor_pi.store import Store  # noqa: E402

PHOTO = 'data:image/jpeg;base64,' + base64.b64encode(b'fake jpeg').decode()
DESCRIPTOR = [((i * 7) % 13) / 13 for i in range(128)]
DANA = {'first': '=Dana', 'last': 'Lee', 'company': 'Acme Aerospace', 'visiting': 'Mike', 'purpose': 'Audit',
        'citizenship': 'Not a U.S. citizen or permanent resident', 'country': 'Canada', 'agreed': True,
        'quickEntry': True, 'photo': PHOTO, 'descriptor': DESCRIPTOR}


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.s = Store(self.dir)
        self.s.set_pin('246810')
        self.token = self.api('adminLogin', pin='246810')['token']

    def api(self, action, rid=None, **args):
        req = {'key': self.s.kiosk_key, 'action': action, 'args': args}
        if rid:
            req['rid'] = rid
        return self.s.handle(req)

    def test_kiosk_key_required(self):
        self.assertEqual(self.s.handle({'key': 'nope', 'action': 'ping'})['error'], 'kiosk_key')

    def test_full_visit(self):
        t = self.token
        self.assertEqual(self.api('adminLogin', pin='000000')['error'], 'pin')
        self.assertEqual(self.api('adminAddBadge', token='bad')['error'], 'admin')
        self.assertEqual(self.api('adminAddBadge', token=t, tag='04aa11bb')['badge'], 'V1')
        self.assertEqual(self.api('adminAddBadge', token=t, tag='04CC22DD04CC22DD')['badge'], 'V2')  # doubled read
        self.assertEqual(self.api('adminAddBadge', token=t)['badge'], 'V3')
        self.assertEqual(self.api('adminLinkTag', token=t, badge='V3', tag='04AA11BB')['movedFrom'], 'V1')

        self.assertEqual(self.api('register', first='Dana')['error'], 'missing')
        reg = self.api('register', **DANA)
        self.assertTrue(reg['ok'])
        vid = reg['visitor']['id']
        self.assertEqual(reg['visitor']['first'], '=Dana')  # stored as typed; CSV export guards formulas
        self.assertEqual(len(self.api('faceIndex')['people'][0]['descriptors']), 1)
        photos = os.listdir(os.path.join(self.dir, 'photos', vid))
        self.assertEqual(len(photos), 1)

        self.assertEqual(self.api('assignBadge', visitorId=vid, tag='unknown1')['error'], 'badge_unknown')
        self.assertEqual(self.api('assignBadge', visitorId=vid, tag='04AA11BB', method='new visitor')['badge'], 'V3')
        self.assertEqual(self.api('adminInside', token=t)['inside'][0]['kind'], 'Foreign national')
        self.assertEqual(self.api('adminRetireBadge', token=t, badge='V3')['error'], 'badge_in_use')

        sam = self.api('register', first='Sam', last='Ortiz', company='N/A', visiting='Mike', purpose='Interview',
                       citizenship='U.S. citizen', agreed=True, quickEntry=False, photo=PHOTO)['visitor']
        self.assertEqual(self.api('assignBadge', visitorId=sam['id'], tag='04AA11BB')['error'], 'badge_in_use')
        self.assertEqual(len(self.api('faceIndex')['people']), 1)

        out = self.api('tapAtWelcome', tag='04aa11bb')
        self.assertEqual((out['result'], out['first']), ('signed_out', '=Dana'))
        self.assertEqual(self.api('tapAtWelcome', tag='04AA11BB')['result'], 'not_out')
        self.assertTrue(self.api('undoSignOut', visitId=out['visitId'])['ok'])
        self.assertEqual(len(self.api('adminInside', token=t)['inside']), 1)

        # The Pi's own reader signs out the same way.
        pi = self.s.tap_badge('04AA11BB', 'Badge tap at the Pi reader')
        self.assertEqual(pi['result'], 'signed_out')
        self.assertEqual(len(self.api('adminInside', token=t)['inside']), 0)
        self.assertEqual(next(b for b in self.api('adminBadges', token=t)['badges'] if b['badge'] == 'V3')['status'], 'available')

    def test_returning_visitors_and_quick_entry(self):
        vid = self.api('register', **DANA)['visitor']['id']
        self.assertEqual(self.api('findVisitor', first='Dana')['error'], 'fullname')
        # Punctuation is ignored, so "=Dana" is found by "dana"; company narrows it.
        self.assertEqual(self.api('findVisitor', first='dana', last='LEE', company='acme')['matches'][0]['id'], vid)
        vid2 = self.api('register', **dict(DANA, first='Dana', company='Northwind'))['visitor']['id']
        self.assertEqual([m['id'] for m in self.api('findVisitor', first='Dana', last='Lee', company='Northwind')['matches']], [vid2])
        self.assertEqual(len(self.api('findVisitor', first='Dana', last='Lee', company='Boeing')['matches']), 0)
        self.assertTrue(self.api('addFaceSample', visitorId=vid, photo=PHOTO, descriptor=DESCRIPTOR)['saved'])
        self.assertTrue(self.api('setQuickEntry', visitorId=vid, on=False)['ok'])
        self.assertFalse(self.api('addFaceSample', visitorId=vid, photo=PHOTO, descriptor=DESCRIPTOR)['saved'])
        self.assertEqual([p['id'] for p in self.api('faceIndex')['people']], [vid2])  # vid opted out

    def test_replayed_write_is_not_applied_twice(self):
        args = dict(DANA, first='Ana', quickEntry=False)
        first = self.api('register', rid='abc123-retry', **args)
        again = self.api('register', rid='abc123-retry', **args)
        self.assertEqual(first['visitor']['id'], again['visitor']['id'])
        self.assertEqual(self.s.db.execute('SELECT COUNT(*) FROM visitors').fetchone()[0], 1)

    def test_pin_change_and_status(self):
        st = self.api('adminStatus', token=self.token)
        self.assertEqual((st['backend'], st['pinSource']), ('pi', 'settings'))
        self.assertEqual(self.api('adminSetPin', token=self.token, pin='12a')['error'], 'pin_format')
        self.assertTrue(self.api('adminSetPin', token=self.token, pin='13579135')['ok'])
        self.assertNotIn('13579135', self.s.setting('admin_pin'))
        self.assertEqual(self.api('adminLogin', pin='246810')['error'], 'pin')
        self.assertTrue(self.api('adminLogin', pin='13579135')['ok'])


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp()
        cls.backup = tempfile.mkdtemp()
        open(os.path.join(cls.backup, '.visitor-pi-backup-target'), 'w').close()
        cls.s = Store(cls.dir)
        cls.s.set_pin('246810')
        cls.httpd = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(cls.s, {'backup_dir': cls.backup}, lambda m: None))
        cls.base = f'http://127.0.0.1:{cls.httpd.server_port}'
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def call(self, path, body=None, cookie=None, method=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method or ('POST' if data else 'GET'))
        req.add_header('Content-Type', 'text/plain;charset=utf-8')
        if cookie:
            req.add_header('Cookie', cookie)
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, r.headers, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()

    def api(self, action, **args):
        return json.loads(self.call('/api', {'key': self.s.kiosk_key, 'action': action, 'args': args})[2])

    def login(self):
        status, headers, _ = self.call('/dash/login', {'pin': '246810'})
        self.assertEqual(status, 200)
        return headers['Set-Cookie'].split(';')[0]

    def test_kiosk_api_with_cors(self):
        status, headers, body = self.call('/api', {'key': self.s.kiosk_key, 'action': 'ping'})
        self.assertEqual(status, 200)
        self.assertEqual(headers['Access-Control-Allow-Origin'], '*')
        self.assertTrue(json.loads(body)['ok'])
        self.assertEqual(self.call('/api', method='OPTIONS')[0], 204)

    def test_dashboard_needs_pin(self):
        self.assertEqual(self.call('/dash/summary')[0], 401)
        self.assertEqual(self.call('/dash/visitors.csv')[0], 401)
        self.assertIn(b'Visitor records', self.call('/')[2])

    def test_dashboard_data_csv_photos_and_backup(self):
        token = self.api('adminLogin', pin='246810')['token']
        self.api('adminAddBadge', token=token, tag='AABBCCDD')
        vid = self.api('register', **DANA)['visitor']['id']
        self.api('assignBadge', visitorId=vid, tag='AABBCCDD')
        cookie = self.login()

        summary = json.loads(self.call('/dash/summary', cookie=cookie)[2])
        self.assertEqual(len(summary['inside']), 1)
        visitors = json.loads(self.call('/dash/visitors', cookie=cookie)[2])['visitors']
        self.assertTrue(visitors[0]['photo'].startswith('/dash/photo/'))
        status, headers, img = self.call(visitors[0]['photo'], cookie=cookie)
        self.assertEqual((status, headers['Content-Type'], img), (200, 'image/jpeg', b'fake jpeg'))
        self.assertEqual(self.call('/dash/photo/../visitors.db', cookie=cookie)[0], 404)

        status, headers, csv_body = self.call('/dash/visitors.csv', cookie=cookie)
        self.assertIn('attachment', headers['Content-Disposition'])
        self.assertIn("'=Dana", csv_body.decode('utf-8-sig'))  # formula guarded for Excel

        visit_id = summary['inside'][0]['visitId']
        self.assertTrue(json.loads(self.call('/dash/signout', {'visitId': visit_id}, cookie)[2])['ok'])
        self.assertTrue(json.loads(self.call('/dash/undo', {'visitId': visit_id}, cookie)[2])['ok'])

        res = json.loads(self.call('/dash/backup', {}, cookie)[2])
        self.assertTrue(res['ok'], res)
        snap = os.path.join(self.backup, 'database', res['database'])
        self.assertEqual(sqlite3.connect(snap).execute('SELECT COUNT(*) FROM visitors').fetchone()[0], 1)
        self.assertTrue(os.listdir(os.path.join(self.backup, 'photos', vid)))


class BackupTest(unittest.TestCase):
    def test_missing_folder_is_reported(self):
        s = Store(tempfile.mkdtemp())
        res = run_backup(s, '/no/such/folder')
        self.assertFalse(res['ok'])
        self.assertIn('not there', res['error'])
        self.assertIn('not there', json.loads(s.setting('last_backup'))['error'])

    def test_unmounted_folder_is_refused(self):
        s = Store(tempfile.mkdtemp())
        res = run_backup(s, tempfile.mkdtemp())
        self.assertFalse(res['ok'])
        self.assertIn('not mounted', res['error'])


class TapDetectorTest(unittest.TestCase):
    def feed(self, text, gap, enter_after):
        d, t = TapDetector(), 100.0
        for ch in text:
            d.key(ch, t)
            t += gap
        return d.enter(t - gap + enter_after)

    def test_fast_burst_is_a_tap(self):
        self.assertEqual(self.feed('7475BB53', 0.008, 0.01), '7475BB53')

    def test_people_typing_is_not(self):
        self.assertIsNone(self.feed('7475BB53', 0.15, 0.1))
        self.assertIsNone(self.feed('7475BB53', 0.008, 0.4))  # Enter long after
        self.assertIsNone(self.feed('123', 0.008, 0.01))      # too short


if __name__ == '__main__':
    unittest.main()
