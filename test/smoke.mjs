// Browser smoke test for the built demo site (Playwright is NOT a dependency; see test/pw.mjs).
//
//   PLAYWRIGHT_PATH=/path/to/node_modules/playwright node test/smoke.mjs [review.json]   (after `npm run build`)
//
// Builds the review (default examples/demo/review.json), serves it on a free port, and checks at
// 412x915 and 1440x900: tabs, compare slider / tap / side-by-side, lightbox, issue filters, issue
// deep links, plan, no horizontal overflow and no console errors. Then it builds a combined site (the demo as a
// UI/UX review plus a re-themed copy as a Backend review in one .review/) and checks the review switch, per-review
// routes and deep links, separate filters, keyboard use and 44px targets. Last, all four kinds in one site
// (examples/ideas-design plus the demo as UI/UX and Backend): the switch, ideas list, grid, filters and detail, research
// deep links, the proposal matrix, platform switch, diff viewer and copy buttons, and an adopted copy opened from
// file://. Screenshots go to test/.smoke/.
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { loadPlaywright } from './pw.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REVIEW = path.resolve(process.argv[2] || path.join(ROOT, 'examples/demo/review.json'));
const SHOTS = path.join(ROOT, 'test/.smoke');
const CLI = path.join(ROOT, 'dist/cli.js');
fs.mkdirSync(SHOTS, { recursive: true });

const servers = [];
/** `review-kit serve ARGS --no-build` on a free port; resolves with its base URL. */
function serveSite(args, cwd = ROOT) {
  const server = spawn(process.execPath, [CLI, 'serve', ...args, '--no-build', '--port', '0', '--host', '127.0.0.1'], { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  servers.push(server);
  return new Promise((resolve, reject) => {
    let buf = '';
    server.stdout.on('data', (d) => { buf += d; const m = buf.match(/local:\s+(http:\/\/\S+)/); if (m) resolve(m[1]); });
    server.on('exit', (c) => reject(new Error('server exited ' + c)));
    setTimeout(() => reject(new Error('server did not start')), 10000);
  });
}
execFileSync(process.execPath, [CLI, 'build', REVIEW], { stdio: 'inherit' });
const base = await serveSite([REVIEW]);

// combined site: .review/ui (the demo) + .review/backend (the demo again, as a backend review with its own accent)
const COMBO = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-smoke-'));
const DEMO = path.join(ROOT, 'examples/demo');
for (const [kind, title, accent] of [['ui', 'UI/UX review', '#5b3df5'], ['backend', 'Backend review', '#7a3b00']]) {
  const dir = path.join(COMBO, '.review', kind);
  fs.cpSync(DEMO, dir, { recursive: true, filter: (src) => path.basename(src) !== 'site' });
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'review.json'), 'utf-8'));
  Object.assign(data.project, { kind, title, theme: { accent, logoText: 'AN' } });
  fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify(data, null, 2));
}
execFileSync(process.execPath, [CLI, 'build'], { cwd: COMBO, stdio: 'inherit' });
const comboBase = await serveSite([], COMBO);

// ideas + design: the examples/ideas-design reviews next to the demo as UI/UX and Backend (all four kinds in one site)
const IDX = path.join(ROOT, 'examples/ideas-design/.review');
const FOUR = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-smoke4-'));
for (const kind of ['ideas', 'design']) fs.cpSync(path.join(IDX, kind), path.join(FOUR, '.review', kind), { recursive: true, filter: (src) => path.basename(src) !== 'site' });
for (const kind of ['ui', 'backend']) {
  const dir = path.join(FOUR, '.review', kind);
  fs.cpSync(DEMO, dir, { recursive: true, filter: (src) => path.basename(src) !== 'site' });
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'review.json'), 'utf-8'));
  Object.assign(data.project, { kind, title: kind === 'ui' ? 'UI/UX review' : 'Backend review' });
  fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify(data, null, 2));
}
execFileSync(process.execPath, [CLI, 'build'], { cwd: FOUR, stdio: 'inherit' });
const fourBase = await serveSite([], FOUR);
const IDEAS = JSON.parse(fs.readFileSync(path.join(FOUR, '.review/ideas/review.json'), 'utf-8'));
const DESIGN = JSON.parse(fs.readFileSync(path.join(FOUR, '.review/design/review.json'), 'utf-8'));

// a design review after adoption: the recommended option adopted, the others discarded (gone), and a hostile line in
// one diff to prove diff text is never parsed as HTML. Built on its own and opened from file://.
const ADOPTED = path.join(FOUR, 'adopted');
fs.cpSync(path.join(IDX, 'design'), ADOPTED, { recursive: true, filter: (src) => path.basename(src) !== 'site' });
{
  const data = JSON.parse(fs.readFileSync(path.join(ADOPTED, 'review.json'), 'utf-8'));
  const p = data.proposals[0], win = p.recommendation.option;
  p.status = 'adopted';
  p.adopted = { option: win, commit: 'abc1234def', date: '2026-10-19' };
  for (const o of p.options) { o.status = o.id === win ? 'adopted' : 'rejected'; if (o.id !== win) o.gone = true; }
  const hostile = p.options.find((o) => o.id === win && o.diff);
  fs.appendFileSync(path.join(ADOPTED, hostile.diff.path), '+<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>\n');
  fs.writeFileSync(path.join(ADOPTED, 'review.json'), JSON.stringify(data, null, 2));
}
execFileSync(process.execPath, [CLI, 'build', ADOPTED], { stdio: 'inherit' });

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

async function combined(name, viewport) {
  console.log(`combined ${name} ${viewport.width}x${viewport.height}`);
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: name === 'mobile' ? 2 : 1, hasTouch: name === 'mobile' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const shot = (n) => page.screenshot({ path: path.join(SHOTS, `combined-${name}-${n}.png`) });
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const tabSel = name === 'mobile' ? '#tabs-bottom a' : '#tabs-top a';
  const sw = page.locator('#review-switch a');
  const current = () => page.locator('#review-switch a[aria-current]').innerText();
  const headerBg = () => page.evaluate(() => getComputedStyle(document.querySelector('.top')).backgroundColor);
  const count = () => page.locator('.issue').count();

  // landing: both reviews side by side
  await page.goto(comboBase);
  await page.waitForSelector('#review-switch');
  check((await sw.allInnerTexts()).join('|') === 'All|UI/UX|Backend', 'switch lists All, UI/UX, Backend in order');
  check((await current()) === 'All', 'landing marks All as current');
  check((await page.locator('#app .card').count()) === 2, 'landing shows one card per review');
  check((await page.title()) === 'Acme Notes reviews', `landing title (got ${await page.title()})`);
  check((await page.locator(tabSel).count()) === 0, 'landing has no per-review tabs');
  const heights = await sw.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  check(heights.every((h) => h >= (name === 'mobile' ? 44 : 36)), `switch targets are large enough (${heights.join(', ')})`);
  check(await overflow() <= 0, 'landing has no horizontal overflow');
  await shot('landing');

  // switch to Backend: its own theme, title and tabs
  const uiBg = await (async () => { await sw.filter({ hasText: 'UI/UX' }).click(); await page.waitForSelector('.view-title'); return headerBg(); })();
  check(page.url().endsWith('#/ui/overview'), 'UI/UX link opens #/ui/overview');
  await sw.filter({ hasText: 'Backend' }).click();
  await page.waitForTimeout(100);
  check(page.url().endsWith('#/backend/overview'), `Backend link opens #/backend/overview (got ${page.url()})`);
  check((await current()) === 'Backend', 'Backend marked current');
  check((await page.locator('#brand').innerText()).includes('Backend review'), 'header shows the backend title');
  check((await headerBg()) !== uiBg, 'header takes the backend accent');
  check((await page.title()) === 'Acme Notes Backend review', 'document title follows the review');
  check((await page.locator(tabSel).count()) === 4, 'backend has its four tabs');
  await shot('backend-overview');

  // tabs stay inside the review, and switching keeps the view
  await page.locator(tabSel, { hasText: 'Issues' }).click();
  await page.waitForTimeout(100);
  check(page.url().endsWith('#/backend/issues'), 'Issues tab routes to #/backend/issues');
  await page.locator('#freset').click();
  if (name === 'mobile') await page.locator('#ftoggle').click();
  await page.locator('.chip[data-f=sev][data-v=P1]').click();
  check((await count()) === 3, 'backend P1 filter -> 3');
  await sw.filter({ hasText: 'UI/UX' }).click();
  await page.waitForTimeout(100);
  check(page.url().endsWith('#/ui/issues'), 'switching keeps the Issues view');
  check((await count()) === 8, 'UI/UX filters are separate from Backend filters');
  check((await page.locator('#fcount').innerText()) === '', 'no filter badge on UI/UX');
  check(await overflow() <= 0, 'combined issues have no horizontal overflow');
  await page.goto(comboBase + '#/backend/issues');
  await page.waitForSelector('.issue');
  check((await count()) === 3, 'backend filter remembered');
  await page.locator('#freset').click();

  // deep links into the second review, and links between its views
  await page.goto(comboBase + '#/backend/issues/d-1');
  await page.waitForSelector('.issue.open');
  check((await count()) === 1, 'backend deep link shows one issue');
  check((await current()) === 'Backend', 'deep link selects Backend');
  await page.locator('.issue.open .fixedby .ichip').click();
  await page.waitForSelector('#fix-fix-2');
  check(page.url().includes('#/backend/fixes/fix-2'), 'fix chip stays in the backend review');
  await shot('backend-fixes');
  // an old single-review hash still opens something sensible
  await page.goto(comboBase + '#/plan');
  await page.waitForSelector('.view-title');
  check((await page.locator('.view-title').innerText()).startsWith('Plan'), 'single-review hash #/plan still renders');

  // keyboard: Tab to the switch and press Enter
  await page.goto(comboBase + '#/ui/overview');
  await page.waitForSelector('.view-title');
  await page.locator('#review-switch a', { hasText: 'Backend' }).focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  check(page.url().endsWith('#/backend/overview'), 'Enter on a focused switch link switches review');
  await page.locator('.brand').click();
  await page.waitForTimeout(100);
  check((await current()) === 'All', 'brand link returns to the combined overview');
  await page.goto(comboBase + '#/ui/fixes');
  await page.waitForSelector('.fixcard');
  check(await overflow() <= 0, 'combined fixes have no horizontal overflow');
  await shot('ui-fixes');

  check(errors.length === 0, 'combined: no console errors: ' + errors.join(' | '));
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

async function ideasDesign(name, viewport, colorScheme = 'light') {
  console.log(`ideas + design ${name} ${viewport.width}x${viewport.height} ${colorScheme}`);
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: name === 'mobile' ? 2 : 1, hasTouch: name === 'mobile', colorScheme });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(fourBase).origin });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const tag = `${name}${colorScheme === 'dark' ? '-dark' : ''}`;
  const shot = (n) => page.screenshot({ path: path.join(SHOTS, `ideas-${tag}-${n}.png`), fullPage: true });
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const tabSel = name === 'mobile' ? '#tabs-bottom a' : '#tabs-top a';
  const sw = page.locator('#review-switch a');
  const P = DESIGN.proposals[0], REC = P.recommendation.option;
  const recTitle = P.options.find((o) => o.id === REC).title;
  const tabs = async () => (await page.locator(tabSel).allInnerTexts()).map((t) => t.trim().split('\n').pop()).join('|');
  const small44 = (sel) => page.locator(sel).evaluateAll((els) => els.filter((e) => e.offsetParent !== null).map((e) => e.getBoundingClientRect()).filter((r) => r.height < 44).length);

  // landing: all four kinds, in order, one card each
  await page.goto(fourBase);
  await page.waitForSelector('#review-switch');
  check((await sw.allInnerTexts()).join('|') === 'All|Ideas|Designs|UI/UX|Backend', `switch order (got ${(await sw.allInnerTexts()).join('|')})`);
  check((await page.locator('#app .rv-card').count()) === 4, 'landing has a card per review');
  check((await page.locator('#app .rv-card').first().innerText()).includes(IDEAS.ideas.length + ' ideas'), 'ideas card counts ideas');
  check((await page.locator('#app .rv-card').nth(1).innerText()).includes(DESIGN.proposals.length + ' proposal'), 'design card counts proposals');
  check(await overflow() <= 0, 'four-kind landing has no horizontal overflow');
  await shot('landing');

  // ideas review: tabs follow the kind
  await sw.filter({ hasText: 'Ideas' }).click();
  await page.waitForURL(/#\/ideas\/overview$/);
  await page.locator(tabSel).first().waitFor();
  const want = ['Overview', 'Ideas', 'Research'].concat((IDEAS.plan || []).length ? ['Plan'] : []);
  check((await tabs()) === want.join('|'), `ideas tabs ${want.join('|')} (got ${await tabs()})`);
  const nGo = IDEAS.ideas.filter((i) => i.status === 'go').length;
  check((await page.locator('#app .stat.fixed b').first().innerText()) === String(nGo), 'ideas overview counts go ideas');
  await shot('overview');

  // ideas list: grid, status chips, sort
  await page.locator(tabSel, { hasText: 'Ideas' }).click();
  await page.waitForSelector('.icard');
  check(page.url().endsWith('#/ideas/ideas'), 'Ideas tab routes to #/ideas/ideas');
  check((await page.locator('.icard').count()) === IDEAS.ideas.length, 'every idea listed');
  const sized = IDEAS.ideas.filter((i) => i.impact && i.effort).length;
  check((await page.locator('.imx .mx-i').count()) === sized, `impact/effort grid lists ${sized} sized ideas`);
  check((await page.locator('.imx tbody tr').count()) === 3 && (await page.locator('.imx tbody tr').first().locator('td').count()) === 3, 'grid is 3x3');
  await page.locator('.chip[data-f=st][data-v=go]').click();
  check((await page.locator('.icard').count()) === nGo, `status Go -> ${nGo}`);
  check((await page.locator('.chip[data-f=st][data-v=go]').getAttribute('aria-pressed')) === 'true', 'chip reports pressed');
  await page.locator('#ireset').click();
  await page.locator('[data-seg=sort] button[data-v=impact]').click();
  const top = IDEAS.ideas.slice().sort((a, b) => ({ L: 3, M: 2, S: 1 }[b.impact] || 0) - ({ L: 3, M: 2, S: 1 }[a.impact] || 0))[0];
  check((await page.locator('.icard h2').first().innerText()) === top.title, 'sort by impact puts the largest impact first');
  check(await small44('.icontrols .chip, .icontrols .seg button') === 0 || name !== 'mobile', 'idea filter targets are 44px on phones');
  check(await overflow() <= 0, 'ideas list has no horizontal overflow');
  await shot('ideas');

  // idea detail: sections in order, evidence cards, link across to the design review
  const idea = IDEAS.ideas.find((i) => (i.proposals || []).length) || IDEAS.ideas[0];
  await page.locator('.icard h2 a', { hasText: idea.title }).click();
  await page.waitForSelector('.isec');
  check(page.url().endsWith('#/ideas/ideas/' + idea.id), 'idea card opens its detail route');
  check(await page.evaluate(() => document.activeElement && document.activeElement.tagName === 'H1'), 'focus moves to the idea heading');
  const heads = (await page.locator('.isec > h2').allInnerTexts()).map((t) => t.trim().toLowerCase());
  const order = ['problem', 'proposal', 'why this', 'evidence', 'alternatives considered', 'risks', 'pros and cons', 'decision'];
  check(order.every((h, i) => heads[i] === h), `idea sections in order (got ${heads.join(', ')})`);
  check((await page.locator('.isec .rcard.inner').count()) === (idea.evidence || []).length, 'each cited research item is a card');
  const refs = page.locator('.isec .rich a.ref');
  const mentions = [idea.reasoning, idea.alternatives, idea.problem, idea.risks].join(' ').match(/\br-\d+\b/g) || [];
  if (mentions.length) {
    check((await refs.count()) >= 1, 'research ids in the text become links');
    check((await page.locator('.isec .rich').allInnerTexts()).every((t) => !/\[r-\d+\]/.test(t)), 'square brackets around research ids are dropped');
    check(await page.locator('.isec a a, .isec code a.ref').count() === 0, 'no links inside links or code');
    const rid = await refs.first().innerText();
    await refs.first().click();
    await page.waitForSelector('.rcard.hl');
    check(page.url().endsWith('#/ideas/research/' + rid), `research link opens ${rid}`);
    await page.goBack();
    await page.waitForSelector('.isec');
  }
  if ((idea.proposals || []).length) {
    await page.locator('.isec .ichip', { hasText: P.title }).first().click();
    await page.waitForSelector('.cmx');
    check(page.url().endsWith('#/design/proposals/' + P.id), 'idea links across to the design proposal');
    check((await page.locator('#review-switch a[aria-current]').innerText()) === 'Designs', 'the switch follows to Designs');
  }

  // research: deep link, sources, cited by
  const r = IDEAS.research.find((x) => (x.sources || []).length);
  await page.goto(fourBase + '#/ideas/research/' + r.id);
  await page.waitForSelector('.rcard.hl');
  await page.waitForTimeout(100);
  check((await page.locator('.rcard.hl').getAttribute('id')) === 'res-' + r.id, 'research deep link highlights the finding');
  check((await page.locator('.rcard.hl .sources li').count()) === r.sources.length, 'numbered sources listed');
  const ext = page.locator('.rcard.hl .sources a[href^="http"]').first();
  if (await ext.count()) check((await ext.getAttribute('rel')) === 'noopener noreferrer' && (await ext.getAttribute('target')) === '_blank', 'external sources open safely');
  check(await page.evaluate(() => !!document.activeElement.closest('.rcard.hl')), 'focus moves to the linked finding');
  check(await overflow() <= 0, 'research has no horizontal overflow');
  await shot('research');

  // proposal: matrix, recommendation, options, platform switch, diff viewer, copy buttons
  await page.goto(fourBase + '#/design/proposals/' + P.id);
  await page.waitForSelector('.cmx');
  check((await tabs()) === 'Overview|Proposals', `design tabs Overview|Proposals (got ${await tabs()})`);
  check((await page.locator('.cmx tbody tr').count()) === P.criteria.length, 'matrix row per criterion');
  check((await page.locator('.cmx thead th').count()) === P.options.length + 1, 'matrix column per option');
  check((await page.locator('.cmx tfoot td.best').count()) >= 1, 'highest total highlighted');
  check((await page.locator('.cmx tfoot td.best').innerText()).includes('Highest'), 'highest total named in text, not colour only');
  check((await page.locator('.callout.rec h2').innerText()).trim() === recTitle, 'recommendation callout names the option');
  const ideaRef = page.locator('.isec a.ref[href*="/ideas/i-"]').first();
  if (/\bi-\d+\b/.test(P.brief)) check((await ideaRef.getAttribute('href') || '').startsWith('#/ideas/ideas/'), 'idea ids in the design brief link across to the ideas review');
  const resRef = page.locator('a.ref[href*="/research/"]').first();
  if (await resRef.count()) check((await resRef.getAttribute('href')).startsWith('#/ideas/research/'), 'research ids in the design review link across');
  const notes = page.locator('#mx-notes');
  if (await notes.count()) {
    await notes.click();
    check((await page.locator('.cmx details[open]').count()) === (await page.locator('.cmx details').count()), 'show all score notes opens every note');
  }
  check((await page.locator('.opt').count()) === P.options.length, 'an option card each');
  check((await page.locator('.opt.s-rec .obadge.rec').count()) === 1, 'recommended option badged');
  const plats = await page.locator('.opts-head [data-seg=plat] button').count();
  if (plats > 1) {
    const before = await page.locator('.opt .oshots img').first().getAttribute('src');
    await page.locator('.opts-head [data-seg=plat] button').nth(1).click();
    const after = await page.locator('.opt .oshots img').first().getAttribute('src').catch(() => null);
    check(before !== after, 'platform switch changes every option\'s screenshot');
    await page.locator('.opts-head [data-seg=plat] button').first().click();
  }
  const o0 = P.options.find((o) => o.diff);
  const card = page.locator('#opt-' + o0.id);
  await card.locator('.diffbox > summary').click();
  // phones: the diff opens inside the option; side-by-side columns: in one full-width panel under them
  const dv = name === 'mobile' ? card.locator('.diffbox .diffv') : page.locator('#diffpanel .diffv');
  await dv.locator('pre.dl span').first().waitFor();
  if (name !== 'mobile') {
    const pw = (await page.locator('#diffpanel').boundingBox()).width;
    check(pw > 1000, `diff panel is full width (${Math.round(pw)}px)`);
    check(await page.evaluate(() => document.activeElement.id === 'dp-h'), 'opening a diff focuses the panel heading');
    check((await card.locator('.dp-note').count()) === 1, 'the option says where its diff is');
  } else check(await page.locator('#diffpanel').isHidden(), 'no diff panel when options are stacked');
  const patch = fs.readFileSync(path.join(FOUR, '.review/design', o0.diff.path), 'utf-8').replace(/\n$/, '').split('\n');
  const shown = await dv.locator('pre.dl span').allTextContents();
  check(shown.join('\n') === patch.join('\n'), 'diff viewer shows the patch text exactly');
  check((await dv.locator('pre.dl span.a').count()) > 0, 'added lines coloured');
  check((await dv.locator('.dfile').count()) === o0.diff.files.length, 'a section per file in the diff');
  await shot('diff');
  if (name !== 'mobile') {
    const o1 = P.options.find((o) => o.diff && o.id !== o0.id);
    if (o1) {
      await page.locator('#opt-' + o1.id + ' .diffbox > summary').click();
      await page.waitForFunction((id) => document.getElementById('diffpanel').getAttribute('data-o') === id, o1.id);
      check((await page.locator('.diffbox[open]').count()) === 1, 'opening another diff replaces the panel');
      check((await page.locator('#dp-h').innerText()).includes(o1.title), 'panel names the option');
    }
    await page.locator('#dp-close').click();
    check(await page.locator('#diffpanel').isHidden(), 'close hides the diff panel');
    check((await page.locator('.diffbox[open]').count()) === 0, 'close collapses the option\'s toggle');
    check(await page.evaluate(() => document.activeElement.matches('.diffbox > summary')), 'close returns focus to the toggle');
  }
  const copy = card.locator('[data-copy]').first();
  const cmd = await copy.getAttribute('data-copy');
  check(cmd === 'git switch ' + (o0.branch || `design/${P.id}/${o0.id}`), 'copy button for git switch');
  check((await card.locator('[data-copy]').nth(1).getAttribute('data-copy')) === `review-kit adopt design ${P.id} ${o0.id}`, 'copy button for adopt (names the review in a combined site)');
  await copy.click();
  await page.waitForTimeout(100);
  check((await copy.innerText()) === 'Copied', 'copy button confirms');
  check((await page.evaluate(() => navigator.clipboard.readText())) === cmd, 'command is on the clipboard');
  check((await page.locator('#rk-live').innerText()).includes(cmd), 'copy is announced');
  if (name === 'mobile') check(await small44('.opt .copy, .diffbox > summary, .dfile > summary, .cmx summary, .back a') === 0, 'proposal targets are 44px on phones');
  check(await overflow() <= 0, 'proposal has no horizontal overflow');
  await shot('proposal');

  // option deep link, keyboard: Enter opens the diff
  const o2 = P.options[P.options.length - 1];
  await page.goto(fourBase + '#/design/proposals/' + P.id + '/' + o2.id);
  await page.waitForSelector('#opt-' + o2.id + '.hl');
  await page.waitForTimeout(100);
  check(await page.evaluate((id) => document.activeElement === document.querySelector('#opt-' + id + ' h3'), o2.id), 'option deep link focuses the option');
  const box = await page.locator('#opt-' + o2.id).boundingBox();
  check(box.y < viewport.height && box.y + 40 > 0, 'option deep link scrolls it into view');
  if (o2.diff) {
    await page.locator('#opt-' + o2.id + ' .diffbox > summary').focus();
    await page.keyboard.press('Enter');
    await page.locator(name === 'mobile' ? '#opt-' + o2.id + ' pre.dl span' : '#diffpanel pre.dl span').first().waitFor();
    check(true, 'Enter opens the diff');
  }
  await shot('option');
  check(errors.length === 0, 'ideas + design: no console errors: ' + errors.join(' | '));
  await ctx.close();

  // adopted, others discarded, from file://
  const ctx2 = await browser.newContext({ viewport, colorScheme });
  const p2 = await ctx2.newPage();
  const err2 = [];
  p2.on('pageerror', (e) => err2.push(String(e)));
  await p2.goto(pathToFileURL(path.join(ADOPTED, 'site/index.html')).href + '#/proposals/' + P.id);
  await p2.waitForSelector('.cmx');
  check((await p2.locator('.callout.ok h2').innerText()).trim() === recTitle, 'adopted callout names the option (file://)');
  check((await p2.locator('[data-copy^="review-kit adopt"]').count()) === 0, 'adopt buttons hidden once adopted');
  check((await p2.locator('[data-copy^="git switch"]').count()) === 1, 'git switch hidden for discarded branches');
  check((await p2.locator('.opt .obadge.rej').count()) === P.options.length - 1, 'other options marked rejected');
  await p2.locator('#opt-' + REC + ' .diffbox > summary').click();
  const dv2 = name === 'mobile' ? p2.locator('#opt-' + REC + ' .diffbox') : p2.locator('#diffpanel');
  await dv2.locator('pre.dl span').first().waitFor();
  check(await p2.evaluate(() => window.__xss === undefined && !document.querySelector('.diffv img, .diffv script')), 'diff text is never parsed as HTML');
  check((await dv2.locator('pre.dl span').last().innerText()).includes('<script>'), 'markup in a diff shows as text');
  await p2.screenshot({ path: path.join(SHOTS, `ideas-${tag}-adopted.png`), fullPage: true });
  check(err2.length === 0, 'adopted site: no errors: ' + err2.join(' | '));
  await ctx2.close();
}

async function prsPages() {
  console.log('PRs: offline pages at both sizes; live API click-through with fake gh');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-smoke-prs-'));
  const example = path.join(ROOT, 'examples/prs');
  const offline = path.join(tmp, 'offline'), liveDir = path.join(tmp, 'live');
  for (const dir of [offline, liveDir]) fs.cpSync(example, dir, { recursive: true, filter: (p) => path.basename(p) !== 'site' });
  execFileSync(process.execPath, [CLI, 'build', offline], { stdio: 'inherit' });
  const fixture = path.join(liveDir, 'review.json'), log = path.join(SHOTS, 'prs-live-gh.jsonl');
  fs.writeFileSync(log, '');
  const fakeEnv = { ...process.env, REVIEW_KIT_GH: path.join(ROOT, 'test/fake-gh.mjs'), REVIEW_KIT_GH_DATA: fixture, REVIEW_KIT_GH_LOG: log };
  const child = spawn(process.execPath, [CLI, 'serve', liveDir, '--port', '0'], { cwd: ROOT, env: fakeEnv, stdio: ['ignore', 'pipe', 'inherit'] });
  servers.push(child);
  const liveBase = await new Promise((resolve, reject) => { let text = ''; const timeout = setTimeout(() => reject(new Error('PR server did not start')), 10000); child.stdout.on('data', (d) => { text += d; const m = text.match(/local:\s+(http:\/\/\S+)/); if (m) { clearTimeout(timeout); resolve(m[1]); } }); child.on('exit', (code) => reject(new Error('PR server exited ' + code))); });
  try {
    const combo = path.join(tmp, 'combined');
    fs.cpSync(offline, path.join(combo, '.review/prs'), { recursive: true, filter: (p) => path.basename(p) !== 'site' });
    fs.cpSync(DEMO, path.join(combo, '.review/ui'), { recursive: true, filter: (p) => path.basename(p) !== 'site' });
    execFileSync(process.execPath, [CLI, 'build'], { cwd: combo, stdio: 'inherit' });
    const comboUrl = pathToFileURL(path.join(combo, '.review/site/index.html')).href;
    const combinedPage = await browser.newPage({ viewport: { width: 412, height: 915 } });
    await combinedPage.goto(comboUrl);
    check((await combinedPage.locator('#review-switch a').allInnerTexts()).join('|') === 'All|PRs|UI/UX', 'combined site orders PRs first');
    check((await combinedPage.locator('.rv-card').first().innerText()).includes('9 pull requests'), 'PR landing card counts PRs');
    await combinedPage.locator('#review-switch a', { hasText: 'PRs' }).click();
    await combinedPage.locator('a[href$="pr/acme-web-150"]').click();
    await combinedPage.waitForSelector('#pr-diff .pr-finding');
    check(combinedPage.url().endsWith('#/prs/pr/acme-web-150'), 'combined reviewing deep link');
    check(await combinedPage.locator('.pr-shipbar').isVisible(), 'combined PR assets and ship bar work');
    await combinedPage.close();
    for (const [name, viewport] of [['mobile', { width: 412, height: 915 }], ['desktop', { width: 1440, height: 900 }]]) {
      const ctx = await browser.newContext({ viewport, colorScheme: 'light', permissions: ['clipboard-read', 'clipboard-write'] }), page = await ctx.newPage(), errors = [], fetches = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('request', (r) => { if (r.resourceType() === 'fetch') fetches.push(r.url()); });
      const offlineBase = pathToFileURL(path.join(offline, 'site/index.html')).href;
      const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      const shot = (label, fullPage = true) => page.screenshot({ path: path.join(SHOTS, 'prs-' + name + '-' + label + '.png'), fullPage });
      await page.goto(offlineBase + '#/prs');
      await page.waitForSelector('.pr-card');
      check(await page.locator('.pr-card').count() === 9, 'PR board lists all 9 PRs');
      check(await page.locator('.pr-group:not(details)').count() === 7, 'PR board renders both role groups');
      check(await overflow() <= 0, 'PR board has no overflow');
      await shot('board');
      await page.locator('[data-role=reviewing]').click();
      check(await page.locator('.pr-card').count() === 3, 'Reviewing role filters board');
      await page.locator('[data-role=all]').click();
      await page.locator('[data-repo="acme/web"]').click();
      check(await page.locator('.pr-card').count() === 3, 'repository filter');
      await page.locator('[data-repo=""]').click();
      await page.locator('#pr-search').fill('Coupons in the cart');
      check(await page.locator('.pr-card').count() === 1, 'PR text search');
      await page.locator('#pr-search').fill('');
      await page.locator('a[href$="pr/acme-web-142"]').click();
      await page.waitForSelector('#pr-diff .dfile');
      check((await page.locator('.pr-blockers').innerText()).includes('2 checks failing'), 'mine PR shows blockers');
      await shot('mine');
      check(await overflow() <= 0, 'mine PR has no overflow');
      await page.locator('[data-jump-threads]').click();
      check(page.url().endsWith('/pr/acme-web-142'), 'thread jump keeps route');
      await page.goto(offlineBase + '#/prs/pr/acme-web-150');
      await page.waitForSelector('#pr-diff .pr-finding');
      check(await page.locator('.pr-shipbar').isVisible(), 'reviewing has sticky ship bar');
      check(await page.locator('#pr-diff .pr-finding').count() >= 2, 'findings appear in the diff');
      check(await overflow() <= 0, 'reviewing PR has no page overflow');
      await shot('reviewing');
      await page.locator('#pr-diff .pr-finding').first().scrollIntoViewIfNeeded();
      check(await page.locator('#pr-diff .pr-inline').first().evaluate((e) => e.getBoundingClientRect().width <= document.getElementById('pr-diff').clientWidth), 'inline finding fits diff viewport');
      check(await page.locator('#pr-diff .pr-finding .rich').first().evaluate((e) => e.scrollWidth <= e.clientWidth), 'inline finding prose wraps');
      await shot('reviewing-findings', false);
      await page.locator('.pr-shipbar [data-pr-action=ship]').click();
      await page.waitForSelector('dialog[open]');
      const json = await page.locator('dialog pre').innerText();
      check(json.includes('REQUEST_CHANGES') && json.includes('src/cart/applyCoupon.ts'), 'offline review preview contains exact verdict and comments');
      await page.locator('dialog button[type=submit]').click();
      check((await page.evaluate(() => navigator.clipboard.readText())).includes('gh api repos/acme/web/pulls/150/reviews -X POST --input -'), 'offline review command is copied with its JSON');
      await page.keyboard.press('?'); check(await page.locator('dialog[open]').count() === 1, 'keyboard help opens'); await page.keyboard.press('Escape');
      check(fetches.length === 0, 'offline PR pages never fetch');
      check(errors.length === 0, 'offline PR pages have no JS errors: ' + errors.join(' | '));
      await ctx.close();
    }
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await ctx.newPage(), errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(liveBase + '#/prs');
    await page.waitForFunction(() => document.body.innerText.includes('Live actions on localhost'));
    await page.evaluate(() => { window.prTestMarker = 'no reload'; });
    async function act(action, click) { const response = page.waitForResponse((r) => r.url().endsWith('/api/prs/' + action) && r.request().method() === 'POST'); await click(); const r = await response; const data = await r.json(); check(r.ok() && data.ok, 'live ' + action + ' succeeds: ' + (data.error || '')); await page.waitForFunction(() => !document.body.classList.contains('pr-busy')); return data; }
    await act('sync', () => page.getByRole('button', { name: 'Sync all', exact: true }).click());
    await page.locator('a[href$="pr/acme-web-142"]').click();
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    await page.locator('dialog textarea').fill('Smoke: a fixture-only comment.');
    await act('comment', () => page.locator('dialog button[type=submit]').click());
    check((await page.locator('.pr-section').allInnerTexts()).some((t) => t.includes('Smoke: a fixture-only comment.')), 'comment appears in place');
    await page.goto(liveBase + '#/prs/pr/nimbus-cli-31');
    await page.waitForFunction(() => document.querySelector('[data-pr-action=merge]')?.textContent === 'Merge');
    await page.locator('[data-pr-action=merge]').first().click();
    await page.locator('dialog select').selectOption('rebase');
    check((await page.locator('dialog pre').innerText()) === 'gh pr merge 31 -R nimbus/cli --rebase', 'merge dialog shows selected exact command');
    await act('merge', () => page.locator('dialog button[type=submit]').click());
    check(await page.locator('[data-pr-action=merge]').count() === 0, 'merged PR updates controls in place');
    await page.goto(liveBase + '#/prs/pr/acme-web-150');
    await page.waitForFunction(() => document.querySelector('.pr-shipbar [data-pr-action=ship]')?.textContent === 'Preview & send');
    await page.waitForSelector('#pr-diff .pr-finding');
    await act('flag', () => page.locator('#pr-findings [data-pr-action=flag][data-finding=f-3]').click());
    check(await page.evaluate(() => document.activeElement.dataset.finding === 'f-3'), 'flag action preserves keyboard focus');
    check((await page.locator('.pr-shipbar').innerText()).includes('3 findings flagged'), 'flag changes sticky count in place');
    await page.locator('#pr-diff [role=button][data-n]').first().click();
    await page.locator('dialog input[name=title]').fill('Fixture finding');
    await page.locator('dialog textarea[name=body]').fill('Please add a test for this branch.');
    await act('finding', () => page.locator('dialog button[type=submit]').click());
    check((await page.locator('#pr-findings').innerText()).includes('Fixture finding'), 'line click adds finding');
    await act('ship', () => page.locator('.pr-shipbar [data-pr-action=ship]').click());
    await page.waitForSelector('dialog[open]');
    check((await page.locator('dialog pre').innerText()).includes('Leftover') === false, 'preview contains exact bodies without added titles');
    await page.screenshot({ path: path.join(SHOTS, 'prs-live-ship-preview.png') });
    await act('ship', () => page.locator('dialog button[type=submit]').click());
    check((await page.locator('.pr-shipbar').innerText()).includes('0 findings flagged'), 'ship clears flags in place');
    check(await page.locator('#pr-findings [data-pr-action=flag]').count() === 2, 'only unposted drafts retain toggles');
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse), reviews = calls.filter((c) => c.argv[1]?.endsWith('/reviews'));
    check(reviews.length === 1 && JSON.parse(reviews[0].input).comments.length === 3, 'click-through posts exactly one selected review with three comments');
    check(errors.length === 0, 'live PR pages have no JS errors: ' + errors.join(' | '));
    // Last page action replaced data, without navigation/reload.
    await page.evaluate(() => { window.prTestMarker = 'no reload'; });
    await act('sync', () => page.locator('[data-pr-action=sync]').click());
    check(await page.evaluate(() => window.prTestMarker === 'no reload'), 'live response updates without reloading page');
    await ctx.close();
  } finally { child.kill(); fs.rmSync(tmp, { recursive: true, force: true }); }
}

try {
  await prsPages();
  await ideasDesign('mobile', { width: 412, height: 915 });
  await ideasDesign('desktop', { width: 1440, height: 900 });
  await ideasDesign('mobile', { width: 412, height: 915 }, 'dark');
  await run('mobile', { width: 412, height: 915 });
  await run('desktop', { width: 1440, height: 900 });
  await dark();
  await combined('mobile', { width: 412, height: 915 });
  await combined('desktop', { width: 1440, height: 900 });
} finally {
  await browser.close();
  for (const s of servers) s.kill();
  fs.rmSync(COMBO, { recursive: true, force: true });
  fs.rmSync(FOUR, { recursive: true, force: true });
}
console.log(`${passes} checks passed, ${failures} failed. Screenshots: ${SHOTS}`);
process.exit(failures ? 1 : 0);
