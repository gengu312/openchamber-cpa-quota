# OpenChamber CPA Quota

一个自定义 OpenChamber 扩展：读取 CPA 兼容额度聚合 API，显示各账号额度、重置时间和 Codex 重置卡数量，保留现有模型调用链。

## 当前状态

- 已实现只读额度、共享缓存、脱敏桌面明细、原生 quota wire 1 适配和 Codex 重置卡数量查询。
- 新增账号级消费适配器、二次确认及共享操作状态机；按同一条重置卡 GET 记录绑定账号/工作区，不需要卡片 ID 或到期时间。全部写操作验证使用 mock，生产消费保持关闭。
- 提供 0.2.0 的两种构建；需要自行构建，不依赖开发者的私人端点。未在真实 OpenChamber 安装或手机上端到端验收。
- 核对的正式版 OpenChamber 2.6.1 不包含最新主分支的原生 quota 扩展接口；不能把“侧边栏可用”当成“手机原生限额可用”。
- 消费请求适配已实现，具体成功/重复/错误响应及端到端幂等性仍需 API 部署方确认。未知 HTTP 200 不视为成功；本版本生产消费硬关闭。
- 手机完整详情页与操作入口未接入；原生摘要合同通过和 360px 面板预览都不等于手机可用。

使用前阅读 [使用与配置](docs/USAGE.md)、[宿主兼容性](docs/COMPATIBILITY.md) 和 [API 合同](docs/API.md)。仓库只有合成测试数据，不包含私人服务地址、账号、聊天记录或密钥。

## 交付目标

1. 服务端读取、校验并缓存额度聚合接口。
2. 准确表达各账号额度窗口、重置时间、状态和数据更新时间。
3. 使用 OpenChamber 支持的原生用量提供商接口实现多端显示；必须核实实际 host 版本支持，必要时提供明确标注的兼容展示，不伪称手机已接入。
4. 不更改现有模型、登录和路由，不把密钥或私人聊天记录写入项目。

## 安装与构建

构建后得到 `dist/native`、`dist/desktop-compat`；`npm run pack` 生成 `release/cpa-quota-*-0.2.0.zip` 和 SHA-256 校验和。本地产物不提交到 Git，仓库 URL 本身不是可直接安装的预构建扩展。

- `desktop-compat`：桌面/网页面板，正式版 2.6.1 manifest 解析合同通过；实际安装仍需验证。
- `native`：另含原生只读摘要，**只用于确认支持 quota role 的宿主，正式版 2.6.1 不支持**。不提供手机完整详情页或消费入口。
- 两种构建使用同一扩展 id，只安装一个。桌面 **设置 → 扩展** 中添加相应 `dist` 文件夹或 ZIP，批准运行本地服务。
- 部署前必须在运行服务的用户目录配置自己的 HTTPS origin，见 [使用说明](docs/USAGE.md)。默认仅为保留示例域名，不会连接开发者的服务。

## 本地重建与测试

要求 Node.js >=22（本次使用 24.20.0）、npm；打包脚本使用 Windows 自带 `tar.exe`。

```powershell
npm ci --ignore-scripts
npm run build
npm run contracts:fetch
npm test
npm run pack
```

`contracts:fetch` 只获取固定 commit 的公开 SDK 源码，放在 `.cache` 中用于合同测试，不是安装开发版。后续 `npm test` 可离线执行；没有下载合同/没有构建时，相关测试会明确 skip，不能作为完整验收。

`node scripts/preview.mjs` 启动仅本机、十分钟自动停止的合成 iframe 宿主，地址 `http://127.0.0.1:47831`；加 `--actions` 可排演账号选择、二次确认及 mock 成功。它不读取真实凭证、不连接 CPA 或主力 OpenChamber，此参数只属于开发预览、不属于生产扩展。预览不代表手机原生兼容。

## 代码入口

- `src/parse.mjs`、`src/view.mjs`：安全解析、原生窗口映射和新鲜度。
- `src/upstream.mjs`、`src/reset-credits.mjs`：分离的匿名/带认证 GET。
- `src/cache.mjs`、`src/service.mjs`：共享缓存、宿主 bearer 认证、固定服务路由，生产动作拒绝。
- `src/reset-consume.mjs`：固定消费请求合同适配；默认关闭，没有自动重试。
- `src/reset-actions.mjs`、`src/reset-store.mjs`：二次确认、每逻辑操作 UUID4、跨客户端单飞、项目外脱敏日志、超时锁定及只读核对。
- `panel/`：跟随宿主主题的桌面明细及账号级二次确认流程；真实消费关闭，不自动轮询或后台操作。

## 响应行为探测

`ciallo` 等短提示可以作为人工触发的响应行为样本，但单次回复不能证明模型身份、路由替换或“降智”。当前未实现、未自动调用模型；可行性与边界见 [探测说明](docs/BEHAVIOR-PROBE.md)。
