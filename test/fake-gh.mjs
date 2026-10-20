#!/usr/bin/env node
// Strict fixture-only gh. Unknown argv fails closed; no network or real gh is ever invoked.
import fs from 'node:fs';
import path from 'node:path';
const argv = process.argv.slice(2), input = fs.readFileSync(0, 'utf8');
const file = process.env.REVIEW_KIT_GH_DATA;
if (!file) throw new Error('REVIEW_KIT_GH_DATA is required for fake gh');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const val = (k) => argv[argv.indexOf(k) + 1];
const write = (v) => console.log(JSON.stringify(v));
const save = () => fs.writeFileSync(file, JSON.stringify(data));
const log = () => { if (process.env.REVIEW_KIT_GH_LOG) fs.appendFileSync(process.env.REVIEW_KIT_GH_LOG, JSON.stringify({ argv, input }) + '\n'); };
if (process.env.REVIEW_KIT_GH_FAIL && argv.includes(process.env.REVIEW_KIT_GH_FAIL)) { console.error('fixture failure'); process.exit(1); }
if (argv[0] === 'auth') process.exit(0);
if (argv.join(' ') === 'api user') { write({ login: 'sam' }); process.exit(0); }
if (argv[0] === 'search') { write(data.prs.filter((p) => p.gh.state === 'OPEN' && (argv.includes('--review-requested') ? p.role === 'reviewing' : p.role !== 'reviewing')).filter((p) => !argv.includes('--repo') || argv.some((a, i) => a === '--repo' && argv[i + 1] === p.repo)).map((p) => ({ number: p.number, repository: { nameWithOwner: p.repo }, url: p.url }))); process.exit(0); }
let p = data.prs.find((p) => p.repo === val('-R') && p.number === +argv[2]);
if (argv[0] === 'api' && argv[1] === 'graphql') {
  const q = argv.find((a) => a.startsWith('query=')) || '';
  if (process.env.REVIEW_KIT_GH_GRAPHQL_ERROR) { write({ errors: [{ message: 'fixture GraphQL failure' }] }); process.exit(0); }
  const page = (nodes) => { const size = +process.env.REVIEW_KIT_GH_PAGE_SIZE || 10000; const start = +(argv.find((a) => a.startsWith('after=')) || 'after=0').slice(6); return { nodes: nodes.slice(start, start + size), pageInfo: { hasNextPage: start + size < nodes.length, endCursor: String(start + size) } }; };
  const comments = (t) => t.comments.map((c) => ({ ...c, author: { login: c.author }, createdAt: c.created }));
  if (q.includes('node(id:')) { const id = argv.find((a) => a.startsWith('id=')).slice(3); const t = data.prs.flatMap((p) => p.gh.threads).find((t) => t.id === id); write({ data: { node: { comments: page(comments(t)) } } }); process.exit(0); }
  if (!q.includes('mutation')) { const owner = argv.find((a) => a.startsWith('owner=')).slice(6), name = argv.find((a) => a.startsWith('name=')).slice(5), n = +argv.find((a) => a.startsWith('number=')).slice(7); p = data.prs.find((p) => p.repo === owner + '/' + name && p.number === n); write({ data: { repository: { pullRequest: { reviewThreads: page((p?.gh.threads || []).map((t) => ({ ...t, isResolved: t.resolved, isOutdated: t.outdated, comments: { nodes: comments(t).slice(0, +process.env.REVIEW_KIT_GH_PAGE_SIZE || 10000), pageInfo: { hasNextPage: !!process.env.REVIEW_KIT_GH_PAGE_SIZE && t.comments.length > +process.env.REVIEW_KIT_GH_PAGE_SIZE, endCursor: String(+process.env.REVIEW_KIT_GH_PAGE_SIZE || 10000) } } }))) } } } }); }
  else { log(); const tid = argv.find((a) => a.startsWith('thread=')).slice(7); const t = data.prs.flatMap((p) => p.gh.threads).find((t) => t.id === tid); if (q.includes('unresolveReviewThread')) t.resolved = false; else if (q.includes('resolveReviewThread')) t.resolved = true; else if (q.includes('addPullRequestReviewThreadReply')) t.comments.push({ author: 'sam', body: argv.find((a) => a.startsWith('body=')).slice(5), created: new Date().toISOString() }); save(); write({ data: {} }); }
  process.exit(0);
}
if (argv[0] === 'api' && /\/reviews$/.test(argv[1])) {
  log(); const m = /^repos\/(.*)\/pulls\/(\d+)\/reviews$/.exec(argv[1]); p = data.prs.find((p) => p.repo === m[1] && p.number === +m[2]); const payload = JSON.parse(input); p.gh.reviews.push({ author: 'sam', state: { COMMENT: 'COMMENTED', APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED' }[payload.event], body: payload.body || '', submitted: new Date().toISOString(), commit: payload.commit_id }); save(); write({ id: 123, html_url: p.url + '#pullrequestreview-123' }); process.exit(0);
}
if (argv[0] === 'pr' && argv[1] === 'view') {
  if (!p) { console.error('No fixture PR'); process.exit(1); }
  const g = p.gh;
  write({ ...g, number: p.number, url: p.url, isDraft: g.draft, author: { login: g.author }, headRefName: g.head, baseRefName: g.base, headRefOid: g.headSha, createdAt: g.created, updatedAt: g.updated, mergeStateStatus: g.mergeState, labels: g.labels.map((name) => ({ name })), reviewRequests: g.reviewRequests.map((login) => ({ login })), statusCheckRollup: g.checks.map((c) => ({ ...c, workflowName: c.workflow, detailsUrl: c.url })), reviews: g.reviews.map((r) => ({ ...r, author: { login: r.author }, submittedAt: r.submitted, commit: { oid: r.commit } })), comments: g.comments.map((c) => ({ ...c, author: { login: c.author }, createdAt: c.created })), files: g.files.map((f) => ({ path: f.path, additions: f.add, deletions: f.del })) }); process.exit(0);
}
if (argv[0] === 'pr' && argv[1] === 'diff') { if (p?.gh.diff) await new Promise((resolve) => process.stdout.write(fs.readFileSync(path.resolve(path.dirname(file), p.gh.diff), 'utf8'), resolve)); process.exit(0); }
if (argv[0] === 'run' && argv[1] === 'rerun') { log(); process.exit(0); }
if (argv[0] === 'pr' && ['comment', 'merge', 'close', 'reopen', 'update-branch', 'ready', 'edit'].includes(argv[1]) && p) {
  log();
  const action = argv[1];
  if (action === 'comment') p.gh.comments.push({ author: 'sam', body: input, created: new Date().toISOString() });
  if (action === 'merge') p.gh.state = 'MERGED';
  if (action === 'close') p.gh.state = 'CLOSED';
  if (action === 'reopen') p.gh.state = 'OPEN';
  if (action === 'ready') p.gh.draft = argv.includes('--undo');
  if (action === 'update-branch') p.gh.mergeState = 'CLEAN';
  if (action === 'edit') p.gh.reviewRequests = val('--add-reviewer').split(',');
  save(); process.exit(0);
}
console.error('Unsupported fake gh argv: ' + JSON.stringify(argv)); process.exit(2);
