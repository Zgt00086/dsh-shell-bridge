// DSH Go 原生插件：Shell 桥（授权制）
// 通道本身是个 uid=2000(shell) 的守护，由 Shizuku 的手机 shell 拉起，靠 /sdcard 队列收发。
// 关键：守护只在用户批准时存在 ——
//   once  = 处理完一条命令立刻自杀（单次允许）
//   ttl N = N 秒后自杀（本次对话允许）
// 没有守护 = 没有 shell。拉起守护只能走手机操控（App 原生确认），插件自己调不动，
// 所以「批准」这一步天然落在用户手上。
import fs from 'node:fs'
import path from 'node:path'

export const name = 'local-shizuku-bridge'

const AUTHOR = 'Dainric'
const PLUGIN_VERSION = '0.6.1'
const BASE = process.env.SHQ_DIR || '/sdcard/Download/DSH-Go/shq'
const IN = path.join(BASE, 'in')
const OUT = path.join(BASE, 'out')
const ST = path.join(BASE, 'status')
const LOG = path.join(BASE, 'log')
const DAEMON = path.join(BASE, 'daemon.sh')
const MODE_FILE = path.join(ST, 'mode')
const STOP_FILE = path.join(ST, 'stop')
const ALIVE_MAX = 15

const DAEMON_SRC = `#!/system/bin/sh
# shq 守护 v2 — 只在用户批准时存在
# 用法：sh daemon.sh once            → 处理完一条就自杀
#       sh daemon.sh ttl <秒>        → 到点自杀
# 停止：写 status/stop 即可
Q=\${SHQ_DIR:-/sdcard/Download/DSH-Go/shq}
MODE=\${1:-once}
TTL=\${2:-0}
mkdir -p "$Q/in" "$Q/out" "$Q/status" 2>/dev/null
NOW=$(date +%s)
if [ "$MODE" = "ttl" ]; then EXPIRE=$((NOW + TTL)); else EXPIRE=$((NOW + 900)); fi
echo $$ > "$Q/status/pid"
echo "$MODE $EXPIRE $NOW" > "$Q/status/mode"
rm -f "$Q/status/stop"
echo "$NOW start $MODE $EXPIRE" >> "$Q/log"
# 只留最近 20 个输出文件，避免 /sdcard 越堆越多
ls -t "$Q"/out/*.out 2>/dev/null | tail -n +21 | while read -r old; do rm -f "$old"; done
i=0
BROKE=""
while :; do
  i=$((i + 1))
  NOW=$(date +%s)
  if [ -f "$Q/status/stop" ]; then rm -f "$Q/status/stop"; BROKE="stop"; break; fi
  if [ "$MODE" = "ttl" ] && [ "$NOW" -gt "$EXPIRE" ]; then BROKE="ttl"; break; fi
  if [ $((i % 3)) -eq 1 ]; then echo "$NOW" > "$Q/status/alive"; fi
  for f in "$Q"/in/*.sh; do
    [ -f "$f" ] || continue
    id=\${f##*/}
    id=\${id%.sh}
    CMD=$(head -c 80 "$f" 2>/dev/null | tr '\\n\\t' '  ')
    echo "$id" > "$Q/status/busy"
    sh "$f" > "$Q/out/$id.out" 2>&1
    C=$?
    echo $C > "$Q/status/$id.code"
    rm -f "$f" "$Q/status/busy"
    echo "$(date +%s) $id $C $CMD" >> "$Q/log"
    if [ "$MODE" = "once" ]; then BROKE="once"; break 2; fi
  done
  sleep 1
done
rm -f "$Q/status/pid" "$Q/status/mode" "$Q/status/alive"
echo "$(date +%s) exit $BROKE" >> "$Q/log"
exit 0
`

const PROBE = [
  'echo "U=$(id -u)"',
  'echo "UN=$(id -un)"',
  'echo "M=$(getprop ro.product.model)"',
  'echo "R=$(getprop ro.build.version.release)"',
  'echo "S=$(getprop ro.build.version.sdk)"',
].join('; ')

const STATS = { count: 0, fail: 0 }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))


// ─── 命令级风险判断（关键词，只用来提醒，不是沙箱）─────────────────────────
// 顺序有意义：先撞上的先算，所以高危规则全部排在前面。
const RISK_RULES = [
  // 只读的服务查询，先判成低风险，免得"cmd wifi status"这种被误报
  { level: 'low', reason: '查询系统服务状态', test: /\b(cmd|svc)\s+\w+\s+(status|list|get|query|info|help)\b/i },
  { level: 'high', reason: '删文件', test: /\brm\b|\bshred\b|\btruncate\b/i },
  { level: 'high', reason: '卸载/清应用数据/改应用权限', test: /\bpm\s+(uninstall|clear|disable-user|disable|grant|revoke|hide)\b/i },
  { level: 'high', reason: '改系统设置', test: /\bsettings\s+(put|delete|reset)\b/i },
  { level: 'high', reason: '强停应用或发系统广播', test: /\bam\s+(force-stop|kill|broadcast)\b/i },
  { level: 'high', reason: '截屏/录屏，可能拍到隐私', test: /\bscreencap\b|\bscreenrecord\b/i },
  { level: 'high', reason: '模拟点击或注入输入事件', test: /\binput\b|\bsendevent\b/i },
  { level: 'high', reason: '改网络/系统服务状态', test: /\b(cmd|svc)\s+(wifi|telephony|connectivity|bluetooth|netstats|netpolicy)\b/i },
  { level: 'high', reason: '可能把数据发到外部网络', test: /\b(curl|wget|nc|ncat|scp|sftp|ftp|ssh)\b/i },
  { level: 'high', reason: '直接写块设备或重挂载', test: /\bdd\b|\bmkfs\b|remount/i },
  { level: 'high', reason: '尝试提权', test: /(^|[\s;&|])su([\s;&|]|$)|\bmagisk\b/i },
  { level: 'high', reason: '改文件权限或安全策略', test: /\bchmod\b|\bchown\b|\bsetenforce\b/i },
  { level: 'high', reason: '读写应用数据或系统数据库', test: /\bcontent\s+(query|delete|insert|update)\b|\bsqlite3\b/i },
  { level: 'high', reason: '杀进程/改时间/重启', test: /\bkill\b|\bpkill\b|\bdate\s+-s\b|\breboot\b|\bshutdown\b/i },
  { level: 'medium', reason: '安装应用', test: /\bpm\s+(install|install-\w+)\b/i },
  { level: 'medium', reason: '启动应用 / 自动化脚本', test: /\bam\s+start\b|\bmonkey\b/i },
  { level: 'medium', reason: '读日志或界面状态，可能含隐私', test: /\blogcat\b|\bdumpsys\s+(activity|window|package|media_session|usage|notification)/i },
  { level: 'medium', reason: '读/打包你的存储文件', test: /\b(cat|tar|cp|zip|base64|split)\b[^;|]*?\/(sdcard|storage\/emulated)[^;|]*?\b(DCIM|Download|Documents|Pictures|Movies|Music|Android)\b/i },
  { level: 'medium', reason: '触发媒体/服务动作', test: /\bmedia\b|\bcmd\s+media_session\b/i },
]

const RISK_NAME = { high: '高', medium: '中', low: '低' }

function classify (command) {
  const text = String(command || '')
  for (const rule of RISK_RULES) if (rule.test.test(text)) return { level: rule.level, reason: rule.reason }
  return { level: 'low', reason: '只读查询或常规命令' }
}

// ─── 队列 ────────────────────────────────────────────────────────────────

function readText (file) {
  try { return fs.readFileSync(file, 'utf8').trim() } catch { return '' }
}

function aliveAge () {
  const t = Number(readText(path.join(ST, 'alive')))
  if (!Number.isFinite(t) || t <= 0) return null
  return Math.max(0, Math.floor(Date.now() / 1000) - t)
}

// 授权 = 守护活着 + 模式未过期
function grant () {
  const age = aliveAge()
  if (age === null || age > ALIVE_MAX) return { ok: false, reason: 'offline', scope: null, left: 0 }
  const [mode, expireRaw] = readText(MODE_FILE).split(/\s+/)
  const expire = Number(expireRaw) || 0
  if (mode !== 'once' && mode !== 'ttl') return { ok: false, reason: 'offline', scope: null, left: 0 }
  const now = Math.floor(Date.now() / 1000)
  if (expire > 0 && now > expire) return { ok: false, reason: 'expired', scope: mode, left: 0 }
  return { ok: true, reason: '', scope: mode, left: Math.max(0, expire - now) }
}

function queuePending () {
  try { return fs.readdirSync(IN).filter((f) => f.endsWith('.sh')).length } catch { return 0 }
}

// 审计：每条命令一行 "<epoch> <req> <code> <命令摘要>"
function recentRuns (limit = 5) {
  const rows = []
  for (const line of readText(LOG).split('\n').slice(-limit * 3)) {
    const m = line.match(/^(\d{10}) (\S+) ([0-9]+) ?(.*)$/)
    if (!m) continue
    const time = new Date(Number(m[1]) * 1000).toTimeString().slice(0, 5)
    const label = (m[4] || m[2]).slice(0, 15)
    rows.push([time, (m[3] === '0' ? '' : '✕ ') + label])
  }
  return rows.length ? rows.slice(-limit) : null
}

function ensureDirs () {
  for (const dir of [BASE, IN, OUT, ST]) fs.mkdirSync(dir, { recursive: true })
}

function ensureDaemonScript () {
  ensureDirs()
  try {
    if (readText(DAEMON) !== DAEMON_SRC.trim()) fs.writeFileSync(DAEMON, DAEMON_SRC)
  } catch {}
}

async function runShell (command, timeoutMs = 20000, signal) {
  const g = grant()
  if (!g.ok) throw new Error('未获批准：让用户在面板点「申请一次」或「申请对话」')
  ensureDirs()
  const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const tmp = path.join(IN, `.${id}.tmp`)
  const request = path.join(IN, `${id}.sh`)
  fs.writeFileSync(tmp, `${command}\n`)
  fs.renameSync(tmp, request)
  const codeFile = path.join(ST, `${id}.code`)
  const outFile = path.join(OUT, `${id}.out`)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      try { fs.rmSync(request, { force: true }) } catch {}
      throw new Error('aborted')
    }
    if (fs.existsSync(codeFile)) {
      const code = Number(readText(codeFile)) || 0
      const output = (() => { try { return fs.readFileSync(outFile, 'utf8').trimEnd() } catch { return '' } })()
      try { fs.rmSync(outFile, { force: true }); fs.rmSync(codeFile, { force: true }) } catch {}
      return { code, output }
    }
    await sleep(100)
  }
  try { fs.rmSync(request, { force: true }) } catch {}
  throw new Error('超时（守护可能在跑长命令）')
}

// ─── 授权动作（都只写标记，真正拉起守护由用户确认的手机操控完成）──────────

function askGrant (en, scope) {
  const text = scope === 'once'
    ? (en ? 'Allow one shell command (risk: low-medium, closes right after).' : '允许一次 shell 权限（风险低—中：跑完一条就收回）')
    : (en ? 'Allow shell for this conversation, 30 min (risk: medium).' : '本次对话允许 shell 权限（风险中：30 分钟内可连续执行）')
  return { insert: text, toast: en ? 'send it: I launch with one confirm' : '发出去，我拉起时你确认一次' }
}

function closeChannel (en) {
  if (!grant().ok && aliveAge() === null) return { toast: en ? 'channel is not running' : '通道本来就没跑', refresh: true }
  try {
    ensureDirs()
    fs.writeFileSync(STOP_FILE, '1')
  } catch {
    return { toast: en ? 'cannot write stop marker' : '写不了停止标记', refresh: true }
  }
  const started = Date.now()
  return {
    result: async () => {
      while (Date.now() - started < 4000) {
        if (aliveAge() === null || aliveAge() > ALIVE_MAX) {
          return { toast: en ? 'channel closed' : '通道已关闭', refresh: true }
        }
        await sleep(300)
      }
      return { toast: en ? 'still up; try again' : '还在跑，再点一次', refresh: true }
    },
  }
}

// ─── 面板数据 ────────────────────────────────────────────────────────────

function readKV (output, keys) {
  const out = {}
  for (const line of String(output || '').split('\n')) {
    const m = line.match(/^([A-Z]+)=(.*)$/)
    if (m && keys.includes(m[1])) out[m[1]] = m[2].trim()
  }
  return out
}

function grantLabel (en, g) {
  if (!g.ok) return g.reason === 'expired' ? (en ? 'Expired' : '已过期') : (en ? 'Not granted' : '未授权')
  return g.scope === 'once' ? (en ? 'One command' : '单次') : (en ? 'This conversation' : '本次对话')
}

function grantLeft (en, g) {
  if (!g.ok) return '—'
  if (g.scope === 'once') return en ? '1 command' : '1 条'
  return `${Math.floor(g.left / 60)}${en ? 'm' : ' 分'}`
}

function localChecks (en) {
  const g = grant()
  const checks = []
  const dirs = [BASE, IN, OUT, ST].every((d) => fs.existsSync(d))
  checks.push({ title: '队列目录', subtitle: dirs ? 'in / out / status 齐全' : '缺目录', tone: dirs ? 'good' : 'bad' })
  checks.push({ title: '授权', subtitle: grantLabel(en, g), tone: g.ok ? 'good' : 'bad' })
  const age = aliveAge()
  checks.push({ title: '心跳', subtitle: age === null ? '从未收到' : `${age}s 前`, tone: age !== null && age <= ALIVE_MAX ? 'good' : 'bad' })
  checks.push({ title: '守护脚本', subtitle: fs.existsSync(DAEMON) ? '在' : '缺（点申请会重写）', tone: fs.existsSync(DAEMON) ? 'good' : 'warn' })
  checks.push({ title: '身份', subtitle: en ? 'shell uid 2000' : 'shell（uid 2000）', tone: 'info' })
  checks.push({
    title: en ? 'High-risk words' : '高危特征',
    subtitle: 'rm · pm uninstall · settings put · input · screencap · curl',
    tone: 'info',
  })
  return checks
}


// 授权范围 → 风险提示（面板顶部与申请文案共用）
function riskOf (en, g) {
  if (!g.ok) {
    return {
      text: en ? 'Risk: none — no grant, the channel does not exist.' : '风险：无 —— 未授权，守护不存在，什么都跑不了',
      tone: 'good',
    }
  }
  if (g.scope === 'once') {
    return {
      text: en
        ? 'Risk: low–medium · one command only, but one command can still delete files or uninstall an app.'
        : '风险：低—中 —— 只跑一条；但一条也够删文件、卸 App，看清楚再按',
      tone: 'warn',
    }
  }
  return {
    text: en
      ? `Risk: medium · ${Math.floor(g.left / 60)}m of back-to-back commands: /sdcard, install/uninstall, settings, screencap, logcat.`
      : `风险：中 —— 剩 ${Math.floor(g.left / 60)} 分钟内可连续跑：读 /sdcard、装卸 App、改设置、截屏、logcat`,
    tone: 'warn',
  }
}

function baseSnapshot (en, g) {
  return {
    state: g.ok ? (en ? 'Granted' : '已授权') : (g.reason === 'expired' ? (en ? 'Expired' : '已过期') : (en ? 'Not granted' : '未授权')),
    stateTone: g.ok ? 'good' : 'warn',
    uid: '—',
    model: '—',
    system: '—',
    grant: grantLabel(en, g),
    grantLeft: grantLeft(en, g),
    riskText: riskOf(en, g).text,
    riskTone: riskOf(en, g).tone,
    pid: readText(path.join(ST, 'pid')) || '—',
    queue: String(queuePending()),
    count: String(STATS.count),
    fail: String(STATS.fail),
    failTone: STATS.fail > 0 ? 'bad' : undefined,
    info: [
      [en ? 'Scope' : '授权范围', grantLabel(en, g)],
      [en ? 'Queue' : '队列', BASE],
      [en ? 'Plugin' : '插件版本', PLUGIN_VERSION],
    ],
    recent: recentRuns() || [['—', en ? 'no runs yet' : '还没有执行']],
    checks: localChecks(en),
    note: g.ok
      ? (en ? 'Only commands you approved can run; close any time.' : '只跑你批准范围内的命令，随时可以点「关闭通道」')
      : (en ? 'No grant: nothing can run. Tap one of the two request buttons.' : '未授权：什么都跑不了。点「申请一次」或「申请对话」'),
    noteTone: g.ok ? 'info' : 'warn',
  }
}

function detailSnapshot (en, g, info) {
  return {
    ...baseSnapshot(en, g),
    uid: info.U || '—',
    model: info.M || '—',
    system: info.R ? `${info.R}${info.S ? ` (SDK ${info.S})` : ''}` : '—',
    info: [
      [en ? 'User' : '运行身份', `${info.UN || 'shell'} · uid ${info.U || '—'}`],
      [en ? 'Scope' : '授权范围', `${grantLabel(en, g)} · ${grantLeft(en, g)}`],
      [en ? 'Queue' : '队列', BASE],
      [en ? 'Plugin' : '插件版本', PLUGIN_VERSION],
    ],
    note: en ? 'Each command is logged below; close stops the daemon in ~1s.' : '每条命令都记在下面，点「关闭通道」1 秒内停止',
    noteTone: 'good',
  }
}

// ─── adb_shell 工具 ──────────────────────────────────────────────────────

function defineShellTool () {
  return {
    name: 'adb_shell',
    description: '在本机 Android 以 shell 身份（uid=2000，u:r:shell:s0，不是 root）执行一条命令，经用户批准的 Shizuku 守护。硬性前提：必须在用户明确批准后才能调用——未批准时返回 error=no_grant，此时不要重试、不要换别的路径绕过，只能请用户在 Shell 桥面板点「申请一次」或「申请对话」。能读 /sdcard、跑 pm/am/settings/input/screencap/dumpsys/logcat/getprop；读不到 /data/data，也改不了系统分区。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: {
          type: 'string',
          description: '交给设备端 sh 的完整命令，多行用 ; 或换行连接，stdout/stderr 一起返回。用 Android 的 /system/bin 路径。',
        },
        description: {
          type: 'string',
          description: '一句话说明这条命令做什么。',
        },
        timeout_ms: {
          type: 'integer',
          description: '等待结果毫秒数，默认 20000，最大 600000。',
        },
      },
      required: ['command', 'description'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          online: { type: 'boolean' },
          code: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          output: { type: 'string' },
          elapsed_ms: { type: 'integer' },
          error: { type: 'string' },
        },
        required: ['online', 'code', 'output', 'elapsed_ms'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.error
          ? `[ADB·uid2000] ${value.error}`
          : `[ADB·uid2000 · exit ${value.code}]\n${value.output}`,
      }],
      // 一行迷你卡：结果不用展开也看得见，体积比 root 桥小一个量级
      presentationMeta: (args, value) => {
        try {
          const failed = Boolean(value.error) || value.code !== 0
          const head = String(value.output || '').trim().split('\n')[0].slice(0, 46)
          const risk = classify(args?.command)
          const tag = `[${RISK_NAME[risk.level]}·${risk.reason}]`
          const text = value.error
            ? `ADB·uid2000 · ${tag} ${String(value.error).slice(0, 50)}`
            : `ADB·uid2000 · ${tag} exit ${value.code} · ${head || '（无输出）'}`
          return { 'dsh-go/view': { type: 'callout', text, tone: failed ? 'warn' : 'info' } }
        } catch { return {} }
      },
    },
    timeoutMs: 610000,
    presentCall: (args) => ({
      card: 'generic',
      kind: 'execute',
      title: `ADB·[${RISK_NAME[classify(args?.command).level]}] ${String(args?.command || '').replace(/\s+/g, ' ').trim().slice(0, 70) || '手机 shell'}`,
    }),
    async execute (args, exec) {
      const started = Date.now()
      const g = grant()
      const deny = (error) => ({ online: false, code: null, output: '', elapsed_ms: Date.now() - started, error })
      if (!g.ok) {
        return deny(g.reason === 'expired'
          ? '授权已过期：请用户在 Shell 桥面板重新申请，不要重试'
          : 'no_grant：用户未批准 shell 权限，禁止使用。请用户在 Shell 桥面板点「申请一次」或「申请对话」')
      }
      const command = typeof args?.command === 'string' ? args.command.trim() : ''
      if (!command) return { online: true, code: null, output: '', elapsed_ms: 0, error: 'command 不能为空' }
      const risk = classify(command)
      if (risk.level === 'high' && g.scope === 'ttl') {
        return {
          online: true,
          code: null,
          output: '',
          elapsed_ms: 0,
          error: `高风险命令（${risk.reason}）不能在「本次对话」授权下执行：请让用户在面板点「申请一次」单独批准`,
        }
      }
      if (command.length > 8192) return { online: true, code: null, output: '', elapsed_ms: 0, error: 'command 太长（上限 8192 字节）' }
      let timeoutMs = 20000
      if (args?.timeout_ms !== undefined && args?.timeout_ms !== null && args?.timeout_ms !== '') {
        const t = Number(args.timeout_ms)
        if (!Number.isFinite(t) || t <= 0) {
          return { online: true, code: null, output: '', elapsed_ms: 0, error: 'timeout_ms 必须是正整数' }
        }
        timeoutMs = Math.min(Math.round(t), 600000)
      }
      try {
        const { code, output } = await runShell(command, timeoutMs, exec?.signal)
        STATS.count += 1
        if (code !== 0) STATS.fail += 1
        return { online: true, code, output, elapsed_ms: Date.now() - started }
      } catch (error) {
        return { online: grant().ok, code: null, output: '', elapsed_ms: Date.now() - started, error: String(error?.message || error) }
      }
    },
  }
}

// ─── 注册 ────────────────────────────────────────────────────────────────

export function apply (ctx) {
  // 先把守护脚本落盘成当前版本：拉起守护的是手机操控那条命令，它只会跑磁盘上的这份
  try { ensureDaemonScript() } catch {}

  // tools 是后加载的根服务：当场 ctx.get('tools') 还是 undefined，必须 inject 等它就绪
  ctx.inject(['tools'], (ctx) => {
    try {
      ctx.tools.register(defineShellTool())
    } catch (error) {
      ctx.logger?.warn?.('local-shizuku-bridge: adb_shell 工具注册失败：', error)
    }
  })

  ctx.inject(['dshGo'], (ctx) => {
    ctx.dshGo.panel('shell-panel', {
      view: () => ({
        type: 'stack',
        title: 'Shell 桥',
        children: [
          { type: 'callout', text: { $: 'data.riskText' }, tone: { $: 'data.riskTone' } },
          { type: 'row', children: [
            { type: 'metric', label: '状态', value: { $: 'data.state' }, tone: { $: 'data.stateTone' } },
            { type: 'metric', label: '授权范围', value: { $: 'data.grant' } },
          ] },
          { type: 'row', children: [
            { type: 'metric', label: '剩余', value: { $: 'data.grantLeft' } },
            { type: 'metric', label: '守护 PID', value: { $: 'data.pid' } },
          ] },
          { type: 'row', children: [
            { type: 'metric', label: '身份', value: { $: 'data.uid' }, caption: 'uid' },
            { type: 'metric', label: '设备', value: { $: 'data.model' } },
          ] },
          { type: 'row', children: [
            { type: 'metric', label: '排队', value: { $: 'data.queue' } },
            { type: 'metric', label: '本次执行', value: { $: 'data.count' } },
          ] },
          { type: 'keyValue', items: { $: 'data.info' } },
          { type: 'table', columns: ['时间', '命令'], rows: { $: 'data.recent' } },
          { type: 'list', items: { $: 'data.checks' } },
          { type: 'callout', text: { $: 'data.note' }, tone: { $: 'data.noteTone' } },
          { type: 'actions', items: [
            { label: '申请一次', action: 'grant-once', style: 'primary' },
            { label: '申请对话', action: 'grant-session' },
            { label: '刷新', action: 'refresh' },
            { label: '自检', action: 'selfcheck' },
          ] },
          { type: 'confirm', id: 'stop', confirmLabel: '关闭通道', cancelLabel: '取消' },
        ],
      }),
      data: (scope, emit, caps) => {
        const en = String(caps?.locale || '').startsWith('en')
        const g = grant()
        emit(baseSnapshot(en, g))
        if (!g.ok) return
        // 「单次」授权只有一条额度，面板探测会把它吃掉，所以只报状态不去排队
        if (g.scope === 'once') {
          emit({
            ...baseSnapshot(en, g),
            note: en ? 'One-command grant: the panel does not probe, so your single command survives.' : '单次授权：面板不做探测，免得把你那一条用掉',
            noteTone: 'info',
          })
          return
        }
        runShell(PROBE, 15000)
          .then(({ code, output }) => {
            if (code !== 0) throw new Error(`exit ${code}`)
            emit(detailSnapshot(en, grant(), readKV(output, ['U', 'UN', 'M', 'R', 'S'])))
          })
          .catch(() => emit({
            ...baseSnapshot(en, grant()),
            note: en ? 'queue read failed; tap refresh' : '读队列失败，点刷新重试',
            noteTone: 'warn',
          }))
      },
      actions: {
        refresh: () => ({ refresh: true }),
        'grant-once': (_scope, event) => {
          const en = String(event?.locale || '').startsWith('en')
          ensureDaemonScript()
          return askGrant(en, 'once')
        },
        'grant-session': (_scope, event) => {
          const en = String(event?.locale || '').startsWith('en')
          ensureDaemonScript()
          return askGrant(en, 'session')
        },
        selfcheck: () => {
          const checks = localChecks(false)
          const bad = checks.filter((c) => c.tone === 'bad').length
          const ok = checks.filter((c) => c.tone === 'good').length
          return {
            toast: bad ? `${ok}/${checks.length} 项正常，${bad} 项有问题` : `${ok}/${checks.length} 项正常`,
            patch: { checks, noteTone: bad ? 'warn' : 'good' },
          }
        },
        stop: (_scope, event) => {
          if (!event?.value?.confirmed) return {}
          return closeChannel(String(event?.locale || '').startsWith('en'))
        },
      },
    })
  })
}
