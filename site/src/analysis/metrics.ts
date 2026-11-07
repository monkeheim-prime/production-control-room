// Per-well performance metrics at a month, gap-to-potential and the Heterogeneity Index.
import type { Dataset, Num, Well } from '../core/data'
import { presAt, pwfMinFor } from '../core/data'
import type { Assumptions } from '../core/state'

export const WC_PI_PENALTY = 0.35 // assumed linear relative-permeability penalty on PI vs water cut

export interface Metrics {
  id: string
  status: 'flowing' | 'idle' | 'notyet' | 'injector'
  oil: number; wat: number; liq: number; gas: number; wc: number; gor: number
  bhp: number | null; whp: number | null; choke: number | null; pres: number; pwfMin: number
  pi: number | null; piRef: number | null; piExp: number | null
  gapDamage: number; gapLift: number; gapWater: number; gapIdle: number; gap: number
  cumOil: number; preShutOil: number
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
export const median = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
export const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i)
  return s[lo] + (s[hi] - s[lo]) * (i - lo)
}
const val = (a: Num[], t: number) => (t >= 0 && t < a.length ? a[t] : null)

function windowAvg(a: Num[], t: number, n = 3, positiveOnly = false): number | null {
  const xs: number[] = []
  for (let k = t - n + 1; k <= t; k++) {
    const v = val(a, k)
    if (v != null && (!positiveOnly || v > 0)) xs.push(v)
  }
  return xs.length ? mean(xs) : null
}

/** Monthly productivity index series: liquid / (Pres - Pwf). */
export function piSeries(ds: Dataset, w: Well, a: Assumptions): (number | null)[] {
  return w.m.oil.map((o, t) => {
    const liq = (o ?? 0) + Math.max(0, w.m.wat[t] ?? 0)
    const pwf = w.m.bhp[t]
    const up = (w.m.hrs[t] ?? 24) / 24
    if (!liq || pwf == null || pwf <= 0 || up < 0.3) return null
    const dp = presAt(ds, w, t, a) - pwf
    return dp > 5 ? liq / up / dp : null // per producing day, so downtime does not read as damage
  })
}

const refCache = new WeakMap<Well, { key: string; piRef: number | null; wcRef: number }>()
export function piReference(ds: Dataset, w: Well, a: Assumptions) {
  const key = `${a.volvePres}`
  const c = refCache.get(w)
  if (c && c.key === key) return c
  const pis = piSeries(ds, w, a)
  const early: number[] = [], wcs: number[] = []
  for (let t = w.first; t < pis.length && early.length < 18; t++) {
    const p = pis[t]
    if (p == null) continue
    early.push(p)
    const o = w.m.oil[t] ?? 0, wa = Math.max(0, w.m.wat[t] ?? 0)
    wcs.push(o + wa > 0 ? wa / (o + wa) : 0)
  }
  const r = { key, piRef: early.length >= 3 ? quantile(early, 0.8) : null, wcRef: mean(wcs) }
  refCache.set(w, r)
  return r
}

export function wellMetrics(ds: Dataset, w: Well, t: number, a: Assumptions): Metrics {
  const pres = presAt(ds, w, t, a)
  const pwfMin = pwfMinFor(ds, w, a)
  const base: Metrics = {
    id: w.id, status: 'notyet', oil: 0, wat: 0, liq: 0, gas: 0, wc: 0, gor: 0, bhp: null, whp: null, choke: null,
    pres, pwfMin, pi: null, piRef: null, piExp: null, gapDamage: 0, gapLift: 0, gapWater: 0, gapIdle: 0, gap: 0,
    cumOil: 0, preShutOil: 0,
  }
  for (let k = 0; k <= Math.min(t, w.m.oil.length - 1); k++) base.cumOil += (w.m.oil[k] ?? 0) * 30.44
  if (w.type === 'injector') return { ...base, status: 'injector' }
  if (t < w.first) return base

  const oil = windowAvg(w.m.oil, t) ?? 0
  const wat = Math.max(0, windowAvg(w.m.wat, t) ?? 0)
  const gas = windowAvg(w.m.gas, t) ?? 0
  const recentOn = [0, 1, 2].some(k => (val(w.m.oil, t - k) ?? 0) > 0)
  if (!recentOn) {
    // idle: remember what it made before it stopped
    let k = t
    while (k > w.first && !((w.m.oil[k] ?? 0) > 0)) k--
    const pre = windowAvg(w.m.oil, k, 6, true) ?? 0
    return { ...base, status: 'idle', preShutOil: pre, gapIdle: pre * 0.7, gap: pre * 0.7 }
  }
  const liq = oil + wat
  const wc = liq > 0 ? wat / liq : 0
  const bhp = windowAvg(w.m.bhp, t, 3, true)
  const whp = windowAvg(w.m.whp, t, 3, true)
  const choke = windowAvg(w.m.choke, t, 3, true)
  const { piRef, wcRef } = piReference(ds, w, a)
  const up = Math.min(1, Math.max(0.3, (windowAvg(w.m.hrs, t) ?? 24) / 24))
  const pi = bhp != null && pres - bhp > 5 ? liq / up / (pres - bhp) : null
  const piExp = piRef != null ? (piRef * (1 - WC_PI_PENALTY * wc)) / (1 - WC_PI_PENALTY * wcRef) : null

  let gapDamage = 0, gapLift = 0
  // technical potential, capped at what the tubing and facilities could plausibly take
  if (pi != null && piExp != null && bhp != null && pi < 0.8 * piExp) gapDamage = Math.min(oil * 1.5, (piExp - pi) * (pres - bhp) * (1 - wc) * up)
  if (pi != null && bhp != null && bhp - pwfMin > 15) gapLift = Math.min(oil, pi * (bhp - pwfMin) * (1 - wc) * up)
  return {
    ...base, status: 'flowing', oil, wat, liq, gas, wc, gor: oil > 0 ? gas / oil : 0, bhp, whp, choke,
    pi, piRef, piExp, gapDamage, gapLift,
  }
}

/** Metrics for every well at month t, including the population-relative water gap. */
export function fieldMetrics(ds: Dataset, t: number, a: Assumptions): Map<string, Metrics> {
  const out = new Map<string, Metrics>()
  ds.wells.forEach(w => out.set(w.id, wellMetrics(ds, w, t, a)))
  const flowing = [...out.values()].filter(m => m.status === 'flowing')
  const wcMed = median(flowing.map(m => m.wc))
  for (const m of flowing) {
    if (m.wc > 0.5 && m.wc > wcMed + 0.15) m.gapWater = Math.min(m.oil * 1.5, (m.oil * (m.wc - wcMed)) / (1 - m.wc) * 0.35)
    m.gap = m.gapDamage + m.gapLift + m.gapWater
  }
  return out
}

export interface HIPoint { id: string; hiOil: number; hiWat: number; idle: boolean }

/** Heterogeneity Index: each well's rate relative to its offset group's mean (0 = average). */
export function heterogeneity(ds: Dataset, metrics: Map<string, Metrics>, groupBy: 'block' | 'field'): HIPoint[] {
  const groups = new Map<string, Well[]>()
  for (const w of ds.producers) {
    const g = groupBy === 'block' ? w.block : 'field'
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(w)
  }
  const pts: HIPoint[] = []
  for (const ws of groups.values()) {
    const live = ws.map(w => metrics.get(w.id)!).filter(m => m.status === 'flowing')
    const mo = mean(live.map(m => m.oil)) || 1, mw = mean(live.map(m => m.wat)) || 1
    for (const w of ws) {
      const m = metrics.get(w.id)!
      if (m.status === 'notyet') continue
      if (m.status === 'idle') pts.push({ id: w.id, hiOil: -1, hiWat: -1, idle: true })
      else pts.push({ id: w.id, hiOil: m.oil / mo - 1, hiWat: m.wat / mw - 1, idle: false })
    }
  }
  return pts
}

/** Last month index with any production in the dataset. */
export function latestMonth(ds: Dataset): number {
  return Math.max(...ds.wells.map(w => w.last))
}
