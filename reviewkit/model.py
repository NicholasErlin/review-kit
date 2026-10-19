"""Loading, saving and defaults for review.json."""
import json
import os
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA_PATH = os.path.join(ROOT, 'schema', 'review.schema.json')
SCHEMA_URL = 'https://raw.githubusercontent.com/NicholasErlin/review-kit/main/schema/review.schema.json'
SITE_SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'site')

DEFAULT_SEVERITIES = [
    {'id': 'P0', 'label': 'P0', 'color': '#c62828', 'description': 'Critical: broken flow, data loss or blocker'},
    {'id': 'P1', 'label': 'P1', 'color': '#e07b00', 'description': 'Major: clearly wrong or painful, has a workaround'},
    {'id': 'P2', 'label': 'P2', 'color': '#2f7d5b', 'description': 'Minor: polish and consistency'},
]
DEFAULT_PLATFORM = {'id': 'default', 'label': 'All', 'shape': 'auto'}
ISSUE_STATUSES = ('open', 'partial', 'fixed', 'notabug', 'wontfix')
PLAN_STATUSES = ('todo', 'doing', 'partial', 'done', 'dropped')
DEFAULT_ACCENT = '#12454f'


class ReviewError(Exception):
    """A user-facing error (bad input, missing file, failed validation)."""


def load(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        raise ReviewError(f'{path}: not found (create one with `review-kit init`)')
    except ValueError as e:
        raise ReviewError(f'{path}: invalid JSON: {e}')


def dumps(data):
    return json.dumps(data, indent=2, ensure_ascii=False) + '\n'


def save(path, data):
    """Atomic write so a crash never leaves a half-written review.json."""
    d = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(prefix='.review-', suffix='.json', dir=d)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(dumps(data))
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def load_schema():
    with open(SCHEMA_PATH, encoding='utf-8') as f:
        return json.load(f)


def platforms(data):
    return data.get('platforms') or [DEFAULT_PLATFORM]


def severities(data):
    return data.get('severities') or DEFAULT_SEVERITIES


def base_dir(review_path):
    return os.path.dirname(os.path.abspath(review_path))


def image_src(img):
    return img if isinstance(img, str) else img.get('src')


def iter_images(data):
    """Yield (where, image) for every screenshot reference in the document."""
    for a in data.get('areas') or []:
        for i, img in enumerate(a.get('screenshots') or []):
            yield f'areas[{a.get("id")}].screenshots[{i}]', img
    for it in data.get('issues') or []:
        for i, img in enumerate(it.get('screenshots') or []):
            yield f'issues[{it.get("id")}].screenshots[{i}]', img
    for fx in data.get('fixes') or []:
        for pid, p in (fx.get('platforms') or {}).items():
            for i, pair in enumerate(p.get('pairs') or []):
                for role in ('before', 'after'):
                    if pair.get(role):
                        yield f'fixes[{fx.get("id")}].platforms.{pid}.pairs[{i}].{role}', pair[role]
            for i, img in enumerate(p.get('images') or []):
                yield f'fixes[{fx.get("id")}].platforms.{pid}.images[{i}]', img
