// Locate Playwright without adding it as a dependency:
// PLAYWRIGHT_PATH=/path/to/node_modules/playwright, else resolve from the current directory.
import { createRequire } from 'module';
import path from 'path';

export function loadPlaywright() {
  const tries = [];
  if (process.env.PLAYWRIGHT_PATH) tries.push(process.env.PLAYWRIGHT_PATH);
  tries.push('playwright', '@playwright/test');
  const req = createRequire(path.join(process.cwd(), 'noop.js'));
  for (const t of tries) {
    try { return req(t); } catch (e) { /* try next */ }
  }
  throw new Error('Playwright not found. Run from a project that has it installed, or set PLAYWRIGHT_PATH=/path/to/node_modules/playwright');
}
