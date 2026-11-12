import { createHash } from 'node:crypto';
import { QuotaError } from './errors.mjs';

export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12);
// Shared pseudonymous key linking a quota account to its reset-credit record when
// both upstreams use the same account id string. Never the raw id itself.
export const resetKeyFor = (rawAccountId) => digest(JSON.stringify(['reset-key', rawAccountId]));
const identity = (value) => typeof value === 'string' && value.length > 0 && value.length <= 1024;
const amount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const percent = (value) => amount(value) !== null && value <= 100 ? value : null;
export const parseTimestamp = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isSafeInteger(ms) && ms >= 0 ? ms : null;
};
const providerNames = { antigravity: 'Antigravity', claude: 'Claude', codex: 'Codex' };
const statuses = new Set(['available', 'unavailable', 'error', 'disabled', 'exhausted', 'rate_limited']);
const plans = new Map(['free', 'pro', 'max', 'plus', 'ultra', 'team', 'enterprise'].map((p) => [p, p]));
const hasError = (value) => value !== null && value !== undefined && value !== '' && value !== false;

function windowName(raw, duration) {
  // Labels may contain emails or paths: only recognised pool names cross to clients.
  const text = `${typeof raw.quota_group === 'string' ? raw.quota_group : ''} ${typeof raw.label === 'string' ? raw.label : ''}`.toLowerCase();
  const pool = ['gemini', 'claude', 'gpt', 'codex'].filter((name) => text.includes(name)).join('/') || '额度池';
  const period = duration === 18000 ? '5h' : duration === 604800 ? '7d' : duration === null ? '周期未知' : `${duration}s`;
  return `${pool} · ${period}`;
}

export function parseQuotas(raw) {
  if (!isObject(raw) || typeof raw.configured !== 'boolean' || typeof raw.refreshing !== 'boolean' || !Array.isArray(raw.accounts) || raw.accounts.length > 100) {
    throw new QuotaError('SCHEMA');
  }
  let invalidItems = 0;
  const accounts = [];
  const seenAccounts = new Set();
  for (const account of raw.accounts) {
    if (!isObject(account) || !identity(account.id) || !Array.isArray(account.windows) || account.windows.length > 128) {
      invalidItems++;
      continue;
    }
    const provider = Object.hasOwn(providerNames, account.provider) ? account.provider : 'other';
    const id = digest(JSON.stringify([provider, account.id]));
    if (seenAccounts.has(id)) { invalidItems++; continue; }
    seenAccounts.add(id);
    const windows = [];
    const seenWindows = new Set();
    for (const window of account.windows) {
      if (!isObject(window) || !identity(window.id)) { invalidItems++; continue; }
      const windowId = digest(JSON.stringify([id, window.id, typeof window.quota_group === 'string' ? window.quota_group : null]));
      if (seenWindows.has(windowId)) { invalidItems++; continue; }
      seenWindows.add(windowId);
      let used = percent(window.used_percent);
      let remaining = percent(window.remaining_percent);
      const inconsistent = used !== null && remaining !== null && Math.abs(used + remaining - 100) > 1;
      if (inconsistent) { used = null; remaining = null; }
      else if (used === null && remaining !== null) used = 100 - remaining;
      else if (remaining === null && used !== null) remaining = 100 - used;
      const duration = Number.isSafeInteger(window.duration_seconds) && window.duration_seconds > 0 ? window.duration_seconds : null;
      windows.push({
        id: windowId,
        label: windowName(window, duration),
        usedPercent: used,
        remainingPercent: remaining,
        resetAt: parseTimestamp(window.resets_at),
        windowSeconds: duration,
        currentCost: amount(window.current_cost),
        currentTokens: amount(window.current_tokens),
        estimatedCost: amount(window.estimated_cost),
        estimatedTokens: amount(window.estimated_tokens),
        hasEstimateBasis: typeof window.estimate_basis === 'string' && window.estimate_basis.length > 0,
        usageError: hasError(window.usage_error),
        inconsistent,
      });
    }
    accounts.push({
      id, provider,
      resetKey: resetKeyFor(account.id),
      label: `${providerNames[provider] ?? '其他'} · ${id.slice(0, 6)}`,
      plan: typeof account.plan === 'string' ? plans.get(account.plan.toLowerCase()) ?? null : null,
      status: statuses.has(account.status) ? account.status : 'unknown',
      error: hasError(account.error),
      upstreamStale: typeof account.stale === 'boolean' ? account.stale : null,
      updatedAt: parseTimestamp(account.updated_at),
      windows: windows.sort((a, b) => a.id.localeCompare(b.id)),
    });
  }
  if (raw.accounts.length > 0 && accounts.length === 0) throw new QuotaError('SCHEMA');
  return {
    configured: raw.configured, refreshing: raw.refreshing,
    updatedAt: parseTimestamp(raw.updated_at), nextRefreshAt: parseTimestamp(raw.next_refresh_at),
    upstreamError: hasError(raw.error), invalidItems,
    accounts: accounts.sort((a, b) => a.label.localeCompare(b.label)),
  };
}
