/**
 * dsh-onenpc · 领域内核（纯函数层）
 *
 * 内容：
 *   - 12 角色注册表（移植自 npc-x `.cnb/settings.yml`，人设精简——禁注入完整总纲，
 *     对齐 npc-x §6.6-C「内联最小必要上下文」）
 *   - 任务判级（S0/S1/M/L/XL）与编成路由（判级三层：LLM 主判 / 默认 M 兜底 / 看板手动改）
 *   - 任务 / 节点 / 公文数据模型与最小状态机
 *   - 护栏进代码：节点顺序守卫（施工串行）、封驳计数、审计留痕（被拒动作也记）
 *
 * 纯函数纪律：本文件不碰时钟/网络/文件系统——now 一律由调用方传入（与 dsh-edict-demo 同约）。
 * 设计文档：analysis/02-design.md
 */

/* ============================== 角色 ============================== */

/**
 * 12 角色注册表。id === name（与 npc-x「NPC_ROLE 与角色名完全一致」铁律同源，零映射漂移）。
 * 三省 slogan 取自 npc-x settings.yml 原文，其余为职责精炼。
 */
export const ROLES = [
  {
    id: '中书令', name: '中书令', org: '中书省', isDispatcher: true,
    slogan: '三省六部总调度，一声令下全线开工',
    duty: '拆解需求、下诏令、仲裁冲突、验收交付；唯一合并权',
    soul: '【总NPC】你是「中书令」，多NPC体系的最高调度者（Orchestrator）。用户只说一句话需求，你负责全程无人值守地组织三省六部完成：拆解→开发→测试→评审→验收→交付。被单独 @ 即视为全权委托牵头，主动按需拉起所需角色，不反问、不停摆。不亲自写业务代码；一切冲突由你裁决并写入台账。',
  },
  {
    id: '门下侍中', name: '门下侍中', org: '门下省', isDispatcher: false,
    slogan: '封驳在手，质量不过关一律打回',
    duty: '独立评审，一票否决（封驳打回）',
    soul: '【评审】你是「门下侍中」，体系的独立审议者。评审只认 产出diff + 验收清单 + 独立可复现验证，不接受产出者自评作为通过证据。结论必须是明确的「准 / 驳 + 逐条理由」；发现硬伤直接封驳打回，注明必须修改的点。你不修改任何产出。',
  },
  {
    id: '尚书令', name: '尚书令', org: '尚书省', isDispatcher: false,
    slogan: '执行总管，派单跟踪汇总',
    duty: '接诏令→执行计划→派单→跟踪催办→汇总呈报',
    soul: '【执行总管】你是「尚书令」。接收诏令后制定执行计划、向六部派单、跟踪催办、汇总回奏。你不做技术决策，也不做质量裁决；冲突无法内部解决时上报中书令。',
  },
  {
    id: '吏部尚书', name: '吏部尚书', org: '六部', isDispatcher: false,
    slogan: '任务台账与分支管理',
    duty: '建任务/分支、更新台账、记录进度',
    soul: '【吏部】你负责任务台账与分支管理：为每个任务建档、维护状态与进度记录。不碰业务代码。',
  },
  {
    id: '户部尚书', name: '户部尚书', org: '六部', isDispatcher: false,
    slogan: '依赖、环境与资源',
    duty: '装依赖、配环境、控制成本',
    soul: '【户部】你负责依赖、环境与资源：安装依赖、准备运行环境、评估资源成本。密钥只进平台密钥库，严禁写入仓库或代码。',
  },
  {
    id: '礼部尚书', name: '礼部尚书', org: '六部', isDispatcher: false,
    slogan: '文档与规范',
    duty: 'README/CHANGELOG/提交规范与代码同步',
    soul: '【礼部】你负责文档与规范：保持 README/CHANGELOG 与代码同步，提交信息遵循约定格式。',
  },
  {
    id: '兵部尚书', name: '兵部尚书', org: '六部', isDispatcher: false,
    slogan: 'CI/CD 与部署运维',
    duty: '构建、发布、回滚',
    soul: '【兵部】你负责构建部署运维：执行构建、发布与健康检查，失败自动回滚并上报。未过质量门的东西禁止部署。',
  },
  {
    id: '刑部尚书', name: '刑部尚书', org: '六部', isDispatcher: false,
    slogan: '测试与质量审计',
    duty: '单测/集测/安全扫描',
    soul: '【刑部】你负责测试与质量审计：写并运行测试、做安全扫描。测试不过一律不准出部；你的通过结论要有独立可复现的验证证据。',
  },
  {
    id: '工部尚书', name: '工部尚书', org: '六部', isDispatcher: false,
    slogan: '开发与实现',
    duty: '写代码、重构、修 Bug',
    soul: '【工部】你负责开发实现：按诏令写代码、重构、修 Bug。只改诏令声明范围内文件，最小改动；完成前先本地验证，不假装完成。',
  },
  {
    id: '太史令', name: '太史令', org: '外协', isDispatcher: false,
    slogan: '知识库主编 · 越用越聪明',
    duty: '经验卡整合、开放摄取、复发审计、技能索引',
    soul: '【外协·协同】你是「太史令」，知识库主编：收集整理【经验卡】、开工先回放案例库、按需检索现成解法、做复发审计。不写业务代码。',
  },
  {
    id: '御史台', name: '御史台', org: '外协', isDispatcher: false,
    slogan: '独立监察 · 只查不改',
    duty: '查越范围/跳质量门/篡改验收清单',
    soul: '【外协·协同】你是「御史台」，独立监察：稽核越范围改动、跳质量门、篡改验收清单等行为。只查不改，产出弹劾文书交中书令裁决。',
  },
  {
    id: '翰林学士', name: '翰林学士', org: '外协', isDispatcher: false,
    slogan: '专职规划 · 交付即退出',
    duty: '只出规划书，不进执行链',
    soul: '【外协·协同】你是「翰林学士」：读需求出方案/规划书，交付即退出，不参与实施。',
  },
]

export const ROLE_NAMES = ROLES.map((r) => r.name)

export function findRole(name) {
  return ROLES.find((r) => r.name === name || r.id === name) ?? null
}

export const ORGS = [...new Set(ROLES.map((r) => r.org))]

/* ============================== 判级 ============================== */

export const TIERS = ['直', 'S0', 'S1', 'M', 'L', 'XL']

export const TIER_META = {
  直: { label: '直答', desc: '纯问答/内容产出，单角色一轮直出', team: '单角色直答' },
  S0: { label: '微小', desc: '单点直改，单兵直派', team: '单兵 + 自动审' },
  S1: { label: '小', desc: '单领域小改', team: '单兵 + 领域角色' },
  M: { label: '中', desc: '跨文件小特性', team: '精简班子' },
  L: { label: '大', desc: '多部协同特性', team: '标准班子' },
  XL: { label: '超大', desc: '体系级/多轮大需求', team: '完整班子' },
}

/** 判级兜底档：LLM 不可用/解析失败时落 M（精简班子、完整质量门） */
export const TRIAGE_FALLBACK = 'M'

/** 封驳断路器：单任务封驳计数达 3 即须换方案（npc-x §8 护栏②，M3 接停机逻辑） */
export const REJECT_CAP = 3

/** 公文正文上限（超出截断并标注） */
export const DOC_TEXT_CAP = 4000

/**
 * 判级 → 节点编成路由（**对齐 npc-x §8 状态机**）：
 *   - [0 立项] 在循环外（仅一次）：需求 → 验收清单；
 *   - 每轮循环（round）：拆解→派单→施工→初审→复审→收口→（部署）→验收；
 *     初审/复审不过 → 封驳打回施工（轮内循环，回到[2]）；验收不满足 → 差距写成新一轮目标（回[1]）；
 *   - S0/S1 单兵直改：无轮次循环（施工+刑部自动审）。
 * 节点带 round 字段；新轮节点由 appendRound 动态生成（轮次无上限，护栏跨轮累计）。
 */
export function roundKindsOf(tier) {
  if (tier === 'M') return ['拆解', '施工', '初审', '复审', '收口', '验收']
  // L 标准班子（npc-x §6.5）：尚书令派单 + 户部备环境 + 兵部部署 + 礼部文档
  if (tier === 'L') return ['拆解', '派单', '备环境', '施工', '初审', '复审', '收口', '部署', '文档', '验收']
  // XL 完整班子：门下前置（施工前审方案）+ 太史令学习审计
  if (tier === 'XL') return ['拆解', '前置评审', '派单', '备环境', '施工', '初审', '复审', '收口', '部署', '文档', '审计', '验收']
  return null // 直/S0/S1：无轮次循环（S1 拆解可增派领域角色）
}

function makeNode(kind, round) {
  return {
    id: '',
    kind,
    round,
    role: NODE_KIND_META[kind].role,
    state: 'pending',
    docs: [],
    artifacts: [],
    tokens: 0,
    calls: 0,
    startedAt: null,
    endedAt: null,
    stopReason: null,
    gitBaseline: null,
    sessionId: null,
  }
}

function withIds(nodes) {
  nodes.forEach((n, i) => { n.id = `N${i + 1}` })
  return nodes
}

export function planNodes(tier) {
  const roundKinds = roundKindsOf(tier)
  if (tier === '直') {
    // 直答：单「承办」节点，承接角色=入口角色（createTask/triageTask 负责覆写 role）
    return withIds([makeNode('承办', 1)])
  }
  if (tier === 'S1') {
    // S1 单领域小改：拆解定领域，可动态增派领域角色节点（npc-x「单兵+领域角色」）
    return withIds([makeNode('拆解', 1), makeNode('施工', 1), makeNode('初审', 1)])
  }
  if (!roundKinds) {
    return withIds([makeNode('施工', 1), makeNode('初审', 1)])
  }
  return withIds([makeNode('立项', 0), ...roundKinds.map((k) => makeNode(k, 1))])
}

/**
 * 动态增派（npc-x「动态增删」）：在指定节点之后插入一个「承办」节点（承接=指定角色，
 * 执行=askLLM 直出），用于拆解声明领域协作（环境/文档/安全等）。
 */
export function insertDeputyNode(task, afterNodeId, role, desc = '') {
  const idx = task.nodes.findIndex((n) => n.id === afterNodeId)
  if (idx < 0) return null
  if (!findRole(role)) return null
  const maxN = Math.max(0, ...task.nodes.map((n) => Number(String(n.id).slice(1)) || 0))
  const node = makeNode('承办', task.nodes[idx].round ?? 1)
  node.id = `N${maxN + 1}`
  node.role = role
  node.deputyFor = sanitizeText(desc, 120)
  task.nodes.splice(idx + 1, 0, node)
  task.team = [...new Set(task.nodes.map((n) => n.role))]
  return node
}

/** 追加一轮节点（验收不满足 → 差距写成新一轮目标，回[1]；npc-x §8 多轮循环） */
export function appendRound(task, goal = '') {
  const roundKinds = roundKindsOf(task.triage)
  if (!roundKinds) return null
  const now = new Date().toISOString()
  const rounds = task.rounds ?? (task.rounds = [])
  const current = rounds[rounds.length - 1]
  if (current) current.endedAt = current.endedAt ?? now
  const n = rounds.length + 1
  rounds.push({ n, goal: sanitizeText(goal, 300), startedAt: now, endedAt: null, verdict: 'pending' })
  const nodes = roundKinds.map((k) => makeNode(k, n))
  const base = task.nodes.length
  nodes.forEach((node, i) => { node.id = `N${base + i + 1}` })
  task.nodes.push(...nodes)
  return nodes
}

/** 编成 = 编成节点的承接角色去重（最小可用编成，防大炮打蚊子） */
export function planTeam(tier) {
  return [...new Set(planNodes(tier).map((n) => n.role))]
}

/* ============================== 节点 ============================== */

export const NODE_KINDS = ['立项', '拆解', '前置评审', '派单', '备环境', '施工', '初审', '复审', '收口', '部署', '文档', '审计', '验收', '承办']

export const NODE_KIND_META = {
  立项: { icon: '📋', role: '中书令', desc: '需求转验收清单（循环外，仅一次）' },
  拆解: { icon: '🧩', role: '中书令', desc: '拆本轮差距为诏令（可增派协作角色）' },
  前置评审: { icon: '📜', role: '门下侍中', desc: '门下前置：施工前审方案（XL）' },
  派单: { icon: '📮', role: '尚书令', desc: '派单建档备环境' },
  备环境: { icon: '🧰', role: '户部尚书', desc: '依赖与环境准备（真子会话）' },
  施工: { icon: '🛠️', role: '工部尚书', desc: '开发实现（真子会话）' },
  初审: { icon: '🔍', role: '刑部尚书', desc: '测试与安全审计' },
  复审: { icon: '⚖️', role: '门下侍中', desc: '独立评审准/驳' },
  收口: { icon: '📦', role: '中书令', desc: '质量门全过后收口（自动提交）' },
  部署: { icon: '🚀', role: '兵部尚书', desc: '部署验证（真子会话）' },
  文档: { icon: '📝', role: '礼部尚书', desc: '文档与 CHANGELOG 同步（真子会话）' },
  审计: { icon: '📚', role: '太史令', desc: '学习审计与经验卡（XL）' },
  验收: { icon: '✅', role: '中书令', desc: '对照清单逐条核：满足→交付，差距→新轮' },
  承办: { icon: '💬', role: '中书令', desc: '直答/增派：单角色一轮直出，回复即交付' },
}

export const NODE_STATES = ['pending', 'running', 'done', 'rejected', 'blocked', 'skipped']

export const NODE_STATE_META = {
  pending: { label: '待办', tone: 'muted' },
  running: { label: '进行中', tone: 'blue' },
  done: { label: '完成', tone: 'green' },
  rejected: { label: '封驳', tone: 'red' },
  blocked: { label: '受阻', tone: 'amber' },
  skipped: { label: '跳过', tone: 'muted' },
}

/* ============================== 公文 ============================== */

export const DOC_TYPES = ['诏令', '回奏', '封驳', '经验卡']

const DOC_CAP = 40

/* ============================== 指标口径 ============================== */

/**
 * 人工干预清单（成功指标 #3 的口径单源，见 analysis/02-design.md §十）：
 * audit 中 actor='user' 且 action 命中此集合的记录计为一次人工干预。
 * 清单写死在此，防「什么算干预」口径漂移。
 */
export const MANUAL_ACTIONS = new Set([
  'triage', 'start', 'done', 'reject', 'block', 'unblock', 'redo', 'skip',
  'archive', 'unarchive', 'doc', 'stop',
])

/** 任务预算初始值（M3 校准）：每 task 模型调用 / token / 步数硬顶 */
export const TASK_BUDGET = { calls: 24, tokens: 300_000, steps: 40 }

/* ============================== 清洗 ============================== */

/** 折空白 + 截断（对齐 dsh-edict-demo sanitizeText 思路；M0 不做剥代码块等重清洗） */
export function sanitizeText(raw, cap = DOC_TEXT_CAP) {
  const s = String(raw ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (s.length > cap) return s.slice(0, cap) + '…（已截断）'
  return s
}

/* ============================== 审计 ============================== */

const AUDIT_CAP = 800

/**
 * 追加一条审计：谁、何时、把哪件事从什么推到什么。
 * 被拒绝的动作同样留痕（result:'denied'），事后可查「谁想绕过门下」。
 */
export function appendAudit(state, entry) {
  if (!Array.isArray(state.audit)) state.audit = []
  const record = {
    at: new Date().toISOString(),
    actor: 'user',
    action: 'unknown',
    taskId: null,
    title: '',
    nodeId: null,
    from: null,
    to: null,
    remark: '',
    result: 'ok',
    ...entry,
  }
  state.audit.push(record)
  if (state.audit.length > AUDIT_CAP) state.audit.splice(0, state.audit.length - AUDIT_CAP)
  return record
}

/* ============================== 任务 ============================== */

export const ORIGINS = ['board', 'command', 'mention']

export const ORIGIN_META = {
  board: { label: '看板下旨', icon: '📜' },
  command: { label: '/npc 命令', icon: '⌨️' },
  mention: { label: '@提及', icon: '📨' },
}

function fail(code, message, status = 400) {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

export function nextTaskId(state) {
  if (!state.seq || typeof state.seq.task !== 'number') state.seq = { task: 0 }
  state.seq.task += 1
  return `TASK-${state.seq.task}`
}

export function findTask(state, id) {
  return state.tasks.find((t) => t.id === id) ?? null
}

/**
 * 建任务（下旨）。判级三层中的 ②③ 在此落地：
 *   - 未指定 tier → 默认 M 档兜底（triageBy='fallback'）；
 *   - 指定 tier   → 手动指定（triageBy='manual'）。
 * ① LLM 主判在流水线第一步执行（judgeTriage，pipeline.js）；手动交办前也会兜底再判一次。
 */
export function createTask(state, input = {}, now = new Date().toISOString()) {
  const title = sanitizeText(input.title, 120)
  if (title.length < 2) throw fail('title_too_short', '标题至少 2 个字（当面下旨常很短，门槛刻意低）')
  const requirement = sanitizeText(input.requirement ?? '', 4000)
  if (input.origin && !ORIGINS.includes(input.origin)) {
    throw fail('bad_origin', `origin 须是 ${ORIGINS.join('/')}`)
  }
  if (input.role && !findRole(input.role)) {
    throw fail('unknown_role', `角色「${input.role}」未注册`)
  }
  let tier = TRIAGE_FALLBACK
  let triageBy = 'fallback'
  let triageReason = `默认 M 档兜底（流水线第一步 LLM 主判）`
  if (input.tier) {
    if (!TIERS.includes(input.tier)) throw fail('bad_tier', `判级须是 ${TIERS.join('/')}`)
    tier = input.tier
    triageBy = 'manual'
    triageReason = '下旨时手动指定'
  }
  const task = {
    id: nextTaskId(state),
    title,
    requirement,
    origin: input.origin || 'board',
    role: input.role || '中书令',
    triage: tier,
    triageBy,
    triageReason,
    team: planTeam(tier),
    nodes: planNodes(tier),
    // npc-x §8：验收清单（立项产出，唯一增删权=调度方）；轮次；交付报告
    acceptance: [],
    rounds: [{ n: 1, goal: '', startedAt: now, endedAt: null, verdict: 'pending' }],
    delivery: null,
    counters: { 封驳: 0, 自愈: 0 },
    archived: false,
    createdAt: now,
    updatedAt: now,
  }
  // 直答单：承办节点承接角色 = 入口角色（中书令/@ 的角色）
  if (tier === '直') {
    task.nodes[0].role = task.role
    task.team = [...new Set(task.nodes.map((n) => n.role))]
  }
  state.tasks.push(task)
  appendAudit(state, {
    action: 'create',
    taskId: task.id,
    title: task.title,
    to: 'created',
    remark: `判级 ${tier}（${triageBy}）· ${task.nodes.length} 节点 · 编成 ${task.team.join('、')}`,
  })
  return task
}

const TRANSITIONS = {
  start: { from: ['pending'], to: 'running' },
  done: { from: ['running'], to: 'done' },
  // reject 允许从 running（评审中断在办）或 done（施工完成后被门下/刑部打回）——封驳计数都 +1
  reject: { from: ['running', 'done'], to: 'rejected' },
  block: { from: ['pending', 'running'], to: 'blocked' },
  unblock: { from: ['blocked'], to: 'pending' },
  // redo：回到待办（而非 running）——否则流水线 nextStep 会把「已打回未派发」误判为在办而空等
  redo: { from: ['rejected'], to: 'pending' },
  skip: { from: ['pending'], to: 'skipped' },
  // reopen：评审轮驳回后，评审节点回到待办（等下一轮施工完成再评审）
  reopen: { from: ['running'], to: 'pending' },
}

export const NODE_ACTIONS = Object.keys(TRANSITIONS)

/**
 * 节点状态推进（动作层）。
 * 护栏进代码：
 *   - 顺序守卫：start/redo 要求前置节点全部 done|skipped（同 task 施工节点串行由此保证，
 *     是 diff 可归因的前提，见 analysis/02-design.md §五「diff 产物捕获」）；
 *   - reject 递增封驳计数并写停因；
 *   - 一切动作写审计。
 */
export function advanceNode(state, task, nodeId, action, opts = {}) {
  if (task.archived) throw fail('archived', '任务已归档，先取消归档再操作', 409)
  const node = task.nodes.find((n) => n.id === nodeId)
  if (!node) throw fail('node_not_found', `节点 ${nodeId} 不存在`, 404)
  const rule = TRANSITIONS[action]
  if (!rule) throw fail('unknown_action', `未知动作 ${action}（可用：${NODE_ACTIONS.join('/')}）`)
  if (!rule.from.includes(node.state)) {
    const fromLabel = NODE_STATE_META[node.state]?.label ?? node.state
    throw fail('bad_transition', `动作 ${action} 不适用于「${node.kind}」的当前状态（${fromLabel}）`, 409)
  }
  if (action === 'start' || action === 'redo') {
    const idx = task.nodes.indexOf(node)
    const blocker = task.nodes.slice(0, idx).find((n) => n.state !== 'done' && n.state !== 'skipped')
    if (blocker) throw fail('order_guard', `前置节点「${blocker.kind}」未完成，流程串行`, 409)
  }
  const from = node.state
  const now = opts.now ?? new Date().toISOString()
  node.state = rule.to
  if (rule.to === 'running' && !node.startedAt) node.startedAt = now
  if (['done', 'rejected', 'skipped'].includes(rule.to)) node.endedAt = now
  if (action === 'unblock' || action === 'redo' || action === 'reopen') node.endedAt = null
  if (action === 'reject') {
    task.counters.封驳 += 1
    node.stopReason = sanitizeText(opts.remark ?? '', 200) || '评审未过'
  }
  task.updatedAt = now
  appendAudit(state, {
    action,
    taskId: task.id,
    title: task.title,
    nodeId,
    from,
    to: rule.to,
    actor: opts.actor ?? 'user',
    remark: sanitizeText(opts.remark ?? '', 200),
  })
  return node
}

/**
 * 改级（判级三层之 ③）。by: 'llm' | 'fallback' | 'manual'。
 * 全部节点尚待办 → 按新档重排编成；有在途节点 → 在途不回溯，仅影响后续派发（留痕）。
 */
export function triageTask(state, task, tier, by = 'manual', reason = '', now = new Date().toISOString()) {
  if (!TIERS.includes(tier)) throw fail('bad_tier', `判级须是 ${TIERS.join('/')}`)
  if (!['llm', 'fallback', 'manual'].includes(by)) throw fail('bad_triage_by', 'by 须是 llm/fallback/manual')
  const from = task.triage
  if (from === tier && task.triageBy === by) return false
  task.triage = tier
  task.triageBy = by
  task.triageReason = sanitizeText(reason, 200) || (TIER_META[tier]?.team ?? '')
  task.updatedAt = now
  if (task.nodes.every((n) => n.state === 'pending')) {
    task.nodes = planNodes(tier)
    // 直答单重排后：承办角色仍取任务入口角色
    if (tier === '直') task.nodes[0].role = task.role || '中书令'
    task.team = [...new Set(task.nodes.map((n) => n.role))]
    appendAudit(state, {
      action: 'triage',
      taskId: task.id,
      title: task.title,
      from,
      to: tier,
      actor: by,
      remark: `重排编成（${task.nodes.length} 节点）· ${task.triageReason}`,
    })
  } else {
    appendAudit(state, {
      action: 'triage',
      taskId: task.id,
      title: task.title,
      from,
      to: tier,
      actor: by,
      remark: '在途节点不回溯，仅影响后续派发',
    })
  }
  return true
}

/** 节点追加公文（诏令/回奏/封驳/经验卡）。封驳计数由 reject 动作统一递增，公文只留痕（防双计）。 */
export function addDoc(state, task, nodeId, doc = {}, now = new Date().toISOString()) {
  if (task.archived) throw fail('archived', '任务已归档', 409)
  const node = task.nodes.find((n) => n.id === nodeId)
  if (!node) throw fail('node_not_found', `节点 ${nodeId} 不存在`, 404)
  if (!DOC_TYPES.includes(doc.type)) throw fail('bad_doc_type', `公文类型须是 ${DOC_TYPES.join('/')}`)
  const text = sanitizeText(doc.text, DOC_TEXT_CAP)
  if (!text) throw fail('empty_doc', '公文正文为空')
  node.docs.push({
    type: doc.type,
    from: sanitizeText(doc.from ?? '', 40) || null,
    to: sanitizeText(doc.to ?? '', 40) || null,
    text,
    at: now,
    actor: doc.actor ?? 'user',
  })
  if (node.docs.length > DOC_CAP) node.docs.splice(0, node.docs.length - DOC_CAP)
  task.updatedAt = now
  appendAudit(state, {
    action: 'doc',
    taskId: task.id,
    title: task.title,
    nodeId,
    actor: doc.actor ?? 'user',
    remark: `${doc.type}（${text.length} 字）`,
  })
  return node.docs[node.docs.length - 1]
}

/** 验收清单更新（唯一增删权=调度方；执行/评审节点只许标 pass/fail 给证据） */
export function acceptanceSet(task, items) {
  task.acceptance = (items ?? []).slice(0, 20).map((x) => ({
    text: sanitizeText(typeof x === 'string' ? x : x?.text ?? '', 160),
    state: x?.state === 'pass' || x?.state === 'fail' ? x.state : 'todo',
  })).filter((x) => x.text)
  return task.acceptance
}

export function acceptanceMarkAll(task, state) {
  for (const item of task.acceptance ?? []) item.state = state
  return task.acceptance
}

/* ============================== 流水线状态与预算 ============================== */

/**
 * 任务级流水线状态（M3）：{ auto, stopped: null | {reason, why, at} }。
 * 停机后须人工「重开」（可同时归零封驳计数＝断路器 reset）。
 */
export function pipelineOf(task) {
  if (!task.pipeline || typeof task.pipeline !== 'object') task.pipeline = { auto: false, stopped: null }
  return task.pipeline
}

export function stopPipeline(task, reason, why) {
  const p = pipelineOf(task)
  p.auto = false
  p.stopped = { reason: String(reason ?? 'unknown').slice(0, 60), why: sanitizeText(why ?? '', 200), at: new Date().toISOString() }
  return p
}

export function resumePipeline(task, { resetBreaker = false } = {}) {
  const p = pipelineOf(task)
  p.stopped = null
  p.auto = true
  if (resetBreaker && task.counters) task.counters.封驳 = 0
  return p
}

/** 累计任务预算用量（执行回写与评审 LLM 调用都走这里） */
export function noteBudget(task, { calls = 0, tokens = 0 } = {}) {
  if (!task.budget || typeof task.budget !== 'object') task.budget = { calls: 0, tokens: 0, steps: 0 }
  task.budget.calls += calls
  task.budget.tokens += tokens
  return task.budget
}

export function noteBudgetStep(task) {
  if (!task.budget || typeof task.budget !== 'object') task.budget = { calls: 0, tokens: 0, steps: 0 }
  task.budget.steps += 1
  return task.budget
}

/** 预算闸门（npc-x §6.6 精神：宁中止不可无界烧）：任一维超 TASK_BUDGET 即超限 */
export function budgetExceeded(task) {
  const b = task.budget ?? {}
  return {
    calls: (b.calls ?? 0) > TASK_BUDGET.calls,
    tokens: (b.tokens ?? 0) > TASK_BUDGET.tokens,
    steps: (b.steps ?? 0) > TASK_BUDGET.steps,
  }
}

/* ============================== 视图辅助 ============================== */

/**
 * 下一个可派发节点：第一个 pending 且前置全部 done|skipped 的节点（串行守卫）。
 * 没有可派发节点返回 null。
 */
export function nextDispatchableNode(task) {
  const nodes = task.nodes ?? []
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]
    if (node.state !== 'pending') continue
    const blocker = nodes.slice(0, i).find((p) => p.state !== 'done' && p.state !== 'skipped')
    return blocker ? null : node
  }
  return null
}

export function taskProgress(task) {
  const total = task.nodes.length
  const done = task.nodes.filter((n) => n.state === 'done' || n.state === 'skipped').length
  const running = task.nodes.filter((n) => n.state === 'running').length
  const rejected = task.nodes.filter((n) => n.state === 'rejected').length
  const blocked = task.nodes.filter((n) => n.state === 'blocked').length
  return { total, done, running, rejected, blocked, pct: total ? Math.round((done / total) * 100) : 0 }
}

/* ============================== 种子数据 ============================== */

/** 种子状态：两单演示任务（一单 L 级跑到施工、一单 M 级吃过一次封驳）。 */
export function seedState(now = new Date().toISOString()) {
  const state = {
    version: 1,
    updatedAt: now,
    lastChange: { reason: 'seed', at: now },
    seq: { task: 0 },
    tasks: [],
    audit: [],
    meta: { modelOverrides: {}, pipelineMode: 'off', defaultRole: '中书令' },
  }
  const t1 = createTask(state, {
    title: '示例 · 给后台管理加数据导出（CSV/Excel）',
    requirement: '后台管理系统增加数据导出功能：支持 CSV 与 Excel 两种格式，可勾选导出字段，大表分批导出。',
    origin: 'board',
    tier: 'L',
  }, now)
  t1.triageReason = '种子演示数据'
  advanceNode(state, t1, 'N1', 'start', { actor: '中书令', now })
  advanceNode(state, t1, 'N1', 'done', { actor: '中书令', remark: '验收清单已入台账', now })
  advanceNode(state, t1, 'N2', 'start', { actor: '中书令', now })
  advanceNode(state, t1, 'N2', 'done', { actor: '中书令', remark: '拆为 3 条诏令', now })
  advanceNode(state, t1, 'N3', 'start', { actor: '尚书令', now })
  advanceNode(state, t1, 'N3', 'done', { actor: '尚书令', remark: '工部承接、户部备环境', now })
  advanceNode(state, t1, 'N4', 'start', { actor: '户部尚书', now })
  advanceNode(state, t1, 'N4', 'done', { actor: '户部尚书', remark: '依赖与环境就绪', now })
  advanceNode(state, t1, 'N5', 'start', { actor: '工部尚书', now })
  addDoc(state, t1, 'N1', {
    type: '诏令', from: '中书令', to: '工部尚书', actor: '中书令',
    text: '【诏令】目标：数据导出功能。范围：src/export/**、README。验收：CSV/Excel 双格式可下载；字段可勾选；1 万行内 5 秒出件。禁止：越范围改动。',
  }, now)

  const t2 = createTask(state, {
    title: '示例 · 修复登录页深色模式对比度',
    requirement: '深色模式下登录页按钮与输入框对比度不足，按 WCAG AA 调整。',
    origin: 'mention',
    tier: 'M',
  }, now)
  t2.triageReason = '种子演示数据'
  advanceNode(state, t2, 'N1', 'start', { actor: '中书令', now })
  advanceNode(state, t2, 'N1', 'done', { actor: '中书令', remark: '单点修复', now })
  advanceNode(state, t2, 'N2', 'start', { actor: '工部尚书', now })
  advanceNode(state, t2, 'N2', 'done', { actor: '工部尚书', now })
  advanceNode(state, t2, 'N3', 'start', { actor: '刑部尚书', now })
  advanceNode(state, t2, 'N3', 'reject', { actor: '刑部尚书', remark: '深色模式下仍用 #999 文本，对比度不足', now })
  addDoc(state, t2, 'N3', {
    type: '封驳', from: '刑部尚书', to: '工部尚书', actor: '刑部尚书',
    text: '【封驳】结论：驳回。理由：1) 提示文本 #999 不满足 AA；2) 未处理聚焦态边框。要求：改用 #A8B3C4 以上并补聚焦态。',
  }, now)
  return state
}
