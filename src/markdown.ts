/**
 * A small Markdown subset renderer (port of reviewkit/markdown.py).
 *
 * Blocks: paragraphs (single newlines become <br>), # headings, - / * / 1. lists,
 * > quotes, ``` fenced code, and sanitized HTML blocks.
 * Inline: `code`, **bold**, *em*, ~~strike~~, [text](url), <https://autolinks>, inline HTML tags.
 *
 * Inline HTML is restricted to formatting tags and safe links in both text modes.
 * A single paragraph renders without a <p> wrapper so short fields (notes, captions) stay compact.
 *
 * Regexes follow Python's semantics: Unicode \s \S \w \d, `.` matching everything but "\n", re.I folding.
 */
import { HTMLParser, escape, type Attr } from './htmlparser.js';
import { RE_D, RE_NS, RE_S, RE_W, lstrip, strip } from './py.js';
import { safeUrl } from './safety.js';

export const TAGS: Set<string> = new Set(('p br hr b strong i em s del code pre blockquote ul ol li h1 h2 h3 h4 h5 h6 '
  + 'div span section table thead tbody tfoot tr td th caption figure figcaption details summary a').split(' '));
const VOID = new Set(['br', 'hr']);

/** Characters for which Python 3.9's str.isdigit() is true (Unicode 13). */
const IS_DIGIT = /^[\u{30}-\u{39}\u{b2}-\u{b3}\u{b9}\u{660}-\u{669}\u{6f0}-\u{6f9}\u{7c0}-\u{7c9}\u{966}-\u{96f}\u{9e6}-\u{9ef}\u{a66}-\u{a6f}\u{ae6}-\u{aef}\u{b66}-\u{b6f}\u{be6}-\u{bef}\u{c66}-\u{c6f}\u{ce6}-\u{cef}\u{d66}-\u{d6f}\u{de6}-\u{def}\u{e50}-\u{e59}\u{ed0}-\u{ed9}\u{f20}-\u{f29}\u{1040}-\u{1049}\u{1090}-\u{1099}\u{1369}-\u{1371}\u{17e0}-\u{17e9}\u{1810}-\u{1819}\u{1946}-\u{194f}\u{19d0}-\u{19da}\u{1a80}-\u{1a89}\u{1a90}-\u{1a99}\u{1b50}-\u{1b59}\u{1bb0}-\u{1bb9}\u{1c40}-\u{1c49}\u{1c50}-\u{1c59}\u{2070}\u{2074}-\u{2079}\u{2080}-\u{2089}\u{2460}-\u{2468}\u{2474}-\u{247c}\u{2488}-\u{2490}\u{24ea}\u{24f5}-\u{24fd}\u{24ff}\u{2776}-\u{277e}\u{2780}-\u{2788}\u{278a}-\u{2792}\u{a620}-\u{a629}\u{a8d0}-\u{a8d9}\u{a900}-\u{a909}\u{a9d0}-\u{a9d9}\u{a9f0}-\u{a9f9}\u{aa50}-\u{aa59}\u{abf0}-\u{abf9}\u{ff10}-\u{ff19}\u{104a0}-\u{104a9}\u{10a40}-\u{10a43}\u{10d30}-\u{10d39}\u{10e60}-\u{10e68}\u{11052}-\u{1105a}\u{11066}-\u{1106f}\u{110f0}-\u{110f9}\u{11136}-\u{1113f}\u{111d0}-\u{111d9}\u{112f0}-\u{112f9}\u{11450}-\u{11459}\u{114d0}-\u{114d9}\u{11650}-\u{11659}\u{116c0}-\u{116c9}\u{11730}-\u{11739}\u{118e0}-\u{118e9}\u{11950}-\u{11959}\u{11c50}-\u{11c59}\u{11d50}-\u{11d59}\u{11da0}-\u{11da9}\u{16a60}-\u{16a69}\u{16b50}-\u{16b59}\u{1d7ce}-\u{1d7ff}\u{1e140}-\u{1e149}\u{1e2f0}-\u{1e2f9}\u{1e950}-\u{1e959}\u{1f100}-\u{1f10a}\u{1fbf0}-\u{1fbf9}]+$/u;

/** str.isdigit() */
function isdigit(s: string): boolean {
  return IS_DIGIT.test(s);
}

class Sanitizer extends HTMLParser {
  out: string[] = [];

  override handle_starttag(tag: string, attrs: Attr[]): void {
    if (!TAGS.has(tag)) return;
    const kept: [string, string][] = [];
    for (const [name, value] of attrs) {
      if (value === null) continue;
      if (name === 'class' || name === 'title'
        || ((tag === 'td' || tag === 'th') && (name === 'colspan' || name === 'rowspan') && isdigit(value))) {
        kept.push([name, value]);
      } else if (tag === 'a' && name === 'href') {
        kept.push([name, safeUrl(value)]);
      }
    }
    this.out.push('<' + tag + kept.map(([k, v]) => ' ' + k + '="' + escape(v, true) + '"').join('') + '>');
  }

  override handle_startendtag(tag: string, attrs: Attr[]): void {
    this.handle_starttag(tag, attrs);
    this.handle_endtag(tag);
  }

  override handle_endtag(tag: string): void {
    if (TAGS.has(tag) && !VOID.has(tag)) this.out.push('</' + tag + '>');
  }

  override handle_data(data: string): void {
    this.out.push(escape(data, false));
  }
}

export function sanitize(text: string): string {
  const parser = new Sanitizer();
  parser.feed(text);
  parser.close();
  return parser.out.join('');
}

const TAG_RE = new RegExp(`</?[A-Za-z][A-Za-z0-9-]*(?:${RE_S}[^<>]*)?/?>|<!--[\\s\\S]*?-->`, 'gu');
const ENTITY_RE = new RegExp(`&(?:#${RE_D}+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);`, 'gu');
// Python's re.I also folds U+0130 / U+0131 to "i"; \b is Unicode-aware (the tag name always ends in a word char).
const I = '[i\\u0130\\u0131]';
const BLOCK_HTML = new RegExp(`^${RE_S}*</?(d${I}v|table|thead|tbody|tr|td|th|ul|ol|l${I}|p|h[1-6]|pre|blockquote|f${I}gure|`
  + `f${I}gcapt${I}on|sect${I}on|deta${I}ls|summary|hr|${I}mg|br)(?!${RE_W})`, 'iu');
const LIST_RE = new RegExp(`^(${RE_S}*)([-*+]|${RE_D}+[.)])${RE_S}+([^\\n]*)$`, 'u');
const HEADING_RE = new RegExp(`^(#{1,6})${RE_S}+([^\\n]*)$`, 'u');
const QUOTE_PREFIX = new RegExp(`^${RE_S}*>${RE_S}?`, 'u');

const CODE_SPAN = /(`+)([^\n]+?)\1/gu;
const AUTOLINK = new RegExp(`<(https?://[^${RE_S.slice(1, -1)}<>]+)>`, 'gu');
const IMAGE = new RegExp(`!\\[([^\\]]*)\\]\\(([^)${RE_S.slice(1, -1)}]+)\\)`, 'gu');
const LINK = new RegExp(`\\[([^\\]]+)\\]\\(([^)${RE_S.slice(1, -1)}]+)\\)`, 'gu');
const BOLD = new RegExp(`\\*\\*(?=${RE_NS})([^\\n]+?)(?<=${RE_NS})\\*\\*`, 'gu');
const NOT_WS_STAR = `[^*${RE_S.slice(1, -1)}]`;
const EM = new RegExp(`(?<![${RE_W.slice(1, -1)}*])\\*(?=${NOT_WS_STAR})([^\\n]+?)(?<=${NOT_WS_STAR})\\*(?![${RE_W.slice(1, -1)}*])`, 'gu');
const STRIKE = new RegExp(`~~(?=${RE_NS})([^\\n]+?)(?<=${RE_NS})~~`, 'gu');
const PLACEHOLDER = new RegExp(`\\x00(${RE_D}+)\\x00`, 'gu');

/** Escape &, < and > except where they form an HTML tag or entity. */
function escapeText(s: string): string {
  const out: string[] = [];
  let pos = 0;
  for (const m of s.matchAll(TAG_RE)) {
    out.push(escapePlain(s.slice(pos, m.index)));
    out.push(m[0]);
    pos = m.index! + m[0].length;
  }
  out.push(escapePlain(s.slice(pos)));
  return out.join('');
}

function escapePlain(s: string): string {
  const parts: string[] = [];
  let pos = 0;
  for (const m of s.matchAll(ENTITY_RE)) {
    parts.push(escape(s.slice(pos, m.index), false));
    parts.push(m[0]);
    pos = m.index! + m[0].length;
  }
  parts.push(escape(s.slice(pos), false));
  return parts.join('');
}

function safeUrlAttr(u: string): string {
  return escape(safeUrl(u), true);
}

const ND = new RegExp(`^${RE_D}$`, 'u');

/** int() of a run of Unicode decimal digits (Nd digits come in contiguous runs of ten, starting at zero). */
function digitsValue(s: string): number {
  let n = 0;
  for (const ch of s) {
    let cp = ch.codePointAt(0)!;
    let d = 0;
    while (ND.test(String.fromCodePoint(cp - 1))) {
      cp--;
      d++;
    }
    n = n * 10 + (d % 10);
  }
  return n;
}

export function inline(text: string): string {
  if (!text) return '';
  text = text.replace(/\x00/g, '');
  const stash: string[] = [];
  const keep = (h: string) => {
    stash.push(h);
    return `\x00${stash.length - 1}\x00`;
  };

  let s = text.replace(CODE_SPAN, (_m, _t: string, code: string) => keep('<code>' + escape(strip(code), false) + '</code>'));
  s = s.replace(AUTOLINK, (_m, u: string) => keep(`<a href="${safeUrlAttr(u)}">${escape(u)}</a>`));
  s = s.replace(IMAGE, (_m, alt: string, src: string) => keep(`<img src="${safeUrlAttr(src)}" alt="${escape(alt)}">`));
  s = s.replace(LINK, (_m, label: string, href: string) => keep(`<a href="${safeUrlAttr(href)}">`) + label + keep('</a>'));
  s = escapeText(s);
  s = s.replace(BOLD, '<b>$1</b>');
  s = s.replace(EM, '<em>$1</em>');
  s = s.replace(STRIKE, '<s>$1</s>');
  while (s.includes('\x00')) {
    s = s.replace(PLACEHOLDER, (_m, d: string) => {
      const v = stash[/^[0-9]+$/.test(d) ? Number(d) : digitsValue(d)];
      if (v === undefined) throw new RangeError('list index out of range');
      return v;
    });
  }
  return s;
}

type Block = string[] | { code: string[] };

function blocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out: Block[] = [];
  let cur: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (strip(line).startsWith('```')) {
      if (cur.length) {
        out.push(cur);
        cur = [];
      }
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !strip(lines[i]).startsWith('```')) {
        code.push(lines[i]);
        i += 1;
      }
      out.push({ code });
      i += 1;
      continue;
    }
    if (!strip(line)) {
      if (cur.length) {
        out.push(cur);
        cur = [];
      }
    } else cur.push(line);
    i += 1;
  }
  if (cur.length) out.push(cur);
  return out;
}

function listHtml(lines: string[]): string {
  const items: [boolean, string][] = [];
  for (const l of lines) {
    const m = LIST_RE.exec(l);
    if (m) items.push([!'-*+'.includes(m[2][0]), m[3]]);
    else if (items.length) items[items.length - 1][1] += '\n' + strip(l);
  }
  const tag = items.length && items[0][0] ? 'ol' : 'ul';
  return `<${tag}>` + items.map(([, t]) => '<li>' + inline(t).replace(/\n/g, '<br>') + '</li>').join('') + `</${tag}>`;
}

function renderBlocks(text: string): string {
  if (!text) return '';
  const out: string[] = [];
  for (const b of blocks(text)) {
    if (!Array.isArray(b)) {
      out.push('<pre><code>' + escape(b.code.join('\n'), false) + '</code></pre>');
      continue;
    }
    const first = b[0];
    const h = HEADING_RE.exec(first);
    if (h && b.length === 1) {
      const level = Math.min(h[1].length + 2, 6);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
    } else if (b.every((l, k) => LIST_RE.test(l) || ((l.startsWith('  ') || l.startsWith('\t')) && k))) {
      out.push(listHtml(b));
    } else if (b.every((l) => lstrip(l).startsWith('>'))) {
      const inner = b.map((l) => l.replace(QUOTE_PREFIX, '')).join('\n');
      out.push('<blockquote>' + renderBlocks(inner) + '</blockquote>');
    } else if (BLOCK_HTML.test(first)) {
      out.push(b.join('\n'));
    } else {
      out.push('<p>' + b.map((l) => inline(l)).join('<br>') + '</p>');
    }
  }
  if (out.length === 1 && out[0].startsWith('<p>') && out[0].endsWith('</p>')) return out[0].slice(3, -4);
  return out.join('\n');
}

export function render(text: string): string {
  return sanitize(renderBlocks(text));
}

/** Render a rich-text field according to project.textFormat. */
export function toHtml(text: string, fmt: string): string {
  if (!text) return '';
  return fmt === 'html' ? sanitize(text) : render(text);
}
