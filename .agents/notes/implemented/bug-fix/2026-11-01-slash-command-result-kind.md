# Agent Note: slash-command-result-kind

Status: implemented

## Problem

`/npc` 斜杠命令在真机上完全不可用：执行时报 `command.execute failed: gateway/internal: command "npc" returned unknown result kind "text"`。原因是 handler 返回了 `{ kind: 'text', text }`，而宿主的 commands 服务只接受白名单内的结果 kind，非法 kind 会让整次调用在 gateway 层失败，用户看不到任何回执。

## Decision

命令结果只返回 `kind: 'success'` 或 `kind: 'error'`，两者都带 `text` 供界面展示（lib/index.js 的 /npc handler：空输入与缺需求走 error，建单成功走 success）。这个白名单不是本项目定义的，是从已装在 desktop profile 里的两个可用插件的实现读出来的：billion-context 的 dsh-native.js / dsh-acp.js（`{kind:"success",text}`、`{kind:"error",text}`）与 dsh-pet 的 `ctx.commands.register` handler（`{kind:"success",text:"已触发桌宠余额显示"}`）。宿主侧契约文档不可读（app.asar 在沙箱里表现为路径不存在），所以以「同机上确实工作的插件」为唯一权威。

注册方式同步改为 `ctx.effect(() => ctx.commands.register({...}), 'dsh-edict: /npc 命令')`，与 dsh-kanban、dsh-pet 的写法一致：插件卸载/热更新时能拿到 disposer，避免旧 handler 残留——本次 bug 正是「改了源码但宿主里跑的还是旧 handler」时最容易踩的形状。effect 内保留 try/catch，commands 服务缺失时降级为一条 warn，不让插件整体崩掉。

回归测地方式改为挂载真插件而不是只测纯函数：scripts/smoke.mjs 新增 D 段，用伪 ctx（logger/get/on/effect/commands/webServer 五个面）调 `apply(fakeCtx)`，捕获注册出来的 handler，分别喂空输入与「中书令 + 需求」，断言 `kind` 只能是 success/error、回执含任务号、以及命令建的单真的以 `origin=command`、`role=中书令` 落盘到临时 DSH_HOME。临时目录通过 `process.env.DSH_HOME` 指向 mkdtemp 目录并在 finally 里还原，同时断言启动日志里出现该临时路径，防止误写真实 `~/.dsh/dsh-edict`。
## Alternatives considered

**返回 `{kind:'message'}` 走会话消息通道**：宿主是否支持该 kind 无从验证，且命令回执语义应贴着 commands 服务本身，不猜第三种类别。

**把 results kind 抽成一个常量表再统一引用**：本次只有一个命令，加一层抽象只增加跳转成本；等出现第二个命令再抽。

**只改代码不补测试**：这个 bug 的形态恰恰是「测试只覆盖纯函数，命令面完全裸奔」，不补就一定会复发；代价是 smoke 需要伪造 ctx，故把伪造范围压到最小（五个面，均为 noop）。

**让测试直接连真实宿主验证命令**：需要重启 GUI，会中断当前会话，且不可重复；改为挂载 apply 后做静态断言，等价覆盖返回结构。
## Consequences

`/npc` 现在能回执「已立项 TASK-x」并按 origin=command 建单；`npm run check` 从 213 项升到 214 项（domain 136 + smoke 214），新增用例同时锁住返回 kind 与落盘路径。代价是 smoke 里多了一份伪 ctx 需要随宿主 ctx API 演进而维护；命令结果契约仍无官方文档可依，若宿主将来新增合法 kind（或改名 success），这里不会自动跟进——它只保证「不返回宿主不认识的 kind」这一条。遗留：修复要对运行中的 GUI 生效仍需重启 DeepSeekRuntime（插件代码在宿主进程内，热更不保证）。

