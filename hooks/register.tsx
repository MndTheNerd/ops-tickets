import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { Ticket } from '../types'
import { C, SEV, dotSvg, kpiSvg, progressSvg, shareBarSvg, trendSvg } from './visuals'

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
const SETUP_PANE = 'ops-setup'

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

async function loadOwners($: EngineInterface, cfg: Cfg) {
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

export const register: Register = (on, options) => {
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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : null
    const all = await read($, tickets)
    const status = await read($, statusFilter)
    const src = await read($, sourceFilter)
    const who = await read($, ownerFilter)
    const ownerList = await read($, owners)
    const Select = 'Select' in els ? els.Select : null
    const Svg = e.surface === 'desktop' && 'Svg' in els ? els.Svg : null
    const sel = await read($, selected)
    const working = await read($, busy)
    const note = await read($, message)
    const confirmId = await read($, confirming)
    const checkResult = await read($, verified)
    const exportPath = await read($, exported)

    const live = all.filter(t => t.status !== 'resolved')
    const byStatus = all.filter(t => (status === 'all' ? t.status !== 'resolved' : t.status === status))
    const shown = byStatus.filter(t => (!src || t.source === src) && (!who || t.owner === who))
    const open = shown.filter(t => t.status === 'open')
    const sources = [...new Set(live.map(t => t.source))].sort()
    const ownersSeen = [...new Set(live.map(t => t.owner ?? 'Unassigned'))].sort()
    const n = (s: string) => all.filter(t => t.status === s).length
    const count = (s: string) => open.filter(t => t.severity === s).length

    // country -> store -> tickets, so a person fixing one branch sees its whole list
    const groups = new Map<string, Map<string, Ticket[]>>()
    for (const t of shown) {
      const country = t.meta?.country ?? 'System'
      const store = t.meta?.store ?? 'General'
      const byStore = groups.get(country) ?? new Map<string, Ticket[]>()
      byStore.set(store, [...(byStore.get(store) ?? []), t])
      groups.set(country, byStore)
    }

    const Markdown = 'Markdown' in els ? els.Markdown : null
    const Code = 'Code' in els ? els.Code : null
    const isDesktop = e.surface === 'desktop'
    // The design is dark-only on desktop; the terminal keeps the theme's own colours.
    const k = isDesktop
      ? { bg: C.canvas, panel: C.panel, panel2: C.panel2, raised: C.raised, hair: C.hair, border: C.border, text: C.text, strong: C.strong,
          muted: C.muted, ghost: C.ghost, cyan: C.cyan, cyanSoft: C.cyanSoft, emerald: C.emerald, amber: C.amberSoft, rose: C.roseSoft }
      : null
    const col = (hex: string | undefined, theme: string) => (k ? hex : theme || undefined) as never
    const mdText = (s: string) => s.replace(/[\\`*_[\]#<>|]/g, m => `\\${m}`)
    const heading = (key: string, level: 1 | 2 | 3, text: string) =>
      Markdown && isDesktop ? <Markdown key={key} text={`${'#'.repeat(level)} ${mdText(text)}`} /> : <Text key={key} bold>{text}</Text>
    // tinted chip: 10% fill look (dark tint) with the signal colour as text
    const tone = (label: string) =>
      /conflict|refused|failed|crash|blocked|no status|down|unreachable|regression/i.test(label) ? 'rose'
        : /cancel|mismatch|setup|slow|spik|missing|inventory|catalogue/i.test(label) ? 'amber'
          : /fixed|verified|ok\b/i.test(label) ? 'emerald' : 'cyan'
    const TINT: Record<string, [string, string]> = {
      rose: ['#3b1520', C.roseSoft], amber: ['#3a2a10', C.amberSoft], emerald: ['#0f2e24', C.emerald], cyan: ['#0e2a3b', C.cyanSoft],
      ghost: ['#1e293b', C.muted], solidRose: ['#93000a', '#ffdad6'], solidCyan: [C.cyan, '#001e2c'],
    }
    const chip = (key: string, text: string, t: string) => {
      const [bg, fg] = TINT[t] ?? TINT.ghost!
      return <Text key={key} backgroundColor={col(bg, 'promptBorder')} color={col(fg, 'text')}>{` ${text} `}</Text>
    }
    const ago = (iso: string) => {
      const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000))
      return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m ago` : `${Math.floor(m / 1440)}d ago`
    }
    const doneCount = (t: Ticket) => t.steps.filter((_, i) => t.steps_done.includes(i)).length
    const tally = (key: (t: Ticket) => string) =>
      [...live.filter(t => t.status === 'open').reduce((m, t) => m.set(key(t), (m.get(key(t)) ?? 0) + 1), new Map<string, number>())]
        .sort((a, b) => b[1] - a[1])
    const allOpen = all.filter(t => t.status === 'open')
    const allHigh = allOpen.filter(t => t.severity === 'high')
    const dayAgo = new Date(Date.now() - 86400000).toISOString()
    const newToday = all.filter(t => t.first_seen >= dayAgo.slice(0, 19)).length
    const fixed = all.filter(t => t.status === 'fixed')
    const resolveMins = fixed.map(t => (Date.parse(t.fixed_at ?? '') - Date.parse(t.first_seen)) / 60000).filter(x => x > 0)
    const avgResolve = resolveMins.length ? resolveMins.reduce((a, b) => a + b, 0) / resolveMins.length : null
    const fmtDur = (m: number | null) => (m === null ? '-' : m < 60 ? `${Math.round(m)}m` : m < 1440 ? `${Math.floor(m / 60)}h ${Math.round(m % 60)}m` : `${(m / 1440).toFixed(1)}d`)
    const verifiedToday = fixed.filter(t => t.events.some(ev => ev.kind === 'verified' && ev.at >= dayAgo.slice(0, 19))).length
    const places = new Set(allHigh.map(t => t.meta?.store).filter(Boolean)).size
    const lastSeen = all.reduce((m, t) => (t.last_seen > m ? t.last_seen : m), '')
    const wide = isDesktop && (e.viewport?.columns ?? 160) >= 120
    const current = shown.find(t => t.id === sel) ?? null

    // The selected ticket. Beside the list on a wide pane, under its row otherwise.
    const inspector = (t: Ticket) => (
      <Box key={`detail-${t.id}`} flexDirection="column" gap={1} paddingX={2} paddingY={1}
        backgroundColor={col(k?.panel, '')} borderStyle="single" borderColor={col(k?.border, SEVERITY_COLOR[t.severity])}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="flex-start">
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {chip(`ds-${t.id}`, t.status.toUpperCase(), t.status === 'open' ? 'rose' : t.status === 'fixed' ? 'emerald' : 'cyan')}
            {chip(`dv-${t.id}`, t.severity.toUpperCase(), t.severity === 'high' ? 'solidRose' : t.severity === 'medium' ? 'amber' : 'ghost')}
            {t.meta?.missing_in && chip(`dm-${t.id}`, t.meta.missing_in, tone(t.meta.missing_in))}
            {t.reopen_count > 0 && chip(`dr-${t.id}`, `REGRESSION x${t.reopen_count}`, 'rose')}
          </Box>
          <Button key="close-detail" plain label="✕" onPress={() => void update($, selected, () => null)} />
        </Box>
        {heading(`dt-${t.id}`, 2, `#${t.id} ${shortTitle(t)}`)}
        <Text wrap="wrap">
          {t.meta?.country && <Text color={col(k?.muted, 'subtle')}>Where: </Text>}
          {t.meta?.country && <Text bold color={col(k?.strong, 'text')}>{[t.meta.country, t.meta.store, t.meta.city].filter(Boolean).join(' / ')}</Text>}
          <Text color={col(k?.muted, 'subtle')}>{t.meta?.country ? '   Source: ' : 'Source: '}</Text>
          <Text color={col(k?.cyanSoft, 'suggestion')}>{t.source}</Text>
        </Text>

        <Box flexDirection="column" paddingX={1} backgroundColor={col(k?.panel2, '')} borderStyle="single" borderColor={col(k?.hair, 'promptBorder')}>
          <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
            <Text color={col(k?.muted, 'subtle')}>Assigned owner:</Text>
            {Select ? (
              <Select key={`owner-${t.id}`} value={t.owner ?? ''}
                options={[...new Set([...ownerList, ...(t.owner ? [t.owner] : [])])].map(o => ({ value: o, label: o }))}
                onSelect={(value: string) => void act($, cfg, 'Saving...', ['owner', String(t.id), value])} />
            ) : <Text bold>{t.owner ?? 'Unassigned'}</Text>}
            <Text color={col(k?.muted, 'subtle')}>{'   Seen count: '}</Text>
            <Text bold color={col(k?.cyanSoft, 'suggestion')}>{`${t.occurrences}x`}</Text>
          </Box>
          <Text color={col(k?.muted, 'subtle')}>
            {'First seen  '}<Text color={col(k?.text, 'text')}>{t.first_seen.replace('T', ' ').replace('Z', ' UTC')}</Text>
            {'    Last seen  '}<Text color={col(k?.text, 'text')}>{`${t.last_seen.replace('T', ' ').replace('Z', ' UTC')} (${ago(t.last_seen)})`}</Text>
          </Text>
        </Box>

        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {t.meta?.code && (
            <Button key={`copy-code-${t.id}`} label={`# Copy ${t.meta.code_label ?? 'code'} (${t.meta.code})`}
              onPress={() => void copy($, e.surface, `${t.meta?.code_label ?? 'code'} ${t.meta?.code}`, t.meta?.code ?? '')} />
          )}
          {t.meta?.url && (
            <Button key={`open-link-${t.id}`}
              label={t.meta.url.includes('sentry') ? 'Open in Sentry ↗' : t.meta.url.includes('github') ? 'Open in GitHub ↗' : t.meta.url.includes('aws') ? 'Open in AWS ↗' : 'Open link ↗'}
              onPress={() => void openLink($, t.meta?.url ?? '')} />
          )}
          <Button key={`copy-ticket-${t.id}`} label="Copy ticket" onPress={() => void copy($, e.surface, `ticket #${t.id}`, ticketText(t))} />
          <Button key={`copy-steps-${t.id}`} label="Copy steps"
            onPress={() => void copy($, e.surface, 'the solution steps', t.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'))} />
        </Box>

        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Text bold color={col(k?.muted, 'subtle')}>DIAGNOSTIC EVIDENCE</Text>
            <Text color={col(k?.cyanSoft, 'suggestion')}>{t.check_name}</Text>
          </Box>
          {Code && isDesktop
            ? <Code key={`dd-${t.id}`} source={t.detail ?? ''} language="log" wrap="wrap" />
            : <Text wrap="wrap">{t.detail ?? ''}</Text>}
          {t.action && <Text wrap="wrap" color={col(k?.text, 'text')}>{t.action}</Text>}
        </Box>

        <Box flexDirection="column" gap={0}>
          <Box flexDirection="row" justifyContent="space-between">
            {heading(`dsol-${t.id}`, 3, 'Solution workflow')}
            <Text color={col(k?.cyanSoft, 'suggestion')}>{`${doneCount(t)}/${t.steps.length} done`}</Text>
          </Box>
          {Svg && (
            <Svg key={`progress-${t.id}-${t.steps_done.length}`} isInteractive
              source={progressSvg(doneCount(t), t.steps.length, wide ? 460 : 560)} alt={`${doneCount(t)} of ${t.steps.length} steps done`} />
          )}
          {t.steps.map((step, i) => {
            const isDone = t.steps_done.includes(i)
            return (
              <Box key={`step-row-${t.id}-${i}`} flexDirection="row" gap={1} paddingX={1} marginTop={1}
                backgroundColor={col(k?.panel2, '')} hover={{ backgroundColor: col(k?.raised, 'inactive') }}>
                <Button key={`step-${t.id}-${i}`} plain label={isDone ? '☑' : '☐'}
                  onPress={() => void act($, cfg, 'Saving...', ['step', String(t.id), String(i)])} />
                <Text wrap="wrap" color={col(isDone ? k?.ghost : k?.strong, isDone ? 'subtle' : 'text')} strikethrough={isDone}>
                  {`${i + 1}. ${step}`}
                </Text>
              </Box>
            )
          })}
        </Box>

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
            {heading(`dc-${t.id}`, 3, `Confirm #${t.id} is fixed?`)}
            {!(checkResult?.id === t.id && checkResult.ok) && (
              <Text color={col(C.amberSoft, 'warning')} wrap="wrap">
                Verify has not passed yet. If it is still broken, the next run will reopen it as a regression.
              </Text>
            )}
            {Input ? (
              <Input key={`fix-${t.id}`} label="What did you do?" placeholder="e.g. fixed the config and re-ran the job"
                submitLabel="Yes, mark fixed" autoFocus onSubmit={(value: string) => void confirmFix($, cfg, t.id, value)} />
            ) : (
              <Button key={`fix-${t.id}`} label="Yes, mark fixed" variant="primary" onPress={() => void confirmFix($, cfg, t.id, '')} />
            )}
            <Button key={`cancel-fix-${t.id}`} label="Cancel" onPress={() => void update($, confirming, () => null)} />
          </Box>
        ) : (
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key={`ask-fix-${t.id}`} label="✓ Mark fixed" variant="primary" onPress={() => void update($, confirming, () => t.id)} />
            <Button key={`verify-${t.id}`} label={working === 'Verifying...' ? 'Verifying...' : '↻ Verify now'}
              onPress={() => { if (!working) void verify($, cfg, t.id) }} />
            {t.status === 'open' ? (
              <Button key={`ack-${t.id}`} label="Acknowledge" onPress={() => void act($, cfg, 'Saving...', ['ack', String(t.id)])} />
            ) : (
              <Button key={`unack-${t.id}`} label="Back to open" onPress={() => void act($, cfg, 'Saving...', ['unack', String(t.id)])} />
            )}
          </Box>
        )}

        <Box flexDirection="column" gap={0}>
          <Text bold color={col(k?.muted, 'subtle')}>ACTIVITY TRAIL</Text>
          {t.events.slice(-8).map((ev, i) => (
            <Box key={`ev-${i}`} flexDirection="row" justifyContent="space-between">
              <Text wrap="truncate-end">
                <Text color={col(/fix|verified/.test(ev.kind) ? C.emerald : /reopen|spike|fail/.test(ev.kind) ? C.roseSoft : ev.kind === 'opened' ? C.amberSoft : C.cyan, 'suggestion')}>{'● '}</Text>
                <Text color={col(k?.text, 'text')}>{`${ev.kind}${ev.note ? `: ${ev.note}` : ''}`}</Text>
              </Text>
              <Text color={col(k?.ghost, 'subtle')}>{ev.at.slice(5, 16).replace('T', ' ')}</Text>
            </Box>
          ))}
        </Box>
      </Box>
    )

    const row = (t: Ticket) => {
      const isSel = t.id === sel
      return (
        <Box key={`t-${t.id}`} flexDirection="row" gap={1} paddingX={1} alignItems="center"
          backgroundColor={col(isSel ? k?.raised : undefined, isSel ? 'promptBorder' : '')}
          hover={{ backgroundColor: col(k?.raised, 'inactive') }}>
          <Text color={col(isSel ? C.cyan : k?.bg, isSel ? 'suggestion' : 'text')}>{isSel ? '▌' : ' '}</Text>
          {Svg ? (
            <Svg key={`dot-${t.id}`} isInteractive width={14} height={14}
              source={dotSvg(SEV[t.severity], t.status === 'open' && t.severity === 'high')} alt={t.severity} />
          ) : <Text color={SEVERITY_COLOR[t.severity]}>●</Text>}
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Box flexDirection="row" gap={1}>
              <Text color={col(isSel ? '#001e2c' : C.cyanSoft, 'suggestion')} backgroundColor={col(isSel ? C.cyan : undefined, '')}>{`#${t.id}`}</Text>
              <Button key={`pick-${t.id}`} plain label={shortTitle(t)}
                onPress={() => void update($, selected, v => (v === t.id ? null : t.id))} />
            </Box>
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {t.meta?.missing_in && chip(`pm-${t.id}`, t.meta.missing_in, tone(t.meta.missing_in))}
              {t.status !== 'open' && chip(`ps-${t.id}`, t.status, t.status === 'fixed' ? 'emerald' : 'cyan')}
              {t.reopen_count > 0 && chip(`pr-${t.id}`, `regression x${t.reopen_count}`, 'rose')}
              {t.owner && <Text color={col(k?.muted, 'subtle')}>{`· ${t.owner}`}</Text>}
              {t.steps_done.length > 0 && <Text color={col(k?.cyanSoft, 'subtle')}>{`· ${doneCount(t)}/${t.steps.length}`}</Text>}
            </Box>
          </Box>
          <Box flexDirection="column" alignItems="flex-end">
            <Text color={col(t.occurrences >= 10 ? C.amberSoft : k?.text, 'text')}>{`Seen ${t.occurrences}x`}</Text>
            <Text color={col(k?.ghost, 'subtle')}>{ago(t.last_seen)}</Text>
          </Box>
        </Box>
      )
    }

    const list = (
      <Box flexDirection="column" gap={0} flexGrow={1} flexShrink={1}>
        {shown.length === 0 && <Text color={col(C.emerald, 'success')}>No tickets match these filters.</Text>}
        {[...groups.entries()].map(([country, byStore]) => {
          const total = [...byStore.values()].reduce((a, l) => a + l.length, 0)
          const highs = [...byStore.values()].flat().filter(t => t.severity === 'high' && t.status === 'open').length
          return (
            <Box key={`c-${country}`} flexDirection="column" marginBottom={1} borderStyle="single" borderColor={col(k?.hair, 'promptBorder')}>
              <Box flexDirection="row" justifyContent="space-between" paddingX={1} backgroundColor={col(k?.panel2, '')}>
                <Text bold color={col(k?.strong, 'claude')}>{`▾ ${country.toUpperCase()} · ${total}`}</Text>
                {highs > 0 && <Text color={col(C.roseSoft, 'error')}>{`${highs} high`}</Text>}
              </Box>
              {[...byStore.entries()].map(([store, items]) => (
                <Box key={`s-${country}-${store}`} flexDirection="column">
                  <Box paddingX={1} marginTop={1}>
                    <Text color={col(k?.muted, 'subtle')}>{`${store.toUpperCase()}${items[0]?.meta?.city ? ` · ${items[0].meta.city.toUpperCase()}` : ''}`}</Text>
                  </Box>
                  {items.flatMap(t => [row(t), ...(!wide && t.id === sel ? [inspector(t)] : [])])}
                </Box>
              ))}
            </Box>
          )
        })}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1} padding={1} backgroundColor={col(k?.bg, '')}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text bold color={col(C.roseSoft, 'error')}>⚡</Text>
            {heading('title', 1, 'Ops Incidents')}
            {chip('live', 'LIVE FEED', 'ghost')}
            <Text color={col(C.emerald, 'success')}>{`● Synced${lastSeen ? ` (${ago(lastSeen)})` : ''}`}</Text>
          </Box>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="run" label={working ?? '▶ Run checks'} variant="primary" onPress={() => { if (!working) void runAll($, cfg, true) }} />
            <Button key="refresh" label="↻ Refresh" onPress={() => void reload($, cfg)} />
            <Button key="export" label={working === 'Exporting...' ? 'Exporting...' : '⤓ Export'}
              onPress={() => { if (!working) void exportOpen($, cfg, status, src, who) }} />
            <Button key="copy-list" label="⧉ Copy list" onPress={() => void copy($, e.surface, `${shown.length} tickets`, listText(shown))} />
            <Button key="setup" label="⚙ Setup" onPress={() => void (async () => { await loadSetup($, cfg); await $.ui.open({ id: SETUP_PANE, title: 'Ops tickets setup' }) })()} />
          </Box>
        </Box>

        {!isDesktop && (
          <Box flexDirection="row" gap={2}>
            <Text color="error">{`${count('high')} high`}</Text>
            <Text color="warning">{`${count('medium')} medium`}</Text>
            <Text color="subtle">{`${count('low')} low`}</Text>
          </Box>
        )}

        {Svg && all.length > 0 && (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Svg key="card-open" isInteractive alt={`${allOpen.length} open tickets`} source={kpiSvg({
                label: 'OPEN TICKETS', value: allOpen.length, accent: C.rose, chip: `${allHigh.length} high priority`,
                foot: 'New in 24h', footValue: `+${newToday}`, delay: 0 })} />
              <Svg key="card-high" isInteractive alt={`${allHigh.length} high priority`} source={kpiSvg({
                label: 'HIGH PRIORITY', value: allHigh.length, accent: C.rose, pulse: allHigh.length > 0,
                foot: 'Impacted places', footValue: `${places}`, delay: 60 })} />
              <Svg key="card-ack" isInteractive alt={`${n('acknowledged')} acknowledged`} source={kpiSvg({
                label: 'ACKNOWLEDGED', value: n('acknowledged'), accent: C.cyan, chip: 'known / owned',
                foot: 'Avg time to fix', footValue: fmtDur(avgResolve), delay: 120 })} />
              <Svg key="card-fixed" isInteractive alt={`${n('fixed')} fixed and watched`} source={kpiSvg({
                label: 'WATCHING FOR REGRESSION', value: n('fixed'), accent: C.emerald,
                chip: n('fixed') ? `${Math.round((1 - all.filter(t => t.reopen_count > 0 && t.status === 'open').length / Math.max(n('fixed'), 1)) * 100)}% stable` : undefined,
                foot: 'Verified today', footValue: `${verifiedToday} / ${n('fixed')}`, delay: 180 })} />
            </Box>
            <Box flexDirection="row" gap={2} flexWrap="wrap" paddingX={1} paddingY={1} backgroundColor={col(k?.panel, '')}
              borderStyle="single" borderColor={col(k?.hair, 'promptBorder')}>
              <Svg key="bar-source" isInteractive alt="open tickets by source" source={shareBarSvg('OPEN BY SOURCE', tally(t => t.source), 300)} />
              <Svg key="bar-owner" isInteractive alt="open tickets by owner" source={shareBarSvg('OPEN BY OWNER', tally(t => t.owner ?? 'Unassigned'), 300)} />
              <Svg key="trend" isInteractive alt="new tickets per day, last 14 days" source={trendSvg(all, 300)} />
            </Box>
          </Box>
        )}

        <Box flexDirection="column" gap={0} paddingX={1} backgroundColor={col(k?.panel, '')} borderStyle="single" borderColor={col(k?.hair, 'promptBorder')}>
          <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
            <Text color={col(k?.ghost, 'subtle')}>STATUS:</Text>
            {(['open', 'acknowledged', 'fixed', 'all'] as const).map(s => (
              <Button key={`f-status-${s}`} variant={status === s ? 'primary' : 'secondary'}
                label={s === 'all' ? `All ${all.filter(t => t.status !== 'resolved').length}` : `${s[0]!.toUpperCase()}${s.slice(1)} ${n(s)}`}
                onPress={() => void update($, statusFilter, () => s)} />
            ))}
          </Box>
          <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
            <Text color={col(k?.ghost, 'subtle')}>SOURCE:</Text>
            <Button key="f-src-all" label="Any source" variant={src ? 'secondary' : 'primary'} onPress={() => void update($, sourceFilter, () => null)} />
            {sources.map(s => (
              <Button key={`f-src-${s}`} label={`${s} (${live.filter(t => t.source === s && t.status === 'open').length})`}
                variant={src === s ? 'primary' : 'secondary'} onPress={() => void update($, sourceFilter, v => (v === s ? null : s))} />
            ))}
          </Box>
          <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
            <Text color={col(k?.ghost, 'subtle')}>OWNER: </Text>
            <Button key="f-own-all" label="Anyone" variant={who ? 'secondary' : 'primary'} onPress={() => void update($, ownerFilter, () => null)} />
            {ownersSeen.map(o => (
              <Button key={`f-own-${o}`} label={o} variant={who === o ? 'primary' : 'secondary'}
                onPress={() => void update($, ownerFilter, v => (v === o ? null : o))} />
            ))}
          </Box>
        </Box>

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

        {wide ? (
          <Box flexDirection="row" gap={1} alignItems="flex-start">
            <Box flexDirection="column" width={current ? '56%' : '100%'}>{list}</Box>
            {current && <Box flexDirection="column" width="44%">{inspector(current)}</Box>}
          </Box>
        ) : list}
      </Box>
    )
  })

  // ------------------------------------------------------------ setup wizard
  on('ui.render', { component: 'Pane', requestId: SETUP_PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : null
    const Select = 'Select' in els ? els.Select : null
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

function shortTitle(t: Ticket): string {
  // the country / store is already the group heading
  const i = t.title.indexOf(': ')
  return t.meta?.store && i > 0 ? t.title.slice(i + 2) : t.title
}
