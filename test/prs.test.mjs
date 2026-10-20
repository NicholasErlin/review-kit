import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { run, withTmp, ROOT, read, stopServer, quietly } from './helpers.mjs';
import * as prs from '../dist/prs.js';
import * as gh from '../dist/gh.js';
import * as build from '../dist/build.js';
import { createLiveHandler } from '../dist/serve.js';

const EXAMPLE = path.join(ROOT, 'examples/prs');
const sample = () => JSON.parse(read(path.join(EXAMPLE, 'review.json')));
function setup(t) {
  fs.cpSync(EXAMPLE, path.join(t.tmp, 'prs'), { recursive: true, filter: (p) => path.basename(p) !== 'site' });
  const base = path.join(t.tmp, 'prs'), review = path.join(base, 'review.json'), log = path.join(t.tmp, 'calls.jsonl');
  process.env.REVIEW_KIT_GH = path.join(ROOT, 'test/fake-gh.mjs');
  process.env.REVIEW_KIT_GH_DATA = review;
  process.env.REVIEW_KIT_GH_LOG = log;
  gh.resetReady();
  return { base, review, log, calls: () => fs.existsSync(log) ? read(log).trim().split('\n').map(JSON.parse) : [] };
}
const pr = (data, n = 142) => data.prs.find((p) => p.number === n);
const ghData = () => ({ fetched: new Date().toISOString(), state: 'OPEN', headSha: 'head', base: 'main', mergeState: 'CLEAN', checks: [], threads: [], reviews: [], reviewRequests: [], viewer: 'sam', author: 'lee' });

describe('PR dashboard', () => {
  test('refs, adding, discovery by role, duplicates and user-owned fields', withTmp(async (t) => {
    const env = setup(t), out = path.join(t.tmp, 'new');
    let r = await run('init', out, '--kind', 'prs'); assert.equal(r.code, 0, r.err);
    async function cli(...args) { const r = await run('pr', ...args, '-r', out); assert.equal(r.code, 0, r.err); return r; }
    await cli('add', 'https://github.com/acme/web/pull/142', '--priority', '2', '--next', 'Fix CI');
    await cli('add', 'nimbus/cli#31');
    await cli('add', 'acme/web', '145');
    await cli('add', '--mine', '--repo', 'acme/api');
    await cli('add', '--requested', '--repo', 'acme/web');
    await cli('add', 'nimbus/cli#36', '--reviewing');
    let d = JSON.parse(read(path.join(out, 'review.json')));
    assert.equal(pr(d).priority, 2); assert.equal(pr(d).next, 'Fix CI'); assert.equal(pr(d, 150).role, 'reviewing'); assert.equal(pr(d, 36).role, 'reviewing');
    assert.equal(d.prs.length, 6);
    await cli('add', 'acme/web#142');
    await cli('set', 'acme-web-142', '--notes', 'Keep these notes', '--depends', 'acme-api-88');
    await cli('sync');
    d = JSON.parse(read(path.join(out, 'review.json')));
    assert.equal(pr(d).notes, 'Keep these notes'); assert.deepEqual(pr(d).dependsOn, ['acme-api-88']);
    assert.equal(pr(d).gh.checks[0].runId, 7001);
    assert.ok((await cli('list')).out.includes('acme-web-142'));
    assert.ok(!(read(path.join(out, 'review.json')).includes(t.tmp)));
    assert.equal((await run('summary', out)).code, 0);
    await cli('remove', 'acme-web-142');
    assert.equal(JSON.parse(read(path.join(out, 'review.json'))).prs.length, 5);
    assert.deepEqual(env.calls(), []);
    assert.deepEqual(gh.mutations.rerun('acme/web', 99999999999).args, ['run', 'rerun', '99999999999', '--failed', '-R', 'acme/web']);
    for (const bad of ['-R', 'https://example.com/a/b/pull/1', 'acme/web#0']) assert.throws(() => gh.parseRef(bad));
  }));
  test('CLI actions and reviewing commands persist, dry-run stdout is exact JSON', withTmp(async (t) => {
    const env = setup(t);
    const cli = async (...args) => { const r = await run('pr', ...args, '-r', env.review); assert.equal(r.code, 0, r.err); return r; };
    const id = 'acme-web-142';
    await cli('comment', id, '--body', 'CLI comment');
    await cli('reply', id, 'PRRT_web142_a', '--body', 'CLI reply');
    await cli('resolve', id, 'PRRT_web142_a'); await cli('resolve', id, 'PRRT_web142_a', '--unresolve');
    await cli('rerun', id, '--all'); await cli('update-branch', id, '--rebase');
    await cli('ready', id, '--undo'); await cli('ready', id);
    await cli('request', id, '--reviewers', 'alice,bob');
    await cli('close', id); await cli('reopen', id); await cli('merge', id, '--merge');
    assert.equal(env.calls().length, 12);
    const reviewing = 'acme-web-150';
    await cli('finding', reviewing, '--title', 'CLI draft', '--body', 'Please fix this.', '--finding', 'cli', '--path', 'src/cart/applyCoupon.ts', '--line', '5');
    await cli('finding', reviewing, '--update', '--finding', 'cli', '--body', 'Please fix the URL.');
    await cli('flag', reviewing, 'cli'); await cli('flag', reviewing, 'f-1,f-2', '--off');
    await cli('finding', reviewing, '--drop', 'f-4'); await cli('verdict', reviewing, '--event', 'COMMENT', '--body', 'CLI verdict');
    const dry = await cli('ship', reviewing, '--dry-run'); const payload = JSON.parse(dry.out); assert.equal(payload.comments.length, 1);
    assert.equal(env.calls().length, 12); await cli('ship', reviewing);
    assert.deepEqual(JSON.parse(env.calls().at(-1).input), payload);
    assert.equal(JSON.parse(read(env.review)).prs.find((p) => p.id === reviewing).findings.find((f) => f.id === 'cli').status, 'posted');
    await cli('set', reviewing, '--priority', '-1'); assert.equal(pr(JSON.parse(read(env.review)), 150).priority, -1);
  }));
  test('gh paginates review threads and their comments; GraphQL errors fail', withTmp(async (t) => {
    setup(t); process.env.REVIEW_KIT_GH_PAGE_SIZE = '1';
    try { const threads = gh.prThreads({ repo: 'acme/web', number: 142 }); assert.equal(threads.length, 3); assert.equal(threads.find((t) => t.id === 'PRRT_web142_b').comments.nodes.length, 2); }
    finally { delete process.env.REVIEW_KIT_GH_PAGE_SIZE; }
    process.env.REVIEW_KIT_GH_GRAPHQL_ERROR = '1';
    try { assert.throws(() => gh.prThreads({ repo: 'acme/web', number: 142 }), /fixture GraphQL failure/); assert.throws(() => gh.exec(gh.mutations.reply('PRRT_web142_a', 'x')), /fixture GraphQL failure/); }
    finally { delete process.env.REVIEW_KIT_GH_GRAPHQL_ERROR; }
    const lines = prs.diffLines('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n');
    assert.deepEqual([...lines.get('a').LEFT], [1]); assert.deepEqual([...lines.get('a').RIGHT], [1]);
  }));
  test('all mine blockers, groups, age and sorting', () => {
    const g = ghData(), p = { id: 'a', gh: g };
    assert.equal(prs.status(p).group, 'ready');
    const cases = [
      [{ draft: true }, 'draft', 'draft'], [{ mergeable: 'CONFLICTING' }, 'conflicts', 'action'], [{ mergeState: 'DIRTY' }, 'conflicts', 'action'],
      [{ checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] }, 'checks-failed', 'action'],
      [{ reviewDecision: 'CHANGES_REQUESTED', reviews: [{ author: 'alice', state: 'CHANGES_REQUESTED' }] }, 'changes-requested', 'action'],
      [{ threads: [{ resolved: false }] }, 'threads', 'action'], [{ mergeState: 'BEHIND' }, 'behind', 'action'],
      [{ checks: [{ status: 'IN_PROGRESS' }] }, 'checks-pending', 'waiting'], [{ reviewDecision: 'REVIEW_REQUIRED', reviewRequests: ['bob'] }, 'review-required', 'waiting'],
      [{ fetched: '2000-01-01' }, 'stale', 'ready'], [{ mergeState: 'BLOCKED' }, 'blocked', 'waiting'],
    ];
    for (const [fields, code, group] of cases) { const s = prs.status({ ...p, gh: { ...g, ...fields } }); assert.equal(s.group, group, code); assert.ok(s.blockers.some((b) => b.code === code), code); }
    for (const state of ['MERGED', 'CLOSED']) assert.equal(prs.status({ gh: { ...g, state } }).group, state.toLowerCase());
    assert.equal(prs.status({}).group, 'waiting');
    assert.equal(prs.status({ ...p, dependsOn: ['missing'] }).group, 'waiting');
    assert.equal(prs.status({ ...p, dependsOn: ['b'] }, new Map([['b', { gh: { state: 'MERGED' } }]])).group, 'ready');
    assert.equal(prs.status({ gh: { ...g, fetched: new Date(Date.now() - 2 * 3600000).toISOString() } }).stale, 'soft');
    const d = { prs: [{ ...p, id: 'a', priority: 2 }, { ...p, id: 'b', priority: 1 }, { id: 'c', gh: { ...g, mergeState: 'BEHIND' } }] };
    assert.deepEqual(prs.boardOrder(d).map((p) => p.id), ['c', 'b', 'a']);
  });
  test('all reviewing groups, blockers and stale findings', () => {
    const p = { role: 'reviewing', gh: ghData(), findings: [] };
    assert.equal(prs.status(p).group, 'to-review');
    p.gh.reviewRequests = ['sam']; assert.match(prs.status(p).blockers[0].text, /requested/);
    p.findings = [{ id: 'f-1', status: 'draft', sha: 'old' }]; assert.equal(prs.status(p).group, 'in-review');
    assert.ok(prs.status(p).blockers.some((b) => b.code === 'stale-findings'));
    p.findings[0].ship = true; assert.equal(prs.status(p).group, 'to-ship');
    p.findings = []; p.gh.reviews = [{ author: 'sam', state: 'COMMENTED', commit: 'head' }]; assert.equal(prs.status(p).group, 'waiting-author');
    p.gh.reviews[0].state = 'CHANGES_REQUESTED'; assert.equal(prs.status(p).group, 'waiting-author');
    p.gh.headSha = 'new'; assert.equal(prs.status(p).group, 'updated');
    p.gh.headSha = 'head'; p.gh.reviews[0].state = 'APPROVED'; assert.equal(prs.status(p).group, 'done');
    p.gh.state = 'MERGED'; assert.equal(prs.status(p).group, 'done');
    p.gh.state = 'CLOSED'; assert.equal(prs.status(p).group, 'done');
  });
  test('sync skips closed, preserves fields and failures, caps diffs', withTmp(async (t) => {
    const env = setup(t), d = sample();
    const original = structuredClone(pr(d, 85).gh);
    assert.ok(prs.sync(env.base, d).find((r) => r.id === 'acme-api-85').skipped);
    assert.deepEqual(pr(d, 85).gh, original);
    assert.equal(prs.sync(env.base, d, ['acme-api-85'])[0].skipped, true);
    assert.ok(!prs.sync(env.base, d, [], true).find((r) => r.id === 'acme-api-85').skipped);
    process.env.REVIEW_KIT_GH_FAIL = 'view'; const old = structuredClone(pr(d).gh); assert.equal(prs.sync(env.base, d, ['acme-web-142'])[0].ok, false); assert.deepEqual(pr(d).gh, old); delete process.env.REVIEW_KIT_GH_FAIL;
    fs.writeFileSync(path.join(env.base, 'diffs/acme-web-142.diff'), 'x\n'.repeat(prs.PR_DIFF_CAP));
    const out = path.join(t.tmp, 'capped-site'); await quietly(() => build.buildAny([env.review], out));
    const js = read(path.join(out, 'data.js')); const compiled = JSON.parse(js.slice(js.indexOf('=') + 1).trim().replace(/;$/, ''));
    const asset = compiled.prs.find((p) => p.number === 142).diff; assert.ok(fs.statSync(path.join(out, asset.raw.split('?')[0])).size <= prs.PR_DIFF_CAP);
    const unsafe = path.join(t.tmp, 'unsafe'); fs.mkdirSync(unsafe); fs.symlinkSync(env.base, path.join(unsafe, 'diffs'));
    assert.throws(() => prs.fetchInto(unsafe, pr(d)), /stay inside/);
    prs.fetchInto(env.base, pr(d)); assert.equal(pr(d).gh.diffTruncated, true); assert.ok(fs.statSync(path.join(env.base, pr(d).gh.diff)).size <= prs.PR_DIFF_CAP);
  }));
  test('every action has exact argv and stdin; thread ownership is checked', withTmp(async (t) => {
    const env = setup(t), d = sample(), id = 'acme-web-142', thread = 'PRRT_web142_a';
    const cases = [
      ['comment', { body: "hello ' $(bad)" }, ['pr', 'comment', '142', '-R', 'acme/web', '--body-file', '-'], "hello ' $(bad)"],
      ['reply', { thread, body: 'reply' }, ['api', 'graphql', '-f', `query=${gh.REPLY_MUTATION}`, '-f', `thread=${thread}`, '-f', 'body=reply']],
      ['resolve', { thread }, ['api', 'graphql', '-f', `query=${gh.RESOLVE_MUTATION}`, '-f', `thread=${thread}`]],
      ['resolve', { thread, unresolve: true }, ['api', 'graphql', '-f', `query=${gh.UNRESOLVE_MUTATION}`, '-f', `thread=${thread}`]],
      ['rerun', {}, ['run', 'rerun', '7001', '--failed', '-R', 'acme/web']], ['rerun', { all: true }, ['run', 'rerun', '7001', '-R', 'acme/web']],
      ['update-branch', { rebase: true }, ['pr', 'update-branch', '142', '-R', 'acme/web', '--rebase']],
      ['ready', {}, ['pr', 'ready', '142', '-R', 'acme/web']], ['ready', { undo: true }, ['pr', 'ready', '142', '-R', 'acme/web', '--undo']],
      ['request', { reviewers: ['alice', 'acme/team'] }, ['pr', 'edit', '142', '-R', 'acme/web', '--add-reviewer', 'alice,acme/team']],
      ['close', {}, ['pr', 'close', '142', '-R', 'acme/web']], ['reopen', {}, ['pr', 'reopen', '142', '-R', 'acme/web']],
      ['merge', { method: 'squash', auto: true, deleteBranch: true }, ['pr', 'merge', '142', '-R', 'acme/web', '--squash', '--auto', '--delete-branch']],
    ];
    for (const [action, args, argv, input = ''] of cases) { prs.act(env.base, d, id, action, args); assert.deepEqual(env.calls().at(-1), { argv, input }); }
    for (const method of ['merge', 'rebase']) assert.ok(prs.plan(pr(d), 'merge', { method })[0].args.includes('--' + method));
    assert.throws(() => prs.plan(pr(d), 'reply', { thread: 'PRRT_foreign', body: 'x' }), /belong/);
    assert.throws(() => prs.plan(pr(d), 'request', { reviewers: ['--bad'] }));
    assert.throws(() => prs.plan(pr(d), 'merge', { method: 'evil' }));
  }));
  test('findings CRUD, exact ship payload, stale and off-diff fallback, own-PR refusals', withTmp(async (t) => {
    const env = setup(t), d = sample(), p = pr(d, 150); p.gh.viewer = 'sam'; p.findings = [];
    const f = prs.upsertFinding(p, { title: 'Encode', body: 'Use encodeURIComponent.', path: 'src/cart/applyCoupon.ts', line: 5, ship: true });
    prs.upsertFinding(p, { id: f.id, title: 'Encode URL' }, true);
    const off = prs.upsertFinding(p, { title: 'Missing', body: 'Keep this too.', path: 'gone.ts', line: 100, ship: true });
    prs.upsertFinding(p, { title: 'General', body: 'General comment.', ship: true });
    const stale = prs.upsertFinding(p, { title: 'Stale', body: 'Recheck.', path: f.path, line: 5, ship: true }); stale.sha = 'old';
    const drop = prs.upsertFinding(p, { title: 'Drop', body: 'Do not send.' }); prs.drop(p, drop.id);
    prs.flag(p, [off.id], false); prs.flag(p, [off.id]);
    prs.setVerdict(p, 'REQUEST_CHANGES', 'Please fix.');
    const plan = prs.ship(env.base, d, p.id, true).plan;
    assert.deepEqual(plan.payload, { commit_id: p.gh.headSha, event: 'REQUEST_CHANGES', body: 'Please fix.\n\n---\n\n**`gone.ts` line 100** (the file is not in the diff):\n\nKeep this too.\n\n---\n\nGeneral comment.\n\n---\n\n**`src/cart/applyCoupon.ts` line 5** (the head commit changed; re-check this location):\n\nRecheck.\n\n_(Written against old; the code may have changed since.)_', comments: [{ path: f.path, line: 5, side: 'RIGHT', body: f.body }] });
    assert.equal(env.calls().length, 0);
    prs.upsertFinding(p, { id: stale.id, body: 'Recheck.' }, true); assert.equal(stale.sha, 'old', 'text editing alone does not verify a moved location');
    const result = prs.ship(env.base, d, p.id);
    assert.equal(result.synced, true);
    assert.deepEqual(env.calls()[0], { argv: ['api', 'repos/acme/web/pulls/150/reviews', '-X', 'POST', '--input', '-'], input: JSON.stringify(plan.payload) });
    assert.equal(f.status, 'posted'); assert.equal(f.posted.reviewId, 123); assert.equal(f.ship, false); assert.equal(p.verdict, undefined);
    assert.throws(() => prs.flag(p, [f.id]), /posted/);
    assert.throws(() => prs.reviewPayload(env.base, p), /nothing to send/);
    p.gh.author = 'sam'; for (const event of ['APPROVE', 'REQUEST_CHANGES']) { prs.setVerdict(p, event, 'Summary'); assert.throws(() => prs.ship(env.base, d, p.id, true), /own PR/); }
    for (const bad of ['/tmp/a', 'C:\\private', '../a', '..\\a']) assert.throws(() => prs.upsertFinding(p, { title: 'x', body: 'x', path: bad }));
  }));
  test('validation, sanitization, CSP and no absolute paths in published data', withTmp(async (t) => {
    const env = setup(t), d = sample(); pr(d, 150).gh.viewer = 'sam'; pr(d).notes = '<script>alert(1)</script>'; fs.writeFileSync(env.review, JSON.stringify(d));
    const out = path.join(t.tmp, 'site'); await quietly(() => build.buildAny([env.review], out));
    assert.match(read(path.join(out, 'index.html')), /connect-src 'none'/);
    for (const name of ['data.js', 'app.js', 'index.html']) assert.ok(!read(path.join(out, name)).includes(t.tmp), name);
    assert.ok(!read(env.review).includes(t.tmp));
    const errors = [], warnings = []; prs.semantic({ ...d, prs: [...d.prs, { ...pr(d), id: 'dup', dependsOn: ['nope'] }, { id: 'unsynced', repo: 'a/b', number: 1, url: 'https://github.com/a/b/pull/1' }] }, env.base, true, errors, warnings, Date.now() + 3 * 86400000);
    assert.ok(warnings.some((w) => w.includes('also on'))); assert.ok(warnings.some((w) => w.includes('dependsOn'))); assert.ok(warnings.some((w) => w.includes('never synced'))); assert.ok(warnings.some((w) => w.includes('last synced')));
  }));
});

function fetchRaw(url, opts = {}) {
  return new Promise((resolve, reject) => { const req = http.request(url, { method: opts.method, headers: opts.headers, agent: false }, (res) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, ok: res.statusCode < 400, headers: new Headers(res.headers), json: async () => JSON.parse(text), text: async () => text }); }); }); req.on('error', reject); req.end(opts.body); });
}
async function server(t, host = '127.0.0.1', extra = {}) {
  const env = setup(t), out = path.join(t.tmp, 'site');
  await quietly(() => build.buildAny([env.review], out));
  const api = createLiveHandler(out, host, { reviewPath: [env.review], ...extra });
  const s = http.createServer(api.handler); await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + s.address().port;
  const session = await (await fetch(base + '/api/session')).json();
  const post = async (action, args = {}, headers = {}) => {
    const response = await fetchRaw(base + '/api/prs/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Review-Kit-Token': session.token || '', ...headers }, body: typeof args === 'string' ? args : JSON.stringify({ review: 'prs', id: 'acme-web-142', ...args }) });
    return { status: response.status, data: await response.json() };
  };
  return { ...env, base, s, out, session, post, close: async () => { api.close(); await stopServer(s); } };
}
describe('PR live API', () => {
  test('every security rejection, served CSP and version; successful action rebuilds', withTmp(async (t) => {
    const env = await server(t);
    try {
      const { post } = env;
      assert.equal(env.session.actions, true); assert.match(env.session.token, /^[a-f0-9]{64}$/);
      for (const [action, body, headers] of [
        ['comment', { body: 'x' }, { 'X-Review-Kit-Token': '' }], ['comment', { body: 'x' }, { 'X-Review-Kit-Token': 'a'.repeat(64) }],
        ['comment', { body: 'x' }, { 'X-Review-Kit-Token': 'é'.repeat(64) }], ['comment', { body: 'x' }, { Origin: 'https://evil.example' }],
        ['comment', { body: 'x' }, { Host: 'evil.example' }], ['comment', { body: 'x' }, { Host: '[::1]evil' }], ['comment', { body: 'x' }, { 'Content-Type': 'text/plain' }],
        ['comment', { body: 'x'.repeat(65536) }], ['comment', { id: 'unknown', body: 'x' }], ['unknown', {}], ['comment', { review: '../private', body: 'x' }],
      ]) { const r = await post(action, body, headers); assert.equal(r.status, 403, JSON.stringify([action, body.id, headers, r])); }
      assert.equal((await post('comment', '{')).status, 400);
      assert.equal((await post('reply', { thread: 'PRRT_foreign', body: 'x' })).status, 400);
      assert.equal((await post('comment', { body: '' })).status, 400);
      assert.equal(env.calls().length, 0);
      const foreign = await fetchRaw(env.base + '/api/session', { headers: { Host: 'evil.example' } }); assert.deepEqual(await foreign.json(), { actions: false }); assert.equal(foreign.headers.get('access-control-allow-origin'), null);
      const response = await fetch(env.base); assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/); assert.match(await response.text(), /connect-src 'self'/); assert.match(read(path.join(env.out, 'index.html')), /connect-src 'none'/);
      const before = await (await fetch(env.base + '/api/version')).json(); assert.ok(before.built);
      const r = await post('comment', { body: 'Live hello' }, { Origin: env.base }); assert.equal(r.status, 200, JSON.stringify(r)); assert.equal(r.data.pr.comments.at(-1).html.includes('Live hello'), true);
      const after = await (await fetch(env.base + '/api/version')).json(); assert.ok(after.built >= before.built);
      assert.deepEqual(env.calls()[0].argv, ['pr', 'comment', '142', '-R', 'acme/web', '--body-file', '-']);
      assert.equal((await post('sync', { id: undefined })).status, 200);
      process.env.REVIEW_KIT_GH_FAIL = 'comment'; const failed = await post('comment', { body: 'x' }); delete process.env.REVIEW_KIT_GH_FAIL; assert.equal(failed.status, 400); assert.match(failed.data.error, /fixture failure/);
    } finally { await env.close(); }
  }));
  test('reviewing API: finding, flag, drop, verdict, ship dry-run then one review', withTmp(async (t) => {
    const env = await server(t);
    try {
      const id = 'acme-web-150', post = (action, args) => env.post(action, { id, ...args });
      assert.equal((await post('finding', { title: 'New', body: 'Exact wording' })).status, 200);
      assert.equal((await post('finding', { finding: 'f-5', title: 'Updated', body: 'Precise wording' })).status, 200);
      assert.equal((await post('flag', { findings: ['f-5'], ship: true })).status, 200);
      assert.equal((await post('drop', { finding: 'f-4' })).status, 200);
      assert.equal((await post('verdict', { event: 'REQUEST_CHANGES', body: 'Fix these.' })).status, 200);
      const preview = await post('ship', { dryRun: true }); assert.equal(preview.status, 200, JSON.stringify(preview)); assert.equal(env.calls().length, 0);
      assert.equal((await post('ship', { expectedPayload: { event: 'APPROVE' } })).status, 400);
      assert.equal(env.calls().length, 0);
      const shipped = await post('ship', { expectedPayload: preview.data.payload }); assert.equal(shipped.status, 200, JSON.stringify(shipped)); assert.equal(shipped.data.pr.findings.find((f) => f.id === 'f-5').status, 'posted'); assert.equal(env.calls().length, 1); assert.deepEqual(JSON.parse(env.calls()[0].input), preview.data.payload);
      const set = await env.post('set', { priority: 1, next: 'Test', notes: 'Saved' }); assert.equal(set.status, 200); assert.equal(set.data.pr.next, 'Test');
    } finally { await env.close(); }
  }));
  test('LAN actions off, explicit override still rejects foreign Host; background sync', withTmp(async (t) => {
    const env = await server(t, '0.0.0.0');
    try { assert.deepEqual(env.session, { actions: false }); assert.equal((await env.post('comment', { body: 'x' })).status, 403); assert.match((await fetch(env.base)).headers.get('content-security-policy'), /connect-src 'none'/); } finally { await env.close(); }
    const other = await server(t, '0.0.0.0', { allowRemoteActions: true, syncPrs: .001 });
    try { assert.equal(other.session.actions, true); assert.equal((await other.post('comment', { body: 'x' }, { Host: '192.168.1.5' })).status, 403); await new Promise((r) => setTimeout(r, 100)); assert.ok(JSON.parse(read(other.review)).prs[0].gh.viewer); } finally { await other.close(); }
  }));
});
