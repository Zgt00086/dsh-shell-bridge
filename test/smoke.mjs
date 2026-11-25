// 离线冒烟测试：不需要手机、不需要 Shizuku，只验证授权闸、风险判断、面板数据。
// 用法：node test/smoke.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

let failed = 0
let passed = 0
function ok (name, cond, extra) {
  if (cond) { passed += 1; console.log('  ✓', name) } else { failed += 1; console.log('  ✗', name, extra === undefined ? '' : JSON.stringify(extra)) }
}

function makeQueue (name, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `shq-${name}-`))
  for (const sub of ['in', 'out', 'status']) fs.mkdirSync(path.join(dir, sub), { recursive: true })
  if (mode) {
    const now = Math.floor(Date.now() / 1000)
    const expire = mode === 'once' ? now + 900 : now + 1800
    fs.writeFileSync(path.join(dir, 'status', 'mode'), `${mode} ${expire} ${now}\n`)
    fs.writeFileSync(path.join(dir, 'status', 'alive'), `${now}\n`)
    fs.writeFileSync(path.join(dir, 'status', 'pid'), '4242\n')
  }
  return dir
}

// 每个场景都要一份独立模块实例（BASE 在模块加载时读 env）
async function load (dir) {
  process.env.SHQ_DIR = dir
  const mod = await import(`../lib/index.js?case=${encodeURIComponent(path.basename(dir))}`)
  const tools = []
  const panels = {}
  const ctx = {
    logger: { warn: () => {} },
    inject: (deps, cb) => cb({
      ...ctx,
      tools: { register: (t) => tools.push(t) },
      dshGo: { strip: () => {}, panel: (id, def) => { panels[id] = def } },
    }),
  }
  mod.apply(ctx)
  return { tool: tools[0], panel: panels['shell-panel'] }
}

const queued = (dir) => fs.readdirSync(path.join(dir, 'in')).filter((f) => f.endsWith('.sh')).length

console.log('未授权')
{
  const dir = makeQueue('none', null)
  const { tool, panel } = await load(dir)
  const r = await tool.execute({ command: 'id -u', description: 'x' }, {})
  ok('工具返回 no_grant', /no_grant/.test(r.error || ''), r)
  ok('工具 online=false', r.online === false)
  const snaps = []
  panel.data({}, (d) => snaps.push(d), { locale: 'zh-CN' })
  await new Promise((r) => setTimeout(r, 200))
  ok('面板显示未授权', snaps[0]?.state === '未授权', snaps[0]?.state)
  ok('风险条说"无"', /风险：无/.test(snaps.at(-1)?.riskText || ''))
  ok('没有排队请求', queued(dir) === 0, queued(dir))
}

console.log('单次授权')
{
  const dir = makeQueue('once', 'once')
  const { tool, panel } = await load(dir)
  const snaps = []
  panel.data({}, (d) => snaps.push(d), { locale: 'zh-CN' })
  await new Promise((r) => setTimeout(r, 800))
  ok('面板显示已授权·单次', snaps.at(-1)?.grant === '单次', snaps.at(-1)?.grant)
  ok('面板探测没有吃掉授权（队列仍为空）', queued(dir) === 0, queued(dir))
  ok('风险条是低—中', /低—中/.test(snaps.at(-1)?.riskText || ''))
  const r = await tool.execute({ command: 'id -u', description: 'x', timeout_ms: 500 }, {})
  ok('单次授权下命令能进队列（超时说明它在等守护执行）', /超时/.test(r.error || ''), r)
  ok('超时后自己清掉排队文件，不留垃圾', queued(dir) === 0, queued(dir))
}

console.log('本次对话授权')
{
  const dir = makeQueue('ttl', 'ttl')
  const { tool } = await load(dir)
  const hi = await tool.execute({ command: 'pm uninstall com.demo.not.here', description: 'x' }, {})
  ok('高风险命令被拒', /高风险命令/.test(hi.error || ''), hi)
  ok('高风险命令没有进队列', fs.readdirSync(path.join(dir, 'in')).length === 0)
  const lo = await tool.execute({ command: 'getprop ro.product.model', description: 'x', timeout_ms: 500 }, {})
  ok('低风险命令放行（超时而非被拒）', /超时/.test(lo.error || '') && !/高风险/.test(lo.error || ''), lo)
  ok('放行后也无残留', queued(dir) === 0, queued(dir))
}

console.log('风险分级')
{
  const dir = makeQueue('risk', null)
  const { tool } = await load(dir)
  const cases = [
    ['id -u', '低'], ['ls /sdcard/Download', '低'], ['dumpsys battery | grep level', '低'],
    ['cmd wifi status', '低'], ['svc data get', '低'],
    ['logcat -d -t 5', '中'], ['dumpsys activity top', '中'], ['pm install /sdcard/a.apk', '中'],
    ['rm -rf /sdcard/Download/x', '高'], ['pm uninstall com.x', '高'], ['settings put global x 1', '高'],
    ['screencap -p /sdcard/a.png', '高'], ['input tap 1 2', '高'], ['curl http://example.com', '高'],
    ['su -c id', '高'], ['cmd wifi set-wifi-enabled disabled', '高'],
  ]
  for (const [cmd, want] of cases) {
    const title = tool.presentCall({ command: cmd }).title
    const got = (title.match(/\[(.)\]/) || [])[1]
    ok(`${want} · ${cmd}`, got === want, title)
  }
}

console.log('守护脚本')
{
  const dir = makeQueue('daemon', null)
  const { panel } = await load(dir)
  panel.actions['grant-once']({}, { locale: 'zh-CN' })
  const script = path.join(dir, 'daemon.sh')
  ok('脚本已落盘', fs.existsSync(script))
  let syntaxError = ''
  try { execFileSync('sh', ['-n', script], { stdio: 'pipe' }) } catch (e) { syntaxError = String(e.stderr || e.message) }
  ok('sh -n 语法通过', syntaxError === '', syntaxError.slice(0, 120))
  const text = fs.readFileSync(script, 'utf8')
  ok('once 模式处理后自杀', /break 2/.test(text) && /MODE" = "once"/.test(text))
  ok('带 stop 标记', /status\/stop/.test(text))
  ok('有 ttl 过期判断', /EXPIRE/.test(text))
}

console.log('')
console.log(failed === 0 ? `全部通过：${passed} 项` : `失败 ${failed} 项 / 通过 ${passed} 项`)
process.exit(failed === 0 ? 0 : 1)
