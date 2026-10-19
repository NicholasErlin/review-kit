/** Publication boundaries shared by validation, building and serving. */
import { ReviewError } from './errors.js';
import { commonpath, decodeUtf8, isabs, join, realpath, relpath, splitext, strip } from './py.js';

export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif']);
export const ATTACHMENT_EXTS = new Set([...IMAGE_EXTS, '.pdf', '.txt', '.md', '.csv', '.tsv', '.json', '.patch', '.diff']);
export const PRIVATE_NAMES = new Set(['state.json', 'storage-state.json', 'storagestate.json', 'auth.json',
  'cookies.json', 'credentials', 'credentials.json', 'secrets.json',
  'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa']);
const PRIVATE_EXTS = ['.pem', '.key', '.p12', '.pfx', '.keystore'];

export function privatePath(path: string): boolean {
  return path.replace(/\\/g, '/').split('/').some((p) => {
    const low = p.toLowerCase();
    return (p.startsWith('.') && p !== '.' && p !== '..') || PRIVATE_NAMES.has(low)
      || PRIVATE_EXTS.some((e) => low.endsWith(e));
  });
}

// ---------------------------------------------------------------- urllib.parse.urlsplit (Python 3.9)
export interface SplitResult {
  scheme: string;
  netloc: string;
  path: string;
  query: string;
  fragment: string;
  username: string | null;
  password: string | null;
}

const SCHEME_CHARS = /^[A-Za-z0-9+\-.]*$/;

function checkNetloc(netloc: string): void {
  if (!netloc || /^[\x00-\x7f]*$/.test(netloc)) return;
  const n = netloc.replace(/[@:#?]/g, '');
  const n2 = n.normalize('NFKC');
  if (n === n2) return;
  for (const c of '/?#@:') {
    if (n2.includes(c)) throw new Error(`netloc '${netloc}' contains invalid characters under NFKC normalization`);
  }
}

export function urlsplit(url: string): SplitResult {
  url = url.replace(/[\t\r\n]/g, '');
  let scheme = '';
  let netloc = '';
  let query = '';
  let fragment = '';
  const i = url.indexOf(':');
  if (i > 0 && /^[A-Za-z]/.test(url) && SCHEME_CHARS.test(url.slice(0, i))) {
    scheme = url.slice(0, i).toLowerCase();
    url = url.slice(i + 1);
  }
  if (url.slice(0, 2) === '//') {
    let delim = url.length;
    for (const c of '/?#') {
      const w = url.indexOf(c, 2);
      if (w >= 0) delim = Math.min(delim, w);
    }
    netloc = url.slice(2, delim);
    url = url.slice(delim);
    if ((netloc.includes('[') && !netloc.includes(']')) || (netloc.includes(']') && !netloc.includes('['))) {
      throw new Error('Invalid IPv6 URL');
    }
  }
  let k = url.indexOf('#');
  if (k >= 0) {
    fragment = url.slice(k + 1);
    url = url.slice(0, k);
  }
  k = url.indexOf('?');
  if (k >= 0) {
    query = url.slice(k + 1);
    url = url.slice(0, k);
  }
  checkNetloc(netloc);
  let username: string | null = null;
  let password: string | null = null;
  const at = netloc.lastIndexOf('@');
  if (at >= 0) {
    const userinfo = netloc.slice(0, at);
    const c = userinfo.indexOf(':');
    username = c >= 0 ? userinfo.slice(0, c) : userinfo;
    password = c >= 0 ? userinfo.slice(c + 1) : null;
  }
  return { scheme, netloc, path: url, query, fragment, username, password };
}

/** urllib.parse.unquote(s, errors='surrogatepass'): invalid UTF-8 raises a UnicodeDecodeError. */
export function unquote(s: string): string {
  if (!s.includes('%')) return s;
  return s.replace(/[\x00-\x7f]+/g, (run) => {
    if (!run.includes('%')) return run;
    const bytes: number[] = [];
    const parts = run.split('%');
    for (const ch of parts[0]) bytes.push(ch.charCodeAt(0));
    for (const item of parts.slice(1)) {
      if (/^[0-9a-fA-F]{2}/.test(item)) {
        bytes.push(parseInt(item.slice(0, 2), 16));
        for (const ch of item.slice(2)) bytes.push(ch.charCodeAt(0));
      } else {
        bytes.push(0x25);
        for (const ch of item) bytes.push(ch.charCodeAt(0));
      }
    }
    return decodeUtf8(Uint8Array.from(bytes), true);
  });
}

/** Allow ordinary links, rejecting active schemes, credentials and obfuscated controls. */
export function safeUrl(value: string): string {
  value = strip(value);
  if (!value || /[\x00-\x20\x7f\\]/.test(value) || value.startsWith('//')) return '#';
  try {
    const url = urlsplit(value);
    if (url.scheme && !['http', 'https', 'mailto'].includes(url.scheme.toLowerCase())) return '#';
    if (['http', 'https'].includes(url.scheme.toLowerCase()) && (!url.netloc || url.username || url.password)) return '#';
  } catch {
    return '#';
  }
  return value;
}

export function isLocalLink(href: string): boolean {
  return !urlsplit(href).scheme && !href.startsWith('/') && !href.startsWith('#');
}

/** Resolve a relative reference inside the review, including its symlink target. */
export function localSource(base: string, src: string, image = false): string {
  base = realpath(base);
  const target = realpath(join(base, src));
  if (isabs(src) || commonpath([base, target]) !== base) {
    throw new ReviewError('asset must stay inside the review folder; import external screenshots with add-issue/add-fix');
  }
  const rel = relpath(target, base);
  if (privatePath(src) || privatePath(rel)) throw new ReviewError('private files cannot be published as assets');
  const allowed = image ? IMAGE_EXTS : ATTACHMENT_EXTS;
  if (!allowed.has(splitext(target)[1].toLowerCase())) {
    throw new ReviewError('unsupported asset type (use raster screenshots or document attachments)');
  }
  return target;
}

/** Decode the URL path once, exactly as SimpleHTTPRequestHandler does. */
export function requestPath(path: string): string {
  return unquote(urlsplit(path).path);
}
