# 仓库拓扑与镜像操作

## 拓扑

| 角色 | 位置 | 谁能写 |
| --- | --- | --- |
| **真源** | <https://github.com/zhileyo/dsh-onenpc> | 开发者本地 `git push` |
| **镜像（只读）** | <https://cnb.cool/zhileyo/dsh-onenpc> | 只有 `.cnb.yml` 里的 git-sync 拉取流水线 |

数据流是单向的：

```
本地开发 ──push──▶ GitHub（真源） ──CNB 定时 pull──▶ CNB（镜像）
```

CNB 侧没有任何「推送 GitHub」的流水线，GitHub 侧也没有 workflow，所以提交只
往一个方向走。CNB 的 `.cnb.yml` 用
[`tencentcom/git-sync`](https://cnb.cool/cnb/plugins/tencentcom/git-sync) 的
`sync_mode: pull` 主动拉取，每小时一次，也可以手动触发。

拉取是逐字节镜像，所以**两边 commit SHA 完全一致**，随时可以直接比对。这也是
`.cnb.yml` 会出现在 GitHub 仓库里的原因：它就是镜像机制本身。

## 首次建仓（已完成，留档）

本项目原先没有任何远端（`D:\Projects\dsh-onenpc` 是普通目录），所以这里是
「首次建仓」而不是「从别处迁移」：

1. 本地 `git init -b main`，提交全部源码；
2. 建 GitHub 空仓 `zhileyo/dsh-onenpc`，`git push origin main`；
3. 建 CNB 空仓 `zhileyo/dsh-onenpc`，把 GitHub 的历史搬一次（见下节），
   之后全靠定时拉取；
4. 配 `origin`（GitHub）与 `cnb`（CNB）两个远端，日常只推 `origin`。

## CNB 侧首次基线

为什么必须人工搬一次：CNB 得先在本仓库某个分支里读到 `.cnb.yml`，才知道有拉取
流水线；空仓没有分支，定时任务无从解析。之后才是纯拉取。

二选一：

**A. 云端导入（不动本地）** — CNB 新仓库 → **云原生开发**，欢迎页「迁移已有仓库」，
粘贴 `https://github.com/zhileyo/dsh-onenpc.git`，一键导入完整历史，SHA 与 GitHub 一致。

**B. 本地首推（一次性）**

```powershell
git push cnb main     # 普通 push，不是 --force
```

推到空仓等价于把 GitHub 的提交原样放进来，同样是快进基线。

然后 `zhileyo/dsh-onenpc` → **设置 → 云原生构建**：勾选**允许自动触发**
（定时任务才跑得起来）；去 **流水线 → 触发构建** 点
`mirror-from-github-manual`，确认拉取流水线本身是通的。

## 日常流程

```powershell
git push origin main       # origin = GitHub，真源
```

CNB 会在下一个整点跟上；想立刻同步就在 CNB 页面手动触发一次
`mirror-from-github-manual`，或者用命令行：

```powershell
cnb build start-build --repo zhileyo/dsh-onenpc --branch main --event api_trigger
```

`.cnb.yml` 里 crontab / web_trigger / api_trigger 三个入口指向同一个 job，
拉取逻辑只有一份。**不要在 CNB 侧提交**：pull 是强制镜像，那里的改动
会在下次拉取时被覆盖。

## 验证镜像是否对齐

```powershell
git ls-remote origin main    # GitHub
git ls-remote cnb main       # CNB
```

两个 SHA 必须一致。

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 定时任务不跑 | 仓库或组织的「允许自动触发 / 允许定时任务自动触发」没开；或 `.cnb.yml` 没被解析（随手改一次文件重新 push） |
| 流水线成功但 CNB 没变 | git-sync 的 `target_url` 写错，或目标分支不是 `main`；看日志里 `git fetch` 的输出 |
| 拉取报非快进 | CNB 侧有 GitHub 没有的提交（网页上改过文件、或导入时做过初始化）；删掉那条提交重建基线 |
| 两边 SHA 不一致 | 有人往 CNB 侧提交过，或拉取失败；手动触发一次拉取即可回到一致 |
| `git push origin` 被拒 | 本地落后于 GitHub；先 `git pull --rebase` |

## 若真源改回私有

1. 在 CNB 密钥仓库里加 `GIT_USERNAME` / `GIT_ACCESS_TOKEN`（fine-grained
   token，Contents: Read-only 即可）；
2. 在 `.cnb.yml` 两个 job 里取消 `username` / `password` 两行的注释，
   并补 `imports:` 指向密钥仓库。

## 与安装脚本的关系

`scripts/install-profile.ps1` 建的是指向 `D:\Projects\dsh-onenpc` 的 junction，
与远端拓扑无关：换机器时 clone 到任意路径后改脚本里的 `$srcDir` 即可。
包名 `dsh-onenpc`、数据目录 `$DSH_HOME/onenpc`、命令 `/npc` 都是运行时契约，
不随仓库改名而变。

## 发布（npm + GitHub Release）

发布跑在 **GitHub Actions**（`.github/workflows/release.yml`），因为 GitHub 是真源；
CNB 镜像不需要、也不允许有发布流水线。

工作流**推 `main` 就跑**（也可以手动 dispatch）：自测 → 读 `package.json` 版本 →
registry 上没这个版本就发布 → `npm pack` → 自动打 `v<版本>` tag 并建 Release。

两个刻意的设计：

- **幂等**：版本已经在 registry 上就只跑自测、不发布。所以「忘了 bump 版本号」的
  提交不会重复发布，也不需要把 tag 推送当成开关。
- **总开关**：仓库变量 `NPM_PUBLISH=1` 才会真发。没设时只跑自测与打包，这样
  在信任关系绑好之前 push 不会把 CI 跑成红色。


### 一次性准备（推荐 Trusted Publishing）

npm 正在收紧长期 token 的发布能力，所以本仓库按「无 token」方案设计：

1. **手工发首版一次**（包还不存在，trust 配置无处可挂）：

   ```powershell
   npm login                 # 已是 zhileyo
   npm publish --access public   # 会要一次 2FA 验证码
   ```

2. **一条命令绑定 GitHub Actions**（npm ≥ 11.15，本机 11.19 满足）：

   ```powershell
   npm trust github dsh-onenpc --file release.yml --allow-publish
   npm trust list dsh-onenpc      # 复查
   ```

   `--repo` 可省略：npm 会取 `package.json` 的 `repository.url`（已指向
   `github.com/zhileyo/dsh-onenpc`）。

3. **删掉 workflow 里的 `NODE_AUTH_TOKEN`**：

   `release.yml` 的「发布到 npm」步骤去掉 `env:` 两行即可。OIDC 由
   `id-token: write` 提供，provenance 自动带上。

绑定必须人工过 2FA，这是 npm 的规则不是偏好：2026-07-31 起带 bypass-2FA 的
Granular Access Token **不能再改**可信发布配置；同一公告写明 **2027-01 起这类
token 也将失去直接 `npm publish` 的能力**，只剩读私有包和「暂存发布、人工批准」。
所以 Automation Token 只是过渡方案：npmjs.com → Access Tokens 生成 Automation
token，存进 GitHub Secrets 的 `NPM_TOKEN`，workflow 加回 `env:` 即可用，到期再换。

### 2027-01 之后（token 直发到期）

npm 公告：bypass-2FA 的 Granular Access Token 届时只剩「读私有包 + 暂存发布」，
不能再直接 `npm publish`。三条替代路线：

| 路线 | CI 侧 | 人工侧 | 适合 |
| --- | --- | --- | --- |
| **A. Trusted Publishing（本仓库默认）** | OIDC，无需任何 token | 一次性绑定 | 想全自动 |
| **B. Staged 发布** | `npm stage publish`（不需要 2FA） | 每次 `npm stage approve <stage-id>` 过 2FA | 想人工把关/先审包 |
| **C. 本地手发** | — | `npm login`（2 小时会话）+ `npm publish` 过 2FA | 极少发版 |

本仓库已在 A 路线上，所以两个月后**不需要做任何改动**——只要绑定做过一次。
只有当初选了 token 路线才需要迁移：换 A，或把 workflow 的 `npm publish` 改成
`npm stage publish` 并人工批准。

B 路线的细节：`npm stage publish` 任何 token 类型都能跑、不弹 2FA；
`npm stage approve` 必须 2FA。可信关系也支持细分权限
（`--allow-publish` / `--allow-stage-publish`），即可以「只允许暂存、不许直发」。
对高价值包可以在 npm 的 package access 页选
「Require two-factor authentication and disallow tokens」彻底禁掉 token 发布。

注意：本地已经发过 0.0.1 就**不要**再推 `v0.0.1` tag——publish 步骤会撞
`EPUBLISHCONFLICT`；从下一个版本开始用 tag 发。

包名现状：`dsh-onenpc` 在 registry 上尚未占用（`npm view` 404），可以公开发。

### 每次发版

```powershell
# 1. 改版本（0.0.1 → 0.0.2 之类），顺手更新 README 状态行
npm version 0.0.2 --no-git-tag-version
git commit -am "chore(release): v0.0.2"

# 2. 推真源——这一步就是发布
git push origin main
```

workflow 自己判断版本是否已发布，没发过就发，然后自己打 tag、自己建 Release。
不需要手动 `git tag` / `git push --tags`。

跑完检查：

```powershell
npm view dsh-onenpc version                 # registry 上的版本
gh release list --repo zhileyo/dsh-onenpc
```

### 发什么

`npm pack` 只看 `package.json` 的 `files`：`lib/`、`public/`、`assets/icon.svg`、
`cordis.patch.yml`、`README.md`，加上强制包含的 `LICENSE` / `package.json`，
共 12 个文件、约 67 kB（`scripts/`、`analysis/`、`.agents/`、`KANBAN.json` 不进包）。

### 版本与兼容

- 1.0 之前用 `0.0.x`，破兼容再进 `0.1.0`；
- `package.json` 的 `dsh.compatibility.dshReleases` 是给宿主的兼容矩阵，
  每次适配新的 DSH 版本记得加一条（当前只有 `0.2.1-rc.3: compatible`）。

### 镜像与 tag

tag 推 GitHub 后，CNB 的 pull 是否带走 tag 取决于 `git fetch` 的行为，可以查：

```powershell
git ls-remote --tags cnb
```

若 CNB 上缺 tag，在 `.cnb.yml` 的 `settings` 里补一行
`fetch_options: "--tags"`，再触发一次拉取。

### 发布前的自查清单

- [ ] `npm run check:fast` 本地绿（136 项）
- [ ] `npm run smoke` 在人机环境绿（沙箱里 spawn 会被拦，属环境限制）
- [ ] `package.json` 版本与要推的 tag 一致
- [ ] `README.md` 的状态行、`docs/REPO.md` 的镜像说明没有过期
- [ ] 没有把本机绝对路径、token 写进将发布的内容
