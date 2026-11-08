// Artificial lift: rule-based method screening, ESP sizing with affinity laws, and rod-pump card diagnosis.
// All internal units SI-oilfield: Sm³/d, bar, m, °C. Every curve and rule here is generic and illustrative.
import { boStanding, iprPwf, rsStanding, aof, vlp, type Fluid, type Inflow, type Tubing } from './nodal'

const G = 9.80665

// ---------------------------------------------------------------- screening
export type Method = 'esp' | 'gl' | 'pcp' | 'rod' | 'jet' | 'plunger'
export const METHODS: Method[] = ['esp', 'gl', 'pcp', 'rod', 'jet', 'plunger']
export const METHOD_LABEL: Record<Method, string> = { esp: 'ESP', gl: 'Gas lift', pcp: 'PCP', rod: 'Rod pump', jet: 'Jet pump', plunger: 'Plunger' }
export const METHOD_COLOR: Record<Method, string> = { esp: '#3987e5', gl: '#d95926', pcp: '#c98500', rod: '#e87ba4', jet: '#1fa8a0', plunger: '#9a7fe0' }

export type Sand = 'none' | 'low' | 'high'
export interface ScreenInput {
  rate: number        // liquid, Sm³/d
  depth: number       // pump / injection depth TVD, m
  glr: number         // producing gas-liquid ratio, Sm³/Sm³
  wc: number          // fraction
  sand: Sand
  visc: number        // dead-oil viscosity at downhole T, cP
  dev: number         // max inclination, °
  dls: number         // dogleg severity at the pump, °/30 m
  temp: number        // bottomhole temperature, °C
  offshore: boolean
  power: boolean      // electrical power available
  gas: boolean        // high-pressure lift gas available
}

export const AXES = ['rate', 'depth', 'gas', 'wc', 'sand', 'visc', 'dev', 'temp', 'surface'] as const
export type Axis = typeof AXES[number]
export const AXIS_LABEL: Record<Axis, string> = { rate: 'Rate', depth: 'Depth', gas: 'Gas', wc: 'Water cut', sand: 'Sand', visc: 'Viscosity', dev: 'Deviation', temp: 'Temperature', surface: 'Surface & utilities' }

/** Step table: first threshold the value is ≤ gives the score; otherwise `rest`. */
const step = (v: number, t: [number, number][], rest: number) => { for (const [x, s] of t) if (v <= x) return s; return rest }

/** Gas-liquid ratio a plunger needs: ~400 scf/bbl per 1,000 ft of lift (Foss & Gaul rule of thumb) → Sm³/Sm³ per m. */
export const plungerGlrNeed = (depth: number) => (400 / 5.6146) * depth / 304.8

interface Rule { s: number; why: string }
function rules(m: Method, x: ScreenInput): Record<Axis, Rule> {
  const r = (s: number, why: string): Rule => ({ s, why })
  const sand = { none: 0, low: 1, high: 2 }[x.sand]
  switch (m) {
    case 'rod': return {
      rate: r(step(x.rate, [[80, 5], [160, 4], [320, 3], [640, 2], [950, 1]], 0), 'rod-string load and stroke rate limit rate, especially when deep'),
      depth: r(step(x.depth, [[1500, 5], [2500, 4], [3000, 3], [4000, 1]], 0), 'rod stress grows with depth'),
      gas: r(step(x.glr, [[50, 5], [150, 3], [300, 2]], 1), 'free gas causes gas interference / gas lock'),
      wc: r(5, 'water cut has little effect'),
      sand: r([5, 3, 1][sand], 'sand wears plunger and barrel, sticks the pump'),
      visc: r(step(x.visc, [[500, 5], [2000, 4]], 3), 'heavy oil slows rod fall on the downstroke'),
      dev: r(Math.min(step(x.dev, [[20, 5], [40, 3], [60, 2]], 1), step(x.dls, [[3, 5], [6, 3]], 1)), 'rod/tubing wear in deviated or doglegged wells'),
      temp: r(step(x.temp, [[280, 5]], 3), 'tolerates high temperature'),
      surface: r(x.offshore ? 1 : 5, x.offshore ? 'pumping unit footprint and weight are a problem offshore' : 'simple onshore surface equipment'),
    }
    case 'pcp': return {
      rate: r(step(x.rate, [[160, 5], [320, 4], [500, 3], [800, 2], [1000, 1]], 0), 'displacement limits rate'),
      depth: r(step(x.depth, [[1200, 5], [1800, 4], [2500, 3], [3000, 2], [3600, 1]], 0), 'rod torque and pump differential pressure limit depth'),
      gas: r(step(x.glr, [[50, 5], [100, 3], [200, 2]], 1), 'free gas overheats and swells the elastomer'),
      wc: r(5, 'water cut has little effect'),
      sand: r([5, 5, 4][sand], 'handles sand well'),
      visc: r(step(x.visc, [[50, 4], [5000, 5]], 4), 'best method for viscous oil'),
      dev: r(Math.min(step(x.dev, [[30, 5], [60, 3]], 2), step(x.dls, [[4, 5], [8, 3]], 2)), 'rod-driven: rod/tubing wear in deviated wells'),
      temp: r(step(x.temp, [[75, 5], [100, 4], [120, 3], [150, 2]], 0), 'elastomer temperature limit'),
      surface: r(x.offshore ? 3 : 5, x.offshore ? 'surface drive head is acceptable offshore but not ideal' : 'small surface drive'),
    }
    case 'esp': return {
      rate: r(step(x.rate, [[30, 1], [80, 3], [160, 4], [5000, 5]], 4), 'poor efficiency and motor cooling at low rate'),
      depth: r(step(x.depth, [[3000, 5], [4000, 4], [4500, 3]], 2), 'more stages and motor power when deep'),
      gas: r(step(x.glr, [[50, 5], [100, 4], [200, 3], [400, 2]], 1), 'free gas degrades head; needs gas separator / handler'),
      wc: r(5, 'high water cut suits an ESP'),
      sand: r([5, 3, 1][sand], 'sand erodes stages; abrasion-resistant pumps needed'),
      visc: r(step(x.visc, [[50, 5], [200, 4], [500, 3], [1000, 2]], 1), 'viscosity derates head and efficiency'),
      dev: r(Math.min(step(x.dev, [[70, 5], [85, 4]], 3), step(x.dls, [[6, 5], [10, 3]], 2)), 'set the pump in a straight section'),
      temp: r(step(x.temp, [[120, 5], [150, 4], [180, 3], [200, 2]], 1), 'motor and cable insulation temperature'),
      surface: r(!x.power ? 1 : 5, !x.power ? 'needs reliable electrical power' : 'small footprint, power available'),
    }
    case 'gl': return {
      rate: r(step(x.rate, [[30, 2], [80, 3], [160, 4], [4000, 5]], 4), 'heading and inefficiency at low rate'),
      depth: r(step(x.depth, [[3000, 5], [4500, 4]], 3), 'injection pressure limits the deepest valve'),
      gas: r(x.glr <= 50 ? 4 : 5, 'formation gas helps lift'),
      wc: r(step(x.wc, [[0.5, 5], [0.8, 4]], 3), 'heavy water column needs more lift gas'),
      sand: r([5, 5, 4][sand], 'no moving parts downhole'),
      visc: r(step(x.visc, [[20, 5], [100, 4], [500, 2]], 1), 'viscous oil reduces gas-lift efficiency'),
      dev: r(step(x.dls, [[10, 5]], 4), 'wireline-retrievable valves work in deviated wells'),
      temp: r(step(x.temp, [[200, 5]], 4), 'valve bellows charge is temperature-sensitive'),
      surface: r(!x.gas ? 1 : x.offshore ? 5 : 4, !x.gas ? 'needs a high-pressure lift-gas supply' : 'compressed gas available'),
    }
    case 'jet': return {
      rate: r(step(x.rate, [[30, 3], [2400, 4]], 2), 'wide rate range at low efficiency'),
      depth: r(step(x.depth, [[3000, 5], [4500, 4]], 3), 'power-fluid pressure grows with depth'),
      gas: r(step(x.glr, [[100, 4], [300, 3]], 2), 'free gas reduces efficiency and causes cavitation'),
      wc: r(4, 'water cut has little effect; returns mix with power fluid'),
      sand: r([5, 4, 3][sand], 'no moving parts; nozzle and throat erode'),
      visc: r(step(x.visc, [[200, 5], [800, 4]], 3), 'power fluid dilutes viscous oil'),
      dev: r(5, 'free pump circulates in and out'),
      temp: r(step(x.temp, [[250, 5]], 4), 'tolerates high temperature'),
      surface: r(!x.power ? 2 : x.offshore ? 4 : 4, !x.power ? 'needs a surface power-fluid pump' : 'surface pump and power-fluid handling'),
    }
    case 'plunger': {
      const ratio = x.glr / plungerGlrNeed(x.depth)
      return {
        rate: r(step(x.rate, [[5, 5], [15, 4], [30, 2], [60, 1]], 0), 'only for small liquid volumes'),
        depth: r(step(x.depth, [[3000, 5], [5000, 4]], 3), 'cycle time grows with depth'),
        gas: r(ratio >= 1.5 ? 5 : ratio >= 1 ? 4 : ratio >= 0.7 ? 2 : ratio >= 0.4 ? 1 : 0, `needs about ${Math.round(plungerGlrNeed(x.depth))} Sm³/Sm³ of gas at this depth; well has ${Math.round(x.glr)}`),
        wc: r(step(x.wc, [[0.3, 5], [0.6, 3]], 1), 'water is heavy to unload with well gas'),
        sand: r([5, 3, 2][sand], 'sand sticks the plunger'),
        visc: r(step(x.visc, [[10, 5], [50, 3]], 1), 'plunger fall slows in viscous liquid'),
        dev: r(Math.min(step(x.dev, [[30, 5], [50, 3], [70, 1]], 0), step(x.dls, [[5, 5]], 3)), 'plunger must fall under gravity'),
        temp: r(5, 'no temperature limit'),
        surface: r(x.offshore ? 4 : 5, 'needs no power or lift gas'),
      }
    }
  }
}

export interface ScreenResult { m: Method; axes: Record<Axis, Rule>; mean: number; min: number; limit: Axis; score: number; feasible: boolean }

/** Mean of the axis scores, cut to 60 % if any axis is a near-showstopper (≤ 1); 0 if one axis scores 0. */
export function screen(x: ScreenInput): ScreenResult[] {
  return METHODS.map(m => {
    const axes = rules(m, x)
    const vals = AXES.map(a => axes[a].s)
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length
    const min = Math.min(...vals)
    const limit = AXES[vals.indexOf(min)]
    const feasible = min > 0
    return { m, axes, mean, min, limit, feasible, score: !feasible ? 0 : min <= 1 ? mean * 0.6 : mean }
  }).sort((a, b) => b.score - a.score)
}

// ---------------------------------------------------------------- ESP
/** Generic single-stage curve at 60 Hz (illustrative; real stage curves come from the vendor catalogue). */
export interface Stage { name: string; qBep: number; h0: number; effMax: number }
export const PUMPS: Stage[] = [
  { name: 'Small (BEP 160 Sm³/d)', qBep: 160, h0: 7.5, effMax: 0.58 },
  { name: 'Medium (BEP 400 Sm³/d)', qBep: 400, h0: 10, effMax: 0.68 },
  { name: 'Large (BEP 900 Sm³/d)', qBep: 900, h0: 12, effMax: 0.74 },
]
export const REC = [0.75, 1.25] as const   // recommended range as a fraction of BEP rate (illustrative)
const QMAX_FAC = 1.8                        // stage runout rate / BEP rate

/** Stage head (m) at rate q and frequency f, by the affinity laws: Q ∝ f, H ∝ f². */
export function stageHead(s: Stage, q: number, f: number): number {
  const r = f / 60
  const x = q / r / (s.qBep * QMAX_FAC)
  return Math.max(0, s.h0 * r * r * (1 - 0.25 * x - 0.75 * x * x))
}
/** Stage efficiency: parabola peaking at the (frequency-scaled) BEP; efficiency is unchanged by speed (affinity). */
export function stageEff(s: Stage, q: number, f: number): number {
  const xb = q / (s.qBep * f / 60)
  return Math.max(0, s.effMax * (2 * xb - xb * xb))
}
export const runout = (s: Stage, f: number) => s.qBep * QMAX_FAC * f / 60

export interface EspInput {
  inflow: Inflow
  fluid: Fluid
  perf: number      // mid-perforation TVD, m
  pump: number      // pump setting TVD, m
  whp: number       // bar
  tubingId: number  // in
  stage: Stage
  stages: number
  freq: number      // Hz
  tBh: number       // °C
}

export const liqDensity = (f: Fluid) => (1 - f.wc) * (141.5 / (131.5 + f.api)) * 999 + f.wc * f.waterSg * 999

function tubing(x: EspInput): Tubing {
  return { tvd: x.pump, md: x.pump * 1.05, id: x.tubingId, rough: 4.6e-5, tWh: 35, tBh: x.tBh }
}

/** Pump intake pressure (bar) for liquid rate q: IPR flowing pressure less the liquid column perforations → pump. */
export function pip(x: EspInput, q: number): number {
  return iprPwf(q, x.inflow) - liqDensity(x.fluid) * G * Math.max(0, x.perf - x.pump) / 1e5
}

/** Head (m) the pump must add at rate q. A rotary gas separator is assumed: tubing carries only gas still in solution at the intake. */
export function headRequired(x: EspInput, q: number): number {
  const p = Math.max(1, pip(x, q))
  const rs = rsStanding(p, x.tBh, x.fluid)
  const tf: Fluid = { ...x.fluid, gor: Math.min(x.fluid.gor, rs) }
  const pd = vlp(q, x.whp, tf, tubing(x), null)
  return (pd - pip(x, q)) * 1e5 / (liqDensity(x.fluid) * G)
}

export const pumpHead = (x: EspInput, q: number, f = x.freq) => x.stages * stageHead(x.stage, q, f)

/** Free-gas volume fraction at the intake before separation. */
export function intakeGvf(x: EspInput, q: number): number {
  const p = Math.max(1, pip(x, q))
  const f = x.fluid
  const rs = rsStanding(p, x.tBh, f)
  const bo = boStanding(rs, x.tBh, f)
  const qo = q * (1 - f.wc), qw = q * f.wc
  const bg = 0.9 * ((x.tBh + 273.15) / 288.15) * (1.01325 / p)
  const free = Math.max(0, f.gor - rs) * qo * bg
  return free / (free + qo * bo + qw)
}

export interface EspPoint { q: number; head: number; pip: number; eff: number; hydKw: number; brakeKw: number; zone: 'down' | 'ok' | 'up'; gvf: number }

/** Operating point: pump head = required head (bisection; pump head falls and required head rises with rate). */
export function espPoint(x: EspInput, f = x.freq): EspPoint | null {
  const hi0 = Math.min(aof(x.inflow) * 0.999, runout(x.stage, f) * 0.999)
  const d = (q: number) => pumpHead(x, q, f) - headRequired(x, q)
  if (d(1) <= 0) return null
  let lo = 1, hi = hi0
  if (d(hi) > 0) lo = hi   // pump would pump the well off: limited by inflow
  else for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (d(m) > 0) lo = m; else hi = m }
  const q = lo
  const head = pumpHead(x, q, f)
  const eff = stageEff(x.stage, q, f)
  const hydKw = liqDensity(x.fluid) * G * (q / 86400) * head / 1000
  const qb = x.stage.qBep * f / 60
  return { q, head, pip: pip(x, q), eff, hydKw, brakeKw: eff > 0.01 ? hydKw / eff : NaN, zone: q < REC[0] * qb ? 'down' : q > REC[1] * qb ? 'up' : 'ok', gvf: intakeGvf(x, q) }
}

// ---------------------------------------------------------------- rod-pump cards
export type Card = 'full' | 'pound' | 'gas' | 'tubing' | 'tvleak' | 'svleak'
export const CARDS: Card[] = ['full', 'pound', 'gas', 'tubing', 'tvleak', 'svleak']
export const CARD_LABEL: Record<Card, string> = {
  full: 'Full pump', pound: 'Fluid pound', gas: 'Gas interference', tubing: 'Tubing movement (unanchored)', tvleak: 'Leaking travelling valve', svleak: 'Leaking standing valve',
}
export const CARD_ACTION: Record<Card, string> = {
  full: 'Pump is filling. Check whether the well can take a faster speed or longer stroke.',
  pound: 'Pump capacity exceeds inflow. Slow down, shorten the stroke, or add a pump-off controller.',
  gas: 'Free gas enters the pump. Lower the pump below the perforations or add a gas anchor.',
  tubing: 'Tubing stretches each stroke. Install or reset a tubing anchor to recover stroke.',
  tvleak: 'Load bleeds off on the upstroke. Plan a pump change (travelling valve or plunger wear).',
  svleak: 'Load creeps up on the downstroke. Plan a pump change (standing valve).',
}

/**
 * A downhole card as two branches over normalised position x ∈ [0, 1]:
 * up(x) = load on the upstroke (left → right), down(x) = load on the downstroke (right → left).
 * Loads are normalised: 0 = rods only (fluid on standing valve), 1 = full fluid load on the plunger.
 */
export interface CardShape { up: (x: number) => number; down: (x: number) => number }

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const ramp = (x: number, a: number, b: number) => clamp01((x - a) / (b - a))
const smooth = (t: number) => t * t * (3 - 2 * t)

export function cardShape(c: Card, fill: number): CardShape {
  const fl = Math.max(0.25, Math.min(0.95, fill))
  switch (c) {
    case 'full': return { up: x => smooth(ramp(x, 0, 0.05)), down: x => smooth(ramp(x, 0.95, 1)) }
    case 'pound': return { up: x => smooth(ramp(x, 0, 0.05)), down: x => x > fl + 0.04 ? 0.97 - 0.05 * (1 - x) : smooth(ramp(x, fl, fl + 0.04)) * 0.95 }
    case 'gas': return { up: x => smooth(ramp(x, 0, 0.07)), down: x => Math.pow(ramp(x, fl - 0.3, 1), 2.2) }
    case 'tubing': return { up: x => ramp(x, 0, 0.25), down: x => ramp(x, 0.75, 1) }
    case 'tvleak': return { up: x => smooth(ramp(x, 0, 0.3)) * (1 - 0.35 * smooth(ramp(x, 0.55, 1))), down: x => smooth(ramp(x, 0.9, 1)) * 0.65 }
    case 'svleak': return { up: x => 0.22 + 0.78 * smooth(ramp(x, 0, 0.08)), down: x => 0.22 + 0.1 * x + 0.68 * smooth(ramp(x, 0.8, 1)) }
  }
}

/** Mulberry32 — small deterministic RNG so "noise" looks the same on every redraw. */
export function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

export const CARD_N = 61
/** Sample a card into up/down arrays (same length for every condition, so paths can morph). Optional load noise. */
export function sampleCard(c: Card, fill: number, noise = 0, seed = 7): { x: number[]; up: number[]; down: number[] } {
  const s = cardShape(c, fill), r = rng(seed)
  const x = Array.from({ length: CARD_N }, (_, i) => i / (CARD_N - 1))
  const nz = () => (r() - 0.5) * 2 * noise
  return { x, up: x.map(v => s.up(v) + nz()), down: x.map(v => s.down(v) + nz()) }
}

export interface CardFeatures { fill: number; rise: number; drop: number; topLoss: number; svCreep: number; area: number }

/** Features a pumper reads off a downhole card. */
export function cardFeatures(k: { x: number[]; up: number[]; down: number[] }): CardFeatures {
  const n = k.x.length
  const sm = (a: number[]) => a.map((_, i) => { let t = 0; for (let j = -2; j <= 2; j++) t += a[Math.max(0, Math.min(n - 1, i + j))]; return t / 5 })
  const up = sm(k.up), dn = sm(k.down)
  const upMax = Math.max(...up)
  const firstUp = (lvl: number) => { const i = up.findIndex(v => v >= lvl * upMax); return i < 0 ? 1 : k.x[i] }
  // downstroke: scan from the right (start of downstroke) leftwards for where the load falls through a level
  const crossDown = (lvl: number) => { for (let i = n - 1; i >= 0; i--) if (dn[i] < lvl * upMax) return k.x[i]; return 0 }
  const fill = crossDown(0.5)
  const drop = crossDown(0.9) - crossDown(0.1)
  const rise = firstUp(0.9)
  const topLoss = 1 - up[Math.round(0.93 * (n - 1))] / upMax
  const mid = dn.slice(Math.round(0.05 * n), Math.round(0.3 * n))   // early downstroke… end of stroke: should carry ~no fluid load
  const svCreep = mid.reduce((s, v) => s + v, 0) / mid.length / upMax
  let area = 0
  for (let i = 1; i < n; i++) area += ((up[i] - dn[i]) + (up[i - 1] - dn[i - 1])) / 2 * (k.x[i] - k.x[i - 1])
  return { fill, rise, drop: Math.abs(drop), topLoss, svCreep, area: area / upMax }
}

const sig = (v: number, k = 12) => 1 / (1 + Math.exp(-k * v))

/** Fuzzy rules → normalised confidence per condition. */
export function classifyCard(f: CardFeatures): { c: Card; p: number }[] {
  const lowFill = sig(0.86 - f.fill, 25)
  const sharp = sig(0.1 - f.drop, 30)
  const slowRise = sig(f.rise - 0.15, 25)
  const topLoss = sig(f.topLoss - 0.15, 20)
  const creep = sig(f.svCreep - 0.12, 25)
  const raw: Record<Card, number> = {
    full: (1 - lowFill) * (1 - slowRise) * (1 - topLoss) * (1 - creep) * sharp,
    pound: lowFill * sharp * (1 - topLoss) * (1 - creep),
    gas: lowFill * (1 - sharp) * (1 - slowRise) * (1 - topLoss) * (1 - creep),
    tubing: slowRise * (1 - sharp) * (1 - topLoss) * (1 - creep) * (1 - lowFill * 0.8),
    tvleak: topLoss * (1 - creep),
    svleak: creep,
  }
  const tot = Object.values(raw).reduce((s, v) => s + v, 0) || 1
  return CARDS.map(c => ({ c, p: raw[c] / tot })).sort((a, b) => b.p - a.p)
}

/** Illustrative surface card from a downhole card: adds buoyant rod weight, a rod-stretch shift and a dynamic term.
 *  This is a forward sketch, not a wave-equation solution (Gibbs 1963 goes the other way, surface → downhole). */
export function surfaceCard(k: { x: number[]; up: number[]; down: number[] }, fo: number, wrf: number, stretch: number) {
  const pts: [number, number][] = []
  const n = k.x.length
  for (let i = 0; i < n; i++) { const t = i / (n - 1) * 0.5; pts.push([k.x[i] * (1 - stretch) + stretch * clamp01(k.up[i]), wrf + fo * k.up[i] + 0.18 * fo * Math.sin(2 * Math.PI * t)]) }
  for (let i = n - 1; i >= 0; i--) { const t = 0.5 + (n - 1 - i) / (n - 1) * 0.5; pts.push([k.x[i] * (1 - stretch) + stretch * clamp01(k.down[i]), wrf + fo * k.down[i] + 0.18 * fo * Math.sin(2 * Math.PI * t)]) }
  return pts
}
