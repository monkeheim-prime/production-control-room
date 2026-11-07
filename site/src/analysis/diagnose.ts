// Rule-based well diagnosis and opportunity generation. Every rule is visible in the Methods drawer.
import type { Dataset, Well } from '../core/data'
import { pwfMinFor } from '../core/data'
import type { Assumptions } from '../core/state'
import { chan, type ChanResult } from './chan'
import { econ, OPP_TYPES, type Cat, type Econ, type OppType } from './econ'
import { connectivity, hall, type HallResult } from './hall'
import { fieldMetrics, latestMonth, type Metrics } from './metrics'

export type Mech = 'channeling' | 'coning' | 'damage' | 'lift' | 'choke' | 'sand' | 'idle'
export const MECH_LABEL: Record<Mech, string> = {
  channeling: 'Water channeling', coning: 'Water coning', damage: 'Near-well damage / skin',
  lift: 'Lift under-performance', choke: 'Choke restriction', sand: 'Sand production', idle: 'Idle well',
}
export const MECH_CAT: Record<Mech, Cat> = {
  channeling: 'water', coning: 'water', damage: 'stim', lift: 'lift', choke: 'lift', sand: 'mech', idle: 'mech',
}
// Field X truth labels -> our mechanism keys, for the "reveal answer" check.
export const TRUTH_TO_MECH: Record<string, Mech | 'healthy'> = {
  healthy: 'healthy', channeling: 'channeling', coning: 'coning', damage: 'damage', gaslift_sub: 'lift',
  idle: 'idle', sand: 'sand', choke: 'choke',
}

export interface Hyp { key: Mech; score: number; evidence: string }
export interface Diagnosis {
  well: Well; m: Metrics; chan: ChanResult
  symptoms: { text: string; on: boolean }[]
  hyps: Hyp[]; primary: Hyp | null
  dataGaps: string[]
}

const sig = (x: number) => 1 / (1 + Math.exp(-x))
const pctTxt = (x: number) => `${Math.round(x * 100)} %`

export function diagnoseProducer(ds: Dataset, w: Well, m: Metrics, a: Assumptions): Diagnosis {
  const c = chan(w)
  const hyps: Hyp[] = []
  const sym: { text: string; on: boolean }[] = []
  const lastT = latestMonth(ds)

  if (m.status === 'idle') {
    hyps.push({ key: 'idle', score: 1, evidence: `No production for the last ≥ 3 months; made {q:${m.preShutOil}} before shut-in` })
  }
  // water
  sym.push({ text: `Water cut ${pctTxt(m.wc)}`, on: m.wc > 0.6 })
  if (c.breakthrough != null) {
    sym.push({ text: c.earlyBt ? 'Early water breakthrough (< 22 % of producing life)' : 'Water breakthrough after plateau', on: c.earlyBt })
    if (c.slopeDer != null) sym.push({ text: `WOR′ late slope ${c.slopeDer.toFixed(2)} on log–log`, on: c.slopeDer > 1.4 })
  }
  const strongLink = (w.links ?? []).find(l => l.w >= 0.6)
  let chScore = c.scores.channeling
  if (strongLink && m.wc > 0.6) chScore = Math.min(1, chScore + 0.15)
  chScore *= sig((m.wc - 0.7) * 12) // channeling needs a high, still-rising water cut
  hyps.push({ key: 'channeling', score: chScore, evidence: `Chan derivative slope ${c.slopeDer?.toFixed(2) ?? '—'}${strongLink ? `; strong link to ${strongLink.inj}` : ''}` })
  hyps.push({ key: 'coning', score: m.wc < 0.3 ? c.scores.coning * 0.3 : c.scores.coning, evidence: c.earlyBt ? 'Early breakthrough, then flattening WOR′' : 'Breakthrough not early' })

  // productivity
  if (m.pi != null && m.piExp != null) {
    const ratio = m.pi / m.piExp
    sym.push({ text: `PI ${pctTxt(ratio)} of water-cut-adjusted early-life PI`, on: ratio < 0.75 })
    hyps.push({ key: 'damage', score: sig((0.72 - ratio) * 14), evidence: `PI now {pi:${m.pi}} vs expected {pi:${m.piExp}}` })
  }
  // lift and choke
  const pwfMin = pwfMinFor(ds, w, a)
  if (m.bhp != null && m.bhp >= m.pres - 5) {
    sym.push({ text: `Flowing BHP ≥ reservoir pressure used ({p:${m.pres}}) — check the pressure assumption`, on: true })
  } else if (m.bhp != null) {
    const excess = m.bhp - pwfMin
    sym.push({ text: `Flowing BHP {dp:${excess}} above achievable minimum`, on: excess > 30 })
    const choked = m.choke != null && m.choke < 32
    if (m.choke != null) sym.push({ text: `Choke ${Math.round(m.choke)} % open`, on: choked })
    const liftScore = sig((excess - 32) / 7)
    hyps.push({ key: choked ? 'choke' : 'lift', score: liftScore, evidence: `Pwf {p:${m.bhp}} vs {p:${pwfMin}} lift limit${choked ? `, choke ${Math.round(m.choke!)} %` : ''}` })
  }
  const sandEv = w.events.filter(e => e.type === 'sand').length
  if (sandEv) {
    sym.push({ text: `${sandEv} sand events in history`, on: sandEv >= 2 })
    hyps.push({ key: 'sand', score: Math.min(0.95, 0.3 * sandEv), evidence: `${sandEv} sand-related choke-backs` })
  }

  hyps.sort((x, y) => y.score - x.score)
  const primary = hyps.length && hyps[0].score >= 0.5 ? hyps[0] : null

  const gaps: string[] = []
  const lastTest = w.tests.length ? w.tests[w.tests.length - 1].t : null
  if (lastTest == null || lastT - lastTest > 12) gaps.push('Multi-rate well test — confirm PI and IPR (no test in the last 12 months)')
  if (w.qa.some(q => q.rule === 'bhp_missing')) gaps.push('Downhole gauge — restore or verify (pressure gaps in record)')
  for (const h of hyps.filter(h => h.score >= 0.5)) {
    if (h.key === 'channeling' || h.key === 'coning') gaps.push('Production logging (PLT) — locate water entry before isolation design')
    if (h.key === 'channeling') gaps.push('Cement bond log — rule out channel behind casing')
    if (h.key === 'damage') gaps.push('Pressure build-up — quantify skin before stimulation')
    if (h.key === 'lift') gaps.push('Flowing gradient survey — confirm lift injection depth and valve status')
    if (h.key === 'choke') gaps.push('Choke step test — find the sand-free / stable maximum rate')
    if (h.key === 'sand') gaps.push('Sand sampling and acoustic monitoring — size sand control')
    if (h.key === 'idle') gaps.push('Slickline drift and integrity test — before reactivation')
  }
  return { well: w, m, chan: c, symptoms: sym, hyps, primary, dataGaps: [...new Set(gaps)] }
}

export interface InjDiagnosis { well: Well; hall: HallResult; links: { prod: string; r: number }[]; verdict: string; next: string[] }

export function diagnoseInjector(ds: Dataset, w: Well, a: Assumptions): InjDiagnosis {
  const h = hall(ds, w, a)
  const links = connectivity(ds, w).map(l => ({ prod: l.prod, r: l.r })).sort((x, y) => y.r - x.r)
  const next: string[] = []
  let verdict = 'Injection pressure not recorded — Hall analysis not possible from this data.'
  if (h.verdict === 'fracture') {
    verdict = 'Hall derivative falls below the integral: injection is likely going into an induced fracture or a high-permeability channel.'
    next.push('Step-rate test — confirm fracture pressure', 'Inter-well tracer — confirm which producers are short-circuited', 'Screen conformance options')
  } else if (h.verdict === 'plugging') {
    verdict = 'Hall derivative rises above the integral: injectivity is declining (plugging / skin build-up).'
    next.push('Water quality audit — solids, oil-in-water, bacteria', 'Fall-off test — quantify skin', 'Plan acid / back-flush')
  } else if (h.verdict === 'matrix') {
    verdict = 'Integral and derivative overlap: stable matrix injection.'
    next.push('Keep surveillance; repeat Hall analysis quarterly')
  } else {
    next.push('Install or recover injection pressure data (WHP at minimum)', 'Use rate-only connectivity and VRR in the meantime')
  }
  return { well: w, hall: h, links, verdict, next }
}

export interface Opportunity {
  id: string; well: string; type: OppType; label: string; cat: Cat; mech: Mech | 'inj'
  gain: number; p10: number; p90: number; cost: number; ps: number; rig: number
  risk: [number, number]; riskText: string; rationale: string; preJob: string[]
  e: Econ
}

export const REALISABLE = 0.5 // share of modelled technical potential booked as P50

function opp(well: string, type: OppType, mech: Mech | 'inj', gain: number, rationale: string, preJob: string[], a: Assumptions): Opportunity {
  const T = OPP_TYPES[type]
  const g = Math.max(gain * REALISABLE, 1)
  return {
    id: `${well}·${type}`, well, type, label: T.label, cat: T.cat, mech, gain: g, p10: g * 1.7, p90: g * 0.4,
    cost: T.cost, ps: T.ps, rig: T.rig, risk: T.risk, riskText: T.riskText, rationale, preJob, e: econ(g, T.cost, T.ps, a),
  }
}

export interface Review { t: number; metrics: Map<string, Metrics>; dx: Map<string, Diagnosis>; inj: Map<string, InjDiagnosis>; opps: Opportunity[] }

const cache = new WeakMap<Dataset, { key: string; r: Review }>()

/** Run the full review for a dataset at its latest month. */
export function review(ds: Dataset, a: Assumptions): Review {
  const key = JSON.stringify(a)
  const c = cache.get(ds)
  if (c && c.key === key) return c.r
  const t = latestMonth(ds)
  const metrics = fieldMetrics(ds, t, a)
  const dx = new Map<string, Diagnosis>()
  const opps: Opportunity[] = []
  for (const w of ds.producers) {
    const m = metrics.get(w.id)!
    if (m.status === 'notyet') continue
    const d = diagnoseProducer(ds, w, m, a)
    dx.set(w.id, d)
    const used = new Set<Cat>()
    for (const h of d.hyps.filter(h => h.score >= 0.5).slice(0, 2)) {
      const cat = MECH_CAT[h.key]
      if (used.has(cat)) continue
      used.add(cat)
      const pre = d.dataGaps.filter(g => !g.startsWith('Multi-rate') || h.key === 'damage')
      if (h.key === 'channeling') opps.push(opp(w.id, 'wso', h.key, Math.max(m.gapWater, m.oil * 0.25), h.evidence, pre, a))
      if (h.key === 'coning') opps.push(opp(w.id, 'wsoCone', h.key, Math.max(m.gapWater * 0.7, m.oil * 0.15), h.evidence, pre, a))
      if (h.key === 'damage') opps.push(opp(w.id, 'stim', h.key, Math.max(m.gapDamage, m.oil * 0.2), h.evidence, pre, a))
      if (h.key === 'lift') {
        const type: OppType = w.lift === 'Gas lift' ? 'glr' : w.lift === 'ESP' ? 'esp' : 'gli'
        opps.push(opp(w.id, type, h.key, m.gapLift, h.evidence, pre, a))
      }
      if (h.key === 'choke') opps.push(opp(w.id, 'choke', h.key, m.gapLift * 0.8, h.evidence, pre, a))
      if (h.key === 'sand') opps.push(opp(w.id, 'sand', h.key, m.oil * 0.25, h.evidence, pre, a))
      if (h.key === 'idle') opps.push(opp(w.id, 'react', h.key, m.gapIdle, h.evidence, pre, a))
    }
  }
  const inj = new Map<string, InjDiagnosis>()
  for (const w of ds.injectors) {
    const d = diagnoseInjector(ds, w, a)
    inj.set(w.id, d)
    if (d.hall.verdict === 'fracture' || d.hall.verdict === 'plugging') {
      const linked = d.links.filter(l => l.r > 0.25).map(l => metrics.get(l.prod)?.oil ?? 0)
      const support = linked.reduce((s, v) => s + v, 0)
      if (d.hall.verdict === 'fracture') opps.push(opp(w.id, 'conf', 'inj', support * 0.12, d.verdict, d.next, a))
      else opps.push(opp(w.id, 'istim', 'inj', support * 0.06, d.verdict, d.next, a))
    }
  }
  opps.sort((x, y) => y.e.rnpv - x.e.rnpv)
  const r = { t, metrics, dx, inj, opps }
  cache.set(ds, { key, r })
  return r
}

export const STAGES = ['Identified', 'Evaluated', 'Approved', 'Executed', 'Rejected'] as const
export type Stage = typeof STAGES[number]

/** Default maturation stage: cheap, high-confidence jobs already done; the rest by value rank. */
export function defaultStage(o: Opportunity, rank: number, n: number): Stage {
  if (o.e.rnpv <= 0) return 'Rejected'
  if (o.cost <= 0.3e6 && o.ps >= 0.85 && rank < n * 0.5) return 'Executed'
  if (rank < n * 0.35) return 'Approved'
  if (rank < n * 0.7) return 'Evaluated'
  return 'Identified'
}
