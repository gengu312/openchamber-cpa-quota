import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const allowed = ['README.md', 'SDK-LICENSE', 'package.json', 'panel/index.html', 'panel/main.js', 'panel/style.css', 'service/main.js'];
await mkdir('release', { recursive: true });
const checksums = [];
for (const kind of ['native', 'desktop-compat']) {
  const root = resolve(`dist/${kind}`);
  async function files(path = '') {
    const entries = await readdir(`${root}/${path}`, { withFileTypes: true });
    return (await Promise.all(entries.map((entry) => entry.isDirectory() ? files(`${path}${entry.name}/`) : `${path}${entry.name}`))).flat();
  }
  const actual = (await files()).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...allowed].sort())) throw new Error('Unexpected package files; refusing to pack');
  const output = resolve(`release/cpa-quota-${kind}-${version}.zip`);
  // Explicit file allowlist; never compress the project or the user configuration directory.
  const result = spawnSync('tar.exe', ['-a', '-c', '-f', output, ...allowed], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('ZIP creation failed');
  const list = spawnSync('tar.exe', ['-t', '-f', output], { encoding: 'utf8' });
  if (list.status !== 0 || JSON.stringify(list.stdout.trim().split(/\r?\n/).sort()) !== JSON.stringify([...allowed].sort())) throw new Error('ZIP contents mismatch');
  checksums.push(`${createHash('sha256').update(await readFile(output)).digest('hex')}  cpa-quota-${kind}-${version}.zip`);
}
await writeFile('release/SHA256SUMS.txt', checksums.join('\n') + '\n');
console.log(`Packaged 2 allowlisted ZIPs, version ${version}`);
