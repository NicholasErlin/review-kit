/** Loading, saving and defaults for review.json. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ReviewError } from './errors.js';
import { dumps as jsonDumps, JSONDecodeError, loads } from './pyjson.js';
import { UnicodeDecodeError, abspath, decodeUtf8, dirname, exists, get, join, truthy } from './py.js';

export { ReviewError };

/** The package root: the folder holding dist/, site/, schema/, skill/ and docs/. */
export const ROOT = dirname(dirname(abspath(fileURLToPath(import.meta.url))));
export const SCHEMA_PATH = join(ROOT, 'schema', 'review.schema.json');
export const SCHEMA_URL = 'https://raw.githubusercontent.com/NicholasErlin/review-kit/main/schema/review.schema.json';
export const SITE_SRC = join(ROOT, 'site');

export const DEFAULT_SEVERITIES = [
  { id: 'P0', label: 'P0', color: '#c62828', description: 'Critical: broken flow, data loss or blocker' },
  { id: 'P1', label: 'P1', color: '#b45f00', description: 'Major: clearly wrong or painful, has a workaround' },
  { id: 'P2', label: 'P2', color: '#2f7d5b', description: 'Minor: polish and consistency' },
];
export const DEFAULT_PLATFORM = { id: 'default', label: 'All', shape: 'auto' };
export const ISSUE_STATUSES = ['open', 'partial', 'fixed', 'notabug', 'wontfix'];
export const PLAN_STATUSES = ['todo', 'doing', 'partial', 'done', 'dropped'];
export const IDEA_STATUSES = ['proposed', 'go', 'maybe', 'no', 'done'];
export const PROPOSAL_STATUSES = ['open', 'adopted', 'closed'];
export const OPTION_STATUSES = ['proposed', 'adopted', 'rejected'];
export const LEVELS = ['low', 'medium', 'high'];
export const SIZES = ['S', 'M', 'L'];
/** Proposal and option ids become branch names (design/<proposal>/<option>), so they are kept to a safe subset. */
export const REF_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const DEFAULT_ACCENT = '#12454f';
/** Largest diff snapshot kept for a design option (bytes); longer diffs are cut at a line break and flagged. */
export const DIFF_CAP = 400 * 1024;
const UMASK = process.umask();

/** Parse JSON text read from a file, reporting errors the way review-kit's Python version did. */
export function parseJsonText(path: string, buf: Buffer): any {
  try {
    let text = decodeUtf8(buf);
    if (text.includes('\r')) text = text.replace(/\r\n?/g, '\n');
    return loads(text);
  } catch (e) {
    if (e instanceof JSONDecodeError || e instanceof UnicodeDecodeError) {
      throw new ReviewError(`${path}: invalid JSON: ${e.message}`);
    }
    throw e;
  }
}

export function load(path: string): any {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ReviewError(`${path}: not found (create one with \`review-kit init\`)`);
    }
    throw e;
  }
  return parseJsonText(path, buf);
}

export function dumps(data: unknown): string {
  return jsonDumps(data, 2) + '\n';
}

const NAME_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789_';

function tempName(): string {
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (const b of bytes) s += NAME_CHARS[b % NAME_CHARS.length];
  return s;
}

/**
 * Atomic write (temp file + rename) so a crash never leaves a half-written file.
 * Keeps the mode of an existing file; new files get the usual umask-based mode, not mkstemp's 0600.
 */
export function writeText(path: string, text: string | Uint8Array): void {
  const d = dirname(abspath(path));
  let mode: number;
  try {
    mode = fs.statSync(path).mode & 0o7777;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    mode = 0o666 & ~UMASK;
  }
  let fd = -1;
  let tmp = '';
  for (let attempt = 0; ; attempt++) {
    tmp = join(d, '.review-' + tempName() + '.tmp');
    try {
      fd = fs.openSync(tmp, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST' && attempt < 10000) continue;
      throw e;
    }
  }
  try {
    try {
      fs.writeFileSync(fd, text); // writes all of it (writeSync may write part of a large buffer)
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, path);
  } catch (e) {
    if (exists(tmp)) fs.unlinkSync(tmp);
    throw e;
  }
}

/** Atomic write so a crash never leaves a half-written review.json. */
export function save(path: string, data: unknown): void {
  writeText(path, dumps(data));
}

let schemaCache: any;

export function loadSchema(): any {
  if (schemaCache === undefined) schemaCache = loads(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
  return schemaCache;
}

export function platforms(data: any): any[] {
  const p = get(data, 'platforms');
  return truthy(p) ? p : [DEFAULT_PLATFORM];
}

export function severities(data: any): any[] {
  const s = get(data, 'severities');
  return truthy(s) ? s : DEFAULT_SEVERITIES;
}

export function baseDir(reviewPath: string): string {
  return dirname(abspath(reviewPath));
}

export function imageSrc(img: any): any {
  return typeof img === 'string' ? img : get(img, 'src');
}

/** str() of a value inside an f-string: None for missing. */
export function s(v: unknown): string {
  if (v === undefined || v === null) return 'None';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  return String(v);
}

/** [where, image] for every screenshot reference in the document. */
export function* iterImages(data: any): Generator<[string, any]> {
  for (const a of get(data, 'areas') || []) {
    const shots = get(a, 'screenshots') || [];
    for (let i = 0; i < shots.length; i++) yield [`areas[${s(get(a, 'id'))}].screenshots[${i}]`, shots[i]];
  }
  for (const it of get(data, 'issues') || []) {
    const shots = get(it, 'screenshots') || [];
    for (let i = 0; i < shots.length; i++) yield [`issues[${s(get(it, 'id'))}].screenshots[${i}]`, shots[i]];
  }
  for (const fx of get(data, 'fixes') || []) {
    const plats = get(fx, 'platforms') || {};
    for (const pid of Object.keys(plats)) {
      const p = plats[pid];
      const pairs = get(p, 'pairs') || [];
      for (let i = 0; i < pairs.length; i++) {
        for (const role of ['before', 'after']) {
          if (truthy(get(pairs[i], role))) yield [`fixes[${s(get(fx, 'id'))}].platforms.${pid}.pairs[${i}].${role}`, pairs[i][role]];
        }
      }
      const imgs = get(p, 'images') || [];
      for (let i = 0; i < imgs.length; i++) yield [`fixes[${s(get(fx, 'id'))}].platforms.${pid}.images[${i}]`, imgs[i]];
    }
  }
  for (const pr of get(data, 'proposals') || []) {
    for (const o of get(pr, 'options') || []) {
      const plats = get(o, 'platforms') || {};
      for (const pid of Object.keys(plats)) {
        const imgs = get(plats[pid], 'images') || [];
        for (let i = 0; i < imgs.length; i++) {
          yield [`proposals[${s(get(pr, 'id'))}].options[${s(get(o, 'id'))}].platforms.${pid}.images[${i}]`, imgs[i]];
        }
      }
    }
  }
}
