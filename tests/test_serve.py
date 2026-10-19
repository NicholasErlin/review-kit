import functools
import http.client
import os
import threading
from unittest import mock
import re
import subprocess
import sys
import time
import unittest
import urllib.request

from helpers import ROOT, TempDirTest

from reviewkit import build, serve


class ServeTest(TempDirTest):
    def test_serves_built_site_with_no_cache(self):
        review = self.copy_demo()
        out = os.path.join(self.tmp, 'site')
        build.build(review, out, quiet=True)
        p = subprocess.Popen([sys.executable, os.path.join(ROOT, 'bin', 'review-kit'), 'serve', out, '--port', '0', '--host', '127.0.0.1'],
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        try:
            url, deadline = None, time.time() + 10
            while url is None and time.time() < deadline:
                m = re.search(r'local:\s+(\S+)', p.stdout.readline())
                if m:
                    url = m.group(1)
            self.assertIsNotNone(url)
            with urllib.request.urlopen(url) as r:
                self.assertEqual(r.status, 200)
                self.assertEqual(r.headers['Cache-Control'], 'no-cache')
                self.assertIn(b'Acme Notes UX review', r.read())
            with urllib.request.urlopen(url + 'data.js') as r:
                self.assertTrue(r.read().startswith(b'window.REVIEW = '))
        finally:
            p.terminate()
            p.wait(5)
            p.stdout.close()

    def test_serve_requires_built_site(self):
        from reviewkit.model import ReviewError
        with self.assertRaises(ReviewError):
            serve.serve(self.tmp, port=0)

    def test_loopback_server_rejects_foreign_host_headers(self):
        # regression: backend review issue-8 (DNS rebinding)
        review = self.copy_demo()
        out = os.path.join(self.tmp, 'site')
        build.build(review, out, quiet=True)
        httpd = serve.http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(serve._Handler, directory=out))
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        port = httpd.server_address[1]
        try:
            for host, status in (('evil.example', 403), (f'evil.example:{port}', 403), (f'localhost:{port}', 200),
                                 (f'127.0.0.1:{port}', 200), ('LOCALHOST', 200)):
                with self.subTest(host=host):
                    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
                    conn.putrequest('GET', '/data.js', skip_host=True)
                    conn.putheader('Host', host)
                    conn.endheaders()
                    r = conn.getresponse()
                    r.read()
                    conn.close()
                    self.assertEqual(r.status, status)
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join()

    def test_watch_survives_unexpected_build_errors_and_sees_deletions(self):
        # regression: backend review issue-9
        review = self.copy_demo()
        with mock.patch.object(serve.builder, 'build', side_effect=OSError('disk went away')):
            self.assertFalse(serve._rebuild(review, os.path.join(self.tmp, 'site'), None))
        before = serve._snapshot(review)
        shots = os.path.join(os.path.dirname(review), 'screenshots')
        victim = sorted(os.listdir(shots))[-1]
        os.remove(os.path.join(shots, victim))
        self.assertNotEqual(serve._snapshot(review), before)

    def test_tailscale_range(self):
        self.assertTrue(serve._tailscale('100.64.0.1'))
        self.assertFalse(serve._tailscale('100.128.0.1'))
        self.assertFalse(serve._tailscale('192.168.0.10'))


if __name__ == '__main__':
    unittest.main()
