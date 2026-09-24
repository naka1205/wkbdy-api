# 部署运维

## 环境要求

- Node.js 22.13 或以上（`better-sqlite3` 需要本地编译或预编译二进制；Docker 镜像内已包含编译工具链）。
- 单实例运行。服务把调度游标、OAuth 事务与刷新锁保存在内存中，多实例共享同一个 `DATA_DIR` 会互相干扰。

## Docker

```bash
cp .env.example .env
# 至少设置 ADMIN_PASSWORD
docker compose up -d --build
docker compose logs -f wkbdy-api
```

- 容器内以 `node` 用户运行，数据写入命名卷 `wkbdy-data`。
- 端口默认只映射到宿主机回环地址 `127.0.0.1:7891`，改 `HOST_PORT` 可换端口。
- 模型目录由容器内的账号实时请求上游 `/v3/config` 获取，无需挂载文件；需要指向别的接口时设置 `WKB2API_CATALOG_URL`。
- 健康检查调用 `/health`。

## PM2

```bash
npm ci
npm run build
ADMIN_PASSWORD='…' PUBLIC_BASE_URL='http://127.0.0.1:7891' pm2 start ecosystem.config.cjs
pm2 save
```

`ecosystem.config.cjs` 使用 `fork` 模式、单实例、`kill_timeout: 16000`，与服务的优雅退出窗口一致。

## 管理端静态文件

```bash
cd ../wkbdy-api-admin
npm ci
npm run build:deploy   # 构建并复制到 ../wkbdy-api/static
```

`static/` 中存在 `index.html` 时后端会托管管理页面（`index.html` 不缓存，其他资源缓存 1 小时）；不存在时根路径返回 JSON 提示，API 仍可独立使用。

## 反向代理

对外暴露时务必加 HTTPS，并把管理端与 API 放在同一域名下（会话 Cookie 为 `SameSite=Lax`）。Nginx 示例：

```nginx
server {
  listen 443 ssl;
  server_name wkbdy.example.com;
  ssl_certificate /etc/letsencrypt/live/wkbdy.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/wkbdy.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:7891;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  # SSE 流式响应：关闭缓冲与超时
  location /v1/ {
    proxy_pass http://127.0.0.1:7891;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }
}
```

启用 TLS 后设置 `PUBLIC_BASE_URL=https://wkbdy.example.com`，管理会话 Cookie 会自动带 `Secure`。

## 账号接入

1. **网页登录**（推荐）：管理端“账号 → 网页登录”，在浏览器完成 WorkBuddy 登录；网关自动轮询并落地令牌与 refresh token，之后可自动续期。
2. **手工令牌**：适用于无法完成网页登录的环境。需要令牌的 `sub` 或显式 `user_id`；无 refresh token 时过期只能重新添加。
3. **本机凭据文件**：设置 `WKB2API_CREDENTIALS_PATH` 后，管理端可一键导入本机 WorkBuddy 客户端保存的账号。
4. **环境变量**：`API_KEYS` 用于导入客户端密钥；账号令牌不再支持环境变量注入。

## 备份与恢复

需要一起备份：

```bash
tar czf wkbdy-backup-$(date +%F).tar.gz \
  -C /path/to/wkbdy-api data/wkbdy.db data/encryption.key
```

- 使用 `TOKEN_ENCRYPTION_KEY` 时不会生成 `encryption.key`，必须单独保管该值。
- 恢复后启动时若无法解密账号，服务会拒绝启动并提示 `Cannot decrypt accounts…`。
- `data/wkbdy.db-wal`、`data/wkbdy.db-shm` 属于运行时文件；在线备份建议先停服务或使用 `sqlite3 wkbdy.db ".backup backup.db"`。

## 从 wkbdy2api 迁移

旧版把账号保存在 `data/accounts.enc`（AES-256-GCM）中：

```bash
cd wkbdy-api
cp .env.example .env   # 设置 ADMIN_PASSWORD
WKB2API_ACCOUNT_STORE_PATH=../WkBdy2api/data/accounts.enc \
WKB2API_ACCOUNT_STORE_KEY_FILE=../WkBdy2api/account-store.key \
npm run migrate
npm run sync:catalog   # 从上游拉取目录并写入表结构
```

迁移会保留调度策略、账号备注与 `oauth_origin`（可继续自动刷新），凭证改用新的 `encryption.key` 重新加密。

## 排障

| 现象                                           | 排查方向                                                                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 启动失败：`Set ADMIN_PASSWORD…`                | `.env` 缺失或密码短于 8 位                                                                                 |
| 启动失败：`Cannot decrypt accounts…`           | 数据库与 `encryption.key`/`TOKEN_ENCRYPTION_KEY` 不匹配                                                    |
| 启动后 `/v1/models` 为空                       | 首次拉取需要可用账号：先在面板加账号，或点“同步目录”重试；日志里有 `Could not load the model catalog` 警告 |
| `503 upstream_error`                           | 没有可用账号：查看 `GET /api/admin/overview` 的 `availability` 与账号 `detail`                             |
| `502 upstream_authentication_error`            | 账号令牌被上游拒绝：重新网页登录                                                                           |
| 请求很慢或中途断开                             | 反向代理缓冲/超时；确认 `/v1/` 已关闭 `proxy_buffering`                                                    |
| 管理端 401 反复出现                            | Cookie 被代理改写、`PUBLIC_BASE_URL` 协议与实际不一致                                                      |
| 目录同步后模型消失                             | 上游目录里该模型已下线或不再属于 `cli` Agent；以面板的“同步目录”结果为准                                   |
| `catalog_unauthorized` / `catalog_unreachable` | 读目录的账号被拒或网络不通：重新登录账号，或检查 `WKB2API_CATALOG_URL`                                     |

日志为 JSON 行，包含 `requestId`、`method`、`url`、`status`、`duration_ms`、`api_key`；设为 `LOG_LEVEL=debug` 可看到更详细的调度信息。
