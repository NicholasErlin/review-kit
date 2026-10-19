import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, read, run, withTmp } from './helpers.mjs';
import * as attach from '../dist/attach.js';
import * as model from '../dist/model.js';

describe('AttachTest', () => {
  test('creates review and pointer', withTmp(async (t) => {
    const { code, err } = await run('attach', t.tmp, '--name', 'Shop', '--platforms', 'web');
    assert.equal(code, 0, err);
    const data = model.load(path.join(t.tmp, '.review', 'ui', 'review.json'));
    assert.equal(data.project.name, 'Shop');
    assert.equal(data.project.kind, 'ui');
    assert.equal(data.project.title, 'UI/UX review');
    assert.deepEqual(data.platforms.map((p) => p.id), ['web']);
    const agents = read(path.join(t.tmp, 'AGENTS.md'));
    assert.ok(agents.includes(attach.BEGIN));
    assert.ok(agents.includes('UI/UX: `.review/ui/review.json`'), agents);
    assert.ok(!fs.existsSync(path.join(t.tmp, 'CLAUDE.md')));
  }));

  test('rerun is idempotent and keeps existing text', withTmp(async (t) => {
    const claude = path.join(t.tmp, 'CLAUDE.md');
    fs.writeFileSync(claude, '# Rules\n\nBe nice.\n');
    await run('attach', t.tmp);
    const first = read(claude);
    assert.ok(first.startsWith('# Rules\n\nBe nice.\n\n' + attach.BEGIN), first);
    const { code, out } = await run('attach', t.tmp);
    assert.equal(code, 0);
    assert.ok(out.includes('ui: using existing .review/ui/review.json'), out);
    assert.ok(out.includes('CLAUDE.md: review-kit pointer unchanged'), out);
    assert.equal(read(claude), first);
  }));

  test('pointer write is atomic and keeps the file mode', withTmp(async (t) => {
    // regression: backend review issue-10
    const agents = path.join(t.tmp, 'AGENTS.md');
    fs.writeFileSync(agents, '# Mine\n');
    fs.chmodSync(agents, 0o640);
    assert.equal((await run('attach', t.tmp, '--no-agents-file')).code, 0);
    const renameSync = fs.renameSync;
    fs.renameSync = () => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    };
    let code, err;
    try {
      ({ code, err } = await run('attach', t.tmp));
    } finally {
      fs.renameSync = renameSync;
    }
    assert.equal(code, 1);
    assert.ok(err.includes('disk full'), err);
    assert.equal(read(agents), '# Mine\n');
    assert.deepEqual(fs.readdirSync(t.tmp).sort(), ['.review', 'AGENTS.md']);
    assert.equal((await run('attach', t.tmp)).code, 0);
    assert.ok(read(agents).includes(attach.BEGIN));
    assert.equal(fs.statSync(agents).mode & 0o777, 0o640);
  }));

  test('replaces an outdated pointer', withTmp(async (t) => {
    const agents = path.join(t.tmp, 'AGENTS.md');
    fs.writeFileSync(agents, `top\n${attach.BEGIN}\nold text\n${attach.END}\nbottom\n`);
    await run('attach', t.tmp);
    const s = read(agents);
    assert.ok(!s.includes('old text'));
    assert.ok(s.startsWith('top\n') && s.endsWith('bottom\n'), s);
    assert.equal(s.split(attach.BEGIN).length - 1, 1);
  }));

  test('reuses review elsewhere and skips agents file', withTmp(async (t) => {
    await run('init', path.join(t.tmp, 'docs', 'review'));
    const { code, out } = await run('attach', t.tmp, '--no-agents-file');
    assert.equal(code, 0);
    assert.ok(out.includes('docs/review/review.json'), out);
    assert.ok(!fs.existsSync(path.join(t.tmp, '.review')));
    assert.ok(!fs.existsSync(path.join(t.tmp, 'AGENTS.md')));
  }));

  test('both kinds', withTmp(async (t) => {
    let { code, out, err } = await run('attach', t.tmp, '--kind', 'ui,backend', '--platforms', 'web');
    assert.equal(code, 0, err);
    const ui = model.load(path.join(t.tmp, '.review', 'ui', 'review.json'));
    const be = model.load(path.join(t.tmp, '.review', 'backend', 'review.json'));
    assert.equal(be.project.kind, 'backend');
    assert.equal(be.project.title, 'Backend review');
    assert.deepEqual(be.platforms.map((p) => p.id), ['default']);
    assert.deepEqual(ui.platforms.map((p) => p.id), ['web']);
    const agents = read(path.join(t.tmp, 'AGENTS.md'));
    assert.ok(agents.includes('Backend practices: `.review/backend/review.json`'), agents);
    // adding a kind later keeps the first review and lists both
    ({ code, out } = await run('attach', t.tmp, '--kind', 'backend,ui'));
    assert.ok(out.includes('backend: using existing'), out);
    await run('attach', t.tmp); // default kind ui: the backend review stays in the pointer
    assert.ok(read(path.join(t.tmp, 'AGENTS.md')).includes('Backend practices: `.review/backend/review.json`'));
  }));

  test('kind shortcut and ambiguous discovery', withTmp(async (t) => {
    await run('attach', t.tmp, '--kind', 'ui,backend', '--no-agents-file');
    const cwd = process.cwd();
    process.chdir(t.tmp);
    try {
      let { code, err } = await run('add-issue', 'backend', '--title', 'Unbounded upload size', '--severity', 'P1');
      assert.equal(code, 0, err);
      assert.equal(model.load('.review/backend/review.json').issues.length, 1);
      ({ code, err } = await run('validate'));
      assert.notEqual(code, 0);
      assert.ok(err.includes('several reviews'), err);
    } finally {
      process.chdir(cwd);
    }
  }));

  test('init kind defaults', withTmp(async (t) => {
    const d = path.join(t.tmp, 'be');
    const { code, err } = await run('init', d, '--kind', 'backend');
    assert.equal(code, 0, err);
    const data = model.load(path.join(d, 'review.json'));
    assert.deepEqual([data.project.kind, data.project.title], ['backend', 'Backend review']);
    assert.equal(data.platforms.length, 1);
  }));

  test('unknown kind', withTmp(async (t) => {
    const { code, err } = await run('attach', t.tmp, '--kind', 'mobile');
    assert.notEqual(code, 0);
    assert.ok(err.includes('unknown review kind'), err);
  }));

  test('home prints kit folder', async () => {
    const { out } = await run('home');
    assert.equal(out.trim(), ROOT);
  });
});

// Replaces the Python InstallTest (install.sh): the npm install story is `npm i -g @horus52/review-kit && review-kit setup`.
describe('SetupTest', () => {
  const realpath = (p) => fs.realpathSync(p);

  /** Run fn with HOME pointing at dir, restoring it afterwards. */
  async function withHome(dir, fn) {
    const saved = process.env.HOME;
    process.env.HOME = dir;
    try {
      return await fn();
    } finally {
      process.env.HOME = saved;
    }
  }

  test('setup links the skill and backs up an old copy', withTmp(async (t) => {
    fs.mkdirSync(path.join(t.tmp, '.claude', 'skills', 'review-kit'), { recursive: true });
    await withHome(t.tmp, async () => {
      const { code, err } = await run('setup');
      assert.equal(code, 0, err);
      const skill = path.join(t.tmp, '.claude', 'skills', 'review-kit');
      assert.equal(realpath(skill), realpath(path.join(ROOT, 'skill', 'review-kit')));
      assert.deepEqual(fs.readdirSync(path.dirname(skill)), ['review-kit']);
      const backups = fs.readdirSync(path.join(t.tmp, '.review-kit-backups'));
      assert.equal(backups.length, 1);
      assert.ok(backups[0].startsWith('claude-skill-'), backups[0]);
      const out = execFileSync(process.execPath, [path.join(ROOT, 'dist', 'cli.js'), 'home'],
        { env: { ...process.env, HOME: t.tmp }, encoding: 'utf-8' }).trim();
      assert.equal(out, ROOT);
      assert.equal((await run('setup')).code, 0);
    });
  }));

  test('setup --no-skill links nothing', withTmp(async (t) => {
    await withHome(t.tmp, async () => {
      const { code, out, err } = await run('setup', '--no-skill');
      assert.equal(code, 0, err);
      assert.ok(!out.includes('linked'), out);
      assert.ok(!fs.existsSync(path.join(t.tmp, '.claude')));
    });
    // setup is an explicit step: installing the package runs nothing
    const scripts = JSON.parse(read(path.join(ROOT, 'package.json'))).scripts || {};
    for (const hook of ['preinstall', 'install', 'postinstall']) assert.ok(!(hook in scripts), hook);
  }));

  test('setup --skills-dir (repeatable) --with-companions links the skill and the bundled companions', withTmp(async (t) => {
    const dirs = [path.join(t.tmp, 'a', 'skills'), path.join(t.tmp, 'b', 'skills')];
    await withHome(t.tmp, async () => {
      const { code, err } = await run('setup', '--skills-dir', dirs[0], '--skills-dir', dirs[1], '--with-companions');
      assert.equal(code, 0, err);
    });
    const names = ['ui-ux-pro-max', 'api-design-principles', 'architecture-patterns', 'error-handling-patterns'];
    for (const d of dirs) {
      assert.equal(realpath(path.join(d, 'review-kit')), realpath(path.join(ROOT, 'skill', 'review-kit')));
      for (const name of names) {
        assert.equal(realpath(path.join(d, name)), realpath(path.join(ROOT, 'skill', 'companions', name)), `${d}/${name}`);
      }
      assert.deepEqual(fs.readdirSync(d).sort(), ['review-kit', ...names].sort());
    }
    assert.ok(!fs.existsSync(path.join(t.tmp, '.claude')));
  }));
});
