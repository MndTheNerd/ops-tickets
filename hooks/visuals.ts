// "Obsidian Telemetry" pieces for the desktop pane: deep slate surfaces, 1px hairlines,
// signal accents, Geist for words and a monospace for every number and id. Each builder
// returns an <svg> string drawn by Svg with isInteractive (CSS animation, :hover, <title>).

import type { Ticket } from '../types'

export const C = {
  canvas: '#0b1326', panel: '#0f172a', panel2: '#131b2e', raised: '#1e293b', hair: '#1e293b', border: '#334155',
  text: '#dae2fd', strong: '#f8fafc', muted: '#94a3b8', ghost: '#475569',
  cyan: '#38bdf8', cyanSoft: '#8ed5ff', emerald: '#4edea3', amber: '#f59e0b', amberSoft: '#ffc174',
  rose: '#f43f5e', roseSoft: '#ffb4ab',
} as const

export const SEV = { high: C.rose, medium: C.amber, low: C.ghost } as const
const SERIES = [C.cyan, C.amber, C.emerald, C.rose, '#a78bfa', '#f472b6', C.muted, '#22d3ee']

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const CSS = `
  .lbl { font: 500 11px "JetBrains Mono", "Cascadia Mono", Consolas, ui-monospace, monospace; letter-spacing: .06em; fill: ${C.muted} }
  .num { font: 700 38px "Geist", "Segoe UI", system-ui, sans-serif; font-variant-numeric: tabular-nums; letter-spacing: -.03em; fill: ${C.strong} }
  .mono { font: 500 12px "JetBrains Mono", "Cascadia Mono", Consolas, ui-monospace, monospace; font-variant-numeric: tabular-nums; fill: ${C.text} }
  .txt { font: 400 12px "Geist", "Segoe UI", system-ui, sans-serif; fill: ${C.muted} }
  .card { fill: ${C.panel}; stroke: ${C.hair} } .card:hover { stroke: ${C.border} }
  .track { fill: ${C.raised} }
  .rise { animation: rise .5s cubic-bezier(.2,.8,.2,1) both }
  @keyframes rise { from { opacity: 0; transform: translateY(5px) } to { opacity: 1; transform: none } }
  .grow { transform-box: fill-box; transform-origin: left; animation: grow .8s cubic-bezier(.2,.8,.2,1) both }
  @keyframes grow { from { transform: scaleX(0) } to { transform: scaleX(1) } }
  .glow { animation: glow 1.8s ease-in-out infinite }
  @keyframes glow { 0%,100% { opacity: .35 } 50% { opacity: .9 } }
  .draw { stroke-dasharray: 1600; stroke-dashoffset: 1600; animation: draw 1.6s ease-out forwards }
  @keyframes draw { to { stroke-dashoffset: 0 } }
  .seg:hover { opacity: .78 }
`
const svg = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><style>${CSS}</style>${body}</svg>`

/** A KPI card: accent top rule, mono label, big tabular number, tinted chip, footer metric. */
export function kpiSvg(o: {
  label: string; value: number; accent: string; chip?: string; foot: string; footValue: string; pulse?: boolean; delay?: number
}): string {
  const w = 228
  const h = 112
  const chipW = o.chip ? o.chip.length * 7 + 14 : 0
  const valueW = String(o.value).length * 23
  return svg(w, h, `<g class="rise" style="animation-delay:${o.delay ?? 0}ms"><title>${esc(`${o.value} ${o.label.toLowerCase()}`)}</title>
    <rect class="card" x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="4"/>
    <rect x=".5" y=".5" width="${w - 1}" height="2" fill="${o.accent}"/>
    <text class="lbl" x="14" y="26">${esc(o.label)}</text>
    ${o.pulse ? `<circle cx="${w - 18}" cy="22" r="9" fill="${o.accent}" class="glow" opacity=".4"/>` : ''}
    <circle cx="${w - 18}" cy="22" r="4.5" fill="${o.accent}"/>
    <text class="num" x="14" y="68">${o.value}</text>
    ${o.chip ? `<rect x="${22 + valueW}" y="50" width="${chipW}" height="20" rx="3" fill="${o.accent}" fill-opacity=".12" stroke="${o.accent}" stroke-opacity=".3"/>
      <text class="mono" x="${29 + valueW}" y="64" style="font-size:11px;fill:${o.accent}">${esc(o.chip)}</text>` : ''}
    <line x1="14" y1="84" x2="${w - 14}" y2="84" stroke="${C.hair}"/>
    <text class="txt" x="14" y="102">${esc(o.foot)}</text>
    <text class="mono" x="${w - 14}" y="102" text-anchor="end">${esc(o.footValue)}</text></g>`)
}

/** Stacked bar with a mono share line on top and a wrapping legend underneath. */
export function shareBarSvg(title: string, counts: [string, number][], width = 380, short = (s: string) => s): string {
  const total = counts.reduce((a, [, n]) => a + n, 0) || 1
  const shares = counts.slice(0, 4).map(([n, v]) => `${short(n).toUpperCase().slice(0, 3)} ${Math.round((v / total) * 100)}%`).join(' · ')
  let x = 0
  let segs = ''
  let legend = ''
  let lx = 0
  let ly = 82
  counts.forEach(([name, n], i) => {
    const w = (n / total) * width
    const c = SERIES[i % SERIES.length]
    segs += `<rect class="seg grow" style="animation-delay:${120 + i * 60}ms" x="${x.toFixed(1)}" y="40" width="${Math.max(w - 2, 2).toFixed(1)}" height="8" fill="${c}"><title>${esc(`${name}: ${n}`)}</title></rect>`
    const label = `${short(name)}: ${n}`
    const lw = label.length * 6.9 + 22
    if (lx + lw > width) {
      lx = 0
      ly += 18
    }
    legend += `<circle cx="${lx + 4}" cy="${ly - 4}" r="3.5" fill="${c}"/><text class="txt" x="${lx + 12}" y="${ly}">${esc(label)}</text>`
    lx += lw
    x += w
  })
  return svg(width, ly + 8, `<g class="rise">
    <text class="lbl" x="0" y="12">${esc(`${title} (${total})`)}</text>
    <text class="mono" x="0" y="30" style="font-size:11px;fill:${C.cyanSoft}">${esc(shares)}</text>
    <rect class="track" x="0" y="40" width="${width}" height="8"/>${segs}
    <line x1="0" y1="58" x2="${width}" y2="58" stroke="${C.hair}"/>${legend}</g>`)
}

/** New tickets per day for 14 days: a cyan area line that draws itself, today's count flagged. */
export function trendSvg(all: Ticket[], width = 380): string {
  const days = [...Array(14)].map((_, i) => new Date(Date.now() - (13 - i) * 86400000).toISOString().slice(0, 10))
  const per = days.map(d => all.filter(t => t.events.some(e => e.kind === 'opened' && e.at.startsWith(d))).length)
  const max = Math.max(...per, 1)
  const top = 30
  const h = 54
  const step = width / (days.length - 1)
  const y = (n: number) => (top + h - (n / max) * h).toFixed(1)
  const pts = per.map((n, i) => `${(i * step).toFixed(1)},${y(n)}`)
  const today = per[per.length - 1] ?? 0
  const avg = per.slice(0, -1).reduce((a, b) => a + b, 0) / 13
  const flag = today > Math.max(2 * avg, 3) ? `+${today} spike today` : `+${today} today`
  const ticks = [0, 5, 9, 13].map(i => `<text class="txt" style="font-size:10px" x="${(i * step).toFixed(1)}" y="${top + h + 18}" text-anchor="${i === 0 ? 'start' : i === 13 ? 'end' : 'middle'}" ${i === 13 ? `fill="${C.cyanSoft}"` : ''}>${days[i]!.slice(5)}${i === 13 ? ' (today)' : ''}</text>`).join('')
  const dots = per.map((n, i) => `<g><title>${days[i]}: ${n} opened</title><circle cx="${(i * step).toFixed(1)}" cy="${y(n)}" r="${i === 13 ? 4 : 2.5}" fill="${C.cyan}"/></g>`).join('')
  return svg(width, top + h + 24, `<g class="rise">
    <text class="lbl" x="0" y="12">NEW TICKETS (LAST 14 DAYS)</text>
    <text class="mono" x="${width}" y="12" text-anchor="end" style="font-size:11px;fill:${today > Math.max(2 * avg, 3) ? C.amberSoft : C.muted}">${flag}</text>
    <line x1="0" y1="${top + h}" x2="${width}" y2="${top + h}" stroke="${C.hair}"/>
    <polygon points="0,${top + h} ${pts.join(' ')} ${width},${top + h}" fill="${C.cyan}" fill-opacity=".1"/>
    <polyline class="draw" points="${pts.join(' ')}" fill="none" stroke="${C.cyan}" stroke-width="2" stroke-linejoin="round"/>
    ${dots}${ticks}</g>`)
}

/** Checklist progress: a thin cyan rule (emerald when complete) with mono "n/m done". */
export function progressSvg(done: number, total: number, width = 520): string {
  const pct = total ? done / total : 0
  const color = pct === 1 ? C.emerald : C.cyan
  return svg(width, 14, `<rect class="track" x="0" y="4" width="${width}" height="6" rx="1"/>
    <rect class="grow" x="0" y="4" width="${Math.max(width * pct, pct ? 6 : 0)}" height="6" rx="1" fill="${color}"/>`)
}

/** Severity dot with a soft status glow for open high tickets. */
export function dotSvg(color: string, pulse: boolean): string {
  return svg(14, 14, `${pulse ? `<circle cx="7" cy="7" r="6" fill="${color}" class="glow" opacity=".45"/>` : ''}<circle cx="7" cy="7" r="3.5" fill="${color}"/>`)
}
