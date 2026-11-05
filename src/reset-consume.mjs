import { DEFAULT_ORIGIN, validateOrigin } from './upstream.mjs';
import { loadResetCredential } from './reset-credits.mjs';

export const RESET_CONSUME_PATH = '/quota/api/codex/reset-credits/consume';
export const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const valid = (value) => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value);

export function createResetConsumer({ origin = DEFAULT_ORIGIN, enabled = false, loadCredential = () => loadResetCredential({ expectedOrigin: origin }), fetchImpl = fetch, timeoutMs = 8000, maxBytes = 64 * 1024,
  classifyResponse = () => ({ status: 'outcome-unknown', code: 'RESPONSE_UNVERIFIED' }) } = {}) {
  origin = validateOrigin(origin);
  return async ({ accountId, workspaceId, redeemRequestId }) => {
    // Production passes false explicitly. No environment/config/UI override exists.
    if (!enabled) return { status: 'not-sent', code: 'DISABLED' };
    if (!valid(accountId) || !valid(workspaceId) || !UUID4.test(redeemRequestId ?? '')) return { status: 'not-sent', code: 'INVALID_TARGET' };
    let credential;
    try { credential = await loadCredential(); } catch { return { status: 'not-sent', code: 'CREDENTIAL' }; }
    if (credential?.origin !== origin || typeof credential.key !== 'string' || !credential.key || credential.key.length > 4096 || /[\r\n]/.test(credential.key)) return { status: 'not-sent', code: 'CREDENTIAL' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${origin}${RESET_CONSUME_PATH}`, {
        method: 'POST', redirect: 'manual', credentials: 'omit', signal: controller.signal,
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${credential.key}` },
        body: JSON.stringify({ account_id: accountId, workspace_id: workspaceId, redeem_request_id: redeemRequestId }),
      });
      // These are generic HTTP refusals, not a claim about a server-side feature switch.
      if (response.status === 401 || response.status === 403) return { status: 'rejected', code: response.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN' };
      if (response.status >= 300 && response.status < 400) return { status: 'outcome-unknown', code: 'REDIRECT' };
      if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:;|$)/i.test(response.headers.get('content-type') ?? '')) return { status: 'outcome-unknown', code: 'RESPONSE_UNVERIFIED' };
      if (Number(response.headers.get('content-length')) > maxBytes) return { status: 'outcome-unknown', code: 'TOO_LARGE' };
      const chunks = [];
      let size = 0;
      if (!response.body) return { status: 'outcome-unknown', code: 'RESPONSE_UNVERIFIED' };
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > maxBytes) return { status: 'outcome-unknown', code: 'TOO_LARGE' };
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return { status: 'outcome-unknown', code: 'RESPONSE_UNVERIFIED' }; }
      // Only an explicitly supplied verified response contract may identify success.
      const result = classifyResponse(response.status, body);
      if (result?.status === 'succeeded') return { status: 'succeeded' };
      if (result?.status === 'rejected' && ['NO_CREDITS', 'NO_RESETTABLE_QUOTA', 'ALREADY_REDEEMED', 'FORBIDDEN', 'UNAUTHORIZED'].includes(result.code)) return { status: 'rejected', code: result.code };
      return { status: 'outcome-unknown', code: 'RESPONSE_UNVERIFIED' };
    } catch {
      // A transport error after fetch starts cannot establish that a write did not land.
      return { status: 'outcome-unknown', code: controller.signal.aborted ? 'TIMEOUT' : 'NETWORK' };
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  };
}
