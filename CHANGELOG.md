# Changelog

## 0.1.0 — 2026-11-10

- 新增 `GET/HEAD /api/dl`：按真实文件名交付文件
  （`Content-Disposition: attachment; filename="<ASCII 兜底>"; filename*=UTF-8''<真实名>`）。
- 查询参数：`path`（绝对路径，必填）、`name`（自定义下载名，服务端收敛成单段安全名）、
  `inline=1`（预览但保留真名）、`download=1`（强制下载）。
- 配置项：`route`（默认 `/api/dl`）、`maxBytes`（默认 20 MiB）、`mode`（默认 `attachment`）。
- 响应头：`Cache-Control: private, no-store`、`X-Content-Type-Options: nosniff`、
  与内置 `/api/file` 同款 `Content-Security-Policy: sandbox`。
- 错误语义：缺 path / 非绝对路径 / 含 NUL → 400；不存在 → 404；目录 → 403；超限 → 413；
  fs 错误码按 `FS_*` 映射，其他异常 → 500 带原因。
- 首版即离线自检覆盖 13 组用例（`node --test test/`），运行时零第三方依赖。
