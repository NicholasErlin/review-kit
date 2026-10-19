import json
import os
import re
import unittest

from helpers import TempDirTest, minimal, read

from reviewkit import build, images, markdown
from reviewkit.model import ReviewError


def read_data(out):
    with open(os.path.join(out, 'data.js'), encoding='utf-8') as f:
        s = f.read()
    assert s.startswith('window.REVIEW = ')
    return json.loads(s[len('window.REVIEW = '):].rstrip().rstrip(';'))


class BuildTest(TempDirTest):
    def test_builds_demo(self):
        review = self.copy_demo()
        out = os.path.join(self.tmp, 'site')
        stats = build.build(review, out, quiet=True)
        self.assertEqual((stats['issues'], stats['fixes'], stats['pairs'], stats['plan_items']), (8, 2, 2, 5))
        for n in ('index.html', 'app.js', 'app.css', 'data.js', build.MARKER):
            self.assertTrue(os.path.isfile(os.path.join(out, n)), n)
        html = read(os.path.join(out, 'index.html'))
        self.assertIn('<title>Acme Notes UX review</title>', html)
        self.assertNotIn('__VER__', html)
        self.assertIn('content="#5b3df5"', html)
        ver = re.search(r'app\.js\?v=(\w+)', html).group(1)
        self.assertIn(f'data.js?v={ver}', html)
        d = read_data(out)
        self.assertEqual([p['id'] for p in d['platforms']], ['mobile', 'desktop'])
        self.assertEqual(d['platforms'][0]['shape'], 'portrait')
        self.assertEqual(d['platforms'][1]['shape'], 'landscape')  # auto-detected from image sizes
        fix1 = d['fixes'][0]
        pair = fix1['platforms']['mobile']['pairs'][0]
        self.assertRegex(pair['before']['src'], r'^img/screenshots/mobile-save-before\.png\?v=[0-9a-f]{10}$')
        self.assertEqual((pair['before']['w'], pair['before']['h']), (180, 360))
        self.assertIn('<b>under</b>', pair['before']['cap'])
        self.assertTrue(os.path.isfile(os.path.join(out, 'img/screenshots/mobile-save-before.png')))
        # derived back-links and markdown rendering
        m1 = next(i for i in d['issues'] if i['id'] == 'm-1')
        self.assertEqual(m1['fixes'], ['fix-1'])
        self.assertIn('<ul><li>Reproduce', m1['html'])
        self.assertIn('<code>src/editor/NoteForm.tsx:88</code>', m1['where'])
        # local links are copied into files/
        link = d['project']['links'][0]
        self.assertTrue(link['href'].startswith('files/notes.md?v='))
        self.assertTrue(os.path.isfile(os.path.join(out, 'files/notes.md')))

    def test_rebuild_prunes_unused_images_and_keeps_unchanged(self):
        review = self.copy_demo()
        out = os.path.join(self.tmp, 'site')
        build.build(review, out, quiet=True)
        stray = os.path.join(out, 'img', 'old.png')
        open(stray, 'w').close()
        stats = build.build(review, out, quiet=True)
        self.assertFalse(os.path.exists(stray))
        self.assertEqual(stats['assets']['copied'], 0)
        self.assertEqual(stats['assets']['kept'], 5)

    def test_refuses_foreign_or_source_dirs(self):
        review = self.copy_demo()
        foreign = os.path.join(self.tmp, 'mine')
        os.makedirs(foreign)
        open(os.path.join(foreign, 'keep.txt'), 'w').close()
        with self.assertRaises(ReviewError):
            build.build(review, foreign, quiet=True)
        with self.assertRaises(ReviewError):
            build.build(review, foreign, quiet=True, force=True)
        self.assertTrue(os.path.exists(os.path.join(foreign, 'keep.txt')))
        with self.assertRaises(ReviewError):
            build.build(review, os.path.dirname(review), quiet=True)

    def test_validation_failure_raises(self):
        d = minimal()
        d['issues'] = [{'id': 'a', 'title': 't', 'screenshots': ['nope.png']}]
        with self.assertRaises(ReviewError) as cm:
            build.build(self.write(d), os.path.join(self.tmp, 'site'), quiet=True)
        self.assertIn('image not found: nope.png', str(cm.exception))

    def test_single_platform_defaults_and_html_format(self):
        self.png('shots/a.png', 20, 10)
        d = minimal()
        d['project']['textFormat'] = 'html'
        d['issues'] = [{'id': 'x', 'title': 'T', 'details': '<b>raw *html*</b>', 'screenshots': ['shots/a.png']}]
        out = os.path.join(self.tmp, 'site')
        build.build(self.write(d), out, quiet=True)
        data = read_data(out)
        self.assertEqual(data['platforms'], [{'id': 'default', 'label': 'All', 'shape': 'landscape', 'desc': ''}])
        self.assertEqual(data['issues'][0]['platform'], 'default')
        self.assertEqual(data['issues'][0]['html'], '<b>raw *html*</b>')
        self.assertEqual(data['issues'][0]['status'], 'open')
        self.assertEqual([s['id'] for s in data['severities']], ['P0', 'P1', 'P2'])

    def test_images_outside_review_dir(self):
        outside = self.png('elsewhere/shot.png')
        os.makedirs(os.path.join(self.tmp, 'r'))
        d = minimal()
        d['issues'] = [{'id': 'x', 'title': 'T', 'screenshots': [os.path.relpath(outside, os.path.join(self.tmp, 'r'))]}]
        review = os.path.join(self.tmp, 'r', 'review.json')
        with open(review, 'w') as f:
            json.dump(d, f)
        out = os.path.join(self.tmp, 'site')
        with self.assertRaisesRegex(ReviewError, 'inside the review folder'):
            build.build(review, out, quiet=True)


class ImagesTest(TempDirTest):
    def test_png_size_and_fingerprint(self):
        p = self.png('a.png', 7, 3)
        self.assertEqual(images.size(p), (7, 3))
        self.assertEqual(len(images.fingerprint(p)), 10)

    def test_jpeg_gif_size(self):
        jpg = os.path.join(self.tmp, 'a.jpg')
        with open(jpg, 'wb') as f:  # SOI, APP0 (len 4), SOF0 with h=20 w=30
            f.write(b'\xff\xd8\xff\xe0\x00\x04ab\xff\xc0\x00\x11\x08\x00\x14\x00\x1e\x03' + b'\x00' * 12)
        self.assertEqual(images.size(jpg), (30, 20))
        gif = os.path.join(self.tmp, 'a.gif')
        with open(gif, 'wb') as f:
            f.write(b'GIF89a\x05\x00\x06\x00' + b'\x00' * 10)
        self.assertEqual(images.size(gif), (5, 6))

    def test_publish_without_resizer_copies(self):
        src = self.png('big.png', 50, 10)
        dst = os.path.join(self.tmp, 'out', 'big.png')
        self.assertEqual(images.publish(src, dst, max_width=10, tool=None), 'copied')
        self.assertEqual(images.size(dst), (50, 10))
        self.assertEqual(images.publish(src, dst, max_width=10, tool=None), 'kept')

    @unittest.skipUnless(images.resizer(), 'no sips/magick/convert available')
    def test_publish_downscales_when_tool_available(self):
        src = self.png('big.png', 64, 16)
        dst = os.path.join(self.tmp, 'out', 'big.png')
        self.assertEqual(images.publish(src, dst, max_width=32, tool=images.resizer()), 'resized')
        self.assertEqual(images.size(dst)[0], 32)


class MarkdownTest(unittest.TestCase):
    def test_inline(self):
        self.assertEqual(markdown.render('a **b** *c* `<d>` ~~e~~ [f](https://x.y)'),
                         'a <b>b</b> <em>c</em> <code>&lt;d&gt;</code> <s>e</s> <a href="https://x.y">f</a>')

    def test_escapes_but_keeps_tags_and_entities(self):
        self.assertEqual(markdown.render('1 < 2 & <b>ok</b> &amp; x'), '1 &lt; 2 &amp; <b>ok</b> &amp; x')

    def test_blocks(self):
        out = markdown.render('# Head\n\npara one\nline two\n\n- a\n- b\n\n1. x\n2. y\n\n```\n<raw>\n```')
        self.assertIn('<h3>Head</h3>', out)
        self.assertIn('<p>para one<br>line two</p>', out)
        self.assertIn('<ul><li>a</li><li>b</li></ul>', out)
        self.assertIn('<ol><li>x</li><li>y</li></ol>', out)
        self.assertIn('<pre><code>&lt;raw&gt;</code></pre>', out)

    def test_html_block_passthrough_and_js_urls(self):
        self.assertEqual(markdown.render('<table><tr><td>1</td></tr></table>'), '<table><tr><td>1</td></tr></table>')
        self.assertIn('href="#"', markdown.render('[x](javascript:alert(1))'))

    def test_identifiers_with_underscores_and_stars_in_code(self):
        self.assertEqual(markdown.render('use `a*b*c` and snake_case_name'), 'use <code>a*b*c</code> and snake_case_name')


if __name__ == '__main__':
    unittest.main()
