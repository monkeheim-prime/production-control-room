// Stage 3 — evaluate: risked gain, economics, and a budget/rig-constrained portfolio.
import * as d3 from 'd3'
import type { Ctx } from '../main'
import { go, set, setA, state } from '../core/state'
import { ev, fmt, money, pct } from '../core/units'
import { review, type Opportunity } from '../analysis/diagnose'
import { CAT_COLOR, CAT_LABEL, optimise, type Cat } from '../analysis/econ'
import { axisStyle, dur, h, legend, panel, responsive, slider, tip, tipRows } from '../ui/kit'

export function mountEvaluate(el: HTMLElement, { ds, u }: Ctx) {
  let picked: Set<string> = new Set()
  let pickOrder: string[] = []
  const rail = h('aside', { class: 'rail', 'aria-label': 'Assumptions' })
  const center = h('div', { class: 'center' })
  const card = h('aside', { class: 'rail right', 'aria-label': 'Selected opportunity' })
  el.append(h('div', { class: 'cols' }, rail, center, card))

  let raf = 0
  const changed = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { picked = new Set(); pickOrder = []; redrawAll() }) }
  const a = state.a
  const optBtn = h('button', { class: 'btn primary', onclick: () => runOptimiser() }, 'Optimise portfolio ▶') as HTMLButtonElement
  const applyBtn = h('button', { class: 'btn', disabled: true, onclick: () => applyToRegister() }, 'Approve optimised set → Register') as HTMLButtonElement
  const optOut = h('div', { class: 'small muted' })
  rail.append(
    h('span', { class: 'eyebrow' }, 'Assumptions'),
    slider('Oil price', a.oilPrice, 40, 120, 1, v => `$${v} /bbl`, v => { setA({ oilPrice: v }); changed() }),
    slider('Opex', a.opex, 5, 40, 1, v => `$${v} /bbl`, v => { setA({ opex: v }); changed() }),
    slider('Intervention budget', a.budget / 1e6, 2, 40, 0.5, v => `$${v} M`, v => { setA({ budget: v * 1e6 }); changed() }),
    slider('Rig / vessel days', a.rigDays, 10, 200, 5, v => `${v} d`, v => { setA({ rigDays: v }); changed() }),
    slider('Gain decline', a.gainDecline * 100, 5, 60, 1, v => `${v} %/yr`, v => { setA({ gainDecline: v / 100 }); changed() }),
    slider('Discount rate', a.discount * 100, 5, 20, 0.5, v => `${v} %`, v => { setA({ discount: v / 100 }); changed() }),
    h('div', { class: 'panel', style: { padding: '10px' } }, h('span', { class: 'eyebrow' }, 'Portfolio optimiser'),
      h('span', { class: 'small muted' }, 'Picks the set with the highest total risked NPV that fits the budget and rig days (0/1 knapsack).'),
      optBtn, optOut, applyBtn),
    h('div', { class: 'small muted' }, 'Costs, success probabilities and rig days per intervention type are generic illustrative values (see Methods).'))

  const wfBox = h('div', { class: 'chart' }), bubBox = h('div', { class: 'chart' }), frBox = h('div', { class: 'chart' })
  center.append(
    panel('Field oil — today → risked potential', 'bars build left to right', wfBox),
    h('div', { class: 'row' },
      h('div', { style: { flex: '2 1 480px', display: 'flex' } }, panel('Opportunity map — cost vs risked gain', legend((Object.keys(CAT_LABEL) as Cat[]).map(c => ({ label: CAT_LABEL[c], color: CAT_COLOR[c] }))), bubBox)),
      h('div', { style: { flex: '1 1 300px', display: 'flex' } }, panel('Efficient frontier', 'ranked by risked NPV per $', frBox))))

  let opps: Opportunity[] = []
  let bubbleG: d3.Selection<SVGGElement, unknown, null, undefined> | null = null
  let cfChart: { destroy: () => void } | null = null
  const charts = [
    responsive(wfBox, 220, { t: 20, r: 16, b: 34, l: 56 }, f => drawWaterfall(f)),
    responsive(bubBox, 360, { t: 16, r: 24, b: 40, l: 60 }, f => drawBubbles(f)),
    responsive(frBox, 360, { t: 16, r: 18, b: 40, l: 56 }, f => drawFrontier(f)),
  ]
  function redrawAll() {
    opps = review(ds, state.a).opps
    if (!state.opp || !opps.some(o => o.id === state.opp)) state.opp = opps[0]?.id ?? null
    charts.forEach(c => c.redraw())
    renderCard()
  }

  // ---------- waterfall ----------
  function drawWaterfall({ g, w: W, h: H }: { g: d3.Selection<SVGGElement, unknown, null, undefined>; w: number; h: number }) {
    g.selectAll('*').remove()
    const rv = review(ds, state.a)
    const today = d3.sum([...rv.metrics.values()].filter(m => m.status === 'flowing'), m => m.oil)
    const cats = Object.keys(CAT_LABEL) as Cat[]
    const add = cats.map(c => ({ c, v: d3.sum(rv.opps.filter(o => o.cat === c), o => o.gain) }))
    const unrisk = d3.sum(add, a => a.v)
    const risked = d3.sum(rv.opps, o => o.gain * o.ps)
    const steps: { label: string; y0: number; y1: number; color: string; kind: string }[] = [{ label: 'Today', y0: 0, y1: today, color: 'var(--dim)', kind: 'total' }]
    let run = today
    add.forEach(a => { steps.push({ label: `+ ${CAT_LABEL[a.c]}`, y0: run, y1: run + a.v, color: CAT_COLOR[a.c], kind: 'add' }); run += a.v })
    steps.push({ label: '− risk', y0: run, y1: today + risked, color: 'var(--warn)', kind: 'risk' })
    steps.push({ label: 'Risked potential', y0: 0, y1: today + risked, color: 'var(--ink-2)', kind: 'total' })
    const xs = d3.scaleBand<string>().domain(steps.map(s => s.label)).range([0, W]).padding(0.3)
    const ys = d3.scaleLinear().domain([0, u.liq(today + unrisk) * 1.08]).range([H, 0]).nice()
    g.append('g').call(d3.axisLeft(ys).ticks(4, '~s')).call(axisStyle)
    g.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(xs)).call(axisStyle).selectAll('text').style('font-family', 'var(--sans)').style('font-size', '11px')
    g.append('text').attr('class', 'lbl').attr('x', 0).attr('y', -6).text(`oil ${u.liqU}`)
    const bars = g.selectAll('rect.wf').data(steps).join('rect').attr('class', 'wf').attr('x', s => xs(s.label)!).attr('width', xs.bandwidth())
      .attr('y', s => ys(u.liq(Math.max(s.y0, s.y1)))).attr('height', 0)
      .attr('fill', s => (s.kind === 'risk' ? 'none' : s.color)).attr('stroke', s => (s.kind === 'risk' ? s.color : 'none')).attr('stroke-dasharray', s => (s.kind === 'risk' ? '4 3' : null))
    bars.transition().delay((_, i) => dur(i * 260)).duration(dur(500)).ease(d3.easeCubicOut)
      .attr('height', s => Math.max(1, Math.abs(ys(u.liq(s.y0)) - ys(u.liq(s.y1)))))
    g.selectAll('text.v').data(steps).join('text').attr('class', 'lbl-mono v').attr('text-anchor', 'middle')
      .attr('x', s => xs(s.label)! + xs.bandwidth() / 2).attr('y', s => ys(u.liq(Math.max(s.y0, s.y1))) - 5).attr('opacity', 0)
      .text(s => (s.kind === 'total' ? fmt(u.liq(s.y1)) : `${s.y1 >= s.y0 ? '+' : '−'}${fmt(u.liq(Math.abs(s.y1 - s.y0)))}`))
      .transition().delay((_, i) => dur(i * 260 + 300)).attr('opacity', 1)
  }

  // ---------- bubbles ----------
  function drawBubbles({ g, w: W, h: H }: { g: d3.Selection<SVGGElement, unknown, null, undefined>; w: number; h: number }) {
    g.selectAll('*').remove()
    bubbleG = g
    const xs = d3.scaleLinear().domain([0, (d3.max(opps, o => o.cost) || 1) / 1e6 * 1.1]).range([0, W]).nice()
    const ys = d3.scaleLinear().domain([0, u.liq(d3.max(opps, o => o.gain * o.ps) || 1) * 1.15]).range([H, 0]).nice()
    const rs = d3.scaleSqrt().domain([0, d3.max(opps, o => Math.max(0, o.e.rnpv)) || 1]).range([4, 26])
    g.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(xs).ticks(6).tickFormat(d => `$${d}M`)).call(axisStyle)
    g.append('g').call(d3.axisLeft(ys).ticks(5, '~s')).call(axisStyle)
    g.append('text').attr('class', 'lbl').attr('x', W / 2).attr('y', H + 34).attr('text-anchor', 'middle').text('Cost')
    g.append('text').attr('class', 'lbl').attr('transform', `translate(-46,${H / 2}) rotate(-90)`).attr('text-anchor', 'middle').text(`Risked oil gain (${u.liqU})`)
    g.append('text').attr('class', 'lbl').attr('x', W).attr('y', 10).attr('text-anchor', 'end').text('size = risked NPV · opacity = P(success)')
    const sorted = [...opps].sort((a, b) => b.e.rnpv - a.e.rnpv)
    g.selectAll('circle.b').data(sorted, (o: any) => o.id).join('circle').attr('class', 'b')
      .attr('cx', o => xs(o.cost / 1e6)).attr('cy', H).attr('r', 0)
      .attr('fill', o => CAT_COLOR[o.cat]).attr('fill-opacity', o => 0.25 + o.ps * 0.6)
      .attr('stroke', 'var(--panel)').attr('stroke-width', 2).style('cursor', 'pointer')
      .on('pointermove', (ev, o) => tip(tipRows(`${o.well} · ${o.label}`, [['Risked gain', `${fmt(u.liq(o.gain * o.ps))} ${u.liqU}`], ['Cost', money(o.cost)], ['P(success)', pct(o.ps)], ['Risked NPV', money(o.e.rnpv)]]), ev))
      .on('pointerleave', () => tip(null))
      .on('click', (_, o) => { set({ opp: o.id }); markSel(); renderCard() })
      .transition().duration(dur(700)).delay((_, i) => dur(i * 25)).ease(d3.easeBackOut.overshoot(1.2))
      .attr('cy', o => ys(u.liq(o.gain * o.ps))).attr('r', o => rs(Math.max(0, o.e.rnpv)))
    const top = sorted.slice(0, 5)
    g.selectAll('text.bl').data(top).join('text').attr('class', 'lbl-mono bl').style('pointer-events', 'none')
      .attr('x', o => xs(o.cost / 1e6) + rs(Math.max(0, o.e.rnpv)) + 4).attr('y', o => ys(u.liq(o.gain * o.ps)) + 4).text(o => o.well)
      .attr('opacity', 0).transition().delay(dur(900)).attr('opacity', 1)
    markSel()
  }
  function markSel() {
    bubbleG?.selectAll<SVGCircleElement, Opportunity>('circle.b')
      .attr('stroke', o => (o.id === state.opp ? 'var(--ink-strong)' : picked.has(o.id) ? 'var(--ink-2)' : 'var(--panel)'))
      .attr('stroke-width', o => (o.id === state.opp ? 3 : picked.has(o.id) ? 2.5 : 2))
      .attr('stroke-dasharray', o => (picked.has(o.id) && o.id !== state.opp ? '3 2' : null))
  }

  // ---------- frontier ----------
  function drawFrontier({ g, w: W, h: H }: { g: d3.Selection<SVGGElement, unknown, null, undefined>; w: number; h: number }) {
    g.selectAll('*').remove()
    const pos = opps.filter(o => o.e.rnpv > 0).sort((a, b) => b.e.rnpv / b.cost - a.e.rnpv / a.cost)
    let cc = 0, cv = 0
    const pts = [{ c: 0, v: 0, o: null as Opportunity | null }, ...pos.map(o => { cc += o.cost; cv += o.e.rnpv; return { c: cc, v: cv, o } })]
    const xs = d3.scaleLinear().domain([0, Math.max(cc, state.a.budget) / 1e6 * 1.05]).range([0, W]).nice()
    const ys = d3.scaleLinear().domain([0, (cv || 1) / 1e6 * 1.08]).range([H, 0]).nice()
    g.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(xs).ticks(5).tickFormat(d => `$${d}M`)).call(axisStyle)
    g.append('g').call(d3.axisLeft(ys).ticks(5).tickFormat(d => `$${d}M`)).call(axisStyle)
    g.append('text').attr('class', 'lbl').attr('x', W / 2).attr('y', H + 34).attr('text-anchor', 'middle').text('Cumulative spend')
    g.append('text').attr('class', 'lbl').attr('transform', `translate(-44,${H / 2}) rotate(-90)`).attr('text-anchor', 'middle').text('Cumulative risked NPV')
    const bx = xs(state.a.budget / 1e6)
    g.append('rect').attr('x', bx).attr('y', 0).attr('width', Math.max(0, W - bx)).attr('height', H).attr('fill', 'var(--panel-2)').attr('opacity', 0.6)
    g.append('line').attr('x1', bx).attr('x2', bx).attr('y1', 0).attr('y2', H).attr('stroke', 'var(--warn)').attr('stroke-dasharray', '4 3')
    g.append('text').attr('class', 'lbl').attr('x', bx - 4).attr('y', 12).attr('text-anchor', 'end').attr('fill', 'var(--warn)').text('budget')
    const line = g.append('path').datum(pts).attr('fill', 'none').attr('stroke', 'var(--ink)').attr('stroke-width', 2)
      .attr('d', d3.line<typeof pts[0]>().x(p => xs(p.c / 1e6)).y(p => ys(p.v / 1e6)).curve(d3.curveMonotoneX))
    const len = (line.node() as SVGPathElement).getTotalLength()
    if (dur(1)) line.attr('stroke-dasharray', `${len} ${len}`).attr('stroke-dashoffset', len).transition().duration(dur(1200)).attr('stroke-dashoffset', 0)
    g.selectAll('circle').data(pts.slice(1)).join('circle').attr('cx', p => xs(p.c / 1e6)).attr('cy', p => ys(p.v / 1e6)).attr('r', 3.5)
      .attr('fill', p => (p.c <= state.a.budget ? CAT_COLOR[p.o!.cat] : 'var(--dim)'))
      .on('pointermove', (ev, p) => tip(tipRows(`${p.o!.well} · ${p.o!.label}`, [['Cum. spend', money(p.c)], ['Cum. risked NPV', money(p.v)]]), ev))
      .on('pointerleave', () => tip(null))
  }

  // ---------- optimiser ----------
  function runOptimiser() {
    const sel = optimise(opps.map(o => ({ id: o.id, cost: o.cost, rig: o.rig, value: o.e.rnpv })), state.a.budget, state.a.rigDays)
    picked = new Set(); pickOrder = sel
    const byId = new Map(opps.map(o => [o.id, o]))
    sel.forEach((id, i) => setTimeout(() => { picked.add(id); markSel(); summary() }, dur(140 * i)))
    if (!dur(1)) { picked = new Set(sel); markSel() }
    const summary = () => {
      const ps = [...picked].map(id => byId.get(id)!)
      optOut.textContent = `${ps.length} jobs · ${money(d3.sum(ps, o => o.cost))} · ${d3.sum(ps, o => o.rig)} rig days · risked NPV ${money(d3.sum(ps, o => o.e.rnpv))} · +${fmt(u.liq(d3.sum(ps, o => o.gain * o.ps)))} ${u.liqU} risked`
    }
    summary()
    applyBtn.disabled = sel.length === 0
  }
  function applyToRegister() {
    const stages = { ...state.stages }
    const key = (id: string) => `${ds.id}:${id}`
    for (const o of opps) if (pickOrder.includes(o.id)) { if (stages[key(o.id)] !== 'Executed') stages[key(o.id)] = 'Approved' }
    set({ stages })
    go('register')
  }

  // ---------- card ----------
  function renderCard() {
    card.innerHTML = ''
    const o = opps.find(x => x.id === state.opp)
    if (!o) { card.append(h('div', { class: 'empty' }, 'No opportunities at current assumptions.')); return }
    const gs = d3.scaleLinear().domain([0, o.p10 * 1.1]).range([0, 100])
    const cfBox = h('div', { class: 'chart' })
    const cell = (l: number, i: number) => h('div', { style: { height: '22px', background: l + i >= 5 ? 'var(--panel-3)' : 'var(--panel-2)', display: 'grid', placeItems: 'center', fontSize: '12px' } },
      o.risk[0] === l && o.risk[1] === i ? '●' : '')
    card.append(
      h('span', { class: 'eyebrow' }, `${o.well} · ${CAT_LABEL[o.cat]}`),
      h('h2', { style: { margin: 0, fontSize: '16px' } }, o.label),
      h('div', { class: 'small muted' }, ev(o.rationale, u)),
      h('div', { class: 'panel', style: { padding: '10px' } },
        h('span', { class: 'small muted' }, `Oil gain range (${u.liqU})`),
        h('div', { style: { position: 'relative', height: '24px', background: 'var(--panel-2)' } },
          h('div', { style: { position: 'absolute', left: `${gs(o.p90)}%`, width: `${gs(o.p10) - gs(o.p90)}%`, top: '9px', height: '6px', background: 'var(--dim)' } }),
          h('div', { style: { position: 'absolute', left: `${gs(o.gain)}%`, width: '3px', top: '3px', height: '18px', background: 'var(--ink-strong)' } })),
        h('div', { class: 'mono small', style: { display: 'flex', justifyContent: 'space-between' } },
          h('span', {}, `P90 ${fmt(u.liq(o.p90))}`), h('span', {}, `P50 ${fmt(u.liq(o.gain))}`), h('span', {}, `P10 ${fmt(u.liq(o.p10))}`))),
      h('div', { class: 'kpis' },
        kpi('Cost', money(o.cost)), kpi('P(success)', pct(o.ps)), kpi('Risked NPV', money(o.e.rnpv)),
        kpi('Payback', o.e.payback ? `${o.e.payback} mo` : '> 5 yr'), kpi('NPV if successful', money(o.e.npv)), kpi('Rig days', String(o.rig))),
      h('div', { class: 'panel', style: { padding: '10px' } }, h('span', { class: 'small muted' }, 'Cumulative cash (success case, 5 yr)'), cfBox),
      h('div', { class: 'panel', style: { padding: '10px', gap: '6px' } },
        h('span', { class: 'small muted' }, 'Risk matrix — likelihood (rows) × impact (cols)'),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '3px' } },
          ...[3, 2, 1].flatMap(l => [1, 2, 3].map(i => cell(l, i)))),
        h('span', { class: 'small' }, o.riskText)),
      h('span', { class: 'eyebrow' }, 'Pre-job data'),
      ...(o.preJob.length ? o.preJob.map(p => h('span', { class: 'small' }, `• ${p}`)) : [h('span', { class: 'small muted' }, 'None required')]),
      h('button', { class: 'btn', onclick: () => go(o.mech === 'inj' ? 'injector' : 'producer', o.mech === 'inj' ? { injector: o.well } : { well: o.well }) }, `Open ${o.well} diagnosis`))
    cfChart?.destroy()
    cfChart = responsive(cfBox, 110, { t: 6, r: 6, b: 18, l: 44 }, ({ g, w: W, h: H }) => {
      g.selectAll('*').remove()
      const prof = o.e.profile
      const xs = d3.scaleLinear().domain([0, prof.length]).range([0, W])
      const ys = d3.scaleLinear().domain(d3.extent([...prof, 0]) as [number, number]).range([H, 0]).nice()
      g.append('g').call(d3.axisLeft(ys).ticks(3).tickFormat(d => money(+d))).call(axisStyle)
      g.append('line').attr('x1', 0).attr('x2', W).attr('y1', ys(0)).attr('y2', ys(0)).attr('stroke', 'var(--line)')
      g.append('path').datum(prof).attr('fill', 'none').attr('stroke', 'var(--oil)').attr('stroke-width', 2)
        .attr('d', d3.line<number>().x((_, i) => xs(i)).y(v => ys(v)))
      if (o.e.payback) g.append('circle').attr('cx', xs(o.e.payback)).attr('cy', ys(0)).attr('r', 4).attr('fill', 'var(--ink-strong)')
    })
  }

  redrawAll()
  return () => { charts.forEach(c => c.destroy()); cfChart?.destroy(); tip(null) }
}

const kpi = (l: string, v: string) => h('div', { class: 'kpi' }, h('div', { class: 'l' }, l), h('div', { class: 'v', style: { fontSize: '16px' } }, v))
