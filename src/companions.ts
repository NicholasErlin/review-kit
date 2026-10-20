/**
 * Companion skills: the third-party agent skills each review kind leans on.
 *
 * A UI/UX review uses ui-ux-pro-max for its UX rules; a backend review uses a few of the backend skills from
 * wshobson/agents; a design review uses both sets and an ideas review none. They are MIT licensed and bundled in
 * skill/companions/ (each folder keeps its upstream LICENSE and a SOURCE file with the commit it came from).
 * `review-kit companions` reports where they are installed,
 * `review-kit companions install` links the bundled copies into skills folders, and `review-kit companions update`
 * (for maintainers) refreshes the bundle from the pinned commits.
 */
import fs from 'node:fs';
import https from 'node:https';
import zlib from 'node:zlib';
import { ReviewError } from './errors.js';
import * as model from './model.js';
import {
  abspath, basename, dirname, exists, expanduser, isabs, isdir, isfile, islink, join, realpath, reprStr,
  sorted, strip,
} from './py.js';

export const KINDS = ['ui', 'backend', 'ideas', 'design', 'prs'];

// The commits the bundle was taken from. Bump deliberately, then run `review-kit companions update`.
export const SOURCES: Record<string, string> = {
  'nextlevelbuilder/ui-ux-pro-max-skill': '56ea9cf174ed86786187daa9de0e6247cb0747e4',
  'wshobson/agents': '0874a27b17a22e2b7c2e2bcd725768e0803cad06',
};

export interface Companion {
  name: string;
  repo: string;
  path: string;
  use: string;
}

export const COMPANIONS: Record<string, Companion[]> = {
  ui: [
    {
      name: 'ui-ux-pro-max', repo: 'nextlevelbuilder/ui-ux-pro-max-skill',
      path: '.claude/skills/ui-ux-pro-max',
      use: 'UX rules (accessibility, touch, layout, type, forms, navigation) to ground and rank UI issues',
    },
  ],
  backend: [
    {
      name: 'api-design-principles', repo: 'wshobson/agents',
      path: 'plugins/backend-development/skills/api-design-principles',
      use: 'HTTP/CLI interface design: resources, status codes, errors, versioning, pagination',
    },
    {
      name: 'architecture-patterns', repo: 'wshobson/agents',
      path: 'plugins/backend-development/skills/architecture-patterns',
      use: 'layering, dependency direction, module boundaries',
    },
    {
      name: 'error-handling-patterns', repo: 'wshobson/agents',
      path: 'plugins/developer-essentials/skills/error-handling-patterns',
      use: 'error propagation, failure modes, retries, graceful degradation',
    },
  ],
  ideas: [],
  prs: [],
  design: [], // filled below: the UI companion for UI options, the backend ones for API/architecture options
};
COMPANIONS.design = [...COMPANIONS.ui, ...COMPANIONS.backend];

export const BUNDLE = join(model.ROOT, 'skill', 'companions');
export const SKIP = ['scripts/tests/']; // upstream test suites aren't needed to use the skill
export const MAX_DOWNLOAD = 200 * 1024 * 1024;
/** Cap on the unpacked archive, so a hostile download cannot exhaust memory. */
export const MAX_UNPACKED = 1024 * 1024 * 1024;

/** Folders where agents commonly keep skills, user-wide and per repo. */
export function skillDirs(repo = '.'): string[] {
  const home = expanduser('~');
  return [
    ...['.claude/skills', '.agents/skills', '.codex/skills', '.cursor/skills'].map((d) => join(home, d)),
    ...['.claude/skills', '.agents/skills'].map((d) => join(abspath(repo), d)),
  ];
}

// ---------------------------------------------------------------- glob.glob (the subset find() needs)
function fnmatchRe(pat: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pat.length) {
    const c = pat[i++];
    if (c === '*') re += '[\\s\\S]*';
    else if (c === '?') re += '[\\s\\S]';
    else if (c === '[') {
      let j = i;
      if (j < pat.length && pat[j] === '!') j++;
      if (j < pat.length && pat[j] === ']') j++;
      while (j < pat.length && pat[j] !== ']') j++;
      if (j >= pat.length) re += '\\[';
      else {
        let stuff = pat.slice(i, j).replace(/\\/g, '\\\\');
        i = j + 1;
        if (stuff[0] === '!') stuff = '^' + stuff.slice(1);
        else if (stuff[0] === '^') stuff = '\\' + stuff;
        re += `[${stuff.replace(/]/g, '\\]')}]`;
      }
    } else re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(`^(?:${re})$`, 'u');
}

const MAGIC = /[*?[]/;

export function glob(pattern: string): string[] {
  const parts = pattern.split('/');
  let paths = [parts[0] === '' ? '/' : parts[0]];
  const rest = parts[0] === '' ? parts.slice(1) : parts.slice(1);
  rest.forEach((seg, idx) => {
    const last = idx === rest.length - 1;
    const next: string[] = [];
    for (const dir of paths) {
      if (!MAGIC.test(seg)) {
        const p = join(dir, seg);
        if (seg === '' ? isdir(dir) : fs.existsSync(p) || islink(p)) next.push(p);
        continue;
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      const re = fnmatchRe(seg);
      for (const e of entries) {
        if (e.name.startsWith('.') && !seg.startsWith('.')) continue;
        if (!re.test(e.name)) continue;
        const p = join(dir, e.name);
        if (!last && !(e.isDirectory() || (e.isSymbolicLink() && isdir(p)))) continue;
        next.push(p);
      }
    }
    paths = next;
  });
  return paths;
}

/** Path to the companion's SKILL.md: an installed copy if there is one, else the bundled copy. */
export function find(name: string, repo = '.', bundle: string | null = null): string | null {
  for (const d of skillDirs(repo)) {
    const p = join(d, name, 'SKILL.md');
    if (isfile(p)) return p;
  }
  const plugins = expanduser('~/.claude/plugins');
  for (const pattern of ['*/*/plugins/*/skills/%s/SKILL.md', '*/*/*/skills/%s/SKILL.md', '*/*/skills/%s/SKILL.md']) {
    const hits = sorted(glob(join(plugins, pattern.replace('%s', name))));
    if (hits.length) return hits[0];
  }
  const p = join(bundle || BUNDLE, name, 'SKILL.md');
  return isfile(p) ? p : null;
}

/** [kind, companion, path or null][] */
export function status(kinds: string[] = KINDS, repo = '.'): [string, Companion, string | null][] {
  const out: [string, Companion, string | null][] = [];
  for (const k of kinds) for (const c of COMPANIONS[k]) out.push([k, c, find(c.name, repo)]);
  return out;
}

function wanted(kinds: string[]): Map<string, Companion[]> {
  const out = new Map<string, Companion[]>();
  for (const k of kinds) {
    if (!Object.prototype.hasOwnProperty.call(COMPANIONS, k)) {
      throw new ReviewError(`unknown review kind ${reprStr(k)}; expected one of ${KINDS.join(', ')}`);
    }
    for (const c of COMPANIONS[k]) {
      if (!out.has(c.repo)) out.set(c.repo, []);
      if (!out.get(c.repo)!.some((x) => x.name === c.name)) out.get(c.repo)!.push(c); // design shares ui/backend's
    }
  }
  return out;
}

/** Link a bundled skill into skillsDir. Never replaces a skill the user installed some other way. */
function link(src: string, skillsDir: string): string {
  const target = join(skillsDir, basename(src));
  if (islink(target)) {
    const real = realpath(target);
    if (real === realpath(src)) return 'already linked';
    if (!real.startsWith(realpath(model.ROOT) + '/') && exists(target)) return 'left alone (links elsewhere)';
    fs.unlinkSync(target); // an older review-kit link, or a dangling one
  } else if (exists(target)) return 'left alone (already installed)';
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.symlinkSync(src, target);
  return 'linked';
}

/** Link the bundled companions for `kinds` into skills folders. Returns log lines. */
export function install(kinds: string[] = KINDS, skillsDirs: string[] | null = null, bundle: string | null = null): string[] {
  const b = bundle || BUNDLE;
  if (skillsDirs === null) {
    const claude = expanduser('~/.claude');
    skillsDirs = isdir(claude) ? [join(claude, 'skills')] : [];
  }
  const log: string[] = [];
  for (const comps of wanted(kinds).values()) {
    for (const c of comps) {
      const src = join(b, c.name);
      if (!isfile(join(src, 'SKILL.md'))) throw new ReviewError(`${src}: bundled skill missing; run \`review-kit companions update\``);
      log.push(`${c.name}:`);
      for (const d of skillsDirs) log.push(`  ${d}: ${link(src, d)}`);
    }
  }
  if (!skillsDirs.length) log.push(`no skills folder given; agents can read the skills in ${b} (\`review-kit companions\` shows the paths)`);
  return log;
}

// ---------------------------------------------------------------- maintainers: refresh the bundle
/** Fetches a URL; resolves with at most `limit` bytes of the body. */
export type Opener = (url: string, limit: number) => Promise<Buffer>;

/** urllib.request.urlopen(url, timeout=60).read(limit) over HTTPS, following redirects. */
export const httpsOpener: Opener = (url, limit) => new Promise((resolve, reject) => {
  const get = (u: string, hops: number) => {
    const req = https.get(u, { timeout: 60_000, headers: { 'User-Agent': 'review-kit' } }, (res) => {
      const code = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location && hops < 5) {
        res.resume();
        const next = new URL(res.headers.location, u);
        if (next.protocol !== 'https:') {
          reject(new Error(`HTTP Error ${code}: redirect to a non-HTTPS URL`));
          return;
        }
        get(next.href, hops + 1);
        return;
      }
      if (code < 200 || code >= 300) {
        res.resume();
        reject(new Error(`HTTP Error ${code}: ${res.statusMessage || ''}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        chunks.push(c);
        size += c.length;
        if (size >= limit) {
          res.destroy();
          resolve(Buffer.concat(chunks).subarray(0, limit));
        }
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', (e) => reject(new Error(`<urlopen error ${e.message}>`)));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (e) => reject(new Error(`<urlopen error ${e.message}>`)));
  };
  get(url, 0);
});

export async function download(repo: string, sha: string, opener: Opener = httpsOpener, limit = MAX_DOWNLOAD): Promise<Buffer> {
  const url = `https://codeload.github.com/${repo}/tar.gz/${sha}`;
  let blob: Buffer;
  try {
    blob = (await opener(url, limit + 1)).subarray(0, limit + 1);
  } catch (e) {
    throw new ReviewError(`could not download ${url}: ${(e as Error).message}`);
  }
  if (blob.length > limit) throw new ReviewError(`${url}: larger than ${Math.floor(limit / (1024 * 1024))} MB; refusing`);
  return blob;
}

// ---------------------------------------------------------------- a minimal, read-only tar reader (tarfile subset)
class TarError extends Error {}
class EOFError extends Error {}

export interface TarMember {
  name: string;
  type: string;
  linkname: string;
  size: number;
  data: Buffer;
}

const REGULAR = new Set(['0', '\0', '7', 'S']);
const GNU_TYPES = new Set(['L', 'K', 'S']);
const SUPPORTED = new Set(['0', '\0', '1', '2', '3', '4', '5', '6', '7', 'L', 'K', 'S', 'x', 'g', 'X']);

const isFile = (m: TarMember) => REGULAR.has(m.type);
const isDir = (m: TarMember) => m.type === '5';

function nts(b: Buffer): string {
  const i = b.indexOf(0);
  return (i < 0 ? b : b.subarray(0, i)).toString('utf8');
}

function nti(b: Buffer): number {
  if (b[0] === 0o200 || b[0] === 0o377) {
    let n = 0n;
    for (let i = 1; i < b.length; i++) n = (n << 8n) + BigInt(b[i]);
    if (b[0] === 0o377) n = -(256n ** BigInt(b.length - 1) - n);
    return Number(n);
  }
  const i = b.indexOf(0);
  const s = strip((i < 0 ? b : b.subarray(0, i)).toString('latin1'));
  if (!s) return 0;
  if (!/^[+-]?[0-7](_?[0-7])*$/.test(s)) throw new TarError('invalid header');
  return parseInt(s.replace(/_/g, ''), 8);
}

function parseHeader(buf: Buffer): Omit<TarMember, 'data'> {
  if (buf.length === 0) throw new TarError('empty header');
  if (buf.length !== 512) throw new TarError('truncated header');
  if (buf.every((x) => x === 0)) throw Object.assign(new TarError('end of file header'), { eof: true });
  const chk = nti(buf.subarray(148, 156));
  let unsigned = 256;
  let signed = 256;
  for (let i = 0; i < 512; i++) {
    if (i >= 148 && i < 156) continue;
    unsigned += buf[i];
    signed += buf[i] > 127 ? buf[i] - 256 : buf[i];
  }
  if (chk !== unsigned && chk !== signed) throw new TarError('bad checksum');
  let name = nts(buf.subarray(0, 100));
  const size = nti(buf.subarray(124, 136));
  let type = String.fromCharCode(buf[156]);
  const linkname = nts(buf.subarray(157, 257));
  const prefix = nts(buf.subarray(345, 500));
  if (type === '\0' && name.endsWith('/')) type = '5';
  if (type === '5') name = name.replace(/\/+$/, '');
  if (prefix && !GNU_TYPES.has(type)) name = prefix + '/' + name;
  return { name, type, linkname, size };
}

const block = (n: number) => Math.ceil(n / 512) * 512;

function parsePax(data: Buffer, into: Map<string, string>): void {
  let pos = 0;
  while (pos < data.length) {
    const m = /^(\d+) ([^=]+)=/.exec(data.subarray(pos, pos + 1024).toString('latin1'));
    if (!m) break;
    const len = parseInt(m[1], 10);
    if (len < 1) break;
    const keyStart = pos + m[1].length + 1;
    const eq = data.indexOf(0x3d, keyStart);
    const key = data.subarray(keyStart, eq).toString('utf8');
    const value = data.subarray(eq + 1, pos + len - 1).toString('utf8');
    into.set(key, value);
    pos += len;
  }
}

/** Read every member of an uncompressed tar archive (regular data, directories, links; pax and GNU long names). */
export function readTar(tar: Buffer): TarMember[] {
  const members: TarMember[] = [];
  const globalPax = new Map<string, string>();
  let offset = 0;
  for (;;) {
    const start = offset;
    let hdr: Omit<TarMember, 'data'>;
    let dataStart: number;
    try {
      const read = (at: number) => {
        const h = parseHeader(tar.subarray(at, at + 512));
        return h;
      };
      hdr = read(offset);
      offset += 512;
      let longName: string | null = null;
      let longLink: string | null = null;
      let pax: Map<string, string> | null = null;
      // special headers apply to the next one
      for (;;) {
        if (hdr.type === 'L' || hdr.type === 'K') {
          const v = nts(tar.subarray(offset, offset + hdr.size));
          if (hdr.type === 'L') longName = v;
          else longLink = v;
        } else if (hdr.type === 'x' || hdr.type === 'X' || hdr.type === 'g') {
          const into = hdr.type === 'g' ? globalPax : (pax = pax || new Map(globalPax));
          parsePax(tar.subarray(offset, offset + hdr.size), into);
        } else break;
        offset += block(hdr.size);
        try {
          hdr = read(offset);
        } catch (e) {
          throw Object.assign(new TarError((e as Error).message), { subsequent: true });
        }
        offset += 512;
      }
      const info = { ...hdr };
      if (longName !== null) info.name = longName;
      if (longLink !== null) info.linkname = longLink;
      const fields = pax || globalPax;
      for (const [k, v] of fields) {
        if (k === 'path') info.name = v.replace(/\/+$/, '');
        else if (k === 'linkpath') info.linkname = v;
        else if (k === 'size') info.size = /^\d+$/.test(v) ? parseInt(v, 10) : 0;
      }
      if (isDir(info as TarMember)) info.name = info.name.replace(/\/+$/, '');
      dataStart = offset;
      if (REGULAR.has(info.type) || !SUPPORTED.has(info.type)) offset += block(info.size);
      if (dataStart + info.size > tar.length && REGULAR.has(info.type)) throw new EOFError('unexpected end of data');
      members.push({ ...info, data: tar.subarray(dataStart, dataStart + info.size) });
    } catch (e) {
      if (e instanceof EOFError) throw e;
      if (!(e instanceof TarError)) throw e;
      const err = e as TarError & { eof?: boolean; subsequent?: boolean };
      if (err.subsequent) throw e;
      if (err.eof) break;
      if (start === 0) throw new TarError(err.message === 'empty header' ? 'empty file' : err.message);
      break;
    }
  }
  return members;
}


function gunzip(blob: Buffer): Buffer {
  if (blob.length < 2 || blob[0] !== 0x1f || blob[1] !== 0x8b) {
    if (!blob.length) return Buffer.alloc(0);
    throw new TarError('not a gzip file');
  }
  try {
    return zlib.gunzipSync(blob, { maxOutputLength: MAX_UNPACKED });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'Z_BUF_ERROR') throw new EOFError('Compressed file ended before the end-of-stream marker was reached');
    if (code === 'ERR_BUFFER_TOO_LARGE') throw new TarError(`unpacked archive larger than ${MAX_UNPACKED / (1024 * 1024)} MB; refusing`);
    throw new TarError('not a gzip file');
  }
}

/** Extract only the companion folders, refusing anything that could land outside them. */
export function extract(blob: Buffer, comps: Companion[], dest: string, repo: string, sha: string, licenseText: Buffer | null = null): void {
  let members: TarMember[];
  try {
    members = readTar(gunzip(blob));
  } catch (e) {
    if (e instanceof TarError || e instanceof EOFError) throw new ReviewError(`${repo}: download is not a valid archive: ${e.message}`);
    throw e;
  }
  const top = members.length ? members[0].name.split('/')[0] : '';
  const lic = members.find((m) => m.name === `${top}/LICENSE` && isFile(m));
  if (lic) licenseText = lic.data;
  for (const c of comps) {
    const prefix = `${top}/${strip(c.path, '/')}/`;
    const out = join(dest, c.name);
    const tmp = out + '.partial';
    fs.rmSync(tmp, { recursive: true, force: true });
    let found = false;
    for (const m of members) {
      if (!m.name.startsWith(prefix)) continue;
      const rel = m.name.slice(prefix.length);
      const parts = rel.split('/');
      if (!rel || isabs(rel) || parts.includes('..') || SKIP.some((s) => rel.startsWith(s))) continue;
      const target = join(tmp, ...parts);
      if (isDir(m)) fs.mkdirSync(target, { recursive: true });
      else if (isFile(m)) {
        fs.mkdirSync(dirname(target), { recursive: true });
        fs.writeFileSync(target, m.data);
        found = found || rel === 'SKILL.md';
      }
      // links, devices and fifos are skipped
    }
    if (!found) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw new ReviewError(`${repo}: ${c.path}/SKILL.md not found in the download`);
    }
    if (licenseText && licenseText.length && !exists(join(tmp, 'LICENSE'))) fs.writeFileSync(join(tmp, 'LICENSE'), licenseText);
    fs.writeFileSync(join(tmp, 'SOURCE'), `https://github.com/${repo}/tree/${sha}/${c.path}\n`
      + 'Bundled by review-kit; refresh with `review-kit companions update`.\n');
    fs.rmSync(out, { recursive: true, force: true });
    fs.renameSync(tmp, out);
  }
}

/** Re-download the pinned commits into the bundle. Returns log lines. */
export async function update(kinds: string[] = KINDS, bundle: string | null = null, opener: Opener = httpsOpener): Promise<string[]> {
  const b = bundle || BUNDLE;
  fs.mkdirSync(b, { recursive: true });
  const log: string[] = [];
  for (const [repo, comps] of wanted(kinds)) {
    const sha = SOURCES[repo];
    extract(await download(repo, sha, opener), comps, b, repo, sha);
    for (const c of comps) log.push(`${c.name}: refreshed from ${repo}@${sha.slice(0, 7)}`);
  }
  return log;
}

