// One combined site for several reviews (.review/ui + .review/backend -> .review/site).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { minimal, pngBytes, quietly, read, readBytes, request, run, startServer, stopServer, withTmp } from './helpers.mjs';
import * as build from '../dist/build.js';
import * as cli from '../dist/cli.js';
import * as serve from '../dist/serve.js';
import { ReviewError } from '../dist/errors.js';

const isFile = (p) => fs.existsSync(p) && fs.statSync(p).isFile();
const isDir = (p) => fs.existsSync(p) && fs.statSync(p).isDirectory();

function readReviews(out) {
  const s = read(path.join(out, 'data.js'));
  assert.ok(s.startsWith('window.REVIEWS = '), s.slice(0, 40));
  return JSON.parse(s.slice('window.REVIEWS = '.length).trimEnd().replace(/;+$/, ''));
}

function manifest(out) {
  return JSON.parse(read(path.join(out, build.MARKER)));
}

/** <tmp>/.review/{ui,backend}/review.json, each with a screenshot at the SAME relative path but different bytes. */
function twoReviews(t, parent = '.review') {
  const root = path.join(t.tmp, parent);
  for (const [kind, w, accent] of [['backend', 6, '#7a3b00'], ['ui', 4, '#2f5d50']]) { // backend first: order comes from the kind
    const dir = path.join(root, kind);
    fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'screenshots', 'a.png'), pngBytes(w, 8));
    const d = minimal();
    d.project.name = 'App';
    d.project.kind = kind;
    d.project.title = kind === 'ui' ? 'UI/UX review' : 'Backend review';
    d.project.theme = { accent };
    d.issues = [{ id: `${kind}-1`, title: `${kind} issue`, screenshots: ['screenshots/a.png'] }];
    fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify(d));
  }
  return root;
}

/** Run fn with the cwd at t.tmp (the CLI resolves .review/ relative to it). */
function inTmp(fn) {
  return withTmp(async (t) => {
    const cwd = process.cwd();
    process.chdir(t.tmp);
    try {
      await fn(t);
    } finally {
      process.chdir(cwd);
    }
  });
}

describe('CombinedDiscoveryTest', () => {
  test('no argument finds every kind; a kind, a parent folder or several paths also work', inTmp(async (t) => {
    twoReviews(t);
    const ui = path.join('.review', 'ui', 'review.json');
    const be = path.join('.review', 'backend', 'review.json');
    assert.deepEqual(cli.findReviews([]), [be, ui]);
    assert.deepEqual(cli.findReviews(['ui']), [ui]);
    assert.deepEqual(cli.findReviews(['.review']), [be, ui]);
    assert.deepEqual(cli.findReviews(['ui', 'backend', 'ui']), [ui, be]);
    assert.equal(cli.combinedOut([ui, be]), path.join('.review', 'site'));
    // commands that edit one review still refuse to guess
    assert.throws(() => cli.findReview(), (e) => e instanceof ReviewError && /several reviews here/.test(e.message));
    const { code, err } = await run('validate');
    assert.equal(code, 1);
    assert.ok(err.includes('several reviews here'), err);
  }));

  test('reviews in different parent folders need --out', inTmp(async (t) => {
    twoReviews(t);
    fs.renameSync(path.join(t.tmp, '.review', 'backend'), path.join(t.tmp, 'backend'));
    const { code, err } = await run('build', 'ui', 'backend');
    assert.equal(code, 1);
    assert.ok(err.includes('--out'), err);
    const r = await run('build', 'ui', 'backend', '--out', 'both');
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(readReviews(path.join(t.tmp, 'both')).map((x) => x.key), ['ui', 'backend']);
  }));
});

describe('CombinedBuildTest', () => {
  test('build with no argument writes one site at .review/site', inTmp(async (t) => {
    twoReviews(t);
    const { code, out, err } = await run('build');
    assert.equal(code, 0, err);
    assert.ok(out.includes('UI/UX: 1 issues') && out.includes('Backend: 1 issues'), out);
    const site = path.join(t.tmp, '.review', 'site');
    for (const n of ['index.html', 'app.js', 'app.css', 'data.js', build.MARKER]) assert.ok(isFile(path.join(site, n)), n);
    assert.ok(!fs.existsSync(path.join(t.tmp, '.review', 'ui', 'site')));
    const reviews = readReviews(site);
    assert.deepEqual(reviews.map((r) => [r.key, r.label]), [['ui', 'UI/UX'], ['backend', 'Backend']]);
    assert.equal(reviews[1].data.project.theme.accent, '#7a3b00'); // each review keeps its own theme
    const html = read(path.join(site, 'index.html'));
    assert.ok(html.includes('<title>App reviews</title>'), html);
    assert.ok(html.includes('content="#2f5d50"'));
    // assets are namespaced per review, so equal relative paths do not collide
    const srcs = reviews.map((r) => r.data.issues[0].shots[0].src.split('?')[0]);
    assert.deepEqual(srcs, ['img/ui/screenshots/a.png', 'img/backend/screenshots/a.png']);
    for (const [i, kind] of [[0, 'ui'], [1, 'backend']]) {
      assert.deepEqual(readBytes(path.join(site, srcs[i])), readBytes(path.join(t.tmp, '.review', kind, 'screenshots', 'a.png')));
    }
    assert.deepEqual(manifest(site).files, ['index.html', 'app.css', 'app.js', 'data.js', ...srcs.slice().sort()]);
    // the combined site is gitignored like each review's own site/
    assert.ok(read(path.join(t.tmp, '.review', '.gitignore')).includes('/site/'));
  }));

  test('a single review still builds alone, exactly as before', inTmp(async (t) => {
    twoReviews(t);
    const { code, err } = await run('build', 'ui');
    assert.equal(code, 0, err);
    const site = path.join(t.tmp, '.review', 'ui', 'site');
    assert.ok(read(path.join(site, 'data.js')).startsWith('window.REVIEW = '));
    assert.ok(isFile(path.join(site, 'img', 'screenshots', 'a.png')));
    assert.ok(!fs.existsSync(path.join(t.tmp, '.review', 'site')));
    assert.ok(!fs.existsSync(path.join(t.tmp, '.review', '.gitignore')));
  }));

  test('explicit paths and a parent folder build the same combined site', inTmp(async (t) => {
    twoReviews(t);
    for (const args of [['.review'], ['backend', 'ui'], ['.review/ui/review.json', '.review/backend']]) {
      const { code, err } = await run('build', ...args);
      assert.equal(code, 0, `${args}: ${err}`);
      assert.deepEqual(readReviews(path.join(t.tmp, '.review', 'site')).map((r) => r.key), ['ui', 'backend'], String(args));
    }
  }));

  test('rebuild prunes stale files but keeps every review\'s images', withTmp(async (t) => {
    const root = twoReviews(t);
    const paths = ['ui', 'backend'].map((k) => path.join(root, k, 'review.json'));
    const out = path.join(root, 'site');
    build.buildCombined(paths, out, { quiet: true });
    const stray = path.join(out, 'img', 'ui', 'old.png');
    fs.writeFileSync(stray, '');
    const stats = build.buildCombined(paths, out, { quiet: true });
    assert.ok(!fs.existsSync(stray));
    assert.deepEqual(stats.reviews.map((r) => [r.key, r.issues, r.assets.kept]), [['ui', 1, 1], ['backend', 1, 1]]);
    assert.ok(isFile(path.join(out, 'img', 'backend', 'screenshots', 'a.png')));
  }));

  test('validation errors name the review and write nothing', withTmp(async (t) => {
    const root = twoReviews(t);
    const be = path.join(root, 'backend', 'review.json');
    const d = JSON.parse(read(be));
    d.issues[0].screenshots = ['nope.png'];
    fs.writeFileSync(be, JSON.stringify(d));
    const out = path.join(root, 'site');
    assert.throws(() => build.buildCombined([path.join(root, 'ui', 'review.json'), be], out, { quiet: true }),
      (e) => e instanceof ReviewError && e.message.includes(be) && e.message.includes('image not found: nope.png'));
    assert.ok(!fs.existsSync(out));
  }));

  test('refuses foreign output folders and duplicate kinds get distinct keys', withTmp(async (t) => {
    const root = twoReviews(t);
    const ui = path.join(root, 'ui', 'review.json');
    const other = path.join(t.tmp, 'other');
    fs.cpSync(path.join(root, 'ui'), other, { recursive: true });
    const foreign = path.join(t.tmp, 'mine');
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, 'keep.txt'), '');
    assert.throws(() => build.buildCombined([ui, path.join(other, 'review.json')], foreign, { quiet: true, force: true }), ReviewError);
    assert.ok(isFile(path.join(foreign, 'keep.txt')));
    const refs = build.loadReviews([ui, path.join(other, 'review.json')]);
    assert.deepEqual(refs.map((r) => [r.key, r.label]), [['ui', 'UI/UX'], ['other', 'UI/UX review']]);
  }));
});

describe('CombinedCleanTest', () => {
  test('clean removes the combined site, each review\'s own site and applied hand-offs', inTmp(async (t) => {
    twoReviews(t);
    await run('build');
    await run('build', 'ui');
    const pending = path.join(t.tmp, '.review', 'backend', 'pending');
    fs.mkdirSync(pending);
    fs.writeFileSync(path.join(pending, 'fix1.applied.json'), '{}');
    const dry = await run('clean', '--dry-run');
    assert.ok(dry.out.includes('would remove: .review/site/'), dry.out);
    assert.ok(isDir(path.join(t.tmp, '.review', 'site')));
    const { code, out, err } = await run('clean');
    assert.equal(code, 0, err);
    assert.ok(out.includes('removed: .review/site/') && out.includes('removed: .review/ui/site/'), out);
    assert.ok(!fs.existsSync(path.join(t.tmp, '.review', 'site')));
    assert.ok(!fs.existsSync(path.join(t.tmp, '.review', 'ui', 'site')));
    assert.ok(!fs.existsSync(path.join(pending, 'fix1.applied.json')));
    assert.ok(isFile(path.join(t.tmp, '.review', 'ui', 'review.json')));
  }));

  test('clean leaves a combined folder review-kit did not build', inTmp(async (t) => {
    twoReviews(t);
    fs.mkdirSync(path.join(t.tmp, '.review', 'site'));
    fs.writeFileSync(path.join(t.tmp, '.review', 'site', 'mine.txt'), '');
    const { code, out } = await run('clean');
    assert.equal(code, 0);
    assert.ok(out.includes('skipped: .review/site: not built by review-kit'), out);
    assert.ok(isFile(path.join(t.tmp, '.review', 'site', 'mine.txt')));
  }));
});

describe('CombinedServeTest', () => {
  test('serves only manifest files of a combined site', withTmp(async (t) => {
    const root = twoReviews(t);
    const out = path.join(root, 'site');
    build.buildCombined(['ui', 'backend'].map((k) => path.join(root, k, 'review.json')), out, { quiet: true });
    fs.writeFileSync(path.join(out, 'img', 'extra.png'), pngBytes(2, 2));
    const server = await startServer(out);
    const port = server.address().port;
    try {
      await quietly(async () => {
        let r = await request(port, '/data.js');
        assert.equal(r.status, 200);
        assert.ok(r.body.toString().startsWith('window.REVIEWS = '));
        assert.ok(r.headers['content-security-policy'].includes("script-src 'self'"));
        for (const p of ['/img/ui/screenshots/a.png', '/img/backend/screenshots/a.png']) {
          r = await request(port, p);
          assert.equal(r.status, 200, p);
        }
        assert.equal((await request(port, '/img/extra.png')).status, 404);
        assert.equal((await request(port, '/.review-kit-site')).status, 404);
      });
    } finally {
      await stopServer(server);
    }
  }));

  test('watch snapshot covers every review and rebuild handles several', withTmp(async (t) => {
    const root = twoReviews(t);
    const paths = ['ui', 'backend'].map((k) => path.join(root, k, 'review.json'));
    const before = serve.snapshot(paths);
    fs.writeFileSync(path.join(root, 'backend', 'screenshots', 'b.png'), pngBytes(2, 2));
    assert.notEqual(serve.snapshot(paths), before);
    const out = path.join(root, 'site');
    const { value } = await quietly(() => serve.rebuild(paths, out, null));
    assert.equal(value, true);
    assert.deepEqual(readReviews(out).map((r) => r.key), ['ui', 'backend']);
  }));

  test('serve with no argument builds and serves the combined site', inTmp(async (t) => {
    twoReviews(t);
    // cmdServe never resolves (it waits for SIGINT), so drive its parts: discovery, build, then serve().
    const paths = cli.findReviews([]);
    const out = cli.combinedOut(paths);
    await quietly(() => build.buildAny(paths, out));
    const { value: server } = await quietly(() => serve.serve(out, '127.0.0.1', 0, { reviewPath: paths, watch: false }));
    try {
      const r = await request(server.address().port, '/');
      assert.equal(r.status, 200);
      assert.ok(r.body.toString().includes('<title>App reviews</title>'));
    } finally {
      await stopServer(server);
    }
  }));
});

describe('CombinedAttachTest', () => {
  test('attaching both kinds ignores the combined site', withTmp(async (t) => {
    const { code, out, err } = await run('attach', t.tmp, '--kind', 'ui,backend', '--name', 'X', '--no-agents-file');
    assert.equal(code, 0, err);
    assert.ok(out.includes('ignores the combined site/'), out);
    assert.ok(read(path.join(t.tmp, '.review', '.gitignore')).includes('/site/'));
    const again = await run('attach', t.tmp, '--kind', 'ui,backend', '--no-agents-file');
    assert.ok(!again.out.includes('ignores the combined site/'), again.out);
  }));
});
