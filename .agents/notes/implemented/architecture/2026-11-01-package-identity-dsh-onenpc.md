# Agent Note: package-identity-dsh-onenpc

Status: implemented

## Problem

包名 dsh-edict 是在「npcteam / dsh-edict / dsh-npc」多轮比较后暂定的，但它有三个实际问题：npm 上 dsh-edict 已被 littlecwr 以 0.1.8 占用（同题材、纯工具实现），本地兄弟项目 dsh-edict-demo 的 package.json name 也是 dsh-edict，三方同名；命名探索还发现 dsh 命名空间里的通用编排词已被同赛道作者系统性占位（dushaobindoudou 的 dsh-npc / dsh-council / dsh-cabinet / dsh-dynasty，wwq9979 的 dsh-quorum 0.5.0「role cards + quorum 终止 + 证据门 + 成本预算」，ikeyuchen 的 dsh-hive 0.0.1「board of tickets + crew of agents」）。继续用 dsh-edict 等于把项目挂在一个已被人占用、且与本地 demo 同名的身份上。

## Decision

包身份改为 dsh-onenpc，语义是「对外一个 NPC，对内一个朝廷」：用户只跟一个 @npc 入口说话，背后是三省六部 12 角色。落点七处，与上一次改名同一套清单：package.json name、cordis.patch.yml 的 insert id 与 name、宿主侧 lib/index.js:43 `export const ROUTE_PREFIX = '/dsh-onenpc-7312'`、浏览器侧 lib/client.js:26 同名常量逐字一致、lib/client.js:398 `window.__ModuleLoader__.load({ id: 'dsh-onenpc', ... })` 与 :318 `data-plugin-css`、/meta 自述 name 与 state.source、数据目录 `$DSH_HOME/onenpc`（注意目录是裸 onenpc，不带 dsh- 前缀；`join(home, 'onenpc')` 与 dev-server、smoke 三处一致）。

内部行为契约仍然一律叫 npc，一个字都没动：面板 key `'npc'`、`/npc` 命令、`@角色名` 解析、public/ui.html 的 `.npcx` 与 `data-npc-base`、`export const name = 'npc'`。onenpc 只是把 npc 放进一个更长的词里，不构成任何契约变更。

源码目录暂时仍叫 D:\Projects\dsh-edict：改目录会让正在运行的 GUI 会话失去 cwd，所以 install-profile.ps1 的 $srcDir 与 README 都指向旧目录，并都写明「等包名稳定、会话重启后再把目录改成 dsh-onenpc 并重跑安装脚本」。这不是遗漏，是刻意的时间差。

存储三迁：$DSH_HOME/dsh-npc → dsh-edict → onenpc。迁移时 onenpc 里已有一份活体运行时抢先写下的种子 state（2 单，16976 B），备份为 state.json.seed-<时间戳> 后让位；真数据（6 单、version 235、98 条审计、3 份 report.md）整体搬入，dsh-edict-demo 的 327KB 骨架备份 state.json.bak-dsh-edict-demo-20261101-174418 一并移入保留出处，随后删除空壳 $DSH_HOME/dsh-edict。

注册脚本从此维护旧名列表 `$staleNames = @('dsh-npc', 'dsh-edict')`：所有旧名的 junction 一律删除（它们都是本项目自己，不再判断「源码目录是否还存在」），dependencies 逐行删除旧名并修掉可能悬空的逗号（`',(\s*)([}\]])'` → `'$1$2'`），bundles 里的旧名替换为 dsh-onenpc，末尾 ConvertFrom-Json 校验「新名在、旧名不在」。
## Alternatives considered

**dsh-npcteam / npcteam**：npm 四个变体全空、语义干净（npcteam 是 npc + team），但它是通用「agent 团队」词，正好落在 dsh-hive（board + crew）与 dsh-quorum（agent teams）已发布产品的赛道上，读者会先把它归类成又一个 crew 工具，而看不出封驳/诏令/审计这套机制。

**npcone**：同样全空（GitHub 仅一个无关 crypto 仓、npm 搜索零结果），但 `npcone` 与 `cone` 同尾，英文读感上会变成 "NPC cone"，且 `one` 把产品读成「一个 NPC」，与一队角色 + 派单的产品事实相反。

**dsh-sansheng / dsh-six-ministries**：官制辨识度最高、也全空（sansheng 还有「三省六部 / 三省吾身」双关），但都是拼音或长词，放弃 npc 血统，而内部契约、命令、CSS 前缀全叫 npc，名字与实现会脱节。

**继续用 dsh-edict 只打标签**：上一轮的选择，能避免第二次全链路改名；但 npm 同名冲突与「与 demo 同名」两个隐患不消失，且 edict 同样不承载 npc 血统，最终仍要改。

**改用 dushaobindoudou 占下的 dsh-council / dsh-cabinet / dsh-dynasty**：名字本身贴切，但已被他人以 0.0.1 预留，且对方在用同一套官制隐喻，撞名又撞主题。
## Consequences

改名后 npm 同名问题消失：dsh-onenpc / onenpc 均 404 空闲，GitHub 无占位，将来发布不必再换名（与 littlecwr 的 dsh-edict、dushaobindoudou 的 dsh-npc 的冲突一并解除）。代价是第二次全链路手术：16 个文件批量替换（用 `@@DEMO@@` 占位保护 dsh-edict-demo 的 35 处引用，避免把骨架项目名一起改掉）、数据再迁一次、profile junction/deps/bundles 再注册一次。

一个必须记住的工具级教训：Windows PowerShell 5.1 读取**无 BOM 的 UTF-8 .ps1** 时会按 ANSI 解码，中文注释被解错后行号偏移，脚本报 `Unexpected token '}'` 而实际语法完全正确（同一文件在 pwsh 7 下 PARSE OK）。install-profile.ps1 因此必须以 UTF-8 **带 BOM** 保存——改写脚本后如果 5.1 报莫名解析错误，先查 BOM 再看语法。

验证：domain 136 项、smoke 214 项全过；dev-server 实跑 /dsh-onenpc-7312/ui 返回 200 且 `data-npc-base` 正确，/meta.name=dsh-onenpc、prefix=/dsh-onenpc-7312，POST /tasks 201、/state.source=dsh-onenpc；profile 里 junction `dsh-onenpc → D:\Projects\dsh-edict`、deps.dsh-onenpc=link:…、bundles 20 项含新名且无 dsh-npc/dsh-edict。

仍未完成：**重启 DeepSeekRuntime** 才生效；源码目录改名 + $srcDir 更新留作后续（否则 dsh-edict 目录名会一直与包名不一致）。

