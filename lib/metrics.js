/**
 * dsh-onenpc · 成功指标（三条 · 口径唯一源，见 analysis/02-design.md §十）
 *
 *   1. @npc 任务全自动完成率 = 终态 done 且无 actor=user 干预的任务 ÷ 已完结任务
 *      （用户取消/归档的排除在分子外，其干预动作仍计入指标 3）
 *   2. 封驳触发率（任务级）= 发生过封驳的任务 ÷ 完成过 ≥1 次施工的任务
 *      （>50% = 诏令/简报质量红线；解读纪律：不许为压低封驳率而弱化评审）
 *   3. 人工干预次数/任务 = Σ(audit actor=user 且 action ∈ MANUAL_ACTIONS) ÷ 已建任务数
 *
 * 全部从 state（tasks+audit）纯推导，零额外记账；干预清单枚举写死在 domain.MANUAL_ACTIONS。
 * 初始目标锚定 npc-x 经验与 dsh-edict-demo 实测拍的，跑满 20 单复核校准——校准机制比数值重要。
 */

import { MANUAL_ACTIONS, REJECT_CAP } from './domain.js'

/** 初始目标（非承诺；M2 观察期 / M3 稳态） */
export const METRIC_TARGETS = {
  autoRate: { observe: 0.6, stable: 0.8 },
  rejectRate: { stable: 0.3, redLine: 0.5 },
  intervention: { stable: 1.0 },
}

const isTerminal = (task) => (task.nodes ?? []).length > 0 && (task.nodes ?? []).every((n) => n.state === 'done' || n.state === 'skipped')

/** 任务的用户干预次数（audit：actor=user 且 action ∈ MANUAL_ACTIONS 且挂在该任务名下） */
export function interventionsOf(state, taskId) {
  return (state.audit ?? []).filter(
    (a) => a.actor === 'user' && MANUAL_ACTIONS.has(a.action) && a.taskId === taskId,
  ).length
}

export function metricsOf(state) {
  const tasks = state.tasks ?? []
  const completed = tasks.filter((t) => isTerminal(t))
  const active = completed.filter((t) => !t.archived)
  const autoDone = active.filter((t) => interventionsOf(state, t.id) === 0)

  const constructed = tasks.filter(
    (t) => (t.nodes ?? []).some((n) => n.kind === '施工' && (n.state === 'done' || n.state === 'skipped')),
  )
  const rejectedTasks = tasks.filter((t) => (t.counters?.封驳 ?? 0) > 0)
  // 轮次级封驳密度：封驳总次数 ÷ 评审轮次（初审/复审/验收进入过 running 或 done 的次数）
  let reviews = 0
  let rejects = 0
  for (const t of tasks) {
    for (const n of t.nodes ?? []) {
      if (n.kind === '初审' || n.kind === '复审' || n.kind === '验收') {
        if (n.state === 'done' || n.state === 'running' || n.state === 'rejected') reviews += 1
      }
    }
    rejects += t.counters?.封驳 ?? 0
  }
  const interventionCount = tasks.reduce((acc, t) => acc + interventionsOf(state, t.id), 0)

  const rate = (a, b) => (b > 0 ? Math.round((a / b) * 100) / 100 : null)
  return {
    generatedAt: new Date().toISOString(),
    sampleNote: '初始目标非承诺：跑满 20 单复核校准一次再固化（analysis/02-design.md §十）',
    auto: {
      done: autoDone.length,
      total: active.length,
      rate: rate(autoDone.length, active.length),
      definition: '终态完成且零人工干预的任务 ÷ 已完结未归档任务',
    },
    reject: {
      rejectedTasks: rejectedTasks.length,
      constructedTasks: constructed.length,
      rate: rate(rejectedTasks.length, constructed.length),
      density: rate(rejects, reviews),
      rejects,
      reviews,
      redLine: REJECT_CAP,
      definition: '发生过封驳的任务 ÷ 完成过 ≥1 次施工的任务（辅看轮次密度）',
    },
    intervention: {
      count: interventionCount,
      tasks: tasks.length,
      perTask: tasks.length > 0 ? Math.round((interventionCount / tasks.length) * 100) / 100 : null,
      definition: 'audit 中 actor=user 干预动作 ÷ 已建任务数（清单写死 domain.MANUAL_ACTIONS）',
    },
  }
}

/** 指标是否越过目标线（UI 标色用） */
export function metricVerdicts(m) {
  const pct = (v) => (v === null ? null : Math.round(v * 100))
  return {
    auto: {
      value: pct(m.auto.rate),
      target: pct(METRIC_TARGETS.autoRate.stable),
      ok: m.auto.rate === null ? null : m.auto.rate >= METRIC_TARGETS.autoRate.stable,
      label: '全自动完成率',
    },
    reject: {
      value: pct(m.reject.rate),
      target: pct(METRIC_TARGETS.rejectRate.stable),
      red: m.reject.rate !== null && m.reject.rate > METRIC_TARGETS.rejectRate.redLine,
      ok: m.reject.rate === null ? null : m.reject.rate <= METRIC_TARGETS.rejectRate.stable,
      label: '封驳触发率',
    },
    intervention: {
      value: m.intervention.perTask,
      target: METRIC_TARGETS.intervention.stable,
      ok: m.intervention.perTask === null ? null : m.intervention.perTask <= METRIC_TARGETS.intervention.stable,
      label: '人工干预/任务',
    },
  }
}
