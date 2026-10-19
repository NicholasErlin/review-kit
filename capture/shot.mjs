#!/usr/bin/env node
// Take one screenshot with Playwright, for before/after evidence in review.json.
// Playwright is resolved from the current project (run this from the repo under review) or PLAYWRIGHT_PATH.
//
//   node ~/review-kit/capture/shot.mjs --url http://localhost:3000/settings --out .review/screenshots/fix3/settings-before-mobile.png --viewport mobile
//
// Options:
//   --url URL            page to open (required)
//   --out FILE           .png or .jpg (required; folders are created)
//   --viewport V         mobile (412x915, scale 2, touch) | tablet (820x1180) | desktop (1440x900) | WxH   [desktop]
//   --full               full-page screenshot
//   --dark               prefers-color-scheme: dark
//   --wait-for SELECTOR  wait for this selector before shooting
//   --wait MS            extra settle time after load [300]
//   --selector SELECTOR  screenshot only this element
//   --storage FILE       Playwright storageState JSON (a logged-in session)
//   --steps FILE         ES module whose default export is async (page) => {} run before the shot (click, scroll, open a dialog...)
//   --quality N          JPEG quality [80]
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { createRequire } from 'module';

function args(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const name = k.slice(2);
    if (['full', 'dark'].includes(name)) a[name] = true;
    else a[name] = argv[++i];
  }
  return a;
}

function loadPlaywright() {
  const req = createRequire(path.join(process.cwd(), 'noop.js'));
  for (const t of [process.env.PLAYWRIGHT_PATH, 'playwright', '@playwright/test'].filter(Boolean)) {
    try { return req(t); } catch (e) { /* next */ }
  }
  console.error('Playwright not found. Run from a project that has it (npm i -D playwright), or set PLAYWRIGHT_PATH=/path/to/node_modules/playwright');
  process.exit(2);
}

const VIEWPORTS = {
  mobile: { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  tablet: { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
};

const a = args(process.argv.slice(2));
if (!a.url || !a.out) {
  console.error('usage: shot.mjs --url URL --out FILE [--viewport mobile|desktop|WxH] [--full] [--dark] [--wait-for SEL] [--selector SEL] [--storage state.json] [--steps steps.mjs]');
  process.exit(2);
}
let ctxOpts = VIEWPORTS[a.viewport || 'desktop'];
if (!ctxOpts) {
  const m = /^(\d+)x(\d+)$/.exec(a.viewport || '');
  if (!m) { console.error('bad --viewport ' + a.viewport); process.exit(2); }
  ctxOpts = { viewport: { width: +m[1], height: +m[2] }, deviceScaleFactor: +m[1] < 600 ? 2 : 1 };
}
ctxOpts = { ...ctxOpts, colorScheme: a.dark ? 'dark' : 'light' };
if (a.storage) ctxOpts.storageState = a.storage;

const { chromium } = loadPlaywright();
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  await page.goto(a.url, { waitUntil: 'networkidle' }).catch(() => page.goto(a.url));
  if (a['wait-for']) await page.waitForSelector(a['wait-for']);
  if (a.steps) {
    const mod = await import(pathToFileURL(path.resolve(a.steps)).href);
    await mod.default(page);
  }
  await page.waitForTimeout(+(a.wait || 300));
  fs.mkdirSync(path.dirname(path.resolve(a.out)), { recursive: true });
  const jpeg = /\.jpe?g$/i.test(a.out);
  const opts = { path: a.out, fullPage: !!a.full, ...(jpeg ? { type: 'jpeg', quality: +(a.quality || 80) } : {}) };
  if (a.selector) await page.locator(a.selector).first().screenshot(opts);
  else await page.screenshot(opts);
  console.log(path.resolve(a.out));
} finally {
  await browser.close();
}
