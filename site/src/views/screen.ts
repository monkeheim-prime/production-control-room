// Stage 1 — screen the population. One set of well dots morphs between five views.
import * as d3 from 'd3'
import type { Ctx } from '../main'
import { fmtMonth } from '../core/data'
import { go, set, state, subscribe, type ScreenView } from '../core/state'
import { fmt, pct } from '../core/units'
import { fieldMetrics, heterogeneity, latestMonth, type Metrics } from '../analysis/metrics'
import { MECH_CAT, MECH_LABEL, review } from '../analysis/diagnose'
import { CAT_COLOR, CAT_LABEL, type Cat } from '../analysis/econ'
import { axisStyle, dur, h, legend, reduced, responsive, tip, tipRows } from '../ui/kit'

const VIEWS: { id: ScreenView; label: string }[] = [
  { id: 'map', label: 'Map' }, { id: 'hi', label: 'Heterogeneity index' }, { id: 'pareto', label: 'Pareto' },
  { id: 'gap', label: 'Gap to potential' }, { id: 'drive', label: 'Water cut vs GOR' },
]

export function mountScreen(el: HTMLElement, { ds, u }: Ctx) {
  const rv = review(ds, state.a)
  const tMax = latestMonth(ds)
  const tMin = Math.min(...ds.producers.map(w => w.first)) + 6
  let t = state.t != null ? Math.min(state.t, tMax) : tMax
  if (ds.id === 'volve' && state.screenView === 'map') state.screenView = 'hi'

  const filters = { flowing: true, idle: true, lifts: new Set(ds.producers.map(w => w.lift)), group: 'block' as 'block' | 'field', size: 'gap' as 'gap' | 'cum' }
  const catOf = (id: string): Cat | null => {
    const p = rv.dx.get(id)?.primary
    return p ? MECH_CAT[p.key] : null
  }
  const colorOf = (id: string) => { const c = catOf(id); return c ? CAT_COLOR[c] : 'var(--cat-none)' }

  // ---------- layout ----------
  const rail = h('aside', { class: 'rail', 'aria-label': 'Filters' })
  const center = h('div', { class: 'center' })
  const right = h('aside', { class: 'rail right', 'aria-label': 'Review queue' })
  el.append(h('div', { class: 'cols chart-first' }, rail, center, right))

  // filters
  const check = (label: string, on: boolean, cb: (v: boolean) => void) => {
    const i = h('input', { type: 'checkbox' }) as HTMLInputElement
    i.checked = on
    i.addEventListener('change', () => { cb(i.checked); update() })
    return h('label', { class: 'check' }, i, label)
  }
  const counts = (pred: (m: Metrics) => boolean) => [...rv.metrics.values()].filter(m => m.status !== 'injector' && pred(m)).length
  const qaWells = ds.wells.filter(w => w.qa.some(q => q.severity === 'high' || q.severity === 'medium'))
  rail.append(
    h('span', { class: 'eyebrow' }, 'Filter population'),
    h('fieldset', {}, h('legend', { class: 'eyebrow' }, 'Status'),
      check(`Flowing (${counts(m => m.status === 'flowing')})`, true, v => { filters.flowing = v }),
      check(`Idle / shut-in (${counts(m => m.status === 'idle')})`, true, v => { filters.idle = v })),
    h('fieldset', {}, h('legend', { class: 'eyebrow' }, 'Lift'),
      ...[...filters.lifts].sort().map(l => check(l, true, v => { v ? filters.lifts.add(l) : filters.lifts.delete(l) }))),
    selectField('Offset group for HI', [['block', 'Reservoir block'], ['field', 'Whole field']], filters.group, v => { filters.group = v as any; update() }),
    selectField('Dot size', [['gap', 'Gap to potential'], ['cum', 'Cumulative oil']], filters.size, v => { filters.size = v as any; update() }),
    h('div', { class: 'panel', style: { padding: '10px' } },
      h('span', { class: 'eyebrow' }, 'Data QA/QC'),
      h('div', { class: 'small' }, `${ds.wells.length - qaWells.length} / ${ds.wells.length} wells pass`),
      ...qaWells.slice(0, 6).map(w => h('div', { class: 'small' }, h('span', { class: 'warn' }, '▲ '), `${w.id}: `,
        h('span', { class: 'muted' }, w.qa.filter(q => q.severity === 'high' || q.severity === 'medium').map(q => q.rule.replace(/_/g, ' ')).join(', '))))),
    h('div', {}, h('span', { class: 'eyebrow' }, 'Colour = primary issue'),
      h('div', { style: { marginTop: '8px' } }, legend([
        ...(Object.keys(CAT_LABEL) as Cat[]).map(c => ({ label: CAT_LABEL[c], color: CAT_COLOR[c] })),
        { label: 'No significant issue', color: 'var(--cat-none)' }, { label: 'Idle', color: 'var(--muted)', hollow: true }]))),
  )

  // center: tabs + chart + time
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Views' })
  const renderTabs = () => {
    tabs.innerHTML = ''
    for (const v of VIEWS) {
      const disabled = v.id === 'map' && !ds.producers.some(w => w.x != null)
      tabs.append(h('button', {
        role: 'tab', 'aria-selected': String(state.screenView === v.id), disabled,
        title: disabled ? 'Volve wellheads share one platform — no spatial spread to map' : null,
        onclick: () => { set({ screenView: v.id }); renderTabs(); update(true) },
      }, v.label))
    }
  }
  renderTabs()
  const caption = h('span', { class: 'small muted' })
  const chartBox = h('div', { class: 'chart' })
  const play = h('button', { class: 'btn', 'aria-label': 'Play history' }, '▶') as HTMLButtonElement
  const range = h('input', { type: 'range', min: tMin, max: tMax, step: 1, value: t, 'aria-label': 'Month', style: { flex: '1 1 auto' } }) as HTMLInputElement
  const tLabel = h('span', { class: 'mono', style: { minWidth: '64px' } })
  center.append(
    h('div', { class: 'row', style: { alignItems: 'center', flex: 'none' } }, h('div', { style: { flex: '0 1 auto', minWidth: '0' } }, tabs), caption),
    h('section', { class: 'panel', style: { flex: '1 1 auto' } }, chartBox,
      h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center' } }, play, range, tLabel,
        h('span', { class: 'small muted' }, 'Scrub or play: wells drift between quadrants over time'))))
  range.addEventListener('input', () => { t = +range.value; update() })
  let timer: ReturnType<typeof setInterval> | null = null
  const stop = () => { if (timer) clearInterval(timer); timer = null; play.textContent = '▶'; trails.clear() }
  play.addEventListener('click', () => {
    if (timer) return stop()
    if (t >= tMax) t = tMin
    play.textContent = '❚❚'
    timer = setInterval(() => {
      t = Math.min(tMax, t + 3); range.value = String(t); update()
      if (t >= tMax) stop()
    }, reduced() ? 50 : 420)
  })

  // right: queue
  const queue = h('div', { class: 'tablewrap', style: { maxHeight: '460px' } })
  const totals = h('div', { class: 'kpi' })
  const diagBtn = h('button', { class: 'btn primary', onclick: () => go('producer', { well: state.well ?? ds.producers[0].id }) }, 'Diagnose selected well →')
  right.append(h('div', { style: { display: 'flex', justifyContent: 'space-between' } }, h('span', { class: 'eyebrow' }, 'Review queue'), h('span', { class: 'small muted' }, 'sorted by gap')), queue, totals, diagBtn)

  // ---------- chart ----------
  const trails = new Map<string, [number, number][]>()
  let frame: { g: d3.Selection<SVGGElement, unknown, null, undefined>; w: number; h: number } | null = null
  const chart = responsive(chartBox, w => Math.max(360, Math.min(560, w * 0.62)), { t: 24, r: 24, b: 44, l: 56 }, f => {
    frame = f
    f.g.selectAll('g.layer').data(['bg', 'trails', 'dots', 'fg']).join('g').attr('class', d => `layer ${d}`)
    update(true)
  }, 'Well population chart')

  function visible(id: string, m: Metrics) {
    const w = ds.producers.find(p => p.id === id)!
    if (m.status === 'notyet') return false
    if (m.status === 'idle' && !filters.idle) return false
    if (m.status === 'flowing' && !filters.flowing) return false
    return filters.lifts.has(w.lift)
  }

  function update(viewChanged = false) {
    if (!frame) return
    const { g, w: W, h: H } = frame
    const view = state.screenView
    tLabel.textContent = fmtMonth(ds.months[t])
    const metrics = t === rv.t ? rv.metrics : fieldMetrics(ds, t, state.a)
    const prods = ds.producers.map(w => ({ w, m: metrics.get(w.id)! })).filter(d => visible(d.w.id, d.m))
    const sizeVal = (m: Metrics) => (filters.size === 'gap' ? m.gap + m.gapIdle * 0 : m.cumOil / 1e4)
    const rS = d3.scaleSqrt().domain([0, d3.max(prods, d => sizeVal(d.m)) || 1]).range([4, 17])
    const pos = new Map<string, { x: number; y: number }>()
    const bg = g.select<SVGGElement>('g.bg')
    const T = dur(viewChanged ? 900 : 380)
    bg.selectAll('*').interrupt()
    if (viewChanged) bg.selectAll('*').remove()

    const byGap = [...prods].sort((a, b) => (b.m.gap || b.m.gapIdle) - (a.m.gap || a.m.gapIdle))
    const gapOf = (m: Metrics) => m.gap || m.gapIdle
    const totalGap = d3.sum(prods, d => gapOf(d.m)) || 1

    if (view === 'map') {
      const xs = d3.scaleLinear().domain([0, 8.4]).range([0, W]), ys = d3.scaleLinear().domain([0, 7]).range([H, 0])
      prods.forEach(d => pos.set(d.w.id, { x: xs(d.w.x!), y: ys(d.w.y!) }))
      caption.textContent = 'Plan view of wellheads by reservoir block. Injectors shown as triangles.'
      drawBg(bg, () => {
        for (const b of ds.blockPres ? Object.keys(ds.blockPres) : []) {
          const bw = ds.producers.filter(p => p.block === b)
          const x0 = d3.min(bw, p => p.x!)! - 0.3, x1 = d3.max(bw, p => p.x!)! + 0.3, y0 = d3.min(bw, p => p.y!)! - 0.3, y1 = d3.max(bw, p => p.y!)! + 0.3
          bg.append('rect').attr('x', xs(x0)).attr('y', ys(y1)).attr('width', xs(x1) - xs(x0)).attr('height', ys(y0) - ys(y1))
            .attr('fill', 'var(--panel-2)').attr('stroke', 'var(--line)').attr('rx', 18)
          bg.append('text').attr('class', 'eyebrow').attr('x', xs(x0) + 10).attr('y', ys(y1) + 18).attr('fill', 'var(--muted)').style('font-family', 'var(--mono)').style('font-size', '11px').text(`BLOCK ${b}`)
        }
        bg.selectAll('path.inj').data(ds.injectors).join('path').attr('class', 'inj')
          .attr('d', d3.symbol(d3.symbolTriangle, 70)).attr('transform', d => `translate(${xs(d.x!)},${ys(d.y!)})`)
          .attr('fill', 'none').attr('stroke', 'var(--water)').attr('stroke-width', 1.5)
        bg.selectAll('text.injl').data(ds.injectors).join('text').attr('class', 'lbl injl').attr('x', d => xs(d.x!) + 9).attr('y', d => ys(d.y!) + 4).text(d => d.id)
        bg.append('text').attr('class', 'lbl').attr('x', W).attr('y', H + 30).attr('text-anchor', 'end').text('km →')
      }, viewChanged)
    } else if (view === 'hi') {
      const hi = new Map(heterogeneity(ds, metrics, filters.group).map(p => [p.id, p]))
      const xs = d3.scaleLinear().domain([-1.15, 2.2]).range([0, W]).clamp(true), ys = d3.scaleLinear().domain([-1.55, 3.7]).range([H, 0]).clamp(true)
      prods.forEach(d => { const p = hi.get(d.w.id); if (p && !p.idle) pos.set(d.w.id, { x: xs(p.hiOil), y: ys(p.hiWat) }) })
      const nIdle = prods.filter(d => d.m.status === 'idle').length
      caption.textContent = `Each well vs the average of its offset group (0 = average). Top-left = water shut-off candidates.${nIdle ? ` ${nIdle} idle wells have no current rate — see Gap view.` : ''}`
      drawBg(bg, () => {
        bg.append('rect').attr('x', 0).attr('y', 0).attr('width', xs(0)).attr('height', ys(0)).attr('fill', 'var(--cat-water)').attr('opacity', 0.07)
        bg.append('line').attr('x1', xs(0)).attr('x2', xs(0)).attr('y1', 0).attr('y2', H).attr('stroke', 'var(--dim)')
        bg.append('line').attr('x1', 0).attr('x2', W).attr('y1', ys(0)).attr('y2', ys(0)).attr('stroke', 'var(--dim)')
        const narrow = W < 560
        const q = (x: number, y: number, a: string, t1: string, short: string, t2: string) => {
          bg.append('text').attr('x', x).attr('y', y).attr('text-anchor', a).attr('class', 'lbl-mono').attr('fill', 'var(--ink)').text(narrow ? short : t1)
          if (!narrow) bg.append('text').attr('x', x).attr('y', y + 15).attr('text-anchor', a).attr('class', 'lbl').text(t2)
        }
        q(8, 16, 'start', 'WATER SHUT-OFF CANDIDATES', 'WSO CANDIDATES', 'less oil, more water than offsets')
        q(W - 8, 16, 'end', 'STRONG — WATCH WATER', 'WATCH WATER', 'more oil and more water')
        q(8, H - 20, 'start', 'STIMULATE / LIFT', 'STIM / LIFT', 'less oil, less water')
        q(W - 8, H - 20, 'end', 'STARS', 'STARS', 'more oil, less water')
        bg.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(xs).ticks(6).tickFormat(d3.format('+.1f'))).call(axisStyle)
        bg.append('g').call(d3.axisLeft(ys).ticks(6).tickFormat(d3.format('+.1f'))).call(axisStyle)
        bg.append('text').attr('class', 'lbl').attr('x', W / 2).attr('y', H + 36).attr('text-anchor', 'middle').text('Oil heterogeneity index  →')
        bg.append('text').attr('class', 'lbl').attr('transform', `translate(-42,${H / 2}) rotate(-90)`).attr('text-anchor', 'middle').text('Water heterogeneity index  →')
      }, viewChanged)
    } else if (view === 'pareto') {
      const xs = d3.scaleBand<string>().domain(byGap.map(d => d.w.id)).range([0, W]).padding(0.25)
      const ys = d3.scaleLinear().domain([0, 1]).range([H, 0])
      const yb = d3.scaleLinear().domain([0, d3.max(byGap, d => gapOf(d.m)) || 1]).range([H, H * 0.35])
      let cum = 0
      byGap.forEach(d => { cum += gapOf(d.m); pos.set(d.w.id, { x: xs(d.w.id)! + xs.bandwidth() / 2, y: ys(cum / totalGap) }) })
      const n80 = byGap.findIndex((_, i) => d3.sum(byGap.slice(0, i + 1), d => gapOf(d.m)) / totalGap >= 0.8) + 1
      caption.textContent = `${n80} of ${byGap.length} wells hold 80 % of the field's gap to potential.`
      drawBg(bg, () => {
        bg.selectAll('rect.bar').data(byGap, (d: any) => d.w.id).join('rect').attr('class', 'bar')
          .attr('x', d => xs(d.w.id)!).attr('width', xs.bandwidth()).attr('y', H).attr('height', 0).attr('fill', 'var(--panel-3)')
          .transition().duration(dur(700)).delay((_, i) => dur(i * 18)).attr('y', d => yb(gapOf(d.m))).attr('height', d => H - yb(gapOf(d.m)))
        bg.append('line').attr('x1', 0).attr('x2', W).attr('y1', ys(0.8)).attr('y2', ys(0.8)).attr('stroke', 'var(--warn)').attr('stroke-dasharray', '4 4')
        bg.append('text').attr('class', 'lbl').attr('x', W - 4).attr('y', ys(0.8) - 6).attr('text-anchor', 'end').attr('fill', 'var(--warn)').text('80 %')
        bg.append('g').call(d3.axisLeft(ys).ticks(5).tickFormat(d3.format('.0%'))).call(axisStyle)
        bg.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(xs).tickFormat(() => '')).call(axisStyle)
        bg.append('text').attr('class', 'lbl').attr('x', W / 2).attr('y', H + 30).attr('text-anchor', 'middle').text('Wells ranked by gap (bars) → cumulative share of field gap (dots)')
      }, viewChanged)
    } else if (view === 'gap') {
      const ys = d3.scaleBand<string>().domain(byGap.map(d => d.w.id)).range([0, H]).padding(0.3)
      const xs = d3.scaleLinear().domain([0, u.liq(d3.max(byGap, d => gapOf(d.m)) || 1)]).nice().range([0, W])
      byGap.forEach(d => pos.set(d.w.id, { x: xs(u.liq(gapOf(d.m))), y: ys(d.w.id)! + ys.bandwidth() / 2 }))
      caption.textContent = `Modelled technical potential not being produced: damage + lift + water + idle (${u.liqU} oil).`
      drawBg(bg, () => {
        const stems = bg.selectAll('line.stem').data(byGap, (d: any) => d.w.id).join('line').attr('class', 'stem')
          .attr('x1', 0).attr('x2', 0).attr('y1', d => ys(d.w.id)! + ys.bandwidth() / 2).attr('y2', d => ys(d.w.id)! + ys.bandwidth() / 2)
          .attr('stroke', 'var(--line)').attr('stroke-width', 2)
        stems.transition().duration(dur(800)).attr('x2', d => xs(u.liq(gapOf(d.m))))
        if (ys.bandwidth() > 8) bg.selectAll('text.wl').data(byGap).join('text').attr('class', 'lbl wl').attr('x', -6).attr('text-anchor', 'end')
          .attr('y', d => ys(d.w.id)! + ys.bandwidth() / 2 + 3).style('font-size', '9px').style('font-family', 'var(--mono)').text(d => d.w.id)
        bg.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(xs).ticks(6)).call(axisStyle)
        bg.append('text').attr('class', 'lbl').attr('x', W / 2).attr('y', H + 34).attr('text-anchor', 'middle').text(`Gap to potential (${u.liqU})`)
      }, viewChanged)
    } else {
      const flowing = prods.filter(d => d.m.status === 'flowing')
      const xs = d3.scaleLinear().domain([0, 1]).range([0, W])
      const g0 = d3.extent(flowing, d => u.gor(d.m.gor)) as [number, number]
      const ys = d3.scaleLog().domain([Math.max(1, (g0[0] || 10) * 0.7), (g0[1] || 1000) * 1.4]).range([H, 0]).nice()
      prods.forEach(d => pos.set(d.w.id, d.m.status === 'idle' ? { x: xs(0) - 0, y: H } : { x: xs(d.m.wc), y: ys(Math.max(ys.domain()[0], u.gor(d.m.gor))) }))
      caption.textContent = 'Drive signature: water cut vs producing GOR. Rising GOR = pressure below bubble point / gas cap.'
      drawBg(bg, () => {
        bg.append('rect').attr('x', xs(0.7)).attr('y', 0).attr('width', W - xs(0.7)).attr('height', H).attr('fill', 'var(--cat-water)').attr('opacity', 0.06)
        bg.append('text').attr('class', 'lbl').attr('x', xs(0.7) + 6).attr('y', 14).text('WC > 70 %')
        bg.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(xs).ticks(5).tickFormat(d3.format('.0%'))).call(axisStyle)
        bg.append('g').call(d3.axisLeft(ys).ticks(5, '~s')).call(axisStyle)
        bg.append('text').attr('class', 'lbl').attr('x', W / 2).attr('y', H + 34).attr('text-anchor', 'middle').text('Water cut →')
        bg.append('text').attr('class', 'lbl').attr('transform', `translate(-42,${H / 2}) rotate(-90)`).attr('text-anchor', 'middle').text(`Producing GOR (${u.gorU}, log)`)
      }, viewChanged)
    }

    // trails while playing (HI only)
    const trailG = g.select<SVGGElement>('g.trails')
    if (timer && view === 'hi') {
      pos.forEach((p, id) => { const tr = trails.get(id) ?? []; tr.push([p.x, p.y]); trails.set(id, tr.slice(-5)) })
    }
    trailG.selectAll('path').data(view === 'hi' ? [...trails.entries()] : [], (d: any) => d[0]).join('path')
      .attr('d', d => d3.line()(d[1])).attr('fill', 'none').attr('stroke', d => colorOf(d[0])).attr('stroke-opacity', 0.35).attr('stroke-width', 1.5)

    // dots: keyed by well id, so each well keeps its identity across views
    const dotData = ds.producers.map(w => ({ w, m: metrics.get(w.id)!, p: pos.get(w.id) }))
    const dots = g.select<SVGGElement>('g.dots').selectAll<SVGCircleElement, typeof dotData[0]>('circle').data(dotData, d => d.w.id)
    dots.join(enter => enter.append('circle').attr('cx', W / 2).attr('cy', H / 2).attr('r', 0)
      .on('pointermove', (ev, d) => tip(tipRows(`${d.w.id} · ${d.w.lift}`, tipFor(d.m, d.w.id)), ev))
      .on('pointerleave', () => tip(null))
      .on('click', (_, d) => { set({ well: d.w.id }); highlight() })
      .on('dblclick', (_, d) => go('producer', { well: d.w.id })))
      .attr('tabindex', 0)
      .attr('aria-label', d => `${d.w.id}`)
      .transition().duration(T).ease(d3.easeCubicInOut).delay((_, i) => (viewChanged ? dur(i * 12) : 0))
      .attr('cx', d => d.p?.x ?? W / 2).attr('cy', d => d.p?.y ?? H / 2)
      .attr('r', d => (d.p && visible(d.w.id, d.m) ? rS(Math.max(sizeVal(d.m), d.m.gapIdle * 0.5)) : 0))
      .attr('fill', d => (d.m.status === 'idle' ? 'var(--panel)' : colorOf(d.w.id)))
      .attr('fill-opacity', 0.9)
      .attr('stroke', d => (d.m.status === 'idle' ? 'var(--muted)' : 'var(--panel)'))
      .attr('stroke-width', d => (d.m.status === 'idle' ? 1.5 : 2))

    // labels for the biggest gaps
    const top = new Set(byGap.slice(0, 6).map(d => d.w.id))
    g.select<SVGGElement>('g.fg').selectAll<SVGTextElement, typeof dotData[0]>('text').data(dotData.filter(d => d.p && top.has(d.w.id) && view !== 'gap'), d => d.w.id)
      .join(enter => enter.append('text').attr('class', 'lbl-mono').style('pointer-events', 'none').attr('opacity', 0))
      .transition().duration(T).attr('x', d => d.p!.x + 10).attr('y', d => d.p!.y - 8).attr('opacity', 1).text(d => d.w.id)
    highlight()
    renderQueue(metrics, byGap.map(d => d.w.id), totalGap)
  }

  function highlight() {
    if (!frame) return
    frame.g.select('g.dots').selectAll<SVGCircleElement, any>('circle')
      .attr('stroke', (d: any) => (d.w.id === state.well ? 'var(--ink-strong)' : d.m.status === 'idle' ? 'var(--muted)' : 'var(--panel)'))
      .attr('stroke-width', (d: any) => (d.w.id === state.well ? 3 : d.m.status === 'idle' ? 1.5 : 2))
    queue.querySelectorAll('tr[data-id]').forEach(tr => tr.classList.toggle('sel', (tr as HTMLElement).dataset.id === state.well))
  }

  function tipFor(m: Metrics, id: string): [string, string][] {
    const d = rv.dx.get(id)
    return [
      ['Status', m.status], ['Oil', `${fmt(u.liq(m.oil))} ${u.liqU}`], ['Water cut', pct(m.wc)],
      ['Gap', `${fmt(u.liq(m.gap || m.gapIdle))} ${u.liqU}`],
      ['Primary issue', d?.primary ? MECH_LABEL[d.primary.key] : 'none'],
    ]
  }

  function renderQueue(metrics: Map<string, Metrics>, order: string[], totalGap: number) {
    const rows = order.slice(0, 14).map(id => {
      const m = metrics.get(id)!, d = rv.dx.get(id)
      const g = m.gap || m.gapIdle
      const mx = metrics.get(order[0])!
      const gMax = mx.gap || mx.gapIdle || 1
      return h('tr', { 'data-id': id, onclick: () => { set({ well: id }); highlight() }, ondblclick: () => go('producer', { well: id }) },
        h('td', { class: 'mono' }, id),
        h('td', { class: 'num' }, fmt(u.liq(m.oil))),
        h('td', { class: 'num' }, m.status === 'idle' ? 'idle' : pct(m.wc)),
        h('td', { class: 'num' }, h('span', { class: 'bar-inline', style: { width: `${Math.round((g / gMax) * 40)}px` } }), fmt(u.liq(g))),
        h('td', {}, d?.primary ? h('span', { class: 'chip' }, h('span', { class: 'dot', style: { background: CAT_COLOR[MECH_CAT[d.primary.key]] } }), MECH_LABEL[d.primary.key].split(' ')[0]) : h('span', { class: 'muted small' }, '—')))
    })
    queue.innerHTML = ''
    queue.append(h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Well'), h('th', { class: 'num' }, `Oil`), h('th', { class: 'num' }, 'WC'), h('th', { class: 'num' }, `Gap`), h('th', {}, 'Issue'))),
      h('tbody', {}, ...rows)))
    const top80 = (() => { let c = 0; for (let i = 0; i < order.length; i++) { const m = metrics.get(order[i])!; c += m.gap || m.gapIdle; if (c / totalGap >= 0.8) return i + 1 } return order.length })()
    totals.innerHTML = ''
    totals.append(h('div', { class: 'l' }, `Field gap to potential (${u.liqU} oil)`), h('div', { class: 'v' }, fmt(u.liq(totalGap))),
      h('div', { class: 's' }, `80 % of it sits in ${top80} wells · units: ${u.liqU}`))
  }

  const unsub = subscribe((_, ch) => { if (ch.has('well')) highlight() })
  return () => { stop(); chart.destroy(); unsub(); tip(null); set({ t: t === tMax ? null : t }) }
}

function drawBg(bg: d3.Selection<SVGGElement, unknown, null, undefined>, draw: () => void, changed: boolean) {
  if (!changed) { bg.selectAll('*').remove(); draw(); return }
  bg.attr('opacity', 0)
  draw()
  bg.transition().duration(dur(500)).attr('opacity', 1)
}

function selectField(label: string, opts: [string, string][], val: string, on: (v: string) => void) {
  const s = h('select', {}, ...opts.map(([v, l]) => h('option', { value: v, selected: v === val }, l))) as HTMLSelectElement
  s.addEventListener('change', () => on(s.value))
  return h('label', { class: 'field' }, h('span', { class: 'muted' }, label), s)
}
