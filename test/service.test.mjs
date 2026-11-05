import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createService } from '../src/service.mjs';
import { createQuotaCache } from '../src/cache.mjs';
import { parseQuotas } from '../src/parse.mjs';
import { parseResetCredits } from '../src/reset-credits.mjs';
import { quotaFixture, resetFixture } from './helpers.mjs';

test('loopback service authentication, bounded wire, fixed routes and shared native/detail data', async (t) => {
  let calls = 0;
  let resetCalls = 0;
  const now = Date.parse('2026-11-05T06:01:00Z');
  const quota = parseQuotas(await quotaFixture());
  const credits = parseResetCredits(await resetFixture());
  const cache = createQuotaCache({ load: async () => { calls++; return quota; }, now: () => now });
  const resetCache = createQuotaCache({ load: async () => { resetCalls++; return credits; }, now: () => now });
  const server = createService({ token: 'SYNTHETIC_HOST_ONLY', cache, resetCache, now: () => now });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: 'Bearer SYNTHETIC_HOST_ONLY' };
  assert.equal((await fetch(`${base}/health`)).status, 401);
  assert.equal((await fetch(`${base}/health`, { headers })).status, 200);
  assert.equal(calls, 0);
  assert.equal(resetCalls, 0);
  assert.equal((await fetch(`${base}/snapshot`, { headers: { ...headers, origin: 'https://evil.invalid' } })).status, 403);
  for (const path of ['/snapshot?url=https://evil.invalid', '/reset', '/consume', '/quota/api/refresh']) assert.equal((await fetch(`${base}${path}`, { method: 'POST', headers })).status, 404);
  const request = { v: 1, requestId: 'synthetic', method: 'usage.read', provider: 'ext-cpa-quota', input: { credentials: {} } };
  const responses = await Promise.all([
    fetch(`${base}/quota`, { method: 'POST', headers, body: JSON.stringify(request) }).then((r) => r.json()),
    fetch(`${base}/snapshot`, { headers }).then((r) => r.json()),
    fetch(`${base}/reset-credits`, { headers }).then((r) => r.json()),
  ]);
  assert.equal(calls, 1);
  assert.equal(resetCalls, 1);
  assert.equal(responses[0].ok, true);
  assert.equal(Object.keys(responses[0].data.usage.windows).length, 5);
  assert.equal(responses[1].data.accounts.length, 3);
  assert.equal(responses[2].actions.enabled, false);
  assert.equal(responses[2].data.accounts[0].availableCount, 2);
  assert(!JSON.stringify(responses).includes('SYNTHETIC_HOST_ONLY'));
  assert(!JSON.stringify(responses).includes('synthetic-codex-1'));
  request.input.credentials = { magpie: { type: 'api', key: 'NEVER_ACCEPT_THIS' } };
  assert.equal((await fetch(`${base}/quota`, { method: 'POST', headers, body: JSON.stringify(request) })).status, 400);
  assert.equal((await fetch(`${base}/quota`, { method: 'POST', headers, body: 'x'.repeat(17000) })).status, 400);
  assert.equal((await fetch(`${base}/reset-credits`, { method: 'POST', headers })).status, 404);
  for (const route of ['/reset/prepare', '/reset/confirm', '/reset/cancel', '/reset/review']) {
    assert.equal((await fetch(`${base}${route}`, { method: 'POST', headers, body: '{}' })).status, 403);
  }
});

test('action bridge rejects client account/workspace overrides, replay goes through shared server coordinator', async (t) => {
  const { createResetActions, RESET_CONFIRMATION } = await import('../src/reset-actions.mjs');
  const { createResetDirectory } = await import('../src/reset-credits.mjs');
  const raw = await resetFixture();
  const data = parseResetCredits(raw);
  const directory = createResetDirectory(); directory.replace(raw, data);
  let writes = [];
  const snapshot = { data, stale: false, errorCode: null };
  const resetActions = await createResetActions({ enabled: true, now: () => Date.parse('2026-11-05T06:01:00Z'),
    readCredits: async () => snapshot, resolveTarget: directory.resolve,
    perform: async (body) => { writes.push(body); return { status: 'outcome-unknown' }; },
    refreshQuota: async () => snapshot, refreshCredits: async () => snapshot });
  const server = createService({ token: 'SYNTHETIC', cache: { read: async () => ({ data: null }) }, resetActions });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { authorization: 'Bearer SYNTHETIC' }, body: JSON.stringify(body) });
  assert.equal((await post('/reset/prepare', { account_id: 'mixed', workspace_id: 'another' })).status, 400);
  const selected = { targetId: data.accounts[0].id, sourceRevision: data.accounts[0].sourceRevision, acknowledge: true };
  const prepared = (await (await post('/reset/prepare', selected)).json()).operation;
  const second = (await (await post('/reset/prepare', selected)).json()).operation;
  assert.equal(prepared.operationId, second.operationId);
  const confirmation = { operationId: prepared.operationId, confirmation: RESET_CONFIRMATION };
  await post('/reset/confirm', confirmation);
  await post('/reset/confirm', confirmation);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].accountId, raw.accounts[0].account_id);
  assert.equal(writes[0].workspaceId, raw.accounts[0].workspace_id);
});
