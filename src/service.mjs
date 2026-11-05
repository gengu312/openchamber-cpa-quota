import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { isObject } from './parse.mjs';
import { publicSnapshot, toNative } from './view.mjs';
import { errorMessage } from './errors.mjs';
import { ResetActionError } from './reset-actions.mjs';

export const PROVIDER_ID = 'ext-cpa-quota';

export function readQuotaRequest(text) {
  let body;
  try { body = JSON.parse(text); } catch { return null; }
  return isObject(body) && body.v === 1 && typeof body.requestId === 'string' && body.requestId.length > 0 && body.requestId.length <= 256
    && body.method === 'usage.read' && body.provider === PROVIDER_ID && isObject(body.input)
    && isObject(body.input.credentials) && Object.keys(body.input.credentials).length === 0 ? body : null;
}

const send = (res, status, body) => {
  const text = JSON.stringify(body);
  if (Buffer.byteLength(text) > 1_000_000) {
    res.writeHead(413, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end('{"error":"response-too-large"}');
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(text);
};

async function readBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 16_384) throw new Error('body-limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createService({ token, cache, resetCache, resetActions, now = Date.now }) {
  if (typeof token !== 'string' || !token) throw new Error('Service token required');
  const expected = Buffer.from(`Bearer ${token}`);
  return http.createServer({ requestTimeout: 10_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, async (req, res) => {
    const actual = Buffer.from(req.headers.authorization ?? '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return send(res, 401, { error: 'unauthorized' });
    // Loopback APIs are for the host only, not a browser origin with a copied token.
    if (req.headers.origin) return send(res, 403, { error: 'browser-origin-refused' });
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
    if (req.method === 'GET' && req.url === '/snapshot') return send(res, 200, publicSnapshot(await cache.read(), now()));
    if (req.method === 'GET' && req.url === '/reset-credits' && resetCache) {
      const snapshot = await resetCache.read();
      return send(res, 200, {
        ...snapshot,
        error: snapshot.errorCode ? errorMessage(snapshot.errorCode) : null,
        actions: { enabled: resetActions?.enabled === true, reason: resetActions?.enabled ? null : '真实消费保持关闭；请求合同已接入，响应合同与真实消费未验证' },
        operations: Object.fromEntries((snapshot.data?.accounts ?? []).flatMap((account) => {
          const operation = resetActions?.forTarget(account.id);
          return operation ? [[account.id, operation]] : [];
        })),
      });
    }
    const actionRoutes = { '/reset/prepare': ['prepare', ['targetId', 'sourceRevision', 'acknowledge']],
      '/reset/confirm': ['confirm', ['operationId', 'confirmation']], '/reset/cancel': ['cancel', ['operationId']],
      '/reset/review': ['review', ['operationId']], '/reset/status': ['status', ['operationId']] };
    if (req.method === 'POST' && Object.hasOwn(actionRoutes, req.url)) {
      if (!resetActions?.enabled) return send(res, 403, { error: 'DISABLED', message: '真实消费保持关闭；没有发送上游请求' });
      try {
        const body = JSON.parse(await readBody(req));
        const [method, fields] = actionRoutes[req.url];
        if (!isObject(body) || Object.keys(body).some((key) => !fields.includes(key))) return send(res, 400, { error: 'INVALID_ACTION_REQUEST' });
        return send(res, 200, { operation: await resetActions[method](body) });
      } catch (error) {
        return send(res, error instanceof ResetActionError ? 409 : 400, { error: error instanceof ResetActionError ? error.code : 'ACTION_UNAVAILABLE' });
      }
    }
    if (req.method !== 'POST' || req.url !== '/quota') return send(res, 404, { error: 'not-found' });
    try {
      const request = readQuotaRequest(await readBody(req));
      if (!request) return send(res, 400, { error: 'invalid-quota-request' });
      const [snapshot, resetSnapshot] = await Promise.all([cache.read(), resetCache?.read()]);
      return send(res, 200, { ok: true, data: toNative(snapshot, now(), resetSnapshot) });
    } catch {
      if (!res.destroyed) send(res, 400, { error: 'invalid-request' });
    }
  });
}
