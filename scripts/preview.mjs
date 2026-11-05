// Synthetic-only iframe host for independent browser QA. Never loads real config or credentials.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { parseQuotas } from '../src/parse.mjs';
import { parseResetCredits, createResetDirectory } from '../src/reset-credits.mjs';
import { publicSnapshot } from '../src/view.mjs';
import { createResetActions } from '../src/reset-actions.mjs';

const now = Date.now();
const quota = JSON.parse(await readFile('fixtures/quotas.synthetic.json', 'utf8'));
quota.updated_at = new Date(now).toISOString();
quota.accounts.forEach((a) => { a.updated_at = quota.updated_at; });
const credits = JSON.parse(await readFile('fixtures/reset-credits.synthetic.json', 'utf8'));
credits.generated_at = quota.updated_at;
const snapshot = publicSnapshot({ data: parseQuotas(quota), fetchedAt: now, lastAttemptAt: now, stale: false, errorCode: null }, now);
const mockActions = process.argv.includes('--actions');
const reset = { data: parseResetCredits(credits), fetchedAt: now, stale: false, error: null,
  actions: { enabled: mockActions, reason: '真实消费保持关闭；请求合同已接入，未发消费请求。' } };
const directory = createResetDirectory(); directory.replace(credits, reset.data);
let writes = 0;
const actions = await createResetActions({ enabled: mockActions, readCredits: async () => reset, resolveTarget: directory.resolve,
  perform: async () => { writes++; return { status: 'succeeded' }; },
  refreshQuota: async () => snapshot, refreshCredits: async () => reset });
const harness = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CPA 合成数据预览（不是 OpenChamber）</title><style>body{margin:0;background:#16191c;color:#a8afba;font:13px 'Segoe UI',sans-serif}p{margin:8px 16px}iframe{border:0;width:100%;height:1600px;display:block}</style></head><body><p>合成数据预览 · 模拟 SDK 宿主 · 未连接真实 API 或 OpenChamber</p><iframe src="/panel/index.html" title="CPA 合成额度面板" sandbox="allow-scripts allow-same-origin"></iframe><script>
const frame = document.querySelector('iframe');
const snapshot = ${JSON.stringify(snapshot)};
const reset = ${JSON.stringify(reset)};
const tokens = {background:'#16191c',foreground:'#e8e9e8',muted:'#a8afba',border:'#363c45',primary:'#75b5b1',warningText:'#dfb979',hover:'#293036',focus:'#75b5b1',font:'"Segoe UI",sans-serif',mono:'Consolas,monospace'};
window.addEventListener('message', async event => {
  if (event.source !== frame.contentWindow || event.data?.channel !== 'openchamber.sdk') return;
  const m = event.data;
  if (m.type === 'hello') frame.contentWindow.postMessage({channel:m.channel,v:1,type:'ready',payload:{theme:{mode:'dark',tokens},surface:'panel',directory:null,session:null,connection:null,settings:{},item:null}}, location.origin);
  if (m.type === 'service-request') {
    let body = m.payload.path === '/snapshot' ? snapshot : reset;
    let status = 200;
    if (m.payload.path.startsWith('/reset/')) {
      const response = await fetch('/mock-action', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:m.payload.path,body:JSON.parse(m.payload.body)})});
      status = response.status; body = await response.json();
    }
    frame.contentWindow.postMessage({channel:m.channel,v:1,type:'result',id:m.id,ok:true,payload:{status,body:JSON.stringify(body)}}, location.origin);
  }
});
</script></body></html>`;
const assets = new Map([
  ['/panel/index.html', ['dist/desktop-compat/panel/index.html', 'text/html; charset=utf-8']],
  ['/panel/main.js', ['dist/desktop-compat/panel/main.js', 'text/javascript; charset=utf-8']],
  ['/panel/style.css', ['dist/desktop-compat/panel/style.css', 'text/css; charset=utf-8']],
]);
const server = http.createServer(async (req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(harness); return; }
  if (req.url === '/health') { res.end('synthetic-only'); return; }
  if (req.url === '/mock-count') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ mock: true, writes })); return; }
  if (req.url === '/mock-action' && req.method === 'POST') {
    try {
      let text = '';
      for await (const chunk of req) { text += chunk; if (text.length > 4096) throw new Error(); }
      const { path, body } = JSON.parse(text);
      const methods = { '/reset/prepare': 'prepare', '/reset/confirm': 'confirm', '/reset/cancel': 'cancel', '/reset/review': 'review', '/reset/status': 'status' };
      if (!Object.hasOwn(methods, path)) throw new Error();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ operation: await actions[methods[path]](body) }));
    } catch (error) { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.code ?? 'MOCK_ERROR' })); }
    return;
  }
  if (req.url === '/__stop' && req.method === 'POST') { res.end('synthetic preview stopped'); server.close(); clearTimeout(timer); return; }
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const asset = assets.get(req.url);
  if (!asset) { res.writeHead(404); res.end(); return; }
  try { res.writeHead(200, { 'content-type': asset[1], 'cache-control': 'no-store' }); res.end(await readFile(asset[0])); }
  catch { res.writeHead(500); res.end(); }
});
server.listen(47831, '127.0.0.1', () => console.log(`Synthetic-only preview: http://127.0.0.1:47831 (mock actions ${mockActions ? 'ON' : 'OFF'}, no upstream; auto stops after 10 minutes)`));
const timer = setTimeout(() => { server.close(); server.closeAllConnections(); }, 600_000);
process.once('SIGTERM', () => { clearTimeout(timer); server.close(); server.closeAllConnections(); });
