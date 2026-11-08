/**
 * dsh-onenpc · 执行层（纯函数 + 宿主旁路工具）
 *
 * 内容：
 *   - 事件映射 observeEvent：从 session/event 里取「助手说了什么/调了什么工具/用量/轮次结束」。
 *     形状移植自 dsh-edict-demo 真机验证版（EXEC-1/2 踩坑结论）：输入侧事件过滤、文本块白名单、
 *     `assistant/message` 替换语义、`turn/end` 成功 kind 是 'completed'、usage 取最大值不累加。
 *   - askLLM：`ctx.llm.stream` 直调（判级用，M3 评审轮共用）。chunk 形状：
 *     text-delta / usage / finish（reason.kind 非 stop 记失败）。
 *   - 简报拼装 executionBrief：角色 soul + 诏令（任务/节点/验收/工作目录/汇报格式）。
 *   - git 基线与 diff 截取：派发前 gitBaseline()，节点结束 captureDiff()——
 *     「点节点看产物」的地基（analysis/02-design.md §五「diff 产物捕获」）。
 *
 * 纯函数纪律：本文件不做业务状态推进；执行记录的字段写入由 index.js 的 dispatcher 调度。
 */

import { execFile } from 'node:child_process'
import { findRole } from './domain.js'

/* ============================== 常量 ============================== */

/** 本插件派发的子会话 id 前缀（@解析靠它排除自己的简报消息） */
export const EXEC_SESSION_PREFIX = 'npc-exec-'

/** turn/end 的失败种类（成功 kind 是 'completed'，不是 'stop'——dsh-edict-demo EXEC-1 实录） */
export const FAILED_REASON_KINDS = new Set(['error', 'aborted', 'max-tokens', 'max_tokens', 'refusal', 'timeout'])

/** 助手文本上限（字符） */
export const EXEC_TEXT_CAP = 20_000
/** 事件轨迹/工具列表上限 */
export const TRACE_CAP = 40
export const TOOLS_CAP = 20
/** 执行记录条数上限（state.json 防膨胀） */
export const EXECUTIONS_CAP = 100
/** diff 截取上限：行数 / 字节 */
export const DIFF_LINE_CAP = 2000
export const DIFF_BYTES_CAP = 512 * 1024

/* ============================== 事件映射 ============================== */

/**
 * 内容块的类型白名单：只有这些算「说出来的话」。
 * 真机 assistant/message 的 content 是块数组，推理块（reasoning/thinking）也在里面，
 * 不过滤就会把内心独白当成奏报（dsh-edict-demo EXEC-2 踩过）。
 */
const TEXT_BLOCK_TYPES = new Set(['text', 'text-delta', 'text_delta', 'output_text', 'output-text'])

function isTextBlock(item) {
  if (!item || typeof item !== 'object') return false
  const blockType = typeof item.type === 'string' ? item.type.toLowerCase() : ''
  if (!blockType) return true // 没有 type 字段，按字符串内容处理
  return TEXT_BLOCK_TYPES.has(blockType)
}

function textOf(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts = []
    for (const item of value) {
      if (typeof item === 'string') parts.push(item)
      else if (item && typeof item === 'object') {
        if (!isTextBlock(item)) continue
        if (typeof item.text === 'string') parts.push(item.text)
        else if (typeof item.content === 'string') parts.push(item.content)
      }
    }
    return parts.join('')
  }
  return ''
}

/** 助手侧事件里的正文：把见过的几种包法都试一遍（宿主形状未公开，按容错取） */
function assistantTextOf(event, data) {
  const candidates = [
    event.delta, data?.delta, data?.textDelta, event.textDelta,
    data?.text, event.text, data?.content, event.content,
    data?.message?.content, data?.message?.text, data?.message?.parts,
    data?.parts, data?.blocks, data?.chunk?.text,
    data?.message?.content?.map?.((c) => c?.text),
  ]
  for (const candidate of candidates) {
    const text = textOf(candidate)
    if (text && text.trim()) return text
  }
  return ''
}

/** 用户侧消息正文（@解析用）：content 块数组 / 纯文本都认 */
export function userTextOf(event) {
  const data = event?.data ?? event?.payload ?? event?.value ?? null
  return textOf(
    data?.content ?? data?.text ?? data?.message?.content ?? data?.message?.text ?? event?.content ?? event?.text,
  )
}

/** 从事件里捞 token 用量：宿主不同版本字段名不一样，全都试一遍 */
export function usageOf(event, data) {
  const bag =
    data?.usage ?? event?.usage ?? event?.data?.usage ?? event?.payload?.usage ??
    data?.metrics?.usage ?? null
  if (!bag || typeof bag !== 'object') return null
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null)
  const input = num(bag.input_tokens ?? bag.prompt_tokens ?? bag.inputTokens ?? bag.promptTokens ?? bag.input)
  const output = num(bag.output_tokens ?? bag.completion_tokens ?? bag.outputTokens ?? bag.completionTokens ?? bag.output)
  const total = num(bag.total_tokens ?? bag.totalTokens ?? bag.total)
    ?? (input !== null || output !== null ? (input ?? 0) + (output ?? 0) : null)
  if (input === null && output === null && total === null) return null
  return { input, output, total }
}

/** 累计用量（宿主报的多是累计值，取「最新一次」不相加，防倒退取 max） */
export function noteUsage(exec, usage) {
  if (!exec || !usage) return false
  const prev = exec.tokens ?? { input: 0, output: 0, total: 0, reports: 0 }
  const pick = (next, old) => (typeof next === 'number' && Number.isFinite(next) ? Math.max(next, old) : old)
  const next = {
    input: pick(usage.input, prev.input ?? 0),
    output: pick(usage.output, prev.output ?? 0),
    total: pick(usage.total, prev.total ?? 0),
    reports: (prev.reports ?? 0) + 1,
  }
  const changed = next.input !== prev.input || next.output !== prev.output || next.total !== prev.total
  exec.tokens = next
  return changed
}

/**
 * 从一条 session/event 里尽量取出「助手说了什么 / 调了什么工具 / 轮次结束」。
 * 认不出就返回 {kind:'unknown'}。移植自 dsh-edict-demo 真机验证版：
 *  - 输入侧事件（agent/inbox、user/、system/、turn/start…）不用于取正文；
 *  - 文本只认助手侧（类型名带 assistant 或 role=assistant）；
 *  - `assistant/message` 替换语义，增量事件追加语义；
 *  - 工具调用必须能拿到工具名。
 */
export function observeEvent(event) {
  if (!event || typeof event !== 'object') return { kind: 'unknown', type: '?' }
  const type = String(event.type ?? event.kind ?? '?')
  const data = event.data ?? event.payload ?? event.value ?? null
  const role = String(
    data?.role ?? event.role ?? data?.message?.role ?? event.message?.role ?? '',
  ).toLowerCase()
  const usage = usageOf(event, data)
  const withUsage = (payload) => (usage ? { ...payload, usage } : payload)

  const inbound = /^(agent\/inbox|user\/|system\/|request\/|permission\/|sandbox\/|approval\/|session\/|turn\/start|step\/start)/.test(type)
  const assistantish = /assistant/.test(type) || role === 'assistant'

  if (!inbound && assistantish) {
    const text = assistantTextOf(event, data)
    if (text) {
      const complete = /\/message$/.test(type) || /\/messages$/.test(type)
      return withUsage({ kind: complete ? 'message' : 'text', type, role: 'assistant', text })
    }
  }

  if (!inbound && /tool/.test(type)) {
    const name = data?.name ?? event.name ?? data?.tool ?? data?.toolName ?? null
    if (name) return withUsage({ kind: 'tool', type, name: String(name).slice(0, 80) })
    return withUsage({ kind: 'unknown', type, role: role || null })
  }

  if (/turn\/(end|complete|done)|turn-end/.test(type)) {
    return withUsage({ kind: 'turn-end', type, reason: data?.reason ?? event.reason ?? null })
  }

  return withUsage({ kind: 'unknown', type, role: role || null })
}

/* ============================== 执行记录 ============================== */

export function createExecutionRecord(state, { taskId, nodeId, role, sessionId, provider, model }) {
  if (!state.executions || typeof state.executions.seq !== 'number') state.executions = { seq: 0, items: [] }
  state.executions.seq += 1
  const exec = {
    id: `EXEC-${state.executions.seq}`,
    taskId, nodeId, role, sessionId,
    status: 'running',
    provider: provider ?? null,
    model: model ?? null,
    chars: 0,
    calls: 0,
    tools: [],
    tokens: { input: 0, output: 0, total: 0, reports: 0 },
    lastText: '',
    trace: [],
    sampleTypes: [],
    startedAt: new Date().toISOString(),
    endedAt: null,
    error: null,
  }
  state.executions.items.push(exec)
  if (state.executions.items.length > EXECUTIONS_CAP) state.executions.items.splice(0, state.executions.items.length - EXECUTIONS_CAP)
  return exec
}

export function findExecutionBySession(state, sessionId) {
  return (state.executions?.items ?? []).find((e) => e.sessionId === sessionId) ?? null
}

export function setAssistantMessage(exec, text) {
  const t = String(text ?? '').slice(0, EXEC_TEXT_CAP)
  const dirty = t !== exec.lastText
  exec.lastText = t
  exec.chars = t.length
  return dirty
}

export function appendExecutionText(exec, text) {
  const next = (exec.lastText + String(text ?? '')).slice(-EXEC_TEXT_CAP)
  const dirty = next !== exec.lastText
  exec.lastText = next
  exec.chars = exec.lastText.length
  return dirty
}

export function noteToolCall(exec, name) {
  exec.calls = (exec.calls ?? 0) + 1
  exec.tools.unshift({ name: String(name).slice(0, 80), at: new Date().toISOString() })
  if (exec.tools.length > TOOLS_CAP) exec.tools.splice(TOOLS_CAP)
  return true
}

export function noteTrace(exec, seen) {
  exec.trace.unshift({
    at: new Date().toISOString(),
    type: String(seen?.type ?? '?').slice(0, 64),
    kind: seen?.kind ?? 'unknown',
    len: Number(seen?.text?.length ?? 0) || 0,
  })
  if (exec.trace.length > TRACE_CAP) exec.trace.splice(TRACE_CAP)
  const st = String(seen?.type ?? '')
  if (st && !exec.sampleTypes.includes(st)) {
    exec.sampleTypes.push(st)
    if (exec.sampleTypes.length > 24) exec.sampleTypes.splice(24)
    return true
  }
  return false
}

export function finishExecution(exec, { status, error }) {
  exec.status = status
  exec.endedAt = new Date().toISOString()
  if (error) exec.error = String(error).slice(0, 500)
  return true
}

export function execView(exec) {
  return {
    id: exec.id, taskId: exec.taskId, nodeId: exec.nodeId, role: exec.role,
    sessionId: exec.sessionId, status: exec.status,
    provider: exec.provider, model: exec.model,
    chars: exec.chars, calls: exec.calls, toolsCount: exec.tools?.length ?? 0,
    tokens: exec.tokens, startedAt: exec.startedAt, endedAt: exec.endedAt, error: exec.error,
  }
}

/* ============================== 简报拼装 ============================== */

/** 承接子会话的第一条指令：角色 soul + 诏令（任务/节点/工作目录/汇报格式） */
export function executionBrief(role, task, node) {
  const r = findRole(role)
  const lines = [
    r?.soul ?? `【角色】你是「${role}」，三省六部体系的承接者。`,
    '',
    '【诏令】',
    `- 任务：${task.title}（${task.id} · 判级 ${task.triage}）`,
    `- 节点：${node.kind}（${node.id}）· 承接：${node.role}`,
    `- 需求详情：${task.requirement || '（见标题）'}`,
    `- 工作目录：${node.gitBaseline?.cwd ?? '（未指定，勿改动当前目录外文件）'}`,
    '- 要求：只做本节点职责内的事；改动最小化；完成前先验证，不假装完成。',
    '',
    '回复末尾用「执行汇报」作结，三行：做了什么 / 如何验证 / 遗留事项。',
  ]
  return lines.join('\n')
}

/* ============================== askLLM（ctx.llm.stream 直调） ============================== */

/**
 * 直调一次模型。**绝不抛错**（调用方据 mode:'simulated' 走确定性退路）。
 * chunk 形状（dsh-edict-demo 真机验证）：text-delta / usage / finish。
 */
export async function askLLM(host, prompt, { provider, model } = {}) {
  const stream = typeof host?.llmStream === 'function' ? host.llmStream() : null
  if (!stream) return { text: '', tokens: 0, mode: 'simulated', failure: 'llm-service-absent' }
  let picked = { provider: provider ?? '', model: model ?? '' }
  if ((!picked.provider || !picked.model) && typeof host?.defaultModel === 'function') {
    const def = await host.defaultModel()
    picked = { provider: picked.provider || def?.provider || '', model: picked.model || def?.model || '' }
  }
  if (!picked.provider || !picked.model) return { text: '', tokens: 0, mode: 'simulated', failure: 'no-model' }
  let text = ''
  let tokens = 0
  let failure = null
  try {
    const message = await host.userMessage(prompt)
    for await (const chunk of stream({ provider: picked.provider, model: picked.model, messages: [message] })) {
      if (chunk?.type === 'text-delta') text += chunk.text ?? ''
      else if (chunk?.type === 'usage') {
        const total = Number(chunk?.usage?.total ?? chunk?.total ?? 0) || 0
        if (total > 0) tokens = Math.max(tokens, total)
      } else if (chunk?.type === 'finish' && chunk.reason?.kind && chunk.reason.kind !== 'stop') {
        failure = chunk.reason.failure?.message ?? chunk.reason.kind
      }
    }
  } catch (error) {
    failure = error?.message ?? String(error)
  }
  if (text.trim() && !failure) return { text: text.trim(), tokens, mode: 'llm', failure: null }
  return { text: text.trim(), tokens, mode: 'simulated', failure: failure ?? 'empty' }
}

/* ============================== git 基线 / diff 截取 ============================== */

function git(args, cwd, maxBuffer = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr: String(stderr ?? '').slice(0, 300) }))
      else resolve(String(stdout ?? ''))
    })
  })
}

/**
 * 派发前记基线。非 git 仓库（或 git 不可用）返回 null——调用方如实标注，不假装干净。
 */
export async function gitBaseline(cwd) {
  try {
    const head = (await git(['rev-parse', 'HEAD'], cwd)).trim()
    const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim()
    let dirty = false
    try {
      dirty = Boolean((await git(['status', '--porcelain'], cwd)).trim())
    } catch {
      dirty = false
    }
    return { head, branch, dirty, recordedAt: new Date().toISOString() }
  } catch {
    return null
  }
}

/**
 * 节点结束时截 diff：`git diff <baselineSha>` 给出基线→当前工作区全部差异
 * （子会话无论是否 commit 都能截到）。行数/字节超限截断并标注。
 */
export async function captureDiff(cwd, baseline) {
  if (!baseline?.head) return null
  try {
    const full = await git(['diff', baseline.head], cwd)
    const stat = await git(['diff', baseline.head, '--stat'], cwd)
    const allLines = full.split('\n')
    const truncated = allLines.length > DIFF_LINE_CAP || full.length > DIFF_BYTES_CAP
    const diffText = allLines.slice(0, DIFF_LINE_CAP).join('\n').slice(0, DIFF_BYTES_CAP)
      + (truncated ? '\n…（diff 已截断：超 2000 行 / 512KB）' : '')
    // 从 --stat 提取逐文件增删（尾行是合计）
    const files = []
    for (const line of stat.split('\n')) {
      const m = line.match(/^\s*(.+?)\s+\|\s+(\d+)\s*([+-]*)\s*$/)
      if (m && m[1] !== '-' && !/changed/.test(m[1])) {
        files.push({ path: m[1].trim(), changes: Number(m[2]) || 0, bar: (m[3] ?? '').slice(0, 40) })
      }
    }
    return { stat, files, diffText, truncated, capturedAt: new Date().toISOString() }
  } catch (error) {
    return { error: error?.message ?? String(error), capturedAt: new Date().toISOString() }
  }
}

/** 未跟踪新文件列表（git diff 看不到，须从 status 收集） */
export async function listUntracked(cwd) {
  try {
    const status = await git(['status', '--porcelain', '--untracked-files=all'], cwd)
    return status.split('\n')
      .filter((l) => l.startsWith('?? '))
      .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''))
      .filter(Boolean)
      .slice(0, 50)
  } catch {
    return []
  }
}

/**
 * 收口 = 自动提交（npc-x §8 [5 自动合并] 的本机等价物）。
 * 工作区干净则 skipped；失败返回 { error }（调用方如实留痕，不中断流程）。
 */
export async function gitCommitAll(cwd, message) {
  try {
    const status = await git(['status', '--porcelain'], cwd)
    if (!status.trim()) {
      const head = (await git(['rev-parse', 'HEAD'], cwd)).trim()
      return { skipped: true, sha: head }
    }
    await git(['add', '-A'], cwd)
    await git(['commit', '-m', String(message ?? '收口').slice(0, 200)], cwd)
    const sha = (await git(['rev-parse', 'HEAD'], cwd)).trim()
    return { sha, output: 'committed' }
  } catch (error) {
    return { error: error?.message ?? String(error) }
  }
}
