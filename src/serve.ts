/** A tiny static server for the built site, with optional rebuild-on-change. */
import { spawnSync } from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { build as buildSite, MARKER } from './build.js';
import { escape } from './htmlparser.js';
import { eprint, io, print } from './io.js';
import { ReviewError } from './errors.js';
import { loads } from './pyjson.js';
import {
  abspath, commonpath, decodeUtf8, dirname, exists, isdir, isDict, isfile, join, lstrip, normpath, relpath, realpath,
  repr, rstrip, splitext, strerror, strftime, strip, walk, type OSErrorLike,
} from './py.js';
import * as safety from './safety.js';
import { VERSION } from './version.js';

export const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];

/** 'localhost:8787' -> 'localhost', '[::1]:8787' -> '::1'. */
export function hostName(header: string): string {
  header = strip(header).toLowerCase();
  if (header.startsWith('[')) return header.slice(1).split(']')[0];
  if ((header.match(/:/g) || []).length === 1) return header.slice(0, header.lastIndexOf(':'));
  return header;
}

const RESPONSES: Record<number, [string, string]> = {
  200: ['OK', 'Request fulfilled, document follows'],
  301: ['Moved Permanently', 'Object moved permanently -- see URI list'],
  304: ['Not Modified', 'Document has not changed since given time'],
  400: ['Bad Request', 'Bad request syntax or unsupported method'],
  403: ['Forbidden', 'Request forbidden -- authorization will not help'],
  404: ['Not Found', 'Nothing matches the given URI'],
  501: ['Not Implemented', 'Server does not support this operation'],
};

const ERROR_PAGE = `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN"
        "http://www.w3.org/TR/html4/strict.dtd">
<html>
    <head>
        <meta http-equiv="Content-Type" content="text/html;charset=utf-8">
        <title>Error response</title>
    </head>
    <body>
        <h1>Error response</h1>
        <p>Error code: %(code)d</p>
        <p>Message: %(message)s.</p>
        <p>Error code explanation: %(code)s - %(explain)s.</p>
    </body>
</html>
`;

// What SimpleHTTPRequestHandler.guess_type answers for the files a site contains.
const TYPES: Record<string, string> = {
  '.gz': 'application/gzip', '.Z': 'application/octet-stream', '.bz2': 'application/x-bzip2', '.xz': 'application/x-xz',
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.ico': 'image/x-icon',
  '.xml': 'application/xml', '.wasm': 'application/wasm', '.woff2': 'font/woff2',
};

function guessType(path: string): string {
  const ext = splitext(path)[1];
  return TYPES[ext] || TYPES[ext.toLowerCase()] || 'application/octet-stream';
}

const CSP = "default-src 'self'; script-src 'self'; "
  + "style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'none'; "
  + "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function unquoteReplace(s: string): string {
  if (!s.includes('%')) return s;
  return s.replace(/[\x00-\x7f]+/g, (run) => {
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
    return new TextDecoder('utf-8').decode(Uint8Array.from(bytes));
  });
}

/** SimpleHTTPRequestHandler.translate_path */
function translatePath(directory: string, path: string): string {
  path = path.split('?')[0].split('#')[0];
  const trailingSlash = rstrip(path).endsWith('/');
  try {
    path = safety.unquote(path);
  } catch {
    path = unquoteReplace(path);
  }
  path = normpath(path);
  let out = directory;
  for (const word of path.split('/').filter(Boolean)) {
    if (dirname(word) || word === '.' || word === '..') continue;
    out = join(out, word);
  }
  return trailingSlash ? out + '/' : out;
}

const USES_NETLOC = ['', 'ftp', 'http', 'gopher', 'nntp', 'telnet', 'imap', 'wais', 'file', 'mms', 'https', 'shttp',
  'snews', 'prospero', 'rtsp', 'rtspu', 'rsync', 'svn', 'svn+ssh', 'sftp', 'nfs', 'git', 'git+ssh', 'ws', 'wss'];

const LOG_MONTHS =['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function logLine(addr: string, text: string): void {
  if (!process.env.REVIEW_KIT_LOG) return;
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const when = `${p(d.getDate())}/${LOG_MONTHS[d.getMonth()]}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  io.stderr(`${addr} - - [${when}] ${text}\n`);
}

/** The request handler: SimpleHTTPRequestHandler plus review-kit's publication checks. */
export function createHandler(directory: string) {
  const dir = abspath(directory);
  return (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const addr = req.socket.remoteAddress || '-';
    const method = req.method || 'GET';
    let path = req.url || '/';
    if (path.startsWith('//')) path = '/' + lstrip(path, '/');
    const requestline = `${method} ${req.url} HTTP/${req.httpVersion}`;
    const headers: [string, string][] = [];
    let status = 200;
    let reason = 'OK';

    const sendResponse = (code: number, message?: string) => {
      status = code;
      reason = message ?? (RESPONSES[code] ? RESPONSES[code][0] : '');
      logLine(addr, `"${requestline}" ${code} -`);
      headers.push(['Server', `review-kit/${VERSION}`], ['Date', new Date().toUTCString()]);
    };
    const endHeaders = () => {
      // Assets are cache-busted with ?v=..., but index.html and data.js must always be revalidated.
      headers.push(['Cache-Control', 'no-cache'], ['X-Content-Type-Options', 'nosniff'], ['Referrer-Policy', 'no-referrer'],
        ['Content-Security-Policy', CSP]);
      res.shouldKeepAlive = false;
      res.writeHead(status, reason, headers.flat());
    };
    // `codeStr` is how Python's error page prints the code: http.server's own errors pass an HTTPStatus member,
    // whose %s form is its enum name; review-kit's checks pass a plain int.
    const sendError = (code: number, message?: string, codeStr = String(code)) => {
      const [shortmsg, longmsg] = RESPONSES[code] || ['???', '???'];
      const msg = message ?? shortmsg;
      logLine(addr, `code ${code}, message ${msg}`);
      sendResponse(code, msg);
      headers.push(['Connection', 'close']);
      const values: Record<string, string> = { d: String(code), s: codeStr };
      const body = Buffer.from(ERROR_PAGE.replace(/%\((\w+)\)([ds])/g, (_, k: string, t: string) => (
        k === 'code' ? values[t] : k === 'message' ? escape(msg, false) : escape(longmsg, false))), 'utf8');
      headers.push(['Content-Type', 'text/html;charset=utf-8'], ['Content-Length', String(body.length)]);
      endHeaders();
      res.end(method === 'HEAD' ? undefined : body);
    };

    if (method !== 'GET' && method !== 'HEAD') {
      sendError(501, `Unsupported method (${repr(method)})`, 'HTTPStatus.NOT_IMPLEMENTED');
      return;
    }

    // A local-only server answers only to local names, so a DNS-rebound page cannot read the review.
    const bound = (req.socket.localAddress || '').replace(/^::ffff:/, '');
    const host = req.headers.host;
    if ((bound.startsWith('127.') || bound === '::1') && host !== undefined
      && !LOOPBACK_HOSTS.includes(hostName(host)) && !hostName(host).startsWith('127.')) {
      sendError(403, 'Host not allowed');
      return;
    }
    try {
      const requested = safety.requestPath(path);
      const root = realpath(dir);
      const target = realpath(translatePath(dir, path));
      const rel = relpath(target, root);
      if (safety.privatePath(requested) || safety.privatePath(rel)
        || requested.replace(/\\/g, '/').split('/').includes('..') || commonpath([root, target]) !== root) {
        sendError(404);
        return;
      }
      const marker = join(root, MARKER);
      if (exists(marker)) {
        const manifest = loads(decodeUtf8(fs.readFileSync(marker)).replace(/\r\n?/g, '\n'));
        if (!isDict(manifest) || !('files' in manifest)) throw new TypeError('manifest');
        let requestedFile = relpath(translatePath(dir, path), dir);
        if (isdir(target)) requestedFile = join(requestedFile, 'index.html');
        requestedFile = normpath(requestedFile);
        const files = manifest.files;
        const listed = Array.isArray(files) ? files.includes(requestedFile)
          : typeof files === 'string' ? files.includes(requestedFile) : (() => { throw new TypeError('files'); })();
        if (!listed) {
          sendError(404);
          return;
        }
      }
    } catch {
      sendError(404);
      return;
    }

    // SimpleHTTPRequestHandler.send_head
    let file = translatePath(dir, path);
    if (isdir(file)) {
      const parts = safety.urlsplit(path);
      if (!parts.path.endsWith('/')) {
        sendResponse(301);
        let url = parts.path + '/';
        if (parts.netloc || (parts.scheme && USES_NETLOC.includes(parts.scheme) && url.slice(0, 2) !== '//')) {
          if (url && url[0] !== '/') url = '/' + url;
          url = '//' + parts.netloc + url;
        }
        if (parts.scheme) url = parts.scheme + ':' + url;
        if (parts.query) url += '?' + parts.query;
        if (parts.fragment) url += '#' + parts.fragment;
        headers.push(['Location', url]);
        endHeaders();
        res.end();
        return;
      }
      const index = ['index.html', 'index.htm'].map((n) => join(file, n)).find((p) => exists(p));
      if (!index) {
        sendError(404); // no directory listings
        return;
      }
      file = index;
    }
    const ctype = guessType(file);
    if (file.endsWith('/')) {
      sendError(404, 'File not found', 'HTTPStatus.NOT_FOUND');
      return;
    }
    let fd: number;
    try {
      fd = fs.openSync(file, 'r');
    } catch {
      sendError(404, 'File not found', 'HTTPStatus.NOT_FOUND');
      return;
    }
    let st: fs.Stats;
    try {
      st = fs.fstatSync(fd);
      if (st.isDirectory()) throw new Error('directory');
    } catch {
      fs.closeSync(fd);
      sendError(404, 'File not found', 'HTTPStatus.NOT_FOUND');
      return;
    }
    const ims = req.headers['if-modified-since'];
    if (ims !== undefined && req.headers['if-none-match'] === undefined) {
      const t = Date.parse(ims);
      if (!Number.isNaN(t) && Math.floor(st.mtimeMs / 1000) * 1000 <= t) {
        fs.closeSync(fd);
        sendResponse(304);
        endHeaders();
        res.end();
        return;
      }
    }
    sendResponse(200);
    headers.push(['Content-type', ctype], ['Content-Length', String(st.size)], ['Last-Modified', new Date(st.mtimeMs).toUTCString()]);
    endHeaders();
    if (method === 'HEAD') {
      fs.closeSync(fd);
      res.end();
      return;
    }
    const stream = fs.createReadStream('', { fd });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  };
}

/** Best-effort list of IPv4 addresses other devices can reach (LAN, Tailscale, ...). */
export async function lanAddresses(): Promise<string[]> {
  const found: string[] = [];
  const add = (ip: string | undefined) => {
    if (ip && !ip.startsWith('127.') && !ip.startsWith('169.254.') && !found.includes(ip)) found.push(ip);
  };
  await new Promise<void>((resolve) => {
    const s = dgram.createSocket('udp4');
    const done = () => {
      try {
        s.close();
      } catch {
        /* closed */
      }
      resolve();
    };
    s.on('error', done);
    try {
      s.connect(80, '192.0.2.1', () => { // TEST-NET address: nothing is sent
        try {
          add(s.address().address);
        } catch {
          /* no route */
        }
        done();
      });
    } catch {
      done();
    }
  });
  for (const cmd of [['ifconfig'], ['ip', '-4', '-o', 'addr', 'show']]) {
    const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf-8', timeout: 3000 });
    if (r.error || r.signal) continue;
    for (const m of (r.stdout || '').matchAll(/inet (?:addr:)?(\d+\.\d+\.\d+\.\d+)/g)) add(m[1]);
    if (found.length) break;
  }
  return found;
}

export function tailscale(ip: string): boolean {
  const [a, b] = ip.split('.').slice(0, 2).map((x) => parseInt(x, 10));
  return a === 100 && b >= 64 && b <= 127; // 100.64.0.0/10 (CGNAT range used by Tailscale)
}

/** [path, mtime] of review.json and every screenshot, so edits, additions and deletions all count as changes. */
export function snapshot(reviewPath: string): string {
  const base = dirname(abspath(reviewPath));
  const stamp: [string, number][] = [[reviewPath, fs.statSync(reviewPath).mtimeMs]];
  const d = join(base, 'screenshots');
  if (isdir(d)) {
    for (const [dp, , fsn] of walk(d)) for (const f of fsn) stamp.push([join(dp, f), fs.statSync(join(dp, f)).mtimeMs]);
  }
  return JSON.stringify(stamp.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1])));
}

const PY_ERRORS: Record<string, string> = {
  ENOENT: 'FileNotFoundError', EACCES: 'PermissionError', EPERM: 'PermissionError', EEXIST: 'FileExistsError',
  EISDIR: 'IsADirectoryError', ENOTDIR: 'NotADirectoryError', ENOTEMPTY: 'OSError',
};

/** type(e).__name__ and str(e) of an unexpected error, Python style. */
function describe(e: unknown): string {
  if (e instanceof Error) {
    const o = e as OSErrorLike;
    if (o.code && /^E[A-Z0-9]+$/.test(o.code)) {
      const name = PY_ERRORS[o.code] || 'OSError';
      if (typeof o.errno === 'number' && !o.strerror) {
        let msg = `[Errno ${Math.abs(o.errno)}] ${strerror(o)}`;
        if (o.path) msg += `: ${repr(o.path)}`;
        if (o.dest) msg += ` -> ${repr(o.dest)}`;
        return `${name}: ${msg}`;
      }
      return `${name}: ${e.message}`;
    }
    return `${e.name}: ${e.message}`;
  }
  return `Exception: ${String(e)}`;
}

/** Rebuild once. Never throws: one failed rebuild must not stop watching. */
export function rebuild(reviewPath: string, out: string, maxWidth: number | null, build = buildSite): boolean {
  try {
    build(reviewPath, out, { maxWidth, quiet: true });
  } catch (e) {
    if (e instanceof ReviewError) eprint(strftime('%H:%M:%S'), 'rebuild failed:', e.message);
    else eprint(strftime('%H:%M:%S'), `rebuild failed: ${describe(e)}`);
    return false;
  }
  print(strftime('%H:%M:%S'), 'rebuilt');
  return true;
}

function watch(reviewPath: string, out: string, maxWidth: number | null, interval = 1000): void {
  let last = snapshot(reviewPath);
  const timer = setInterval(() => {
    let now: string;
    try {
      now = snapshot(reviewPath);
    } catch {
      return;
    }
    if (now !== last) {
      last = now;
      rebuild(reviewPath, out, maxWidth);
    }
  }, interval);
  timer.unref();
}

function lookup4(host: string): Promise<string> {
  if (host === '') return Promise.resolve('0.0.0.0');
  return new Promise((resolve, reject) => {
    dns.lookup(host, { family: 4 }, (err, address) => (err ? reject(err) : resolve(address)));
  });
}

export interface ServeOptions {
  reviewPath?: string | null;
  watch?: boolean;
  maxWidth?: number | null;
}

/** Start the server and resolve once it is listening (it keeps running until the process stops). */
export async function serve(directory: string, host = '127.0.0.1', port = 8787, opts: ServeOptions = {}): Promise<http.Server> {
  if (!isfile(join(directory, 'index.html'))) throw new ReviewError(`${directory}/index.html not found; run \`review-kit build\` first`);
  const marker = join(directory, MARKER);
  if (exists(marker)) {
    let ok = false;
    try {
      const manifest = loads(decodeUtf8(fs.readFileSync(marker)).replace(/\r\n?/g, '\n'));
      ok = isDict(manifest) && Array.isArray(manifest.files);
    } catch {
      ok = false;
    }
    if (!ok) throw new ReviewError('old or invalid site manifest; run `review-kit build` again');
  }
  const server = http.createServer(createHandler(directory));
  try {
    const address = await lookup4(host);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, address, 5, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (e) {
    const err = e as OSErrorLike;
    let msg: string;
    if (err.code === 'ENOTFOUND' || err.code === 'EAI_NONAME') {
      msg = process.platform === 'darwin' ? 'nodename nor servname provided, or not known' : 'Name or service not known';
    } else msg = err.code ? strerror(err) : err.message;
    throw new ReviewError(`cannot listen on ${host}:${port}: ${msg}`);
  }
  port = (server.address() as AddressInfo).port;
  if (!LOOPBACK_HOSTS.includes(host)) print('Network sharing enabled: anyone who can reach this port can read the review.');
  print(`Serving ${abspath(directory)}`);
  // The server listens on IPv4; `localhost` may resolve to ::1 first (Node 18's fetch does), so print the address.
  const local = host === 'localhost' ? 'localhost' : host === '::1' ? '[::1]' : '127.0.0.1';
  print(`  local:   http://${local}:${port}/`);
  if (host === '0.0.0.0' || host === '') {
    const ips = await lanAddresses();
    const tail = ips.slice(1).filter((ip) => !tailscale(ip));
    if (ips.length) print(`  network: http://${ips[0]}:${port}/`);
    for (const ip of ips) if (tailscale(ip)) print(`  tailscale: http://${ip}:${port}/`);
    if (tail.length) print('  also: ' + tail.join(', '));
  } else if (host !== '127.0.0.1' && host !== 'localhost') print(`  network: http://${host}:${port}/`);
  if (opts.watch && opts.reviewPath) {
    watch(opts.reviewPath, directory, opts.maxWidth ?? null);
    print(`  watching ${opts.reviewPath} for changes`);
  }
  print('Ctrl+C to stop.');
  return server;
}
