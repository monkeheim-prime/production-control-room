import './style.css'
import { loadDataset, type Dataset } from './core/data'
import { go, onHashChange, readHash, set, state, subscribe, type Route, type State } from './core/state'
import { units } from './core/units'
import { review } from './analysis/diagnose'
import { h } from './ui/kit'
import { openMethods } from './views/methods'
import { mountScreen } from './views/screen'
import { mountProducer } from './views/producer'
import { mountInjector } from './views/injector'
import { mountEvaluate } from './views/evaluate'
import { mountRegister } from './views/register'
import { openPresent } from './views/present'

export interface Ctx { ds: Dataset; u: ReturnType<typeof units> }
type Mount = (el: HTMLElement, ctx: Ctx) => (() => void) | void

const VIEWS: Record<Route, { n: string; label: string; mount: Mount }> = {
  screen: { n: '1', label: 'Screen', mount: mountScreen },
  producer: { n: '2', label: 'Diagnose producer', mount: mountProducer },
  injector: { n: '2b', label: 'Diagnose injector', mount: mountInjector },
  evaluate: { n: '3', label: 'Evaluate', mount: mountEvaluate },
  register: { n: '4', label: 'Register', mount: mountRegister },
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
      h('div', { class: 'line' }, 'PRODUCTION TECHNOLOGY // WELL-BY-WELL REVIEW'),
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
  return h('header', { class: 'topbar' },
    h('span', { class: 'brand' }, 'WELL-BY-WELL REVIEW'),
    h('nav', { class: 'stages', 'aria-label': 'Review stages' }, ...(Object.keys(VIEWS) as Route[]).map(stage)),
    h('span', { class: 'spacer' }),
    seg([['fieldx', 'Field X · synthetic'], ['volve', 'Volve · real']], state.ds, v => set({ ds: v as State['ds'], well: null, injector: null, opp: null }), 'Dataset'),
    seg([['field', 'FIELD'], ['si', 'SI']], state.units, v => set({ units: v as State['units'] }), 'Units'),
    h('button', { class: 'btn ghost', onclick: () => openMethods(state.route) }, 'Methods'),
    h('button', { class: 'btn', onclick: () => current && openPresent({ ds: current, u: units(state.units) }) }, '▶ Present'))
}

function banner(ds: Dataset) {
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
    h('span', {}, 'STATE IN URL — share the link to share the view'))
}

async function render() {
  const view = VIEWS[state.route]
  app.innerHTML = ''
  const main = h('main', { class: 'view', id: 'main' })
  app.append(h('div', { class: 'app' }, topbar(), h('div', { id: 'banner' }), main, h('div', { id: 'status' })))
  main.append(h('div', { class: 'empty', style: { margin: '20px' } }, 'Loading data…'))
  const ds = await loadDataset(state.ds)
  current = ds
  review(ds, state.a)
  app.querySelector('#banner')!.replaceWith(banner(ds))
  app.querySelector('#status')!.replaceWith(statusbar(ds))
  if (typeof cleanup === 'function') cleanup()
  main.innerHTML = ''
  document.title = `${view.label} · Well-by-well review`
  cleanup = view.mount(main, { ds, u: units(state.units) })
}

const REMOUNT: (keyof State)[] = ['route', 'ds', 'units', 'well', 'injector']
subscribe((_, changed) => { if (REMOUNT.some(k => changed.has(k))) render() })
readHash()
onHashChange(render)
boot()
render()
