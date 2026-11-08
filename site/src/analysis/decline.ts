// Arps decline-curve fitting, probabilistic forecast and hindcast (backtest).
// Arps, J.J. (1945). Analysis of decline curves. Trans. AIME 160, 228–247.
import type { Dataset, Well } from '../core/data'

export const DAYS_PER_MONTH = 30.44

export interface Pt { t: number; q: number }               // t = month index into ds.months, q = Sm3/d
export interface Arps { qi: number; di: number; b: number; t0: number }   // di per month, nominal

/** Rate at month t (q in Sm3/d). b = 0 exponential, 0 < b < 1 hyperbolic, b = 1 harmonic. */
export function arps(p: Arps, t: number): number {
  const dt = Math.max(0, t - p.t0)
  if (p.b < 1e-3) return p.qi * Math.exp(-p.di * dt)
  return p.qi / Math.pow(1 + p.b * p.di * dt, 1 / p.b)
}

export const regime = (b: number) => (b < 0.05 ? 'exponential' : Math.abs(b - 1) < 0.05 ? 'harmonic' : b > 1 ? 'hyperbolic (b > 1, transient)' : 'hyperbolic')
/** Nominal annual decline (fraction/yr) from the monthly nominal rate. */
export const annualDecline = (di: number) => di * 12

/** Producing months: oil > 0 and, where uptime is recorded, at least 12 h/d on average. */
export function producingPoints(w: Well): Pt[] {
  const out: Pt[] = []
  for (let t = w.first; t <= w.last; t++) {
    const q = w.m.oil[t], hrs = w.m.hrs[t]
    if (q == null || q <= 0) continue
    if (hrs != null && hrs < 12) continue
    out.push({ t, q })
  }
  return out
}

const lnq = (p: Arps, t: number) => Math.log(arps(p, t))

// For fixed b and di the least-squares ln(qi) is closed form: mean(ln q − ln f(t)).
function fitQi(pts: Pt[], b: number, di: number, t0: number) {
  let s = 0
  for (const p of pts) s += Math.log(p.q) - lnq({ qi: 1, di, b, t0 }, p.t)
  const qi = Math.exp(s / pts.length)
  let sse = 0
  for (const p of pts) { const r = Math.log(p.q) - lnq({ qi, di, b, t0 }, p.t); sse += r * r }
  return { qi, sse }
}

const DI_MIN = 1e-4, DI_MAX = 0.6

/** Golden-section search on log(di) for fixed b. */
function fitDi(pts: Pt[], b: number, t0: number) {
  const g = (Math.sqrt(5) - 1) / 2
  let lo = Math.log(DI_MIN), hi = Math.log(DI_MAX)
  const f = (x: number) => fitQi(pts, b, Math.exp(x), t0).sse
  let x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo), f1 = f(x1), f2 = f(x2)
  for (let i = 0; i < 48; i++) {
    if (f1 < f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - g * (hi - lo); f1 = f(x1) }
    else { lo = x1; x1 = x2; f1 = f2; x2 = lo + g * (hi - lo); f2 = f(x2) }
  }
  const di = Math.exp((lo + hi) / 2)
  return { di, ...fitQi(pts, b, di, t0) }
}

export const B_GRID = Array.from({ length: 31 }, (_, i) => i * 0.05)

/** Least squares on ln q: grid over b ∈ [0, 1.5], golden section on di, closed-form qi. */
const B_COARSE = B_GRID.filter((_, i) => i % 2 === 0)

export function fitArps(pts: Pt[], t0: number, fixedB: number | null = null, coarse = false): Arps & { sse: number; sigma: number } {
  let best = { qi: pts[0]?.q ?? 1, di: DI_MIN, b: 0, sse: Infinity }
  for (const b of fixedB != null ? [fixedB] : coarse ? B_COARSE : B_GRID) {
    const r = fitDi(pts, b, t0)
    if (r.sse < best.sse) best = { ...r, b }
  }
  const dof = Math.max(1, pts.length - (fixedB != null ? 2 : 3))
  return { ...best, t0, sigma: Math.sqrt(best.sse / dof) }
}

/** Default fit start: the peak rate within the last 48 producing months before the cutoff (keeps ≥ 6 points). */
export function autoStart(pts: Pt[], cutoff: number): number {
  const before = pts.filter(p => p.t < cutoff)
  if (before.length < 6) return before[0]?.t ?? cutoff
  const win = before.slice(Math.max(0, before.length - 48), before.length - 6)
  let pk = win[0]
  for (const p of win) if (p.q > pk.q) pk = p
  return pk.t
}

// Deterministic PRNG so the band does not flicker between redraws.
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Forecast {
  fit: Arps & { sse: number; sigma: number }
  fitPts: Pt[]
  start: number; cutoff: number; end: number
  months: number[]                     // cutoff … end
  p50: number[]; p10: number[]; p90: number[]   // P10 = high case (exceedance convention)
  eur: { p10: number; p50: number; p90: number }  // Sm3, cumulative actual to cutoff + forecast to limit
  cumToCutoff: number
  limitMonth: number | null            // P50 month the rate crosses the economic limit
}


/** Fit on [start, cutoff), forecast to `end`, residual bootstrap for P10/P90 of the trend and EUR. */
export function forecast(w: Well, pts: Pt[], start: number, cutoff: number, end: number, qLimit: number, fixedB: number | null, nBoot = 60, seed = 7): Forecast | null {
  const fitPts = pts.filter(p => p.t >= start && p.t < cutoff)
  if (fitPts.length < 4) return null
  const fit = fitArps(fitPts, start, fixedB)
  const months = Array.from({ length: Math.max(0, end - cutoff + 1) }, (_, i) => cutoff + i)
  let cumToCutoff = 0
  for (let t = w.first; t < cutoff; t++) cumToCutoff += Math.max(0, w.m.oil[t] ?? 0) * DAYS_PER_MONTH

  const tail = (p: Arps) => {   // cumulative from cutoff until q < limit (max 30 yr)
    let c = 0
    for (let t = cutoff; t < cutoff + 360; t++) { const q = arps(p, t); if (q < qLimit) break; c += q * DAYS_PER_MONTH }
    return c
  }
  // residual bootstrap: resample log residuals onto the fitted trend and refit
  const rnd = mulberry32(seed + fitPts.length * 31 + start)
  const res = fitPts.map(p => Math.log(p.q) - lnq(fit, p.t))
  const curves: number[][] = [], eurs: number[] = []
  for (let k = 0; k < nBoot; k++) {
    const sim = fitPts.map(p => ({ t: p.t, q: arps(fit, p.t) * Math.exp(res[Math.floor(rnd() * res.length)]) }))
    const f = fitArps(sim, start, fixedB, true)
    curves.push(months.map(t => arps(f, t)))
    eurs.push(cumToCutoff + tail(f))
  }
  if (!nBoot) { curves.push(months.map(t => arps(fit, t))); eurs.push(cumToCutoff + tail(fit)) }
  const pct = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))] }
  const p50 = months.map(t => arps(fit, t))
  const p10 = months.map((_, i) => pct(curves.map(c => c[i]), 0.9))
  const p90 = months.map((_, i) => pct(curves.map(c => c[i]), 0.1))
  let limitMonth: number | null = null
  for (let t = cutoff; t < cutoff + 360; t++) if (arps(fit, t) < qLimit) { limitMonth = t; break }
  return {
    fit, fitPts, start, cutoff, end, months, p50, p10, p90, cumToCutoff, limitMonth,
    eur: { p10: pct(eurs, 0.9), p50: cumToCutoff + tail(fit), p90: pct(eurs, 0.1) },
  }
}

export interface Backtest { n: number; cumErr: number | null; mape: number | null; coverage: number | null; actualCum: number; fcCum: number }

/** Compare the forecast with the hidden actuals over producing months in [cutoff, last]. */
export function score(f: Forecast, pts: Pt[]): Backtest {
  const hidden = pts.filter(p => p.t >= f.cutoff && p.t <= f.end)
  let a = 0, fc = 0, ape = 0, inBand = 0
  for (const p of hidden) {
    const i = p.t - f.cutoff
    a += p.q; fc += f.p50[i]
    ape += Math.abs(f.p50[i] - p.q) / p.q
    if (p.q <= f.p10[i] && p.q >= f.p90[i]) inBand++
  }
  const n = hidden.length
  return {
    n, actualCum: a * DAYS_PER_MONTH, fcCum: fc * DAYS_PER_MONTH,
    cumErr: n >= 3 ? (fc - a) / a : null, mape: n >= 3 ? ape / n : null, coverage: n >= 3 ? inBand / n : null,
  }
}

export const MIN_MONTHS = 12

export function eligible(ds: Dataset): Well[] {
  return ds.producers.filter(w => producingPoints(w).length >= MIN_MONTHS)
}

/** 12-month hindcast for every eligible producer with the automatic fit window. */
export function scoreboard(ds: Dataset, hide = 12) {
  return eligible(ds).map(w => {
    const pts = producingPoints(w)
    const cutoff = w.last - hide + 1
    const start = autoStart(pts, cutoff)
    const f = forecast(w, pts, start, cutoff, w.last, 0, null, 0)
    return { well: w.id, bt: f ? score(f, pts) : null }
  })
}
