// All data is stored in SI-oilfield units (Sm3/d, bar). Conversion happens only at display time.
export type UnitSystem = 'field' | 'si'

const SM3_TO_BBL = 6.2898
const SM3_TO_MSCF = 0.0353147
const BAR_TO_PSI = 14.5038
const SM3SM3_TO_SCFBBL = 5.6146

export interface Units {
  sys: UnitSystem
  liq: (v: number) => number
  gas: (v: number) => number
  p: (v: number) => number
  pInv: (v: number) => number
  gor: (v: number) => number
  pi: (v: number) => number
  cum: (v: number) => number
  liqU: string
  gasU: string
  pU: string
  gorU: string
  piU: string
  cumU: string
}

export function units(sys: UnitSystem): Units {
  if (sys === 'si') {
    return {
      sys, liq: v => v, gas: v => v, p: v => v, pInv: v => v, gor: v => v, pi: v => v, cum: v => v,
      liqU: 'Sm³/d', gasU: 'Sm³/d', pU: 'bar', gorU: 'Sm³/Sm³', piU: 'Sm³/d/bar', cumU: 'Sm³',
    }
  }
  return {
    sys,
    liq: v => v * SM3_TO_BBL,
    gas: v => v * SM3_TO_MSCF,
    p: v => v * BAR_TO_PSI,
    pInv: v => v / BAR_TO_PSI,
    gor: v => v * SM3SM3_TO_SCFBBL,
    pi: v => (v * SM3_TO_BBL) / BAR_TO_PSI,
    cum: v => v * SM3_TO_BBL,
    liqU: 'bbl/d', gasU: 'Mscf/d', pU: 'psi', gorU: 'scf/bbl', piU: 'bbl/d/psi', cumU: 'bbl',
  }
}

/** Expand unit tokens produced by the analysis layer: {q:Sm3/d} {p:bar} {dp:bar} {pi:Sm3/d/bar}. */
export function ev(text: string, u: Units): string {
  return text.replace(/\{(q|p|dp|pi):(-?[\d.eE+-]+)\}/g, (_, k, v) => {
    const n = +v
    if (k === 'q') return `${fmt(u.liq(n))} ${u.liqU}`
    if (k === 'p') return `${fmt(u.p(n))} ${u.pU}`
    if (k === 'dp') return `${fmt(u.p(n))} ${u.pU}`
    return `${fmt(u.pi(n), 2)} ${u.piU}`
  })
}

export const toBbl = (sm3: number) => sm3 * SM3_TO_BBL

export function fmt(v: number | null | undefined, digits = 0): string {
  if (v == null || !isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M'
  if (a >= 1e4 && digits === 0) return Math.round(v).toLocaleString('en-US')
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export const pct = (v: number | null | undefined, digits = 0) =>
  v == null || !isFinite(v) ? '—' : (v * 100).toFixed(digits) + ' %'

export const money = (usd: number) => {
  const a = Math.abs(usd)
  const s = a >= 1e6 ? `$${(a / 1e6).toFixed(1)} M` : a >= 1e3 ? `$${Math.round(a / 1e3)} k` : `$${Math.round(a)}`
  return usd < 0 ? '−' + s : s
}
