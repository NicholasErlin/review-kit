/**
 * review-kit setup: link the agent skill (and optionally the bundled companion skills) into agent skills folders.
 *
 * The skill is symlinked, not copied, so updating the package (`npm i -g @horus52/review-kit`) keeps it current.
 * By default it is linked into ~/.claude/skills when ~/.claude exists; pass --skills-dir for other agents.
 * An existing copy that is not a link is moved to ~/.review-kit-backups/ first, outside the skills folder, so the
 * agent does not load the old copy as a second skill.
 */
import fs from 'node:fs';
import * as companions from './companions.js';
import * as model from './model.js';
import { basename, dirname, exists, expanduser, isdir, islink, join, lstrip, strftime } from './py.js';
import { VERSION } from './version.js';

export const SKILL_SRC = join(model.ROOT, 'skill', 'review-kit');

function move(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

/** Link the skill folder into skillsDir. Returns log lines. */
export function linkSkill(skillsDir: string): string[] {
  const log: string[] = [];
  const target = join(skillsDir, 'review-kit');
  fs.mkdirSync(skillsDir, { recursive: true });
  if (islink(target)) fs.unlinkSync(target);
  else if (exists(target)) {
    const parent = basename(dirname(skillsDir));
    const agent = parent.startsWith('.') ? parent.slice(1) : parent;
    const home = expanduser('~');
    const backup = join(home, '.review-kit-backups', `${agent}-skill-${strftime('%Y%m%d%H%M%S')}`);
    fs.mkdirSync(join(home, '.review-kit-backups'), { recursive: true });
    move(target, backup);
    log.push(`moved the old copy of the skill to ${backup}`);
  }
  fs.symlinkSync(SKILL_SRC, target);
  log.push(`linked the skill into ${skillsDir}`);
  return log;
}

export interface SetupOptions {
  skillsDirs?: string[] | null;
  noSkill?: boolean;
  withCompanions?: boolean;
}

export function setup(opts: SetupOptions = {}): string[] {
  const log: string[] = [];
  let skills = [...(opts.skillsDirs || [])];
  if (!opts.noSkill) {
    const claude = expanduser('~/.claude');
    if (!skills.length && isdir(claude)) skills = [join(claude, 'skills')];
    for (const d of skills) log.push(...linkSkill(d));
    if (!skills.length) {
      log.push('no agent skills folder found; pass --skills-dir DIR, or run `review-kit attach` in a repo to point its AGENTS.md at the skill');
    }
  }
  if (opts.withCompanions) log.push(...companions.install(companions.KINDS, skills.length ? skills : null));
  log.push('');
  log.push(`review-kit ${VERSION} is ready. In a repo, run:`);
  log.push('  review-kit attach --name "My App" --kind ui,backend');
  if (!opts.withCompanions) log.push('Optional companion skills for UI/UX and backend reviews: review-kit companions');
  return log;
}
