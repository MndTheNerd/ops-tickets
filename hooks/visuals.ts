// Pure SVG builders for the desktop pane. Each returns an <svg> string drawn by
// the Svg element with isInteractive (sandboxed: CSS animation, :hover, <title>
// tooltips, no script). Colours carry their own light/dark pair.

import type { Ticket } from '../types'

export const SEV = { high: '#e5484d', medium: '#f5a524', low: '#8b8d98' } as const
const STATUS = { open: '#e5484d', acknowledged: '#3e9bff', fixed: '#30a46c', resolved: '#8b8d98' } as const
const PALETTE = ['#6e56cf', '#3e9bff', '#12a594', '#f5a524', '#e5484d', '#d6409f', '#8b8d98', '#30a46c']

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const BASE_CSS = `
  .t { font: 600 11px system-ui, -apple-system, Segoe UI, sans-serif; fill: #6b6f7a; letter-spacing: .04em }
  .v { font: 700 26px system-ui, -apple-system, Segoe UI, sans-serif; fill: #1c1d21 }
  .s { font: 500 11px system-ui, -apple-system, Segoe UI, sans-serif; fill: #6b6f7a }
  .card { fill: #ffffff; stroke: #e4e5e9 }
  .track { fill: #eceef1 }
  @media (prefers-color-scheme: dark) {
    .v { fill: #f1f1f3 } .t, .s { fill: #a0a3ad }
    .card { fill: #1f2024; stroke: #2f3036 } .track { fill: #2a2b30 }
  }
  .rise { animation: rise .55s cubic-bezier(.2,.8,.2,1) both }
  @keyframes rise { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }
  .grow { transform-box: fill-box; transform-origin: left; animation: grow .8s cubic-bezier(.2,.8,.2,1) both }
  @keyframes grow { from { transform: scaleX(0) } to { transform: scaleX(1) } }
  .pulse { transform-box: fill-box; transform-origin: center; animation: pulse 1.6s ease-out infinite }
  @keyframes pulse { 0% { opacity: .7; transform: scale(1) } 100% { opacity: 0; transform: scale(2.6) } }
  .seg:hover { opacity: .8 } .card:hover { stroke: #6e56cf }
  .draw { stroke-dasharray: 1000; stroke-dashoffset: 1000; animation: draw 1.4s ease-out forwards }
  @keyframes draw { to { stroke-dashoffset: 0 } }
`

// Bigger, standalone pieces: each is its own Svg so the pane lays them out and
// wraps them at full size instead of scaling one wide picture down.
const BIG_CSS = BASE_CSS + `
  .t { font-size: 13px } .v { font-size: 36px } .s { font-size: 13px }
`

/** One stat card: label, big number, sub-line; the dot pulses when `pulse`. */
export function cardSvg(label: string, value: number, color: string, sub: string, pulse: boolean, delay = 0): string {
  const w = 210
  const h = 104
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><style>${BIG_CSS}</style>
    <g class="rise" style="animation-delay:${delay}ms"><title>${esc(`${value} ${label.toLowerCase()}: ${sub}`)}</title>
    <rect class="card" x="1" y="1" width="${w - 2}" height="${h - 2}" rx="14"/>
    <rect x="1" y="1" width="6" height="${h - 2}" rx="3" fill="${color}"/>
    <text class="t" x="22" y="30">${esc(label)}</text>
    ${pulse ? `<circle cx="${w - 24}" cy="25" r="7" fill="${color}" class="pulse"/>` : ''}<circle cx="${w - 24}" cy="25" r="7" fill="${color}"/>
    <text class="v" x="22" y="70">${value}</text>
    <text class="s" x="22" y="90">${esc(sub)}</text></g></svg>`
}

/** A labelled stacked bar with a legend that wraps onto as many lines as it needs. */
export function barSvg(title: string, counts: [string, number][], width = 620): string {
  const total = counts.reduce((a, [, n]) => a + n, 0) || 1
  let x = 0
  let segs = ''
  let legend = ''
  let lx = 0
  let ly = 66
  counts.forEach(([name, n], i) => {
    const w = (n / total) * width
    const c = PALETTE[i % PALETTE.length]
    segs += `<rect class="seg grow" style="animation-delay:${150 + i * 70}ms" x="${x}" y="24" width="${Math.max(w - 3, 2)}" height="18" rx="5" fill="${c}"><title>${esc(`${name}: ${n}`)}</title></rect>`
    const label = `${name}  ${n}`
    const lw = label.length * 7.6 + 30
    if (lx + lw > width) {
      lx = 0
      ly += 22
    }
    legend += `<g><title>${esc(`${name}: ${n} open`)}</title><circle cx="${lx + 6}" cy="${ly - 4}" r="5.5" fill="${c}"/><text class="s" x="${lx + 17}" y="${ly}">${esc(label)}</text></g>`
    lx += lw
    x += w
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${ly + 10}" viewBox="0 0 ${width} ${ly + 10}"><style>${BIG_CSS}</style>
    <g class="rise"><text class="t" x="0" y="14">${esc(title)}</text>
    <rect class="track" x="0" y="24" width="${width}" height="18" rx="5"/>${segs}${legend}</g></svg>`
}

/** Tickets opened per day over the last 14 days, as an area line that draws itself. */
export function trendSvg(all: Ticket[], width = 620): string {
  const days = [...Array(14)].map((_, i) => new Date(Date.now() - (13 - i) * 86400000).toISOString().slice(0, 10))
  const perDay = days.map(d => all.filter(t => t.events.some(e => e.kind === 'opened' && e.at.startsWith(d))).length)
  const max = Math.max(...perDay, 1)
  const top = 28
  const h = 70
  const step = (width - 20) / (days.length - 1)
  const y = (n: number) => (top + h - (n / max) * h).toFixed(1)
  const pts = perDay.map((n, i) => `${(10 + i * step).toFixed(1)},${y(n)}`)
  const dots = perDay.map((n, i) => `<g><title>${days[i]}: ${n} opened</title><circle cx="${(10 + i * step).toFixed(1)}" cy="${y(n)}" r="${n ? 5 : 3}" fill="#6e56cf"/></g>`).join('')
  const labels = [0, 7, 13].map(i => `<text class="s" x="${(10 + i * step).toFixed(1)}" y="${top + h + 22}" text-anchor="${i === 0 ? 'start' : i === 13 ? 'end' : 'middle'}">${days[i]!.slice(5)}</text>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${top + h + 30}" viewBox="0 0 ${width} ${top + h + 30}"><style>${BIG_CSS}</style>
    <g class="rise"><text class="t" x="0" y="14">NEW TICKETS, LAST 14 DAYS</text>
    <polygon points="10,${top + h} ${pts.join(' ')} ${width - 10},${top + h}" fill="#6e56cf" opacity=".14"/>
    <polyline class="draw" points="${pts.join(' ')}" fill="none" stroke="#6e56cf" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}${labels}</g></svg>`
}

/** Stat cards, a stacked bar by source and by owner, and a 14-day "opened" trend. */
export function dashboardSvg(all: Ticket[], width = 760): string {
  const live = all.filter(t => t.status !== 'resolved')
  const open = live.filter(t => t.status === 'open')
  const cards: [string, number, string, string][] = [
    ['OPEN', open.length, STATUS.open, `${open.filter(t => t.severity === 'high').length} high`],
    ['HIGH', open.filter(t => t.severity === 'high').length, SEV.high, 'needs action'],
    ['ACKNOWLEDGED', live.filter(t => t.status === 'acknowledged').length, STATUS.acknowledged, 'known / owned'],
    ['FIXED', live.filter(t => t.status === 'fixed').length, STATUS.fixed, 'watching for regressions'],
  ]
  const gap = 12
  const cw = (width - gap * 3) / 4
  let out = ''
  cards.forEach(([label, value, color, sub], i) => {
    const x = i * (cw + gap)
    const pulse = label === 'HIGH' && value > 0
      ? `<circle cx="${x + cw - 16}" cy="18" r="5" fill="${color}" class="pulse"/><circle cx="${x + cw - 16}" cy="18" r="5" fill="${color}"/>`
      : `<circle cx="${x + cw - 16}" cy="18" r="5" fill="${color}"/>`
    out += `<g class="rise" style="animation-delay:${i * 70}ms"><title>${esc(`${value} ${label.toLowerCase()}: ${sub}`)}</title>
      <rect class="card" x="${x}" y="0.5" width="${cw}" height="74" rx="10"/>
      <rect x="${x}" y="0.5" width="4" height="74" rx="2" fill="${color}"/>
      <text class="t" x="${x + 16}" y="22">${label}</text>${pulse}
      <text class="v" x="${x + 16}" y="52">${value}</text>
      <text class="s" x="${x + 16}" y="67">${esc(sub)}</text></g>`
  })

  const bar = (y: number, title: string, counts: [string, number][]) => {
    const total = counts.reduce((a, [, n]) => a + n, 0) || 1
    let x = 0
    let segs = ''
    let legend = ''
    let lx = 0
    counts.forEach(([name, n], i) => {
      const w = (n / total) * width
      const c = PALETTE[i % PALETTE.length]
      segs += `<rect class="seg grow" style="animation-delay:${200 + i * 60}ms" x="${x}" y="${y + 16}" width="${Math.max(w - 2, 1)}" height="12" rx="3" fill="${c}"><title>${esc(`${name}: ${n}`)}</title></rect>`
      const label = `${name} ${n}`
      if (lx + label.length * 6.4 + 22 < width) {
        legend += `<circle cx="${lx + 5}" cy="${y + 42}" r="4" fill="${c}"/><text class="s" x="${lx + 13}" y="${y + 46}">${esc(label)}</text>`
        lx += label.length * 6.4 + 26
      }
      x += w
    })
    return `<g class="rise" style="animation-delay:150ms"><text class="t" x="0" y="${y + 10}">${title}</text>
      <rect class="track" x="0" y="${y + 16}" width="${width}" height="12" rx="3"/>${segs}${legend}</g>`
  }
  const tally = (key: (t: Ticket) => string) =>
    [...open.reduce((m, t) => m.set(key(t), (m.get(key(t)) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1])
  out += bar(92, 'OPEN BY SOURCE', tally(t => t.source))
  out += bar(150, 'OPEN BY OWNER', tally(t => t.owner ?? 'Unassigned'))

  // tickets opened per day, last 14 days
  const days = [...Array(14)].map((_, i) => {
    const d = new Date(Date.now() - (13 - i) * 86400000)
    return d.toISOString().slice(0, 10)
  })
  const perDay = days.map(d => all.filter(t => t.events.some(e => e.kind === 'opened' && e.at.startsWith(d))).length)
  const max = Math.max(...perDay, 1)
  const ty = 208
  const th = 44
  const step = width / (days.length - 1)
  const pts = perDay.map((n, i) => `${(i * step).toFixed(1)},${(ty + 18 + th - (n / max) * th).toFixed(1)}`)
  const dots = perDay.map((n, i) => `<circle cx="${(i * step).toFixed(1)}" cy="${(ty + 18 + th - (n / max) * th).toFixed(1)}" r="3.5" fill="#6e56cf"><title>${days[i]}: ${n} opened</title></circle>`).join('')
  out += `<g class="rise" style="animation-delay:250ms"><text class="t" x="0" y="${ty + 10}">NEW TICKETS, LAST 14 DAYS</text>
    <polygon points="0,${ty + 18 + th} ${pts.join(' ')} ${width},${ty + 18 + th}" fill="#6e56cf" opacity=".12"/>
    <polyline class="draw" points="${pts.join(' ')}" fill="none" stroke="#6e56cf" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>${dots}</g>`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${ty + 18 + th + 6}" viewBox="0 -1 ${width} ${ty + 18 + th + 8}"><style>${BASE_CSS}</style>${out}</svg>`
}

/** A checklist progress bar that animates to its new length. */
export function progressSvg(done: number, total: number, width = 560): string {
  const pct = total ? done / total : 0
  const color = pct === 1 ? '#30a46c' : '#6e56cf'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="30" viewBox="0 0 ${width} 30"><style>${BIG_CSS}</style>
    <rect class="track" x="0" y="8" width="${width - 90}" height="14" rx="7"/>
    <rect class="grow" x="0" y="8" width="${Math.max((width - 90) * pct, pct ? 14 : 0)}" height="14" rx="7" fill="${color}"/>
    <text class="s" x="${width - 80}" y="20" style="font-weight:700">${done}/${total} done</text></svg>`
}

/** The ticket's history as a timeline of dots, newest on the right. */
export function timelineSvg(t: Ticket, width = 560): string {
  const ev = t.events.slice(-12)
  if (!ev.length) return ''
  const colorOf = (k: string) =>
    k === 'fixed' || k === 'verified' ? '#30a46c'
      : k === 'reopened' || k === 'spike' || k === 'verify-failed' ? '#e5484d'
        : k === 'acknowledged' ? '#3e9bff' : k.startsWith('step') ? '#6e56cf' : '#8b8d98'
  const step = ev.length > 1 ? (width - 20) / (ev.length - 1) : 0
  const dots = ev.map((e, i) => {
    const x = 10 + i * step
    return `<g class="rise" style="animation-delay:${i * 50}ms"><title>${esc(`${e.at.replace('T', ' ').replace('Z', ' UTC')}\n${e.kind}${e.note ? `: ${e.note}` : ''}`)}</title>
      <circle cx="${x}" cy="16" r="8" fill="${colorOf(e.kind)}"/>
      <text class="s" x="${x}" y="44" text-anchor="${i === 0 ? 'start' : i === ev.length - 1 ? 'end' : 'middle'}">${esc(e.kind)}</text></g>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="52" viewBox="0 0 ${width} 52"><style>${BIG_CSS}</style>
    <rect class="track" x="10" y="14" width="${width - 20}" height="4" rx="2"/>${dots}</svg>`
}

/** A small round severity dot that pulses for open high tickets. */
export function dotSvg(color: string, pulse: boolean): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><style>${BASE_CSS}</style>
    ${pulse ? `<circle cx="10" cy="10" r="5" fill="${color}" class="pulse"/>` : ''}<circle cx="10" cy="10" r="5" fill="${color}"/></svg>`
}
