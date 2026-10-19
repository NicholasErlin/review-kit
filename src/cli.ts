#!/usr/bin/env node
/** Command line interface: review-kit <command> ...  (run `review-kit -h`). */
import fs from 'node:fs';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ArgparseExit, type Namespace } from './argparse.js';
import * as attach from './attach.js';
import { buildAny } from './build.js';
import * as clean from './clean.js';
import { parser } from './cliparser.js';
import * as companions from './companions.js';
import * as design from './design.js';
import * as edit from './edit.js';
import { ReviewError } from './errors.js';
import * as ideas from './ideas.js';
import { eprint, print } from './io.js';
import * as model from './model.js';
import { dumps, JSONDecodeError, loads } from './pyjson.js';
import {
  abspath, basename, copyDict, decodeUtf8, dirname, exists, get, has, isabs, isdir, isDict, isfile, isOSError, join,
  osErrorMessage, relpath, reprStr, setKey, sorted, strip, today, truthy, UnicodeDecodeError,
} from './py.js';
import * as serveMod from './serve.js';
import { setup } from './setup.js';
import { cmdShot } from './shot.js';
import { summarise } from './summary.js';
import * as validate from './validate.js';

export const CANDIDATES = ['review.json', '.review/review.json', 'docs/review/review.json', 'review/review.json'];
export const KIND_PARENTS = ['.review', 'docs/review'];

/** .review/<kind>/review.json (and docs/review/<kind>/) under `parent`, or under the cwd's kind parents. */
function kindReviews(parent?: string): string[] {
  const parents = parent ? [parent] : KIND_PARENTS;
  return sorted(parents.flatMap((p) => companions.glob(join(p, '*', 'review.json'))));
}

export function findReview(path?: string | null): string {
  const found = findReviews(path ? [path] : []);
  if (found.length === 1) return found[0];
  throw new ReviewError('several reviews here (' + found.join(', ') + '); pass one, e.g. `review-kit build ui`');
}

function resolveOne(path: string): string[] {
  if (!exists(path) && has(attach.KIND_DEFAULTS, path)) {
    for (const parent of KIND_PARENTS) {
      if (isfile(join(parent, path, 'review.json'))) return [join(parent, path, 'review.json')];
    }
  }
  if (isdir(path)) {
    // A parent folder such as .review/ that holds one review per kind stands for all of them.
    if (!exists(join(path, 'review.json'))) {
      const kids = kindReviews(path);
      if (kids.length) return kids;
    }
    return [join(path, 'review.json')];
  }
  return [path];
}

/**
 * The reviews a command acts on. With no paths: the first CANDIDATES file, else every .review/<kind>/review.json
 * (and docs/review/<kind>/). A kind, a review.json, its folder, or a parent folder holding several kinds can be given.
 */
export function findReviews(paths: (string | null | undefined)[] = []): string[] {
  const given = paths.filter((p): p is string => !!p);
  if (given.length) {
    const out: string[] = [];
    for (const p of given) for (const r of resolveOne(p)) if (!out.includes(r)) out.push(r);
    return out;
  }
  for (const c of CANDIDATES) if (isfile(c)) return [c];
  const found = kindReviews();
  if (found.length) return found;
  throw new ReviewError('no review.json found here (looked for ' + CANDIDATES.join(', ')
    + ', .review/<kind>/review.json); pass a path or run `review-kit init`');
}

/** Where a combined site goes by default: site/ in the folder the reviews share (.review/site). */
export function combinedOut(paths: string[]): string {
  const parents = [...new Set(paths.map((p) => dirname(abspath(model.baseDir(p)))))];
  if (parents.length !== 1) {
    throw new ReviewError('these reviews do not share a parent folder; pass --out DIR for the combined site');
  }
  return relpath(join(parents[0], 'site'));
}

function readStdin(): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(1 << 16);
  for (;;) {
    let n: number;
    try {
      n = fs.readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EAGAIN') continue;
      if ((e as NodeJS.ErrnoException).code === 'EOF') break;
      throw e;
    }
    if (!n) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return decodeUtf8(Buffer.concat(chunks)).replace(/\r\n?/g, '\n');
}

function readJsonArg(a: Namespace): any {
  if (truthy(a.json)) {
    try {
      return loads(a.json);
    } catch (e) {
      if (e instanceof JSONDecodeError) throw new ReviewError(`--json: invalid JSON: ${e.message}`);
      throw e;
    }
  }
  if (truthy(a.file)) {
    if (a.file === '-') {
      try {
        return loads(readStdin());
      } catch (e) {
        if (e instanceof JSONDecodeError || e instanceof UnicodeDecodeError) throw new ReviewError(`stdin: invalid JSON: ${e.message}`);
        throw e;
      }
    }
    return model.load(a.file);
  }
  return null;
}

export function csv(s: string | null | undefined): string[] {
  return s ? s.split(',').map((x) => strip(x)).filter(Boolean) : [];
}

/** Image paths on the command line: relative to review.json if found there, else to the cwd (then copied in). */
function cliPath(p: string, reviewPath: string): string {
  if (isabs(p) || exists(join(model.baseDir(reviewPath), p))) return p;
  return abspath(p);
}

function saveChecked(path: string, data: any): void {
  const warnings = edit.check(data, model.baseDir(path));
  model.save(path, data);
  for (const w of warnings) print('warning:', w);
}

const setdefault = (d: Record<string, any>, k: string, v: unknown) => {
  if (!has(d, k)) setKey(d, k, v);
  return d[k];
};

// ---------------------------------------------------------------- commands
function cmdInit(a: Namespace): void {
  const d = a.kind ? attach.KIND_DEFAULTS[a.kind] : undefined;
  const platforms = a.platforms !== null ? csv(a.platforms) : d ? d.platforms : ['mobile', 'desktop'];
  const path = edit.init(a.dir, a.name || basename(abspath('.')), a.title || (d ? d.title : 'Review'),
    platforms.length ? platforms : ['default'], a.ignore_screenshots, a.accent, a.kind);
  const dir = dirname(path);
  print(`created ${path}, ${dir}/screenshots/, ${dir}/pending/, ${dir}/.gitignore`);
  print(`next: review-kit add-issue ${path} --title "..." --severity P1   |   review-kit build ${path}`);
}

function cmdValidate(a: Namespace): number {
  const path = findReview(a.review || a.review_opt);
  const data = model.load(path);
  const [errors, warnings] = validate.validate(data, model.baseDir(path), !a.no_files);
  for (const w of warnings) print('warning:', w);
  if (errors.length) {
    eprint(errors.map((e) => 'error: ' + e).join('\n'));
    return 1;
  }
  const n = (k: string) => (get(data, k) || []).length;
  const extra = [['research', 'research entries'], ['ideas', 'ideas'], ['proposals', 'proposals']]
    .filter(([k]) => n(k)).map(([k, what]) => `, ${n(k)} ${what}`).join('');
  print(`${path}: valid (${n('issues')} issues, ${n('fixes')} fixes${extra})`);
  return 0;
}

const defaultOut = (path: string) => join(model.baseDir(path), 'site');

/** The review arguments of build / serve / clean (positional, plus the hidden -r). */
function reviewArgs(a: Namespace, key = 'review'): string[] {
  const v = a[key];
  const list: string[] = Array.isArray(v) ? v : v ? [v] : [];
  return a.review_opt ? [...list, a.review_opt] : list;
}

function siteOut(a: Namespace, paths: string[]): string {
  return a.out || (paths.length === 1 ? defaultOut(paths[0]) : combinedOut(paths));
}

/** A combined site built to its default folder (.review/site) is kept out of git like each review's own site/. */
function ignoreSite(a: Namespace, paths: string[], out: string): void {
  if (paths.length > 1 && !a.out && edit.ignoreCombinedSite(dirname(out))) {
    print(`note: added site/ to ${join(dirname(out), '.gitignore')}`);
  }
}

function cmdBuild(a: Namespace): void {
  const paths = findReviews(reviewArgs(a));
  const out = siteOut(a, paths);
  ignoreSite(a, paths, out);
  buildAny(paths, out, { maxWidth: a.max_width, force: a.force, clean: a.clean });
}

async function cmdServe(a: Namespace): Promise<number> {
  const targets = reviewArgs(a, 'target');
  const target = targets.length === 1 ? targets[0] : null;
  let server;
  if (target && isdir(target) && isfile(join(target, 'index.html')) && !isfile(join(target, 'review.json'))) {
    server = await serveMod.serve(target, a.host, a.port);
  } else {
    const paths = findReviews(targets);
    const out = siteOut(a, paths);
    if (!a.no_build) ignoreSite(a, paths, out);
    if (!a.no_build) buildAny(paths, out, { maxWidth: a.max_width, force: a.force });
    server = await serveMod.serve(out, a.host, a.port, { reviewPath: paths, watch: a.watch, maxWidth: a.max_width });
  }
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => {
      server.close();
      server.closeAllConnections?.();
      resolve();
    });
  });
  return 0;
}

function cmdAddIssue(a: Namespace): void {
  const path = findReview(a.review || a.review_opt);
  const data = edit.loadChecked(path);
  const obj = readJsonArg(a);
  const items: any[] = Array.isArray(obj) ? obj : truthy(obj) ? [obj] : [{}];
  const flags: Record<string, any> = {};
  for (const [k, v] of Object.entries({
    id: a.id, platform: a.platform, area: a.area, severity: a.severity, status: a.status,
    title: a.title, details: a.details, note: a.note, where: a.where,
  })) if (v !== null && v !== undefined) flags[k] = v;
  if (a.top) flags.top = true;
  if (truthy(a.screenshot)) flags.screenshots = a.screenshot.map((x: string) => cliPath(x, path));
  if (a.tags) flags.tags = csv(a.tags);
  const out = items.map((item) => {
    if (!isDict(item)) throw new TypeError(`'${typeof item}' object is not iterable`);
    const it = copyDict(item);
    for (const k of Object.keys(flags)) setKey(it, k, flags[k]);
    if (['', 'none', 'null'].includes(get(it, 'severity'))) it.severity = null;
    return edit.upsertIssue(data, it, model.baseDir(path), a.update);
  });
  saveChecked(path, data);
  for (const it of out) {
    print(`issue ${model.s(it.id)}: ${model.s(it.title)} [${truthy(get(it, 'severity')) ? model.s(it.severity) : '-'} / ${model.s(get(it, 'status'))}]`);
  }
}

function cmdAddFix(a: Namespace): void {
  const path = findReview(a.review || a.review_opt);
  const data = edit.loadChecked(path);
  const read = readJsonArg(a);
  const obj = truthy(read) ? read : {};
  let env: Record<string, any> = truthy(obj) ? edit.normaliseEnvelope(obj) : { fix: {} };
  const fx: Record<string, any> = copyDict(truthy(get(env, 'fix')) ? env.fix : {});
  for (const [k, v] of Object.entries({ id: a.id, title: a.title, date: a.date, summary: a.summary })) {
    if (v !== null && v !== undefined) setKey(fx, k, v);
  }
  if (a.number !== null && a.number !== undefined) fx.number = a.number;
  if (a.files) fx.files = csv(a.files);
  for (const link of a.link || []) {
    const i = link.indexOf('=');
    const label = i < 0 ? link : link.slice(0, i);
    const href = i < 0 ? '' : link.slice(i + 1);
    setdefault(fx, 'links', []).push(href ? { label, href } : { label: link, href: link });
  }
  for (const sha of a.commit || []) setdefault(fx, 'commits', []).push({ sha });
  for (const [plat, before, after] of a.pair || []) {
    const p = setdefault(setdefault(fx, 'platforms', {}), plat, {});
    const pr: Record<string, string> = {};
    for (const [role, val] of [['before', before], ['after', after]]) {
      if (val !== '-' && val !== '') pr[role] = cliPath(val, path);
    }
    setdefault(p, 'pairs', []).push(pr);
  }
  const marks: any[] = Array.isArray(get(env, 'marks')) ? [...env.marks] : [];
  for (const i of csv(a.resolves)) marks.push({ issue: i, status: 'fixed' });
  for (const i of csv(a.partial)) marks.push({ issue: i, status: 'partial' });
  for (const i of [...csv(a.resolves), ...csv(a.partial)]) {
    if (!(has(fx, 'issues') ? fx.issues : []).includes(i)) setdefault(fx, 'issues', []).push(i);
  }
  env = copyDict(env);
  env.fix = fx;
  env.marks = marks;
  const log = edit.merge(data, env, model.baseDir(path), a.update);
  saveChecked(path, data);
  print(log.join('\n'));
}

function cmdAddPlan(a: Namespace): void {
  const path = findReview(a.review || a.review_opt);
  const data = edit.loadChecked(path);
  const read = readJsonArg(a);
  if (truthy(read) && !isDict(read)) throw new TypeError('dictionary update sequence element #0 is not a sequence');
  const it: Record<string, any> = copyDict(truthy(read) ? read : {});
  for (const [k, v] of Object.entries({
    id: a.id, title: a.title, phase: a.phase, status: a.status, effort: a.effort,
    severity: a.severity, note: a.note, details: a.details,
  })) if (v !== null && v !== undefined) setKey(it, k, v);
  if (a.files) it.files = csv(a.files);
  const g = get(it, 'group');
  delete it.group;
  const group = truthy(g) ? g : a.group || 'Plan';
  const item = edit.addPlanItem(data, group, it);
  saveChecked(path, data);
  print(`plan item ${model.s(item.id)} added to "${model.s(group)}"`);
}

function looksLikeReview(arg: string): boolean {
  return has(attach.KIND_DEFAULTS, arg) || arg.endsWith('.json') || isdir(arg);
}

function cmdMark(a: Namespace): void {
  // `mark [review] <status> <ids...>`, like the other commands; `-r review` still works.
  const statuses = [...model.ISSUE_STATUSES, ...model.PLAN_STATUSES];
  if (a.review_opt === null && !statuses.includes(a.status) && looksLikeReview(a.status)) {
    if (!a.ids.length || !statuses.includes(a.ids[0])) {
      throw new ReviewError('usage: review-kit mark [review] <status> <ids...> (status: ' + statuses.join('|') + ')');
    }
    if (a.ids.length < 2) throw new ReviewError('mark: give one or more issue or plan item ids after the status');
    [a.review_opt, a.status, a.ids] = [a.status, a.ids[0], a.ids.slice(1)];
  }
  const path = findReview(a.review_opt);
  const data = edit.loadChecked(path);
  const msgs = a.ids.map((i: string) => edit.applyMark(data, { id: i, status: a.status, note: a.note || '' }, a.fix));
  saveChecked(path, data);
  print(msgs.join('\n'));
}

function cmdApplyPending(a: Namespace): void {
  const path = findReview(a.review || a.review_opt);
  const results = edit.applyPending(path, a.dir);
  if (!results.length) print('nothing pending');
  for (const [name, log, warnings] of results) {
    print(`${name}: ` + log.join('; '));
    for (const w of warnings) print('  warning:', w);
  }
}

function cmdSummary(a: Namespace): void {
  const path = findReview(a.review || a.review_opt);
  print(summarise(edit.loadChecked(path), a.open, !a.text));
}

function cmdClean(a: Namespace): void {
  const paths = findReviews(reviewArgs(a));
  const opts = { site: !a.keep_site, applied: !a.keep_applied, orphaned: a.orphans, dryRun: a.dry_run };
  let removed: string[] = [];
  let skipped: string[] = [];
  if (paths.length === 1) [removed, skipped] = clean.clean(paths[0], { ...opts, out: a.out });
  else {
    // Several reviews: the combined site (or --out), plus each review's own site/ unless --out names the folder.
    for (const p of paths) {
      const [r, s] = clean.clean(p, { ...opts, site: opts.site && !a.out });
      removed.push(...r);
      skipped.push(...s);
    }
    if (opts.site) {
      const [r, s] = clean.cleanSite(abspath(siteOut(a, paths)), opts.dryRun);
      removed.push(...r);
      skipped.push(...s);
    }
  }
  for (const line of skipped) print('skipped:', line);
  const verb = a.dry_run ? 'would remove' : 'removed';
  for (const line of removed) print(`${verb}: ${line}`);
  if (!removed.length) print('nothing to clean');
}

// ---------------------------------------------------------------- research, ideas and design proposals
/** `cmd [review] <n args>`: split off a leading review argument when one more word than needed was given. */
function splitWords(a: Namespace, n: number, usage: string): string[] {
  const words: string[] = [...a.words];
  if (words.length === n + 1 && a.review_opt === null && looksLikeReview(words[0])) a.review_opt = words.shift();
  // `decide ideas i-1` (a kind, then too few words) is a missing argument, not an idea called "ideas"
  const kindFirst = words.length === n && a.review_opt === null && has(attach.KIND_DEFAULTS, words[0]);
  if (words.length !== n || kindFirst) throw new ReviewError(`usage: ${usage}`);
  return words;
}

/** Fields from --json/--file merged with the flags that were given (flags win). */
function objectArg(a: Namespace, flags: Record<string, unknown>): Record<string, any> {
  const read = readJsonArg(a);
  if (truthy(read) && !isDict(read)) throw new ReviewError('--json/--file: expected a JSON object');
  const obj: Record<string, any> = copyDict(truthy(read) ? read : {});
  for (const [k, v] of Object.entries(flags)) if (v !== null && v !== undefined) setKey(obj, k, v);
  return obj;
}

/** Load, change, validate and save one review; prints the change log and validation warnings (minus `skip`). */
function editReview(path: string, fn: (data: any, path: string) => string[], skip: (w: string) => boolean = () => false): void {
  const data = edit.loadChecked(path);
  const log = fn(data, path);
  const warnings = edit.check(data, model.baseDir(path));
  model.save(path, data);
  for (const w of warnings) if (!skip(w)) print('warning:', w);
  for (const line of log) print(line);
}

function kindOfReview(path: string): string | null {
  try {
    const data = model.load(path);
    return isDict(data) && isDict(data.project) ? String(get(data.project, 'kind') ?? 'ui') : null;
  } catch (e) {
    if (e instanceof ReviewError) return null;
    throw e;
  }
}

function hasProposal(path: string, id: string): boolean {
  try {
    const data = model.load(path);
    return (get(data, 'proposals') || []).some((p: any) => isDict(p) && p.id === id);
  } catch (e) {
    if (e instanceof ReviewError) return false;
    throw e;
  }
}

/** How to name `path` on the command line: its kind when `.review/<kind>/` resolves to it, else its path. */
function reviewHint(path: string, kind?: string | null): string {
  const k = kind || kindOfReview(path);
  if (k && has(attach.KIND_DEFAULTS, k)) {
    try {
      if (abspath(findReview(k)) === abspath(path)) return k;
    } catch (e) {
      if (!(e instanceof ReviewError)) throw e;
    }
  }
  return relpath(path);
}

/**
 * The review a research/ideas/design command acts on. Given: that one. Otherwise the only review, else the only
 * review of `kind` (ideas or design), else (design commands) the only review holding the proposal. Still ambiguous:
 * an error whose example names the review, e.g. `review-kit adopt design hero plain`.
 */
function findFor(review: string | null | undefined, kind: string, example: (hint: string) => string, proposal?: string): string {
  if (review) return findReview(review);
  const found = findReviews([]);
  if (found.length === 1) return found[0];
  const ofKind = found.filter((p) => kindOfReview(p) === kind);
  if (ofKind.length === 1) return ofKind[0];
  if (proposal) {
    const holding = (ofKind.length ? ofKind : found).filter((p) => hasProposal(p, proposal));
    if (holding.length === 1) return holding[0];
  }
  const byKind = ofKind.find((p) => reviewHint(p, kind) === kind);
  const hint = byKind || !ofKind.length ? kind : relpath(ofKind[0]);
  throw new ReviewError(`several reviews here (${found.join(', ')}); pass one, e.g. \`${example(hint)}\``);
}

/** True when the cwd has several reviews, so printed commands need the review argument. */
function severalReviews(): boolean {
  try {
    return findReviews([]).length > 1;
  } catch (e) {
    if (e instanceof ReviewError) return false;
    throw e;
  }
}

function cmdAddResearch(a: Namespace): void {
  const path = findFor(a.review || a.review_opt, 'ideas', (h) => `review-kit add-research ${h} --title ...`);
  editReview(path, (data) => {
    const isWeb = (href: string) => /^https?:/i.test(href);
    const quotes: string[] = a.quote || [];
    if (quotes.length > (a.source || []).length) throw new ReviewError('--quote: give one --source per quote (the n-th quote goes with the n-th source)');
    const sources = (a.source || []).map((x: string, i: number) => {
      const src: Record<string, any> = ideas.parseSource(x);
      const accessed = a.accessed || (isWeb(src.href) ? today() : null);
      if (accessed) src.accessed = accessed;
      if (quotes[i]) src.quote = quotes[i];
      if (a.source_kind) src.kind = a.source_kind;
      return src;
    });
    const r = ideas.upsertResearch(data, objectArg(a, {
      id: a.id, title: a.title, summary: a.summary, confidence: a.confidence,
      tags: a.tags ? csv(a.tags) : null, sources: sources.length ? sources : null,
    }), a.update);
    return [`research ${model.s(r.id)}: ${model.s(r.title)} (${(get(r, 'sources') || []).length} source(s))`];
  });
}

function cmdAddIdea(a: Namespace): void {
  const path = findFor(a.review || a.review_opt, 'ideas', (h) => `review-kit add-idea ${h} --title ...`);
  editReview(path, (data) => {
    const it = ideas.upsertIdea(data, objectArg(a, {
      id: a.id, title: a.title, status: a.status, problem: a.problem, proposal: a.proposal, reasoning: a.reasoning,
      alternatives: a.alternatives, risks: a.risks, effort: a.effort, impact: a.impact, confidence: a.confidence,
      rank: a.rank, evidence: a.evidence !== null ? csv(a.evidence) : null, pros: a.pro, cons: a.con,
      tags: a.tags ? csv(a.tags) : null,
    }), a.update);
    return [`idea ${model.s(it.id)}: ${model.s(it.title)} [${model.s(get(it, 'status'))}]`];
  });
}

function cmdDecide(a: Namespace): void {
  const [id, status] = splitWords(a, 2, 'review-kit decide [review] <idea> proposed|go|maybe|no|done [--note TEXT]');
  const path = findFor(a.review_opt, 'ideas', (h) => `review-kit decide ${h} ${id} ${status}`);
  editReview(path, (data) => [ideas.decide(data, id, status, a.note || '')]);
}

function cmdAddProposal(a: Namespace): void {
  let idea: string | null = null;
  let proposalId = '';
  let fresh = false;
  const path = findFor(a.review || a.review_opt, 'design', (h) => `review-kit add-proposal ${h} --id ${a.id || 'ID'} ...`);
  editReview(path, (data) => {
    const obj = objectArg(a, {
      id: a.id, title: a.title, brief: a.brief, idea: a.idea, status: a.status,
      criteria: a.criterion ? a.criterion.map(ideas.parseCriterion) : null,
    });
    if (!truthy(get(obj, 'id'))) throw new ReviewError('add-proposal needs --id (it becomes part of the option branch names)');
    const pr = ideas.upsertProposal(data, obj, a.update);
    idea = truthy(get(pr, 'idea')) ? pr.idea : null;
    proposalId = pr.id;
    fresh = !(get(pr, 'options') || []).length;
    const log = [`proposal ${model.s(pr.id)}: ${model.s(pr.title)} (${(get(pr, 'criteria') || []).length} criteria)`];
    if (idea && ideas.linkIdea(data, idea, pr.id)) log.push(`idea ${idea}: linked to proposal ${pr.id}`);
    return log;
  }, (w) => fresh && w.startsWith(`proposals[${proposalId}]: 0 option(s)`)); // options come later
  if (idea) linkIdeaElsewhere(path, idea, proposalId);
}

/** When the idea lives in a sibling review (.review/ideas/), add the proposal to its `proposals` there too. */
function linkIdeaElsewhere(reviewPath: string, ideaId: string, proposalId: string): void {
  const parent = dirname(model.baseDir(reviewPath));
  for (const other of kindReviews(parent)) {
    if (abspath(other) === abspath(reviewPath)) continue;
    let data: any;
    try {
      data = edit.loadChecked(other);
    } catch (e) {
      if (e instanceof ReviewError) continue;
      throw e;
    }
    if (ideas.linkIdea(data, ideaId, proposalId)) {
      edit.check(data, model.baseDir(other)); // its own warnings are not this command's business
      model.save(other, data);
      print(`idea ${ideaId} in ${relpath(other)}: linked to proposal ${proposalId}`);
    }
  }
}

function cmdOption(a: Namespace): void {
  const words: string[] = [...a.words];
  if (words.length >= 2 && !['new', 'record'].includes(words[0]) && ['new', 'record'].includes(words[1]) && a.review_opt === null) {
    a.review_opt = words.splice(0, 1)[0];
  }
  const action = words.shift();
  if (action !== 'new' && action !== 'record') {
    throw new ReviewError('usage: review-kit option new|record [review] <proposal> <option> ... (see `review-kit option -h`)');
  }
  a.words = words;
  const [proposal, option] = splitWords(a, 2, `review-kit option ${action} [review] <proposal> <option> ...`);
  const path = findFor(a.review_opt, 'design', (h) => `review-kit option ${action} ${h} ${proposal} ${option} ...`, proposal);
  if (action === 'new') {
    if (!a.title) throw new ReviewError('option new: --title is required');
    const made: { worktree?: string } = {};
    editReview(path, (data) => {
      edit.check(data, model.baseDir(path)); // refuse an invalid review before creating any branch
      const res = design.optionNew(path, data, proposal, option, a.title, a.base, a.worktree_root);
      made.worktree = res.worktree;
      return [...res.log, `option ${proposal}/${option}: branch ${res.branch} from ${res.base.slice(0, 7)}`];
    });
    print(`worktree: ${made.worktree}`);
    print('next: build the option there and commit on the branch, run its tests, take the same screenshots as the other options,');
    const rv = severalReviews() || a.review_opt ? reviewHint(path) + ' ' : '';
    print(`      then: review-kit option record ${rv}${proposal} ${option} --summary ... --reasoning ... --score <criterion>=N:why ...`);
    return;
  }
  const shots = (a.shot || []).map((x: string[]) => {
    if (x.length < 2 || x.length > 3) throw new ReviewError('--shot: expected PLATFORM PATH [CAPTION]');
    return x;
  });
  editReview(path, (data) => design.optionRecord(path, data, proposal, option, {
    title: a.title, summary: a.summary, reasoning: a.reasoning, evidence: a.evidence, pros: a.pro, cons: a.con,
    scores: a.score || [], shots: shots.map(([pl, p, c]: string[]) => [pl, cliPath(p, path), c] as [string, string, string?]),
  }));
}

function cmdRecommend(a: Namespace): void {
  const [proposal, option] = splitWords(a, 2, 'review-kit recommend [review] <proposal> <option> --reasoning TEXT');
  const path = findFor(a.review_opt, 'design', (h) => `review-kit recommend ${h} ${proposal} ${option} --reasoning ...`, proposal);
  editReview(path, (data) => [ideas.recommend(data, proposal, option, a.reasoning)]);
}

function cmdAdopt(a: Namespace): void {
  const [proposal, option] = splitWords(a, 2, 'review-kit adopt [review] <proposal> <option> [--no-commit] [--message TEXT]');
  const path = findFor(a.review_opt, 'design', (h) => `review-kit adopt ${h} ${proposal} ${option}`, proposal);
  editReview(path, (data) => {
    edit.check(data, model.baseDir(path));
    return design.adopt(path, data, proposal, option, { commit: !a.no_commit, message: a.message, recordOnly: a.record_only });
  });
}

function cmdDiscard(a: Namespace): void {
  const [proposal] = splitWords(a, 1, 'review-kit discard [review] <proposal> [--option ID]... [--force] [--dry-run]');
  const path = findFor(a.review_opt, 'design', (h) => `review-kit discard ${h} ${proposal}`, proposal);
  if (a.dry_run) {
    for (const line of design.discard(path, edit.loadChecked(path), proposal, { options: a.option || [], force: a.force, dryRun: true })) print(line);
    return;
  }
  editReview(path, (data) => design.discard(path, data, proposal, { options: a.option || [], force: a.force }));
}

function cmdAttach(a: Namespace): void {
  const files = a.no_agents_file ? [] : (truthy(a.agents_file) ? a.agents_file : null);
  const kinds = csv(a.kind);
  for (const line of attach.attach(a.repo, {
    kinds: kinds.length ? kinds : ['ui'], directory: a.dir, name: a.name, title: a.title, platforms: csv(a.platforms),
    ignoreScreenshots: a.ignore_screenshots, accent: a.accent, agentFiles: files,
  })) print(line);
  print('next: ask your agent to run a review (it reports issues, then fixes the ones you approve)');
}

async function cmdCompanions(a: Namespace): Promise<void> {
  const k0 = csv(a.kind);
  // ui and backend between them cover every companion (design uses both sets), so they are the default.
  const kinds = k0.length ? k0 : ['ui', 'backend'];
  for (const k of kinds) {
    if (!companions.KINDS.includes(k)) {
      throw new ReviewError(`unknown review kind ${reprStr(k)}; expected one of ${companions.KINDS.join(', ')}`);
    }
  }
  if (a.path) {
    const found = companions.find(a.path);
    if (!found) throw new ReviewError(`${a.path}: not installed (\`review-kit companions install\` adds it)`);
    print(dirname(found));
    return;
  }
  if (a.action === 'install' || a.action === 'update') {
    const lines = a.action === 'install'
      ? companions.install(kinds, truthy(a.skills_dir) ? a.skills_dir : null)
      : await companions.update(kinds);
    for (const line of lines) print(line);
    return;
  }
  const rows = companions.status(kinds);
  if (a.json) {
    print(dumps(rows.map(([k, c, p]) => ({ kind: k, name: c.name, use: c.use, source: c.repo, path: p })), 2, true));
    return;
  }
  const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - Array.from(s).length));
  for (const k of kinds) if (!companions.COMPANIONS[k].length) print(`${pad(k, 8)} (no companion skills; research uses web search and the codebase)`);
  for (const [k, c, p] of rows) {
    print(`${pad(k, 8)} ${pad(c.name, 24)} ${p || 'not installed'}`);
    print(`${pad('', 8)} ${pad('', 24)} ${c.use}`);
  }
  if (rows.some(([, , p]) => p === null)) {
    print('\nmissing skills are optional; `review-kit companions install` links the bundled copies into '
      + '~/.claude/skills, or pass --skills-dir DIR for other agents');
  }
}

function cmdSetup(a: Namespace): void {
  for (const line of setup({ skillsDirs: a.skills_dir, noSkill: a.no_skill, withCompanions: a.with_companions })) print(line);
}

// ---------------------------------------------------------------- main
const COMMANDS: Record<string, (a: Namespace) => void | number | Promise<void | number>> = {
  init: cmdInit,
  attach: cmdAttach,
  validate: cmdValidate,
  build: cmdBuild,
  serve: cmdServe,
  'add-issue': cmdAddIssue,
  'add-fix': cmdAddFix,
  'add-plan': cmdAddPlan,
  'add-research': cmdAddResearch,
  'add-idea': cmdAddIdea,
  decide: cmdDecide,
  'add-proposal': cmdAddProposal,
  option: cmdOption,
  recommend: cmdRecommend,
  adopt: cmdAdopt,
  discard: cmdDiscard,
  mark: cmdMark,
  'apply-pending': cmdApplyPending,
  summary: cmdSummary,
  clean: cmdClean,
  companions: cmdCompanions,
  home: () => print(model.ROOT),
  schema: () => print(model.SCHEMA_PATH),
  setup: cmdSetup,
  shot: (a) => cmdShot({
    url: a.url, out: a.out, viewport: a.viewport, full: a.full, dark: a.dark, waitFor: a.wait_for, wait: a.wait,
    selector: a.selector, storage: a.storage, steps: a.steps, quality: a.quality,
  }),
};

/** Run the CLI with argv (without the node and script paths). Resolves with the exit status. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: Namespace;
  try {
    args = parser().parseArgs(argv);
  } catch (e) {
    if (e instanceof ArgparseExit) return e.status;
    throw e;
  }
  try {
    return (await COMMANDS[args.cmd](args)) || 0;
  } catch (e) {
    if (e instanceof ReviewError) {
      eprint(`review-kit: ${e.message}`);
      return 1;
    }
    if (isOSError(e)) {
      eprint(`review-kit: ${osErrorMessage(e)}`);
      return 1;
    }
    throw e;
  }
}

function isMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main().then((code) => {
    process.exitCode = code;
  }, (e) => {
    process.stderr.write((e instanceof Error && e.stack ? e.stack : String(e)) + '\n');
    process.exitCode = 1;
  });
}
