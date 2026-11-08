# dsh-onenpc 设计方案（三省六部 · NPC 协作插件）

> 把 npc-x（CNB 平台版三省六部）移植成 DeepSeekRuntime 插件。
> 前置调研：[01-npc-x-analysis.md](./01-npc-x-analysis.md)；架构先例：`D:\Projects\dsh-edict-demo`（同作者、MIT，骨架直接继承）。
> 目标运行时：DeepSeekRuntime 0.2.1-rc.3（插件面证据见 `dsh-edict-demo/analysis/02-dsh-plugin-surface.md`）。

---

## 一、目标与非目标

**目标（用户已拍板）**：

1. **对话框 @npc 完成对话**：交互采用 **A+B**——`/npc` 斜杠命令 + 输入区按钮起步；同时监听消息里的 `@角色名` 前缀自动建任务派发。不接管官方输入框（`conversation.composer` chain 风险高，留观望）。
2. **任务看板**：整页面板展示历史 @npc 任务（列表/筛选/计数徽章）。
3. **任务详情 = 流程视图**：展示整条流程（拆解→派单→施工→初审→复审→合并→验收…），每个节点有状态；**点节点开抽屉**：详情 + 公文原文 + 产物预览。
4. **载体：纯本机**——NPC 子会话直接在工作目录改代码/产出，验证与提交走本机 git；无 PR/远程合并语义，质量门 = 刑部/门下独立评审轮。

**非目标（第一版）**：CNB 联动（Issue/PR/api_trigger 遥控）、接管输入框做 @ 自动补全、御史台稽核、跨进程常驻心跳。

---

## 二、总体架构（继承 dsh-edict-demo 三原则）

```
浏览器 lib/client.js（瘦壳）                     宿主进程 lib/index.js
  slot: 会话头 tab「三省六部」+ main 整页面板        npcStore ── $DSH_HOME/onenpc/state.json
        + sidebar.panellist + settings.section       └─ HTTP 路由（/state 长轮询、任务/执行/审计）
    └─ <iframe src=/dsh-onenpc-<n>/ui> ──────────► GET /ui（public/ui.html 界面唯一来源）
                                                   lib/domain.js  状态机/判级/公文/闸门（纯函数）
                                                   lib/roles.js   12 角色人设（精简版）
                                                   lib/dispatch.js 判级→编成→建子会话→steer
                                                   lib/pipeline.js 流程编排（拆解/派单/评审轮）
```

三个刻意的选择（照抄 dsh-edict-demo，已被验证）：

1. **界面只有一份**：`public/ui.html`，iframe 承载 + dev-server 直吐，「预览=实装」一致，无构建步骤。
2. **实时性自建**：不依赖宿主事件流（0.1.5 已删浏览器端事件 API），插件自建 HTTP 路由长轮询（`/state?since=`）。
3. **计算留在宿主**：状态机、判级、闸门、公文清洗全在 `lib/domain.js` 纯函数，浏览器只画。

## 三、目录结构（目标形态）

```
dsh-onenpc/
  package.json          # dsh.bundle.patch + dsh.client + compatibility（照 dsh-edict-demo 模板）
  cordis.patch.yml      # - insert: id: dsh-onenpc / name: 'dsh-onenpc'（id 行禁行尾注释）
  lib/
    index.js            # 宿主半侧：store + 路由 + 长轮询 + 审计 + session/event 监听
    client.js           # 浏览器半侧：window.__ModuleLoader__ 副作用脚本，四个 slot
    domain.js           # 领域内核：12 角色/判级/状态机/公文/闸门/种子数据
    dispatch.js         # 判级→编成→ctx.agents.create→简报拼装→事件回写→token 记账
    pipeline.js         # 流程编排：拆解/派单/刑部/门下/验收 环节决策 + 确定性退路
    ledger.js           # 案例库/经验卡（$DSH_HOME/onenpc/casebook/*.md）
  public/ui.html        # 界面：看板 + 详情流程图 + 节点抽屉 + 角色总览 + 设置
  scripts/              # dev-server.mjs / domain-test.mjs / smoke*.mjs / ui-e2e.mjs
  analysis/             # 本文档
```

## 四、数据模型（任务/节点/产物）

```js
task = {
  id: 'TASK-<n>', title, 需求原文,
  origin: 'command|mention|board',      // 来源：/npc 命令 / @解析 / 看板下旨
  triage: 'S0|S1|M|L|XL',               // 判级（三层：LLM 主判 / 默认 M 兜底 / 看板手动改）
  triageBy: 'llm|fallback|manual',      // 判级来源（审计可溯）
  triageReason: '',                     // 判级理由一句话（LLM 给出 / fallback 说明 / 手动备注）
  team: ['中书令','工部尚书',...],        // 本单编成（由判级路由，最小可用编成）
  acceptance: [{ text, state: 'todo|pass|fail' }],   // 验收清单（唯一增删权=调度方）
  nodes: [{
    id, kind: '立项|拆解|派单|施工|初审(刑部)|复审(门下)|收口|验收',
    role: '工部尚书',                    // 承接角色
    state: 'pending|running|done|rejected|blocked|skipped',
    docs: [ {type:'诏令|回奏|封驳|经验卡', from, to, text, at} ],   // 公文流（timeline）
    artifacts: [ {kind:'text|file|diff|report', ref, summary} ],   // 产物（diff 等大文本外置 artifacts/ 目录，state 只存摘要+路径）
    gitBaseline: { head, branch, dirty, recordedAt },              // 施工类节点派发前记录（diff 捕获地基，见 §五末）
    sessionId,                          // 承接子会话 id（可回放/可叫停）
    tokens, calls, startedAt, endedAt, stopReason
  }],
  counters: { 封驳计数: 'N/3', 自愈轮次: 'M/3', budget: {calls, tokens, steps} },
  audit: [ {at, actor, action, taskId, from, to, remark, result} ],  // 被拒也记
  createdAt, updatedAt, archived
}
```

**节点状态由动作层写**（`lib/actions.js` 模式）：状态机迁移、闸门判断、审计全部代码化——提示词只管产线，不管规则。

## 五、@npc 交互（A+B）

### A. `/npc` 斜杠命令 + 输入区按钮

- `ctx.commands.register`：`/npc <角色名> <需求>`（`input.hint: '[角色]（可空，默认中书令）+ 需求'`）。
  handler：建 task（origin=command）→ 判级 → dispatch。
- `conversation.input.left` 注册「📣 召 NPC」按钮 → 弹角色选择器（12 角色 + slogan）→ 选完预填 `/npc <角色> `。
- 命令卡片渲染：`conversation.chat.commandview`（keyed by 命令名）给 `/npc` 专属卡片（显示任务号 + 看板跳转）。

### B. 消息 @解析

- 监听 `ctx.on('session/event')` 的 `user/message`：检测正文 `@<角色名>`（匹配 12 角色名表，如 `@中书令 给XX加导出`）。
- 命中 → 建 task（origin=mention）→ dispatch → NPC 回复写进任务节点（看板可见），**不伪装成主会话回复**。
- **@命中的 UI 指引（降困惑 · 第一版必做）**：主 agent 也会响应这条消息，故命中后必须在对话流里给出明确指引——
  注册 `conversation.chat.turnTail`（完成 Turn 的功能位，list/session，新 id 即新增一行）：该 turn 的用户消息命中 @角色时 →
  渲染一行「📨 已转交「中书令」· TASK-n · NPC 结果看「三省六部」看板（主会话回复仅供参考）」+「打开看板」按钮
  （`ctx.layout.selectPanel('dsh-onenpc')`）；未命中/上下文不足 → 渲染 `null`（零侵入，不影响普通消息）。
  配套：任务创建后会话头 tab tbadge 徽章 +1（dsh-edict-demo 已有 tbadge 惯例）；task 记 `origin=mention` 与来源消息摘要。
  （turnTail 的 owner props 形状待验证，拿不到 turn 上下文时降级为仅 tbadge 指路。）
- 已知边界（如实标注在 README/界面说明）：第一版接受双响应，靠 turnTail 提示行 + tbadge 指路降困惑；后续视实际干扰度评估 agentPreset 或 composer 接管。

### 派发执行（dispatch.js，继承 dsh-edict-demo execution.js 已验证路径）

```
POST 派发 → ctx.agents.create({ sessionId: `npc-<task>-<node>`, meta:{cwd, origin:'subagent'},
             agentOptions:{provider, model: roles[role].model ?? 宿主默认} })
         → agent.steer(简报)   // 人设+职掌+诏令全文（目标/范围/验收/禁止）+ 汇报格式要求
         → ctx.on('session/event') 只认助手侧 text 块 → 回写节点 docs/artifacts
         → usage 事件累计 tokens（取最大值，不换算钱）
         → 一轮结束：产出写 artifacts、推进节点状态、写审计 execute/execute-done
```

- **降级可见**：宿主无 `ctx.agents`（dsh-agent-loop 未加载）→ 接口 503、按钮置灰、明说「只能人手推进」，绝不假装在办。
- 模型不在/解析失败 → `parsed:false` 留痕标「模拟」，流程不停摆。

### diff 产物捕获（git 基线机制 · 设计 M1 前定，实现随 M2 派发）

子会话直接改本机文件，「点节点看产物」的 diff 体验靠**派发前记基线、节点结束截 diff**：

1. **派发前（施工/收口类节点）**：记录 `node.gitBaseline = { head: 'git rev-parse HEAD', branch, dirty, recordedAt }`。
   工作区非净（`git status --porcelain` 非空）→ 节点标「⚠ 工作区非净，diff 含前置改动」警示，**不阻断、如实呈现**；cwd 非 git 仓库 → 不记基线，产物只有文本，diff 区显示「非 git 工作区」。
2. **节点结束（execute-done）**：统一截 `git diff <baselineSha>`——该命令给出基线→当前工作区的全部差异，**子会话无论是否 commit 都能截到**：
   - `git diff <sha> --stat` 摘要（n files, +a/-b）写进 `artifacts[{kind:'diff'}].summary`；
   - diff 全文外置 `$DSH_HOME/onenpc/artifacts/<task>/<node>.diff`（state.json 只存摘要+路径，防膨胀；上限 2000 行 / 512KB，截断须标注）；
   - untracked 新文件 `git diff` 看不到 → 从 `git status --porcelain` 收集，逐个作为 `{kind:'file'}` artifact（>1MB 只留路径不读内容）。
3. **可归因前提**：同一 task 的施工类节点**强制串行**（dispatch 队列）——并行施工的 diff 会互相混入无法归因；与 npc-x §7「改动范围重叠串行」制度同源。
4. **展示**：节点抽屉产物区按文件列 diff（+a/-b 计数），点击展开；第一版红绿行自绘渲染，不引第三方 diff 大库。
5. **读路径**：`GET /artifacts/:task/:node/:file` 插件路由读外置文件，iframe 同源直取。

## 六、流程编排与护栏（pipeline.js + domain.js）

- **判级（三层 · 四因素纯代码判不了）**：
  ① **主判 = 中书令（LLM）**——dispatch 前用 `ctx.llm.stream` 发一次小判级 prompt（需求原文 + 四因素档位定义表，要求只回 `S0|S1|M|L|XL` + 一句话理由），写 `task.triage / triageBy='llm' / triageReason`；
  ② **兜底 = 默认 M 档**——LLM 不可用/超时/解析失败即落 M（精简班子、完整质量门），`triageBy='fallback'` 留痕，不反问不停摆；
  ③ **手动改级 = 看板可改**——任务卡/详情下拉改档，`triageBy='manual'` + 审计（actor=user）；未派发即按新档重算编成，**在途节点不回溯**。
  判级调用计入 task 预算（1 次）；M3 起中书令拆解节点可建议改级，采纳同样走审计。
  档→编成路由不变：S0/S1 单兵直派（单节点），M 精简（施工+刑部），L/XL 标准全流程（拆解→派单→施工→初审→复审→收口→验收）。
- **评审轮**：刑部/门下用 `ctx.llm.stream` 独立调用（给 diff/产出 + 验收清单，要求「准/驳 + 逐条理由」）；**不接受产出者自评作为通过证据**（npc-x 提案2 制度保留）。
- **护栏代码化**（照 npc-x §8 + dsh-edict-demo 闸门先例）：
  - 封驳计数 ≥3 → 强制停机换方案，归零留痕（断路器）；
  - 预算闸门：每 task 上限 N 次模型调用 / token 上限 / 步数上限，用满即停并写停因（圣裁/验收环节永不自动越过）；
  - 完成门槛：验收清单有 fail/todo → 不许进入 done（409 + 理由）；
  - 审计：状态变更与被拒尝试全留痕。
- **定时督办**：`ctx.schedule` 扫「running 但久无心跳」的节点 → 催办/升级（如实标注：仅 DSH 进程运行时生效）。

## 七、看板 UI（public/ui.html）

| 页面 | 内容 |
|---|---|
| **任务看板**（main 面板/会话头 tab 共用同一 iframe） | 任务卡网格（判级 tag/编成/节点进度条/封驳圆点/now 摘要）+ 筛选（进行中/已归档）+ 计数徽章 + 卡内动作（叫停/归档/**改级**：下拉 S0~XL，写审计并重算未派发编成） |
| **任务详情** | 顶部需求/验收清单；**流程节点图**（横向泳道或纵向时间线，节点状态色：pending 灰/running 蓝/done 绿/rejected 红/blocked 黄）；点节点 → 右侧抽屉 |
| **节点抽屉** | 详情（承接角色/起止/tokens/停因/gitBaseline 摘要）+ 公文流 timeline（诏令/回奏/封驳原文折叠）+ **产物区**（文本/文件/报告可复制 Markdown；**diff 按文件列表 +a/-b、点击展开红绿行渲染**，截断标注）+ 产物若是子会话可「查看会话轨迹」 |
| **角色总览** | 12 角色卡（slogan/在办/累计 tokens/功绩） |
| **设置** | 逐角色模型覆盖、流水线模式（手动/制度环/全自动）、案例库路径 |

## 八、HTTP 接口草案（前缀 `/dsh-onenpc-<n>/`，路由必须含包名）

```
GET  /meta                    自述与端点清单
GET  /state?since=&timeout=   全量快照 + 长轮询
GET  /tasks /tasks/:id        列表 / 详情（nodes/docs/artifacts/audit）
POST /tasks                   建任务（下旨：{title, requirement, role?, priority}）
POST /tasks/:id/action        统一动作（advance/reject/pass/block/archive/...）
POST /tasks/:id/triage        改级（{tier, reason?}，写审计；未派发即重算编成）
GET  /artifacts/:task/:node/:file  读外置产物文件（diff/文本，iframe 同源直取）
POST /tasks/:id/dispatch      派发给承接角色（ctx.agents.create 真办差）
POST /tasks/:id/pipeline/step 流程走一步（调试用）
GET  /executions /executions/:id  执行记录 + 会话轨迹
POST /executions/:id/stop     叫停子会话
GET  /roles /config           角色表 / 配置（模型覆盖、流水线模式）
POST /config/*                写配置
GET  /casebook /casebook/query    案例库列表 / 检索
GET  /audit                   审计（?task=&result=&action=）
```

## 九、里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M0 骨架** | 从 dsh-edict-demo 拷骨架改造：package.json/patch/两半侧/dev-server；12 角色 domain 数据 | dev-server 起得来，空看板可开，domain 自检过 |
| **M1 看板** | 任务 CRUD + 判级三层（LLM 主判 / M 兜底 / 手动改）+ 状态机 + 节点时间线 + 详情抽屉 + **diff 基线数据模型与 artifacts 外置存储**（纯本地数据，LLM 判级可 mock） | smoke + ui-e2e：下旨→节点推进→抽屉可见→改级留痕 |
| **M2 真对话** | /npc 命令 + input.left 按钮 + @解析（含 turnTail 提示行）→ agents.create 真办差 → **派发前 git 基线 + 节点结束 diff 截取** → 产出/审计回写 | 真机：@中书令 一句话 → 施工节点有真产物与可展开 diff |
| **M3 流水线** | 刑部/门下评审轮 + 预算闸门 + 封驳断路器 + 多轮循环 + **成功指标面板（/metrics 三条常驻顶栏）** | 真机全自动跑通一单 L 级任务并停机留痕 |
| **M4 治理** | 案例库/经验卡、定时督办、角色功绩统计（可选御史台） | 经验卡沉淀→回放命中 |

## 十、成功指标（三条 · 看板顶栏常驻）

> **口径唯一源 = `lib/metrics.js`**（纯函数，从 state.json 的 task+audit 推导，零额外记账——audit 本就全量留痕含 actor）；`GET /metrics` 出数，看板顶栏指标 chips 常驻（当前值 vs 目标值，越线标色）。「什么算干预」的清单枚举写死在 domain.js，防口径漂移。

| # | 指标 | 定义（公式） | 初始目标 | 越线处置 |
|---|---|---|---|---|
| 1 | **@npc 任务全自动完成率** | 终态 `done` 且 audit 中 actor=user 干预数=0 的任务 ÷ 全部已完结任务（用户取消/归档的排除在分子外、计入指标3） | M2 观察期 ≥60%；M3 稳态 ≥80% | 低于目标 → 抽 3 单复盘停因分布（预算耗尽/评审卡壳/派发失败/降级模拟），按最大头立项改进 |
| 2 | **封驳触发率（任务级）** | 发生过封驳（刑部驳或门下驳）的任务 ÷ 完成过 ≥1 次施工的任务；辅看轮次级封驳密度 = 封驳次数 ÷ 评审轮次 | 稳态 ≤30%；**>50% = 红线告警**（诏令/简报质量差） | >50% → 复盘 dispatch.js 简报拼装与验收清单生成质量；连续两周超线立项改进单。⚠ 解读纪律：封驳是制度在工作，**不许为压低封驳率而弱化评审**（分母用「做过施工的任务」防注水） |
| 3 | **人工干预次数/任务** | Σ(audit 中 actor=user 且 action ∈ 干预清单) ÷ 已建任务数。干预清单（枚举，写死 domain.js）：改级 / 手动推进 / 手动驳回或准奏 / 叫停 / 恢复 / 手动写产出或待办 / 重开停机任务 / 取消归档 | 稳态 ≤1 次/任务；单任务 ≥3 次自动打「需复盘」标签 | 按干预动作类型排序 → 把最高频一项做成自动化（如高频手动准奏 → 先查完成门槛判定是否过严，而不是直接放开闸门） |

**务实声明**：三条初始目标是锚定 npc-x 经验与 dsh-edict-demo 实测拍的**初始值，非承诺**——先记后判（M2 起随 audit 记账，M3 出面板），跑满 20 单复核校准一次再固化；校准机制比数值本身重要。

## 十一、风险与待验证清单

| # | 事项 | 处置 |
|---|---|---|
| 1 | `UserMessage` 精确构造（id/source 字段） | 实现期对照 dsh-edict-demo `lib/execution.js` 现成写法（真机已验证），不自行猜测 |
| 2 | @解析与主 agent 双响应 | 已定缓解：turnTail 提示行指路「结果看看板」+ tbadge 徽章（owner props 形状待验证，拿不到即降级为仅 tbadge）；再按实际干扰度决定是否升级方案 |
| 3 | `ctx.schedule` 进程退出即停 | UI/README 明确「督办仅在 DSH 运行时生效」 |
| 4 | DSH 版本兼容 | `dsh.compatibility.dshReleases` 逐版本声明（装机实测后填） |
| 5 | slot 同 priority 冲突 / 服务重名 / 顶层 ESM | 照 dsh-edict-demo 踩坑清单执行（服务名加后缀、client 无顶层 import、不打包 react） |
| 6 | 12 角色 prompt 注入量 | 精简人设 + 按需能力包（对齐 npc-x §6.6-C），禁全量总纲注入 |
| 7 | 路由前缀冲突 | 统一 `/dsh-onenpc-<n>/`，注册前探测 |
