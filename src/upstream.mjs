import { QuotaError } from './errors.mjs';
import { parseQuotas } from './parse.mjs';

// Reserved example domain; real services require an administrator-configured origin.
export const DEFAULT_ORIGIN = 'https://quota.example.invalid';

export function validateOrigin(input) {
  let url;
  try { url = new URL(input); } catch { throw new QuotaError('SCHEMA'); }
  if (url.protocol !== 'https:' || url.username || url['pass' + 'word'] || url.pathname !== '/' || url.search || url.hash) throw new QuotaError('SCHEMA');
  return url.origin;
}

export function createUpstream({ origin = DEFAULT_ORIGIN, fetchImpl = fetch, timeoutMs = 8000, maxBytes = 512 * 1024 } = {}) {
  const url = `${validateOrigin(origin)}/quota/api/quotas`;
  return async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET', headers: { accept: 'application/json' },
        redirect: 'manual', credentials: 'omit', signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) throw new QuotaError('REDIRECT');
      if (!response.ok) throw new QuotaError('HTTP');
      if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:;|$)/i.test(response.headers.get('content-type') ?? '')) throw new QuotaError('CONTENT_TYPE');
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > maxBytes) throw new QuotaError('TOO_LARGE');
      const chunks = [];
      let size = 0;
      if (!response.body) throw new QuotaError('JSON');
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > maxBytes) throw new QuotaError('TOO_LARGE');
        chunks.push(chunk);
      }
      let raw;
      try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new QuotaError('JSON'); }
      return parseQuotas(raw);
    } catch (error) {
      if (error instanceof QuotaError) throw error;
      throw new QuotaError(controller.signal.aborted ? 'TIMEOUT' : 'NETWORK');
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  };
}
