"""A tiny static server for the built site, with optional rebuild-on-change."""
import functools
import http.server
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time

from . import build as builder, safety
from .model import ReviewError


class _Handler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        try:
            requested = safety.request_path(self.path)
            root = os.path.realpath(self.directory)
            target = os.path.realpath(self.translate_path(self.path))
            rel = os.path.relpath(target, root)
            if (safety.private_path(requested) or safety.private_path(rel)
                    or '..' in requested.replace('\\', '/').split('/')
                    or os.path.commonpath((root, target)) != root):
                self.send_error(404)
                return None
            marker = os.path.join(root, builder.MARKER)
            if os.path.exists(marker):
                with open(marker, encoding='utf-8') as f:
                    manifest = json.load(f)
                requested_file = os.path.relpath(self.translate_path(self.path), os.path.abspath(self.directory))
                if os.path.isdir(target):
                    requested_file = os.path.join(requested_file, 'index.html')
                requested_file = os.path.normpath(requested_file).replace(os.sep, '/')
                if requested_file not in manifest['files']:
                    self.send_error(404)
                    return None
        except (ValueError, UnicodeError, OSError, KeyError, TypeError):
            self.send_error(404)
            return None
        return super().send_head()

    def list_directory(self, path):
        self.send_error(404)
        return None

    def end_headers(self):
        # Assets are cache-busted with ?v=..., but index.html and data.js must always be revalidated.
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; "
                         "style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'none'; "
                         "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
        super().end_headers()

    def log_message(self, fmt, *args):
        if os.environ.get('REVIEW_KIT_LOG'):
            super().log_message(fmt, *args)


def lan_addresses():
    """Best-effort list of IPv4 addresses other devices can reach (LAN, Tailscale, ...)."""
    found = []

    def add(ip):
        if ip and not ip.startswith('127.') and not ip.startswith('169.254.') and ip not in found:
            found.append(ip)

    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('192.0.2.1', 80))  # TEST-NET address: nothing is sent
        add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    for cmd in (['ifconfig'], ['ip', '-4', '-o', 'addr', 'show']):
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=3).stdout
        except (OSError, subprocess.SubprocessError):
            continue
        for ip in re.findall(r'inet (?:addr:)?(\d+\.\d+\.\d+\.\d+)', out):
            add(ip)
        if found:
            break
    return found


def _tailscale(ip):
    a, b = (int(x) for x in ip.split('.')[:2])
    return a == 100 and 64 <= b <= 127  # 100.64.0.0/10 (CGNAT range used by Tailscale)


def _watch(review_path, out, max_width, interval=1.0):
    def mtimes():
        base = os.path.dirname(os.path.abspath(review_path))
        stamp = [os.path.getmtime(review_path)]
        for sub in ('screenshots',):
            d = os.path.join(base, sub)
            if os.path.isdir(d):
                for dp, _, fs in os.walk(d):
                    stamp.extend(os.path.getmtime(os.path.join(dp, f)) for f in fs)
        return max(stamp)

    last = mtimes()
    while True:
        time.sleep(interval)
        try:
            now = mtimes()
        except OSError:
            continue
        if now != last:
            last = now
            try:
                builder.build(review_path, out, max_width=max_width, quiet=True)
                print(time.strftime('%H:%M:%S'), 'rebuilt', flush=True)
            except ReviewError as e:
                print(time.strftime('%H:%M:%S'), 'rebuild failed:', e, file=sys.stderr, flush=True)


def serve(directory, host='127.0.0.1', port=8787, review_path=None, watch=False, max_width=None):
    if not os.path.isfile(os.path.join(directory, 'index.html')):
        raise ReviewError(f'{directory}/index.html not found; run `review-kit build` first')
    marker = os.path.join(directory, builder.MARKER)
    if os.path.exists(marker):
        try:
            with open(marker, encoding='utf-8') as f:
                manifest = json.load(f)
            if not isinstance(manifest.get('files'), list):
                raise ValueError('missing file list')
        except (ValueError, OSError, AttributeError):
            raise ReviewError('old or invalid site manifest; run `review-kit build` again')
    handler = functools.partial(_Handler, directory=os.path.abspath(directory))
    try:
        httpd = http.server.ThreadingHTTPServer((host, port), handler)
    except OSError as e:
        raise ReviewError(f'cannot listen on {host}:{port}: {e.strerror or e}')
    port = httpd.server_address[1]
    if host not in ('127.0.0.1', 'localhost', '::1'):
        print('Network sharing enabled: anyone who can reach this port can read the review.', flush=True)
    print(f'Serving {os.path.abspath(directory)}', flush=True)
    print(f'  local:   http://localhost:{port}/', flush=True)
    if host in ('0.0.0.0', ''):
        ips = lan_addresses()
        tail = [ip for ip in ips[1:] if not _tailscale(ip)]
        if ips:
            print(f'  network: http://{ips[0]}:{port}/', flush=True)
        for ip in ips:
            if _tailscale(ip):
                print(f'  tailscale: http://{ip}:{port}/', flush=True)
        if tail:
            print('  also: ' + ', '.join(tail), flush=True)
    elif host not in ('127.0.0.1', 'localhost'):
        print(f'  network: http://{host}:{port}/', flush=True)
    if watch and review_path:
        threading.Thread(target=_watch, args=(review_path, directory, max_width), daemon=True).start()
        print(f'  watching {review_path} for changes', flush=True)
    print('Ctrl+C to stop.', flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
