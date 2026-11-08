// Geothermal doublet producer with lithium co-production. Simple steady-state energy balance.

export const BRINE = { rho: 1080, cp: 3800 }      // kg/m³, J/kg/K — moderately saline brine (~100 g/L TDS), assumed
export const T_COND = 30                           // °C, ORC condensing temperature (air-cooled), assumed
export const WHP_MIN = 10                          // bar kept at the wellhead to stop CO₂ degassing / scaling, assumed
export const CASING_ID = 0.2                       // m, production string ID
export const LCE_PER_LI = 5.323                    // t Li₂CO₃ per t Li

export interface GeoInput {
  q: number        // L/s
  tres: number     // °C, production temperature at wellhead (heat losses ignored)
  tinj: number     // °C, reinjection temperature
  pi: number       // L/s/bar, productivity index (injectivity assumed equal)
  depth: number    // m, pump setting / well depth for friction
  eff: number      // pump wire-to-water efficiency, fraction
  li: number       // mg/L
  rec: number      // lithium recovery, fraction
  secondLaw: number // ORC second-law (fraction of Carnot) efficiency
  uptime: number   // fraction
}

export interface GeoResult {
  thermal: number; gross: number; pump: number; net: number   // MW
  eta: number; dp: number                                     // ORC efficiency; total pump Δp, bar
  heatGWh: number; elecGWh: number; lce: number; li: number   // per year
}

const K = 273.15

/** ORC efficiency as a fraction of the Carnot efficiency between the log-mean heat-source temperature and the condenser. */
export function orcEff(tres: number, tinj: number, secondLaw: number) {
  const th = tres + K, tc = Math.max(tinj, T_COND + 1) + K
  const tm = th - tc > 0.1 ? (th - tc) / Math.log(th / tc) : th
  return Math.max(0, secondLaw * (1 - (T_COND + K) / tm))
}

export function frictionBar(qLs: number, depth: number) {
  const q = qLs / 1000, d = CASING_ID, a = Math.PI * d * d / 4, v = q / a
  const Re = BRINE.rho * v * d / 3e-4                               // brine viscosity ~0.3 mPa·s at 100+ °C
  const f = Re < 2300 ? 64 / Math.max(Re, 1) : (-1.8 * Math.log10((4.5e-5 / d / 3.7) ** 1.11 + 6.9 / Re)) ** -2
  return f * depth / d * BRINE.rho * v * v / 2 / 1e5
}

export function geo(p: GeoInput): GeoResult {
  const q = p.q / 1000
  const thermal = BRINE.rho * BRINE.cp * q * Math.max(0, p.tres - p.tinj) / 1e6
  const eta = orcEff(p.tres, p.tinj, p.secondLaw)
  const gross = thermal * eta
  // producer: drawdown + friction + wellhead back-pressure; injector: same Δp (injectivity = productivity)
  const dp = 2 * p.q / p.pi + 2 * frictionBar(p.q, p.depth) + WHP_MIN
  const pump = q * dp * 1e5 / p.eff / 1e6
  const hours = 8766 * p.uptime
  const liT = p.q * p.li * p.rec * hours * 3600 / 1e9                 // L/s · mg/L → mg/s → t/yr
  return { thermal, gross, pump, net: gross - pump, eta, dp, heatGWh: thermal * hours / 1000, elecGWh: (gross - pump) * hours / 1000, li: liT, lce: liT * LCE_PER_LI }
}
