// Injector diagnostics: modified Hall analysis (Izgec & Kabir, 2009), connectivity, voidage replacement.
import type { Dataset, Well } from '../core/data'
import { presAt } from '../core/data'
import type { Assumptions } from '../core/state'

export interface HallPoint { t: number; wi: number; hi: number; dhi: number | null }
export interface HallResult {
  available: boolean
  pressureSource: 'bhp' | 'whp' | null
  pts: HallPoint[]
  ratio: number | null          // mean DHI/HI over the last third
  onset: number | null          // index into pts where curves separate
  verdict: 'matrix' | 'plugging' | 'fracture' | null
}

export function hall(ds: Dataset, w: Well, a: Assumptions): HallResult {
  const hasBhp = w.m.bhp.some(v => v != null && v > 0)
  const hasWhp = w.m.whp.some(v => v != null && v > 0)
  const src: 'bhp' | 'whp' | null = hasBhp ? 'bhp' : hasWhp ? 'whp' : null
  if (!src) return { available: false, pressureSource: null, pts: [], ratio: null, onset: null, verdict: null }
  const pts: HallPoint[] = []
  let wi = 0, hi = 0
  for (let t = w.first; t <= w.last; t++) {
    const q = w.m.wi[t] ?? 0
    const p = w.m[src][t]
    if (q <= 0 || p == null) continue
    const days = ((w.m.hrs[t] ?? 24) / 24) * 30.44
    const dp = src === 'bhp' ? p - presAt(ds, w, t, a) : p
    wi += q * 30.44
    hi += dp * days
    pts.push({ t, wi, hi, dhi: null })
  }
  if (pts.length < 12) return { available: false, pressureSource: null, pts: [], ratio: null, onset: null, verdict: null }
  // DHI = dHI / d ln(Wi) = Wi * dHI/dWi, central difference over +-3 points
  for (let i = 0; i < pts.length; i++) {
    const lo = pts[Math.max(0, i - 3)], up = pts[Math.min(pts.length - 1, i + 3)]
    if (up.wi > lo.wi) pts[i].dhi = pts[i].wi * (up.hi - lo.hi) / (up.wi - lo.wi)
  }
  const tail = pts.slice(Math.floor(pts.length * 0.66)).filter(p => p.dhi != null && p.hi > 0)
  const ratio = tail.length ? tail.reduce((s, p) => s + p.dhi! / p.hi, 0) / tail.length : null
  let onset: number | null = null
  for (let i = 6; i < pts.length - 3; i++) {
    const seg = pts.slice(i, i + 4)
    if (seg.every(p => p.dhi != null && p.hi > 0 && Math.abs(p.dhi / p.hi - 1) > 0.1)) { onset = i; break }
  }
  const verdict = ratio == null ? null : ratio > 1.1 ? 'plugging' : ratio < 0.9 ? 'fracture' : 'matrix'
  return { available: true, pressureSource: src, pts, ratio, onset, verdict }
}

export interface Link { inj: string; prod: string; r: number }

const diff = (xs: (number | null)[]) => xs.map((v, i) => (i && v != null && xs[i - 1] != null ? v - xs[i - 1]! : null))

/** Pearson correlation of month-on-month injection changes with producer liquid changes, lagged one month. */
export function connectivity(ds: Dataset, inj: Well): Link[] {
  const dq = diff(inj.m.wi.map(v => (v != null && v > 0 ? v : null)))
  return ds.producers.map(p => {
    const liq = p.m.oil.map((o, t) => ((o ?? 0) > 0 ? (o ?? 0) + Math.max(0, p.m.wat[t] ?? 0) : null))
    const dl = diff(liq)
    const xs: number[] = [], ys: number[] = []
    for (let t = 1; t < dq.length - 1; t++) {
      const x = dq[t], y = dl[t + 1]
      if (x != null && y != null) { xs.push(x); ys.push(y) }
    }
    return { inj: inj.id, prod: p.id, r: pearson(xs, ys) }
  })
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length
  if (n < 12) return 0
  const mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2 }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0
}

export const BO = 1.25 // assumed oil formation volume factor, rm3/Sm3
export const BW = 1.02

/** Monthly voidage replacement ratio for a block (Field X) or the whole field (Volve). */
export function vrr(ds: Dataset, block: string | null): { t: number; v: number }[] {
  const prods = ds.producers.filter(p => !block || p.block === block)
  const injs = ds.injectors.filter(p => !block || p.block === block)
  const out: { t: number; v: number }[] = []
  for (let t = 0; t < ds.months.length; t++) {
    const inj = injs.reduce((s, w) => s + (w.m.wi[t] ?? 0), 0) * BW
    const prod = prods.reduce((s, w) => s + (w.m.oil[t] ?? 0) * BO + Math.max(0, w.m.wat[t] ?? 0) * BW, 0)
    if (prod > 1 && inj > 0) out.push({ t, v: inj / prod })
  }
  return out
}
