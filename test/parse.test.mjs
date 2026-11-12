import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuotas } from '../src/parse.mjs';
import { parseResetCredits } from '../src/reset-credits.mjs';
import { toNative, publicSnapshot } from '../src/view.mjs';
import { quotaFixture, resetFixture } from './helpers.mjs';

test('parse synthetic quota: null vs zero, usage_error keeps quota, null reset', async () => {
  const data = parseQuotas(await quotaFixture());
  const windows = data.accounts.flatMap((a) => a.windows);
  assert.equal(windows.length, 4);
  const zero = windows.find((w) => w.usedPercent === 0);
  assert.equal(zero.remainingPercent, 100);
  assert.equal(zero.resetAt, null);
  assert.equal(zero.currentTokens, null);
  assert.equal(zero.usageError, true);
  assert.equal(windows.find((w) => w.remainingPercent === 0).usedPercent, 100);
  assert.equal(windows.find((w) => w.currentTokens !== null).currentTokens, 125000);
});

test('missing and invalid numeric values stay unknown; valid zero values preserved', async () => {
  const fixture = await quotaFixture();
  const window = fixture.accounts[0].windows[0];
  Object.assign(window, { used_percent: null, remaining_percent: null, current_tokens: 0, current_cost: 0, estimated_cost: '0', resets_at: 'tomorrow', duration_seconds: 0 });
  const parsed = parseQuotas(fixture).accounts.find((a) => a.provider === 'antigravity').windows.find((w) => w.windowSeconds === null);
  assert.equal(parsed.usedPercent, null);
  assert.equal(parsed.remainingPercent, null);
  assert.equal(parsed.currentTokens, 0);
  assert.equal(parsed.currentCost, 0);
  assert.equal(parsed.estimatedCost, null);
  assert.equal(parsed.resetAt, null);
});

test('derive complement only when a valid percentage exists; inconsistent data unknown', async () => {
  const fixture = await quotaFixture();
  fixture.accounts[0].windows[0].used_percent = null;
  fixture.accounts[0].windows[0].remaining_percent = 25;
  fixture.accounts[0].windows[1].remaining_percent = 99;
  const windows = parseQuotas(fixture).accounts.find((a) => a.provider === 'antigravity').windows;
  assert(windows.some((w) => w.usedPercent === 75));
  assert(windows.some((w) => w.inconsistent && w.usedPercent === null && w.remainingPercent === null));
});

test('stable identities independent of order and labels; repeated labels/pools not merged', async () => {
  const fixture = await quotaFixture();
  const first = parseQuotas(fixture);
  const second = structuredClone(fixture);
  second.accounts.reverse();
  second.accounts.forEach((a) => { a.label = 'same private label'; a.windows.reverse(); a.windows.forEach((w) => { w.label = 'same'; }); });
  assert.deepEqual(first.accounts.map((a) => a.id).sort(), parseQuotas(second).accounts.map((a) => a.id).sort());
  fixture.accounts[0].windows.push({ ...fixture.accounts[0].windows[0], quota_group: 'another-pool' });
  assert.equal(parseQuotas(fixture).accounts.find((a) => a.provider === 'antigravity').windows.length, 3);
});

test('raw identifiers, arbitrary labels, plans and errors never cross client boundary', async () => {
  const fixture = await quotaFixture();
  const marker = 'private@example.invalid SECRET_RAW https://private.invalid';
  fixture.error = marker;
  fixture.accounts.forEach((a) => { a.label = marker; a.plan = marker; a.error = marker; a.windows.forEach((w) => { w.label = marker; w.usage_error = marker; w.estimate_basis = marker; }); });
  const parsed = parseQuotas(fixture);
  const output = JSON.stringify(parsed);
  assert(!output.includes('private@'));
  assert(!output.includes('SECRET_RAW'));
  assert(!output.includes('synthetic-codex-1'));
  assert.equal(parsed.upstreamError, true);
});

test('reset keys link via quota_account_id, never the consume account_id', async () => {
  const quota = parseQuotas(await quotaFixture());
  const credits = parseResetCredits(await resetFixture());
  const codex = quota.accounts.find((a) => a.provider === 'codex');
  const credit = credits.accounts[0];
  assert.equal(codex.resetKey, credit.resetKey);
  assert.match(codex.resetKey, /^[0-9a-f]{12}$/);
  const output = JSON.stringify({ quota, credits });
  assert(!output.includes('synthetic-codex-1'));
  assert(!output.includes('synthetic-reset-op-1'));
  assert(!output.includes('synthetic@example.invalid'));
  // A non-codex quota account matches nothing.
  const claude = quota.accounts.find((a) => a.provider === 'claude');
  assert.notEqual(claude.resetKey, credit.resetKey);
  // Matching is keyed on quota_account_id: changing the consume account_id keeps the link,
  // changing quota_account_id breaks it, and a missing quota_account_id never matches.
  const raw = await resetFixture();
  raw.accounts[0].account_id = 'completely-different-op-id';
  assert.equal(parseResetCredits(raw).accounts[0].resetKey, codex.resetKey);
  const broken = await resetFixture();
  broken.accounts[0].quota_account_id = 'some-other-quota-id';
  assert.notEqual(parseResetCredits(broken).accounts[0].resetKey, codex.resetKey);
  const missing = await resetFixture();
  delete missing.accounts[0].quota_account_id;
  assert.equal(parseResetCredits(missing).accounts[0].resetKey, null);
});

test('schema drift rejects unusable envelope, skips individual malformed entries', async () => {
  for (const raw of [null, [], {}, { configured: true, refreshing: false, accounts: {} }]) assert.throws(() => parseQuotas(raw), { code: 'SCHEMA' });
  const fixture = await quotaFixture();
  fixture.accounts.push(null);
  fixture.accounts[0].windows.push({ label: 'missing-id' });
  const data = parseQuotas(fixture);
  assert.equal(data.invalidItems, 2);
  assert.equal(data.accounts.length, 3);
  fixture.accounts = [null];
  assert.throws(() => parseQuotas(fixture), { code: 'SCHEMA' });
});

test('native mapping shows each window, preserves nulls, flags stale and does not sum', async () => {
  const data = parseQuotas(await quotaFixture());
  const now = Date.parse('2026-11-05T06:01:00Z');
  const native = toNative({ data, fetchedAt: now, stale: false, errorCode: null }, now);
  assert.equal(Object.keys(native.usage.windows).length, 4);
  assert(!native.usage.models);
  assert.equal(native.ok, true);
  assert.match(native.error, /旧数据/);
  assert(Object.values(native.usage.windows).some((w) => w.usedPercent === 0 && w.resetAt === null));
  assert(Object.values(native.usage.windows).some((w) => /旧数据/.test(w.valueLabel)));
  assert(!('totalPercent' in native));
});

test('source age, missing source date and stale cache never presented as fresh', async () => {
  const data = parseQuotas(await quotaFixture());
  const now = Date.parse('2026-11-05T07:00:00Z');
  assert(publicSnapshot({ data, stale: false }, now).data.accounts.every((a) => a.freshness === 'stale'));
  data.updatedAt = null;
  data.accounts.forEach((a) => { a.updatedAt = null; a.upstreamStale = false; });
  assert(publicSnapshot({ data, stale: false }, now).data.accounts.every((a) => a.freshness === 'unknown'));
  assert(publicSnapshot({ data, stale: true }, now).data.accounts.every((a) => a.freshness === 'stale'));
});

test('native capacity includes read-only card counts; never silently truncates', async () => {
  const data = parseQuotas(await quotaFixture());
  const account = data.accounts[0];
  account.windows = Array.from({ length: 33 }, (_, i) => ({ ...account.windows[0], id: `w${i}` }));
  const output = toNative({ data, stale: false }, Date.parse('2026-11-05T06:01:00Z'));
  assert.equal(output.usage, null);
  assert.match(output.error, /32/);
});
