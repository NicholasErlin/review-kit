import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { read, run, withTmp } from './helpers.mjs';
import * as companions from '../dist/companions.js';
import { ReviewError } from '../dist/errors.js';

// ---------------------------------------------------------------- a tiny ustar writer
function octal(n, width) {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function header(name, { size = 0, type = '0', linkname = '' } = {}) {
  const h = Buffer.alloc(512);
  const put = (s, at, len) => {
    const b = Buffer.from(s, 'utf8');
    assert.ok(b.length <= len, `tar field too long: ${s}`);
    b.copy(h, at);
  };
  put(name, 0, 100);
  put(octal(type === '2' ? 0o777 : 0o644, 8), 100, 8);
  put(octal(0, 8), 108, 8); // uid
  put(octal(0, 8), 116, 8); // gid
  put(octal(size, 12), 124, 12);
  put(octal(0, 12), 136, 12); // mtime
  h.fill(0x20, 148, 156); // checksum field counts as spaces while summing
  put(type, 156, 1);
  put(linkname, 157, 100);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

/** A gzipped tar shaped like a GitHub codeload download: everything under one top folder. */
function tarball(files, links = []) {
  const parts = [];
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.from(body, 'utf8');
    parts.push(header('repo-sha/' + name, { size: data.length }));
    parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  for (const [name, target] of links) parts.push(header('repo-sha/' + name, { type: '2', linkname: target }));
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

const UI = '.claude/skills/ui-ux-pro-max/';

/** CompanionsTest.setUp: a bundle and skills folder in the temp dir, and an opener serving a fake download. */
function companionsTest(fn) {
  return withTmp(async (t) => {
    t.bundle = path.join(t.tmp, 'bundle');
    t.skills = path.join(t.tmp, 'skills');
    t.urls = [];
    const blob = tarball({
      [UI + 'SKILL.md']: 'ui skill', [UI + 'scripts/search.py']: 'print(1)',
      [UI + 'scripts/tests/test_x.py']: 'x', 'README.md': 'x', LICENSE: 'MIT License',
      [UI + '../../../evil.txt']: 'nope',
    }, [[UI + 'data', '/etc']]);
    t.opener = async (url) => {
      t.urls.push(url);
      return blob;
    };
    t.update = () => companions.update(['ui'], t.bundle, t.opener);
    t.install = (skillsDirs = null) => companions.install(['ui'], skillsDirs === null ? [t.skills] : skillsDirs, t.bundle);
    await fn(t);
  });
}

/** mock.patch.dict(os.environ, {'HOME': dir}) */
async function withHome(dir, fn) {
  const saved = process.env.HOME;
  process.env.HOME = dir;
  try {
    return await fn();
  } finally {
    process.env.HOME = saved;
  }
}

describe('CompanionsTest', () => {
  test('update extracts only the skill with license and source', companionsTest(async (t) => {
    await t.update();
    assert.deepEqual(t.urls, ['https://codeload.github.com/nextlevelbuilder/ui-ux-pro-max-skill/tar.gz/'
      + companions.SOURCES['nextlevelbuilder/ui-ux-pro-max-skill']]);
    const skill = path.join(t.bundle, 'ui-ux-pro-max');
    // no symlink, no README, no upstream tests
    assert.deepEqual(fs.readdirSync(skill).sort(), ['LICENSE', 'SKILL.md', 'SOURCE', 'scripts']);
    assert.deepEqual(fs.readdirSync(path.join(skill, 'scripts')), ['search.py']);
    assert.equal(read(path.join(skill, 'LICENSE')), 'MIT License');
    assert.ok(read(path.join(skill, 'SOURCE')).includes(companions.SOURCES['nextlevelbuilder/ui-ux-pro-max-skill']));
    assert.ok(!fs.existsSync(path.join(t.tmp, 'evil.txt')));
  }));

  test('install links the bundle offline', companionsTest(async (t) => {
    await t.update();
    t.urls.length = 0;
    assert.ok(t.install().join('\n').includes('linked'));
    assert.deepEqual(t.urls, []);
    const link = path.join(t.skills, 'ui-ux-pro-max');
    assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(t.bundle, 'ui-ux-pro-max')));
    assert.ok(t.install().join('\n').includes('already linked'));
  }));

  test('never replaces a skill installed another way', companionsTest(async (t) => {
    await t.update();
    const mine = path.join(t.skills, 'ui-ux-pro-max');
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, 'SKILL.md'), 'my copy');
    assert.ok(t.install().join('\n').includes('left alone'));
    assert.equal(read(path.join(mine, 'SKILL.md')), 'my copy');
  }));

  test('bad downloads are clean errors', companionsTest(async (t) => {
    t.opener = async () => tarball({ 'README.md': 'x' });
    await assert.rejects(t.update(), (e) => e instanceof ReviewError && /not found/.test(e.message));
    t.opener = async () => Buffer.from('not a tarball');
    await assert.rejects(t.update(), (e) => e instanceof ReviewError && /not a valid archive/.test(e.message));
    await assert.rejects(companions.download('a/b', 'sha', async () => Buffer.from('x'.repeat(11)), 10),
      (e) => e instanceof ReviewError && /larger than/.test(e.message));
  }));

  test('find prefers installed copies over the bundle', companionsTest(async (t) => {
    await t.update();
    await withHome(t.tmp, () => {
      assert.equal(companions.find('ui-ux-pro-max', t.tmp, t.bundle), path.join(t.bundle, 'ui-ux-pro-max', 'SKILL.md'));
      const agents = path.join(t.tmp, '.agents', 'skills', 'ui-ux-pro-max');
      fs.mkdirSync(agents, { recursive: true });
      fs.writeFileSync(path.join(agents, 'SKILL.md'), '');
      assert.equal(companions.find('ui-ux-pro-max', t.tmp, t.bundle), path.join(agents, 'SKILL.md'));
    });
  }));

  test('the repo bundles every companion', companionsTest(async () => {
    for (const kind of companions.KINDS) {
      for (const c of companions.COMPANIONS[kind]) {
        const d = path.join(companions.BUNDLE, c.name);
        for (const f of ['SKILL.md', 'LICENSE', 'SOURCE']) {
          const p = path.join(d, f);
          assert.ok(fs.existsSync(p) && fs.statSync(p).isFile(), `${c.name}/${f}`);
        }
        assert.ok(read(path.join(d, 'SOURCE')).includes(companions.SOURCES[c.repo]), c.name);
      }
    }
  }));

  test('list and path commands', companionsTest(async (t) => {
    let code, out, err;
    await withHome(t.tmp, async () => {
      ({ code, out, err } = await run('companions', '--kind', 'backend'));
      assert.equal(code, 0, err);
      for (const name of ['api-design-principles', 'architecture-patterns', 'error-handling-patterns']) {
        assert.ok(out.includes(path.join(companions.BUNDLE, name)), out);
      }
      assert.ok(!out.includes('ui-ux-pro-max'), out);
      ({ code, out } = await run('companions', '--path', 'ui-ux-pro-max'));
    });
    assert.deepEqual([code, out.trim()], [0, path.join(companions.BUNDLE, 'ui-ux-pro-max')]);
    assert.notEqual((await run('companions', '--path', 'nope')).code, 0);
  }));
});
