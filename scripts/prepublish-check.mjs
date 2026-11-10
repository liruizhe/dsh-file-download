/**
 * 发布前体检：跑测试 + 核对打包清单 + 挡住占位符。
 * 跑法：npm run check
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const note = (message) => problems.push(message)

// 1) 测试必须先过
const tests = spawnSync(process.execPath, ['--test'], { cwd: root, encoding: 'utf8' })
if (tests.status !== 0) {
  process.stdout.write(tests.stdout ?? '')
  process.stderr.write(tests.stderr ?? '')
  console.error('check: 测试未通过，终止')
  process.exit(1)
}
const passed = /(?:#|\u2139)\s*pass\s+(\d+)/.exec(tests.stdout ?? '')
console.log(`check: 测试通过（${passed?.[1] ?? '?'} 项）`)

// 2) 清单：manifest 声明的文件都得真在
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const required = ['name', 'version', 'description', 'license', 'repository', 'type', 'files', 'exports', 'dsh', 'peerDependencies']
for (const field of required) if (manifest[field] === undefined) note(`package.json 缺字段：${field}`)

if (typeof manifest.repository === 'object' && /CHANGE-ME|your-|TODO/i.test(String(manifest.repository.url ?? ''))) {
  note(`package.json 的 repository.url 还是占位符：${manifest.repository.url}；发布前改成真实仓库地址`)
}

if (manifest.dsh?.bundle?.patch === undefined) note('package.json 缺 dsh.bundle.patch —— 不会被当成 bundle 装载')
const patchPath = join(root, String(manifest.dsh?.bundle?.patch ?? '').replace(/^\.\//, ''))
if (manifest.dsh?.bundle?.patch !== undefined && !existsSync(patchPath)) note(`bundle patch 文件不存在：${manifest.dsh.bundle.patch}`)

for (const entry of manifest.files ?? []) {
  if (!existsSync(join(root, entry))) note(`files 里的条目不存在：${entry}`)
}
for (const entry of ['lib', 'cordis.patch.yml']) {
  if (!(manifest.files ?? []).includes(entry)) note(`files 必须包含 ${entry}，否则装进 profile 后装载失败`)
}
for (const [key, value] of Object.entries(manifest.exports ?? {})) {
  const target = typeof value === 'string' ? value : value?.default
  if (typeof target === 'string' && !target.startsWith('./package.json') && !existsSync(join(root, target))) {
    note(`exports["${key}"] 指向不存在的文件：${target}`)
  }
}
if (manifest.type !== 'module') note('type 必须是 module（核心按 ESM 装载插件）')
if (/^(file:|link:|workspace:)/.test(String(manifest.version ?? ''))) note('version 不是合法 semver')

// 3) 别把占位符 / 本机私有路径发出去
for (const file of ['README.md', 'cordis.patch.yml', 'lib/index.js']) {
  const text = readFileSync(join(root, file), 'utf8')
  if (/CHANGE-ME|<你的账号>|\/home\/harness\//.test(text)) note(`${file} 里有占位符或本机私有路径，发布前应清理`)
}

if (problems.length > 0) {
  console.error('check: 发布前体检未通过')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`check: ${manifest.name}@${manifest.version} 清单完整，可以发布`)
