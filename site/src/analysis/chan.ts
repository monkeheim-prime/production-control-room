// Chan (1995) water-control diagnostic: WOR and its time derivative on log-log axes.
//   Normal displacement: WOR' rises roughly parallel to WOR.
//   Channeling: WOR' climbs steeply (positive, increasing slope) after breakthrough.
//   Coning: early breakthrough, then WOR' falls or flattens (negative slope) before rising late.
import type { Well } from '../core/data'

export interface ChanPoint { t: number; days: number; wor: number; dwor: number | null }
export interface ChanResult {
  pts: ChanPoint[]
  breakthrough: number | null   // days
  slopeWor: number | null       // d ln WOR / d ln t, late period
  slopeDer: number | null       // d ln WOR' / d ln t, late period
  earlyBt: boolean
  scores: { channeling: number; coning: number; normal: number }
}

const sig = (x: number) => 1 / (1 + Math.exp(-x))

function fitSlope(xs: number[], ys: number[]): number | null {
  const n = xs.length
  if (n < 4) return null
  const mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n
  let num = 0, den = 0
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2 }
  return den > 0 ? num / den : null
}

export function chan(w: Well): ChanResult {
  const raw: { t: number; days: number; wor: number }[] = []
  let days = 0
  for (let t = w.first; t <= w.last; t++) {
    const o = w.m.oil[t] ?? 0, wa = w.m.wat[t] ?? 0, h = w.m.hrs[t] ?? 0
    days += (h / 24) * 30.44
    if (o > 0.5 && wa >= 0) raw.push({ t, days: Math.max(days, 1), wor: Math.max(wa / o, 1e-4) })
  }
  // geometric 3-point smoothing
  const sm = raw.map((p, i) => {
    const ws = raw.slice(Math.max(0, i - 1), i + 2).map(q => Math.log(q.wor))
    return { ...p, wor: Math.exp(ws.reduce((a, b) => a + b) / ws.length) }
  })
  const pts: ChanPoint[] = sm.map((p, i) => {
    const a = sm[Math.max(0, i - 2)], b = sm[Math.min(sm.length - 1, i + 2)]
    const d = b.days > a.days ? (b.wor - a.wor) / (b.days - a.days) : null
    return { ...p, dwor: d != null && d > 0 ? d : null }
  })

  const btIdx = pts.findIndex(p => p.wor > 0.05)
  const breakthrough = btIdx >= 0 ? pts[btIdx].days : null
  const life = pts.length ? pts[pts.length - 1].days : 1
  const earlyBt = breakthrough != null && breakthrough < 0.22 * life
  const post = btIdx >= 0 ? pts.slice(btIdx) : []
  const late = post.slice(Math.floor(post.length * 0.4)).filter(p => p.dwor != null)
  const slopeWor = fitSlope(late.map(p => Math.log(p.days)), late.map(p => Math.log(p.wor)))
  const slopeDer = fitSlope(late.map(p => Math.log(p.days)), late.map(p => Math.log(p.dwor!)))

  // mid-period derivative trend: coning shows a falling derivative after early breakthrough
  const mid = post.slice(0, Math.max(4, Math.floor(post.length * 0.6))).filter(p => p.dwor != null)
  const slopeMid = fitSlope(mid.map(p => Math.log(p.days)), mid.map(p => Math.log(p.dwor!)))

  let channeling = 0, coning = 0, normal = 0
  if (breakthrough != null && slopeDer != null && slopeWor != null) {
    channeling = sig((slopeDer - 0.2) * 4) * sig((slopeWor - 1) * 4)
    coning = (earlyBt ? 0.75 : 0.2) * sig(-(slopeMid ?? 0) * 2.5 + 0.4)
    normal = Math.max(0, 1 - Math.max(channeling, coning)) * 0.8
  }
  return { pts, breakthrough, slopeWor, slopeDer, earlyBt, scores: { channeling, coning, normal } }
}
