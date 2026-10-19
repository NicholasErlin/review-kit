import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, minimal, quietly, read, request, startServer, stopServer, withTmp } from './helpers.mjs';
import * as build from '../dist/build.js';
import { parser } from '../dist/cliparser.js';
import * as edit from '../dist/edit.js';
import { HTMLParser } from '../dist/htmlparser.js';
import * as markdown from '../dist/markdown.js';
import * as model from '../dist/model.js';
import * as safety from '../dist/safety.js';
import * as serve from '../dist/serve.js';
import * as validate from '../dist/validate.js';

/** Every start tag in text, as [tag, {attr: value}]. */
class Tags extends HTMLParser {
  constructor(text) {
    super();
    this.tags = [];
    this.feed(text);
  }

  handle_starttag(tag, attrs) {
    this.tags.push([tag, Object.fromEntries(attrs)]);
  }
}

describe('ContentSecurityTest', () => {
  test('sanitizes active html in both formats', () => {
    const payload = '<script>alert(1)</script><svg><a href="javascript:alert(1)">bad</a></svg>'
      + '<img src="https://example.com/track" onerror="alert(1)">'
      + '<iframe srcdoc="<script>alert(1)</script>"></iframe>'
      + '<span style="background:url(https://example.com/track)" onclick="alert(1)" '
      + 'id="app" class="tag P0">safe</span>'
      + '<a href="java&#x09;script:alert(1)">bad</a>'
      + '<table><tr><td colspan="2">cell</td></tr></table>';
    for (const fmt of ['html', 'markdown']) {
      const out = markdown.toHtml(payload, fmt);
      const tags = new Tags(out).tags;
      assert.ok(tags.length > 0, fmt);
      assert.ok(tags.every(([tag]) => markdown.TAGS.has(tag)), `${fmt}: ${out}`);
      assert.ok(tags.every(([, attrs]) => Object.keys(attrs).every((name) => !name.startsWith('on') && !['style', 'id', 'srcdoc'].includes(name))),
        `${fmt}: ${out}`);
      assert.ok(tags.every(([, attrs]) => (attrs.href ?? '#') === '#'), `${fmt}: ${out}`);
      assert.ok(out.includes('<span class="tag P0">safe</span>'), `${fmt}: ${out}`);
      assert.ok(out.includes('<td colspan="2">cell</td>'), `${fmt}: ${out}`);
    }
  });

  test('url schemes and credentials', () => {
    for (const value of ['javascript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,bad',
      'vbscript:bad', 'file:///etc/passwd', '//example.com/x',
      'https://user:password@example.com/', 'https://[broken', '\\example.com']) {
      assert.equal(safety.safeUrl(value), '#', JSON.stringify(value));
    }
    for (const value of ['https://example.com/a?q=1', 'mailto:hello@example.com', '#section', 'files/notes.md']) {
      assert.equal(safety.safeUrl(value), value);
    }
  });

  test('markdown handles untrusted placeholder characters', () => {
    assert.equal(markdown.render('\x000\x00 **ok**'), '0 <b>ok</b>');
  });

  test('local preview is default', () => {
    assert.ok(serve.serve.toString().includes("host = '127.0.0.1'"));
    assert.equal(parser().parseArgs(['serve']).host, '127.0.0.1');
  });
});

describe('PublicationSecurityTest', () => {
  test('validation rejects external and sensitive attachments even without file checks', withTmp(async (t) => {
    for (const href of ['../private.txt', '.env', 'credentials.json', 'state.json', 'key.pem', 'payload.html',
      'javascript:alert(1)', 'data:text/html,bad']) {
      for (const section of ['project', 'fix']) {
        const data = minimal();
        const links = [{ label: 'attachment', href }];
        if (section === 'project') data.project.links = links;
        else data.fixes = [{ id: 'f', title: 'fix', links }];
        assert.ok(validate.validate(data, t.tmp, false)[0].length > 0, `${href} in ${section}`);
      }
    }
  }));

  test('repo paths and active commit links are rejected', withTmp(async (t) => {
    const data = minimal();
    data.project.repo = '/Users/private/project';
    assert.ok(validate.validate(data, t.tmp)[0].length > 0);
    delete data.project.repo;
    data.fixes = [{ id: 'f', title: 'fix', commits: [{ sha: 'abc', url: 'javascript:alert(1)' }] }];
    assert.ok(validate.validate(data, t.tmp)[0].length > 0);
  }));

  test('external symlinks cannot be published', withTmp(async (t) => {
    const review = t.copyDemo();
    const base = path.dirname(review);
    const external = path.join(t.tmp, 'private.txt');
    fs.writeFileSync(external, 'SYNTHETIC_PRIVATE_VALUE');
    fs.symlinkSync(external, path.join(base, 'notes-link.txt'));
    const data = model.load(review);
    data.project.links = [{ label: 'notes', href: 'notes-link.txt' }];
    model.save(review, data);
    assert.throws(() => build.build(review, path.join(t.tmp, 'site'), { quiet: true }),
      (e) => e instanceof model.ReviewError && /inside the review folder/.test(e.message));
  }));

  test('existing output secrets are preserved and block build', withTmp(async (t) => {
    const review = t.copyDemo();
    const out = path.join(t.tmp, 'site');
    build.build(review, out, { quiet: true });
    for (const name of ['.env', 'leftover.txt']) {
      const p = path.join(out, name);
      fs.writeFileSync(p, 'SYNTHETIC_PRIVATE_VALUE');
      assert.throws(() => build.build(review, out, { force: true, clean: true, quiet: true }),
        (e) => e instanceof model.ReviewError && /fresh output directory/.test(e.message), name);
      assert.ok(fs.statSync(p).isFile());
      fs.rmSync(p);
    }
  }));

  test('output symlink does not modify its target', withTmp(async (t) => {
    const review = t.copyDemo();
    const out = path.join(t.tmp, 'site');
    build.build(review, out, { quiet: true });
    const external = path.join(t.tmp, 'private.txt');
    fs.writeFileSync(external, 'SYNTHETIC_PRIVATE_VALUE');
    fs.rmSync(path.join(out, 'data.js'));
    fs.symlinkSync(external, path.join(out, 'data.js'));
    assert.throws(() => build.build(review, out, { quiet: true }),
      (e) => e instanceof model.ReviewError && /symlink/.test(e.message));
    assert.equal(read(external), 'SYNTHETIC_PRIVATE_VALUE');
  }));

  test('absolute screenshots still import explicitly', withTmp(async (t) => {
    const reviewDir = path.join(t.tmp, 'review');
    const review = edit.init(reviewDir, 'Test');
    const data = model.load(review);
    const shot = t.png('outside/shot.png');
    edit.upsertIssue(data, { title: 'shot', screenshots: [shot] }, reviewDir);
    model.save(review, data);
    build.build(review, path.join(t.tmp, 'site'), { quiet: true });
    assert.deepEqual(data.issues[0].screenshots, ['screenshots/issues/shot.png']);
  }));

  test('server blocks secrets symlinks and unlisted files for get and head', withTmp(async (t) => {
    const review = t.copyDemo();
    const out = path.join(t.tmp, 'site');
    build.build(review, out, { quiet: true });
    const external = path.join(t.tmp, 'private.txt');
    fs.writeFileSync(external, 'SYNTHETIC_PRIVATE_VALUE');
    for (const name of ['.env', 'leftover.txt', 'credentials.json']) fs.writeFileSync(path.join(out, name), 'SYNTHETIC_PRIVATE_VALUE');
    fs.symlinkSync(external, path.join(out, 'private-link.txt'));
    fs.mkdirSync(path.join(out, 'folder'));
    const server = await startServer(out);
    const port = server.address().port;
    try {
      await quietly(async () => {
        for (const p of ['/.env', '/%2eenv', '/credentials.json', '/leftover.txt', '/private-link.txt',
          '/folder/', '/img/', '/%2e%2e/private.txt', '/' + build.MARKER]) {
          for (const method of ['GET', 'HEAD']) {
            const r = await request(port, p, { method });
            assert.equal(r.status, 404, `${method} ${p}`);
          }
        }
        for (const p of ['/', '/data.js', '/files/notes.md', '/img/screenshots/mobile-save-before.png']) {
          const r = await request(port, p);
          assert.equal(r.status, 200, p);
          assert.equal(r.headers['x-content-type-options'], 'nosniff');
          assert.equal(r.headers['referrer-policy'], 'no-referrer');
          assert.ok(r.headers['content-security-policy'].includes("connect-src 'none'"));
        }
      });
    } finally {
      await stopServer(server);
    }
  }));

  test('repository and scaffold ignore secrets', withTmp(async (t) => {
    const names = ['.env', '.env.local', 'private.pem', 'state.json', 'playwright/.auth/session.json'];
    const probe = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], { cwd: ROOT, input: names.join('\n') + '\n', encoding: 'utf-8' });
    assert.deepEqual(probe.split('\n').filter(Boolean), names);
    const review = edit.init(path.join(t.tmp, 'review'), 'Test');
    const ignored = read(path.join(path.dirname(review), '.gitignore'));
    for (const name of ['.env', 'state.json', '*.pem', '.auth/']) assert.ok(ignored.includes(name), name);
  }));

  test('new reviews do not store installation paths', withTmp(async (t) => {
    const review = edit.init(path.join(t.tmp, 'review'), 'Test');
    const data = model.load(review);
    assert.equal(data.$schema, model.SCHEMA_URL);
    assert.ok(!model.dumps(data).includes(t.tmp));
  }));
});
