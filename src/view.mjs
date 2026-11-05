import { errorMessage } from './errors.mjs';

const MAX_SOURCE_AGE_MS = 10 * 60_000;

export function publicSnapshot(snapshot, now = Date.now()) {
  const data = snapshot.data;
  return {
    ...snapshot,
    error: snapshot.errorCode ? errorMessage(snapshot.errorCode) : null,
    data: data && {
      ...data,
      accounts: data.accounts.map((account) => {
        const updatedAt = account.updatedAt ?? data.updatedAt;
        const freshness = snapshot.stale || account.upstreamStale === true || account.error || (updatedAt !== null && now - updatedAt > MAX_SOURCE_AGE_MS)
          ? 'stale' : updatedAt === null || account.upstreamStale === null || updatedAt > now + 60_000 ? 'unknown' : 'fresh';
        return { ...account, freshness };
      }),
    },
  };
}

export function toNative(snapshot, now = Date.now(), resetSnapshot) {
  const view = publicSnapshot(snapshot, now);
  if (!view.data && !resetSnapshot?.data) return { ok: false, configured: true, error: view.error ?? '额度尚无可用数据', usage: null };
  const data = view.data ?? { accounts: [], updatedAt: null };
  const count = data.accounts.reduce((sum, account) => sum + account.windows.length, 0);
  const resetCount = resetSnapshot?.data?.accounts.length ?? (resetSnapshot ? 1 : 0);
  if (count + resetCount > 32) return { ok: false, configured: true, error: errorMessage('LIMIT'), usage: null };
  const warnings = [];
  if (!view.data) warnings.push(view.error ?? '额度尚无可用数据；重置卡查询独立展示');
  if (view.error && view.data) warnings.push(`${view.error}；当前为上次成功读取的旧数据`);
  if (data.upstreamError) warnings.push(errorMessage('UPSTREAM'));
  if (data.invalidItems) warnings.push(`${data.invalidItems} 项数据结构异常，已跳过`);
  if (data.accounts.some((a) => a.freshness !== 'fresh')) warnings.push('部分账号为旧数据或新鲜度未知，请核对源更新时间');
  if (data.accounts.some((a) => a.status !== 'available')) warnings.push('部分账号状态异常或未知');
  if (data.accounts.some((a) => a.windows.some((w) => w.inconsistent))) warnings.push('部分窗口百分比不一致，已按未知显示');
  const windows = Object.fromEntries(data.accounts.flatMap((account) => account.windows.map((window) => {
    const state = [account.freshness === 'stale' ? '旧数据' : account.freshness === 'unknown' ? '新鲜度未知' : null,
      account.status !== 'available' ? '账号状态异常/未知' : null].filter(Boolean).join(' · ');
    const updated = account.updatedAt ?? data.updatedAt;
    const valueLabel = `${state ? `${state} · ` : ''}剩余 ${window.remainingPercent === null ? '未知' : `${Number(window.remainingPercent.toFixed(2))}%`} · 源 ${updated === null ? '时间未知' : new Date(updated).toISOString().slice(5, 16) + 'Z'}`;
    return [`${account.label} / ${window.label} [${window.id.slice(0, 6)}]`, {
      usedPercent: window.usedPercent,
      windowSeconds: window.windowSeconds,
      resetAt: window.resetAt,
      valueLabel,
    }];
  })));
  if (resetSnapshot) {
    if (!resetSnapshot.data) {
      windows['重置卡 · 查询不可用（只读）'] = { usedPercent: null, valueLabel: '数量未知 · 真实使用已禁用' };
      warnings.push(errorMessage(resetSnapshot.errorCode));
    } else {
      const generatedAt = resetSnapshot.data.generatedAt;
      const stale = resetSnapshot.stale || generatedAt === null || now - generatedAt > MAX_SOURCE_AGE_MS || generatedAt > now + 60_000;
      for (const account of resetSnapshot.data.accounts) {
        windows[`${account.label} / ${account.workspace} · 卡片数量 [${account.id.slice(0, 6)}]`] = {
          usedPercent: null,
          valueLabel: `${stale || account.error ? '旧数据/异常 · ' : ''}可用 ${account.availableCount ?? '未知'} 张 · 源 ${generatedAt === null ? '时间未知' : new Date(generatedAt).toISOString().slice(5, 16) + 'Z'} · 只读`,
        };
      }
      if (stale || resetSnapshot.errorCode || resetSnapshot.data.accounts.some((a) => a.error)) warnings.push('重置卡查询为旧数据或异常，不能据此消费');
    }
  }
  return {
    // The host discards new usage when ok=false and it already has a sample.
    // Partial readable data must advance, with warnings AND per-window stale labels.
    ok: true, configured: true,
    ...(warnings.length ? { error: warnings.join('；') } : {}),
    planLabel: `${data.accounts.length} 个账号 · ${count} 个独立窗口${data.refreshing ? ' · 上游刷新中' : ''}`,
    usage: { windows },
  };
}
