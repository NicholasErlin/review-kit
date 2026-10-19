import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { minimal, read, readBytes, withTmp } from './helpers.mjs';
import * as build from '../dist/build.js';
import * as images from '../dist/images.js';
import * as markdown from '../dist/markdown.js';
import { ReviewError } from '../dist/errors.js';

function readData(out) {
  const s = read(path.join(out, 'data.js'));
  assert.ok(s.startsWith('window.REVIEW = '));
  return JSON.parse(s.slice('window.REVIEW = '.length).trimEnd().replace(/;+$/, ''));
}

const isFile = (p) => fs.existsSync(p) && fs.statSync(p).isFile();

describe('BuildTest', () => {
  test('builds demo', withTmp(async (t) => {
    const review = t.copyDemo();
    const out = path.join(t.tmp, 'site');
    const stats = build.build(review, out, { quiet: true });
    assert.deepEqual([stats.issues, stats.fixes, stats.pairs, stats.plan_items], [8, 2, 2, 5]);
    for (const n of ['index.html', 'app.js', 'app.css', 'data.js', build.MARKER]) assert.ok(isFile(path.join(out, n)), n);
    const html = read(path.join(out, 'index.html'));
    assert.ok(html.includes('<title>Acme Notes UX review</title>'));
    assert.ok(!html.includes('__VER__'));
    assert.ok(html.includes('content="#5b3df5"'));
    const ver = /app\.js\?v=(\w+)/.exec(html)[1];
    assert.ok(html.includes(`data.js?v=${ver}`));
    const d = readData(out);
    assert.deepEqual(d.platforms.map((p) => p.id), ['mobile', 'desktop']);
    assert.equal(d.platforms[0].shape, 'portrait');
    assert.equal(d.platforms[1].shape, 'landscape'); // auto-detected from image sizes
    const fix1 = d.fixes[0];
    const pair = fix1.platforms.mobile.pairs[0];
    assert.match(pair.before.src, /^img\/screenshots\/mobile-save-before\.png\?v=[0-9a-f]{10}$/);
    assert.deepEqual([pair.before.w, pair.before.h], [180, 360]);
    assert.ok(pair.before.cap.includes('<b>under</b>'));
    assert.ok(isFile(path.join(out, 'img/screenshots/mobile-save-before.png')));
    // derived back-links and markdown rendering
    const m1 = d.issues.find((i) => i.id === 'm-1');
    assert.deepEqual(m1.fixes, ['fix-1']);
    assert.ok(m1.html.includes('<ul><li>Reproduce'));
    assert.ok(m1.where.includes('<code>src/editor/NoteForm.tsx:88</code>'));
    // local links are copied into files/
    const link = d.project.links[0];
    assert.ok(link.href.startsWith('files/notes.md?v='));
    assert.ok(isFile(path.join(out, 'files/notes.md')));
  }));

  test('rebuild prunes unused images and keeps unchanged', withTmp(async (t) => {
    const review = t.copyDemo();
    const out = path.join(t.tmp, 'site');
    build.build(review, out, { quiet: true });
    const stray = path.join(out, 'img', 'old.png');
    fs.writeFileSync(stray, '');
    const stats = build.build(review, out, { quiet: true });
    assert.ok(!fs.existsSync(stray));
    assert.equal(stats.assets.copied, 0);
    assert.equal(stats.assets.kept, 5);
  }));

  test('refuses foreign or source dirs', withTmp(async (t) => {
    const review = t.copyDemo();
    const foreign = path.join(t.tmp, 'mine');
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, 'keep.txt'), '');
    assert.throws(() => build.build(review, foreign, { quiet: true }), ReviewError);
    assert.throws(() => build.build(review, foreign, { quiet: true, force: true }), ReviewError);
    assert.ok(fs.existsSync(path.join(foreign, 'keep.txt')));
    assert.throws(() => build.build(review, path.dirname(review), { quiet: true }), ReviewError);
  }));

  test('validation failure raises', withTmp(async (t) => {
    const d = minimal();
    d.issues = [{ id: 'a', title: 't', screenshots: ['nope.png'] }];
    assert.throws(() => build.build(t.write(d), path.join(t.tmp, 'site'), { quiet: true }),
      (e) => e instanceof ReviewError && e.message.includes('image not found: nope.png'));
  }));

  test('single platform defaults and html format', withTmp(async (t) => {
    t.png('shots/a.png', 20, 10);
    const d = minimal();
    d.project.textFormat = 'html';
    d.issues = [{ id: 'x', title: 'T', details: '<b>raw *html*</b>', screenshots: ['shots/a.png'] }];
    const out = path.join(t.tmp, 'site');
    build.build(t.write(d), out, { quiet: true });
    const data = readData(out);
    assert.deepEqual(data.platforms, [{ id: 'default', label: 'All', shape: 'landscape', desc: '' }]);
    assert.equal(data.issues[0].platform, 'default');
    assert.equal(data.issues[0].html, '<b>raw *html*</b>');
    assert.equal(data.issues[0].status, 'open');
    assert.deepEqual(data.severities.map((s) => s.id), ['P0', 'P1', 'P2']);
  }));

  test('images outside review dir', withTmp(async (t) => {
    const outside = t.png('elsewhere/shot.png');
    fs.mkdirSync(path.join(t.tmp, 'r'));
    const d = minimal();
    d.issues = [{ id: 'x', title: 'T', screenshots: [path.relative(path.join(t.tmp, 'r'), outside)] }];
    const review = path.join(t.tmp, 'r', 'review.json');
    fs.writeFileSync(review, JSON.stringify(d));
    const out = path.join(t.tmp, 'site');
    assert.throws(() => build.build(review, out, { quiet: true }),
      (e) => e instanceof ReviewError && /inside the review folder/.test(e.message));
  }));

  test('asset names that sanitise alike do not collide', withTmp(async (t) => {
    // regression: backend review issue-4
    const d = path.join(t.tmp, 'r');
    t.png('r/screenshots/a b.png', 4, 8);
    t.png('r/screenshots/a_b.png', 6, 8);
    const doc = minimal();
    doc.issues = [{ id: 'one', title: 'One', screenshots: ['screenshots/a b.png'] },
      { id: 'two', title: 'Two', screenshots: ['screenshots/a_b.png'] }];
    const review = t.write(doc, 'r/review.json');
    const out = path.join(d, 'site');
    build.build(review, out, { quiet: true });
    const srcs = readData(out).issues.map((i) => i.shots[0].src.split('?')[0]);
    assert.equal(new Set(srcs).size, 2, String(srcs));
    ['a b.png', 'a_b.png'].forEach((orig, k) => {
      assert.deepEqual(readBytes(path.join(out, srcs[k])), readBytes(path.join(d, 'screenshots', orig)), srcs[k]);
    });
    assert.equal(build.build(review, out, { quiet: true }).assets.kept, 2);
  }));
});

describe('ImagesTest', () => {
  test('publish recopies a replaced source with an older mtime', withTmp(async (t) => {
    // regression: backend review issue-5
    const src = t.png('src.png', 4, 8);
    const dst = path.join(t.tmp, 'out', 'src.png');
    assert.equal(images.publish(src, dst), 'copied');
    assert.equal(images.publish(src, dst), 'kept');
    const other = t.png('other.png', 6, 8);
    fs.utimesSync(other, 1e9, 1e9);
    fs.renameSync(other, src);
    assert.equal(images.publish(src, dst), 'copied');
    assert.deepEqual(readBytes(src), readBytes(dst));
  }));

  test('png size and fingerprint', withTmp(async (t) => {
    const p = t.png('a.png', 7, 3);
    assert.deepEqual(images.size(p), [7, 3]);
    assert.equal(images.fingerprint(p).length, 10);
  }));

  test('jpeg gif size', withTmp(async (t) => {
    const jpg = path.join(t.tmp, 'a.jpg');
    // SOI, APP0 (len 4), SOF0 with h=20 w=30
    fs.writeFileSync(jpg, Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04]), Buffer.from('ab'),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x14, 0x00, 0x1e, 0x03]), Buffer.alloc(12)]));
    assert.deepEqual(images.size(jpg), [30, 20]);
    const gif = path.join(t.tmp, 'a.gif');
    fs.writeFileSync(gif, Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x05, 0x00, 0x06, 0x00]), Buffer.alloc(10)]));
    assert.deepEqual(images.size(gif), [5, 6]);
  }));

  test('publish without resizer copies', withTmp(async (t) => {
    const src = t.png('big.png', 50, 10);
    const dst = path.join(t.tmp, 'out', 'big.png');
    assert.equal(images.publish(src, dst, 10, null), 'copied');
    assert.deepEqual(images.size(dst), [50, 10]);
    assert.equal(images.publish(src, dst, 10, null), 'kept');
  }));

  test('publish downscales when tool available', { skip: images.resizer() ? false : 'no sips/magick/convert available' },
    withTmp(async (t) => {
      const src = t.png('big.png', 64, 16);
      const dst = path.join(t.tmp, 'out', 'big.png');
      assert.equal(images.publish(src, dst, 32, images.resizer()), 'resized');
      assert.equal(images.size(dst)[0], 32);
    }));
});

describe('MarkdownTest', () => {
  test('inline', () => {
    assert.equal(markdown.render('a **b** *c* `<d>` ~~e~~ [f](https://x.y)'),
      'a <b>b</b> <em>c</em> <code>&lt;d&gt;</code> <s>e</s> <a href="https://x.y">f</a>');
  });

  test('escapes but keeps tags and entities', () => {
    assert.equal(markdown.render('1 < 2 & <b>ok</b> &amp; x'), '1 &lt; 2 &amp; <b>ok</b> &amp; x');
  });

  test('blocks', () => {
    const out = markdown.render('# Head\n\npara one\nline two\n\n- a\n- b\n\n1. x\n2. y\n\n```\n<raw>\n```');
    assert.ok(out.includes('<h3>Head</h3>'), out);
    assert.ok(out.includes('<p>para one<br>line two</p>'), out);
    assert.ok(out.includes('<ul><li>a</li><li>b</li></ul>'), out);
    assert.ok(out.includes('<ol><li>x</li><li>y</li></ol>'), out);
    assert.ok(out.includes('<pre><code>&lt;raw&gt;</code></pre>'), out);
  });

  test('html block passthrough and js urls', () => {
    assert.equal(markdown.render('<table><tr><td>1</td></tr></table>'), '<table><tr><td>1</td></tr></table>');
    assert.ok(markdown.render('[x](javascript:alert(1))').includes('href="#"'));
  });

  test('identifiers with underscores and stars in code', () => {
    assert.equal(markdown.render('use `a*b*c` and snake_case_name'), 'use <code>a*b*c</code> and snake_case_name');
  });
});
