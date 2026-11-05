export function createQuotaCache({ load, now = Date.now, ttlMs = 30_000, retryMs = 30_000, retentionMs = 86_400_000 }) {
  let data = null;
  let fetchedAt = null;
  let lastAttemptAt = null;
  let nextAttemptAt = 0;
  let errorCode = null;
  let pending = null;

  const snapshot = () => ({
    data: fetchedAt !== null && now() - fetchedAt <= retentionMs ? data : null,
    fetchedAt, lastAttemptAt,
    stale: errorCode !== null || (fetchedAt !== null && now() - fetchedAt >= ttlMs),
    errorCode,
  });

  async function read() {
    if (pending) { await pending; return snapshot(); }
    if (now() < nextAttemptAt) return snapshot();
    lastAttemptAt = now();
    pending = (async () => {
      try {
        const next = await load();
        if (!next.configured || (next.upstreamError && next.accounts.length === 0)) {
          errorCode = !next.configured ? 'NOT_CONFIGURED' : 'UPSTREAM';
          nextAttemptAt = now() + retryMs;
          return;
        }
        data = next;
        fetchedAt = now();
        errorCode = null;
        nextAttemptAt = now() + ttlMs;
      } catch (error) {
        errorCode = ['NETWORK', 'TIMEOUT', 'REDIRECT', 'HTTP', 'CONTENT_TYPE', 'TOO_LARGE', 'SCHEMA', 'JSON', 'CREDENTIAL'].includes(error?.code) ? error.code : 'NETWORK';
        nextAttemptAt = now() + retryMs;
      }
    })();
    try { await pending; } finally { pending = null; }
    return snapshot();
  }
  async function refresh({ afterWrite = false } = {}) {
    // Explicit follow-up reads may bypass the TTL, never an error backoff or an in-flight read.
    if (!pending && errorCode === null && (afterWrite || lastAttemptAt === null || now() - lastAttemptAt >= 5000)) nextAttemptAt = 0;
    return read();
  }
  return { read, refresh };
}
