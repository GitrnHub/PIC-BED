# PIC-BED Cloudflare 最小闭环交接

> 日期：2026-08-25  
> 实现范围：Cloudflare Phase 1 + Phase 2 最小后端闭环  
> 线上部署状态：尚未部署；本机 Wrangler 未登录 Cloudflare 账号  
> 前端状态：未实现，留给网页端继续

## 1. 本轮已经完成

Cloudflare 侧已经实现并在 Wrangler 本地运行时验证：

- TypeScript Worker 项目骨架；
- D1、Private R2、Cron bindings；
- D1 `files` 初始 migration；
- 管理员密码登录；
- 24 小时 HMAC Bearer session；
- 管理员小文件原始流上传；
- D1 元数据创建与状态更新；
- 无需登录的公开分享下载；
- 管理员删除文件；
- 删除后分享链接立即返回 `410 Gone`；
- 严格管理员 API CORS；
- 中文 JSON 错误信息；
- 结构化日志与 Workers observability；
- Secret、本地状态和依赖目录的忽略规则。

R2 binding 没有配置公开域名或公开开发 URL。Bucket 必须继续保持 Private，下载只能走 Worker。

## 2. 本轮明确没有实现

为避免扩大范围，以下内容仍留在原交接文档指定的后续 Phase：

- GitHub Pages 页面；
- 文件列表与限制修改界面；
- Presigned PUT 大文件直传；
- 过期时间、Cron 物理删除；
- 最大下载次数；
- download ticket 与 Range/断点续传；
- URL 云保存和 SSRF 防护；
- R2 lifecycle 兜底。

当前 Cron 每小时会触发，但 handler 只输出 `cron_noop` 结构化日志，不会删除任何文件。真正清理逻辑属于 Phase 3。

## 3. Cloudflare 文件

```text
worker/
├─ src/index.ts
├─ migrations/0001_init.sql
├─ package.json
├─ pnpm-lock.yaml
├─ pnpm-workspace.yaml
├─ tsconfig.json
└─ wrangler.jsonc
```

根目录 `.gitignore` 会排除：

- `.dev.vars` / `.env`；
- `.wrangler/` 本地 D1、R2 和日志状态；
- `worker-configuration.d.ts` 生成类型文件；
- `node_modules/`；
- 构建产物和日志。

`worker-configuration.d.ts` 由 `pnpm run check` 中的 `wrangler types` 自动生成，不提交大体积运行时类型，也没有手写 binding interface。

## 4. 当前 API 契约

错误响应统一为：

```json
{
  "error": {
    "code": "machine_readable_code",
    "message": "中文错误信息"
  }
}
```

### `GET /health`

公开健康检查，不访问 D1/R2。

### `POST /api/login`

请求：

```json
{
  "password": "管理员输入的密码"
}
```

成功返回：

```json
{
  "token": "signed-session-token",
  "expiresAt": 1780000000
}
```

前端只应把 `token` 保存在 `sessionStorage`，不能保存管理员密码。

### `POST /api/logout`

返回 `204`。当前 session 是无状态 HMAC token，因此退出操作由前端删除 `sessionStorage` 中的 token 完成。

### `GET /api/session`

Header：

```text
Authorization: Bearer <token>
```

用于页面刷新后校验 token。

### `POST /api/admin/files?filename=<URL 编码文件名>`

这是 Phase 2 的小文件上传接口，不使用 `multipart/form-data`。

请求要求：

```text
Authorization: Bearer <token>
Content-Type: 文件 MIME
Body: File / Blob 原始内容
```

浏览器应直接把 `File` 作为 `fetch` body。浏览器会提供已知长度请求流，Worker 校验 `Content-Length` 后把原始流直接传给 `R2.put()`，不会调用 `arrayBuffer()`。

当前限制为 10 MiB。缺少已知长度返回 `411`，超限返回 `413`。大文件 Presigned PUT 属于后续 Phase。

成功返回：

```json
{
  "id": "128-bit-random-share-id",
  "filename": "example.png",
  "mimeType": "image/png",
  "sizeBytes": 12345,
  "status": "active",
  "shareUrl": "https://<worker>/f/<id>"
}
```

### `GET /f/:id`

公开访问，不需要管理员 token。Worker 先读取 D1，只有 `active` 文件才从 Private R2 流式返回。

当前返回 `Content-Type`、`Content-Length`、`Content-Disposition` 和 `ETag`。Range 支持留给 Phase 4。

### `DELETE /api/admin/files/:id`

需要 Bearer token。先在 D1 将文件标记为 `deleted`，然后删除 R2 对象。成功返回 `204`，之后公开链接返回 `410`。

## 5. 网页端最小对接方式

网页端只需实现以下调用，不需要修改 Worker：

```js
const login = await fetch(`${API_BASE}/api/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password }),
}).then((response) => response.json());

sessionStorage.setItem("picBedToken", login.token);

const uploaded = await fetch(
  `${API_BASE}/api/admin/files?filename=${encodeURIComponent(file.name)}`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${login.token}`,
      "Content-Type": file.type || "application/octet-stream",
    },
    body: file,
  },
).then((response) => response.json());
```

上传完成后展示 `uploaded.shareUrl`；删除时调用 `DELETE /api/admin/files/:id`。

生产 CORS 当前允许：

```text
https://gitrnhub.github.io
```

本地开发还允许：

```text
http://localhost:5500
http://127.0.0.1:5500
```

如果 GitHub Pages 使用自定义域名，需要同步修改 `worker/wrangler.jsonc` 的 `ALLOWED_ORIGINS`。

## 6. Cloudflare 首次部署

当前使用 Wrangler 4.125 的 automatic provisioning：D1 与 R2 binding 只声明 binding 名，首次部署时 Wrangler 会创建资源并把资源标识写回配置。

在已安装 Node.js 和 pnpm 的终端执行：

```bash
cd worker
pnpm install
pnpm run check
pnpm exec wrangler login
pnpm exec wrangler deploy
pnpm exec wrangler secret put ADMIN_PASSWORD
pnpm exec wrangler secret put SESSION_SECRET
pnpm exec wrangler d1 migrations apply DB --remote
pnpm exec wrangler deploy
```

要求：

- `ADMIN_PASSWORD` 不得提交到仓库；
- `SESSION_SECRET` 至少 32 字节，建议使用密码管理器生成随机值；
- 不要把本地测试用 `.dev.vars` 提交；
- 首次 deploy 自动写回的 D1/R2 资源标识不是 Secret，可以提交；
- 部署后再次确认 R2 没有开启公开访问。

当前机器执行 `wrangler whoami` 的结果是“未认证”，所以本轮没有擅自创建线上 Cloudflare 资源，也没有使用临时预览账号替代正式账号。

## 7. 已完成的验证

工具链：

- Wrangler `4.125.0`
- `@cloudflare/workers-types` `5.20260823.1`
- TypeScript `7.0.2`

静态与打包检查：

- `wrangler types --check`：通过；
- `tsc --noEmit`：通过；
- `wrangler deploy --dry-run`：通过；
- D1 `0001_init.sql` 本地 migration：4 条命令全部成功。

本地端到端回归：

| 检查项 | 结果 |
|---|---:|
| `GET /health` | `200` |
| 错误密码登录 | `401` |
| 正确密码登录与 session | 通过 |
| 未授权上传 | `401` |
| 非允许 Origin | `403` |
| 43 字节中文文件名上传 | `201 active` |
| 未登录公开下载 | `200`，内容一致 |
| 管理员删除 | `204` |
| 删除后再次下载 | `410 file_unavailable` |
| 本地 Cron 触发 | `200`，只记录 `cron_noop` |

## 8. 网页端继续前的状态标记

```text
CLOUDFLARE_HANDOFF_STATUS: MINIMAL_BACKEND_READY_LOCAL
CLOUDFLARE_DEPLOYMENT_STATUS: WAITING_FOR_WRANGLER_LOGIN
WEB_NEXT_SCOPE: LOGIN_UPLOAD_SHARE_DELETE_UI_ONLY
```

