const LOGIN_BODY_LIMIT_BYTES = 4 * 1024;
const MAX_FILENAME_LENGTH = 255;
const MAX_MIME_TYPE_LENGTH = 255;
const SESSION_AUDIENCE = "pic-bed-admin";

type SessionPayload = {
  aud: typeof SESSION_AUDIENCE;
  exp: number;
  iat: number;
  sub: "admin";
};

type FileRow = {
  filename: string;
  id: string;
  mime_type: string;
  r2_key: string;
  size_bytes: number;
  status: string;
};

class HttpError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const isApiRequest = url.pathname.startsWith("/api/");

    if (isApiRequest) {
      const origin = request.headers.get("Origin");
      if (!isAllowedOrigin(origin, env.ALLOWED_ORIGINS)) {
        return errorResponse(403, "origin_forbidden", "不允许的请求来源");
      }

      if (request.method === "OPTIONS") {
        return withCors(new Response(null, { status: 204 }), origin);
      }
    }

    try {
      const response = await routeRequest(request, env, ctx, url);
      if (!isApiRequest) {
        return response;
      }
      return withCors(response, request.headers.get("Origin"));
    } catch (error) {
      const response = handleError(error, url.pathname);
      if (!isApiRequest) {
        return response;
      }
      return withCors(response, request.headers.get("Origin"));
    }
  },

  scheduled(controller: ScheduledController, _env: Env, _ctx: ExecutionContext): void {
    console.log(
      JSON.stringify({
        event: "cron_noop",
        message: "Phase 3 lifecycle cleanup is not implemented yet.",
        scheduledTime: controller.scheduledTime,
      }),
    );
  },
} satisfies ExportedHandler<Env>;

async function routeRequest(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  if (url.pathname === "/health" && request.method === "GET") {
    return jsonResponse({ phase: "minimal-backend", service: "pic-bed-worker", status: "ok" });
  }

  if (url.pathname === "/api/login") {
    requireMethod(request, "POST");
    return login(request, env);
  }

  if (url.pathname === "/api/logout") {
    requireMethod(request, "POST");
    return new Response(null, { status: 204 });
  }

  if (url.pathname === "/api/session") {
    requireMethod(request, "GET");
    const session = await requireAdmin(request, env);
    return jsonResponse({ authenticated: true, expiresAt: session.exp });
  }

  if (url.pathname === "/api/admin/files") {
    requireMethod(request, "POST");
    await requireAdmin(request, env);
    return uploadSmallFile(request, env, url);
  }

  const adminFileMatch = /^\/api\/admin\/files\/([a-f0-9]{32})$/.exec(url.pathname);
  if (adminFileMatch) {
    requireMethod(request, "DELETE");
    await requireAdmin(request, env);
    const shareId = adminFileMatch[1];
    if (shareId === undefined) {
      throw new HttpError(404, "not_found", "文件不存在");
    }
    return deleteFile(env, shareId);
  }

  const publicFileMatch = /^\/f\/([a-f0-9]{32})$/.exec(url.pathname);
  if (publicFileMatch) {
    requireMethod(request, "GET");
    const shareId = publicFileMatch[1];
    if (shareId === undefined) {
      throw new HttpError(404, "not_found", "分享链接不存在");
    }
    return downloadFile(env, shareId);
  }

  throw new HttpError(404, "not_found", "接口不存在");
}

async function login(request: Request, env: Env): Promise<Response> {
  const body = await readBoundedJson(request, LOGIN_BODY_LIMIT_BYTES);
  if (!isRecord(body) || typeof body.password !== "string" || body.password.length === 0) {
    throw new HttpError(422, "invalid_password", "请输入管理员密码");
  }

  if (!(await timingSafeStringEqual(body.password, env.ADMIN_PASSWORD))) {
    throw new HttpError(401, "invalid_credentials", "管理员密码错误");
  }

  const now = Math.floor(Date.now() / 1000);
  const ttlSeconds = readPositiveInteger(env.SESSION_TTL_SECONDS, "SESSION_TTL_SECONDS");
  const payload: SessionPayload = {
    aud: SESSION_AUDIENCE,
    exp: now + ttlSeconds,
    iat: now,
    sub: "admin",
  };
  const token = await signSession(payload, env.SESSION_SECRET);

  return jsonResponse({ expiresAt: payload.exp, token });
}

async function uploadSmallFile(request: Request, env: Env, url: URL): Promise<Response> {
  const filename = normalizeFilename(url.searchParams.get("filename"));
  const maxUploadBytes = readPositiveInteger(env.MAX_UPLOAD_BYTES, "MAX_UPLOAD_BYTES");
  const declaredLength = parseContentLength(request.headers.get("Content-Length"));
  if (declaredLength === null) {
    throw new HttpError(411, "length_required", "小文件上传必须提供 Content-Length");
  }
  if (declaredLength !== null && declaredLength > maxUploadBytes) {
    throw new HttpError(413, "file_too_large", "文件超过当前小文件上传限制");
  }
  if (request.body === null) {
    throw new HttpError(422, "missing_file", "请求中没有文件内容");
  }

  const contentType = normalizeMimeType(request.headers.get("Content-Type"));
  const shareId = crypto.randomUUID().replaceAll("-", "");
  const r2Key = `files/${shareId}`;
  const now = Math.floor(Date.now() / 1000);

  await env.DB.prepare(
    `INSERT INTO files (
      id, r2_key, filename, mime_type, size_bytes, source_type, source_url,
      created_at, expires_at, max_downloads, download_count, status,
      created_by, last_download_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'local', NULL, ?, NULL, NULL, 0, 'uploading', 'admin', NULL, ?)`,
  )
      .bind(shareId, r2Key, filename, contentType, declaredLength, now, now)
      .run();

  try {
    const object = await env.BUCKET.put(r2Key, request.body, {
      httpMetadata: { contentType },
    });

    await env.DB.prepare(
      "UPDATE files SET size_bytes = ?, status = 'active', updated_at = ? WHERE id = ? AND status = 'uploading'",
    )
      .bind(object.size, Math.floor(Date.now() / 1000), shareId)
      .run();

    const shareUrl = new URL(`/f/${shareId}`, request.url).toString();
    return jsonResponse(
      {
        filename,
        id: shareId,
        mimeType: contentType,
        shareUrl,
        sizeBytes: object.size,
        status: "active",
      },
      201,
    );
  } catch (error) {
    console.error(
      JSON.stringify({ error: errorMessage(error), event: "upload_failed", shareId }),
    );
    await cleanupFailedUpload(env, shareId, r2Key);
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(500, "upload_failed", "文件上传失败");
  }
}

async function cleanupFailedUpload(env: Env, shareId: string, r2Key: string): Promise<void> {
  try {
    await env.BUCKET.delete(r2Key);
  } catch (error) {
    console.error(
      JSON.stringify({
        error: errorMessage(error),
        event: "upload_cleanup_r2_failed",
        shareId,
      }),
    );
  }

  try {
    await env.DB.prepare("UPDATE files SET status = 'failed', updated_at = ? WHERE id = ?")
      .bind(Math.floor(Date.now() / 1000), shareId)
      .run();
  } catch (error) {
    console.error(
      JSON.stringify({
        error: errorMessage(error),
        event: "upload_cleanup_d1_failed",
        shareId,
      }),
    );
  }
}

async function downloadFile(env: Env, shareId: string): Promise<Response> {
  const file = await env.DB.prepare(
    "SELECT id, r2_key, filename, mime_type, size_bytes, status FROM files WHERE id = ?",
  )
    .bind(shareId)
    .first<FileRow>();

  if (file === null) {
    throw new HttpError(404, "not_found", "分享链接不存在");
  }
  if (file.status !== "active") {
    throw new HttpError(410, "file_unavailable", "文件已失效或被删除");
  }

  const object = await env.BUCKET.get(file.r2_key);
  if (object === null) {
    console.error(JSON.stringify({ event: "r2_object_missing", shareId }));
    throw new HttpError(410, "file_unavailable", "文件内容已不可用");
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", file.mime_type || "application/octet-stream");
  headers.set("Content-Length", String(object.size));
  headers.set("Content-Disposition", contentDisposition(file.filename));
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", "private, no-store");

  return new Response(object.body, { headers });
}

async function deleteFile(env: Env, shareId: string): Promise<Response> {
  const result = await env.DB.prepare(
    `UPDATE files
     SET status = 'deleted', updated_at = ?
     WHERE id = ? AND status IN ('uploading', 'active', 'failed')
     RETURNING r2_key`,
  )
    .bind(Math.floor(Date.now() / 1000), shareId)
    .first<{ r2_key: string }>();

  if (result === null) {
    throw new HttpError(404, "not_found", "文件不存在或已删除");
  }

  try {
    await env.BUCKET.delete(result.r2_key);
  } catch (error) {
    await env.DB.prepare("UPDATE files SET status = 'failed', updated_at = ? WHERE id = ?")
      .bind(Math.floor(Date.now() / 1000), shareId)
      .run();
    console.error(
      JSON.stringify({ error: errorMessage(error), event: "delete_r2_failed", shareId }),
    );
    throw new HttpError(500, "delete_failed", "文件删除失败");
  }

  return new Response(null, { status: 204 });
}

async function requireAdmin(request: Request, env: Env): Promise<SessionPayload> {
  const authorization = request.headers.get("Authorization");
  if (authorization === null || !authorization.startsWith("Bearer ")) {
    throw new HttpError(401, "unauthorized", "请先登录");
  }

  const payload = await verifySession(authorization.slice("Bearer ".length), env.SESSION_SECRET);
  if (payload === null) {
    throw new HttpError(401, "invalid_session", "登录状态无效或已过期");
  }
  return payload;
}

async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  requireSessionSecret(secret);
  const encodedPayload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmacSha256(secret, encodedPayload);
  return `${encodedPayload}.${base64UrlEncode(signature)}`;
}

async function verifySession(token: string, secret: string): Promise<SessionPayload | null> {
  requireSessionSecret(secret);
  if (token.length > 2048) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const encodedPayload = parts[0];
  const encodedSignature = parts[1];
  if (encodedPayload === undefined || encodedSignature === undefined) {
    return null;
  }

  try {
    const expectedSignature = await hmacSha256(secret, encodedPayload);
    const providedSignature = base64UrlDecode(encodedSignature);
    if (
      providedSignature.byteLength !== expectedSignature.byteLength ||
      !crypto.subtle.timingSafeEqual(providedSignature, expectedSignature)
    ) {
      return null;
    }

    const parsed: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload)));
    if (!isSessionPayload(parsed)) {
      return null;
    }
    if (parsed.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function hmacSha256(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
}

async function timingSafeStringEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  return crypto.subtle.timingSafeEqual(leftHash, rightHash);
}

async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  if (request.body === null) {
    throw new HttpError(422, "invalid_json", "请求体不能为空");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    totalBytes += result.value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel("request body too large");
      throw new HttpError(413, "request_too_large", "请求体过大");
    }
    chunks.push(result.value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new HttpError(422, "invalid_json", "请求体不是有效 JSON");
  }
}

function isAllowedOrigin(origin: string | null, allowedOrigins: string): boolean {
  if (origin === null) {
    return true;
  }
  return allowedOrigins
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .includes(origin);
}

function withCors(response: Response, origin: string | null): Response {
  if (origin === null) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  headers.append("Vary", "Origin");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function requireMethod(request: Request, expectedMethod: string): void {
  if (request.method !== expectedMethod) {
    throw new HttpError(405, "method_not_allowed", "请求方法不受支持");
  }
}

function normalizeFilename(value: string | null): string {
  const filename = value?.trim();
  if (filename === undefined || filename.length === 0) {
    throw new HttpError(422, "invalid_filename", "缺少文件名");
  }
  if (filename.length > MAX_FILENAME_LENGTH || /[\u0000-\u001f\u007f]/u.test(filename)) {
    throw new HttpError(422, "invalid_filename", "文件名不合法");
  }
  return filename;
}

function normalizeMimeType(value: string | null): string {
  if (
    value === null ||
    value.length === 0 ||
    value.length > MAX_MIME_TYPE_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return "application/octet-stream";
  }
  return value;
}

function parseContentLength(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new HttpError(422, "invalid_content_length", "Content-Length 不合法");
  }
  return parsed;
}

function readPositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    console.error(JSON.stringify({ event: "invalid_configuration", name }));
    throw new HttpError(500, "server_misconfigured", "服务配置错误");
  }
  return parsed;
}

function requireSessionSecret(secret: string): void {
  if (new TextEncoder().encode(secret).byteLength < 32) {
    console.error(JSON.stringify({ event: "invalid_configuration", name: "SESSION_SECRET" }));
    throw new HttpError(500, "server_misconfigured", "服务配置错误");
  }
}

function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/gu, "_").replace(/["/\\]/gu, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionPayload(value: unknown): value is SessionPayload {
  return (
    isRecord(value) &&
    value.aud === SESSION_AUDIENCE &&
    typeof value.exp === "number" &&
    Number.isSafeInteger(value.exp) &&
    typeof value.iat === "number" &&
    Number.isSafeInteger(value.iat) &&
    value.sub === "admin"
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    headers: { "Cache-Control": "no-store" },
    status,
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

function handleError(error: unknown, path: string): Response {
  if (error instanceof HttpError) {
    return errorResponse(error.status, error.code, error.message);
  }
  console.error(
    JSON.stringify({
      error: errorMessage(error),
      event: "unhandled_error",
      path,
    }),
  );
  return errorResponse(500, "internal_error", "服务器内部错误");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

