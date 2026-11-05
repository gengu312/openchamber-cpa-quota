import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createResetStore } from '../src/reset-store.mjs';

test('journal atomic save/load using synthetic records outside project; malformed state fails closed', async () => {
  const root = await mkdtemp(join(process.env.LOCALAPPDATA, 'Temp', 'opencode', 'cpa-reset-journal-'));
  const path = join(root, 'reset-operations.json');
  const store = createResetStore(path);
  assert.deepEqual(await store.load(), []);
  const records = [{ operationId: '12345678-1234-4234-9234-123456789abc', redeemRequestId: '12345678-1234-4234-9234-123456789abc',
    accountKey: 'a'.repeat(24), targetId: 'b'.repeat(24), sourceRevision: 'c'.repeat(24), state: 'running' }];
  await store.save(records);
  assert.deepEqual(await store.load(), records);
  assert.equal(JSON.parse(await readFile(path, 'utf8'))[0].state, 'running');
  await writeFile(path, '[{"state":"running"}]');
  await assert.rejects(store.load(), /RESET_JOURNAL_INVALID/);
});
