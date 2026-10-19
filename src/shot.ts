/**
 * review-kit shot: take one Playwright screenshot, for before/after evidence in review.json.
 *
 * Playwright is not a dependency of review-kit. It is resolved from the project you run the command in
 * (node_modules/playwright or @playwright/test), then from PLAYWRIGHT_PATH, then next to review-kit itself.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { eprint, print } from './io.js';
import { abspath, dirname, join } from './py.js';

export class ShotError extends Error {
  constructor(message: string, public status = 2) {
    super(message);
  }
}

export const PLAYWRIGHT_MISSING = 'Playwright not found. Run from a project that has it (npm i -D playwright), '
  + 'or set PLAYWRIGHT_PATH=/path/to/node_modules/playwright';

/** Find Playwright: the current project first, then PLAYWRIGHT_PATH, then review-kit's own install. */
export function loadPlaywright(): any {
  const fromCwd = createRequire(join(process.cwd(), 'noop.js'));
  const tries: [NodeRequire, string][] = [[fromCwd, 'playwright'], [fromCwd, '@playwright/test']];
  if (process.env.PLAYWRIGHT_PATH) tries.push([fromCwd, abspath(process.env.PLAYWRIGHT_PATH)]);
  const fromKit = createRequire(import.meta.url);
  tries.push([fromKit, 'playwright'], [fromKit, '@playwright/test']);
  for (const [req, id] of tries) {
    try {
      return req(id);
    } catch {
      /* try the next one */
    }
  }
  throw new ShotError(PLAYWRIGHT_MISSING);
}

const VIEWPORTS: Record<string, Record<string, unknown>> = {
  mobile: { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  tablet: { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
};

export interface ShotOptions {
  url: string;
  out: string;
  viewport?: string;
  full?: boolean;
  dark?: boolean;
  waitFor?: string | null;
  wait?: number;
  selector?: string | null;
  storage?: string | null;
  steps?: string | null;
  quality?: number;
}

/** Context options for a --viewport value: a preset name or WxH. */
export function contextOptions(o: ShotOptions): Record<string, unknown> {
  const v = o.viewport || 'desktop';
  let ctx = VIEWPORTS[v];
  if (!ctx) {
    const m = /^(\d+)x(\d+)$/.exec(v);
    if (!m) throw new ShotError('bad --viewport ' + v);
    ctx = { viewport: { width: +m[1], height: +m[2] }, deviceScaleFactor: +m[1] < 600 ? 2 : 1 };
  }
  const out: Record<string, unknown> = { ...ctx, colorScheme: o.dark ? 'dark' : 'light' };
  if (o.storage) out.storageState = o.storage;
  return out;
}

export async function shot(o: ShotOptions): Promise<string> {
  const ctxOpts = contextOptions(o);
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext(ctxOpts);
    const page = await ctx.newPage();
    await page.goto(o.url, { waitUntil: 'networkidle' }).catch(() => page.goto(o.url));
    if (o.waitFor) await page.waitForSelector(o.waitFor);
    if (o.steps) {
      const mod = await import(pathToFileURL(abspath(o.steps)).href);
      await mod.default(page);
    }
    await page.waitForTimeout(o.wait ?? 300);
    fs.mkdirSync(dirname(abspath(o.out)), { recursive: true });
    const jpeg = /\.jpe?g$/i.test(o.out);
    const opts = { path: o.out, fullPage: !!o.full, ...(jpeg ? { type: 'jpeg', quality: o.quality ?? 80 } : {}) };
    if (o.selector) await page.locator(o.selector).first().screenshot(opts);
    else await page.screenshot(opts);
    return abspath(o.out);
  } finally {
    await browser.close();
  }
}

/** The `shot` command: prints the absolute path of the screenshot. Returns the exit status. */
export async function cmdShot(o: ShotOptions): Promise<number> {
  try {
    print(await shot(o));
    return 0;
  } catch (e) {
    if (e instanceof ShotError) {
      eprint(e.message);
      return e.status;
    }
    throw e;
  }
}
