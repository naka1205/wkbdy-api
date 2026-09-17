# 配置说明

配置分两层：

- **启动配置**（`.env`）：监听地址、管理员密码、数据目录、初始密钥。修改后需要重启。
- **运行时设置**（SQLite，可在面板修改）：调度策略、隔离时间、上游地址与 UA、Token 刷新、日志保留。修改后立即生效。

## 启动配置

服务使用 Node 原生 `.env` 加载（`src/config.ts` 顶部 `import 'dotenv/config'`），进程环境变量优先于 `.env`。

| 变量                       | 必填   | 默认值                                         | 说明                                                              |
| -------------------------- | ------ | ---------------------------------------------- | ----------------------------------------------------------------- |
| `HOST`                     | 否     | `127.0.0.1`                                    | 监听地址，仅在受控测试或容器内改为 `0.0.0.0`                      |
| `PORT`                     | 否     | `7891`                                         | 监听端口                                                          |
| `ADMIN_PASSWORD`           | **是** | —                                              | 管理员密码，至少 8 个字符；仅首次启动写入数据库                   |
| `PUBLIC_BASE_URL`          | 否     | `http://localhost:<PORT>`                      | 用于判断会话 Cookie 是否需要 `Secure`                             |
| `DATA_DIR`                 | 否     | `./data`                                       | SQLite 与加密密钥目录                                             |
| `STATIC_DIR`               | 否     | `./static`                                     | 管理端构建产物目录                                                |
| `LOG_LEVEL`                | 否     | `info`                                         | `fatal`/`error`/`warn`/`info`/`debug`/`silent`                    |
| `API_KEYS`                 | 否     | 空                                             | 逗号分隔的初始客户端密钥，仅首次启动导入                          |
| `WKB2API_UPSTREAM_URL`     | 否     | `https://www.workbuddy.ai/v2/chat/completions` | 首次启动时写入运行时设置；之后以数据库为准                        |
| `WKB2API_UPSTREAM_UA`      | 否     | `WorkBuddy/2.137.1`                            | 同上；同时决定 OAuth 授权链接的 `version` 参数                    |
| `WKB2API_CATALOG_PATH`     | 否     | `./config/wb_v3config.public.json`             | 产品目录文件；首次启动导入数据库，之后用于 `models/sync`          |
| `WKB2API_CREDENTIALS_PATH` | 否     | 空                                             | 本机 WorkBuddy 凭据文件；设置后才启用“导入本机账号”               |
| `TOKEN_ENCRYPTION_KEY`     | 否     | 空                                             | base64 编码的 32 字节密钥；不设置时使用 `DATA_DIR/encryption.key` |
| `WKB2API_DUMP_DIR`         | 否     | 空                                             | 协议抓包目录；设置后把客户端/上游的**原始**报文写入 JSONL（见下） |
| `WKB2API_DUMP_REDACT`      | 否     | 空                                             | 设为 `1` 时把 `Bearer …`／JWT／`sk-…` 替换成占位符                |

`.env` 缺失或不可读不会导致启动失败，但 `ADMIN_PASSWORD` 为空会立即报错：

```text
Invalid configuration:
  ADMIN_PASSWORD: Set ADMIN_PASSWORD to at least 8 characters in .env
```

### 协议抓包（临时排障）

设置 `WKB2API_DUMP_DIR` 后，网关会把每次 `/v1/*` 调用的原始数据追加写入 `<DIR>/dump-YYYY-MM-DD.jsonl`，一行一个事件：

| kind                  | 内容                                                                        |
| --------------------- | --------------------------------------------------------------------------- |
| `client_request`      | 客户端方法、URL、**原始请求头**、**原始请求体字节**（未经 JSON 重新序列化） |
| `client_response`     | 网关返回给客户端的状态码、响应头与响应体                                    |
| `upstream_request`    | 发给 WorkBuddy 的 URL、请求头（含账号令牌）与请求体                         |
| `upstream_response`   | 上游状态行与响应头                                                          |
| `upstream_chunk`      | 上游 SSE 的**原始文本分片**（逐字节读取时的每一段）                         |
| `upstream_error_body` | 上游非 200 时的原始响应体                                                   |

注意：

- 默认**不脱敏、不截断**，因此文件里包含客户端密钥与上游账号令牌，按凭证对待，排障结束就删除。
- 管理端（`/api/admin/*`）的请求不会记录，因为其中包含管理员密码与会话 Cookie。
- 流式响应由 `client_sse` 逐帧记录（hijack 后的响应不经过 `onSend`，因此没有 `client_response`）；非流式响应记 `client_response`。
- 仅在需要抓包时临时打开；不设置该变量时没有任何开销，也不会改变 JSON 解析行为。

## 运行时设置

`GET/PUT /api/admin/settings`，结构由 `settingsSchema` 严格校验（多余的键会被拒绝）。

```json
{
  "strategy": "round-robin",
  "pool": { "cooldownSeconds": 60, "accountBinding": "key" },
  "upstream": {
    "url": "https://www.workbuddy.ai/v2/chat/completions",
    "userAgent": "WorkBuddy/2.137.1"
  },
  "tokenRefresh": { "enabled": true, "intervalMinutes": 30 },
  "logging": { "retentionDays": 30, "maxEntries": 50000 }
}
```

| 字段                           | 取值                   | 说明                                                                      |
| ------------------------------ | ---------------------- | ------------------------------------------------------------------------- |
| `strategy`                     | `round-robin`/`random` | 账号调度策略                                                              |
| `pool.cooldownSeconds`         | 0–3600                 | 首次临时失败的隔离时长；之后指数退避，上限 30 分钟                        |
| `pool.accountBinding`          | `key`/`none`           | `key`：一个客户端密钥占一个账号，直到账号不可用；`none`：每个请求独立选号 |
| `upstream.url`                 | HTTP(S) URL            | 上游 Chat Completions 地址，改动后下一个请求即生效                        |
| `upstream.userAgent`           | 1–200 字符             | 上游 `User-Agent`，同时作为 OAuth 版本号来源                              |
| `tokenRefresh.enabled`         | 布尔                   | 是否启用 Token 预刷新                                                     |
| `tokenRefresh.intervalMinutes` | 1–1440                 | 提前刷新窗口                                                              |
| `logging.retentionDays`        | 1–365                  | 请求日志保留天数                                                          |
| `logging.maxEntries`           | 100–1000000            | 请求日志最大条数                                                          |

运行时设置保存在 `meta` 表（键 `settings`）。数据库缺失该键时使用默认值；`.env` 中的上游地址与 UA 只用于首次播种。

## 模型目录

目录文件是 WorkBuddy 的产品配置（`/v3/config` 的响应）。最小结构：

```json
{
  "data": {
    "models": [
      {
        "id": "deepseek-v4.1-flash",
        "name": "DeepSeek V4.1 Flash",
        "isDefault": true,
        "supportsToolCall": true,
        "supportsReasoning": true,
        "maxOutputTokens": 8192,
        "contextWindow": { "defaultLength": 200000, "supportedLengths": [200000, 400000] },
        "reasoning": { "supportedEfforts": ["low", "medium", "high"] }
      }
    ],
    "agents": [{ "name": "cli", "models": ["deepseek-v4.1-flash"], "modelTags": ["code"] }],
    "endpoint": "https://www.workbuddy.ai"
  }
}
```

校验规则：

- `models` 与 `agents` 至少各一项，模型 `id` 不能重复。
- Agent 引用的模型必须存在于 `models` 中，否则导入失败（`catalog_invalid`）。
- 客户端可见的模型 = `cli` Agent 列出的模型 ∩ 面板中启用的模型。

导入方式：首次启动自动导入；之后用管理端“同步目录”按钮、`POST /api/admin/models/sync` 或 `npm run sync:catalog [文件]`。导入会保留面板的启停与上下文选择，删除文件中已消失的模型。

## 数据目录

```text
data/
├── wkbdy.db          # SQLite（WAL，0600）
├── wkbdy.db-wal
├── wkbdy.db-shm
└── encryption.key    # 32 字节 base64，0600
```

`encryption.key` 只在缺失时创建。使用 `TOKEN_ENCRYPTION_KEY` 时不会生成文件，此时必须自行保管该值：丢失后账号 token 无法解密，只能删除账号重新登录。
