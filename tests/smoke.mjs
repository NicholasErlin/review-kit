// Browser smoke test for the built demo site (Playwright is NOT a dependency; see tests/pw.mjs).
//
//   PLAYWRIGHT_PATH=/path/to/node_modules/playwright node tests/smoke.mjs [review.json]
//
// Builds the review (default examples/demo/review.json), serves it on a free port, and checks at
// 412x915 and 1440x900: tabs, compare slider / tap / side-by-side, lightbox, issue filters, issue
// deep links, plan, no horizontal overflow and no console errors. Screenshots go to tests/.smoke/.
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPlaywright } from './pw.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REVIEW = path.resolve(process.argv[2] || path.join(ROOT, 'examples/demo/review.json'));
const SHOTS = path.join(ROOT, 'tests/.smoke');
const CLI = path.join(ROOT, 'bin/review-kit');
fs.mkdirSync(SHOTS, { recursive: true });

execFileSync('python3', [CLI, 'build', REVIEW], { stdio: 'inherit' });
const server = spawn('python3', [CLI, 'serve', REVIEW, '--no-build', '--port', '0', '--host', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'inherit'] });
const base = await new Promise((resolve, reject) => {
  let buf = '';
  server.stdout.on('data', (d) => { buf += d; const m = buf.match(/local:\s+(http:\/\/\S+)/); if (m) resolve(m[1]); });
  server.on('exit', (c) => reject(new Error('server exited ' + c)));
  setTimeout(() => reject(new Error('server did not start')), 10000);
});

const { chromium } = loadPlaywright();
const browser = await chromium.launch();
let failures = 0, passes = 0;
function check(cond, msg) { if (cond) { passes++; } else { failures++; console.log('  FAIL', msg); } }

async function run(name, viewport) {
  console.log(`${name} ${viewport.width}x${viewport.height}`);
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: name === 'mobile' ? 2 : 1, hasTouch: name === 'mobile' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const shot = (n) => page.screenshot({ path: path.join(SHOTS, `${name}-${n}.png`) });
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const tabSel = name === 'mobile' ? '#tabs-bottom a' : '#tabs-top a';

  await page.goto(base + '#/overview');
  await page.waitForSelector('.card');
  check((await page.locator(tabSel).count()) === 4, 'four tabs visible');
  check((await page.locator(name === 'mobile' ? '#tabs-top a' : '#tabs-bottom a').isVisible().catch(() => false)) === false, 'other tab bar hidden');
  check((await page.title()).includes('Acme Notes') || !REVIEW.endsWith('demo/review.json'), 'document title');
  check((await page.locator('.view-title').innerText()) === 'Overview', 'overview title');
  check(await overflow() <= 0, 'overview has no horizontal overflow');
  await shot('overview');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await shot('overview-bottom');

  // tabs
  for (const [label, title] of [['Fixes', 'Fixes'], ['Issues', 'Issues'], ['Plan', 'Plan'], ['Overview', 'Overview']]) {
    await page.locator(tabSel, { hasText: label }).click();
    await page.waitForTimeout(100);
    const t = (await page.locator('.view-title').innerText()).split('\n')[0];
    check(t.startsWith(title), `tab ${label} shows ${title} (got ${t})`);
    check((await page.locator(tabSel + '.on').innerText()).includes(label), `tab ${label} highlighted`);
  }

  // fixes: compare modes
  await page.goto(base + '#/fixes');
  await page.waitForSelector('.fixcard');
  check((await page.locator('.fixcard').count()) === 2, 'two fix cards');
  const card = page.locator('#fix-fix-1');
  await card.locator('[data-seg=mode] button[data-v=slider]').click();
  const cmp = card.locator('.cmp').first();
  await cmp.scrollIntoViewIfNeeded();
  const box = await cmp.boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5, { steps: 6 });
  await page.mouse.up();
  const x = await cmp.evaluate((el) => parseFloat(el.style.getPropertyValue('--x')));
  check(x > 10 && x < 30, `slider drag moves divider to ~20% (got ${x})`);
  await cmp.focus();
  await page.keyboard.press('ArrowRight');
  const x2 = await cmp.evaluate((el) => parseFloat(el.style.getPropertyValue('--x')));
  check(Math.abs(x2 - x - 5) < 0.6, 'arrow key moves the divider');
  await shot('fixes-slider');
  await card.locator('[data-seg=mode] button[data-v=flip]').click();
  const flip = card.locator('.cmp.mode-flip');
  check((await flip.count()) === 1, 'tap mode renders');
  const fb = await flip.boundingBox();
  await page.mouse.click(fb.x + fb.width / 2, fb.y + fb.height / 3);
  check(await flip.evaluate((el) => el.classList.contains('show-before')), 'tap toggles to before');
  await card.locator('[data-seg=mode] button[data-v=side]').click();
  check((await card.locator('.side .fig').count()) === 2, 'side-by-side shows two figures');
  check(await overflow() <= 0, 'fixes have no horizontal overflow');
  await shot('fixes-side');
  // platform switch on fix 2 (desktop has a pair, mobile only an extra image)
  const card2 = page.locator('#fix-fix-2');
  await card2.locator('[data-seg=plat] button[data-v=desktop]').click();
  check((await card2.locator('.fig img, .cmp').count()) >= 1, 'fix 2 desktop pair renders');
  check((await card2.locator('.resolves .ichip').count()) === 1, 'fix 2 links its issue');

  // lightbox
  await card.locator('[data-seg=mode] button[data-v=slider]').click();
  await card.locator('.cmp .zoom').first().click();
  await page.waitForFunction(() => { const i = document.getElementById('lb-img'); return !document.getElementById('lightbox').hidden && i.complete && i.naturalWidth > 0; });
  check((await page.locator('#lb-label').innerText()) === 'AFTER', 'lightbox opens on AFTER');
  await shot('lightbox');
  await page.locator('#lb-next').click();
  check((await page.locator('#lb-label').innerText()) === 'BEFORE', 'lightbox next wraps to BEFORE');
  const stage = await page.locator('#lb-stage').boundingBox();
  await page.mouse.dblclick(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await page.waitForTimeout(50);
  const scale = await page.evaluate(() => /scale\(([\d.]+)\)/.exec(document.getElementById('lb-img').style.transform)[1]);
  check(parseFloat(scale) > 0, 'lightbox zoom transform applied');
  await page.keyboard.press('Escape');
  check(await page.locator('#lightbox').isHidden(), 'Escape closes the lightbox');
  check(page.url().endsWith('#/fixes'), 'closing the lightbox keeps the route');

  // issues + filters
  await page.goto(base + '#/issues');
  await page.locator('#freset').click();
  if (name === 'mobile') {
    check(await page.locator('#fpanel').isHidden(), 'filters collapsed on phones');
    await page.locator('#ftoggle').click();
  }
  const count = () => page.locator('.issue').count();
  check((await count()) === 8, `8 issues listed (got ${await count()})`);
  await page.locator('.chip[data-f=sev][data-v=P1]').click();
  check((await count()) === 3, 'severity P1 filter -> 3');
  await page.locator('.chip[data-f=plat][data-v=desktop]').click();
  check((await count()) === 2, 'P1 + desktop -> 2');
  check((await page.locator('#fcount').innerText()).includes('2'), 'filter count badge');
  await page.locator('#freset').click();
  if (name === 'mobile' && await page.locator('#fpanel').isHidden()) await page.locator('#ftoggle').click();
  await page.locator('.chip[data-f=st][data-v=notabug]').click();
  check((await count()) === 1, 'status not-a-bug -> 1');
  await page.locator('#freset').click();
  if (name === 'mobile' && await page.locator('#fpanel').isHidden()) await page.locator('#ftoggle').click();
  await page.selectOption('#area', 'd-settings');
  check((await count()) === 2, 'area filter -> 2');
  await page.locator('#freset').click();
  await page.fill('#q', 'export');
  await page.waitForTimeout(250);
  check((await count()) === 1, 'search "export" -> 1');
  await page.locator('.issue .ih').first().click();
  check((await page.locator('.issue.open .fixnote').count()) === 1, 'expanded issue shows its note');
  await shot('issues-filtered');
  await page.fill('#q', '');
  await page.waitForTimeout(250);
  check(await overflow() <= 0, 'issues have no horizontal overflow');

  // deep link to an issue with screenshots, then lightbox from a thumbnail
  await page.goto(base + '#/issues/d-1');
  await page.waitForSelector('.issue.open');
  check((await count()) === 1, 'deep link shows one issue');
  check((await page.locator('.issue.open .fixedby .ichip').count()) === 1, 'issue links to its fix');
  await shot('issue-deeplink');
  await page.locator('.issue.open .thumbs button').first().click();
  check(await page.locator('#lightbox').isVisible(), 'thumbnail opens lightbox');
  await page.locator('#lb-close').click();
  await page.locator('.issue.open .fixedby .ichip').click();
  await page.waitForSelector('#fix-fix-2');
  check(page.url().includes('#/fixes/fix-2'), 'fix chip navigates to the fix');

  // plan
  await page.goto(base + '#/plan');
  await page.waitForSelector('.card');
  const rows = name === 'mobile' ? page.locator('.plan-mob .prow') : page.locator('.plan-desk .ptable tr.s-todo, .plan-desk .ptable tr[class^=s-]');
  check((await rows.count()) === 5, `plan shows 5 items (got ${await rows.count()})`);
  check(await overflow() <= 0, 'plan has no horizontal overflow');
  await shot('plan');

  check(errors.length === 0, 'no console errors: ' + errors.join(' | '));
  await ctx.close();
}

async function dark() {
  console.log('dark mode 412x915');
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  const page = await ctx.newPage();
  await page.goto(base + '#/overview');
  await page.waitForSelector('.card');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check(bg !== 'rgb(243, 246, 246)', 'dark mode changes the page background (' + bg + ')');
  await page.screenshot({ path: path.join(SHOTS, 'dark-overview.png') });
  await page.goto(base + '#/issues/m-1');
  await page.waitForSelector('.issue.open');
  await page.screenshot({ path: path.join(SHOTS, 'dark-issue.png') });
  await ctx.close();
}

try {
  await run('mobile', { width: 412, height: 915 });
  await run('desktop', { width: 1440, height: 900 });
  await dark();
} finally {
  await browser.close();
  server.kill();
}
console.log(`${passes} checks passed, ${failures} failed. Screenshots: ${SHOTS}`);
process.exit(failures ? 1 : 0);
