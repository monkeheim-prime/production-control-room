// Intervention economics and the budget/rig-constrained portfolio optimiser.
import type { Assumptions } from '../core/state'
import { toBbl } from '../core/units'

export type Cat = 'water' | 'stim' | 'lift' | 'mech'
export type OppType = 'wso' | 'wsoCone' | 'stim' | 'glr' | 'esp' | 'gli' | 'choke' | 'sand' | 'react' | 'conf' | 'istim'

// Costs, success probabilities and rig days are generic illustrative figures, editable in one place.
export const OPP_TYPES: Record<OppType, { label: string; cat: Cat; cost: number; ps: number; rig: number; risk: [number, number]; riskText: string }> = {
  wso: { label: 'Water shut-off (zonal isolation)', cat: 'water', cost: 1.6e6, ps: 0.6, rig: 12, risk: [2, 2], riskText: 'Isolation may not hold, or water entry is not where the PLT suggests' },
  wsoCone: { label: 'Water shut-off / drawdown control', cat: 'water', cost: 0.9e6, ps: 0.5, rig: 8, risk: [2, 2], riskText: 'Cone may re-form; lower drawdown also lowers oil' },
  stim: { label: 'Matrix acid stimulation', cat: 'stim', cost: 0.8e6, ps: 0.7, rig: 6, risk: [1, 2], riskText: 'Damage may be scale or fines needing a different treatment' },
  glr: { label: 'Gas lift redesign (rigless)', cat: 'lift', cost: 0.25e6, ps: 0.85, rig: 3, risk: [1, 1], riskText: 'Lift gas availability is shared across the field' },
  esp: { label: 'ESP resize / VSD retune', cat: 'lift', cost: 1.8e6, ps: 0.75, rig: 10, risk: [2, 2], riskText: 'Run-life and power constraints' },
  gli: { label: 'Install gas lift (workover)', cat: 'lift', cost: 2.6e6, ps: 0.7, rig: 16, risk: [2, 3], riskText: 'Workover risk; needs lift-gas capacity' },
  choke: { label: 'Choke optimisation', cat: 'lift', cost: 0.05e6, ps: 0.85, rig: 0, risk: [1, 1], riskText: 'Reason for the choke-back must be confirmed (sand, water, separator)' },
  sand: { label: 'Sand control', cat: 'mech', cost: 2.2e6, ps: 0.55, rig: 14, risk: [3, 2], riskText: 'Screens can plug; productivity impairment' },
  react: { label: 'Idle well reactivation', cat: 'mech', cost: 1.5e6, ps: 0.6, rig: 10, risk: [2, 3], riskText: 'Integrity or fishing issues found on re-entry' },
  conf: { label: 'Injector conformance treatment', cat: 'mech', cost: 1.4e6, ps: 0.5, rig: 8, risk: [3, 2], riskText: 'Gel placement uncertain in a fractured injector' },
  istim: { label: 'Injector stimulation', cat: 'stim', cost: 0.6e6, ps: 0.75, rig: 5, risk: [1, 1], riskText: 'Plugging may recur without better water treatment' },
}

export const CAT_LABEL: Record<Cat, string> = { water: 'Water control', stim: 'Stimulation', lift: 'Lift / choke', mech: 'Mechanical & idle' }
export const CAT_COLOR: Record<Cat, string> = { water: 'var(--cat-water)', stim: 'var(--cat-stim)', lift: 'var(--cat-lift)', mech: 'var(--cat-mech)' }

export interface Econ { pv: number; npv: number; rnpv: number; payback: number | null; profile: number[] }

const HORIZON = 60

/** gain in Sm3/d of oil at month 0, declining exponentially. */
export function econ(gainSm3d: number, cost: number, ps: number, a: Assumptions): Econ {
  let pv = 0, cum = 0
  let payback: number | null = null
  const profile: number[] = []
  for (let m = 0; m < HORIZON; m++) {
    const q = toBbl(gainSm3d) * Math.exp(-a.gainDecline * m / 12)
    const cash = q * 30.44 * (a.oilPrice - a.opex)
    pv += cash / Math.pow(1 + a.discount, (m + 0.5) / 12)
    cum += cash
    profile.push(cum - cost)
    if (payback == null && cum >= cost) payback = m + 1
  }
  return { pv, npv: pv - cost, rnpv: ps * pv - cost, payback, profile }
}

/** 0/1 knapsack on cost and rig days, maximising risked NPV. Returns selected ids in pick order. */
export function optimise(items: { id: string; cost: number; rig: number; value: number }[], budget: number, rigDays: number): string[] {
  const unit = 50e3
  const B = Math.max(0, Math.floor(budget / unit)), R = Math.max(0, Math.floor(rigDays))
  const cand = items.filter(i => i.value > 0)
  const W = cand.map(i => Math.ceil(i.cost / unit))
  // dp over (budget, rig) with item-by-item tables for reconstruction
  let dp = new Float64Array((B + 1) * (R + 1))
  const keep: Uint8Array[] = []
  for (let k = 0; k < cand.length; k++) {
    const nd = dp.slice()
    const kk = new Uint8Array((B + 1) * (R + 1))
    const w = W[k], r = cand[k].rig, v = cand[k].value
    for (let b = w; b <= B; b++) {
      for (let d = r; d <= R; d++) {
        const alt = dp[(b - w) * (R + 1) + (d - r)] + v
        if (alt > nd[b * (R + 1) + d]) { nd[b * (R + 1) + d] = alt; kk[b * (R + 1) + d] = 1 }
      }
    }
    keep.push(kk); dp = nd
  }
  const out: string[] = []
  let b = B, d = R
  for (let k = cand.length - 1; k >= 0; k--) {
    if (keep[k][b * (R + 1) + d]) { out.push(cand[k].id); b -= W[k]; d -= cand[k].rig }
  }
  const byId = new Map(cand.map(c => [c.id, c]))
  return out.sort((x, y) => byId.get(y)!.value / byId.get(y)!.cost - byId.get(x)!.value / byId.get(x)!.cost)
}
