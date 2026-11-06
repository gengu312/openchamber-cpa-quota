import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupWindows, normalizeOrder, orderAccounts, moveAccount, placeAccount, resetCountdown, remainingTone, percentText, formatCompact, accountFreshness, accountSummary, orderFocusControl } from '../panel/view-model.mjs';

const accounts = ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc'].map((id) => ({ id }));

test('panel order validates stored IDs, keeps unseen accounts, and never drops an account', () => {
  assert.deepEqual(normalizeOrder(['bbbbbbbbbbbb', 'bad', 'bbbbbbbbbbbb', null]), ['bbbbbbbbbbbb']);
  assert.deepEqual(orderAccounts(accounts, ['bbbbbbbbbbbb', 'dddddddddddd']).map((a) => a.id), ['bbbbbbbbbbbb', 'aaaaaaaaaaaa', 'cccccccccccc']);
  assert.deepEqual(moveAccount(accounts, [], 'aaaaaaaaaaaa', 1), ['bbbbbbbbbbbb', 'aaaaaaaaaaaa', 'cccccccccccc']);
  assert.deepEqual(moveAccount(accounts, [], 'aaaaaaaaaaaa', -1), accounts.map((a) => a.id));
  assert.deepEqual(placeAccount(accounts, [], 'cccccccccccc', 'aaaaaaaaaaaa'), ['cccccccccccc', 'aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
  assert.deepEqual(placeAccount(accounts, [], 'missing', 'aaaaaaaaaaaa'), accounts.map((a) => a.id));
});

test('local time ages readings without requests; failed read invalidates health and fresh-only low count', () => {
  const now = 1_000_000;
  const account = { updatedAt: now, upstreamStale: false, status: 'available', error: false, windows: [{ remainingPercent: 10 }] };
  const snapshot = { data: { updatedAt: now }, stale: false };
  assert.equal(accountFreshness(account, snapshot, now), 'fresh');
  assert.equal(accountFreshness(account, snapshot, now + 600_001), 'stale');
  assert.equal(accountFreshness(account, snapshot, now, true), 'stale');
  assert.equal(accountFreshness({ ...account, updatedAt: null }, { data: { updatedAt: null } }, now), 'unknown');
  assert.equal(accountFreshness({ ...account, updatedAt: now + 60_001 }, snapshot, now), 'unknown');
  assert.deepEqual(accountSummary([account], snapshot, now), { total: 1, available: 1, low: 1 });
  assert.deepEqual(accountSummary([account], snapshot, now + 600_001), { total: 1, available: 0, low: 0 });
  assert.deepEqual(accountSummary([account], snapshot, now, true), { total: 1, available: 0, low: 0 });
  assert.equal(orderFocusControl('上移', 0, 3), 'handle');
  assert.equal(orderFocusControl('下移', 2, 3), 'handle');
  assert.equal(orderFocusControl('上移', 1, 3), '上移');
});

test('compact windows group recognised pools without merging stable IDs or duplicate periods', () => {
  const groups = groupWindows([
    { id: 'c', label: 'claude/gpt · 7d', windowSeconds: 604800 },
    { id: 'b', label: 'gemini · 7d', windowSeconds: 604800 },
    { id: 'a', label: 'gemini · 5h', windowSeconds: 18000 },
    { id: 'd', label: 'gemini · 7d', windowSeconds: 604800 },
  ]);
  assert.deepEqual(groups.map((g) => g.name), ['Gemini', 'Claude / GPT']);
  assert.deepEqual(groups[0].windows.map((w) => w.id), ['a', 'b', 'd']);
});

test('countdown and quota formatting preserve unknown, exhausted and due states', () => {
  const now = Date.parse('2026-11-05T06:00:00Z');
  assert.equal(resetCountdown(null, now), '重置时间未知');
  assert.equal(resetCountdown(now - 1, now), '已到重置时间 · 待读取');
  assert.equal(resetCountdown(now + 1000, now), '1分钟后重置');
  assert.equal(resetCountdown(now + 3660_000, now), '1小时 1分后重置');
  assert.equal(resetCountdown(now + 86400_000, now), '1天后重置');
  assert.equal(percentText(0), '0%');
  assert.equal(percentText(null), '—');
  assert.equal(formatCompact(125000), '125K');
  assert.equal(remainingTone(null), 'unknown');
  assert.equal(remainingTone(0), 'error');
  assert.equal(remainingTone(20), 'warning');
  assert.equal(remainingTone(80), 'success');
});
