/**
 * dsh-onenpc · 领域层自检（纯函数，无 IO，毫秒级）
 * 覆盖：角色注册表 / 判级与编成路由 / 任务状态机与顺序守卫 / 改级 / 公文 / 审计 / 清洗
 * 运行：node scripts/domain-test.mjs
 */

import {
  ROLES, ROLE_NAMES, findRole, ORGS,
  TIERS, TIER_META, TRIAGE_FALLBACK, REJECT_CAP,
  NODE_KINDS, NODE_STATES, NODE_STATE_META, NODE_ACTIONS,
  DOC_TYPES, MANUAL_ACTIONS, TASK_BUDGET,
  sanitizeText, appendAudit, ORIGINS,
  nextTaskId, findTask, createTask, advanceNode, triageTask, addDoc,
  taskProgress, planNodes, planTeam, seedState, nextDispatchableNode,
  pipelineOf, stopPipeline, resumePipeline, noteBudget, noteBudgetStep, budgetExceeded,
  appendRound, acceptanceSet, insertDeputyNode,
} from '../lib/domain.js'

let n = 0
const bad = []
const ok = (cond, name) => {
  n += 1
  if (!cond) bad.push(name)
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name}（got ${JSON.stringify(a)}）`)
const throws = (fn, code, name) => {
  try {
    fn()
    ok(false, `${name}（未抛错）`)
  } catch (error) {
    ok(error?.code === code, `${name}（got ${error?.code ?? '非代码错误'}）`)
  }
}

/* ---------------- 角色注册表 ---------------- */
eq(ROLES.length, 12, '角色数量 = 12')
eq(new Set(ROLES.map((r) => r.id)).size, 12, '角色 id 唯一')
ok(ROLES.every((r) => r.id === r.name), 'id === name（零映射漂移）')
ok(ROLES.every((r) => r.slogan && r.duty && r.soul && r.org), '每角色有 slogan/duty/soul/org')
ok(ROLES.filter((r) => r.isDispatcher).length === 1 && ROLES[0].isDispatcher, '唯一调度者 = 中书令')
ok(findRole('中书令')?.org === '中书省', 'findRole 命中')
ok(findRole('不存在的角色') === null, 'findRole 未命中返回 null')
eq(ORGS.sort().join(','), '中书省,六部,外协,尚书省,门下省', '机构枚举')

/* ---------------- 判级与编成 ---------------- */
eq(TIERS.join('/'), '直/S0/S1/M/L/XL', '判级档位（直答打头）')
ok(TRIAGE_FALLBACK === 'M', '兜底档 = M')
eq(NODE_KINDS.length, 14, '节点种类 = 14（§8 + 直答承办 + 前置评审/备环境/文档/审计）')
eq(NODE_STATES.join('/'), 'pending/running/done/rejected/blocked/skipped', '节点状态枚举')
eq(planNodes('S0').map((x) => x.kind).join(','), '施工,初审', 'S0 编成节点')
eq(planNodes('S1').map((x) => x.kind).join(','), '拆解,施工,初审', 'S1 编成节点（拆解定领域，可增派）')
eq(planNodes('M').map((x) => x.kind).join(','), '立项,拆解,施工,初审,复审,收口,验收', 'M 编成节点（§8：立项在循环外 + 轮内含收口/验收）')
eq(planNodes('L').length, 11, 'L 全流程 11 节点（立项 + 10：户部备环境/礼部文档进标准班子）')
eq(planNodes('XL').map((x) => x.kind).join(','), '立项,拆解,前置评审,派单,备环境,施工,初审,复审,收口,部署,文档,审计,验收', 'XL 节点序列（门下前置 + 太史令审计）')
eq(planNodes('M')[0].kind, '立项', 'M[0] = 立项（循环外）')
eq(planNodes('M')[2].role, '工部尚书', '施工默认工部')
eq(planNodes('M')[3].role, '刑部尚书', '初审默认刑部')
eq(planNodes('M')[4].role, '门下侍中', '复审默认门下')
eq(planNodes('M')[6].role, '中书令', '验收默认中书令')
ok(planNodes('M').every((x) => x.round === (x.kind === '立项' ? 0 : 1)), '立项 round=0，首轮 round=1')
ok(planNodes('M').every((x) => x.state === 'pending' && Array.isArray(x.docs) && Array.isArray(x.artifacts) && x.gitBaseline === null), '节点默认字段齐备')
eq(planTeam('S0').join(','), '工部尚书,刑部尚书', 'S0 编成 = 工部+刑部（去重）')
eq(planTeam('XL').length, 9, 'XL 编成去重后 9 角色（完整班子含户/礼/太史令）')

/* ---------------- 种子状态 ---------------- */
const state = seedState('2026-11-01T08:00:00.000Z')
eq(state.tasks.length, 2, '种子 2 单')
ok(state.version === 1, '种子版本 1')
eq(findTask(state, 'TASK-1').triage, 'L', '种子单1判级 L')
eq(findTask(state, 'TASK-1').nodes.length, 11, '种子单1有 11 节点')
eq(findTask(state, 'TASK-1').nodes[4].state, 'running', '种子单1施工进行中（N5）')
eq(findTask(state, 'TASK-2').counters.封驳, 1, '种子单2封驳计数 1')
eq(findTask(state, 'TASK-2').nodes[2].state, 'rejected', '种子单2初审被驳')
ok(state.audit.some((a) => a.action === 'reject' && a.result === 'ok'), '封驳动作有审计')
ok(state.audit.some((a) => a.action === 'doc' && a.remark.includes('封驳')), '封驳公文有审计')

/* ---------------- 建任务 ---------------- */
const t3 = createTask(state, { title: '测试任务甲', requirement: '  要求  <b>折行</b>\n\n\n缩进   测试 ' })
eq(t3.id, 'TASK-3', '任务号自增')
eq(t3.triage, 'M', '未指定判级 → M 兜底')
eq(t3.triageBy, 'fallback', 'triageBy = fallback')
eq(t3.origin, 'board', '默认来源 board')
eq(t3.role, '中书令', '默认入口角色 中书令')
eq(t3.nodes.length, 7, 'M 档 7 节点（立项+6 循环）')
ok(t3.rounds?.length === 1 && t3.rounds[0].n === 1, '初始 1 轮')
ok(Array.isArray(t3.acceptance) && t3.acceptance.length === 0, '验收清单初始空（立项产出）')
ok(t3.requirement === '要求 <b>折行</b>\n\n缩进 测试', '需求正文折空白')
throws(() => createTask(state, { title: 'a' }), 'title_too_short', '标题过短拒')
throws(() => createTask(state, { title: '合法标题', tier: 'XXL' }), 'bad_tier', '非法判级拒')
throws(() => createTask(state, { title: '合法标题', origin: 'weird' }), 'bad_origin', '非法来源拒')
throws(() => createTask(state, { title: '合法标题', role: '太上皇' }), 'unknown_role', '未注册角色拒')
const t4 = createTask(state, { title: '单兵直改任务', tier: 'S0', origin: 'command' })
eq(t4.triageBy, 'manual', '指定判级 → manual')
eq(t4.nodes.map((x) => x.kind).join(','), '施工,初审', 'S0 节点序列')
eq(nextTaskId(state), 'TASK-5', 'nextTaskId 继续自增')

/* ---------------- 节点状态机 ---------------- */
throws(() => advanceNode(state, t3, 'N9', 'start'), 'node_not_found', '不存在节点拒')
throws(() => advanceNode(state, t3, 'N1', 'explode'), 'unknown_action', '未知动作拒')
advanceNode(state, t3, 'N1', 'start', { now: '2026-11-01T09:00:00.000Z' })
eq(t3.nodes[0].state, 'running', 'start → running')
ok(t3.nodes[0].startedAt === '2026-11-01T09:00:00.000Z', 'startedAt 落值')
throws(() => advanceNode(state, t3, 'N2', 'start'), 'order_guard', '前置未完成不得开工（施工串行）')
advanceNode(state, t3, 'N1', 'done', { now: '2026-11-01T09:10:00.000Z' })
ok(t3.nodes[0].endedAt === '2026-11-01T09:10:00.000Z', 'endedAt 落值')
throws(() => advanceNode(state, t3, 'N1', 'done'), 'bad_transition', '重复 done 拒')
advanceNode(state, t3, 'N2', 'start')
advanceNode(state, t3, 'N2', 'reject', { remark: '对比度不足', now: '2026-11-01T09:20:00.000Z' })
eq(t3.nodes[1].state, 'rejected', 'reject → rejected')
eq(t3.counters.封驳, 1, '封驳计数 +1')
eq(t3.nodes[1].stopReason, '对比度不足', '停因留痕')
advanceNode(state, t3, 'N2', 'redo')
eq(t3.nodes[1].state, 'pending', 'redo → pending（回待办等派发）')
ok(t3.nodes[1].endedAt === null, 'redo 清 endedAt')
advanceNode(state, t3, 'N2', 'block')
eq(t3.nodes[1].state, 'blocked', 'block → blocked')
advanceNode(state, t3, 'N2', 'unblock')
eq(t3.nodes[1].state, 'pending', 'unblock → pending')
throws(() => advanceNode(state, t3, 'N2', 'done'), 'bad_transition', 'pending 不可直接 done')
advanceNode(state, t3, 'N2', 'skip')
eq(t3.nodes[1].state, 'skipped', 'skip → skipped（从 pending）')
advanceNode(state, t3, 'N3', 'start')
eq(t3.nodes[2].state, 'running', '跳过后后继可开工（skip 视同通过）')
throws(() => advanceNode(state, t3, 'N3', 'start'), 'bad_transition', 'running 不可再 start')

/* ---------------- 归档守卫 ---------------- */
const t5 = createTask(state, { title: '归档守卫任务' })
advanceNode(state, t5, 'N1', 'block')
t5.archived = true
throws(() => advanceNode(state, t5, 'N1', 'unblock'), 'archived', '归档任务拒操作')
throws(() => addDoc(state, t5, 'N1', { type: '回奏', text: 'x' }), 'archived', '归档任务拒公文')
t5.archived = false
advanceNode(state, t5, 'N1', 'unblock')

/* ---------------- 改级 ---------------- */
ok(triageTask(state, t3, 'M', 'fallback', '维持') === false, '同档同级 no-op')
throws(() => triageTask(state, t3, 'ZZ'), 'bad_tier', '改级非法档拒')
throws(() => triageTask(state, t3, 'L', 'bogus'), 'bad_triage_by', '改级非法来源拒')
ok(triageTask(state, t3, 'XL', 'manual', '升格全流程') === true, '改级生效')
eq(t3.triageBy, 'manual', 'triageBy = manual')
// 有在途节点（N3 running）→ 不回溯
ok(t3.nodes.length === 7 && t3.nodes[0].state === 'done', '在途节点不回溯')
ok(state.audit.some((a) => a.action === 'triage' && a.remark.includes('不回溯')), '不回溯有留痕')
const t6 = createTask(state, { title: '全待办改级任务' })
triageTask(state, t6, 'XL', 'llm', '多部协同、多轮验收')
eq(t6.nodes.length, 13, '全待办任务改级即重排 13 节点')
eq(t6.triageBy, 'llm', 'triageBy = llm')
eq(t6.team.length, 9, 'XL 编成去重后 9 角色')

/* ---------------- 公文 ---------------- */
throws(() => addDoc(state, t5, 'N1', { type: '密旨', text: 'x' }), 'bad_doc_type', '非法公文类型拒')
throws(() => addDoc(state, t5, 'N1', { type: '回奏', text: '   ' }), 'empty_doc', '空正文拒')
throws(() => addDoc(state, t5, 'N99', { type: '回奏', text: 'x' }), 'node_not_found', '公文节点不存在拒')
const before = t5.counters.封驳
addDoc(state, t5, 'N1', { type: '封驳', from: '门下侍中', to: '工部尚书', text: '驳回：越范围改动' })
eq(t5.counters.封驳, before, '封驳公文不重复计数（计数随 reject 动作走）')
addDoc(state, t5, 'N1', { type: '回奏', text: 'x'.repeat(5000) })
eq(t5.nodes[0].docs[1].text.length, 4000 + '…（已截断）'.length, '公文正文截断标注')
eq(taskProgress(t3).running, 1, '进度视图 running 计数')

/* ---------------- 清洗 / 审计 / 口径常量 ---------------- */
eq(sanitizeText('a\r\n\n\n\nb\t\tc   d'), 'a\n\nb c d', '清洗折空白')
ok(sanitizeText('x'.repeat(10), 5).endsWith('（已截断）'), '清洗上限截断')
eq(ORIGINS.join('/'), 'board/command/mention', '任务来源枚举')
ok(MANUAL_ACTIONS instanceof Set && MANUAL_ACTIONS.has('triage') && MANUAL_ACTIONS.has('doc') && !MANUAL_ACTIONS.has('create'), '干预清单口径（create 不算干预）')
ok(TASK_BUDGET.calls > 0 && TASK_BUDGET.tokens > 0, '预算常量在位')
ok(REJECT_CAP === 3, '封驳断路器 = 3')
// 审计上限
const fat = seedState()
for (let i = 0; i < 900; i += 1) appendAudit(fat, { action: 'noop' })
eq(fat.audit.length, 800, '审计上限 800 条')

/* ---------------- 派发辅助 ---------------- */
{
  const st = seedState()
  const t = createTask(st, { title: '派发辅助任务', tier: 'M' })
  eq(nextDispatchableNode(t)?.id, 'N1', '全待办 → 首节点可派发')
  advanceNode(st, t, 'N1', 'start')
  eq(nextDispatchableNode(t), null, '首节点 running → 无可派发（串行）')
  advanceNode(st, t, 'N1', 'done')
  eq(nextDispatchableNode(t)?.id, 'N2', '首节点 done → 下一节点可派发')
  const done = createTask(st, { title: '全完成派发任务', tier: 'S0' })
  for (const n of done.nodes) {
    advanceNode(st, done, n.id, 'start')
    advanceNode(st, done, n.id, 'done')
  }
  eq(nextDispatchableNode(done), null, '全完成 → null')
}

/* ---------------- 动态增派（S1 领域角色 / npc-x 动态增删） ---------------- */
{
  const st = seedState()
  const t = createTask(st, { title: '增派机制任务', requirement: '单领域小改+文档', tier: 'S1' })
  eq(t.nodes.map((x) => x.kind).join(','), '拆解,施工,初审', 'S1 初始 3 节点')
  const added = insertDeputyNode(t, 'N1', '礼部尚书', '同步 CHANGELOG')
  ok(added && added.id === 'N4' && added.kind === '承办' && added.role === '礼部尚书', '拆解后插入承办节点（礼部）')
  eq(t.nodes.map((x) => x.kind).join(','), '拆解,承办,施工,初审', '增派节点排在拆解之后施工之前')
  eq(t.team.join(','), '中书令,礼部尚书,工部尚书,刑部尚书', '编成自动并入礼部')
  ok(added.deputyFor === '同步 CHANGELOG', '增派任务说明留痕')
  eq(insertDeputyNode(t, 'N9', '礼部尚书', 'x'), null, '锚点不存在 → null')
  eq(insertDeputyNode(t, 'N1', '太上皇', 'x'), null, '未注册角色 → null')
}

/* ---------------- M3：打回 done 节点 / reopen / 流水线状态 / 预算 ---------------- */
{
  const st = seedState()
  const t = createTask(st, { title: 'M3 机制任务', tier: 'M' })
  // §8 轮次：验收不满足 → appendRound 生成新一轮节点（差距目标）
  eq(t.rounds.length, 1, '初始 1 轮')
  const before = t.nodes.length
  const added = appendRound(t, '对比度仍差一档')
  eq(t.rounds.length, 2, '追加第 2 轮')
  eq(t.rounds[1].goal, '对比度仍差一档', '新轮目标=差距')
  eq(added.length, 6, 'M 档新轮 6 节点')
  eq(t.nodes.length, before + 6, '节点追加')
  eq(t.nodes[before].round, 2, '新节点 round=2')
  eq(t.nodes[before].kind, '拆解', '新轮从[1 拆解]开始（回[1]）')
  ok(t.rounds[0].endedAt !== null, '旧轮收束')
  const s0t = createTask(st, { title: 'S0 无轮次', tier: 'S0' })
  eq(appendRound(s0t, 'x'), null, 'S0/S1 无轮次循环')
  ok(NODE_ACTIONS.includes('reopen'), 'NODE_ACTIONS 含 reopen')
  advanceNode(st, t, 'N1', 'start')
  advanceNode(st, t, 'N1', 'done')
  // done 节点可被评审打回（封驳计数 +1）
  const beforeReject = t.counters.封驳
  advanceNode(st, t, 'N1', 'reject', { actor: '刑部尚书', remark: '施工完成后被驳回' })
  eq(t.counters.封驳, beforeReject + 1, 'done 节点 reject 也计封驳')
  eq(t.nodes[0].state, 'rejected', 'done → rejected')
  advanceNode(st, t, 'N1', 'redo')
  eq(t.nodes[0].state, 'pending', 'redo → pending（回待办等派发）')
  advanceNode(st, t, 'N1', 'start')
  advanceNode(st, t, 'N1', 'done')
  // reopen：running → pending（评审未过，评审节点回待办）
  advanceNode(st, t, 'N2', 'start')
  advanceNode(st, t, 'N2', 'reopen')
  eq(t.nodes[1].state, 'pending', 'reopen → pending')
  // 流水线状态
  eq(pipelineOf(t).auto, false, '流水线默认关')
  stopPipeline(t, '封驳断路', '计数达 3')
  eq(pipelineOf(t).stopped?.reason, '封驳断路', '停机留痕')
  eq(pipelineOf(t).auto, false, '停机即关自动')
  resumePipeline(t, { resetBreaker: true })
  eq(pipelineOf(t).stopped, null, '重开清停机')
  eq(pipelineOf(t).auto, true, '重开开自动')
  eq(t.counters.封驳, 0, '断路器 reset 归零')
  // 预算
  noteBudget(t, { calls: 3, tokens: 1000 })
  noteBudgetStep(t)
  eq(t.budget, { calls: 3, tokens: 1000, steps: 1 }, '预算累计')
  eq(budgetExceeded(t), { calls: false, tokens: false, steps: false }, '未超限')
  noteBudget(t, { tokens: TASK_BUDGET.tokens })
  eq(budgetExceeded(t).tokens, true, 'token 超限判定')
}

/* ---------------- 直答档（中书令一轮直出） ---------------- */
{
  const st = seedState()
  const t = createTask(st, { title: '直答任务', requirement: '写一首诗', tier: '直', role: '翰林学士' })
  eq(t.nodes.length, 1, '直答单节点')
  eq(t.nodes[0].kind, '承办', '节点 = 承办')
  eq(t.nodes[0].role, '翰林学士', '承办角色 = 入口角色')
  eq(t.team.join(','), '翰林学士', '编成 = 单角色')
  ok(t.rounds.length === 1, '直答单轮')
  eq(appendRound(t, 'x'), null, '直答无轮次循环')
  const t2 = createTask(st, { title: '直答默认角色', tier: '直' })
  eq(t2.nodes[0].role, '中书令', '未指定角色 → 中书令承办')
  throws(() => createTask(st, { title: '非法档位', tier: 'XX' }), 'bad_tier', '非法档拒')
}

/* ---------------- 汇总 ---------------- */
if (bad.length) {
  console.error(`\ndomain: ${n - bad.length}/${n} 项通过，${bad.length} 项失败：`)
  for (const name of bad) console.error(`  ✗ ${name}`)
  process.exit(1)
}
console.log(`domain: ${n} 项，全部通过`)
