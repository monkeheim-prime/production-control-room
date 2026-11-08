// Tiny observable store. The URL hash mirrors the shareable parts (route, dataset, units, well).
import type { UnitSystem } from './units'

export type Route = 'screen' | 'producer' | 'injector' | 'evaluate' | 'register' | 'forecast' | 'nodal' | 'gaslift' | 'transition' | 'flowassurance' | 'lift' | 'network' | 'events'
export type DatasetId = 'fieldx' | 'volve'
export type ScreenView = 'map' | 'hi' | 'pareto' | 'gap' | 'drive'

export interface Assumptions {
  oilPrice: number      // USD/bbl
  opex: number          // USD/bbl
  budget: number        // USD
  rigDays: number
  gainDecline: number   // fraction per year
  discount: number      // fraction per year
  volvePres: number     // bar, assumed reservoir pressure for Volve PI
  volvePwfMin: number   // bar, assumed minimum flowing BHP with artificial lift
}

export interface State {
  route: Route
  ds: DatasetId
  units: UnitSystem
  well: string | null
  injector: string | null
  screenView: ScreenView
  t: number | null            // month index for screening (null = latest)
  opp: string | null          // selected opportunity id
  a: Assumptions
  stages: Record<string, string>  // opportunity id -> stage override
}

export const DEFAULT_ASSUMPTIONS: Assumptions = {
  oilPrice: 72, opex: 18, budget: 12e6, rigDays: 90, gainDecline: 0.25, discount: 0.1,
  volvePres: 310, volvePwfMin: 150,
}

type Listener = (s: State, changed: Set<keyof State>) => void
const listeners = new Set<Listener>()

function loadStages(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem('wbwr.stages') || '{}') } catch { return {} }
}

export const state: State = {
  route: 'screen', ds: 'fieldx', units: 'field', well: null, injector: null,
  screenView: 'hi', t: null, opp: null, a: { ...DEFAULT_ASSUMPTIONS }, stages: loadStages(),
}

export function set(patch: Partial<State>) {
  const changed = new Set<keyof State>()
  for (const k of Object.keys(patch) as (keyof State)[]) {
    if (state[k] !== patch[k]) { changed.add(k); (state as any)[k] = patch[k] }
  }
  if (!changed.size) return
  if (changed.has('stages')) {
    try { localStorage.setItem('wbwr.stages', JSON.stringify(state.stages)) } catch { /* private mode */ }
  }
  writeHash()
  listeners.forEach(l => l(state, changed))
}

export function setA(patch: Partial<Assumptions>) { set({ a: { ...state.a, ...patch } }) }

export function subscribe(l: Listener) { listeners.add(l); return () => listeners.delete(l) }

const ROUTES: Route[] = ['screen', 'producer', 'injector', 'evaluate', 'register', 'forecast', 'nodal', 'gaslift', 'transition', 'flowassurance', 'lift', 'network', 'events']

export function readHash() {
  const h = location.hash.replace(/^#\/?/, '')
  const [path, qs] = h.split('?')
  const q = new URLSearchParams(qs || '')
  const route = (ROUTES as string[]).includes(path) ? (path as Route) : 'screen'
  const patch: Partial<State> = { route }
  const ds = q.get('ds'); if (ds === 'volve' || ds === 'fieldx') patch.ds = ds
  const u = q.get('u'); if (u === 'si' || u === 'field') patch.units = u
  if (q.get('w')) patch.well = q.get('w')
  if (q.get('i')) patch.injector = q.get('i')
  const v = q.get('v'); if (v && ['map', 'hi', 'pareto', 'gap', 'drive'].includes(v)) patch.screenView = v as ScreenView
  if (q.get('o')) patch.opp = q.get('o')
  Object.assign(state, patch)
}

let writing = false
function writeHash() {
  const q = new URLSearchParams()
  q.set('ds', state.ds); q.set('u', state.units)
  if (state.route === 'screen') q.set('v', state.screenView)
  if (['producer', 'forecast', 'nodal'].includes(state.route) && state.well) q.set('w', state.well)
  if (state.route === 'injector' && state.injector) q.set('i', state.injector)
  if ((state.route === 'evaluate' || state.route === 'register') && state.opp) q.set('o', state.opp)
  const next = `#/${state.route}?${q.toString()}`
  if (location.hash !== next) { writing = true; history.replaceState(null, '', next); writing = false }
}

export function onHashChange(cb: () => void) {
  window.addEventListener('hashchange', () => { if (!writing) { readHash(); cb() } })
}

export function go(route: Route, patch: Partial<State> = {}) {
  set({ ...patch, route })
  window.scrollTo({ top: 0 })
}
