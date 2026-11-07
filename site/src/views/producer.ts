// Stage 2 — producer deep-dive: linked history lanes, Chan plot, PI trend, nodal gap, schematic, diagnosis.
import * as d3 from 'd3'
import type { Ctx } from '../main'
import { fmtMonth, presAt, pwfMinFor, type Dataset, type Well } from '../core/data'
import { go, set, setA, state, subscribe } from '../core/state'
import { ev, fmt, pct } from '../core/units'
import { MECH_CAT, MECH_LABEL, TRUTH_TO_MECH, review, type Diagnosis } from '../analysis/diagnose'
import { CAT_COLOR } from '../analysis/econ'
import { piSeries, piReference, WC_PI_PENALTY } from '../analysis/metrics'
import { axisStyle, drawIn, dur, h, legend, panel, reduced, responsive, slider, tip, tipRows } from '../ui/kit'

const EV_COLOR: Record<string, string> = {
  start: 'var(--ink)', breakthrough: 'var(--warn)', shutin: 'var(--muted)', choke: 'var(--ink)', sand: 'var(--cat-mech)',
  workover: 'var(--cat-stim)', gl_change: 'var(--cat-lift)',
}

export function mountProducer(el: HTMLElement, ctx: Ctx) {
  const { ds } = ctx
  const wells = ds.producers
  const w = wells.find(x => x.id === state.well) ?? wells[0]
  if (state.well !== w.id) state.well = w.id
  const idx = wells.indexOf(w)
  const nav = (d: number) => set({ well: wells[(idx + d + wells.length) % wells.length].id })

  const destroyers: (() => void)[] = []
  const head = h('div', { class: 'banner', style: { background: 'var(--panel)', gap: '8px 24px' } })
  const body = h('div', { class: 'cols' })
  el.append(head, body)

  // identity strip
  const sel = h('select', { 'aria-label': 'Well' }, ...wells.map(x => h('option', { value: x.id, selected: x.id === w.id }, x.id))) as HTMLSelectElement
  sel.addEventListener('change', () => set({ well: sel.value }))
  const cum = d3.sum(w.m.oil, v => (v ?? 0) * 30.44)
  head.append(
    h('button', { class: 'btn', 'aria-label': 'Previous well', onclick: () => nav(-1) }, '◂'), sel,
    h('button', { class: 'btn', 'aria-label': 'Next well', onclick: () => nav(1) }, '▸'),
    h('span', { class: 'mono', style: { fontSize: '16px', color: 'var(--ink-strong)' } }, w.name),
    kv('Lift', w.lift), kv('Block', w.block), kv('Online', fmtMonth(ds.months[w.first])),
    kv('Cum. oil', `${fmt(ctx.u.cum(cum) / 1e6, 2)} M${ctx.u.cumU}`),
    kv('QA flags', String(w.qa.filter(q => q.severity !== 'pass' && q.severity !== 'info').length)),
    h('span', { class: 'spacer' }),
    h('a', { href: '#/screen', class: 'small muted', onclick: (e: Event) => { e.preventDefault(); go('screen') } }, '← back to screen'))

  const main = h('div', { class: 'center' })
  const aside = h('aside', { class: 'rail right', style: { maxWidth: '300px', flexBasis: '260px' } })
  body.append(main, aside)

  // persistent assumption bar for Volve (kept outside the re-rendered area so sliders keep focus)
  if (ds.id === 'volve') {
    main.append(h('div', { class: 'panel', style: { flexDirection: 'row', flexWrap: 'wrap', gap: '16px', alignItems: 'end' } },
      h('div', { style: { flex: '2 1 260px' }, class: 'small' }, h('span', { class: 'eyebrow' }, 'Assumptions (not in public data)'),
        h('div', { class: 'muted' }, 'Volve has no public reservoir-pressure survey. PI, damage and lift diagnoses depend on these — drag to test sensitivity.')),
      h('div', { style: { flex: '1 1 200px' } }, slider('Reservoir pressure', state.a.volvePres, 220, 380, 5, v => `${fmt(ctx.u.p(v))} ${ctx.u.pU}`, v => setA({ volvePres: v }))),
      h('div', { style: { flex: '1 1 200px' } }, slider('Min. flowing BHP with lift', state.a.volvePwfMin, 80, 250, 5, v => `${fmt(ctx.u.p(v))} ${ctx.u.pU}`, v => setA({ volvePwfMin: v })))))
  }
  const dyn = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } })
  main.append(dyn)

  const render = () => {
    destroyers.splice(0).forEach(f => f())
    dyn.innerHTML = ''; aside.innerHTML = ''
    const rv = review(ds, state.a)
    const dx = rv.dx.get(w.id)
    if (!dx) { dyn.append(h('div', { class: 'empty' }, 'This well has not started producing.')); return }
    const lanesBox = h('div', { class: 'chart' })
    const playBtn = h('button', { class: 'btn' }, '▶ Replay life') as HTMLButtonElement
    dyn.append(panel('Production history — linked lanes, shared time axis',
      h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 16px' } },
        legend([{ label: 'Oil', color: 'var(--oil)' }, { label: 'Water', color: 'var(--water)' }, { label: 'Gas', color: 'var(--gas)' }, { label: 'Lift gas', color: 'var(--gas)', dash: true }, { label: 'BHP', color: 'var(--ink)' }, { label: 'WHP', color: 'var(--muted)' }, { label: 'Well test', color: 'var(--ink-strong)', hollow: true }]),
        h('span', { class: 'small muted' }, 'Brush the strip at the bottom to zoom'), playBtn),
      lanesBox))
    destroyers.push(lanes(lanesBox, ds, w, ctx, playBtn))

    const chanBox = h('div', { class: 'chart' }), piBox = h('div', { class: 'chart' }), nodalBox = h('div', { class: 'chart' })
    const tplBtn = h('button', { class: 'btn ghost small', 'aria-pressed': 'false' }, 'Show reference shapes') as HTMLButtonElement
    dyn.append(h('div', { class: 'row' },
      panel('Chan diagnostic (log–log)', tplBtn, chanBox, h('div', { class: 'small muted' }, chanVerdict(dx))),
      panel('Productivity trend', ds.id === 'volve' ? 'assumed Pres' : 'block Pres from model', piBox, h('div', { class: 'small muted' }, piVerdict(dx, ctx))),
      panel('Actual vs potential (nodal)', 'linear IPR', nodalBox, h('div', { class: 'small muted' }, nodalVerdict(dx, ctx, ds)))))
    destroyers.push(chanChart(chanBox, dx, tplBtn), piChart(piBox, ds, w, ctx), nodalChart(nodalBox, ds, w, dx, ctx))
    dyn.append(diagnosisPanel(w, dx, rv.opps.filter(o => o.well === w.id), ctx.u))
    aside.append(schematic(w, dx))
  }
  render()
  const unsub = subscribe((_, ch) => { if (ch.has('a')) render() })
  return () => { destroyers.forEach(f => f()); unsub(); tip(null) }
}

const kv = (k: string, v: string) => h('span', { class: 'small' }, h('span', { class: 'muted' }, `${k} `), v)

// ---------------------------------------------------------------- lanes
function lanes(box: HTMLElement, ds: Dataset, w: Well, { u }: Ctx, playBtn: HTMLButtonElement) {
  const hi = w.hi
  const daily = ds.frequency === 'daily'
  // trim to producing life
  const i0 = Math.max(0, hi.oil.findIndex(v => (v ?? 0) > 0) - (daily ? 10 : 1))
  let i1 = hi.dates.length - 1
  while (i1 > i0 && !((hi.oil[i1] ?? 0) > 0)) i1--
  i1 = Math.min(hi.dates.length - 1, i1 + (daily ? 30 : 2))
  const idx = d3.range(i0, i1 + 1)
  const dates = idx.map(i => hi.dates[i])
  const get = (k: keyof typeof hi) => idx.map(i => (hi[k] as (number | null)[])[i])
  const S = {
    oil: get('oil').map(v => (v == null ? null : u.liq(v))), wat: get('wat').map(v => (v == null ? null : u.liq(Math.max(0, v)))),
    gas: get('gas').map(v => (v == null ? null : u.gas(v))), gl: get('gl').map(v => (v == null || v === 0 ? null : u.gas(v))),
    bhp: get('bhp').map(v => (v == null || v <= 0 ? null : u.p(v))), whp: get('whp').map(v => (v == null || v <= 0 ? null : u.p(v))),
    choke: get('choke').map(v => (v == null || v <= 0 ? null : v)), hrs: get('hrs'),
  }
  const LANES = [
    { key: 'liq', title: `LIQUID ${u.liqU}`, h: 120, series: [['oil', 'var(--oil)'], ['wat', 'var(--water)']] },
    { key: 'gas', title: `GAS ${u.gasU}`, h: 70, series: [['gas', 'var(--gas)'], ['gl', 'var(--gas)']] },
    { key: 'p', title: `PRESSURE ${u.pU}`, h: 96, series: [['bhp', 'var(--ink)'], ['whp', 'var(--muted)']] },
    { key: 'ch', title: 'CHOKE %', h: 52, series: [['choke', 'var(--ink-2)']] },
  ] as const
  const EVH = 34, CTX = 44, GAP = 22
  const total = LANES.reduce((s, l) => s + l.h + GAP, 0) + EVH + CTX + 24
  let x = d3.scaleTime().domain(d3.extent(dates) as [Date, Date])
  const x0 = x.copy()
  let playing = false

  const r = responsive(box, total, { t: 18, r: 14, b: 22, l: 64 }, (f) => {
    const { g, w: W } = f
    g.selectAll('*').remove()
    x.range([0, W]); x0.range([0, W])
    const clipId = `clip-${w.id.replace(/\W/g, '')}`
    const defs = f.svg.selectAll('defs').data([0]).join('defs')
    defs.selectAll('clipPath').remove()
    const clipRect = defs.append('clipPath').attr('id', clipId).append('rect').attr('width', W).attr('height', total).attr('y', -6)
    let y = 0
    const laneG: { g: d3.Selection<SVGGElement, unknown, null, undefined>; ys: d3.ScaleLinear<number, number>; lane: typeof LANES[number] }[] = []
    for (const lane of LANES) {
      const lg = g.append('g').attr('transform', `translate(0,${y})`)
      const vals = lane.series.flatMap(([k]) => (S as any)[k] as (number | null)[]).filter((v): v is number => v != null)
      const ys = d3.scaleLinear().domain([0, (d3.quantile(vals.sort(d3.ascending), 0.995) || 1) * 1.08]).range([lane.h, 0]).nice()
      lg.append('g').call(d3.axisLeft(ys).ticks(lane.h > 80 ? 4 : 2).tickSize(-W).tickFormat(d3.format('~s'))).call(axisStyle)
        .call(s => s.selectAll('.tick line').attr('stroke', 'var(--line-soft)')).call(s => s.select('.domain').remove())
      lg.append('text').attr('class', 'eyebrow').attr('x', 0).attr('y', -7).attr('fill', 'var(--muted)').style('font-family', 'var(--mono)').style('font-size', '10px').text(lane.title)
      const pg = lg.append('g').attr('clip-path', `url(#${clipId})`).attr('class', 'paths')
      lane.series.forEach(([k, c]) => {
        pg.append('path').datum((S as any)[k] as (number | null)[]).attr('class', `s-${k}`).attr('fill', 'none').attr('stroke', c)
          .attr('stroke-width', daily ? 1.1 : 1.8).attr('stroke-dasharray', k === 'gl' ? '4 3' : null).attr('opacity', k === 'whp' ? 0.9 : 1)
      })
      laneG.push({ g: lg, ys, lane })
      y += lane.h + GAP
    }
    // well tests on pressure lane
    const pLane = laneG[2]
    const tests = w.tests.map(t => ({ d: ds.months[t.t], v: u.p(t.pwf) }))
    // events lane
    const evG = g.append('g').attr('transform', `translate(0,${y + 4})`)
    evG.append('text').attr('class', 'eyebrow').attr('y', -2).attr('fill', 'var(--muted)').style('font-family', 'var(--mono)').style('font-size', '10px').text('EVENTS')
    const evLines = g.append('g').attr('clip-path', `url(#${clipId})`)
    y += EVH
    // context + brush
    const ctxG = g.append('g').attr('transform', `translate(0,${y + 10})`)
    const yc = d3.scaleLinear().domain([0, d3.max(S.oil, v => v ?? 0) || 1]).range([CTX - 10, 0])
    ctxG.append('path').datum(S.oil).attr('fill', 'var(--panel-3)').attr('stroke', 'var(--oil)').attr('stroke-width', 0.8)
      .attr('d', d3.area<number | null>().defined(v => v != null).x((_, i) => x0(dates[i])).y0(CTX - 10).y1(v => yc(v ?? 0)))
    ctxG.append('g').attr('transform', `translate(0,${CTX - 10})`).call(d3.axisBottom(x0).ticks(Math.max(3, W / 110))).call(axisStyle)
    const brush = d3.brushX().extent([[0, 0], [W, CTX - 10]]).on('brush end', (ev) => {
      x = ev.selection ? x0.copy().domain((ev.selection as [number, number]).map(x0.invert)) : x0.copy()
      draw(0)
    })
    ctxG.append('g').attr('class', 'brush').call(brush)
      .call(s => s.selectAll('.selection').attr('fill', 'var(--ink)').attr('fill-opacity', 0.08).attr('stroke', 'var(--muted)'))

    // crosshair
    const cross = g.append('line').attr('y1', 0).attr('y2', y - EVH + 20).attr('stroke', 'var(--ink-strong)').attr('stroke-opacity', 0).attr('pointer-events', 'none')
    g.append('rect').attr('width', W).attr('height', y - 4).attr('fill', 'transparent')
      .on('pointermove', (ev) => {
        const [mx] = d3.pointer(ev)
        const d = x.invert(mx)
        const i = Math.max(0, Math.min(dates.length - 1, d3.bisector((dd: Date) => dd).center(dates, d)))
        cross.attr('x1', x(dates[i])).attr('x2', x(dates[i])).attr('stroke-opacity', 0.5)
        const f1 = (v: number | null, dgt = 0) => (v == null ? '—' : fmt(v, dgt))
        const wc = S.oil[i] != null && S.wat[i] != null && S.oil[i]! + S.wat[i]! > 0 ? S.wat[i]! / (S.oil[i]! + S.wat[i]!) : null
        tip(tipRows(daily ? dates[i].toISOString().slice(0, 10) : fmtMonth(dates[i]), [
          ['Oil', `${f1(S.oil[i])} ${u.liqU}`], ['Water', `${f1(S.wat[i])} ${u.liqU}`], ['Water cut', pct(wc)],
          ['Gas', `${f1(S.gas[i])} ${u.gasU}`], ['BHP', `${f1(S.bhp[i])} ${u.pU}`], ['WHP', `${f1(S.whp[i])} ${u.pU}`],
          ['Choke', S.choke[i] == null ? '—' : `${fmt(S.choke[i]!)} %`], ['Hours', S.hrs[i] == null ? '—' : fmt(S.hrs[i]!, 1)],
        ]), ev)
      })
      .on('pointerleave', () => { cross.attr('stroke-opacity', 0); tip(null) })
      .lower()

    function draw(ms: number) {
      for (const { g: lg, ys, lane } of laneG) {
        lane.series.forEach(([k]) => {
          const line = d3.line<number | null>().defined(v => v != null).x((_, i) => x(dates[i])).y(v => ys(v as number))
          lg.select<SVGPathElement>(`path.s-${k}`).transition().duration(ms).attr('d', line as any)
        })
      }
      pLane.g.selectAll('circle.test').data(tests).join('circle').attr('class', 'test').attr('r', 4).attr('fill', 'var(--panel)').attr('stroke', 'var(--ink-strong)').attr('stroke-width', 1.5)
        .attr('cx', d => x(d.d)).attr('cy', d => pLane.ys(d.v)).attr('clip-path', `url(#${clipId})`)
      const evs = w.events.filter(e => +e.date >= +x.domain()[0] && +e.date <= +x.domain()[1])
      evG.selectAll('path.ev').data(evs).join('path').attr('class', 'ev').attr('d', d3.symbol(d3.symbolTriangle, 60))
        .attr('transform', d => `translate(${x(d.date)},12) rotate(180)`).attr('fill', d => EV_COLOR[d.type] ?? 'var(--ink)')
        .on('pointermove', (ev, d) => tip(tipRows(d.date.toISOString().slice(0, 10), [['Event', d.label]]), ev)).on('pointerleave', () => tip(null))
      evLines.selectAll('line').data(evs.filter(e => e.type !== 'start')).join('line').attr('x1', d => x(d.date)).attr('x2', d => x(d.date))
        .attr('y1', 0).attr('y2', y - EVH + 4).attr('stroke', d => EV_COLOR[d.type] ?? 'var(--ink)').attr('stroke-opacity', 0.35).attr('stroke-dasharray', '2 4')
    }
    draw(0)

    playBtn.onclick = () => {
      if (playing) return
      playing = true
      clipRect.attr('width', 0).transition().duration(reduced() ? 0 : 5200).ease(d3.easeLinear).attr('width', W)
        .on('end', () => { playing = false })
    }
  }, `Production history of ${w.id}`)
  return r.destroy
}

// ---------------------------------------------------------------- Chan
function chanVerdict(dx: Diagnosis) {
  const c = dx.chan
  if (c.breakthrough == null) return 'No water breakthrough yet — Chan plot not diagnostic.'
  const s = c.scores
  const best = s.channeling > s.coning && s.channeling > 0.5 ? 'channeling' : s.coning > 0.5 ? 'coning' : 'normal displacement'
  return `Signature closest to ${best}. Late WOR′ slope ${c.slopeDer?.toFixed(2) ?? '—'}, WOR slope ${c.slopeWor?.toFixed(2) ?? '—'}; breakthrough at ${Math.round(c.breakthrough)} days.`
}

function chanChart(box: HTMLElement, dx: Diagnosis, btn: HTMLButtonElement) {
  const pts = dx.chan.pts.filter(p => p.wor > 1e-3)
  let showTpl = false
  const r = responsive(box, 230, { t: 10, r: 12, b: 34, l: 46 }, f => {
    const { g, w: W, h: H } = f
    g.selectAll('*').remove()
    if (pts.length < 4) { g.append('text').attr('class', 'lbl').attr('x', W / 2).attr('y', H / 2).attr('text-anchor', 'middle').text('Not enough water production to plot'); return }
    const xs = d3.scaleLog().domain([Math.max(10, d3.min(pts, p => p.days)! * 0.8), d3.max(pts, p => p.days)! * 1.2]).range([0, W])
    const all = pts.flatMap(p => [p.wor, p.dwor ?? p.wor]).filter(v => v > 0)
    const ys = d3.scaleLog().domain([Math.max(1e-5, d3.min(all)! * 0.6), d3.max(all)! * 1.8]).range([H, 0]).clamp(true)
    g.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(xs).ticks(4, '~s')).call(axisStyle)
    g.append('g').call(d3.axisLeft(ys).ticks(4, '~g')).call(axisStyle)
    g.append('text').attr('class', 'lbl').attr('x', W).attr('y', H + 28).attr('text-anchor', 'end').text('producing days')
    const tpl = g.append('g').attr('class', 'tpl')
    g.selectAll('circle.wor').data(pts).join('circle').attr('class', 'wor').attr('cx', p => xs(p.days)).attr('cy', p => ys(p.wor)).attr('r', 0)
      .attr('fill', 'var(--water)').transition().delay((_, i) => dur(i * 6)).duration(dur(300)).attr('r', 2.6)
    g.selectAll('circle.der').data(pts.filter(p => p.dwor != null)).join('circle').attr('class', 'der').attr('cx', p => xs(p.days)).attr('cy', p => ys(p.dwor!)).attr('r', 0)
      .attr('fill', 'none').attr('stroke', 'var(--ink-2)').attr('stroke-width', 1).transition().delay((_, i) => dur(200 + i * 6)).duration(dur(300)).attr('r', 2.6)
    g.append('text').attr('class', 'lbl').attr('x', 4).attr('y', 10).attr('fill', 'var(--water)').text('● WOR')
    g.append('text').attr('class', 'lbl').attr('x', 56).attr('y', 10).text('○ WOR′ (per day)')
    const drawTpl = () => {
      tpl.selectAll('*').remove()
      if (!showTpl || dx.chan.breakthrough == null) return
      const bt = pts.find(p => p.days >= dx.chan.breakthrough!)!
      const x1 = xs.domain()[1]
      const yd = bt.dwor ?? bt.wor / bt.days
      const shape = (name: string, slope: number, color: string, dy: number) => {
        const path = tpl.append('path').attr('fill', 'none').attr('stroke', color).attr('stroke-width', 1.5)
          .attr('d', d3.line()([[xs(bt.days), ys(yd)], [xs(x1), ys(yd * Math.pow(x1 / bt.days, slope))]]))
        drawIn(path, 700)
        tpl.append('text').attr('class', 'lbl').attr('x', xs(x1) - 4).attr('y', ys(yd * Math.pow(x1 / bt.days, slope)) + dy).attr('text-anchor', 'end').attr('fill', color).text(name)
      }
      shape('channeling', 2.5, 'var(--warn)', -4)
      shape('normal', 1, 'var(--ink-2)', 12)
      shape('coning', -0.6, 'var(--cat-mech)', 12)
    }
    drawTpl()
    btn.onclick = () => { showTpl = !showTpl; btn.setAttribute('aria-pressed', String(showTpl)); btn.textContent = showTpl ? 'Hide reference shapes' : 'Show reference shapes'; drawTpl() }
  }, 'Chan water-oil ratio diagnostic plot')
  return r.destroy
}

// ---------------------------------------------------------------- PI
function piVerdict(dx: Diagnosis, { u }: Ctx) {
  const m = dx.m
  if (m.pi == null || m.piExp == null) return 'PI not computable now (no downhole pressure, or BHP above the reservoir pressure used).'
  return `PI now ${fmt(u.pi(m.pi), 2)} vs ${fmt(u.pi(m.piExp), 2)} ${u.piU} expected at this water cut (${pct(m.pi / m.piExp)}).`
}

function piChart(box: HTMLElement, ds: Dataset, w: Well, { u }: Ctx) {
  const pis = piSeries(ds, w, state.a)
  const { piRef, wcRef } = piReference(ds, w, state.a)
  const rows = pis.map((p, t) => {
    const o = w.m.oil[t] ?? 0, wa = Math.max(0, w.m.wat[t] ?? 0)
    const wc = o + wa > 0 ? wa / (o + wa) : 0
    return { d: ds.months[t], pi: p == null ? null : u.pi(p), exp: piRef == null || o <= 0 ? null : u.pi(piRef * (1 - WC_PI_PENALTY * wc) / (1 - WC_PI_PENALTY * wcRef)) }
  }).filter(r => r.pi != null || r.exp != null)
  const tests = w.tests.map(t => ({ d: ds.months[t.t], pi: u.pi(t.ql / Math.max(1, t.pres - t.pwf)) }))
  const r = responsive(box, 230, { t: 10, r: 12, b: 34, l: 46 }, f => {
    const { g, w: W, h: H } = f
    g.selectAll('*').remove()
    if (!rows.length) { g.append('text').attr('class', 'lbl').attr('x', W / 2).attr('y', H / 2).attr('text-anchor', 'middle').text('No downhole pressure to compute PI'); return }
    const xs = d3.scaleTime().domain(d3.extent(rows, r => r.d) as [Date, Date]).range([0, W])
    const vmax = d3.max([...rows.map(r => Math.max(r.pi ?? 0, r.exp ?? 0)), ...tests.map(t => t.pi)])!
    const ys = d3.scaleLinear().domain([0, d3.quantile(rows.map(r => r.pi ?? 0).sort(d3.ascending), 0.98)! * 1.2 || vmax]).range([H, 0]).nice().clamp(true)
    g.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(xs).ticks(4)).call(axisStyle)
    g.append('g').call(d3.axisLeft(ys).ticks(4)).call(axisStyle)
    g.append('text').attr('class', 'lbl').attr('x', W).attr('y', H + 28).attr('text-anchor', 'end').text(u.piU)
    const p = g.append('path').datum(rows).attr('fill', 'none').attr('stroke', 'var(--ink)').attr('stroke-width', 1.8)
      .attr('d', d3.line<typeof rows[0]>().defined(r => r.pi != null).x(r => xs(r.d)).y(r => ys(r.pi!)))
    drawIn(p, 1100)
    g.append('path').datum(rows).attr('fill', 'none').attr('stroke', 'var(--muted)').attr('stroke-dasharray', '5 4').attr('stroke-width', 1.4)
      .attr('d', d3.line<typeof rows[0]>().defined(r => r.exp != null).x(r => xs(r.d)).y(r => ys(r.exp!)))
    g.selectAll('circle').data(tests).join('circle').attr('cx', t => xs(t.d)).attr('cy', t => ys(t.pi)).attr('r', 4)
      .attr('fill', 'var(--panel)').attr('stroke', 'var(--ink-strong)').attr('stroke-width', 1.5)
    g.append('text').attr('class', 'lbl').attr('x', 4).attr('y', 10).text('— PI   - - expected (WC-adjusted)   ○ well test')
  }, 'Productivity index trend')
  return r.destroy
}

// ---------------------------------------------------------------- nodal
function nodalVerdict(dx: Diagnosis, { u }: Ctx, ds: Dataset) {
  const m = dx.m
  if (m.pi == null || m.bhp == null) return m.status === 'idle' ? 'Idle — potential shown is pre-shut-in rate × 0.7.' : 'Needs PI and flowing BHP.'
  const gain = m.gapDamage + m.gapLift
  return `Technical oil potential +${fmt(u.liq(gain))} ${u.liqU}: ${fmt(u.liq(m.gapDamage))} from restoring PI, ${fmt(u.liq(m.gapLift))} from lowering Pwf to ${fmt(u.p(m.pwfMin))} ${u.pU}${ds.id === 'volve' ? ' (assumed)' : ''}.`
}

function nodalChart(box: HTMLElement, ds: Dataset, w: Well, dx: Diagnosis, { u }: Ctx) {
  const m = dx.m
  const r = responsive(box, 230, { t: 10, r: 14, b: 34, l: 50 }, f => {
    const { g, w: W, h: H } = f
    g.selectAll('*').remove()
    if (m.pi == null || m.bhp == null || m.piExp == null) { g.append('text').attr('class', 'lbl').attr('x', W / 2).attr('y', H / 2).attr('text-anchor', 'middle').text('Not enough data for an IPR'); return }
    const pres = presAt(ds, w, ds.months.length - 1, state.a), pmin = pwfMinFor(ds, w, state.a)
    const piBest = Math.max(m.pi, m.piExp)
    const qmax = piBest * pres
    const xs = d3.scaleLinear().domain([0, u.liq(qmax)]).range([0, W]).nice()
    const ys = d3.scaleLinear().domain([0, u.p(pres) * 1.05]).range([H, 0]).nice()
    g.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(xs).ticks(4, '~s')).call(axisStyle)
    g.append('g').call(d3.axisLeft(ys).ticks(4, '~s')).call(axisStyle)
    g.append('text').attr('class', 'lbl').attr('x', W).attr('y', H + 28).attr('text-anchor', 'end').text(`liquid ${u.liqU}`)
    const ipr = (pi: number) => [[xs(0), ys(u.p(pres))], [xs(u.liq(pi * pres)), ys(0)]] as [number, number][]
    g.append('path').attr('d', d3.line()(ipr(m.piExp))).attr('stroke', 'var(--muted)').attr('stroke-dasharray', '5 4').attr('fill', 'none')
    const now = g.append('path').attr('d', d3.line()(ipr(m.pi))).attr('stroke', 'var(--ink)').attr('stroke-width', 2).attr('fill', 'none')
    drawIn(now, 800)
    g.append('line').attr('x1', 0).attr('x2', W).attr('y1', ys(u.p(pmin))).attr('y2', ys(u.p(pmin))).attr('stroke', 'var(--cat-lift)').attr('stroke-dasharray', '2 4')
    g.append('text').attr('class', 'lbl').attr('x', W - 2).attr('y', ys(u.p(pmin)) - 5).attr('text-anchor', 'end').attr('fill', 'var(--cat-lift)').text('lift limit')
    const cur = { x: xs(u.liq(m.liq)), y: ys(u.p(m.bhp)) }
    const pts = [
      { label: 'restore PI', x: xs(u.liq(Math.max(m.piExp, m.pi) * (pres - m.bhp))), y: cur.y },
      { label: 'lower Pwf', x: xs(u.liq(m.pi * (pres - pmin))), y: ys(u.p(pmin)) },
    ]
    g.selectAll('line.arrow').data(pts).join('line').attr('class', 'arrow').attr('x1', cur.x).attr('y1', cur.y).attr('x2', cur.x).attr('y2', cur.y)
      .attr('stroke', 'var(--ink-strong)').attr('stroke-dasharray', '3 3')
      .transition().delay((_, i) => dur(700 + i * 500)).duration(dur(600)).attr('x2', d => d.x).attr('y2', d => d.y)
    g.selectAll('circle.pot').data(pts).join('circle').attr('class', 'pot').attr('cx', cur.x).attr('cy', cur.y).attr('r', 5)
      .attr('fill', 'none').attr('stroke', 'var(--ink-strong)').attr('stroke-width', 2)
      .transition().delay((_, i) => dur(700 + i * 500)).duration(dur(600)).attr('cx', d => d.x).attr('cy', d => d.y)
    g.selectAll('text.pot').data(pts).join('text').attr('class', 'lbl pot').attr('x', d => d.x + 7).attr('y', d => d.y - 7).text(d => d.label)
    g.append('circle').attr('cx', cur.x).attr('cy', cur.y).attr('r', 6).attr('fill', 'var(--ink)')
    g.append('text').attr('class', 'lbl-strong').attr('x', cur.x - 8).attr('y', cur.y + 16).attr('text-anchor', 'end').text('now')
  }, 'Inflow performance and potential')
  return r.destroy
}

// ---------------------------------------------------------------- diagnosis panel
function diagnosisPanel(w: Well, dx: Diagnosis, opps: ReturnType<typeof review>['opps'], u: Ctx['u']) {
  const bars = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } })
  dx.hyps.slice(0, 5).forEach((hy, i) => {
    const fill = h('span', { style: { display: 'block', height: '8px', width: '0%', background: CAT_COLOR[MECH_CAT[hy.key]], transition: `width ${dur(700)}ms var(--ease) ${dur(i * 120)}ms` } })
    bars.append(h('div', { class: 'small', title: ev(hy.evidence, u), style: { display: 'grid', gridTemplateColumns: '150px 1fr 34px', gap: '8px', alignItems: 'center' } },
      h('span', {}, MECH_LABEL[hy.key]), h('span', { style: { background: 'var(--panel-2)' } }, fill), h('span', { class: 'mono' }, hy.score.toFixed(2))))
    requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${Math.round(hy.score * 100)}%` }))
  })
  const truth = w.truth ? TRUTH_TO_MECH[w.truth] : null
  const reveal = h('div', { class: 'small' })
  const revealBtn = truth ? h('button', {
    class: 'btn ghost', onclick: () => {
      const got = dx.primary?.key ?? 'healthy'
      const ok = got === truth
      reveal.innerHTML = ''
      reveal.append(h('span', { class: ok ? '' : 'warn' }, ok ? '✓ ' : '✗ '), `Synthetic truth: `, h('strong', {}, truth === 'healthy' ? 'no issue' : MECH_LABEL[truth as keyof typeof MECH_LABEL]),
        ok ? ' — diagnosis matches.' : ` — diagnosis said ${got === 'healthy' ? 'no issue' : MECH_LABEL[got as keyof typeof MECH_LABEL]}.`)
    },
  }, 'Reveal synthetic truth') : null

  return h('section', { class: 'panel' },
    h('header', {}, h('h2', {}, 'Diagnosis'), h('span', { class: 'small muted' }, 'rule-based, every rule listed under Methods')),
    h('div', { class: 'row', style: { gap: '24px' } },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, h('span', { class: 'eyebrow' }, 'Symptoms'),
        ...dx.symptoms.map(s => h('span', { class: 'small' }, h('span', { class: s.on ? 'warn' : 'muted' }, s.on ? '■ ' : '□ '), ev(s.text, u)))),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, h('span', { class: 'eyebrow' }, 'Mechanism hypotheses'), bars,
        revealBtn, reveal),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, h('span', { class: 'eyebrow' }, 'Data gaps → well test plan'),
        ...(dx.dataGaps.length ? dx.dataGaps.map((g, i) => h('span', { class: 'small' }, `${i + 1}. ${g}`)) : [h('span', { class: 'small muted' }, 'No critical gaps.')]),
        h('span', { class: 'eyebrow', style: { marginTop: '10px' } }, 'Opportunities'),
        ...(opps.length ? opps.map(o => h('button', { class: 'btn', style: { justifyContent: 'space-between' }, onclick: () => go('evaluate', { opp: o.id }) },
          h('span', {}, o.label), h('span', { class: 'mono small' }, 'Evaluate →'))) : [h('span', { class: 'small muted' }, 'None above threshold.')]))))
}

// ---------------------------------------------------------------- schematic
function schematic(w: Well, dx: Diagnosis) {
  const c = w.completion
  const NS = 'http://www.w3.org/2000/svg'
  const W = 240, H = 520, top = 16, bot = H - 20
  // broken depth scale: upper hole compressed, completion interval expanded
  const split = Math.max(c.td * 0.3, Math.min(c.packer ?? c.td, ...c.zones.map(z => z.top), ...(c.glm?.length ? [c.glm[c.glm.length - 1]] : [])) - 120)
  const y = d3.scaleLinear().domain([0, split, c.td]).range([top, top + (bot - top) * 0.45, bot])
  const svg = d3.select(document.createElementNS(NS, 'svg')).attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img').attr('aria-label', `Completion schematic of ${w.id}`)
  const cx = 92
  const waterHyp = dx.hyps.find(h => (h.key === 'channeling' || h.key === 'coning') && h.score >= 0.5)
  // formation shading at zones
  c.zones.forEach((z, i) => {
    const suspect = waterHyp && (c.suspectZone == null ? true : c.suspectZone === i)
    svg.append('rect').attr('x', 8).attr('width', 168).attr('y', y(z.top)).attr('height', Math.max(6, y(z.base) - y(z.top)))
      .attr('fill', suspect ? 'var(--water)' : 'var(--panel-3)').attr('opacity', suspect ? 0.16 : 0.7)
    const yy = (y(z.top) + y(z.base)) / 2
    for (let k = 0; k < 4; k++) {
      svg.append('line').attr('x1', cx - 34).attr('x2', cx - 46).attr('y1', y(z.top) + (k + 0.5) * (y(z.base) - y(z.top)) / 4).attr('y2', y(z.top) + (k + 0.5) * (y(z.base) - y(z.top)) / 4).attr('stroke', 'var(--ink)').attr('stroke-width', 1.5)
      svg.append('line').attr('x1', cx + 34).attr('x2', cx + 46).attr('y1', y(z.top) + (k + 0.5) * (y(z.base) - y(z.top)) / 4).attr('y2', y(z.top) + (k + 0.5) * (y(z.base) - y(z.top)) / 4).attr('stroke', 'var(--ink)').attr('stroke-width', 1.5)
    }
    svg.append('text').attr('class', 'lbl').attr('x', 182).attr('y', yy + 3).attr('fill', suspect ? 'var(--water)' : 'var(--ink-2)').text(z.name + (suspect && c.suspectZone == null ? ' ?' : ''))
    if (suspect) {
      for (let k = 0; k < 5; k++) {
        const side = k % 2 ? 1 : -1
        svg.append('circle').attr('class', 'droplet').attr('r', 2.2).attr('fill', 'var(--water)')
          .attr('cx', cx + side * 72).attr('cy', y(z.top) + ((k + 0.5) / 5) * Math.max(6, y(z.base) - y(z.top)))
          .style('--dx', `${-side * 36}px`).style('animation-delay', `${k * 0.3}s`)
      }
    }
  })
  // casings
  const casing = (half: number, depth: number, wdt = 2) => {
    svg.append('line').attr('x1', cx - half).attr('x2', cx - half).attr('y1', top).attr('y2', y(depth)).attr('stroke', 'var(--dim)').attr('stroke-width', wdt)
    svg.append('line').attr('x1', cx + half).attr('x2', cx + half).attr('y1', top).attr('y2', y(depth)).attr('stroke', 'var(--dim)').attr('stroke-width', wdt)
    svg.append('path').attr('d', `M${cx - half - 5},${y(depth)} l5,-6 v6z M${cx + half + 5},${y(depth)} l-5,-6 v6z`).attr('fill', 'var(--dim)')
  }
  casing(52, c.td * 0.08, 3); casing(42, c.td * 0.35); casing(32, c.td)
  const tubEnd = c.esp ?? c.packer ?? c.td * 0.8
  svg.append('line').attr('x1', cx - 9).attr('x2', cx - 9).attr('y1', top).attr('y2', y(tubEnd)).attr('stroke', 'var(--ink)').attr('stroke-width', 2)
  svg.append('line').attr('x1', cx + 9).attr('x2', cx + 9).attr('y1', top).attr('y2', y(tubEnd)).attr('stroke', 'var(--ink)').attr('stroke-width', 2)
  const label = (d: number, t: string) => svg.append('text').attr('class', 'lbl').attr('x', 182).attr('y', y(d) + 3).text(t)
  if (c.sssv) { svg.append('rect').attr('x', cx - 13).attr('y', y(c.sssv) - 4).attr('width', 26).attr('height', 8).attr('fill', 'var(--muted)'); label(c.sssv, 'SSSV') }
  ;(c.glm ?? []).forEach((d, i) => { svg.append('rect').attr('x', cx + 9).attr('y', y(d) - 6).attr('width', 7).attr('height', 12).attr('fill', 'var(--cat-lift)'); if (i === 0) label(d, 'GLMs') })
  if (c.esp) { svg.append('rect').attr('x', cx - 11).attr('y', y(c.esp) - 22).attr('width', 22).attr('height', 34).attr('fill', 'var(--cat-lift)').attr('opacity', 0.8); label(c.esp, 'ESP') }
  if (c.packer) {
    svg.append('rect').attr('x', cx - 32).attr('y', y(c.packer) - 5).attr('width', 23).attr('height', 10).attr('fill', 'var(--ink-2)')
    svg.append('rect').attr('x', cx + 9).attr('y', y(c.packer) - 5).attr('width', 23).attr('height', 10).attr('fill', 'var(--ink-2)')
    label(c.packer, 'Packer')
  }
  svg.append('text').attr('class', 'lbl').attr('x', 4).attr('y', bot + 14).text(`TD ${fmt(c.td)} m MD`)
  const ys = y(split)
  svg.append('path').attr('d', `M2,${ys - 3} l10,-4 M2,${ys + 3} l10,-4`).attr('stroke', 'var(--muted)')
  svg.append('text').attr('class', 'lbl').attr('x', 14).attr('y', ys + 3).style('font-size', '9px').text(`scale break ${fmt(split)} m`)

  const barriers = c.barriers?.length
    ? c.barriers.map(b => h('div', { class: 'small' }, h('span', { class: b.status === 'ok' ? 'muted' : 'warn' }, b.status === 'ok' ? '● ' : '▲ '), `${b.name} — ${b.status === 'ok' ? 'OK' : 'attention'}`))
    : [h('div', { class: 'small muted' }, 'Barrier status not in public data.')]
  return h('div', { class: 'schematic', style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
    h('div', { style: { display: 'flex', justifyContent: 'space-between' } }, h('span', { class: 'eyebrow' }, 'Completion schematic'), h('span', { class: 'badge' }, 'ILLUSTRATIVE')),
    svg.node()!,
    h('div', { class: 'small muted' }, waterHyp
      ? (c.suspectZone == null ? 'Water hypothesis active — entry zone unknown: PLT required to locate it.' : 'Animated droplets mark the suspected water-entry zone.')
      : 'No active water hypothesis.'),
    h('span', { class: 'eyebrow' }, 'Integrity barriers'), ...barriers)
}
