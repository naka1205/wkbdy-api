# 管理 API

所有管理接口位于 `/api/admin` 下。

- 除 `POST /auth/login`、`GET /auth/session` 外，都需要管理员会话 Cookie。
- 所有非 `GET`/`HEAD`/`OPTIONS` 请求必须带 `X-Admin-Request: 1`，否则返回 403 `csrf_required`。
- 错误统一为：

```json
{ "error": { "message": "…", "type": "invalid_password", "code": "invalid_password", "request_id": "…" } }
```

## 会话

| 方法   | 路径                       | 说明                                        |
| ------ | -------------------------- | ------------------------------------------- |
| `GET`  | `/api/admin/auth/session`  | 返回 `{ authenticated: boolean }`，无需会话 |
| `POST` | `/api/admin/auth/login`    | `{ password }`，成功后写入 HttpOnly Cookie  |
| `POST` | `/api/admin/auth/logout`   | 删除当前会话                                |
| `POST` | `/api/admin/auth/password` | `{ current, next }`，成功后清空所有会话     |

登录失败按来源 IP 计数，连续 5 次失败后返回 429 `login_rate_limited`（5 分钟）。

```bash
curl -i http://127.0.0.1:7891/api/admin/auth/login \
  -H 'Content-Type: application/json' -H 'X-Admin-Request: 1' \
  -d '{"password":"…"}'
```

## 总览

`GET /api/admin/overview` 返回面板首页所需的全部信息：

```json
{
  "version": "1.0.0",
  "started_at": 1730000000000,
  "uptime_ms": 123456,
  "upstream": { "url": "https://www.workbuddy.ai/v2/chat/completions", "user_agent": "WorkBuddy/2.137.1", "catalog_path": "/app/config/wb_v3config.public.json" },
  "availability": { "total": 3, "disabled": 0, "needsReauth": 1, "coolingDown": 0, "available": 2 },
  "pool": { "size": 3, "strategy": "round-robin", "accounts": [ … ] },
  "models": { "total": 12, "enabled": 10 },
  "keys": 2,
  "stats": {
    "requests24h": 120,
    "errors24h": 3,
    "tokens24h": 45678,
    "credits24h": 128,
    "perModel": [ … ],
    "latency": { "p50": 800, "p95": 2400 },
    "daily": [{ "date": "2026-09-17", "requests": 42, "tokens": 12345 }]
  },
  "recent": [ … ]
}
```

## 账号

| 方法     | 路径                              | 说明                                                                                                    |
| -------- | --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/admin/accounts`             | 账号列表（`ok`、`detail`、`email`、用量、隔离与重新登录标记、占用密钥 `bound_key_id`/`bound_key_name`） |
| `POST`   | `/api/admin/accounts`             | 新增账号：`{ token, user_id?, name?, note?, domain?, verify? }`                                         |
| `POST`   | `/api/admin/accounts/import`      | 导入 `WKB2API_CREDENTIALS_PATH` 指向的本机凭据文件                                                      |
| `PATCH`  | `/api/admin/accounts/:id`         | `{ name?, note?, enabled? }`                                                                            |
| `DELETE` | `/api/admin/accounts/:id`         | 删除账号                                                                                                |
| `POST`   | `/api/admin/accounts/:id/verify`  | 用该账号向上游发一次最小请求，返回 `{ ok, detail }`                                                     |
| `POST`   | `/api/admin/accounts/:id/release` | 解除该账号的占号分配，返回 `{ ok, released, account }`                                                  |

`POST /api/admin/accounts/:id/release` 只解除绑定、不影响账号健康状态；下一个使用该密钥的请求会重新分配账号。

`POST /api/admin/accounts` 行为：

1. 去掉可能存在的 `Bearer ` 前缀。
2. 从 JWT 的 `sub`（或 `user_id` 参数）解析上游用户 ID；两者都没有时返回 400。
3. 从 JWT 的 `email` 声明解析账号邮箱（Keycloak 签发，用于在面板上区分账号）；令牌没有该声明时留空。
4. 除非 `verify: false`，先向上游校验令牌；失败返回 400 `account_verification_failed`。
5. 写入账号池：同一上游用户（`domain` + `userId`）已存在时更新令牌、邮箱并解除隔离。

`POST /api/admin/accounts/import` 需要 `WKB2API_CREDENTIALS_PATH`，否则返回 400 `import_unavailable`。返回 `{ imported, accepted, issues }`，`issues` 说明被跳过的条目（缺少字段、令牌过期、身份不匹配、域名非法）。

`POST /api/admin/accounts/import` 与网页登录（OAuth 回调）同样会解析并写入邮箱；`POST /api/admin/accounts/:id/verify` 成功后也会用令牌补写一次邮箱，便于刷新旧账号。

## 模型

| 方法    | 路径                     | 说明                                                                                                   |
| ------- | ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `GET`   | `/api/admin/models`      | 所有模型（含未启用）、Agent 白名单与目录同步时间                                                       |
| `POST`  | `/api/admin/models/sync` | 重新导入 `WKB2API_CATALOG_PATH` 指向的目录                                                             |
| `PATCH` | `/api/admin/models/:id`  | `{ enabled?, context_window? }`，`context_window: null` 清除选择；上下文长度也可由客户端按请求传参覆盖 |

`POST /api/admin/models/sync` 返回 `{ added, updated, removed, models, synced_at }`。目录文件缺失返回 400 `catalog_unreadable`，格式错误返回 400 `catalog_invalid`。

## 客户端密钥

| 方法     | 路径                  | 说明                                                                         |
| -------- | --------------------- | ---------------------------------------------------------------------------- |
| `GET`    | `/api/admin/keys`     | 密钥列表（仅前缀，不含明文；含占号信息 `accountId`/`accountName`/`boundAt`） |
| `POST`   | `/api/admin/keys`     | `{ name? }`，返回 `{ key, record }`                                          |
| `DELETE` | `/api/admin/keys/:id` | 删除密钥                                                                     |

`key` 明文只在创建时返回一次，形如 `sk-wk-<43 字符>`。

## 日志

| 方法     | 路径                | 说明                                                                                                                                                                                       |
| -------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`    | `/api/admin/logs`   | 查询参数：`limit`（≤200）、`offset`、`model`、`status=success\|error`、`apiKeyId`、`taskId`、`logicalRequestId`；每条含 `credits`（上游 `usage.credit`）、关联 ID 与 `upstream_request_id` |
| `DELETE` | `/api/admin/logs`   | 清空日志                                                                                                                                                                                   |
| `GET`    | `/api/admin/events` | SSE 流，事件名 `log`，`data` 为 `{ id }`；每 15 秒发送心跳注释                                                                                                                             |

## 设置

| 方法  | 路径                  | 说明                                          |
| ----- | --------------------- | --------------------------------------------- |
| `GET` | `/api/admin/settings` | 返回 `{ settings }`                           |
| `PUT` | `/api/admin/settings` | 整体替换，结构见 [配置说明](configuration.md) |

请求体必须是完整的设置对象（先 `GET` 再修改字段回传），未知字段会被拒绝。

## 网页登录

| 方法   | 路径                          | 说明                                                                                                   |
| ------ | ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `POST` | `/api/admin/oauth/start`      | `{ note? }`，返回 `{ id, status, authorization_url }`                                                  |
| `GET`  | `/api/admin/oauth/:id/status` | 查询事务状态：`pending`/`token_received`/`account_received`/`completed`/`failed`/`cancelled`/`expired` |
| `POST` | `/api/admin/oauth/:id/cancel` | 取消事务                                                                                               |

事务与发起它的会话绑定；其他会话查询返回 404 `oauth_session_not_found`。

## 错误码

| 状态码 | 错误码                                                    | 说明                           |
| ------ | --------------------------------------------------------- | ------------------------------ |
| 400    | `invalid_request`                                         | 参数校验失败                   |
| 400    | `account_verification_failed`                             | 上游拒绝了待添加的账号         |
| 400    | `import_unavailable`                                      | 未配置本机凭据文件路径         |
| 400    | `catalog_invalid`                                         | 目录文件内容非法               |
| 401    | `unauthorized`                                            | 缺少或过期的会话               |
| 401    | `invalid_password`                                        | 密码错误                       |
| 403    | `csrf_required`                                           | 缺少 `X-Admin-Request: 1`      |
| 404    | `account_not_found` / `model_not_found` / `key_not_found` | 目标不存在                     |
| 429    | `login_rate_limited`                                      | 登录尝试过于频繁               |
| 500    | `server_error`                                            | 未预期错误（详情写入服务日志） |
