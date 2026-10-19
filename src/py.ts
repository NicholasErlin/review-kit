/**
 * Small helpers that reproduce the Python standard library behaviour review-kit relies on (posixpath, str methods,
 * repr(), os.walk, OSError messages), so the TypeScript port prints and writes exactly what the Python version did.
 */
import fs from 'node:fs';
import os from 'node:os';

// ---------------------------------------------------------------- character classes (Python `re`, str methods)
/** Characters for which Python's str.isspace() is true, for use inside a RegExp character class. */
export const WS = '\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
/** Python's \s, \S, \w and \d for str patterns (use with the `u` flag). */
export const RE_S = `[${WS}]`;
export const RE_NS = `[^${WS}]`;
export const RE_W = '[\\p{L}\\p{N}_]';
export const RE_D = '\\p{Nd}';

const WS_SET = new Set<string>([
  '\t', '\n', '\x0b', '\x0c', '\r', '\x1c', '\x1d', '\x1e', '\x1f', ' ', '\x85', '\xa0', ' ',
  ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ',
  ' ', ' ', ' ', ' ', '　',
]);

export function isSpace(ch: string): boolean {
  return WS_SET.has(ch);
}

/** str.strip() / lstrip() / rstrip(), with Python's whitespace set or an explicit set of characters. */
export function strip(s: string, chars?: string): string {
  return rstrip(lstrip(s, chars), chars);
}

export function lstrip(s: string, chars?: string): string {
  const test = chars === undefined ? isSpace : (c: string) => chars.includes(c);
  let i = 0;
  while (i < s.length && test(s[i])) i++;
  return s.slice(i);
}

export function rstrip(s: string, chars?: string): string {
  const test = chars === undefined ? isSpace : (c: string) => chars.includes(c);
  let i = s.length;
  while (i > 0 && test(s[i - 1])) i--;
  return s.slice(0, i);
}

/** len() of a str: code points, not UTF-16 units. */
export function pyLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** s[start:end] on code points (non-negative indices only). */
export function pySlice(s: string, start: number, end?: number): string {
  if (!/[\ud800-\udfff]/.test(s)) return s.slice(start, end);
  return Array.from(s).slice(start, end).join('');
}

export function isLower(s: string): boolean {
  return s !== s.toUpperCase() && s === s.toLowerCase();
}

export function capitalize(s: string): string {
  const cps = Array.from(s);
  if (!cps.length) return s;
  return cps[0].toUpperCase() + cps.slice(1).join('').toLowerCase();
}

/** Compare two strings by code point, as Python does. */
export function cmpStr(a: string, b: string): number {
  if (!/[\ud800-\udfff]/.test(a) && !/[\ud800-\udfff]/.test(b)) return a < b ? -1 : a > b ? 1 : 0;
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d) return d < 0 ? -1 : 1;
  }
  return x.length - y.length < 0 ? -1 : x.length > y.length ? 1 : 0;
}

/** sorted(list_of_str) */
export function sorted(items: Iterable<string>): string[] {
  return Array.from(items).sort(cmpStr);
}

// ---------------------------------------------------------------- repr() and type names
const NONPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

function hex(n: number, width: number): string {
  return n.toString(16).padStart(width, '0');
}

export function reprStr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === quote || ch === '\\') out += '\\' + ch;
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (cp < 0x20 || cp === 0x7f) out += '\\x' + hex(cp, 2);
    else if (cp < 0x7f) out += ch;
    else if (ch !== ' ' && NONPRINTABLE.test(ch)) {
      out += cp <= 0xff ? '\\x' + hex(cp, 2) : cp <= 0xffff ? '\\u' + hex(cp, 4) : '\\U' + hex(cp, 8);
    } else out += ch;
  }
  return out + quote;
}

/** repr() of a float, Python style (shortest round-trip digits, exponent outside 1e-4 .. 1e16). */
export function floatRepr(x: number): string {
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const sign = x < 0 ? '-' : '';
  const [mant, expStr] = Math.abs(x).toExponential().split('e');
  const digits = mant.replace('.', '');
  const exp = parseInt(expStr, 10);
  const decpt = exp + 1;
  if (decpt > -4 && decpt <= 16) {
    if (decpt <= 0) return sign + '0.' + '0'.repeat(-decpt) + digits;
    if (decpt >= digits.length) return sign + digits + '0'.repeat(decpt - digits.length) + '.0';
    return sign + digits.slice(0, decpt) + '.' + digits.slice(decpt);
  }
  const m = digits.length > 1 ? digits[0] + '.' + digits.slice(1) : digits;
  const e = Math.abs(exp);
  return sign + m + 'e' + (exp < 0 ? '-' : '+') + (e < 10 ? '0' + e : String(e));
}

/** str() of a JSON number: integers print as ints, everything else as a Python float. */
export function numStr(x: number): string {
  if (Number.isInteger(x) && Math.abs(x) <= Number.MAX_SAFE_INTEGER) return String(x);
  return floatRepr(x);
}

export function repr(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return numStr(v);
  if (typeof v === 'string') return reprStr(v);
  if (Array.isArray(v)) return '[' + v.map(repr).join(', ') + ']';
  if (typeof v === 'object') {
    return '{' + Object.entries(v as Record<string, unknown>).map(([k, x]) => reprStr(k) + ': ' + repr(x)).join(', ') + '}';
  }
  return String(v);
}

/** str() of a JSON value. */
export function str(v: unknown): string {
  return typeof v === 'string' ? v : repr(v);
}

/** Whether a JSON number is a Python int (integral and within 2**53; see pyjson.dumps). */
export function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER;
}

/** type(v).__name__ for a JSON value. */
export function typeName(v: unknown): string {
  if (v === null || v === undefined) return 'NoneType';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return isInt(v) ? 'int' : 'float';
  if (typeof v === 'string') return 'str';
  if (Array.isArray(v)) return 'list';
  return 'dict';
}

/** Python equality for JSON values (1 == 1.0, True == 1, lists and dicts compared deeply). */
export function pyEq(a: unknown, b: unknown): boolean {
  const num = (x: unknown) => (typeof x === 'boolean' ? Number(x) : x);
  a = num(a);
  b = num(b);
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => pyEq(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k)
      && pyEq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/** Python truthiness for JSON values. */
export function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
}

export function isDict(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A shallow copy that, unlike Object.assign, keeps a "__proto__" key as plain data. */
export function copyDict<T extends Record<string, any>>(d: T): T {
  const out = {} as T;
  for (const k of Object.keys(d)) setKey(out, k, d[k]);
  return out;
}

/** d[k] = v that is safe for any key, including "__proto__". */
export function setKey(d: Record<string, any>, k: string, v: unknown): void {
  if (k === '__proto__') Object.defineProperty(d, k, { value: v, enumerable: true, writable: true, configurable: true });
  else d[k] = v;
}

/** dict.get(k): own properties only. */
export function get(d: Record<string, any> | null | undefined, k: string): any {
  return d && Object.prototype.hasOwnProperty.call(d, k) ? d[k] : undefined;
}

export function has(d: Record<string, any> | null | undefined, k: string): boolean {
  return !!d && Object.prototype.hasOwnProperty.call(d, k);
}

// ---------------------------------------------------------------- posixpath
export function isabs(p: string): boolean {
  return p.startsWith('/');
}

export function join(a: string, ...rest: string[]): string {
  let path = a;
  for (const b of rest) {
    if (b.startsWith('/')) path = b;
    else if (!path || path.endsWith('/')) path += b;
    else path += '/' + b;
  }
  return path;
}

export function split(p: string): [string, string] {
  const i = p.lastIndexOf('/') + 1;
  let head = p.slice(0, i);
  const tail = p.slice(i);
  if (head && head !== '/'.repeat(head.length)) head = rstrip(head, '/');
  return [head, tail];
}

export function dirname(p: string): string {
  return split(p)[0];
}

export function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

export function splitext(p: string): [string, string] {
  const sepIndex = p.lastIndexOf('/');
  const dotIndex = p.lastIndexOf('.');
  if (dotIndex > sepIndex) {
    let i = sepIndex + 1;
    while (i < dotIndex) {
      if (p[i] !== '.') return [p.slice(0, dotIndex), p.slice(dotIndex)];
      i++;
    }
  }
  return [p, ''];
}

export function normpath(path: string): string {
  if (!path) return '.';
  let initial = path.startsWith('/') ? 1 : 0;
  if (initial && path.startsWith('//') && !path.startsWith('///')) initial = 2;
  const out: string[] = [];
  for (const comp of path.split('/')) {
    if (comp === '' || comp === '.') continue;
    if (comp !== '..' || (!initial && !out.length) || (out.length && out[out.length - 1] === '..')) out.push(comp);
    else if (out.length) out.pop();
  }
  const res = '/'.repeat(initial) + out.join('/');
  return res || '.';
}

export function abspath(p: string): string {
  return normpath(isabs(p) ? p : join(process.cwd(), p));
}

export function relpath(path: string, start = '.'): string {
  if (!path) throw new Error('no path specified');
  const s = abspath(start).split('/').filter(Boolean);
  const p = abspath(path).split('/').filter(Boolean);
  let i = 0;
  while (i < s.length && i < p.length && s[i] === p[i]) i++;
  const rel = [...Array(s.length - i).fill('..'), ...p.slice(i)];
  return rel.length ? join(rel[0], ...rel.slice(1)) : '.';
}

function cmpList(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = cmpStr(a[i], b[i]);
    if (c) return c;
  }
  return a.length - b.length;
}

export function commonpath(paths: string[]): string {
  if (!paths.length) throw new Error('commonpath() arg is an empty sequence');
  const abs = new Set(paths.map((p) => p.startsWith('/')));
  if (abs.size > 1) throw new Error("Can't mix absolute and relative paths");
  const parts = paths.map((p) => p.split('/').filter((c) => c && c !== '.'));
  let s1 = parts[0];
  let s2 = parts[0];
  for (const x of parts) {
    if (cmpList(x, s1) < 0) s1 = x;
    if (cmpList(x, s2) > 0) s2 = x;
  }
  let common = s1;
  for (let i = 0; i < s1.length; i++) {
    if (s1[i] !== s2[i]) {
      common = s1.slice(0, i);
      break;
    }
  }
  return (paths[0].startsWith('/') ? '/' : '') + common.join('/');
}

export function islink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

export function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

export function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function isfile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isdir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** os.path.realpath (Python 3.9, non-strict): resolves symlinks component by component, keeps missing parts. */
export function realpath(filename: string): string {
  return abspath(joinRealpath('', filename, new Map())[0]);
}

function joinRealpath(path: string, rest: string, seen: Map<string, string | null>): [string, boolean] {
  if (isabs(rest)) {
    rest = rest.slice(1);
    path = '/';
  }
  while (rest) {
    const i = rest.indexOf('/');
    let name: string;
    if (i < 0) {
      name = rest;
      rest = '';
    } else {
      name = rest.slice(0, i);
      rest = rest.slice(i + 1);
    }
    if (!name || name === '.') continue;
    if (name === '..') {
      if (path) {
        const [head, tail] = split(path);
        path = head;
        if (tail === '..') path = join(path, '..', '..');
      } else path = '..';
      continue;
    }
    const newpath = join(path, name);
    if (!islink(newpath)) {
      path = newpath;
      continue;
    }
    if (seen.has(newpath)) {
      const cached = seen.get(newpath);
      if (cached != null) {
        path = cached;
        continue;
      }
      return [join(newpath, rest), false];
    }
    seen.set(newpath, null);
    const [resolved, ok] = joinRealpath(path, fs.readlinkSync(newpath), seen);
    path = resolved;
    if (!ok) return [join(path, rest), false];
    seen.set(newpath, path);
  }
  return [path, true];
}

export function expanduser(p: string): string {
  if (!p.startsWith('~')) return p;
  let i = p.indexOf('/', 1);
  if (i < 0) i = p.length;
  if (i !== 1) return p; // ~user forms are not used by review-kit
  const home = process.env.HOME !== undefined ? process.env.HOME : os.userInfo().homedir;
  return (rstrip(home, '/') + p.slice(i)) || '/';
}

/** os.walk(top, topdown) without following symlinked folders; errors listing a folder are ignored. */
export function* walk(top: string, topdown = true): Generator<[string, string[], string[]]> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(top, { withFileTypes: true });
  } catch {
    return;
  }
  const dirs: string[] = [];
  const files: string[] = [];
  const linked = new Set<string>();
  for (const e of entries) {
    let isDir = e.isDirectory();
    if (!isDir && e.isSymbolicLink()) {
      isDir = isdir(join(top, e.name));
      if (isDir) linked.add(e.name);
    }
    (isDir ? dirs : files).push(e.name);
  }
  if (topdown) yield [top, dirs, files];
  for (const d of dirs) {
    const p = join(top, d);
    if (!linked.has(d) && !islink(p)) yield* walk(p, topdown);
  }
  if (!topdown) yield [top, dirs, files];
}

export function listdir(p: string): string[] {
  return fs.readdirSync(p);
}

// ---------------------------------------------------------------- text files (Python's text mode: universal newlines)
export function readText(p: string): string {
  const s = decodeUtf8(fs.readFileSync(p));
  return s.includes('\r') ? s.replace(/\r\n?/g, '\n') : s;
}

// ---------------------------------------------------------------- UTF-8 decoding with Python's errors
export class UnicodeDecodeError extends Error {
  override name = 'UnicodeDecodeError';
}

const FAST = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** bytes.decode('utf-8'[, 'surrogatepass']): strict, keeps a BOM, raises Python's error message. */
export function decodeUtf8(buf: Uint8Array, surrogatepass = false): string {
  if (!surrogatepass) {
    try {
      return FAST.decode(buf);
    } catch {
      /* fall through for the exact error */
    }
  }
  let out = '';
  let i = 0;
  const n = buf.length;
  const fail = (start: number, end: number, reason: string): never => {
    const what = end - start === 1
      ? `byte 0x${buf[start].toString(16).padStart(2, '0')} in position ${start}`
      : `bytes in position ${start}-${end - 1}`;
    throw new UnicodeDecodeError(`'utf-8' codec can't decode ${what}: ${reason}`);
  };
  while (i < n) {
    const b = buf[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i++;
      continue;
    }
    let need: number;
    let lo = 0x80;
    let hi = 0xbf;
    if (b >= 0xc2 && b <= 0xdf) need = 1;
    else if (b >= 0xe0 && b <= 0xef) {
      need = 2;
      if (b === 0xe0) lo = 0xa0;
      if (b === 0xed && !surrogatepass) hi = 0x9f;
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3;
      if (b === 0xf0) lo = 0x90;
      if (b === 0xf4) hi = 0x8f;
    } else return fail(i, i + 1, 'invalid start byte');
    let cp = b & (need === 1 ? 0x1f : need === 2 ? 0x0f : 0x07);
    for (let k = 1; k <= need; k++) {
      if (i + k >= n) return fail(i, n, 'unexpected end of data');
      const c = buf[i + k];
      const l = k === 1 ? lo : 0x80;
      const h = k === 1 ? hi : 0xbf;
      if (c < l || c > h) return fail(i, i + k, 'invalid continuation byte');
      cp = (cp << 6) | (c & 0x3f);
    }
    out += String.fromCodePoint(cp);
    i += need + 1;
  }
  return out;
}

// ---------------------------------------------------------------- time
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** time.strftime for the few directives review-kit uses (%d %b %Y %H %M %S %m), in local time. */
export function strftime(fmt: string, d = new Date()): string {
  return fmt.replace(/%([dbYHMSm%])/g, (_, c: string) => {
    switch (c) {
      case 'd': return pad(d.getDate());
      case 'b': return MONTHS[d.getMonth()];
      case 'Y': return String(d.getFullYear());
      case 'm': return pad(d.getMonth() + 1);
      case 'H': return pad(d.getHours());
      case 'M': return pad(d.getMinutes());
      case 'S': return pad(d.getSeconds());
      default: return '%';
    }
  });
}

/** datetime.date.today().isoformat() */
export function today(): string {
  return strftime('%Y-%m-%d');
}

// ---------------------------------------------------------------- OSError
const STRERROR: Record<string, string> = {
  EPERM: 'Operation not permitted',
  ENOENT: 'No such file or directory',
  EIO: 'Input/output error',
  EBADF: 'Bad file descriptor',
  EACCES: 'Permission denied',
  EEXIST: 'File exists',
  EXDEV: 'Cross-device link',
  ENOTDIR: 'Not a directory',
  EISDIR: 'Is a directory',
  EINVAL: 'Invalid argument',
  EMFILE: 'Too many open files',
  ENFILE: 'Too many open files in system',
  EFBIG: 'File too large',
  ENOSPC: 'No space left on device',
  EROFS: 'Read-only file system',
  EMLINK: 'Too many links',
  EPIPE: 'Broken pipe',
  ENAMETOOLONG: 'File name too long',
  ENOTEMPTY: 'Directory not empty',
  ELOOP: 'Too many levels of symbolic links',
  EADDRINUSE: 'Address already in use',
  ECONNREFUSED: 'Connection refused',
  ECONNRESET: 'Connection reset by peer',
  ETIMEDOUT: 'Operation timed out',
  EHOSTUNREACH: 'No route to host',
  ENETUNREACH: 'Network is unreachable',
  EDQUOT: 'Disc quota exceeded',
  ...(process.platform === 'darwin'
    ? { EBUSY: 'Resource busy', EADDRNOTAVAIL: "Can't assign requested address", EAFNOSUPPORT: 'Address family not supported by protocol family' }
    : { EBUSY: 'Device or resource busy', EADDRNOTAVAIL: 'Cannot assign requested address', ETIMEDOUT: 'Connection timed out',
        EAFNOSUPPORT: 'Address family not supported by protocol', EDQUOT: 'Disk quota exceeded' }),
};

export interface OSErrorLike extends Error {
  code?: string;
  errno?: number;
  path?: string;
  dest?: string;
  strerror?: string;
}

/** True for errors Python would raise as OSError: Node system errors and errors carrying an E* code. */
export function isOSError(e: unknown): e is OSErrorLike {
  return e instanceof Error && typeof (e as OSErrorLike).code === 'string' && /^E[A-Z0-9]+$/.test((e as OSErrorLike).code!);
}

/** e.strerror or str(e): the system message when Node reports one, else the error's own message. */
export function strerror(e: OSErrorLike): string {
  if (e.strerror) return e.strerror;
  if (typeof e.errno === 'number' && e.code && STRERROR[e.code]) return STRERROR[e.code];
  if (typeof e.errno === 'number' && e.code) return e.message.replace(/^[A-Z0-9]+: /, '').replace(/,.*$/, '');
  return e.message;
}

/** How the CLI reports an OSError: "<filename>: <strerror>". */
export function osErrorMessage(e: OSErrorLike): string {
  return (e.path ? `${e.path}: ` : '') + strerror(e);
}

export function osError(code: string, path?: string, message?: string): OSErrorLike {
  const e = new Error(message || STRERROR[code] || code) as OSErrorLike;
  e.code = code;
  e.errno = 1;
  e.strerror = message || STRERROR[code] || code;
  if (path !== undefined) e.path = path;
  return e;
}
