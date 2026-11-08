// Flow assurance screening: flowing temperature up the tubing (Ramey 1962) and along a seabed flowline,
// against the wax appearance temperature and a natural-gas hydrate curve (Hammerschmidt 1934).
// SI-oilfield units throughout: bar, °C, Sm³/d, m.
import { rsStanding, boStanding, frictionFactor, vlp, type Fluid, type GradientPoint, type Tubing } from './nodal'

export type Inhibitor = 'none' | 'methanol' | 'meg'

export interface FAInput {
  ql: number          // liquid rate, Sm³/d
  wc: number          // water cut, fraction
  gor: number         // Sm³/Sm³
  tres: number        // reservoir temperature, °C
  depth: number       // reservoir TVD below mudline, m
  tsea: number        // seabed temperature, °C (also earth temperature at the mudline)
  whp: number         // flowing wellhead pressure, bar
  flowline: number    // km; 0 = dry-tree wellhead on the host
  uFl: number         // flowline overall heat-transfer coefficient, W/m²/K (inner-diameter basis)
  wat: number         // wax appearance temperature, °C
  pour: number        // pour point, °C
  inh: Inhibitor
  inhWt: number       // inhibitor in the free-water phase, wt %
}

// Fixed, documented assumptions.
export const FA = {
  api: 34, gasSg: 0.7, waterSg: 1.03,
  tubingId: 2.992,     // in (3½″ tubing)
  flId: 0.2032,        // m (8″ flowline)
  uWell: 30,           // W/m²/K, tubing-to-formation through annulus and cement
  kEarth: 2.0,         // W/m/K
  fTime: 3.0,          // Ramey dimensionless time function, months of production
  cpOil: 2100, cpWat: 4180, cpGas: 2300,  // J/kg/K
}

const oilRho = (api: number) => (141.5 / (131.5 + api)) * 999
const fluid = (i: FAInput): Fluid => ({ api: FA.api, gor: i.gor, wc: i.wc, gasSg: FA.gasSg, waterSg: FA.waterSg })

/** Mass rate (kg/s) and mass-weighted heat capacity (J/kg/K) of the produced stream. */
export function stream(i: FAInput) {
  const qo = i.ql * (1 - i.wc), qw = i.ql * i.wc
  const mo = qo * oilRho(FA.api), mw = qw * FA.waterSg * 999, mg = qo * i.gor * FA.gasSg * 1.2232
  const m = (mo + mw + mg) / 86400
  const cp = (mo * FA.cpOil + mw * FA.cpWat + mg * FA.cpGas) / Math.max(1e-9, mo + mw + mg)
  return { m, cp, wcp: m * cp }
}

/** Ramey (1962) relaxation distance A (m) for the producing string. */
export function rameyA(wcp: number) {
  const r = (FA.tubingId * 0.0254) / 2
  return (wcp / (2 * Math.PI)) * (FA.kEarth + r * FA.uWell * FA.fTime) / (r * FA.uWell * FA.kEarth)
}

/** Hammerschmidt (1934) hydrate formation temperature, °C, for P in bar (natural gas, sg ≈ 0.6–0.7). */
export function hydrateT(p: number) {
  const psia = Math.max(1, p * 14.5038 + 14.7)
  const tF = 8.9 * Math.pow(psia, 0.285)
  return (tF - 32) / 1.8
}

const INH = { methanol: { M: 32.04, K: 2335 }, meg: { M: 62.07, K: 2700 } }

/** Hammerschmidt (1934) hydrate depression, °C, for W wt % inhibitor in the water phase. */
export function depression(inh: Inhibitor, w: number) {
  if (inh === 'none' || w <= 0) return 0
  const { M, K } = INH[inh]
  return (K * w) / (M * (100 - Math.min(w, 95))) / 1.8
}

/** Inverse Hammerschmidt: wt % needed for a depression of dT °C. */
export function wtNeeded(inh: Exclude<Inhibitor, 'none'>, dT: number) {
  if (dT <= 0) return 0
  const { M, K } = INH[inh]
  const dF = dT * 1.8
  return (100 * dF * M) / (K + dF * M)
}

export interface PathPoint {
  s: number           // distance from the reservoir along the flow path, m
  seg: 'well' | 'flowline'
  z: number | null    // TVD below mudline (well only), m
  t: number           // fluid temperature, °C
  amb: number         // surrounding temperature (formation or sea), °C
  p: number           // pressure, bar
  th: number          // hydrate temperature at p, uninhibited, °C
  thInh: number       // with inhibitor, °C
}

export interface FAResult {
  path: PathPoint[]
  bhp: number; twh: number; tarr: number; parr: number
  waxOnset: PathPoint | null      // first point below WAT
  hydOnset: PathPoint | null      // first point inside the (inhibited) hydrate zone
  subcool: number                 // max (hydrate T − fluid T) along the path, uninhibited, °C (>0 = inside)
  subcoolInh: number
  subcoolShut: number             // hydrate T at shut-in pressure − sea temperature (contents settle at sea T)
  chokedFlowline: boolean         // arrival pressure hit the floor: the line cannot carry this rate at this WHP
  inhNeeded: { methanol: number; meg: number }
  pourRisk: boolean               // arrival below pour point
  A: number; grad: number
  cooldown: { tau: number; toHyd: number | null; toWat: number | null; t0: number; p: number }
}

/** Fluid temperature along the tubing (from the bottom, x up) and the flowline (distance y from the wellhead). */
export function run(i: FAInput): FAResult {
  const { wcp } = stream(i)
  const A = rameyA(wcp)
  const g = (i.tres - i.tsea) / i.depth          // °C/m
  const tWell = (x: number) => i.tsea + g * (i.depth - x) + g * A * (1 - Math.exp(-x / A))
  const twh = tWell(i.depth)

  // Pressure in the tubing: no-slip gradient from nodal.ts, wellhead downwards.
  const tub: Tubing = { tvd: i.depth, md: i.depth, id: FA.tubingId, rough: 4.6e-5, tWh: twh, tBh: i.tres }
  const prof: GradientPoint[] = []
  const bhp = vlp(i.ql, i.whp, fluid(i), tub, null, 1, prof)
  const pAtZ = (z: number) => {
    if (z <= prof[0].z) return i.whp
    for (let k = 1; k < prof.length; k++) if (prof[k].z >= z) {
      const a = prof[k - 1], b = prof[k]
      return a.p + (b.p - a.p) * (z - a.z) / (b.z - a.z)
    }
    return bhp
  }

  const dT = depression(i.inh, i.inhWt)
  const path: PathPoint[] = []
  const nW = 50
  for (let k = 0; k <= nW; k++) {
    const x = (i.depth * k) / nW
    const z = i.depth - x
    const p = k === 0 ? bhp : pAtZ(z)
    const th = hydrateT(p)
    path.push({ s: x, seg: 'well', z, t: tWell(x), amb: i.tsea + g * z, p, th, thInh: th - dT })
  }

  // Flowline: exponential approach to sea temperature, pressure by horizontal friction marching.
  const L = i.flowline * 1000
  let p = i.whp, t = twh
  if (L > 0) {
    const nF = 50, ds = L / nF
    const f = fluid(i)
    const area = Math.PI * FA.flId * FA.flId / 4
    const qo = i.ql * (1 - i.wc), qw = i.ql * i.wc
    const mass = qo * oilRho(FA.api) + qw * FA.waterSg * 999 + qo * i.gor * FA.gasSg * 1.2232
    const decay = Math.PI * FA.flId * i.uFl / wcp      // 1/m
    for (let k = 1; k <= nF; k++) {
      const y = k * ds
      t = i.tsea + (twh - i.tsea) * Math.exp(-decay * y)
      const rs = rsStanding(p, t, f), bo = boStanding(rs, t, f)
      const bg = 0.9 * ((t + 273.15) / 288.15) * (1.01325 / Math.max(p, 1.5))
      const vol = qo * bo + qw + Math.max(0, qo * (i.gor - rs)) * bg
      const rho = vol > 0 ? mass / vol : 1000
      const v = vol / 86400 / area
      const lam = vol > 0 ? (qo * bo + qw) / vol : 1
      const mu = lam * ((1 - i.wc) * 3e-3 + i.wc * 0.6e-3) + (1 - lam) * 1.5e-5
      const fr = frictionFactor(rho * v * FA.flId / mu, 4.6e-5 / FA.flId)
      p = Math.max(1.5, p - fr * rho * v * v / (2 * FA.flId) * ds / 1e5)
      const th = hydrateT(p)
      path.push({ s: i.depth + y, seg: 'flowline', z: null, t, amb: i.tsea, p, th, thInh: th - dT })
    }
  }
  const last = path[path.length - 1]

  const waxOnset = path.find(q => q.t < i.wat) ?? null
  const hydOnset = path.find(q => q.t < q.thInh) ?? null
  const subcool = Math.max(...path.map(q => q.th - q.t))
  const subcoolInh = subcool - dT
  const pShut = i.whp                                                 // settles near wellhead pressure
  const subcoolShut = L > 0 ? hydrateT(pShut) - i.tsea : -Infinity
  const worst = Math.max(subcool, subcoolShut)
  const need = worst > -3 ? worst + 3 : 0   // keep a 3 °C margin, a common design allowance

  // Shut-in cooldown of the flowline contents (lumped, wall heat capacity ignored).
  const rhoCp = 0.5 * (850 * FA.cpOil) + 0.5 * (1000 * FA.cpWat)   // mixed liquid, J/m³/K
  const tau = (rhoCp * FA.flId) / (4 * Math.max(0.1, i.uFl)) / 3600   // hours
  const t0 = L > 0 ? (twh + last.t) / 2 : twh
  const toTarget = (target: number) => {
    if (t0 <= target) return 0
    if (target <= i.tsea) return null
    return tau * Math.log((t0 - i.tsea) / (target - i.tsea))
  }

  return {
    path, bhp, twh, tarr: last.t, parr: last.p, waxOnset, hydOnset, subcool, subcoolInh, subcoolShut,
    chokedFlowline: L > 0 && last.p <= 1.5 + 1e-9,
    inhNeeded: { methanol: wtNeeded('methanol', need), meg: wtNeeded('meg', need) },
    pourRisk: last.t < i.pour, A, grad: g,
    cooldown: { tau, toHyd: toTarget(hydrateT(pShut) - dT), toWat: toTarget(i.wat), t0, p: pShut },
  }
}

/** Wax onset distance (m from reservoir) vs liquid rate — low late-life rates move the onset deeper. */
export function onsetVsRate(i: FAInput, rates: number[]) {
  return rates.map(ql => {
    const r = run({ ...i, ql })
    return { ql, s: r.waxOnset?.s ?? null, twh: r.twh, tarr: r.tarr }
  })
}
