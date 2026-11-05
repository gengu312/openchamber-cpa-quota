import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { parseQuotas } from '../src/parse.mjs';
import { toNative } from '../src/view.mjs';
import { parseResetCredits } from '../src/reset-credits.mjs';
import { quotaFixture, resetFixture } from './helpers.mjs';
import { readQuotaRequest } from '../src/service.mjs';

test('pinned host schemas: main accepts native, released 2.6.1 refuses it; both accept compat', async (t) => {
  try { await access('.cache/contracts/main/src/parse.ts'); await access('dist/native/package.json'); }
  catch { t.skip('Run npm run contracts:fetch and npm run build for pinned host verification'); return; }
  const native = JSON.parse(await readFile('dist/native/package.json', 'utf8'));
  const compat = JSON.parse(await readFile('dist/desktop-compat/package.json', 'utf8'));
  for (const kind of ['main', 'release']) {
    await build({ stdin: {
      contents: `export {parseManifest} from './src/parse.ts'; export * from './src/service-providers.ts'; export * from './src/service-provider-schemas.ts';`,
      resolveDir: resolve(`.cache/contracts/${kind}`), loader: 'ts',
    }, outfile: `.cache/contracts/${kind}/test-bundle.mjs`, bundle: true, platform: 'node', format: 'esm', packages: 'external' });
    const official = await import(pathToFileURL(resolve(`.cache/contracts/${kind}/test-bundle.mjs`)));
    assert.equal(official.parseManifest(compat).ok, true);
    const result = official.parseManifest(native);
    assert.equal(result.ok, kind === 'main');
    if (kind === 'release') assert.equal(result.code, 'invalid-service');
    if (kind === 'main') {
      const request = JSON.stringify({ v: 1, requestId: 'test', provider: 'ext-cpa-quota', method: 'usage.read', input: { credentials: {} } });
      assert(official.readQuotaProviderRequest(request));
      assert(readQuotaRequest(request));
      const fixture = parseQuotas(await quotaFixture());
      const now = Date.parse('2026-11-05T06:01:00Z');
      const snapshot = { data: fixture, stale: false, fetchedAt: now };
      const reset = { data: parseResetCredits(await resetFixture()), stale: false, fetchedAt: now };
      for (const data of [toNative(snapshot, now, reset), toNative({ data: null, errorCode: 'NETWORK' }, now)]) {
        const parsed = official.quotaProviderSchemasV1.usage.safeParse(data);
        assert.equal(parsed.success, true, parsed.error?.message);
        assert.equal(official.quotaProviderSchemasV1.envelope.safeParse({ ok: true, data }).success, true);
      }
    }
  }
});
