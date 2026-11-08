// Gas-lift allocation under limited lift gas: per-well performance curves and the equal-slope optimum.
// Curves are an illustrative concave form calibrated to each well's latest month (real curves come from nodal models).
import type { Dataset, Well } from '../core/data'

export interface GLWell {
  id: string; truth?: string
  gCur: number; qCur: number; wc: number   // latest month: lift gas Sm3/d, oil Sm3/d, water cut
  q0: number; c: number; g1: number; gOpt: number  // curve parameters (Sm3/d)
}

// q(g) = q0 + c · [ (gOpt + g1) · ln(1 + g/g1) − g ]     maximum at g = gOpt
export const qOf = (w: GLWell, g: number) => w.q0 + w.c * ((w.gOpt + w.g1) * Math.log1p(g / w.g1) - g)
export const slopeOf = (w: GLWell, g: number) => w.c * ((w.gOpt + w.g1) / (w.g1 + g) - 1)

/** Deterministic 0–1 value per well id and salt. */
function hash(id: string, salt: number) {
  let x = 2166136261 ^ salt
  for (const ch of id) x = Math.imul(x ^ ch.charCodeAt(0), 16777619)
  return ((x >>> 0) % 10007) / 10007
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

// Shape by mechanism: under-injected wells sit far left of their optimum, inflow-limited and
// high-water-cut wells sit near or past it.
const SHAPE: Record<string, { opt: [number, number]; f0: [number, number] }> = {
  gaslift_sub: { opt: [2.4, 3.2], f0: [0.15, 0.25] },
  healthy: { opt: [1.05, 1.35], f0: [0.2, 0.35] },
  damage: { opt: [0.95, 1.2], f0: [0.25, 0.4] },
  channeling: { opt: [0.85, 1.1], f0: [0.3, 0.45] },
  coning: { opt: [0.9, 1.15], f0: [0.3, 0.45] },
}

export function gasLiftWells(ds: Dataset): GLWell[] {
  const t = ds.months.length - 1
  const latest = (w: Well) => {
    // mean of the last 3 months smooths monthly noise
    const o: number[] = [], g: number[] = [], wa: number[] = []
    for (let k = t; k > t - 3 && k >= 0; k--) { o.push(w.m.oil[k] ?? 0); g.push(w.m.gl[k] ?? 0); wa.push(Math.max(0, w.m.wat[k] ?? 0)) }
    const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length
    return { o: avg(o), g: avg(g), wa: avg(wa) }
  }
  return ds.producers.filter(w => w.lift === 'Gas lift').flatMap(w => {
    const L = latest(w)
    if (L.o <= 0 || L.g <= 0 || (w.m.oil[t] ?? 0) <= 0) return []
    const sh = SHAPE[w.truth ?? ''] ?? SHAPE.healthy
    const gOpt = L.g * lerp(sh.opt[0], sh.opt[1], hash(w.id, 1))
    const f0 = lerp(sh.f0[0], sh.f0[1], hash(w.id, 2))
    const g1 = gOpt * lerp(0.3, 0.55, hash(w.id, 3))
    const F = (g: number) => (gOpt + g1) * Math.log1p(g / g1) - g
    const c = L.o / ((f0 * F(gOpt)) / (1 - f0) + F(L.g))
    const q0 = (f0 * c * F(gOpt)) / (1 - f0)
    return [{ id: w.id, truth: w.truth, gCur: L.g, qCur: L.o, wc: L.wa / (L.o + L.wa), q0, c, g1, gOpt }]
  })
}

/** Gas a well takes at marginal value λ, capped at its optimum and the per-well valve limit. */
function gAt(w: GLWell, lam: number, gMax: number) {
  const g = (w.gOpt + w.g1) / (1 + lam / w.c) - w.g1
  return Math.max(0, Math.min(g, w.gOpt, gMax))
}

export interface Alloc { g: number[]; q: number[]; total: number; lam: number }

const pack = (ws: GLWell[], g: number[], lam = NaN): Alloc => {
  const q = ws.map((w, i) => qOf(w, g[i]))
  return { g, q, total: q.reduce((s, v) => s + v, 0), lam }
}

/** Equal-slope optimum: ∂q_i/∂g_i = λ for every well that receives gas (KKT; curves are concave). */
export function optimise(ws: GLWell[], G: number, gMax = Infinity): Alloc {
  const need = ws.reduce((s, w) => s + Math.min(w.gOpt, gMax), 0)
  if (G >= need) return pack(ws, ws.map(w => Math.min(w.gOpt, gMax)), 0)
  let lo = 0, hi = Math.max(...ws.map(w => slopeOf(w, 0)))
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2
    const s = ws.reduce((a, w) => a + gAt(w, mid, gMax), 0)
    if (s > G) lo = mid; else hi = mid
  }
  const lam = (lo + hi) / 2
  return pack(ws, ws.map(w => gAt(w, lam, gMax)), lam)
}

export const equalSplit = (ws: GLWell[], G: number, gMax = Infinity) => pack(ws, ws.map(() => Math.min(G / ws.length, gMax)))

export function currentRatio(ws: GLWell[], G: number, gMax = Infinity) {
  const cur = ws.reduce((s, w) => s + w.gCur, 0)
  return pack(ws, ws.map(w => Math.min((w.gCur * G) / cur, gMax)))
}

/** Least total gas that, optimally allocated, holds a target oil rate (bisection). */
export function gasToHold(ws: GLWell[], target: number, gMax = Infinity) {
  let lo = 0, hi = ws.reduce((s, w) => s + Math.min(w.gOpt, gMax), 0)
  if (optimise(ws, hi, gMax).total < target) return NaN
  for (let k = 0; k < 50; k++) {
    const mid = (lo + hi) / 2
    if (optimise(ws, mid, gMax).total >= target) hi = mid; else lo = mid
  }
  return hi
}
