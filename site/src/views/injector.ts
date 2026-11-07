// Stage 2b — injector review: modified Hall plot, rate connectivity, voidage replacement.
import * as d3 from 'd3'
import type { Ctx } from '../main'
import { fmtMonth } from '../core/data'
import { go, set, state } from '../core/state'
import { fmt } from '../core/units'
import { review } from '../analysis/diagnose'
import { vrr, type HallResult } from '../analysis/hall'
import { axisStyle, drawIn, dur, h, legend, panel, reduced, responsive, tip, tipRows } from '../ui/kit'

export function mountInjector(el: HTMLElement, { ds, u }: Ctx) {
  const injs = ds.injectors
  const w = injs.find(x => x.id === state.injector) ?? injs[0]
  if (state.injector !== w.id) state.injector = w.id
  const rv = review(ds, state.a)
  const dx = rv.inj.get(w.id)!
  const destroyers: (() => void)[] = []

  const sel = h('select', { 'aria-label': 'Injector' }, ...injs.map(x => h('option', { value: x.id, selected: x.id === w.id }, x.id))) as HTMLSelectElement
  sel.addEventListener('change', () => set({ injector: sel.value }))
  const cumWi = d3.sum(w.m.wi, v => (v ?? 0) * 30.44)
  el.append(h('div', { class: 'banner', style: { background: 'var(--panel)', gap: '8px 24px' } },
    sel, h('span', { class: 'mono', style: { fontSize: '16px', color: 'var(--ink-strong)' } }, `${w.name} · water injector`),
    h('span', { class: 'small' }, h('span', { class: 'muted' }, 'Online '), fmtMonth(ds.months[w.first])),
    h('span', { class: 'small' }, h('span', { class: 'muted' }, 'Cum. injected '), `${fmt(u.cum(cumWi) / 1e6, 1)} M${u.cumU}`),
    h('span', { class: 'small' }, h('span', { class: 'muted' }, 'Pressure data '), dx.hall.available ? (dx.hall.pressureSource === 'bhp' ? 'downhole' : 'wellhead') : 'none in public data')))

  const main = h('div', { class: 'center' })
  const side = h('aside', { class: 'rail right', style: { maxWidth: '460px', flexBasis: '400px' } })
  el.append(h('div', { class: 'cols' }, main, side))

  // Hall plot (or injection history when pressure is missing)
  const hallBox = h('div', { class: 'chart' })
  if (dx.hall.available) {
    main.append(panel('Modified Hall plot — integral and derivative vs cumulative injection',
      legend([{ label: 'Hall integral', color: 'var(--ink)' }, { label: 'Derivative (dHI / d ln Wi)', color: 'var(--water)' }]), hallBox,
      h('div', { class: 'row small muted', style: { gap: '20px' } },
        h('span', {}, 'Curves overlap → stable matrix injection'), h('span', {}, 'Derivative above → plugging / skin'), h('span', {}, 'Derivative below → fracture or thief zone'))))
    destroyers.push(hallChart(hallBox, dx.hall, u))
  } else {
    main.append(h('div', { class: 'empty' },
      h('strong', {}, 'Hall analysis not possible from this dataset. '),
      'The public Volve production file records injected volumes for F-4 and F-5 but not injection pressure. ',
      'Below: real injection history, rate-based connectivity and voidage replacement. Switch to Field X to see Hall diagnostics on injectors with pressure.'))
    main.append(panel('Injection history', `${u.liqU}`, hallBox))
    destroyers.push(rateChart(hallBox, ds.months, w.m.wi, u))
  }
  const vrrBox = h('div', { class: 'chart' })
  main.append(panel(`Voidage replacement ratio — ${ds.id === 'fieldx' ? `block ${w.block}` : 'field'}`, 'dashed = 1.0 (pressure maintained) · amber < 0.9 · Bo = 1.25 assumed', vrrBox))
  destroyers.push(vrrChart(vrrBox, ds, ds.id === 'fieldx' ? w.block : null))

  // connectivity + diagnosis
  const netBox = h('div', { class: 'chart' })
  side.append(panel('Injector → producer connectivity', 'line weight = correlation; pulses flow toward producers', netBox,
    h('div', { class: 'small muted' }, 'Pearson r of month-on-month injection change vs producer liquid change one month later. Correlation is a screening signal, not proof — confirm with tracer.')))
  destroyers.push(network(netBox, ds, w, dx.links))
  side.append(h('section', { class: 'panel' },
    h('header', {}, h('h2', {}, 'Diagnosis')),
    h('p', { class: 'small', style: { margin: 0, lineHeight: 1.6 } }, dx.verdict),
    dx.hall.ratio != null ? h('div', { class: 'small muted' }, `Mean DHI / HI over the last third: ${dx.hall.ratio.toFixed(2)}`) : null,
    w.truth ? h('details', { class: 'small' }, h('summary', { class: 'muted' }, 'Reveal synthetic truth'), `Generated as: ${w.truth}`) : null,
    h('span', { class: 'eyebrow' }, 'Next steps'),
    ...dx.next.map((n, i) => h('span', { class: 'small' }, `${i + 1}. ${n}`)),
    ...rv.opps.filter(o => o.well === w.id).map(o => h('button', { class: 'btn', style: { justifyContent: 'space-between' }, onclick: () => go('evaluate', { opp: o.id }) }, h('span', {}, o.label), h('span', { class: 'mono small' }, 'Evaluate →')))))
  return () => { destroyers.forEach(f => f()); tip(null) }
}

function hallChart(box: HTMLElement, hall: HallResult, u: Ctx['u']) {
  const pts = hall.pts
  return responsive(box, w => Math.max(320, Math.min(440, w * 0.5)), { t: 16, r: 20, b: 40, l: 62 }, f => {
    const { g, w: W, h: H } = f
    g.selectAll('*').remove()
    const xs = d3.scaleLinear().domain([0, u.cum(d3.max(pts, p => p.wi)!)]).range([0, W]).nice()
    const ymax = d3.max(pts, p => Math.max(p.hi, p.dhi ?? 0))!
    const ys = d3.scaleLinear().domain([0, u.p(ymax)]).range([H, 0]).nice()
    g.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(xs).ticks(6, '~s')).call(axisStyle)
    g.append('g').call(d3.axisLeft(ys).ticks(5, '~s')).call(axisStyle)
    g.append('text').attr('class', 'lbl').attr('x', W / 2).attr('y', H + 34).attr('text-anchor', 'middle').text(`Cumulative water injected (${u.cumU})`)
    g.append('text').attr('class', 'lbl').attr('transform', `translate(-48,${H / 2}) rotate(-90)`).attr('text-anchor', 'middle').text(`∫ Δp dt (${u.pU}·day)`)
    // separation band
    if (hall.onset != null) {
      const band = pts.slice(hall.onset).filter(p => p.dhi != null)
      const area = d3.area<typeof band[0]>().x(p => xs(u.cum(p.wi))).y0(p => ys(u.p(p.hi))).y1(p => ys(u.p(p.dhi!)))
      g.append('path').datum(band).attr('d', area).attr('fill', hall.verdict === 'matrix' ? 'var(--muted)' : 'var(--warn)').attr('opacity', 0)
        .transition().delay(dur(1600)).duration(dur(600)).attr('opacity', 0.14)
      const x0 = xs(u.cum(pts[hall.onset].wi))
      g.append('line').attr('x1', x0).attr('x2', x0).attr('y1', 0).attr('y2', H).attr('stroke', 'var(--warn)').attr('stroke-dasharray', '3 4').attr('opacity', 0)
        .transition().delay(dur(1600)).attr('opacity', 1)
      g.append('text').attr('class', 'lbl-mono').attr('x', x0 + 6).attr('y', 14).attr('fill', 'var(--warn)').attr('opacity', 0)
        .text(hall.verdict === 'fracture' ? 'DERIVATIVE BELOW → FRACTURE / THIEF ZONE' : hall.verdict === 'plugging' ? 'DERIVATIVE ABOVE → PLUGGING' : 'MINOR SEPARATION')
        .transition().delay(dur(1700)).attr('opacity', 1)
    }
    const hiP = g.append('path').datum(pts).attr('fill', 'none').attr('stroke', 'var(--ink)').attr('stroke-width', 2)
      .attr('d', d3.line<typeof pts[0]>().x(p => xs(u.cum(p.wi))).y(p => ys(u.p(p.hi))))
    const dP = g.append('path').datum(pts.filter(p => p.dhi != null)).attr('fill', 'none').attr('stroke', 'var(--water)').attr('stroke-width', 2)
      .attr('d', d3.line<typeof pts[0]>().x(p => xs(u.cum(p.wi))).y(p => ys(u.p(p.dhi!))))
    drawIn(hiP, 1500); drawIn(dP, 1500, 150)
    g.append('rect').attr('width', W).attr('height', H).attr('fill', 'transparent')
      .on('pointermove', ev => {
        const [mx] = d3.pointer(ev)
        const i = d3.bisector((p: typeof pts[0]) => u.cum(p.wi)).center(pts, xs.invert(mx))
        const p = pts[i]
        tip(tipRows(`Cum ${fmt(u.cum(p.wi))} ${u.cumU}`, [['Hall integral', fmt(u.p(p.hi))], ['Derivative', p.dhi == null ? '—' : fmt(u.p(p.dhi))], ['Ratio', p.dhi == null ? '—' : (p.dhi / p.hi).toFixed(2)]]), ev)
      }).on('pointerleave', () => tip(null))
  }, 'Modified Hall plot').destroy
}

function rateChart(box: HTMLElement, months: Date[], wi: (number | null)[], u: Ctx['u']) {
  const rows = months.map((d, i) => ({ d, v: wi[i] })).filter(r => r.v != null && r.v > 0)
  return responsive(box, 260, { t: 10, r: 16, b: 30, l: 56 }, f => {
    const { g, w: W, h: H } = f
    g.selectAll('*').remove()
    const xs = d3.scaleTime().domain(d3.extent(rows, r => r.d) as [Date, Date]).range([0, W])
    const ys = d3.scaleLinear().domain([0, u.liq(d3.max(rows, r => r.v!)!)]).range([H, 0]).nice()
    g.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(xs).ticks(6)).call(axisStyle)
    g.append('g').call(d3.axisLeft(ys).ticks(4, '~s')).call(axisStyle)
    const p = g.append('path').datum(rows).attr('fill', 'none').attr('stroke', 'var(--water)').attr('stroke-width', 1.8)
      .attr('d', d3.line<typeof rows[0]>().x(r => xs(r.d)).y(r => ys(u.liq(r.v!))))
    drawIn(p, 1200)
  }, 'Injection rate history').destroy
}

function vrrChart(box: HTMLElement, ds: Ctx['ds'], block: string | null) {
  const rows = vrr(ds, block).map(r => ({ d: ds.months[r.t], v: r.v }))
  return responsive(box, 170, { t: 10, r: 16, b: 28, l: 44 }, f => {
    const { g, w: W, h: H } = f
    g.selectAll('*').remove()
    if (!rows.length) return
    const xs = d3.scaleBand<Date>().domain(rows.map(r => r.d)).range([0, W]).padding(0.15)
    const ys = d3.scaleLinear().domain([0, Math.max(1.6, d3.quantile(rows.map(r => r.v).sort(d3.ascending), 0.98)!)]).range([H, 0]).clamp(true)
    g.append('g').call(d3.axisLeft(ys).ticks(4)).call(axisStyle)
    const tx = d3.scaleTime().domain(d3.extent(rows, r => r.d) as [Date, Date]).range([0, W])
    g.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(tx).ticks(6)).call(axisStyle)
    g.selectAll('rect').data(rows).join('rect').attr('x', r => xs(r.d)!).attr('width', Math.max(1, xs.bandwidth()))
      .attr('y', H).attr('height', 0).attr('fill', r => (r.v < 0.9 ? 'var(--warn)' : 'var(--muted)')).attr('opacity', 0.85)
      .on('pointermove', (ev, r) => tip(tipRows(fmtMonth(r.d), [['VRR', r.v.toFixed(2)]]), ev)).on('pointerleave', () => tip(null))
      .transition().delay((_, i) => dur(i * 4)).duration(dur(400)).attr('y', r => ys(r.v)).attr('height', r => H - ys(r.v))
    g.append('line').attr('x1', 0).attr('x2', W).attr('y1', ys(1)).attr('y2', ys(1)).attr('stroke', 'var(--ink)').attr('stroke-dasharray', '4 3')
  }, 'Voidage replacement ratio').destroy
}

function lineGuide(g: d3.Selection<SVGGElement, unknown, null, undefined>, cx: number, cy: number, R: number) {
  for (const f of [0.35, 0.675, 1]) g.append('circle').attr('cx', cx).attr('cy', cy).attr('r', R * f).attr('fill', 'none').attr('stroke', 'var(--line-soft)').attr('stroke-dasharray', '2 4')
  g.append('text').attr('class', 'lbl').attr('x', cx + 4).attr('y', cy - R * 0.35 - 4).style('font-size', '9px').text('strong')
  g.append('text').attr('class', 'lbl').attr('x', cx + 4).attr('y', cy - R - 4).style('font-size', '9px').text('weak')
}

function network(box: HTMLElement, ds: Ctx['ds'], inj: Ctx['ds']['wells'][0], links: { prod: string; r: number }[]) {
  const shown = links.filter(l => l.r > 0.12).slice(0, 8)
  let timer: d3.Timer | null = null
  const r = responsive(box, 340, { t: 16, r: 60, b: 16, l: 16 }, f => {
    const { g, w: W, h: H } = f
    g.selectAll('*').remove()
    timer?.stop()
    const nodes = new Map<string, { x: number; y: number }>()
    if (inj.x != null) {
      // true bearing from the injector; distance shrinks as correlation grows
      nodes.set(inj.id, { x: W / 2, y: H / 2 })
      const R = Math.min(W, H) / 2 - 34
      // keep the real bearing order but space wells evenly so labels do not collide
      const near = links.map(l => ({ l, p: ds.wells.find(x => x.id === l.prod)! }))
        .filter(({ l, p }) => p.block === inj.block || l.r > 0.12)
        .map(d => ({ ...d, b: Math.atan2(-(d.p.y! - inj.y!), d.p.x! - inj.x!) }))
        .sort((a, b) => a.b - b.b)
      near.forEach((d, i) => {
        const ang = near[0].b + (i / near.length) * Math.PI * 2
        const rad = R * (0.35 + 0.65 * (1 - Math.max(0, Math.min(1, d.l.r))))
        nodes.set(d.l.prod, { x: W / 2 + Math.cos(ang) * rad, y: H / 2 + Math.sin(ang) * rad })
      })
      lineGuide(g, W / 2, H / 2, R)
    } else {
      nodes.set(inj.id, { x: W / 2, y: H / 2 })
      links.forEach((l, i) => { const a = (i / links.length) * Math.PI * 2 - Math.PI / 2; nodes.set(l.prod, { x: W / 2 + Math.cos(a) * W * 0.36, y: H / 2 + Math.sin(a) * H * 0.38 }) })
    }
    const c = nodes.get(inj.id)!
    const lineG = g.append('g'), pulseG = g.append('g'), nodeG = g.append('g')
    const drawn = shown.filter(l => nodes.has(l.prod))
    lineG.selectAll('line').data(drawn).join('line').attr('x1', c.x).attr('y1', c.y).attr('x2', c.x).attr('y2', c.y)
      .attr('stroke', l => (l.r > 0.5 ? 'var(--warn)' : 'var(--water)')).attr('stroke-opacity', 0.65).attr('stroke-width', l => 1 + l.r * 7)
      .transition().duration(dur(800)).attr('x2', l => nodes.get(l.prod)!.x).attr('y2', l => nodes.get(l.prod)!.y)
    for (const [id, p] of nodes) {
      const isInj = id === inj.id
      const link = links.find(l => l.prod === id)
      const gg = nodeG.append('g').attr('transform', `translate(${p.x},${p.y})`)
      if (isInj) gg.append('path').attr('d', d3.symbol(d3.symbolTriangle, 160)).attr('fill', 'var(--panel-3)').attr('stroke', 'var(--ink-strong)').attr('stroke-width', 2)
      else gg.append('circle').attr('r', 6).attr('fill', 'var(--panel-2)').attr('stroke', link && link.r > 0.12 ? 'var(--ink)' : 'var(--line)')
      if (isInj || (link && link.r > 0.12) || inj.x == null) gg.append('text').attr('class', isInj ? 'lbl-strong' : 'lbl').attr('x', isInj ? -12 : 10).attr('y', isInj ? 22 : 4).text(id + (link && link.r > 0.12 ? `  r=${link.r.toFixed(2)}` : ''))
      if (!isInj) gg.on('pointermove', ev => tip(tipRows(id, [['Correlation r', link ? link.r.toFixed(2) : '—']]), ev)).on('pointerleave', () => tip(null))
    }
    if (!drawn.length) g.append('text').attr('class', 'lbl').attr('x', W / 2).attr('y', H - 6).attr('text-anchor', 'middle').text('No producer shows a positive rate correlation above 0.12')
    if (reduced() || !drawn.length) return
    const pulses = drawn.flatMap(l => d3.range(3).map(k => ({ l, off: k / 3 })))
    const dots = pulseG.selectAll('circle').data(pulses).join('circle').attr('r', 2.6).attr('fill', 'var(--water)')
    timer = d3.timer(el => {
      dots.each(function (p) {
        const to = nodes.get(p.l.prod)!
        const s = ((el / 1000) * (0.15 + p.l.r * 0.6) + p.off) % 1
        d3.select(this).attr('cx', c.x + (to.x - c.x) * s).attr('cy', c.y + (to.y - c.y) * s).attr('opacity', Math.sin(s * Math.PI))
      })
    })
  }, 'Injector to producer connectivity')
  return () => { timer?.stop(); r.destroy() }
}
