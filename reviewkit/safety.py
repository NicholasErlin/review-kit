"""Publication boundaries shared by validation, building and serving."""
import os
import re
from urllib.parse import unquote, urlsplit

from .model import ReviewError

IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif'}
ATTACHMENT_EXTS = IMAGE_EXTS | {'.pdf', '.txt', '.md', '.csv', '.tsv', '.json', '.patch', '.diff'}
PRIVATE_NAMES = {'state.json', 'storage-state.json', 'storagestate.json', 'auth.json',
                 'cookies.json', 'credentials', 'credentials.json', 'secrets.json',
                 'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa'}


def private_path(path):
    parts = path.replace('\\', '/').split('/')
    return any((p.startswith('.') and p not in ('.', '..')) or p.lower() in PRIVATE_NAMES
               or p.lower().endswith(('.pem', '.key', '.p12', '.pfx', '.keystore'))
               for p in parts)


def safe_url(value):
    """Allow ordinary links, rejecting active schemes, credentials and obfuscated controls."""
    value = value.strip()
    if not value or re.search(r'[\x00-\x20\x7f\\]', value) or value.startswith('//'):
        return '#'
    try:
        url = urlsplit(value)
        if url.scheme and url.scheme.lower() not in ('http', 'https', 'mailto'):
            return '#'
        if url.scheme.lower() in ('http', 'https') and (not url.netloc or url.username or url.password):
            return '#'
    except ValueError:
        return '#'
    return value


def is_local_link(href):
    return not urlsplit(href).scheme and not href.startswith(('/', '#'))


def local_source(base, src, image=False):
    """Resolve a relative reference inside the review, including its symlink target."""
    base = os.path.realpath(base)
    target = os.path.realpath(os.path.join(base, src))
    if os.path.isabs(src) or os.path.commonpath((base, target)) != base:
        raise ReviewError('asset must stay inside the review folder; import external screenshots with add-issue/add-fix')
    rel = os.path.relpath(target, base)
    if private_path(src) or private_path(rel):
        raise ReviewError('private files cannot be published as assets')
    allowed = IMAGE_EXTS if image else ATTACHMENT_EXTS
    if os.path.splitext(target)[1].lower() not in allowed:
        raise ReviewError('unsupported asset type (use raster screenshots or document attachments)')
    return target


def request_path(path):
    """Decode the URL once, exactly as SimpleHTTPRequestHandler does."""
    return unquote(urlsplit(path).path, errors='surrogatepass')
