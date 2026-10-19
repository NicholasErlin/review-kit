"""Image helpers: read dimensions without dependencies, copy with optional downscaling.

Downscaling uses whatever is installed (macOS `sips`, ImageMagick `magick`/`convert`);
without any of them images are copied unchanged.
"""
import hashlib
import os
import shutil
import struct
import subprocess

EXTS = ('.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif')


def size(path):
    """(width, height) for PNG, JPEG, GIF and WebP; None when unknown."""
    try:
        with open(path, 'rb') as f:
            head = f.read(32)
            if head.startswith(b'\x89PNG\r\n\x1a\n') and head[12:16] == b'IHDR':
                return struct.unpack('>II', head[16:24])
            if head[:6] in (b'GIF87a', b'GIF89a'):
                return struct.unpack('<HH', head[6:10])
            if head[:4] == b'RIFF' and head[8:12] == b'WEBP':
                kind = head[12:16]
                if kind == b'VP8 ':
                    w, h = struct.unpack('<HH', head[26:30])
                    return w & 0x3FFF, h & 0x3FFF
                if kind == b'VP8L':
                    b = head[21:25]
                    w = 1 + (((b[1] & 0x3F) << 8) | b[0])
                    h = 1 + (((b[3] & 0xF) << 10) | (b[2] << 2) | ((b[1] & 0xC0) >> 6))
                    return w, h
                if kind == b'VP8X':
                    w = 1 + int.from_bytes(head[24:27], 'little')
                    h = 1 + int.from_bytes(head[27:30], 'little')
                    return w, h
                return None
            if head[:2] == b'\xff\xd8':
                f.seek(2)
                while True:
                    m = f.read(2)
                    if len(m) < 2 or m[0] != 0xFF:
                        return None
                    marker = m[1]
                    if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                        continue
                    ln = struct.unpack('>H', f.read(2))[0]
                    if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                        f.read(1)
                        h, w = struct.unpack('>HH', f.read(4))
                        return w, h
                    f.seek(ln - 2, 1)
    except (OSError, struct.error):
        return None
    return None


def fingerprint(path):
    """Short content hash used for cache-busting (?v=...)."""
    h = hashlib.sha1()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 16), b''):
            h.update(chunk)
    return h.hexdigest()[:10]


def resizer():
    """Name of an available resize tool, or None."""
    for tool in ('sips', 'magick', 'convert'):
        if shutil.which(tool):
            return tool
    return None


def _resize(tool, src, dst, max_width):
    if tool == 'sips':
        cmd = ['sips', '--resampleWidth', str(max_width), src, '--out', dst]
    elif tool == 'magick':
        cmd = ['magick', src, '-resize', f'{max_width}x>', dst]
    else:
        cmd = ['convert', src, '-resize', f'{max_width}x>', dst]
    r = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return r.returncode == 0 and os.path.isfile(dst)


def publish(src, dst, max_width=None, tool=None):
    """Copy src to dst (downscaled to max_width when possible). Skips unchanged files.
    Returns 'copied', 'resized' or 'kept'."""
    # Copies carry the source's mtime (copy2, and utime after resizing), so "unchanged" means the exact same mtime.
    # A newer *or older* source (a replaced capture, a restored file) is published again.
    src_ns = os.stat(src).st_mtime_ns
    if os.path.isfile(dst) and os.stat(dst).st_mtime_ns == src_ns:
        return 'kept'
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if max_width and tool and os.path.splitext(src)[1].lower() in ('.png', '.jpg', '.jpeg'):
        dim = size(src)
        if dim and dim[0] > max_width:
            tmp = dst + '.tmp' + os.path.splitext(dst)[1]
            if _resize(tool, src, tmp, max_width):
                os.utime(tmp, ns=(src_ns, src_ns))
                os.replace(tmp, dst)
                return 'resized'
            if os.path.exists(tmp):
                os.remove(tmp)
    shutil.copy2(src, dst)
    return 'copied'
