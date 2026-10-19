import functools
import inspect
import os
import subprocess
import threading
import unittest
import urllib.error
import urllib.request
from html.parser import HTMLParser

from helpers import ROOT, TempDirTest, minimal
from reviewkit import build, cli, edit, markdown, model, safety, serve, validate


class Tags(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.tags = []
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        self.tags.append((tag, dict(attrs)))


class ContentSecurityTest(unittest.TestCase):
    def test_sanitizes_active_html_in_both_formats(self):
        payload = ('<script>alert(1)</script><svg><a href="javascript:alert(1)">bad</a></svg>'
                   '<img src="https://example.com/track" onerror="alert(1)">'
                   '<iframe srcdoc="<script>alert(1)</script>"></iframe>'
                   '<span style="background:url(https://example.com/track)" onclick="alert(1)" '
                   'id="app" class="tag P0">safe</span>'
                   '<a href="java&#x09;script:alert(1)">bad</a>'
                   '<table><tr><td colspan="2">cell</td></tr></table>')
        for fmt in ('html', 'markdown'):
            with self.subTest(fmt=fmt):
                out = markdown.to_html(payload, fmt)
                tags = Tags(out).tags
                self.assertTrue(all(tag in markdown._Sanitizer.TAGS for tag, _ in tags))
                self.assertTrue(all(not name.startswith('on') and name not in ('style', 'id', 'srcdoc')
                                    for _, attrs in tags for name in attrs))
                self.assertTrue(all(attrs.get('href', '#') == '#' for _, attrs in tags))
                self.assertIn('<span class="tag P0">safe</span>', out)
                self.assertIn('<td colspan="2">cell</td>', out)

    def test_url_schemes_and_credentials(self):
        for value in ('javascript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,bad',
                      'vbscript:bad', 'file:///etc/passwd', '//example.com/x',
                      'https://user:password@example.com/', 'https://[broken', '\\example.com'):
            with self.subTest(value=value):
                self.assertEqual(safety.safe_url(value), '#')
        for value in ('https://example.com/a?q=1', 'mailto:hello@example.com', '#section', 'files/notes.md'):
            self.assertEqual(safety.safe_url(value), value)

    def test_markdown_handles_untrusted_placeholder_characters(self):
        self.assertEqual(markdown.render('\x000\x00 **ok**'), '0 <b>ok</b>')

    def test_local_preview_is_default(self):
        self.assertEqual(inspect.signature(serve.serve).parameters['host'].default, '127.0.0.1')
        self.assertEqual(cli.parser().parse_args(['serve']).host, '127.0.0.1')


class PublicationSecurityTest(TempDirTest):
    def test_validation_rejects_external_and_sensitive_attachments_even_without_file_checks(self):
        for href in ('../private.txt', '.env', 'credentials.json', 'state.json', 'key.pem', 'payload.html',
                     'javascript:alert(1)', 'data:text/html,bad'):
            for section in ('project', 'fix'):
                with self.subTest(href=href, section=section):
                    data = minimal()
                    links = [{'label': 'attachment', 'href': href}]
                    if section == 'project':
                        data['project']['links'] = links
                    else:
                        data['fixes'] = [{'id': 'f', 'title': 'fix', 'links': links}]
                    self.assertTrue(validate.validate(data, self.tmp, check_files=False)[0])

    def test_repo_paths_and_active_commit_links_are_rejected(self):
        data = minimal()
        data['project']['repo'] = '/Users/private/project'
        self.assertTrue(validate.validate(data, self.tmp)[0])
        data['project'].pop('repo')
        data['fixes'] = [{'id': 'f', 'title': 'fix', 'commits': [{'sha': 'abc', 'url': 'javascript:alert(1)'}]}]
        self.assertTrue(validate.validate(data, self.tmp)[0])

    def test_external_symlinks_cannot_be_published(self):
        review = self.copy_demo()
        base = os.path.dirname(review)
        external = os.path.join(self.tmp, 'private.txt')
        with open(external, 'w') as f:
            f.write('SYNTHETIC_PRIVATE_VALUE')
        os.symlink(external, os.path.join(base, 'notes-link.txt'))
        data = model.load(review)
        data['project']['links'] = [{'label': 'notes', 'href': 'notes-link.txt'}]
        model.save(review, data)
        with self.assertRaisesRegex(model.ReviewError, 'inside the review folder'):
            build.build(review, os.path.join(self.tmp, 'site'), quiet=True)

    def test_existing_output_secrets_are_preserved_and_block_build(self):
        review = self.copy_demo()
        out = os.path.join(self.tmp, 'site')
        build.build(review, out, quiet=True)
        for name in ('.env', 'leftover.txt'):
            path = os.path.join(out, name)
            with open(path, 'w') as f:
                f.write('SYNTHETIC_PRIVATE_VALUE')
            with self.assertRaisesRegex(model.ReviewError, 'fresh output directory'):
                build.build(review, out, force=True, clean=True, quiet=True)
            self.assertTrue(os.path.isfile(path))
            os.remove(path)

    def test_output_symlink_does_not_modify_its_target(self):
        review = self.copy_demo()
        out = os.path.join(self.tmp, 'site')
        build.build(review, out, quiet=True)
        external = os.path.join(self.tmp, 'private.txt')
        with open(external, 'w') as f:
            f.write('SYNTHETIC_PRIVATE_VALUE')
        os.remove(os.path.join(out, 'data.js'))
        os.symlink(external, os.path.join(out, 'data.js'))
        with self.assertRaisesRegex(model.ReviewError, 'symlink'):
            build.build(review, out, quiet=True)
        with open(external) as f:
            self.assertEqual(f.read(), 'SYNTHETIC_PRIVATE_VALUE')

    def test_absolute_screenshots_still_import_explicitly(self):
        review_dir = os.path.join(self.tmp, 'review')
        review = edit.init(review_dir, 'Test')
        data = model.load(review)
        shot = self.png('outside/shot.png')
        edit.upsert_issue(data, {'title': 'shot', 'screenshots': [shot]}, review_dir)
        model.save(review, data)
        build.build(review, os.path.join(self.tmp, 'site'), quiet=True)
        self.assertEqual(data['issues'][0]['screenshots'], ['screenshots/issues/shot.png'])

    def test_server_blocks_secrets_symlinks_and_unlisted_files_for_get_and_head(self):
        review = self.copy_demo()
        out = os.path.join(self.tmp, 'site')
        build.build(review, out, quiet=True)
        external = os.path.join(self.tmp, 'private.txt')
        with open(external, 'w') as f:
            f.write('SYNTHETIC_PRIVATE_VALUE')
        for name in ('.env', 'leftover.txt', 'credentials.json'):
            with open(os.path.join(out, name), 'w') as f:
                f.write('SYNTHETIC_PRIVATE_VALUE')
        os.symlink(external, os.path.join(out, 'private-link.txt'))
        os.makedirs(os.path.join(out, 'folder'))
        httpd = serve.http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(serve._Handler, directory=out))
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        base = 'http://127.0.0.1:' + str(httpd.server_address[1])
        try:
            for path in ('/.env', '/%2eenv', '/credentials.json', '/leftover.txt', '/private-link.txt',
                         '/folder/', '/img/', '/%2e%2e/private.txt', '/' + build.MARKER):
                for method in ('GET', 'HEAD'):
                    with self.subTest(path=path, method=method):
                        with self.assertRaises(urllib.error.HTTPError) as raised:
                            urllib.request.urlopen(urllib.request.Request(base + path, method=method))
                        self.assertEqual(raised.exception.code, 404)
            for path in ('/', '/data.js', '/files/notes.md', '/img/screenshots/mobile-save-before.png'):
                with urllib.request.urlopen(base + path) as response:
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.headers['X-Content-Type-Options'], 'nosniff')
                    self.assertEqual(response.headers['Referrer-Policy'], 'no-referrer')
                    self.assertIn("connect-src 'none'", response.headers['Content-Security-Policy'])
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join()

    def test_repository_and_scaffold_ignore_secrets(self):
        names = ['.env', '.env.local', 'private.pem', 'state.json', 'playwright/.auth/session.json']
        probe = subprocess.run(['git', 'check-ignore', '--no-index', '--stdin'], cwd=ROOT,
                               input='\n'.join(names) + '\n', text=True, capture_output=True, check=True)
        self.assertEqual(probe.stdout.splitlines(), names)
        review = edit.init(os.path.join(self.tmp, 'review'), 'Test')
        with open(os.path.join(os.path.dirname(review), '.gitignore')) as f:
            ignored = f.read()
        for name in ('.env', 'state.json', '*.pem', '.auth/'):
            self.assertIn(name, ignored)

    def test_new_reviews_do_not_store_installation_paths(self):
        review = edit.init(os.path.join(self.tmp, 'review'), 'Test')
        data = model.load(review)
        self.assertEqual(data['$schema'], model.SCHEMA_URL)
        self.assertNotIn(self.tmp, model.dumps(data))


if __name__ == '__main__':
    unittest.main()
