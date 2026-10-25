import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { Ticket } from '../types'
import { C, accentSvg, kpi2Svg, pipeSvg } from './visuals'

const PANE = 'ops-tickets'
const tickets = atom({ plugin: 'ops-tickets', key: 'tickets' } as const, [])
const selected = atom({ plugin: 'ops-tickets', key: 'selected' } as const, null)
const statusFilter = atom({ plugin: 'ops-tickets', key: 'statusFilter' } as const, 'open')
const sourceFilter = atom({ plugin: 'ops-tickets', key: 'sourceFilter' } as const, null)
const ownerFilter = atom({ plugin: 'ops-tickets', key: 'ownerFilter' } as const, null)
const owners = atom({ plugin: 'ops-tickets', key: 'owners' } as const, [])
const busy = atom({ plugin: 'ops-tickets', key: 'busy' } as const, null)
const message = atom({ plugin: 'ops-tickets', key: 'message' } as const, null)
const confirming = atom({ plugin: 'ops-tickets', key: 'confirming' } as const, null)
const verified = atom({ plugin: 'ops-tickets', key: 'verified' } as const, null)
const exported = atom({ plugin: 'ops-tickets', key: 'exported' } as const, null)
const setup = atom({ plugin: 'ops-tickets', key: 'setup' } as const, null)
const pageIndex = atom({ plugin: 'ops-tickets', key: 'pageIndex' } as const, 0)
const expanded = atom({ plugin: 'ops-tickets', key: 'expanded' } as const, false)
const scheduleAt = atom({ plugin: 'ops-tickets', key: 'scheduleAt' } as const, null)
const SETUP_PANE = 'ops-setup'
// the desktop app never showed a second pane (0.3.7-0.3.8): kept only so an old id still draws
const DETAIL_PANE = 'ops-ticket'

const SEVERITY_COLOR = { high: 'error', medium: 'warning', low: 'subtle' } as const
const STATUS_COLOR = { open: 'error', acknowledged: 'suggestion', fixed: 'success', resolved: 'subtle' } as const
const MISSING_COLOR = (label: string) =>
  /conflict|refused|failed|crash|blocked|no status|down|unreachable/i.test(label) ? 'error'
    : /cancel|mismatch|setup|slow|spik/i.test(label) ? 'warning'
      : label.includes('inventory') ? 'suggestion'
        : label.includes('catalogue') ? 'claude'
          : 'subtle'

const COMMANDS: Record<string, string> = {
  tickets: 'Open the ops tickets pane',
  'ops-setup': 'Set up ops-tickets: choose your sources (database, Slack, Sentry, AWS, GitHub, URLs) and owners',
  'ops-run': 'Collect alerts and run every check now, then update the tickets',
  'ticket-show': 'Show one ticket: /ticket-show <id>',
  'ticket-fix': 'Mark a ticket fixed: /ticket-fix <id> [note]',
  'ticket-reopen': 'Reopen a ticket: /ticket-reopen <id>',
}

type Cfg = { python: string }

// Sources the wizard offers, how each connects, and which connector tools give it away.
const SOURCES = [
  { id: 'database', label: 'Database', how: 'Postgres or MySQL, direct or through a tunnel (Cloudflare, SSH). Read-only.', tool: null },
  { id: 'slack', label: 'Slack alert channel', how: 'Reads a channel where Sentry, AWS and GitHub bots post. Needs the Slack connector.', tool: /slack.*read_channel/i },
  { id: 'sentry', label: 'Sentry', how: 'Issues, users affected and spikes straight from Sentry. Needs the Sentry connector.', tool: /sentry/i },
  { id: 'aws', label: 'AWS CloudWatch', how: 'Alarms in ALARM state. Needs an AWS connector (or the AWS CLI).', tool: /aws|cloudwatch/i },
  { id: 'github', label: 'GitHub', how: 'Failed deploys and workflow runs. Needs the GitHub connector (or gh CLI).', tool: /github/i },
  { id: 'urls', label: 'Websites & APIs', how: 'Up, fast, certificate not expiring. Nothing to connect.', tool: null },
] as const

type Setup = {
  step: number
  configured: boolean
  enabled: Record<string, boolean>
  detected: Record<string, boolean>
  tests: Record<string, { ok: boolean | null; message: string }>
  config: Record<string, unknown>
  packs: { name: string; description: string; needs: string[]; ready: boolean }[]
  error: string | null
}

async function ops($: EngineInterface, cfg: Cfg, argv: string[], timeoutMs = 30000, stdin?: string) {
  const engine = `${$.plugin.root}/engine/opsdesk.py`
  const r = await $.process.run([cfg.python, engine, ...argv], stdin === undefined ? { timeoutMs } : { timeoutMs, stdin })
  return { ok: r.exitCode === 0, out: (r.stdout || '').trim(), err: (r.stderr || r.stdout || '').trim() }
}

async function opsJson<T>($: EngineInterface, cfg: Cfg, argv: string[], timeoutMs = 30000): Promise<T | null> {
  const r = await ops($, cfg, argv, timeoutMs)
  if (!r.ok) return null
  try {
    return JSON.parse(r.out) as T
  } catch {
    return null
  }
}

async function reload($: EngineInterface, cfg: Cfg) {
  const r = await ops($, cfg, ['json'])
  if (!r.ok) {
    await update($, message, () => `Could not read tickets: ${r.err.slice(0, 300)}`)
    return
  }
  const list = JSON.parse(r.out) as Ticket[]
  await update($, tickets, () => list)
  const open = list.filter(t => t.status === 'open')
  const high = open.filter(t => t.severity === 'high').length
  await $.ui.status(open.length ? `tickets: ${open.length} open${high ? `, ${high} high` : ''}` : undefined)
}

async function act($: EngineInterface, cfg: Cfg, label: string, argv: string[], timeoutMs?: number) {
  await update($, busy, () => label)
  await update($, message, () => null)
  const r = await ops($, cfg, argv, timeoutMs)
  await update($, message, () => (r.ok ? r.out.split('\n').pop() || 'Done.' : `Failed: ${r.err.slice(0, 300)}`))
  await reload($, cfg)
  await update($, busy, () => null)
  return r
}

async function notifyNew($: EngineInterface, cfg: Cfg) {
  // new high tickets, regressions and spikes since the last call; ops.py marks them delivered
  const r = await ops($, cfg, ['notifications'])
  if (!r.ok) return
  let items: { kind: string; ticket: number; title: string; owner: string | null }[] = []
  try {
    items = JSON.parse(r.out)
  } catch {
    return
  }
  const label = (k: string) => (k === 'reopened' ? 'Regression' : k === 'spike' ? 'Spiking' : 'New')
  for (const it of items.slice(0, 3)) {
    await $.ui.notify(`#${it.ticket} ${it.title}${it.owner ? ` (${it.owner})` : ''}`, { title: `Ops ticket: ${label(it.kind)}` })
  }
  if (items.length > 3) {
    await $.ui.notify(`${items.length - 3} more new/changed tickets in the Ops tickets pane`, { title: 'Ops tickets' })
  }
}

// export takes a status; map the pane's preset view onto one
function viewStatus(view: string): string {
  return view === 'ack' ? 'acknowledged' : view === 'fixed' ? 'fixed' : view === 'open' || view === 'high' ? 'open' : 'all'
}

async function loadOwners($: EngineInterface, cfg: Cfg) {
  const sched = await opsJson<string>($, cfg, ['config-get', 'schedule'])
  await update($, scheduleAt, () => sched ?? null)
  const r = await ops($, cfg, ['owners'])
  if (r.ok) {
    try {
      const list = JSON.parse(r.out) as string[]
      await update($, owners, () => list)
    } catch { /* keep the old list */ }
  }
}

async function findTool($: EngineInterface, pattern: RegExp, verb?: RegExp) {
  const tools = await $.tool.list()
  return tools.find(t => t.mcp && pattern.test(t.name) && (!verb || verb.test(t.name)))?.name ?? null
}

// Slack is read here, directly through the person's Slack connector; the engine parses it.
async function collectSlack($: EngineInterface, cfg: Cfg): Promise<string> {
  const slack = await opsJson<{ enabled: boolean; channel_id: string; lookback_hours: number }>($, cfg, ['config-get', 'sources.slack'])
  if (!slack?.enabled || !slack.channel_id) return ''
  const tool = await findTool($, /slack/i, /read_channel/i)
  if (!tool) return 'Slack: the Slack connector is not connected in this session.'
  const oldest = String(Math.floor(Date.now() / 1000 - (slack.lookback_hours || 26) * 3600))
  const pages: string[] = []
  let cursor: string | null = null
  for (let i = 0; i < 15; i++) {
    const res = await $.tool.call({
      tool, channel_id: slack.channel_id, oldest, limit: 100, response_format: 'detailed', ...(cursor ? { cursor } : {}),
    } as never) as { text?: string; deny?: string }
    if (res.deny) return `Slack: ${res.deny}`
    const text = res.text ?? ''
    pages.push(text)
    cursor = /use cursor: `([^`]+)`/.exec(text)?.[1] ?? null
    if (!cursor) break
  }
  const r = await ops($, cfg, ['ingest-alerts', '-', '--format', 'slack'], 60000, pages.join('\n'))
  return r.ok ? `Slack: ${r.out}` : `Slack: ${r.err.slice(0, 200)}`
}

// Collect every enabled source, run every pack, refresh, notify. Connectors with no fixed
// tool shape (Sentry, AWS, GitHub) are collected by Claude through the ops-collect skill.
async function runAll($: EngineInterface, cfg: Cfg, handOff: boolean) {
  await update($, busy, () => 'Running checks...')
  await update($, message, () => null)
  const notes: string[] = []
  const slackNote = await collectSlack($, cfg)
  if (slackNote) notes.push(slackNote)
  const run = await ops($, cfg, ['run'], 300000)
  notes.push(run.ok ? 'Checks done.' : `Checks failed: ${run.err.slice(0, 200)}`)
  const sources = await opsJson<Record<string, { enabled: boolean }>>($, cfg, ['config-get', 'sources'])
  const viaClaude = ['sentry', 'aws', 'github'].filter(id => sources?.[id]?.enabled)
  if (handOff && viaClaude.length) {
    notes.push(`Asked Claude to collect ${viaClaude.join(', ')}.`)
    await $.prompt.submit({ text: `/ops-tickets:ops-collect ${viaClaude.join(' ')}` } as never)
  }
  await update($, message, () => notes.join('  '))
  await reload($, cfg)
  await update($, busy, () => null)
  await notifyNew($, cfg)
}

async function loadSetup($: EngineInterface, cfg: Cfg) {
  const status = await opsJson<{ configured: boolean; sources: Record<string, { enabled: boolean }>; packs: Setup['packs'] }>(
    $, cfg, ['status'])
  const config = await opsJson<Record<string, unknown>>($, cfg, ['config-get'])
  const tools = await $.tool.list()
  const detected: Record<string, boolean> = {}
  for (const s of SOURCES) {
    detected[s.id] = s.tool ? tools.some(t => t.mcp && s.tool!.test(t.name)) : true
  }
  await update($, setup, prev => ({
    step: prev?.step ?? 0,
    configured: status?.configured ?? false,
    enabled: Object.fromEntries(SOURCES.map(s => [s.id, status?.sources?.[s.id]?.enabled ?? false])),
    detected,
    tests: prev?.tests ?? {},
    config: config ?? {},
    packs: status?.packs ?? [],
    error: status ? null : 'The engine did not answer. Is Python 3 installed and on PATH (plugin setting "python")?',
  }))
}

async function setConfig($: EngineInterface, cfg: Cfg, key: string, value: unknown) {
  const r = await ops($, cfg, ['config-set', key, JSON.stringify(value)])
  if (!r.ok) await update($, message, () => `Could not save ${key}: ${r.err.slice(0, 200)}`)
  await loadSetup($, cfg)
}

async function toggleSource($: EngineInterface, cfg: Cfg, id: string, on: boolean) {
  await ops($, cfg, ['init'])
  await setConfig($, cfg, `sources.${id}.enabled`, on)
}

async function testSource($: EngineInterface, cfg: Cfg, id: string) {
  await update($, setup, prev => (prev ? { ...prev, tests: { ...prev.tests, [id]: { ok: null, message: 'Testing...' } } } : prev))
  let result: { ok: boolean | null; message: string }
  if (id === 'database' || id === 'urls') {
    result = (await opsJson<{ ok: boolean; message: string }>($, cfg, ['test-source', id], 60000))
      ?? { ok: false, message: 'The engine did not answer.' }
  } else {
    const tools = await $.tool.list()
    const src = SOURCES.find(s => s.id === id)
    const found = tools.filter(t => t.mcp && src?.tool?.test(t.name))
    result = found.length
      ? { ok: true, message: `Connector found (${found.length} tools).` }
      : { ok: false, message: 'Not connected in this session. Use "Help me connect".' }
  }
  await update($, setup, prev => (prev ? { ...prev, tests: { ...prev.tests, [id]: result } } : prev))
}

async function findSlackChannel($: EngineInterface, cfg: Cfg, name: string) {
  const tool = await findTool($, /slack/i, /search_channels/i)
  if (!tool) {
    await update($, message, () => 'Slack connector not found: connect Slack first.')
    return
  }
  const clean = name.replace(/^#/, '').trim()
  const res = await $.tool.call({
    tool, keywords: [clean], natural_language_query: clean, channel_types: 'public_channel,private_channel', response_format: 'concise',
  } as never) as { text?: string }
  const m = new RegExp(`#${clean.replace(/[-]/g, '\\-')} \\((C[A-Z0-9]+)\\)`).exec(res.text ?? '') ?? /\((C[A-Z0-9]+)\)/.exec(res.text ?? '')
  if (!m) {
    await update($, message, () => `No channel "${clean}" found. Is the Slack app in that channel?`)
    return
  }
  await setConfig($, cfg, 'sources.slack', { enabled: true, channel_id: m[1], channel_name: `#${clean}`, lookback_hours: 26 })
  await update($, message, () => `Slack channel #${clean} found (${m[1]}).`)
}

// Open or close a ticket and bring the right thing into view: the opened ticket, or on close
// the row it came from (the state write redraws the pane before the scroll).
async function inspect($: EngineInterface, id: number) {
  trace($, `inspect #${id}`)
  await update($, selected, () => id)
  await update($, expanded, () => false)
}

// Switch the list to a preset view from anywhere (KPI cards, integration chips, view buttons).
async function showView($: EngineInterface, value: string) {
  await update($, statusFilter, () => value)
  await update($, pageIndex, () => 0)
  await update($, selected, () => null)
}

async function closeInspect($: EngineInterface, id: number) {
  trace($, `close #${id}`)
  await update($, selected, () => null)
}

async function askClaude($: EngineInterface, text: string) {
  await $.prompt.submit({ text } as never)
}

async function verify($: EngineInterface, cfg: Cfg, id: number) {
  await update($, busy, () => 'Verifying...')
  const r = await ops($, cfg, ['verify', String(id)], 90000)
  let result = { id, ok: false, message: `Verify failed to run: ${r.err.slice(0, 300)}` }
  if (r.ok) {
    try {
      result = { id, ...(JSON.parse(r.out) as { ok: boolean; message: string }) }
    } catch {
      result = { id, ok: false, message: r.out.slice(0, 300) }
    }
  }
  await update($, verified, () => result)
  await reload($, cfg)
  await update($, busy, () => null)
}

async function confirmFix($: EngineInterface, cfg: Cfg, id: number, note: string) {
  const words = note.trim().split(/\s+/).filter(Boolean)
  await act($, cfg, 'Saving...', ['fix', String(id), ...words])
  await update($, confirming, () => null)
}

async function copy($: EngineInterface, surface: RenderSurface, what: string, text: string) {
  const r = await $.ui.copy({ text, surface })
  await update($, message, () => (r.isCopied ? `Copied ${what}.` : `Could not copy (${r.reason}).`))
}

async function exportOpen($: EngineInterface, cfg: Cfg, status: string, source: string | null, owner: string | null) {
  const argv = ['export', '--status', status, ...(source ? ['--source', source] : []), ...(owner ? ['--owner', owner] : [])]
  const r = await act($, cfg, 'Exporting...', argv, 60000)
  const path = r.ok ? r.out.replace(/^.* to /, '').trim() : null
  await update($, exported, () => path)
}

// Open a URL or file with the OS (explorer on Windows, open on macOS, xdg-open on Linux).
// No shell parses the argument.
async function openWithOs($: EngineInterface, target: string, reveal = false) {
  const tries: string[][] = reveal
    ? [['explorer', `/select,${target}`], ['open', '-R', target], ['xdg-open', target.replace(/[\\/][^\\/]*$/, '')]]
    : [['explorer', target], ['open', target], ['xdg-open', target]]
  for (const argv of tries) {
    try {
      const r = await $.process.run(argv)
      if (r.exitCode <= 1) return
    } catch { /* next */ }
  }
  await update($, message, () => `Could not open ${target}`)
}

async function openLink($: EngineInterface, url: string) {
  if (/^https:\/\//.test(url)) await openWithOs($, url)
}

async function openExport($: EngineInterface, path: string, inFolder: boolean) {
  await openWithOs($, path, inFolder)
}

function ticketText(t: Ticket): string {
  const m = t.meta ?? {}
  return [
    `#${t.id} ${t.title}`,
    `Status: ${t.status}  Severity: ${t.severity}`,
    m.country || m.store ? `Where: ${[m.country, m.store, m.city].filter(Boolean).join(' / ')}` : '',
    m.code ? `${m.code_label ?? 'Code'}: ${m.code} '${m.item ?? ''}'  Problem: ${m.missing_in ?? ''}` : '',
    '',
    t.detail ?? '',
    '',
    'Solution:',
    ...t.steps.map((s, i) => `${t.steps_done.includes(i) ? '[x]' : '[ ]'} ${i + 1}. ${s}`),
  ].filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n')
}

function listText(list: Ticket[]): string {
  return list.map(t => `#${t.id} [${t.severity}] ${t.title}`).join('\n')
}

// Scroll trace: a short ring of what moved the tickets pane, written next to the plugin so a
// scroll bug can be read after the fact (scroll-trace.log in the plugin folder).
const traceLines: string[] = []
let traceDue = 0
function trace($: EngineInterface, line: string) {
  traceLines.push(`${new Date().toISOString().slice(11, 23)} ${line}`)
  if (traceLines.length > 300) traceLines.shift()
  if (traceDue) return // one write a second at most: a slow draw makes wheel ticks pile up
  traceDue = 1
  void $.clock.sleep(1000).then(() => {
    traceDue = 0
    return $.fs.write(`${$.plugin.root}/scroll-trace.log`, traceLines.join('\n'))
  }).catch(() => { traceDue = 0 })
}

// The desktop pane pinned a pane taller than itself to its end (repeated moves onto the last
// offset, 0.3.3-0.3.7 traces). So the list pane draws only what fits and owns the wheel.
// what the list pane drew last: how many rows fit and how many there are
let listWindow = { fit: 8, total: 0, windowed: false }
let wheelRest = 0
// rows taken off the window when the drawn list still came out taller than the pane
let fitAdjust = 0

export const register: Register = (on, options) => {
  on('ui.scroll', { requestId: DETAIL_PANE }, async ($, e, next) => {
    trace($, `detail scroll origin=${e.origin.kind} by=${e.by} offset=${e.offset} body=${e.bodyRows} content=${e.contentRows}`)
    return next(e)
  })
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if (!listWindow.windowed) return next(e) // terminal and phones scroll the pane as usual
    trace($, `scroll origin=${e.origin.kind} by=${e.by} offset=${e.offset} body=${e.bodyRows} content=${e.contentRows}`)
    if (e.contentRows > e.bodyRows && listWindow.fit > 2) {
      // the estimate drew too much: take rows off and redraw, so the pane never has an end to pin
      fitAdjust += Math.max(1, Math.ceil((e.contentRows - e.bodyRows) / 4))
      trace($, `  overflow ${e.contentRows - e.bodyRows} rows: fitAdjust=${fitAdjust}`)
      $.ui.invalidate('ui.render')
    }
    if (e.origin.kind !== 'person') return {}
    // the pane's own window stays put; a wheel tick of ~3 rows moves the list by one ticket.
    // Jumps of a page or more are the surface pinning itself, not the wheel: ignored.
    if (Math.abs(e.by) > e.bodyRows / 2) { trace($, '  ignored jump'); return {} }
    wheelRest += e.by
    const steps = Math.trunc(wheelRest / 3)
    if (!steps) return {}
    wheelRest -= steps * 3
    const max = Math.max(0, listWindow.total - listWindow.fit)
    await update($, pageIndex, p => Math.max(0, Math.min(max, p + steps)))
    return {}
  })

  const cfg: Cfg = { python: String(options.python ?? 'python') }

  on('session.start', async ($, e, next) => {
    for (const [name, description] of Object.entries(COMMANDS)) {
      await $.command.register({ name, description })
    }
    const status = await opsJson<{ configured: boolean }>($, cfg, ['status'])
    if (status && !status.configured) {
      await loadSetup($, cfg)
      void $.ui.open({ id: SETUP_PANE, title: 'Ops tickets setup' })
    } else {
      await reload($, cfg)
      await loadOwners($, cfg)
      void $.ui.open({ id: PANE, title: 'Ops tickets' })
      void notifyNew($, cfg)
    }
    return next(e)
  })

  on('command.run', async ($, e, next) => {
    if (!(e.command in COMMANDS)) return next(e)
    const [id, ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    if (e.command === 'tickets') {
      await reload($, cfg)
      await loadOwners($, cfg)
      await $.ui.open({ id: PANE, title: 'Ops tickets' })
      return { text: 'Ops tickets pane opened.' }
    }
    if (e.command === 'ops-setup') {
      await loadSetup($, cfg)
      await $.ui.open({ id: SETUP_PANE, title: 'Ops tickets setup' })
      return { text: 'Setup opened.' }
    }
    if (e.command === 'ops-run') {
      await runAll($, cfg, true)
      const note = await read($, message)
      await $.ui.open({ id: PANE, title: 'Ops tickets' })
      return { text: note ?? 'Done.' }
    }
    if (!/^\d+$/.test(id ?? '')) return { text: `Usage: /${e.command} <id>` }
    if (e.command === 'ticket-show') {
      await update($, selected, () => Number(id))
      await $.ui.open({ id: PANE, title: 'Ops tickets' })
      return { text: `Showing #${id} in the pane.` }
    }
    const r = await act($, cfg, 'Saving...', e.command === 'ticket-fix' ? ['fix', id!, ...rest] : ['reopen', id!])
    return { text: r.ok ? r.out : r.err }
  })

  // one drawing for both panes: the list (PANE) and the opened ticket (DETAIL_PANE)
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE && e.requestId !== DETAIL_PANE) return next(e)
    const isDetail = e.requestId === DETAIL_PANE
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = e.surface !== 'mobile' && 'Input' in els ? els.Input : null
    const Select = e.surface !== 'mobile' && 'Select' in els ? els.Select : null
    const Markdown = 'Markdown' in els ? els.Markdown : null
    const Code = 'Code' in els ? els.Code : null
    const Link = 'Link' in els ? els.Link : null
    const isDesktop = e.surface === 'desktop'
    const isMobile = e.surface === 'mobile'
    const Svg = (isDesktop || isMobile) && 'Svg' in els ? els.Svg : null
    // phones and narrow panes: stacked rows, stacked header, inspector under its row
    const compact = isMobile || (e.viewport?.columns ?? 160) < 90
    const all = await read($, tickets)
    const view = await read($, statusFilter)          // the preset view: open | high | ack | fixed | all | src:<x> | geo:<x>
    const search = (await read($, sourceFilter)) ?? '' // free-text filter
    const who = await read($, ownerFilter)
    const page = await read($, pageIndex)
    const ownerList = await read($, owners)
    const sel = await read($, selected)
    const working = await read($, busy)
    const note = await read($, message)
    const confirmId = await read($, confirming)
    const checkResult = await read($, verified)
    const exportPath = await read($, exported)
    const schedule = await read($, scheduleAt)
    const showAll = await read($, expanded)

    // ---------------------------------------------------------------- palette
    const k = isDesktop ? C : null
    const col = (hex: string | undefined, theme: string) => (k ? hex : theme || undefined) as never
    const TINT: Record<string, [string, string]> = {
      rose: ['#3b1520', C.roseSoft], amber: ['#3a2a10', C.amberSoft], emerald: ['#0f2e24', C.emerald],
      cyan: ['#0e2a3b', C.cyanSoft], ghost: ['#1b2947', '#cbd5e1'], solidRose: ['#4c0519', '#fda4af'],
    }
    const chip = (key: string, text: string, t: string) => {
      const [bg, fg] = TINT[t] ?? TINT.ghost!
      return <Text key={key} backgroundColor={col(bg, 'promptBorder')} color={col(fg, 'text')}>{` ${text} `}</Text>
    }
    const tone = (label: string) =>
      /conflict|refused|failed|crash|blocked|no status|down|unreachable|regression/i.test(label) ? 'rose'
        : /cancel|mismatch|setup|slow|spik|missing|inventory|catalogue/i.test(label) ? 'amber'
          : /fixed|verified|ok\b/i.test(label) ? 'emerald' : 'cyan'
    const PRIORITY = { high: ['P0 CRITICAL', 'solidRose'], medium: ['P1 HIGH', 'amber'], low: ['P2 MED', 'ghost'] } as const
    const mdText = (s: string) => s.replace(/[\\`*_[\]#<>|]/g, m => `\\${m}`)
    const heading = (key: string, level: 1 | 2 | 3, text: string) =>
      Markdown && isDesktop ? <Markdown key={key} text={`${'#'.repeat(level)} ${mdText(text)}`} /> : <Text key={key} bold>{text}</Text>

    // ------------------------------------------------------------------ data
    const ageMin = (iso: string) => Math.max(0, (Date.now() - Date.parse(iso)) / 60000)
    const dur = (m: number) => (m < 60 ? `${Math.round(m)}m` : m < 1440 ? `${Math.floor(m / 60)}h ${Math.round(m % 60)}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`)
    const ago = (iso: string) => `${dur(ageMin(iso))} ago`
    const doneCount = (t: Ticket) => t.steps.filter((_, i) => t.steps_done.includes(i)).length
    const place = (t: Ticket) => [t.meta?.country, t.meta?.store].filter(Boolean).join(' · ')
    const live = all.filter(t => t.status !== 'resolved')
    const open = live.filter(t => t.status === 'open')
    const high = open.filter(t => t.severity === 'high')
    const sevRank = { high: 0, medium: 1, low: 2 } as const
    // finished work (fixed and watched, or resolved) lives in the Completed tab only
    const isDone = (t: Ticket) => t.status === 'fixed' || t.status === 'resolved'
    const done = all.filter(isDone)
    const active = all.filter(t => !isDone(t))
    const isDoneView = view === 'done' || view === 'fixed'
    const matchView = (t: Ticket) =>
      isDoneView ? (view === 'fixed' ? t.status === 'fixed' : isDone(t))
        : isDone(t) ? false
          : view === 'open' ? t.status === 'open'
            : view === 'high' ? t.status === 'open' && t.severity === 'high'
              : view === 'ack' ? t.status === 'acknowledged'
                : view === 'code' ? t.status === 'open' && !!t.meta?.code
                  : view === 'regress' ? t.reopen_count > 0
                    : view.startsWith('src:') ? t.source === view.slice(4)
                      : view.startsWith('geo:') ? t.meta?.country === view.slice(4)
                        : true
    const q = search.trim().toLowerCase()
    const matchSearch = (t: Ticket) => !q || [t.title, t.detail ?? '', t.meta?.code ?? '', t.owner ?? '', place(t), String(t.id), t.source]
      .some(s => s.toLowerCase().includes(q))
    const shown = all.filter(t => matchView(t) && matchSearch(t) && (!who || t.owner === who))
      .sort(isDoneView
        ? (a, b) => (b.fixed_at ?? b.last_seen).localeCompare(a.fixed_at ?? a.last_seen) // newest finished first
        : (a, b) => sevRank[a.severity] - sevRank[b.severity] || b.last_seen.localeCompare(a.last_seen))
    // The list pane never draws taller than the pane: a taller tree let the desktop pin its window
    // to the end (see ui.scroll). The wheel moves `pageIndex` (the first row shown) instead.
    const bodyRows = Math.max(16, (e.viewport?.rows ?? 48) - 1)
    const ROW_H = compact ? 6 : 4
    const scrolledDown = isDesktop && (page > 0 || all.some(t => t.id === sel))
    const TOP_H = scrolledDown ? 4 : Svg ? 30 : compact ? 22 : 18
    const windowed = isDesktop // only the desktop pane pinned itself to its end
    const fit = windowed ? Math.max(2, Math.floor((bodyRows - TOP_H - 7) / ROW_H) - fitAdjust) : Math.max(1, shown.length)
    const start = Math.max(0, Math.min(page, shown.length - fit))
    const pageRows = shown.slice(start, start + fit)
    if (!isDetail) listWindow = { fit, total: shown.length, windowed }
    const current = all.find(t => t.id === sel) ?? null
    const wide = isDesktop && !compact && (e.viewport?.columns ?? 160) >= 120
    const countBy = (key: (t: Ticket) => string | undefined, list: Ticket[]) =>
      [...list.reduce((m, t) => { const v = key(t); return v ? m.set(v, (m.get(v) ?? 0) + 1) : m }, new Map<string, number>())]
        .sort((a, b) => b[1] - a[1])
    const sourcesOpen = countBy(t => t.source, open)
    const countries = countBy(t => t.meta?.country, open).filter(([c]) => c !== 'Alerts')
    const dayAgoIso = new Date(Date.now() - 86400000).toISOString().slice(0, 19)
    const weekAgoIso = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 19)
    const fixed = live.filter(t => t.status === 'fixed')
    const fixed7 = all.filter(t => t.fixed_at && t.fixed_at >= weekAgoIso)
    const mttr = fixed7.length ? fixed7.reduce((a, t) => a + (Date.parse(t.fixed_at!) - Date.parse(t.first_seen)) / 60000, 0) / fixed7.length : null
    const fixedToday = all.filter(t => t.fixed_at && t.fixed_at >= dayAgoIso).length
    const verifiedToday = all.filter(t => t.events.some(ev => ev.kind === 'verified' && ev.at >= dayAgoIso)).length
    const regressions = open.filter(t => t.reopen_count > 0).length
    const newDay = open.filter(t => t.first_seen >= dayAgoIso).length
    const oldestHigh = high.reduce((m, t) => Math.max(m, ageMin(t.first_seen)), 0)
    const codeOpen = open.filter(t => t.meta?.code)
    const codeLabel = codeOpen[0]?.meta?.code_label ?? 'Code'
    const codePlaces = new Set(codeOpen.map(t => t.meta?.store).filter(Boolean)).size
    const codeCountries = [...new Set(codeOpen.map(t => t.meta?.country).filter(Boolean))].slice(0, 3).join(' · ')
    const topProblem = countBy(t => t.meta?.missing_in, codeOpen.length ? codeOpen : open)[0]
    const lastSeen = all.reduce((m, t) => (t.last_seen > m ? t.last_seen : m), '')
    const health = (name: string) => {
      const o = open.filter(t => t.source === name)
      return o.some(t => t.severity === 'high') ? 'rose' : o.length ? 'amber' : 'emerald'
    }

    // --------------------------------------------------------------- pieces
    const pipeline = (t: Ticket): [string, number, string] =>
      t.status === 'fixed' ? ['FIXED', 1, C.emerald]
        : t.status === 'acknowledged' ? ['ACKNOWLEDGED', 1, C.cyan]
          : doneCount(t) === 0 ? ['QUEUED', 0.2, '#64748b']
            : doneCount(t) >= t.steps.length - 1 ? ['VERIFY', 0.85, C.cyan]
              : ['TRIAGING', doneCount(t) / t.steps.length, C.amberSoft]

    const compactRow = (t: Ticket) => {
      const isSel = t.id === sel
      const [plabel, ptone] = PRIORITY[t.severity]
      const [pstate, ppct, pcolor] = pipeline(t)
      return (
        <Box key={`t-${t.id}`} flexDirection="column" gap={0} paddingX={1} paddingY={1}
          backgroundColor={col(isSel ? '#0e2236' : undefined, isSel ? 'promptBorder' : '')}
          borderStyle="single" borderColor={col(isSel ? C.cyan : C.hair, isSel ? 'suggestion' : 'promptBorder')}>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {chip(`pp-${t.id}`, plabel, ptone)}
            <Text color={col(C.muted, 'subtle')}>{`#INC-${t.id}`}</Text>
            {t.meta?.code && (
              <Button key={`code-${t.id}`} plain label={`${t.meta.code_label ?? 'Code'} ${t.meta.code} ⧉`}
                onPress={() => void copy($, e.surface, `${t.meta?.code_label ?? 'code'} ${t.meta?.code}`, t.meta?.code ?? '')} />
            )}
          </Box>
          <Text bold wrap="wrap" color={col(C.strong, 'text')}>{shortTitle(t).replace(/^(PLU|SKU|Code) \d+ /, '')}</Text>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {place(t) && chip(`pl-${t.id}`, `▪ ${place(t)}`, 'ghost')}
            {t.meta?.missing_in && chip(`pm-${t.id}`, t.meta.missing_in, tone(t.meta.missing_in))}
            {t.reopen_count > 0 && chip(`pr-${t.id}`, `REGRESSION x${t.reopen_count}`, 'rose')}
          </Box>
          <Text wrap="wrap" color={col(C.muted, 'subtle')}>{`${t.source} · Owner: ${t.owner ?? 'Unassigned'}`}</Text>
          <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
            <Text bold color={col(t.occurrences >= 10 ? C.roseSoft : '#cbd5e1', 'text')}>{`${t.occurrences} hits`}</Text>
            <Text color={col(C.ghost, 'subtle')}>{`· ${ago(t.last_seen)} ·`}</Text>
            <Text color={col(pcolor, 'subtle')}>{pstate}</Text>
            {Svg ? <Svg key={`pipe-${t.id}`} source={pipeSvg(ppct, pcolor)} alt={`${pstate} ${Math.round(ppct * 100)}%`} /> : null}
            {Link && urlsOf(t)[0] && <Link key={`rowlink-${t.id}`} href={urlsOf(t)[0]!} label="↗ link" />}
          </Box>
          <Button key={`pick-${t.id}`} label={isSel ? 'Close' : 'Inspect »'} variant={isSel ? 'primary' : 'secondary'}
            onPress={() => void (isSel ? closeInspect($, t.id) : inspect($, t.id))} />
        </Box>
      )
    }

    const row = (t: Ticket) => {
      if (compact) return compactRow(t)
      const isSel = t.id === sel
      const [plabel, ptone] = PRIORITY[t.severity]
      const [pstate, ppct, pcolor] = pipeline(t)
      return (
        <Box key={`t-${t.id}`} flexDirection="row" gap={1} paddingX={1} paddingY={0} alignItems="center"
          backgroundColor={col(isSel ? '#0e2236' : undefined, isSel ? 'promptBorder' : '')}
          hover={{ backgroundColor: col('#131e36', 'inactive') }}>
          <Text color={col(isSel ? C.cyan : '#0d1527', isSel ? 'suggestion' : 'text')}>{isSel ? '▌' : ' '}</Text>
          <Box flexDirection="column" width={13}>{chip(`pp-${t.id}`, plabel, ptone)}</Box>
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Text color={col(C.muted, 'subtle')}>{`#INC-${t.id}`}</Text>
              {t.meta?.code && (
                <Button key={`code-${t.id}`} plain label={`${t.meta.code_label ?? 'Code'} ${t.meta.code} ⧉`}
                  onPress={() => void copy($, e.surface, `${t.meta?.code_label ?? 'code'} ${t.meta?.code}`, t.meta?.code ?? '')} />
              )}
              <Text bold color={col(isSel ? C.strong : '#e2e8f0', 'text')} wrap="truncate-end">{shortTitle(t).replace(/^(PLU|SKU|Code) \d+ /, '')}</Text>
            </Box>
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {place(t) && chip(`pl-${t.id}`, `▪ ${place(t)}`, 'ghost')}
              {t.meta?.missing_in && chip(`pm-${t.id}`, t.meta.missing_in, tone(t.meta.missing_in))}
              <Text color={col(C.ghost, 'subtle')}>·</Text>
              <Text color={col(C.muted, 'subtle')}>{t.source}</Text>
              <Text color={col(C.ghost, 'subtle')}>·</Text>
              <Text color={col('#cbd5e1', 'text')}>Owner: <Text bold color={col(isSel ? C.cyan : '#cbd5e1', 'text')}>{t.owner ?? 'Unassigned'}</Text></Text>
              {t.reopen_count > 0 && chip(`pr-${t.id}`, `REGRESSION x${t.reopen_count}`, 'rose')}
              {Link && urlsOf(t)[0] && <Link key={`rowlink-${t.id}`} href={urlsOf(t)[0]!} label={`↗ ${linkLabel(urlsOf(t)[0]!).split('/')[0]}`} />}
            </Box>
          </Box>
          <Box flexDirection="column" alignItems="flex-end" width={10}>
            <Text bold color={col(t.occurrences >= 10 ? C.roseSoft : '#cbd5e1', 'text')}>{`${t.occurrences >= 10 ? '↗ ' : ''}${t.occurrences} hits`}</Text>
            <Text color={col(C.ghost, 'subtle')}>{ago(t.last_seen)}</Text>
          </Box>
          <Box flexDirection="column" alignItems="center" width={13}>
            <Text color={col(pcolor, 'subtle')}>{pstate}</Text>
            {Svg ? <Svg key={`pipe-${t.id}`} source={pipeSvg(ppct, pcolor)} alt={`${pstate} ${Math.round(ppct * 100)}%`} />
              : <Text color="subtle">{`${'█'.repeat(Math.round(ppct * 8))}${'░'.repeat(8 - Math.round(ppct * 8))}`}</Text>}
          </Box>
          <Button key={`pick-${t.id}`} label={isSel ? 'Close' : 'Inspect »'} variant={isSel ? 'primary' : 'secondary'}
            onPress={() => void (isSel ? closeInspect($, t.id) : inspect($, t.id))} />
        </Box>
      )
    }

    const inspector = (t: Ticket) => {
      const [plabel, ptone] = PRIORITY[t.severity]
      const done = doneCount(t)
      const nextStep = t.steps.findIndex((_, i) => !t.steps_done.includes(i))
      const evidence = JSON.stringify({
        source: t.source, check: t.check_name, ...(t.meta?.code ? { [`${(t.meta.code_label ?? 'code').toLowerCase()}`]: t.meta.code } : {}),
        ...(t.meta?.item ? { item: t.meta.item } : {}), ...(t.meta?.store ? { place: t.meta.store } : {}),
        ...(t.meta?.country ? { country: t.meta.country } : {}), occurrences: t.occurrences, first_seen: t.first_seen, last_seen: t.last_seen,
      }, null, 2)
      return (
        <Box key={`detail-${t.id}`} flexDirection="column" backgroundColor={col('#0d1527', '')}
          borderStyle="single" borderColor={col('#1f4d6b', SEVERITY_COLOR[t.severity])}>
          {Svg && <Svg key={`accent-${t.id}`} source={accentSvg(compact ? 320 : 600)} alt="" />}
          <Box flexDirection="column" gap={1} paddingX={2} paddingY={1} backgroundColor={col('#101a30', '')}>
            <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" gap={1}>
              <Box flexDirection="row" gap={1} flexWrap="wrap">
                {chip(`dp-${t.id}`, plabel, ptone)}
                {chip(`di-${t.id}`, `INC-${t.id}`, 'cyan')}
                <Text color={col(C.muted, 'subtle')}>{t.check_name.toUpperCase()}</Text>
                {t.status !== 'open' && chip(`ds-${t.id}`, t.status.toUpperCase(), t.status === 'fixed' ? 'emerald' : 'cyan')}
              </Box>
              <Box flexDirection="row" gap={1}>
                {t.status === 'open' && chip(`age-${t.id}`, `⏱ OPEN ${dur(ageMin(t.first_seen))}`, t.severity === 'high' ? 'rose' : 'amber')}
                <Button key="close-detail" plain label="✕" onPress={() => void closeInspect($, t.id)} />
              </Box>
            </Box>
            <Text key={`dt-${t.id}`} bold color={col('#f1f5f9', 'text')}>{shortTitle(t)}</Text>
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Box flexDirection="column" paddingX={1} flexGrow={1} backgroundColor={col('#080d1a', '')} borderStyle="single" borderColor={col(C.hair, 'promptBorder')}>
                <Text color={col(C.ghost, 'subtle')}>IMPACTED PLACE</Text>
                <Text bold color={col('#e2e8f0', 'text')}>{place(t) || t.source}</Text>
              </Box>
              <Box flexDirection="column" paddingX={1} flexGrow={1} backgroundColor={col('#080d1a', '')} borderStyle="single" borderColor={col(C.hair, 'promptBorder')}>
                <Text color={col(C.ghost, 'subtle')}>OCCURRENCES</Text>
                <Text bold color={col(t.occurrences >= 10 ? C.roseSoft : '#e2e8f0', 'text')}>{`${t.occurrences} seen · last ${ago(t.last_seen)}`}</Text>
              </Box>
              <Box flexDirection="column" paddingX={1} flexGrow={1} backgroundColor={col('#080d1a', '')} borderStyle="single" borderColor={col(C.hair, 'promptBorder')}>
                <Text color={col(C.ghost, 'subtle')}>OWNER</Text>
                {Select ? (
                  <Select key={`owner-${t.id}`} value={t.owner ?? ''}
                    options={[...new Set([...ownerList, ...(t.owner ? [t.owner] : [])])].map(o => ({ value: o, label: o }))}
                    onSelect={(value: string) => { trace($, `owner select #${t.id} ${t.owner} -> ${value}`); if (value !== (t.owner ?? '')) void act($, cfg, 'Saving...', ['owner', String(t.id), value]) }} />
                ) : <Text bold>{t.owner ?? 'Unassigned'}</Text>}
              </Box>
            </Box>
          </Box>

          <Box flexDirection="column" gap={0} paddingX={2} paddingY={1} backgroundColor={col('#070c18', '')}>
            <Box flexDirection="row" justifyContent="space-between">
              <Text bold color={col('#cbd5e1', 'text')}>{'{ } DIAGNOSTIC EVIDENCE PAYLOAD'}</Text>
              <Box flexDirection="row" gap={1}>
                {t.meta?.url && (
                  <Button key={`open-link-${t.id}`} plain
                    label={t.meta.url.includes('sentry') ? 'Sentry ↗' : t.meta.url.includes('github') ? 'GitHub ↗' : t.meta.url.includes('aws') ? 'AWS ↗' : 'Open ↗'}
                    onPress={() => void openLink($, t.meta?.url ?? '')} />
                )}
                <Button key={`copy-ticket-${t.id}`} plain label="Copy ⧉" onPress={() => void copy($, e.surface, `ticket #${t.id}`, ticketText(t))} />
              </Box>
            </Box>
            {t.detail && <Text wrap="wrap" color={col(C.roseSoft, 'error')}>{`[${(t.meta?.missing_in ?? t.severity).toUpperCase()}] ${t.detail.split('\n')[0]}`}</Text>}
            {(() => {
              const full = isDesktop ? `${evidence}\n\n${t.detail ?? ''}` : t.detail ?? ''
              const lines = full.split('\n')
              const shownText = showAll || lines.length <= 8 ? full : `${lines.slice(0, 8).join('\n')}\n…`
              return (
                <Box flexDirection="column">
                  {/* plain text, not Code: the desktop code viewer pulled the pane to its end */}
                  <Box paddingX={1} backgroundColor={col('#080d1a', '')}>
                    <Text wrap="wrap" color={col('#cbd5e1', 'text')}>{shownText}</Text>
                  </Box>
                  {lines.length > 8 && (
                    <Button key={`ev-more-${t.id}`} plain label={showAll ? '▴ Show less' : `▾ Show full evidence (${lines.length} lines)`}
                      onPress={() => void update($, expanded, v => !v)} />
                  )}
                </Box>
              )
            })()}
            {t.action && <Text wrap="wrap" color={col('#cbd5e1', 'text')}>{t.action}</Text>}
            {Link && urlsOf(t).length > 0 && (
              <Box flexDirection="column" gap={0} marginTop={1}>
                <Text bold color={col(C.muted, 'subtle')}>{`LINKS (${urlsOf(t).length})`}</Text>
                {urlsOf(t).map((u, i) => (
                  <Box key={`lnk-${t.id}-${i}`} flexDirection="row" gap={1}>
                    <Text color={col(C.cyan, 'suggestion')}>↗</Text>
                    <Link key={`link-${t.id}-${i}`} href={u} label={linkLabel(u)} />
                  </Box>
                ))}
              </Box>
            )}
          </Box>

          <Box flexDirection="column" gap={1} paddingX={2} paddingY={1}>
            <Box flexDirection="row" justifyContent="space-between">
              <Text bold color={col('#e2e8f0', 'text')}>{'⇄ RUNBOOK PIPELINE'}</Text>
              <Text bold color={col(done === t.steps.length ? C.emerald : C.cyan, 'suggestion')}>
                {done === t.steps.length ? `All ${t.steps.length} steps done` : `Step ${nextStep + 1} of ${t.steps.length}`}
              </Text>
            </Box>
            {t.steps.map((step, i) => {
              const isDone = t.steps_done.includes(i)
              const isNext = i === nextStep
              return (
                <Box key={`step-row-${t.id}-${i}`} flexDirection="row" gap={1} paddingX={1}
                  backgroundColor={col(isNext ? '#0e2a3b' : isDone ? '#0f1d2c' : '#0b1222', '')}
                  borderStyle="single" borderColor={col(isNext ? '#1f6f99' : isDone ? '#14532d' : C.hair, isNext ? 'suggestion' : 'promptBorder')}>
                  <Button key={`step-${t.id}-${i}`} plain label={isDone ? '✔' : isNext ? '◐' : '○'}
                    onPress={() => void act($, cfg, 'Saving...', ['step', String(t.id), String(i)])} />
                  <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                    <Text wrap="wrap" bold={isNext} strikethrough={isDone}
                      color={col(isDone ? C.ghost : isNext ? C.strong : C.muted, isDone ? 'subtle' : 'text')}>{`${i + 1}. ${step}`}</Text>
                    {isDone && <Text color={col(C.emerald, 'success')}>Done</Text>}
                    {isNext && (
                      <Box flexDirection="row" gap={1} marginTop={0}>
                        <Button key={`step-do-${t.id}-${i}`} label="✔ Mark step done" variant="primary"
                          onPress={() => void act($, cfg, 'Saving...', ['step', String(t.id), String(i)])} />
                        {i === t.steps.length - 1 && (
                          <Button key={`verify-inline-${t.id}`} label={working === 'Verifying...' ? 'Verifying...' : '↻ Verify now'}
                            onPress={() => { if (!working) void verify($, cfg, t.id) }} />
                        )}
                      </Box>
                    )}
                  </Box>
                </Box>
              )
            })}

            {checkResult && checkResult.id === t.id && (
              <Box paddingX={1} borderStyle="single" borderColor={col(checkResult.ok ? C.emerald : C.amberSoft, checkResult.ok ? 'success' : 'warning')}>
                <Text color={col(checkResult.ok ? C.emerald : C.amberSoft, checkResult.ok ? 'success' : 'warning')} wrap="wrap">
                  {`${checkResult.ok ? '✓ Verified: ' : '! Not yet: '}${checkResult.message}`}
                </Text>
              </Box>
            )}
            {t.fixed_note && <Text color={col(C.emerald, 'success')} wrap="wrap">{`Fixed ${t.fixed_at}: ${t.fixed_note}`}</Text>}

            {t.status === 'fixed' || t.status === 'resolved' ? (
              <Box flexDirection="row" gap={1} flexWrap="wrap">
                <Button key={`verify-${t.id}`} label={working === 'Verifying...' ? 'Verifying...' : '↻ Verify now'}
                  onPress={() => { if (!working) void verify($, cfg, t.id) }} />
                <Button key={`reopen-${t.id}`} label="Reopen" onPress={() => void act($, cfg, 'Saving...', ['reopen', String(t.id)])} />
              </Box>
            ) : confirmId === t.id ? (
              <Box flexDirection="column" gap={1} padding={1} borderStyle="single" borderColor={col(C.emerald, 'success')}>
                {heading(`dc-${t.id}`, 3, `Confirm INC-${t.id} is resolved?`)}
                {!(checkResult?.id === t.id && checkResult.ok) && (
                  <Text color={col(C.amberSoft, 'warning')} wrap="wrap">
                    Verify has not passed yet. If it is still broken, the next run will reopen it as a regression.
                  </Text>
                )}
                {Input ? (
                  <Input key={`fix-${t.id}`} label="What did you do?" placeholder="e.g. fixed the config and re-ran the job"
                    submitLabel="Yes, mark resolved" autoFocus onSubmit={(value: string) => void confirmFix($, cfg, t.id, value)} />
                ) : (
                  <Button key={`fix-${t.id}`} label="Yes, mark resolved" variant="primary" onPress={() => void confirmFix($, cfg, t.id, '')} />
                )}
                <Button key={`cancel-fix-${t.id}`} label="Cancel" onPress={() => void update($, confirming, () => null)} />
              </Box>
            ) : (
              <Box flexDirection="row" gap={1} flexWrap="wrap" paddingTop={1}>
                <Button key={`ask-fix-${t.id}`} label="✔ Mark incident resolved" variant="primary" onPress={() => void update($, confirming, () => t.id)} />
                <Button key={`verify-${t.id}`} label={working === 'Verifying...' ? 'Verifying...' : '↻ Verify'}
                  onPress={() => { if (!working) void verify($, cfg, t.id) }} />
                {t.status === 'open' ? (
                  <Button key={`ack-${t.id}`} label="Acknowledge" onPress={() => void act($, cfg, 'Saving...', ['ack', String(t.id)])} />
                ) : (
                  <Button key={`unack-${t.id}`} label="Back to open" onPress={() => void act($, cfg, 'Saving...', ['unack', String(t.id)])} />
                )}
                {t.meta?.code && (
                  <Button key={`copy-code-${t.id}`} label={`Copy ${t.meta.code_label ?? 'code'}`}
                    onPress={() => void copy($, e.surface, `${t.meta?.code_label ?? 'code'} ${t.meta?.code}`, t.meta?.code ?? '')} />
                )}
                <Button key={`copy-steps-${t.id}`} label="Copy steps"
                  onPress={() => void copy($, e.surface, 'the runbook steps', t.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'))} />
              </Box>
            )}

            <Box flexDirection="column" gap={0}>
              <Text bold color={col(C.ghost, 'subtle')}>AUDIT TRAIL</Text>
              {t.events.slice(showAll ? -12 : -3).map((ev, i) => (
                <Box key={`ev-${i}`} flexDirection="row" justifyContent="space-between">
                  <Text wrap="truncate-end">
                    <Text color={col(/fix|verified/.test(ev.kind) ? C.emerald : /reopen|spike|fail/.test(ev.kind) ? C.roseSoft : ev.kind === 'opened' ? C.amberSoft : C.cyan, 'suggestion')}>{'● '}</Text>
                    <Text color={col(C.text, 'text')}>{`${ev.kind}${ev.note ? `: ${ev.note}` : ''}`}</Text>
                  </Text>
                  <Text color={col(C.ghost, 'subtle')}>{ev.at.slice(5, 16).replace('T', ' ')}</Text>
                </Box>
              ))}
            </Box>
          </Box>
        </Box>
      )
    }

    const viewBtn = (key: string, label: string, n: number, value: string, dot?: string) => (
      <Button key={`v-${key}`} label={`${dot ? `${dot} ` : ''}${label}  ${n}`} variant={view === value ? 'primary' : 'secondary'}
        onPress={() => void showView($, value)} />
    )

    const table = (
      <Box flexDirection="column" backgroundColor={col('#0d1527', '')} borderStyle="single" borderColor={col(C.hair, 'promptBorder')}>
        <Box flexDirection="row" justifyContent="space-between" paddingX={1} backgroundColor={col('#111a2e', '')}>
          <Box flexDirection="row" gap={1}>
            <Text bold color={col('#cbd5e1', 'text')}>INCIDENT &amp; ENTITY RECORD</Text>
            {chip('showing', shown.length ? `Rows ${start + 1}–${start + pageRows.length} of ${shown.length}` : 'Showing 0', 'ghost')}
          </Box>
          {!compact && <Text color={col(C.muted, 'subtle')}>FREQUENCY · PIPELINE · ACTION</Text>}
        </Box>
        {isDoneView && (
          <Box paddingX={1} flexDirection="row" gap={1} flexWrap="wrap">
            <Text color={col(C.emerald, 'success')}>✓ Completed: fixed tickets stay here while they are watched, then auto-resolve. A regression reopens one in the main list.</Text>
            <Button key="back-active" plain label="‹ Back to active" onPress={() => void showView($, 'open')} />
          </Box>
        )}
        {shown.length === 0 && <Box paddingX={1} paddingY={1}><Text color={col(C.emerald, 'success')}>{isDoneView ? 'Nothing completed yet.' : 'No incidents match this view.'}</Text></Box>}
        {pageRows.flatMap(t => [row(t), ...(!isDesktop && t.id === sel ? [inspector(t)] : [])])}
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" paddingX={1} backgroundColor={col('#060a14', '')}>
          <Text color={col(C.muted, 'subtle')}><Text color={col(C.emerald, 'success')}>● </Text>{`Live: ${open.length} open incidents`}</Text>
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text color={col(C.muted, 'subtle')}>{`${shown.length - start - pageRows.length} more below · scroll or use ▲ ▼`}</Text>
            <Button key="pg-prev" plain label="▲" onPress={() => void update($, pageIndex, () => Math.max(0, start - fit))} />
            <Button key="pg-next" plain label="▼" onPress={() => void update($, pageIndex, () => Math.max(0, Math.min(shown.length - fit, start + fit)))} />
          </Box>
        </Box>
      </Box>
    )

    if (isDetail) {
      return current
        ? <Box key="detail-pane" flexDirection="column" backgroundColor={col('#0b1326', '')}>{inspector(current)}</Box>
        : <Box padding={1}><Text color={col(C.muted, 'subtle')}>No ticket selected. Press Inspect on a ticket in the Ops tickets pane.</Text></Box>
    }

    return (
      <Box flexDirection="column" gap={1} padding={1} backgroundColor={col(C.canvas, '')}>
        {scrolledDown ? (
          <Box key="top-folded" flexDirection="row" gap={1} alignItems="center" paddingX={1}
            backgroundColor={col('#080d1a', '')} borderStyle="single" borderColor={col(C.hair, 'promptBorder')}>
            <Text bold color={col(C.strong, 'text')}>OPS TICKETS</Text>
            <Text color={col(C.muted, 'subtle')}>{`${open.length} open · ${high.length} P0 · view: ${view}`}</Text>
            <Button key="back-top" plain label="▲ Back to top" onPress={() => void update($, pageIndex, () => 0)} />
          </Box>
        ) : (
          <Box key="top" flexDirection="column" gap={1}>
        {/* command header */}
        <Box flexDirection={compact ? 'column' : 'row'} justifyContent="space-between" alignItems={compact ? 'flex-start' : 'center'} flexWrap="wrap" gap={1}
          paddingX={1} backgroundColor={col('#080d1a', '')} borderStyle="single" borderColor={col(C.hair, 'promptBorder')}>
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text bold backgroundColor={col('#0e2a3b', 'promptBorder')} color={col(C.cyan, 'suggestion')}>{' >_ '}</Text>
            <Text bold color={col(C.strong, 'text')}>OPS TICKETS</Text>
            {chip('core', 'INCIDENT COMMAND', 'cyan')}
            <Text color={col(C.emerald, 'success')}>{`● Synced${lastSeen ? ` ${ago(lastSeen)}` : ''}`}</Text>
          </Box>
          {!Input && search && (
            <Box flexDirection="row" gap={1}>
              <Text color={col(C.muted, 'subtle')}>{`Search: "${search}"`}</Text>
              <Button key="search-clear" plain label="✕ clear" onPress={() => void update($, sourceFilter, () => '')} />
            </Box>
          )}
          {Input && (
            <Box flexGrow={1} flexShrink={1} width={compact ? '100%' : undefined}>
              <Input key="search" label="Search" value={search} placeholder="Filter incidents, code, place, owner (e.g. SKU-123, 520, Downtown)"
                submitLabel="Search" onInput={(v: string) => void (async () => { await update($, sourceFilter, () => v); await update($, pageIndex, () => 0) })()}
                onSubmit={(v: string) => void update($, sourceFilter, () => v)} />
            </Box>
          )}
          <Box flexDirection="row" gap={1}>
            <Button key="run" label={working ?? '⚡ Run healthcheck'} variant="primary" onPress={() => { if (!working) void runAll($, cfg, true) }} />
            <Button key="export" label={working === 'Exporting...' ? 'Exporting...' : '⤓ Export'}
              onPress={() => { if (!working) void exportOpen($, cfg, viewStatus(view), view.startsWith('src:') ? view.slice(4) : null, who) }} />
            <Button key="refresh" label="↻" onPress={() => void reload($, cfg)} />
            <Button key="copy-list" label="⧉" onPress={() => void copy($, e.surface, `${shown.length} incidents`, listText(shown))} />
            <Button key="setup" label="⚙" onPress={() => void (async () => { await loadSetup($, cfg); await $.ui.open({ id: SETUP_PANE, title: 'Ops tickets setup' }) })()} />
          </Box>
        </Box>

        {/* integration health strip */}
        <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" gap={1} paddingX={1}>
          <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
            <Text bold color={col(C.ghost, 'subtle')}>INTEGRATIONS:</Text>
            {[...new Set(active.map(t => t.source))].sort().map(s => {
              const hs = health(s)
              const n = open.filter(t => t.source === s).length
              return <Button key={`hs-${s}`} plain onPress={() => void showView($, `src:${s}`)}><Text backgroundColor={col(hs === 'emerald' ? '#0f1d2c' : TINT[hs]![0], 'promptBorder')}
                color={col(hs === 'emerald' ? '#cbd5e1' : TINT[hs]![1], 'text')}>
                <Text color={col(hs === 'rose' ? C.rose : hs === 'amber' ? C.amber : C.emerald, 'text')}>{' ● '}</Text>{`${s}: ${n ? `${n} open${hs === 'rose' ? ' (critical)' : ' (degraded)'}` : 'OK'} `}
              </Text></Button>
            })}
          </Box>
          <Text color={col(C.cyan, 'suggestion')}>{`⏲ Next automated run: ${schedule ?? 'not scheduled'}`}</Text>
        </Box>

        {/* KPI cards */}
        {Svg && all.length > 0 && (
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Box key="k-active-card" flexDirection="column" gap={0}>
              <Svg key="k-active" isInteractive alt={`${open.length} active incidents`} source={kpi2Svg({
              label: 'ACTIVE INCIDENTS', accent: C.rose, chip: `${high.length} P0 HIGH`, chipColor: C.rose, alert: high.length > 0, pulse: high.length > 0,
              value: String(open.length), caption: 'in queue', rightTop: high.length ? `⏱ oldest P0: ${dur(oldestHigh)}` : 'No P0 open',
              rightTopColor: high.length ? C.roseSoft : C.emerald, rightSub: `${regressions} regression(s)`,
              footL: `New in 24h: +${newDay}`, footR: sourcesOpen[0] ? `Most: ${sourcesOpen[0][0]}` : '', footRColor: C.amberSoft, delay: 0 })} />
              <Button key="k-active-view" plain label={`View ${open.length} active incidents ›`} onPress={() => void showView($, 'open')} />
            </Box>
            <Box key="k-mttr-card" flexDirection="column" gap={0}>
              <Svg key="k-mttr" isInteractive alt="mean time to resolve" source={kpi2Svg({
              label: 'MTTR (TRAILING 7D)', accent: C.cyan, chip: `${fixed7.length} resolved`, chipColor: C.emerald,
              value: mttr === null ? '–' : dur(mttr), caption: '', rightTop: `Fixed today: ${fixedToday}`,
              rightSub: `${verifiedToday} verified today`, rightSubColor: C.emerald,
              footL: `Acknowledged: ${live.filter(t => t.status === 'acknowledged').length}`, footR: `Owners: ${new Set(open.map(t => t.owner)).size}`, delay: 70 })} />
              <Button key="k-mttr-view" plain label={`View ${done.length} completed ›`} onPress={() => void showView($, 'done')} />
            </Box>
            <Box key="k-codes-card" flexDirection="column" gap={0}>
              <Svg key="k-codes" isInteractive alt={`${codeOpen.length} ${codeLabel} issues`} source={kpi2Svg(codeOpen.length ? {
              label: `${codeLabel.toUpperCase()} INTEGRITY`, accent: C.emerald, chip: `${codeOpen.length} unresolved`, chipColor: C.cyan,
              value: String(codeOpen.length), caption: `${codeLabel} diffs`, captionColor: C.roseSoft,
              rightTop: `Scope: ${codePlaces} places`, rightSub: codeCountries,
              footL: topProblem ? `Top: ${topProblem[0]}` : '', footR: `${topProblem?.[1] ?? 0} tickets`, footRColor: C.muted, delay: 140 } : {
              label: 'IMPACTED PLACES', accent: C.emerald, chip: 'by location', chipColor: C.cyan,
              value: String(new Set(open.map(t => t.meta?.store).filter(Boolean)).size), caption: 'places',
              rightTop: `${countries.length} countries`, rightSub: countries.slice(0, 3).map(([c]) => c).join(' · '),
              footL: topProblem ? `Top: ${topProblem[0]}` : '', footR: '', delay: 140 })} />
              <Button key="k-codes-view" plain label={codeOpen.length ? `View ${codeOpen.length} ${codeLabel} issues ›` : 'View all places ›'} onPress={() => void showView($, codeOpen.length ? 'code' : 'all')} />
            </Box>
            <Box key="k-watch-card" flexDirection="column" gap={0}>
              <Svg key="k-watch" isInteractive alt={`${fixed.length} fixed and watched`} source={kpi2Svg({
              label: 'REGRESSION WATCH', accent: C.emerald, chip: regressions ? 'Regressing' : 'Active', chipColor: regressions ? C.rose : C.emerald,
              value: `${Math.max(fixed.length - regressions, 0)} / ${fixed.length}`, caption: 'stable', captionColor: C.emerald,
              rightTop: `${regressions} regressions`, rightTopColor: regressions ? C.roseSoft : '#cbd5e1',
              rightSub: regressions ? 'reopened after fix' : 'all fixes holding', rightSubColor: regressions ? C.roseSoft : C.emerald,
              footL: `Verified today: ${verifiedToday}`, footR: 'Audit trail ›', delay: 210 })} />
              <Button key="k-watch-view" plain label={regressions ? `View ${regressions} regressions ›` : `View ${fixed.length} watched fixes ›`} onPress={() => void showView($, regressions ? 'regress' : 'fixed')} />
            </Box>
          </Box>
        )}
        {!isDesktop && (
          <Box flexDirection="row" gap={2}>
            <Text color="error">{`${high.length} P0`}</Text>
            <Text color="warning">{`${open.filter(t => t.severity === 'medium').length} P1`}</Text>
            <Text color="subtle">{`${open.filter(t => t.severity === 'low').length} P2`}</Text>
          </Box>
        )}

        {/* views toolbar */}
        <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" gap={1} paddingX={1}
          backgroundColor={col('#0d1527', '')} borderStyle="single" borderColor={col(C.hair, 'promptBorder')}>
          <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
            <Text bold color={col(C.muted, 'subtle')}>VIEWS:</Text>
            {viewBtn('open', 'Needs triage', open.length, 'open')}
            {viewBtn('high', 'P0 blockers', high.length, 'high', '●')}
            {sourcesOpen.map(([s, n]) => viewBtn(`src-${s}`, s, n, `src:${s}`))}
            {countries.slice(0, 4).map(([c, n]) => viewBtn(`geo-${c}`, `Regional: ${c}`, n, `geo:${c}`))}
            {viewBtn('ack', 'Acknowledged', live.filter(t => t.status === 'acknowledged').length, 'ack')}
            {viewBtn('all', 'All active', active.length, 'all')}
            {view === 'code' && viewBtn('code', `${codeLabel} issues`, codeOpen.length, 'code')}
            {view === 'regress' && viewBtn('regress', 'Regressions', regressions, 'regress')}
          </Box>
          {/* finished tickets are kept out of every view above */}
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text color={col(C.hair, 'subtle')}>│</Text>
            {viewBtn('done', '✓ Completed', done.length, 'done')}
          </Box>
          {!Select && (
            <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
              <Text color={col(C.muted, 'subtle')}>Owner:</Text>
              <Button key="f-owner-any" label="Anyone" variant={who ? 'secondary' : 'primary'} onPress={() => void update($, ownerFilter, () => null)} />
              {[...new Set(live.map(t => t.owner ?? 'Unassigned'))].sort().map(o => (
                <Button key={`f-owner-${o}`} label={o} variant={who === o ? 'primary' : 'secondary'}
                  onPress={() => void update($, ownerFilter, v => (v === o ? null : o))} />
              ))}
            </Box>
          )}
          {Select && (
            <Box flexDirection="row" gap={1} alignItems="center">
              <Text color={col(C.muted, 'subtle')}>Owner</Text>
              <Select key="f-owner" value={who ?? '*'}
                options={[{ value: '*', label: 'Anyone' }, ...[...new Set(live.map(t => t.owner ?? 'Unassigned'))].sort().map(o => ({ value: o, label: o }))]}
                onSelect={(v: string) => void update($, ownerFilter, () => (v === '*' ? null : v))} />
            </Box>
          )}
        </Box>

          </Box>
        )}
        {note && <Text color={col(/fail|could not/i.test(note) ? C.roseSoft : C.emerald, /fail|could not/i.test(note) ? 'error' : 'success')} wrap="wrap">{note}</Text>}
        {exportPath && (
          <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
            <Text color={col(C.emerald, 'success')} wrap="truncate-middle">{exportPath}</Text>
            <Button key="open-export" label="Open file" variant="primary" onPress={() => void openExport($, exportPath, false)} />
            <Button key="show-export" label="Show in folder" onPress={() => void openExport($, exportPath, true)} />
            <Button key="copy-export" label="Copy path" onPress={() => void copy($, e.surface, 'the file path', exportPath)} />
            <Button key="dismiss-export" label="Dismiss" onPress={() => void update($, exported, () => null)} />
          </Box>
        )}

        {isDesktop && current ? (
          <Box key="detail-view" flexDirection="column" gap={1}>
            <Button key="back-list" plain label="‹ Back to the list" onPress={() => void closeInspect($, current.id)} />
            {inspector(current)}
          </Box>
        ) : table}
      </Box>
    )
  })

  // ------------------------------------------------------------ setup wizard
  on('ui.render', { component: 'Pane', requestId: SETUP_PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = e.surface !== 'mobile' && 'Input' in els ? els.Input : null
    const Select = e.surface !== 'mobile' && 'Select' in els ? els.Select : null
    const Markdown = 'Markdown' in els ? els.Markdown : null
    const isDesktop = e.surface === 'desktop'
    const s = await read($, setup)
    const working = await read($, busy)
    const note = await read($, message)
    const hd = (key: string, level: 1 | 2 | 3, text: string) =>
      Markdown && isDesktop ? <Markdown key={key} text={`${'#'.repeat(level)} ${text}`} /> : <Text key={key} bold>{text}</Text>

    if (!s) {
      return (
        <Box flexDirection="column" padding={1} gap={1}>
          {hd('w-title', 1, 'Set up ops tickets')}
          <Button key="w-load" label="Start" variant="primary" onPress={() => void loadSetup($, cfg)} />
        </Box>
      )
    }

    const conf = s.config as {
      owners?: string[]; owner_rules?: Record<string, string>; schedule?: string
      packs?: { name?: string; path?: string }[]
      sources?: Record<string, Record<string, unknown>>
    }
    const src = (id: string) => (conf.sources?.[id] ?? {}) as Record<string, unknown>
    const go = (step: number) => update($, setup, prev => (prev ? { ...prev, step } : prev))
    const steps = ['Sources', 'Connect', 'Packs & owners', 'Finish']
    const enabled = SOURCES.filter(x => s.enabled[x.id])
    const testLine = (id: string) => {
      const t = s.tests[id]
      return t ? (
        <Text key={`w-tr-${id}`} color={t.ok === null ? 'subtle' : t.ok ? 'success' : 'error'} wrap="wrap">
          {`${t.ok === null ? '…' : t.ok ? '✓' : '✗'} ${t.message}`}
        </Text>
      ) : null
    }
    const helpButton = (id: string, label: string) => (
      <Button key={`w-help-${id}`} label="Help me connect"
        onPress={() => void askClaude($, `Help me connect ${label} so the ops-tickets plugin can read it. Check what is `
          + `already connected (connectors in claude.ai settings or /mcp, CLI tools like aws/gh), then walk me through `
          + `the missing steps one at a time. When it works, tell me to press Test in the Ops tickets setup pane.`)} />
    )
    const field = (key: string, label: string, value: string, placeholder: string, onSave: (v: string) => void) => (
      <Box key={key} flexDirection="column">
        <Text dimColor>{`${label}${value ? `: ${value}` : ''}`}</Text>
        {Input && <Input key={`${key}-in`} label={label} placeholder={placeholder} submitLabel="Save" onSubmit={(v: string) => onSave(v.trim())} />}
      </Box>
    )

    const card = (key: string, title: string, body: unknown, ok?: boolean | null) => (
      <Box key={key} flexDirection="column" gap={1} paddingX={2} paddingY={1}
        backgroundColor={isDesktop ? C.panel : undefined}
        borderStyle="single" borderColor={ok === true ? (isDesktop ? C.emerald : 'success') : ok === false ? (isDesktop ? C.amberSoft : 'warning') : (isDesktop ? C.hair : 'promptBorder')}>
        {hd(`${key}-h`, 3, title)}
        {body as never}
      </Box>
    )

    const stepSources = (
      <Box flexDirection="column" gap={1}>
        <Text wrap="wrap">Tick what you want to watch. You can change this later with /ops-setup.</Text>
        {SOURCES.map(x => (
          <Box key={`w-src-${x.id}`} flexDirection="row" gap={1} alignItems="center" paddingX={1}
            borderStyle="round" borderColor={s.enabled[x.id] ? 'success' : 'promptBorder'} hover={{ backgroundColor: 'inactive' }}>
            <Button key={`w-tog-${x.id}`} plain label={`${s.enabled[x.id] ? '☑' : '☐'}  ${x.label}`}
              onPress={() => void toggleSource($, cfg, x.id, !s.enabled[x.id])} />
            <Text dimColor wrap="wrap">{x.how}</Text>
            {x.tool && (
              <Text key={`w-det-${x.id}`} color={s.detected[x.id] ? 'success' : 'subtle'}>
                {s.detected[x.id] ? '● connector found' : '○ not connected'}
              </Text>
            )}
          </Box>
        ))}
      </Box>
    )

    const db = src('database')
    const sl = src('slack')
    const urls = (src('urls').list as { name: string; url: string }[] | undefined) ?? []
    const stepConnect = (
      <Box flexDirection="column" gap={1}>
        {enabled.length === 0 && <Text color="warning">No sources ticked yet: go back to Sources.</Text>}
        {s.enabled.database && card('w-c-db', 'Database', (
          <Box flexDirection="column" gap={1}>
            <Text wrap="wrap" dimColor>
              Login details stay in an env file on your machine; the plugin only stores its path. Use a read-only user.
            </Text>
            {field('w-db-env', 'Env file with the login', String(db.env_file ?? ''), 'C:/path/to/.env  (DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD)',
              v => void setConfig($, cfg, 'sources.database.env_file', v))}
            {Select && (
              <Box flexDirection="row" gap={1} alignItems="center">
                <Text dimColor>Driver</Text>
                <Select key="w-db-driver" value={String(db.driver ?? 'postgres')}
                  options={[{ value: 'postgres', label: 'PostgreSQL' }, { value: 'mysql', label: 'MySQL' }]}
                  onSelect={(v: string) => void setConfig($, cfg, 'sources.database.driver', v)} />
              </Box>
            )}
            {field('w-db-tunnel', 'Tunnel command (optional, shown as a hint when the test fails)', String(db.tunnel ?? ''),
              'cloudflared access tcp --hostname db.example.com --url localhost:5432', v => void setConfig($, cfg, 'sources.database.tunnel', v))}
            <Box flexDirection="row" gap={1}>
              <Button key="w-test-db" label="Test connection" variant="primary" onPress={() => void testSource($, cfg, 'database')} />
              {helpButton('database', 'my database (read-only, possibly through a Cloudflare or SSH tunnel)')}
            </Box>
            {testLine('database')}
          </Box>
        ), s.tests.database?.ok)}
        {s.enabled.slack && card('w-c-slack', 'Slack alert channel', (
          <Box flexDirection="column" gap={1}>
            <Text dimColor>{sl.channel_id ? `Channel: ${String(sl.channel_name ?? '')} (${String(sl.channel_id)})` : 'No channel yet.'}</Text>
            {Input && <Input key="w-slack-ch" label="Channel name" placeholder="#alerts" submitLabel="Find"
              onSubmit={(v: string) => void findSlackChannel($, cfg, v)} />}
            <Box flexDirection="row" gap={1}>
              <Button key="w-test-slack" label="Test" variant="primary" onPress={() => void testSource($, cfg, 'slack')} />
              {!s.detected.slack && helpButton('slack', 'Slack')}
            </Box>
            {testLine('slack')}
          </Box>
        ), s.tests.slack?.ok)}
        {(['sentry', 'aws', 'github'] as const).filter(id => s.enabled[id]).map(id => {
          const meta = SOURCES.find(x => x.id === id)!
          const fieldsFor: Record<string, [string, string, string]> = {
            sentry: ['organization', 'Sentry organization slug', 'my-org'],
            aws: ['region', 'AWS region', 'eu-central-1'],
            github: ['repos', 'Repositories (comma separated)', 'owner/repo, owner/other'],
          }
          const [k, label, ph] = fieldsFor[id]!
          const value = src(id)[k]
          return card(`w-c-${id}`, meta.label, (
            <Box flexDirection="column" gap={1}>
              <Text dimColor wrap="wrap">{`${meta.how} Claude collects it on each run, through whatever connector you have.`}</Text>
              {field(`w-${id}-${k}`, label, Array.isArray(value) ? value.join(', ') : String(value ?? ''), ph,
                v => void setConfig($, cfg, `sources.${id}.${k}`, id === 'github' ? v.split(',').map(x => x.trim()).filter(Boolean) : v))}
              <Box flexDirection="row" gap={1}>
                <Button key={`w-test-${id}`} label="Test" variant="primary" onPress={() => void testSource($, cfg, id)} />
                {helpButton(id, meta.label)}
              </Box>
              {testLine(id)}
            </Box>
          ), s.tests[id]?.ok)
        })}
        {s.enabled.urls && card('w-c-urls', 'Websites & APIs', (
          <Box flexDirection="column" gap={0}>
            {urls.map((u, i) => (
              <Box key={`w-url-${i}`} flexDirection="row" gap={1} alignItems="center">
                <Text>{`${u.name}  ·  ${u.url}`}</Text>
                <Button key={`w-url-rm-${i}`} plain label="✕"
                  onPress={() => void setConfig($, cfg, 'sources.urls.list', urls.filter((_, j) => j !== i))} />
              </Box>
            ))}
            {Input && <Input key="w-url-add" label="Add a URL" placeholder="Name | https://example.com/health" submitLabel="Add"
              onSubmit={(v: string) => {
                const [name, url] = v.includes('|') ? v.split('|').map(x => x.trim()) : [v.trim(), v.trim()]
                if (/^https?:\/\//.test(url ?? '')) void setConfig($, cfg, 'sources.urls.list', [...urls, { name, url, max_ms: 5000 }])
              }} />}
            <Box flexDirection="row" gap={1}>
              <Button key="w-test-urls" label="Test" variant="primary" onPress={() => void testSource($, cfg, 'urls')} />
            </Box>
            {testLine('urls')}
          </Box>
        ), s.tests.urls?.ok)}
      </Box>
    )

    const packSpecs = conf.packs ?? []
    const ownerList = conf.owners ?? []
    const rules = conf.owner_rules ?? {}
    const stepPacks = (
      <Box flexDirection="column" gap={1}>
        {card('w-packs', 'Check packs', (
          <Box flexDirection="column" gap={0}>
            <Text dimColor wrap="wrap">Packs are sets of checks. Built-in: SQL rules and URLs. Add a pack file for your own system.</Text>
            {s.packs.map((p, i) => (
              <Box key={`w-pack-${i}`} flexDirection="row" gap={1} alignItems="center">
                <Text color={p.ready ? 'success' : 'subtle'}>{p.ready ? '●' : '○'}</Text>
                <Text bold>{p.name}</Text>
                <Text dimColor wrap="wrap">{`${p.description}${p.ready ? '' : `  (needs: ${p.needs.join(', ')})`}`}</Text>
                {packSpecs[i]?.path && <Button key={`w-pack-rm-${i}`} plain label="✕"
                  onPress={() => void setConfig($, cfg, 'packs', packSpecs.filter((_, j) => j !== i))} />}
              </Box>
            ))}
            {Input && <Input key="w-pack-add" label="Add a pack file" placeholder="C:/path/to/my_pack.py" submitLabel="Add"
              onSubmit={(v: string) => { if (v.trim()) void setConfig($, cfg, 'packs', [...packSpecs, { path: v.trim() }]) }} />}
          </Box>
        ))}
        {card('w-owners', 'Owners', (
          <Box flexDirection="column" gap={1}>
            {field('w-owner-list', 'People or teams (comma separated)', ownerList.join(', '), 'Backend, Mobile app, Ops, Me',
              v => void setConfig($, cfg, 'owners', v.split(',').map(x => x.trim()).filter(Boolean)))}
            <Text dimColor>Who gets each kind of ticket by default:</Text>
            {Object.keys(rules).map(k => (
              <Box key={`w-rule-${k}`} flexDirection="row" gap={1} alignItems="center">
                <Text>{k === 'default' ? 'Everything else' : k}</Text>
                {Select ? (
                  <Select key={`w-rule-sel-${k}`} value={rules[k] ?? ''}
                    options={[...new Set([...ownerList, rules[k] ?? ''])].filter(Boolean).map(o => ({ value: o, label: o }))}
                    onSelect={(v: string) => void setConfig($, cfg, `owner_rules.${k}`, v)} />
                ) : <Text bold>{rules[k] ?? ''}</Text>}
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    )

    const stepFinish = (
      <Box flexDirection="column" gap={1}>
        {card('w-summary', 'Ready', (
          <Box flexDirection="column" gap={0}>
            {SOURCES.map(x => (
              <Text key={`w-sum-${x.id}`} color={s.enabled[x.id] ? (s.tests[x.id]?.ok === false ? 'warning' : 'success') : 'subtle'}>
                {`${s.enabled[x.id] ? (s.tests[x.id]?.ok === false ? '!' : '✓') : '–'}  ${x.label}${s.enabled[x.id] && s.tests[x.id]?.ok === false ? '  (test failed)' : ''}`}
              </Text>
            ))}
          </Box>
        ))}
        {card('w-schedule', 'Daily run', (
          <Box flexDirection="column" gap={1}>
            {field('w-time', 'Time (24h, your local time)', conf.schedule ?? '08:00', '08:00',
              v => void setConfig($, cfg, 'schedule', v))}
            <Button key="w-routine" label="Create the daily routine"
              onPress={() => void askClaude($, `Create a recurring scheduled task called "Ops tickets daily" that runs every day at `
                + `${conf.schedule ?? '08:00'} my local time, in this folder, whose prompt is exactly: /ops-run`
                + ` . Then tell me it is set and how to change it.`)} />
          </Box>
        ))}
        <Box flexDirection="row" gap={1}>
          <Button key="w-first-run" label={working ?? '▶ Run the first check'} variant="primary"
            onPress={() => {
              if (working) return
              void (async () => {
                await runAll($, cfg, true)
                await loadOwners($, cfg)
                await $.ui.open({ id: PANE, title: 'Ops tickets' })
              })()
            }} />
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1} padding={1} backgroundColor={isDesktop ? C.canvas : undefined}>
        {hd('w-title', 1, 'Set up ops tickets')}
        {!Input && <Text color="warning" wrap="wrap">Setup needs text fields: run /ops-setup on desktop or in the terminal. Tickets work everywhere once it is set up.</Text>}
        {s.error && <Text color="error" wrap="wrap">{s.error}</Text>}
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {steps.map((name, i) => (
            <Button key={`w-step-${i}`} label={`${i + 1}. ${name}`} variant={s.step === i ? 'primary' : 'secondary'}
              onPress={() => void go(i)} />
          ))}
        </Box>
        {note && <Text color={/fail|could not|not found|no channel/i.test(note) ? 'warning' : 'success'} wrap="wrap">{note}</Text>}
        {s.step === 0 ? stepSources : s.step === 1 ? stepConnect : s.step === 2 ? stepPacks : stepFinish}
        <Box flexDirection="row" gap={1}>
          {s.step > 0 && <Button key="w-back" label="← Back" onPress={() => void go(s.step - 1)} />}
          {s.step < steps.length - 1 && <Button key="w-next" label="Next →" variant="primary" onPress={() => void go(s.step + 1)} />}
          <Button key="w-refresh" label="↻ Re-detect connectors" onPress={() => void loadSetup($, cfg)} />
        </Box>
      </Box>
    )
  })
}

// Every web address a ticket mentions: its main link first, then any in its text.
function urlsOf(t: Ticket): string[] {
  const text = `${t.meta?.url ?? ''}
${t.detail ?? ''}
${t.action ?? ''}`
  const found = text.match(/https?:\/\/[^\s)>\]"'`]+/g) ?? []
  return [...new Set(found.map(u => u.replace(/[.,;:]+$/, '')))].slice(0, 12)
}

function linkLabel(url: string): string {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '')
    const path = u.pathname.replace(/\/$/, '')
    const tail = path.length > 42 ? `…${path.slice(-40)}` : path
    return `${host}${tail}`
  } catch {
    return url.slice(0, 60)
  }
}

function shortTitle(t: Ticket): string {
  // the country / store is already the group heading
  const i = t.title.indexOf(': ')
  return t.meta?.store && i > 0 ? t.title.slice(i + 2) : t.title
}
