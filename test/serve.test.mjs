import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, quietly, request, startServer, stopServer, withTmp } from './helpers.mjs';
import * as build from '../dist/build.js';
import * as serve from '../dist/serve.js';
import { ReviewError } from '../dist/errors.js';

describe('ServeTest', () => {
  test('serves built site with no cache', withTmp(async (t) => {
    const review = t.copyDemo();
    const out = path.join(t.tmp, 'site');
    build.build(review, out, { quiet: true });
    const p = spawn(process.execPath, [path.join(ROOT, 'dist', 'cli.js'), 'serve', out, '--port', '0', '--host', '127.0.0.1'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const url = await new Promise((resolve) => {
        let buf = '';
        const timer = setTimeout(() => resolve(null), 10000);
        p.stdout.on('data', (d) => {
          buf += d;
          const m = /local:\s+(\S+)/.exec(buf);
          if (m) {
            clearTimeout(timer);
            resolve(m[1]);
          }
        });
        p.on('exit', () => {
          clearTimeout(timer);
          resolve(null);
        });
      });
      assert.notEqual(url, null);
      let r = await fetch(url);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('Cache-Control'), 'no-cache');
      assert.ok((await r.text()).includes('Acme Notes UX review'));
      r = await fetch(url + 'data.js');
      assert.ok((await r.text()).startsWith('window.REVIEW = '));
    } finally {
      const exited = new Promise((resolve) => (p.exitCode !== null || p.signalCode !== null ? resolve() : p.once('exit', resolve)));
      p.kill('SIGTERM');
      await exited;
    }
  }));

  test('serve requires built site', withTmp(async (t) => {
    await assert.rejects(serve.serve(t.tmp, '127.0.0.1', 0), ReviewError);
  }));

  test('loopback server rejects foreign host headers', withTmp(async (t) => {
    // regression: backend review issue-8 (DNS rebinding)
    const review = t.copyDemo();
    const out = path.join(t.tmp, 'site');
    build.build(review, out, { quiet: true });
    const server = await startServer(out);
    const port = server.address().port;
    try {
      await quietly(async () => {
        for (const [host, status] of [['evil.example', 403], [`evil.example:${port}`, 403], [`localhost:${port}`, 200],
          [`127.0.0.1:${port}`, 200], ['LOCALHOST', 200]]) {
          const r = await request(port, '/data.js', { headers: { Host: host } });
          assert.equal(r.status, status, host);
        }
      });
    } finally {
      await stopServer(server);
    }
  }));

  test('watch survives unexpected build errors and sees deletions', withTmp(async (t) => {
    // regression: backend review issue-9
    const review = t.copyDemo();
    const failing = () => {
      throw Object.assign(new Error('disk went away'), { code: 'EIO' });
    };
    const { value } = await quietly(() => serve.rebuild(review, path.join(t.tmp, 'site'), null, failing));
    assert.equal(value, false);
    const before = serve.snapshot(review);
    const shots = path.join(path.dirname(review), 'screenshots');
    const victim = fs.readdirSync(shots).sort().at(-1);
    fs.rmSync(path.join(shots, victim));
    assert.notEqual(serve.snapshot(review), before);
  }));

  test('tailscale range', () => {
    assert.equal(serve.tailscale('100.64.0.1'), true);
    assert.equal(serve.tailscale('100.128.0.1'), false);
    assert.equal(serve.tailscale('192.168.0.10'), false);
  });
});
