import { randomUUID } from 'node:crypto';
import { UUID4 } from './reset-consume.mjs';

export const RESET_CONFIRMATION = '确认消耗一次重置权益';
const locked = new Set(['preparing', 'running', 'outcome-unknown', 'refresh-required', 'journal-error']);

export class ResetActionError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const publicOperation = (operation) => {
  const { accountKey, ...view } = operation;
  return view;
};

// One coordinator per host service, shared by all clients; no browser-side lock or retry loop.
export async function createResetActions({ enabled = false, readCredits, resolveTarget, perform, refreshQuota, refreshCredits,
  now = Date.now, uuid = randomUUID, timeoutMs = 10_000, store = { load: async () => [], save: async () => {} }, reconcileResult } = {}) {
  const operations = new Map();
  const byAccount = new Map();
  const preparations = new Map();
  for (const operation of await store.load()) {
    if (['preparing', 'awaiting-confirmation'].includes(operation.state)) { operation.state = 'cancelled'; }
    if (operation.state === 'running') { operation.state = 'outcome-unknown'; operation.code = 'RESTARTED'; }
    operations.set(operation.operationId, operation);
    byAccount.set(operation.accountKey, operation);
  }
  let saves = Promise.resolve();
  const persist = () => {
    // Queue immutable snapshots so a later operation cannot overwrite a running lock out of order.
    const snapshot = structuredClone([...operations.values()]);
    const saved = saves.then(() => store.save(snapshot));
    saves = saved.catch(() => {});
    return saved;
  };
  const mustEnable = () => { if (!enabled) throw new ResetActionError('DISABLED'); };
  const find = (operationId) => {
    const operation = operations.get(operationId);
    if (!operation) throw new ResetActionError('OPERATION_NOT_FOUND');
    return operation;
  };
  const targetFrom = async (targetId, sourceRevision, read = readCredits) => {
    const snapshot = await read();
    const generatedAt = snapshot.data?.generatedAt;
    if (!snapshot.data || snapshot.stale || snapshot.errorCode || generatedAt === null || !Number.isFinite(generatedAt)
      || now() - generatedAt > 600_000 || generatedAt > now() + 60_000) throw new ResetActionError('STALE_QUERY');
    const account = snapshot.data.accounts.find((account) => account.id === targetId);
    const target = resolveTarget(targetId);
    if (!account || !account.selectable || account.error || !(account.availableCount > 0) || !target?.workspaceId
      || target.sourceRevision !== sourceRevision || account.sourceRevision !== sourceRevision) throw new ResetActionError('SELECTION_CHANGED');
    return { account, target };
  };
  const refreshBoth = async (operation) => {
    const afterWrite = operation.verifiedOutcome === 'succeeded' && operation.checkedAt === undefined;
    const reads = await Promise.allSettled([refreshCredits({ afterWrite }), refreshQuota({ afterWrite })]);
    operation.checkedAt = now();
    operation.refreshOk = reads.every((result) => result.status === 'fulfilled' && result.value?.data && !result.value.stale && !result.value.errorCode);
    return operation.refreshOk;
  };
  const api = {
    enabled,
    async prepare({ targetId, sourceRevision, acknowledge }) {
      mustEnable();
      if (acknowledge !== true) throw new ResetActionError('ACKNOWLEDGEMENT_REQUIRED');
      const { account, target } = await targetFrom(targetId, sourceRevision);
      const current = byAccount.get(target.accountKey);
      if (current) {
        // Identical selections across tabs/devices get the SAME logical operation and UUID.
        if (current.targetId === targetId && current.sourceRevision === sourceRevision) {
          if (preparations.has(current.operationId)) { await preparations.get(current.operationId); return publicOperation(current); }
          if (current.state === 'awaiting-confirmation' && current.expiresAt <= now()) throw new ResetActionError('CONFIRMATION_EXPIRED');
          return publicOperation(current);
        }
        if (locked.has(current.state) || (current.state === 'awaiting-confirmation' && current.expiresAt > now())) throw new ResetActionError('ACCOUNT_LOCKED');
      }
      if (operations.size >= 500) throw new ResetActionError('JOURNAL_FULL');
      const operationId = uuid();
      if (!UUID4.test(operationId) || operations.has(operationId)) throw new ResetActionError('INVALID_OPERATION_ID');
      const operation = { operationId, redeemRequestId: operationId, accountKey: target.accountKey, targetId, sourceRevision,
        account: account.label, workspace: account.workspace, availableCount: account.availableCount,
        confirmation: RESET_CONFIRMATION, expiresAt: now() + 60_000, state: 'preparing' };
      operations.set(operationId, operation);
      byAccount.set(target.accountKey, operation);
      const preparation = (async () => {
        try {
          await persist();
          operation.state = 'awaiting-confirmation';
          await persist();
        } catch { operation.state = 'journal-error'; throw new ResetActionError('JOURNAL_UNAVAILABLE'); }
      })();
      preparations.set(operationId, preparation);
      try { await preparation; } finally { preparations.delete(operationId); }
      return publicOperation(operation);
    },
    async cancel({ operationId }) {
      mustEnable();
      const operation = find(operationId);
      if (operation.state === 'awaiting-confirmation') { operation.state = 'cancelled'; await persist(); }
      return publicOperation(operation);
    },
    async confirm({ operationId, confirmation }) {
      mustEnable();
      const operation = find(operationId);
      if (operation.state !== 'awaiting-confirmation') return publicOperation(operation);
      if (confirmation !== RESET_CONFIRMATION || operation.expiresAt <= now()) throw new ResetActionError('CONFIRMATION_INVALID');
      // Claim synchronously, before either query validation, disk write or transport awaits.
      operation.state = 'running';
      try { await persist(); }
      catch { operation.state = 'journal-error'; throw new ResetActionError('JOURNAL_UNAVAILABLE'); }
      let selected;
      try {
        selected = await targetFrom(operation.targetId, operation.sourceRevision);
        if (selected.target.accountKey !== operation.accountKey) throw new Error();
      } catch {
        operation.state = 'rejected'; operation.code = 'SELECTION_CHANGED';
        try { await persist(); } catch { operation.state = 'journal-error'; }
        return publicOperation(operation);
      }
      let result;
      let timer;
      try {
        result = await Promise.race([
          perform({ accountId: selected.target.accountId, workspaceId: selected.target.workspaceId, redeemRequestId: operation.redeemRequestId }),
          new Promise((resolve) => { timer = setTimeout(() => resolve({ status: 'outcome-unknown', code: 'TIMEOUT' }), timeoutMs); }),
        ]);
      } catch { result = { status: 'outcome-unknown', code: 'NETWORK' }; }
      finally { clearTimeout(timer); }
      if (result?.status === 'succeeded') {
        operation.state = 'refresh-required';
        operation.verifiedOutcome = 'succeeded';
        try { await persist(); } catch { operation.state = 'journal-error'; return publicOperation(operation); }
        if (await refreshBoth(operation)) operation.state = 'succeeded';
      } else if (['not-sent', 'rejected'].includes(result?.status) && ['DISABLED', 'INVALID_TARGET', 'CREDENTIAL', 'UNAUTHORIZED', 'FORBIDDEN', 'NO_CREDITS', 'NO_RESETTABLE_QUOTA', 'ALREADY_REDEEMED'].includes(result.code)) {
        operation.state = 'rejected'; operation.code = result.code;
      } else {
        operation.state = 'outcome-unknown';
        operation.code = ['TIMEOUT', 'NETWORK', 'REDIRECT', 'TOO_LARGE', 'RESPONSE_UNVERIFIED'].includes(result?.code) ? result.code : 'RESPONSE_UNVERIFIED';
        operation.message = '可能已使用，请先刷新卡数和额度核对；不会自动重试';
      }
      try { await persist(); } catch { operation.state = 'journal-error'; }
      return publicOperation(operation);
    },
    async review({ operationId }) {
      mustEnable();
      const operation = find(operationId);
      if (operation.state === 'running') return publicOperation(operation);
      await refreshBoth(operation);
      // Counts alone do not prove whether THIS UUID landed. Unknown remains locked.
      if (operation.state === 'refresh-required' && operation.refreshOk) operation.state = 'succeeded';
      if (operation.state === 'outcome-unknown' && reconcileResult && operation.refreshOk) {
        const outcome = await reconcileResult(operation.redeemRequestId);
        if (outcome === 'succeeded' || outcome === 'not-performed') {
          operation.state = outcome === 'succeeded' ? 'succeeded' : 'rejected';
          operation.code = outcome === 'not-performed' ? 'VERIFIED_NOT_PERFORMED' : undefined;
        }
      }
      await persist();
      return publicOperation(operation);
    },
    forTarget(targetId) {
      const target = resolveTarget?.(targetId);
      const operation = target ? byAccount.get(target.accountKey) : [...operations.values()].findLast((op) => op.targetId === targetId);
      return operation ? publicOperation(operation) : null;
    },
    status({ operationId }) { return publicOperation(find(operationId)); },
  };
  return api;
}
