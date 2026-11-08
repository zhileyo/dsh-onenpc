/**
 * dsh-onenpc · 流水线（M3）：全自动流转
 *
 * 「模型说话、代码裁决」——模型只提供意见（拆解/评审结论/验收结果），
 * 状态机、评审闸门、预算、封驳断路器全部在代码里（analysis/02-design.md §六）。
 *
 * 执行者分工：
 *   - 施工 = 真子会话（dispatcher.dispatch，要改工作区、截 diff）；
 *   - 其余节点（立项/拆解/派单/收口/初审/复审/验收）= askLLM 直调（便宜、无工作区）。
 *
 * 质量门 fail-closed：
 *   - 评审/验收结论解析不出 → 按驳处理；
 *   - 评审模型不可用 → 停机待人（质量门不降级），**绝不**无模型放行；
 *   - 非裁决节点模型不可用 → 确定性退路留痕「模拟」，流程不停摆（对齐 dsh-edict-demo）。
 *
 * 停机条件（护栏，无轮次上限）：验收清单全满足（正常收口）/ 封驳计数达 3（断路器，
 * 人工重开可 reset 归零）/ 预算超限（宁中止不可无界烧）/ 派发失败 / 评审模型缺席。
 */

import {
  findTask, advanceNode, addDoc, nextDispatchableNode, triageTask,
  pipelineOf, stopPipeline, noteBudget, noteBudgetStep, budgetExceeded,
  acceptanceSet, acceptanceMarkAll, appendRound, insertDeputyNode,
  REJECT_CAP, TASK_BUDGET,
} from './domain.js'
import { findRole, ROLE_NAMES } from './domain.js'
import { appendAudit } from './domain.js'
import { askLLM, gitCommitAll } from './execution.js'

/** 评审/验收节点：askLLM + 结论裁决（质量门）。前置评审 = XL 门下前置（施工前审方案） */
export const VERDICT_KINDS = new Set(['初审', '复审', '验收', '前置评审'])
/** 必须真子会话的节点：要改工作区（diff 可归因） */
export const SUBAGENT_KINDS = new Set(['施工', '备环境', '部署', '文档'])

/** 评审结论解析：只认一行结论开头；解析不出按驳（fail-closed） */
export function parseVerdict(text) {
  const t = String(text ?? '').trim()
  if (/^(验收通过|准|通过|满足|✅)/.test(t)) return 'pass'
  if (/^(驳|封驳|不通过|未通过|不满足|未达标|❌)/.test(t)) return 'reject'
  return 'unknown'
}

/** 立项回奏 → 验收清单条目（'- '/'* '/'• '/「1.」开头的行；解析不出给整体兜底条目） */
export function parseAcceptance(text) {
  const items = String(text ?? '').split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(-\s|\*\s|•\s|\d+[.、)])/.test(l))
    .map((l) => l.replace(/^(-\s|\*\s|•\s|\d+[.、)])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 20)
  return items.length ? items : ['（立项未产出分条清单，按需求整体验收）']
}

/** 拆解回奏里的增派声明解析：「增派：<角色名> <一句话任务>」，最多 3 条 */
export function parseDeputies(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const m = line.trim().match(/^增派[:：]\s*(.+)$/)
    if (!m) continue
    const body = m[1].trim()
    const role = ROLE_NAMES.find((r) => body.startsWith(r))
    if (!role) continue
    out.push({ role, task: body.slice(role.length).trim() || '增援协作' })
    if (out.length >= 3) break
  }
  return out
}

/**
 * 判级三层之①：LLM 主判（只对 fallback 档任务生效；手动指定过的不覆盖）。
 * 流水线第一步 + 交办前都会调（幂等：判过 triageBy 变 'llm' 就不再判）。
 */
export function judgeTriage(host, task) {
  return _judgeTriage(host, task)
}

async function _judgeTriage(host, task) {
  if (task.triageBy !== 'fallback') return null
  const prompt = [
    '你是三省六部体系的调度中枢。请对下面这个需求判级（任务分级），',
    '只回一行：先写档位（直答/S0/S1/M/L/XL 之一），空格后接一句话理由。',
    '档位定义：直答 = 纯问答/写作/翻译等内容产出，不需要改动任何代码，单角色一轮直出；',
    'S0 单点直改（typo/小修）；S1 单领域小改；M 跨文件小特性；L 多部协同特性；XL 体系级/多轮大需求。',
    `需求标题：${task.title}`,
    `需求详情：${task.requirement || '（无）'}`,
  ].join('\n')
  const asked = await askLLM(host, prompt)
  if (asked.mode !== 'llm') return null
  const m = String(asked.text).match(/\b(S0|S1|M|L|XL)\b|直答/)
  if (!m) return null
  const tier = m[0] === '直答' ? '直' : m[1]
  const reason = String(asked.text).replace(/^\s*(直答|\b(S0|S1|M|L|XL)\b)/, '').trim().slice(0, 180)
  return { tier, reason: reason || 'LLM 判级', tokens: asked.tokens ?? 0 }
}

/** 决策：这一步该做什么（纯函数，不动状态） */
export function nextStep(task) {
  if (task.archived) return { kind: 'stop', reason: '任务已归档', why: '归档任务不自动流转' }
  const p = pipelineOf(task)
  if (p.stopped) return { kind: 'idle', why: `已停机：${p.stopped.reason}` }
  const budget = budgetExceeded(task)
  const over = Object.entries(budget).filter(([, v]) => v).map(([k]) => k)
  if (over.length) {
    return {
      kind: 'stop',
      reason: '预算耗尽',
      why: `超出上限（${over.join('/')}，上限 calls ${TASK_BUDGET.calls} / tokens ${TASK_BUDGET.tokens} / steps ${TASK_BUDGET.steps}）——宁中止不可无界烧，人工重开续跑`,
    }
  }
  if ((task.counters?.封驳 ?? 0) >= REJECT_CAP) {
    return { kind: 'stop', reason: '封驳断路', why: `封驳计数达 ${REJECT_CAP}，须换方案；人工「重开」（可归零计数）后继续` }
  }
  const nodes = task.nodes ?? []
  if (nodes.length > 0 && nodes.every((n) => n.state === 'done' || n.state === 'skipped')) {
    // npc-x §8：验收全满足 → 跳出循环 → [交付] 最终交付报告 → 完成
    if (!task.delivery) return { kind: 'deliver' }
    return { kind: 'complete' }
  }
  const rejected = nodes.find((n) => n.state === 'rejected')
  if (rejected) return { kind: 'redo', node: rejected }
  if (nodes.some((n) => n.state === 'running')) return { kind: 'wait', why: '有在办节点' }
  const next = nextDispatchableNode(task)
  if (!next) return { kind: 'wait', why: '暂无可推进节点' }
  if (SUBAGENT_KINDS.has(next.kind)) return { kind: 'dispatch', node: next }
  return { kind: 'llm', node: next }
}

/** 施工证据（评审/验收的输入）：最近一次施工的回奏 + diff 摘要 */
export function evidenceOf(task) {
  const constructions = (task.nodes ?? []).filter((n) => n.kind === '施工')
  const c = constructions[constructions.length - 1]
  if (!c) return null
  const report = [...(c.docs ?? [])].reverse().find((d) => d.type === '回奏')?.text ?? '（无）'
  const diff = (c.artifacts ?? []).find((a) => a.kind === 'diff')
  const files = (diff?.files ?? []).map((f) => f.path).join('、')
  return {
    node: c,
    report,
    diffSummary: diff ? `${diff.summary ?? ''}${files ? '：' + files : ''}` : '（无 diff 产物）',
  }
}

/** 某类节点最近一次的回奏文本（前置评审审拆解方案用） */
export function evidenceOfKind(task, kind) {
  const list = (task.nodes ?? []).filter((n) => n.kind === kind)
  const n = list[list.length - 1]
  if (!n) return '（无）'
  return [...(n.docs ?? [])].reverse().find((d) => d.type === '回奏')?.text ?? '（无回奏）'
}

const firstLine = (text) => String(text ?? '').split('\n')[0].slice(0, 100)

const roundGoalOf = (task, round) =>
  (task.rounds ?? []).find((r) => r.n === round)?.goal ?? ''

/** 各节点的提示词（角色 soul + 任务上下文 + 节点职责；评审节点附施工证据与裁决格式） */
export function promptFor(node, task) {
  const soul = findRole(node.role)?.soul ?? `【角色】你是「${node.role}」，三省六部体系的承接者。`
  const ev = evidenceOf(task)
  const base = [
    soul,
    '',
    `【任务】${task.title}（${task.id} · 判级 ${task.triage}）`,
    `【需求/验收标准】${task.requirement || '（见标题）'}`,
    `【本节点】${node.kind}（${node.id}）`,
  ]
  switch (node.kind) {
    case '立项':
      return [...base, '请产出：验收清单（可逐条核对的条目，每行一条，以「- 」开头；这是全任务验收的唯一依据）。'].join('\n')
    case '拆解':
      return [
        ...base,
        `【本轮目标】${roundGoalOf(task, node.round) || '（初始需求，见上）'}`,
        '请产出：本轮诏令（做什么 / 改动范围 / 前置依赖 / 本轮可捆绑编辑数上限 b_t / 禁止事项），简明分条。',
        '若需要其他部协作（环境/文档/部署/安全等），在末尾单独一行「增派：<角色名> <一句话任务>」（最多 3 条）；不需要就不写。',
      ].join('\n')
    case '承办':
      return [
        ...base,
        node.deputyFor ? `【增派任务】${node.deputyFor}` : '',
        node.deputyFor
          ? '这是增派协作：完成上面这一项协作任务即可，不越界。'
          : '这是直答单：没有施工/评审环节，你的回复就是最终交付物。请直接完成该需求，输出即交付（面向用户，简明分条）。',
      ].filter(Boolean).join('\n')
    case '派单':
      return [...base, '请产出：派单安排（确认承接与前置依赖，两三句即可）。'].join('\n')
    case '收口':
      return [...base, '请产出：收口总结（完成情况 / 遗留 / 交付说明），简明分条。质量门（初审+复审）已全过，你确认后产物将自动提交。'].join('\n')
    case '前置评审':
      return [
        ...base,
        `【拆解诏令（被审对象）】\n${evidenceOfKind(task, '拆解')}`,
        '你是门下前置（XL）：施工开始前审方案本身——范围是否合理、验收是否可核、风险是否可控。',
        '只回：一行结论开头（「准」或「驳」），随后逐条理由；驳 = 方案打回重拆。',
      ].join('\n')
    case '初审':
      return [
        ...base,
        `【施工证据】\n回奏：${ev?.report ?? '（无）'}\ndiff：${ev?.diffSummary ?? '（无）'}`,
        '你是质量门（刑部）。评审只认 diff + 验收标准 + 独立可复现验证，不接受产出者自评作为通过证据。',
        '只回：一行结论开头（「准」或「驳」），随后逐条理由；驳回必须列出必须修改的点。',
      ].join('\n')
    case '复审':
      return [
        ...base,
        `【施工证据】\n回奏：${ev?.report ?? '（无）'}\ndiff：${ev?.diffSummary ?? '（无）'}`,
        '你是独立评审（门下），一票否决。只回：一行结论开头（「准」或「驳」），随后逐条硬伤理由。',
      ].join('\n')
    case '审计':
      return [
        ...base,
        `【本任务】\n需求：${task.requirement || '（见标题）'}\n轮次：${(task.rounds ?? []).length}`,
        '你是太史令（XL 学习审计）：请产出 1) 本任务【经验卡】（场景/坑点/解法/适用条件，按台账格式）；2) 学习审计结论（旧错是否复发、该沉淀什么）。简明分条。',
      ].join('\n')
    case '验收':
      return [
        ...base,
        `【验收清单】\n${(task.acceptance ?? []).map((a) => `- ${a.text}`).join('\n') || '（无分条清单，按需求整体验收）'}`,
        '你是验收人（中书令），对照验收清单逐条核对施工证据与各节点回奏。',
        '全部满足：只回「验收通过」开头 + 逐条核对结果；仍有差距：只回「未满足」开头 + 逐条核对结果 + 末尾单独一行「差距：」写清下一轮目标。',
      ].join('\n')
    default:
      return [...base, '请按职责完成本节点并简要汇报。'].join('\n')
  }
}

/**
 * 走一步。返回 { ok, step, ... }；**模型意见、代码裁决**：
 * 状态推进/封驳计数/停机判断全在这里落，调用方只负责触发与展示。
 */
export async function runPipelineStep(store, host, dispatcher, taskId) {
  const task = findTask(store.state, taskId)
  if (!task) throw Object.assign(new Error(`任务 ${taskId} 不存在`), { code: 'task_not_found', status: 404 })

  // 判级三层之①：fallback 档任务的**第一个动作** = LLM 主判（可能整条重编排成）。
  // 必须先于任何节点执行——否则立项/拆解已在途，判出直答也无法回溯。
  if (task.triageBy === 'fallback' && !pipelineOf(task).stopped) {
    try {
      const triaged = await judgeTriage(host, task)
      if (triaged) {
        triageTask(store.state, task, triaged.tier, 'llm', triaged.reason)
        noteBudget(task, { calls: 1, tokens: triaged.tokens ?? 0 })
        store.touch('triage-llm')
        return { ok: true, step: { kind: 'triaged', tier: triaged.tier, reason: triaged.reason } }
      }
    } catch {
      /* 判级失败留 fallback，继续按当前模板走 */
    }
  }

  const step = nextStep(task)

  if (step.kind === 'idle' || step.kind === 'wait') return { ok: true, step, idle: true }

  if (step.kind === 'complete') {
    const p = pipelineOf(task)
    p.auto = false
    appendAudit(store.state, {
      action: 'pipeline-complete',
      taskId: task.id,
      title: task.title,
      actor: 'system',
      remark: '验收清单全部满足，自动流转收口',
    })
    store.touch('pipeline-complete')
    return { ok: true, step, finished: true }
  }

  if (step.kind === 'stop') {
    stopPipeline(task, step.reason, step.why)
    appendAudit(store.state, {
      action: 'pipeline-stop',
      taskId: task.id,
      title: task.title,
      actor: 'system',
      result: 'denied',
      remark: `${step.reason}：${step.why}`,
    })
    store.touch('pipeline-stop')
    return { ok: false, step, stopped: true }
  }

  if (step.kind === 'redo') {
    advanceNode(store.state, task, step.node.id, 'redo', { actor: 'system', remark: '流水线：打回重做' })
    noteBudgetStep(task)
    store.touch('pipeline-step')
    return { ok: true, step, note: `重做 ${step.node.kind}` }
  }

  if (step.kind === 'deliver') {
    // npc-x §8 [交付]：最终交付报告（需求→逐条验收结果→轮次概览→遗留）
    noteBudgetStep(task)
    const prompt = [
      findRole('中书令')?.soul ?? '【角色】你是「中书令」。', '',
      `【任务】${task.title}（${task.id}）`,
      `【需求】${task.requirement || '（见标题）'}`,
      `【验收清单】\n${(task.acceptance ?? []).map((a) => `- [${a.state}] ${a.text}`).join('\n') || '（无分条清单）'}`,
      '【各轮收口】\n' + ((task.nodes ?? []).filter((n) => n.kind === '收口').map((n) => `- 第${n.round}轮：${([...(n.docs ?? [])].reverse().find((d) => d.type === '回奏')?.text ?? '').slice(0, 120)}`).join('\n') || '（无）'),
      '请产出：最终交付报告（需求 → 验收清单逐条结果 → 轮次/产物概览 → 遗留），面向用户，简明分条。',
    ].join('\n')
    const asked = await askLLM(host, prompt)
    noteBudget(task, { calls: 1, tokens: asked.tokens ?? 0 })
    task.delivery = {
      text: String(asked.text ?? '').trim() || '（交付报告生成失败，见各轮台账）',
      simulated: asked.mode !== 'llm',
      at: new Date().toISOString(),
    }
    appendAudit(store.state, { action: 'deliver', taskId: task.id, title: task.title, actor: 'system', remark: '最终交付报告已生成' })
    store.touch('deliver')
    return { ok: true, step, delivered: true }
  }

  noteBudgetStep(task)

  if (step.kind === 'dispatch') {
    try {
      const exec = await dispatcher.dispatch(task.id, { nodeId: step.node.id, actor: 'system' })
      store.touch('pipeline-step')
      return { ok: true, step, execution: exec.id }
    } catch (error) {
      stopPipeline(task, '派发失败', error?.message ?? String(error))
      appendAudit(store.state, {
        action: 'pipeline-stop',
        taskId: task.id,
        title: task.title,
        actor: 'system',
        result: 'denied',
        remark: `派发失败：${error?.message ?? error}`,
      })
      store.touch('pipeline-stop')
      return { ok: false, step, stopped: true }
    }
  }

  // kind === 'llm'：askLLM 直调节点（评审/验收含裁决；其余意见型）
  const node = step.node
  advanceNode(store.state, task, node.id, 'start', { actor: 'system', remark: '流水线：办理中' })
  store.touch('pipeline-step')
  const asked = await askLLM(host, promptFor(node, task))
  noteBudget(task, { calls: 1, tokens: asked.tokens ?? 0 })
  const text = String(asked.text ?? '')
  const simulated = asked.mode !== 'llm'

  if (VERDICT_KINDS.has(node.kind)) {
    if (simulated) {
      advanceNode(store.state, task, node.id, 'reopen', { actor: 'system', remark: '评审模型不可用，质量门不降级' })
      stopPipeline(task, '模型不可用', `${node.kind} 无法在无模型时进行（质量门不降级，绝不无模型放行）`)
      appendAudit(store.state, { action: 'pipeline-stop', taskId: task.id, actor: 'system', result: 'denied', remark: '评审模型缺席，停机待人' })
      store.touch('pipeline-stop')
      return { ok: false, step, stopped: true, simulated: true }
    }
    const verdict = parseVerdict(text)
    if (verdict === 'pass') {
      addDoc(store.state, task, node.id, { type: '回奏', from: node.role, to: '中书令', text: text || '准', actor: node.role })
      advanceNode(store.state, task, node.id, 'done', { actor: node.role, remark: `${node.kind}评审通过` })
      if (node.kind === '验收') {
        // npc-x §8 [7]：全部满足 → 跳出循环（round 收口为 accepted）
        acceptanceMarkAll(task, 'pass')
        const round = (task.rounds ?? []).slice(-1)[0]
        if (round) {
          round.verdict = 'accepted'
          round.endedAt = round.endedAt ?? new Date().toISOString()
        }
        appendAudit(store.state, { action: 'round-accept', taskId: task.id, actor: 'system', remark: `第${round?.n ?? '?'}轮验收通过` })
      }
      store.touch('pipeline-step')
      return { ok: true, step, verdict: 'pass' }
    }
    const verdictNote = verdict === 'unknown' ? '\n[结论无法解析，fail-closed 按驳处理]' : ''
    if (node.kind === '验收') {
      // npc-x §8 [7]：仍有差距 → 差距写成新一轮目标，回到[1]（不是打回施工）
      addDoc(store.state, task, node.id, { type: '回奏', from: node.role, to: '中书令', text: (text || '未满足') + verdictNote, actor: node.role })
      advanceNode(store.state, task, node.id, 'reopen', { actor: 'system', remark: '验收未满足，进入下一轮' })
      const round = (task.rounds ?? []).slice(-1)[0]
      if (round) {
        round.verdict = 'gap'
        round.endedAt = round.endedAt ?? new Date().toISOString()
      }
      const gap = String(text ?? '').match(/差距[:：]\s*([\s\S]+)/)?.[1]?.trim() ?? '验收未满足（详见验收回奏）'
      const newNodes = appendRound(task, gap)
      appendAudit(store.state, { action: 'round-append', taskId: task.id, actor: 'system', remark: `第${round?.n ?? '?'}轮未满足，差距写成第${(task.rounds ?? []).length}轮目标（回[1]），新增 ${newNodes?.length ?? 0} 节点` })
      store.touch('pipeline-step')
      return { ok: true, step, verdict: 'reject', newRound: (task.rounds ?? []).length }
    }
    // 初审/复审驳 → 打回施工；前置评审驳 → 打回拆解（方案重做，npc-x 门下前置）
    const rejectTargetKind = node.kind === '前置评审' ? '拆解' : '施工'
    const rejectTo = node.kind === '前置评审' ? '中书令' : '工部尚书'
    addDoc(store.state, task, node.id, { type: '封驳', from: node.role, to: rejectTo, text: (text || '驳回') + verdictNote, actor: node.role })
    advanceNode(store.state, task, node.id, 'reopen', { actor: 'system', remark: `${node.kind}驳回，回到待办等重做后再审` })
    const candidates = (task.nodes ?? []).filter((n) => n.kind === rejectTargetKind)
    const target = candidates[candidates.length - 1]
    if (target) {
      try {
        advanceNode(store.state, task, target.id, 'reject', { actor: node.role, remark: `${node.kind}驳回：${firstLine(text)}` })
      } catch {
        /* 目标节点状态不允许时不动（如实留痕在封驳公文里） */
      }
    }
    store.touch('pipeline-step')
    return { ok: true, step, verdict: 'reject' }
  }

  // 非裁决节点：模型意见留痕 + 推进（模拟退路如实标注）
  const suffix = simulated ? '\n[模拟] 模型不在场，确定性退路留痕，不作为实质产出' : ''
  addDoc(store.state, task, node.id, {
    type: '回奏',
    from: node.role,
    to: '中书令',
    text: (text || '（无输出）') + suffix,
    actor: node.role,
  })
  advanceNode(store.state, task, node.id, 'done', { actor: node.role, remark: simulated ? '流水线完成（模拟退路）' : '流水线完成' })
  if (node.kind === '立项') {
    // [0 立项]：需求 → 验收清单（唯一增删权=调度方；此处即调度方动作）
    acceptanceSet(task, parseAcceptance(text))
    appendAudit(store.state, { action: 'acceptance-set', taskId: task.id, actor: 'system', remark: `验收清单 ${task.acceptance.length} 条（立项产出）` })
  }
  if (node.kind === '拆解') {
    // 动态增派（npc-x「动态增删」）：拆解声明协作角色 → 本轮插入承办节点（同角色去重）
    for (const d of parseDeputies(text)) {
      const exists = (task.nodes ?? []).some((n) => n.round === node.round && n.role === d.role)
      if (exists) continue
      const added = insertDeputyNode(task, node.id, d.role, d.task)
      if (added) {
        appendAudit(store.state, { action: 'deputy-add', taskId: task.id, nodeId: added.id, actor: 'system', remark: `${added.id} ${d.role}：${d.task}` })
      }
    }
  }
  if (node.kind === '承办' && task.triage === '直') {
    // 直答单：承办回复即交付物（不再单独走 [交付] 步骤，节省一轮调用）。
    // 注意：S1 增派出来的承办节点不是直答——它们的产出只留痕，交付仍走 [交付] 步骤。
    task.delivery = {
      text: (text || '（无输出）') + (simulated ? '\n[模拟] 模型不在场，本直答为占位留痕' : ''),
      simulated,
      at: new Date().toISOString(),
    }
    const round = (task.rounds ?? []).slice(-1)[0]
    if (round) round.verdict = 'accepted'
    appendAudit(store.state, { action: 'deliver', taskId: task.id, title: task.title, actor: node.role, remark: '直答交付' })
  }
  if (node.kind === '收口' && store.state.meta?.autoCommit !== false) {
    // npc-x §8 [5 自动合并] 的本机等价物：收口 = 自动提交（可在配置关闭）。
    // 用施工节点的 git 基线所在仓（收口节点自己没被派发、无基线）。
    const constructions = (task.nodes ?? []).filter((n) => n.kind === '施工' && n.gitBaseline?.head)
    const baselineNode = constructions[constructions.length - 1]
    if (baselineNode) {
      const commit = await gitCommitAll(baselineNode.gitBaseline.cwd, `[中书令] ${task.id} 第${node.round}轮收口`)
      if (commit.sha && !commit.skipped) {
        node.artifacts.push({ kind: 'note', summary: `已自动提交 ${commit.sha.slice(0, 10)}（收口=自动合并的本机等价物）`, at: new Date().toISOString() })
        appendAudit(store.state, { action: 'auto-commit', taskId: task.id, nodeId: node.id, actor: 'system', remark: `${commit.sha.slice(0, 10)} ${commit.output ?? ''}` })
      } else if (commit.skipped) {
        node.artifacts.push({ kind: 'note', summary: '工作区干净，无需提交', at: new Date().toISOString() })
      } else if (commit.error) {
        node.artifacts.push({ kind: 'note', summary: `自动提交失败：${commit.error}`, at: new Date().toISOString() })
      }
    }
  }
  store.touch('pipeline-step')
  return { ok: true, step, simulated }
}
