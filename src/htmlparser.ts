/**
 * A port of Python 3.9's html.parser.HTMLParser (convert_charrefs=True), the parts of _markupbase.ParserBase it
 * uses, and html.escape / html.unescape. Regexes keep Python's semantics: Unicode \s, re.match anchoring (sticky),
 * re.search from a position (global + lastIndex), and Python's re.IGNORECASE folding.
 * Indices are UTF-16 offsets; the only place where Python's code-point counting changes behaviour (the 34
 * characters looked back for a cut charref) is converted explicitly.
 */
import { HTML5, INVALID_CHARREFS, INVALID_CODEPOINTS } from './entities.js';
import { RE_S, WS, strip } from './py.js';

// ---------------------------------------------------------------- html.escape / html.unescape
export function escape(s: string, quote = true): string {
  s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (quote) s = s.replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
  return s;
}

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function replaceCharref(_m: string, s: string): string {
  if (s[0] === '#') {
    let num: number;
    if (s[1] === 'x' || s[1] === 'X') num = parseInt(s.slice(2).replace(/;+$/, ''), 16);
    else num = parseInt(s.slice(1).replace(/;+$/, ''), 10);
    if (hasOwn(INVALID_CHARREFS, String(num))) return INVALID_CHARREFS[num];
    if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) return '�';
    if (INVALID_CODEPOINTS.has(num)) return '';
    return String.fromCodePoint(num);
  }
  if (hasOwn(HTML5, s)) return HTML5[s];
  // find the longest matching name (as defined by the standard); names are ASCII, so UTF-16 slicing is safe
  for (let x = s.length - 1; x > 1; x--) {
    const p = s.slice(0, x);
    if (hasOwn(HTML5, p)) return HTML5[p] + s.slice(x);
  }
  return '&' + s;
}

const CHARREF = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/gu;

export function unescape(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(CHARREF, replaceCharref);
}

// ---------------------------------------------------------------- regexes (html.parser, _markupbase)
const NOT_WS = (extra: string) => `[^${extra}${WS}]`;

const interestingNormal = /[&<]/gu;
const incomplete = /&[a-zA-Z#]/uy;
const entityref = /&([a-zA-Z][-.a-zA-Z0-9]*)[^a-zA-Z0-9]/uy;
const charref = /&#(?:[0-9]+|[xX][0-9a-fA-F]+)[^0-9a-fA-F]/uy;
const starttagopen = /<[a-zA-Z]/uy;
const piclose = />/gu;
const tagfindTolerant = new RegExp(`([a-zA-Z][^\\t\\n\\r\\f />\\x00]*)(?:${RE_S}|/(?!>))*`, 'uy');
const attrfindTolerant = new RegExp(
  `((?<=['"${WS}/])${NOT_WS('/>')}${NOT_WS('/=>')}*)(${RE_S}*=+${RE_S}*`
  + `('[^']*'|"[^"]*"|(?!['"])${NOT_WS('>')}*))?(?:${RE_S}|/(?!>))*`, 'uy');
const locatestarttagendTolerant = new RegExp(
  `<[a-zA-Z][^\\t\\n\\r\\f />\\x00]*`
  + `(?:[${WS}/]*`
  + `(?:(?<=['"${WS}/])${NOT_WS('/>')}${NOT_WS('/=>')}*`
  + `(?:${RE_S}*=+${RE_S}*`
  + `(?:'[^']*'|"[^"]*"|(?!['"])${NOT_WS('>')}*)`
  + `${RE_S}*`
  + `)?(?:${RE_S}|/(?!>))*`
  + `)*`
  + `)?`
  + `${RE_S}*`, 'uy');
const endendtag = />/gu;
const endtagfind = new RegExp(`</${RE_S}*([a-zA-Z][-.a-zA-Z0-9:_]*)${RE_S}*>`, 'uy');
const declnameMatch = new RegExp(`[a-zA-Z][-_.a-zA-Z0-9]*${RE_S}*`, 'uy');
const commentclose = new RegExp(`--${RE_S}*>`, 'gu');
const markedsectionclose = new RegExp(`\\]${RE_S}*\\]${RE_S}*>`, 'gu');
const msmarkedsectionclose = new RegExp(`\\]${RE_S}*>`, 'gu');
const wsOrSemicolon = new RegExp(`[${WS};]`, 'u');

/** re.match(pattern, s, pos): anchored at pos. The pattern must be sticky. */
function matchAt(re: RegExp, s: string, pos: number): RegExpExecArray | null {
  re.lastIndex = pos;
  return re.exec(s);
}

/** pattern.search(s, pos). The pattern must be global. */
function searchFrom(re: RegExp, s: string, pos: number): RegExpExecArray | null {
  re.lastIndex = pos;
  return re.exec(s);
}

/** Python's re.IGNORECASE also matches U+0130 and U+0131 with "i", which JavaScript's /iu does not. */
function ignoreCaseSource(word: string): string {
  return word.replace(/[iI]/g, '[i\\u0130\\u0131]');
}

/** Index (UTF-16) of the code point `count` code points before the end of s, or -1 if s is shorter. */
function backFromEnd(s: string, count: number): number {
  let k = s.length;
  for (let c = 0; c < count; c++) {
    if (k <= 0) return -1;
    k--;
    if (k > 0 && /[\udc00-\udfff]/.test(s[k]) && /[\ud800-\udbff]/.test(s[k - 1])) k--;
  }
  return k;
}

/** Raised where Python's _markupbase.ParserBase.error() raises NotImplementedError. */
export class NotImplementedError extends Error {
  constructor(message = 'subclasses of ParserBase must override error()') {
    super(message);
    this.name = 'NotImplementedError';
  }
}

export type Attr = [string, string | null];

export class HTMLParser {
  static CDATA_CONTENT_ELEMENTS = ['script', 'style'];

  protected rawdata = '';
  protected lasttag = '???';
  protected interesting: RegExp = interestingNormal;
  protected cdataElem: string | null = null;
  protected lineno = 1;
  protected offset = 0;
  private starttagText: string | null = null;
  readonly convertCharrefs = true;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.rawdata = '';
    this.lasttag = '???';
    this.interesting = interestingNormal;
    this.cdataElem = null;
    this.lineno = 1;
    this.offset = 0;
  }

  feed(data: string): void {
    this.rawdata = this.rawdata + data;
    this.goahead(false);
  }

  close(): void {
    this.goahead(true);
  }

  getpos(): [number, number] {
    return [this.lineno, this.offset];
  }

  get_starttag_text(): string | null {
    return this.starttagText;
  }

  protected updatepos(i: number, j: number): number {
    if (i >= j) return j;
    const chunk = this.rawdata.slice(i, j);
    const nlines = chunk.split('\n').length - 1;
    if (nlines) {
      this.lineno += nlines;
      this.offset = j - (i + chunk.lastIndexOf('\n') + 1);
    } else {
      this.offset += j - i;
    }
    return j;
  }

  protected error(_message: string): never {
    throw new NotImplementedError();
  }

  set_cdata_mode(elem: string): void {
    this.cdataElem = elem.toLowerCase();
    this.interesting = new RegExp(`</${RE_S}*${ignoreCaseSource(this.cdataElem)}${RE_S}*>`, 'giu');
  }

  clear_cdata_mode(): void {
    this.interesting = interestingNormal;
    this.cdataElem = null;
  }

  private data(s: string): void {
    this.handle_data(this.convertCharrefs && !this.cdataElem ? unescape(s) : s);
  }

  protected goahead(end: boolean): void {
    const rawdata = this.rawdata;
    let i = 0;
    const n = rawdata.length;
    while (i < n) {
      let j: number;
      if (this.convertCharrefs && !this.cdataElem) {
        j = rawdata.indexOf('<', i);
        if (j < 0) {
          const back = backFromEnd(rawdata, 34);
          const start = Math.max(i, back);
          const amppos = rawdata.lastIndexOf('&');
          if (amppos >= start && !wsOrSemicolon.test(rawdata.slice(amppos))) break;
          j = n;
        }
      } else {
        const match = searchFrom(this.interesting, rawdata, i);
        if (match) j = match.index;
        else {
          if (this.cdataElem) break;
          j = n;
        }
      }
      if (i < j) this.data(rawdata.slice(i, j));
      i = this.updatepos(i, j);
      if (i === n) break;
      if (rawdata.startsWith('<', i)) {
        let k: number;
        if (matchAt(starttagopen, rawdata, i)) k = this.parse_starttag(i);
        else if (rawdata.startsWith('</', i)) k = this.parse_endtag(i);
        else if (rawdata.startsWith('<!--', i)) k = this.parse_comment(i);
        else if (rawdata.startsWith('<?', i)) k = this.parse_pi(i);
        else if (rawdata.startsWith('<!', i)) k = this.parse_html_declaration(i);
        else if (i + 1 < n) {
          this.handle_data('<');
          k = i + 1;
        } else break;
        if (k < 0) {
          if (!end) break;
          k = rawdata.indexOf('>', i + 1);
          if (k < 0) {
            k = rawdata.indexOf('<', i + 1);
            if (k < 0) k = i + 1;
          } else k += 1;
          this.data(rawdata.slice(i, k));
        }
        i = this.updatepos(i, k);
      } else if (rawdata.startsWith('&#', i)) {
        const match = matchAt(charref, rawdata, i);
        if (match) {
          this.handle_charref(match[0].slice(2, -1));
          let k = i + match[0].length;
          if (!rawdata.startsWith(';', k - 1)) k = k - 1;
          i = this.updatepos(i, k);
          continue;
        } else {
          if (rawdata.slice(i).includes(';')) {
            this.handle_data(rawdata.slice(i, i + 2));
            i = this.updatepos(i, i + 2);
          }
          break;
        }
      } else if (rawdata.startsWith('&', i)) {
        let match = matchAt(entityref, rawdata, i);
        if (match) {
          this.handle_entityref(match[1]);
          let k = i + match[0].length;
          if (!rawdata.startsWith(';', k - 1)) k = k - 1;
          i = this.updatepos(i, k);
          continue;
        }
        match = matchAt(incomplete, rawdata, i);
        if (match) {
          if (end && match[0] === rawdata.slice(i)) {
            i = this.updatepos(i, i + 1);
          }
          break;
        } else if (i + 1 < n) {
          this.handle_data('&');
          i = this.updatepos(i, i + 1);
        } else break;
      } else {
        throw new Error('interesting.search() lied');
      }
    }
    if (end && i < n && !this.cdataElem) {
      this.data(rawdata.slice(i, n));
      i = this.updatepos(i, n);
    }
    this.rawdata = rawdata.slice(i);
  }

  protected parse_html_declaration(i: number): number {
    const rawdata = this.rawdata;
    if (rawdata.slice(i, i + 4) === '<!--') return this.parse_comment(i);
    if (rawdata.slice(i, i + 3) === '<![') return this.parse_marked_section(i);
    if (rawdata.slice(i, i + 9).toLowerCase() === '<!doctype') {
      const gtpos = rawdata.indexOf('>', i + 9);
      if (gtpos === -1) return -1;
      this.handle_decl(rawdata.slice(i + 2, gtpos));
      return gtpos + 1;
    }
    return this.parse_bogus_comment(i);
  }

  protected parse_bogus_comment(i: number, report = true): number {
    const rawdata = this.rawdata;
    const pos = rawdata.indexOf('>', i + 2);
    if (pos === -1) return -1;
    if (report) this.handle_comment(rawdata.slice(i + 2, pos));
    return pos + 1;
  }

  protected parse_pi(i: number): number {
    const rawdata = this.rawdata;
    const match = searchFrom(piclose, rawdata, i + 2);
    if (!match) return -1;
    this.handle_pi(rawdata.slice(i + 2, match.index));
    return match.index + match[0].length;
  }

  protected parse_starttag(i: number): number {
    this.starttagText = null;
    const endpos = this.check_for_whole_start_tag(i);
    if (endpos < 0) return endpos;
    const rawdata = this.rawdata;
    this.starttagText = rawdata.slice(i, endpos);

    const attrs: Attr[] = [];
    const match = matchAt(tagfindTolerant, rawdata, i + 1);
    if (!match) throw new Error('unexpected call to parse_starttag()');
    let k = i + 1 + match[0].length;
    const tag = match[1].toLowerCase();
    this.lasttag = tag;
    while (k < endpos) {
      const m = matchAt(attrfindTolerant, rawdata, k);
      if (!m) break;
      const attrname = m[1];
      const rest = m[2];
      let attrvalue: string | null = m[3] === undefined ? null : m[3];
      if (!rest) attrvalue = null;
      else if (attrvalue !== null && ((attrvalue.slice(0, 1) === "'" && attrvalue.slice(-1) === "'")
        || (attrvalue.slice(0, 1) === '"' && attrvalue.slice(-1) === '"'))) {
        attrvalue = attrvalue.slice(1, -1);
      }
      if (attrvalue) attrvalue = unescape(attrvalue);
      attrs.push([attrname.toLowerCase(), attrvalue]);
      k = m.index + m[0].length;
    }

    const endText = strip(rawdata.slice(k, endpos));
    if (endText !== '>' && endText !== '/>') {
      this.handle_data(rawdata.slice(i, endpos));
      return endpos;
    }
    if (endText.endsWith('/>')) {
      this.handle_startendtag(tag, attrs);
    } else {
      this.handle_starttag(tag, attrs);
      if (HTMLParser.CDATA_CONTENT_ELEMENTS.includes(tag)) this.set_cdata_mode(tag);
    }
    return endpos;
  }

  protected check_for_whole_start_tag(i: number): number {
    const rawdata = this.rawdata;
    const m = matchAt(locatestarttagendTolerant, rawdata, i);
    if (m) {
      const j = i + m[0].length;
      const next = rawdata.slice(j, j + 1);
      if (next === '>') return j + 1;
      if (next === '/') {
        if (rawdata.startsWith('/>', j)) return j + 2;
        if (rawdata.startsWith('/', j)) return -1;
        return j > i ? j : i + 1;
      }
      if (next === '') return -1;
      if ('abcdefghijklmnopqrstuvwxyz=/ABCDEFGHIJKLMNOPQRSTUVWXYZ'.includes(next)) return -1;
      return j > i ? j : i + 1;
    }
    throw new Error('we should not get here!');
  }

  protected parse_endtag(i: number): number {
    const rawdata = this.rawdata;
    let match = searchFrom(endendtag, rawdata, i + 1);
    if (!match) return -1;
    let gtpos = match.index + match[0].length;
    match = matchAt(endtagfind, rawdata, i);
    if (!match) {
      if (this.cdataElem !== null) {
        this.handle_data(rawdata.slice(i, gtpos));
        return gtpos;
      }
      const namematch = matchAt(tagfindTolerant, rawdata, i + 2);
      if (!namematch) {
        if (rawdata.slice(i, i + 3) === '</>') return i + 3;
        return this.parse_bogus_comment(i);
      }
      const tagname = namematch[1].toLowerCase();
      gtpos = rawdata.indexOf('>', i + 2 + namematch[0].length);
      this.handle_endtag(tagname);
      return gtpos + 1;
    }
    const elem = match[1].toLowerCase();
    if (this.cdataElem !== null) {
      if (elem !== this.cdataElem) {
        this.handle_data(rawdata.slice(i, gtpos));
        return gtpos;
      }
    }
    this.handle_endtag(elem);
    this.clear_cdata_mode();
    return gtpos;
  }

  // ---------------------------------------------------------------- _markupbase.ParserBase
  protected parse_marked_section(i: number, report = true): number {
    const rawdata = this.rawdata;
    const [sectName, j] = this.scan_name(i + 3, i);
    if (j < 0) return j;
    let match: RegExpExecArray | null;
    if (['temp', 'cdata', 'ignore', 'include', 'rcdata'].includes(sectName!)) {
      match = searchFrom(markedsectionclose, rawdata, i + 3);
    } else if (['if', 'else', 'endif'].includes(sectName!)) {
      match = searchFrom(msmarkedsectionclose, rawdata, i + 3);
    } else {
      this.error('unknown status keyword in marked section');
    }
    if (!match) return -1;
    if (report) this.unknown_decl(rawdata.slice(i + 3, match.index));
    return match.index + match[0].length;
  }

  protected parse_comment(i: number, report = true): number {
    const rawdata = this.rawdata;
    if (rawdata.slice(i, i + 4) !== '<!--') this.error('unexpected call to parse_comment()');
    const match = searchFrom(commentclose, rawdata, i + 4);
    if (!match) return -1;
    if (report) this.handle_comment(rawdata.slice(i + 4, match.index));
    return match.index + match[0].length;
  }

  protected scan_name(i: number, declstartpos: number): [string | null, number] {
    const rawdata = this.rawdata;
    const n = rawdata.length;
    if (i === n) return [null, -1];
    const m = matchAt(declnameMatch, rawdata, i);
    if (m) {
      const s = m[0];
      const name = strip(s);
      if (i + s.length === n) return [null, -1];
      return [name.toLowerCase(), i + s.length];
    }
    this.updatepos(declstartpos, i);
    this.error('expected name token');
  }

  // ---------------------------------------------------------------- overridable handlers
  handle_startendtag(tag: string, attrs: Attr[]): void {
    this.handle_starttag(tag, attrs);
    this.handle_endtag(tag);
  }

  handle_starttag(_tag: string, _attrs: Attr[]): void {}
  handle_endtag(_tag: string): void {}
  handle_charref(_name: string): void {}
  handle_entityref(_name: string): void {}
  handle_data(_data: string): void {}
  handle_comment(_data: string): void {}
  handle_decl(_decl: string): void {}
  handle_pi(_data: string): void {}
  unknown_decl(_data: string): void {}
}
