import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQuotaCache } from '../src/cache.mjs';
import { QuotaError } from '../src/errors.mjs';
import { deferred } from './helpers.mjs';

test('shared cache merges concurrent desktop/native reads and refreshes after TTL', async () => {
  let now = 0;
  let calls = 0;
  const gate = deferred();
  const cache = createQuotaCache({ now: () => now, load: async () => { calls++; await gate.promise; return { configured: true, accounts: [] }; } });
  const reads = Array.from({ length: 20 }, () => cache.read());
  assert.equal(calls, 1);
  gate.resolve();
  await Promise.all(reads);
  await cache.read();
  assert.equal(calls, 1);
  now = 30_000;
  await cache.read();
  assert.equal(calls, 2);
});

test('network failure keeps old data with original timestamp, backs off, expires and recovers', async () => {
  let now = 0;
  let calls = 0;
  let fail = false;
  const cache = createQuotaCache({ now: () => now, retentionMs: 100_000, load: async () => { calls++; if (fail) throw new QuotaError('NETWORK'); return { configured: true, accounts: [] }; } });
  await cache.read();
  fail = true;
  now = 30_000;
  const failed = await cache.read();
  assert.equal(failed.stale, true);
  assert.equal(failed.fetchedAt, 0);
  assert(failed.data);
  now = 35_000;
  await cache.read();
  assert.equal(calls, 2);
  now = 110_000;
  assert.equal((await cache.read()).data, null);
  fail = false;
  now = 150_000;
  const recovered = await cache.read();
  assert.equal(recovered.stale, false);
  assert.equal(recovered.errorCode, null);
  assert.equal(recovered.fetchedAt, now);
});

test('cold error cached, raw error scrubbed; unconfigured does not erase previous success', async () => {
  let now = 0;
  let result = 'throw';
  const cache = createQuotaCache({ now: () => now, load: async () => {
    if (result === 'throw') throw new Error('secret-token');
    return { configured: result !== 'unconfigured', accounts: [] };
  } });
  const error = await cache.read();
  assert.equal(error.data, null);
  assert(!JSON.stringify(error).includes('secret-token'));
  now = 30_000; result = 'success';
  await cache.read();
  now = 60_000; result = 'unconfigured';
  const view = await cache.read();
  assert(view.data);
  assert.equal(view.errorCode, 'NOT_CONFIGURED');
  assert.equal(view.stale, true);
});

test('explicit follow-up refresh bypasses TTL after a verified write but does not bypass error backoff', async () => {
  let calls = 0;
  let failed = false;
  const cache = createQuotaCache({ now: () => 0, load: async () => {
    calls++;
    if (failed) throw new QuotaError('NETWORK');
    return { configured: true, accounts: [] };
  } });
  await cache.read();
  await cache.refresh();
  assert.equal(calls, 1);
  await cache.refresh({ afterWrite: true });
  assert.equal(calls, 2);
  failed = true;
  await cache.refresh({ afterWrite: true });
  await cache.refresh({ afterWrite: true });
  assert.equal(calls, 3);
});
