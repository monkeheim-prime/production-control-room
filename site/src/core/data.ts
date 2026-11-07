// Loads both datasets and normalises them to one monthly well model.
// Volve keeps its daily series for the high-resolution history lanes.
import type { Assumptions, DatasetId } from './state'

export type Num = number | null
export interface QAFlag { rule: string; severity: 'high' | 'medium' | 'low' | 'pass' | 'info'; days: number; unit?: string; first: string; last: string; detail: string }
export interface Ev { t: number; date: Date; type: string; label: string }
export interface Test { t: number; ql: number; pwf: number; wc: number; pres: number }
export interface Zone { top: number; base: number; name: string }
export interface Completion {
  illustrative: boolean; lift: string; td: number; tvd?: number; tubing?: number; sssv?: number; packer?: number
  glm?: number[]; esp?: number | null; zones: Zone[]; suspectZone?: number | null
  barriers?: { name: string; status: 'ok' | 'warn' }[]
}
export interface Monthly { oil: Num[]; wat: Num[]; gas: Num[]; gl: Num[]; wi: Num[]; bhp: Num[]; whp: Num[]; choke: Num[]; hrs: Num[] }
export interface HiRes { dates: Date[]; oil: Num[]; wat: Num[]; gas: Num[]; gl: Num[]; wi: Num[]; bhp: Num[]; whp: Num[]; choke: Num[]; hrs: Num[] }

export interface Well {
  id: string; name: string; type: 'producer' | 'injector'; block: string; lift: string
  x: number | null; y: number | null
  completion: Completion; qa: QAFlag[]; events: Ev[]; tests: Test[]
  truth?: string; links?: { inj: string; w: number }[]; pwfMin: number | null
  m: Monthly; hi: HiRes; first: number; last: number
}

export interface Dataset {
  id: DatasetId; label: string; real: boolean; frequency: 'daily' | 'monthly'
  source?: string; licence?: string; url?: string; note?: string
  months: Date[]; wells: Well[]; producers: Well[]; injectors: Well[]
  blockPres: Record<string, Num[]>
}

const KEYS = ['oil', 'wat', 'gas', 'gl', 'wi', 'bhp', 'whp', 'choke', 'hrs'] as const
const RATE_KEYS = new Set(['oil', 'wat', 'gas', 'gl', 'wi', 'hrs']) // calendar-day averages; hrs/24 = uptime

const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
const addMonths = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1))
const monthDiff = (a: Date, b: Date) => (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth()
export const fmtMonth = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`

function emptyMonthly(n: number): Monthly {
  const o: any = {}
  for (const k of KEYS) o[k] = new Array(n).fill(null)
  return o
}

function span(m: Monthly): [number, number] {
  const liv = (i: number) => (m.oil[i] ?? 0) > 0 || (m.wi[i] ?? 0) > 0
  let a = 0, b = m.oil.length - 1
  while (a < b && !liv(a)) a++
  while (b > a && !liv(b)) b--
  return [a, b]
}

async function getJSON(name: string) {
  const res = await fetch(`${import.meta.env.BASE_URL}data/${name}`)
  if (!res.ok) throw new Error(`failed to load ${name}`)
  return res.json()
}

// ---------- Volve ----------
function volveEvents(hi: HiRes, months0: Date): Ev[] {
  const ev: Ev[] = []
  const n = hi.dates.length
  const t = (i: number) => monthDiff(months0, monthStart(hi.dates[i]))
  const firstFlow = hi.oil.findIndex(v => (v ?? 0) > 0)
  const firstInj = hi.wi.findIndex(v => (v ?? 0) > 0)
  const f0 = firstFlow >= 0 ? firstFlow : firstInj
  if (f0 >= 0) ev.push({ t: t(f0), date: hi.dates[f0], type: 'start', label: firstFlow >= 0 ? 'Online' : 'Injection start' })
  // shut-ins: >= 10 consecutive days with no hours after flowing
  let run = 0
  for (let i = Math.max(f0, 0); i < n; i++) {
    const off = (hi.hrs[i] ?? 0) < 0.5
    run = off ? run + 1 : 0
    if (run === 10) ev.push({ t: t(i - 9), date: hi.dates[i - 9], type: 'shutin', label: 'Shut-in ≥ 10 days' })
  }
  // choke steps: 15-day median moves by > 15 points
  const med = (a: number) => {
    const xs = hi.choke.slice(Math.max(0, a - 7), a + 8).filter((v): v is number => v != null && v > 0).sort((x, y) => x - y)
    return xs.length ? xs[xs.length >> 1] : null
  }
  let last: number | null = null, lastI = -999
  for (let i = 0; i < n; i += 5) {
    const m = med(i)
    if (m == null) continue
    if (last != null && Math.abs(m - last) > 15 && i - lastI > 60) {
      ev.push({ t: t(i), date: hi.dates[i], type: 'choke', label: `Choke ${Math.round(last)} → ${Math.round(m)} %` })
      lastI = i
    }
    last = m
  }
  // water breakthrough: 30-day WC first above 10 %
  for (let i = 30; i < n; i++) {
    let o = 0, w = 0
    for (let k = i - 30; k < i; k++) { o += hi.oil[k] ?? 0; w += Math.max(0, hi.wat[k] ?? 0) }
    if (o > 0 && w / (o + w) > 0.1) { ev.push({ t: t(i), date: hi.dates[i], type: 'breakthrough', label: 'Water breakthrough (WC > 10 %)' }); break }
  }
  return ev.sort((a, b) => +a.date - +b.date)
}

function loadVolve(raw: any): Dataset {
  const starts = raw.wells.map((w: any) => new Date(w.start + 'T00:00:00Z'))
  const ends = raw.wells.map((w: any, i: number) => new Date(+starts[i] + (w.days - 1) * 864e5))
  const m0 = monthStart(new Date(Math.min(...starts.map(Number))))
  const m1 = monthStart(new Date(Math.max(...ends.map(Number))))
  const nM = monthDiff(m0, m1) + 1
  const months = Array.from({ length: nM }, (_, i) => addMonths(m0, i))

  const wells: Well[] = raw.wells.map((w: any, wi: number): Well => {
    const s = w.series
    const dates = Array.from({ length: w.days }, (_, i) => new Date(+starts[wi] + i * 864e5))
    const hi: HiRes = { dates, oil: s.oil, wat: s.wat, gas: s.gas, gl: new Array(w.days).fill(null), wi: s.wi, bhp: s.bhp, whp: s.whp, choke: s.choke, hrs: s.hrs }
    const m = emptyMonthly(nM)
    const acc: Record<string, { sum: number; n: number; days: number }[]> = {}
    for (const k of KEYS) acc[k] = Array.from({ length: nM }, () => ({ sum: 0, n: 0, days: 0 }))
    dates.forEach((d, i) => {
      const t = monthDiff(m0, monthStart(d))
      for (const k of KEYS) {
        const v = (hi as any)[k][i] as Num
        const a = acc[k][t]
        a.days++
        if (v == null) continue
        if (RATE_KEYS.has(k)) { a.sum += v; a.n++ }
        else if (v > 0) { a.sum += v; a.n++ }
      }
    })
    for (const k of KEYS) {
      for (let t = 0; t < nM; t++) {
        const a = acc[k][t]
        if (!a.days || !a.n) continue
        ;(m as any)[k][t] = RATE_KEYS.has(k) ? a.sum / a.days : k === 'hrs' ? a.sum / a.n : a.sum / a.n
      }
    }
    const [first, last] = span(m)
    const c = w.completion
    return {
      id: w.id, name: w.name, type: w.type, block: 'Hugin', lift: c.lift ?? '—', x: null, y: null,
      completion: { ...c, zones: (c.zones ?? []).map((z: any) => ({ top: z[0], base: z[1], name: z[2] })), barriers: undefined },
      qa: w.qa, events: volveEvents(hi, m0), tests: [], pwfMin: null, m, hi, first, last,
    }
  })
  return finish({
    id: 'volve', label: raw.meta.label, real: true, frequency: 'daily', source: raw.meta.source,
    licence: raw.meta.licence, url: raw.meta.url, months, wells, producers: [], injectors: [], blockPres: {},
  })
}

// ---------- Field X ----------
function loadFieldX(raw: any): Dataset {
  const [y, mo] = raw.meta.start.split('-').map(Number)
  const m0 = new Date(Date.UTC(y, mo - 1, 1))
  const nM = raw.meta.months
  const months = Array.from({ length: nM }, (_, i) => addMonths(m0, i))
  const blockPres: Record<string, Num[]> = {}
  raw.blocks.forEach((b: any) => { blockPres[b.id] = b.pres })
  const wells: Well[] = raw.wells.map((w: any): Well => {
    const m = emptyMonthly(nM)
    for (const k of KEYS) if (w.series[k]) (m as any)[k] = w.series[k]
    const hi: HiRes = { dates: months, ...m }
    const [first, last] = span(m)
    const c = w.completion
    return {
      id: w.id, name: w.id, type: w.type, block: w.block, lift: w.lift, x: w.x, y: w.y,
      completion: { ...c, zones: c.zones.map((z: any) => ({ top: z[0], base: z[1], name: z[2] })) },
      qa: w.qa, events: (w.events ?? []).map((e: any) => ({ ...e, date: months[Math.min(e.t, nM - 1)] })),
      tests: w.tests ?? [], truth: w.truth, links: w.links, pwfMin: w.pwfMin ?? null, m, hi, first, last,
    }
  })
  return finish({
    id: 'fieldx', label: raw.meta.label, real: false, frequency: 'monthly', note: raw.meta.note,
    months, wells, producers: [], injectors: [], blockPres,
  })
}

function finish(d: Dataset): Dataset {
  d.producers = d.wells.filter(w => w.type === 'producer')
  d.injectors = d.wells.filter(w => w.type === 'injector')
  return d
}

export const parseDataset = (id: DatasetId, raw: any) => (id === 'volve' ? loadVolve(raw) : loadFieldX(raw))

const cache: Partial<Record<DatasetId, Promise<Dataset>>> = {}
export function loadDataset(id: DatasetId): Promise<Dataset> {
  if (!cache[id]) cache[id] = getJSON(`${id}.json`).then(raw => parseDataset(id, raw))
  return cache[id]!
}

/** Reservoir pressure seen by a well at month t (bar). Volve has no public pressure survey: an assumption. */
export function presAt(ds: Dataset, w: Well, t: number, a: Assumptions): number {
  if (ds.id === 'volve') return a.volvePres
  const p = ds.blockPres[w.block]?.[t]
  return p ?? a.volvePres
}

export function pwfMinFor(ds: Dataset, w: Well, a: Assumptions): number {
  return ds.id === 'volve' ? a.volvePwfMin : (w.pwfMin ?? 100)
}
