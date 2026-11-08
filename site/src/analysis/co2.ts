// Pure-CO₂ thermodynamics (Peng–Robinson 1976) and a steady-state injection-well model.
// SI internally: Pa, K, kg, J. Exposed results use bar and °C.

const R = 8.314462618     // J/mol/K
const M = 0.0440095       // kg/mol
export const TC = 304.1282  // K (Span & Wagner 1996)
export const PC = 73.773    // bar
const TC_PR = 304.13, PC_PR = 73.77e5, OMEGA = 0.225
const KAPPA = 0.37464 + 1.54226 * OMEGA - 0.26992 * OMEGA * OMEGA
const A_C = 0.45724 * R * R * TC_PR * TC_PR / PC_PR
const B_PR = 0.07780 * R * TC_PR / PC_PR
const S2 = Math.SQRT2
export const T_TRIPLE = 216.592 // K
const G = 9.80665

/** Span & Wagner (1996) ancillary vapour pressure, bar. Valid triple point → Tc. */
export function psat(T: number): number {
  const th = 1 - T / TC
  return PC * Math.exp((TC / T) * (-7.0602087 * th + 1.9391218 * th ** 1.5 - 1.6463597 * th ** 2 - 3.2995634 * th ** 4))
}

/** Inverse of psat by bisection, K. */
export function tsat(Pbar: number): number {
  let lo = T_TRIPLE, hi = TC
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (psat(m) > Pbar) hi = m; else lo = m }
  return (lo + hi) / 2
}

function cubicRoots(c2: number, c1: number, c0: number): number[] {
  // z³ + c2 z² + c1 z + c0 = 0
  const q = (3 * c1 - c2 * c2) / 9, r = (9 * c2 * c1 - 27 * c0 - 2 * c2 ** 3) / 54
  const d = q ** 3 + r * r
  if (d > 0) {
    const s = Math.cbrt(r + Math.sqrt(d)), t = Math.cbrt(r - Math.sqrt(d))
    return [s + t - c2 / 3]
  }
  const th = Math.acos(Math.max(-1, Math.min(1, r / Math.sqrt(-(q ** 3)))))
  const m = 2 * Math.sqrt(-q)
  return [0, 1, 2].map(k => m * Math.cos((th + 2 * Math.PI * k) / 3) - c2 / 3).sort((a, b) => a - b)
}

interface PRState { Z: number; A: number; B: number; a: number; dadT: number }

function prParams(T: number) {
  const sq = Math.sqrt(T / TC_PR)
  const al = 1 + KAPPA * (1 - sq)
  return { a: A_C * al * al, dadT: -A_C * KAPPA * al / Math.sqrt(T * TC_PR) }
}

const lnTerm = (Z: number, B: number) => Math.log((Z + (1 + S2) * B) / (Z + (1 - S2) * B))
const lnPhi = (Z: number, A: number, B: number) => Z - 1 - Math.log(Z - B) - A / (2 * S2 * B) * lnTerm(Z, B)

/** Solve PR at T (K), P (Pa). Root choice: below Tc follow the Span–Wagner saturation line; otherwise minimum Gibbs. */
function solve(T: number, P: number, force?: 'liq' | 'vap'): PRState {
  const { a, dadT } = prParams(T)
  const A = a * P / (R * T) ** 2, B = B_PR * P / (R * T)
  const roots = cubicRoots(-(1 - B), A - 3 * B * B - 2 * B, -(A * B - B * B - B ** 3)).filter(z => z > B)
  let Z: number
  if (roots.length === 1) Z = roots[0]
  else {
    const liq = roots[0], vap = roots[roots.length - 1]
    const want = force ?? (T < TC ? (P / 1e5 > psat(T) ? 'liq' : 'vap') : (lnPhi(liq, A, B) < lnPhi(vap, A, B) ? 'liq' : 'vap'))
    Z = want === 'liq' ? liq : vap
  }
  return { Z, A, B, a, dadT }
}

/** Density, kg/m³. */
export function density(T: number, Pbar: number, force?: 'liq' | 'vap'): number {
  const s = solve(T, Pbar * 1e5, force)
  return Pbar * 1e5 * M / (s.Z * R * T)
}

// Ideal-gas enthalpy from the NIST Shomate equation for CO₂ (298–1200 K; mild extrapolation below 298 K).
const SH = { A: 24.99735, B: 55.18696, C: -33.69137, D: 7.948387, E: -0.136638 }
function hIdeal(T: number): number { // J/kg, arbitrary reference
  const t = T / 1000
  const kJmol = SH.A * t + SH.B * t * t / 2 + SH.C * t ** 3 / 3 + SH.D * t ** 4 / 4 - SH.E / t
  return kJmol * 1000 / M
}

/** Specific enthalpy, J/kg (ideal gas + PR departure). */
export function enthalpy(T: number, Pbar: number, force?: 'liq' | 'vap'): number {
  const s = solve(T, Pbar * 1e5, force)
  const dep = R * T * (s.Z - 1) + (T * s.dadT - s.a) / (2 * S2 * B_PR) * lnTerm(s.Z, s.B)
  return hIdeal(T) + dep / M
}

export type Phase = 'gas' | 'liquid' | 'supercritical' | 'dense liquid' | 'two-phase'
export function phaseOf(T: number, Pbar: number): Phase {
  if (T >= TC) return Pbar >= PC ? 'supercritical' : 'gas'
  if (Pbar >= PC) return 'dense liquid'
  return Pbar > psat(T) ? 'liquid' : 'gas'
}

export interface Flash { T: number; quality: number | null; rho: number; phase: Phase }

/** Temperature from (P, h). Inside the saturation dome the fluid sits at Tsat with vapour quality x. */
export function flashPH(Pbar: number, h: number): Flash {
  if (Pbar < PC) {
    const Ts = tsat(Pbar)
    const hL = enthalpy(Ts, Pbar, 'liq'), hV = enthalpy(Ts, Pbar, 'vap')
    if (h > hL && h < hV) {
      const x = (h - hL) / (hV - hL)
      const rho = 1 / (x / density(Ts, Pbar, 'vap') + (1 - x) / density(Ts, Pbar, 'liq'))
      return { T: Ts, quality: x, rho, phase: 'two-phase' }
    }
  }
  let lo = 200, hi = 520
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (enthalpy(m, Pbar) > h) hi = m; else lo = m }
  const T = (lo + hi) / 2
  return { T, quality: null, rho: density(T, Pbar), phase: phaseOf(T, Pbar) }
}

/** Approximate CO₂–water hydrate equilibrium (°C, bar), read from published equilibrium data (Sloan & Koh 2008 compilation). */
export const HYDRATE: [number, number][] = [
  [-1.5, 10.3], [0, 12.4], [2, 15.5], [4, 20.0], [6, 26.5], [8, 35.5], [9.8, 44.9], [10.1, 80], [10.4, 150], [10.8, 250], [11.2, 350],
]
/** Hydrate equilibrium temperature at P (°C); hydrates are stable below it when free water is present. */
export function hydrateT(Pbar: number): number {
  const H = HYDRATE
  if (Pbar <= H[0][1]) return H[0][0]
  for (let i = 1; i < H.length; i++) if (Pbar <= H[i][1]) {
    const [t0, p0] = H[i - 1], [t1, p1] = H[i]
    return t0 + (t1 - t0) * (Math.log(Pbar) - Math.log(p0)) / (Math.log(p1) - Math.log(p0))
  }
  return H[H.length - 1][0]
}

export interface WellInput {
  rate: number      // Mt/yr
  whp: number       // bar
  wht: number       // °C
  pres: number      // bar, reservoir
  depth: number     // m TVD (vertical well)
  id: number        // in, tubing inner diameter
  grad: number      // °C / 100 m
  tsurf: number     // °C at wellhead depth (mudline / surface)
}

export interface ProfilePt { z: number; P: number; T: number; rho: number; phase: Phase }
export interface WellResult {
  path: ProfilePt[]
  bhp: number; tbh: number; rhoBh: number; phaseBh: Phase
  sandT: number; sandPhase: Phase; dTjt: number; sandQuality: number | null
  jt: { P: number; T: number }[]
  twoPhaseTubing: boolean; canInject: boolean; hydrate: boolean; belowZero: boolean
  vel: number; mdot: number
}

/** Simple density-based viscosity fit for CO₂ (Pa·s); about ±30 % vs reference data. */
const visc = (rho: number) => 1.5e-5 + 9.5e-8 * rho

export function injectionWell(p: WellInput): WellResult {
  const N = 120
  const dz = p.depth / N
  const mdot = p.rate * 1e9 / (365.25 * 86400)          // kg/s
  const d = p.id * 0.0254, area = Math.PI * d * d / 4, rough = 4.5e-5
  const lam = 2.0, ft = 3.0                            // rock conductivity W/m/K, Ramey time function (~1 yr)
  let P = p.whp, T = p.wht + 273.15
  let h = enthalpy(T, P)
  let fl = flashPH(P, h)
  const path: ProfilePt[] = [{ z: 0, P, T: T - 273.15, rho: fl.rho, phase: fl.phase }]
  let twoPhase = fl.phase === 'two-phase'
  let vel = 0
  for (let i = 1; i <= N; i++) {
    const z = i * dz
    const rho = fl.rho
    vel = mdot / (rho * area)
    const Re = rho * vel * d / visc(rho)
    const f = Re < 2300 ? 64 / Math.max(Re, 1) : (-1.8 * Math.log10((rough / d / 3.7) ** 1.11 + 6.9 / Re)) ** -2   // Haaland
    const dpdz = rho * G - f * rho * vel * vel / (2 * d)  // Pa/m, downward flow
    P = Math.max(1, P + dpdz * dz / 1e5)
    // Ramey (1962) relaxation length A = ṁ cp f(t) / (2π λ); cp approximated from local enthalpy slope
    const cp = Math.max(800, Math.min(6000, (enthalpy(T + 0.5, P) - enthalpy(T - 0.5, P))))
    const Lr = mdot * cp * ft / (2 * Math.PI * lam)
    const Tg = p.tsurf + 273.15 + p.grad / 100 * (z - dz / 2)
    h += G * dz + cp * (Tg - T) / Lr * dz                // potential energy gain + heat from the formation
    fl = flashPH(P, h)
    T = fl.T
    if (fl.phase === 'two-phase') twoPhase = true
    path.push({ z, P, T: T - 273.15, rho: fl.rho, phase: fl.phase })
  }
  const bot = path[path.length - 1]
  const canInject = bot.P > p.pres
  // isenthalpic expansion from flowing BHP to reservoir pressure (choking at the sandface / near wellbore)
  const jt: { P: number; T: number }[] = []
  let sand = flashPH(bot.P, h)
  if (canInject) {
    const steps = 30
    for (let k = 0; k <= steps; k++) {
      const Pk = bot.P + (p.pres - bot.P) * k / steps
      const f = flashPH(Pk, h)
      jt.push({ P: Pk, T: f.T - 273.15 })
      if (k === steps) sand = f
    }
  }
  const sandT = sand.T - 273.15
  return {
    path, bhp: bot.P, tbh: bot.T, rhoBh: bot.rho, phaseBh: bot.phase,
    sandT, sandPhase: sand.phase, sandQuality: sand.quality, dTjt: sandT - bot.T, jt,
    twoPhaseTubing: twoPhase, canInject,
    hydrate: canInject && sandT < hydrateT(p.pres), belowZero: canInject && sandT < 0,
    vel, mdot,
  }
}

/** Saturation curve from (Tmin °C) to the critical point. */
export function satCurve(tmin: number, n = 60): { T: number; P: number }[] {
  const a = Math.max(T_TRIPLE, tmin + 273.15)
  return Array.from({ length: n + 1 }, (_, i) => { const T = a + (TC - a) * i / n; return { T: T - 273.15, P: psat(T) } })
}
