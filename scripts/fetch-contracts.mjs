import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const refs = { main: '0137dc30eb3022af139ef5cbe26ed2d025c6c208', release: 'ce853f415704d1bfe8d076a5cfb2caabac00fffd' };
for (const [kind, ref] of Object.entries(refs)) {
  const response = await fetch(`https://api.github.com/repos/openchamber/openchamber/git/trees/${ref}?recursive=1`);
  if (!response.ok) throw new Error('Could not obtain pinned public tree');
  const tree = await response.json();
  const paths = tree.tree.map((item) => item.path).filter((path) => /^packages\/sdk\/src\/[^/]+\.ts$/.test(path) && !path.includes('.test.'));
  const hashes = {};
  const root = `.cache/contracts/${kind}/src`;
  await mkdir(root, { recursive: true });
  await writeFile(`.cache/contracts/${kind}/package.json`, '{"type":"module"}\n');
  let cursor = 0;
  await Promise.all(Array.from({ length: 5 }, async () => {
    while (cursor < paths.length) {
      const path = paths[cursor++];
      const response = await fetch(`https://raw.githubusercontent.com/openchamber/openchamber/${ref}/${path}`);
      if (!response.ok) throw new Error(`Cannot fetch public contract ${path}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      await writeFile(`${root}/${path.split('/').at(-1)}`, bytes);
      hashes[path] = createHash('sha256').update(bytes).digest('hex');
    }
  }));
  await writeFile(`.cache/contracts/${kind}/evidence.json`, JSON.stringify({ ref, hashes }, null, 2));
  console.log(`Pinned ${kind} SDK sources: ${ref} (${paths.length} files, test-only cache)`);
}
