# wkbdy-api

wkbdy-api 是面向 WorkBuddy (CodeBuddy) 的自托管 API 网关与账号管理后端。服务使用 TypeScript、Fastify 和 SQLite，向客户端提供 **OpenAI 兼容**接口，并负责账号调度、凭证加密存储、Token 刷新、用量记录和管理鉴权。

可配合独立管理端 `wkbdy-api-admin` 使用，也可直接通过管理 API 完成配置。

## 文档

| 文档                                  | 内容                                               |
| ------------------------------------- | -------------------------------------------------- |
| [技术架构](docs/architecture.md)      | 模块职责、请求链路、表结构、鉴权与进程生命周期     |
| [功能说明](docs/features.md)          | 账号、模型目录、密钥、日志、设置、OAuth 与定时任务 |
| [配置说明](docs/configuration.md)     | 环境变量、运行时设置、默认值与生效方式             |
| [客户端 API](docs/client-api.md)      | 模型列表、Chat Completions、Responses 与错误处理   |
| [重试与关联 ID](docs/retry-policy.md) | 可重试的失败、`Retry-After` 与关联请求头           |
| [管理 API](docs/admin-api.md)         | 管理会话、账号、模型、密钥、日志与设置             |
| [部署运维](docs/deployment.md)        | Docker、PM2、反向代理、备份、迁移与排障            |
| [验证与发布](docs/verification.md)    | 单元测试、冒烟、发布校验与真实上游验证             |

## 主要功能

- 提供 `GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/responses`，支持普通 JSON 响应与 SSE 流式响应。
- 账号池默认按客户端密钥占号：一个 Key 在账号可用期间固定使用同一个上游账号，账号停用/需要重新登录/进入隔离期时自动改派；可用 `pool.accountBinding: "none"` 回到逐个请求轮询（`round-robin` / `random`）。
- 临时故障按指数退避隔离，鉴权失效的账号暂停调度并提示重新登录。
- 账号凭证使用 AES-256-GCM 加密后存入 SQLite；管理密码使用 scrypt 哈希，客户端 API Key 只保存 SHA-256 摘要。
- WorkBuddy 产品目录（模型能力、推理档位、上下文长度、Agent 白名单）以表结构存储在数据库中，可用 `npm run sync:catalog` 从配置文件重新导入，导入时保留面板的启停与上下文选择。
- 支持网页登录（OAuth 轮询）、手工令牌、环境变量与本机凭据文件四种账号接入方式。
- 记录每个请求的状态、耗时、Token 用量、使用的密钥与账号，支持按模型/状态/密钥筛选与自动清理。
- 上游始终以流式方式请求，非流式客户端请求在网关内聚合，行为与原 wkbdy2api 一致。

## 快速开始

需要 Node.js **22.13 或以上**和 npm。配合管理端使用时，将两个仓库放在同级目录：

```text
WkBdyApi/
├── wkbdy-api/
└── wkbdy-api-admin/
```

首次启动后端：

```bash
cd wkbdy-api
npm ci
cp .env.example .env
# 编辑 .env，将 ADMIN_PASSWORD 设置为自己的管理员密码，至少 8 个字符
npm run dev
```

后端默认监听 `127.0.0.1:7891`。`ADMIN_PASSWORD` 是必填启动配置；首次运行时初始化管理员密码，后续在管理端修改的密码以数据库记录为准。

在另一个终端启动管理端：

```bash
cd wkbdy-api-admin
npm ci
npm run dev
```

打开 Vite 输出的地址（默认 `http://127.0.0.1:5173`）。开发代理将 `/api` 请求转发到后端。登录后添加 WorkBuddy 账号，并在「客户端密钥」页创建 API Key。

把管理端构建产物发布到后端时运行：

```bash
cd wkbdy-api-admin
npm run build:deploy   # 构建并复制到 ../wkbdy-api/static
```

管理端自带 Playwright 浏览器测试（`npm run test:e2e`）；跨仓库回归用 `cd wkbdy-api && npm run ci`。

## 构建与运行

管理端构建命令会将静态文件同步到 API 仓库的 `static/`：

```bash
cd wkbdy-api-admin
npm run build:deploy
cd ../wkbdy-api
npm run build
npm start
```

此时可通过 `http://127.0.0.1:7891` 访问管理页面和 API。后端也能在没有管理端静态文件时独立提供接口。

## 客户端调用

Base URL 设置为 `http://127.0.0.1:7891/v1`，API Key 使用管理端创建的密钥。

```bash
export WKBDY_API_KEY='替换为创建的 API Key'

curl http://127.0.0.1:7891/v1/chat/completions \
  -H "Authorization: Bearer $WKBDY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"Reply with exactly OK."}],"max_tokens":128}'
```

流式调用在请求中加入 `"stream": true`，并使用 `curl -N`。完整字段说明、`context_window` 与错误处理见 [客户端 API](docs/client-api.md)。

## 配置与数据

启动配置来自 `.env`；账号调度、上游地址、Token 刷新与日志保留等运行时设置保存在 SQLite 中，可通过管理端即时调整。

默认数据目录为 `./data`，包含数据库和凭证加密密钥。备份时应一起保存 `wkbdy.db` 与 `encryption.key`；使用 `TOKEN_ENCRYPTION_KEY` 时，应另行保管相同的密钥值。详细步骤见 [部署运维](docs/deployment.md)。

服务按单进程设计。OAuth 流程、调度游标、并发上限和刷新锁存在于内存中，部署时使用一个实例。

## 开发验证

```bash
npm run typecheck
npm test
npm run build
# 先构建管理端静态文件，再验证生产服务启动与接口
npm run smoke
npm run verify:release
```

自动化测试使用临时数据库和模拟上游，覆盖鉴权、存储、目录导入、上下文长度、SSE 解析、错误映射、OAuth 与日志。真实上游的连通性、账号权限和余额需要通过实际请求验证。

跨仓库完整回归使用 `npm run ci`。准备要求与结果边界见 [验证与发布](docs/verification.md)。

## 许可

许可证见 [LICENSE](LICENSE)。
