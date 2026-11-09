# AGENTS.md

给在本仓库动手的 AI agent 与贡献者的操作手册。人类向的介绍、安装步骤与界面说明在
[README.md](README.md)；这一页只回答三件事：**怎么跑、改哪里、别碰什么**。

## 项目是什么

`dsh-onenpc` 是 **DeepSeekRuntime（DSH）插件**「三省六部 · 任务看板」：把
[npc-x](../npc-x)（CNB 平台版「无人值守多 NPC 协作体系」）搬进 DSH——对话框里
`@npc` 一个入口，背后是 12 角色班子、任务看板、流程节点详情与产物。

目标宿主 **DSH 0.2.1-rc.3**（`package.json` 的 `dsh.compatibility.dshReleases`）。
包名沿革 `dsh-npc` → `dsh-edict` → `dsh-onenpc`；**每次改名都没动运行时标识符**，
原因见「硬约束」第 1 条。

## 环境

| 项 | 值 |
| --- | --- |
| Node | `>=22.12.0`（`engines`） |
| 包管理器 | npm；**没有 `dependencies`、没有 lockfile**，运行时依赖全是 `peerDependencies` |
| 宿主 | DSH 0.2.1-rc.3 + `react`/`react-dom` 18 |
| 开发机 | Windows + PowerShell（示例命令用 `pwsh`） |
| 数据目录 | `$DSH_HOME/onenpc/`：`state.json`（任务/公文/审计/执行记录）+ `artifacts/`（diff、报告） |

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run domain`（=`check:fast`） | 纯函数层断言（当前 136 项）。不 spawn 子进程，任何环境都能跑 |
| `npm run smoke` | 宿主半侧 HTTP 契约 + M2 执行链。会用 `execFile` 起**真实临时 git 仓**，需要进程权限 |
| `npm run check` | 两者串联，= 提交前基线 |
| `npm run dev` | `node scripts/dev-server.mjs [--port 7412] [--shared]`，把宿主路由原封不动挂到本机 |
| `pwsh -File scripts/install-profile.ps1` | 装进本机 desktop profile：建 junction、补 `dependencies`（`link:`）与 `dsh.profile.bundles`，顺手清旧名残留 |

断言条数以脚本自报为准，别信文档里的数字（会过期）。

## 代码地图

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | 宿主半侧 Cordis 插件：`NpcStore`（`state.json` 持久化）、`createRouter`、`createDispatcher`、`apply`、`ROUTE_PREFIX` |
| `lib/domain.js` | 领域内核（纯函数）：12 角色注册表、编档（M/L/XL）、编成节点、状态机 |
| `lib/pipeline.js` | 流水线 M3：全自动流转、评审闸门、预算、封驳断路器 |
| `lib/execution.js` | 执行层：宿主事件映射、diff 产物、旁路工具 |
| `lib/metrics.js` | 三条成功指标的**唯一口径**（与 `analysis/02-design.md` §十 对齐） |
| `lib/client.js` | 浏览器半侧：注册「三省六部」tab（同源 iframe 指向 `public/ui.html`）、fetch 封装 |
| `public/ui.html` | 界面本体，单文件（宿主路由 `/dsh-onenpc-7312/ui` 直接提供） |
| `cordis.patch.yml` | bundle patch：把插件挂进 DSH 配置树 |
| `scripts/` | `domain-test.mjs` / `smoke.mjs` / `dev-server.mjs` / `http-probe.mjs` / `install-profile.ps1` |

## 硬约束

1. **运行时标识符是兼容面，不要顺手改名。** 下面这些属于宿主契约或用户已有数据的落盘位置，
   改动即破坏兼容：
   - `ROUTE_PREFIX = '/dsh-onenpc-7312'`（`lib/index.js:43`、`lib/client.js:26`）
   - `<html data-npc-base>`（`lib/index.js:748` 注入，界面据此定 API 根）
   - `$DSH_HOME/onenpc/state.json`、`$DSH_HOME/onenpc/artifacts/`
   - 宿主侧路由（`lib/index.js` 的 `createRouter`，权威清单见 `/meta` 的 `endpoints`）：
     `GET /health|/state|/roles|/tasks|/tasks/:id|/audit|/executions|/executions/:id|/hints|/artifacts/:task/:node/:file|/ui`、
     `POST /tasks|/tasks/:id/triage|/tasks/:id/action|/tasks/:id/dispatch|/tasks/:id/nodes/:nodeId/stop|/tasks/:id/nodes/:nodeId/doc|/config|/dev/reseed`
2. **`.cnb.yml` 是 CNB 侧拉取镜像本体。** 只允许 `tencentcom/git-sync` +
   `sync_mode: pull` + `crontab`/`web_trigger`/`api_trigger`；**不要加任何从 CNB 推 GitHub
   的流水线**——那会和拉取形成回环。三个触发入口共用同一份 job（YAML 锚点
   `.mirror-from-github`），改完要重新同步定时任务（`cnb build build-crontab-sync`）。
3. **只往 GitHub `origin` 推。** CNB 是只读镜像，`git push cnb` 只在首次 bootstrap 时用过。
4. **发布是「推 main 即发」**（`.github/workflows/release.yml`）：自测 → 查
   `npm view dsh-onenpc@<version>` → 没发过才 `npm publish --provenance` → 自己打
   `v<version>` tag → 建 Release。要点：
   - **版本幂等**：版本已存在就只跑自测。所以「忘了 bump」的提交不会重复发布，也不需要
     手动 `git tag`。
   - **总开关**：仓库变量 `NPM_PUBLISH=1` 才真发；没设时只跑自测与打包。别为了「简化」
     删掉这道闸——信任关系没绑好之前，push 会把 CI 跑成红色。
   - **认证是 OIDC，不是 token**：保持 `id-token: write`，**不要加回 `NODE_AUTH_TOKEN`**
     （它会让 npm 放弃 OIDC），也不要给 `setup-node` 加 `registry-url` 之外的认证配置。
     npm 版本要 ≥ 11.15（Node 24 自带 npm 11；Node 22 的 npm 10 换不到 OIDC 令牌）。
   - Trusted Publisher 关系只能挂在**已存在**的包上，所以首版是本地手工
     `npm publish` 发的；之后用 `npm trust github dsh-onenpc --file release.yml --allow-publish`
     绑定（要 2FA）。一个包只允许一条 trust 配置。
   - 2027-01 起 bypass-2FA 的 granular token 失去直接发布能力，别再走 token 路线。
     细节见 [docs/REPO.md](docs/REPO.md)。
5. **`cordis.patch.yml` 的 `id` 必须全局唯一且等于包名**，而且 `id:` 那一行**绝不能写行尾
   注释**——宿主商城预检用正则匹配「值 + 直接换行」，行尾注释会让它抓不到 entry ID。
6. **不新增运行依赖。** 只用宿主提供的 `@deepseek-ai/*` 与 `react`；新增第三方依赖前先问，
   因为插件装进的是别人的桌面运行时。
7. **`scripts/install-profile.ps1` 必须保持 UTF-8 带 BOM。** PowerShell 5.1 读无 BOM 的
   UTF-8 会 `Unexpected token '}'`。用 PS 7 的 `Set-Content -Encoding utf8` 改写会去掉 BOM，
   改完要补回来。
8. **「模型说话、代码裁决」。** 状态机、评审闸门、预算、封驳断路器一律在
   `lib/pipeline.js` / `lib/domain.js` 的代码里；模型只提供意见（拆解/评审结论/验收结果）。
   别把判定逻辑挪进 prompt。

## 代码约定

- ESM（`"type": "module"`），Node 内置模块只在宿主半侧用；`lib/client.js` 里不碰 node 内置。
- 文档与注释用中文；注释写**为什么**，不写「做了什么」。
- 提交信息用 conventional commits：`feat:` / `fix:` / `docs:` / `ci:` / `chore:`。
- 改行为就先加断言：领域规则进 `scripts/domain-test.mjs`（纯函数、零依赖、秒级），
  宿主契约与执行链进 `scripts/smoke.mjs`。

## 文档地图

| 文件 | 内容 |
| --- | --- |
| [README.md](README.md) | 特性、安装、界面入口、开发、发布、仓库与镜像拓扑 |
| [docs/REPO.md](docs/REPO.md) | 真源/镜像/发布的逐步操作清单、排错、`cnb` CLI 用法 |
| [analysis/01-npc-x-analysis.md](analysis/01-npc-x-analysis.md) | npc-x 原体系的拆解与移植取舍 |
| [analysis/02-design.md](analysis/02-design.md) | 设计文档：状态机、闸门、指标口径、风险清单 |
| `.agents/notes/implemented/` | 已实施的架构与 bug-fix 记录（带日期，只增不改） |
| [KANBAN.json](KANBAN.json) | 项目自身的看板档案（**不是运行时数据**，`lib/` 与 `ui.html` 都不引用它） |

`KANBAN.json` 是交接用的静态档案：完成一块活就把对应卡置 `done` 并写清验证方式，
新增待办就加卡。它跟着提交一起更新，但**不要**把它接进运行时。

## 已知陷阱

- **受限环境跑不了 `smoke`**：它要 `execFile` 起临时 git 仓，沙箱里会
  `EPERM spawn`。这不是代码问题，用 `npm run check:fast` 兜底，并在有进程权限的环境补跑。
- **本机 git 直连 HTTPS 会报** `schannel: AcquireCredentialsHandle failed:
  SEC_E_NO_CREDENTIALS (0x8009030e)`；加 `-c http.sslBackend=openssl` 可解。
  沙箱里 `sh.exe` 起不来（`couldn't create signal pipe`），所以 `!` 形式的 credential
  helper 与 Git Credential Manager 全废——推送只能把 token 塞进 URL
  （`https://zhileyo:<token>@github.com/...`），别把 token 写进 `.git/config`。
- **别用 `Invoke-WebRequest` 探测 GitHub/CNB**（本机 schannel 证书问题会 SSL 失败），
  用 `gh` / `cnb` CLI。
- **`cnb build start-build` 的 `--event` 只认 `api_trigger`/`api_trigger_*`**；传
  `web_trigger` 会 400。网页按钮是另一条路径。
- **npm 对新包名有创建速率限制**：短时间发多个从没出现过的名字会 `E429`；已上架的包发
  新版本不受影响。
- **看到「CI 说发了、registry 查不到」先别升版本号**：可能是 OIDC 发布退化成了 staged
  发布，用 `npm stage list dsh-onenpc` 查待审批记录，有就 `npm stage approve <stage-id>`
  （要 2FA）。
- `.dsh-dev-home/`、`state.json`、`artifacts/`、`*.tgz` 是本地/构建产物，已被 `.gitignore`
  挡掉，不要提交。
