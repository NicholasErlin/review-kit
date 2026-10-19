import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, run, withTmp } from './helpers.mjs';
import * as build from '../dist/build.js';
import * as clean from '../dist/clean.js';
import * as model from '../dist/model.js';
import * as validate from '../dist/validate.js';

const BASIC_APP = path.join(ROOT, 'examples', 'basic-app', 'review');

/** CleanTest.setUp: a built demo copy with applied/unapplied hand-offs and one unreferenced screenshot. */
function cleanTest(fn) {
  return withTmp(async (t) => {
    t.review = t.copyDemo();
    t.base = model.baseDir(t.review);
    t.site = path.join(t.base, 'site');
    build.build(t.review, t.site, { quiet: true });
    t.pending = path.join(t.base, 'pending');
    fs.mkdirSync(t.pending, { recursive: true });
    for (const n of ['fix1.applied.json', 'fix2.json']) fs.writeFileSync(path.join(t.pending, n), '{}');
    t.orphan = t.png('demo/screenshots/old/unused.png');
    await fn(t);
  });
}

const isDir = (p) => fs.existsSync(p) && fs.statSync(p).isDirectory();

describe('CleanTest', () => {
  test('default removes site and applied only', cleanTest(async (t) => {
    const { code, err } = await run('clean', t.review);
    assert.equal(code, 0, err);
    assert.ok(!fs.existsSync(t.site));
    assert.deepEqual(fs.readdirSync(t.pending).sort(), ['fix2.json']);
    assert.ok(fs.existsSync(t.orphan));
    assert.deepEqual(validate.validate(model.load(t.review), t.base)[0], []);
  }));

  test('orphans removes unreferenced screenshots only', cleanTest(async (t) => {
    assert.deepEqual(clean.orphans(t.review), [path.normalize(t.orphan)]);
    await run('clean', t.review, '--orphans', '--keep-site');
    assert.ok(isDir(t.site));
    assert.ok(!fs.existsSync(path.dirname(t.orphan)));
    assert.deepEqual(validate.validate(model.load(t.review), t.base)[0], []);
  }));

  test('orphans keeps screenshots referenced by pending hand offs', cleanTest(async (t) => {
    // regression: backend review issue-2
    const shot = t.png('demo/screenshots/fix7/before.png');
    const issueShot = t.png('demo/screenshots/fix7/issue.png');
    fs.writeFileSync(path.join(t.pending, 'fix7.json'), JSON.stringify({
      fix: { title: 'x', platforms: { mobile: { pairs: [{ before: 'screenshots/fix7/before.png' }] } } },
      issues: [{ title: 'y', screenshots: [{ src: 'screenshots/fix7/issue.png' }] }],
    }));
    assert.deepEqual(clean.orphans(t.review), [path.normalize(t.orphan)]);
    await run('clean', t.review, '--orphans');
    assert.ok(fs.existsSync(shot));
    assert.ok(fs.existsSync(issueShot));
    assert.ok(!fs.existsSync(t.orphan));
  }));

  test('orphans refuses when a pending file is unreadable', cleanTest(async (t) => {
    fs.writeFileSync(path.join(t.pending, 'fix8.json'), '{not json');
    const { code, err } = await run('clean', t.review, '--orphans');
    assert.equal(code, 1);
    assert.ok(err.includes('fix8.json'), err);
    assert.ok(fs.existsSync(t.orphan));
  }));

  test('dry run touches nothing', cleanTest(async (t) => {
    const { code, out } = await run('clean', t.review, '--orphans', '--dry-run');
    assert.equal(code, 0);
    assert.ok(out.includes('would remove'), out);
    assert.ok(isDir(t.site));
    assert.ok(fs.existsSync(path.join(t.pending, 'fix1.applied.json')));
    assert.ok(fs.existsSync(t.orphan));
  }));

  test('leaves folders not built by review kit', cleanTest(async (t) => {
    const other = path.join(t.tmp, 'mine');
    fs.mkdirSync(other);
    const { code, out } = await run('clean', t.review, '--out', other);
    assert.equal(code, 0);
    assert.ok(out.includes('skipped'), out);
    assert.ok(isDir(other));
  }));
});

describe('BasicAppExampleTest', () => {
  test('committed review is valid and tidy', () => {
    const p = path.join(BASIC_APP, 'review.json');
    const [errors] = validate.validate(model.load(p), BASIC_APP);
    assert.deepEqual(errors, []);
    assert.deepEqual(clean.orphans(p), []);
  });
});
