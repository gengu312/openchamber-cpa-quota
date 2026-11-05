# 使用与配置

## 目前可以使用什么

只读显示各账号独立额度窗口、剩余/已用比例、重置时间、源更新时间，以及 Codex 重置卡数量。账号显示为提供商和短哈希，隐藏原 label、邮箱、workspace、原始错误和未经白名单允许的 plan。哈希是可关联的假名，不是强匿名化。

额度接口和卡片接口有各自的账号命名空间。消费目标直接取重置卡 GET 同一记录的 `account_id/workspace_id`，无需猜测其与额度 API 的 id 是否对应。客户端只选择脱敏账号和工作区，不能混搭提交原始字段。账号级协议不需要卡 ID/到期信息，不显示“永久有效”，也不虚构选卡项。

0.2.0 增加消费适配与二次确认代码，**真实消费仍在生产入口硬关闭**。没有环境变量、前端设置或配置文件可以开启它。手机完整详情页/动作入口未实现；当前不能说“安装后电脑手机都能操作”。

## 安装前条件

先在独立实例验证，不建议直接用主力安装测试未发布的宿主合同。

1. 在获得授权的独立实例中，先确认实际宿主合同，见 `COMPATIBILITY.md`。
2. 在桌面或网页的 Settings → Extensions 中添加 ZIP 或对应 `dist` 文件夹，明确授权本地服务。服务拥有当前用户权限，不是 OS 沙箱。
3. 两个包只选其一：`desktop-compat` 只有面板；`native` 还声明 quota role。它们的 panel.id 都是 `cpa-quota`。
4. native 通过后，在 Usage 设置中选择 CPA 额度，并启用 Show in Work Status 等显示项。手机需要连接同一实例，而且客户端也必须包含 extension quota 同步/展示实现。
5. 手机不负责安装扩展，不读取或保存上游密钥。独立服务端上的凭据也应在该服务运行用户的配置目录中；本机文件不会自动同步到另一台服务器。

## 服务端配置

必须指定自己的 HTTPS 额度服务 origin，请求固定 `/quota/api/quotas`，不发送任何授权头，不读取 Magpie/OpenCode 凭据。源码中的 `https://quota.example.invalid` 是保留示例域名，不是可用服务。

非秘密管理员配置在 `~/.config/openchamber-cpa-quota/config.json`，必须创建，仅允许 `origin` 字段。origin 必须是 HTTPS origin，不允许路径、query、用户名/密码或 fragment；不能从面板、查询参数或宿主请求中改变。缺少或无效时服务拒绝启动。

```json
{ "origin": "https://quota.example.invalid" }
```

把示例 origin 改成自己的服务地址，不要把私人配置提交到仓库。Windows 对应 `%USERPROFILE%\.config\openchamber-cpa-quota\config.json`。配置读取的是服务端用户目录，不是浏览器设备目录。

重置卡查询凭据读取位置：

`~/.config/openchamber-cpa-quota/credentials.json`（Windows：`%USERPROFILE%\.config\openchamber-cpa-quota\credentials.json`）

由管理员在项目外创建并限制访问权限，例如 Unix 文件权限 0600、Windows 仅服务运行用户可读。读取和消费适配共用该密钥，但只有需要请求时才在进程内部加载；当前生产消费禁用。字段为 `origin`、`resetCreditsPath`、`resetApiKey`。origin 必须与管理员 config.json 中的 origin 完全一致，GET path 固定 `/quota/api/codex/reset-credits`；消费 POST 固定到同 origin 的 `/quota/api/codex/reset-credits/consume`。**不要把文件放进项目、面板、ZIP、日志或聊天。**

服务不依赖将自定义环境变量传入扩展。宿主只传有限的环境，密钥不通过 manifest、构建变量或 iframe 储存。上游固定为管理员配置的 origin，不能由客户端请求覆盖，且不会跨域跟随重定向。该 API 合同不等同于 CPA 原始管理接口，需要部署方提供兼容的聚合 API，见 `API.md`。

## 刷新、缓存与旧数据

- 面板“读取额度”只发 GET，不会调用上游 `POST /quota/api/refresh`。
- 额度缓存 30 秒；失败后 30 秒内不再请求，最多保留 24 小时的旧样本。
- 重置卡缓存和失败退避各 60 秒，旧样本最多保留 10 分钟。
- 并发额度面板/原生卡共享同一服务缓存；两类上游的缓存互不覆盖。重置卡错误不隐藏有效额度，额度故障也不隐藏成功的卡数查询。
- native 的宿主刷新会只读查询额度与卡数；桌面卡数由“查询重置卡”按钮触发。扩展没有定时器轮询上游或后台消费；宿主可按自身规则触发只读刷新。
- 源数据超过 10 分钟、上游 stale 或账号错误会标为旧数据；没有源时间/状态时显示新鲜度未知。更新时间以源数据为准，本地 GET 成功不代表上游刚刚采集。
- `next_refresh_at` 保留到明细响应，但不据此调用 POST。null 表示未知，合法 0 保持为 0；不同账号/配额池不相加。
- Token/cost 明细不可用不影响有效额度。估算值不是实际扣款；未知成本单位不自行标为 USD。

## 本地服务接口（仅宿主）

所有路由，包括 health，都要求宿主生成的 bearer；仅监听 `127.0.0.1`，拒绝浏览器 Origin，不返回 CORS 授权。

- `GET /health`：健康检查，不读凭据、不请求上游。
- `GET /snapshot`：额度脱敏明细。
- `GET /reset-credits`：卡数脱敏明细，`actions.enabled=false`。
- `POST /quota`：宿主 wire 1 `usage.read`，provider=`ext-cpa-quota`，credentials 必须为空。
- `POST /reset/prepare|confirm|cancel|review|status`：固定的手动操作协议；本次生产全部返回 403 DISABLED，不发上游请求。只有离线 mock 构造的服务才开放用于测试。

这是固定 API，不是任意 URL 代理。没有任意 URL、上游刷新或直连 ChatGPT/CPA 管理层入口。宿主 bearer 绝不转发，重置卡专用 bearer 只用于已确认的 GET/消费 POST 精确端点。消费适配代码在 0.2.0 包中，但两层生产 enabled=false，不会发送。

## 账号级手动流程（当前仅 mock 可执行）

1. 查询后明确选择账号和工作区，勾选不可撤销的一次权益消耗说明；没有默认选中账号。
2. 服务端验证新鲜且无错误的同一 GET 记录，锁定目标，生成标准 UUID4。相同选择跨客户端只得到同一逻辑操作；不因双击另生成 UUID。
3. 二次确认弹窗显示账号、工作区、查询数量、操作号和消耗说明。取消不消费；确认有效期 60 秒（这是确认窗口，不是卡片到期时间）。
4. 确认后服务端同账号单飞，复核目标和查询版本。字段/工作区/数量变化时拒绝，不偷换目标，不提交卡片 ID。
5. 发送前将运行状态写入服务用户项目外 `reset-operations.json`（仅脱敏标识、UUID、状态）。重启发现 running 转成结果未知，防止进程重启后忘记已发请求。此日志只在未来获批启用或 mock 测试中写入，本次生产不生成操作。
6. 超时/断线/未知响应视为结果未知并锁定，不自动重试。手动核对只刷新卡数和额度；单看数量变化不能证明该 UUID 的结果，响应查询合同缺失时不会解锁重发。
7. 仅经已验证的响应判定器确认成功后刷新卡数与额度；目前默认响应判定器不识别成功（200 也不够）。mock 可注入明确的假响应合同验证成功路径。

锁和防重范围是同一 OpenChamber 服务实例。不能把客户端内单飞或 UUID 字段宣称为跨不同独立宿主的全链路幂等保证。已完成/取消的同一查询选择不会另建操作；需要重新获取变化后的可信查询快照后才能开始新的逻辑操作。日志最多 500 条，满后拒绝新增，不自动丢弃历史去重记录。

## 仍需补齐或另行批准

请求 method/path/body 已完整，依据是用户提供的正式说明；没有真实消费测试。还需正式成功/重复/错误响应、幂等保证和超时结果查询合同。用户说明上游使用开关关闭，本项目不请求打开、不用 POST 验证 403；通用 403 只说明权限/策略拒绝，不断言具体原因。

手机已认证操作载体仍需实施和验证。quota role 只有读取协议；不能往窗口对象里塞入按钮，不能把桌面 iframe 宣称为手机消费入口。任何宿主回移、升级或部署均需另行批准。
