import { createUpstream, validateOrigin } from './upstream.mjs';
import { createQuotaCache } from './cache.mjs';
import { createService } from './service.mjs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createResetReader, createResetDirectory } from './reset-credits.mjs';
import { createResetConsumer } from './reset-consume.mjs';
import { createResetActions } from './reset-actions.mjs';
import { createResetStore } from './reset-store.mjs';

// The host deliberately does not forward arbitrary environment variables.
// Origin is an administrator-controlled, non-secret file, never a request parameter.
async function main() {
  const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
  const token = process.env.OPENCHAMBER_SERVICE_TOKEN;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) throw new Error('env');
  let config = {};
  try {
    const text = await readFile(join(homedir(), '.config', 'openchamber-cpa-quota', 'config.json'), 'utf8');
    if (Buffer.byteLength(text) > 4096) throw new Error('config');
    config = JSON.parse(text);
    if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some((key) => key !== 'origin')) throw new Error('config');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('config');
  }
  const origin = validateOrigin(config.origin);
  const cache = createQuotaCache({ load: createUpstream({ origin }) });
  const directory = createResetDirectory();
  const resetCache = createQuotaCache({ load: createResetReader({ origin, directory }), ttlMs: 60_000, retryMs: 60_000, retentionMs: 600_000 });
  // No setting or environment variable can enable production writes in this delivery.
  const resetActions = await createResetActions({ enabled: false,
    readCredits: resetCache.read, resolveTarget: directory.resolve,
    perform: createResetConsumer({ origin, enabled: false }),
    refreshQuota: cache.refresh, refreshCredits: resetCache.refresh,
    store: createResetStore(join(homedir(), '.config', 'openchamber-cpa-quota', 'reset-operations.json')),
  });
  const server = createService({ token, cache, resetCache, resetActions });
  server.on('error', () => { console.error('CPA quota service could not start'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1');
  const stop = () => { server.close(); server.closeAllConnections(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

main().catch(() => { console.error('CPA quota service configuration is invalid'); process.exitCode = 1; });
