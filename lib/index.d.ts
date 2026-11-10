/**
 * 类型声明（手写；本包运行时零依赖，也不需要构建，所以这里也不 import 任何外部包，
 * 只用结构化最小类型描述宿主注入的东西）。
 * @packageDocumentation
 */

/** 宿主提供的文件系统服务中，本插件用到的那部分。 */
export interface FsLike {
  /** 把绝对路径解析成执行世界里的目标。 */
  resolve(path: string, options?: { signal?: AbortSignal }): Promise<{ displayPath?: string } | unknown>
  /** 目标状态；不存在时返回 undefined。 */
  stat(target: unknown, signal?: AbortSignal): Promise<{ type?: string; size?: number } | undefined>
  /** 读取字节，超过 maxBytes 抛错。 */
  readBytes(target: unknown, signal?: AbortSignal, maxBytes?: number): Promise<ArrayBuffer | Uint8Array>
}

/** 宿主 Connection 的 fetch 路由注册表（`/api/` 下的 exact 路由）。 */
export interface FetchRegistryLike {
  register(route: {
    path: string
    methods: readonly string[]
    requestBody: string
    fetch: (request: Request) => Promise<Response>
  }): unknown | Promise<unknown>
}

/** 本插件需要的宿主上下文（Cordis 的 Context 的子集）。 */
export interface HostContext {
  fs: FsLike
  connection: { fetch: FetchRegistryLike }
  effect(callback: () => unknown, label?: string): unknown
}

/** Cordis 插件稳定名，profile 补丁层按这个 id 覆盖配置。 */
export const name: 'dsh-file-download'

/** 需要宿主提供的服务。 */
export const inject: readonly ['connection', 'fs']

/** 插件配置。 */
export interface Config {
  /**
   * 注册的路径，必须在 `/api/` 下（`connection.fetch.register` 的硬约束，
   * 也保证复用同一鉴权 / CSRF / owner-peer 通道）。默认 `/api/dl`；非法值回落默认。
   */
  route?: string
  /** 单次读取上限（字节）。默认 20 MiB，与内置 `/api/file` 的交付约定一致。 */
  maxBytes?: number
  /**
   * 默认交付方式：`attachment` 强制下载（默认），`inline` 内联预览但仍给出真实文件名。
   * 请求上的 `?download=1` / `?inline=1` 可逐次覆盖。
   */
  mode?: 'attachment' | 'inline'
}

/**
 * 装载：在共享 API 通道上注册下载路由。
 * @param ctx - 已注入 `connection` 与 `fs` 的宿主上下文。
 * @param config - 见 {@link Config}。
 */
export function apply(ctx: HostContext, config?: Config): void
