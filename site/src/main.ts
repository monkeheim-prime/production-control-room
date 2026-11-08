import './style.css'
import { loadDataset, type Dataset } from './core/data'
import { go, onHashChange, readHash, set, state, subscribe, type Route, type State } from './core/state'
import { units } from './core/units'
import { AUTHOR } from './core/credit'
import { review } from './analysis/diagnose'
import { h } from './ui/kit'
import { openMethods } from './views/methods'
import { mountScreen } from './views/screen'
import { mountProducer } from './views/producer'
import { mountInjector } from './views/injector'
import { mountEvaluate } from './views/evaluate'
import { mountRegister } from './views/register'
import { openPresent } from './views/present'
import { mountForecast } from './views/forecast'
import { mountNodal } from './views/nodal'
import { mountGasLift } from './views/gaslift'
import { mountTransition } from './views/transition'

export interface Ctx { ds: Dataset; u: ReturnType<typeof units> }
type Mount = (el: HTMLElement, ctx: Ctx) => (() => void) | void

// group 'review' = the four-stage workflow; 'tools' = supporting engineering modules.
// `model` pages run on illustrative physics inputs and do not depend on the dataset toggle.
const VIEWS: Record<Route, { n: string; label: string; mount: Mount; group: 'review' | 'tools'; model?: true }> = {
  screen: { n: '1', label: 'Screen', mount: mountScreen, group: 'review' },
  producer: { n: '2', label: 'Diagnose producer', mount: mountProducer, group: 'review' },
  injector: { n: '2b', label: 'Diagnose injector', mount: mountInjector, group: 'review' },
  evaluate: { n: '3', label: 'Evaluate', mount: mountEvaluate, group: 'review' },
  register: { n: '4', label: 'Register', mount: mountRegister, group: 'review' },
  forecast: { n: 'T1', label: 'Decline & forecast', mount: mountForecast, group: 'tools' },
  nodal: { n: 'T2', label: 'Nodal analysis', mount: mountNodal, group: 'tools' },
  gaslift: { n: 'T3', label: 'Gas lift allocation', mount: mountGasLift, group: 'tools' },
  transition: { n: 'T4', label: 'CO₂ & geothermal', mount: mountTransition, group: 'tools', model: true },
}

const app = document.querySelector<HTMLDivElement>('#app')!
let cleanup: (() => void) | void
let current: Dataset | null = null

function boot() {
  let seen = false
  try { seen = sessionStorage.getItem('wbwr.boot') === '1' } catch { /* ignore */ }
  if (seen || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const el = h('div', { class: 'boot', role: 'presentation' },
    h('div', { class: 'inner' },
      h('div', { class: 'line' }, `PRODUCTION TECHNOLOGY // PREPARED BY ${AUTHOR.toUpperCase()}`),
      h('h1', {}, 'Screen › Diagnose › Evaluate › Register'),
      h('div', { class: 'line', style: { animationDelay: '.5s' } }, 'Loading wells, QA/QC, diagnostics…'),
      h('div', { class: 'bar' }, h('i'))))
  const close = () => { el.classList.add('off'); setTimeout(() => el.remove(), 500) }
  el.addEventListener('click', close)
  document.body.append(el)
  setTimeout(close, 1500)
  try { sessionStorage.setItem('wbwr.boot', '1') } catch { /* ignore */ }
}

function topbar() {
  const stage = (r: Route) => {
    const v = VIEWS[r]
    return h('a', { href: `#/${r}`, 'aria-current': state.route === r ? 'page' : null, onclick: (e: Event) => { e.preventDefault(); go(r) } },
      h('span', { class: 'n' }, v.n), v.label)
  }
  const seg = (opts: [string, string][], cur: string, on: (v: string) => void, label: string) =>
    h('div', { class: 'seg', role: 'group', 'aria-label': label },
      ...opts.map(([v, l]) => h('button', { 'aria-pressed': String(v === cur), onclick: () => on(v) }, l)))
  const routes = Object.keys(VIEWS) as Route[]
  return h('header', { class: 'topbar' },
    h('span', { class: 'brand' }, 'PRODUCTION CONTROL ROOM', h('span', { class: 'byline' }, `Prepared by ${AUTHOR}`)),
    h('nav', { class: 'stages', 'aria-label': 'Sections' },
      h('span', { class: 'group' }, 'Review'), ...routes.filter(r => VIEWS[r].group === 'review').map(stage),
      h('span', { class: 'group' }, 'Toolkit'), ...routes.filter(r => VIEWS[r].group === 'tools').map(stage)),
    h('span', { class: 'spacer' }),
    seg([['fieldx', 'Field X · synthetic'], ['volve', 'Volve · real']], state.ds, v => set({ ds: v as State['ds'], well: null, injector: null, opp: null }), 'Dataset'),
    seg([['field', 'FIELD'], ['si', 'SI']], state.units, v => set({ units: v as State['units'] }), 'Units'),
    h('button', { class: 'btn ghost', onclick: () => openMethods(state.route) }, 'Methods'),
    h('button', { class: 'btn', onclick: () => current && openPresent({ ds: current, u: units(state.units) }) }, '▶ Present'))
}

function banner(ds: Dataset) {
  if (VIEWS[state.route].model) return h('div', { class: 'banner' },
    h('span', { class: 'badge synthetic' }, 'ILLUSTRATIVE MODEL'),
    h('span', {}, 'Physics models with adjustable, generic inputs · independent of the dataset toggle · real public injection figures cited for scale'))
  return h('div', { class: 'banner' },
    ds.real ? h('span', { class: 'badge real' }, 'REAL DATA') : h('span', { class: 'badge synthetic' }, 'SYNTHETIC DATA'),
    h('span', {}, ds.real
      ? `${ds.label} · ${ds.producers.length} producers, ${ds.injectors.length} injectors · daily 2007–2016 · completions illustrative · reservoir pressure assumed`
      : `${ds.label} · ${ds.producers.length} producers, ${ds.injectors.length} injectors · monthly 2012–2025 · each well has a hidden "true" problem to test the diagnosis`))
}

function statusbar(ds: Dataset) {
  return h('footer', { class: 'statusbar' },
    ds.real
      ? h('span', {}, 'SRC ', h('a', { href: ds.url, target: '_blank', rel: 'noopener' }, 'Equinor & Volve licence partners'), ` · ${ds.licence}`)
      : h('span', {}, 'SRC pipeline/fieldx.py · synthetic, seed 42'),
    h('span', {}, 'UNITS ', state.units === 'field' ? 'field (bbl/d, psi)' : 'SI (Sm³/d, bar)'),
    h('span', { class: 'spacer' }),
    h('span', {}, 'STATE IN URL — share the link to share the view'),
    h('span', { class: 'credit' }, `Prepared by ${AUTHOR}`))
}

async function render() {
  const view = VIEWS[state.route]
  app.innerHTML = ''
  const main = h('main', { class: 'view', id: 'main' })
  app.append(h('div', { class: 'app' }, topbar(), h('div', { id: 'banner' }), main, h('div', { id: 'status' })))
  // On phones the section nav scrolls sideways: bring the current tab into view.
  const nav = app.querySelector<HTMLElement>('.stages'), cur = nav?.querySelector<HTMLElement>('a[aria-current]')
  if (nav && cur && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = cur.offsetLeft - nav.offsetLeft - 16
  main.append(h('div', { class: 'empty', style: { margin: '20px' } }, 'Loading data…'))
  const ds = await loadDataset(state.ds)
  current = ds
  review(ds, state.a)
  app.querySelector('#banner')!.replaceWith(banner(ds))
  app.querySelector('#status')!.replaceWith(statusbar(ds))
  if (typeof cleanup === 'function') cleanup()
  main.innerHTML = ''
  document.title = `${view.label} · Production control room · ${AUTHOR}`
  cleanup = view.mount(main, { ds, u: units(state.units) })
}

const REMOUNT: (keyof State)[] = ['route', 'ds', 'units', 'well', 'injector']
subscribe((_, changed) => { if (REMOUNT.some(k => changed.has(k))) render() })
readHash()
onHashChange(render)
boot()
render()
