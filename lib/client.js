/**
 * dsh-onenpc · 浏览器半侧
 *
 * 设计取舍（与 dsh-edict-demo 同构，真机验证过的接法）：界面本体是 public/ui.html
 * （单文件，宿主路由 /dsh-onenpc-7312/ui 直接提供），这里只做五件事：
 *   1. 在会话头部注册「三省六部」tab —— 里面是一个同源 iframe，指向那份 UI；
 *   2. 在左侧栏注册「三省六部」面板行 —— 点击由宿主切到主区域整页面板；
 *   3. 注册主区域 main keyed 面板（key 'npc'）—— 与 tab 同一份 iframe UI；
 *   4. 在设置页注册「三省六部」一节 —— 显示地址、数据目录与阶段说明；
 *   5. M2 对话入口：输入框左侧「🏯 召 NPC」按钮（迷你下旨弹层，origin=command）
 *      + turnTail 提示行（@命中后在完成 Turn 下渲染「已转交 NPC · 结果看看板」）。
 *
 * 硬约束（dsh-edict-demo/analysis/02 §E）：本文件必须是普通副作用脚本，
 * 不能有顶层 import/export；react 一律走 __ModuleLoader__ 的 require。
 */

;(() => {
  function makeFactory() {
    return (require) => {
      const module = { exports: {} }
      const { jsx: h } = require('react/jsx-runtime')
      const { useState, useEffect } = require('react')

      const name = 'npc'
      const inject = ['slots', 'locale', 'layout']
      const ROUTE_PREFIX = '/dsh-onenpc-7312'
      // 宿主 layout 服务（ctx.get('layout')）：apply 时填充；给了 selectPanel 就客户端内切面板
      let layout = null

      /**
       * 自绘「宫殿」图标：按官方原语的绘制规范（16×16 viewBox / 单色 currentColor /
       * 1.2 圆头描边），意象对齐 edict 的 🏛️——飞檐 + 立柱 + 双层台基。
       * 接口与官方原语一致（接受 size prop），宿主渲染行文字时自动同色对齐。
       */
      function PalaceIcon(props) {
        const size = props && typeof props.size === 'number' ? props.size : 16
        // 注意：h = react/jsx-runtime 的 jsx，children 必须走 props（第三个参数是 key）
        const paths = [
          'M8 2.8 V1.4',                                        // 宝顶
          'M2 6.5 C4.2 6 6.3 4.6 8 2.8 C9.7 4.6 11.8 6 14 6.5', // 飞檐
          'M3.2 6.5 H12.8',                                     // 檐梁
          'M4.8 6.5 V11.2 M8 6.5 V11.2 M11.2 6.5 V11.2',        // 立柱
          'M3.2 11.2 H12.8',                                    // 台基上层
          'M2.2 13.4 H13.8',                                    // 台基层
        ]
        return h('svg', {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          children: paths.map((d, i) => h('path', { key: i, d })),
        })
      }

      // 与 lib/domain.js 的 ROLE_NAMES 保持一致（客户端半侧不打包宿主模块）
      const ROLE_NAMES = [
        '中书令', '门下侍中', '尚书令', '吏部尚书', '户部尚书', '礼部尚书',
        '兵部尚书', '刑部尚书', '工部尚书', '太史令', '御史台', '翰林学士',
      ]

      const CSS = `
.npcx-frame-wrap { display:flex; flex-direction:column; height:100%; min-height:420px; background:#0b0f1a; }
.npcx-frame { flex:1; min-height:420px; width:100%; border:0; display:block; background:#0b0f1a; }
.npcx-cfg { padding:12px 4px; font-size:12.5px; color:#dde4f4; line-height:1.7; }
.npcx-cfg code { background:#161f36; border:1px solid #232e4d; border-radius:5px; padding:1px 5px; font-size:11.5px; }
.npcx-cfg .muted { color:#5a6a8f; }
.npcx-cfg a { color:#5b9cf5; }
.npcx-sb-icon { font-size:15px; line-height:1; display:inline-block; vertical-align:middle; user-select:none; }
/* —— 输入框「召 NPC」按钮与迷你下旨弹层 —— */
.npcx-summon { position:relative; display:inline-flex; }
.npcx-summon-btn { border:0; background:transparent; font-size:15px; cursor:pointer; padding:0 4px; line-height:1; opacity:.85; }
.npcx-summon-btn:hover { opacity:1; }
.npcx-summon-pop { position:absolute; bottom:calc(100% + 10px); left:0; width:340px; z-index:999;
  background:#101728; border:1px solid #2c3a63; border-radius:12px; padding:14px;
  box-shadow:0 12px 40px rgba(0,0,0,.5); display:flex; flex-direction:column; gap:8px;
  color:#dde4f4; font-size:12.5px; }
.npcx-summon-title { font-weight:700; font-size:13.5px; color:#e0b15e; }
.npcx-summon-pop input, .npcx-summon-pop select, .npcx-summon-pop textarea {
  font:inherit; font-size:12.5px; color:#dde4f4; background:#0b0f1a; border:1px solid #232e4d;
  border-radius:8px; padding:6px 9px; width:100%; box-sizing:border-box; }
.npcx-summon-pop textarea { resize:vertical; min-height:56px; }
.npcx-summon-go { background:#e0b15e; border-color:#e0b15e; color:#1a1408; font-weight:600;
  border-radius:8px; padding:6px 12px; cursor:pointer; align-self:flex-end; }
.npcx-summon-go:disabled { opacity:.5; cursor:default; }
.npcx-summon-note { color:#5a6a8f; }
.npcx-summon-result { border-top:1px dashed #232e4d; padding-top:8px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.npcx-summon-result.err { color:#e06c6c; }
.npcx-summon-result button { background:#161f36; color:#dde4f4; border:1px solid #2c3a63;
  border-radius:8px; padding:3px 10px; cursor:pointer; }
/* —— turnTail @命中提示行 —— */
.npcx-hint { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:12px; color:#8fa0c4;
  background:rgba(224,177,94,.08); border:1px solid rgba(224,177,94,.35); border-radius:8px;
  padding:4px 10px; margin:4px 0; }
.npcx-hint button { background:transparent; border:1px solid rgba(224,177,94,.5); color:#e0b15e;
  border-radius:6px; padding:1px 8px; cursor:pointer; font-size:11.5px; }
`

      /**
       * 会话头部的「三省六部」整屏视图。
       * iframe src 带 ?v= 会话内时间戳，插件升级后不会被容器缓存住。
       */
      function NpcFrame() {
        const stamp = Date.now().toString(36)
        return h('div', {
          className: 'npcx-frame-wrap',
          children: [
            h('iframe', {
              key: 'f',
              className: 'npcx-frame',
              title: '三省六部',
              src: ROUTE_PREFIX + '/ui?v=' + stamp,
            }),
          ],
        })
      }

      /** 全屏主面板：与 tab 同一份 iframe UI，由侧栏「三省六部」点亮。 */
      function NpcPanel() {
        return NpcFrame()
      }

      /** 侧栏行内容：自绘宫殿图标（官方线条规范），异常时回落 🏯。 */
      function NpcSidebar() {
        try {
          return h(PalaceIcon, { size: 16 })
        } catch {
          return h('span', { title: '三省六部', className: 'npcx-sb-icon', children: '🏯' })
        }
      }

      /** 设置页的「三省六部」一节：信息展示 */
      function NpcSettings() {
        return h('div', {
          className: 'npcx-cfg',
          children: [
            h('div', {
              key: 'entry',
              children: [
                '界面入口：左侧栏「三省六部」、会话头部标签「三省六部」，或直接访问 ',
                h('code', { key: 'c', children: ROUTE_PREFIX + '/ui' }),
              ],
            }),
            h('div', {
              key: 'how',
              children: [
                '召 NPC：对话框 ',
                h('code', { key: 'cmd', children: '/npc [角色] 需求' }),
                '、输入框左侧 ',
                h('code', { key: 'btn', children: '🏯 召 NPC' }),
                ' 按钮，或消息里直接 ',
                h('code', { key: 'at', children: '@角色名' }),
                '。',
              ],
            }),
            h('div', {
              key: 'where',
              className: 'muted',
              children: ['HTTP 前缀 ', h('code', { key: 'p', children: ROUTE_PREFIX }), '；数据落在 $DSH_HOME/onenpc/state.json；diff/报告产物在 $DSH_HOME/onenpc/artifacts/'],
            }),
            h('div', {
              key: 'stage',
              className: 'muted',
              children:
                '当前阶段 M2 真对话：/npc 命令 + @解析 + 真子会话办差 + git 基线/diff 产物 + turnTail 提示行。' +
                'M3 接入：刑部/门下评审轮、预算闸门、流水线、成功指标面板。',
            }),
          ],
        })
      }

      /** 输入框左侧「🏯 召 NPC」：迷你下旨弹层（角色/标题/需求 → 建单 origin=command → 交办） */
      function NpcSummon() {
        const [open, setOpen] = useState(false)
        const [roles, setRoles] = useState([])
        const [role, setRole] = useState('中书令')
        const [title, setTitle] = useState('')
        const [req, setReq] = useState('')
        const [busy, setBusy] = useState(false)
        const [result, setResult] = useState(null)

        useEffect(() => {
          if (!open || roles.length) return
          fetch(ROUTE_PREFIX + '/roles')
            .then((r) => r.json())
            .then((j) => setRoles(j.roles ?? []))
            .catch(() => {})
        }, [open])

        async function submit() {
          if (!title.trim() || busy) return
          setBusy(true)
          setResult(null)
          try {
            const res = await fetch(ROUTE_PREFIX + '/tasks', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ title, requirement: req, role, origin: 'command' }),
            })
            const j = await res.json()
            if (!res.ok) throw new Error(j.message || j.error || '下旨失败')
            // npc-x 精神：下旨即全权委托 → 自动流转（判级→…→施工交办→评审→验收→交付）
            let note
            try {
              const meta = await fetch(ROUTE_PREFIX + '/meta').then((r) => r.json())
              if (meta.agentsReady) {
                const res2 = await fetch(ROUTE_PREFIX + `/tasks/${encodeURIComponent(j.id)}/pipeline`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ auto: true }),
                })
                note = res2.ok ? '已立项并自动流转（结果看看板）' : '已立项（自动流转开启失败，可看板手动开）'
              } else {
                note = '已立项（当前环境无子会话能力，未自动流转）'
              }
            } catch {
              note = '已立项（状态查询失败，可看板手动开启流转）'
            }
            setResult({ id: j.id, msg: note })
            setTitle('')
            setReq('')
          } catch (error) {
            setResult({ error: error?.message ?? String(error) })
          } finally {
            setBusy(false)
          }
        }

        return h('div', { className: 'npcx-summon' },
          h('button', {
            className: 'npcx-summon-btn',
            title: '三省六部 · 召 NPC 办差',
            onClick: () => setOpen(!open),
          }, '🏯'),
          open && h('div', { className: 'npcx-summon-pop' },
            h('div', { className: 'npcx-summon-title' }, '📜 召 NPC 办差'),
            roles.length
              ? h('select', { value: role, onChange: (e) => setRole(e.target.value) },
                  roles.map((r) => h('option', { key: r.name, value: r.name }, `${r.name} · ${r.org}`)))
              : h('div', { className: 'npcx-summon-note' }, '加载角色中…'),
            h('input', {
              placeholder: '标题（一句话说清要什么）',
              value: title,
              onChange: (e) => setTitle(e.target.value),
            }),
            h('textarea', {
              placeholder: '需求详情（可空：验收标准/范围/约束）',
              value: req,
              rows: 3,
              onChange: (e) => setReq(e.target.value),
            }),
            h('button', { className: 'npcx-summon-go', disabled: busy || !title.trim(), onClick: submit },
              busy ? '办理中…' : '📜 下旨并交办'),
            result && h('div', { className: 'npcx-summon-result' + (result.error ? ' err' : '') },
              result.error ? `✗ ${result.error}` : `${result.id} ✓ ${result.msg}`,
              result.id && h('button', {
                onClick: () => { setOpen(false); layout?.selectPanel?.('npc') },
              }, '打开看板'),
            ),
          ),
        )
      }

      /**
       * turnTail：@命中后在完成 Turn 下渲染提示行。
       * owner props 形状未公开（待真机校准）：防御式探测——深度搜 props 里的字符串，
       * 匹配 @角色名 → 拉最近 hints 匹配角色 → 渲染；不命中渲染 null（零侵入）。
       */
      function NpcMentionHint(props) {
        const [hint, setHint] = useState(null)
        useEffect(() => {
          try {
            if (!NpcMentionHint._logged) {
              NpcMentionHint._logged = true
              try {
                console.debug('[dsh-onenpc] turnTail props keys:', Object.keys(props ?? {}))
              } catch { /* 忽略 */ }
            }
            const texts = []
            const walk = (v, depth) => {
              if (!v || typeof v !== 'object' || depth > 3) return
              for (const key of Object.keys(v)) {
                const val = v[key]
                if (typeof val === 'string') texts.push(val)
                else if (val && typeof val === 'object') walk(val, depth + 1)
              }
            }
            walk(props, 0)
            const re = new RegExp(`@(${ROLE_NAMES.join('|')})`)
            const hit = texts.map((t) => t.match(re)).find(Boolean)
            if (!hit) return
            fetch(ROUTE_PREFIX + '/hints?limit=5')
              .then((r) => r.json())
              .then((j) => {
                const found = (j.hints ?? []).find((x) => x.role === hit[1])
                if (found) setHint(found)
              })
              .catch(() => {})
          } catch {
            /* 探测失败静默：不拖垮消息流 */
          }
        }, [])
        if (!hint) return null
        return h('div', { className: 'npcx-hint' },
          `📨 已转交「${hint.role}」· ${hint.taskId} · NPC 结果看「三省六部」看板（主会话回复仅供参考）`,
          h('button', { onClick: () => layout?.selectPanel?.('npc') }, '打开看板'),
        )
      }

      function apply(ctx) {
        // 样式用 data-plugin-css 标记，靠 ctx.effect 回收
        try {
          const style = document.createElement('style')
          style.setAttribute('data-plugin-css', 'dsh-onenpc')
          style.textContent = CSS
          document.head.appendChild(style)
          if (typeof ctx.effect === 'function') {
            ctx.effect(() => () => style.remove(), 'dsh-onenpc: styles')
          }
        } catch {
          /* 样式失败不该拖垮插件 */
        }

        // layout 服务（ctx.layout.selectPanel）：侧栏点击在客户端内部切主面板用
        try {
          const l = typeof ctx.get === 'function' ? ctx.get('layout') : undefined
          if (l && typeof l.selectPanel === 'function') layout = l
        } catch {
          /* layout 缺席时按钮走旧的外开路径 */
        }

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return

        try {
          slots.inject('conversation.view', () =>
            slots.register(
              { name: 'conversation.view', id: 'npc-court', order: 41, label: '三省六部', scope: 'session' },
              NpcFrame,
            ),
          )
        } catch (error) {
          console.warn('[dsh-onenpc] 注册 conversation.view 失败', error)
        }

        try {
          slots.inject('settings.section', () =>
            slots.register({ name: 'settings.section', id: 'npc-config', order: 41, label: '三省六部' }, NpcSettings),
          )
        } catch (error) {
          console.warn('[dsh-onenpc] 注册 settings.section 失败', error)
        }

        try {
          slots.inject('sidebar.panellist', () =>
            slots.register({ name: 'sidebar.panellist', id: 'npc', order: 2, label: '三省六部' }, NpcSidebar),
          )
        } catch (error) {
          console.warn('[dsh-onenpc] 注册 sidebar.panellist 失败', error)
        }

        try {
          slots.inject('main', () =>
            slots.register({ name: 'main', key: 'npc', locale: undefined }, NpcPanel),
          )
        } catch (error) {
          console.warn('[dsh-onenpc] 注册 main 面板失败', error)
        }

        // M2：输入框左侧「🏯 召 NPC」按钮（迷你下旨，origin=command）
        try {
          slots.inject('conversation.input.left', () =>
            slots.register({ name: 'conversation.input.left', id: 'npc-summon', order: 5 }, NpcSummon),
          )
        } catch (error) {
          console.warn('[dsh-onenpc] 注册 conversation.input.left 失败', error)
        }

        // M2：turnTail @命中提示行（owner props 待真机校准，探测失败渲染 null）
        try {
          slots.inject('conversation.chat.turnTail', () =>
            slots.register({ name: 'conversation.chat.turnTail', id: 'npc-mention-hint', order: 5 }, NpcMentionHint),
          )
        } catch (error) {
          console.warn('[dsh-onenpc] 注册 conversation.chat.turnTail 失败', error)
        }
      }

      module.exports = { apply, inject, name }
      return module.exports
    }
  }

  window.__ModuleLoader__.load({ id: 'dsh-onenpc', factory: makeFactory() })
})()
