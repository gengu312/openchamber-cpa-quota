import { connectHost } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';

const host = connectHost();
const root = document.querySelector('#root');
let mounted = false;
let busy = false;
let creditsBusy = false;
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const time = (ms) => ms === null ? '未知' : new Date(ms).toLocaleString('zh-CN', { hour12: false });
const number = (value) => value === null ? '未知' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
const freshness = { fresh: '可读', stale: '旧数据', unknown: '新鲜度未知' };
const statusNames = { available: '可用', unavailable: '不可用', error: '异常', disabled: '已停用', exhausted: '耗尽', rate_limited: '限流', unknown: '状态未知' };

host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  if (mounted) return;
  mounted = true;
  root.replaceChildren();
  const header = el('header');
  const heading = el('div');
  heading.append(el('span', 'CPA', 'eyebrow'), el('h1', '账号额度'));
  const refresh = el('button', '读取额度');
  refresh.type = 'button';
  header.append(heading, refresh);
  const notice = el('p', '只读聚合额度 · 不标记当前推理账号', 'muted');
  const banner = el('p', '', 'notice');
  banner.setAttribute('role', 'status');
  const meta = el('p', '', 'meta');
  const accounts = el('div');
  const credits = el('section', undefined, 'credits');
  const creditsHeader = el('div', undefined, 'section-heading');
  const query = el('button', '查询重置卡');
  query.type = 'button';
  creditsHeader.append(el('h2', 'Codex 重置卡'), query);
  const creditsContent = el('div');
  creditsContent.setAttribute('aria-live', 'polite');
  creditsContent.append(el('p', '尚未查询；密钥仅在服务端读取。', 'muted'));
  credits.append(creditsHeader, creditsContent, el('p', '按重置卡查询中的账号和工作区消费一次重置权益，不选择单张卡，不与额度账号自动关联。', 'muted'));
  const actionArea = el('div', undefined, 'reset-actions');
  const selectLabel = el('label', '重置目标账号与工作区');
  const select = el('select');
  select.setAttribute('aria-label', '重置目标账号与工作区');
  selectLabel.append(select);
  const ackLabel = el('label', undefined, 'acknowledgement');
  const ack = el('input'); ack.type = 'checkbox';
  ackLabel.append(ack, document.createTextNode('我确认所选账号和工作区，理解此操作会消耗一次重置权益且不可撤销'));
  const start = el('button', '继续确认重置'); start.type = 'button'; start.disabled = true;
  const actionMessage = el('p', '真实消费保持关闭；请求合同已接入，未发消费请求。', 'warning');
  actionMessage.setAttribute('role', 'status');
  const review = el('button', '刷新卡数与额度并核对'); review.type = 'button'; review.hidden = true;
  actionArea.append(selectLabel, ackLabel, start, actionMessage, review);
  credits.append(actionArea);
  const dialog = el('dialog');
  const dialogTitle = el('h2', '再次确认重置');
  const dialogDescription = el('p');
  const cancel = el('button', '取消'); cancel.type = 'button';
  const confirm = el('button', '确认消耗一次重置权益'); confirm.type = 'button';
  const dialogButtons = el('div', undefined, 'section-heading'); dialogButtons.append(cancel, confirm);
  dialog.append(dialogTitle, dialogDescription, dialogButtons);
  dialog.setAttribute('aria-label', '再次确认账号级重置');
  credits.append(dialog);
  let resetView;
  let actionBusy = false;
  let operation;
  const actionStates = { preparing: '准备中', 'awaiting-confirmation': '等待二次确认', running: '正在处理，请勿重复提交', succeeded: '已按已验证响应确认成功', rejected: '请求被拒绝或未发送；不会自动重试', cancelled: '已取消，未消费', 'outcome-unknown': '可能已使用，请先刷新卡数与额度核对；不会自动重试', 'refresh-required': '消费已确认，但查询刷新未完成，请核对', 'journal-error': '操作状态保存异常，已锁定；禁止重发' };
  const actionCodes = { DISABLED: '真实消费保持关闭', FORBIDDEN: '请求被拒绝：可能是权限或使用策略限制，不能仅凭 403 判断开关原因', UNAUTHORIZED: '消费认证被拒绝', NO_CREDITS: '无可用重置次数', NO_RESETTABLE_QUOTA: '无可重置额度', ALREADY_REDEEMED: '该操作已兑换', SELECTION_CHANGED: '所选账号/工作区或查询数据已变化，请核对', ACCOUNT_LOCKED: '同账号已有待确认或结果待核对的操作', STALE_QUERY: '查询过旧，请刷新', JOURNAL_UNAVAILABLE: '操作状态无法安全保存，未发起消费' };
  const updateStart = () => {
    const account = resetView?.data?.accounts.find((account) => account.id === select.value);
    const stale = resetView?.stale || resetView?.errorCode || !Number.isFinite(resetView?.data?.generatedAt) || Date.now() - resetView.data.generatedAt > 600_000;
    const blocked = operation?.targetId === select.value && ['preparing', 'running', 'outcome-unknown', 'refresh-required', 'journal-error'].includes(operation.state);
    start.disabled = actionBusy || blocked || stale || !resetView?.actions?.enabled || !account?.selectable || account.error || !(account.availableCount > 0) || !ack.checked;
  };
  const callAction = async (path, body) => {
    const response = await host.serviceRequest({ method: 'POST', path, body: JSON.stringify(body) });
    const result = JSON.parse(response.body);
    if (response.status !== 200 || !result.operation) throw new Error(actionCodes[result.error] ?? '操作未完成；不要重复提交，请查询核对');
    operation = result.operation;
    actionMessage.textContent = `${actionStates[operation.state] ?? '结果未知'}${operation.code ? ` · ${actionCodes[operation.code] ?? '响应或传输结果未确认'}` : ''}`;
    review.hidden = !['running', 'outcome-unknown', 'refresh-required', 'journal-error'].includes(operation.state);
    return operation;
  };
  select.addEventListener('change', () => {
    ack.checked = false;
    const known = resetView?.operations?.[select.value];
    if (known) {
      operation = known;
      actionMessage.textContent = actionStates[known.state] ?? '结果未知，请核对';
      review.hidden = !['running', 'outcome-unknown', 'refresh-required', 'journal-error'].includes(known.state);
    } else { operation = null; review.hidden = true; }
    updateStart();
  });
  ack.addEventListener('change', updateStart);
  start.addEventListener('click', async () => {
    if (start.disabled || actionBusy) return;
    const account = resetView.data.accounts.find((account) => account.id === select.value);
    actionBusy = true; updateStart();
    try {
      const prepared = await callAction('/reset/prepare', { targetId: account.id, sourceRevision: account.sourceRevision, acknowledge: ack.checked });
      if (prepared.state !== 'awaiting-confirmation') return;
      dialogDescription.textContent = `${prepared.account} / ${prepared.workspace}；查询可用 ${prepared.availableCount} 次。确认后将尝试消耗一次重置权益，不会自动重试。操作 ${prepared.operationId}`;
      confirm.disabled = false; cancel.disabled = false;
      dialog.showModal();
    } catch (error) { actionMessage.textContent = error.message; }
    finally { actionBusy = false; updateStart(); }
  });
  const cancelOperation = async () => {
    if (actionBusy || !operation) return;
    actionBusy = true; cancel.disabled = true; confirm.disabled = true;
    try { await callAction('/reset/cancel', { operationId: operation.operationId }); }
    catch (error) { actionMessage.textContent = error.message; }
    finally { dialog.close(); actionBusy = false; ack.checked = false; updateStart(); }
  };
  cancel.addEventListener('click', cancelOperation);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); void cancelOperation(); });
  confirm.addEventListener('click', async () => {
    if (actionBusy || !operation) return;
    actionBusy = true; confirm.disabled = true; cancel.disabled = true; updateStart();
    try {
      const result = await callAction('/reset/confirm', { operationId: operation.operationId, confirmation: '确认消耗一次重置权益' });
      if (result.state === 'succeeded') { await load(); await loadCredits(); }
    } catch {
      actionMessage.textContent = '确认请求中断，可能已使用；请先刷新核对，禁止重新发起'; review.hidden = false;
    } finally { dialog.close(); actionBusy = false; ack.checked = false; updateStart(); }
  });
  review.addEventListener('click', async () => {
    if (actionBusy || !operation) return;
    actionBusy = true; review.disabled = true; updateStart();
    try { await callAction('/reset/review', { operationId: operation.operationId }); await load(); await loadCredits(); }
    catch (error) { actionMessage.textContent = error.message; }
    finally { actionBusy = false; review.disabled = false; updateStart(); }
  });
  const boundary = el('details', undefined, 'boundary');
  boundary.append(el('summary', '跨端与版本限制'), el('p', '本页是桌面/网页扩展面板，不是手机入口。OpenChamber 2.6.1 不支持原生 quota 角色；支持新合同的宿主可把同一服务的只读额度及卡数显示到手机。usage.read 不提供写按钮；手机消费入口尚未接入。', 'muted'));
  root.append(header, notice, banner, meta, accounts, credits, boundary);

  async function load() {
    if (busy) return;
    busy = true;
    refresh.disabled = true;
    refresh.textContent = '读取中…';
    try {
      const response = await host.serviceRequest({ method: 'GET', path: '/snapshot' });
      if (response.status !== 200) throw new Error();
      const view = JSON.parse(response.body);
      banner.textContent = view.error ? `${view.error}${view.data ? '；保留上次读取的旧数据' : ''}` : view.data?.upstreamError ? '上游报告部分错误，原始错误已隐藏' : '';
      meta.textContent = `本地读取 ${time(view.fetchedAt)} · 源更新 ${time(view.data?.updatedAt ?? null)}`;
      accounts.replaceChildren();
      if (!view.data) accounts.append(el('p', '暂无可用额度。', 'muted'));
      for (const account of view.data?.accounts ?? []) {
        const section = el('section', undefined, 'account');
        const title = el('div', undefined, 'account-title');
        title.append(el('h2', account.label), el('span', `${freshness[account.freshness]} · ${statusNames[account.status]}`, account.freshness === 'fresh' && !account.error ? 'muted' : 'warning'));
        section.append(title, el('p', `源更新 ${time(account.updatedAt ?? view.data.updatedAt)}${account.plan ? ` · ${account.plan}` : ''}${account.error ? ' · 账号读取异常' : ''}`, 'meta'));
        if (!account.windows.length) section.append(el('p', '无可用窗口，不能视为零用量。', 'muted'));
        for (const window of account.windows) {
          const row = el('div', undefined, 'window');
          const line = el('div', undefined, 'window-line');
          line.append(el('span', `${window.label} · ${window.id.slice(0, 6)}`), el('strong', `剩余 ${window.remainingPercent === null ? '未知' : `${number(window.remainingPercent)}%`}`));
          row.append(line);
          if (window.remainingPercent !== null) {
            const progress = el('progress');
            progress.max = 100;
            progress.value = window.remainingPercent;
            progress.setAttribute('aria-label', `${account.label} ${window.label} 剩余额度`);
            row.append(progress);
          }
          row.append(el('p', `已用 ${window.usedPercent === null ? '未知' : `${number(window.usedPercent)}%`} · 重置 ${time(window.resetAt)}`, 'meta'));
          const detail = el('details');
          detail.append(el('summary', window.usageError ? 'Token / 成本明细不可用或不完整' : 'Token / 成本明细'));
          const values = el('dl');
          for (const [label, value] of [['当前 Token', window.currentTokens], ['当前成本（上游单位）', window.currentCost], ['估算 Token', window.estimatedTokens], ['估算成本（上游单位，非实际扣款）', window.estimatedCost]]) values.append(el('dt', label), el('dd', number(value)));
          detail.append(values);
          row.append(detail);
          section.append(row);
        }
        accounts.append(section);
      }
    } catch {
      banner.textContent = '无法读取扩展服务；请确认已在设置中授权本地服务。已有画面不是最新数据。';
    } finally {
      busy = false;
      refresh.disabled = false;
      refresh.textContent = '读取额度';
    }
  }
  refresh.addEventListener('click', load);
  async function loadCredits() {
    if (creditsBusy) return;
    creditsBusy = true;
    query.disabled = true;
    try {
      const response = await host.serviceRequest({ method: 'GET', path: '/reset-credits' });
      if (response.status !== 200) throw new Error();
      const view = JSON.parse(response.body);
      resetView = view;
      select.replaceChildren(el('option', '请选择账号与工作区'));
      select.options[0].value = '';
      creditsContent.replaceChildren();
      if (view.error) creditsContent.append(el('p', view.error, 'warning'));
      const generatedAt = view.data?.generatedAt ?? null;
      const old = view.stale || generatedAt === null || Date.now() - generatedAt > 600_000 || generatedAt > Date.now() + 60_000;
      creditsContent.append(el('p', `${old ? '旧数据/时间未知 · ' : ''}源生成 ${time(generatedAt)} · 本地读取 ${time(view.fetchedAt)}`, 'meta'));
      for (const account of view.data?.accounts ?? []) {
        const row = el('div', undefined, 'window-line');
        row.append(el('span', account.label), el('strong', `${account.availableCount === null ? '数量未知' : `${account.availableCount} 张`}${account.error ? ' · 查询异常' : ''}`));
        row.append(el('span', account.workspace, 'meta'));
        creditsContent.append(row);
        const option = el('option', `${account.label} / ${account.workspace} · ${account.availableCount ?? '未知'} 次`);
        option.value = account.id; option.disabled = old || !account.selectable || account.error || !(account.availableCount > 0); select.append(option);
      }
      if (!view.data?.accounts.length) creditsContent.append(el('p', '没有可确认的卡片数量。', 'muted'));
      creditsContent.append(el('p', '账号级协议不选择单卡；有效期未知，不表示永久有效。', 'muted'));
      if (!view.actions.enabled) actionMessage.textContent = view.actions.reason;
      ack.checked = false;
    } catch {
      creditsContent.replaceChildren(el('p', '重置卡查询失败；请重读核对，不能据此消费。', 'warning'));
      resetView = null;
    } finally { creditsBusy = false; query.disabled = false; updateStart(); }
  }
  query.addEventListener('click', loadCredits);
  void load();
});

window.addEventListener('pagehide', () => host.dispose(), { once: true });
