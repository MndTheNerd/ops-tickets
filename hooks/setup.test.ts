import { expect, test } from 'claude-code/testing'

const CONFIG = {
  owners: ['Backend', 'Ops'],
  owner_rules: { 'Sentry backend': 'Backend', default: 'Ops' },
  schedule: '08:00',
  packs: [{ name: 'sql_rules' }, { name: 'urls' }],
  sources: {
    database: { enabled: false, driver: 'postgres', env_file: '' },
    slack: { enabled: true, channel_id: 'C123', channel_name: '#alerts', lookback_hours: 26 },
    sentry: { enabled: false }, aws: { enabled: false }, github: { enabled: false },
    urls: { enabled: false, list: [] },
  },
}

const STATUS = {
  configured: false,
  sources: { database: { enabled: false }, slack: { enabled: true }, sentry: { enabled: false }, aws: { enabled: false }, github: { enabled: false }, urls: { enabled: false } },
  packs: [{ name: 'sql_rules', description: 'SQL', needs: ['database'], ready: false }],
}

function engine(on: any, calls: { argv: string[]; stdin?: string }[]) {
  on('process.run', async (_$: unknown, e: { argv: string[]; init?: { stdin?: string } }) => {
    calls.push({ argv: [...e.argv], stdin: e.init?.stdin })
    const a = e.argv.slice(2)
    const reply = (obj: unknown) => ({ value: { exitCode: 0, stdout: typeof obj === 'string' ? obj : JSON.stringify(obj), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (a[0] === 'status') return reply(STATUS) as never
    if (a[0] === 'config-get') return reply(a[1] === 'sources.slack' ? CONFIG.sources.slack : a[1] === 'sources' ? CONFIG.sources : CONFIG) as never
    if (a[0] === 'test-source') return reply({ ok: true, message: 'Connected (postgres).' }) as never
    if (a[0] === 'json') return reply([]) as never
    if (a[0] === 'notifications' || a[0] === 'owners') return reply([]) as never
    if (a[0] === 'ingest-alerts') return reply('Read 1 alert(s); 1 alert ticket(s) active.') as never
    return reply('ok') as never
  })
  on('tool.list', async () => ({ value: [{ name: 'mcp__slack__slack_read_channel', description: '', mcp: true }] }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.notify', async () => ({ value: { isSent: true, channel: 'test' } }) as never)
}

for (const surface of ['desktop', 'terminal'] as const) {
  test(`setup wizard detects connectors, saves choices and tests the database (${surface})`, async ($, on) => {
    const calls: { argv: string[]; stdin?: string }[] = []
    engine(on, calls)
    await $.command.run({ command: 'ops-setup', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'ops-tickets', surface, component: 'Pane', requestId: 'ops-setup', props: {} as never })

    expect(await ui.find({ text: /connector found/ })).toBeDefined()   // Slack detected from the tool list
    await ui.press({ key: 'w-tog-database' })
    expect(calls.some(c => c.argv.includes('config-set') && c.argv.includes('sources.database.enabled') && c.argv.includes('true'))).toBe(true)

    await ui.press({ key: 'w-step-1' })
    expect(await ui.find({ text: /Channel: #alerts \(C123\)/ })).toBeDefined()
  })

  test(`ops-run reads the Slack channel through the connector and feeds the engine (${surface})`, async ($, on) => {
    const calls: { argv: string[]; stdin?: string }[] = []
    engine(on, calls)
    const read: unknown[] = []
    on('tool.call', async (_$, e) => {
      read.push(e)
      return { result: {} as never, text: '=== Message from Sentry (U1) at 2026-10-15 10:30:29 +03 ===\nShort ID: APP-1' } as never
    })
    await $.command.run({ command: 'ops-run', args: '' } as never)
    expect(read.length).toBe(1)
    const ingest = calls.find(c => c.argv.includes('ingest-alerts'))
    expect(ingest?.stdin).toContain('Short ID: APP-1')
    expect(calls.some(c => c.argv.includes('run'))).toBe(true)
  })
}
