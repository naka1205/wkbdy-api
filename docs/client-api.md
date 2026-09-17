# 客户端 API

Base URL：`http://<host>:<port>/v1`；鉴权：`Authorization: Bearer <客户端 API Key>`。

只提供 OpenAI 兼容接口：模型列表、Chat Completions、Responses。Anthropic Messages 接口不再提供。

## 鉴权

| 情况                    | 状态码 | 错误码            |
| ----------------------- | ------ | ----------------- |
| 缺少或无效的 Bearer Key | 401    | `invalid_api_key` |

错误体遵循 OpenAI 结构：

```json
{
  "error": {
    "message": "Invalid or missing API key.",
    "type": "authentication_error",
    "param": null,
    "code": "invalid_api_key"
  }
}
```

## GET /v1/models

返回启用且属于 `cli` Agent 的模型：

```json
{
  "object": "list",
  "data": [
    {
      "id": "deepseek-v4.1-flash",
      "object": "model",
      "created": 0,
      "owned_by": "workbuddy",
      "x_workbuddy": {
        "name": "DeepSeek V4.1 Flash",
        "is_default": true,
        "max_input_tokens": 200000,
        "max_output_tokens": 8192,
        "supports_tool_call": true,
        "supports_reasoning": true,
        "context_window": { "defaultLength": 200000, "supportedLengths": [200000, 400000] },
        "credits": "1x",
        "reasoning": { "defaultEffort": "medium", "supportedEfforts": ["low", "medium", "high"] }
      }
    }
  ]
}
```

`GET /v1/models/:id` 返回单个模型；未知或已停用的模型返回 404 `model_not_found`。

## POST /v1/chat/completions

支持的字段：

| 字段                                          | 说明                                                                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `model`                                       | 必填，网关模型 ID                                                                                                                                                                    |
| `messages`                                    | 必填，`system`/`developer`/`user`/`assistant`/`tool`                                                                                                                                 |
| `stream`                                      | 默认 `false`；`true` 时返回 SSE                                                                                                                                                      |
| `temperature`、`top_p`                        | 透传                                                                                                                                                                                 |
| `max_tokens` / `max_completion_tokens`        | 二者互斥；后者写入上游 `max_tokens`                                                                                                                                                  |
| `stop`                                        | 字符串或最多 4 个字符串                                                                                                                                                              |
| `tools`、`tool_choice`、`parallel_tool_calls` | 透传；模型不支持工具调用时由上游拒绝                                                                                                                                                 |
| `reasoning_effort`                            | `none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`，透传                                                                                                                           |
| `thinking`                                    | 兼容写法：`{ "type": "disabled" }`、`{ "type": "enabled", "budget_tokens": 8192 }`、`{ "type": "adaptive" }`、`{ "effort": "high" }` 或直接传档位字符串；会转换为 `reasoning_effort` |
| `context_window`                              | 覆盖该次请求的上下文长度；任意正整数按原值透传，缺省时用服务端选择或默认值 `1000000`                                                                                                 |
| `stream_options.include_usage`                | `true` 时在流末尾追加 usage-only chunk                                                                                                                                               |
| `user`                                        | 透传                                                                                                                                                                                 |

以下参数会被显式拒绝（400 `unsupported_parameter`），避免静默改变语义：

`logprobs`、`top_logprobs`、`response_format`、`seed`、`presence_penalty`、`frequency_penalty`、`n`、`store`、`metadata`、`logit_bias`、`functions`、`function_call`、`audio`、`modalities`、`prediction`、`web_search_options`、`service_tier`、`speed`。

其他说明：

- 未知字段（schema 之外）返回 400 `invalid_request`。
- `messages[0]` 不是 `system`/`developer` 时会自动插入 `You are a helpful assistant.`。
- 上游只接受流式请求，因此非流式调用由网关聚合后再返回。
- `"[undefined]"` 占位值（部分客户端在未设置可选参数时会发送）会被丢弃。

### 非流式响应

```bash
curl http://127.0.0.1:7891/v1/chat/completions \
  -H "Authorization: Bearer $WKBDY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"ping"}]}'
```

```json
{
  "id": "chatcmpl-…",
  "object": "chat.completion",
  "created": 1730000000,
  "model": "deepseek-v4.1-flash",
  "choices": [{ "index": 0, "message": { "role": "assistant", "content": "pong" }, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": 12, "completion_tokens": 3, "total_tokens": 15 }
}
```

思考过程（上游 `reasoning_content`）原样保留在 `message` 与 delta 中；是否输出取决于上游。

### 流式响应

```bash
curl -N http://127.0.0.1:7891/v1/chat/completions \
  -H "Authorization: Bearer $WKBDY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"ping"}],"stream":true}'
```

帧格式为标准 `data: {...}\n\n`，以 `data: [DONE]` 结束。若上游在状态码提交后损坏，会发送一帧 `{"error": {...}}` 后结束。

## POST /v1/responses

支持 `model`、`input`（字符串或 item 数组）、`instructions`、`stream`、`temperature`、`top_p`、`max_output_tokens`、`tools`、`tool_choice`、`parallel_tool_calls`、`reasoning`、`thinking`、`context_window`、`store`。

- 非流式：返回完整的 `response` 对象（含 `output`、`usage`）。
- 流式：按官方事件序列输出 `response.created` → `response.in_progress` → `response.output_text.delta` → `response.output_text.done` → `response.completed`，每帧带 `sequence_number`。

## 错误处理

| 状态码 | 错误码                          | 场景                                       |
| ------ | ------------------------------- | ------------------------------------------ |
| 400    | `invalid_request`               | 请求体不合法、参数冲突、上游拒绝请求内容   |
| 400    | `unsupported_parameter`         | 使用了不受支持的参数                       |
| 400    | `invalid_correlation_id`        | 关联请求头格式非法或看起来像凭证           |
| 401    | `invalid_api_key`               | 缺少或错误的客户端 Key                     |
| 404    | `model_not_found`               | 模型不存在或已停用                         |
| 429    | `rate_limit_exceeded`           | 上游限流                                   |
| 429    | `insufficient_quota`            | 上游余额/额度不足                          |
| 429    | `upstream_authentication_error` | 账号令牌被上游拒绝（下一次请求会换账号）   |
| 429    | `upstream_error`                | 上游 5xx 或连接失败（可重试）              |
| 429    | `upstream_protocol_error`       | 上游返回无法解析的 SSE/JSON（可重试）      |
| 429    | `upstream_timeout`              | 上游超时（可重试）                         |
| 499    | `invalid_request`               | 客户端主动断开                             |
| 502    | `upstream_error`                | 上游端点 404（协议漂移，通常需要人工介入） |
| 503    | `upstream_error`                | 没有可用账号（响应带 `Retry-After`）       |

可重试的失败统一为 429，并尽量带上 `Retry-After`（秒）与错误体里的 `error.retry_after`；重试语义、关联请求头与上游 trace 的对应关系见[重试与关联 ID](retry-policy.md)。

响应头包含 `X-Request-Id`（等于日志的 `request_id`）、`X-Logical-Request-Id`，以及客户端提供时回传的 `X-Task-Id`，可用于排查。

## 账号分配对客户端的影响

默认开启「按密钥占号」：同一个 API Key 的连续请求会一直由同一个上游账号服务（详见[功能说明](features.md#调度)）。

- 客户端不需要做任何事，也**无法从响应中看出**当前用的是哪个账号 —— 网关不会回传账号标识，账号归属只记录在管理端日志的 `account_id` 字段里。
- 同一次请求不会因为换号而重发：失败就是失败，客户端按错误码重试即可；重试时可能落到新分配的账号上（原账号被停用、需要重新登录或进入隔离期时）。
- 因此客户端不要假设两次请求之间上游侧存在会话状态：每次请求都需要提交完整的消息与工具上下文。
- 多账号部署下，如果账号池整体不可用，仍会得到 `503`（带 `Retry-After`）；`GET /api/admin/overview` 的 `availability` 有明细。
- 客户端可带上 `X-Task-Id` / `X-Logical-Request-Id` 等关联头，方便按任务排查（见[重试与关联 ID](retry-policy.md)），但这不会改变占号粒度：占号仍然按 API Key。
