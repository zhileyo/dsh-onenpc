/**
 * dsh-onenpc · 独立开发服务器（不经过 DeepSeekRuntime）
 *
 *   node scripts/dev-server.mjs [--port 7412] [--shared]
 *
 * 它把插件**宿主半侧的路由原封不动**挂到本机 http://127.0.0.1:PORT 上，并直接提供
 * public/ui.html。用途：
 *   - 宿主插件代码改了以后不必重启 GUI 就能自测（DeepSeekRuntime 只在启动时加载宿主半侧）；
 *   - CI / 无 GUI 环境里做端到端验证；
 *   - 用户只想看界面、不想开 Runtime 时的一键预览。
 *
 * 数据目录**默认用临时目录**：dev-server 与宿主两个进程若同写一份
 * `$DSH_HOME/onenpc/state.json`，会互相覆盖（dsh-edict-demo 真机踩过的坑）。
 * 确实要读真实数据时显式加 `--shared`，并且**先停掉 GUI 里的同款插件**。
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { __internals } from '../lib/index.js'

const args = process.argv.slice(2)
const portArg = args.indexOf('--port')
const PORT = portArg >= 0 ? Number.parseInt(args[portArg + 1], 10) : 7412
const useTemp = !args.includes('--shared')

const LOG = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m, e) => console.error(m, e ?? ''),
}

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const dataDir = useTemp
  ? join(tmpdir(), `dsh-onenpc-dev-${process.pid}`)
  : join(home, 'onenpc')

const store = new __internals.NpcStore(dataDir)
await store.load(LOG)

const route = __internals.createRouter(store, LOG, {
  home,
  agentsReady: () => false,
})

const UI_FILE = new URL('../public/ui.html', import.meta.url)
/** 与宿主一致的路由前缀：真实 GUI 里页面就在 ${PREFIX}/ui 下 */
const PREFIX = __internals.ROUTE_PREFIX

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  // 真实宿主里页面挂在 ${PREFIX}/ui 下、接口在 ${PREFIX}/...。
  // 这里也照样提供一份，才能测出「页面在子路径、请求打到站点根」这类只有真机才犯的病。
  const servedUnderPrefix = url.pathname.startsWith(PREFIX + '/') || url.pathname === PREFIX
  const pathname = servedUnderPrefix ? url.pathname.slice(PREFIX.length) || '/' : url.pathname

  // 界面本体
  if (pathname === '/' || pathname === '/index.html' || pathname === '/ui') {
    try {
      const raw = await readFile(UI_FILE, 'utf8')
      const page = servedUnderPrefix ? raw.replace('<html', `<html data-npc-base="${PREFIX}"`) : raw
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(page)
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`读不到 public/ui.html：${error instanceof Error ? error.message : String(error)}`)
    }
    return
  }

  // 插件路由（与宿主内完全一致的那一份）
  let body
  if (req.method === 'POST' || req.method === 'PUT') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (chunks.length) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'invalid_json' }))
        return
      }
    }
  }

  try {
    const result = await route(pathname + (url.search || ''), req.method ?? 'GET', body)
    if (result.html !== undefined) {
      res.writeHead(result.status ?? 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(String(result.html))
      return
    }
    const payload = JSON.stringify(result.json ?? {})
    res.writeHead(result.status ?? 200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
    })
    res.end(payload)
  } catch (error) {
    const payload = JSON.stringify({
      error: error?.code ?? 'internal_error',
      message: error instanceof Error ? error.message : String(error),
    })
    res.writeHead(Number.isInteger(error?.status) ? error.status : 500, {
      'content-type': 'application/json; charset=utf-8',
    })
    res.end(payload)
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n三省六部 · 独立开发服务器`)
  console.log(`  界面   http://127.0.0.1:${PORT}`)
  console.log(`  路由   ${__internals.ROUTE_PREFIX}/state 等（与插件同一份实现）`)
  console.log(`  数据   ${dataDir}${useTemp ? '（临时目录，退出不留痕）' : '（真实数据：若 GUI 里也装着本插件，两边会互相覆盖，建议先停宿主）'}`)
  console.log('  Ctrl+C 停止\n')
})
