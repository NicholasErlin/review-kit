/**
 * The few git operations design proposals need. git runs via execFileSync with an argument list (never a shell);
 * refs come from validated ids and paths are absolute, so nothing user-typed can be read as an option.
 */
import { execFileSync } from 'node:child_process';
import { ReviewError } from './errors.js';
import { isabs, join, normpath, realpath } from './py.js';

export interface GitResult { status: number; stdout: Buffer; stderr: string }

const MAX_BUFFER = 1024 * 1024 * 1024;

/** Run git in cwd. Throws ReviewError when git is missing, or (unless allowFail) when it exits non-zero. */
export function run(cwd: string, args: string[], allowFail = false): GitResult {
  try {
    const stdout = execFileSync('git', args, {
      cwd, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { status?: number | null; stdout?: Buffer; stderr?: Buffer };
    if (err.code === 'ENOENT' && typeof err.status !== 'number') {
      throw new ReviewError('git is not installed or not on PATH; design options need git');
    }
    if (typeof err.status !== 'number') throw e;
    const res = { status: err.status, stdout: err.stdout || Buffer.alloc(0), stderr: (err.stderr || Buffer.alloc(0)).toString('utf8').trim() };
    if (allowFail) return res;
    throw new ReviewError(`git ${args[0]} failed: ${res.stderr || `exit status ${res.status}`}`);
  }
}

/** git output as trimmed text. */
export function text(cwd: string, args: string[]): string {
  return run(cwd, args).stdout.toString('utf8').trim();
}

/** The top folder of the repository containing dir (realpath). */
export function root(dir: string): string {
  const r = run(dir, ['rev-parse', '--show-toplevel'], true);
  if (r.status !== 0) throw new ReviewError(`${dir} is not inside a git repository (design options are built on git branches)`);
  return realpath(r.stdout.toString('utf8').trim());
}

/** True when dir belongs to the main checkout, not a linked worktree. */
export function isMainCheckout(dir: string): boolean {
  const gitDir = text(dir, ['rev-parse', '--absolute-git-dir']);
  let common = text(dir, ['rev-parse', '--git-common-dir']);
  if (!isabs(common)) common = join(dir, common);
  return realpath(normpath(gitDir)) === realpath(normpath(common));
}

/** The checked-out branch name, or null on a detached HEAD. */
export function currentBranch(dir: string): string | null {
  const r = run(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true);
  return r.status === 0 ? r.stdout.toString('utf8').trim() : null;
}

export function branchExists(dir: string, branch: string): boolean {
  return run(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], true).status === 0;
}

/** The commit sha a ref names; ReviewError when it does not exist. */
export function commit(dir: string, ref: string): string {
  if (!ref || ref.startsWith('-')) throw new ReviewError(`invalid git ref ${JSON.stringify(ref)}`);
  const r = run(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], true);
  if (r.status !== 0) throw new ReviewError(`git: ${JSON.stringify(ref)} is not a commit in this repository`);
  return r.stdout.toString('utf8').trim();
}

export function isAncestor(dir: string, a: string, b: string): boolean {
  return run(dir, ['merge-base', '--is-ancestor', a, b], true).status === 0;
}

export interface StatusEntry { x: string; y: string; path: string; orig?: string }

/** `git status --porcelain=v1 -z` as entries (untracked files listed one by one). */
export function status(dir: string): StatusEntry[] {
  const out = run(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).stdout.toString('utf8');
  const parts = out.split('\0');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    const e: StatusEntry = { x: p[0], y: p[1], path: p.slice(3) };
    if (e.x === 'R' || e.x === 'C') e.orig = parts[++i];
    entries.push(e);
  }
  return entries;
}

export interface NumstatFile { path: string; add: number; del: number; binary?: boolean }

/** Parse `git diff --numstat -z`. Renames are reported under their new path. */
export function parseNumstat(out: string): NumstatFile[] {
  const parts = out.split('\0');
  const files: NumstatFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(parts[i]);
    if (!m) continue;
    let path = m[3];
    if (!path) { // rename or copy: the source and destination follow as separate fields
      i += 2;
      path = parts[i] ?? '';
    }
    const binary = m[1] === '-' || m[2] === '-';
    const f: NumstatFile = { path, add: binary ? 0 : Number(m[1]), del: binary ? 0 : Number(m[2]) };
    if (binary) f.binary = true;
    files.push(f);
  }
  return files;
}

/** Paths with unresolved conflicts. */
export function conflicts(dir: string): string[] {
  return run(dir, ['diff', '--name-only', '-z', '--diff-filter=U'], true).stdout.toString('utf8').split('\0').filter(Boolean);
}
