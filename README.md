# dsh-onenpc · 三省六部（DeepSeekRuntime 插件）

把 [npc-x](../npc-x)（CNB 平台版「三省六部 · 无人值守多 NPC 协作体系」）移植成 DeepSeekRuntime 插件：
对话框 **@npc / `/npc` / 🏯 按钮** 直达办事、任务看板、角色泳道流程图、节点详情与产物（git diff / 执行汇报）。

> **对外一个 NPC，对内一个朝廷。** 你只需要跟一个 `@npc` 入口说话；背后是三省六部 12 个角色——中书令拆解、门下省封驳、刑部初审、太史令审计、六部执行，全部由一个 NPC 的名字对外。

当前状态：**M3 流水线完成 + 流程全面对齐 npc-x §8**（2026-11-01）——domain 121 项 + smoke 146 项自测全过；**真机（DeepSeekRuntime 内）验证待安装后进行**。

## 仓库与镜像

| 位置 | 角色 | 地址 |
| --- | --- | --- |
| GitHub | **真源**（唯一推送目标） | <https://github.com/zhileyo/dsh-onenpc> |
| CNB | 只读镜像（每小时拉取一次） | <https://cnb.cool/zhileyo/dsh-onenpc> |

```
本地开发 ──push──▶ GitHub（真源） ──CNB 定时 pull──▶ CNB（镜像）
```

- 日常只有 `git push origin main`；`origin` = GitHub，`cnb` = CNB。
- **不要在 CNB 侧提交**：`.cnb.yml` 是 pull 式镜像，那里的改动会被下次拉取覆盖。
- 刚推完想立刻对齐：CNB 仓库页 → 流水线 → 触发构建 →
  `mirror-from-github-manual`。
- 镜像机制、首次基线、排错见 [docs/REPO.md](docs/REPO.md)。

## 发布

**推 `main` 即发布**（`.github/workflows/release.yml`，跑在 GitHub Actions）：

```bash
npm version 0.0.2 --no-git-tag-version
git commit -am "chore(release): v0.0.2" && git push origin main
```

工作流跑自测 → 发现 registry 上没有这个版本就 `npm publish --provenance` →
自己打 `v0.0.2` tag → 建 Release 附 tarball。版本已存在就只跑自测，不重复发布。

两个前置：仓库变量 `NPM_PUBLISH=1` 打开总开关；npm 侧用 **Trusted Publishing**
（OIDC，仓库里不存任何 token）。首次绑定与细节见
[docs/REPO.md](docs/REPO.md#发布npm--github-release)。

## 流程（完全对齐 npc-x §8 状态机，档位差异化落地）

```
[0 立项]（循环外，仅一次，M+）需求 → 验收清单（acceptance，唯一增删权=调度方）
  ▼
┌─ 第 N 轮循环（rounds，无上限，护栏跨轮累计）──────────────────┐
│ [1 拆解]  中书令拆解本轮差距 → 诏令（范围+前置+b_t）            │
│           └ 可声明「增派：<角色> <任务>」动态插入协作节点（≤3）  │
│ [前置评审]（XL）门下施工前审方案 ──驳──▶ 打回拆解（回[1]）       │
│ [2 派单→施工] 施工/备环境(户)/部署(兵)/文档(礼)=真子会话+diff    │
│ [3 初审]  刑部 ──不过──▶ 封驳打回施工（回到[2]）                │
│ [4 复审]  门下 ──驳──▶ 打回（回到[2]）                          │
│ [5 收口]  质量门全过 → 确认 + 自动提交（自动合并等价物，可配置关）│
│ [6 部署→文档] 兵部构建部署 → 礼部同步文档（L/XL）               │
│ [审计]    太史令学习审计+经验卡（XL）                           │
│ [7 验收]  中书令对照验收清单逐条核对：                          │
│      ├─ 全部满足 → 轮次 accepted → [交付]                       │
│      └─ 仍有差距 → 差距写成第 N+1 轮目标，回[1]（appendRound）   │
└───────────────────────────────────────────────────────────────┘
[交付] 中书令产出最终交付报告（task.delivery）
```

**档位差异化**（对齐 npc-x §6.5 判级表）：

| 档 | 节点 | 执行者 |
|---|---|---|
| **直** | 承办×1（入口角色） | askLLM 一轮，回复即交付 |
| **S0** | 施工 → 初审 | 施工=真子会话 |
| **S1** | 拆解 → 施工 → 初审（**拆解可增派领域角色**：礼部/户部…插入承办节点） | 增派=askLLM，施工=真子会话 |
| **M** | 立项 + 拆解→施工→初审→复审→收口→验收 | 拆解可增派 |
| **L** | + 派单(尚书)、**备环境(户)、部署(兵)、文档(礼)** 均真子会话 | 标准班子 8 角色 |
| **XL** | + **前置评审(门下，施工前审方案，驳→打回拆解)**、**审计(太史令经验卡)** | 完整班子 9 角色 |

执行者分工：施工/备环境/部署/文档 = 真子会话（改工作区、截 diff）；其余节点 = askLLM 直调。质量门 fail-closed（结论解析不出按驳；评审模型缺席停机不降级）。护栏（封驳计数 N/3、预算 calls 24/tokens 30万/步 40）跨轮累计，代码化不靠提示词。

## 本地验证 / 预览

```bash
npm run check        # domain 121 项 + smoke 146 项（约 4 秒）
npm run dev          # 独立服务器 http://127.0.0.1:7412（默认临时数据目录；--shared 用真实数据）
```

smoke 的执行链用**伪 agents/llm + 真实临时 git 仓**覆盖：派发（git 基线+简报）→ 事件回写 → diff 产物落盘；§8 流程覆盖：全自动一单（立项产清单→拆解→施工→初审→复审→收口**自动提交**→验收→交付报告）、初审驳回→施工打回→重做→再审通过（轮内循环）、验收不满足→差距开新轮、连驳 3 次断路器停机→重开归零、LLM 用量打爆预算→闸门停机、成功指标三公式精确断言。dev-server 里 `ctx.agents` 缺席，交办按钮如实降级为「不可用」。

## 已有能力（M0+M1+M2）

| 层 | 能力 |
|---|---|
| 领域（domain.js） | 12 角色注册表（人设精简）· 判级三层（LLM 主判 / 默认 M 兜底 / 手动改级）· 任务/节点状态机（顺序守卫=施工串行；reject 支持 done 节点打回；redo 回待办；reopen 评审重开）· 公文四式 · 封驳计数 · 审计留痕（被拒也记）· 任务级流水线状态与预算记账 |
| 宿主（index.js） | state.json 原子持久化 · 长轮询 · `/npc` 斜杠命令 · @解析 · dispatcher（判级 LLM → 选节点 → git 基线 → agents.create+steer → 事件回写 → diff/报告产物落盘 → 节点收口）· 流水线定时步进（5s，同任务串行/全局 ≤2）· 交办/叫停/执行/产物/配置/流水线路由 |
| 流水线（pipeline.js） | nextStep 决策（施工=真子会话，其余=askLLM 直调）· 评审/验收 fail-closed（结论解析不出按驳；评审模型缺席停机不降级）· 封驳断路器（达 3 停机，重开可 reset 归零）· 预算闸门（calls 24/tokens 30 万/步 40，宁中止不可无界烧）· 多轮循环（驳→打回→重做→再审） |
| 界面（ui.html） | 顶栏成功指标 chips（全自动/封驳/干预，红线标色）· 任务卡「▶自动中/⏹停机」徽章 · 详情页流水线控制行（自动/停/走一步/重开+停因+预算余量）· 交办/叫停 · 执行状态 · 产物区（diff 红绿懒加载/报告可复制）· 执行配置卡 |
| 对话入口（client.js） | 会话头 tab + 侧栏🏯 + main 面板 + 设置页 · 输入框左侧「🏯 召 NPC」迷你下旨弹层 · turnTail @命中提示行（owner props 待真机校准） |

## 装进本机 desktop profile（真机验证）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-profile.ps1
```

脚本幂等：建 junction `node_modules\dsh-onenpc → D:\Projects\dsh-onenpc`，并给 `dependencies`（`link:` 形式）
与 `dsh.profile.bundles` 各补一条 `dsh-onenpc`；旧名 `dsh-npc` / `dsh-edict` 的悬空链接与依赖条目顺手清掉。装完**重启 DeepSeekRuntime**。

> **包名沿革（2026-11-01）**：`dsh-npc` → `dsh-edict` → **`dsh-onenpc`**。最终命名的理由：对外一个 NPC、对内一个朝廷——用户只跟一个 `@npc` 入口对话，背后是整套班子。依赖与 bundles 缺一不装（见 dsh-edict-demo 教训）。
> 数据目录随之三迁：`$DSH_HOME/dsh-npc` → `$DSH_HOME/dsh-edict` → **`$DSH_HOME/onenpc`**；该目录里原有的骨架（dsh-edict-demo）数据已备份为 `state.json.bak-dsh-edict-demo-<时间戳>`。
> 源码目录已随之改为 `D:\Projects\dsh-onenpc`（此前为 `D:\Projects\dsh-edict`）；`install-profile.ps1` 的 `$srcDir` 同步更新，改过目录后重跑一次安装脚本即可让 junction 指到新路径。

**真机验收清单（M2 验收标准）**：
1. 设置页出现「三省六部」一节、左侧栏出现 🏯、会话头出现「三省六部」tab；
2. 角色总览 → 执行配置：确认「子会话环境 ✅ 可用」；填默认工作目录（一个 git 仓）保存；
3. 对话框输入 `/npc 工部尚书 在默认目录里加一个 hello.txt 内容随便` → 应见「已立项 TASK-n」卡片；
4. 看板里该任务施工节点自动 running，办完自动 done，产物区有 **diff（红绿）+ 执行汇报（可复制）**；
5. 消息里发 `@中书令 <需求>` → turnTail 出现「📨 已转交」提示行（若未出现，看 DevTools console 里 `[dsh-onenpc] turnTail props keys:` 的探测输出，校准 `lib/client.js` 的 props 解析——这是设计文档 §十 风险 #2 的既定校准路径）。

## 文档

- [analysis/01-npc-x-analysis.md](analysis/01-npc-x-analysis.md) — 移植源调研：npc-x 是什么、哪些搬哪些不搬
- [analysis/02-design.md](analysis/02-design.md) — 设计方案：架构/数据模型/@npc 交互/接口/里程碑/成功指标
- [docs/REPO.md](docs/REPO.md) — 仓库拓扑：GitHub 真源 + CNB 拉取镜像的日常流程与排错
- 架构先例：`D:\Projects\dsh-edict-demo`（同作者已验证的 DeepSeekRuntime 插件骨架，MIT）；插件面证据：`dsh-edict-demo/analysis/02-dsh-plugin-surface.md`

## 已拍板的关键决策（2026-11-01）

1. **@npc 交互 = A+B**：`/npc` 命令 + 输入区按钮起步；消息里 `@角色名` 解析自动建任务。不接管官方输入框。
2. **任务载体 = 纯本机**：NPC 子会话直接改本机代码/产出，验证与提交走本机 git；无 PR/远程合并语义，质量门 = 刑部/门下独立评审轮（M3）。
3. **护栏全部代码化**（封驳计数 N/3、预算闸门、完成门槛、审计留痕），不靠提示词。
4. **判级三层**：LLM（中书令）主判 + 失败默认 M 档兜底 + 看板手动改级，全部留审计可溯。
5. **diff 产物捕获 = git 基线机制**：派发前记 `git rev-parse HEAD` 基线（工作区非净如实警示），节点结束截 `git diff <baselineSha>` 外置存储；同 task 施工节点强制串行保可归因。
6. **@命中提示**：`conversation.chat.turnTail` 渲染「已转交 NPC · 结果看看板」提示行 + 看板徽章，缓解双响应困惑。
7. **成功指标三条**（看板顶栏常驻，口径单源 `lib/metrics.js`，M3 落地）：@npc 全自动完成率（M2≥60% / M3≥80%）、封驳触发率（稳态≤30%，**>50% = 诏令质量红线**）、人工干预次数/任务（稳态≤1）。初始值非承诺，跑满 20 单校准。

## 里程碑

- [x] M0 骨架（2026-11-01）：包契约 + 两半侧 + dev-server + 12 角色 domain
- [x] M1 看板（2026-11-01，随 M0 顺手完成）：任务 CRUD + 状态机 + 角色泳道 + 节点详情内嵌
- [x] M2 真对话（2026-11-01）：/npc 命令 + @解析 + 真子会话办差 + git 基线/diff 产物 + turnTail
- [x] M3 流水线（2026-11-01）：刑部/门下评审轮 + 预算闸门 + 封驳断路器 + 多轮循环 + 成功指标面板
- [ ] 真机验收：装进 desktop profile 后按验收清单走（/npc 全自动一单 L 级任务 + turnTail 校准）
- [ ] M4 治理：案例库/经验卡、定时督办、角色功绩统计

---

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
