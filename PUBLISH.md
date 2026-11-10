# 发布 / 接入手册（PUBLISH）

本包已经做成可直接对外发布的形态：**纯 ESM、无构建脚本、运行时零第三方依赖**。
所以从 npm、GitHub、私有 Git、本地目录安装都可行，而且不会被 pnpm 的 `allowBuilds` 拦
（git 安装的包若有 `prepare` 构建脚本会被 pnpm 拦住，要人工在 profile 的 `pnpm-workspace.yaml`
里加 `allowBuilds` —— 本包没有构建步骤，免这个坑）。

> **当前决定（2026-11-10）：只走 GitHub，不发 npm**（自用为主）。下面第 2 节留作以后想发时的备忘。

## 0. 发布前必做（有一条硬门槛）

```bash
npm run check
# 现在会停在这里：package.json 缺字段：repository
```

把 `package.json` 补上真实仓库地址（并把 `version` / `CHANGELOG.md` 对齐）：

```json
"repository": { "type": "git", "url": "git+https://github.com/<owner>/dsh-file-download.git" },
"homepage": "https://github.com/<owner>/dsh-file-download#readme",
"bugs": { "url": "https://github.com/<owner>/dsh-file-download/issues" }
```

再跑一次 `npm run check` → 应当输出「清单完整，可以发布」。
CI 里 `publish-readiness` 这一步就是这道门，占位符没清就红。

## 1. 放 GitHub（不必发 npm 也能让别人装）

```bash
cd <本包目录>
git init -b main
git add -A
git commit -m "feat: dsh-file-download 0.1.0（/api/dl 带真实文件名的下载路由）"
git remote add origin git@github.com:<owner>/dsh-file-download.git
git push -u origin main
git tag v0.1.0 && git push origin v0.1.0
```

别人（或你自己另一台机）安装：

```bash
dsh plugin --profile web add github:<owner>/dsh-file-download#v0.1.0   # 或 #main 跟随主干
```

私有仓库 / 自建 Gitea：

```bash
dsh plugin --profile web add "git+ssh://git@your.git.host:<owner>/dsh-file-download.git#v0.1.0"
```

（前提：跑 dsh 的那个用户对该仓库有 SSH/deploy key 权限。）

## 2. 发 npm

```bash
npm login
npm publish --access public        # 未 scoped 的名字先到先得；被占就改用 @<scope>/dsh-file-download
```

别人安装：

```bash
dsh plugin --profile web add dsh-file-download
```

发版纪律：改代码 → `npm test` → 提 `CHANGELOG.md` → `npm version patch|minor|major`（会打 git tag）
→ `npm publish` → `git push --follow-tags`。`files` 只带 `lib / cordis.patch.yml / README / CHANGELOG / LICENSE`，
测试与脚本不进 tarball（仓库里有）。

## 3. 装完之后：激活 + 重启（两条路径都一样）

`dsh plugin …` 只是把参数转给 pnpm，**不会**写 `dsh.profile.bundles`（GUI 的插件管理器安装会自动激活）。
所以补一行再重启：

```bash
cd ~/.dsh/profiles/web
node -e 'const fs=require("fs"),f="package.json",m=JSON.parse(fs.readFileSync(f));const p=(m.dsh??={}).profile??={};p.bundles=[...new Set([...(p.bundles??[]),"dsh-file-download"])];fs.writeFileSync(f,JSON.stringify(m,null,2)+"\n")'
systemctl restart dsh-web          # 或你的启动方式
```

验证（服务端看响应头，不必靠浏览器猜）：

```bash
curl -sk -D - -o /dev/null --resolve <域名>:443:127.0.0.1 \
  "https://<域名>/api/dl?path=%2Fetc%2Fhostname" | grep -iE '^HTTP/|content-disposition'
journalctl -u dsh-web --since "-2 min" --no-pager | grep -iE "skipped|incompatib|bundle"   # 应为空
```

浏览器侧的判据很简单：存下来的文件名应当是真名，不是 `file.xxx`。

## 4. 想在生产之外先验一遍（不碰线上实例）

```bash
dsh plugin --profile dl-test add github:<owner>/dsh-file-download   # 首次使用会自动 initProfile
dsh --profile dl-test --port 3099 --no-open                          # 另起一个实例，浏览器开 http://127.0.0.1:3099
```

验过再在生产 profile 上装；生产侧仍按你的升级流程走（先快照 → 改 → 分离 restart + arm 看门狗）。

## 5. 卸载 / 回滚

```bash
dsh plugin --profile web remove dsh-file-download
# 再从 package.json 的 dsh.profile.bundles 删掉那一行，重启
```

## 6. 已知约束（写进 README 也写在这里）

- 路由必须在 `/api/` 下：`connection.fetch.register` 的 `assertFetchRoute` 只接受 `/api/` 下的 exact 路径；
  好处是鉴权 / trustedHost / CSRF / owner-peer 全部复用现成通道。
- 不能覆盖 `/api/file`：`registerFetchRoute` 对同一路径重复注册会抛错；核心也没有 disposition 开关。
- 不要 import 任何 `@deepseek-ai/*` 运行时值：插件装在 profile 的 `node_modules`，核心包不一定在解析锚点上。
  类型需要就用本地最小结构类型（见 `lib/index.d.ts`）。
- 核心升级会重写 profile 依赖树：升级后若 `/api/dl` 变 404，重跑安装命令 + 确认 bundles 行，再重启。
- `peerDependencies` 里写 dsh 包的版本范围会触发核心的兼容性闸门（不匹配就 skip 掉这个 bundle），
  范围请写宽（`>=0.2.0-rc.1`）。
