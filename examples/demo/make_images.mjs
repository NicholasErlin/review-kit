#!/usr/bin/env node
// Regenerate the demo's tiny mock screenshots (Node built-ins only: zlib + Buffer).
//
//     node examples/demo/make_images.mjs
//
// Draws flat-colour wireframes of a phone screen and a desktop table, before and after a fix.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'screenshots');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export class Canvas {
  constructor(w, h, bg) {
    this.w = w;
    this.h = h;
    this.px = Array.from({ length: h }, () => Buffer.from(Array(w).fill(bg).flat()));
  }

  rect(x, y, w, h, color) {
    for (let yy = Math.max(0, y); yy < Math.min(this.h, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(this.w, x + w); xx++) this.px[yy].set(color, xx * 3);
    }
  }

  /** A 'line of text': a rounded-ish bar. */
  text(x, y, w, color, h = 6) {
    this.rect(x + 1, y, w - 2, h, color);
    this.rect(x, y + 1, w, h - 2, color);
  }

  png() {
    const raw = Buffer.concat(this.px.map((r) => Buffer.concat([Buffer.from([0]), r])));
    const chunk = (type, data) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(body));
      return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0);
    ihdr.writeUInt32BE(this.h, 4);
    ihdr.set([8, 2, 0, 0, 0], 8);
    return Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
  }

  save(file) {
    fs.writeFileSync(file, this.png());
  }
}

const BG = [243, 246, 246], CARD = [255, 255, 255], INK = [40, 52, 58], MUTED = [160, 172, 176], LINE = [219, 227, 229];
const ACCENT = [91, 61, 245], RED = [198, 40, 40], PALE = [225, 228, 240], WHITE = [255, 255, 255];

function phone(after) {
  const c = new Canvas(180, 360, BG);
  c.rect(0, 0, 180, 34, ACCENT);
  c.text(12, 14, 70, WHITE);
  for (let i = 0; i < 5; i++) {
    const y = 46 + i * 44;
    c.rect(8, y, 164, 38, CARD);
    c.text(16, y + 9, i % 2 ? 90 : 70, INK);
    c.text(16, y + 23, 50, MUTED, 5);
    c.text(130, y + 15, 34, INK);
  }
  // Bottom of the form: before = Save hidden under the bottom nav and low-contrast; after = sticky bar, solid primary.
  if (after) {
    c.rect(0, 274, 180, 46, CARD);
    c.rect(0, 274, 180, 1, LINE);
    c.rect(12, 284, 72, 26, PALE);
    c.rect(96, 284, 72, 26, ACCENT);
    c.text(116, 294, 32, WHITE);
  } else {
    c.rect(96, 300, 72, 26, PALE);
    c.text(116, 310, 32, [190, 194, 214]);
  }
  c.rect(0, 320, 180, 40, CARD);
  c.rect(0, 320, 180, 1, LINE);
  for (let i = 0; i < 4; i++) c.rect(18 + i * 44, 332, 18, 16, i === 0 ? ACCENT : MUTED);
  return c;
}

function desktop(after) {
  const c = new Canvas(480, 270, BG);
  c.rect(0, 0, 480, 30, ACCENT);
  c.text(14, 12, 90, WHITE);
  c.rect(0, 30, 92, 240, CARD);
  for (let i = 0; i < 6; i++) c.text(12, 46 + i * 22, 60, i ? MUTED : ACCENT);
  c.rect(104, 44, 364, 214, CARD);
  c.rect(104, 70, 364, 1, LINE);
  const cols = after ? [[114, 70], [196, 120], [330, 60], [404, 52]] : [[114, 96], [196, 120], [300, 60], [350, 52]];
  for (const [x, w] of cols) c.text(x, 54, Math.min(w, 44), MUTED, 5);
  for (let r = 0; r < 7; r++) {
    const y = 80 + r * 25;
    c.rect(104, y + 21, 364, 1, LINE);
    cols.forEach(([x, w], k) => c.text(x, y + 7, k !== 3 ? w - 8 : 20, !after && k === 0 ? RED : INK));
    if (after) c.rect(440, y + 4, 14, 14, PALE);
  }
  return c;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] || OUT;
  fs.mkdirSync(out, { recursive: true });
  phone(false).save(path.join(out, 'mobile-save-before.png'));
  phone(true).save(path.join(out, 'mobile-save-after.png'));
  desktop(false).save(path.join(out, 'desktop-table-before.png'));
  desktop(true).save(path.join(out, 'desktop-table-after.png'));
  for (const n of fs.readdirSync(out).sort()) console.log(n, fs.statSync(path.join(out, n)).size, 'bytes');
}
