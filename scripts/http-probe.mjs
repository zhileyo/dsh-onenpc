// M0 一次性 HTTP 探针（dev-server 起来后手跑；不属于常驻自检）
const base = process.argv[2] ?? 'http://127.0.0.1:7412/dsh-onenpc-7312'
const r = await fetch(base + '/ui')
const html = await r.text()
console.log('/ui:', r.status, 'base前缀:', html.includes('data-npc-base="/dsh-onenpc-7312"'), '字节:', html.length)
const p = await fetch(base + '/tasks', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'HTTP 冒烟单', origin: 'command' }),
})
const pj = await p.json()
console.log('POST /tasks:', p.status, pj.id, 'nodes:', pj.task.nodes.length, 'triage:', pj.task.triage + '/' + pj.task.triageBy)
const a = await fetch(base + '/tasks/' + pj.id + '/action', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'start', nodeId: 'N1' }),
})
console.log('start N1:', a.status, (await a.json()).node?.state)
const lp = await fetch(base + '/state?since=0&timeout=0')
const lpj = await lp.json()
console.log('/state: v=' + lpj.v, 'tasks=' + lpj.tasks.length, 'roles=' + lpj.catalog.roles.length)
