import { readFile } from 'node:fs/promises';

export const quotaFixture = async () => JSON.parse(await readFile(new URL('../fixtures/quotas.synthetic.json', import.meta.url), 'utf8'));
export const resetFixture = async () => JSON.parse(await readFile(new URL('../fixtures/reset-credits.synthetic.json', import.meta.url), 'utf8'));
export const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
export const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
