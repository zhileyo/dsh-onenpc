/**
 * dsh-onenpc · 宿主半侧（Cordis 插件）
 *
 * M2 真对话：
 *   1. NpcStore      —— 任务/公文/审计/执行记录持久化到 $DSH_HOME/onenpc/state.json
 *   2. HTTP 路由     —— /state（长轮询）、/tasks、/dispatch、/stop、/executions、/artifacts、/config、/ui
 *   3. 领域内核      —— lib/domain.js（12 角色、判级三层、节点状态机、公文、审计）
 *   4. 执行层        —— lib/execution.js（事件映射、简报、git 基线/diff、askLLM）
 *   5. dispatcher    —— 交办真子会话（ctx.agents.create + steer）+ 事件回写 + diff 产物落盘
 *   6. /npc 命令     —— ctx.commands：`/npc [角色] 需求` → 建单（origin=command）→ 派发
 *   7. @解析         —— session/event 的 user/message 里 `@角色名` → 建单（origin=mention）→ 派发
 *
 * 架构与 dsh-edict-demo 同构（真机验证过的接线方式）：路由逻辑与 Cordis 解耦，
 * 宿主 ctx.webServer.register 与 scripts/dev-server.mjs 各自接同一份实现；
 * 判级三层之②（M 档兜底）在 domain.createTask 落地，之①（LLM 主判）在 dispatcher 派发前落地。
 * M3 待接入：刑部/门下评审轮、预算闸门、流水线、成功指标面板。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  ROLES, ROLE_NAMES, ORGS, TIERS, TIER_META, NODE_KINDS, NODE_KIND_META,
  NODE_STATES, NODE_STATE_META, NODE_ACTIONS, DOC_TYPES, ORIGINS, ORIGIN_META,
  TRIAGE_FALLBACK, REJECT_CAP, TASK_BUDGET, MANUAL_ACTIONS,
  appendAudit, createTask, advanceNode, triageTask, addDoc, findTask, taskProgress,
  nextDispatchableNode, seedState,
  pipelineOf, resumePipeline, noteBudget, stopPipeline,
} from './domain.js'
import {
  EXEC_SESSION_PREFIX, FAILED_REASON_KINDS,
  observeEvent, noteUsage, createExecutionRecord, findExecutionBySession,
  setAssistantMessage, appendExecutionText, noteToolCall, noteTrace, finishExecution,
  execView, executionBrief, askLLM, gitBaseline, captureDiff, listUntracked, userTextOf,
} from './execution.js'
import { metricsOf } from './metrics.js'
import { runPipelineStep, nextStep as pipelineNextStep, judgeTriage } from './pipeline.js'

export const name = 'npc'
export const inject = ['webServer', 'commands']

/** 路由前缀：带端口尾号，避免与其它插件的命名空间撞车 */
export const ROUTE_PREFIX = '/dsh-onenpc-7312'
/** 长轮询的默认/最长挂起时间（毫秒） */
const LONGPOLL_DEFAULT_MS = 25_000
const LONGPOLL_MAX_MS = 30_000

/**
 * 数据根目录：优先用宿主提供的 `@deepseek-ai/dsh-home-paths`，
 * 拿不到时退回 $DSH_HOME / ~/.dsh（这样脱离宿主也能跑 smoke 自测）。
 */
let resolveDshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')
try {
  const mod = await import('@deepseek-ai/dsh-home-paths')
  if (typeof mod?.resolveDshHome === 'function') resolveDshHome = mod.resolveDshHome
} catch {
  /* 非宿主环境（如自测）：用上面的兜底 */
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj)
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...headers,
  })
  res.end(body)
}

async function readJson(req, limitBytes = 1_000_000) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limitBytes) throw Object.assign(new Error('payload too large'), { status: 413 })
    chunks.push(chunk)
  }
  if (!chunks.length) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { status: 400 })
  }
}

async function renameWithRetry(from, to, attempts = 5) {
  let last
  for (let i = 0; i < attempts; i += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      last = error
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error
      await new Promise((r) => setTimeout(r, 15 * (i + 1)))
    }
  }
  throw last
}

/* ------------------------------------------------------------------ */
/* NpcStore：JSON 单文件持久化 + 版本号 + 变更通知                      */
/* ------------------------------------------------------------------ */

class NpcStore {
  constructor(dir) {
    this.dir = dir
    this.file = join(dir, 'state.json')
    this.state = null
    this.version = 0
    this.waiters = new Set()
    this.saving = null
    this.dirty = false
    this.tmpSeq = 0
  }

  async load(logger) {
    await mkdir(this.dir, { recursive: true })
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (!parsed || !Array.isArray(parsed.tasks)) throw new Error('state.json 结构不合法')
      this.state = parsed
      logger?.info?.(`[dsh-onenpc] 已加载 ${this.file}（${parsed.tasks.length} 单任务）`)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger?.warn?.(`[dsh-onenpc] state.json 读取失败，改用种子数据：${error?.message ?? error}`)
      }
      this.state = seedState()
      await this.persist()
    }
    if (!this.state.meta || typeof this.state.meta !== 'object') this.state.meta = {}
    this.version = Number(this.state.version) || 1
  }

  /** 原子写：先写 .tmp 再 rename，避免半截文件（Windows 下 EPERM 用递增序号避让） */
  async persist() {
    if (this.saving) {
      this.dirty = true
      return this.saving
    }
    this.saving = (async () => {
      do {
        this.dirty = false
        const payload = JSON.stringify(this.state, null, 2)
        const tmp = `${this.file}.${process.pid}.${this.tmpSeq++}.tmp`
        await mkdir(dirname(this.file), { recursive: true })
        await writeFile(tmp, payload, 'utf8')
        await renameWithRetry(tmp, this.file)
      } while (this.dirty)
    })()
    try {
      await this.saving
    } finally {
      this.saving = null
    }
  }

  /** 标记一次变更：版本号 +1，唤醒所有长轮询 */
  touch(reason = 'update') {
    this.version += 1
    this.state.version = this.version
    this.state.updatedAt = new Date().toISOString()
    this.state.lastChange = { reason, at: this.state.updatedAt }
    for (const waiter of this.waiters) waiter(this.version)
    this.waiters.clear()
    void this.persist()
  }

  /** 等到版本号超过 seen，或超时 */
  waitForChange(seen, timeoutMs) {
    if (this.version > seen) return Promise.resolve(this.version)
    return new Promise((resolve) => {
      const done = (v) => {
        clearTimeout(timer)
        this.waiters.delete(done)
        resolve(v)
      }
      const timer = setTimeout(() => done(this.version), timeoutMs)
      this.waiters.add(done)
    })
  }

  /** 等到挂起的落盘全部完成（测试/退出前用；touch 的 persist 是 fire-and-forget） */
  async flush() {
    while (this.saving) {
      try {
        await this.saving
      } catch {
        break
      }
    }
  }

  reseed() {
    this.state = seedState()
    this.touch('reseed')
  }
}

/* ------------------------------------------------------------------ */
/* 视图投影                                                            */
/* ------------------------------------------------------------------ */

/** 看板用的轻量任务视图（不含 docs 正文，避免快照过大） */
function taskView(task) {
  return {
    id: task.id,
    title: task.title,
    origin: task.origin,
    role: task.role ?? '中书令',
    triage: task.triage,
    triageBy: task.triageBy,
    triageReason: task.triageReason,
    team: task.team ?? [],
    nodes: (task.nodes ?? []).map((n) => ({ id: n.id, kind: n.kind, role: n.role, state: n.state, round: n.round ?? 1 })),
    progress: taskProgress(task),
    counters: task.counters ?? { 封驳: 0, 自愈: 0 },
    docCount: (task.nodes ?? []).reduce((acc, n) => acc + (n.docs?.length ?? 0), 0),
    pipeline: { auto: Boolean(task.pipeline?.auto), stopped: task.pipeline?.stopped ?? null },
    rounds: (task.rounds ?? []).map((r) => ({ n: r.n, goal: r.goal ?? '', verdict: r.verdict ?? 'pending' })),
    acceptance: {
      total: (task.acceptance ?? []).length,
      pass: (task.acceptance ?? []).filter((a) => a.state === 'pass').length,
      fail: (task.acceptance ?? []).filter((a) => a.state === 'fail').length,
    },
    delivered: Boolean(task.delivery),
    createdAt: task.createdAt ?? null,
    updatedAt: task.updatedAt ?? null,
    archived: Boolean(task.archived),
  }
}

/** 详情视图：完整任务（节点带 docs/artifacts/gitBaseline/sessionId + 流水线/预算/轮次/验收/交付） */
function taskDetail(task) {
  return {
    ...taskView(task),
    requirement: task.requirement ?? '',
    budget: task.budget ?? { calls: 0, tokens: 0, steps: 0 },
    acceptance: task.acceptance ?? [],
    rounds: task.rounds ?? [],
    delivery: task.delivery ?? null,
    nodes: (task.nodes ?? []).map((n) => ({
      id: n.id,
      kind: n.kind,
      role: n.role,
      state: n.state,
      round: n.round ?? 1,
      docs: n.docs ?? [],
      artifacts: n.artifacts ?? [],
      tokens: n.tokens ?? 0,
      calls: n.calls ?? 0,
      startedAt: n.startedAt ?? null,
      endedAt: n.endedAt ?? null,
      stopReason: n.stopReason ?? null,
      gitBaseline: n.gitBaseline ?? null,
      sessionId: n.sessionId ?? null,
    })),
  }
}

export function buildState(store, host = null) {
  const now = Date.now()
  const tasks = store.state.tasks
  return {
    v: store.version,
    source: 'dsh-onenpc',
    stage: 'm2-execution',
    generatedAt: new Date(now).toISOString(),
    metrics: {
      taskCount: tasks.length,
      active: tasks.filter((t) => !t.archived).length,
      archived: tasks.filter((t) => t.archived).length,
      running: tasks.filter((t) => !t.archived && (t.nodes ?? []).some((n) => n.state === 'running')).length,
      executing: (store.state.executions?.items ?? []).filter((e) => e.status === 'running').length,
    },
    tasks: tasks.filter((t) => !t.archived).map((t) => taskView(t)),
    agentsReady: Boolean(host?.agentsReady?.()),
    config: {
      defaultCwd: store.state.meta?.defaultCwd ?? null,
      autoCommit: store.state.meta?.autoCommit !== false,
      executionMode: 'manual',
    },
    executions: (store.state.executions?.items ?? []).slice(-30).map((e) => execView(e)),
    hints: (store.state.hints ?? []).slice(-10),
    success: metricsOf(store.state),
    catalog: {
      roles: ROLES,
      orgs: ORGS,
      tiers: TIERS,
      tierMeta: TIER_META,
      nodeKinds: NODE_KINDS,
      nodeKindMeta: NODE_KIND_META,
      nodeStates: NODE_STATES,
      nodeStateMeta: NODE_STATE_META,
      nodeActions: NODE_ACTIONS,
      docTypes: DOC_TYPES,
      origins: ORIGINS,
      originMeta: ORIGIN_META,
      fallbackTier: TRIAGE_FALLBACK,
      rejectCap: REJECT_CAP,
      budget: TASK_BUDGET,
    },
    health: {
      ok: true,
      storePath: store.file,
      taskCount: tasks.length,
      version: store.version,
      changedAt: store.state.lastChange?.at ?? store.state.updatedAt ?? null,
    },
  }
}

/* ------------------------------------------------------------------ */
/* dispatcher：交办真子会话 + 事件回写 + diff 产物                      */
/* ------------------------------------------------------------------ */

function createDispatcher(store, host, logger) {
  /** 执行中的 AgentHandle：只在内存里（重启即失效），执行记录本身随 state.json 落盘 */
  const live = new Map()
  /** @解析去重（sessionId:seq|内容），LRU 200 */
  const seenMentions = new Set()

  const runningExecOfNode = (nodeId) =>
    (store.state.executions?.items ?? []).find((e) => e.nodeId === nodeId && e.status === 'running') ?? null

  /** 判级三层之①：交办前兜底主判（流水线第一步已判过则跳过——判过 triageBy 变 'llm'） */
  const triageWithLLM = (task) => judgeTriage(host, task)

  /**
   * 交办：判级（LLM 主判）→ 选节点 → git 基线 → 起子会话 → 喂简报。
   * 失败一律抛错由路由翻译（502/503）——不静默吞掉，否则界面会以为在办。
   */
  async function dispatch(taskId, { nodeId, actor = 'system' } = {}) {
    const task = findTask(store.state, taskId)
    if (!task) throw Object.assign(new Error(`任务 ${taskId} 不存在`), { code: 'task_not_found', status: 404 })
    if (task.archived) throw Object.assign(new Error('任务已归档'), { code: 'archived', status: 409 })
    const registry = host?.agents?.()
    if (!registry || typeof registry.create !== 'function') {
      throw Object.assign(new Error('宿主未提供 AgentRegistry（ctx.agents），无法真正 spawn 子会话'), { code: 'execution_unavailable', status: 503 })
    }

    // ① 判级三层之①：LLM 主判（fallback 档才判；失败留 fallback 不反问）
    try {
      const triaged = await triageWithLLM(task)
      if (triaged) triageTask(store.state, task, triaged.tier, 'llm', triaged.reason)
    } catch (error) {
      logger?.warn?.('[dsh-onenpc] LLM 判级失败，沿用当前档', error)
    }

    // ② 选节点：显式指定 或 串行守卫下的首个可派发节点
    const node = nodeId ? (task.nodes ?? []).find((n) => n.id === nodeId) : nextDispatchableNode(task)
    if (!node) throw Object.assign(new Error('没有可派发的节点（流程串行或已全部完成）'), { code: 'no_dispatchable_node', status: 409 })
    if (node.state === 'running') {
      const running = runningExecOfNode(node.id)
      if (running) {
        throw Object.assign(new Error(`节点已在办差中（${running.id}）`), { code: 'already_running', status: 409 })
      }
      // running 但执行记录已不在（宿主重启断链）→ 允许重派，补一条留痕
      appendAudit(store.state, { action: 'dispatch', taskId: task.id, nodeId: node.id, actor: 'system', remark: '断链重派（原执行会话已失联）' })
    } else if (node.state !== 'pending') {
      throw Object.assign(new Error(`节点「${node.kind}」当前状态不可派发`), { code: 'bad_node_state', status: 409 })
    }

    // ③ git 基线（派发前记录——diff 产物的地基）
    const cwd = store.state.meta?.defaultCwd || host.home
    const baseline = await gitBaseline(cwd)
    node.gitBaseline = baseline
      ? { ...baseline, cwd }
      : { cwd, note: '非 git 工作区或 git 不可用', recordedAt: new Date().toISOString() }

    // ④ 状态推进 + 执行记录
    if (node.state === 'pending') {
      advanceNode(store.state, task, node.id, 'start', { actor, remark: '交办真子会话' })
    }
    const picked = typeof host?.modelFor === 'function' ? await host.modelFor(node.role) : null
    const agentOptions = {}
    if (picked?.provider) agentOptions.provider = picked.provider
    if (picked?.model) agentOptions.model = picked.model
    const sessionId = `${EXEC_SESSION_PREFIX}${task.id}-${node.id}-${Date.now().toString(36)}`
    const exec = createExecutionRecord(store.state, {
      taskId: task.id, nodeId: node.id, role: node.role, sessionId,
      provider: picked?.provider ?? null, model: picked?.model ?? null,
    })
    node.sessionId = exec.sessionId
    node.tokens = 0
    node.calls = 0
    store.touch('dispatch')

    // ⑤ spawn + steer（失败如实报错，绝不假装在办）
    let handle
    try {
      handle = await registry.create({
        sessionId: exec.sessionId,
        meta: { cwd, origin: 'subagent', delegationDepth: 1 },
        ...(Object.keys(agentOptions).length ? { agentOptions } : {}),
      })
    } catch (error) {
      finishExecution(exec, { status: 'failed', error: `spawn 失败：${error?.message ?? error}` })
      node.stopReason = 'spawn 失败'
      appendAudit(store.state, { action: 'dispatch', taskId: task.id, nodeId: node.id, actor: 'system', result: 'denied', remark: `spawn 失败：${error?.message ?? error}` })
      store.touch('dispatch-failed')
      throw Object.assign(new Error(`spawn 失败：${error?.message ?? error}`), { code: 'spawn_failed', status: 502 })
    }
    live.set(exec.id, handle)
    try {
      const message = await host.userMessage(executionBrief(node.role, task, node))
      const agent = handle?.agent
      if (typeof agent?.steer === 'function') agent.steer(message)
      else if (typeof agent?.followup === 'function') agent.followup(message)
      else throw new Error('AgentHandle 上没有 steer/followup，无法启动这一轮')
    } catch (error) {
      await stopExecution(exec.id).catch(() => {})
      finishExecution(exec, { status: 'failed', error: `简报投递失败：${error?.message ?? error}` })
      node.stopReason = '简报投递失败'
      store.touch('dispatch-failed')
      throw Object.assign(new Error(`简报投递失败：${error?.message ?? error}`), { code: 'spawn_unsupported', status: 502 })
    }

    appendAudit(store.state, {
      action: 'dispatch',
      taskId: task.id,
      title: task.title,
      nodeId: node.id,
      to: 'running',
      actor,
      remark: `${exec.id} · ${node.role}${picked?.model ? ` · ${picked.model}` : ''}${baseline ? ` · 基线 ${baseline.head.slice(0, 10)}` : ''}`,
    })
    logger?.info?.(`[dsh-onenpc] 已交办 ${task.id}/${node.id} → ${exec.id}（${node.role}）`)
    return exec
  }

  /** 一轮结束时把结果写回：diff 产物 + 执行汇报 + 回奏 + 节点收口 + 审计 */
  async function finishWriteback(exec, seen) {
    const kind = typeof seen?.reason === 'object' && seen.reason ? String(seen.reason.kind ?? '') : ''
    const failed = FAILED_REASON_KINDS.has(kind)
    const task = findTask(store.state, exec.taskId)
    const node = task?.nodes?.find((n) => n.id === exec.nodeId)
    finishExecution(exec, {
      status: failed ? 'failed' : 'done',
      error: failed ? (seen?.reason?.failure?.message ?? kind) : null,
    })

    if (task && node) {
      // ① diff 截取（有基线才有意义；工作区非净已在基线里如实标注）
      const cwd = node.gitBaseline?.cwd
      if (cwd && node.gitBaseline?.head) {
        const cap = await captureDiff(cwd, node.gitBaseline)
        if (cap && !cap.error) {
          const dir = join(store.dir, 'artifacts', task.id, node.id)
          await mkdir(dir, { recursive: true })
          const file = `${node.id}.diff`
          await writeFile(join(dir, file), cap.diffText, 'utf8')
          node.artifacts.push({
            kind: 'diff',
            ref: `${task.id}/${node.id}/${file}`,
            summary: `${cap.files.length} 文件${cap.truncated ? '（已截断）' : ''}`,
            files: cap.files.slice(0, 30),
            at: cap.capturedAt,
          })
          const untracked = await listUntracked(cwd)
          for (const p of untracked.slice(0, 20)) {
            node.artifacts.push({ kind: 'file', path: p, summary: '未跟踪新文件', at: cap.capturedAt })
          }
        } else if (cap?.error) {
          node.artifacts.push({ kind: 'note', summary: `diff 截取失败：${cap.error}`, at: cap.capturedAt })
        }
      }
      // ② 执行汇报 → 报告产物 + 回奏公文（actor=承接角色，不算人工干预）
      const report = String(exec.lastText ?? '').trim()
      if (report) {
        const dir = join(store.dir, 'artifacts', task.id, node.id)
        await mkdir(dir, { recursive: true })
        const file = `${node.id}.report.md`
        await writeFile(join(dir, file), report, 'utf8')
        node.artifacts.push({ kind: 'report', ref: `${task.id}/${node.id}/${file}`, summary: `${report.length} 字执行汇报`, at: new Date().toISOString() })
        try {
          addDoc(store.state, task, node.id, { type: '回奏', from: node.role, to: '中书令', text: report, actor: node.role })
        } catch {
          /* 公文校验不过就只留产物，不硬塞 */
        }
      }
      // ③ 节点收口：成功 → done；失败 → 留 running 待人（如实呈现）
      if (!failed) {
        try {
          advanceNode(store.state, task, node.id, 'done', { actor: node.role, remark: `${exec.id} 交办完成` })
        } catch {
          /* 状态机不允许时不动它 */
        }
      } else {
        node.stopReason = `执行失败（${kind || 'unknown'}）`
      }
      node.tokens = exec.tokens?.total ?? 0
      node.calls = exec.calls ?? 0
      // 预算记账（任务级，M3 闸门用）：执行用量计入
      noteBudget(task, { calls: exec.calls ?? 0, tokens: exec.tokens?.total ?? 0 })
    }

    appendAudit(store.state, {
      action: 'execute-done',
      taskId: exec.taskId,
      nodeId: exec.nodeId,
      actor: exec.role,
      to: exec.status,
      result: exec.status === 'done' ? 'ok' : 'denied',
      remark: `${exec.id} · ${exec.chars} 字 · tokens ${exec.tokens?.total ?? 0}`,
    })
    const handle = live.get(exec.id)
    if (handle) {
      live.delete(exec.id)
      try {
        await handle.dispose?.()
      } catch {
        /* 释放失败不影响回写结果 */
      }
    }
    store.touch('execute-done')
  }

  /** 子会话事件回写（ctx.on('session/event') 转发进来；只认 running 的执行记录） */
  function handleEvent(sessionId, event) {
    const exec = findExecutionBySession(store.state, sessionId)
    if (!exec || exec.status !== 'running') return false
    const seen = observeEvent(event)
    let dirty = noteTrace(exec, seen)
    if (seen.usage) dirty = noteUsage(exec, seen.usage) || dirty
    if (seen.kind === 'message') dirty = setAssistantMessage(exec, seen.text) || dirty
    else if (seen.kind === 'text') dirty = appendExecutionText(exec, seen.text) || dirty
    else if (seen.kind === 'tool') dirty = noteToolCall(exec, seen.name) || dirty
    else if (seen.kind === 'turn-end') {
      dirty = true
      void finishWriteback(exec, seen).catch((error) => logger?.warn?.('[dsh-onenpc] 执行回写失败', error))
    }
    if (dirty) store.touch('execution-event')
    return true
  }

  /** @解析：主会话 user/message 里的 `@角色名` → 建单（origin=mention）→ 派发 */
  function handleMention(sessionId, event) {
    try {
      if (typeof sessionId !== 'string' || sessionId.startsWith(EXEC_SESSION_PREFIX)) return
      if (!/^user\//.test(String(event?.type ?? ''))) return
      const content = userTextOf(event)
      if (!content) return
      const m = content.match(new RegExp(`@(${ROLE_NAMES.join('|')})`))
      if (!m) return
      const role = m[1]
      const seq = event?.seq ?? event?.data?.seq ?? content
      const key = `${sessionId}:${String(seq).slice(0, 160)}`
      if (seenMentions.has(key)) return
      seenMentions.add(key)
      if (seenMentions.size > 200) {
        let n = 0
        for (const k of seenMentions) {
          seenMentions.delete(k)
          if (++n >= 100) break
        }
      }
      const title = content.replace(m[0], '').trim().slice(0, 60) || `${role} 收到一段 @ 指派`
      const task = createTask(store.state, { title, requirement: content, origin: 'mention', role })
      if (!Array.isArray(store.state.hints)) store.state.hints = []
      store.state.hints.push({ at: new Date().toISOString(), sessionId, taskId: task.id, role, title: task.title })
      if (store.state.hints.length > 50) store.state.hints.splice(0, store.state.hints.length - 50)
      store.touch('mention-create')
      logger?.info?.(`[dsh-onenpc] @${role} 命中 → ${task.id}，开始交办`)
      void dispatch(task.id, { actor: 'system' }).catch((error) => logger?.warn?.('[dsh-onenpc] @交办失败', error))
    } catch {
      /* 解析失败静默——不能拖垮宿主事件总线 */
    }
  }

  async function stopExecution(execId) {
    const exec = (store.state.executions?.items ?? []).find((e) => e.id === execId)
    if (!exec) throw Object.assign(new Error(`执行 ${execId} 不存在`), { code: 'execution_not_found', status: 404 })
    if (exec.status !== 'running') return exec
    const handle = live.get(execId)
    try {
      handle?.agent?.cancel?.({})
    } catch {
      /* 取消失败不影响后面的释放 */
    }
    try {
      await handle?.dispose?.()
    } catch {
      /* dispose 失败也要把句柄摘掉，避免泄漏 */
    }
    live.delete(execId)
    finishExecution(exec, { status: 'stopped' })
    const task = findTask(store.state, exec.taskId)
    const node = task?.nodes?.find((n) => n.id === exec.nodeId)
    if (node) node.stopReason = `${execId} 被叫停，待人处理`
    appendAudit(store.state, { action: 'stop', taskId: exec.taskId, nodeId: exec.nodeId, actor: 'user', remark: `${execId} 叫停` })
    store.touch('execute-stop')
    return exec
  }

  async function stopByNode(taskId, nodeId) {
    const exec = (store.state.executions?.items ?? []).find(
      (e) => e.taskId === taskId && e.nodeId === nodeId && e.status === 'running',
    )
    if (!exec) {
      throw Object.assign(new Error('该节点没有在办的执行'), { code: 'no_running_execution', status: 404 })
    }
    return stopExecution(exec.id)
  }

  return { dispatch, handleEvent, handleMention, stopExecution, stopByNode, live }
}

/* ------------------------------------------------------------------ */
/* 路由（与 Cordis 解耦：dev-server 与宿主共用这一份）                  */
/* ------------------------------------------------------------------ */

export function createRouter(store, logger, host = {}) {
  /** 被拒动作也留痕（制度：谁想绕过门下、为什么收不了口，事后查得到） */
  const deny = (entry) => {
    try {
      appendAudit(store.state, { result: 'denied', actor: 'user', ...entry })
      store.touch('audit-denied')
    } catch {
      /* 留痕失败不吞掉原错误 */
    }
  }

  return async function route(url, method = 'GET', body = undefined) {
    const u = new URL(url, 'http://localhost')
    let pathname = u.pathname
    if (pathname.startsWith(ROUTE_PREFIX)) pathname = pathname.slice(ROUTE_PREFIX.length) || '/'
    const seg = pathname.split('/').filter(Boolean).map((s) => {
      try { return decodeURIComponent(s) } catch { return s }
    })
    const [head] = seg

    /* ---------------- 只读 ---------------- */

    if (method === 'GET' && head === 'health') {
      return { json: { ok: true, version: store.version, taskCount: store.state.tasks.length, storePath: store.file } }
    }

    if (method === 'GET' && head === 'meta') {
      return {
        json: {
          name: 'dsh-onenpc',
          title: '三省六部 · 任务看板',
          prefix: ROUTE_PREFIX,
          stage: 'm2-execution',
          agentsReady: Boolean(host?.agentsReady?.()),
          endpoints: [
            'GET /health', 'GET /state', 'GET /roles', 'GET /tasks', 'GET /tasks/:id', 'GET /audit',
            'GET /executions', 'GET /executions/:id', 'GET /hints', 'GET /artifacts/:task/:node/:file',
            'POST /tasks', 'POST /tasks/:id/triage', 'POST /tasks/:id/action', 'POST /tasks/:id/dispatch',
            'POST /tasks/:id/nodes/:nodeId/stop', 'POST /tasks/:id/nodes/:nodeId/doc',
            'POST /config', 'POST /dev/reseed', 'GET /ui',
          ],
          comingNext: ['M3：刑部/门下评审轮 + 预算闸门 + 流水线 + 成功指标面板'],
        },
      }
    }

    if (method === 'GET' && head === 'state') {
      const seen = Number.parseInt(u.searchParams.get('since') ?? '', 10)
      const timeoutRaw = Number.parseInt(u.searchParams.get('timeout') ?? '', 10)
      const timeout = Number.isFinite(timeoutRaw)
        ? Math.min(Math.max(timeoutRaw, 0), LONGPOLL_MAX_MS)
        : LONGPOLL_DEFAULT_MS
      if (Number.isFinite(seen) && seen >= 0 && timeout > 0) {
        await store.waitForChange(seen, timeout)
      }
      return { json: buildState(store, host) }
    }

    if (method === 'GET' && head === 'roles') {
      return { json: { v: store.version, roles: ROLES, orgs: ORGS } }
    }

    if (method === 'GET' && head === 'tasks' && seg.length === 1) {
      const archived = u.searchParams.get('archived')
      const list = store.state.tasks.filter((t) => (archived === '1' ? t.archived : archived === 'all' ? true : !t.archived))
      return { json: { v: store.version, tasks: list.map((t) => taskView(t)) } }
    }

    if (method === 'GET' && head === 'tasks' && seg.length === 2) {
      const task = findTask(store.state, seg[1])
      if (!task) throw Object.assign(new Error(`任务 ${seg[1]} 不存在`), { code: 'task_not_found', status: 404 })
      return { json: { v: store.version, task: taskDetail(task) } }
    }

    if (method === 'GET' && head === 'audit') {
      const task = u.searchParams.get('task')
      const action = u.searchParams.get('action')
      const result = u.searchParams.get('result')
      const limitRaw = Number.parseInt(u.searchParams.get('limit') ?? '', 10)
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100
      let list = [...(store.state.audit ?? [])].reverse()
      if (task) list = list.filter((a) => a.taskId === task)
      if (action) list = list.filter((a) => a.action === action)
      if (result) list = list.filter((a) => a.result === result)
      return { json: { v: store.version, audit: list.slice(0, limit) } }
    }

    if (method === 'GET' && head === 'executions' && seg.length === 1) {
      const taskId = u.searchParams.get('task')
      const status = u.searchParams.get('status')
      let list = [...(store.state.executions?.items ?? [])].reverse()
      if (taskId) list = list.filter((e) => e.taskId === taskId)
      if (status) list = list.filter((e) => e.status === status)
      return { json: { v: store.version, agentsReady: Boolean(host?.agentsReady?.()), executions: list.slice(0, 50).map((e) => execView(e)) } }
    }

    if (method === 'GET' && head === 'executions' && seg.length === 2) {
      const exec = (store.state.executions?.items ?? []).find((e) => e.id === seg[1])
      if (!exec) throw Object.assign(new Error(`执行 ${seg[1]} 不存在`), { code: 'execution_not_found', status: 404 })
      return { json: { v: store.version, execution: { ...exec } } }
    }

    if (method === 'GET' && head === 'hints') {
      const limit = Math.min(Math.max(Number.parseInt(u.searchParams.get('limit') ?? '5', 10) || 5, 1), 20)
      return { json: { v: store.version, hints: (store.state.hints ?? []).slice(-limit).reverse() } }
    }

    if (method === 'GET' && head === 'artifacts' && seg.length === 4) {
      // 段名白名单（task TASK-n / node Nn / 文件名），防路径穿越
      if (seg.some((s) => !/^[\w.\-]+$/.test(s) || s.includes('..'))) {
        throw Object.assign(new Error('非法产物路径'), { code: 'bad_artifact_path', status: 400 })
      }
      try {
        const raw = await readFile(join(store.dir, 'artifacts', ...seg.slice(1)), 'utf8')
        return { json: { ok: true, text: raw } }
      } catch {
        throw Object.assign(new Error('产物文件不存在'), { code: 'artifact_not_found', status: 404 })
      }
    }

    /* ---------------- 界面本体（单文件 HTML，与 dev-server 预览同一份） ---------------- */

    if (method === 'GET' && head === 'ui') {
      try {
        const file = new URL('../public/ui.html', import.meta.url)
        const raw = await readFile(file, 'utf8')
        // 把真实前缀写进 <html data-npc-base>：界面据此指定 API 根，
        // 免得页面在 /<prefix>/ui 下却把请求打到站点根（dsh-edict-demo 踩过的坑）。
        const html = raw.replace('<html', `<html data-npc-base="${ROUTE_PREFIX}"`)
        return { html }
      } catch (error) {
        return { status: 500, json: { error: 'ui_missing', message: `读不到 public/ui.html：${error?.message ?? error}` } }
      }
    }

    /* ---------------- 写操作 ---------------- */

    if (method === 'POST' && head === 'tasks' && seg.length === 1) {
      try {
        const task = createTask(store.state, body ?? {}, new Date().toISOString())
        store.touch('task-create')
        return { status: 201, json: { ok: true, v: store.version, id: task.id, task: taskDetail(task) } }
      } catch (error) {
        deny({ action: 'create', title: String(body?.title ?? ''), remark: error?.message ?? String(error) })
        throw error
      }
    }

    if (method === 'POST' && head === 'tasks' && seg.length === 3 && seg[2] === 'triage') {
      const task = findTask(store.state, seg[1])
      if (!task) throw Object.assign(new Error(`任务 ${seg[1]} 不存在`), { code: 'task_not_found', status: 404 })
      try {
        const changed = triageTask(store.state, task, body?.tier, body?.by ?? 'manual', body?.reason ?? '')
        store.touch('task-triage')
        return { json: { ok: true, v: store.version, changed, task: taskDetail(task) } }
      } catch (error) {
        deny({ action: 'triage', taskId: task.id, title: task.title, to: body?.tier ?? null, remark: error?.message ?? String(error) })
        throw error
      }
    }

    if (method === 'POST' && head === 'tasks' && seg.length === 3 && seg[2] === 'action') {
      const task = findTask(store.state, seg[1])
      if (!task) throw Object.assign(new Error(`任务 ${seg[1]} 不存在`), { code: 'task_not_found', status: 404 })
      const { action, nodeId, remark } = body ?? {}
      try {
        if (action === 'archive' || action === 'unarchive') {
          task.archived = action === 'archive'
          task.updatedAt = new Date().toISOString()
          appendAudit(store.state, { action, taskId: task.id, title: task.title, to: task.archived ? 'archived' : 'active' })
          store.touch(`task-${action}`)
          return { json: { ok: true, v: store.version, task: taskDetail(task) } }
        }
        const node = advanceNode(store.state, task, nodeId, action, { remark })
        store.touch(`node-${action}`)
        return { json: { ok: true, v: store.version, task: taskDetail(task), node: { id: node.id, state: node.state } } }
      } catch (error) {
        deny({ action: String(action ?? 'unknown'), taskId: task.id, title: task.title, nodeId: nodeId ?? null, remark: error?.message ?? String(error) })
        throw error
      }
    }

    if (method === 'POST' && head === 'tasks' && seg.length === 3 && seg[2] === 'dispatch') {
      const task = findTask(store.state, seg[1])
      if (!task) throw Object.assign(new Error(`任务 ${seg[1]} 不存在`), { code: 'task_not_found', status: 404 })
      try {
        if (!host.dispatcher) {
          throw Object.assign(new Error('宿主未提供执行环境（ctx.agents 缺席或运行于 dev-server）'), { code: 'execution_unavailable', status: 503 })
        }
        const exec = await host.dispatcher.dispatch(task.id, { nodeId: body?.nodeId, actor: 'user' })
        return { json: { ok: true, v: store.version, execution: execView(exec) } }
      } catch (error) {
        deny({ action: 'dispatch', taskId: task.id, title: task.title, nodeId: body?.nodeId ?? null, remark: error?.message ?? String(error) })
        throw error
      }
    }

    if (method === 'POST' && head === 'tasks' && seg.length === 5 && seg[2] === 'nodes' && seg[4] === 'stop') {
      const task = findTask(store.state, seg[1])
      if (!task) throw Object.assign(new Error(`任务 ${seg[1]} 不存在`), { code: 'task_not_found', status: 404 })
      try {
        if (!host.dispatcher) {
          throw Object.assign(new Error('宿主未提供执行环境'), { code: 'execution_unavailable', status: 503 })
        }
        const exec = await host.dispatcher.stopByNode(task.id, seg[3])
        return { json: { ok: true, v: store.version, execution: execView(exec) } }
      } catch (error) {
        deny({ action: 'stop', taskId: task.id, title: task.title, nodeId: seg[3], remark: error?.message ?? String(error) })
        throw error
      }
    }

    if (method === 'POST' && head === 'tasks' && seg.length === 5 && seg[2] === 'nodes' && seg[4] === 'doc') {
      const task = findTask(store.state, seg[1])
      if (!task) throw Object.assign(new Error(`任务 ${seg[1]} 不存在`), { code: 'task_not_found', status: 404 })
      try {
        // M0 测试写入位：界面/自测用；M2 起执行层（子会话回写）走同一函数、actor 带角色名
        const doc = addDoc(store.state, task, seg[3], { ...body, actor: body?.actor ?? 'user' })
        store.touch('doc-add')
        return { status: 201, json: { ok: true, v: store.version, task: taskDetail(task), doc } }
      } catch (error) {
        deny({ action: 'doc', taskId: task.id, title: task.title, nodeId: seg[3], remark: error?.message ?? String(error) })
        throw error
      }
    }

    if (method === 'POST' && head === 'tasks' && seg.length === 3 && seg[2] === 'pipeline') {
      const task = findTask(store.state, seg[1])
      if (!task) throw Object.assign(new Error(`任务 ${seg[1]} 不存在`), { code: 'task_not_found', status: 404 })
      const auto = Boolean(body?.auto)
      const p = pipelineOf(task)
      if (auto) {
        resumePipeline(task, { resetBreaker: Boolean(body?.reset) })
        appendAudit(store.state, { action: 'pipeline-on', taskId: task.id, title: task.title, actor: 'user', remark: body?.reset ? '重开（断路器归零）' : '开启自动流转' })
      } else {
        p.auto = false
        appendAudit(store.state, { action: 'pipeline-off', taskId: task.id, title: task.title, actor: 'user', remark: '停止自动流转' })
      }
      store.touch('pipeline-switch')
      return { json: { ok: true, v: store.version, pipeline: pipelineOf(task) } }
    }

    if (method === 'POST' && head === 'tasks' && seg.length === 3 && seg[2] === 'step') {
      const task = findTask(store.state, seg[1])
      if (!task) throw Object.assign(new Error(`任务 ${seg[1]} 不存在`), { code: 'task_not_found', status: 404 })
      try {
        if (!host.dispatcher) {
          throw Object.assign(new Error('宿主未提供执行环境'), { code: 'execution_unavailable', status: 503 })
        }
        const result = await runPipelineStep(store, host, host.dispatcher, task.id)
        return { json: { ok: true, v: store.version, ...result } }
      } catch (error) {
        deny({ action: 'pipeline-step', taskId: task.id, title: task.title, remark: error?.message ?? String(error) })
        throw error
      }
    }

    if (method === 'POST' && head === 'config') {
      const meta = store.state.meta ?? (store.state.meta = {})
      if (body && 'defaultCwd' in body) {
        const cwd = String(body.defaultCwd ?? '').trim()
        if (cwd && !/^([a-zA-Z]:[\\/]|\/)/.test(cwd)) {
          throw Object.assign(new Error('defaultCwd 须是绝对路径'), { code: 'bad_cwd', status: 400 })
        }
        meta.defaultCwd = cwd || null
        appendAudit(store.state, { action: 'config', actor: 'user', remark: `默认工作目录 = ${cwd || '（未设置，回落 DSH home）'}` })
      }
      if (body && 'autoCommit' in body) {
        meta.autoCommit = Boolean(body.autoCommit)
        appendAudit(store.state, { action: 'config', actor: 'user', remark: `收口自动提交 = ${meta.autoCommit ? '开' : '关'}` })
      }
      store.touch('config')
      return { json: { ok: true, v: store.version, config: { defaultCwd: meta.defaultCwd ?? null, autoCommit: meta.autoCommit !== false, executionMode: 'manual' } } }
    }

    if (method === 'POST' && head === 'dev' && seg[1] === 'reseed') {
      store.reseed()
      logger?.warn?.('[dsh-onenpc] 已重置为种子数据（仅自测用）')
      return { json: { ok: true, v: store.version } }
    }

    throw Object.assign(new Error(`未找到路由 ${method} ${pathname}`), { code: 'not_found', status: 404 })
  }
}

/* ------------------------------------------------------------------ */
/* Cordis 接线                                                         */
/* ------------------------------------------------------------------ */

/** 缓存 `@deepseek-ai/dsh-llm` 的 createUserMessage（拿不到时是 null，避免反复 import） */
let llmMessageFactory

export function apply(ctx) {
  const home = resolveDshHome()
  const store = new NpcStore(join(home, 'onenpc'))

  /** 取宿主服务但不因缺失而让插件崩掉（未 inject 的服务访问会抛错） */
  const safeGet = (serviceName) => {
    try {
      return ctx.get?.(serviceName)
    } catch {
      return undefined
    }
  }

  /** 宿主能力面：agents（真办差）/ llm（判级与评审）/ 默认模型 */
  const host = {
    home,
    agents() {
      return safeGet('agents')
    },
    agentsReady() {
      const agents = safeGet('agents')
      return typeof agents?.create === 'function'
    },
    async defaultModel() {
      try {
        const svc = safeGet('agentDefaultModel')
        const sel = svc?.currentSelection?.() ?? null
        if (!sel) return null
        return { provider: sel.provider ?? '', model: sel.model ?? '', vendor: sel.vendor ?? null }
      } catch {
        return null
      }
    },
    /** 逐角色模型：先看 meta.modelOverrides[角色名]，再看宿主默认（override 允许 `provider:model` 或只写 model） */
    async modelFor(role) {
      const meta = store.state.meta ?? {}
      const override = meta.modelOverrides?.[role] ?? null
      const def = await host.defaultModel()
      if (!override) return def ? { provider: def.provider || null, model: def.model || null, source: 'default' } : { provider: null, model: null, source: 'none' }
      const raw = String(override)
      if (raw.includes(':')) {
        const idx = raw.indexOf(':')
        return { provider: raw.slice(0, idx) || def?.provider || null, model: raw.slice(idx + 1) || null, source: 'override' }
      }
      return { provider: def?.provider || null, model: raw, source: 'override' }
    },
    /** 判级/评审用的流式通道；拿不到返回 null，上层退化并如实标注 */
    llmStream() {
      const llm = safeGet('llm')
      if (!llm || typeof llm.stream !== 'function') return null
      return (options) => llm.stream(options)
    },
    /** 造一条 user 消息；`@deepseek-ai/dsh-llm` 拿不到时退回朴素结构 */
    async userMessage(text) {
      if (llmMessageFactory === undefined) {
        try {
          const mod = await import('@deepseek-ai/dsh-llm')
          llmMessageFactory = typeof mod?.createUserMessage === 'function' ? mod.createUserMessage : null
        } catch {
          llmMessageFactory = null
        }
      }
      if (llmMessageFactory) {
        return llmMessageFactory({ content: [{ type: 'text', text }], source: { kind: 'user' } })
      }
      return { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
    },
  }

  let ready = null
  const ensureReady = () => {
    if (!ready) ready = store.load(ctx.logger).catch((error) => ctx.logger?.error?.('[dsh-onenpc] 初始化失败', error))
    return ready
  }
  void ensureReady()

  const dispatcher = createDispatcher(store, host, ctx.logger)
  const route = createRouter(store, ctx.logger, { ...host, dispatcher })

  /* ---- /npc 斜杠命令：`/npc [角色] 需求` → 建单（origin=command）→ 派发 ---- */
  /* result.kind 只能是宿主认识的 'success' / 'error'（返回其它值 → gateway 报 unknown result kind） */
  ctx.effect(() => {
    try {
      const off = ctx.commands?.register?.({
        name: 'npc',
        description: '三省六部：召 NPC 办差',
        input: { hint: '[角色名，可空·默认中书令] 需求一句话' },
        handler: async ({ rawInput }) => {
          try {
            await ensureReady()
            const raw = String(rawInput ?? '').trim()
            if (!raw) return { kind: 'error', text: '用法：/npc [角色名] 需求一句话（角色可省略，默认中书令）' }
            let role = '中书令'
            let rest = raw
            const m = raw.match(new RegExp(`^(${ROLE_NAMES.join('|')})\\s*([\\s\\S]*)$`))
            if (m) {
              role = m[1]
              rest = m[2].trim()
            }
            if (!rest) return { kind: 'error', text: '缺需求内容。用法：/npc [角色名] 需求一句话' }
            const task = createTask(store.state, {
              title: rest.slice(0, 60),
              requirement: rest,
              origin: 'command',
              role,
            })
            store.touch('command-create')
            void dispatcher.dispatch(task.id, { actor: 'system' }).catch((error) => ctx.logger?.warn?.('[dsh-onenpc] /npc 交办失败', error))
            return {
              kind: 'success',
              text: `已立项 ${task.id}「${task.title}」（判级 ${task.triage}·${task.triageBy}）。\n正在交办，进度与产物看「三省六部」看板（左侧栏 🏯 或会话头 tab）。`,
            }
          } catch (error) {
            return { kind: 'error', text: `下旨失败：${error?.message ?? error}` }
          }
        },
      })
      ctx.logger?.info?.('[dsh-onenpc] /npc 命令已注册')
      return typeof off === 'function' ? off : undefined
    } catch (error) {
      ctx.logger?.warn?.('[dsh-onenpc] 注册 /npc 命令失败', error)
      return undefined
    }
  }, 'dsh-onenpc: /npc 命令')

  /* ---- 会话事件：① 本插件执行子会话 → 回写；② 主会话 user/message → @解析 ---- */
  ctx.effect(
    () => {
      const onExecutionEvent = (session, event) => {
        const sid = session?.header?.id ?? session?.id ?? null
        if (!sid) return
        try {
          if (typeof sid === 'string' && sid.startsWith(EXEC_SESSION_PREFIX)) {
            dispatcher.handleEvent(sid, event)
            return
          }
          dispatcher.handleMention(sid, event)
        } catch (error) {
          ctx.logger?.warn?.('[dsh-onenpc] session/event 处理失败', error)
        }
      }
      const off = ctx.on?.('session/event', onExecutionEvent)
      return () => {
        try {
          off?.()
        } catch {
          /* 某些版本 ctx.on 返回的不是 disposer，忽略即可 */
        }
      }
    },
    'dsh-onenpc: 执行回写与 @解析订阅',
  )

  /* ---- M3：流水线定时步进（每 5s 扫一轮 auto 任务；同任务串行、全局 ≤2 并发、有在办执行先等） ---- */
  const pipelineBusy = new Set()
  const pipelineTick = setInterval(() => {
    if (!ready) return
    const tasks = store.state?.tasks ?? []
    for (const task of tasks) {
      if (pipelineBusy.size >= 2) break
      const p = task.pipeline
      if (!p?.auto || p.stopped) continue
      if (pipelineBusy.has(task.id)) continue
      if ((store.state.executions?.items ?? []).some((e) => e.taskId === task.id && e.status === 'running')) continue
      pipelineBusy.add(task.id)
      void (async () => {
        try {
          await runPipelineStep(store, host, dispatcher, task.id)
        } catch (error) {
          ctx.logger?.warn?.('[dsh-onenpc] 自动流转失败', error)
          const target = store.state.tasks.find((t) => t.id === task.id)
          if (target) stopPipeline(target, 'error', error?.message ?? String(error))
          store.touch('pipeline-error')
        } finally {
          pipelineBusy.delete(task.id)
        }
      })()
    }
  }, 5000)
  ctx.effect(() => () => clearInterval(pipelineTick), 'dsh-onenpc: 流水线步进')

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          const abort = new AbortController()
          const onClose = () => abort.abort()
          res.on('close', onClose)
          try {
            await ensureReady()
            if (abort.signal.aborted) return
            const body = req.method === 'POST' || req.method === 'PUT' ? await readJson(req) : undefined
            const result = await route(req.url ?? '/', req.method ?? 'GET', body)
            res.off('close', onClose)
            if (res.destroyed || res.writableEnded) return
            if (result.html !== undefined) {
              const page = String(result.html)
              res.writeHead(result.status ?? 200, {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store',
                'content-length': Buffer.byteLength(page),
              })
              res.end(page)
            } else {
              sendJson(res, result.status ?? 200, result.json ?? {})
            }
          } catch (error) {
            res.off('close', onClose)
            if (res.destroyed || res.writableEnded) return
            const status = Number.isInteger(error?.status) ? error.status : 500
            sendJson(res, status, {
              error: error?.code ?? 'internal_error',
              message: error instanceof Error ? error.message : String(error),
            })
          }
        },
      }),
    'dsh-onenpc: HTTP 路由',
  )

  ctx.logger?.info?.(`[dsh-onenpc] 三省六部已挂载：${ROUTE_PREFIX}（数据目录 ${store.dir}）`)
}

/** 供 scripts/dev-server.mjs 与 scripts/smoke.mjs 复用的零件（宿主运行时不会用到） */
export const __internals = { NpcStore, createRouter, createDispatcher, buildState, ROUTE_PREFIX, runPipelineStep, pipelineNextStep }
