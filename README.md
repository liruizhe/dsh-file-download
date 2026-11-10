# dsh-file-download
[![CI](https://github.com/liruizhe/dsh-file-download/actions/workflows/ci.yml/badge.svg)](https://github.com/liruizhe/dsh-file-download/actions/workflows/ci.yml)

> DSH (DeepSeek Harness) Host 插件：给 Host 增加一条 **按真实文件名**交付文件的下载路由 `GET/HEAD /api/dl`。
> 零运行时依赖、无需构建，装完即用。

## 为什么需要

DSH 内置的 `GET /api/file?path=<绝对路径>` 响应**不带 `Content-Disposition`**。浏览器只能拿 URL 最后一段
（`/api/file`）当文件名，所以每次下载都叫 `file.pdf` / `file.md` / `file.zip` —— 除非你在网页里点“另存为”，
否则真实名字就丢了。

本插件在同一条**已鉴权的共享 API 通道**上注册一条 exact 路由，把真实文件名补上（含中文名、空格）：

| | `/api/file`（内置） | `/api/dl`（本插件） |
|---|---|---|
| 用途 | 内联预览、图片渲染、GUI 的 `present` 卡片 | 交付下载 |
| `Content-Disposition` | 无 → 存成 `file.xxx` | `attachment; filename*=UTF-8''<真实名>` |
| 鉴权 / trustedHost / CSRF | 共享 API 通道 | **同一条通道**（不额外暴露面） |

> 为什么是“另起一条路由”而不是覆盖 `/api/file`：DSH 的 `registerFetchRoute` 对同一 exact 路径重复注册会直接抛错
> （源码 `@deepseek-ai/dsh-client-connection`），核心也没有任何开关可以打开 disposition。另起 `/api/` 下的新路径是
> 唯一不碰核心代码、又不绕过鉴权的做法。

## 接口

```
GET/HEAD  https://<你的 DSH 域名>/api/dl?path=<URL 编码的绝对路径>
```

| 参数 | 作用 |
|---|---|
| `path` | 必填，绝对路径（相对路径 / 含 NUL → 400） |
| `name` | 覆盖下载名；服务端会收敛成单段安全名（去路径、控制字符、`\/:*?"<>|`） |
| `inline=1` | 内联预览，但仍给出真实文件名 |
| `download=1` | 强制下载（配置 `mode: inline` 时用得上） |

状态：不存在 404、目录 403、超过 `maxBytes` 413、未登录 401。响应头带 `Cache-Control: private, no-store`、
`X-Content-Type-Options: nosniff`，以及和内置 `/api/file` 一致的 `Content-Security-Policy: sandbox`。

例：

```
https://example.org/api/dl?path=%2Fhome%2Fuser%2Fdeliverables%2Freport.pdf
https://example.org/api/dl?path=%2Ftmp%2Fa.md&name=%E7%BB%BC%E8%BF%B0-2026-11-10.md   # 综述-2026-11-10.md
```

## 安装

前提：DSH ≥ 0.2.0-rc.1（`connection.fetch` 与 `fs` 服务）；Node ≥ 20。插件**无构建脚本**，
所以从 git 安装也不会被 pnpm 的 `allowBuilds` 拦住。

### A. 从 npm

```bash
dsh plugin --profile web add dsh-file-download
```

### B. 从 GitHub（不发布 npm 也能用）

```bash
dsh plugin --profile web add github:<owner>/dsh-file-download      # 可加 #v0.1.0 / #main
```

私有仓库（自建 Gitea 等）用完整 git URL：

```bash
dsh plugin --profile web add "git+ssh://git@your.git.host:<owner>/dsh-file-download.git"
```

### C. 本地目录（自用 / 开发）

```bash
dsh plugin --profile web add file:/path/to/dsh-file-download          # 或 link: 保持就地编辑
```

### 然后：激活 + 重启（重要）

`dsh plugin …` 只是把参数转发给 pnpm，**不会**改 `dsh.profile.bundles`（GUI 的插件管理器安装才会自动激活）。
所以补一行再重启：

```bash
cd ~/.dsh/profiles/web
node -e 'const fs=require("fs"),f="package.json",m=JSON.parse(fs.readFileSync(f));const p=(m.dsh??={}).profile??={};p.bundles=[...new Set([...(p.bundles??[]),"dsh-file-download"])];fs.writeFileSync(f,JSON.stringify(m,null,2)+"\n")'
systemctl restart dsh-web        # 或你启动 dsh 的方式
```

卸载：`dsh plugin --profile web remove dsh-file-download`，并把 `dsh.profile.bundles` 里那一行删掉，重启。

## 配置（可选）

默认就是 `/api/dl` + 20 MiB + `attachment`，无需配置。要改就在 profile 的 `cordis.patch.yml` 里按 id 写**裸 row**
（本包自己的 `cordis.patch.yml` 已经 `insert` 过一次，**不要再写 `insert:`**，否则挂载两次）：

```yaml
- id: dsh-file-download
  config:
    route: /api/dl        # 必须在 /api/ 下
    maxBytes: 52428800    # 50 MiB
    mode: inline          # 默认内联预览，?download=1 才强制下载
```

改完重启 dsh 生效。GUI 里没有配置表单（故意为之：那需要依赖 `@deepseek-ai/schemastery`，会让插件不再是零依赖）。

## 安全说明

- 只读：没有写 / 删 / 列目录接口。
- 不额外做 roots 白名单：读得到什么是宿主的 `fs` 服务（同一沙箱与访问策略）说了算，与 `/api/file` 同权。
- 必须登录：路由注册在 `/api/` 下，走 DSH 的连接鉴权；非 owner principal 一律 403。
- 文件名会被收敛，`Content-Disposition` 里的引号 / 反斜杠不会成为注入点。

## 开发

```bash
git clone <repo> && cd dsh-file-download
node --test test/          # 离线自检：假 ctx + 假 fs，无需跑 dsh
npm run check              # 发布前体检（测试 + 清单完整性 + 占位符检查）
```

约定：运行时只用 `node:` 内置模块 + 注入的 `ctx`，**不 import 任何 `@deepseek-ai/*` 运行时值**
（插件被装进 profile 的 `node_modules`，核心包不一定在解析锚点上；零依赖才不会随核心升级而装载失败）。

## FAQ

- **升级 dsh 核心后 `/api/dl` 变 404？** 核心升级会重写 profile 依赖树，插件可能不再被列出。重跑安装命令，
  再确认 `dsh.profile.bundles` 里有 `dsh-file-download`，重启。
- **`dsh --profile web` 启动日志说 skipping bundle？** 看 `journalctl` / 控制台里的原因
  （通常是 `peerDependencies` 与核心版本不匹配，或 `dsh.profile.bundles` 里的名字拼错）。
- **想让浏览器直接下载而不是预览？** 默认就是 `attachment`；若你配了 `mode: inline`，用 `&download=1`。

## License

MIT
