const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
const compactFormat = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

export const formatNumber = (value) => Number.isFinite(value) ? numberFormat.format(value) : '—';
export const formatCompact = (value) => Number.isFinite(value) ? compactFormat.format(value) : '—';
export const percentText = (value) => Number.isFinite(value) ? `${formatNumber(value)}%` : '—';
export const remainingTone = (value) => !Number.isFinite(value) ? 'unknown' : value <= 10 ? 'error' : value <= 25 ? 'warning' : 'success';

export function accountFreshness(account, snapshot, now = Date.now(), readFailed = false) {
  const updatedAt = account.updatedAt ?? snapshot?.data?.updatedAt;
  if (readFailed || snapshot?.stale || account.upstreamStale === true || account.error || (Number.isFinite(updatedAt) && now - updatedAt > 600_000)) return 'stale';
  if (!Number.isFinite(updatedAt) || account.upstreamStale === null || updatedAt > now + 60_000) return 'unknown';
  return 'fresh';
}

export function accountSummary(accounts, snapshot, now = Date.now(), readFailed = false) {
  const fresh = accounts.filter((account) => accountFreshness(account, snapshot, now, readFailed) === 'fresh');
  return {
    total: accounts.length,
    available: fresh.filter((account) => account.status === 'available' && !account.error).length,
    low: fresh.filter((account) => account.windows.some((window) => Number.isFinite(window.remainingPercent) && window.remainingPercent <= 25)).length,
  };
}

export function orderFocusControl(control, index, count) {
  return (control === '上移' && index === 0) || (control === '下移' && index === count - 1) ? 'handle' : control;
}

export function resetCountdown(resetAt, now = Date.now()) {
  if (!Number.isFinite(resetAt)) return '重置时间未知';
  const minutes = Math.ceil((resetAt - now) / 60_000);
  if (minutes <= 0) return '已到重置时间 · 待读取';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  const rest = minutes % 60;
  return `${days ? `${days}天${hours ? ` ${hours}小时` : ''}` : hours ? `${hours}小时${rest ? ` ${rest}分` : ''}` : `${rest}分钟`}后重置`;
}

export function windowPool(window) {
  const pool = window.label.split(' · ')[0];
  const names = { gemini: 'Gemini', 'claude/gpt': 'Claude / GPT', claude: 'Claude', gpt: 'GPT', codex: 'Codex' };
  return names[pool] ?? '额度';
}

export function windowPeriod(window) {
  return window.windowSeconds === 18000 ? '5 小时' : window.windowSeconds === 604800 ? '7 天'
    : Number.isFinite(window.windowSeconds) ? `${formatCompact(window.windowSeconds / 3600)} 小时` : '周期未知';
}

export function groupWindows(windows) {
  const groups = new Map();
  for (const window of windows) {
    const name = windowPool(window);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(window);
  }
  const poolOrder = ['Gemini', 'Claude / GPT', 'Claude', 'GPT', 'Codex', '额度'];
  return [...groups].sort(([a], [b]) => poolOrder.indexOf(a) - poolOrder.indexOf(b)).map(([name, items]) => ({
    name, windows: items.sort((a, b) => (a.windowSeconds ?? Infinity) - (b.windowSeconds ?? Infinity) || a.id.localeCompare(b.id)),
  }));
}

export function normalizeOrder(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id) => typeof id === 'string' && /^[a-f0-9]{12}$/.test(id)))].slice(0, 100);
}

export function orderAccounts(accounts, order) {
  const positions = new Map(normalizeOrder(order).map((id, index) => [id, index]));
  return [...accounts].sort((a, b) => (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity));
}

export function moveAccount(accounts, order, id, direction) {
  const ids = orderAccounts(accounts, order).map((account) => account.id);
  const from = ids.indexOf(id);
  if (from < 0) return ids;
  const to = Math.max(0, Math.min(ids.length - 1, from + direction));
  ids.splice(from, 1);
  ids.splice(to, 0, id);
  return ids;
}

export function placeAccount(accounts, order, dragged, before) {
  const ids = orderAccounts(accounts, order).map((account) => account.id);
  if (dragged === before || !ids.includes(dragged) || !ids.includes(before)) return ids;
  ids.splice(ids.indexOf(dragged), 1);
  ids.splice(ids.indexOf(before), 0, dragged);
  return ids;
}
