// Shared test helpers (port of tests/helpers.py). Importing this module points HOME at a fresh temp folder,
// so nothing under test can read or write the real home directory.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-home-'));
process.env.HOME = HOME;
process.on('exit', () => fs.rmSync(HOME, { recursive: true, force: true }));

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DEMO = path.join(ROOT, 'examples', 'demo');

// Imported after HOME is set, so nothing in the CLI can capture the real home directory.
const { main } = await import('../dist/cli.js');
const { io } = await import('../dist/io.js');
const { createHandler } = await import('../dist/serve.js');

export function read(p) {
  return fs.readFileSync(p, 'utf-8');
}

export function readBytes(p) {
  return fs.readFileSync(p);
}

export function minimal() {
  return { version: 1, project: { name: 'Test' } };
}

export function loadDemo() {
  return JSON.parse(read(path.join(DEMO, 'review.json')));
}

/** Swap the CLI's output streams for collectors while fn runs. */
async function captured(fn) {
  const cap = { out: '', err: '' };
  const saved = { stdout: io.stdout, stderr: io.stderr };
  io.stdout = (text) => { cap.out += text; };
  io.stderr = (text) => { cap.err += text; };
  try {
    cap.value = await fn();
  } finally {
    io.stdout = saved.stdout;
    io.stderr = saved.stderr;
  }
  return cap;
}

/** Run the CLI in-process (like contextlib.redirect_stdout around cli.main). Resolves with {code, out, err}. */
export async function run(...argv) {
  const { value, out, err } = await captured(() => main(argv.map(String)));
  return { code: value, out, err };
}

/** Run fn with the CLI's output captured (keeps expected log lines out of the test output). */
export async function quietly(fn) {
  return captured(fn);
}

// ---------------------------------------------------------------- PNG writer (port of make_images.Canvas.save)
let CRC_TABLE = null;
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** A flat-colour 8-bit RGB PNG of w x h pixels (filter byte 0 per row, deflate level 9). */
export function pngBytes(w, h, bg = [10, 20, 30]) {
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set(bg, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- per-test temp folder (TempDirTest)
export class TempDir {
  constructor() {
    this.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-test-'));
  }

  cleanup() {
    fs.rmSync(this.tmp, { recursive: true, force: true });
  }

  /** A writable copy of the demo review (review.json + screenshots), without its built site. */
  copyDemo() {
    const d = path.join(this.tmp, 'demo');
    fs.cpSync(DEMO, d, { recursive: true, filter: (src) => path.basename(src) !== 'site' });
    const p = path.join(d, 'review.json');
    const data = JSON.parse(read(p));
    delete data.$schema;
    fs.writeFileSync(p, JSON.stringify(data));
    return p;
  }

  write(data, name = 'review.json') {
    const p = path.join(this.tmp, name);
    fs.writeFileSync(p, JSON.stringify(data));
    return p;
  }

  png(name, w = 4, h = 8) {
    const p = path.join(this.tmp, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, pngBytes(w, h));
    return p;
  }
}

/** Wrap a test body so it gets its own TempDir (passed as the argument), removed afterwards. */
export function withTmp(fn) {
  return async () => {
    const t = new TempDir();
    try {
      await fn(t);
    } finally {
      t.cleanup();
    }
  };
}

// ---------------------------------------------------------------- HTTP helpers for the server tests
/** Start the review-kit request handler on a free loopback port (replaces ThreadingHTTPServer + _Handler). */
export async function startServer(directory) {
  const server = http.createServer(createHandler(directory));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

export function stopServer(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

/** A raw request (the path is sent as-is, not normalised like fetch/URL would). Resolves with {status, headers, body}. */
export function request(port, reqPath, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method, headers, agent: false, timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });
}
