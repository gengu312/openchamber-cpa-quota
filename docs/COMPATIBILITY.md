# 宿主兼容性证据

核对日期：2026-11-05。GitHub latest 仍为 v2.6.1。**SDK 的 2.6.1 字样或 engines 下限不是 quota 功能证据。**

## 固定源码与实际验证层级

### 正式版 v2.6.1

固定 commit：`ce853f415704d1bfe8d076a5cfb2caabac00fffd`。

离线运行该 commit 的官方 `parseManifest`：
- 接受 desktop-compat manifest。
- 拒绝 native manifest，返回 `invalid-service`（quota role 不在合同中）。

初次 0.2.0 验证只证明 manifest 解析兼容。后续 0.3.0 已在本机注册 desktop-compat 文件夹扩展，验证授权、catalog 版本、服务健康与资源交付；不等于真实桌面视觉或手机验收。该正式版无法仅靠本扩展实现目标手机原生额度。

### main 源码合同

固定 commit：`0137dc30eb3022af139ef5cbe26ed2d025c6c208`。

通过官方源码的 manifest parser、`readQuotaProviderRequest`、`quotaProviderSchemasV1` 校验：
- native 和 desktop-compat manifests 均接受。
- wire 1 `POST /quota`，method `usage.read`。
- `quota.providers=[]`，不索要现有 Magpie/OpenCode 凭据。
- 每窗 `usedPercent`、毫秒 `resetAt`、`windowSeconds`、`valueLabel`；允许 null。
- 卡数只读行 `usedPercent=null`，不是额度百分比。

没有启动/安装 main 宿主，不代表已经端到端验证开发版。未自行指定一个“未来最低正式版”；manifest 的 `>=2.6.1` 只是通用引擎下限，当前正式版会因 role 不支持而拒绝 native。

## 多账号表达与合同限制

一个扩展只有一个 provider id：`ext-cpa-quota`。本实现不伪造五个独立 provider 卡片。

原生顶层窗口用“脱敏账号 / 配额池 · 周期 [稳定窗口后缀]”逐行输出；卡数作为独立只读行，账号不会自动关联。总计最多 32 行（额度窗口加卡数/查询不可用占位）。超过时明确返回容量错误，桌面明细不静默截断；未用 models 规避上限。

核对 `UsagePage.tsx` 和 `usageGroups.ts` 发现每个 models 只取第一个窗口；按账号塞多个窗口会漏显示，因此不采用该路线。源标签不直接暴露，识别出的 gemini/claude/gpt/codex 池名和稳定后缀用来避免同名合并。

`useQuotaStore.ts` 对 `ok=false` 会保留前次样本，因此部分可读结果用 `ok=true` 搭配 `error` 警告及每窗旧数据标识；完全无可读数据/超过合同上限用 `ok=false`。宿主自己的 fetchedAt 是读取时间，不替代 valueLabel 中的源时间。

## 手机读取与动作载体

已核对上述 main commit：
- `MobileApp.tsx` 使用 `useQuotaProviderSync()`。
- `MobileSessionMetadata.tsx` 经 `useUsageProviderGroups()` → `UsageProviderCards` 显示只读行。
- `GUEST_SERVICES.md` 明确手机不暴露扩展安装目录/面板；服务在已授权的同一服务端运行。
- `QuotaProviderRequest` 仅允许 usage.read，输出 schema 为 strict，不含动作、卡片或确认按钮字段。

因此，**手机读取路径已有源码证据及 wire 合同验证；手机消费载体尚未接入**。没有证明现有手机能加载这个桌面 iframe；没有以外部独立网页冒充 OpenChamber 内操作。要满足电脑/手机均可消费，还需验证真实消费响应，并确定单独获批的手机操作入口（例如宿主内已认证的响应式详情入口，或明确限定范围的宿主动作支持）。不能在本次授权下直接补丁主力宿主。

0.2.0 已依据用户提供的请求合同接入账号级消费适配与确认代码，替代此前选卡 mock。请求协议不再是缺口；真实成功/重复/错误响应和幂等核对仍未验证，生产消费保持关闭。手机完整详情页与操作入口仍未实现，这与消费 HTTP 请求适配是两件事。

## 本次没有验证的设备

- 没有真实 Android/iOS 手机验证。
- 已安装扩展的注册、服务健康、资源交付已验证；真实桌面最终视觉与手机端到端验证分开记录在 `UI-0.3.0.md`。
- 没有修改、重启、升级桌面程序、打包 OpenCode 或 Magpie。
- 360px/1100px Edge headless 结果仅为合成面板布局及桥接模拟。

## 公开参考

- https://github.com/openchamber/openchamber/blob/0137dc30eb3022af139ef5cbe26ed2d025c6c208/packages/sdk/GUEST_SERVICES.md
- https://github.com/openchamber/openchamber/blob/0137dc30eb3022af139ef5cbe26ed2d025c6c208/packages/sdk/src/service-provider-schemas.ts
- https://github.com/openchamber/openchamber/blob/0137dc30eb3022af139ef5cbe26ed2d025c6c208/packages/ui/src/components/usage/usageGroups.ts
- https://github.com/openchamber/openchamber/blob/0137dc30eb3022af139ef5cbe26ed2d025c6c208/packages/ui/src/apps/MobileSessionMetadata.tsx
- https://github.com/openchamber/openchamber/blob/0137dc30eb3022af139ef5cbe26ed2d025c6c208/packages/ui/src/stores/useQuotaStore.ts

`npm run contracts:fetch` 下载固定公开 SDK 源码并记录 SHA-256 到 `.cache/contracts/*/evidence.json`。仅测试使用；不会进 ZIP。
