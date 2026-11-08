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
