# PIC-BED / R2 临时文件中转站 — Codex 交接文档

> 状态：需求与架构已确定，尚未开始实现。
> 
> 目标仓库：`GitrnHub/PIC-BED`
> 
> 交接日期：2026-08-25

## 1. 项目目标

将 Cloudflare R2 做成一个**个人临时图床 / 临时文件中转站**。

用户日常使用时只访问托管在 GitHub Pages 的网页，不需要进入 Cloudflare Dashboard，也不需要登录任何网盘客户端。

核心能力：

1. **本地文件上传**：在网页选择文件，上传到 R2。
2. **直链 → 云保存**：在网页粘贴一个公开 HTTP/HTTPS 文件直链，由 Cloudflare Worker 从远端抓取并直接流式写入 R2，文件不需要先下载到用户电脑。
3. **临时分享直链**：保存完成后返回一个任何人都可以直接打开/下载的分享地址；朋友无需登录。
4. **按时间自动销毁**：例如 1 天、3 天、7 天或自定义保存时间。
5. **按下载次数限制**：例如最多允许 10 次下载，到达上限后立即禁止继续下载并进入删除流程。
6. **管理员鉴权**：只有仓库所有者本人能上传、远程抓取、查看文件列表、修改限制和删除文件；下载方无需鉴权。
7. **简单密码登录**：不使用 Cloudflare Access、邮箱 OTP 或复杂账号系统，只需输入一个管理员密码。

项目定位是“私人临时文件中转站”，不是公共网盘，不需要多用户注册、权限组、分享协作等复杂功能。

---

## 2. 已确定的总体架构

```text
GitHub Pages（静态前端）
        |
        | HTTPS API
        v
Cloudflare Worker
   |           |
   |           +---- D1：文件元数据 / 过期时间 / 下载计数
   |
   +---------------- R2 Private Bucket：实际文件对象
```

下载路径：

```text
朋友 -> /f/{share_id} -> Worker 检查 D1 -> R2.get() -> 流式返回文件
```

远程直链保存路径：

```text
GitHub Pages -> Worker /api/import
                    |
                    +-> fetch(remote_url)
                           |
                           +-> ReadableStream -> R2.put()
```

本地文件上传优先采用：

```text
浏览器 -> Worker 请求一次性上传授权
              |
              +-> 生成短期 R2 Presigned PUT URL

浏览器 -----------------------> R2
           直接 PUT 文件
```

不要让大文件先完整进入 Worker 内存。

---

## 3. 强制设计原则

### 3.1 R2 Bucket 必须保持 Private

不要开启整个 Bucket 的公开访问。

外部下载必须走 Worker 的 `/f/{share_id}` / 下载 ticket 路径，这样才能真正执行：

- 到期失效；
- 下载次数上限；
- 删除状态；
- 未来可能增加的访问日志或限速。

如果直接暴露永久 R2 URL，下载次数和过期限制可以被绕过。

Cloudflare R2 Workers API：
https://developers.cloudflare.com/r2/api/workers/workers-api-reference/

### 3.2 GitHub Pages 中禁止出现任何 Cloudflare Secret

仓库及前端不得包含：

- R2 Access Key；
- R2 Secret Access Key；
- 管理员密码；
- session signing key；
- Cloudflare API Token。

敏感值放入 Cloudflare Worker Secrets。

参考：
https://developers.cloudflare.com/workers/configuration/secrets/

### 3.3 远程抓取必须流式处理

不要：

```text
fetch -> arrayBuffer() -> R2
```

应当：

```text
fetch -> response.body (ReadableStream) -> R2.put()
```

Cloudflare Workers Streams API 可以避免将大文件完整缓冲到 Worker 128 MB 内存中。

参考：
https://developers.cloudflare.com/workers/runtime-apis/streams/

R2 `put()` 支持 `ReadableStream`：
https://developers.cloudflare.com/r2/api/workers/workers-api-reference/

---

## 4. 管理员登录方案

用户明确要求：**只输密码，不使用 Cloudflare Access / 邮箱验证码。**

建议 API：

```text
POST /api/login
POST /api/logout
GET  /api/session
```

登录流程：

1. GitHub Pages 显示一个密码输入框。
2. 浏览器通过 HTTPS 将密码提交给 Worker。
3. Worker 与 Secret 中保存的管理员密码（或其安全 hash）比较。
4. 成功后签发一个短期 session token，例如 24 小时。
5. 后续所有 `/api/admin/*` 请求携带该 token。
6. token 过期后重新输入密码。

推荐 Secrets：

```text
ADMIN_PASSWORD
SESSION_SECRET
```

也可以实现为 `ADMIN_PASSWORD_HASH`，但不要为了这个个人项目引入复杂身份系统。

由于 GitHub Pages 与 Worker 可能跨站，V1 可以优先使用 `Authorization: Bearer <signed-session-token>`，token 仅保存在 `sessionStorage`；不要将管理员密码保存在浏览器 localStorage。

需要配置严格 CORS，只允许本项目 GitHub Pages origin（以及本地开发 origin）调用管理员 API。

---

## 5. 推荐仓库结构

```text
PIC-BED/
├─ CODEX_HANDOFF.md
├─ README.md
├─ docs/                       # GitHub Pages 静态前端
│  ├─ index.html
│  ├─ app.js
│  └─ style.css
└─ worker/                     # Cloudflare Worker
   ├─ src/
   │  └─ index.ts
   ├─ migrations/
   │  └─ 0001_init.sql
   ├─ package.json
   ├─ tsconfig.json
   └─ wrangler.jsonc
```

前端尽量保持无构建或轻构建，避免为了一个简单工具引入庞大的前端框架。

GitHub Pages 建议直接从 `main/docs` 发布。

---

## 6. D1 数据模型

至少需要一张 `files` 表。

建议字段：

```text
id / share_id      随机不可猜的分享 ID，主键
r2_key             R2 对象 key
filename           原始文件名
mime_type          MIME
size_bytes         文件大小
source_type        local | url
source_url         远程导入时可记录源 URL；本地上传为空
created_at         创建时间
expires_at         逻辑过期时间；NULL 可表示不限时（如允许）
max_downloads      最大下载会话数；NULL 表示不限
 download_count     已使用下载会话数
status             uploading | active | expired | exhausted | deleted | failed
created_by         固定 admin，可选
last_download_at   可选
updated_at         更新时间
```

如需记录下载 ticket，可增加 `download_sessions` 表；V1 也可以使用无状态 HMAC ticket。

D1 可通过 Worker Binding 直接执行 SQL：
https://developers.cloudflare.com/d1/worker-api/

---

## 7. 下载次数的定义

不要把“一个 HTTP GET 请求”机械地等同于“一次下载”。

原因：浏览器、播放器、下载工具会使用 `Range`，断点续传也可能产生多个请求，一个真实下载可能拆成多个 GET。

推荐语义：

> `max_downloads = 10` 表示最多允许创建 10 个下载会话。

建议流程：

```text
GET /f/{share_id}
  |
  +-> 检查文件 active / 未过期 / 未达到次数上限
  |
  +-> 用一条原子 UPDATE 消耗一次下载配额
  |
  +-> 生成短期 download ticket（例如 30~60 分钟）
  |
  +-> redirect 或直接转入 /d/{share_id}?token=...

GET /d/{share_id}?token=...
  |
  +-> 验证 ticket
  +-> 允许同一 ticket 下的 Range / 续传
  +-> 不重复计数
```

D1 中建议使用单条条件 UPDATE，避免并发下载导致超卖配额，例如逻辑上：

```text
UPDATE ...
SET download_count = download_count + 1
WHERE id = ?
  AND status = 'active'
  AND (max_downloads IS NULL OR download_count < max_downloads)
  AND (expires_at IS NULL OR expires_at > now)
RETURNING ...
```

单条 SQLite 写语句保持原子性。

V1 可接受的折中：同一个 download ticket 在有效期内可以被重复用于 Range/续传。不要尝试依赖 IP 地址作为“一个人”的身份。

---

## 8. 自动过期 / 自动销毁

采用三层策略。

### 第一层：Worker 逻辑立即失效

每次访问 `/f/{id}` 时检查 `expires_at`。

一旦到期立即返回 `410 Gone`，即使 R2 实体暂时尚未删除也不能再下载。

达到下载次数上限同理：立即变为 `exhausted` / `410 Gone`。

### 第二层：Cron 定时物理删除

使用 Worker Cron（例如每小时一次）：

```text
查询 expired / exhausted / 待删除记录
-> R2.delete(r2_key)
-> D1 更新 status = deleted
```

可以保留少量 D1 tombstone 元数据，便于管理页显示“因过期/下载次数耗尽而删除”。

R2 对象可通过 Workers API 删除：
https://developers.cloudflare.com/r2/objects/delete-objects/

### 第三层：R2 Lifecycle 兜底

额外给临时对象设置一个较长的统一兜底生命周期，例如 30 天。

它不是精确的每文件过期机制，只用于防止程序 bug 导致垃圾对象永久残留。

Cloudflare 说明 lifecycle 删除通常会在过期值后约 24 小时内完成，因此精确访问控制仍应由 D1 + Worker 执行。

参考：
https://developers.cloudflare.com/r2/buckets/object-lifecycles/

---

## 9. 本地文件上传

### 推荐：Presigned PUT

流程：

```text
POST /api/admin/upload-ticket
-> Worker 鉴权
-> 生成随机 r2_key
-> 创建 uploading 元数据
-> 返回短期 R2 Presigned PUT URL

Browser PUT presigned_url
-> 文件直接进入 R2

POST /api/admin/upload-complete
-> Worker HEAD R2 对象验证大小/存在性
-> D1 status = active
-> 返回 share URL
```

R2 Presigned URL 支持限制具体对象、操作类型和有效期：
https://developers.cloudflare.com/r2/api/s3/presigned-urls/

注意配置 R2 CORS，使 GitHub Pages origin 可以执行 PUT/HEAD 所需操作。

不要把 R2 S3 凭据下发给浏览器；浏览器只得到短期、单对象、单操作的 presigned URL。

---

## 10. “直链 → 云保存”功能

管理员页面提供 URL 输入框，例如：

```text
https://example.com/files/test.zip
```

调用：

```text
POST /api/admin/import-url
```

请求体至少包含：

```text
url
expires_in / expires_at
max_downloads
optional filename override
```

Worker：

1. 验证管理员 session。
2. 只接受 `http:` / `https:`。
3. 生成新的 `share_id` 和 `r2_key`。
4. `fetch(remote_url)`。
5. 检查 HTTP 状态和响应头。
6. 使用 `response.body` 直接 `R2.put()`。
7. 保存/更新 D1 元数据。
8. 返回分享 URL。

需要考虑：

- 跟随重定向时仍需验证最终 URL；
- 限制最大重定向次数；
- 屏蔽 localhost、loopback、link-local、RFC1918 私网等 SSRF 目标；
- 设置合理的最大文件大小；
- 如果有 `Content-Length`，提前拒绝超限文件；
- 没有 `Content-Length` 时，应在流式过程中计数并在超限后中止；
- 远端失败时，将 D1 标为 `failed` 并清理残余对象；
- 某些网站需要 Cookie、Referer、登录态或会屏蔽数据中心 IP，这类地址允许明确报“无法抓取”，不要求 V1 绕过反爬机制。

V1 目标是**公开 HTTP/HTTPS 文件直链**，不是通用网页下载器。

---

## 11. SSRF 防护

虽然 `/api/admin/import-url` 只有管理员可调用，仍应做基础 SSRF 防护，避免以后接口误开放后成为代理。

至少拒绝：

```text
localhost
127.0.0.0/8
10.0.0.0/8
172.16.0.0/12
192.168.0.0/16
169.254.0.0/16
::1
fc00::/7
fe80::/10
```

只允许 HTTP/HTTPS。

重定向后的目标也重新检查。

---

## 12. 推荐 API 设计

公开：

```text
GET  /f/:shareId                创建/消耗一个下载会话
GET  /d/:shareId                带 ticket 实际流式下载，支持 Range
```

认证：

```text
POST /api/login
POST /api/logout
GET  /api/session
```

管理员：

```text
GET    /api/admin/files
POST   /api/admin/upload-ticket
POST   /api/admin/upload-complete
POST   /api/admin/import-url
PATCH  /api/admin/files/:id
DELETE /api/admin/files/:id
```

可选：

```text
POST /api/admin/files/:id/regenerate-link
```

分享 ID 使用足够长的 CSPRNG 随机值，例如 128 bit 级别，不使用连续整数 ID。

---

## 13. 下载实现要求

从 R2 读取后应流式返回，不要把整个对象加载入内存。

至少正确处理：

- `Content-Type`；
- `Content-Length`；
- `Content-Disposition`；
- `ETag`（如方便）；
- `Range`；
- `206 Partial Content`；
- 无效 Range 的 `416`。

建议默认：

```text
Content-Disposition: attachment; filename*=UTF-8''...
```

图片如果希望直接作为“图床”在浏览器显示，可根据需要提供 `inline` / `download=1` 之类的可选行为。

---

## 14. 前端 UX

登录后主界面应非常简单。

### 上传区

```text
[选择本地文件]

或

[粘贴公开文件 URL]

保存时间：1 天 / 3 天 / 7 天 / 自定义
下载次数：不限 / 1 / 3 / 10 / 自定义

[开始保存]
```

### 完成后显示

```text
文件名
文件大小
过期时间 / 剩余时间
已用下载次数 / 最大次数
分享地址

[复制链接] [删除]
```

### 文件管理列表

至少显示：

```text
文件名
大小
来源（本地 / URL）
创建时间
剩余时间
下载次数
状态
分享链接
操作：复制 / 修改限制 / 删除
```

可选增加进度条；本地上传应尽量显示上传进度。

无需追求复杂后台 UI，优先保证稳定、易用、移动端也能正常操作。

---

## 15. 状态码建议

```text
200 / 206   正常下载
401         管理员未登录 / session 失效
403         CORS / 权限或 URL import 被拒绝
404         share_id 不存在
409         上传状态冲突
410         已过期 / 下载次数已耗尽 / 已删除
413         文件超过项目限制
416         Range 不合法
422         URL / 参数无效
502         远端 URL 抓取失败
```

前端应显示人类可读的中文错误信息。

---

## 16. 不要实现的内容（V1）

不要扩大范围：

- 不做用户注册；
- 不做多管理员；
- 不做 OAuth；
- 不做 Cloudflare Access；
- 不做邮箱验证码；
- 不做文件夹/网盘目录树；
- 不做在线播放器；
- 不做图片编辑；
- 不做第三方网盘解析；
- 不绕过登录、DRM、防盗链；
- 不使用公开 R2 bucket；
- 不把任何 secret commit 到 GitHub；
- 不为了简单页面引入重型框架。

---

## 17. 部署目标

最终希望达到：

```text
前端：GitHub Pages
后端：Cloudflare Worker
存储：Cloudflare R2 Private Bucket
数据库：Cloudflare D1
定时任务：Cloudflare Worker Cron
```

初次安装允许使用 Cloudflare Dashboard / Wrangler 创建资源和写入 Secrets。

**初次部署完成以后，日常使用不应再要求用户打开 Cloudflare Dashboard。**

用户只需：

```text
打开 GitHub Pages
-> 输入密码
-> 上传本地文件或粘贴 URL
-> 得到分享链接
```

---

## 18. Codex 建议执行顺序

### Phase 1 — 项目骨架

1. 建立 `docs/` 静态前端。
2. 建立 `worker/` TypeScript Worker。
3. Wrangler 配置 R2、D1、Cron bindings。
4. 创建 D1 migration。
5. 添加 `.gitignore`，确保 `.env` / `.dev.vars` 等不会被提交。

### Phase 2 — 最小闭环

1. 密码登录/session。
2. 本地小文件上传。
3. D1 创建记录。
4. `/f/:id` 下载。
5. 删除文件。

先做到一个文件“上传 -> 返回分享链接 -> 未登录朋友下载”的完整闭环。

### Phase 3 — 生命周期

1. `expires_at`。
2. Cron 删除。
3. R2 lifecycle 兜底。
4. `410 Gone`。

### Phase 4 — 下载次数

1. 原子消费下载配额。
2. download ticket。
3. Range / 断点续传不重复扣次数。

### Phase 5 — URL 云保存

1. URL 校验。
2. SSRF 防护。
3. 流式 fetch -> R2。
4. 失败回滚与清理。

### Phase 6 — UI 完善和测试

1. 文件列表。
2. 修改过期/次数限制。
3. 上传/导入进度状态。
4. 手机和桌面布局。
5. 错误提示。

---

## 19. V1 验收标准

必须全部满足：

- [ ] GitHub Pages 能打开管理页面。
- [ ] 未登录时看不到/不能调用管理员功能。
- [ ] 正确密码可以登录，错误密码拒绝。
- [ ] 密码及其他 Secret 不存在于仓库和前端产物。
- [ ] 能从浏览器上传本地文件到 Private R2。
- [ ] 能粘贴一个公开 HTTP/HTTPS 文件直链并由 Worker 云端保存到 R2，本地不需要先下载该文件。
- [ ] 上传后能返回不可预测的分享 URL。
- [ ] 朋友打开分享 URL 无需登录。
- [ ] R2 bucket 不公开。
- [ ] 能设置过期时间。
- [ ] 到期后分享链接立即返回 410。
- [ ] Cron 最终删除到期 R2 实体。
- [ ] 能设置最大下载次数。
- [ ] 达到下载次数后不能继续创建新下载会话。
- [ ] Range / 断点续传不会把一次正常下载错误计算成很多次。
- [ ] 管理页可以查看、复制链接和手动删除文件。
- [ ] 手动删除后文件无法再下载。
- [ ] 远程 URL import 有基础 SSRF 防护。
- [ ] 大文件路径不使用 `arrayBuffer()` 全量缓冲。
- [ ] README 给出从空 Cloudflare 账号到部署完成的明确步骤。

---

## 20. Cloudflare 官方参考资料

实现时优先查 Cloudflare 最新文档，不要凭旧版本 API 记忆：

- R2 Workers API  
  https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
- R2 Presigned URLs  
  https://developers.cloudflare.com/r2/api/s3/presigned-urls/
- R2 Object Lifecycle  
  https://developers.cloudflare.com/r2/buckets/object-lifecycles/
- R2 Delete Objects  
  https://developers.cloudflare.com/r2/objects/delete-objects/
- D1 Workers Binding API  
  https://developers.cloudflare.com/d1/worker-api/
- Workers Streams API  
  https://developers.cloudflare.com/workers/runtime-apis/streams/
- Workers Secrets  
  https://developers.cloudflare.com/workers/configuration/secrets/

---

## 21. 给 Codex 的关键提醒

1. **先做可运行的最小闭环，再增加 URL import 和下载 ticket，不要一次堆完所有功能。**
2. **不要把 R2 bucket 改成 public。**
3. **不要把密码、API Token、R2 key 写进仓库。**
4. **远程文件必须流式写 R2，下载也必须流式返回。**
5. **下载次数按下载会话计数，不按 Range 请求数计数。**
6. **所有重要状态以 D1 为准，R2 只负责对象内容。**
7. **页面和错误信息优先使用中文。**
8. 如果 Cloudflare 当前 API/限制与本文冲突，以最新 Cloudflare 官方文档为准，并在 commit / README 中说明调整原因。

