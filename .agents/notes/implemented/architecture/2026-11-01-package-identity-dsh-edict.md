# Agent Note: package-identity-dsh-edict

Status: superseded by [2026-11-01-package-identity-dsh-onenpc.md](./2026-11-01-package-identity-dsh-onenpc.md)（包名于同日再次改为 dsh-onenpc；本笔记保留为「dsh-npc → dsh-edict」那一次改名的记录）

## Problem

项目源码目录从 D:\Projects\dsh-npc 改名为 D:\Projects\dsh-edict 后，包内身份仍是旧的 dsh-npc：package.json name、cordis patch 的 id/name、HTTP 路由前缀 /dsh-npc-7312、数据目录 $DSH_HOME/dsh-npc、浏览器侧 __ModuleLoader__ 的 id 全部对不上，desktop profile 里还留着指向已删除目录的悬空 junction，重启即装不上。需要一次把「包名 → 路由 → 存储 → profile 注册」四层贯通，否则会停在半改名状态。

## Decision

包身份统一为 dsh-edict，落在六个具体位置：package.json 的 name（version 仍 0.0.1）、cordis.patch.yml 的 insert id 与 name、宿主侧 lib/index.js:43 `export const ROUTE_PREFIX = '/dsh-edict-7312'`、浏览器侧 lib/client.js:26 同名常量与之逐字一致、lib/client.js:398 `window.__ModuleLoader__.load({ id: 'dsh-edict', ... })`、lib/index.js:914 `new NpcStore(join(home, 'dsh-edict'))` 与 /meta 自述 name。路由尾号沿用 7312，与骨架项目 dsh-edict-demo 的 7311 并存不撞。

包身份与内部行为契约是两回事，后者一律不改：面板 key `'npc'`（`slots.register({name:'main', key:'npc'})`、`layout.selectPanel('npc')`、`sidebar.panellist` id）、`/npc` 命令、`@角色名` 解析、public/ui.html 的 `.npcx` 类名与 `data-npc-base` 属性、以及 `export const name = 'npc'`（对照 dsh-edict-demo 的 `export const name = 'edict'`，这是插件短名而非包名）。也就是说：包叫 edict，插件命名空间和面向用户的「办差」命令面仍叫 npc，改名不触碰任何已生效的交互契约。

存储随之迁移而不是并存：$DSH_HOME/dsh-npc 的 state.json 与 artifacts 迁入 $DSH_HOME/dsh-edict，旧目录删除；该目录原有的骨架（dsh-edict-demo）数据备份为 state.json.bak-dsh-edict-demo-20261101-174418 后让位，不做删除。迁移后 state.json 内无 dsh-npc 字样（artifacts 里存的是相对路径）。

注册由 scripts/install-profile.ps1 承担并保持幂等：先清理悬空 junction，再从 dependencies 删除旧名条目、把 bundles 里的旧名替换为新名，末尾用 ConvertFrom-Json 校验 deps/bundles 与「无残留旧名」。脚本刻意避开两件事——不对悬空链接调用 Get-Item（Windows PowerShell 5.1 下其 Target 为 null，会抛 `Cannot bind argument to parameter 'Path' because it is null`），也不整份重写 profile package.json（用定点字符串手术，保格式与顺序）。dependencies 与 dsh.profile.bundles 缺一不装，这是 dsh-edict-demo 踩过的坑，脚本两处都写。

改完之后复查了 npm 命名空间，结论是**本地身份继续用 dsh-edict，暂不发布、也不为发布改名**：npm 上 `dsh-edict` 已被 `littlecwr` 以 0.1.8 占用（仓库 Caoran1314/dsh-edict，同题但实现不同——纯工具、无 client 半侧、数据落 `~/.dsh/edict/`、身份靠 `EDICT_AGENT_ID`），`dsh-npc` 被 `dushaobindoudou` 以 0.0.1 预留（dushaobindoudou/dsh-plugin 的 packages/dsh-npc），本地兄弟项目 dsh-edict-demo 的 name 同为 `dsh-edict`——三方同名，但都只在本地加载链路里，不构成运行时冲突；一旦要 `npm publish`，必须改用已核实空闲的名字（`dsh-npcteam` / `npcteam` / `dsh-npc-team` / `dsh-sansheng` / `dsh-liubu` 均 free）。因此「打标签」而非「改名」是当前形态：package.json keywords 扩到 15 项（补 npc、npc-team、orchestration、task-board、workflow、three-departments-six-ministries，保留 dsh / dsh-plugin / deepseek-harness / deepseek-runtime 这组发现用标签），README 末尾挂官方 powered by dsh 徽章，包名与全部内部契约不动。

## Alternatives considered

**连内部面板 key 一起改名（'npc' → 'edict'）**：会连带改 ui.html 的 slot 注册、CSS 类名前缀、@角色 解析入口与自测用例，纯内部标识改动换来零用户可见收益，且容易在改名途中漏改一处造成面板白屏，故保留 'npc'。

**数据目录沿用 $DSH_HOME/dsh-npc 以免迁移**：能省掉一次搬迁，但会长期停在「包 dsh-edict、数据在 dsh-npc」的拧巴状态，且旧目录名的 junction 已悬空，留着等于把历史包袱固化成规范。

**直接清空 $DSH_HOME/dsh-edict 里骨架项目的 state.json**：那是 dsh-edict-demo 的 327KB 数据，删了不可恢复且与本次改名无关，改为改名备份保留。

**用 ConvertFrom-Json / ConvertTo-Json 重写 profile package.json**：会重排键序、改缩进并可能改写其它字段，把一次改名变成一次全文件格式化，改用正则定位 + 字符串删除/替换，只碰目标行。

**再改一次名换成 dsh-npcteam / dsh-sansheng**：这两个名字语义更干净（npcteam 有团队感且与内部 npc key 顺承，sansheng 双关「三省六部/三省吾身」），但插件当前只经 desktop profile 本地加载、不进 npm，改名是第二次全链路手术（包名、路由、数据目录、profile、脚本），收益为零，故留给「真要发布」的时点再定。

**沿用 dsh-npc**：与内部契约最自洽（/npc、panel key 'npc'、data-npc-base、.npcx、`export const name = 'npc'`），但 npm 上已被 dushaobindoudou 以「name reserved」预留，且单数 NPC 带工具人联想，正是当初改掉它的原因，故只作为历史名保留在 README 的迁移说明里。

**去 npm 上把 dsh-edict 收编或对齐 littlecwr 的实现**：对方的实现路线是纯工具（无 client 半侧、数据落 `~/.dsh/edict/`、EDICT_AGENT_ID 身份），与本插件的「宿主 + 浏览器两半侧」架构根本不同，对齐等于换项目，不予考虑。
## Consequences

改名现在生效于包名、路由、存储与 profile 四层，`npm run check` 的 domain 136 项与 smoke 208 项全过，dev-server 实跑 /dsh-edict-7312/ui 返回 200、data-npc-base 前缀正确、/meta.name=dsh-edict。代价是：需要**重启 DeepSeekRuntime** 才让新包名进入加载链路（未自动重启，会中断当前会话）；项目里仍有意保留若干 `dsh-npc` 字样（README.md:69,71,72 的改名记录、scripts/install-profile.ps1:5,13,14,53 的迁移变量），后续 grep 到它们属预期。已知遗留：D:\Projects\dsh-edict-demo 的 package.json name 同为 `dsh-edict`（未注册进 profile，暂不冲突），若将来要装 demo，必须先给它另行改名——这一条是本次改名留下的唯一同名隐患。命名复查后的补充：徽章已挂在 README 末尾（shields.io `powered_by-dsh`，121×20，链到 deepseek-harness 仓库），keywords 15 项使 npm 搜索能被 dsh / dsh-plugin / npc / npc-team / orchestration 等词命中；代价是「包名与 npm 上他人的 dsh-edict 同名」这件事只在本地无害，任何发布前动作都必须先换成已核实空闲的名字。

