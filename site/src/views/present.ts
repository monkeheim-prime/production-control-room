// Full-screen review-meeting mode: summary → field waterfall → one slide per approved job → register.
import * as d3 from 'd3'
import type { Ctx } from '../main'
import { state } from '../core/state'
import { ev, fmt, money, pct } from '../core/units'
import { MECH_LABEL, review, type Opportunity } from '../analysis/diagnose'
import { CAT_COLOR, CAT_LABEL, type Cat } from '../analysis/econ'
import { axisStyle, drawIn, dur, h, responsive } from '../ui/kit'
import { stageOf } from './register'
import { AUTHOR } from '../core/credit'

export function openPresent({ ds, u }: Ctx) {
  const rv = review(ds, state.a)
  const opps = rv.opps
  const approved = opps.filter(o => ['Approved', 'Executed'].includes(stageOf(ds, opps, o)))
  const focus = (approved.length ? approved : opps.filter(o => o.e.rnpv > 0)).slice(0, 8)
  const flowing = [...rv.metrics.values()].filter(m => m.status === 'flowing')
  const today = d3.sum(flowing, m => m.oil)
  const issues = [...rv.dx.values()].filter(d => d.primary).length

  const slides: (() => HTMLElement)[] = [
    () => h('div', { class: 'slide' },
      h('span', { class: 'eyebrow' }, `${ds.label} · well-by-well review · prepared by ${AUTHOR}`),
      h('h1', {}, `${focus.length} interventions worth +${fmt(u.liq(d3.sum(focus, o => o.gain * o.ps)))} ${u.liqU} risked`),
      h('div', { class: 'kpis', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', maxWidth: '980px' } },
        big('Wells reviewed', String(ds.wells.length)), big('Wells with an issue', String(issues)),
        big('Opportunities', String(opps.length)), big(`Field oil today (${u.liqU})`, fmt(u.liq(today))),
        big('Risked NPV of plan', money(d3.sum(focus, o => o.e.rnpv))), big('Plan cost', money(d3.sum(focus, o => o.cost)))),
      h('p', { class: 'muted', style: { maxWidth: '760px', lineHeight: 1.6 } },
        'Screen → diagnose → evaluate → register. Use ← → to step through, Esc to close.')),
    () => {
      const box = h('div', { class: 'chart', style: { maxWidth: '1000px' } })
      const el = h('div', { class: 'slide' }, h('span', { class: 'eyebrow' }, 'Where the barrels are'), h('h1', {}, 'Risked gain by intervention type'), box)
      requestAnimationFrame(() => catBars(box, opps, u))
      return el
    },
    ...focus.map((o, i) => () => wellSlide(o, i + 1, focus.length)),
    () => h('div', { class: 'slide' }, h('span', { class: 'eyebrow' }, 'Decision'), h('h1', {}, 'Recommended plan'),
      h('div', { class: 'tablewrap' }, h('table', { class: 'data', style: { fontSize: '14px' } },
        h('thead', {}, h('tr', {}, h('th', {}, 'Well'), h('th', {}, 'Intervention'), h('th', { class: 'num' }, `P50 ${u.liqU}`), h('th', { class: 'num' }, 'Cost'), h('th', { class: 'num' }, 'P(s)'), h('th', { class: 'num' }, 'Risked NPV'))),
        h('tbody', {}, ...focus.map(o => h('tr', {}, h('td', { class: 'mono' }, o.well), h('td', {}, o.label), h('td', { class: 'num' }, fmt(u.liq(o.gain))),
          h('td', { class: 'num' }, money(o.cost)), h('td', { class: 'num' }, pct(o.ps)), h('td', { class: 'num' }, money(o.e.rnpv)))))))),
  ]

  function wellSlide(o: Opportunity, n: number, of: number) {
    const w = ds.wells.find(x => x.id === o.well)!
    const dx = rv.dx.get(o.well)
    const box = h('div', { class: 'chart' })
    const el = h('div', { class: 'slide' },
      h('span', { class: 'eyebrow' }, `Opportunity ${n} of ${of} · ${CAT_LABEL[o.cat]}`),
      h('h1', {}, `${o.well} — ${o.label}`),
      h('div', { class: 'row', style: { gap: '28px', alignItems: 'flex-start' } },
        h('div', { style: { flex: '2 1 520px' } }, box),
        h('div', { style: { flex: '1 1 300px', display: 'flex', flexDirection: 'column', gap: '10px', lineHeight: 1.6 } },
          h('div', {}, h('span', { class: 'eyebrow' }, 'Problem'), h('div', {}, dx?.primary ? MECH_LABEL[dx.primary.key] : 'Injector performance')),
          h('div', {}, h('span', { class: 'eyebrow' }, 'Evidence'), h('div', { class: 'muted' }, ev(o.rationale, u))),
          h('div', { class: 'kpis' }, big(`P50 gain (${u.liqU})`, fmt(u.liq(o.gain))), big('Risked NPV', money(o.e.rnpv)), big('Cost', money(o.cost)), big('Payback', o.e.payback ? `${o.e.payback} mo` : '>5 yr')),
          h('div', {}, h('span', { class: 'eyebrow' }, 'Before execution'), h('div', { class: 'muted' }, o.preJob.map(p => p.split(' — ')[0]).join(' · ') || 'Ready')))))
    requestAnimationFrame(() => history(box, w))
    return el
  }

  function history(box: HTMLElement, w: typeof ds.wells[0]) {
    const rows = ds.months.map((d, t) => ({ d, o: w.m.oil[t], wa: w.m.wat[t], wi: w.m.wi[t] })).slice(w.first, w.last + 1)
    responsive(box, 340, { t: 16, r: 16, b: 30, l: 56 }, ({ g, w: W, h: H }) => {
      g.selectAll('*').remove()
      const inj = w.type === 'injector'
      const xs = d3.scaleTime().domain(d3.extent(rows, r => r.d) as [Date, Date]).range([0, W])
      const ys = d3.scaleLinear().domain([0, u.liq(d3.max(rows, r => (inj ? r.wi ?? 0 : Math.max(r.o ?? 0, r.wa ?? 0))) || 1)]).range([H, 0]).nice()
      g.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(xs).ticks(6)).call(axisStyle)
      g.append('g').call(d3.axisLeft(ys).ticks(5, '~s')).call(axisStyle)
      const line = (k: 'o' | 'wa' | 'wi') => d3.line<typeof rows[0]>().defined(r => r[k] != null).x(r => xs(r.d)).y(r => ys(u.liq(Math.max(0, r[k] ?? 0))))
      const series: ['o' | 'wa' | 'wi', string, string][] = inj ? [['wi', 'var(--water)', 'injection']] : [['wa', 'var(--water)', 'water'], ['o', 'var(--oil)', 'oil']]
      series.forEach(([k, c, l], i) => {
        const p = g.append('path').datum(rows).attr('d', line(k)).attr('fill', 'none').attr('stroke', c).attr('stroke-width', 2)
        drawIn(p, 1400, i * 200)
        g.append('text').attr('class', 'lbl').attr('x', 6 + i * 130).attr('y', -4).attr('fill', c).text(`— ${l} (${u.liqU})`)
      })
    })
  }

  let i = 0
  const stage = h('div', { style: { flex: '1 1 auto', display: 'flex', minHeight: 0 } })
  const counter = h('span', {})
  const root = h('div', { class: 'present', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Review meeting' },
    stage,
    h('div', { class: 'foot' },
      h('button', { class: 'btn ghost', onclick: () => close() }, 'Esc  close'), h('span', {}, counter, ` · prepared by ${AUTHOR}`),
      h('div', { style: { display: 'flex', gap: '8px' } },
        h('button', { class: 'btn', 'aria-label': 'Previous slide', onclick: () => show(i - 1) }, '←'),
        h('button', { class: 'btn primary', 'aria-label': 'Next slide', onclick: () => show(i + 1) }, '→'))))
  function show(n: number) {
    i = Math.max(0, Math.min(slides.length - 1, n))
    stage.innerHTML = ''
    const s = slides[i]()
    if (dur(1)) s.classList.add('slide-enter')
    stage.append(s)
    counter.textContent = `${i + 1} / ${slides.length}`
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close()
    else if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); show(i + 1) }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); show(i - 1) }
  }
  function close() { removeEventListener('keydown', onKey); root.remove() }
  addEventListener('keydown', onKey)
  document.body.append(root)
  show(0)
  ;(root.querySelector('.foot .btn.primary') as HTMLElement).focus()
}

const big = (l: string, v: string) => h('div', { class: 'kpi' }, h('div', { class: 'l' }, l), h('div', { class: 'v', style: { fontSize: '26px' } }, v))

function catBars(box: HTMLElement, opps: Opportunity[], u: Ctx['u']) {
  const cats = (Object.keys(CAT_LABEL) as Cat[]).map(c => ({ c, v: d3.sum(opps.filter(o => o.cat === c), o => o.gain * o.ps), n: opps.filter(o => o.cat === c).length }))
  responsive(box, 320, { t: 10, r: 80, b: 20, l: 150 }, ({ g, w: W, h: H }) => {
    g.selectAll('*').remove()
    const ys = d3.scaleBand<string>().domain(cats.map(c => c.c)).range([0, H]).padding(0.35)
    const xs = d3.scaleLinear().domain([0, u.liq(d3.max(cats, c => c.v) || 1)]).range([0, W])
    g.selectAll('text.c').data(cats).join('text').attr('class', 'lbl-strong c').attr('x', -10).attr('y', c => ys(c.c)! + ys.bandwidth() / 2 + 4).attr('text-anchor', 'end').text(c => CAT_LABEL[c.c])
    g.selectAll('rect').data(cats).join('rect').attr('x', 0).attr('y', c => ys(c.c)!).attr('height', ys.bandwidth()).attr('width', 0).attr('fill', c => CAT_COLOR[c.c])
      .transition().delay((_, i) => dur(i * 180)).duration(dur(700)).attr('width', c => xs(u.liq(c.v)))
    g.selectAll('text.v').data(cats).join('text').attr('class', 'lbl-mono v').attr('y', c => ys(c.c)! + ys.bandwidth() / 2 + 4)
      .attr('x', c => xs(u.liq(c.v)) + 8).text(c => `${fmt(u.liq(c.v))} ${u.liqU} · ${c.n} jobs`)
  })
}
