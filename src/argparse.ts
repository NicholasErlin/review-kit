/**
 * A port of the subset of CPython 3.9's argparse that review-kit uses, so that parse results, error messages, usage
 * and help output are byte-identical to the Python version. The structure follows Lib/argparse.py closely
 * (_parse_known_args, consume_optional/consume_positionals, nargs regex patterns, HelpFormatter, textwrap.wrap).
 */
import path from 'node:path';
import { io } from './io.js';
import { RE_NS, RE_S, RE_W, pyLen, repr, reprStr, strip } from './py.js';

export const SUPPRESS = '==SUPPRESS==';
export const OPTIONAL = '?';
export const ZERO_OR_MORE = '*';
export const ONE_OR_MORE = '+';
const PARSER = 'A...';

export type Nargs = undefined | '?' | '*' | '+' | number;
type AnyNargs = Nargs | typeof PARSER;
export type Namespace = Record<string, any>;
export type TypeFunc = 'int' | ((s: string) => unknown);
export type ActionKind = 'store' | 'store_true' | 'store_false' | 'store_const' | 'append' | 'count' | 'version' | 'help';

export interface ArgumentOptions {
  dest?: string;
  action?: ActionKind;
  nargs?: Nargs;
  const?: unknown;
  default?: unknown;
  type?: TypeFunc;
  choices?: readonly unknown[];
  metavar?: string | readonly string[];
  help?: string;
  required?: boolean;
  version?: string;
}

export interface ParserOptions {
  prog?: string;
  usage?: string;
  description?: string;
  epilog?: string;
  addHelp?: boolean;
  allowAbbrev?: boolean;
}

export interface SubparsersOptions {
  dest?: string;
  metavar?: string;
  required?: boolean;
  help?: string;
  prog?: string;
}

export interface AddParserOptions {
  help?: string;
  usage?: string;
  description?: string;
  epilog?: string;
  prog?: string;
  aliases?: string[];
}

/** Thrown where Python's argparse would call sys.exit(status) (errors: 2, --help / --version: 0). */
export class ArgparseExit extends Error {
  status: number;
  constructor(status: number) {
    super(`argparse exit ${status}`);
    this.name = 'ArgparseExit';
    this.status = status;
  }
}

/** Python's int(str): surrounding whitespace, a sign, any Unicode decimal digits, single underscores between digits. */
export function pyInt(s: string): number {
  const t = strip(s);
  const m = /^([+-]?)(\p{Nd}+(?:_\p{Nd}+)*)$/u.exec(t);
  if (!m) throw new ValueError(`invalid literal for int() with base 10: ${reprStr(s)}`);
  let digits = '';
  for (const ch of m[2]) {
    if (ch === '_') continue;
    if (ch >= '0' && ch <= '9') {
      digits += ch;
      continue;
    }
    // Unicode Nd characters come in contiguous runs of ten starting at zero.
    let cp = ch.codePointAt(0)!;
    let n = 0;
    while (/\p{Nd}/u.test(String.fromCodePoint(cp - 1))) {
      cp--;
      n++;
    }
    digits += String(n % 10);
  }
  const v = Number(m[1] === '-' ? '-' + digits : digits);
  return v === 0 ? 0 : v;
}

class ValueError extends Error {}

class ArgumentTypeError extends Error {}

class ArgumentError extends Error {
  argumentName: string | null;
  constructor(argument: Action | null, message: string) {
    super(message);
    this.argumentName = getActionName(argument);
  }
  override toString(): string {
    return this.argumentName === null ? this.message : `argument ${this.argumentName}: ${this.message}`;
  }
}

export { ArgumentTypeError };

function getActionName(argument: Action | null): string | null {
  if (argument === null) return null;
  if (argument.optionStrings.length) return argument.optionStrings.join('/');
  if (argument.metavar !== null && argument.metavar !== SUPPRESS) return argument.metavar as string;
  if (argument.dest !== null && argument.dest !== SUPPRESS) return argument.dest;
  return null;
}

function cps(s: string): string[] {
  return Array.from(s);
}

// ---------------------------------------------------------------- actions
export class Action {
  optionStrings: string[];
  dest: string;
  nargs: AnyNargs | 0;
  const: unknown;
  default: unknown;
  type: TypeFunc | null;
  choices: readonly unknown[] | Map<string, ArgumentParser> | null;
  required: boolean;
  help: string | null;
  metavar: string | readonly string[] | null;
  kind: ActionKind | 'parsers' | 'choice';
  version: string | null = null;

  constructor(init: {
    optionStrings: string[];
    dest: string;
    kind: Action['kind'];
    nargs?: AnyNargs | 0;
    const?: unknown;
    default?: unknown;
    type?: TypeFunc | null;
    choices?: Action['choices'];
    required?: boolean;
    help?: string | null;
    metavar?: string | readonly string[] | null;
  }) {
    this.optionStrings = init.optionStrings;
    this.dest = init.dest;
    this.kind = init.kind;
    this.nargs = init.nargs;
    this.const = init.const === undefined ? null : init.const;
    this.default = init.default === undefined ? null : init.default;
    this.type = init.type ?? null;
    this.choices = init.choices ?? null;
    this.required = init.required ?? false;
    this.help = init.help === undefined ? null : init.help;
    this.metavar = init.metavar === undefined ? null : init.metavar;
  }

  formatUsage(): string {
    return this.optionStrings[0];
  }

  subactions(): Action[] | null {
    return null;
  }

  call(parser: ArgumentParser, namespace: Namespace, values: any, _optionString: string | null): void {
    switch (this.kind) {
      case 'store':
        namespace[this.dest] = values;
        return;
      case 'store_const':
      case 'store_true':
      case 'store_false':
        namespace[this.dest] = this.const;
        return;
      case 'append': {
        const items = namespace[this.dest];
        const copy = items === null || items === undefined ? [] : Array.isArray(items) ? items.slice() : [items];
        copy.push(values);
        namespace[this.dest] = copy;
        return;
      }
      case 'count': {
        const count = namespace[this.dest];
        namespace[this.dest] = (count === null || count === undefined ? 0 : count) + 1;
        return;
      }
      case 'help':
        parser.printHelp();
        parser.exit();
        return;
      case 'version': {
        const formatter = parser.getFormatter();
        formatter.addText(this.version);
        parser.printMessage(formatter.formatHelp(), 'stdout');
        parser.exit();
        return;
      }
      default:
        throw new Error(`.__call__() not defined`);
    }
  }
}

export class SubParsersAction extends Action {
  private progPrefix: string;
  private nameParserMap: Map<string, ArgumentParser>;
  private choicesActions: Action[] = [];

  constructor(prog: string, opts: SubparsersOptions) {
    const map = new Map<string, ArgumentParser>();
    super({
      optionStrings: [],
      dest: opts.dest ?? SUPPRESS,
      kind: 'parsers',
      nargs: PARSER,
      choices: map,
      required: opts.required ?? false,
      help: opts.help,
      metavar: opts.metavar,
    });
    this.progPrefix = prog;
    this.nameParserMap = map;
  }

  addParser(name: string, opts: AddParserOptions = {}): ArgumentParser {
    const prog = opts.prog ?? `${this.progPrefix} ${name}`;
    const aliases = opts.aliases ?? [];
    if ('help' in opts) {
      let metavar = name;
      if (aliases.length) metavar += ` (${aliases.join(', ')})`;
      this.choicesActions.push(
        new Action({ optionStrings: [], dest: name, kind: 'choice', help: opts.help, metavar }),
      );
    }
    const parser = new ArgumentParser({
      prog,
      usage: opts.usage,
      description: opts.description,
      epilog: opts.epilog,
    });
    this.nameParserMap.set(name, parser);
    for (const alias of aliases) this.nameParserMap.set(alias, parser);
    return parser;
  }

  /** Python's add_parser spelling. */
  add_parser(name: string, opts: AddParserOptions = {}): ArgumentParser {
    return this.addParser(name, opts);
  }

  override subactions(): Action[] {
    return this.choicesActions;
  }

  override call(_parser: ArgumentParser, namespace: Namespace, values: string[]): void {
    const parserName = values[0];
    const argStrings = values.slice(1);
    if (this.dest !== SUPPRESS) namespace[this.dest] = parserName;
    const parser = this.nameParserMap.get(parserName);
    if (parser === undefined) {
      const choices = Array.from(this.nameParserMap.keys()).join(', ');
      throw new ArgumentError(this, `unknown parser ${reprStr(parserName)} (choices: ${choices})`);
    }
    const [subnamespace, rest] = parser.parseKnownArgs(argStrings);
    for (const [key, value] of Object.entries(subnamespace)) namespace[key] = value;
    if (rest.length) {
      if (!(UNRECOGNIZED in namespace)) namespace[UNRECOGNIZED] = [];
      namespace[UNRECOGNIZED].push(...rest);
    }
  }
}

const UNRECOGNIZED = '_unrecognized_args';

// ---------------------------------------------------------------- textwrap
const TW_WS = '[\\t\\n\\x0b\\x0c\\r ]';
const TW_NWS = '[^\\t\\n\\x0b\\x0c\\r ]';
const TW_WP = `(?:${RE_W}|[!"'&.,?])`;
const TW_LT = `(?:(?!\\p{Nd})${RE_W})`;
const WORDSEP_RE = new RegExp(
  `(${TW_WS}+` +
    `|(?<=${TW_WP})-{2,}(?=${RE_W})` +
    `|${TW_NWS}+?(?:` +
    `-(?:(?<=${TW_LT}{2}-)|(?<=${TW_LT}-${TW_LT}-))(?=${TW_LT}-?${TW_LT})` +
    `|(?=${TW_WS}|$)` +
    `|(?<=${TW_WP})(?=-{2,}${RE_W})` +
    `))`,
  'u',
);

/** textwrap.wrap(text, width, initial_indent=..., subsequent_indent=...) with the default options. */
export function textwrapWrap(text: string, width: number, initialIndent = '', subsequentIndent = ''): string[] {
  // _munge_whitespace: expandtabs(8), then each ASCII whitespace char -> ' '
  let expanded = '';
  let col = 0;
  for (const ch of text) {
    if (ch === '\t') {
      const n = 8 - (col % 8);
      expanded += ' '.repeat(n);
      col += n;
    } else {
      expanded += ch;
      col = ch === '\n' || ch === '\r' ? 0 : col + 1;
    }
  }
  const munged = expanded.replace(/[\t\n\x0b\x0c\r]/g, ' ');
  const chunks = munged.split(WORDSEP_RE).filter((c) => c);
  return wrapChunks(chunks, width, initialIndent, subsequentIndent);
}

function wrapChunks(chunks: string[], fullWidth: number, initialIndent: string, subsequentIndent: string): string[] {
  const lines: string[] = [];
  if (fullWidth <= 0) throw new ValueError(`invalid width ${fullWidth} (must be > 0)`);
  chunks = chunks.slice().reverse();
  const isBlank = (s: string) => strip(s) === '';
  while (chunks.length) {
    let curLine: string[] = [];
    let curLen = 0;
    const indent = lines.length ? subsequentIndent : initialIndent;
    const width = fullWidth - pyLen(indent);
    if (isBlank(chunks[chunks.length - 1]) && lines.length) chunks.pop();
    while (chunks.length) {
      const l = pyLen(chunks[chunks.length - 1]);
      if (curLen + l <= width) {
        curLine.push(chunks.pop()!);
        curLen += l;
      } else break;
    }
    if (chunks.length && pyLen(chunks[chunks.length - 1]) > width) {
      // _handle_long_word with break_long_words=True
      const spaceLeft = width < 1 ? 1 : width - curLen;
      const last = cps(chunks[chunks.length - 1]);
      curLine.push(last.slice(0, spaceLeft).join(''));
      chunks[chunks.length - 1] = last.slice(spaceLeft).join('');
      curLen = curLine.reduce((n, c) => n + pyLen(c), 0);
    }
    if (curLine.length && isBlank(curLine[curLine.length - 1])) {
      curLen -= pyLen(curLine[curLine.length - 1]);
      curLine = curLine.slice(0, -1);
    }
    if (curLine.length) lines.push(indent + curLine.join(''));
  }
  return lines;
}

// ---------------------------------------------------------------- help formatting
/** shutil.get_terminal_size().columns: $COLUMNS if a positive int, else the terminal, else 80. */
export function terminalColumns(): number {
  let columns = 0;
  const env = process.env.COLUMNS;
  if (env !== undefined) {
    try {
      columns = pyInt(env);
    } catch {
      columns = 0;
    }
  }
  if (columns <= 0) {
    columns = process.stdout.isTTY && process.stdout.columns ? process.stdout.columns : 80;
  }
  return columns;
}

const SPACE_ASCII_RE = /[ \t\n\r\f\v]+/g;

function pad(n: number): string {
  return n > 0 ? ' '.repeat(n) : '';
}

/** Python's `help % params` for the %(name)s / %% forms. */
function percentFormat(text: string, params: Record<string, unknown>): string {
  return text.replace(/%(?:\(([^)]*)\)([sdr])|%)/g, (m, name: string | undefined, conv: string | undefined) => {
    if (m === '%%') return '%';
    if (!(name! in params)) throw new Error(`KeyError: ${reprStr(name!)}`);
    const v = params[name!];
    if (conv === 'r') return repr(v);
    if (conv === 'd') return String(Math.trunc(Number(v)));
    return typeof v === 'string' ? v : repr(v);
  });
}

class Section {
  items: Array<() => string> = [];
  constructor(
    private formatter: HelpFormatter,
    public parent: Section | null,
    private heading: string | null = null,
  ) {}

  formatHelp(): string {
    if (this.parent !== null) this.formatter.indent();
    const itemHelp = this.formatter.joinParts(this.items.map((f) => f()));
    if (this.parent !== null) this.formatter.dedent();
    if (!itemHelp) return '';
    let heading = '';
    if (this.heading !== SUPPRESS && this.heading !== null) {
      heading = `${pad(this.formatter.currentIndent)}${this.heading}:\n`;
    }
    return this.formatter.joinParts(['\n', heading, itemHelp, '\n']);
  }
}

export class HelpFormatter {
  private prog: string;
  private indentIncrement: number;
  private maxHelpPosition: number;
  private width: number;
  currentIndent = 0;
  private level = 0;
  private actionMaxLength = 0;
  private rootSection: Section;
  private currentSection: Section;

  constructor(prog: string, indentIncrement = 2, maxHelpPosition = 24, width?: number) {
    if (width === undefined) width = terminalColumns() - 2;
    this.prog = prog;
    this.indentIncrement = indentIncrement;
    this.maxHelpPosition = Math.min(maxHelpPosition, Math.max(width - 20, indentIncrement * 2));
    this.width = width;
    this.rootSection = new Section(this, null);
    this.currentSection = this.rootSection;
  }

  indent(): void {
    this.currentIndent += this.indentIncrement;
    this.level += 1;
  }

  dedent(): void {
    this.currentIndent -= this.indentIncrement;
    if (this.currentIndent < 0) throw new Error('Indent decreased below 0.');
    this.level -= 1;
  }

  private addItem(f: () => string): void {
    this.currentSection.items.push(f);
  }

  startSection(heading: string | null): void {
    this.indent();
    const section = new Section(this, this.currentSection, heading);
    this.addItem(() => section.formatHelp());
    this.currentSection = section;
  }

  endSection(): void {
    this.currentSection = this.currentSection.parent!;
    this.dedent();
  }

  addText(text: string | null | undefined): void {
    if (text !== SUPPRESS && text !== null && text !== undefined) this.addItem(() => this.formatText(text));
  }

  addUsage(usage: string | null | undefined, actions: Action[], prefix: string | null = null): void {
    if (usage !== SUPPRESS) this.addItem(() => this.formatUsageText(usage ?? null, actions, prefix));
  }

  addArgument(action: Action): void {
    if (action.help !== SUPPRESS) {
      const invocations = [this.formatActionInvocation(action)];
      const subs = action.subactions();
      if (subs) for (const sub of subs) invocations.push(this.formatActionInvocation(sub));
      const invocationLength = Math.max(...invocations.map(pyLen));
      const actionLength = invocationLength + this.currentIndent;
      this.actionMaxLength = Math.max(this.actionMaxLength, actionLength);
      this.addItem(() => this.formatAction(action));
    }
  }

  addArguments(actions: Action[]): void {
    for (const action of actions) this.addArgument(action);
  }

  formatHelp(): string {
    let help = this.rootSection.formatHelp();
    if (help) {
      help = help.replace(/\n\n\n+/g, '\n\n');
      help = strip(help, '\n') + '\n';
    }
    return help;
  }

  joinParts(parts: Array<string | null>): string {
    return parts.filter((p) => p && p !== SUPPRESS).join('');
  }

  private formatUsageText(usage: string | null, actions: Action[], prefix: string | null): string {
    if (prefix === null) prefix = 'usage: ';
    if (usage !== null) {
      usage = percentFormat(usage, { prog: this.prog });
    } else if (!actions.length) {
      usage = this.prog;
    } else {
      const prog = this.prog;
      const optionals: Action[] = [];
      const positionals: Action[] = [];
      for (const action of actions) (action.optionStrings.length ? optionals : positionals).push(action);
      const actionUsage = this.formatActionsUsage([...optionals, ...positionals]);
      usage = [prog, actionUsage].filter((s) => s).join(' ');

      const textWidth = this.width - this.currentIndent;
      if (pyLen(prefix) + pyLen(usage) > textWidth) {
        const partRegexp = new RegExp(
          `\\(.*?\\)+(?=${RE_S}|$)|\\[.*?\\]+(?=${RE_S}|$)|${RE_NS}+`,
          'gu',
        );
        const optUsage = this.formatActionsUsage(optionals);
        const posUsage = this.formatActionsUsage(positionals);
        const optParts = optUsage.match(partRegexp) ?? [];
        const posParts = posUsage.match(partRegexp) ?? [];
        if (optParts.join(' ') !== optUsage || posParts.join(' ') !== posUsage) throw new Error('AssertionError');

        const getLines = (parts: string[], indent: string, pfx: string | null = null): string[] => {
          const lines: string[] = [];
          let line: string[] = [];
          let lineLen = pfx !== null ? pyLen(pfx) - 1 : pyLen(indent) - 1;
          for (const part of parts) {
            if (lineLen + 1 + pyLen(part) > textWidth && line.length) {
              lines.push(indent + line.join(' '));
              line = [];
              lineLen = pyLen(indent) - 1;
            }
            line.push(part);
            lineLen += pyLen(part) + 1;
          }
          if (line.length) lines.push(indent + line.join(' '));
          if (pfx !== null) lines[0] = cps(lines[0]).slice(pyLen(indent)).join('');
          return lines;
        };

        let lines: string[];
        if (pyLen(prefix) + pyLen(prog) <= 0.75 * textWidth) {
          const indent = pad(pyLen(prefix) + pyLen(prog) + 1);
          if (optParts.length) {
            lines = getLines([prog, ...optParts], indent, prefix);
            lines.push(...getLines(posParts, indent));
          } else if (posParts.length) {
            lines = getLines([prog, ...posParts], indent, prefix);
          } else {
            lines = [prog];
          }
        } else {
          const indent = pad(pyLen(prefix));
          const parts = [...optParts, ...posParts];
          lines = getLines(parts, indent);
          if (lines.length > 1) {
            lines = [];
            lines.push(...getLines(optParts, indent));
            lines.push(...getLines(posParts, indent));
          }
          lines = [prog, ...lines];
        }
        usage = lines.join('\n');
      }
    }
    return `${prefix}${usage}\n\n`;
  }

  /** _format_actions_usage without mutually exclusive groups (review-kit has none). */
  formatActionsUsage(actions: Action[]): string {
    const parts: Array<string | null> = [];
    for (const action of actions) {
      if (action.help === SUPPRESS) {
        parts.push(null);
      } else if (!action.optionStrings.length) {
        parts.push(this.formatArgs(action, this.defaultMetavarForPositional(action)));
      } else {
        const optionString = action.optionStrings[0];
        let part: string;
        if (action.nargs === 0) {
          part = action.formatUsage();
        } else {
          const argsString = this.formatArgs(action, this.defaultMetavarForOptional(action));
          part = `${optionString} ${argsString}`;
        }
        if (!action.required) part = `[${part}]`;
        parts.push(part);
      }
    }
    let text = parts.filter((p) => p !== null).join(' ');
    text = text.replace(/([[(]) /g, '$1');
    text = text.replace(/ ([\])])/g, '$1');
    text = text.replace(/[[(] *[\])]/g, '');
    text = text.replace(/\(([^|]*)\)/g, '$1');
    return strip(text);
  }

  private formatText(text: string): string {
    if (text.includes('%(prog)')) text = percentFormat(text, { prog: this.prog });
    const textWidth = Math.max(this.width - this.currentIndent, 11);
    const indent = pad(this.currentIndent);
    return this.fillText(text, textWidth, indent) + '\n\n';
  }

  private formatAction(action: Action): string {
    const helpPosition = Math.min(this.actionMaxLength + 2, this.maxHelpPosition);
    const helpWidth = Math.max(this.width - helpPosition, 11);
    const actionWidth = helpPosition - this.currentIndent - 2;
    let actionHeader = this.formatActionInvocation(action);
    let indentFirst = 0;

    if (!action.help) {
      actionHeader = `${pad(this.currentIndent)}${actionHeader}\n`;
    } else if (pyLen(actionHeader) <= actionWidth) {
      actionHeader = `${pad(this.currentIndent)}${actionHeader}${pad(actionWidth - pyLen(actionHeader))}  `;
      indentFirst = 0;
    } else {
      actionHeader = `${pad(this.currentIndent)}${actionHeader}\n`;
      indentFirst = helpPosition;
    }

    const parts: string[] = [actionHeader];
    if (action.help) {
      const helpText = this.expandHelp(action);
      const helpLines = this.splitLines(helpText, helpWidth);
      // '%*s%s\n' % (indent_first, '', help_lines[0]) -- IndexError in Python if the help is blank
      if (!helpLines.length) throw new Error('IndexError: list index out of range');
      parts.push(`${pad(indentFirst)}${helpLines[0]}\n`);
      for (const line of helpLines.slice(1)) parts.push(`${pad(helpPosition)}${line}\n`);
    } else if (!actionHeader.endsWith('\n')) {
      parts.push('\n');
    }

    const subs = action.subactions();
    if (subs) {
      this.indent();
      for (const sub of subs) parts.push(this.formatAction(sub));
      this.dedent();
    }
    return this.joinParts(parts);
  }

  formatActionInvocation(action: Action): string {
    if (!action.optionStrings.length) {
      const [metavar] = this.metavarFormatter(action, this.defaultMetavarForPositional(action))(1);
      return metavar;
    }
    const parts: string[] = [];
    if (action.nargs === 0) {
      parts.push(...action.optionStrings);
    } else {
      const argsString = this.formatArgs(action, this.defaultMetavarForOptional(action));
      for (const optionString of action.optionStrings) parts.push(`${optionString} ${argsString}`);
    }
    return parts.join(', ');
  }

  private metavarFormatter(action: Action, defaultMetavar: string): (n: number) => readonly string[] {
    let result: string | readonly string[];
    if (action.metavar !== null) result = action.metavar;
    else if (action.choices !== null) {
      const keys = action.choices instanceof Map ? Array.from(action.choices.keys()) : action.choices;
      result = `{${keys.map((c) => (typeof c === 'string' ? c : repr(c))).join(',')}}`;
    } else result = defaultMetavar;
    return (size: number) => (typeof result === 'string' ? Array(size).fill(result) : result);
  }

  formatArgs(action: Action, defaultMetavar: string): string {
    const getMetavar = this.metavarFormatter(action, defaultMetavar);
    const nargs = action.nargs;
    if (nargs === undefined || nargs === null) return `${getMetavar(1)[0]}`;
    if (nargs === OPTIONAL) return `[${getMetavar(1)[0]}]`;
    if (nargs === ZERO_OR_MORE) {
      const metavar = getMetavar(1);
      return metavar.length === 2 ? `[${metavar[0]} [${metavar[1]} ...]]` : `[${metavar[0]} ...]`;
    }
    if (nargs === ONE_OR_MORE) {
      const m = getMetavar(2);
      return `${m[0]} [${m[1]} ...]`;
    }
    if (nargs === PARSER) return `${getMetavar(1)[0]} ...`;
    if (typeof nargs === 'number') {
      const m = getMetavar(nargs);
      if (m.length !== nargs) throw new Error('length of metavar tuple does not match nargs');
      return m.slice(0, nargs).join(' ');
    }
    throw new Error('invalid nargs value');
  }

  private expandHelp(action: Action): string {
    const params: Record<string, unknown> = {
      option_strings: action.optionStrings,
      dest: action.dest,
      nargs: action.nargs,
      const: action.const,
      default: action.default,
      type: action.type === 'int' ? 'int' : action.type,
      choices: action.choices,
      required: action.required,
      help: action.help,
      metavar: action.metavar,
      prog: this.prog,
    };
    for (const name of Object.keys(params)) if (params[name] === SUPPRESS) delete params[name];
    if (params.choices !== null && params.choices !== undefined) {
      const c = params.choices as Action['choices'];
      const keys = c instanceof Map ? Array.from(c.keys()) : (c as unknown[]);
      params.choices = keys.map((x) => (typeof x === 'string' ? x : repr(x))).join(', ');
    }
    return percentFormat(action.help!, params);
  }

  private splitLines(text: string, width: number): string[] {
    text = strip(text.replace(SPACE_ASCII_RE, ' '));
    return textwrapWrap(text, width);
  }

  private fillText(text: string, width: number, indent: string): string {
    text = strip(text.replace(SPACE_ASCII_RE, ' '));
    return textwrapWrap(text, width, indent, indent).join('\n');
  }

  private defaultMetavarForOptional(action: Action): string {
    return action.dest.toUpperCase();
  }

  private defaultMetavarForPositional(action: Action): string {
    return action.dest;
  }
}

// ---------------------------------------------------------------- the parser
const NEGATIVE_NUMBER_RE = /^-\p{Nd}+\n?$|^-\p{Nd}*\.\p{Nd}+\n?$/u;

type OptionTuple = [Action | null, string, string | null];

interface ArgumentGroup {
  title: string;
  description: string | null;
  actions: Action[];
}

export class ArgumentParser {
  prog: string;
  usage: string | null;
  description: string | null;
  epilog: string | null;
  allowAbbrev: boolean;
  private prefixChars = '-';
  private actions: Action[] = [];
  private optionStringActions = new Map<string, Action>();
  private actionGroups: ArgumentGroup[] = [];
  private positionalsGroup: ArgumentGroup;
  private optionalsGroup: ArgumentGroup;
  private subparsers: ArgumentGroup | null = null;
  private defaults: Record<string, unknown> = {};
  private hasNegativeNumberOptionals = false;

  constructor(opts: ParserOptions = {}) {
    this.prog = opts.prog ?? path.basename(process.argv[1] ?? '');
    this.usage = opts.usage ?? null;
    this.description = opts.description ?? null;
    this.epilog = opts.epilog ?? null;
    this.allowAbbrev = opts.allowAbbrev ?? true;
    this.positionalsGroup = this.addArgumentGroup('positional arguments');
    this.optionalsGroup = this.addArgumentGroup('optional arguments');
    if (opts.addHelp ?? true) {
      this.addArgument(['-h', '--help'], { action: 'help', default: SUPPRESS, help: 'show this help message and exit' });
    }
  }

  private addArgumentGroup(title: string, description: string | null = null): ArgumentGroup {
    const group: ArgumentGroup = { title, description, actions: [] };
    this.actionGroups.push(group);
    return group;
  }

  setDefaults(defaults: Record<string, unknown>): void {
    Object.assign(this.defaults, defaults);
    for (const action of this.actions) if (action.dest in defaults) action.default = defaults[action.dest];
  }

  getDefault(dest: string): unknown {
    for (const action of this.actions) if (action.dest === dest && action.default !== null) return action.default;
    return dest in this.defaults ? this.defaults[dest] : null;
  }

  addArgument(names: string[], opts: ArgumentOptions = {}): Action {
    const chars = this.prefixChars;
    let optionStrings: string[];
    let dest: string;
    let required = opts.required ?? false;
    if (!names.length || (names.length === 1 && !chars.includes(names[0][0]))) {
      if (names.length && opts.dest !== undefined) throw new Error('dest supplied twice for positional argument');
      if ('required' in opts) throw new TypeError("'required' is an invalid argument for positionals");
      if (opts.nargs !== OPTIONAL && opts.nargs !== ZERO_OR_MORE) required = true;
      if (opts.nargs === ZERO_OR_MORE && !('default' in opts)) required = true;
      optionStrings = [];
      dest = names.length ? names[0] : opts.dest!;
    } else {
      optionStrings = [];
      const longOptionStrings: string[] = [];
      for (const optionString of names) {
        if (!chars.includes(optionString[0])) {
          throw new Error(`invalid option string ${reprStr(optionString)}: must start with a character ${reprStr(chars)}`);
        }
        optionStrings.push(optionString);
        if (optionString.length > 1 && chars.includes(optionString[1])) longOptionStrings.push(optionString);
      }
      if (opts.dest !== undefined) dest = opts.dest;
      else {
        const destOptionString = longOptionStrings.length ? longOptionStrings[0] : optionStrings[0];
        dest = destOptionString.replace(/^-+/, '');
        if (!dest) throw new Error(`dest= is required for options like ${reprStr(destOptionString)}`);
        dest = dest.replace(/-/g, '_');
      }
    }

    let dflt: unknown = opts.default;
    if (!('default' in opts) && dest in this.defaults) dflt = this.defaults[dest];

    const kind = opts.action ?? 'store';
    let action: Action;
    const base = { optionStrings, dest, kind, required, help: opts.help, metavar: opts.metavar } as const;
    switch (kind) {
      case 'store':
      case 'append':
        if (opts.nargs === 0) throw new Error(`nargs for ${kind} actions must be != 0`);
        if (opts.const !== undefined && opts.nargs !== OPTIONAL) throw new Error("nargs must be '?' to supply const");
        action = new Action({
          ...base,
          nargs: opts.nargs,
          const: opts.const,
          default: dflt,
          type: opts.type,
          choices: opts.choices,
        });
        break;
      case 'store_const':
        action = new Action({ ...base, metavar: undefined, nargs: 0, const: opts.const, default: dflt });
        break;
      case 'store_true':
      case 'store_false':
        action = new Action({
          ...base,
          metavar: undefined,
          nargs: 0,
          const: kind === 'store_true',
          default: 'default' in opts || dest in this.defaults ? dflt : kind !== 'store_true',
        });
        break;
      case 'count':
        action = new Action({ ...base, metavar: undefined, nargs: 0, default: dflt });
        break;
      case 'help':
        action = new Action({
          ...base,
          dest: opts.dest ?? SUPPRESS,
          metavar: undefined,
          nargs: 0,
          default: 'default' in opts ? dflt : SUPPRESS,
        });
        break;
      case 'version':
        action = new Action({
          ...base,
          dest: opts.dest ?? SUPPRESS,
          metavar: undefined,
          nargs: 0,
          default: 'default' in opts ? dflt : SUPPRESS,
          help: 'help' in opts ? opts.help : "show program's version number and exit",
        });
        action.version = opts.version ?? null;
        break;
      default:
        throw new Error(`unknown action "${kind}"`);
    }
    // raise an error if the metavar does not match nargs
    this.getFormatter().formatArgs(action, '');
    return this.addAction(action);
  }

  /** Python's add_argument spelling: add_argument('--x', '-y', {opts}). */
  add_argument(...args: Array<string | ArgumentOptions>): Action {
    const last = args[args.length - 1];
    const opts = typeof last === 'object' ? (args.pop() as ArgumentOptions) : {};
    return this.addArgument(args as string[], opts);
  }

  addSubparsers(opts: SubparsersOptions = {}): SubParsersAction {
    if (this.subparsers !== null) this.error('cannot have multiple subparser arguments');
    this.subparsers = this.positionalsGroup;
    let prog = opts.prog;
    if (prog === undefined) {
      const formatter = this.getFormatter();
      formatter.addUsage(this.usage, this.positionalActions(), '');
      prog = strip(formatter.formatHelp());
    }
    const action = new SubParsersAction(prog, opts);
    this.subparsers.actions.push(action);
    this.registerAction(action);
    return action;
  }

  add_subparsers(opts: SubparsersOptions = {}): SubParsersAction {
    return this.addSubparsers(opts);
  }

  private addAction(action: Action): Action {
    (action.optionStrings.length ? this.optionalsGroup : this.positionalsGroup).actions.push(action);
    this.registerAction(action);
    return action;
  }

  private registerAction(action: Action): void {
    const conflicts = action.optionStrings.filter((o) => this.optionStringActions.has(o));
    if (conflicts.length) {
      const what = conflicts.length === 1 ? 'conflicting option string' : 'conflicting option strings';
      throw new ArgumentError(action, `${what}: ${conflicts.join(', ')}`);
    }
    this.actions.push(action);
    for (const optionString of action.optionStrings) {
      this.optionStringActions.set(optionString, action);
      if (NEGATIVE_NUMBER_RE.test(optionString)) this.hasNegativeNumberOptionals = true;
    }
  }

  private optionalActions(): Action[] {
    return this.actions.filter((a) => a.optionStrings.length);
  }

  private positionalActions(): Action[] {
    return this.actions.filter((a) => !a.optionStrings.length);
  }

  // ---------------------------------------------------------------- parsing
  parseArgs(args?: string[]): Namespace {
    const [namespace, argv] = this.parseKnownArgs(args);
    if (argv.length) this.error(`unrecognized arguments: ${argv.join(' ')}`);
    return namespace;
  }

  parse_args(args?: string[]): Namespace {
    return this.parseArgs(args);
  }

  parseKnownArgs(args?: string[], namespace?: Namespace): [Namespace, string[]] {
    args = args === undefined ? process.argv.slice(2) : args.slice();
    if (namespace === undefined) namespace = {};
    for (const action of this.actions) {
      if (action.dest !== SUPPRESS && !(action.dest in namespace) && action.default !== SUPPRESS) {
        namespace[action.dest] = action.default;
      }
    }
    for (const dest of Object.keys(this.defaults)) {
      if (!(dest in namespace)) namespace[dest] = this.defaults[dest];
    }
    let extras: string[];
    try {
      [namespace, extras] = this.parseKnownArgsInner(args, namespace);
    } catch (e) {
      if (e instanceof ArgumentError) this.error(e.toString());
      throw e;
    }
    if (UNRECOGNIZED in namespace) {
      extras.push(...namespace[UNRECOGNIZED]);
      delete namespace[UNRECOGNIZED];
    }
    return [namespace, extras];
  }

  private parseKnownArgsInner(argStrings: string[], namespace: Namespace): [Namespace, string[]] {
    // find all option indices, and determine the arg_string_pattern
    const optionStringIndices = new Map<number, OptionTuple>();
    const patternParts: string[] = [];
    for (let i = 0; i < argStrings.length; i++) {
      const argString = argStrings[i];
      if (argString === '--') {
        patternParts.push('-');
        for (i = i + 1; i < argStrings.length; i++) patternParts.push('A');
        break;
      }
      const optionTuple = this.parseOptional(argString);
      if (optionTuple === null) patternParts.push('A');
      else {
        optionStringIndices.set(i, optionTuple);
        patternParts.push('O');
      }
    }
    const argStringsPattern = patternParts.join('');

    const seenActions = new Set<Action>();

    const takeAction = (action: Action, argumentStrings: string[], optionString: string | null = null) => {
      seenActions.add(action);
      const argumentValues = this.getValues(action, argumentStrings);
      if (argumentValues !== SUPPRESS) action.call(this, namespace, argumentValues, optionString);
    };

    const extras: string[] = [];

    const consumeOptional = (startIndex: number): number => {
      let [action, optionString, explicitArg] = optionStringIndices.get(startIndex)!;
      const actionTuples: Array<[Action, string[], string]> = [];
      let stop: number;
      for (;;) {
        if (action === null) {
          extras.push(argStrings[startIndex]);
          return startIndex + 1;
        }
        if (explicitArg !== null) {
          const argCount = this.matchArgument(action, 'A');
          const chars = this.prefixChars;
          if (argCount === 0 && !chars.includes(cps(optionString)[1])) {
            actionTuples.push([action, [], optionString]);
            const ch = cps(optionString)[0];
            const ea = cps(explicitArg);
            if (!ea.length) throw new Error('IndexError: string index out of range');
            optionString = ch + ea[0];
            const newExplicitArg = ea.slice(1).join('') || null;
            const found = this.optionStringActions.get(optionString);
            if (found !== undefined) {
              action = found;
              explicitArg = newExplicitArg;
            } else {
              throw new ArgumentError(action, `ignored explicit argument ${reprStr(explicitArg)}`);
            }
          } else if (argCount === 1) {
            stop = startIndex + 1;
            actionTuples.push([action, [explicitArg], optionString]);
            break;
          } else {
            throw new ArgumentError(action, `ignored explicit argument ${reprStr(explicitArg)}`);
          }
        } else {
          const start = startIndex + 1;
          const selectedPatterns = argStringsPattern.slice(start);
          const argCount = this.matchArgument(action, selectedPatterns);
          stop = start + argCount;
          actionTuples.push([action, argStrings.slice(start, stop), optionString]);
          break;
        }
      }
      for (const [a, args, os] of actionTuples) takeAction(a, args, os);
      return stop;
    };

    const positionals = this.positionalActions();

    const consumePositionals = (startIndex: number): number => {
      const selectedPattern = argStringsPattern.slice(startIndex);
      const argCounts = this.matchArgumentsPartial(positionals, selectedPattern);
      for (let k = 0; k < argCounts.length && k < positionals.length; k++) {
        const args = argStrings.slice(startIndex, startIndex + argCounts[k]);
        startIndex += argCounts[k];
        takeAction(positionals[k], args);
      }
      positionals.splice(0, argCounts.length);
      return startIndex;
    };

    let startIndex = 0;
    const indices = Array.from(optionStringIndices.keys());
    const maxOptionStringIndex = indices.length ? Math.max(...indices) : -1;
    while (startIndex <= maxOptionStringIndex) {
      const nextOptionStringIndex = Math.min(...indices.filter((i) => i >= startIndex));
      if (startIndex !== nextOptionStringIndex) {
        const positionalsEndIndex = consumePositionals(startIndex);
        if (positionalsEndIndex > startIndex) {
          startIndex = positionalsEndIndex;
          continue;
        } else {
          startIndex = positionalsEndIndex;
        }
      }
      if (!optionStringIndices.has(startIndex)) {
        extras.push(...argStrings.slice(startIndex, nextOptionStringIndex));
        startIndex = nextOptionStringIndex;
      }
      startIndex = consumeOptional(startIndex);
    }

    const stopIndex = consumePositionals(startIndex);
    extras.push(...argStrings.slice(stopIndex));

    const requiredActions: string[] = [];
    for (const action of this.actions) {
      if (!seenActions.has(action)) {
        if (action.required) requiredActions.push(getActionName(action)!);
        else if (
          action.default !== null &&
          typeof action.default === 'string' &&
          action.dest in namespace &&
          action.default === namespace[action.dest]
        ) {
          namespace[action.dest] = this.getValue(action, action.default);
        }
      }
    }
    if (requiredActions.length) {
      this.error(`the following arguments are required: ${requiredActions.join(', ')}`);
    }
    return [namespace, extras];
  }

  private matchArgument(action: Action, argStringsPattern: string): number {
    const m = new RegExp('^' + this.nargsPattern(action)).exec(argStringsPattern);
    if (m === null) {
      let msg: string;
      if (action.nargs === undefined || action.nargs === null) msg = 'expected one argument';
      else if (action.nargs === OPTIONAL) msg = 'expected at most one argument';
      else if (action.nargs === ONE_OR_MORE) msg = 'expected at least one argument';
      else if (typeof action.nargs === 'number') {
        msg = action.nargs === 1 ? `expected ${action.nargs} argument` : `expected ${action.nargs} arguments`;
      } else msg = `expected ${action.nargs} arguments`;
      throw new ArgumentError(action, msg);
    }
    return m[1].length;
  }

  private matchArgumentsPartial(actions: Action[], argStringsPattern: string): number[] {
    for (let i = actions.length; i > 0; i--) {
      const pattern = actions.slice(0, i).map((a) => this.nargsPattern(a)).join('');
      const m = new RegExp('^' + pattern).exec(argStringsPattern);
      if (m !== null) return m.slice(1).map((s) => s.length);
    }
    return [];
  }

  private parseOptional(argString: string): OptionTuple | null {
    if (!argString) return null;
    if (!this.prefixChars.includes(argString[0])) return null;
    const exact = this.optionStringActions.get(argString);
    if (exact !== undefined) return [exact, argString, null];
    if (pyLen(argString) === 1) return null;
    if (argString.includes('=')) {
      const eq = argString.indexOf('=');
      const optionString = argString.slice(0, eq);
      const explicitArg = argString.slice(eq + 1);
      const a = this.optionStringActions.get(optionString);
      if (a !== undefined) return [a, optionString, explicitArg];
    }
    const optionTuples = this.getOptionTuples(argString);
    if (optionTuples.length > 1) {
      const options = optionTuples.map((t) => t[1]).join(', ');
      this.error(`ambiguous option: ${argString} could match ${options}`);
    } else if (optionTuples.length === 1) {
      return optionTuples[0];
    }
    if (NEGATIVE_NUMBER_RE.test(argString)) {
      if (!this.hasNegativeNumberOptionals) return null;
    }
    if (argString.includes(' ')) return null;
    return [null, argString, null];
  }

  private getOptionTuples(optionString: string): OptionTuple[] {
    const result: OptionTuple[] = [];
    const chars = this.prefixChars;
    const c = cps(optionString);
    if (chars.includes(c[0]) && chars.includes(c[1])) {
      if (this.allowAbbrev) {
        let optionPrefix: string;
        let explicitArg: string | null;
        if (optionString.includes('=')) {
          const eq = optionString.indexOf('=');
          optionPrefix = optionString.slice(0, eq);
          explicitArg = optionString.slice(eq + 1);
        } else {
          optionPrefix = optionString;
          explicitArg = null;
        }
        for (const [os, action] of this.optionStringActions) {
          if (os.startsWith(optionPrefix)) result.push([action, os, explicitArg]);
        }
      }
    } else if (chars.includes(c[0]) && !chars.includes(c[1])) {
      const optionPrefix = optionString;
      const shortOptionPrefix = c.slice(0, 2).join('');
      const shortExplicitArg = c.slice(2).join('');
      for (const [os, action] of this.optionStringActions) {
        if (os === shortOptionPrefix) result.push([action, os, shortExplicitArg]);
        else if (os.startsWith(optionPrefix)) result.push([action, os, null]);
      }
    } else {
      this.error(`unexpected option string: ${optionString}`);
    }
    return result;
  }

  private nargsPattern(action: Action): string {
    const nargs = action.nargs;
    let p: string;
    if (nargs === undefined || nargs === null) p = '(-*A-*)';
    else if (nargs === OPTIONAL) p = '(-*A?-*)';
    else if (nargs === ZERO_OR_MORE) p = '(-*[A-]*)';
    else if (nargs === ONE_OR_MORE) p = '(-*A[A-]*)';
    else if (nargs === PARSER) p = '(-*A[-AO]*)';
    else p = `(-*${Array(nargs as number).fill('A').join('-*')}-*)`;
    if (action.optionStrings.length) p = p.split('-*').join('').split('-').join('');
    return p;
  }

  private getValues(action: Action, argStrings: string[]): any {
    if (action.nargs !== PARSER) {
      const i = argStrings.indexOf('--');
      if (i >= 0) argStrings.splice(i, 1);
    }
    let value: any;
    if (!argStrings.length && action.nargs === OPTIONAL) {
      value = action.optionStrings.length ? action.const : action.default;
      if (typeof value === 'string') {
        value = this.getValue(action, value);
        this.checkValue(action, value);
      }
    } else if (!argStrings.length && action.nargs === ZERO_OR_MORE && !action.optionStrings.length) {
      value = action.default !== null ? action.default : argStrings;
      this.checkValue(action, value);
    } else if (argStrings.length === 1 && (action.nargs === undefined || action.nargs === null || action.nargs === OPTIONAL)) {
      value = this.getValue(action, argStrings[0]);
      this.checkValue(action, value);
    } else if (action.nargs === PARSER) {
      value = argStrings.map((v) => this.getValue(action, v));
      this.checkValue(action, value[0]);
    } else {
      value = argStrings.map((v) => this.getValue(action, v));
      for (const v of value) this.checkValue(action, v);
    }
    return value;
  }

  private getValue(action: Action, argString: string): unknown {
    const type = action.type;
    if (type === null) return argString;
    const fn = type === 'int' ? pyInt : type;
    const name = type === 'int' ? 'int' : type.name || repr(type);
    try {
      return fn(argString);
    } catch (e) {
      if (e instanceof ArgumentTypeError) throw new ArgumentError(action, e.message);
      if (e instanceof ValueError || e instanceof TypeError || type === 'int') {
        throw new ArgumentError(action, `invalid ${name} value: ${reprStr(argString)}`);
      }
      throw e;
    }
  }

  private checkValue(action: Action, value: unknown): void {
    const choices = action.choices;
    if (choices === null) return;
    const ok = choices instanceof Map ? choices.has(value as string) : choices.includes(value);
    if (!ok) {
      const keys = choices instanceof Map ? Array.from(choices.keys()) : choices;
      throw new ArgumentError(action, `invalid choice: ${repr(value)} (choose from ${keys.map(repr).join(', ')})`);
    }
  }

  // ---------------------------------------------------------------- help
  getFormatter(): HelpFormatter {
    return new HelpFormatter(this.prog);
  }

  formatUsage(): string {
    const formatter = this.getFormatter();
    formatter.addUsage(this.usage, this.actions);
    return formatter.formatHelp();
  }

  formatHelp(): string {
    const formatter = this.getFormatter();
    formatter.addUsage(this.usage, this.actions);
    formatter.addText(this.description);
    for (const group of this.actionGroups) {
      formatter.startSection(group.title);
      formatter.addText(group.description);
      formatter.addArguments(group.actions);
      formatter.endSection();
    }
    formatter.addText(this.epilog);
    return formatter.formatHelp();
  }

  printUsage(file: 'stdout' | 'stderr' = 'stdout'): void {
    this.printMessage(this.formatUsage(), file);
  }

  printHelp(file: 'stdout' | 'stderr' = 'stdout'): void {
    this.printMessage(this.formatHelp(), file);
  }

  printMessage(message: string, file: 'stdout' | 'stderr' = 'stderr'): void {
    if (!message) return;
    if (file === 'stdout') io.stdout(message);
    else io.stderr(message);
  }

  /** sys.exit(status) after optionally printing `message` to stderr; always throws ArgparseExit. */
  exit(status = 0, message?: string): never {
    if (message) this.printMessage(message, 'stderr');
    throw new ArgparseExit(status);
  }

  /** Print the usage and `prog: error: message` to stderr, then exit 2. */
  error(message: string): never {
    this.printUsage('stderr');
    this.exit(2, `${this.prog}: error: ${message}\n`);
  }
}
