/**
 * dsh-onenpc · 宿主半侧自测（HTTP 契约 + M2 执行链，直接调 createRouter/createDispatcher）
 *
 * 覆盖：
 *   A. 只读路由 / 长轮询 / 任务 CRUD / 状态机 / 改级 / 公文 / 审计 / 持久化回路（M0 遗产）
 *   B. M2 执行链（伪 agents + 伪 llm + 真实临时 git 仓）：
 *      派发（git 基线 + 简报）→ 事件回写（正文/用量/工具）→ turn-end 收口
 *      → diff 产物落盘 + 回奏公文 + 节点 done + 审计
 *   C. LLM 判级（fallback 档才判）/ @解析（去重 + 自会话过滤）/ 叫停 / 降级 503 / 产物路径白名单
 *   D. /npc 斜杠命令（伪 ctx 挂载 apply）：result.kind 只能是宿主认识的 success / error
 *
 * 运行：node scripts/smoke.mjs
 */

import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __internals, apply } from '../lib/index.js'
import { metricsOf, metricVerdicts } from '../lib/metrics.js'

const { NpcStore, createRouter, createDispatcher, buildState, ROUTE_PREFIX, runPipelineStep } = __internals

const LOG = { info: () => {}, warn: (m, e) => console.warn(m, e ?? ''), error: (m, e) => console.error(m, e ?? '') }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let n = 0
const bad = []
const ok = (cond, name) => {
  n += 1
  if (!cond) bad.push(name)
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name}（got ${JSON.stringify(a)}）`)

/* ================= 环境准备：临时数据目录 + 真实临时 git 仓 ================= */

const dir = mkdtempSync(join(tmpdir(), 'dsh-onenpc-smoke-'))
const repo = mkdtempSync(join(tmpdir(), 'dsh-onenpc-repo-'))

const g = (args) =>
  new Promise((resolve, reject) =>
    execFile('git', args, { cwd: repo, windowsHide: true }, (error, stdout, stderr) =>
      error ? reject(Object.assign(error, { stderr })) : resolve(String(stdout ?? '')),
    ),
  )
await g(['init', '-b', 'main'])
await g(['config', 'user.email', 'smoke@test.local'])
await g(['config', 'user.name', 'smoke'])
writeFileSync(join(repo, 'a.txt'), 'hello\n', 'utf8')
await g(['add', '.'])
await g(['commit', '-m', 'init'])
const headSha = (await g(['rev-parse', 'HEAD'])).trim()

const store = new NpcStore(dir)
await store.load(LOG)

/** 伪 agents：记录 steer 文本；伪 llm：可编程回复（llmQueue 优先，回落 llmReply） */
const fakeSpawns = []
const fakeSteers = []
let llmReply = 'S0 简单单点修改'
let llmTokens = 42
const llmQueue = []
const fakeRegistry = {
  create: async ({ sessionId, agentOptions, meta }) => {
    fakeSpawns.push({ sessionId, agentOptions, meta })
    return {
      agent: {
        steer: (msg) => {
          fakeSteers.push({ sessionId, text: msg?.content?.[0]?.text ?? String(msg) })
        },
        followup: (msg) => {
          fakeSteers.push({ sessionId, text: msg?.content?.[0]?.text ?? String(msg) })
        },
        cancel: () => {},
      },
      dispose: async () => {},
    }
  },
}
const fakeHost = {
  home: dir,
  agents: () => fakeRegistry,
  agentsReady: () => true,
  defaultModel: async () => ({ provider: 'test', model: 'fake-model' }),
  modelFor: async () => ({ provider: 'test', model: 'fake-model', source: 'default' }),
  llmStream: () =>
    async function* (options) {
      ok(Array.isArray(options?.messages) && options.messages.length >= 1, 'llm.stream 收到 messages 数组')
      const text = llmQueue.length ? llmQueue.shift() : llmReply
      yield { type: 'text-delta', text }
      yield { type: 'usage', usage: { total: llmTokens } }
    },
  userMessage: async (text) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }),
}

const dispatcher = createDispatcher(store, fakeHost, LOG)
const route = createRouter(store, LOG, { ...fakeHost, dispatcher })
const routeNoExec = createRouter(store, LOG, { home: dir, agentsReady: () => false })

const get = (path, r = route) => r(path, 'GET')
const post = (path, body, r = route) => r(path, 'POST', body)
const code = async (fn) => {
  try {
    await fn()
    return null
  } catch (error) {
    return error
  }
}
const waitExecDone = async (execId, timeoutMs = 5000) => {
  // 锚点 = execute-done 审计（finishWriteback 的最后一步），防状态先翻、产物未落盘的竞态
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const exec = store.state.executions.items.find((e) => e.id === execId)
    const auditDone = store.state.audit.some((a) => a.action === 'execute-done' && a.remark?.includes(execId))
    if ((exec && exec.status !== 'running' && auditDone) || Date.now() > deadline) return exec
    await sleep(30)
  }
}

/* ================= A. 只读路由与任务契约 ================= */

const health = await get('/health')
ok(health.json?.ok === true && health.json?.taskCount === 2, 'GET /health')

const meta = await get('/meta')
ok(meta.json?.name === 'dsh-onenpc' && meta.json?.stage === 'm2-execution', 'GET /meta 自述（M2）')

const state1 = await get('/state')
ok(state1.json?.source === 'dsh-onenpc' && state1.json?.stage === 'm2-execution', 'GET /state 来源与阶段')
eq(state1.json?.tasks?.length, 2, 'GET /state 任务数（种子未归档）')
eq(state1.json?.catalog?.roles?.length, 12, 'GET /state 角色目录 12')
ok(state1.json?.agentsReady === true, 'GET /state agentsReady（伪宿主）')
ok(Array.isArray(state1.json?.executions) && state1.json?.executions.length === 0, 'GET /state 执行记录空表')
eq(state1.json?.catalog?.fallbackTier, 'M', '目录含兜底档')

const created = await post('/tasks', { title: '冒烟测试任务', requirement: '验证 POST /tasks', tier: 'M' })
ok(created.status === 201 && created.json?.id === 'TASK-3', 'POST /tasks → 201 TASK-3')
eq(created.json?.task?.triageBy, 'manual', '指定判级 → manual')

const badTitle = await code(() => post('/tasks', { title: 'a' }))
eq(badTitle?.code, 'title_too_short', '标题过短 400')
const auditAfterDenied = store.state.audit.filter((a) => a.result === 'denied')
ok(auditAfterDenied.length >= 1, '被拒动作已留痕（denied）')

const detail = await get('/tasks/TASK-1')
eq(detail.json?.task?.id, 'TASK-1', 'GET /tasks/:id')
ok(detail.json?.task?.nodes?.[0]?.gitBaseline === null, '详情含 gitBaseline 位')

const ui = await get('/ui')
ok(typeof ui.html === 'string' && ui.html.includes(`data-npc-base="${ROUTE_PREFIX}"`), 'GET /ui 注入 base 前缀')

const err404 = await code(() => get('/tasks/TASK-99'))
eq(err404?.code, 'task_not_found', '未知任务 404')

/* ================= 配置：默认工作目录 ================= */

const cfg = await post('/config', { defaultCwd: repo })
eq(cfg.json?.config?.defaultCwd, repo, 'POST /config 设 defaultCwd')
const badCwd = await code(() => post('/config', { defaultCwd: 'relative/path' }))
eq(badCwd?.code, 'bad_cwd', '相对路径 cwd 拒')
const stateCwd = await get('/state')
eq(stateCwd.json?.config?.defaultCwd, repo, '/state 回显 config')

/* ================= B. M2 执行链：派发 → 事件 → 回写 → diff 产物 ================= */

const t1 = await post('/tasks', { title: '冒烟交办任务', requirement: '改 a.txt 并新增 note.txt', tier: 'S0' })
const T1 = t1.json.id
eq(t1.json?.task?.nodes?.map((x) => x.kind).join(','), '施工,初审', 'S0 节点序列')

const dispatched = await post(`/tasks/${T1}/dispatch`, {})
ok(dispatched.json?.execution?.status === 'running', 'POST dispatch → running（隐式 200）')
const exec1 = dispatched.json.execution
ok(String(exec1.sessionId).startsWith('npc-exec-'), '执行会话 id 前缀')
eq(exec1.model, 'fake-model', '执行记录带模型')

const detail1 = await get(`/tasks/${T1}`)
const n1 = detail1.json.task.nodes[0]
eq(n1.state, 'running', '节点转 running')
eq(n1.gitBaseline?.head, headSha, 'git 基线 = 当前 HEAD')
eq(n1.gitBaseline?.dirty, false, '派发时工作区干净')
ok(n1.gitBaseline?.cwd === repo, '基线记录 cwd')
ok(fakeSpawns.length === 1 && fakeSpawns[0].meta?.cwd === repo && fakeSpawns[0].meta?.origin === 'subagent', 'agents.create 收到 cwd/origin')
ok(fakeSpawns[0].agentOptions?.model === 'fake-model', '模型下发给子会话')
ok(fakeSteers.length === 1 && fakeSteers[0].text.includes('【诏令】') && fakeSteers[0].text.includes('【工部】'), '简报 = soul + 诏令')

const dup = await code(() => post(`/tasks/${T1}/dispatch`, {}))
eq(dup?.code, 'no_dispatchable_node', '重复派发（无 nodeId）→ 串行无可派发')
const dup2 = await code(() => post(`/tasks/${T1}/dispatch`, { nodeId: 'N1' }))
eq(dup2?.code, 'already_running', '重复派发（显式 nodeId）→ already_running')

/* 模拟子会话事件：正文 → 工具 → 用量 →（写文件）→ turn-end */
await dispatcher.handleEvent(exec1.sessionId, {
  type: 'assistant/message',
  data: { content: [{ type: 'text', text: '执行汇报：已修改 a.txt 并新增 note.txt\n如何验证：肉眼比对\n遗留：无' }] },
})
await dispatcher.handleEvent(exec1.sessionId, { type: 'tool/call', data: { name: 'write' } })
await dispatcher.handleEvent(exec1.sessionId, { type: 'usage', data: { usage: { input_tokens: 100, output_tokens: 50 } } })
appendFileSync(join(repo, 'a.txt'), 'world\n', 'utf8')
writeFileSync(join(repo, 'note.txt'), 'new file\n', 'utf8')
await dispatcher.handleEvent(exec1.sessionId, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
const doneExec = await waitExecDone(exec1.id)
ok(doneExec?.status === 'done', 'turn-end(completed) → 执行 done')
ok(doneExec?.chars > 0 && doneExec?.tokens?.total === 150, '正文与用量记账（100+50）')

const detail1b = await get(`/tasks/${T1}`)
const n1b = detail1b.json.task.nodes[0]
eq(n1b.state, 'done', '节点收口 done')
eq(n1b.tokens, 150, '节点 tokens 回写')
ok(n1b.docs?.some((d) => d.type === '回奏' && d.actor === '工部尚书'), '回奏公文（actor=承接角色）')
const diffArt = n1b.artifacts?.find((a) => a.kind === 'diff')
ok(Boolean(diffArt) && diffArt.files?.some((f) => f.path.includes('a.txt')), 'diff 产物（含 a.txt）')
ok(n1b.artifacts?.some((a) => a.kind === 'file' && a.path === 'note.txt'), '未跟踪新文件 → file 产物')
ok(n1b.artifacts?.some((a) => a.kind === 'report'), '执行汇报 → report 产物')
const auditDone = store.state.audit.filter((a) => a.action === 'execute-done' && a.taskId === T1)
ok(auditDone.length === 1 && auditDone[0].result === 'ok', 'execute-done 审计')

const diffText = await get(`/artifacts/${T1}/N1/N1.diff`)
ok(diffText.json?.text?.includes('diff --git') && diffText.json?.text?.includes('a.txt'), 'GET /artifacts diff 内容')
const reportText = await get(`/artifacts/${T1}/N1/N1.report.md`)
ok(reportText.json?.text?.includes('执行汇报'), 'GET /artifacts 报告内容')
const badPath = await code(() => get('/artifacts/TASK-1/N1/..%2F..%2Fsecret'))
eq(badPath?.code, 'bad_artifact_path', '产物路径穿越拒（编码穿越）')
const noArt = await code(() => get(`/artifacts/${T1}/N1/nope.diff`))
eq(noArt?.code, 'artifact_not_found', '产物不存在 404')

const execList = await get(`/executions?task=${T1}`)
ok(execList.json?.executions?.length === 1 && execList.json?.executions?.[0]?.status === 'done', 'GET /executions 过滤')
const execDetail = await get(`/executions/${exec1.id}`)
ok(execDetail.json?.execution?.lastText?.includes('执行汇报'), 'GET /executions/:id 带完整汇报')

/* 失败轮：turn-end 带错误种类 → failed，节点留 running */
const tFail = await post('/tasks', { title: '失败轮任务', tier: 'S0' })
const T2 = tFail.json.id
const d2 = await post(`/tasks/${T2}/dispatch`, {})
const exec2 = d2.json.execution
await dispatcher.handleEvent(exec2.sessionId, { type: 'turn/end', data: { reason: { kind: 'error', failure: { message: 'boom' } } } })
const failedExec = await waitExecDone(exec2.id)
eq(failedExec?.status, 'failed', '错误种类 → 执行 failed')
const tFailDetail = await get(`/tasks/${T2}`)
eq(tFailDetail.json.task.nodes[0].state, 'running', '失败轮节点留 running 待人')
ok(tFailDetail.json.task.nodes[0].stopReason?.includes('执行失败'), '失败停因留痕')

/* ================= C1. LLM 判级（fallback 档才判） ================= */

llmReply = 'S0 简单单点修改'
const t3 = await post('/tasks', { title: '未判级任务', requirement: '什么都还没定' })
const T3 = t3.json.id
eq(t3.json?.task?.nodes?.length, 7, '未判级 → M 档 7 节点（立项+6 循环）')
const d3 = await post(`/tasks/${T3}/dispatch`, {})
ok(d3.json?.ok === true, '派发成功（判级后）')
const t3Detail = await get(`/tasks/${T3}`)
eq(t3Detail.json.task.triage, 'S0', 'LLM 判级 → S0')
eq(t3Detail.json.task.triageBy, 'llm', 'triageBy = llm')
eq(t3Detail.json.task.nodes.length, 2, '判级后重排 2 节点')
ok(fakeSpawns.length === 3, '判级后派发（ spawns 累计 3）')

/* ================= C2. @解析（去重 + 自会话过滤） ================= */

const tasksBeforeMention = store.state.tasks.length
await dispatcher.handleMention('main-session-1', {
  type: 'user/message',
  data: { seq: 7, content: [{ type: 'text', text: '@中书令 帮我加个导出功能，支持 CSV' }] },
})
await store.flush()
const mentionTask = store.state.tasks.find((t) => t.origin === 'mention' && t.title.includes('导出功能'))
ok(Boolean(mentionTask), '@命中建单（origin=mention）')
eq(mentionTask?.role, '中书令', '@解析到入口角色')
ok(store.state.tasks.length === tasksBeforeMention + 1, '只建一单')
await dispatcher.handleMention('main-session-1', {
  type: 'user/message',
  data: { seq: 7, content: [{ type: 'text', text: '@中书令 帮我加个导出功能，支持 CSV' }] },
})
await store.flush()
eq(store.state.tasks.length, tasksBeforeMention + 1, '同消息去重（不重复建单）')
await dispatcher.handleMention('npc-exec-TASK-9-N1-abc', {
  type: 'user/message',
  data: { content: [{ type: 'text', text: '@中书令 简报里也有 @ 不应触发' }] },
})
eq(store.state.tasks.length, tasksBeforeMention + 1, '自会话简报不触发 @解析')
const hints = await get('/hints')
ok(hints.json?.hints?.some((h) => h.taskId === mentionTask.id && h.role === '中书令'), 'GET /hints 留痕（turnTail 用）')
await waitExecDone('EXEC-999') // 不存在的执行：只验证不抛
ok((store.state.executions?.items?.length ?? 0) >= 3, 'mention 派发已入执行记录')

/* ================= C3. 叫停 ================= */

const t4 = await post('/tasks', { title: '叫停任务', tier: 'S0' })
const T4 = t4.json.id
await post(`/tasks/${T4}/dispatch`, {})
const stopRes = await post(`/tasks/${T4}/nodes/N1/stop`, {})
ok(stopRes.json?.execution?.status === 'stopped', '叫停 → 执行 stopped')
const t4Detail = await get(`/tasks/${T4}`)
eq(t4Detail.json.task.nodes[0].state, 'running', '叫停后节点留 running')
ok(t4Detail.json.task.nodes[0].stopReason?.includes('叫停'), '叫停停因留痕')
ok(store.state.audit.some((a) => a.action === 'stop' && a.taskId === T4), '叫停审计')
const stopNone = await code(() => post(`/tasks/${T4}/nodes/N1/stop`, {}))
eq(stopNone?.code, 'no_running_execution', '无在办执行再叫停 404')

/* ================= C4. 降级：无执行环境 → 503 ================= */

const noExec = await code(() => post(`/tasks/TASK-1/dispatch`, {}, routeNoExec))
eq(noExec?.code, 'execution_unavailable', '无执行环境 503（如实降级）')

/* ================= D. 状态机动作 / 改级 / 公文 / 归档（M0 契约回归） ================= */

const startN1 = await post(`/tasks/${T1}/nodes/N1/doc`, { type: '经验卡', text: '伪 agents 也能全链路' })
ok(startN1.status === 201, 'POST doc → 201')

const tri = await post(`/tasks/${T1}/triage`, { tier: 'M', reason: '升格冒烟' })
ok(tri.json?.task?.triage === 'M' && tri.json?.task?.nodes?.length === 2, '有在途/完成节点 → 编成不回溯（S0 2 节点保留）')

await post(`/tasks/TASK-2/action`, { action: 'archive' })
const tasksAfter = await get('/tasks')
ok(tasksAfter.json?.tasks?.every((t) => t.id !== 'TASK-2'), '归档后列表不含')
const archAction = await code(() => post('/tasks/TASK-2/action', { action: 'start', nodeId: 'N1' }))
eq(archAction?.code, 'archived', '归档任务拒操作 409')
await post('/tasks/TASK-2/action', { action: 'unarchive' })

const audit = await get(`/audit?task=${T1}&limit=500`)
ok(audit.json?.audit?.length >= 5, '审计按任务过滤')
const auditLimited = await get('/audit?limit=2')
eq(auditLimited.json?.audit?.length, 2, '审计 limit 生效')

/* ================= E. 持久化回路 ================= */

await store.flush()
const store2 = new NpcStore(dir)
await store2.load(LOG)
ok(store2.state.executions?.items?.length === store.state.executions.items.length, '重启后执行记录保留')
const direct = buildState(store2, { agentsReady: () => true })
eq(direct.metrics.taskCount, store.state.tasks.length, 'buildState 指标')
ok(direct.executions.length > 0, 'buildState 执行记录')

/* ================= F. M3 流水线：全自动流转 / 驳回重做 / 断路器 / 预算熔断 ================= */

/** 把一次施工执行办完（正文事件 → 写文件 → turn-end → 等回写落锚） */
const completeConstruction = async (execId, file = 'w.txt') => {
  const exec = store.state.executions.items.find((e) => e.id === execId)
  await dispatcher.handleEvent(exec.sessionId, {
    type: 'assistant/message',
    data: { content: [{ type: 'text', text: '执行汇报：已完成改动\n如何验证：本地检查\n遗留：无' }] },
  })
  await dispatcher.handleEvent(exec.sessionId, { type: 'tool/call', data: { name: 'write' } })
  await dispatcher.handleEvent(exec.sessionId, { type: 'usage', data: { usage: { input_tokens: 100, output_tokens: 50 } } })
  writeFileSync(join(repo, file), `out-${execId}\n`, 'utf8')
  await dispatcher.handleEvent(exec.sessionId, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await waitExecDone(execId)
}

/** 驱动流水线直到收口/停机/空转（dispatch 步自动把施工办完） */
const drive = async (taskId, maxSteps = 30) => {
  const results = []
  for (let i = 0; i < maxSteps; i += 1) {
    const r = await runPipelineStep(store, fakeHost, dispatcher, taskId)
    results.push(r)
    if (r.step?.kind === 'dispatch' && r.execution) await completeConstruction(r.execution)
    if (r.step?.kind === 'stop' || r.step?.kind === 'complete' || r.idle) break
  }
  return results
}

/* ---- F1 全自动 M 单（§8）：立项→拆解→施工→初审→复审→收口(自动提交)→验收→交付（M 档轮内无部署） ---- */
llmQueue.length = 0
llmQueue.push(
  '验收清单：\n- 条目一：导出可用\n- 条目二：字段可勾选\n- 条目三：大表分批',
  '诏令：改 a.txt 新增产出（b_t=2）',
  '准',
  '准',
  '收口说明：质量门全过，收口。',
  '验收通过\n- [pass] 条目一\n- [pass] 条目二\n- [pass] 条目三',
  '交付报告：全部完成，交付。',
)
const t5 = await post('/tasks', { title: '全自动流转任务', requirement: '按需求完成改动', tier: 'M' })
const T5 = t5.json.id
await post(`/tasks/${T5}/pipeline`, { auto: true })
eq(store.state.tasks.find((t) => t.id === T5).pipeline.auto, true, '开启自动流转')
const r5 = await drive(T5)
const t5d = await get(`/tasks/${T5}`)
eq(t5d.json.task.nodes.map((x) => x.state).join(','), 'done,done,done,done,done,done,done', 'M 单七节点全部 done（立项+6 循环）')
eq(t5d.json.task.pipeline.auto, false, '交付后自动关闭')
eq(t5d.json.task.rounds[0].verdict, 'accepted', '第 1 轮验收通过')
ok(t5d.json.task.acceptance?.length === 3, '验收清单 3 条（立项产出）')
ok(t5d.json.task.acceptance?.every((a) => a.state === 'pass'), '验收通过后清单全 pass')
ok(t5d.json.task.delivery?.text?.includes('交付'), '[交付] 最终交付报告已生成')
ok(store.state.audit.some((a) => a.action === 'pipeline-complete' && a.taskId === T5), '收口审计')
eq(t5d.json.task.budget.steps, 8, '预算步数（立项/拆解/施工/初审/复审/收口/验收/交付）')
eq(t5d.json.task.budget.calls, 8, '预算调用（7 次 LLM 含交付 + 1 次工具）')
ok(t5d.json.task.budget.tokens >= 7 * 42 + 150, '预算 token 累计（LLM 7 次 + 施工 150）')
ok(r5.some((r) => r.step?.kind === 'dispatch'), '施工走了真子会话派发')
ok(r5.some((r) => r.step?.kind === 'deliver'), '走了交付步骤')
const t5n6 = t5d.json.task.nodes[5]
ok(t5n6.kind === '收口' && t5n6.artifacts?.some((a) => a.kind === 'note' && a.summary.includes('已自动提交')), '收口=自动提交（§8[5] 本机等价物）')

/* ---- F2 驳回重做：初审驳 → 施工打回 → 重做 → 再审准（轮内循环，npc-x §8[3]） ---- */
llmQueue.length = 0
llmQueue.push('立项清单：- 完成', '诏令：改点东西', '驳回：对比度仍不足，必须改色值', '准', '准', '收口', '验收通过', '交付')
const t6 = await post('/tasks', { title: '驳回重做任务', requirement: '对比度达标', tier: 'M' })
const T6 = t6.json.id
const r6 = await drive(T6)
const t6d = await get(`/tasks/${T6}`)
eq(t6d.json.task.counters.封驳, 1, '驳回一次封驳计数 1（验收开新轮不计封驳）')
eq(t6d.json.task.nodes[3].state, 'done', '初审最终通过 done（驳回轮曾 reopen）')
ok(t6d.json.task.nodes[3].docs?.some((d) => d.type === '封驳' && d.actor === '刑部尚书'), '初审封驳公文（actor=刑部）')
ok(r6.some((r) => r.step?.kind === 'redo'), '走了一次 redo')
ok(r6.some((r) => r.verdict === 'reject'), '有一次 reject 裁决')
ok(r6.some((r) => r.verdict === 'pass'), '最终 pass 裁决')
eq(t6d.json.task.nodes[2].docs?.filter((d) => d.type === '回奏')?.length >= 2, true, '施工同一节点两轮执行各有回奏（redo 重做同节点）')

/* ---- F3 封驳断路器：连驳 3 次 → 停机 → 重开归零 ---- */
llmQueue.length = 0
llmReply = '驳回：还是不行'
const t7 = await post('/tasks', { title: '断路器任务', requirement: '始终不过', tier: 'M' })
const T7 = t7.json.id
const r7 = await drive(T7, 60)
const t7d = await get(`/tasks/${T7}`)
eq(t7d.json.task.counters.封驳, 3, '三次封驳')
eq(t7d.json.task.pipeline.stopped?.reason, '封驳断路', '断路器停机')
eq(t7d.json.task.pipeline.auto, false, '断路即关自动')
ok(r7.at(-1).step.kind === 'stop', '驱动循环以 stop 结束')
await post(`/tasks/${T7}/pipeline`, { auto: true, reset: true })
const t7r = await get(`/tasks/${T7}`)
eq(t7r.json.task.counters.封驳, 0, '重开 reset 归零封驳')
eq(t7r.json.task.pipeline.stopped, null, '重开清停机')

/* ---- F4 预算熔断：单次 LLM 用量打爆 token 上限 ---- */
llmQueue.length = 0
llmReply = '立项清单：- x'
llmTokens = 400_000
const t8 = await post('/tasks', { title: '预算熔断任务', requirement: 'x', tier: 'M' })
const T8 = t8.json.id
const r8a = await runPipelineStep(store, fakeHost, dispatcher, T8) // 立项（LLM 400k）
ok(r8a.ok === true, '预算熔断：第一步正常执行')
const r8b = await runPipelineStep(store, fakeHost, dispatcher, T8) // 第二步应被预算闸门拦下
eq(r8b.step?.kind, 'stop', '第二步预算闸门拦截')
eq(r8b.step?.reason, '预算耗尽', '停因=预算耗尽')
const t8d = await get(`/tasks/${T8}`)
eq(t8d.json.task.pipeline.stopped?.reason, '预算耗尽', '停机留痕（预算）')
llmTokens = 42

/* ---- F5 成功指标：公式精确断言 + /state 回显 ---- */
{
  const ms = {
    tasks: [
      { id: 'A', archived: false, counters: { 封驳: 0 }, nodes: [{ kind: '施工', state: 'done' }] },
      { id: 'B', archived: false, counters: { 封驳: 2 }, nodes: [{ kind: '施工', state: 'done' }, { kind: '初审', state: 'done' }, { kind: '复审', state: 'done' }] },
      { id: 'C', archived: true, counters: { 封驳: 0 }, nodes: [{ kind: '施工', state: 'done' }] },
    ],
    audit: [
      { actor: 'user', action: 'triage', taskId: 'A' },
      { actor: 'system', action: 'start', taskId: 'A' },
    ],
  }
  const m = metricsOf(ms)
  eq(m.auto.done, 1, '指标①分子（A 有干预，B 零干预）')
  eq(m.auto.total, 2, '指标①分母（归档 C 不计）')
  eq(m.auto.rate, 0.5, '指标①全自动完成率 0.5')
  eq(m.reject.constructedTasks, 3, '指标②分母（做过施工含归档 C）')
  eq(m.reject.rejectedTasks, 1, '指标②分子（仅 B 发生过封驳）')
  ok(Math.abs(m.reject.rate - 1 / 3) < 0.01, '指标②封驳触发率 1/3')
  eq(m.reject.reviews, 2, '轮次（B 初审+复审）')
  eq(m.reject.density, 1, '轮次封驳密度 2/2')
  eq(m.intervention.count, 1, '指标③干预总数（system 不计）')
  ok(Math.abs(m.intervention.perTask - 1 / 3) < 0.01, '指标③每任务干预 1/3')
  const v = metricVerdicts(m)
  eq(v.auto.value, 50, 'verdict 换算百分比')
  eq(v.auto.ok, false, '50% < 80% 目标 → 不达标')
}
const stateFinal = await get('/state')
ok(stateFinal.json?.success?.auto && typeof stateFinal.json.success.auto.rate === 'number', '/state 回显 success 指标')
ok(stateFinal.json?.success?.reject && Array.isArray([stateFinal.json.success.reject]), '/state 指标结构完整')

/* ---- F6 直答档：中书令一轮承办 → 回复即交付（无施工/评审/独立交付步骤） ---- */
llmQueue.length = 0
llmQueue.push('这是直答内容：答案本身。')
const spawnsBeforeF6 = fakeSpawns.length
const t9 = await post('/tasks', { title: '直答任务', requirement: '纯问答', tier: '直' })
const T9 = t9.json.id
eq(t9.json?.task?.nodes?.map((x) => x.kind).join(','), '承办', '直答单节点（承办）')
eq(t9.json?.task?.nodes?.[0]?.role, '中书令', '承办角色默认中书令')
const r9 = await drive(T9)
const t9d = await get(`/tasks/${T9}`)
eq(t9d.json.task.nodes.map((x) => x.state).join(','), 'done', '承办 done')
ok(t9d.json.task.delivery?.text?.includes('答案本身'), '直答回复即交付')
eq(t9d.json.task.rounds[0].verdict, 'accepted', '直答轮次 accepted')
eq(fakeSpawns.length, spawnsBeforeF6, '直答不起子会话')
eq(t9d.json.task.budget.calls, 1, '直答预算：1 次 LLM 调用')
ok(r9.some((r) => r.step?.kind === 'complete'), '承办后直接收口')

/* ---- F7 S1 动态增派：拆解声明领域 → 插入礼部承办 → 施工 → 初审 → 交付 ---- */
llmQueue.length = 0
llmQueue.push(
  '诏令：改 x\n增派：礼部尚书 同步 CHANGELOG',
  '礼部回复：CHANGELOG 已同步。',
  '准',
  '交付报告：S1 完成。',
)
const spawnsBeforeF7 = fakeSpawns.length
const t10 = await post('/tasks', { title: 'S1 增派任务', requirement: '小改+文档', tier: 'S1' })
const T10 = t10.json.id
eq(t10.json?.task?.nodes?.map((x) => x.kind).join(','), '拆解,施工,初审', 'S1 初始 3 节点')
const r10 = await drive(T10)
const t10d = await get(`/tasks/${T10}`)
const t10kinds = t10d.json.task.nodes.map((x) => x.kind).join(',')
ok(t10kinds.startsWith('拆解,承办,施工'), '拆解后动态插入礼部承办节点')
eq(t10d.json.task.nodes.find((n) => n.role === '礼部尚书')?.state, 'done', '增派的礼部节点 done')
eq(t10d.json.task.team.includes('礼部尚书'), true, '编成并入礼部尚书')
eq(t10d.json.task.nodes.map((x) => x.state === 'done').every(Boolean), true, 'S1 增派后全部 done')
ok(t10d.json.task.delivery?.text?.includes('S1 完成'), '交付报告由 [交付] 步骤生成（增派承办不误触发交付）')
eq(fakeSpawns.length - spawnsBeforeF7, 1, 'S1 只有施工一个真子会话')
eq(t10d.json.task.budget.calls, 5, 'S1 预算调用（拆解/礼部承办/初审/交付 4 LLM + 1 子会话工具）')
ok(store.state.audit.some((a) => a.action === 'deputy-add' && a.taskId === T10), '动态增派有审计')

/* ---- F8 L 标准班子全流程：户部备环境/兵部部署/礼部文档都走真子会话 ---- */
llmQueue.length = 0
llmQueue.push('验收清单：- 完成', '诏令', '派单安排', '准', '准', '收口', '验收通过', '交付')
const t11 = await post('/tasks', { title: 'L 标准班子任务', requirement: '按需求完成', tier: 'L' })
const T11 = t11.json.id
eq(t11.json?.task?.nodes?.length, 11, 'L 11 节点')
const r11 = await drive(T11)
const t11d = await get(`/tasks/${T11}`)
eq(t11d.json.task.nodes.map((x) => x.state === 'done').every(Boolean), true, 'L 11 节点全部 done')
eq(t11d.json.task.nodes.filter((n) => n.role === '户部尚书' && n.state === 'done').length, 1, '户部备环境 done（真子会话）')
eq(t11d.json.task.nodes.filter((n) => n.role === '礼部尚书' && n.state === 'done').length, 1, '礼部文档 done（真子会话）')
eq(t11d.json.task.nodes.filter((n) => n.role === '兵部尚书' && n.state === 'done').length, 1, '兵部部署 done（真子会话）')
eq(t11d.json.task.budget.calls, 8 + 4, 'L 预算调用（8 LLM + 4 子会话工具）')
eq(t11d.json.task.budget.steps, 12, 'L 预算步数（11 节点 + 交付）')
ok(t11d.json.task.delivery?.text?.includes('交付'), 'L 交付报告')

/* ---- F9 XL 完整班子：门下前置 + 太史令审计 ---- */
llmQueue.length = 0
llmQueue.push('验收清单：- 完成', '诏令', '准', '派单安排', '准', '准', '收口', '经验卡：场景/坑点/解法', '验收通过', '交付')
const t12 = await post('/tasks', { title: 'XL 完整班子任务', requirement: '按需求完成', tier: 'XL' })
const T12 = t12.json.id
eq(t12.json?.task?.nodes?.map((x) => x.kind).join(','),
  '立项,拆解,前置评审,派单,备环境,施工,初审,复审,收口,部署,文档,审计,验收', 'XL 13 节点序列（门下前置/太史令审计就位）')
const r12 = await drive(T12)
const t12d = await get(`/tasks/${T12}`)
eq(t12d.json.task.nodes.map((x) => x.state === 'done').every(Boolean), true, 'XL 13 节点全部 done')
eq(t12d.json.task.nodes.find((n) => n.kind === '前置评审')?.state, 'done', '门下前置评审 done')
ok(t12d.json.task.nodes.find((n) => n.kind === '审计')?.docs?.some((d) => d.text.includes('经验卡')), '太史令审计产出经验卡')
ok(r12.some((r) => r.step?.kind === 'dispatch' && r.step?.node?.kind === '备环境'), '备环境走真子会话派发')
eq(t12d.json.task.budget.steps, 14, 'XL 预算步数（13 节点 + 交付）')

/* ---- F10 判级时机：fallback 任务流水线第一步 = LLM 主判（1+2 之类的直答单不再误落 M） ---- */
llmQueue.length = 0
llmReply = '直答 这是纯问答，不需要改代码'
const t13 = await post('/tasks', { title: '1+2 等于几', requirement: '1+2 等于几？' }) // 未判级 → fallback M
eq(t13.json?.task?.triage, 'M', '建单时仅兜底 M')
const r13 = await drive(t13.json.id)
const t13d = await get(`/tasks/${t13.json.id}`)
eq(t13d.json.task.triage, '直', '流水线首步 LLM 主判 → 直')
eq(t13d.json.task.triageBy, 'llm', 'triageBy = llm')
eq(t13d.json.task.nodes.map((x) => x.kind).join(','), '承办', '判成直答 → 重编排为承办单节点')
ok(t13d.json.task.delivery?.text?.includes('纯问答'), '直答交付')
ok(r13.some((r) => r.step?.kind === 'triaged'), '驱动里出现 triaged 步')
llmReply = 'S0 简单单点修改'

/* ---- G1 /npc 斜杠命令：result.kind 只能是宿主认识的 success / error ---- */
/* 回归：曾返回 kind:'text'，宿主 gateway 直接报 `unknown result kind "text"`，命令彻底不可用。 */
{
  const cmdHome = mkdtempSync(join(tmpdir(), 'dsh-onenpc-cmd-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = cmdHome
  const logLines = []
  const mounted = []
  let registration = null
  const fakeCtx = {
    logger: { info: (m) => logLines.push(String(m)), warn: () => {}, error: () => {} },
    get: () => undefined,
    on: () => () => {},
    effect: (fn) => {
      const dispose = fn?.()
      if (typeof dispose === 'function') mounted.push(dispose)
    },
    commands: { register: (def) => (registration = def) && (() => {}) },
    webServer: { register: () => () => {} },
  }
  try {
    apply(fakeCtx)
    ok(registration?.name === 'npc', '/npc 命令已注册到 ctx.commands')
    ok(
      logLines.some((line) => line.includes(cmdHome)),
      '/npc 用例隔离在临时 DSH_HOME（防写真实数据）',
    )
    const miss = await registration.handler({ rawInput: '' })
    eq(miss.kind, 'error', '空输入 → kind=error（宿主可识别）')
    const hit = await registration.handler({ rawInput: '中书令 核查登录接口的空指针' })
    eq(hit.kind, 'success', '建单成功 → kind=success（宿主可识别，不再是 text）')
    ok(typeof hit.text === 'string' && hit.text.includes('已立项'), '/npc 回执含任务号')
    let saved = null
    for (let i = 0; i < 20 && !saved?.tasks?.some((t) => t.origin === 'command'); i += 1) {
      await sleep(50)
      try {
        saved = JSON.parse(await readFile(join(cmdHome, 'onenpc', 'state.json'), 'utf8'))
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        saved = null
      }
    }
    ok(saved?.tasks?.some((t) => t.origin === 'command' && t.role === '中书令'), '/npc 建单落盘（origin=command, role=中书令）')
  } finally {
    for (const dispose of mounted) {
      try {
        dispose()
      } catch {
        /* 清理失败的 disposer 不影响判定 */
      }
    }
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  }
}

/* ================= 汇总 ================= */

if (bad.length) {
  console.error(`\nsmoke: ${n - bad.length}/${n} 项通过，${bad.length} 项失败：`)
  for (const name of bad) console.error(`  ✗ ${name}`)
  process.exit(1)
}
console.log(`smoke: ${n} 项，全部通过（数据 ${dir}；git 仓 ${repo}）`)
