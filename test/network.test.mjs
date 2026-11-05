import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUpstream, validateOrigin, DEFAULT_ORIGIN } from '../src/upstream.mjs';
import { createResetReader, parseResetCredits, loadResetCredential } from '../src/reset-credits.mjs';
import { parseQuotas } from '../src/parse.mjs';
import { json, quotaFixture, resetFixture } from './helpers.mjs';

test('quota uses fixed GET without host tokens or reset key; no arbitrary URL/config path', async () => {
  for (const origin of ['http://example.invalid', 'https://user:password@example.invalid', 'https://example.invalid/path', 'https://example.invalid/?x=y', 'file:///etc/passwd']) assert.throws(() => validateOrigin(origin));
  let count = 0;
  const raw = await quotaFixture();
  const read = createUpstream({ fetchImpl: async (url, options) => {
    count++;
    assert.equal(url, `${DEFAULT_ORIGIN}/quota/api/quotas`);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    assert.deepEqual(options.headers, { accept: 'application/json' });
    return json(raw);
  } });
  await read();
  assert.equal(count, 1);
});

test('upstream rejects HTTP failure, redirects, wrong content type, JSON and malformed schema', async () => {
  const cases = [
    [() => new Response('', { status: 302, headers: { location: 'https://evil.invalid' } }), 'REDIRECT'],
    [() => new Response('secret raw body', { status: 500 }), 'HTTP'],
    [() => new Response('<html>private</html>', { headers: { 'content-type': 'text/html' } }), 'CONTENT_TYPE'],
    [() => new Response('{', { headers: { 'content-type': 'application/json' } }), 'JSON'],
    [() => json({}), 'SCHEMA'],
  ];
  for (const [response, code] of cases) await assert.rejects(createUpstream({ fetchImpl: async () => response() })(), { code });
});

test('both readers bound declared and chunked/decompressed response sizes', async () => {
  for (const factory of [createUpstream, (options) => createResetReader({ ...options, loadCredential: async () => ({ origin: DEFAULT_ORIGIN, key: 'SYNTHETIC' }) })]) {
    await assert.rejects(factory({ maxBytes: 20, fetchImpl: async () => new Response('x', { headers: { 'content-type': 'application/json', 'content-length': '100' } }) })(), { code: 'TOO_LARGE' });
    await assert.rejects(factory({ maxBytes: 20, fetchImpl: async () => new Response('x'.repeat(100), { headers: { 'content-type': 'application/json' } }) })(), { code: 'TOO_LARGE' });
  }
});

test('timeouts cover headers and streaming body; network errors contain no raw messages', async () => {
  const pending = async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('private URL')), { once: true }));
  for (const factory of [createUpstream, (options) => createResetReader({ ...options, loadCredential: async () => ({ origin: DEFAULT_ORIGIN, key: 'SYNTHETIC' }) })]) {
    await assert.rejects(factory({ timeoutMs: 10, fetchImpl: pending })(), { code: 'TIMEOUT', message: 'TIMEOUT' });
    await assert.rejects(factory({ fetchImpl: async () => { throw new Error('secret'); } })(), { code: 'NETWORK', message: 'NETWORK' });
  }
  await assert.rejects(createUpstream({ timeoutMs: 10, fetchImpl: async (_url, { signal }) => {
    return new Response(new ReadableStream({ start(controller) { signal.addEventListener('abort', () => controller.error(new Error('timeout')), { once: true }); } }), { headers: { 'content-type': 'application/json' } });
  } })(), { code: 'TIMEOUT' });
});

test('reset credits authenticated only at pinned endpoint; never follows bearer redirects', async () => {
  let calls = 0;
  const read = createResetReader({ loadCredential: async () => ({ origin: DEFAULT_ORIGIN, key: 'SYNTHETIC_ONLY' }), fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, `${DEFAULT_ORIGIN}/quota/api/codex/reset-credits`);
    assert.equal(options.headers.authorization, 'Bearer SYNTHETIC_ONLY');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 307, headers: { location: 'https://evil.invalid' } });
  } });
  await assert.rejects(read(), { code: 'REDIRECT' });
  assert.equal(calls, 1);
  await assert.rejects(createResetReader({ loadCredential: async () => ({ origin: 'https://evil.invalid', key: 'SYNTHETIC' }), fetchImpl: async () => { throw new Error('must not send'); } })(), { code: 'CREDENTIAL' });
});

test('reset query handles zero, unknown, sanitized error and does not bind quota account', async () => {
  const fixture = await resetFixture();
  const quota = parseQuotas(await quotaFixture());
  const data = await createResetReader({ loadCredential: async () => ({ origin: DEFAULT_ORIGIN, key: 'SYNTHETIC' }), fetchImpl: async () => json(fixture) })();
  assert.equal(data.accounts[0].availableCount, 2);
  assert(!quota.accounts.some((a) => a.id === data.accounts[0].id));
  fixture.accounts[0].available_count = 0;
  assert.equal(parseResetCredits(fixture).accounts[0].availableCount, 0);
  fixture.accounts[0].available_count = null;
  fixture.accounts[0].error = 'private@example.invalid secret';
  const output = parseResetCredits(fixture);
  assert.equal(output.accounts[0].availableCount, null);
  assert.equal(output.accounts[0].error, true);
  assert(!JSON.stringify(output).includes('example.invalid'));
  assert(!JSON.stringify(output).includes('synthetic-workspace'));
});

test('reset credentials absent/refused: no fallback to quota token or management secrets', async () => {
  await assert.rejects(createResetReader({ loadCredential: async () => null })(), { code: 'CREDENTIAL' });
  await assert.rejects(createResetReader({ loadCredential: async () => ({ origin: DEFAULT_ORIGIN, key: 'SYNTHETIC' }), fetchImpl: async () => new Response('private', { status: 401 }) })(), { code: 'CREDENTIAL' });
});

test('credential loader validates exact origin/path and bearer shape using in-memory fake files only', async () => {
  const value = { origin: DEFAULT_ORIGIN, resetCreditsPath: '/quota/api/codex/reset-credits', resetApiKey: 'SYNTHETIC_NOT_REAL' };
  const readText = async (path) => { assert.match(path, /openchamber-cpa-quota[\\/]credentials.json$/); return JSON.stringify(value); };
  assert.deepEqual(await loadResetCredential({ readText }), { origin: DEFAULT_ORIGIN, key: 'SYNTHETIC_NOT_REAL' });
  for (const patch of [{ origin: 'https://evil.invalid' }, { resetCreditsPath: '/consume' }, { resetApiKey: 'bad\nheader' }, { resetApiKey: '' }]) {
    await assert.rejects(loadResetCredential({ readText: async () => JSON.stringify({ ...value, ...patch }) }), { code: 'CREDENTIAL', message: 'CREDENTIAL' });
  }
  await assert.rejects(loadResetCredential({ readText: async () => '{' }), { code: 'CREDENTIAL' });
  assert.equal(await loadResetCredential({ readText: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } }), null);
});

test('public build uses only an explicit administrator origin and binds the reset key to it', async () => {
  const origin = 'https://my-quota.example.invalid:9443';
  const credential = { origin, resetCreditsPath: '/quota/api/codex/reset-credits', resetApiKey: 'SYNTHETIC_CONFIG_ONLY' };
  const readText = async () => JSON.stringify(credential);
  assert.deepEqual(await loadResetCredential({ expectedOrigin: origin, readText }), { origin, key: credential.resetApiKey });
  await assert.rejects(loadResetCredential({ expectedOrigin: DEFAULT_ORIGIN, readText }), { code: 'CREDENTIAL' });
  await assert.rejects(createResetReader({ origin, loadCredential: async () => ({ origin: DEFAULT_ORIGIN, key: credential.resetApiKey }), fetchImpl: async () => { throw new Error('must not send'); } })(), { code: 'CREDENTIAL' });
  let calls = 0;
  await createResetReader({ origin, loadCredential: async () => ({ origin, key: credential.resetApiKey }), fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, `${origin}/quota/api/codex/reset-credits`);
    assert.equal(options.headers.authorization, `Bearer ${credential.resetApiKey}`);
    return json(await resetFixture());
  } })();
  assert.equal(calls, 1);
  assert.throws(() => validateOrigin('https://:synthetic@quota.example.invalid'));
});
