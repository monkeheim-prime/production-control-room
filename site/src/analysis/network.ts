// Surface network: wells → manifolds (flowlines) → separator → oil export / gas compression / water treatment.
// Facility capacities are linear constraints on the wells' choke-back fractions; the oil-maximising
// allocation is a small linear programme solved exactly with a dense simplex.
import type { Dataset } from '../core/data'
import type { Assumptions } from '../core/state'
import { review } from './diagnose'

export interface NetWell { id: string; man: string; oil: number; wat: number; gas: number; liq: number; wc: number }
export interface Network {
  wells: NetWell[]                 // flowing producers, potential = latest 3-month rates (Sm³/d)
  manifolds: { id: string; wells: string[]; liq: number }[]
  injection: number                // current water injection, Sm³/d
  pot: { oil: number; wat: number; gas: number; liq: number }
}
export interface Caps { liq: number; wat: number; gas: number; oil: number; line: number } // Sm³/d; `line` per manifold, liquid
export type ConKey = 'liq' | 'wat' | 'gas' | 'oil' | 'line'
export const CON_LABEL: Record<ConKey, string> = { wat: 'Water handling', liq: 'Separator liquid', gas: 'Gas compression', oil: 'Oil export', line: 'Flowline' }
export type Rule = 'opt' | 'pro'

export interface Alloc {
  f: Map<string, number>           // choke-back fraction per well, 1 = full potential
  oil: number; wat: number; gas: number; liq: number
  manLiq: Map<string, number>
  util: Record<ConKey, number>     // allocated / capacity (line = worst manifold)
  binding: ConKey[]                // constraints at ≥ 99.5 % of capacity
}

const avg3 = (a: (number | null)[], t: number) => {
  const xs: number[] = []
  for (let k = t - 2; k <= t; k++) { const v = a[k]; if (v != null) xs.push(v) }
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0
}

export function buildNetwork(ds: Dataset, a: Assumptions): Network {
  const rv = review(ds, a)
  const wells: NetWell[] = []
  for (const w of ds.producers) {
    const m = rv.metrics.get(w.id)
    if (!m || m.status !== 'flowing' || m.oil <= 0) continue
    wells.push({ id: w.id, man: ds.id === 'volve' ? 'Main' : w.block, oil: m.oil, wat: m.wat, gas: Math.max(0, m.gas), liq: m.oil + m.wat, wc: m.wc })
  }
  wells.sort((x, y) => x.man.localeCompare(y.man) || x.wc - y.wc)
  const ids = [...new Set(wells.map(w => w.man))]
  const manifolds = ids.map(id => {
    const ws = wells.filter(w => w.man === id)
    return { id, wells: ws.map(w => w.id), liq: ws.reduce((s, w) => s + w.liq, 0) }
  })
  const injection = ds.injectors.reduce((s, w) => s + Math.max(0, avg3(w.m.wi, rv.t)), 0)
  const sum = (k: 'oil' | 'wat' | 'gas' | 'liq') => wells.reduce((s, w) => s + w[k], 0)
  return { wells, manifolds, injection, pot: { oil: sum('oil'), wat: sum('wat'), gas: sum('gas'), liq: sum('liq') } }
}

/** Illustrative defaults: water handling binds (typical late life), the rest has some headroom. */
export function defaultCaps(n: Network): Caps {
  const nice = (v: number) => { const p = 10 ** Math.floor(Math.log10(Math.max(v, 1))) / 2; return Math.round(v / p) * p }
  return {
    wat: nice(n.pot.wat * 0.85),
    liq: nice(n.pot.liq * 1.04),
    gas: nice(n.pot.gas * 1.15),
    oil: nice(n.pot.oil * 1.25),
    line: nice(Math.max(...n.manifolds.map(m => m.liq), 1) * 1.15),
  }
}

// ---------- dense simplex: maximise c·x subject to A x ≤ b, x ≥ 0, with b ≥ 0 (origin feasible) ----------
export function simplex(c: number[], A: number[][], b: number[]): number[] {
  const m = A.length, n = c.length
  // tableau rows: [A | I | b], objective row: [-c | 0 | 0]
  const T = A.map((row, i) => [...row, ...Array.from({ length: m }, (_, j) => (i === j ? 1 : 0)), b[i]])
  const z = [...c.map(v => -v), ...new Array(m).fill(0), 0]
  const basis = Array.from({ length: m }, (_, i) => n + i)
  const W = n + m
  for (let it = 0; it < 500; it++) {
    let col = -1
    for (let j = 0; j < W; j++) if (z[j] < -1e-9) { col = j; break } // Bland's rule: no cycling
    if (col < 0) break
    let row = -1, best = Infinity
    for (let i = 0; i < m; i++) {
      if (T[i][col] > 1e-12) {
        const r = T[i][W] / T[i][col]
        if (r < best - 1e-12 || (Math.abs(r - best) <= 1e-12 && basis[i] < basis[row])) { best = r; row = i }
      }
    }
    if (row < 0) break // unbounded — cannot happen here, every x ≤ 1
    const pv = T[row][col]
    for (let j = 0; j <= W; j++) T[row][j] /= pv
    for (let i = 0; i < m; i++) {
      if (i === row || !T[i][col]) continue
      const k = T[i][col]
      for (let j = 0; j <= W; j++) T[i][j] -= k * T[row][j]
    }
    const k = z[col]
    for (let j = 0; j <= W; j++) z[j] -= k * T[row][j]
    basis[row] = col
  }
  const x = new Array(n).fill(0)
  basis.forEach((bv, i) => { if (bv < n) x[bv] = T[i][W] })
  return x
}

function finish(n: Network, caps: Caps, f: Map<string, number>): Alloc {
  let oil = 0, wat = 0, gas = 0, liq = 0
  const manLiq = new Map<string, number>()
  for (const w of n.wells) {
    const k = f.get(w.id) ?? 1
    oil += w.oil * k; wat += w.wat * k; gas += w.gas * k; liq += w.liq * k
    manLiq.set(w.man, (manLiq.get(w.man) ?? 0) + w.liq * k)
  }
  const util: Record<ConKey, number> = {
    wat: wat / caps.wat, liq: liq / caps.liq, gas: gas / caps.gas, oil: oil / caps.oil,
    line: Math.max(0, ...[...manLiq.values()].map(v => v / caps.line)),
  }
  const binding = (Object.keys(util) as ConKey[]).filter(k => util[k] >= 0.995).sort((x, y) => util[y] - util[x])
  return { f, oil, wat, gas, liq, manLiq, util, binding }
}

/** Oil-maximising choke-back: LP over fractions f_i ∈ [0, 1]. */
export function allocOptimal(n: Network, caps: Caps): Alloc {
  const N = n.wells.length
  if (!N) return finish(n, caps, new Map())
  const A: number[][] = [], b: number[] = []
  A.push(n.wells.map(w => w.wat)); b.push(caps.wat)
  A.push(n.wells.map(w => w.liq)); b.push(caps.liq)
  A.push(n.wells.map(w => w.gas)); b.push(caps.gas)
  A.push(n.wells.map(w => w.oil)); b.push(caps.oil)
  for (const m of n.manifolds) { A.push(n.wells.map(w => (w.man === m.id ? w.liq : 0))); b.push(caps.line) }
  n.wells.forEach((_, i) => { A.push(n.wells.map((__, j) => (i === j ? 1 : 0))); b.push(1) })
  // scale rows to O(1) so the pivot tolerances mean the same thing for every constraint
  A.forEach((row, i) => { const s = Math.max(...row.map(Math.abs), 1e-9); A[i] = row.map(v => v / s); b[i] /= s })
  const x = simplex(n.wells.map(w => w.oil), A, b)
  return finish(n, caps, new Map(n.wells.map((w, i) => [w.id, Math.min(1, Math.max(0, x[i]))])))
}

/** Pro-rata: every well on a manifold cut by the same factor, then the whole field cut by one factor. */
export function allocProRata(n: Network, caps: Caps): Alloc {
  const f = new Map<string, number>()
  for (const m of n.manifolds) { const k = Math.min(1, caps.line / Math.max(m.liq, 1e-9)); m.wells.forEach(id => f.set(id, k)) }
  const tot = (key: 'oil' | 'wat' | 'gas' | 'liq') => n.wells.reduce((s, w) => s + w[key] * f.get(w.id)!, 0)
  const g = Math.min(1, caps.wat / Math.max(tot('wat'), 1e-9), caps.liq / Math.max(tot('liq'), 1e-9),
    caps.gas / Math.max(tot('gas'), 1e-9), caps.oil / Math.max(tot('oil'), 1e-9))
  for (const w of n.wells) f.set(w.id, f.get(w.id)! * g)
  return finish(n, caps, f)
}

export const allocate = (n: Network, caps: Caps, rule: Rule) => (rule === 'opt' ? allocOptimal(n, caps) : allocProRata(n, caps))

// ---------- what-if debottlenecking ----------
export const WSO_WATER_CUT = 0.5 // assumed: a successful water shut-off removes half the well's water

export interface WhatIf { key: string; label: string; oil: number; gain: number; note: string }

export function whatIfs(ds: Dataset, a: Assumptions, n: Network, caps: Caps, rule: Rule, pctUp: number, topN: number): WhatIf[] {
  const base = allocate(n, caps, rule).oil
  const out: WhatIf[] = []
  const add = (key: string, label: string, oil: number, note: string) => out.push({ key, label, oil, gain: oil - base, note })
  const up = 1 + pctUp / 100
  add('wat', `+${pctUp} % water handling`, allocate(n, { ...caps, wat: caps.wat * up }, rule).oil, 'new water treatment / injection capacity')
  add('liq', `+${pctUp} % separator liquid`, allocate(n, { ...caps, liq: caps.liq * up }, rule).oil, 'separator internals / second train')
  add('gas', `+${pctUp} % gas compression`, allocate(n, { ...caps, gas: caps.gas * up }, rule).oil, 'compressor re-wheel / added stage')
  add('line', `+${pctUp} % flowline capacity`, allocate(n, { ...caps, line: caps.line * up }, rule).oil, 'looping / larger flowline')
  const worst = [...n.wells].sort((x, y) => y.wc - x.wc).slice(0, topN).map(w => w.id)
  if (worst.length) {
    const shut: Network = { ...n, wells: n.wells.filter(w => !worst.includes(w.id)) }
    add('shut', `Shut in top ${worst.length} water-cut well${worst.length > 1 ? 's' : ''}`, allocate(shut, caps, rule).oil, `${worst.join(', ')}${rule === 'opt' ? ' — fully shut; the optimiser already chokes them only as far as needed' : ''}`)
  }
  // water shut-off jobs proposed in the review (Diagnose → Evaluate), risked
  const opps = review(ds, a).opps.filter(o => o.cat === 'water' && n.wells.some(w => w.id === o.well))
  if (opps.length) {
    const wells = n.wells.map(w => {
      const o = opps.find(x => x.well === w.id)
      if (!o) return w
      const oil = w.oil + o.gain * o.ps, wat = w.wat * (1 - WSO_WATER_CUT * o.ps)
      return { ...w, oil, wat, liq: oil + wat, wc: wat / (oil + wat) }
    })
    add('wso', `Water shut-off jobs from the review (${opps.length})`, allocate({ ...n, wells }, caps, rule).oil, opps.map(o => o.well).join(', '))
  }
  return out.sort((x, y) => y.gain - x.gain)
}

/** Field monthly oil/water history, for the "when did water handling start to bind" chart. */
export function fieldHistory(ds: Dataset): { t: number; date: Date; oil: number; wat: number }[] {
  return ds.months.map((date, t) => {
    let oil = 0, wat = 0
    for (const w of ds.producers) { oil += w.m.oil[t] ?? 0; wat += Math.max(0, w.m.wat[t] ?? 0) }
    return { t, date, oil, wat }
  }).filter(r => r.oil + r.wat > 0)
}
