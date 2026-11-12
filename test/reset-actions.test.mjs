import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResetActions, RESET_CONFIRMATION } from '../src/reset-actions.mjs';
import { createResetConsumer, classifyConsumeResponse, UUID4, RESET_CONSUME_PATH } from '../src/reset-consume.mjs';
import { createResetDirectory, parseResetCredits } from '../src/reset-credits.mjs';
import { DEFAULT_ORIGIN } from '../src/upstream.mjs';
import { deferred, json, resetFixture } from './helpers.mjs';

async function setup(options = {}) {
  const raw = await resetFixture();
  let now = Date.parse('2026-11-05T06:01:00Z');
  const directory = createResetDirectory();
  let data = parseResetCredits(raw);
  directory.replace(raw, data);
  const snapshot = () => ({ data, fetchedAt: now, stale: false, errorCode: null });
  let calls = [];
  let saved = [];
  let refreshes = [];
  const flow = await createResetActions({ enabled: true, now: () => now, readCredits: async () => snapshot(), resolveTarget: directory.resolve,
    perform: async (body) => { calls.push(body); return { status: 'succeeded' }; },
    refreshQuota: async () => { refreshes.push('quota'); return snapshot(); }, refreshCredits: async () => { refreshes.push('credits'); return snapshot(); },
    store: { load: async () => [], save: async (operations) => { saved = structuredClone(operations); } }, ...options });
  const selection = () => ({ targetId: data.accounts[0].id, sourceRevision: data.accounts[0].sourceRevision, acknowledge: true });
  return { flow, calls, refreshes, selection, saved: () => saved, raw,
    advance(ms) { now += ms; },
    update() { data = parseResetCredits(raw); directory.replace(raw, data); },
  };
}
const confirm = (flow, op) => flow.confirm({ operationId: op.operationId, confirmation: RESET_CONFIRMATION });

test('account-level selection from same GET record, UUID4, no card prerequisites; second confirmation', async () => {
  const ctx = await setup();
  await assert.rejects(ctx.flow.prepare({ ...ctx.selection(), acknowledge: false }), { code: 'ACKNOWLEDGEMENT_REQUIRED' });
  const op = await ctx.flow.prepare(ctx.selection());
  assert(UUID4.test(op.redeemRequestId));
  assert.equal(op.operationId, op.redeemRequestId);
  assert.equal(op.workspace.startsWith('工作区 · '), true);
  assert(!JSON.stringify(op).includes('synthetic-workspace'));
  assert.equal(ctx.calls.length, 0);
  await assert.rejects(ctx.flow.confirm({ operationId: op.operationId, confirmation: '' }), { code: 'CONFIRMATION_INVALID' });
  const result = await confirm(ctx.flow, op);
  assert.equal(result.state, 'succeeded');
  assert.deepEqual(ctx.calls, [{ accountId: ctx.raw.accounts[0].account_id, workspaceId: ctx.raw.accounts[0].workspace_id, redeemRequestId: op.redeemRequestId }]);
  assert.deepEqual(ctx.refreshes.sort(), ['credits', 'quota']);
});

test('cancel does not send; exact repeated selection cannot mint a new UUID', async () => {
  const ctx = await setup();
  const op = await ctx.flow.prepare(ctx.selection());
  assert.equal((await ctx.flow.cancel({ operationId: op.operationId })).state, 'cancelled');
  assert.equal((await ctx.flow.prepare(ctx.selection())).operationId, op.operationId);
  assert.equal((await confirm(ctx.flow, op)).state, 'cancelled');
  assert.equal(ctx.calls.length, 0);
});

test('cross-client prepare and confirm single flight, one UUID, no repeated logical request', async () => {
  const gate = deferred();
  let count = 0;
  const ctx = await setup({ perform: async () => { count++; return gate.promise; } });
  const [a, b] = await Promise.all([ctx.flow.prepare(ctx.selection()), ctx.flow.prepare(ctx.selection())]);
  assert.equal(a.operationId, b.operationId);
  const running = confirm(ctx.flow, a);
  assert.equal((await confirm(ctx.flow, b)).state, 'running');
  gate.resolve({ status: 'succeeded' });
  await running;
  assert.equal((await confirm(ctx.flow, a)).state, 'succeeded');
  assert.equal((await ctx.flow.prepare(ctx.selection())).operationId, a.operationId);
  assert.equal(count, 1);
});

test('same account in another workspace stays locked; selection changes never retarget a confirmed action', async () => {
  const ctx = await setup();
  const op = await ctx.flow.prepare(ctx.selection());
  ctx.raw.accounts[0].workspace_id = 'different-workspace';
  ctx.update();
  await assert.rejects(ctx.flow.prepare(ctx.selection()), { code: 'ACCOUNT_LOCKED' });
  assert.equal((await confirm(ctx.flow, op)).state, 'rejected');
  assert.equal(ctx.calls.length, 0);
});

test('unknown/zero/error/missing-workspace accounts and expired confirmations fail closed', async () => {
  for (const patch of [{ available_count: 0 }, { available_count: null }, { workspace_id: null }, { error: 'private error' }]) {
    const ctx = await setup(); Object.assign(ctx.raw.accounts[0], patch); ctx.update();
    await assert.rejects(ctx.flow.prepare(ctx.selection()), { code: 'SELECTION_CHANGED' });
  }
  const ctx = await setup();
  const op = await ctx.flow.prepare(ctx.selection());
  ctx.advance(61000);
  await assert.rejects(confirm(ctx.flow, op), { code: 'CONFIRMATION_INVALID' });
  assert.equal(ctx.calls.length, 0);
});

test('changed source counts/revision cannot consume stale selection or silently retarget', async () => {
  const ctx = await setup();
  const op = await ctx.flow.prepare(ctx.selection());
  ctx.raw.accounts[0].available_count = 1; ctx.update();
  assert.equal((await confirm(ctx.flow, op)).code, 'SELECTION_CHANGED');
  assert.equal(ctx.calls.length, 0);
});

test('timeout is unknown, no auto retry, explicit review refreshes both but cannot infer success from counts', async () => {
  const gate = deferred();
  let count = 0;
  const ctx = await setup({ timeoutMs: 10, perform: async () => { count++; return gate.promise; } });
  const op = await ctx.flow.prepare(ctx.selection());
  assert.equal((await confirm(ctx.flow, op)).state, 'outcome-unknown');
  gate.resolve({ status: 'succeeded' });
  assert.equal((await ctx.flow.review({ operationId: op.operationId })).state, 'outcome-unknown');
  ctx.raw.generated_at = '2026-11-05T06:01:01Z'; ctx.update();
  await assert.rejects(ctx.flow.prepare(ctx.selection()), { code: 'ACCOUNT_LOCKED' });
  assert.equal(count, 1);
  assert.deepEqual(ctx.refreshes.sort(), ['credits', 'quota']);
});

test('journal preserves running/unknown locks across restart; no raw target or key persisted', async () => {
  const ctx = await setup({ perform: async () => ({ status: 'outcome-unknown', code: 'NETWORK' }) });
  const op = await ctx.flow.prepare(ctx.selection());
  await confirm(ctx.flow, op);
  const records = ctx.saved();
  assert.equal(ctx.flow.forTarget(ctx.selection().targetId).state, 'outcome-unknown');
  assert(!JSON.stringify(records).includes(ctx.raw.accounts[0].account_id));
  assert(!JSON.stringify(records).includes(ctx.raw.accounts[0].workspace_id));
  records[0].state = 'running';
  const restarted = await createResetActions({ enabled: true, store: { load: async () => records, save: async () => {} } });
  assert.equal(restarted.status({ operationId: op.operationId }).state, 'outcome-unknown');
  assert.equal((await confirm(restarted, op)).state, 'outcome-unknown');
});

test('durable lock required before transport; refresh failure after verified mock success never repeats write', async () => {
  let calls = 0;
  const broken = await setup({ store: { load: async () => [], save: async () => { throw new Error(); } }, perform: async () => { calls++; } });
  await assert.rejects(broken.flow.prepare(broken.selection()), { code: 'JOURNAL_UNAVAILABLE' });
  assert.equal(calls, 0);
  const ctx = await setup({ refreshCredits: async () => { throw new Error(); } });
  const op = await ctx.flow.prepare(ctx.selection());
  assert.equal((await confirm(ctx.flow, op)).state, 'refresh-required');
  assert.equal((await confirm(ctx.flow, op)).state, 'refresh-required');
  assert.equal(ctx.calls.length, 1);
});

test('production disabled action and consumer do not read credentials or invoke transport', async () => {
  const nope = () => { throw new Error('must not be reached'); };
  const flow = await createResetActions({ enabled: false, readCredits: nope, perform: nope });
  await assert.rejects(flow.prepare({}), { code: 'DISABLED' });
  const consume = createResetConsumer({ enabled: false, loadCredential: nope, fetchImpl: nope });
  assert.deepEqual(await consume({}), { status: 'not-sent', code: 'DISABLED' });
});

test('consume request exact user contract, fixed origin and bearer, standard UUID4, no card IDs', async () => {
  const body = JSON.parse(await (await import('node:fs/promises')).readFile('fixtures/reset-consume-request.synthetic.json', 'utf8'));
  let calls = 0;
  const consume = createResetConsumer({ enabled: true, loadCredential: async () => ({ origin: DEFAULT_ORIGIN, key: 'SYNTHETIC' }), fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, `${DEFAULT_ORIGIN}${RESET_CONSUME_PATH}`);
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.authorization, 'Bearer SYNTHETIC');
    assert.equal(options.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), body);
    return json({ success: true });
  } });
  const result = await consume({ accountId: body.account_id, workspaceId: body.workspace_id, redeemRequestId: body.redeem_request_id });
  assert.equal(result.status, 'outcome-unknown', '200 and success:true are not a verified response contract');
  assert.equal(calls, 1);
});

test('consume failures: 403 generic not feature-switch assertion; redirects, timeout and unknown 200 never retried', async () => {
  const target = { accountId: 'synthetic', workspaceId: 'synthetic-workspace', redeemRequestId: '12345678-1234-4234-9234-123456789abc' };
  for (const status of [200, 302, 403, 409, 500]) {
    let calls = 0;
    const consume = createResetConsumer({ enabled: true, loadCredential: async () => ({ origin: DEFAULT_ORIGIN, key: 'SYNTHETIC' }), fetchImpl: async () => { calls++; return json({ error: 'private email/key' }, status); } });
    const result = await consume(target);
    assert.equal(result.status, status === 403 ? 'rejected' : 'outcome-unknown');
    if (status === 403) assert.equal(result.code, 'FORBIDDEN');
    assert(!JSON.stringify(result).includes('private'));
    assert.equal(calls, 1);
  }
  const consume = createResetConsumer({ enabled: true, timeoutMs: 10, loadCredential: async () => ({ origin: DEFAULT_ORIGIN, key: 'SYNTHETIC' }), fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error()), { once: true })) });
  assert.deepEqual(await consume(target), { status: 'outcome-unknown', code: 'TIMEOUT' });
});

test('consume validates targets/UUID before credentials, bounds response, only verified mock response may succeed', async () => {
  const target = { accountId: 'synthetic', workspaceId: 'synthetic-workspace', redeemRequestId: '12345678-1234-4234-9234-123456789abc' };
  const never = () => { throw new Error('unexpected'); };
  const invalid = createResetConsumer({ enabled: true, loadCredential: never, fetchImpl: never });
  assert.equal((await invalid({ ...target, redeemRequestId: 'not-uuid4' })).status, 'not-sent');
  assert.equal((await invalid({ ...target, workspaceId: '' })).status, 'not-sent');
  const wrongOrigin = createResetConsumer({ enabled: true, loadCredential: async () => ({ origin: 'https://evil.invalid', key: 'SYNTHETIC' }), fetchImpl: never });
  assert.equal((await wrongOrigin(target)).code, 'CREDENTIAL');
  const large = createResetConsumer({ enabled: true, maxBytes: 10, loadCredential: async () => ({ origin: DEFAULT_ORIGIN, key: 'SYNTHETIC' }), fetchImpl: async () => json({ large: 'x'.repeat(100) }) });
  assert.equal((await large(target)).code, 'TOO_LARGE');
  const classified = createResetConsumer({ enabled: true, loadCredential: async () => ({ origin: DEFAULT_ORIGIN, key: 'SYNTHETIC' }), fetchImpl: async () => json({ mockOnlyVerified: true }),
    classifyResponse: (status, body) => status === 200 && body.mockOnlyVerified ? { status: 'succeeded' } : null });
  assert.equal((await classified(target)).status, 'succeeded');
});

test('wrapped-service contract classifier: 200 success, 409/403 rejected, 502 unknown, rest unverified', async () => {
  // Direct classifier unit checks against the hosting service's documented contract.
  assert.deepEqual(classifyConsumeResponse(200, { success: true, account: 'x', redeem_request_id: 'r', before: 2, after: 1 }), { status: 'succeeded' });
  assert.deepEqual(classifyConsumeResponse(409, { error: 'no available reset credit' }), { status: 'rejected', code: 'NO_CREDITS' });
  assert.deepEqual(classifyConsumeResponse(409, { error: 'redeem_request_id bound to another account' }), { status: 'rejected', code: 'NO_CREDITS' });
  assert.deepEqual(classifyConsumeResponse(403, { error: 'consume disabled' }), { status: 'rejected', code: 'FORBIDDEN' });
  assert.deepEqual(classifyConsumeResponse(502, { success: false, outcome: 'unknown' }), { status: 'outcome-unknown', code: 'OUTCOME_UNKNOWN' });
  // Anything not in the contract stays unverified — including bare 200, success:false on 200,
  // and a 502 without outcome:"unknown". Real upstream business success is NOT trusted here.
  for (const [s, b] of [[200, { success: false }], [200, {}], [200, { success: 'true' }], [502, { success: false }], [502, {}], [500, { error: 'x' }], [201, { success: true }]]) {
    assert.deepEqual(classifyConsumeResponse(s, b), { status: 'outcome-unknown', code: 'RESPONSE_UNVERIFIED' });
  }
});

test('consumer wired with contract classifier: success and idempotent replay recognised, unknown stays locked', async () => {
  const target = { accountId: 'synthetic', workspaceId: 'synthetic-workspace', redeemRequestId: '12345678-1234-4234-9234-123456789abc' };
  const cred = async () => ({ origin: DEFAULT_ORIGIN, key: 'SYNTHETIC' });
  // Verified success.
  const ok = createResetConsumer({ enabled: true, loadCredential: cred, classifyResponse: classifyConsumeResponse, fetchImpl: async () => json({ success: true, before: 2, after: 1 }) });
  assert.deepEqual(await ok(target), { status: 'succeeded' });
  // Deduped replay of a recorded success returns the stored result (also success:true).
  const replay = createResetConsumer({ enabled: true, loadCredential: cred, classifyResponse: classifyConsumeResponse, fetchImpl: async () => json({ success: true, replay: true }) });
  assert.equal((await replay(target)).status, 'succeeded');
  // No available credit.
  const noCredit = createResetConsumer({ enabled: true, loadCredential: cred, classifyResponse: classifyConsumeResponse, fetchImpl: async () => json({ error: 'no available reset credit' }, 409) });
  assert.deepEqual(await noCredit(target), { status: 'rejected', code: 'NO_CREDITS' });
  // Unknown outcome: stays locked, never auto-retried, no private field leaks.
  const unknown = createResetConsumer({ enabled: true, loadCredential: cred, classifyResponse: classifyConsumeResponse, fetchImpl: async () => json({ success: false, outcome: 'unknown', detail: 'private upstream' }, 502) });
  const ures = await unknown(target);
  assert.equal(ures.status, 'outcome-unknown');
  assert.equal(ures.code, 'OUTCOME_UNKNOWN');
  assert(!JSON.stringify(ures).includes('private'));
});

test('prepare cannot expose awaiting-confirmation before the durable snapshot has finished saving', async () => {
  const save = deferred();
  let count = 0;
  let saved;
  const ctx = await setup({ store: { load: async () => [], save: async (value) => {
    count++; saved = value;
    if (count === 2) await save.promise;
  } } });
  let done = false;
  const first = ctx.flow.prepare(ctx.selection()).then((op) => { done = true; return op; });
  while (count < 2) await new Promise((resolve) => setImmediate(resolve));
  const second = ctx.flow.prepare(ctx.selection());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  assert.equal(saved[0].state, 'awaiting-confirmation');
  save.resolve();
  assert.equal((await first).operationId, (await second).operationId);
});
