import { build } from 'esbuild';
import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { parseManifest } from '@openchamber/sdk/schemas';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
for (const kind of ['native', 'desktop-compat']) {
  const root = `dist/${kind}`;
  await mkdir(`${root}/panel`, { recursive: true });
  await mkdir(`${root}/service`, { recursive: true });
  const manifest = {
    name: `openchamber-cpa-quota-${kind}`, version: pkg.version, private: true, type: 'module',
    openchamber: {
      apiVersion: 1,
      // No release containing quota is published yet: floor is NOT proof of native support.
      engines: { openchamber: '>=2.6.1' },
      contributes: {
        panel: { id: 'cpa-quota', name: kind === 'native' ? 'CPA 额度' : 'CPA 额度（桌面兼容）', icon: 'bar-chart-box', entry: 'panel/index.html' },
        service: { entry: 'service/main.js', runtime: 'host', ...(kind === 'native' ? { provides: ['quota'] } : {}) },
        ...(kind === 'native' ? { quota: { providers: [] } } : {}),
        attach: false,
      },
    },
  };
  // The release parser intentionally refuses the unreleased quota role.
  if (kind === 'desktop-compat' && !parseManifest(manifest).ok) throw new Error('Compatibility manifest rejected');
  await writeFile(`${root}/package.json`, JSON.stringify(manifest, null, 2) + '\n');
  await build({ entryPoints: ['src/main.mjs'], outfile: `${root}/service/main.js`, platform: 'node', format: 'esm', target: 'node22', bundle: true, legalComments: 'none' });
  await build({ entryPoints: ['panel/main.mjs'], outfile: `${root}/panel/main.js`, platform: 'browser', format: 'iife', target: 'es2022', bundle: true, minify: true, legalComments: 'none' });
  await copyFile('panel/index.html', `${root}/panel/index.html`);
  await copyFile('panel/style.css', `${root}/panel/style.css`);
  await copyFile('node_modules/@openchamber/sdk/LICENSE', `${root}/SDK-LICENSE`);
  await writeFile(`${root}/README.md`, `# CPA 额度 ${kind} ${pkg.version}\n\n${kind === 'native' ? '需要明确支持 quota role 的宿主；正式版 2.6.1 不支持。只有原生只读摘要，不含手机整页/动作入口。' : '仅桌面/网页兼容面板，不是手机整页或消费入口。'}\n\n同一个 panel.id 的两种版本只能选一个安装。未经批准不要安装到主力实例。\n已实现账号级消费请求适配与二次确认，但生产 enabled=false（无环境变量/配置开关）。请求合同依据用户说明，真实消费未测试，响应合同未知时不判成功。无选卡/到期时间前提，不自动重试。\n服务进程在项目外用户配置目录读取凭证，绝不把凭证复制进此目录；所有验证使用合成数据。\n`);
}
console.log('Built dist/native and dist/desktop-compat (no services started)');
