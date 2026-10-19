"""review-kit clean: remove what a review leaves behind once it has been merged and built.

- the built site (only a folder that carries build.MARKER, so nothing else is ever deleted)
- pending/*.applied.json hand-off files that apply-pending has already merged
- with orphans=True, files under screenshots/ that review.json no longer references
"""
import os
import re
import shutil

from . import model
from .build import MARKER

KEEP = {'.gitkeep'}


def _referenced(data, base):
    """Absolute paths of every local file review.json points at (images and local links)."""
    refs = set()
    for _, img in model.iter_images(data):
        src = model.image_src(img)
        if src:
            refs.add(os.path.normpath(os.path.join(base, src)))
    links = list((data.get('project') or {}).get('links') or [])
    for fx in data.get('fixes') or []:
        links += fx.get('links') or []
    for link in links:
        href = link.get('href') or ''
        if href and not re.match(r'^[a-z][a-z0-9+.-]*:|^/|^#', href, re.I):
            refs.add(os.path.normpath(os.path.join(base, href)))
    return refs


def orphans(review_path):
    """Files under screenshots/ that nothing in review.json references."""
    base = model.base_dir(review_path)
    shots = os.path.join(base, 'screenshots')
    if not os.path.isdir(shots):
        return []
    refs = _referenced(model.load(review_path), base)
    out = []
    for root, _, files in os.walk(shots):
        for n in sorted(files):
            p = os.path.normpath(os.path.join(root, n))
            if n not in KEEP and p not in refs:
                out.append(p)
    return sorted(out)


def _remove_empty_dirs(top):
    for root, dirs, files in os.walk(top, topdown=False):
        if root != top and not os.listdir(root):
            os.rmdir(root)


def clean(review_path, out=None, site=True, applied=True, orphaned=False, dry_run=False):
    """Returns (removed, skipped): lists of human-readable lines. Nothing is touched when dry_run is set."""
    base = model.base_dir(review_path)
    removed, skipped = [], []

    if site:
        out = os.path.abspath(out or os.path.join(base, 'site'))
        if os.path.isdir(out):
            if os.path.exists(os.path.join(out, MARKER)):
                removed.append(os.path.relpath(out) + os.sep)
                if not dry_run:
                    shutil.rmtree(out)
            else:
                skipped.append(f'{os.path.relpath(out)}: not built by review-kit (no {MARKER}); left alone')

    if applied:
        pending = os.path.join(base, 'pending')
        if os.path.isdir(pending):
            for n in sorted(os.listdir(pending)):
                if n.endswith('.applied.json'):
                    p = os.path.join(pending, n)
                    removed.append(os.path.relpath(p))
                    if not dry_run:
                        os.remove(p)

    if orphaned:
        for p in orphans(review_path):
            removed.append(os.path.relpath(p))
            if not dry_run:
                os.remove(p)
        if not dry_run and os.path.isdir(os.path.join(base, 'screenshots')):
            _remove_empty_dirs(os.path.join(base, 'screenshots'))

    return removed, skipped
