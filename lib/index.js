/**
 * dsh-file-download — 给 Host 增加一条按真实文件名交付文件的下载路由 `/api/dl`。
 *
 * 为什么要它：内置的 `/api/file?path=…` 响应不带 `Content-Disposition`，浏览器只能按
 * URL 最后一段（`/api/file`）取名，于是下载一律叫 `file.xxx`。本插件在**同一条已鉴权的
 * 共享 API 通道**上注册一条 exact 路由（`ctx.connection.fetch.register` 只接受 `/api/`
 * 下的路径），因此鉴权、trustedHost/CSRF 与 owner-peer 校验都和 `/api/file` 一致，
 * 不会另开一个公网可读面。
 *
 * 为什么零运行时依赖：插件被装进 profile 的 node_modules，解析锚点在 profile 里，
 * 核心包（@deepseek-ai/dsh-fs 等）不一定在解析路径上；所以本文件只用 node: 内置模块，
 * 文件系统与鉴权服务全部通过注入的 `ctx` 取，错误按 `error.code` 字符串映射。
 * 这样核心升级不会让插件装载失败。
 *
 * 用法（浏览器已登录 GUI 的同一浏览器里打开即可）：
 *   https://<host>/api/dl?path=%2Fabs%2Fpath%2Freport.pdf            → 另存为 report.pdf
 *   …&name=STATE-2026-11-10.md                                       → 自定义下载名
 *   …&inline=1                                                       → 内联预览，但仍给出真实文件名
 *   …&download=1                                                     → 强制下载（配置 mode: inline 时用）
 */

import { isAbsolute } from 'node:path'

/** Cordis 插件稳定名（profile 补丁层按这个 id 覆盖配置）。 */
export const name = 'dsh-file-download'

/** 需要宿主的文件系统服务与 Connection 路由注册表。 */
export const inject = ['connection', 'fs']

/** 默认路由；必须是 `/api/` 下的一段，否则回落到默认值。 */
const DEFAULT_ROUTE = '/api/dl'
/** 单次读取上限，与内置 /api/file 的 20 MiB 交付约定一致。 */
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024

/** 响应头基线：下载内容不缓存、不嗅探，内联时套上和 /api/file 同样的沙箱 CSP。 */
const BASE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "sandbox; default-src 'none'",
}

/** FsError 之类的 code → HTTP 状态，未列出的按 500。 */
const STATUS_OF_CODE = {
  FS_NOT_FOUND: 404,
  FS_NOT_REGULAR_FILE: 403,
  FS_PERMISSION_DENIED: 403,
  FS_SANDBOX_DENIED: 403,
  FS_TOO_LARGE: 413,
  FS_ABORTED: 499,
  ENOENT: 404,
  EISDIR: 403,
  EACCES: 403,
}

/** 常见交付物类型；未知一律 application/octet-stream（下载名仍由 disposition 给出）。 */
const MIME = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  jsonl: 'application/x-ndjson',
  ndjson: 'application/x-ndjson',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  ts: 'text/plain',
  tsx: 'text/plain',
  jsx: 'text/plain',
  py: 'text/x-python',
  sh: 'text/x-shellscript',
  bash: 'text/x-shellscript',
  sql: 'application/sql',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  bz2: 'application/x-bzip2',
  xz: 'application/x-xz',
  zst: 'application/zstd',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  iso: 'application/x-iso9660-image',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  epub: 'application/epub+zip',
  ipynb: 'application/x-ipynb+json',
  apk: 'application/vnd.android.package-archive',
  deb: 'application/vnd.debian.binary-package',
  rpm: 'application/x-rpm',
  exe: 'application/x-msdownload',
  msi: 'application/x-msdownload',
  dmg: 'application/x-apple-diskimage',
  wsl: 'application/x-tar',
  gzipped: 'application/gzip',
}

/**
 * 取显示路径的最后一段（同时兼容 POSIX 与 Windows 分隔符）。
 * @param path - 文件服务给出的显示路径。
 * @returns 末段，空则空串。
 */
function baseOf(path) {
  const parts = String(path).split(/[/\\]+/)
  return parts[parts.length - 1] ?? ''
}

/** 扩展名（小写，不含点）。 */
function extOf(filename) {
  const match = /\.([^.\\/]+)$/.exec(filename)
  return match === null ? '' : match[1].toLowerCase()
}

/**
 * 把用户给的下载名收敛成安全单段名：去路径、去控制字符与 Windows 非法字符。
 * @param raw - 查询参数 `name` 或文件本身的名字。
 * @returns 可直接进 Content-Disposition 的名字，全被削掉时用 `download`。
 */
function safeName(raw) {
  const single = baseOf(String(raw ?? '').trim())
  const clean = single
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/^[.\s]+/, '')
    .slice(0, 200)
  return clean.length > 0 ? clean : 'download'
}

/**
 * 生成 Content-Disposition：`filename` 给老客户端 ASCII 兜底，`filename*` 给现代客户端
 * 完整的 UTF-8 名字（含中文、空格）。
 * @param mode - `attachment`（下载）或 `inline`（预览但保留名字）。
 * @param filename - 已经过 safeName 的名字。
 * @returns 头值。
 */
function disposition(mode, filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const fallback = ascii.replace(/^[.\s]+/, '').length > 0 ? ascii : 'download'
  return `${mode}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

/**
 * 回答一次 /api/dl 请求。
 * @param request - Connection 已鉴权（owner peer）后的请求。
 * @param fs - 宿主注入的文件系统服务（resolve / stat / readBytes）。
 * @param options - 配置好的 maxBytes 与默认 mode。
 * @returns 带真实文件名的响应。
 */
async function serve(request, fs, options) {
  const fail = (status, text) =>
    new Response(request.method === 'HEAD' ? null : text, { status, headers: BASE_HEADERS })

  const params = new URL(request.url).searchParams
  const path = params.get('path')
  if (path === null || path.length === 0) return fail(400, 'missing path')
  if (path.includes('\0') || !isAbsolute(path)) return fail(400, 'absolute path required')

  let mode = options.mode
  if (params.get('inline') === '1') mode = 'inline'
  if (params.get('download') === '1') mode = 'attachment'

  try {
    const target = await fs.resolve(path, { signal: request.signal })
    const info = await fs.stat(target, request.signal)
    if (info === undefined) return fail(404, 'not found')
    if (info.type !== 'file') return fail(403, 'not a regular file')
    if (info.size !== undefined && info.size > options.maxBytes) {
      return fail(413, `file exceeds ${options.maxBytes} bytes`)
    }

    const displayPath = typeof target?.displayPath === 'string' ? target.displayPath : path
    const filename = safeName(params.get('name') || baseOf(displayPath))
    const headers = {
      ...BASE_HEADERS,
      'Content-Type': MIME[extOf(filename)] ?? 'application/octet-stream',
      'Content-Disposition': disposition(mode, filename),
    }

    if (request.method === 'HEAD') {
      if (info.size !== undefined) headers['Content-Length'] = String(info.size)
      return new Response(null, { headers })
    }

    const bytes = await fs.readBytes(target, request.signal, options.maxBytes)
    headers['Content-Length'] = String(bytes.byteLength)
    return new Response(bytes.slice(), { headers })
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : ''
    const status = STATUS_OF_CODE[code] ?? 500
    return fail(status, status === 500 ? String(error?.message ?? error) : code)
  }
}

/**
 * 装载：在共享 API 通道上注册下载路由。
 * @param ctx - 已注入 `connection` 与 `fs` 的宿主上下文。
 * @param config - `{ route, maxBytes, mode }`；缺省即 `/api/dl`、20 MiB、attachment。
 */
export function apply(ctx, config = {}) {
  const configured = typeof config.route === 'string' ? config.route : ''
  const route = /^\/api\/[A-Za-z0-9._~-]+$/.test(configured) ? configured : DEFAULT_ROUTE
  const maxBytes =
    Number.isSafeInteger(config.maxBytes) && config.maxBytes > 0 ? config.maxBytes : DEFAULT_MAX_BYTES
  const mode = config.mode === 'inline' ? 'inline' : 'attachment'

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: route,
        methods: ['GET', 'HEAD'],
        requestBody: 'buffered',
        fetch: (request) => serve(request, ctx.fs, { maxBytes, mode }),
      }),
    'dsh-file-download: route',
  )
}
