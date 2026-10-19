import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { read, readBytes, run, withTmp } from './helpers.mjs';
import * as edit from '../dist/edit.js';
import * as model from '../dist/model.js';
import { ReviewError } from '../dist/errors.js';

describe('InitTest', () => {
  test('init scaffolds', withTmp(async (t) => {
    const d = path.join(t.tmp, '.review');
    let { code, err } = await run('init', d, '--name', 'Shop', '--platforms', 'mobile,desktop', '--ignore-screenshots', '--accent', '#123456');
    assert.equal(code, 0, err);
    const data = model.load(path.join(d, 'review.json'));
    assert.equal(data.project.name, 'Shop');
    assert.deepEqual(data.platforms.map((p) => p.id), ['mobile', 'desktop']);
    assert.equal(data.platforms[0].shape, 'portrait');
    assert.ok(fs.statSync(path.join(d, 'screenshots')).isDirectory());
    assert.ok(fs.statSync(path.join(d, 'pending')).isDirectory());
    assert.ok(read(path.join(d, '.gitignore')).includes('screenshots/*'));
    assert.equal((await run('validate', d)).code, 0);
    ({ code, err } = await run('init', d, '--name', 'Again'));
    assert.equal(code, 1);
    assert.ok(err.includes('already exists'), err);
  }));
});

/** EditTest.setUp: a fresh review with mobile and desktop platforms. */
function editTest(fn) {
  return withTmp(async (t) => {
    t.dir = path.join(t.tmp, 'r');
    edit.init(t.dir, 'P', 'Review', ['mobile', 'desktop']);
    t.review = path.join(t.dir, 'review.json');
    t.data = () => model.load(t.review);
    await fn(t);
  });
}

describe('EditTest', () => {
  test('add issue flags and auto id', editTest(async (t) => {
    const { code, err } = await run('add-issue', t.review, '--title', 'Broken', '--platform', 'mobile', '--severity', 'P1', '--area', 'Home');
    assert.equal(code, 0, err);
    const issue = t.data().issues[0];
    assert.deepEqual(issue, { title: 'Broken', platform: 'mobile', severity: 'P1', area: 'Home', id: 'm-1', status: 'open' });
    await run('add-issue', t.review, '--title', 'Root', '--platform', 'desktop', '--severity', 'none');
    assert.equal(t.data().issues[1].id, 'd-2');
    assert.equal(t.data().issues[1].severity, null);
  }));

  test('add issue rejects invalid and leaves file', editTest(async (t) => {
    const before = read(t.review);
    const { code, err } = await run('add-issue', t.review, '--title', 'X', '--platform', 'watch');
    assert.equal(code, 1);
    assert.ok(err.includes('unknown platform "watch"'), err);
    assert.equal(read(t.review), before);
  }));

  test('add issue json list and update', editTest(async (t) => {
    const items = [{ id: 'a', title: 'A', platform: 'mobile' }, { id: 'b', title: 'B', platform: 'desktop', severity: 'P0' }];
    assert.equal((await run('add-issue', t.review, '--json', JSON.stringify(items))).code, 0);
    const { code, err } = await run('add-issue', t.review, '--id', 'a', '--title', 'dup', '--platform', 'mobile');
    assert.equal(code, 1);
    assert.ok(err.includes('already exists'), err);
    assert.equal((await run('add-issue', t.review, '--id', 'a', '--status', 'partial', '--update')).code, 0);
    const a = t.data().issues[0];
    assert.deepEqual([a.title, a.status], ['A', 'partial']);
  }));

  test('add issue copies absolute screenshot', editTest(async (t) => {
    const shot = t.png('outside/s.png');
    await run('add-issue', t.review, '--title', 'With shot', '--platform', 'mobile', '--screenshot', shot);
    assert.deepEqual(t.data().issues[0].screenshots, ['screenshots/issues/s.png']);
    assert.ok(fs.statSync(path.join(t.dir, 'screenshots/issues/s.png')).isFile());
  }));

  test('add fix flags pairs and resolves', editTest(async (t) => {
    await run('add-issue', t.review, '--json', JSON.stringify([{ id: 'a', title: 'A', platform: 'mobile' }, { id: 'b', title: 'B', platform: 'mobile' }]));
    const before = t.png('cap/before.png');
    const after = t.png('cap/after.png');
    const { code, err } = await run('add-fix', t.review, '--title', 'Sticky footer', '--files', 'a.tsx, b.tsx', '--pair', 'mobile', before, after,
      '--pair', 'desktop', '-', after, '--resolves', 'a', '--partial', 'b', '--commit', 'abc1234', '--link', 'PR=https://x/pr/1');
    assert.equal(code, 0, err);
    const d = t.data();
    const fx = d.fixes[0];
    assert.deepEqual([fx.id, fx.number], ['fix-1', 1]);
    assert.deepEqual(fx.files, ['a.tsx', 'b.tsx']);
    assert.deepEqual(fx.issues, ['a', 'b']);
    assert.deepEqual(fx.platforms.mobile.pairs[0], { before: 'screenshots/fix-1/before.png', after: 'screenshots/fix-1/after.png' });
    assert.deepEqual(fx.platforms.desktop.pairs[0], { after: 'screenshots/fix-1/after.png' });
    assert.deepEqual(fx.links, [{ label: 'PR', href: 'https://x/pr/1' }]);
    assert.deepEqual(d.issues.map((i) => i.status), ['fixed', 'partial']);
    assert.match(fx.date, /^\d{4}-\d{2}-\d{2}$/);
    await run('add-fix', t.review, '--title', 'Second');
    assert.equal(t.data().fixes[1].id, 'fix-2');
  }));

  test('add fix unknown issue fails', editTest(async (t) => {
    const { code, err } = await run('add-fix', t.review, '--title', 'X', '--resolves', 'ghost');
    assert.equal(code, 1);
    assert.ok(err.includes('ghost'), err);
    assert.deepEqual(t.data().fixes, []);
  }));

  test('mark issue and plan', editTest(async (t) => {
    await run('add-issue', t.review, '--id', 'a', '--title', 'A', '--platform', 'mobile');
    await run('add-plan', t.review, '--group', 'Roadmap', '--id', 'p1', '--title', 'Do it', '--files', 'x.ts');
    await run('add-fix', t.review, '--title', 'F');
    assert.equal((await run('mark', '-r', t.review, 'notabug', 'a', '--note', 'works as designed', '--fix', 'fix-1')).code, 0);
    assert.equal((await run('mark', '-r', t.review, 'done', 'p1')).code, 0);
    const d = t.data();
    assert.deepEqual([d.issues[0].status, d.issues[0].note], ['notabug', 'works as designed']);
    assert.deepEqual(d.fixes[0].issues, ['a']);
    assert.equal(d.plan[0].items[0].status, 'done');
    assert.deepEqual(d.plan[0].items[0].files, ['x.ts']);
    const { code, err } = await run('mark', '-r', t.review, 'fixed', 'p1');
    assert.equal(code, 1);
    assert.ok(err.includes('status must be one of'), err);
  }));

  test('apply pending envelopes in natural order', editTest(async (t) => {
    await run('add-issue', t.review, '--json', JSON.stringify([{ id: 'a', title: 'A', platform: 'mobile' }, { id: 'b', title: 'B', platform: 'desktop' }]));
    await run('add-plan', t.review, '--id', 'p1', '--title', 'Plan item');
    const shot = t.png('agent/after.png');
    const pending = path.join(t.dir, 'pending');
    fs.writeFileSync(path.join(pending, 'fix10.json'), JSON.stringify({ title: 'Ten', number: 10, issues: ['b'] })); // bare fix
    fs.writeFileSync(path.join(pending, 'fix2.json'), JSON.stringify({
      fix: { title: 'Two', summary: 'did **it**', platforms: { mobile: { pairs: [{ after: { src: shot, caption: 'now' } }] } } },
      issues: [{ id: 'c', title: 'Found while fixing', platform: 'mobile', severity: 'P2' }],
      marks: [{ issue: 'a', status: 'fixed', note: 'done' }, { plan: 'p1', status: 'partial' }],
    }));
    const { code, out, err } = await run('apply-pending', t.review);
    assert.equal(code, 0, err);
    assert.ok(out.indexOf('fix2.json') >= 0 && out.indexOf('fix10.json') >= 0, out);
    assert.ok(out.indexOf('fix2.json') < out.indexOf('fix10.json'), out);
    const d = t.data();
    assert.deepEqual(d.fixes.map((f) => f.title), ['Two', 'Ten']);
    assert.equal(d.fixes[0].number, 1);
    assert.deepEqual(d.fixes[0].issues, ['a']);
    assert.deepEqual(d.fixes[0].platforms.mobile.pairs[0].after, { src: 'screenshots/fix-1/after.png', caption: 'now' });
    assert.deepEqual(d.issues.map((i) => i.id), ['a', 'b', 'c']);
    assert.equal(d.issues[0].status, 'fixed');
    assert.equal(d.plan[0].items[0].status, 'partial');
    assert.deepEqual(fs.readdirSync(pending).sort(), ['.gitkeep', 'fix10.applied.json', 'fix2.applied.json']);
    assert.equal((await run('apply-pending', t.review)).out.trim(), 'nothing pending');
  }));

  test('apply pending stops on invalid file', editTest(async (t) => {
    const pending = path.join(t.dir, 'pending');
    fs.writeFileSync(path.join(pending, 'bad.json'), JSON.stringify({ fix: { title: 'Bad', issues: ['ghost'] } }));
    const { code, err } = await run('apply-pending', t.review);
    assert.equal(code, 1);
    assert.ok(err.includes('ghost'), err);
    assert.ok(fs.existsSync(path.join(pending, 'bad.json')));
    assert.deepEqual(t.data().fixes, []);
  }));

  test('envelope unknown keys', editTest(async () => {
    assert.throws(() => edit.normaliseEnvelope({ fix: {}, extra: 1 }), ReviewError);
  }));

  test('summary', editTest(async (t) => {
    await run('add-issue', t.review, '--json', JSON.stringify([{ id: 'a', title: 'A', platform: 'mobile', severity: 'P0' },
      { id: 'b', title: 'B', platform: 'desktop', severity: 'P2' }]));
    await run('add-fix', t.review, '--title', 'Fix A', '--resolves', 'a');
    const { code, out } = await run('summary', t.review);
    assert.equal(code, 0);
    assert.ok(out.includes('**Issues:** 2 total, 1 fixed, 0 partly fixed, 1 open (50% done)'), out);
    assert.ok(out.includes('- #1 Fix A'), out);
    assert.ok(out.includes('- P2 b [Desktop]: B'), out);
  }));

  // -- regression: imported screenshots with the same file name (backend review issue-1)
  test('same basename screenshots do not overwrite each other', editTest(async (t) => {
    const a = t.png('a/home.png', 4, 8);
    const b = t.png('b/home.png', 6, 8);
    const { code, err } = await run('add-fix', t.review, '--title', 'T', '--pair', 'mobile', a, b);
    assert.equal(code, 0, err);
    for (const shot of [a, b]) {
      assert.equal((await run('add-issue', t.review, '--title', 'I', '--platform', 'mobile', '--screenshot', shot)).code, 0);
    }
    const data = t.data();
    const pair = data.fixes[0].platforms.mobile.pairs[0];
    const stored = [pair.before, pair.after, ...data.issues.map((i) => i.screenshots[0])];
    assert.equal(new Set(stored).size, 4, String(stored));
    [a, b, a, b].forEach((orig, k) => {
      assert.deepEqual(readBytes(path.join(t.dir, stored[k])), readBytes(orig), stored[k]);
    });
  }));

  test('reimporting an identical screenshot reuses the copy', editTest(async (t) => {
    const a = t.png('a/home.png');
    for (let k = 0; k < 2; k++) await run('add-issue', t.review, '--title', 'I', '--platform', 'mobile', '--screenshot', a);
    assert.deepEqual(t.data().issues.map((i) => i.screenshots), [['screenshots/issues/home.png'], ['screenshots/issues/home.png']]);
  }));

  // -- regression: malformed input and OS errors are clean CLI errors (issue-3)
  test('malformed pending envelope is a clean error', editTest(async (t) => {
    const pending = path.join(t.dir, 'pending');
    for (const [n, body] of [['fix1.json', { issues: 'x' }], ['fix2.json', { fix: [1] }], ['fix3.json', { marks: [1] }]]) {
      fs.writeFileSync(path.join(pending, n), JSON.stringify(body));
      const { code, err } = await run('apply-pending', t.review);
      assert.equal(code, 1, n);
      assert.ok(!err.includes('Traceback'), err);
      assert.ok(err.includes('review-kit:'), err);
      fs.rmSync(path.join(pending, n));
    }
  }));

  test('broken review json is reported before editing', editTest(async (t) => {
    const data = t.data();
    data.issues = [{ title: 'no id' }];
    fs.writeFileSync(t.review, JSON.stringify(data));
    for (const argv of [['add-issue', t.review, '--title', 'x'], ['add-fix', t.review, '--title', 'x'],
      ['mark', '-r', t.review, 'fixed', 'a'], ['summary', t.review]]) {
      const { code, err } = await run(...argv);
      assert.equal(code, 1, argv.join(' '));
      assert.ok(err.includes('run `review-kit validate`'), err);
    }
  }));

  test('unknown companion kind is a clean error', editTest(async () => {
    const { code, err } = await run('companions', '--kind', 'foo');
    assert.equal(code, 1);
    assert.ok(err.includes('unknown review kind'), err);
  }));

  test('os errors are clean errors', { skip: process.getuid && process.getuid() === 0 ? 'root ignores permissions' : false },
    editTest(async (t) => {
      fs.chmodSync(t.dir, 0o555);
      let code, err;
      try {
        ({ code, err } = await run('add-issue', t.review, '--title', 'x', '--platform', 'mobile'));
      } finally {
        fs.chmodSync(t.dir, 0o755);
      }
      assert.equal(code, 1);
      assert.ok(err.includes('review-kit:'), err);
      assert.ok(err.includes('ermission denied'), err);
    }));

  // -- regression: mark takes the review positionally like every other command (issue-12)
  test('mark accepts review positionally and with r', editTest(async (t) => {
    await run('add-issue', t.review, '--json', JSON.stringify([{ id: 'a', title: 'A', platform: 'mobile' },
      { id: 'b', title: 'B', platform: 'mobile' }]));
    let { code, err } = await run('mark', t.dir, 'fixed', 'a');
    assert.equal(code, 0, err);
    ({ code, err } = await run('mark', '-r', t.review, 'wontfix', 'b'));
    assert.equal(code, 0, err);
    assert.deepEqual(t.data().issues.map((i) => i.status), ['fixed', 'wontfix']);
    ({ code, err } = await run('mark', t.dir, 'fixed'));
    assert.equal(code, 1);
    assert.ok(err.includes('ids'), err);
  }));
});
