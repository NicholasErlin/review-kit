/**
 * Image helpers: read dimensions without dependencies, copy with optional downscaling.
 *
 * Downscaling uses whatever is installed (macOS `sips`, ImageMagick `magick`/`convert`);
 * without any of them images are copied unchanged.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { dirname, exists, isfile, join, splitext } from './py.js';

export const EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif'];

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function readAt(fd: number, pos: number, n: number): Buffer {
  const buf = Buffer.alloc(n);
  const got = fs.readSync(fd, buf, 0, n, pos);
  return buf.subarray(0, got);
}

/** [width, height] for PNG, JPEG, GIF and WebP; null when unknown. */
export function size(path: string): [number, number] | null {
  let fd: number;
  try {
    fd = fs.openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const head = readAt(fd, 0, 32);
    const eq = (start: number, s: string) => head.subarray(start, start + s.length).equals(Buffer.from(s, 'latin1'));
    if (eq(0, '\x89PNG\r\n\x1a\n') && eq(12, 'IHDR')) {
      if (head.length < 24) return null;
      return [head.readUInt32BE(16), head.readUInt32BE(20)];
    }
    if (eq(0, 'GIF87a') || eq(0, 'GIF89a')) {
      if (head.length < 10) return null;
      return [head.readUInt16LE(6), head.readUInt16LE(8)];
    }
    if (eq(0, 'RIFF') && eq(8, 'WEBP')) {
      if (eq(12, 'VP8 ')) {
        if (head.length < 30) return null;
        return [head.readUInt16LE(26) & 0x3fff, head.readUInt16LE(28) & 0x3fff];
      }
      if (eq(12, 'VP8L')) {
        const b = head.subarray(21, 25);
        if (b.length < 4) throw new RangeError('index out of range');
        const w = 1 + (((b[1] & 0x3f) << 8) | b[0]);
        const h = 1 + (((b[3] & 0xf) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6));
        return [w, h];
      }
      if (eq(12, 'VP8X')) {
        const w = 1 + head.readUIntLE(24, 3);
        const h = 1 + head.readUIntLE(27, 3);
        return [w, h];
      }
      return null;
    }
    if (head[0] === 0xff && head[1] === 0xd8) {
      let pos = 2;
      for (;;) {
        const m = readAt(fd, pos, 2);
        pos += m.length;
        if (m.length < 2 || m[0] !== 0xff) return null;
        const marker = m[1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        const l = readAt(fd, pos, 2);
        pos += l.length;
        if (l.length < 2) return null;
        const ln = l.readUInt16BE(0);
        if (SOF.has(marker)) {
          pos += readAt(fd, pos, 1).length;
          const hw = readAt(fd, pos, 4);
          if (hw.length < 4) return null;
          return [hw.readUInt16BE(2), hw.readUInt16BE(0)];
        }
        pos += ln - 2;
      }
    }
  } catch (e) {
    if (e instanceof RangeError || (e as NodeJS.ErrnoException).code) return null;
    throw e;
  } finally {
    fs.closeSync(fd);
  }
  return null;
}

/** Short content hash used for cache-busting (?v=...). */
export function fingerprint(path: string): string {
  return crypto.createHash('sha1').update(fs.readFileSync(path)).digest('hex').slice(0, 10);
}

/** shutil.which */
export function which(cmd: string): string | null {
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir) continue;
    const p = join(dir, cmd);
    try {
      if (fs.statSync(p).isFile()) {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      }
    } catch {
      /* not here */
    }
  }
  return null;
}

/** Name of an available resize tool, or null. */
export function resizer(): string | null {
  for (const tool of ['sips', 'magick', 'convert']) {
    if (which(tool)) return tool;
  }
  return null;
}

function resize(tool: string, src: string, dst: string, maxWidth: number): boolean {
  let cmd: string[];
  if (tool === 'sips') cmd = ['sips', '--resampleWidth', String(maxWidth), src, '--out', dst];
  else if (tool === 'magick') cmd = ['magick', src, '-resize', `${maxWidth}x>`, dst];
  else cmd = ['convert', src, '-resize', `${maxWidth}x>`, dst];
  const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'ignore' });
  return !r.error && r.status === 0 && isfile(dst);
}

/** shutil.copyfile + copystat: contents, permission bits and timestamps. */
export function copy2(src: string, dst: string): void {
  const st = fs.statSync(src, { bigint: true });
  const fin = fs.openSync(src, 'r');
  try {
    const fout = fs.openSync(dst, 'w');
    try {
      const buf = Buffer.alloc(1 << 16);
      let n: number;
      while ((n = fs.readSync(fin, buf, 0, buf.length, null)) > 0) fs.writeSync(fout, buf, 0, n);
    } finally {
      fs.closeSync(fout);
    }
  } finally {
    fs.closeSync(fin);
  }
  fs.utimesSync(dst, secs(st.atimeNs), secs(st.mtimeNs));
  fs.chmodSync(dst, Number(st.mode) & 0o7777);
}

const secs = (ns: bigint) => Number(ns) / 1e9;

function mtimeNs(p: string): bigint {
  return fs.statSync(p, { bigint: true }).mtimeNs;
}

/**
 * Node can only set timestamps to the microsecond (Python sets nanoseconds), so "the exact same mtime" is checked
 * at that resolution: a copy review-kit made carries the source's mtime to within 2 microseconds.
 */
function sameMtime(a: bigint, b: bigint): boolean {
  const d = a > b ? a - b : b - a;
  return d < 2000n;
}

/**
 * Copy src to dst (downscaled to maxWidth when possible). Skips unchanged files.
 * Returns 'copied', 'resized' or 'kept'.
 */
export function publish(src: string, dst: string, maxWidth: number | null = null, tool: string | null = null): 'copied' | 'resized' | 'kept' {
  // Copies carry the source's mtime (copy2, and utime after resizing), so "unchanged" means the same mtime.
  // A newer *or older* source (a replaced capture, a restored file) is published again.
  const srcNs = mtimeNs(src);
  if (isfile(dst) && sameMtime(mtimeNs(dst), srcNs)) return 'kept';
  fs.mkdirSync(dirname(dst), { recursive: true });
  if (maxWidth && tool && ['.png', '.jpg', '.jpeg'].includes(splitext(src)[1].toLowerCase())) {
    const dim = size(src);
    if (dim && dim[0] > maxWidth) {
      const tmp = dst + '.tmp' + splitext(dst)[1];
      if (resize(tool, src, tmp, maxWidth)) {
        fs.utimesSync(tmp, secs(srcNs), secs(srcNs));
        fs.renameSync(tmp, dst);
        return 'resized';
      }
      if (exists(tmp)) fs.unlinkSync(tmp);
    }
  }
  copy2(src, dst);
  return 'copied';
}
