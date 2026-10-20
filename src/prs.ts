/**
 * The PR dashboard (`project.kind: "prs"`): pull requests across repositories, synced from GitHub with gh.
 *
 * Each entry in `prs` has fields the user (or agent) owns (priority, next, notes, dependsOn) and a `gh` object that
 * `sync` replaces wholesale. status() derives, in one place, what blocks a PR and which board group it sits in; build,
 * `pr list`, `summary` and the live server all use it. Actions run one fixed gh command and re-sync the PR.
 */
import fs from 'node:fs';
import { ReviewError } from './errors.js';
import * as gh from './gh.js';
import * as markdown from './markdown.js';
import * as model from './model.js';
import { get, has, isDict, isfile, join } from './py.js';
import * as safety from './safety.js';

/** Largest diff kept per PR (bytes); longer diffs are cut at a line break and flagged diffTruncated. */
export const PR_DIFF_CAP = 2 * 1024 * 1024;
/** Board groups, in board order: my PRs, then PRs I review (role "reviewing"). */
export const MINE_GROUPS = ['action', 'ready', 'waiting', 'draft', 'merged', 'closed'];
export const REVIEWING_GROUPS = ['to-ship', 'in-review', 'updated', 'to-review', 'waiting-author', 'done'];
export const GROUPS = [...MINE_GROUPS, ...REVIEWING_GROUPS];
export const GROUP_LABELS: Record<string, string> = {
  action: 'Needs you', ready: 'Ready to merge', waiting: 'Waiting', draft: 'Drafts', merged: 'Merged', closed: 'Closed',
  'to-ship': 'Ready to send', 'in-review': 'Reviewing', updated: 'New commits', 'to-review': 'To review',
  'waiting-author': 'Waiting for the author', done: 'Done',
};
export const ID_RE = /^[a-z0-9][a-z0-9._-]{0,150}$/;
const HOUR = 3600_000;
const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);

export interface Blocker { code: string; text: string }
export interface Status { group: string; blockers: Blocker[]; ageText: string; stale: false | 'soft' | 'hard' }

/** <owner>-<repo>-<number>, lower-case (dots and underscores kept). */
export function prId(repo: string, number: number): string {
  return `${repo.replace('/', '-')}-${number}`.toLowerCase();
}

export function prList(data: any): any[] {
  const l = get(data, 'prs');
  return Array.isArray(l) ? l : [];
}

export function findPr(data: any, id: unknown): any {
  const pr = prList(data).find((p) => isDict(p) && p.id === id);
  if (!pr) {
    const ids = prList(data).map((p) => p.id);
    throw new ReviewError(`no PR with id "${String(id)}"` + (ids.length ? ` (known: ${ids.slice(0, 12).join(', ')}${ids.length > 12 ? ', ...' : ''})` : ''));
  }
  return pr;
}

const ref = (pr: any): gh.PrRef => ({ repo: pr.repo, number: pr.number });

// ---------------------------------------------------------------- derived status
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

function names(list: string[], max = 3): string {
  if (list.length <= 1) return list.join('');
  if (list.length > max) return `${list.slice(0, max).join(', ')} and ${list.length - max} more`;
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

export const checkFailed = (c: any) => FAILED.has(String(get(c, 'conclusion') ?? ''));
export const checkPending = (c: any) => get(c, 'status') !== 'COMPLETED';

/** Logins whose latest decisive review (approve / request changes / dismissed) requests changes. */
function changesRequestedBy(reviews: any[]): string[] {
  const last = new Map<string, string>();
  for (const r of reviews) {
    const st = get(r, 'state');
    if (st === 'APPROVED' || st === 'CHANGES_REQUESTED' || st === 'DISMISSED') last.set(String(get(r, 'author') ?? ''), st);
  }
  return [...last].filter(([a, st]) => a && st === 'CHANGES_REQUESTED').map(([a]) => a);
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function ago(ms: number): string {
  if (ms < 60_000) return 'just now';
  if (ms < HOUR) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 48 * HOUR) return `${Math.floor(ms / HOUR)} h ago`;
  return `${Math.floor(ms / (24 * HOUR))} days ago`;
}

function duration(ms: number): string {
  return ago(ms).replace(/ ago$/, '').replace(/^just now$/, 'a minute');
}

/**
 * What blocks a PR (in plain words, most pressing first) and its board group. `byId` holds the review's PRs (for
 * dependsOn); `now` is the time the status is computed at (build time).
 */
export function status(pr: any, byId: Map<string, any> = new Map(), now = Date.now()): Status {
  const g = get(pr, 'gh');
  const blockers: Blocker[] = [];
  const add = (code: string, text: string) => blockers.push({ code, text });
  if (!isDict(g)) {
    add('unsynced', 'Not synced yet');
    return { group: role(pr) === 'reviewing' ? 'to-review' : 'waiting', blockers, ageText: 'never synced', stale: false };
  }
  const fetched = Date.parse(String(get(g, 'fetched') ?? ''));
  const age = Number.isNaN(fetched) ? Infinity : Math.max(0, now - fetched);
  const stale: Status['stale'] = age > 24 * HOUR ? 'hard' : age > HOUR ? 'soft' : false;
  const ageText = Number.isFinite(age) ? `synced ${ago(age)}` : 'never synced';
  const state = get(g, 'state');
  if (role(pr) === 'reviewing') return reviewingStatus(pr, g, blockers, ageText, stale, age);
  if (state === 'MERGED') return { group: 'merged', blockers, ageText, stale };
  if (state === 'CLOSED') return { group: 'closed', blockers, ageText, stale };

  const base = String(get(g, 'base') || 'the base branch');
  const checks: any[] = Array.isArray(get(g, 'checks')) ? g.checks : [];
  const threads: any[] = Array.isArray(get(g, 'threads')) ? g.threads : [];
  const failed = checks.filter(checkFailed);
  const pending = checks.filter((c) => checkPending(c) && !checkFailed(c));
  const unresolved = threads.filter((t) => get(t, 'resolved') !== true);
  const decision = get(g, 'reviewDecision');
  const mstate = get(g, 'mergeState');

  if (get(g, 'draft') === true) add('draft', 'Still a draft');
  if (get(g, 'mergeable') === 'CONFLICTING' || mstate === 'DIRTY') add('conflicts', `Has merge conflicts with ${base}`);
  if (failed.length) {
    add('checks-failed', `${plural(failed.length, 'check')} failing: ${names(failed.map((c) => String(get(c, 'name') || '?')), 4)}`);
  }
  if (decision === 'CHANGES_REQUESTED') {
    const who = changesRequestedBy(Array.isArray(get(g, 'reviews')) ? g.reviews : []);
    add('changes-requested', who.length ? `${names(who)} requested changes` : 'Changes requested');
  }
  if (unresolved.length) add('threads', `${plural(unresolved.length, 'unresolved review thread')}`);
  if (mstate === 'BEHIND') add('behind', `Behind ${base}`);
  if (pending.length) add('checks-pending', `${plural(pending.length, 'check')} still running`);
  if (decision === 'REVIEW_REQUIRED') {
    const who: string[] = (Array.isArray(get(g, 'reviewRequests')) ? g.reviewRequests : []).map(String);
    add('review-required', who.length ? `Waiting for review from ${names(who)}` : 'Waiting for review');
  }
  if (stale === 'hard') add('stale', `Not synced for ${duration(age)}`);
  for (const dep of Array.isArray(get(pr, 'dependsOn')) ? pr.dependsOn : []) {
    const other = byId.get(dep);
    const st = other ? get(get(other, 'gh'), 'state') : null;
    if (st !== 'MERGED') add('depends', other ? `Waits on ${dep}` : `Waits on ${dep} (not on this board)`);
  }
  const codes = new Set(blockers.map((b) => b.code));
  if (mstate === 'BLOCKED' && !['conflicts', 'checks-failed', 'changes-requested', 'threads', 'behind', 'checks-pending',
    'review-required', 'draft'].some((c) => codes.has(c))) {
    add('blocked', 'Merging is blocked by a branch rule');
    codes.add('blocked');
  }
  let group: string;
  if (codes.has('draft')) group = 'draft';
  else if (['conflicts', 'checks-failed', 'changes-requested', 'threads', 'behind'].some((c) => codes.has(c))) group = 'action';
  else if (['checks-pending', 'review-required', 'depends', 'blocked'].some((c) => codes.has(c))) group = 'waiting';
  else group = 'ready';
  return { group, blockers, ageText, stale };
}

export const role = (pr: any) => (get(pr, 'role') === 'reviewing' ? 'reviewing' : 'mine');
export const findingsOf = (pr: any): any[] => (Array.isArray(get(pr, 'findings')) ? pr.findings.filter(isDict) : []);
const fstatus = (f: any) => (get(f, 'status') === 'posted' || get(f, 'status') === 'dropped' ? f.status : 'draft');
/** A draft finding written against an older head commit than the one last synced (its line may be wrong). */
export const findingStale = (f: any, g: any) => fstatus(f) === 'draft' && !!str(get(f, 'sha')) && !!str(get(g, 'headSha'))
  && f.sha !== g.headSha;

/** My latest review on GitHub (by the viewer login), or null. */
function myLastReview(g: any): any {
  const me = str(get(g, 'viewer')).toLowerCase();
  if (!me) return null;
  const mine = (Array.isArray(get(g, 'reviews')) ? g.reviews : []).filter((r: any) => str(get(r, 'author')).toLowerCase() === me
    && get(r, 'state') !== 'PENDING');
  return mine.length ? mine[mine.length - 1] : null;
}

/** Groups of a PR I review: to-ship, in-review, updated, to-review, waiting-author, done. */
function reviewingStatus(pr: any, g: any, blockers: Blocker[], ageText: string, stale: Status['stale'], age: number): Status {
  const add = (code: string, text: string) => blockers.push({ code, text });
  const state = get(g, 'state');
  const fs = findingsOf(pr);
  const drafts = fs.filter((f) => fstatus(f) === 'draft');
  const flagged = drafts.filter((f) => get(f, 'ship') === true);
  const old = drafts.filter((f) => findingStale(f, g));
  const last = myLastReview(g);
  const postedShas = fs.filter((f) => fstatus(f) === 'posted').map((f) => str(get(get(f, 'posted'), 'sha')) || str(get(f, 'sha'))).filter(Boolean);
  const reviewedAt = last ? str(get(last, 'commit')) : postedShas[postedShas.length - 1] || '';
  const reviewed = !!last || postedShas.length > 0;
  const moved = reviewed && !!reviewedAt && !!str(get(g, 'headSha')) && reviewedAt !== g.headSha;
  if (state === 'MERGED' || state === 'CLOSED') {
    return { group: 'done', blockers, ageText, stale };
  }
  if (drafts.length) {
    add('findings', `${plural(drafts.length, 'finding')} drafted` + (flagged.length ? `, ${flagged.length} flagged to ship` : ''));
  }
  if (old.length) add('stale-findings', `${plural(old.length, 'finding')} written before the latest commits (lines may have moved)`);
  if (moved) add('updated', 'New commits since your review');
  if (stale === 'hard') add('stale', `Not synced for ${duration(age)}`);
  let group: string;
  if (flagged.length) group = 'to-ship';
  else if (drafts.length) group = 'in-review';
  else if (moved) group = 'updated';
  else if (reviewed && get(last, 'state') === 'APPROVED') group = 'done';
  else if (reviewed) {
    group = 'waiting-author';
    add('waiting-author', get(last, 'state') === 'CHANGES_REQUESTED' ? 'You requested changes; no new commits yet' : 'Waiting for the author');
  } else {
    group = 'to-review';
    const me = str(get(g, 'viewer')).toLowerCase();
    const asked = (Array.isArray(get(g, 'reviewRequests')) ? g.reviewRequests : []).some((r: string) => String(r).toLowerCase() === me);
    add('review-requested', asked ? 'Your review is requested' : 'Not reviewed yet');
  }
  return { group, blockers, ageText, stale };
}

/** Status of every PR, keyed by id. */
export function statuses(data: any, now = Date.now()): Map<string, Status> {
  const byId = new Map<string, any>(prList(data).map((p) => [p.id, p]));
  return new Map(prList(data).map((p) => [p.id, status(p, byId, now)]));
}

/** PRs in board order: by group, then priority (unset last), then most recently updated. */
export function boardOrder(data: any, st: Map<string, Status> = statuses(data)): any[] {
  const prio = (p: any) => (typeof get(p, 'priority') === 'number' ? p.priority : Infinity);
  const upd = (p: any) => Date.parse(String(get(get(p, 'gh'), 'updated') ?? '')) || 0;
  return prList(data).map((p, i) => ({ p, i })).sort((a, b) => GROUPS.indexOf(st.get(a.p.id)!.group) - GROUPS.indexOf(st.get(b.p.id)!.group)
    || prio(a.p) - prio(b.p) || upd(b.p) - upd(a.p) || a.i - b.i).map((x) => x.p);
}

// ---------------------------------------------------------------- copy-paste commands (plain gh, no review-kit)
/** POSIX shell single-quoting. */
export function shq(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

const cmd = (args: string[]) => ['gh', ...args].map(shq).join(' ');

/** Failed GitHub Actions run ids among the checks (unique, in order). */
export function failedRuns(g: any): number[] {
  const out: number[] = [];
  for (const c of Array.isArray(get(g, 'checks')) ? g.checks : []) {
    const id = get(c, 'runId');
    if (checkFailed(c) && Number.isInteger(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The gh commands the site offers to copy. `{body}` marks where the (shell-quoted) text goes. */
export function commands(pr: any): Record<string, string> {
  const r = ref(pr);
  const m = gh.mutations;
  const runs = failedRuns(get(pr, 'gh'));
  return {
    view: cmd(['pr', 'view', String(r.number), '-R', r.repo, '--web']),
    checkout: cmd(['pr', 'checkout', String(r.number), '-R', r.repo]),
    diff: cmd(['pr', 'diff', String(r.number), '-R', r.repo]),
    checks: cmd(['pr', 'checks', String(r.number), '-R', r.repo]),
    merge: cmd(m.merge(r, 'squash').args),
    mergeMerge: cmd(m.merge(r, 'merge').args),
    mergeRebase: cmd(m.merge(r, 'rebase').args),
    updateBranch: cmd(m.updateBranch(r).args),
    updateBranchRebase: cmd(m.updateBranch(r, true).args),
    ready: cmd(m.ready(r).args),
    undoReady: cmd(m.ready(r, true).args),
    close: cmd(m.close(r).args),
    reopen: cmd(m.reopen(r).args),
    rerun: runs.map((id) => cmd(m.rerun(r.repo, id).args)).join(' && '),
    rerunAll: runs.map((id) => cmd(m.rerun(r.repo, id, false).args)).join(' && '),
    comment: `${cmd(['pr', 'comment', String(r.number), '-R', r.repo])} --body {body}`,
    request: `${cmd(['pr', 'edit', String(r.number), '-R', r.repo])} --add-reviewer {reviewers}`,
  };
}

/** Copy commands for one review thread. */
export function threadCommands(threadId: string): Record<string, string> {
  if (!gh.NODE_ID_RE.test(threadId)) return {};
  return {
    reply: `gh api graphql -f ${shq('query=' + gh.REPLY_MUTATION)} -f thread=${threadId} -f body={body}`,
    resolve: cmd(gh.mutations.resolve(threadId).args),
    unresolve: cmd(gh.mutations.resolve(threadId, true).args),
  };
}

// ---------------------------------------------------------------- sync
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const login = (a: any) => (isDict(a) ? str(a.login) || str(a.slug) || str(a.name) : typeof a === 'string' ? a : '');
const int = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0);
const opt = (o: Record<string, any>, k: string, v: unknown) => {
  if (v !== undefined && v !== null && v !== '') o[k] = v;
};

/** gh's statusCheckRollup entry (CheckRun or StatusContext) as a check. */
export function check(c: any): Record<string, any> {
  const out: Record<string, any> = {};
  if (get(c, '__typename') === 'StatusContext' || has(c, 'context')) {
    const st = str(get(c, 'state'));
    out.name = str(c.context) || '?';
    out.workflow = '';
    out.status = st === 'PENDING' || st === 'EXPECTED' ? 'PENDING' : 'COMPLETED';
    out.conclusion = st === 'SUCCESS' ? 'SUCCESS' : st === 'FAILURE' || st === 'ERROR' ? 'FAILURE' : null;
    opt(out, 'url', safety.safeUrl(str(get(c, 'targetUrl'))));
    return out;
  }
  out.name = str(get(c, 'name')) || '?';
  out.workflow = str(get(c, 'workflowName'));
  out.status = str(get(c, 'status')) || 'PENDING';
  out.conclusion = str(get(c, 'conclusion')) || null;
  const url = str(get(c, 'detailsUrl'));
  opt(out, 'url', safety.safeUrl(url));
  const m = /\/actions\/runs\/(\d+)(?:\/|$)/.exec(url);
  if (m) out.runId = Number(m[1]);
  return out;
}

const comment = (c: any) => {
  const o: Record<string, any> = { author: login(get(c, 'author')), body: str(get(c, 'body')), created: str(get(c, 'createdAt')) };
  opt(o, 'url', safety.safeUrl(str(get(c, 'url'))));
  return o;
};

/** The `gh` object of review.json from gh's answers. */
export function normalize(v: any, threads: any[], fetched: string, viewer = ''): Record<string, any> {
  const g: Record<string, any> = {
    fetched, viewer,
    title: str(get(v, 'title')), body: str(get(v, 'body')), state: str(get(v, 'state')) || 'OPEN', draft: get(v, 'isDraft') === true,
    author: login(get(v, 'author')), head: str(get(v, 'headRefName')), base: str(get(v, 'baseRefName')), headSha: str(get(v, 'headRefOid')),
    created: str(get(v, 'createdAt')), updated: str(get(v, 'updatedAt')), mergedAt: str(get(v, 'mergedAt')) || null,
    mergeable: str(get(v, 'mergeable')) || 'UNKNOWN', mergeState: str(get(v, 'mergeStateStatus')) || 'UNKNOWN',
    reviewDecision: str(get(v, 'reviewDecision')) || null,
    additions: int(get(v, 'additions')), deletions: int(get(v, 'deletions')), changedFiles: int(get(v, 'changedFiles')),
    labels: (get(v, 'labels') || []).map((l: any) => login(l)).filter(Boolean),
    reviewRequests: (get(v, 'reviewRequests') || []).map((r: any) => login(r)).filter(Boolean),
    checks: (get(v, 'statusCheckRollup') || []).filter(isDict).map(check),
    reviews: (get(v, 'reviews') || []).filter(isDict).map((r: any) => {
      const o: Record<string, any> = { author: login(r.author), state: str(r.state), submitted: str(r.submittedAt), body: str(r.body) };
      opt(o, 'url', safety.safeUrl(str(r.url)));
      opt(o, 'commit', str(get(get(r, 'commit'), 'oid')));
      return o;
    }),
    threads: threads.filter(isDict).map((t: any) => ({
      id: str(t.id), path: str(t.path), line: Number.isInteger(t.line) ? t.line : Number.isInteger(t.originalLine) ? t.originalLine : null,
      resolved: t.isResolved === true, outdated: t.isOutdated === true,
      comments: (get(get(t, 'comments'), 'nodes') || []).filter(isDict).map(comment),
    })),
    comments: (get(v, 'comments') || []).filter(isDict).map(comment),
    files: (get(v, 'files') || []).filter(isDict).map((f: any) => ({ path: str(f.path), add: int(f.additions), del: int(f.deletions) })),
  };
  return g;
}

/** Write the diff to diffs/<id>.diff (capped); returns [relative path, truncated]. */
function writeDiff(base: string, id: string, text: string): [string, boolean] {
  let buf = Buffer.from(text, 'utf8');
  let truncated = false;
  if (buf.length > PR_DIFF_CAP) {
    const nl = buf.subarray(0, PR_DIFF_CAP).lastIndexOf(0x0a);
    buf = buf.subarray(0, nl > 0 ? nl + 1 : PR_DIFF_CAP);
    truncated = true;
  }
  if (!ID_RE.test(id)) throw new ReviewError('invalid PR id');
  const rel = `diffs/${id}.diff`;
  safety.localSource(base, rel); // also refuses an existing diffs symlink outside the review
  fs.mkdirSync(join(base, 'diffs'), { recursive: true });
  model.writeText(join(base, rel), buf);
  return [rel, truncated];
}

/** Fetch one PR from GitHub and replace its `gh` object. Returns a log line. */
export function fetchInto(base: string, pr: any): string {
  const r = ref(pr);
  const view = gh.prView(r);
  const threads = gh.prThreads(r);
  const g = normalize(view, threads, new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), gh.viewer());
  const [diff, why] = gh.prDiff(r);
  let note = '';
  if (diff !== null) {
    const [rel, cut] = writeDiff(base, pr.id, diff);
    g.diff = rel;
    g.diffTruncated = cut;
    if (cut) note = ' (diff cut at 2 MB)';
  } else {
    g.diffTruncated = false;
    note = ` (no diff: ${why.split('\n')[0]})`;
  }
  if (str(get(view, 'url')) && safety.safeUrl(view.url) === view.url) pr.url = view.url;
  pr.gh = g;
  return note;
}

export interface SyncResult { id: string; ok: boolean; skipped?: boolean; line: string }

/** One line about a PR: "acme-web-142  action  Has merge conflicts with main". */
export function statusLine(pr: any, st: Status): string {
  const first = st.blockers[0] ? st.blockers[0].text : st.group === 'ready' ? 'Ready to merge' : GROUP_LABELS[st.group];
  return `${pr.id}  ${st.group}  ${first}`;
}

/**
 * Re-fetch PRs (all, or `ids`). Merged and closed PRs already synced as such are skipped unless `all`. A PR that fails
 * to sync keeps its old data. Returns one result per PR.
 */
export function sync(base: string, data: any, ids: string[] = [], all = false): SyncResult[] {
  const targets = ids.length ? ids.map((i) => findPr(data, i)) : prList(data);
  const out: SyncResult[] = [];
  for (const pr of targets) {
    const st0 = get(get(pr, 'gh'), 'state');
    if (!all && (st0 === 'MERGED' || st0 === 'CLOSED')) {
      out.push({ id: pr.id, ok: true, skipped: true, line: `${pr.id}  ${st0.toLowerCase()} (not re-fetched; --all does)` });
      continue;
    }
    try {
      const note = fetchInto(base, pr);
      const st = statuses(data).get(pr.id)!;
      out.push({ id: pr.id, ok: true, line: statusLine(pr, st) + note });
    } catch (e) {
      if (!(e instanceof ReviewError)) throw e;
      out.push({ id: pr.id, ok: false, line: `${pr.id}  sync failed: ${e.message}` });
    }
  }
  return out;
}

// ---------------------------------------------------------------- add / set / remove
export interface UserFields { priority?: number | null; next?: string | null; notes?: string | null; dependsOn?: string[] | null }

export function applyFields(pr: any, f: UserFields): void {
  if (f.priority !== undefined) {
    if (f.priority === null) delete pr.priority;
    else if (!Number.isSafeInteger(f.priority)) throw new ReviewError('priority must be a safe whole number');
    else pr.priority = f.priority;
  }
  for (const k of ['next', 'notes'] as const) {
    const v = f[k];
    if (v === undefined) continue;
    if (v !== null && typeof v !== 'string') throw new ReviewError(`${k} must be text`);
    if (typeof v === 'string' && v.length > 20000) throw new ReviewError(`${k} is longer than 20000 characters`);
    if (v === null || !v.trim()) delete pr[k];
    else pr[k] = k === 'next' ? v.trim() : v;
  }
  if (f.dependsOn !== undefined) {
    if (f.dependsOn !== null && !Array.isArray(f.dependsOn)) throw new ReviewError('dependsOn must be an array of PR ids');
    const deps = (f.dependsOn || []).filter(Boolean);
    for (const d of deps) if (typeof d !== 'string' || !ID_RE.test(d)) throw new ReviewError(`"${String(d)}" is not a PR id`);
    if (deps.includes(pr.id)) throw new ReviewError(`${pr.id} cannot depend on itself`);
    if (deps.length) pr.dependsOn = [...new Set(deps)];
    else delete pr.dependsOn;
  }
}

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Add PRs (skipping ones already on the board), then sync the new ones. Returns log lines and whether all synced. */
export function add(base: string, data: any, refs: gh.PrRef[], f: UserFields = {}, doSync = true, asRole: 'mine' | 'reviewing' = 'mine'): { log: string[]; ok: boolean } {
  if (!Array.isArray(get(data, 'prs'))) data.prs = [];
  const log: string[] = [];
  const fresh: string[] = [];
  let ok = true;
  for (const r of refs) {
    const existing = prList(data).find((p) => String(p.repo).toLowerCase() === r.repo.toLowerCase() && p.number === r.number);
    if (existing) {
      log.push(`${existing.id}: already on the board`);
      if (Object.keys(f).length) applyFields(existing, f);
      continue;
    }
    let id = prId(r.repo, r.number);
    for (let n = 2; prList(data).some((p) => p.id === id); n++) id = `${prId(r.repo, r.number)}-${n}`;
    const pr: Record<string, any> = { id, repo: r.repo, number: r.number, url: `https://github.com/${r.repo}/pull/${r.number}` };
    if (asRole === 'reviewing') pr.role = 'reviewing';
    applyFields(pr, f);
    pr.added = nowIso();
    data.prs.push(pr);
    fresh.push(id);
  }
  if (doSync && fresh.length) {
    for (const res of sync(base, data, fresh)) {
      log.push(`added ${res.line}`);
      ok = ok && res.ok;
    }
  } else for (const id of fresh) log.push(`added ${id} (not synced)`);
  return { log, ok };
}

export function remove(data: any, id: string): string {
  const pr = findPr(data, id);
  data.prs.splice(data.prs.indexOf(pr), 1);
  for (const p of prList(data)) {
    if (Array.isArray(get(p, 'dependsOn')) && p.dependsOn.includes(id)) {
      p.dependsOn = p.dependsOn.filter((d: string) => d !== id);
      if (!p.dependsOn.length) delete p.dependsOn;
    }
  }
  return `removed ${id}` + (get(get(pr, 'gh'), 'diff') ? ` (its diff stays in ${pr.gh.diff} as a local snapshot)` : '');
}

// ---------------------------------------------------------------- actions
export interface ActionArgs {
  body?: string; thread?: string; unresolve?: boolean; all?: boolean; rebase?: boolean; undo?: boolean;
  method?: string; auto?: boolean; deleteBranch?: boolean; reviewers?: string[];
}

export const ACTIONS = ['comment', 'reply', 'resolve', 'rerun', 'update-branch', 'ready', 'merge', 'close', 'reopen', 'request'];

/** The gh calls an action makes (argv + stdin), checked but not run. */
export function plan(pr: any, action: string, a: ActionArgs): gh.Mutation[] {
  const r = ref(pr);
  const m = gh.mutations;
  if (['reply', 'resolve'].includes(action) && !(pr.gh?.threads || []).some((t: any) => t.id === a.thread)) {
    throw new ReviewError('thread does not belong to this PR');
  }
  switch (action) {
    case 'comment': return [m.comment(r, a.body as string)];
    case 'reply': return [m.reply(a.thread as string, a.body as string)];
    case 'resolve': return [m.resolve(a.thread as string, a.unresolve === true)];
    case 'rerun': {
      const runs = failedRuns(get(pr, 'gh'));
      if (!runs.length) throw new ReviewError(`${pr.id}: no failed GitHub Actions runs to re-run (sync first if CI just failed)`);
      return runs.map((id) => m.rerun(r.repo, id, a.all !== true));
    }
    case 'update-branch': return [m.updateBranch(r, a.rebase === true)];
    case 'ready': return [m.ready(r, a.undo === true)];
    case 'merge': return [m.merge(r, String(a.method || ''), a.auto === true, a.deleteBranch === true)];
    case 'close': return [m.close(r)];
    case 'reopen': return [m.reopen(r)];
    case 'request': return [m.request(r, Array.isArray(a.reviewers) ? a.reviewers.map(String) : [])];
    default: throw new ReviewError(`unknown action "${action}"`);
  }
}

const DONE: Record<string, string> = {
  comment: 'Commented', reply: 'Replied', resolve: 'Resolved the thread', rerun: 'Re-ran failed jobs', 'update-branch': 'Updated the branch',
  ready: 'Marked ready for review', merge: 'Merged', close: 'Closed', reopen: 'Reopened', request: 'Requested reviews',
};

function doneText(action: string, a: ActionArgs, n: number): string {
  if (action === 'resolve' && a.unresolve) return 'Unresolved the thread';
  if (action === 'ready' && a.undo) return 'Converted to draft';
  if (action === 'rerun') return `${a.all ? 'Re-ran' : 'Re-ran failed jobs of'} ${plural(n, 'workflow run')}`;
  if (action === 'merge' && a.auto) return 'Auto-merge enabled';
  if (action === 'update-branch' && a.rebase) return 'Rebased the branch';
  return DONE[action];
}

export interface ActionResult { message: string; synced: boolean; syncError?: string; ran: string[][] }

/**
 * Run an action's gh commands (stopping at the first failure, which throws), then re-sync the PR. A failed re-sync
 * does not undo the action: it is reported in the result.
 */
export function act(base: string, data: any, id: string, action: string, a: ActionArgs = {}): ActionResult {
  const pr = findPr(data, id);
  const calls = plan(pr, action, a);
  const ran: string[][] = [];
  for (const c of calls) {
    gh.exec(c);
    ran.push(c.args);
  }
  let message = `${doneText(action, a, calls.length)}: ${pr.repo}#${pr.number}`;
  try {
    fetchInto(base, pr);
    return { message, synced: true, ran };
  } catch (e) {
    if (!(e instanceof ReviewError)) throw e;
    message += ' (re-sync failed; run sync)';
    return { message, synced: false, syncError: e.message, ran };
  }
}

// ---------------------------------------------------------------- compile for the site
/**
 * One PR as app.js reads it: the gh fields flattened next to the user fields, Markdown rendered to sanitized HTML,
 * the derived group/blockers/ageText, copy commands, and the diff as a published script asset (see build.ts).
 */
export function compilePr(pr: any, st: Status, rich: (t: any) => string, diffAsset: (rel: string) => Record<string, any> | null,
  base = ''): Record<string, any> {
  const g = isDict(get(pr, 'gh')) ? pr.gh : null;
  const S = (k: string, d: any = '') => (g && has(g, k) && g[k] !== undefined ? g[k] : d);
  const comm = (c: any) => ({ author: str(get(c, 'author')), html: rich(get(c, 'body')), created: str(get(c, 'created')), url: str(get(c, 'url')) });
  const diffRel = g ? get(g, 'diff') : null;
  const checks = (S('checks', []) as any[]).map((c) => ({
    name: str(get(c, 'name')), workflow: str(get(c, 'workflow')), status: str(get(c, 'status')), conclusion: get(c, 'conclusion') ?? null,
    url: str(get(c, 'url')), runId: Number.isInteger(get(c, 'runId')) ? c.runId : null,
    failed: checkFailed(c), pending: checkPending(c) && !checkFailed(c),
  }));
  return {
    id: pr.id, repo: pr.repo, number: pr.number, url: pr.url,
    priority: typeof get(pr, 'priority') === 'number' ? pr.priority : null,
    next: str(get(pr, 'next')), notes: rich(get(pr, 'notes')), notesText: str(get(pr, 'notes')),
    dependsOn: Array.isArray(get(pr, 'dependsOn')) ? pr.dependsOn : [], added: str(get(pr, 'added')),
    synced: !!g, fetched: S('fetched'), group: st.group, blockers: st.blockers, ageText: st.ageText, stale: st.stale,
    title: S('title') || `${pr.repo}#${pr.number}`, body: rich(S('body')), state: S('state', 'OPEN'), draft: S('draft', false) === true,
    author: S('author'), head: S('head'), base: S('base'), headSha: S('headSha'),
    created: S('created'), updated: S('updated'), mergedAt: S('mergedAt', null),
    mergeable: S('mergeable', 'UNKNOWN'), mergeState: S('mergeState', 'UNKNOWN'), reviewDecision: S('reviewDecision', null),
    additions: S('additions', 0), deletions: S('deletions', 0), changedFiles: S('changedFiles', 0),
    labels: S('labels', []), reviewRequests: S('reviewRequests', []),
    checks,
    reviews: (S('reviews', []) as any[]).map((r) => ({ author: str(get(r, 'author')), state: str(get(r, 'state')), submitted: str(get(r, 'submitted')),
      html: rich(get(r, 'body')), url: str(get(r, 'url')) })),
    threads: (S('threads', []) as any[]).map((t) => ({
      id: str(get(t, 'id')), path: str(get(t, 'path')), line: get(t, 'line') ?? null, resolved: get(t, 'resolved') === true,
      outdated: get(t, 'outdated') === true, comments: (get(t, 'comments') || []).map(comm), commands: threadCommands(str(get(t, 'id'))),
    })),
    comments: (S('comments', []) as any[]).map(comm),
    files: (S('files', []) as any[]).map((f) => ({ path: str(get(f, 'path')), add: int(get(f, 'add')), del: int(get(f, 'del')) })),
    diff: typeof diffRel === 'string' && diffRel ? diffAsset(diffRel) : null,
    diffTruncated: S('diffTruncated', false) === true,
    commands: commands(pr),
    ...compileReviewing(pr, g, rich, base),
  };
}

/** role, findings, verdict and (when there is something to send) the review ship would post. */
function compileReviewing(pr: any, g: any, rich: (t: any) => string, base: string): Record<string, any> {
  const findings = findingsOf(pr).map((f) => ({
    id: str(f.id), severity: SEVERITIES.includes(f.severity) ? f.severity : 'P1', title: str(f.title), html: rich(get(f, 'body')),
    text: str(get(f, 'body')), path: str(get(f, 'path')), line: Number.isInteger(get(f, 'line')) ? f.line : null,
    side: get(f, 'side') === 'LEFT' ? 'LEFT' : 'RIGHT', startLine: Number.isInteger(get(f, 'startLine')) ? f.startLine : null,
    ship: get(f, 'ship') === true, status: fstatus(f), sha: str(get(f, 'sha')), stale: g ? findingStale(f, g) : false,
    posted: isDict(get(f, 'posted')) ? { at: str(f.posted.at), url: str(f.posted.url), reviewId: get(f.posted, 'reviewId') ?? null } : null,
  }));
  const v = get(pr, 'verdict');
  const verdict = isDict(v) ? { event: EVENTS.includes(v.event) ? v.event : 'COMMENT', html: rich(get(v, 'body')), text: str(get(v, 'body')) } : null;
  let review: Record<string, any> | null = null;
  if (role(pr) === 'reviewing' && g) {
    try {
      const p = reviewPayload(base, pr);
      review = { payload: p.payload, command: p.command, findings: p.findings, inline: p.inline, moved: p.moved, error: '' };
    } catch (e) {
      if (!(e instanceof ReviewError)) throw e;
      review = { payload: null, command: '', findings: [], inline: [], moved: [], error: e.message };
    }
  }
  return { role: role(pr), viewer: g ? str(get(g, 'viewer')) : '', findings, verdict, review };
}

// ---------------------------------------------------------------- validation (warnings; the schema covers the shape)
export function semantic(data: any, base: string, checkFiles: boolean, errors: string[], warnings: string[], now = Date.now()): void {
  const prs = prList(data);
  const ids = new Set(prs.map((p) => p.id));
  const seen = new Map<string, string>();
  for (const pr of prs) {
    const w = `prs[${model.s(pr.id)}]`;
    const key = `${String(pr.repo).toLowerCase()}#${pr.number}`;
    if (seen.has(key)) warnings.push(`${w}: ${pr.repo}#${pr.number} is also on the board as ${seen.get(key)}`);
    else seen.set(key, pr.id);
    if (safety.safeUrl(pr.url) !== pr.url || !/^https:\/\//i.test(pr.url)) errors.push(`${w}.url: use the PR's https:// URL`);
    for (const d of Array.isArray(get(pr, 'dependsOn')) ? pr.dependsOn : []) {
      if (!ids.has(d)) warnings.push(`${w}: dependsOn "${model.s(d)}" is not a PR on this board`);
    }
    const fids = new Set<string>();
    for (const f of findingsOf(pr)) {
      if (fids.has(f.id)) errors.push(`${w}: duplicate finding id "${model.s(f.id)}"`);
      fids.add(f.id);
      if (typeof f.path === 'string' && (/^(?:[A-Za-z]:|[/\\])/.test(f.path) || f.path.replace(/\\/g, '/').split('/').includes('..'))) errors.push(`${w}.findings[${model.s(f.id)}]: path must be relative to the repository`);
      if (get(f, 'line') !== undefined && !get(f, 'path')) warnings.push(`${w}.findings[${model.s(f.id)}]: a line without a path is posted as a general comment`);
      if (get(f, 'ship') === true && fstatus(f) !== 'draft') warnings.push(`${w}.findings[${model.s(f.id)}]: flagged to ship but ${fstatus(f)}`);
    }
    if (role(pr) === 'mine' && (findingsOf(pr).length || get(pr, 'verdict'))) {
      warnings.push(`${w}: findings and a verdict are for PRs you review (set "role": "reviewing")`);
    }
    const g = get(pr, 'gh');
    if (!isDict(g)) {
      warnings.push(`${w}: never synced (\`review-kit pr sync ${pr.id}\`)`);
      continue;
    }
    const fetched = Date.parse(String(get(g, 'fetched') ?? ''));
    const open = get(g, 'state') !== 'MERGED' && get(g, 'state') !== 'CLOSED';
    if (open && (Number.isNaN(fetched) || now - fetched > 24 * HOUR)) {
      warnings.push(`${w}: last synced ${Number.isNaN(fetched) ? 'at an unknown time' : ago(now - fetched)}; run \`review-kit pr sync\``);
    }
    const dp = get(g, 'diff');
    if (typeof dp === 'string') {
      if (!/\.(diff|patch)$/i.test(dp)) errors.push(`${w}.gh.diff: path must end in .diff or .patch`);
      else {
        try {
          const target = safety.localSource(base, dp);
          if (checkFiles && !isfile(target)) errors.push(`${w}.gh.diff: file not found: ${dp}`);
        } catch (e) {
          if (!(e instanceof ReviewError)) throw e;
          errors.push(`${w}.gh.diff: ${e.message}`);
        }
      }
    }
    for (const [i, c] of (Array.isArray(get(g, 'checks')) ? g.checks : []).entries()) {
      if (typeof get(c, 'url') === 'string' && safety.safeUrl(c.url) !== c.url) errors.push(`${w}.gh.checks[${i}].url: unsafe URL`);
    }
  }
}

// ---------------------------------------------------------------- list / summary
function plainText(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** `pr list`: one row per PR in board order. */
export function table(data: any, now = Date.now()): string {
  const st = statuses(data, now);
  const rows = boardOrder(data, st).map((p) => {
    const s = st.get(p.id)!;
    return [s.group, p.id, plainText(str(get(get(p, 'gh'), 'title')) || `${p.repo}#${p.number}`, 50),
      s.blockers.length ? plainText(s.blockers.map((b) => b.text).join('; '), 70) : s.group === 'ready' ? 'Ready to merge' : '-',
      plainText(str(get(p, 'next')), 50) || '-'];
  });
  if (!rows.length) return 'no PRs yet (`review-kit pr add <url>` or `review-kit pr add --mine`)';
  const head = ['GROUP', 'ID', 'TITLE', 'BLOCKERS', 'NEXT'];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => [...r[i]].length)));
  const pad = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : c + ' '.repeat(w[i] - [...c].length))).join('  ').trimEnd();
  return [pad(head), ...rows.map(pad)].join('\n');
}

/** `summary` for a PR dashboard (Markdown or plain text). */
export function summaryLines(data: any, markdown = true, now = Date.now()): string[] {
  if (!markdown) return table(data, now).split('\n');
  const st = statuses(data, now);
  const order = boardOrder(data, st);
  const done = order.filter((p) => ['MERGED', 'CLOSED'].includes(get(get(p, 'gh'), 'state'))).length;
  const lines = [`**PRs:** ${order.length - done} open, ${done} merged or closed`];
  if (!order.length) return [...lines, '', 'No PRs yet. Run `review-kit pr add --mine` or `--requested`.'];
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  lines.push('', '| Group | ID | Title | Blockers | Next |', '| --- | --- | --- | --- | --- |');
  for (const p of order) {
    const s = st.get(p.id)!;
    lines.push('| ' + [s.group, p.id, str(get(get(p, 'gh'), 'title')) || `${p.repo}#${p.number}`,
      s.blockers.map((b) => b.text).join('; ') || (s.group === 'ready' ? 'Ready to merge' : '-'), str(get(p, 'next')) || '-'].map(cell).join(' | ') + ' |');
  }
  return lines;
}

export const toHtml = markdown.toHtml;

// ---------------------------------------------------------------- reviewing: findings, verdict, ship
export const SEVERITIES = ['P0', 'P1', 'P2', 'nit'];
export const EVENTS = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'];
const FINDING_ID = /^[a-z0-9][a-z0-9._-]{0,40}$/;

export interface FindingFields {
  id?: string | null; title?: string | null; body?: string | null; path?: string | null; line?: number | null;
  side?: string | null; startLine?: number | null; severity?: string | null; ship?: boolean | null;
}

export function findFinding(pr: any, id: unknown): any {
  const f = findingsOf(pr).find((x) => x.id === id);
  if (!f) throw new ReviewError(`${pr.id}: no finding "${String(id)}"`);
  return f;
}

/** Create a finding, or (update) change one; records the head commit it was written against. */
export function upsertFinding(pr: any, f: FindingFields, update = false): any {
  if (!Array.isArray(get(pr, 'findings'))) pr.findings = [];
  let it: any;
  if (update) {
    it = findFinding(pr, f.id);
    if (fstatus(it) === 'posted') throw new ReviewError(`${pr.id}: finding ${it.id} was already posted`);
  } else {
    let id = f.id || '';
    if (!id) for (let n = pr.findings.length + 1; ; n++) if (!pr.findings.some((x: any) => x.id === `f-${n}`)) { id = `f-${n}`; break; }
    if (!FINDING_ID.test(id)) throw new ReviewError(`finding id "${id}" is not allowed (lower-case letters, digits, ".", "_", "-")`);
    if (pr.findings.some((x: any) => x.id === id)) throw new ReviewError(`${pr.id}: finding "${id}" already exists (pass --update)`);
    it = { id, severity: 'P1', title: '', body: '', ship: false, status: 'draft' };
  }
  const text = (k: 'title' | 'body', max: number) => {
    const v = f[k];
    if (v === undefined || v === null) return;
    if (typeof v !== 'string') throw new ReviewError(`${k} must be text`);
    if (v.length > max) throw new ReviewError(`${k} is longer than ${max} characters`);
    it[k] = k === 'title' ? v.replace(/\s+/g, ' ').trim() : v;
  };
  text('title', 300);
  text('body', 60000);
  if (f.severity !== undefined && f.severity !== null) {
    if (!SEVERITIES.includes(f.severity)) throw new ReviewError(`severity must be one of ${SEVERITIES.join(', ')}`);
    it.severity = f.severity;
  }
  if (f.path !== undefined && f.path !== null) {
    if (typeof f.path !== 'string' || f.path.length > 1000 || (/^(?:[A-Za-z]:|[/\\])/.test(f.path)) || f.path.replace(/\\/g, '/').split('/').includes('..') || /[\0\r\n]/.test(f.path)) {
      throw new ReviewError('path must be a file path relative to the repository');
    }
    if (f.path) it.path = f.path;
    else for (const k of ['path', 'line', 'side', 'startLine']) delete it[k];
  }
  const lineNo = (k: 'line' | 'startLine') => {
    const v = f[k];
    if (v === undefined) return;
    if (v === null) delete it[k];
    else if (!Number.isInteger(v) || v < 1) throw new ReviewError(`${k} must be a line number`);
    else it[k] = v;
  };
  lineNo('line');
  lineNo('startLine');
  if (f.side !== undefined && f.side !== null) {
    if (f.side !== 'LEFT' && f.side !== 'RIGHT') throw new ReviewError('side must be LEFT or RIGHT');
    it.side = f.side;
  }
  if (f.ship !== undefined && f.ship !== null) it.ship = f.ship === true;
  if (!it.path) for (const k of ['line', 'side', 'startLine']) delete it[k];
  else if (it.line && !it.side) it.side = 'RIGHT';
  if (!it.line) delete it.startLine;
  if (it.startLine && it.startLine >= it.line) delete it.startLine;
  if (!it.title) throw new ReviewError('a finding needs --title');
  if (!str(it.body).trim()) throw new ReviewError('a finding needs --body (the exact text to post)');
  const sha = str(get(get(pr, 'gh'), 'headSha'));
  if (sha && (!update || f.line !== undefined || f.path !== undefined)) it.sha = sha;
  it.status = 'draft';
  if (!update) pr.findings.push(it);
  return it;
}

export function flag(pr: any, ids: string[], ship = true): string {
  if (!ids.length) throw new ReviewError('flag: give finding ids, e.g. f-1,f-3');
  for (const id of ids) {
    const f = findFinding(pr, id);
    if (fstatus(f) !== 'draft') throw new ReviewError(`${pr.id}: finding ${id} is ${fstatus(f)}`);
  }
  for (const id of ids) findFinding(pr, id).ship = ship;
  return `${pr.id}: ${ids.join(', ')} ${ship ? 'flagged to ship' : 'no longer flagged'}`;
}

export function drop(pr: any, id: string): string {
  const f = findFinding(pr, id);
  if (fstatus(f) === 'posted') throw new ReviewError(`${pr.id}: finding ${id} was already posted`);
  f.status = 'dropped';
  f.ship = false;
  return `${pr.id}: dropped finding ${id}`;
}

export function setVerdict(pr: any, event: string, body: string | null | undefined): string {
  if (!EVENTS.includes(event)) throw new ReviewError(`verdict: event must be one of ${EVENTS.join(', ')}`);
  if (body !== undefined && body !== null && (typeof body !== 'string' || body.length > 60000)) throw new ReviewError('verdict body must be text');
  const v: Record<string, any> = { event };
  const b = body ?? str(get(get(pr, 'verdict'), 'body'));
  if (b && b.trim()) v.body = b;
  pr.verdict = v;
  return `${pr.id}: verdict ${event}${v.body ? ' with a summary' : ''}`;
}

/** Per file in a unified diff: the line numbers a review comment can sit on, per side. */
export function diffLines(text: string): Map<string, { LEFT: Set<number>; RIGHT: Set<number> }> {
  const out = new Map<string, { LEFT: Set<number>; RIGHT: Set<number> }>();
  let cur: { LEFT: Set<number>; RIGHT: Set<number> } | null = null;
  let oldN = 0;
  let newN = 0;
  let inHunk = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = null;
      inHunk = false;
      continue;
    }
    if (!inHunk && line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/\t.*$/, '');
      if (p !== '/dev/null') {
        const path = p.replace(/^b\//, '');
        cur = out.get(path) || { LEFT: new Set(), RIGHT: new Set() };
        out.set(path, cur);
      }
      continue;
    }
    if (!inHunk && line.startsWith('--- ')) {
      const p = line.slice(4).replace(/\t.*$/, '');
      if (p !== '/dev/null') {
        const path = p.replace(/^a\//, '');
        cur = out.get(path) || { LEFT: new Set(), RIGHT: new Set() };
        out.set(path, cur);
      }
      continue;
    }
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (m) {
      oldN = Number(m[1]);
      newN = Number(m[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || !cur) continue;
    if (line.startsWith('+')) cur.RIGHT.add(newN++);
    else if (line.startsWith('-')) cur.LEFT.add(oldN++);
    else if (line.startsWith(' ')) {
      cur.RIGHT.add(newN++);
      cur.LEFT.add(oldN++);
    } else if (line.startsWith('\\')) continue;
    else inHunk = false;
  }
  return out;
}

export interface ReviewPlan {
  payload: Record<string, any>;
  findings: string[];
  inline: string[];
  moved: { id: string; why: string }[];
  command: string;
}

const where = (f: any) => `\`${f.path}\`${f.line ? ` line ${f.startLine ? `${f.startLine}-` : ''}${f.line}` : ''}`;

/**
 * The one GitHub review `ship` would post: flagged draft findings as inline comments where their lines are in the
 * diff, the rest (general, file-level, or off the diff) folded into the review body with a note; never dropped.
 */
export function reviewPayload(base: string, pr: any): ReviewPlan {
  const g = get(pr, 'gh');
  if (!isDict(g)) throw new ReviewError(`${pr.id}: not synced yet; run \`review-kit pr sync ${pr.id}\` first`);
  if (g.state !== 'OPEN') throw new ReviewError(`${pr.id} is ${String(g.state).toLowerCase()}; there is nothing to review`);
  const flagged = findingsOf(pr).filter((f) => fstatus(f) === 'draft' && f.ship === true);
  const verdict = isDict(get(pr, 'verdict')) ? pr.verdict : {};
  const event = EVENTS.includes(verdict.event) ? verdict.event : 'COMMENT';
  const vbody = str(verdict.body).trim();
  if (!flagged.length && !vbody) {
    throw new ReviewError(`${pr.id}: nothing to send; flag findings (\`review-kit pr flag ${pr.id} f-1\`) or write a verdict body`);
  }
  const me = str(get(g, 'viewer')).toLowerCase();
  if (event !== 'COMMENT' && me && str(g.author).toLowerCase() === me) {
    throw new ReviewError(`${pr.id} is your own PR; GitHub does not let you ${event === 'APPROVE' ? 'approve' : 'request changes on'} it (use COMMENT)`);
  }
  let lines = new Map<string, { LEFT: Set<number>; RIGHT: Set<number> }>();
  const dp = get(g, 'diff');
  if (typeof dp === 'string') {
    try {
      lines = diffLines(fs.readFileSync(safety.localSource(base, dp), 'utf8'));
    } catch {
      lines = new Map();
    }
  }
  const comments: Record<string, any>[] = [];
  const general: string[] = [];
  const moved: { id: string; why: string }[] = [];
  const inline: string[] = [];
  for (const f of flagged) {
    const old = findingStale(f, g);
    const note = old ? `\n\n_(Written against ${String(f.sha).slice(0, 7)}; the code may have changed since.)_` : '';
    const side: 'LEFT' | 'RIGHT' = f.side === 'LEFT' ? 'LEFT' : 'RIGHT';
    const file = f.path ? lines.get(f.path) : undefined;
    const lineOk = !!(file && f.line && file[side].has(f.line) && (!f.startLine || file[side].has(f.startLine)));
    if (f.path && f.line && lineOk && !old) {
      const c: Record<string, any> = { path: f.path, line: f.line, side, body: str(f.body) + note };
      if (f.startLine) Object.assign(c, { start_line: f.startLine, start_side: side });
      comments.push(c);
      inline.push(f.id);
      continue;
    }
    if (f.path) {
      const why = old ? 'the head commit changed; re-check this location' : !file ? 'the file is not in the diff' : !f.line ? 'a file-level comment' : 'that line is not in the diff';
      moved.push({ id: f.id, why });
      general.push(`**${where(f)}** (${why}):\n\n${str(f.body)}${note}`);
    } else general.push(str(f.body) + note);
  }
  const body = [vbody, ...general].filter(Boolean).join('\n\n---\n\n');
  const payload: Record<string, any> = { commit_id: str(g.headSha), event };
  if (body) payload.body = body;
  if (comments.length) payload.comments = comments;
  if (!payload.commit_id) delete payload.commit_id;
  const json = JSON.stringify(payload, null, 2);
  const command = `gh api repos/${pr.repo}/pulls/${pr.number}/reviews -X POST --input - <<'RK_REVIEW'\n${json}\nRK_REVIEW`;
  return { payload, findings: flagged.map((f) => f.id), inline, moved, command };
}

/** Post the review (one gh api call), mark the shipped findings posted, clear the verdict and re-sync. */
export function ship(base: string, data: any, id: string, dryRun = false): { plan: ReviewPlan; message: string; synced: boolean; posted?: any } {
  const pr = findPr(data, id);
  const g = get(pr, 'gh');
  if (isDict(g) && !dryRun) g.viewer = gh.viewer();
  const plan = reviewPayload(base, pr);
  if (dryRun) return { plan, message: `dry run: would post ${describePlan(plan)} to ${pr.repo}#${pr.number}`, synced: false };
  const out = gh.exec(gh.mutations.review(ref(pr), plan.payload));
  let resp: any = {};
  try {
    resp = JSON.parse(out);
  } catch {
    resp = {};
  }
  const posted: Record<string, any> = { at: nowIso() };
  const url = str(get(resp, 'html_url'));
  if (url && safety.safeUrl(url) === url) posted.url = url;
  if (Number.isInteger(get(resp, 'id'))) posted.reviewId = resp.id;
  if (plan.payload.commit_id) posted.sha = plan.payload.commit_id;
  for (const fid of plan.findings) {
    const f = findFinding(pr, fid);
    f.status = 'posted';
    f.ship = false;
    f.posted = { ...posted };
  }
  delete pr.verdict;
  let message = `Sent ${describePlan(plan)} to ${pr.repo}#${pr.number}`;
  let synced = true;
  try {
    fetchInto(base, pr);
  } catch (e) {
    if (!(e instanceof ReviewError)) throw e;
    message += ' (re-sync failed; run sync)';
    synced = false;
  }
  return { plan, message, synced, posted };
}

function describePlan(p: ReviewPlan): string {
  const ev = { COMMENT: 'a review', APPROVE: 'an approval', REQUEST_CHANGES: 'a change request' }[p.payload.event as string] || 'a review';
  return `${ev} with ${plural(p.findings.length, 'finding')} (${p.inline.length} inline)`;
}
