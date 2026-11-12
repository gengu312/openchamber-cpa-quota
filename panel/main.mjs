import { connectHost } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { formatCompact, formatNumber, percentText, remainingTone, resetCountdown, windowPeriod, groupWindows, normalizeOrder, orderAccounts, moveAccount, placeAccount, accountFreshness, accountSummary, orderFocusControl } from './view-model.mjs';

const host = connectHost();
const root = document.querySelector('#root');
let mounted = false;
let busy = false;
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const time = (ms) => ms === null ? '未知' : new Date(ms).toLocaleString('zh-CN', { hour12: false });
const statusNames = { available: '可用', unavailable: '不可用', error: '异常', disabled: '已停用', exhausted: '耗尽', rate_limited: '限流', unknown: '状态未知' };
const icon = (name) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  const paths = name === 'antigravity' ? ['M4 19 12 4l8 15M8 14h8'] : name === 'claude'
    ? ['m12 3 1 6 4-5-2 6 6-2-5 4 5 2-6 1 2 6-4-4-1 5-2-6-4 4 2-6-6 1 5-3-5-3 6 1-2-6 4 5Z']
    : name === 'codex' ? ['m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18'] : ['M5 18V9m7 9V4m7 14v-6'];
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d); svg.append(path);
  }
  return svg;
};

host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  if (mounted) return;
  mounted = true;
  root.replaceChildren();
  const header = el('header', undefined, 'page-header');
  const heading = el('div');
  heading.append(el('span', 'CPA QUOTA', 'eyebrow'), el('h1', '额度总览'));
  const refresh = el('button', '刷新额度', 'primary-button');
  refresh.type = 'button';
  header.append(heading, refresh);
  const banner = el('p', '', 'notice');
  banner.setAttribute('role', 'status');
  const meta = el('p', '', 'meta');
  const overview = el('div', undefined, 'overview');
  const toolbar = el('div', undefined, 'toolbar');
  const orderMessage = el('span', '', 'meta order-message'); orderMessage.setAttribute('role', 'status');
  const arrange = el('button', '调整顺序', 'quiet-button'); arrange.type = 'button'; arrange.setAttribute('aria-pressed', 'false');
  const restore = el('button', '恢复默认', 'quiet-button'); restore.type = 'button'; restore.hidden = true;
  const retryOrder = el('button', '重试保存', 'quiet-button'); retryOrder.type = 'button'; retryOrder.hidden = true;
  const toolbarButtons = el('div', undefined, 'toolbar-buttons'); toolbarButtons.append(retryOrder, restore, arrange);
  toolbar.append(orderMessage, toolbarButtons);
  const accounts = el('div', undefined, 'accounts'); accounts.setAttribute('aria-label', '账号额度列表');
  const positionMessage = el('span', '', 'sr-only'); positionMessage.setAttribute('role', 'status');
  const orderKey = 'account-order-v1';
  let currentView;
  let accountOrder = [];
  let arranging = false;
  let draggedId = null;
  let saveQueue = Promise.resolve();
  let saveVersion = 0;
  let orderDirty = false;
  let readFailed = false;

  // Per-account reset card state, keyed by quota account id.
  // credits holds the latest query result per resetKey; actions holds live UI/operation state per quota account id.
  let resetCredits = null; // last /reset-credits view
  let creditsBusy = false;
  let creditsQueried = false;
  const actionStates = { preparing: '准备中', 'awaiting-confirmation': '等待二次确认', running: '正在处理，请勿重复提交', succeeded: '已按已验证响应确认成功', rejected: '请求被拒绝或未发送；不会自动重试', cancelled: '已取消，未消费', 'outcome-unknown': '可能已使用，请先刷新卡数与额度核对；不会自动重试', 'refresh-required': '消费已确认，但查询刷新未完成，请核对', 'journal-error': '操作状态保存异常，已锁定；禁止重发' };
  const actionCodes = { DISABLED: '真实消费保持关闭', FORBIDDEN: '请求被拒绝：可能是权限或使用策略限制，不能仅凭 403 判断开关原因', UNAUTHORIZED: '消费认证被拒绝', NO_CREDITS: '无可用重置次数', NO_RESETTABLE_QUOTA: '无可重置额度', ALREADY_REDEEMED: '该操作已兑换', SELECTION_CHANGED: '所选账号/工作区或查询数据已变化，请核对', ACCOUNT_LOCKED: '同账号已有待确认或结果待核对的操作', STALE_QUERY: '查询过旧，请刷新', JOURNAL_UNAVAILABLE: '操作状态无法安全保存，未发起消费', CONFIRMATION_EXPIRED: '确认已过期，请重新发起', CONFIRMATION_INVALID: '确认无效或已过期', ACKNOWLEDGEMENT_REQUIRED: '请先勾选确认说明', OPERATION_NOT_FOUND: '操作不存在或已过期', ACTION_UNAVAILABLE: '操作不可用，请稍后重试' };
  const resetStates = new Map(); // quotaAccountId -> { busy, ack, operation, message, dialogOpen }
  const stateFor = (accountId) => {
    if (!resetStates.has(accountId)) resetStates.set(accountId, { busy: false, ack: false, operation: null, message: '', dialogOpen: false });
    return resetStates.get(accountId);
  };
  const matchedCredit = (account) => (resetCredits?.data?.accounts ?? []).filter((credit) => credit.resetKey === account.resetKey);
  const creditFresh = () => {
    const generatedAt = resetCredits?.data?.generatedAt ?? null;
    return resetCredits && !resetCredits.stale && !resetCredits.errorCode && generatedAt !== null
      && Date.now() - generatedAt <= 600_000 && generatedAt <= Date.now() + 60_000;
  };

  const boundary = el('details', undefined, 'boundary');
  boundary.append(el('summary', '跨端与版本限制'), el('p', '本页是桌面/网页扩展面板，不是手机入口。OpenChamber 2.6.1 不支持原生 quota 角色；支持新合同的宿主可把同一服务的只读额度及卡数显示到手机。usage.read 不提供写按钮；手机消费入口尚未接入。', 'muted'));
  const footnote = el('p', '账号与配额池独立计量 · 未标记当前推理账号', 'footer-note');
  root.append(header, meta, banner, overview, toolbar, positionMessage, accounts, footnote, boundary);

  const callAction = async (accountId, path, body) => {
    const response = await host.serviceRequest({ method: 'POST', path, body: JSON.stringify(body) });
    const result = JSON.parse(response.body);
    if (response.status !== 200 || !result.operation) throw new Error(actionCodes[result.error] ?? '操作未完成；不要重复提交，请查询核对');
    return result.operation;
  };

  function renderResetArea(section, account) {
    const state = stateFor(account.id);
    const matches = matchedCredit(account);
    const fresh = creditFresh();
    const credit = matches.length === 1 ? matches[0] : null;
    const creditArea = el('div', undefined, 'credit-area');
    creditArea.dataset.accountId = account.id;
    const head = el('div', undefined, 'credit-head');
    head.append(el('span', 'Codex 重置卡', 'credit-title'));
    const query = el('button', creditsBusy ? '查询中…' : '查询数量', 'quiet-button credit-query');
    query.type = 'button';
    query.disabled = creditsBusy;
    query.addEventListener('click', () => void loadCredits());
    head.append(query);
    creditArea.append(head);
    if (!creditsQueried) {
      creditArea.append(el('p', '尚未查询；密钥仅在服务端读取。仅查询数量，不会消耗重置卡。', 'meta'));
    } else if (!resetCredits) {
      creditArea.append(el('p', '重置卡查询失败；请重读核对，不能据此消费。', 'warning'));
    } else {
      const generatedAt = resetCredits.data?.generatedAt ?? null;
      if (!fresh) creditArea.append(el('p', `旧数据/时间未知 · 源生成 ${time(generatedAt)} · 本地读取 ${time(resetCredits.fetchedAt)}`, 'meta'));
      if (resetCredits.error) creditArea.append(el('p', resetCredits.error, 'warning'));
      if (matches.length > 1) creditArea.append(el('p', '匹配到多条重置卡记录，已按不可用处理；请核对上游账号。', 'warning'));
      else if (!credit) creditArea.append(el('p', '没有与本账号匹配的重置卡记录。', 'meta'));
      else {
        creditArea.append(el('p', `${credit.workspace} · 可用 ${credit.availableCount === null ? '数量未知' : `${credit.availableCount} 张`}${credit.error ? ' · 查询异常' : ''}`, 'credit-count'));
      }
    }
    const actionsEnabled = resetCredits?.actions?.enabled === true;
    const details = el('details', undefined, 'action-details');
    details.open = state.dialogOpen || state.ack || state.operation !== null;
    const summary = el('summary', actionsEnabled ? '手动使用重置权益' : '手动重置 · 当前关闭');
    details.append(summary);
    const area = el('div', undefined, 'reset-actions');
    if (actionsEnabled && credit && fresh) {
      const ackLabel = el('label', undefined, 'acknowledgement');
      const ack = el('input'); ack.type = 'checkbox'; ack.checked = state.ack;
      ackLabel.append(ack, document.createTextNode('我确认本账号与工作区，理解此操作会消耗一次重置权益且不可撤销'));
      area.append(ackLabel);
      const start = el('button', '继续确认重置'); start.type = 'button';
      const blocked = state.operation && ['preparing', 'running', 'outcome-unknown', 'refresh-required', 'journal-error'].includes(state.operation.state);
      start.disabled = state.busy || blocked || !credit.selectable || credit.error || !(credit.availableCount > 0) || !ack.checked;
      ack.addEventListener('change', () => { state.ack = ack.checked; start.disabled = state.busy || blocked || !credit.selectable || credit.error || !(credit.availableCount > 0) || !ack.checked; });
      start.addEventListener('click', async () => {
        if (start.disabled || state.busy) return;
        state.busy = true; state.message = ''; rerenderReset(account.id);
        try {
          const prepared = await callAction(account.id, '/reset/prepare', { targetId: credit.id, sourceRevision: credit.sourceRevision, acknowledge: true });
          state.operation = prepared;
          if (prepared.state !== 'awaiting-confirmation') { state.message = actionStates[prepared.state] ?? '结果未知'; rerenderReset(account.id); return; }
          state.dialogOpen = true;
          showDialog(account, credit, prepared);
        } catch (error) { state.message = error.message; rerenderReset(account.id); }
        finally { state.busy = false; }
      });
      area.append(start);
    } else {
      area.append(el('p', actionsEnabled ? '需要先查询到新鲜且匹配的重置卡记录，才能手动使用。' : (resetCredits?.actions?.reason ?? '真实消费保持关闭；请求合同已接入，未发消费请求。'), actionsEnabled ? 'meta' : 'warning'));
    }
    if (state.operation) {
      const known = resetCredits?.operations?.[state.operation.targetId] ?? state.operation;
      state.operation = known;
      area.append(el('p', `${actionStates[known.state] ?? '结果未知，请核对'}${known.code ? ` · ${actionCodes[known.code] ?? '响应或传输结果未确认'}` : ''}`, 'warning'));
      if (['running', 'outcome-unknown', 'refresh-required', 'journal-error'].includes(known.state)) {
        const review = el('button', '刷新卡数与额度并核对', 'quiet-button'); review.type = 'button'; review.disabled = state.busy;
        review.addEventListener('click', async () => {
          if (state.busy) return;
          state.busy = true; rerenderReset(account.id);
          try { state.operation = await callAction(account.id, '/reset/review', { operationId: known.operationId }); await load(); await loadCredits(); }
          catch (error) { state.message = error.message; }
          finally { state.busy = false; rerenderReset(account.id); }
        });
        area.append(review);
      }
    }
    if (state.message) area.append(el('p', state.message, 'warning'));
    details.append(area);
    creditArea.append(details);
    return creditArea;
  }

  let dialogAccount = null;
  const dialog = el('dialog');
  const dialogTitle = el('h2', '再次确认重置');
  const dialogDescription = el('p');
  const cancel = el('button', '取消'); cancel.type = 'button';
  const confirm = el('button', '确认消耗一次重置权益'); confirm.type = 'button';
  const dialogButtons = el('div', undefined, 'section-heading'); dialogButtons.append(cancel, confirm);
  dialog.append(dialogTitle, dialogDescription, dialogButtons);
  dialog.setAttribute('aria-label', '再次确认账号级重置');
  root.append(dialog);

  function showDialog(account, credit, prepared) {
    dialogAccount = { account, credit };
    dialogDescription.textContent = `${prepared.account} / ${prepared.workspace}；查询可用 ${prepared.availableCount} 次。确认后将尝试消耗一次重置权益，不会自动重试。操作 ${prepared.operationId}`;
    confirm.disabled = false; cancel.disabled = false;
    dialog.showModal();
  }
  const closeDialog = () => {
    if (dialogAccount) { const state = stateFor(dialogAccount.account.id); state.dialogOpen = false; }
    dialogAccount = null;
    dialog.close();
  };
  const cancelOperation = async () => {
    if (!dialogAccount) return closeDialog();
    const { account } = dialogAccount;
    const state = stateFor(account.id);
    if (state.busy || !state.operation) return closeDialog();
    state.busy = true; cancel.disabled = true; confirm.disabled = true;
    try { state.operation = await callAction(account.id, '/reset/cancel', { operationId: state.operation.operationId }); state.ack = false; }
    catch (error) { state.message = error.message; }
    finally { closeDialog(); state.busy = false; rerenderReset(account.id); }
  };
  cancel.addEventListener('click', cancelOperation);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); void cancelOperation(); });
  confirm.addEventListener('click', async () => {
    if (!dialogAccount) return;
    const { account } = dialogAccount;
    const state = stateFor(account.id);
    if (state.busy || !state.operation) return;
    state.busy = true; confirm.disabled = true; cancel.disabled = true;
    try {
      const result = await callAction(account.id, '/reset/confirm', { operationId: state.operation.operationId, confirmation: '确认消耗一次重置权益' });
      state.operation = result;
      state.ack = false;
      if (result.state === 'succeeded') { await load(); await loadCredits(); }
    } catch {
      state.message = '确认请求中断，可能已使用；请先刷新核对，禁止重新发起';
    } finally { closeDialog(); state.busy = false; rerenderReset(account.id); }
  });

  function rerenderReset(accountId) {
    const section = accounts.querySelector(`[data-account-id="${accountId}"]`);
    if (!section) return;
    const account = (currentView?.data?.accounts ?? []).find((item) => item.id === accountId);
    if (!account) return;
    section.querySelector('.credit-area')?.replaceWith(renderResetArea(section, account));
  }

  function renderAccounts() {
    const active = document.activeElement;
    const focusedAccount = active?.closest('[data-account-id]')?.dataset.accountId;
    const focusedControl = active?.dataset.orderControl;
    accounts.replaceChildren();
    const items = orderAccounts(currentView?.data?.accounts ?? [], accountOrder);
    const summary = accountSummary(items, currentView, Date.now(), readFailed);
    overview.replaceChildren();
    for (const [label, value, tone] of [['账号', summary.total, ''], ['新鲜且可用', summary.available, 'success-text'], ['低额度（新鲜）', summary.low, summary.low ? 'warning-text' : '']]) {
      const stat = el('div', undefined, 'overview-stat'); stat.append(el('strong', String(value), tone), el('span', label)); overview.append(stat);
    }
    if (!items.length) accounts.append(el('p', '暂无可用额度，请检查服务配置后刷新。', 'empty-state'));
    for (const [index, account] of items.entries()) {
      const section = el('section', undefined, `account${arranging ? ' is-arranging' : ''}`);
      section.dataset.accountId = account.id;
      const freshness = accountFreshness(account, currentView, Date.now(), readFailed);
      section.dataset.freshness = freshness;
      const identity = el('div', undefined, 'account-identity');
      const mark = el('span', undefined, `provider-mark provider-${account.provider}`); mark.append(icon(account.provider));
      const name = el('div', undefined, 'account-name');
      name.append(el('h2', account.label));
      const accountMeta = el('div', undefined, 'account-meta');
      if (account.plan) accountMeta.append(el('span', account.plan, 'plan-badge'));
      const good = account.status === 'available' && !account.error;
      accountMeta.append(el('span', account.error ? '读取异常' : statusNames[account.status], `status-badge ${good ? 'status-success' : 'status-warning'}`));
      accountMeta.append(el('span', freshness === 'fresh' ? '数据新鲜' : freshness === 'stale' ? '旧数据' : '新鲜度未知', `status-badge ${freshness === 'fresh' ? 'status-neutral' : 'status-warning'}`));
      name.append(accountMeta); identity.append(mark, name);
      const reorder = el('div', undefined, 'reorder-controls'); reorder.hidden = !arranging;
      const handle = el('button', '⠿', 'drag-handle'); handle.type = 'button'; handle.draggable = true;
      handle.setAttribute('aria-label', `拖动或按上下键排序 ${account.label}`); handle.title = '拖动排序；也可用 ↑ ↓ 键';
      handle.addEventListener('keydown', (event) => {
        if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault(); void persistOrder(moveAccount(items, accountOrder, account.id, event.key === 'ArrowUp' ? -1 : 1), account.id, 'handle');
      });
      handle.dataset.orderControl = 'handle';
      handle.addEventListener('dragstart', (event) => {
        draggedId = account.id; section.classList.add('dragging');
        event.dataTransfer.setData('text/plain', account.id); event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setDragImage(section, 20, 20);
      });
      handle.addEventListener('dragend', () => { draggedId = null; section.classList.remove('dragging'); accounts.querySelectorAll('.drop-target').forEach((node) => node.classList.remove('drop-target')); });
      reorder.append(handle);
      for (const [symbol, direction, label] of [['↑', -1, '上移'], ['↓', 1, '下移']]) {
        const button = el('button', symbol, 'move-button'); button.type = 'button';
        button.setAttribute('aria-label', `${label} ${account.label}`); button.title = label; button.dataset.orderControl = label;
        button.disabled = direction === -1 ? index === 0 : index === items.length - 1;
        button.addEventListener('click', () => void persistOrder(moveAccount(items, accountOrder, account.id, direction), account.id, label));
        reorder.append(button);
      }
      identity.append(reorder);
      section.addEventListener('dragover', (event) => { if (arranging && draggedId && draggedId !== account.id) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; section.classList.add('drop-target'); } });
      section.addEventListener('dragleave', (event) => { if (!section.contains(event.relatedTarget)) section.classList.remove('drop-target'); });
      section.addEventListener('drop', (event) => {
        if (!arranging || !draggedId) return;
        event.preventDefault(); const id = draggedId; draggedId = null;
        void persistOrder(placeAccount(items, accountOrder, id, account.id), id, 'handle');
      });
      section.append(identity);
      const windows = el('div', undefined, 'account-windows');
      if (!account.windows.length) windows.append(el('p', '窗口暂不可用，不代表零用量。', 'meta'));
      for (const group of groupWindows(account.windows)) {
        const pool = el('div', undefined, 'pool-grid');
        for (const window of group.windows) {
          const row = el('div', undefined, 'quota-window'); row.dataset.tone = remainingTone(window.remainingPercent);
          const line = el('div', undefined, 'window-line');
          const duplicate = group.windows.filter((other) => other.windowSeconds === window.windowSeconds).length > 1;
          const title = el('span', `${group.name === '额度' ? '' : `${group.name} · `}${windowPeriod(window)}${duplicate ? ` · 池 ${window.id.slice(0, 6)}` : ''}`, 'window-label');
          title.title = `窗口 ${window.id.slice(0, 6)}`;
          const value = el('span', undefined, 'quota-value'); value.append(el('strong', percentText(window.remainingPercent)), document.createTextNode(' 剩余'));
          line.append(title, value); row.append(line);
          const track = el('div', undefined, `quota-track${window.remainingPercent === null ? ' quota-unknown' : ''}`);
          track.setAttribute('role', 'progressbar'); track.setAttribute('aria-label', `${account.label} ${title.textContent} 剩余额度`);
          track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100');
          if (window.remainingPercent !== null) {
            track.setAttribute('aria-valuenow', String(window.remainingPercent));
            const fill = el('span', undefined, 'quota-fill'); fill.style.width = `${window.remainingPercent}%`; track.append(fill);
          } else track.setAttribute('aria-valuetext', '未知');
          row.append(track);
          const detail = el('details', undefined, 'window-details'); detail.dataset.windowId = window.id;
          const countdown = el('summary', resetCountdown(window.resetAt), 'reset-time');
          countdown.dataset.resetAt = window.resetAt ?? ''; detail.append(countdown);
          detail.append(el('p', `精确重置时间 ${time(window.resetAt)}`, 'meta'));
          if ([window.currentTokens, window.currentCost, window.estimatedTokens, window.estimatedCost].some((v) => v !== null)) {
            const usage = el('div', undefined, 'usage-lines');
            usage.append(el('p', `当前 ${formatNumber(window.currentCost)} 成本 / ${formatCompact(window.currentTokens)} Token`), el('p', `估算 ${formatNumber(window.estimatedCost)} 成本 / ${formatCompact(window.estimatedTokens)} Token`));
            usage.append(el('p', '成本为上游单位；估算非实际扣款。')); detail.append(usage);
          }
          row.append(detail);
          pool.append(row);
        }
        windows.append(pool);
      }
      section.append(windows);
      if (account.provider === 'codex') section.append(renderResetArea(section, account));
      const footer = el('div', undefined, 'account-footer');
      const timestamp = account.updatedAt ?? currentView.data.updatedAt;
      footer.append(el('span', `源更新 ${time(timestamp)}`));
      if (account.windows.some((w) => w.usageError)) footer.append(el('span', '部分 Token / 成本明细暂缺'));
      section.append(footer); accounts.append(section);
    }
    if (focusedAccount && focusedControl) {
      const index = items.findIndex((account) => account.id === focusedAccount);
      const control = orderFocusControl(focusedControl, index, items.length);
      accounts.querySelector(`[data-account-id="${focusedAccount}"] [data-order-control="${control}"]`)?.focus();
    }
  }

  async function saveOrder() {
    const savedOrder = [...accountOrder]; const version = ++saveVersion;
    orderDirty = true;
    retryOrder.hidden = false; retryOrder.disabled = true;
    orderMessage.textContent = '正在保存顺序…'; orderMessage.classList.remove('warning');
    const write = saveQueue.then(() => host.storage.set(orderKey, savedOrder));
    saveQueue = write.catch(() => {});
    try {
      await write;
      if (version === saveVersion) { orderDirty = false; retryOrder.hidden = true; orderMessage.textContent = '顺序已保存'; }
    } catch {
      if (version === saveVersion) { orderMessage.textContent = '顺序未保存，请重试保存'; orderMessage.classList.add('warning'); }
    } finally { if (version === saveVersion) retryOrder.disabled = false; }
  }
  async function persistOrder(next, focusId, control) {
    accountOrder = normalizeOrder([...next, ...accountOrder.filter((id) => !next.includes(id))]);
    const expanded = new Set([...accounts.querySelectorAll('.window-details[open]')].map((node) => node.dataset.windowId));
    renderAccounts();
    accounts.querySelectorAll('.window-details').forEach((node) => { node.open = expanded.has(node.dataset.windowId); });
    if (focusId) {
      const items = orderAccounts(currentView?.data?.accounts ?? [], accountOrder);
      const index = items.findIndex((account) => account.id === focusId);
      accounts.querySelector(`[data-account-id="${focusId}"] [data-order-control="${orderFocusControl(control, index, items.length)}"]`)?.focus();
      positionMessage.textContent = `已移至第 ${index + 1} 位，共 ${items.length} 个账号`;
    }
    await saveOrder();
    if (focusId && !orderDirty) {
      const index = orderAccounts(currentView?.data?.accounts ?? [], accountOrder).findIndex((account) => account.id === focusId);
      orderMessage.textContent = `顺序已保存 · 第 ${index + 1} 位，共 ${currentView.data.accounts.length} 个账号`;
    }
  }
  retryOrder.addEventListener('click', () => void saveOrder());
  arrange.addEventListener('click', () => {
    arranging = !arranging; arrange.textContent = arranging ? '完成排序' : '调整顺序'; arrange.setAttribute('aria-pressed', String(arranging));
    restore.hidden = !arranging;
    if (!orderDirty) orderMessage.textContent = arranging ? '拖动手柄，或用 ↑ ↓ 调整' : '';
    const expanded = new Set([...accounts.querySelectorAll('.window-details[open]')].map((node) => node.dataset.windowId));
    renderAccounts();
    accounts.querySelectorAll('.window-details').forEach((node) => { node.open = expanded.has(node.dataset.windowId); });
  });
  restore.addEventListener('click', () => {
    accountOrder = []; void persistOrder((currentView?.data?.accounts ?? []).map((account) => account.id));
  });

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
      meta.textContent = `源更新 ${time(view.data?.updatedAt ?? null)}${view.stale ? ' · 正在显示旧数据' : ''}`;
      readFailed = false; currentView = view; renderAccounts();
    } catch {
      banner.textContent = '无法读取扩展服务；请确认已在设置中授权本地服务。已有画面不是最新数据。';
      readFailed = true; if (currentView) renderAccounts();
    } finally {
      busy = false;
      refresh.disabled = false;
      refresh.textContent = '刷新额度';
    }
  }
  refresh.addEventListener('click', load);
  async function loadCredits() {
    if (creditsBusy) return;
    creditsBusy = true;
    renderAccounts();
    try {
      const response = await host.serviceRequest({ method: 'GET', path: '/reset-credits' });
      if (response.status !== 200) throw new Error();
      resetCredits = JSON.parse(response.body);
      creditsQueried = true;
      // Sync any known operations into per-account state.
      for (const account of currentView?.data?.accounts ?? []) {
        const state = stateFor(account.id);
        for (const credit of matchedCredit(account)) {
          const known = resetCredits.operations?.[credit.id];
          if (known) state.operation = known;
        }
      }
    } catch {
      resetCredits = null;
      creditsQueried = true;
    } finally { creditsBusy = false; renderAccounts(); }
  }
  void (async () => {
    try { accountOrder = normalizeOrder(await host.storage.get(orderKey)); }
    catch { orderMessage.textContent = '未读取到保存的顺序'; }
    await load();
  })();
  const countdownTimer = setInterval(() => {
    if (document.hidden) return;
    updateLocalTime();
  }, 60_000);
  function updateLocalTime() {
    if (!currentView) return;
    const changed = (currentView.data?.accounts ?? []).some((account) => accounts.querySelector(`[data-account-id="${account.id}"]`)?.dataset.freshness !== accountFreshness(account, currentView, Date.now(), readFailed));
    if (changed && !draggedId) {
      const expanded = new Set([...accounts.querySelectorAll('.window-details[open]')].map((node) => node.dataset.windowId));
      renderAccounts();
      accounts.querySelectorAll('.window-details').forEach((node) => { node.open = expanded.has(node.dataset.windowId); });
    }
    accounts.querySelectorAll('[data-reset-at]').forEach((node) => { node.textContent = resetCountdown(node.dataset.resetAt === '' ? null : Number(node.dataset.resetAt)); });
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) updateLocalTime(); });
  window.addEventListener('pagehide', () => clearInterval(countdownTimer), { once: true });
});

window.addEventListener('pagehide', () => host.dispose(), { once: true });
