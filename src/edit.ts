/** Commands that create or update review.json: init, add-issue, add-fix, add-plan, mark, apply-pending. */
import fs from 'node:fs';
import { ReviewError } from './errors.js';
import { copy2 } from './images.js';
import * as model from './model.js';
import {
  abspath, basename, capitalize, cmpStr, copyDict, exists, get, has, isabs, isDict, isfile, isdir, isInt, isLower, join,
  listdir, numStr, pyEq, pySlice, relpath, rstrip, setKey, splitext, strip, today, truthy, typeName,
} from './py.js';
import * as safety from './safety.js';
import * as validate from './validate.js';
import { FORMAT_VERSION } from './version.js';

export const PENDING_KEYS = ['fix', 'issues', 'marks', 'plan'];
const S = model.s;

/** d.setdefault(k, v) */
function setdefault(d: Record<string, any>, k: string, v: unknown): any {
  if (!has(d, k)) setKey(d, k, v);
  return d[k];
}

/** list(x) for a JSON value: lists are copied, strings give their characters, dicts their keys. */
function pyList(x: unknown): any[] {
  if (Array.isArray(x)) return [...x];
  if (typeof x === 'string') return Array.from(x);
  if (isDict(x)) return Object.keys(x);
  throw new TypeError(`'${typeName(x)}' object is not iterable`);
}

// ---------------------------------------------------------------- init
export function init(directory: string, name: string, title = 'Review', platforms: string[] = ['mobile', 'desktop'],
  ignoreScreenshots = false, accent: string | null = null, kind: string | null = null): string {
  fs.mkdirSync(directory, { recursive: true });
  const path = join(directory, 'review.json');
  if (exists(path)) throw new ReviewError(`${path} already exists`);
  const plats = platforms.map((p) => {
    const pid = strip(strip(p).replace(/[^A-Za-z0-9_-]+/g, '-'), '-') || 'default';
    const shape = ['mobile', 'phone', 'ios', 'android'].includes(pid.toLowerCase()) ? 'portrait' : 'auto';
    return { id: pid, label: isLower(p) ? capitalize(strip(p)) : strip(p), shape };
  });
  const data: Record<string, any> = {
    $schema: model.SCHEMA_URL,
    version: FORMAT_VERSION,
    project: { name, title, date: today(), links: [] } as Record<string, any>,
    platforms: plats,
    severities: model.DEFAULT_SEVERITIES.map((x) => ({ ...x })),
    areas: [], issues: [], fixes: [], plan: [],
  };
  if (kind) data.project.kind = kind;
  if (kind === 'ideas') Object.assign(data, { research: [], ideas: [] });
  if (kind === 'design') data.proposals = [];
  if (accent) data.project.theme = { accent };
  model.save(path, data);
  for (const sub of ['screenshots', 'pending']) {
    fs.mkdirSync(join(directory, sub), { recursive: true });
    const keep = join(directory, sub, '.gitkeep');
    if (!exists(keep)) fs.closeSync(fs.openSync(keep, 'w'));
  }
  let ignore = ['# review-kit build output', 'site/', '# Local secrets and browser sessions',
    '.env', '.env.*', '!.env.example', '!.env.sample', '*.pem', '*.key', '*.p12', '*.pfx',
    '*.keystore', 'credentials', 'credentials.json', 'secrets.json', 'state.json', 'storage-state.json',
    'storageState.json', 'auth.json', 'cookies.json', '.auth/', 'playwright/.auth/',
    'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', '.ssh/', '.aws/'];
  if (ignoreScreenshots) ignore = [...ignore, '# screenshots are large; keep them out of git', 'screenshots/*', '!screenshots/.gitkeep'];
  const gi = join(directory, '.gitignore');
  if (!exists(gi)) fs.writeFileSync(gi, ignore.join('\n') + '\n');
  return path;
}

/**
 * Make <parent>/.gitignore ignore site/, where the combined site of several reviews is built (.review/site/).
 * Returns true when it created or extended the file.
 */
export function ignoreCombinedSite(parent: string): boolean {
  const gi = join(parent, '.gitignore');
  if (exists(gi)) {
    const text = fs.readFileSync(gi, 'utf-8');
    if (text.split(/\r?\n/).some((l) => ['site', 'site/', '/site', '/site/'].includes(l.trim()))) return false;
    fs.appendFileSync(gi, (text && !text.endsWith('\n') ? '\n' : '') + '# review-kit combined site\n/site/\n');
    return true;
  }
  if (!isdir(parent)) return false;
  fs.writeFileSync(gi, '# review-kit build output: the combined site of the reviews in this folder\n/site/\n');
  return true;
}

// ---------------------------------------------------------------- helpers
export function slug(s: string): string {
  return pySlice(strip(s.toLowerCase().replace(/[^a-z0-9]+/g, '-'), '-'), 0, 40) || 'item';
}

export function unique(base: string, taken: Set<unknown>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** filecmp.cmp(a, b, shallow=False) */
function sameFile(a: string, b: string): boolean {
  const sa = fs.statSync(a);
  const sb = fs.statSync(b);
  if (!sa.isFile() || !sb.isFile()) return false;
  if (sa.size !== sb.size) return false;
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

/** Absolute image paths are copied into <review>/screenshots/<subdir>/ and rewritten as relative. */
export function importImage(img: any, reviewDir: string, subdir: string): any {
  const src = model.imageSrc(img);
  if (!truthy(src) || !isabs(src)) return img;
  if (!isfile(src)) throw new ReviewError(`image not found: ${src}`);
  if (!safety.IMAGE_EXTS.has(splitext(src)[1].toLowerCase())) throw new ReviewError('only raster screenshots may be imported');
  const rd = abspath(reviewDir);
  let rel: string;
  if (abspath(src).startsWith(rd + '/')) rel = relpath(src, rd);
  else {
    const destDir = join(rd, 'screenshots', subdir);
    fs.mkdirSync(destDir, { recursive: true });
    const [stem, ext] = splitext(basename(src));
    let dest = join(destDir, stem + ext);
    let n = 2;
    // Never overwrite a different image that already has this name (before/ and after/ folders often share names).
    while (exists(dest) && !sameFile(src, dest)) {
      dest = join(destDir, `${stem}-${n}${ext}`);
      n++;
    }
    if (!exists(dest)) copy2(src, dest);
    rel = relpath(dest, rd);
  }
  if (typeof img === 'string') return rel;
  const out = copyDict(img);
  out.src = rel;
  return out;
}

function importIssueImages(issue: Record<string, any>, reviewDir: string): void {
  if (truthy(get(issue, 'screenshots'))) issue.screenshots = issue.screenshots.map((x: any) => importImage(x, reviewDir, 'issues'));
}

function importFixImages(fix: Record<string, any>, reviewDir: string): void {
  const sub = S(fix.id);
  const plats = get(fix, 'platforms') || {};
  for (const k of Object.keys(plats)) {
    const p = plats[k];
    for (const pair of get(p, 'pairs') || []) {
      for (const role of ['before', 'after']) {
        if (truthy(get(pair, role))) pair[role] = importImage(pair[role], reviewDir, sub);
      }
    }
    if (truthy(get(p, 'images'))) p.images = p.images.map((x: any) => importImage(x, reviewDir, sub));
  }
}

export function appendNote(old: any, add: any): any {
  if (!truthy(old)) return add;
  if (!truthy(add) || old.includes(add)) return old;
  return rstrip(old) + '\n\n' + add;
}

// ---------------------------------------------------------------- issues
export function upsertIssue(data: Record<string, any>, issue: Record<string, any>, reviewDir: string, update = false): Record<string, any> {
  const issues: any[] = setdefault(data, 'issues', []);
  issue = copyDict(issue);
  const ids = new Set(issues.map((i) => i.id));
  if (!truthy(get(issue, 'id'))) {
    const plat = get(issue, 'platform');
    const prefix = model.platforms(data).length > 1 ? pySlice(truthy(plat) ? plat : 'issue', 0, 1).toLowerCase() : 'issue';
    let n = issues.length + 1;
    while (ids.has(`${prefix}-${n}`)) n++;
    issue.id = `${prefix}-${n}`;
  }
  importIssueImages(issue, reviewDir);
  for (let i = 0; i < issues.length; i++) {
    const old = issues[i];
    if (pyEq(old.id, issue.id)) {
      if (!update) throw new ReviewError(`issue "${S(issue.id)}" already exists (use --update to merge fields)`);
      const merged = copyDict(old);
      for (const k of Object.keys(issue)) setKey(merged, k, issue[k]);
      issues[i] = merged;
      return merged;
    }
  }
  if (!truthy(get(issue, 'title'))) throw new ReviewError('a new issue needs a "title"');
  setdefault(issue, 'status', 'open');
  if (!has(issue, 'severity')) issue.severity = null;
  if (model.platforms(data).length === 1 && !has(issue, 'platform')) issue.platform = model.platforms(data)[0].id;
  issues.push(issue);
  return issue;
}

// ---------------------------------------------------------------- marks
function findPlanItem(data: any, ident: any): any {
  for (const g of get(data, 'plan') || []) {
    for (const it of get(g, 'items') || []) {
      if (pyEq(get(it, 'id') ?? null, ident ?? null)) return it;
    }
  }
  return null;
}

/** mark = {"issue"|"plan"|"id": ..., "status": ..., "note": ...}. Returns a description string. */
export function applyMark(data: any, mark: Record<string, any>, fixId: string | null = null): string {
  const status = get(mark, 'status');
  const note = has(mark, 'note') ? mark.note : '';
  let target: any;
  let kind: string;
  if (has(mark, 'plan')) {
    target = findPlanItem(data, mark.plan);
    kind = 'plan';
  } else {
    const ident = truthy(get(mark, 'issue')) ? mark.issue : get(mark, 'id');
    target = (get(data, 'issues') || []).find((i: any) => pyEq(i.id, ident ?? null)) ?? null;
    kind = 'issue';
    if (target === null && !has(mark, 'issue')) {
      target = findPlanItem(data, ident);
      kind = 'plan';
    }
  }
  const ident = truthy(get(mark, 'plan')) ? mark.plan : truthy(get(mark, 'issue')) ? mark.issue : get(mark, 'id');
  if (target === null) throw new ReviewError(`mark: no issue or plan item with id "${S(ident)}"`);
  const allowed = kind === 'plan' ? model.PLAN_STATUSES : model.ISSUE_STATUSES;
  if (!allowed.includes(status)) throw new ReviewError(`mark ${S(ident)}: status must be one of ${allowed.join(', ')}`);
  target.status = status;
  if (truthy(note)) target.note = appendNote(has(target, 'note') ? target.note : '', note);
  if (fixId) {
    if (kind === 'issue') {
      const fx = (get(data, 'fixes') || []).find((f: any) => f.id === fixId) ?? null;
      if (fx !== null && !(get(fx, 'issues') || []).some((x: any) => pyEq(x, ident))) setdefault(fx, 'issues', []).push(ident);
    } else if (!(get(target, 'fixes') || []).includes(fixId)) setdefault(target, 'fixes', []).push(fixId);
  }
  return `${kind} ${S(ident)} -> ${S(status)}`;
}

// ---------------------------------------------------------------- fixes
export function upsertFix(data: Record<string, any>, fix: Record<string, any>, reviewDir: string, update = false): Record<string, any> {
  const fixes: any[] = setdefault(data, 'fixes', []);
  fix = copyDict(fix);
  if (!has(fix, 'number')) {
    const nums = fixes.map((f) => get(f, 'number')).filter((n) => isInt(n) || typeof n === 'boolean').map(Number);
    fix.number = nums.length ? Math.max(...nums) + 1 : 1;
  } else if (fix.number === null) delete fix.number;
  if (!truthy(get(fix, 'id'))) {
    fix.id = unique(has(fix, 'number') ? `fix-${numStr(fix.number)}` : 'fix-' + slug(has(fix, 'title') ? fix.title : ''),
      new Set(fixes.map((f) => f.id)));
  }
  setdefault(fix, 'date', today());
  if (!truthy(get(fix, 'title'))) throw new ReviewError('a fix needs a "title"');
  importFixImages(fix, reviewDir);
  for (let i = 0; i < fixes.length; i++) {
    if (pyEq(fixes[i].id, fix.id)) {
      if (!update) throw new ReviewError(`fix "${S(fix.id)}" already exists (use --update to replace it)`);
      fixes[i] = fix;
      return fix;
    }
  }
  fixes.push(fix);
  return fix;
}

export function addPlanItem(data: Record<string, any>, group: string, item: Record<string, any>): Record<string, any> {
  const plan: any[] = setdefault(data, 'plan', []);
  let g = plan.find((x) => pyEq(get(x, 'id') ?? null, group) || pyEq(x.title, group));
  if (g === undefined) {
    g = { id: unique(slug(group), new Set(plan.map((x) => get(x, 'id') ?? null))), title: group, items: [] };
    plan.push(g);
  }
  item = copyDict(item);
  if (!truthy(get(item, 'title'))) throw new ReviewError('a plan item needs a "title"');
  const taken = new Set<unknown>();
  for (const x of plan) for (const it of get(x, 'items') || []) taken.add(get(it, 'id') ?? null);
  if (truthy(get(item, 'id')) && taken.has(item.id)) throw new ReviewError(`plan item "${S(item.id)}" already exists`);
  if (!truthy(get(item, 'id'))) item.id = unique(('plan-' + pySlice(slug(item.title.replace(/<[^>]+>/g, '')), 0, 30)), taken);
  setdefault(item, 'status', 'todo');
  setdefault(g, 'items', []).push(item);
  return item;
}

// ---------------------------------------------------------------- envelopes
/** Accept a pending envelope {"fix", "issues", "marks", "plan"} or a bare fix object. */
export function normaliseEnvelope(obj: unknown): Record<string, any> {
  if (!isDict(obj)) throw new ReviewError('expected a JSON object');
  let env: Record<string, any>;
  const keys = Object.keys(obj);
  if (keys.some((k) => PENDING_KEYS.includes(k)) && !has(obj, 'title')) {
    const unknown = keys.filter((k) => !PENDING_KEYS.includes(k));
    if (unknown.length) {
      throw new ReviewError(`unknown hand-off keys: ${[...new Set(unknown)].sort(cmpStr).join(', ')} (allowed: ${[...PENDING_KEYS].sort(cmpStr).join(', ')})`);
    }
    env = obj;
  } else env = { fix: obj };
  const errors = envelopeErrors(env);
  if (errors.length) throw new ReviewError('invalid hand-off:\n  ' + errors.join('\n  '));
  return env;
}

function shapeErrors(value: unknown, ref: string, where: string, ignore: string[] = []): string[] {
  const schema = model.loadSchema();
  const sub = copyDict(schema.$defs[ref]);
  delete sub.required;
  if (isDict(value)) {
    const v: Record<string, any> = {};
    for (const k of Object.keys(value)) if (!ignore.includes(k)) setKey(v, k, value[k]);
    value = v;
  }
  return new validate.SchemaValidator(schema).errors(value, sub, where);
}

function envelopeErrors(env: Record<string, any>): string[] {
  const errors: string[] = [];
  if (get(env, 'fix') !== undefined && env.fix !== null) errors.push(...shapeErrors(env.fix, 'fix', 'fix', ['marks']));
  const marks = pyList(truthy(get(env, 'marks')) ? env.marks : []);
  if (isDict(get(env, 'fix'))) {
    const fm = get(env.fix, 'marks');
    marks.push(...pyList(truthy(fm) ? fm : []));
  }
  for (const [key, ref, ignore] of [['issues', 'issue', []], ['plan', 'planItem', ['group']], ['marks', null, []]] as [string, string | null, string[]][]) {
    const items = key === 'marks' ? marks : get(env, key);
    if (items === undefined || items === null) continue;
    if (!Array.isArray(items)) {
      errors.push(`${key}: expected a list, got ${typeName(items)}`);
      continue;
    }
    items.forEach((it, i) => {
      if (ref) errors.push(...shapeErrors(it, ref, `${key}[${i}]`, ignore));
      else if (!isDict(it) || typeof get(it, 'status') !== 'string') errors.push(`${key}[${i}]: expected {"issue"|"plan": id, "status": ...}`);
    });
  }
  return errors;
}

/** Load review.json for editing, refusing a document whose shape the editing code cannot rely on. */
export function loadChecked(path: string): any {
  const data = model.load(path);
  const errors = new validate.SchemaValidator(model.loadSchema()).errors(data);
  if (errors.length) {
    throw new ReviewError(`${path} is not a valid review (run \`review-kit validate\` for details):\n  ` + errors.slice(0, 5).join('\n  '));
  }
  return data;
}

/** Apply a hand-off envelope to data in place. Returns a list of change descriptions. */
export function merge(data: Record<string, any>, envelope: unknown, reviewDir: string, update = false): string[] {
  const env = normaliseEnvelope(envelope);
  const log: string[] = [];
  for (const issue of truthy(get(env, 'issues')) ? env.issues : []) {
    const found = (get(data, 'issues') || []).some((i: any) => pyEq(i.id, get(issue, 'id') ?? null));
    const it = upsertIssue(data, issue, reviewDir, found || update);
    log.push(`issue ${S(it.id)} ${found ? 'updated' : 'added'}`);
  }
  let fixId: string | null = null;
  const marks = pyList(truthy(get(env, 'marks')) ? env.marks : []);
  if (truthy(get(env, 'fix'))) {
    let fx = copyDict(env.fix);
    const fm = has(fx, 'marks') ? fx.marks : [];
    delete fx.marks;
    for (const m of fm) marks.push(copyDict(m));
    fx = upsertFix(data, fx, reviewDir, update);
    fixId = fx.id;
    log.push(`fix ${S(fixId)} (#${has(fx, 'number') ? S(fx.number) : '-'}) ${update ? 'replaced' : 'added'}`);
  }
  for (let p of truthy(get(env, 'plan')) ? env.plan : []) {
    p = copyDict(p);
    const g = get(p, 'group');
    delete p.group;
    const group = truthy(g) ? g : 'Plan';
    const it = addPlanItem(data, group, p);
    log.push(`plan item ${S(it.id)} added to "${S(group)}"`);
  }
  for (const m of marks) log.push(applyMark(data, m, fixId));
  return log;
}

export function check(data: unknown, reviewDir: string): string[] {
  const [errors, warnings] = validate.validate(data, abspath(reviewDir));
  if (errors.length) throw new ReviewError('the result would not validate; review.json left unchanged:\n  ' + errors.join('\n  '));
  return warnings;
}

type NatKey = (string | bigint)[];

function digitValue(ch: string): number {
  // Unicode decimal digits come in runs of ten starting at zero.
  let cp = ch.codePointAt(0)!;
  let start = cp;
  while (/\p{Nd}/u.test(String.fromCodePoint(start - 1))) start--;
  return (cp - start) % 10;
}

function natural(n: string): NatKey {
  return n.split(/(\p{Nd}+)/u).map((t, i) => (i % 2 ? BigInt(Array.from(t).map(digitValue).join('')) : t));
}

function cmpNat(a: NatKey, b: NatKey): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (typeof x === 'bigint' && typeof y === 'bigint') {
      if (x !== y) return x < y ? -1 : 1;
    } else {
      const c = cmpStr(x as string, y as string);
      if (c) return c;
    }
  }
  return a.length - b.length;
}

/** Merge every <pending>/*.json (not *.applied.json) in natural order, renaming each to .applied.json. */
export function applyPending(reviewPath: string, pendingDir: string | null = null): [string, string[], string[]][] {
  const reviewDir = model.baseDir(reviewPath);
  pendingDir = pendingDir || join(reviewDir, 'pending');
  if (!isdir(pendingDir)) throw new ReviewError(`${pendingDir}: no such directory`);
  const names = listdir(pendingDir).filter((n) => n.endsWith('.json') && !n.endsWith('.applied.json'))
    .map((n) => [n, natural(n)] as [string, NatKey]).sort((a, b) => cmpNat(a[1], b[1])).map((x) => x[0]);
  const results: [string, string[], string[]][] = [];
  for (const n of names) {
    const data = loadChecked(reviewPath);
    const p = join(pendingDir, n);
    const env = model.load(p);
    const log = merge(data, env, reviewDir);
    const warnings = check(data, reviewDir);
    model.save(reviewPath, data);
    fs.renameSync(p, p.slice(0, -5) + '.applied.json');
    results.push([n, log, warnings]);
  }
  return results;
}
