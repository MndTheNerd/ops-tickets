import { expect, test } from 'claude-code/testing'

const TICKETS = [
  {
    id: 4, check_name: 'catalogue', title: 'Exampleland / Harbour (Port City): SKU 90001 \'House Sauce\' - Code conflict',
    severity: 'high', status: 'open', detail: 'SKU 90001 means House Sauce in the shop. Log: https://admin.example.com/orders/log/77/change/.', action: 'Correct the code',
    occurrences: 1, first_seen: '2026-10-15T11:56:17Z', last_seen: '2026-10-15T11:56:17Z',
    fixed_at: null, fixed_note: null, reopen_count: 0, events: [], steps: ['Decide which is right', 'Press Verify now'], steps_done: [],
    owner: 'Catalogue', source: 'Shop checks', meta: { url: 'https://errors.example.com/issues/4/', kind: 'code', code: '90001', code_label: 'SKU', missing_in: 'Code conflict', store: 'Harbour', country: 'Exampleland', city: 'Port City' },
  },
  {
    id: 12, check_name: 'silent', title: 'Otherland / Northgate (Hill Town): no sales for 12h+',
    severity: 'medium', status: 'open', detail: null, action: null, occurrences: 1,
    first_seen: '2026-10-15T11:56:17Z', last_seen: '2026-10-15T11:56:17Z', fixed_at: null, fixed_note: null,
    reopen_count: 0, events: [], steps: ['Call the store'], steps_done: [], owner: 'Ops', source: 'Shop checks', meta: { kind: 'silent', store: 'Northgate', country: 'Otherland', city: 'Hill Town' },
  },
]

for (const surface of ['desktop', 'terminal'] as const) {
  test(`incident command pane: views, filters, search, inspector and runbook (${surface})`, async ($, on) => {
    const calls: string[][] = []
    on('process.run', async (_$, e) => {
      calls.push([...e.argv])
      const isJson = e.argv.includes('json')
      return { value: { exitCode: 0, stdout: isJson ? JSON.stringify(TICKETS) : e.argv.includes('export') ? 'Exported 2 open ticket(s) to /tmp/exports/Ops tickets.xlsx' : e.argv.includes('notifications') ? JSON.stringify([{ kind: 'opened', ticket: 4, title: 'Code conflict', owner: 'Catalogue' }]) : e.argv.includes('owners') ? JSON.stringify(['Backend', 'Catalogue']) : e.argv.includes('verify') ? JSON.stringify({ ok: true, message: 'Code fine now' }) : e.argv.includes('config-get') ? JSON.stringify('08:12') : '#4 marked fixed.', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
    })
    on('ui.status', async () => ({ value: undefined }) as never)
    on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
    const notified: string[] = []
    on('ui.notify', async (_$, e) => { notified.push(e.text); return { value: { isSent: true, channel: 'test' } } as never })
    const copied: string[] = []
    on('ui.copy', async (_$, e) => { copied.push(e.text); return { value: { isCopied: true } } as never })

    await $.command.run({ command: 'tickets', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'ops-tickets', surface, component: 'Pane', requestId: 'ops-tickets', props: {} as never })

    // both incidents, with their place chips, priority badges and the schedule from the config
    expect(await ui.find({ text: /Exampleland · Harbour/ })).toBeDefined()
    expect(await ui.find({ text: /Otherland · Northgate/ })).toBeDefined()
    expect(await ui.find({ text: /P0 CRITICAL/ })).toBeDefined()
    expect(await ui.find({ text: /P1 HIGH/ })).toBeDefined()
    expect(await ui.find({ text: /Next automated run: 08:12/ })).toBeDefined()
    if (surface === 'desktop') expect((await ui.findAll({ type: 'Svg' })).length).toBeGreaterThanOrEqual(6) // 4 KPIs + pipelines
    else expect(await ui.find({ text: /1 P0/ })).toBeDefined()

    // preset view: P0 blockers only
    await ui.press({ key: 'v-high' })
    expect(await ui.find({ text: /Otherland · Northgate/ })).toBeUndefined()
    await ui.press({ key: 'v-open' })
    expect(await ui.find({ text: /Otherland · Northgate/ })).toBeDefined()

    // owner filter
    await ui.select({ key: 'f-owner', value: 'Ops' })
    expect(await ui.find({ text: /Exampleland · Harbour/ })).toBeUndefined()
    await ui.select({ key: 'f-owner', value: '*' })

    // free-text search
    await ui.input({ key: 'search', text: 'Northgate', kind: 'change' })
    expect(await ui.find({ text: /Exampleland · Harbour/ })).toBeUndefined()
    await ui.input({ key: 'search', text: '', kind: 'change' })
    expect(await ui.find({ text: /Exampleland · Harbour/ })).toBeDefined()

    await ui.press({ key: 'export' })
    expect(calls.some(a => a.includes('export'))).toBe(true)
    expect(await ui.find({ text: /Ops tickets\.xlsx/ })).toBeDefined()
    expect(await ui.find({ key: 'open-export' })).toBeDefined()

    // inspector + runbook
    await ui.press({ key: 'pick-4' })
    expect(await ui.find({ text: /RUNBOOK PIPELINE/ })).toBeDefined()
    expect(await ui.find({ text: /Step 1 of 2/ })).toBeDefined()
    const order: string[] = []
    const walk = (n: unknown) => {
      if (!n || typeof n !== 'object') return
      const node = n as { key?: string; props?: { key?: string }; children?: unknown[] }
      const k = node.key ?? node.props?.key
      if (k && /^(t-|detail-)/.test(k)) order.push(k)
      for (const c of node.children ?? []) walk(c)
    }
    walk(await ui.drawn())
    if (surface === 'desktop') expect(order.indexOf('detail-4')).toBe(order.length - 1) // side inspector
    else expect(order.indexOf('detail-4')).toBe(order.indexOf('t-4') + 1)              // under its row

    // every link in the ticket is clickable (main link + one inside the detail text)
    const links = (await ui.findAll({ type: 'Link' })) as unknown as { props?: { href?: string } }[]
    const hrefs = links.map(l => l.props?.href ?? '')
    expect(hrefs).toContain('https://errors.example.com/issues/4/')
    expect(hrefs).toContain('https://admin.example.com/orders/log/77/change/')

    await ui.press({ key: 'copy-ticket-4' })
    expect(copied.at(-1)).toContain('SKU: 90001')
    await ui.press({ key: 'code-4' })
    expect(copied.at(-1)).toBe('90001')

    await ui.press({ key: 'step-do-4-0' })
    expect(calls.some(a => a.includes('step') && a.includes('4') && a.includes('0'))).toBe(true)
    await ui.press({ key: 'verify-4' })
    expect(await ui.find({ text: /Code fine now/ })).toBeDefined()
    await ui.press({ key: 'ack-4' })
    expect(calls.some(a => a.includes('ack') && a.includes('4'))).toBe(true)

    // resolving needs a second, explicit confirmation
    expect(await ui.find({ key: 'fix-4' })).toBeUndefined()
    await ui.press({ key: 'ask-fix-4' })
    expect((await ui.find({ text: /Confirm INC-4 is resolved/ })) ?? (await ui.find({ key: 'dc-4' }))).toBeDefined()
    await ui.input({ key: 'fix-4', text: 'renamed on POS' })
    expect(calls.some(a => a.includes('fix') && a.includes('4') && a.includes('renamed'))).toBe(true)
  })
}

// Phones (no text inputs or dropdowns) and narrow desktop panes: stacked rows, inspector under its row.
for (const [label, surface, viewport] of [
  ['mobile', 'mobile', undefined],
  ['narrow desktop', 'desktop', { columns: 70, rows: 40 }],
] as const) {
  test(`compact layout works on ${label}`, async ($, on) => {
    const calls: string[][] = []
    on('process.run', async (_$, e) => {
      calls.push([...e.argv])
      const out = e.argv.includes('json') ? JSON.stringify(TICKETS) : e.argv.includes('config-get') ? JSON.stringify('08:12')
        : e.argv.includes('owners') ? JSON.stringify(['Catalogue', 'Ops']) : e.argv.includes('notifications') ? '[]' : 'ok'
      return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
    })
    on('ui.status', async () => ({ value: undefined }) as never)
    on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
    on('ui.notify', async () => ({ value: { isSent: true, channel: 'test' } }) as never)

    await $.command.run({ command: 'tickets', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'ops-tickets', surface, component: 'Pane', requestId: 'ops-tickets', props: {} as never,
      ...(viewport ? { viewport } : {}) } as never)

    expect(await ui.find({ text: /Exampleland · Harbour/ })).toBeDefined()
    expect(await ui.find({ text: /FREQUENCY · PIPELINE · ACTION/ })).toBeUndefined() // no wide column header

    await ui.press({ key: 'pick-4' })
    const order: string[] = []
    const walk = (n: unknown) => {
      if (!n || typeof n !== 'object') return
      const node = n as { key?: string; props?: { key?: string }; children?: unknown[] }
      const k = node.key ?? node.props?.key
      if (k && /^(t-|detail-)/.test(k)) order.push(k)
      for (const c of node.children ?? []) walk(c)
    }
    walk(await ui.drawn())
    expect(order.indexOf('detail-4')).toBe(order.indexOf('t-4') + 1) // under its own row

    await ui.press({ key: 'ask-fix-4' })
    if (surface === 'mobile') {
      await ui.press({ key: 'fix-4' }) // no text input on phones: one tap confirms
      expect(calls.some(a => a.includes('fix') && a.includes('4'))).toBe(true)
      await ui.press({ key: 'f-owner-Ops' }) // owner filter as buttons on phones
      expect(await ui.find({ text: /Exampleland · Harbour/ })).toBeUndefined()
    } else {
      await (ui as unknown as { input: (a: { key: string; text: string }) => Promise<unknown> }).input({ key: 'fix-4', text: 'done' })
      expect(calls.some(a => a.includes('fix') && a.includes('done'))).toBe(true)
    }
  })
}
