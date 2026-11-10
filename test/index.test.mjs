/**
 * 离线自检：不需要跑 dsh，用假 ctx + 假 fs 驱动真实的 apply() / 路由处理器。
 * 跑法：node --test test/   或   npm test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

/**
 * 用假 fs 装载插件，返回它注册的路由与调用器。
 * @param fsImpl - 假的文件系统服务。
 * @param config - 插件配置。
 * @returns 路由对象与 call()。
 */
function mount(fsImpl, config = {}) {
  let route = null
  apply(
    {
      fs: fsImpl,
      effect: (fn) => void fn(),
      connection: { fetch: { register: (r) => ((route = r), () => {}) } },
    },
    config,
  )
  return {
    get route() {
      return route
    },
    call: (url, method = 'GET') => route.fetch(new Request(url, { method })),
  }
}

/** 常规假 fs：8 字节内容，displayPath 可覆盖。 */
const okFs = (over = {}) => ({
  async resolve() {
    return { displayPath: over.displayPath ?? '/home/harness/deliverables/report.pdf' }
  },
  async stat() {
    return over.stat ?? { type: 'file', size: 8, version: 'v1' }
  },
  async readBytes() {
    return new TextEncoder().encode(over.content ?? 'abcdefgh')
  },
})

/** 只关心 stat 的假 fs。 */
const statFs = (stat, displayPath = '/x.pdf') => ({
  async resolve() {
    return { displayPath }
  },
  async stat() {
    return stat
  },
  async readBytes() {
    return new Uint8Array(1)
  },
})

/** resolve 直接抛错的假 fs。 */
const throwingFs = (error) => ({
  async resolve() {
    throw error
  },
  async stat() {
    return { type: 'file', size: 1 }
  },
  async readBytes() {
    return new Uint8Array(1)
  },
})

const CN = '巡检报告-2026 11.md'
const cnMount = () => mount(okFs({ displayPath: `/home/harness/deliverables/${CN}` }))

test('注册在 /api/dl，方法 GET/HEAD', () => {
  const m = cnMount()
  assert.equal(m.route.path, '/api/dl')
  assert.deepEqual([...m.route.methods], ['GET', 'HEAD'])
})

test('中文名走 filename*，ASCII 走 filename 兜底', async () => {
  const r = await cnMount().call(`https://h/api/dl?path=${encodeURIComponent('/home/harness/deliverables/' + CN)}`)
  assert.equal(r.status, 200)
  const cd = r.headers.get('content-disposition')
  assert.match(cd, /^attachment; filename="_+-2026 11\.md"; filename\*=UTF-8''/)
  assert.equal(cd.split("filename*=UTF-8''")[1], encodeURIComponent(CN))
})

test('Content-Type 按扩展名，未知走 octet-stream', async () => {
  assert.equal((await cnMount().call('https://h/api/dl?path=%2Fa%2Fb.md')).headers.get('content-type'), 'text/markdown')
  const m = mount(okFs({ displayPath: '/a/b.unknownext' }))
  assert.equal((await m.call('https://h/api/dl?path=%2Fa%2Fb.unknownext')).headers.get('content-type'), 'application/octet-stream')
})

test('安全头：不缓存 + nosniff + CSP 沙箱', async () => {
  const r = await cnMount().call('https://h/api/dl?path=%2Fa%2Fb.md')
  assert.match(r.headers.get('cache-control'), /no-store/)
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
  assert.match(r.headers.get('content-security-policy'), /sandbox/)
})

test('正文与 Content-Length 一致', async () => {
  const r = await cnMount().call('https://h/api/dl?path=%2Fa%2Fb.md')
  assert.equal(r.headers.get('content-length'), '8')
  assert.equal(await r.text(), 'abcdefgh')
})

test('?name= 覆盖下载名并收敛成单段安全名', async () => {
  const m = mount(okFs({ displayPath: '/a/y.pdf' }))
  const r = await m.call('https://h/api/dl?path=%2Fa%2Fy.pdf&name=' + encodeURIComponent('../../evil name.txt'))
  assert.match(r.headers.get('content-disposition'), /^attachment; filename="evil name\.txt"/)
})

test('?inline=1 预览但仍带真名', async () => {
  const m = mount(okFs({ displayPath: '/a/y.pdf' }))
  const r = await m.call('https://h/api/dl?path=%2Fa%2Fy.pdf&inline=1')
  assert.match(r.headers.get('content-disposition'), /^inline; filename="y\.pdf"/)
})

test('mode: inline 与 ?download=1 覆盖', async () => {
  const m = mount(okFs({ displayPath: '/a/y.pdf' }), { mode: 'inline' })
  assert.match((await m.call('https://h/api/dl?path=%2Fa%2Fy.pdf')).headers.get('content-disposition'), /^inline; /)
  assert.match((await m.call('https://h/api/dl?path=%2Fa%2Fy.pdf&download=1')).headers.get('content-disposition'), /^attachment; /)
})

test('HEAD 给长度不给正文', async () => {
  const r = await cnMount().call('https://h/api/dl?path=%2Fa%2Fb.md', 'HEAD')
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-length'), '8')
  assert.equal(await r.text(), '')
})

test('入参校验：缺 path / 相对路径 / NUL 都 400', async () => {
  const m = cnMount()
  assert.equal((await m.call('https://h/api/dl')).status, 400)
  assert.equal((await m.call('https://h/api/dl?path=rel%2Fx.pdf')).status, 400)
  assert.equal((await m.call('https://h/api/dl?path=%2Fx%2Fa%00b')).status, 400)
})

test('状态码：无文件 404、目录 403、超限 413', async () => {
  assert.equal((await mount(statFs(undefined)).call('https://h/api/dl?path=%2Fx.pdf')).status, 404)
  assert.equal((await mount(statFs({ type: 'directory', size: 0 })).call('https://h/api/dl?path=%2Fx.pdf')).status, 403)
  assert.equal((await mount(statFs({ type: 'file', size: 999 }), { maxBytes: 10 }).call('https://h/api/dl?path=%2Fx.bin')).status, 413)
})

test('FsError 的 code 映射状态，别的错误 500 带原因', async () => {
  const r1 = await mount(throwingFs(Object.assign(new Error('x'), { code: 'FS_SANDBOX_DENIED' }))).call('https://h/api/dl?path=%2Fx.bin')
  assert.equal(r1.status, 403)
  assert.equal(await r1.text(), 'FS_SANDBOX_DENIED')
  const r2 = await mount(throwingFs(new TypeError('readBytes is not a function'))).call('https://h/api/dl?path=%2Fx.bin')
  assert.equal(r2.status, 500)
  assert.match(await r2.text(), /readBytes/)
})

test('配置容错：非法 route 回落默认，合法 route 生效，非法 maxBytes 回落', async () => {
  assert.equal(mount(okFs(), { route: '../etc' }).route.path, '/api/dl')
  assert.equal(mount(okFs(), { route: '/api/dl2' }).route.path, '/api/dl2')
  assert.equal((await mount(okFs(), { maxBytes: -5 }).call('https://h/api/dl?path=%2Fx.pdf')).status, 200)
})
