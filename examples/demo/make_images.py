#!/usr/bin/env python3
"""Regenerate the demo's tiny mock screenshots (stdlib only: zlib + struct).

    python3 examples/demo/make_images.py

Draws flat-colour wireframes of a phone screen and a desktop table, before and after a fix.
"""
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'screenshots')


class Canvas:
    def __init__(self, w, h, bg):
        self.w, self.h = w, h
        self.px = [list(bg) * w for _ in range(h)]

    def rect(self, x, y, w, h, color):
        for yy in range(max(0, y), min(self.h, y + h)):
            row = self.px[yy]
            for xx in range(max(0, x), min(self.w, x + w)):
                row[xx * 3:xx * 3 + 3] = color

    def text(self, x, y, w, color, h=6):
        """A 'line of text': a rounded-ish bar."""
        self.rect(x + 1, y, w - 2, h, color)
        self.rect(x, y + 1, w, h - 2, color)

    def save(self, path):
        raw = b''.join(b'\x00' + bytes(r) for r in self.px)

        def chunk(t, d):
            c = struct.pack('>I', len(d)) + t + d
            return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)

        png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', self.w, self.h, 8, 2, 0, 0, 0))
        png += chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
        with open(path, 'wb') as f:
            f.write(png)


BG, CARD, INK, MUTED, LINE = (243, 246, 246), (255, 255, 255), (40, 52, 58), (160, 172, 176), (219, 227, 229)
ACCENT, RED, GREEN, PALE = (91, 61, 245), (198, 40, 40), (27, 127, 75), (225, 228, 240)


def phone(after):
    c = Canvas(180, 360, BG)
    c.rect(0, 0, 180, 34, ACCENT)
    c.text(12, 14, 70, (255, 255, 255))
    for i in range(5):
        y = 46 + i * 44
        c.rect(8, y, 164, 38, CARD)
        c.text(16, y + 9, 90 if i % 2 else 70, INK)
        c.text(16, y + 23, 50, MUTED, 5)
        c.text(130, y + 15, 34, INK)
    # Bottom of the form: before = Save hidden under the bottom nav and low-contrast; after = sticky bar, solid primary.
    if after:
        c.rect(0, 274, 180, 46, CARD)
        c.rect(0, 274, 180, 1, LINE)
        c.rect(12, 284, 72, 26, PALE)
        c.rect(96, 284, 72, 26, ACCENT)
        c.text(116, 294, 32, (255, 255, 255))
    else:
        c.rect(96, 300, 72, 26, PALE)
        c.text(116, 310, 32, (190, 194, 214))
    c.rect(0, 320, 180, 40, CARD)
    c.rect(0, 320, 180, 1, LINE)
    for i in range(4):
        c.rect(18 + i * 44, 332, 18, 16, ACCENT if i == 0 else MUTED)
    return c


def desktop(after):
    c = Canvas(480, 270, BG)
    c.rect(0, 0, 480, 30, ACCENT)
    c.text(14, 12, 90, (255, 255, 255))
    c.rect(0, 30, 92, 240, CARD)
    for i in range(6):
        c.text(12, 46 + i * 22, 60, MUTED if i else ACCENT)
    c.rect(104, 44, 364, 214, CARD)
    c.rect(104, 70, 364, 1, LINE)
    cols = [(114, 70), (196, 120), (330, 60), (404, 52)] if after else [(114, 96), (196, 120), (300, 60), (350, 52)]
    for x, w in cols:
        c.text(x, 54, min(w, 44), MUTED, 5)
    for r in range(7):
        y = 80 + r * 25
        c.rect(104, y + 21, 364, 1, LINE)
        for k, (x, w) in enumerate(cols):
            color = RED if (not after and k == 0) else INK
            c.text(x, y + 7, w - 8 if k != 3 else 20, color)
        if after:
            c.rect(440, y + 4, 14, 14, PALE)
    return c


def main():
    os.makedirs(OUT, exist_ok=True)
    phone(False).save(os.path.join(OUT, 'mobile-save-before.png'))
    phone(True).save(os.path.join(OUT, 'mobile-save-after.png'))
    desktop(False).save(os.path.join(OUT, 'desktop-table-before.png'))
    desktop(True).save(os.path.join(OUT, 'desktop-table-after.png'))
    for n in sorted(os.listdir(OUT)):
        print(n, os.path.getsize(os.path.join(OUT, n)), 'bytes')


if __name__ == '__main__':
    main()
