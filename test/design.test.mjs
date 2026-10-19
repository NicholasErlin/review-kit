// Design options on git branches, in temporary repositories: option new -> commit -> option record -> adopt -> discard,
// plus the refusals (dirty tree, design branch, linked worktree), the conflict path and the patch fallback.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { read, run, withTmp } from './helpers.mjs';
import * as model from '../dist/model.js';
import * as git from '../dist/git.js';

function g(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** <tmp>/repo: a git repo with app.txt committed and a design review with one proposal (criteria clarity, cost). */
async function repo(t, { commitReview = false } = {}) {
  const root = path.join(t.tmp, 'repo');
  fs.mkdirSync(root);
  g(root, 'init', '-q', '-b', 'main');
  g(root, 'config', 'user.email', 'test@example.com');
  g(root, 'config', 'user.name', 'Test');
  g(root, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(root, 'app.txt'), 'line 1\nline 2\n');
  g(root, 'add', 'app.txt');
  g(root, 'commit', '-q', '-m', 'base');
  const dir = path.join(root, '.review', 'design');
  let r = await run('init', dir, '--kind', 'design', '--name', 'App');
  assert.equal(r.code, 0, r.err);
  const review = path.join(dir, 'review.json');
  r = await run('add-proposal', review, '--id', 'first-run', '--title', 'First run', '--brief', 'Decide',
    '--criterion', 'clarity=Clarity:3', '--criterion', 'cost=Cost');
  assert.equal(r.code, 0, r.err);
  if (commitReview) {
    g(root, 'add', '.review');
    g(root, 'commit', '-q', '-m', 'review');
  }
  return { root, dir, review, wtRoot: path.join(t.tmp, 'repo.designs') };
}

/** option new + a commit on the option branch that changes app.txt. */
async function option(env, id, content, title = id.toUpperCase()) {
  const r = await run('option', 'new', env.review, 'first-run', id, '--title', title);
  assert.equal(r.code, 0, r.err);
  const wt = path.join(env.wtRoot, `first-run--${id}`);
  fs.writeFileSync(path.join(wt, 'app.txt'), content);
  g(wt, 'commit', '-q', '-am', `option ${id}`);
  return { wt, out: r.out };
}

const proposal = (env) => model.load(env.review).proposals[0];

describe('DesignFlowTest', () => {
  test('option new -> commit -> record -> adopt -> discard', withTmp(async (t) => {
    const env = await repo(t);
    const baseSha = g(env.root, 'rev-parse', 'HEAD');
    const a = await option(env, 'a', 'line 1 from A\nline 2\n', 'Option A');
    assert.ok(a.out.includes(`worktree: ${fs.realpathSync(env.wtRoot)}/first-run--a`), a.out);
    assert.ok(a.out.includes('next: build the option there'), a.out);
    let o = proposal(env).options[0];
    assert.deepEqual(o, {
      id: 'a', title: 'Option A', status: 'proposed', branch: 'design/first-run/a', base: baseSha,
      worktree: '../repo.designs/first-run--a',
    });
    assert.equal(g(env.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main'); // the user's branch is untouched
    assert.equal(read(path.join(env.root, 'app.txt')), 'line 1\nline 2\n');

    // refusals
    let r = await run('option', 'new', env.review, 'first-run', 'a', '--title', 'Again');
    assert.equal(r.code, 1);
    assert.ok(r.err.includes('already has a branch'), r.err);
    r = await run('option', 'new', env.review, 'first-run', 'Bad_Id', '--title', 'x');
    assert.ok(r.err.includes('option id "Bad_Id" is not allowed'), r.err);
    r = await run('option', 'new', env.review, 'nope', 'x', '--title', 'x');
    assert.ok(r.err.includes('no proposal with id "nope"'), r.err);
    r = await run('option', 'new', env.review, 'first-run', 'x');
    assert.ok(r.err.includes('--title is required'), r.err);
    r = await run('option', 'new', env.review, 'first-run', 'x', '--title', 'x', '--base', 'no-such-ref');
    assert.ok(r.err.includes('"no-such-ref" is not a commit'), r.err);
    r = await run('option', 'new', env.review, 'first-run', 'x', '--title', 'x', '--base=--output=/tmp/x');
    assert.ok(r.err.includes('invalid git ref'), r.err);
    g(env.root, 'branch', 'design/first-run/taken');
    r = await run('option', 'new', env.review, 'first-run', 'taken', '--title', 'x');
    assert.ok(r.err.includes('branch design/first-run/taken already exists'), r.err);
    g(env.root, 'branch', '-D', 'design/first-run/taken');
    assert.equal(proposal(env).options.length, 1);

    // record: write-up, scores, a screenshot, and the diff snapshot (warning about uncommitted work)
    fs.writeFileSync(path.join(a.wt, 'scratch.txt'), 'not committed\n');
    const shot = t.png('shots/a-mobile.png');
    r = await run('option', 'record', env.review, 'first-run', 'a', '--summary', 'Changes line 1', '--reasoning', 'Simplest',
      '--pro', 'Small', '--con', 'Plain', '--score', 'clarity=4:Clear enough', '--score', 'cost=5', '--evidence', 'tests pass',
      '--shot', 'mobile', shot, 'First screen');
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes('snapshot diffs/first-run--a.patch: 1 file(s), +1 -1'), r.out);
    assert.ok(r.out.includes('warning: 1 uncommitted change(s) in the worktree are not in the snapshot'), r.out);
    o = proposal(env).options[0];
    assert.equal(o.head, g(env.root, 'rev-parse', 'design/first-run/a'));
    assert.deepEqual(o.diff, { path: 'diffs/first-run--a.patch', files: [{ path: 'app.txt', add: 1, del: 1 }], insertions: 1, deletions: 1 });
    assert.deepEqual(o.scores, { clarity: { score: 4, note: 'Clear enough' }, cost: { score: 5 } });
    assert.deepEqual(o.platforms.mobile.images, [{ src: 'screenshots/first-run--a/a-mobile.png', caption: 'First screen' }]);
    assert.ok(fs.existsSync(path.join(env.dir, 'screenshots', 'first-run--a', 'a-mobile.png')));
    const patch = read(path.join(env.dir, o.diff.path));
    assert.ok(patch.startsWith('diff --git a/app.txt b/app.txt'), patch);
    assert.ok(patch.includes('+line 1 from A'));
    r = await run('option', 'record', env.review, 'first-run', 'a', '--score', 'speed=3');
    assert.ok(r.err.includes('unknown criterion "speed"'), r.err);
    r = await run('option', 'record', env.review, 'first-run', 'a', '--score', 'cost=7');
    assert.ok(r.err.includes('whole number from 1 to 5'), r.err);
    r = await run('option', 'record', env.review, 'first-run', 'a', '--shot', 'tablet', shot);
    assert.ok(r.err.includes('unknown platform "tablet"'), r.err);
    r = await run('option', 'record', env.review, 'first-run', 'zz');
    assert.ok(r.err.includes('has no option "zz"'), r.err);
    fs.rmSync(path.join(a.wt, 'scratch.txt'));

    // a second option, then a recommendation
    await option(env, 'b', 'line 1\nline 2 from B\n');
    r = await run('option', 'record', 'design', 'first-run', 'b', '--reasoning', 'Other line', '-r', env.review);
    assert.equal(r.code, 1); // a kind and -r: ambiguous on purpose
    r = await run('option', 'record', env.review, 'first-run', 'b', '--reasoning', 'Other line', '--score', 'clarity=2', '--score', 'cost=2');
    assert.equal(r.code, 0, r.err);
    r = await run('recommend', env.review, 'first-run', 'a', '--reasoning', 'Clearer; b if line 2 matters');
    assert.equal(r.code, 0, r.err);

    // adopt refuses a dirty tree outside the review folders, but not changes inside them
    fs.writeFileSync(path.join(env.root, 'stray.txt'), 'x');
    r = await run('adopt', env.review, 'first-run', 'a');
    assert.equal(r.code, 1);
    assert.ok(r.err.includes('changes outside the review folders') && r.err.includes('stray.txt'), r.err);
    fs.rmSync(path.join(env.root, 'stray.txt'));
    g(env.root, 'switch', '-q', 'design/first-run/b', '--ignore-other-worktrees');
    r = await run('adopt', env.review, 'first-run', 'a');
    assert.ok(r.err.includes('is a design branch'), r.err);
    g(env.root, 'switch', '-q', 'main');

    r = await run('adopt', env.review, 'first-run', 'a');
    assert.equal(r.code, 0, r.err);
    const head = g(env.root, 'rev-parse', 'HEAD');
    assert.ok(r.out.includes(`committed ${head.slice(0, 7)} "Adopt design first-run: Option A"`), r.out);
    assert.equal(g(env.root, 'log', '-1', '--format=%s'), 'Adopt design first-run: Option A');
    assert.equal(g(env.root, 'rev-list', '--count', 'HEAD'), '2'); // squashed: one commit
    assert.equal(read(path.join(env.root, 'app.txt')), 'line 1 from A\nline 2\n');
    let pr = proposal(env);
    assert.equal(pr.status, 'adopted');
    assert.equal(pr.adopted.option, 'a');
    assert.equal(pr.adopted.commit, head);
    assert.deepEqual(pr.options.map((x) => x.status), ['adopted', 'rejected']);
    r = await run('adopt', env.review, 'first-run', 'b');
    assert.ok(r.err.includes('already adopted option "a"'), r.err);

    // discard: dry run first, then both (a is merged: its commit is in HEAD)
    r = await run('discard', env.review, 'first-run', '--dry-run');
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes('a: would remove worktree ../repo.designs/first-run--a'), r.out);
    assert.ok(r.out.includes('b: would remove branch design/first-run/b'), r.out);
    assert.ok(git.branchExists(env.root, 'design/first-run/b'));
    assert.equal(proposal(env).options[1].gone, undefined);
    r = await run('discard', env.review, 'first-run');
    assert.equal(r.code, 0, r.err);
    assert.ok(!git.branchExists(env.root, 'design/first-run/a') && !git.branchExists(env.root, 'design/first-run/b'));
    assert.ok(!fs.existsSync(path.join(env.wtRoot, 'first-run--a')) && !fs.existsSync(path.join(env.wtRoot, 'first-run--b')));
    pr = proposal(env);
    for (const x of pr.options) {
      assert.equal(x.gone, true);
      assert.equal(x.worktree, undefined);
      assert.ok(x.branch.startsWith('design/first-run/'));
      assert.ok(fs.existsSync(path.join(env.dir, x.diff.path)), 'snapshots stay');
    }
    assert.ok(fs.existsSync(path.join(env.dir, 'screenshots', 'first-run--a', 'a-mobile.png')));
    assert.equal((await run('validate', env.review)).code, 0);

    // clean never touches diffs (or anything git)
    r = await run('clean', env.review, '--orphans');
    assert.equal(r.code, 0, r.err);
    assert.ok(fs.existsSync(path.join(env.dir, 'diffs', 'first-run--a.patch')));
    assert.ok(fs.existsSync(path.join(env.dir, 'screenshots', 'first-run--a', 'a-mobile.png')));

    // the built site has the snapshot text, not the worktree or any absolute path
    r = await run('build', env.review);
    assert.equal(r.code, 0, r.err);
    const js = read(path.join(env.dir, 'site', 'data.js'));
    assert.ok(js.includes('+line 1 from A'));
    assert.ok(!js.includes(t.tmp) && !js.includes(fs.realpathSync(t.tmp)) && !js.includes('repo.designs'));
    assert.ok(js.includes('"gone":true'));
  }));

  test('adopt --no-commit stages; discard keeps an adopted option until it is committed', withTmp(async (t) => {
    const env = await repo(t);
    await option(env, 'a', 'A\n');
    await option(env, 'b', 'B\n');
    const r = await run('adopt', env.review, 'first-run', 'b', '--no-commit');
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes('changes are staged, not committed'), r.out);
    assert.equal(g(env.root, 'diff', '--cached', '--name-only'), 'app.txt');
    assert.equal(proposal(env).adopted.commit, undefined);
    const d = await run('discard', env.review, 'first-run');
    assert.equal(d.code, 0, d.err);
    assert.ok(git.branchExists(env.root, 'design/first-run/b'), 'not committed yet: kept');
    assert.ok(!git.branchExists(env.root, 'design/first-run/a'));
    const e = await run('discard', env.review, 'first-run', '--option', 'b');
    assert.equal(e.code, 0, e.err);
    assert.ok(!git.branchExists(env.root, 'design/first-run/b'), '--option names it explicitly');
  }));

  test('adopt with a custom message, and from staged review files', withTmp(async (t) => {
    const env = await repo(t, { commitReview: true });
    await option(env, 'a', 'A\n');
    g(env.root, 'add', '.review');
    fs.writeFileSync(path.join(env.root, '.review', 'design', 'notes.md'), 'x');
    g(env.root, 'add', '.review/design/notes.md');
    let r = await run('adopt', env.review, 'first-run', 'a');
    assert.ok(r.err.includes('.review/design/notes.md (staged)'), r.err);
    g(env.root, 'reset', '-q');
    r = await run('adopt', env.review, 'first-run', 'a', '-m', 'Use option A');
    assert.equal(r.code, 0, r.err);
    assert.equal(g(env.root, 'log', '-1', '--format=%s'), 'Use option A');
    assert.equal(g(env.root, 'show', '--name-only', '--format=', 'HEAD'), 'app.txt', 'review files are not swept into the commit');
  }));

  test('conflict: git state is left, adoption not recorded, then --record-only', withTmp(async (t) => {
    const env = await repo(t);
    await option(env, 'a', 'line 1 from A\nline 2\n');
    fs.writeFileSync(path.join(env.root, 'app.txt'), 'line 1 on main\nline 2\n');
    g(env.root, 'commit', '-q', '-am', 'main moves on');
    const before = read(env.review);
    let r = await run('adopt', env.review, 'first-run', 'a');
    assert.equal(r.code, 1);
    assert.ok(r.err.includes('conflicts in:\n  app.txt'), r.err);
    assert.ok(r.err.includes('git reset --merge') && r.err.includes('`git merge --abort` does not work'), r.err);
    assert.ok(r.err.includes('--record-only'), r.err);
    assert.equal(read(env.review), before, 'adoption not recorded');
    assert.deepEqual(git.conflicts(env.root), ['app.txt']);
    // resolve by hand and record
    fs.writeFileSync(path.join(env.root, 'app.txt'), 'line 1 merged\nline 2\n');
    g(env.root, 'add', 'app.txt');
    g(env.root, 'commit', '-q', '-m', 'adopt a by hand');
    r = await run('adopt', env.review, 'first-run', 'a', '--record-only');
    assert.equal(r.code, 0, r.err);
    assert.equal(proposal(env).adopted.commit, g(env.root, 'rev-parse', 'HEAD'));
    assert.equal(proposal(env).options[0].status, 'adopted');
  }));

  test('conflict can be undone with git reset --merge', withTmp(async (t) => {
    const env = await repo(t);
    await option(env, 'a', 'line 1 from A\nline 2\n');
    fs.writeFileSync(path.join(env.root, 'app.txt'), 'line 1 on main\nline 2\n');
    g(env.root, 'commit', '-q', '-am', 'main moves on');
    assert.equal((await run('adopt', env.review, 'first-run', 'a')).code, 1);
    g(env.root, 'reset', '--merge');
    assert.equal(read(path.join(env.root, 'app.txt')), 'line 1 on main\nline 2\n');
    assert.deepEqual(git.conflicts(env.root), []);
  }));

  test('a gone branch falls back to the diff snapshot', withTmp(async (t) => {
    const env = await repo(t);
    const a = await option(env, 'a', 'line 1 from A\nline 2\n');
    fs.writeFileSync(path.join(a.wt, 'new.txt'), 'new file\n');
    g(a.wt, 'add', 'new.txt');
    g(a.wt, 'commit', '-q', '-m', 'add file');
    assert.equal((await run('option', 'record', env.review, 'first-run', 'a')).code, 0);
    let r = await run('discard', env.review, 'first-run', '--option', 'a');
    assert.equal(r.code, 0, r.err);
    r = await run('option', 'record', env.review, 'first-run', 'a', '--summary', 'still editable');
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes('warning: branch design/first-run/a not found; kept the existing diff snapshot'), r.out);
    r = await run('adopt', env.review, 'first-run', 'a');
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes('branch design/first-run/a is gone; applied diffs/first-run--a.patch instead'), r.out);
    assert.equal(read(path.join(env.root, 'app.txt')), 'line 1 from A\nline 2\n');
    assert.equal(read(path.join(env.root, 'new.txt')), 'new file\n');
    assert.equal(g(env.root, 'status', '--porcelain', '--', 'app.txt', 'new.txt'), '');
  }));

  test('the diff snapshot is capped; a truncated snapshot cannot be adopted', withTmp(async (t) => {
    const env = await repo(t);
    const r0 = await run('option', 'new', env.review, 'first-run', 'big', '--title', 'Big');
    assert.equal(r0.code, 0, r0.err);
    const wt = path.join(env.wtRoot, 'first-run--big');
    fs.writeFileSync(path.join(wt, 'big.txt'), ('y'.repeat(79) + '\n').repeat(8000)); // 640 KB
    fs.writeFileSync(path.join(wt, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 0]));
    g(wt, 'add', '.');
    g(wt, 'commit', '-q', '-m', 'big');
    let r = await run('option', 'record', env.review, 'first-run', 'big');
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes('(truncated at 400 KB)'), r.out);
    const o = proposal(env).options[0];
    assert.equal(o.diff.truncated, true);
    assert.deepEqual(o.diff.files.find((f) => f.path === 'blob.bin'), { path: 'blob.bin', add: 0, del: 0, binary: true });
    assert.equal(o.diff.insertions, 8000);
    const size = fs.statSync(path.join(env.dir, o.diff.path)).size;
    assert.ok(size <= model.DIFF_CAP && size > model.DIFF_CAP - 100, String(size));
    assert.ok(!read(path.join(env.dir, o.diff.path)).includes('\0'), 'no binary content');
    r = await run('discard', env.review, 'first-run', '--option', 'big');
    assert.equal(r.code, 0, r.err);
    r = await run('adopt', env.review, 'first-run', 'big');
    assert.ok(r.err.includes('was truncated; it cannot be applied'), r.err);
  }));

  test('discard passes on a dirty worktree unless --force', withTmp(async (t) => {
    const env = await repo(t);
    const a = await option(env, 'a', 'A\n');
    fs.writeFileSync(path.join(a.wt, 'app.txt'), 'dirty\n');
    let r = await run('discard', env.review, 'first-run');
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes('a: kept worktree ../repo.designs/first-run--a') && r.out.includes('pass --force'), r.out);
    assert.ok(git.branchExists(env.root, 'design/first-run/a'));
    assert.equal(proposal(env).options[0].gone, undefined);
    r = await run('discard', env.review, 'first-run', '--force');
    assert.equal(r.code, 0, r.err);
    assert.ok(!fs.existsSync(a.wt) && !git.branchExists(env.root, 'design/first-run/a'));
    assert.equal(proposal(env).options[0].gone, true);
  }));

  test('refuses outside git, inside a linked worktree, and with a nested --worktree-root it warns', withTmp(async (t) => {
    const dir = path.join(t.tmp, 'plain', '.review', 'design');
    await run('init', dir, '--kind', 'design');
    const review = path.join(dir, 'review.json');
    await run('add-proposal', review, '--id', 'p', '--title', 'P');
    let r = await run('option', 'new', review, 'p', 'a', '--title', 'A');
    assert.equal(r.code, 1);
    assert.ok(r.err.includes('is not inside a git repository'), r.err);

    const env = await repo(t, { commitReview: true });
    const a = await option(env, 'a', 'A\n');
    const copy = path.join(a.wt, '.review', 'design', 'review.json');
    assert.ok(fs.existsSync(copy));
    r = await run('option', 'record', copy, 'first-run', 'a');
    // the copy in the worktree predates option a, so it fails on the missing option or on the worktree check
    assert.equal(r.code, 1);
    r = await run('add-proposal', copy, '--id', 'other', '--title', 'x');
    assert.equal(r.code, 0, r.err);
    r = await run('option', 'new', copy, 'other', 'x', '--title', 'x');
    assert.ok(r.err.includes('inside a linked worktree'), r.err);

    r = await run('option', 'new', env.review, 'first-run', 'nested', '--title', 'N', '--worktree-root', path.join(env.root, 'wt'));
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes('warning: the worktree is inside the repository'), r.out);
    assert.equal(proposal(env).options[1].worktree, 'wt/first-run--nested');
  }));
});

describe('GitHelpersTest', () => {
  test('numstat parsing handles renames and binary files', () => {
    const out = '3\t1\tsrc/a.ts\0-\t-\timg.png\0' + '0\t0\t\0old name.txt\0new name.txt\0';
    assert.deepEqual(git.parseNumstat(out), [
      { path: 'src/a.ts', add: 3, del: 1 },
      { path: 'img.png', add: 0, del: 0, binary: true },
      { path: 'new name.txt', add: 0, del: 0 },
    ]);
  });
});

describe('DesignDefaultReviewTest', () => {
  test('option new without a review argument finds the design review and names it in the next step', withTmp(async (t) => {
    const env = await repo(t);
    await run('init', path.join(env.root, '.review', 'ideas'), '--kind', 'ideas');
    const cwd = process.cwd();
    process.chdir(env.root);
    try {
      let r = await run('option', 'new', 'first-run', 'plain', '--title', 'Plain');
      assert.equal(r.code, 0, r.err);
      assert.ok(r.out.includes('then: review-kit option record design first-run plain --summary'), r.out);
      assert.equal(proposal(env).options[0].branch, 'design/first-run/plain');
      r = await run('option', 'record', 'first-run', 'plain', '--reasoning', 'Why');
      assert.equal(r.code, 0, r.err);
      fs.rmSync(path.join(env.root, '.review', 'ideas'), { recursive: true });
      r = await run('option', 'new', 'first-run', 'bold', '--title', 'Bold');
      assert.equal(r.code, 0, r.err);
      assert.ok(r.out.includes('then: review-kit option record first-run bold --summary'), r.out);
    } finally {
      process.chdir(cwd);
    }
  }));
});
