# 功能说明

## 账号池

账号池保存在 `accounts` 表中，按上游身份（`domain` + `userId`）唯一。四种接入方式：

| 来源     | 接入方式                    | 是否可自动刷新                           |
| -------- | --------------------------- | ---------------------------------------- |
| `oauth`  | 管理端网页登录              | 是（有 refresh token 与 `oauth_origin`） |
| `manual` | 管理端粘贴令牌              | 否（除非令牌同时带 refresh token）       |
| `import` | 本机 WorkBuddy 凭据文件导入 | 否                                       |
| `env`    | 初始密钥导入（兼容旧部署）  | 否                                       |

新增账号前默认会向上游发一次最小请求做校验；校验失败可通过 `verify: false` 跳过（例如上游临时不可用）。

账号的 `email` 列来自 Keycloak 访问令牌的 `email` 声明（`sub` 提供上游 User ID）。上游 `/accounts`、`/login/account` 都不返回邮箱、剩余积分或额度，只有 JWT 里带地址，因此面板用邮箱而不是 UUID 来标识账号；邮箱在新增、本机导入、网页登录以及「校验」成功时写入或补写。

### 调度

默认策略是**按客户端密钥占号**（`pool.accountBinding: "key"`）：一个 API Key 第一次请求时分配一个账号，之后只要该账号可用就一直由它服务。这样长会话（例如 ZCODE 这类会连续发起多次请求的客户端）在整个任务期间使用同一个上游身份，不会在请求之间跳号。

- 分配顺序：优先挑没有任何密钥占用的账号，其次才在已占用的账号之间轮转，所以账号富余时密钥会自然分散到不同账号（池子比密钥少时允许共享账号，不会硬性失败）。
- 账号可用 = 已启用 且 不需要重新登录 且 不在隔离期内。
- 分配在以下情况立即解除，下一次请求换号：账号被停用、需要重新登录、进入隔离期（临时失败退避）、被删除，或密钥被删除。
- 只要账号保持可用，中途的成功/失败计数不会改变归属；账号恢复后也不会被"抢回"。
- 设 `pool.accountBinding: "none"` 可回到「每个请求独立选号」的旧行为：`round-robin` 按内存游标轮转，`random` 在可用账号中随机挑选。
- 全部账号不可用时返回 `503`，错误体携带 `Retry-After`，`/api/admin/overview` 中的 `availability` 给出明细。
- 管理端「账号管理」页显示每个账号被哪个密钥占用，并提供「释放绑定」手动改派。

### 故障处理

| 情况                              | 处理                                                                     |
| --------------------------------- | ------------------------------------------------------------------------ |
| 401/403                           | 尝试刷新（仅 `oauth` 账号）；失败则标记需要重新登录                      |
| 连续临时失败（网络、5xx、429 等） | 前 3 次只计数，第 3 次起指数退避隔离：`cooldown × 2^(n-1)`，上限 30 分钟 |
| 隔离期结束或任意成功请求          | 计数清零，恢复调度                                                       |
| Token 临近过期（提前 60 秒判定）  | 请求前刷新；`jobs` 定时任务也会提前刷新                                  |

上游封控（`410004` 或「账号已被封控」类消息）会**直接把账号停用**并释放占号——这类失败等待不会恢复，需要在面板里人工重新启用；账号级失败（额度耗尽、令牌被上游拒绝、账号被封）会在**同一次客户端请求内换号重试**，最多 3 个账号：占号账号不能用时自动退役并释放占号，请求落到下一个可用账号，客户端不会因为池里某一个账号没额度而中断任务。池内确实没有可用账号时，回的是第一个失败账号的错误（例如 `insufficient_quota`）而不是笼统的「无可用账号」。请求级失败（参数、模型、上游 4xx）不换号。

### 客户端系统提示改写

WorkBuddy 上游会按**系统提示内容**识别客户端：命中已知第三方客户端（Codex、Claude Code 等）的身份句时，直接回 `400 Illegal API invocation from an unapproved channel`，且这类失败与账号无关（换号无效）、客户端也不会重试，整个 agent 轮次会直接失败。

上游的判定是对系统提示做子串精确匹配，且只检查 `system` 消息（用户消息里的同样文本不受影响）。因此网关在发给上游之前会把这几句身份描述改写成中性说法（`src/sanitize.ts`），developer / 用户内容原样保留；命中改写时请求日志的 `detail` 会记录 `rewrote client prompt fingerprints: <规则名>`，便于排查行为变化。

对客户端而言，可重试的失败统一返回 429 + `Retry-After`，错误体同时带 `error.retryable` 与 `error.retry_after`；`/v1/chat/completions` 与 `/v1/responses`（含流式错误帧）行为一致。可重试的判定、关联请求头与日志字段见[重试与关联 ID](retry-policy.md)。

## Responses → Chat Completions 映射

`/v1/responses` 的 `input` 项会翻译成上游的 chat/completions 消息。核心规则是：**上游的一个 assistant 轮次 = 一条 assistant 消息**，拆开就会被拒。

- 一轮里的多个 `function_call` / `custom_tool_call` 项合并成一条 assistant 消息的多个 `tool_calls`；拆成多条会得到 `400 tool calls and tool results do not match, please start a new conversation and retry`（第一个调用的结果不再紧跟它所回应的那条消息）。
- 同一轮先出现的 assistant 文本 `message` 项与随后的工具调用**也合并到同一条消息**（`content` + `tool_calls`）；拆成"文本一条、工具调用一条"会得到 `400 the reasoning content from the previous turn must be passed back in thinking mode`——上游在 thinking 模式下会认为上一轮带思考的回复没有回传。
- 中间的 `reasoning`（加密思考）与 `additional_tools` 项不产生消息，因此不会打断合并；`message` 与工具结果项会结束合并。
- 同样的归一化也应用在 `/v1/chat/completions` 入口：客户端把一轮拆成"文本 + 工具调用"两条 assistant 消息时，网关会先合并再转发。

## 模型目录

目录来自 WorkBuddy 产品配置接口（上游主机的 `/v3/config`，需要账号令牌），拉取后存于表结构：

- `models`：名称、说明、Credits、默认标记、输入/输出上限、温度、图片/工具调用/推理能力、推理档位、上下文窗口默认值、是否启用、选定的上下文长度、排序。
- `model_context_lengths` / `model_reasoning_efforts`：能力列表，保持原始顺序。
- `agents` / `agent_models` / `agent_tags`：Agent 白名单。客户端只能看到 `cli` Agent 列出的模型。

`/v1/models` 返回 OpenAI 形态的模型对象，WorkBuddy 特有信息放在 `x_workbuddy` 命名空间（推理能力、上下文窗口、Credits、Token 上限等）。

面板可以：

- 启用/停用任意模型（停用后从 `/v1/models` 消失，请求该模型返回 404）。
- 上下文长度不做档位限制：客户端 `context_window` 按原值透传，未传时用面板选择，均未设置时用默认值 `1000000`（上游按模型能力收敛）。
- 重新拉取目录（`POST /api/admin/models/sync` 或 `npm run sync:catalog`），每次都实时请求上游接口，保留启停与上下文选择。

## 客户端 API Key

- 面板可创建任意数量的密钥，明文只在创建时返回一次，数据库仅存摘要与前缀。
- 删除密钥立即失效；`last_used_at` 记录最后使用时间。
- 日志按密钥归属，`/api/admin/logs?apiKeyId=...` 可筛选单个密钥的请求。

## 请求日志

每次调用记录：请求 ID、时间、密钥、模型、账号、端点、是否流式、状态码、耗时、输入/输出 Token、上游 credit 计费值、错误码与详细信息。

`detail` 是给排障用的自然语言说明：失败时是校验或上游的原始消息（例如 `messages: messages must contain at least one message`），成功时是被忽略的客户端参数列表。面板「请求日志」详情里可以直接看到，列表里的错误码也有悬停提示。

`cache_hit_tokens` / `reasoning_tokens` 取自上游 usage（`prompt_cache_hit_tokens`/`prompt_tokens_details.cached_tokens` 与 `completion_thinking_tokens`/`completion_tokens_details.reasoning_tokens`），面板详情可见；统计接口额外给出 `stats.cacheHitTokens24h`，控制台用它显示缓存命中率。

`credits` 取自上游 `usage.credit`（WorkBuddy 自己的计费单位，与 Token 用量无关，免费账号为 0），只写入日志与统计（`stats.credits24h`），不会出现在返回给客户端的 `usage` 里。同一个值也按账号累加到 `accounts.credits`，账号列表直接显示每个账号的累计积分消耗（上游说该账号额度耗尽时 `quota_exhausted_at` 会被写入，面板把数字显示成红色，成功一次即清除）；`/v1/chat/completions` 与 `/v1/responses` 都会累加请求数、Token 与积分（Responses 走的是 Codex 流量，早先漏记，现已在成功、非流式与流式两条路径都补上）。

暂停原因写在同一行账号记录里，面板按原因显示不同的状态徽标：`cooldown_reason=quota`（额度耗尽，`quota_retry_after` 到期后自动探测，充值即恢复）、`transient`（上游 5xx / 连接失败 / 普通 429 限流 / 超时，累计 3 次才指数退避）、`auth`（令牌被拒，需要重新网页登录）、`blocked`（上游封控，已自动停用）。额度耗尽不再计入失败次数，也不会把账号整体隔离——上游对免费（`x0.00`）模型同样回 `14018`，此时 `quota_scope=account`，充值后随探测自动恢复。

- 关联字段：客户端提交的 `task_id`、`session_id`、`trace_id`、`client_request_id`、`logical_request_id`、`client_attempt`，以及上游回显的 `upstream_request_id`；请求头契约见[重试与关联 ID](retry-policy.md)。
- 保留策略：`logging.retentionDays`（默认 30 天）与 `logging.maxEntries`（默认 50000 条），由定时任务清理。
- `/api/admin/logs` 支持 `limit`、`offset`、`model`、`status`、`apiKeyId`、`taskId`、`logicalRequestId` 过滤。
- `/api/admin/events` 提供 SSE 日志流，仅推送新记录 ID，供面板做增量刷新。

## 网页登录（OAuth）

`POST /api/admin/oauth/start` 会：

1. 请求上游 `/auth/state` 获取授权地址，并补充当前客户端版本号。
2. 在浏览器中打开该地址完成登录。
3. 后台轮询 `/auth/token` 与 `/login/account`，用返回的令牌调用 `/accounts` 校验账号归属。
4. 校验通过后写入账号池并标记为 `oauth` 来源。

事务与发起它的管理会话绑定，其他会话不可见；可取消，默认 5 分钟超时，最多 32 个并发事务。

Token 刷新（`refreshCredential`）要求账号来源于该 OAuth 源且持有 refresh token，因此只有 `oauth` 账号能被自动续期。刷新失败会按上表隔离或标记重新登录。

## 定时任务

每分钟一次（`jobs.ts`）：

1. **Token 预刷新**：对所有将在 `tokenRefresh.intervalMinutes`（默认 30 分钟）内过期的 `oauth` 账号执行刷新；401/403 标记需要重新登录，其他错误进入退避隔离。
2. **日志清理**：按保留策略删除过期与超量记录。

任务在单次执行完成前不会重入；`jobs` 关闭时（测试）不会启动。

## 安全边界

- 默认只监听回环地址；对公网暴露必须放在反向代理后并启用 HTTPS（此时管理会话 Cookie 自动带 `Secure`）。
- 上游地址可运行时修改（`settings.upstream.url`），面板可指向自建代理；`userAgent` 同时影响上游请求头与 OAuth 版本号。
- 所有返回前端的账号信息都不包含 token；错误消息经过脱敏。
