import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { UUID4 } from './reset-consume.mjs';

// Outside the project; raw targets/credentials are never journalled.
export function createResetStore(path) {
  return {
    async load() {
      let text;
      try { text = await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw new Error('RESET_JOURNAL_UNAVAILABLE'); }
      if (Buffer.byteLength(text) > 512 * 1024) throw new Error('RESET_JOURNAL_INVALID');
      let operations;
      try { operations = JSON.parse(text); } catch { throw new Error('RESET_JOURNAL_INVALID'); }
      if (!Array.isArray(operations) || operations.length > 500 || operations.some((op) => !UUID4.test(op?.operationId ?? '')
        || op.redeemRequestId !== op.operationId || !/^[a-f0-9]{24}$/.test(op.accountKey ?? '')
        || !/^[a-f0-9]{24}$/.test(op.targetId ?? '') || !/^[a-f0-9]{24}$/.test(op.sourceRevision ?? '')
        || !['preparing', 'awaiting-confirmation', 'running', 'cancelled', 'rejected', 'succeeded', 'outcome-unknown', 'refresh-required', 'journal-error'].includes(op.state))) throw new Error('RESET_JOURNAL_INVALID');
      return operations;
    },
    async save(operations) {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.tmp`;
      await writeFile(temporary, JSON.stringify(operations), { encoding: 'utf8', mode: 0o600, flush: true });
      await rename(temporary, path);
    },
  };
}
