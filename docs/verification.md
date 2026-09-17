# 验证与发布

## 自动化测试

```bash
npm run typecheck   # src + tests + scripts
npm test            # node:test，全部使用临时数据库与模拟上游
```

覆盖范围：

| 文件                             | 内容                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `tests/store.test.ts`            | 账号加密与去重、隔离与恢复、可用性统计、密钥摘要、设置校验、目录导入、日志与保留策略 |
| `tests/models.test.ts`           | 上下文长度解析优先级、目录导入与 Agent 白名单、`/v1/models` 可见性                   |
| `tests/catalog.test.ts`          | 产品配置解析、重复 ID、能力映射                                                      |
| `tests/stream.test.ts`           | SSE 分帧、CRLF 容错、`[DONE]`、多字节字符跨包                                        |
| `tests/mapping.test.ts`          | 请求映射、reasoning 转换、占位值清理、流式 chunk 与聚合                              |
| `tests/chat-completions.test.ts` | 非流式聚合、流式转发、usage chunk、参数拒绝、错误映射、账号隔离与切换                |
| `tests/responses.test.ts`        | Responses 对象与事件序列、输入校验、上游错误                                         |
| `tests/auth.test.ts`             | 客户端密钥鉴权、管理会话与 CSRF、改密失效、登录限流                                  |
| `tests/binding.test.ts`          | 占号：密钥复用同一账号、隔离/停用/删除后释放、关闭策略后的轮询、面板手动释放         |
| `tests/admin.test.ts`            | 账号 CRUD 与校验、密钥、模型启停与同步、日志、设置                                   |
| `tests/import.test.ts`           | 本机凭据解析与导入接口                                                               |
| `tests/oauth.test.ts`            | 登录轮询、事务归属与取消、Token 刷新前置条件                                         |
| `tests/redact.test.ts`           | 错误脱敏与上游错误分类                                                               |

测试不会访问真实上游：`createServer({ fetcher })` 注入模拟传输层。

管理端浏览器测试位于 `wkbdy-api-admin/tests/admin.spec.ts`（Playwright），覆盖登录与登出、账号新增/校验/启停/删除、客户端密钥的创建与撤销、模型启停、设置持久化与日志详情：

```bash
cd wkbdy-api-admin
npm run test:e2e   # 先构建管理端，再用 tests/start-api.ts 启动后端
```

`tests/start-api.ts` 用注入的模拟上游启动真实后端（临时数据目录、固定端口 `43971`），并通过仅存在于测试进程的 `POST /__test/reset` 重置状态。

## 冒烟测试

```bash
npm run build
npm run smoke
```

冒烟会启动编译后的 `dist/index.js`（临时数据目录、随机端口），校验：`/health`、未鉴权请求被拒、初始密钥可用、目录已播种、管理端登录与账号列表，并在存在 `static/` 时校验管理页面与打包资源可访问。

## 发布校验

```bash
npm run verify:release
```

校验内容：

- `package.json` 的关键约束（Node 版本、SQLite 依赖）。
- 源码、配置示例与文档中不含形如 `sk-wk-…` 的密钥、JWT 或私钥。
- `.env.example` 覆盖 `loadEnv` 读取的全部变量。
- `docs/admin-api.md` 记录了 `src/routes/admin.ts` 中实际存在的路由。

## 跨仓库回归

```bash
npm run ci
```

依次执行：后端 `typecheck` → `test` → `build` → 管理端 `typecheck` → `build` → `deploy:assets` → 后端 `smoke` → `verify:release`。要求 `wkbdy-api` 与 `wkbdy-api-admin` 位于同级目录。

## 真实上游验证

自动化测试不覆盖上游真实行为，发布前建议手动确认：

1. 用网页登录添加一个账号，确认 `POST /api/admin/accounts/:id/verify` 返回 `ok: true`。
2. 用客户端密钥调用 `/v1/models`，确认返回的模型与目录文件、面板启停状态一致。
3. 分别以 `stream: false` 与 `stream: true` 调用 `/v1/chat/completions`，确认内容、`finish_reason` 与 usage 合理。
4. 用 `context_window` 传一个自定义值（例如 `300000`），确认它覆盖默认的 `1000000`。
5. 打开“日志”页，确认请求记录包含模型、Token 与耗时，且账号用量增加。
6. 覆盖一次失败路径：临时把上游地址改为不可达地址，确认得到 502/503 而非 500，并可从日志定位。
7. 检查 `GET /api/admin/overview` 的 `availability`：临时失败后账号应进入隔离并带 `Retry-After`，隔离结束后恢复。

明确的上游封禁（业务码 `410004`）会持久影响账号调度；余额查询成功不能证明推理权限已恢复，需用真实请求确认。
