import { expect, test } from 'claude-code/testing'

const TICKETS = [
  {
    id: 4, check_name: 'catalogue', title: 'Exampleland / Harbour (Port City): SKU 5007001 \'Ketchup\' - Code conflict',
    severity: 'high', status: 'open', detail: 'SKU 5007001 means Ketchup in the shop', action: 'Correct the code',
    occurrences: 1, first_seen: '2026-10-15T11:56:17Z', last_seen: '2026-10-15T11:56:17Z',
    fixed_at: null, fixed_note: null, reopen_count: 0, events: [], steps: ['Decide which is right', 'Press Verify now'], steps_done: [],
    owner: 'Catalogue', source: 'Shop checks', meta: { kind: 'code', code: '5007001', code_label: 'SKU', missing_in: 'Code conflict', store: 'Harbour', country: 'Exampleland', city: 'Port City' },
  },
  {
    id: 12, check_name: 'silent', title: 'Otherland / Northgate (Hill Town): no sales for 12h+',
    severity: 'medium', status: 'open', detail: null, action: null, occurrences: 1,
    first_seen: '2026-10-15T11:56:17Z', last_seen: '2026-10-15T11:56:17Z', fixed_at: null, fixed_note: null,
    reopen_count: 0, events: [], steps: ['Call the store'], steps_done: [], owner: 'Ops', source: 'Shop checks', meta: { kind: 'silent', store: 'Northgate', country: 'Otherland', city: 'Hill Town' },
  },
]

for (const surface of ['desktop', 'terminal'] as const) {
  test(`pane groups tickets by country and store, and a click shows the fix (${surface})`, async ($, on) => {
    const calls: string[][] = []
    on('process.run', async (_$, e) => {
      calls.push([...e.argv])
      const isJson = e.argv.includes('json')
      return { value: { exitCode: 0, stdout: isJson ? JSON.stringify(TICKETS) : e.argv.includes('export') ? 'Exported 2 open ticket(s) to /tmp/exports/Ops tickets.xlsx' : e.argv.includes('notifications') ? JSON.stringify([{ kind: 'opened', ticket: 4, title: 'Code conflict', owner: 'Catalogue' }]) : e.argv.includes('owners') ? JSON.stringify(['Backend', 'Catalogue']) : e.argv.includes('verify') ? JSON.stringify({ ok: true, message: 'Code fine now' }) : '#4 marked fixed.', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
    })
    on('ui.status', async () => ({ value: undefined }) as never)
    on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
    const notified: string[] = []
    on('ui.notify', async (_$, e) => { notified.push(e.text); return { value: { isSent: true, channel: 'test' } } as never })
    const copied: string[] = []
    on('ui.copy', async (_$, e) => { copied.push(e.text); return { value: { isCopied: true } } as never })

    await $.command.run({ command: 'tickets', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'ops-tickets', surface, component: 'Pane', requestId: 'ops-tickets', props: {} as never })

    // headings are Markdown on desktop, Text in the terminal: find by text or by key
    const has = async (text: RegExp, key: string) => (await ui.find({ text })) ?? (await ui.find({ key }))
    expect(await ui.find({ text: /EXAMPLELAND/ })).toBeDefined()
    expect(await ui.find({ text: /OTHERLAND/ })).toBeDefined()
    expect(await ui.find({ text: /HARBOUR/ })).toBeDefined()
    if (surface === 'desktop') expect((await ui.findAll({ type: 'Svg' })).length).toBeGreaterThanOrEqual(7)
    else expect(await ui.find({ text: /1 high/ })).toBeDefined()

    // filters: owner chip narrows the list
    await ui.press({ key: 'f-own-Ops' })
    expect(await ui.find({ text: /HARBOUR/ })).toBeUndefined()
    expect(await ui.find({ text: /NORTHGATE/ })).toBeDefined()
    await ui.press({ key: 'f-own-all' })

    await ui.press({ key: 'export' })
    expect(calls.some(a => a.includes('export'))).toBe(true)
    expect(await ui.find({ text: /Ops tickets\.xlsx/ })).toBeDefined()
    expect(await ui.find({ key: 'open-export' })).toBeDefined()

    await ui.press({ key: 'pick-4' })
    expect(await has(/Solution/, 'dsol-4')).toBeDefined()
    // the ticket opens right under its own row, before the next row
    const order: string[] = []
    const walk = (n: unknown) => {
      if (!n || typeof n !== 'object') return
      const node = n as { key?: string; props?: { key?: string }; children?: unknown[] }
      const k = node.key ?? node.props?.key
      if (k && /^(t-|detail-)/.test(k)) order.push(k)
      for (const c of node.children ?? []) walk(c)
    }
    walk(await ui.drawn())
    if (surface === 'desktop') {
      // wide desktop pane: the inspector sits beside the list, after every row
      expect(order.indexOf('detail-4')).toBe(order.length - 1)
    } else {
      // terminal / narrow: it opens right under its own row
      expect(order.indexOf('detail-4')).toBe(order.indexOf('t-4') + 1)
    }
    expect(await ui.find({ text: /Decide which is right/ })).toBeDefined()

    await ui.press({ key: 'copy-ticket-4' })
    expect(copied.at(-1)).toContain('SKU: 5007001')
    expect(await ui.find({ text: /Copied ticket #4/ })).toBeDefined()
    await ui.press({ key: 'copy-code-4' })
    expect(copied.at(-1)).toBe('5007001')

    await ui.press({ key: 'step-4-0' })
    expect(calls.some(a => a.includes('step') && a.includes('4') && a.includes('0'))).toBe(true)

    await ui.press({ key: 'verify-4' })
    expect(await ui.find({ text: /Code fine now/ })).toBeDefined()

    await ui.press({ key: 'ack-4' })
    expect(calls.some(a => a.includes('ack') && a.includes('4'))).toBe(true)

    // fixing needs a second, explicit confirmation
    expect(await ui.find({ key: 'fix-4' })).toBeUndefined()
    await ui.press({ key: 'ask-fix-4' })
    expect(await has(/Confirm #4 is fixed/, 'dc-4')).toBeDefined()
    await ui.input({ key: 'fix-4', text: 'renamed on POS' })
    expect(calls.some(a => a.includes('fix') && a.includes('4') && a.includes('renamed'))).toBe(true)
  })
}
