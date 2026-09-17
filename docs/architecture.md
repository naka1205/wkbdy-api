# 技术架构

## 进程模型

单进程 Node.js 服务。Fastify 监听 `HOST:PORT`（默认 `127.0.0.1:7891`），同时提供三类入口：

| 入口         | 前缀         | 鉴权                                      |
| ------------ | ------------ | ----------------------------------------- |
| 客户端 API   | `/v1`        | 客户端 API Key（`Authorization: Bearer`） |
| 管理 API     | `/api/admin` | 管理员会话 Cookie + `X-Admin-Request: 1`  |
| 管理端静态页 | `/`          | 无（仅静态资源）                          |

`/health`、`/healthz` 无需鉴权。数据库、加密密钥都在启动时初始化，缺失 `ADMIN_PASSWORD` 时服务拒绝启动。

## 模块职责

| 模块                      | 职责                                                           |
| ------------------------- | -------------------------------------------------------------- |
| `src/index.ts`            | 启动、优雅退出（`SIGINT`/`SIGTERM`，15 秒兜底）                |
| `src/server.ts`           | 组装数据库、仓库、调度器、上游客户端、路由、静态资源与错误处理 |
| `src/config.ts`           | 环境变量校验（zod）与运行时设置结构与默认值                    |
| `src/db.ts`               | SQLite 建表、幂等迁移、WAL 与文件权限                          |
| `src/crypto.ts`           | AES-256-GCM 凭据加密、scrypt 密码哈希、SHA-256 摘要            |
| `src/store.ts`            | 账号、API Key、会话、模型目录、请求日志的全部读写              |
| `src/accounts.ts`         | 账号调度：选择、隔离、刷新、用量归属                           |
| `src/upstream.ts`         | WorkBuddy 传输层：SSE 解码、401 重试、凭据校验                 |
| `src/stream.ts`           | 增量 SSE 帧解析（与网络分片无关）                              |
| `src/request.ts`          | OpenAI 请求 → 上游请求映射（强制 `stream:true`、system 注入）  |
| `src/proxy.ts`            | `/v1/chat/completions`：聚合或转发、错误映射、日志             |
| `src/routes/responses.ts` | `/v1/responses`：Responses 对象与事件流                        |
| `src/routes/models.ts`    | `/v1/models`、`/v1/models/:id`                                 |
| `src/routes/admin.ts`     | 管理 API、目录导入、日志流                                     |
| `src/oauth.ts`            | 网页登录轮询与 Token 刷新                                      |
| `src/import.ts`           | 本机 WorkBuddy 凭据文件解析                                    |
| `src/jobs.ts`             | 定时任务：Token 预刷新、日志清理                               |
| `src/errors.ts`           | 错误基类、上游错误分类、日志脱敏                               |
| `src/openai/*`            | OpenAI 响应构造（chat.completion、chunk、Responses）           |

## 请求链路（Chat Completions）

1. `onRequest` 钩子解析 Bearer Key，写入 `request.apiKeyId/apiKeyName`；无效则 401 `invalid_api_key`。
2. `src/proxy.ts` 归一化请求体（丢弃 `"[undefined]"` 占位）、拒绝会改变语义但不受支持的参数、用 zod 校验。
3. 从数据库读取模型行；未启用或不属于 `cli` Agent 白名单的模型返回 404 `model_not_found`。
4. 解析上下文长度：请求值（原值透传）→ 面板选择 → 默认 `1000000`。
5. `toUpstreamRequest` 生成上游请求：始终 `stream:true`，`messages[0]` 必须是 system。
6. `accounts.getCredential(apiKeyId)` 选择账号：优先复用该密钥已占用的账号，账号不可用时先释放再重新分配；临近过期时先用 refresh token 换新。
7. 上游返回 SSE；流式请求逐帧转换后转发，非流式请求在网关内聚合后一次性返回。
8. 结果（状态、耗时、Token、上游 credit、关联 ID、密钥、账号）写入 `request_logs`，成功时更新账号用量，失败时按类型隔离账号。

客户端断开（响应流 close 且未结束）会中止上游请求；已提交状态码后的上游错误以 SSE `error` 帧返回。

## 数据模型

SQLite（`DATA_DIR/wkbdy.db`，WAL，文件权限 0600）：

| 表                                       | 说明                                                                |
| ---------------------------------------- | ------------------------------------------------------------------- |
| `meta`                                   | 键值元数据：管理员密码哈希、目录同步时间、目录来源地址              |
| `accounts`                               | 账号、加密后的 access/refresh token、邮箱、隔离与用量状态           |
| `api_keys`                               | 客户端密钥：名称、前缀、SHA-256 摘要、最后使用时间                  |
| `account_bindings`                       | 占号：密钥 → 账号的粘性分配与绑定时间；任一侧删除即级联移除         |
| `sessions`                               | 管理端会话：令牌摘要与过期时间                                      |
| `models`                                 | 模型能力与面板状态（启停、选定的上下文长度、排序）                  |
| `model_context_lengths`                  | 模型支持的上下文长度（有序）                                        |
| `model_reasoning_efforts`                | 模型支持的推理档位（有序）                                          |
| `agents` / `agent_models` / `agent_tags` | Agent 白名单与标签，决定 `/v1/models` 暴露哪些模型                  |
| `request_logs`                           | 请求记录：状态、耗时、Token、上游 credit、关联 ID、密钥、账号、错误 |

产品目录（原 `wb_v3config.public.json`）只有在导入时才需要文件，运行时完全以表结构提供；导入时保留面板状态，文件中消失的模型会被删除。

## 鉴权与密钥

- **管理端**：`ADMIN_PASSWORD` 只在首次启动时写入 `meta.adminPassword`（scrypt，`salt:hash`）。登录成功后写入 `sessions` 并使用 HttpOnly Cookie；改密会清空所有会话。非读写方法必须带 `X-Admin-Request: 1`（CSRF 防护），连续 5 次失败登录后按来源 IP 限流 5 分钟。
- **客户端**：密钥形如 `sk-wk-<43 字符 base64url>`，数据库只保存摘要与前缀；`API_KEYS` 环境变量仅在首次启动时导入（`keysInitialized` 标记）。
- **账号凭据**：AES-256-GCM，密钥来自 `DATA_DIR/encryption.key` 或 `TOKEN_ENCRYPTION_KEY`。数据库与密钥必须成对备份，否则账号无法解密。
- 日志与错误消息统一经过脱敏：已知密钥、`Bearer`、JWT 形态字符串与控制字符都会被移除。

## 生命周期

启动顺序：加载 `.env` → 校验环境变量 → 打开数据库（迁移）→ 初始化 Vault → 校验账号可解密 → 播种运行时设置与初始密钥 → 首次导入目录 → 注册路由与静态资源 → 启动定时任务。

退出顺序：`preClose` 停止定时任务并关闭 OAuth 事务 → `onClose` 关闭数据库；`index.ts` 在 15 秒内未完成则强制退出。

服务按单进程设计：调度游标、并发与刷新锁都在内存中，不要横向扩容，也不要同时运行多个实例访问同一个 `DATA_DIR`。
