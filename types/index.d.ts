export type TicketEvent = { at: string; kind: string; note: string | null }

export type TicketMeta = {
  kind?: string
  code?: string
  code_label?: string
  item?: string
  sent_as?: string
  missing_in?: string
  store_id?: number | null
  store?: string
  country?: string
  city?: string
  app_name?: string
  app_id?: number
  app_type?: string
  url?: string
  alert_key?: string
}

export type Ticket = {
  id: number
  check_name: string
  title: string
  severity: 'high' | 'medium' | 'low'
  status: 'open' | 'acknowledged' | 'fixed' | 'resolved'
  detail: string | null
  action: string | null
  occurrences: number
  first_seen: string
  last_seen: string
  fixed_at: string | null
  fixed_note: string | null
  reopen_count: number
  meta: TicketMeta | null
  owner: string | null
  source: string
  steps: string[]
  steps_done: number[]
  events: TicketEvent[]
}

declare module 'claude-code' {
  interface PluginState {
    'ops-tickets': {
      tickets: Ticket[]
      selected: number | null
      statusFilter: string
      sourceFilter: string | null
      ownerFilter: string | null
      owners: string[]
      busy: string | null
      message: string | null
      confirming: number | null
      verified: { id: number; ok: boolean; message: string } | null
      exported: string | null
      setup: {
        step: number
        configured: boolean
        enabled: Record<string, boolean>
        detected: Record<string, boolean>
        tests: Record<string, { ok: boolean | null; message: string }>
        config: Record<string, unknown>
        packs: { name: string; description: string; needs: string[]; ready: boolean }[]
        error: string | null
      } | null
    }
  }
}
