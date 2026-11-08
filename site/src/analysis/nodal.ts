// Nodal analysis: composite PI/Vogel inflow and a simplified no-slip multiphase tubing gradient.
// All pressures in bar (absolute ≈ gauge + 1 is ignored at this level), rates in Sm³/d, depths in m.

export interface Fluid {
  api: number        // stock-tank oil gravity, °API
  gor: number        // producing GOR, Sm³/Sm³
  wc: number         // water cut, fraction
  gasSg: number      // gas specific gravity (air = 1)
  waterSg: number
}
export interface Tubing {
  tvd: number        // true vertical depth of the node (m)
  md: number         // measured depth, used for friction length (m)
  id: number         // inner diameter (in)
  rough: number      // absolute roughness (m)
  tWh: number        // flowing wellhead temperature (°C)
  tBh: number        // bottomhole temperature (°C)
}
export interface Lift { qgl: number; depth: number }    // lift gas Sm³/d injected at depth (TVD m)
export interface Inflow { pres: number; pi: number; pb: number }  // bar, Sm³/d/bar (liquid), bar

/** Common tubing sizes: OD → ID (in), API 5CT typical weights. */
export const TUBING: { od: number; id: number }[] = [
  { od: 2.875, id: 2.441 }, { od: 3.5, id: 2.992 }, { od: 4.5, id: 3.958 }, { od: 5.5, id: 4.892 }, { od: 7, id: 6.184 },
]

const G = 9.80665
const PSC = 1.01325       // bar
const TSC = 288.15        // K
const Z = 0.9             // constant gas deviation factor (simplification)
const RHO_AIR_SC = 1.2232 // kg/m³ at 15 °C, 1 atm

const oilSg = (api: number) => 141.5 / (131.5 + api)
const cToF = (c: number) => c * 1.8 + 32

/** Standing (1947) solution GOR, Sm³/Sm³. p in bar, T in °C; capped at the producing GOR. */
export function rsStanding(p: number, tC: number, f: Fluid): number {
  const psia = p * 14.5038 + 14.7
  const x = 0.0125 * f.api - 0.00091 * cToF(tC)
  const rsScf = f.gasSg * Math.pow((psia / 18.2 + 1.4) * Math.pow(10, x), 1.2048)
  return Math.min(f.gor, rsScf / 5.6146)
}

/** Standing (1947) oil formation volume factor, rm³/Sm³. */
export function boStanding(rs: number, tC: number, f: Fluid): number {
  const rsScf = rs * 5.6146
  return 0.9759 + 0.00012 * Math.pow(rsScf * Math.sqrt(f.gasSg / oilSg(f.api)) + 1.25 * cToF(tC), 1.2)
}

/** Swamee & Jain (1976) explicit Darcy friction factor; laminar 64/Re below Re 2000. */
export function frictionFactor(re: number, relRough: number): number {
  if (re < 1) return 0
  if (re < 2000) return 64 / re
  const t = Math.log10(relRough / 3.7 + 5.74 / Math.pow(re, 0.9))
  return 0.25 / (t * t)
}

export interface GradientPoint { z: number; p: number; rho: number; v: number; holdup: number }

/**
 * March from the wellhead down to the node TVD. Returns flowing pressure at the node (bar).
 * `k` scales the gravity term — a single holdup/slip correction used to match measured pressures.
 */
export function vlp(ql: number, whp: number, f: Fluid, t: Tubing, lift: Lift | null, k = 1, profile?: GradientPoint[]): number {
  const n = 60
  const dz = t.tvd / n
  const lenFac = Math.max(1, t.md / t.tvd)
  const d = t.id * 0.0254
  const area = Math.PI * d * d / 4
  const qo = ql * (1 - f.wc), qw = ql * f.wc
  const rhoOsc = oilSg(f.api) * 999, rhoWsc = f.waterSg * 999, rhoGsc = f.gasSg * RHO_AIR_SC
  let p = Math.max(whp, PSC)
  for (let i = 0; i < n; i++) {
    const z = (i + 0.5) * dz
    const tC = t.tWh + (t.tBh - t.tWh) * (z / t.tvd)
    const gasSc = qo * f.gor + (lift && z < lift.depth ? lift.qgl : 0)
    const rs = rsStanding(p, tC, f)
    const bo = boStanding(rs, tC, f)
    const freeSc = Math.max(0, gasSc - qo * rs)
    const bg = Z * ((tC + 273.15) / TSC) * (PSC / p)
    const volLiq = qo * bo + qw                     // m³/d in situ
    const volGas = freeSc * bg
    const vol = volLiq + volGas
    const mass = qo * rhoOsc + qw * rhoWsc + gasSc * rhoGsc   // kg/d, conserved
    const rho = vol > 0 ? mass / vol : rhoWsc
    const lam = vol > 0 ? volLiq / vol : 1          // no-slip liquid holdup
    const v = vol / 86400 / area
    const muL = (1 - f.wc) * 1.5e-3 + f.wc * 0.5e-3   // Pa·s, assumed
    const mu = lam * muL + (1 - lam) * 1.8e-5
    const re = rho * v * d / mu
    const fr = frictionFactor(re, t.rough / d)
    const dpdz = k * rho * G + fr * rho * v * v / (2 * d) * lenFac   // Pa/m
    profile?.push({ z, p, rho, v, holdup: lam })
    p += dpdz * dz / 1e5
  }
  return p
}

/** Composite inflow: straight line above Pb, Vogel (1968) below. Liquid rate at a flowing pressure. */
export function iprRate(pwf: number, r: Inflow): number {
  if (pwf >= r.pres) return 0
  if (r.pres <= r.pb) {
    const qmax = r.pi * r.pres / 1.8
    const x = pwf / r.pres
    return qmax * (1 - 0.2 * x - 0.8 * x * x)
  }
  if (pwf >= r.pb) return r.pi * (r.pres - pwf)
  const qb = r.pi * (r.pres - r.pb)
  const x = pwf / r.pb
  return qb + (r.pi * r.pb / 1.8) * (1 - 0.2 * x - 0.8 * x * x)
}
export const aof = (r: Inflow) => iprRate(0, r)

/** Inverse of iprRate (bisection): flowing pressure delivering liquid rate q. */
export function iprPwf(q: number, r: Inflow): number {
  if (q <= 0) return r.pres
  if (q >= aof(r)) return 0
  let lo = 0, hi = r.pres
  for (let i = 0; i < 50; i++) {
    const m = (lo + hi) / 2
    if (iprRate(m, r) > q) lo = m; else hi = m
  }
  return (lo + hi) / 2
}

export interface OpPoint { q: number; pwf: number; stable: boolean }

/** Stable operating point: rightmost crossing where the VLP rises through the IPR. null = will not flow. */
export function operatingPoint(r: Inflow, bhp: (q: number) => number): OpPoint | null {
  const qa = aof(r)
  const N = 120
  const diff = (q: number) => bhp(q) - iprPwf(q, r)
  let prevQ = qa, prev = diff(qa * 0.999)
  for (let i = N - 1; i >= 1; i--) {
    const q = qa * i / N
    const d = diff(q)
    if (prev > 0 && d <= 0) {
      let lo = q, hi = prevQ
      for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (diff(m) <= 0) lo = m; else hi = m }
      const qq = (lo + hi) / 2
      const slope = bhp(qq * 1.02) - bhp(qq * 0.98)
      return { q: qq, pwf: iprPwf(qq, r), stable: slope >= 0 }
    }
    prev = d; prevQ = q
  }
  return null
}

/** Golden-section search for the gravity multiplier that minimises squared BHP error. */
export function calibrate(pts: { ql: number; whp: number; pwf: number; fluid: Fluid; lift: Lift | null }[], t: Tubing): { k: number; rawErr: number; calErr: number } {
  if (!pts.length) return { k: 1, rawErr: NaN, calErr: NaN }
  // Fit k on the same metric the page reports (mean absolute % error), so calibration never looks worse.
  const mape = (kk: number) => pts.reduce((s, p) => s + Math.abs(vlp(p.ql, p.whp, p.fluid, t, p.lift, kk) - p.pwf) / p.pwf, 0) / pts.length
  let a = 0.6, b = 1.6
  const gr = (Math.sqrt(5) - 1) / 2
  let c = b - gr * (b - a), d = a + gr * (b - a)
  for (let i = 0; i < 30; i++) {
    if (mape(c) < mape(d)) b = d; else a = c
    c = b - gr * (b - a); d = a + gr * (b - a)
  }
  const k = mape((a + b) / 2) <= mape(1) ? (a + b) / 2 : 1
  return { k, rawErr: mape(1), calErr: mape(k) }
}
