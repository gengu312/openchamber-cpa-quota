# CPA 兼容聚合 API

本扩展连接部署方提供的额度聚合服务，而不是直接连接 CPA 管理接口。服务 origin 由管理员通过项目外配置指定；下面只使用保留示例域名，不能作为真实服务访问。

## 额度读取

`GET https://quota.example.invalid/quota/api/quotas`

当前协议不发送 Authorization，返回 `application/json`：

```text
configured, refreshing, updated_at, next_refresh_at, error
accounts[]: id, label, provider, plan, status, error, updated_at, stale, windows
windows[]: id, label, used_percent, remaining_percent, resets_at,
           duration_seconds, quota_group?, current_cost, current_tokens,
           estimated_cost, estimated_tokens, estimate_basis, usage_error
```

字段语义和合成结构见 `fixtures/quotas.synthetic.json`。未知数值保留 null，有效 0 保持为 0。配额池按稳定 id/quota_group 区分，不相加不同账号的百分比。明细 usage_error 不应抹掉有效额度。

## 重置卡读取

`GET /quota/api/codex/reset-credits`

`Authorization: Bearer <server-side key>`，返回：

```text
generated_at
accounts[]: account_id, quota_account_id, label, email, workspace_id, available_count, error
```

- `quota_account_id` 是与额度接口 `accounts[].id` 完全一致的公共键，面板据此把重置卡匹配到对应 Codex 额度卡片（`resetAccount.quota_account_id === quotaAccount.id`）。缺少该字段的记录不匹配任何卡片。
- `account_id` 是消费命名空间，与 `quota_account_id` 通常不同，仅用于消费请求，不参与匹配。

没有单卡 ID 或有效期不能解释为永久有效，也不虚构选卡功能。原始 account_id/workspace_id 保留在服务端内存目录；面板只接收脱敏目标标识。

## 手动消费请求（生产关闭）

`POST /quota/api/codex/reset-credits/consume`

使用同一服务端 bearer，`Content-Type: application/json`：

```json
{
  "account_id": "synthetic-codex-account",
  "workspace_id": "synthetic-workspace",
  "redeem_request_id": "12345678-1234-4234-9234-123456789abc"
}
```

- account_id/workspace_id 来自重置卡 GET 的同一条新鲜且无错误的记录，服务端验证关联，不接受前端任意拼装。
- 每次逻辑操作一个标准 UUID4，双击不生成第二次消费；不传卡片 ID。
- 明确选择账号/工作区、确认权益消耗、二次确认。取消、读取、轮询都不消费。
- 同一服务实例共享锁与脱敏操作日志；UUID 字段不代表已证明跨独立服务的端到端幂等。
- 请求不自动重试。超时、断线、未知响应锁定为结果未知，先刷新核对，不能换 UUID 重发。
- 消费成功/重复/错误的响应合同未作为通用协议确认；默认判定器不会把 HTTP 200 当作成功。
- 0.2.0 的生产协调器和消费适配器均为 `enabled=false`，没有配置或前端开关，所有写测试只用 mock。禁止为验证拒绝分支对真实消费端点发 POST。

所有 bearer 只发往管理员配置的同一 origin 和固定端点；拒绝重定向，不回显原始上游错误，不代理任意 URL。扩展不直连 ChatGPT OAuth 或 CPA 管理 API。
