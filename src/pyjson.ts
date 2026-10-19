/**
 * JSON with Python's `json` module behaviour: the same error messages and positions as json.loads (CPython's C
 * scanner), NaN/Infinity literals, and json.dumps output (indent=2 or compact separators, ensure_ascii=False).
 */
import { floatRepr, setKey } from './py.js';

export class JSONDecodeError extends Error {
  override name = 'JSONDecodeError';
  constructor(msg: string, doc: string, pos: number) {
    const before = doc.slice(0, pos);
    const cpPos = Array.from(before).length;
    const nl = before.lastIndexOf('\n');
    const lineno = before.split('\n').length;
    const colno = nl < 0 ? cpPos + 1 : Array.from(before.slice(nl + 1)).length + 1;
    super(`${msg}: line ${lineno} column ${colno} (char ${cpPos})`);
  }
}

class StopIteration {
  constructor(public idx: number) {}
}

const isWs = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

/** json.loads(s) */
export function loads(s: string): any {
  if (s.startsWith('﻿')) throw new JSONDecodeError('Unexpected UTF-8 BOM (decode using utf-8-sig)', s, 0);
  const len = s.length;
  const end = len - 1;

  const scanString = (start: number): [string, number] => {
    // start: index just after the opening quote
    const begin = start - 1;
    let out = '';
    let pos = start;
    for (;;) {
      let next = pos;
      let c = '';
      for (; next < len; next++) {
        c = s[next];
        if (c === '"' || c === '\\') break;
        if (c.charCodeAt(0) <= 0x1f) throw new JSONDecodeError('Invalid control character at', s, next);
      }
      if (next >= len) throw new JSONDecodeError('Unterminated string starting at', s, begin);
      out += s.slice(pos, next);
      next++;
      if (c === '"') return [out, next];
      if (next === len) throw new JSONDecodeError('Unterminated string starting at', s, begin);
      c = s[next];
      if (c !== 'u') {
        pos = next + 1;
        const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (!Object.prototype.hasOwnProperty.call(map, c)) throw new JSONDecodeError('Invalid \\escape', s, pos - 2);
        out += map[c];
      } else {
        next++;
        pos = next + 4;
        if (pos >= len) throw new JSONDecodeError('Invalid \\uXXXX escape', s, next - 1);
        const hex = s.slice(next, pos);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new JSONDecodeError('Invalid \\uXXXX escape', s, pos - 5);
        let code = parseInt(hex, 16);
        next = pos;
        if (code >= 0xd800 && code <= 0xdbff && pos + 6 < len && s[next] === '\\' && s[next + 1] === 'u') {
          const end2 = pos + 6;
          const hex2 = s.slice(next + 2, end2);
          if (!/^[0-9a-fA-F]{4}$/.test(hex2)) throw new JSONDecodeError('Invalid \\uXXXX escape', s, end2 - 5);
          const c2 = parseInt(hex2, 16);
          if (c2 >= 0xdc00 && c2 <= 0xdfff) {
            code = 0x10000 + ((code - 0xd800) << 10) + (c2 - 0xdc00);
            pos = end2;
          }
        }
        out += String.fromCodePoint(code);
      }
    }
  };

  const matchNumber = (start: number): [number, number] => {
    let idx = start;
    if (s[idx] === '-') {
      idx++;
      if (idx > end) throw new StopIteration(start);
    }
    if (s[idx] >= '1' && s[idx] <= '9') {
      idx++;
      while (idx <= end && isDigit(s[idx])) idx++;
    } else if (s[idx] === '0') idx++;
    else throw new StopIteration(start);
    if (idx < end && s[idx] === '.' && isDigit(s[idx + 1])) {
      idx += 2;
      while (idx <= end && isDigit(s[idx])) idx++;
    }
    if (idx < end && (s[idx] === 'e' || s[idx] === 'E')) {
      const eStart = idx;
      idx++;
      if (idx < end && (s[idx] === '-' || s[idx] === '+')) idx++;
      while (idx <= end && isDigit(s[idx])) idx++;
      if (!isDigit(s[idx - 1])) idx = eStart;
    }
    return [Number(s.slice(start, idx)), idx];
  };

  const skip = (idx: number) => {
    while (idx <= end && isWs(s[idx])) idx++;
    return idx;
  };

  const parseObject = (start: number): [Record<string, any>, number] => {
    const obj: Record<string, any> = {};
    let idx = skip(start);
    if (idx > end || s[idx] !== '}') {
      for (;;) {
        if (idx > end || s[idx] !== '"') throw new JSONDecodeError('Expecting property name enclosed in double quotes', s, idx);
        const [key, afterKey] = scanString(idx + 1);
        idx = skip(afterKey);
        if (idx > end || s[idx] !== ':') throw new JSONDecodeError("Expecting ':' delimiter", s, idx);
        idx = skip(idx + 1);
        const [val, next] = scanOnce(idx);
        setKey(obj, key, val);
        idx = skip(next);
        if (idx <= end && s[idx] === '}') break;
        if (idx > end || s[idx] !== ',') throw new JSONDecodeError("Expecting ',' delimiter", s, idx);
        idx = skip(idx + 1);
      }
    }
    return [obj, idx + 1];
  };

  const parseArray = (start: number): [any[], number] => {
    const arr: any[] = [];
    let idx = skip(start);
    if (idx > end || s[idx] !== ']') {
      for (;;) {
        const [val, next] = scanOnce(idx);
        arr.push(val);
        idx = skip(next);
        if (idx <= end && s[idx] === ']') break;
        if (idx > end || s[idx] !== ',') throw new JSONDecodeError("Expecting ',' delimiter", s, idx);
        idx = skip(idx + 1);
      }
    }
    return [arr, idx + 1];
  };

  const scanOnce = (idx: number): [any, number] => {
    if (idx >= len) throw new StopIteration(idx);
    switch (s[idx]) {
      case '"': return scanString(idx + 1);
      case '{': return parseObject(idx + 1);
      case '[': return parseArray(idx + 1);
      case 'n': if (idx + 3 < len && s.startsWith('null', idx)) return [null, idx + 4]; break;
      case 't': if (idx + 3 < len && s.startsWith('true', idx)) return [true, idx + 4]; break;
      case 'f': if (idx + 4 < len && s.startsWith('false', idx)) return [false, idx + 5]; break;
      case 'N': if (idx + 2 < len && s.startsWith('NaN', idx)) return [NaN, idx + 3]; break;
      case 'I': if (idx + 7 < len && s.startsWith('Infinity', idx)) return [Infinity, idx + 8]; break;
      case '-': if (idx + 8 < len && s.startsWith('-Infinity', idx)) return [-Infinity, idx + 9]; break;
    }
    return matchNumber(idx);
  };

  let idx = 0;
  while (idx < len && isWs(s[idx])) idx++;
  let obj: any;
  let next: number;
  try {
    [obj, next] = scanOnce(idx);
  } catch (e) {
    if (e instanceof StopIteration) throw new JSONDecodeError('Expecting value', s, e.idx);
    throw e;
  }
  while (next < len && isWs(s[next])) next++;
  if (next !== len) throw new JSONDecodeError('Extra data', s, next);
  return obj;
}

// ---------------------------------------------------------------- dumps
function encodeStr(s: string, ascii = false): string {
  return '"' + s.replace(ascii ? /[\x00-\x1f\\"\u007f-\uffff]/g : /[\x00-\x1f\\"]/g, (c) => {
    switch (c) {
      case '\\': return '\\\\';
      case '"': return '\\"';
      case '\n': return '\\n';
      case '\r': return '\\r';
      case '\t': return '\\t';
      case '\b': return '\\b';
      case '\f': return '\\f';
      default: return c.charCodeAt(0) === 0x7f ? c : '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
    }
  }) + '"';
}

function encodeNumber(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return 'Infinity';
  if (n === -Infinity) return '-Infinity';
  // JavaScript has one number type. Integral values print as Python ints, except huge ones (beyond 2**53 they can
  // only have come through float arithmetic or a float literal in practice), which print as Python floats.
  if (Number.isInteger(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER) return String(n);
  return floatRepr(n);
}

/** json.dumps(v, indent=indent, ensure_ascii=False); indent null gives the compact (',', ':') form. */
export function dumps(v: unknown, indent: number | null = 2, ensureAscii = false): string {
  const encodeString = (s: string) => encodeStr(s, ensureAscii);
  const enc = (x: unknown, level: number): string => {
    if (x === null || x === undefined) return 'null';
    if (x === true) return 'true';
    if (x === false) return 'false';
    if (typeof x === 'number') return encodeNumber(x);
    if (typeof x === 'string') return encodeString(x);
    if (Array.isArray(x)) {
      if (!x.length) return '[]';
      if (indent === null) return '[' + x.map((y) => enc(y, level)).join(',') + ']';
      const pad = '\n' + ' '.repeat(indent * (level + 1));
      return '[' + pad + x.map((y) => enc(y, level + 1)).join(',' + pad) + '\n' + ' '.repeat(indent * level) + ']';
    }
    if (typeof x === 'object') {
      const keys = Object.keys(x as object);
      if (!keys.length) return '{}';
      const o = x as Record<string, unknown>;
      if (indent === null) return '{' + keys.map((k) => encodeString(k) + ':' + enc(o[k], level)).join(',') + '}';
      const pad = '\n' + ' '.repeat(indent * (level + 1));
      return '{' + pad + keys.map((k) => encodeString(k) + ': ' + enc(o[k], level + 1)).join(',' + pad)
        + '\n' + ' '.repeat(indent * level) + '}';
    }
    throw new TypeError(`Object of type ${typeof x} is not JSON serializable`);
  };
  return enc(v, 0);
}
