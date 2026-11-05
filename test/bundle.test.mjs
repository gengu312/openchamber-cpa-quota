import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { resolve, join } from 'node:path';
import { toNative } from '../src/view.mjs';
import { parseResetCredits } from '../src/reset-credits.mjs';
import { resetFixture } from './helpers.mjs';

test('built service starts in isolated HOME, authenticated health has no API reads, clean stop', async (t) => {
  let source;
  try { source = await readFile('dist/native/service/main.js', 'utf8'); }
  catch { t.skip('Run npm run build for bundle verification'); return; }
  assert(!source.includes('cardExpiresAt'), 'old card-specific mock must not ship in production');
  assert(!source.includes('SYNTHETIC_NOT_REAL'));
  assert(!/C:\\\\Users\\\\[^\\]+/.test(source), 'bundle must not contain a personal Windows home path');
  const home = await mkdtemp(join(process.env.LOCALAPPDATA, 'Temp', 'opencode', 'cpa-quota-smoke-'));
  await mkdir(join(home, '.config', 'openchamber-cpa-quota'), { recursive: true });
  // A fake origin makes any accidental quota call fail locally; credentials are absent.
  await writeFile(join(home, '.config', 'openchamber-cpa-quota', 'config.json'), '{"origin":"https://127.0.0.1:1"}');
  const placeholder = http.createServer();
  placeholder.listen(0, '127.0.0.1');
  await once(placeholder, 'listening');
  const port = placeholder.address().port;
  await new Promise((resolve) => placeholder.close(resolve));
  const child = spawn(process.execPath, [resolve('dist/native/service/main.js')], {
    env: { ...process.env, HOME: home, USERPROFILE: home, OPENCHAMBER_SERVICE_PORT: String(port), OPENCHAMBER_SERVICE_TOKEN: 'SYNTHETIC_SMOKE' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  t.after(() => child.kill());
  let response;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { response = await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: 'Bearer SYNTHETIC_SMOKE' }, signal: AbortSignal.timeout(500) }); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  assert.equal(response?.status, 200, 'built service did not become ready');
  assert.equal(output, '');
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 401);
  for (const path of ['/reset/prepare', '/reset/confirm', '/reset/review']) {
    assert.equal((await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { authorization: 'Bearer SYNTHETIC_SMOKE' }, body: '{}' })).status, 403);
  }
  const exited = once(child, 'exit');
  child.kill();
  await exited;
});

test('native card counts are independent of quota failure and never a percentage', async () => {
  const now = Date.parse('2026-11-05T06:01:00Z');
  const reset = { data: parseResetCredits(await resetFixture()), stale: false, fetchedAt: now };
  const result = toNative({ data: null, errorCode: 'NETWORK' }, now, reset);
  assert.equal(result.ok, true);
  assert.match(result.error, /连接/);
  const window = Object.values(result.usage.windows)[0];
  assert.equal(window.usedPercent, null);
  assert.match(window.valueLabel, /2 张/);
  assert.match(window.valueLabel, /源/);
});
