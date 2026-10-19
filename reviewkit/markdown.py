"""A small Markdown subset renderer (stdlib only).

Blocks: paragraphs (single newlines become <br>), # headings, - / * / 1. lists,
> quotes, ``` fenced code, and sanitized HTML blocks.
Inline: `code`, **bold**, *em*, ~~strike~~, [text](url), <https://autolinks>, inline HTML tags.

Inline HTML is restricted to formatting tags and safe links in both text modes.
A single paragraph renders without a <p> wrapper so short fields (notes, captions) stay compact.
"""
import html
import re
from html.parser import HTMLParser

from .safety import safe_url


class _Sanitizer(HTMLParser):
    TAGS = set('p br hr b strong i em s del code pre blockquote ul ol li h1 h2 h3 h4 h5 h6 '
               'div span section table thead tbody tfoot tr td th caption figure figcaption details summary a'.split())
    VOID = {'br', 'hr'}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []

    def handle_starttag(self, tag, attrs):
        if tag not in self.TAGS:
            return
        kept = []
        for name, value in attrs:
            if value is None:
                continue
            if name in ('class', 'title') or (tag in ('td', 'th') and name in ('colspan', 'rowspan') and value.isdigit()):
                kept.append((name, value))
            elif tag == 'a' and name == 'href':
                kept.append((name, safe_url(value)))
        self.out.append('<' + tag + ''.join(' ' + k + '="' + html.escape(v, quote=True) + '"' for k, v in kept) + '>')

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if tag in self.TAGS and tag not in self.VOID:
            self.out.append('</' + tag + '>')

    def handle_data(self, data):
        self.out.append(html.escape(data, quote=False))


def sanitize(text):
    parser = _Sanitizer()
    parser.feed(text)
    parser.close()
    return ''.join(parser.out)

_TAG = re.compile(r'</?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?/?>|<!--.*?-->', re.S)
_ENTITY = re.compile(r'&(?:#\d+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);')
_BLOCK_HTML = re.compile(r'^\s*</?(div|table|thead|tbody|tr|td|th|ul|ol|li|p|h[1-6]|pre|blockquote|figure|figcaption|section|details|summary|hr|img|br)\b', re.I)
_LIST = re.compile(r'^(\s*)([-*+]|\d+[.)])\s+(.*)$')


def _escape_text(s):
    """Escape &, < and > except where they form an HTML tag or entity."""
    out, pos = [], 0
    for m in _TAG.finditer(s):
        out.append(_escape_plain(s[pos:m.start()]))
        out.append(m.group(0))
        pos = m.end()
    out.append(_escape_plain(s[pos:]))
    return ''.join(out)


def _escape_plain(s):
    parts, pos = [], 0
    for m in _ENTITY.finditer(s):
        parts.append(html.escape(s[pos:m.start()], quote=False))
        parts.append(m.group(0))
        pos = m.end()
    parts.append(html.escape(s[pos:], quote=False))
    return ''.join(parts)


def _safe_url(u):
    return html.escape(safe_url(u), quote=True)


def inline(text):
    if not text:
        return ''
    text = text.replace('\x00', '')
    stash = []

    def keep(h):
        stash.append(h)
        return f'\x00{len(stash) - 1}\x00'

    s = re.sub(r'(`+)(.+?)\1', lambda m: keep('<code>' + html.escape(m.group(2).strip(), quote=False) + '</code>'), text)
    s = re.sub(r'<(https?://[^\s<>]+)>', lambda m: keep(f'<a href="{_safe_url(m.group(1))}">{html.escape(m.group(1))}</a>'), s)
    s = re.sub(r'!\[([^\]]*)\]\(([^)\s]+)\)', lambda m: keep(f'<img src="{_safe_url(m.group(2))}" alt="{html.escape(m.group(1))}">'), s)

    def link(m):
        return keep(f'<a href="{_safe_url(m.group(2))}">') + m.group(1) + keep('</a>')

    s = re.sub(r'\[([^\]]+)\]\(([^)\s]+)\)', link, s)
    s = _escape_text(s)
    s = re.sub(r'\*\*(?=\S)(.+?)(?<=\S)\*\*', r'<b>\1</b>', s)
    s = re.sub(r'(?<![\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])', r'<em>\1</em>', s)
    s = re.sub(r'~~(?=\S)(.+?)(?<=\S)~~', r'<s>\1</s>', s)
    while '\x00' in s:
        s = re.sub(r'\x00(\d+)\x00', lambda m: stash[int(m.group(1))], s)
    return s


def _blocks(text):
    lines = text.replace('\r\n', '\n').replace('\r', '\n').split('\n')
    blocks, cur, i = [], [], 0
    while i < len(lines):
        line = lines[i]
        if line.strip().startswith('```'):
            if cur:
                blocks.append(cur)
                cur = []
            code = []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith('```'):
                code.append(lines[i])
                i += 1
            blocks.append(('code', code))
            i += 1
            continue
        if not line.strip():
            if cur:
                blocks.append(cur)
                cur = []
        else:
            cur.append(line)
        i += 1
    if cur:
        blocks.append(cur)
    return blocks


def _list_html(lines):
    items = []  # (ordered, text)
    for l in lines:
        m = _LIST.match(l)
        if m:
            items.append([m.group(2)[0].isdigit(), m.group(3)])
        elif items:
            items[-1][1] += '\n' + l.strip()
    tag = 'ol' if items and items[0][0] else 'ul'
    return f'<{tag}>' + ''.join('<li>' + inline(t).replace('\n', '<br>') + '</li>' for _, t in items) + f'</{tag}>'


def _render(text):
    if not text:
        return ''
    out = []
    for b in _blocks(text):
        if isinstance(b, tuple):
            out.append('<pre><code>' + html.escape('\n'.join(b[1]), quote=False) + '</code></pre>')
            continue
        first = b[0]
        h = re.match(r'^(#{1,6})\s+(.*)$', first)
        if h and len(b) == 1:
            level = min(len(h.group(1)) + 2, 6)
            out.append(f'<h{level}>{inline(h.group(2))}</h{level}>')
        elif all(_LIST.match(l) or (l.startswith(('  ', '\t')) and k) for k, l in enumerate(b)):
            out.append(_list_html(b))
        elif all(l.lstrip().startswith('>') for l in b):
            inner = '\n'.join(re.sub(r'^\s*>\s?', '', l) for l in b)
            out.append('<blockquote>' + _render(inner) + '</blockquote>')
        elif _BLOCK_HTML.match(first):
            out.append('\n'.join(b))
        else:
            out.append('<p>' + '<br>'.join(inline(l) for l in b) + '</p>')
    if len(out) == 1 and out[0].startswith('<p>') and out[0].endswith('</p>'):
        return out[0][3:-4]
    return '\n'.join(out)


def render(text):
    return sanitize(_render(text))


def to_html(text, fmt):
    """Render a rich-text field according to project.textFormat."""
    if not text:
        return ''
    return sanitize(text) if fmt == 'html' else render(text)
