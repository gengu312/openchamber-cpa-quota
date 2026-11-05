import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DEFAULT_ORIGIN, validateOrigin } from './upstream.mjs';
import { QuotaError } from './errors.mjs';
import { isObject, parseTimestamp } from './parse.mjs';

export const RESET_CREDITS_PATH = '/quota/api/codex/reset-credits';
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const validId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value);

export function parseResetCredits(raw) {
  if (!isObject(raw) || !Array.isArray(raw.accounts) || raw.accounts.length > 100) throw new QuotaError('SCHEMA');
  const generatedAt = parseTimestamp(raw.generated_at);
  const seen = new Set();
  const accounts = raw.accounts.map((account) => {
    if (!isObject(account) || !validId(account.account_id)) throw new QuotaError('SCHEMA');
    // Different namespaces: matching source strings do NOT establish quota-account binding.
    const workspaceId = validId(account.workspace_id) ? account.workspace_id : null;
    const id = hash(['reset-codex', account.account_id, workspaceId]);
    if (seen.has(id)) throw new QuotaError('SCHEMA');
    seen.add(id);
    return {
      id, label: `重置卡账号 · ${hash(['reset-account', account.account_id]).slice(0, 6)}`,
      workspace: workspaceId ? `工作区 · ${hash(['reset-workspace', workspaceId]).slice(0, 6)}` : '工作区未知',
      sourceRevision: hash([account.account_id, workspaceId, generatedAt, account.available_count, Boolean(account.error)]),
      selectable: workspaceId !== null,
      availableCount: Number.isSafeInteger(account.available_count) && account.available_count >= 0 ? account.available_count : null,
      error: account.error !== null && account.error !== undefined && account.error !== '' && account.error !== false,
    };
  });
  return { configured: true, generatedAt, accounts };
}

// Raw target fields never enter a cache response, panel DTO, journal or log.
export function createResetDirectory() {
  let targets = new Map();
  return {
    replace(raw, parsed) {
      targets = new Map(parsed.accounts.map((account, index) => [account.id, {
        accountId: raw.accounts[index].account_id,
        workspaceId: validId(raw.accounts[index].workspace_id) ? raw.accounts[index].workspace_id : null,
        accountKey: hash(['reset-account', raw.accounts[index].account_id]),
        sourceRevision: account.sourceRevision,
      }]));
    },
    resolve(id) { const target = targets.get(id); return target ? { ...target } : null; },
  };
}

export async function loadResetCredential({ readText = readFile, expectedOrigin = DEFAULT_ORIGIN } = {}) {
  // Never return this object over the service bridge or include it in an error.
  let text;
  try { text = await readText(join(homedir(), '.config', 'openchamber-cpa-quota', 'credentials.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new QuotaError('CREDENTIAL'); }
  try {
    if (Buffer.byteLength(text) > 8192) throw new Error();
    const credential = JSON.parse(text);
    if (!isObject(credential) || validateOrigin(credential.origin) !== validateOrigin(expectedOrigin)
      || credential.resetCreditsPath !== RESET_CREDITS_PATH || typeof credential.resetApiKey !== 'string'
      || !credential.resetApiKey || credential.resetApiKey.length > 4096 || /[\r\n]/.test(credential.resetApiKey)) throw new Error();
    return { origin: validateOrigin(expectedOrigin), key: credential.resetApiKey };
  } catch { throw new QuotaError('CREDENTIAL'); }
}

export function createResetReader({ origin = DEFAULT_ORIGIN, loadCredential = () => loadResetCredential({ expectedOrigin: origin }), fetchImpl = fetch, timeoutMs = 8000, maxBytes = 128 * 1024, directory } = {}) {
  origin = validateOrigin(origin);
  return async () => {
    const credential = await loadCredential();
    if (!credential) throw new QuotaError('CREDENTIAL');
    // Even an injected credential cannot select a different network origin/path.
    if (credential.origin !== origin) throw new QuotaError('CREDENTIAL');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${origin}${RESET_CREDITS_PATH}`, {
        method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${credential.key}` },
        signal: controller.signal, redirect: 'manual', credentials: 'omit',
      });
      if (response.status >= 300 && response.status < 400) throw new QuotaError('REDIRECT');
      if (response.status === 401 || response.status === 403) throw new QuotaError('CREDENTIAL');
      if (!response.ok) throw new QuotaError('HTTP');
      if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:;|$)/i.test(response.headers.get('content-type') ?? '')) throw new QuotaError('CONTENT_TYPE');
      if (Number(response.headers.get('content-length')) > maxBytes) throw new QuotaError('TOO_LARGE');
      let bytes = 0;
      const chunks = [];
      if (!response.body) throw new QuotaError('JSON');
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) throw new QuotaError('TOO_LARGE');
        chunks.push(chunk);
      }
      let raw;
      try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new QuotaError('JSON'); }
      const parsed = parseResetCredits(raw);
      directory?.replace(raw, parsed);
      return parsed;
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
