// Toolkit T1 — Arps decline fit, probabilistic forecast and a hindcast that hides the latest months.
import * as d3 from 'd3'
import type { Ctx } from '../main'
import { fmtMonth } from '../core/data'
import { set, state } from '../core/state'
import { fmt, pct } from '../core/units'
import { annualDecline, arps, autoStart, eligible, forecast, producingPoints, regime, score, scoreboard, type Backtest, type Forecast } from '../analysis/decline'
import { axisStyle, drawIn, dur, grid, h, legend, panel, responsive, slider, tip, tipRows } from '../ui/kit'

export const METHODS = `
<h2>Decline &amp; forecast</h2>
<h3>Arps decline (Arps, 1945)</h3>
<div class="eq">q(t) = q_i / (1 + b·D_i·t)^(1/b)      0 &lt; b ≤ 1.5   (b = 1 harmonic)
q(t) = q_i · exp(−D_i·t)               b = 0          (exponential)
t in months from the fit start, D_i nominal per month (shown ×12 as %/yr)</div>
<h3>Data</h3>
<p>Monthly oil as calendar-day average rate. Months with no oil, or with recorded uptime below 12 h/d (Volve), are left out of the fit and the scoring, so shut-ins do not read as decline.</p>
<h3>Fit</h3>
<div class="eq">minimise Σ [ln q_obs − ln q(t)]²   over the fit window
b   : grid 0, 0.05 … 1.5
D_i : golden-section search on ln D_i ∈ [1e-4, 0.6] /month
q_i : closed form, ln q_i = mean(ln q_obs − ln f(t; b, D_i))</div>
<p>Default fit window: from the peak rate inside the last 48 producing months before the cutoff (a proxy for "after the last major event"), keeping at least 6 points. Drag the slider to change it, or fix b by hand.</p>
<h3>Uncertainty</h3>
<p>Residual bootstrap: the log residuals of the fit are resampled onto the fitted curve 60 times (seeded, so it is repeatable) and refitted. P10 / P90 are the 90th / 10th percentiles of the refitted curves and of EUR (P10 = high case). The band reflects trend uncertainty in the fitted window only — not future events, workovers or changes in operating strategy.</p>
<h3>EUR</h3>
<div class="eq">EUR = cumulative actual to the cutoff + Σ q(t)·30.44   until q &lt; economic limit (max 30 yr)</div>
<h3>Backtest (hindcast)</h3>
<p>The last N months are hidden, the curve is fitted on what came before, and the hidden actuals are then revealed. Scored over producing months in the hidden window (at least 3):</p>
<div class="eq">cum error = (Σ q_P50 − Σ q_obs) / Σ q_obs      (+ = forecast too high)
MAPE      = mean |q_P50 − q_obs| / q_obs
coverage  = share of hidden months inside the P10–P90 band</div>
<p>The field scoreboard repeats a 12-month hindcast for every producer with the automatic window, so the method is judged across wells, not on a hand-picked one.</p>
<h3>References</h3>
<ul><li>Arps, J.J. (1945). Analysis of decline curves. Trans. AIME 160, 228–247.</li>
<li>Efron, B., Tibshirani, R. (1993). An Introduction to the Bootstrap. Chapman &amp; Hall (residual bootstrap).</li></ul>`

const FC_MONTHS = 60

export function mountForecast(el: HTMLElement, { ds, u }: Ctx) {
  const wells = eligible(ds)
  if (!wells.length) { el.append(h('div', { class: 'empty', style: { margin: '20px' } }, 'No producer has 12 producing months.')); return }
  const w = wells.find(x => x.id === state.well) ?? wells[0]
  if (state.well !== w.id) state.well = w.id
  const pts = producingPoints(w)

  // local view state
  let hide = Math.min(12, Math.max(0, w.last - (pts[5]?.t ?? w.last)))
  let start: number | null = null          // null = automatic
  let fixedB: number | null = null
  const limInit = u.sys === 'si' ? 5 : 30   // display units
  let qLimit = limInit / u.liq(1)          // Sm3/d
  let logY = true
  let animate = true
  let fc: Forecast | null = null
  let bt: Backtest | null = null

  const rail = h('aside', { class: 'rail', 'aria-label': 'Forecast controls' })
  const center = h('div', { class: 'center' })
  const card = h('aside', { class: 'rail right', 'aria-label': 'Forecast results' })
  el.append(h('div', { class: 'cols chart-first' }, rail, center, card))

  // ---------- controls ----------
  const sel = h('select', { 'aria-label': 'Well' }, ...wells.map(x => h('option', { value: x.id, selected: x.id === w.id }, x.id))) as HTMLSelectElement
  sel.addEventListener('change', () => set({ well: sel.value }))
  const idx = wells.indexOf(w)
  const nav = (d: number) => set({ well: wells[(idx + d + wells.length) % wells.length].id })
  const cutoffOf = () => w.last - hide + 1
  const startOut = h('span', { class: 'mono' })
  const startIn = h('input', { type: 'range', step: 1, 'aria-label': 'Fit window start' }) as HTMLInputElement
  startIn.addEventListener('input', () => { start = +startIn.value; update(false) })
  const autoBtn = h('button', { class: 'btn ghost', onclick: () => { start = null; update(false) } }, 'Auto')
  const bBox = h('input', { type: 'checkbox', 'aria-label': 'Fix b by hand' }) as HTMLInputElement
  const bSlider = slider('b exponent', 0.5, 0, 1.5, 0.05, v => v.toFixed(2), v => { if (fixedB != null) { fixedB = v; update(false) } })
  bSlider.style.display = 'none'
  bBox.addEventListener('change', () => {
    fixedB = bBox.checked ? +(bSlider.querySelector('input') as HTMLInputElement).value : null
    bSlider.style.display = bBox.checked ? '' : 'none'
    update(false)
  })
  const scale = h('div', { class: 'seg', role: 'group', 'aria-label': 'Rate axis' },
    ...([['log', 'Log'], ['lin', 'Linear']] as const).map(([k, l]) => {
      const b = h('button', { 'aria-pressed': String((k === 'log') === logY), onclick: () => { logY = k === 'log'; scale.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); update(false) } }, l)
      return b
    }))
  const limMax = u.sys === 'si' ? 80 : 500, limStep = u.sys === 'si' ? 1 : 5
  rail.append(
    h('span', { class: 'eyebrow' }, 'Well'),
    h('div', { style: { display: 'flex', gap: '6px' } },
      h('button', { class: 'btn', 'aria-label': 'Previous well', onclick: () => nav(-1) }, '◂'), sel,
      h('button', { class: 'btn', 'aria-label': 'Next well', onclick: () => nav(1) }, '▸')),
    h('span', { class: 'eyebrow' }, 'Backtest'),
    slider('Hide last N months', hide, 0, 36, 1, v => (v ? `${v} mo` : 'none'), v => { hide = v; if (start != null && start > cutoffOf() - 4) start = null; update(true) }),
    h('div', { class: 'small muted' }, 'The curve is fitted only on data before the cutoff. The hidden months are then revealed and scored.'),
    h('span', { class: 'eyebrow' }, 'Fit'),
    h('label', { class: 'field' }, h('span', { class: 'top' }, h('span', {}, 'Fit window start'), startOut), startIn),
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, autoBtn, h('span', { class: 'small muted' }, 'peak in last 48 months')),
    h('label', { class: 'small', style: { display: 'flex', gap: '8px', alignItems: 'center' } }, bBox, 'Fix b by hand'),
    bSlider,
    slider('Economic limit', limInit, limStep, limMax, limStep, v => `${v} ${u.liqU}`, v => { qLimit = v / u.liq(1); update(false) }),
    h('div', {}, h('span', { class: 'eyebrow', style: { display: 'block', marginBottom: '6px' } }, 'Rate axis'), scale))

  // ---------- charts ----------
  const mainBox = h('div', { class: 'chart' }), cumBox = h('div', { class: 'chart' }), sbBox = h('div', { class: 'chart' })
  center.append(
    panel(`${w.id} — oil rate, fit and forecast`, legend([
      { label: 'actual (fit window)', color: 'var(--oil)' }, { label: 'hidden actual', color: 'var(--ink-strong)', hollow: true },
      { label: 'P50 forecast', color: 'var(--ink-2)', dash: true }, { label: 'P10–P90', color: 'rgba(184,190,198,.35)' }]), mainBox),
    h('div', { class: 'row' },
      h('div', { style: { flex: '1 1 300px', display: 'flex' } }, panel('Cumulative over the hidden window', 'forecast vs actual', cumBox)),
      h('div', { style: { flex: '1 1 340px', display: 'flex' } }, panel('Field scoreboard — 12-month hindcast', 'cum error per well · click to open', sbBox))))

  const board = scoreboard(ds, 12)
  const charts = [
    responsive(mainBox, W => (W < 600 ? 300 : 380), { t: 18, r: 16, b: 30, l: 56 }, f => drawMain(f), 'Oil rate history, Arps fit and forecast'),
    responsive(cumBox, 230, { t: 16, r: 16, b: 30, l: 56 }, f => drawCum(f), 'Cumulative oil over the hidden window'),
    responsive(sbBox, () => board.length * 18 + 34, { t: 22, r: 64, b: 10, l: 64 }, f => drawBoard(f), 'Backtest error by well'),
  ]

  let raf = 0
  function update(anim: boolean) {
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => {
      animate = anim
      const cutoff = cutoffOf()
      const auto = autoStart(pts, cutoff)
      const lo = w.first, hi = Math.max(lo, cutoff - 4)
      if (start != null) start = Math.min(Math.max(start, lo), hi)
      const s = start ?? auto
      startIn.min = String(lo); startIn.max = String(hi); startIn.value = String(s)
      startOut.textContent = `${fmtMonth(ds.months[s])}${start == null ? ' · auto' : ''}`
      autoBtn.toggleAttribute('disabled', start == null)
      fc = forecast(w, pts, s, cutoff, w.last + FC_MONTHS, qLimit, fixedB)
      bt = fc && hide ? score(fc, pts) : null
      charts.forEach(c => c.redraw())
      renderCard()
      animate = false
    })
  }

  const dateOf = (t: number) => new Date(Date.UTC(ds.months[0].getUTCFullYear(), ds.months[0].getUTCMonth() + t, 1))

  function drawMain({ g, w: W, h: H }: { g: d3.Selection<SVGGElement, unknown, null, undefined>; w: number; h: number }) {
    g.selectAll('*').remove()
    if (!fc) { g.append('text').attr('class', 'lbl').attr('x', W / 2).attr('y', H / 2).attr('text-anchor', 'middle').text('Not enough producing months before the cutoff'); return }
    const f = fc
    const t0 = Math.max(w.first, f.start - 24)
    const xs = d3.scaleTime().domain([dateOf(t0), dateOf(f.end)]).range([0, W])
    const shown = pts.filter(p => p.t >= t0)
    const qmax = Math.max(d3.max(shown, p => p.q) ?? 1, d3.max(f.p10) ?? 1)
    const qmin = Math.max(qmax * 1e-3, Math.min(d3.min(shown, p => p.q) ?? 1, d3.min(f.p90) ?? 1) * 0.6)
    const ys = logY ? d3.scaleLog().domain([u.liq(qmin), u.liq(qmax) * 1.3]).range([H, 0]).clamp(true)
      : d3.scaleLinear().domain([0, u.liq(qmax) * 1.08]).range([H, 0]).nice()
    const Y = (q: number) => ys(u.liq(Math.max(q, qmin)))
    grid(g, ys, W, 4)
    g.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(xs).ticks(W < 600 ? 4 : 8)).call(axisStyle)
    g.append('g').call(d3.axisLeft(ys).ticks(logY ? 4 : 5, '~s')).call(axisStyle)
    g.append('text').attr('class', 'lbl').attr('x', 0).attr('y', -6).text(`oil ${u.liqU}${logY ? ' · log' : ''}`)

    const xc = xs(dateOf(f.cutoff))
    if (hide) {
      g.append('rect').attr('x', xc).attr('y', 0).attr('width', Math.max(0, xs(dateOf(w.last + 1)) - xc)).attr('height', H).attr('fill', 'var(--panel-2)')
      g.append('text').attr('class', 'lbl').attr('x', xc + 4).attr('y', 12).text(W < 600 ? 'hidden' : `hidden ${hide} mo`)
    }
    // economic limit
    if (qLimit >= qmin) g.append('line').attr('x1', 0).attr('x2', W).attr('y1', Y(qLimit)).attr('y2', Y(qLimit)).attr('stroke', 'var(--warn)').attr('stroke-dasharray', '2 4')
    if (qLimit >= qmin) g.append('text').attr('class', 'lbl').attr('x', W).attr('y', Y(qLimit) - 4).attr('text-anchor', 'end').attr('fill', 'var(--warn)').text('economic limit')
    // band
    const band = d3.area<number>().x((_, i) => xs(dateOf(f.months[i]))).y0((_, i) => Y(f.p90[i])).y1((_, i) => Y(f.p10[i]))
    const bandP = g.append('path').datum(f.p50).attr('d', band).attr('fill', 'var(--ink-2)').attr('fill-opacity', 0.12)
    // actuals before the cutoff
    const before = shown.filter(p => p.t < f.cutoff)
    const inWin = (t: number) => t >= f.start
    g.append('path').datum(before).attr('fill', 'none').attr('stroke', 'var(--oil)').attr('stroke-width', 1.5).attr('stroke-opacity', 0.6)
      .attr('d', d3.line<typeof before[0]>().x(p => xs(dateOf(p.t))).y(p => Y(p.q)))
    g.selectAll('circle.a').data(before).join('circle').attr('class', 'a').attr('cx', p => xs(dateOf(p.t))).attr('cy', p => Y(p.q))
      .attr('r', p => (inWin(p.t) ? 3 : 2)).attr('fill', p => (inWin(p.t) ? 'var(--oil)' : 'var(--dim)'))
    // fitted curve over the window, then forecast
    const fitLine = d3.range(f.start, f.cutoff + 1)
    const ln = d3.line<number>().x(t => xs(dateOf(t))).y(t => Y(arps(f.fit, t)))
    g.append('path').datum(fitLine).attr('d', ln).attr('fill', 'none').attr('stroke', 'var(--ink-2)').attr('stroke-width', 2)
    const fcP = g.append('path').datum(f.months).attr('d', ln).attr('fill', 'none').attr('stroke', 'var(--ink-2)').attr('stroke-width', 2).attr('stroke-dasharray', '6 4')
    g.append('line').attr('x1', xc).attr('x2', xc).attr('y1', 0).attr('y2', H).attr('stroke', 'var(--ink)').attr('stroke-width', 1)
    g.append('text').attr('class', 'lbl').attr('x', xc - 4).attr('y', H - 6).attr('text-anchor', 'end').text(W < 600 ? 'cutoff' : 'forecast made here')
    // hidden actuals
    const after = pts.filter(p => p.t >= f.cutoff)
    const hidP = g.append('path').datum(after).attr('fill', 'none').attr('stroke', 'var(--ink-strong)').attr('stroke-width', 1.5)
      .attr('d', d3.line<typeof after[0]>().x(p => xs(dateOf(p.t))).y(p => Y(p.q)))
    const hidC = g.selectAll('circle.h').data(after).join('circle').attr('class', 'h').attr('cx', p => xs(dateOf(p.t))).attr('cy', p => Y(p.q))
      .attr('r', 3).attr('fill', 'var(--panel)').attr('stroke', 'var(--ink-strong)').attr('stroke-width', 1.5)
    if (animate && dur(1)) {
      bandP.attr('opacity', 0).transition().duration(dur(500)).attr('opacity', 1)
      drawIn(fcP as any, 900)
      if (after.length) {
        drawIn(hidP as any, 1200, 900)
        hidC.attr('opacity', 0).transition().delay((_, i) => 900 + (i / after.length) * 1200).duration(150).attr('opacity', 1)
      }
    }
    // crosshair
    const cross = g.append('line').attr('y1', 0).attr('y2', H).attr('stroke', 'var(--muted)').attr('stroke-dasharray', '3 3').attr('opacity', 0)
    g.append('rect').attr('width', W).attr('height', H).attr('fill', 'transparent')
      .on('pointermove', ev => {
        const [mx] = d3.pointer(ev)
        const d = xs.invert(mx)
        const t = Math.round((d.getUTCFullYear() - ds.months[0].getUTCFullYear()) * 12 + d.getUTCMonth() - ds.months[0].getUTCMonth() + d.getUTCDate() / 30)
        cross.attr('x1', xs(dateOf(t))).attr('x2', xs(dateOf(t))).attr('opacity', 1)
        const a = pts.find(p => p.t === t)
        const i = t - f.cutoff
        const rows: [string, string][] = [['Actual', a ? `${fmt(u.liq(a.q))} ${u.liqU}${t >= f.cutoff ? ' (hidden)' : ''}` : '—']]
        if (t >= f.start) rows.push(['P50', `${fmt(u.liq(arps(f.fit, t)))} ${u.liqU}`])
        if (i >= 0 && i < f.months.length) rows.push(['P90 – P10', `${fmt(u.liq(f.p90[i]))} – ${fmt(u.liq(f.p10[i]))}`])
        tip(tipRows(fmtMonth(dateOf(t)), rows), ev)
      })
      .on('pointerleave', () => { cross.attr('opacity', 0); tip(null) })
  }

  function drawCum({ g, w: W, h: H }: { g: d3.Selection<SVGGElement, unknown, null, undefined>; w: number; h: number }) {
    g.selectAll('*').remove()
    if (!fc || !hide) {
      g.append('text').attr('class', 'lbl').attr('x', W / 2).attr('y', H / 2).attr('text-anchor', 'middle').text('Hide some months to run a backtest')
      return
    }
    const f = fc
    const ts = d3.range(f.cutoff, w.last + 1)
    const prod = new Map(pts.map(p => [p.t, p.q]))
    let ca = 0, cf = 0
    // both curves accumulate over producing months only, like the score
    const rows = ts.map(t => { const q = prod.get(t); if (q != null) { ca += q * 30.44; cf += f.p50[t - f.cutoff] * 30.44 } return { t, a: ca, f: cf } })
    const xs = d3.scaleTime().domain([dateOf(f.cutoff), dateOf(w.last)]).range([0, W])
    const ys = d3.scaleLinear().domain([0, u.cum(Math.max(ca, cf, 1)) * 1.1]).range([H, 0]).nice()
    grid(g, ys, W, 4)
    g.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(xs).ticks(W < 400 ? 3 : 5).tickFormat(d => d3.utcFormat('%b %y')(d as Date))).call(axisStyle)
    g.append('g').call(d3.axisLeft(ys).ticks(4, '~s')).call(axisStyle)
    g.append('text').attr('class', 'lbl').attr('x', 0).attr('y', -6).text(`cumulative oil (${u.cumU})`)
    const line = (k: 'a' | 'f') => d3.line<typeof rows[0]>().x(r => xs(dateOf(r.t))).y(r => ys(u.cum(r[k])))
    const pf = g.append('path').datum(rows).attr('d', line('f')).attr('fill', 'none').attr('stroke', 'var(--ink-2)').attr('stroke-width', 2).attr('stroke-dasharray', '6 4')
    const pa = g.append('path').datum(rows).attr('d', line('a')).attr('fill', 'none').attr('stroke', 'var(--ink-strong)').attr('stroke-width', 2)
    if (animate) { drawIn(pf as any, 900); drawIn(pa as any, 1200, 900) }
    const last = rows[rows.length - 1]
    g.append('text').attr('class', 'lbl-mono').attr('x', W).attr('y', ys(u.cum(last.f)) + (last.f >= last.a ? -6 : 14)).attr('text-anchor', 'end').text('P50')
    g.append('text').attr('class', 'lbl-mono').attr('x', W).attr('y', ys(u.cum(last.a)) + (last.a > last.f ? -6 : 14)).attr('text-anchor', 'end').text('actual')
  }

  function drawBoard({ g, w: W }: { g: d3.Selection<SVGGElement, unknown, null, undefined>; w: number; h: number }) {
    g.selectAll('*').remove()
    const rows = board.map(b => ({ ...b, e: b.bt?.cumErr ?? null }))
    const lim = Math.min(1, Math.max(0.2, d3.max(rows, r => Math.abs(r.e ?? 0)) ?? 0.2))
    const xs = d3.scaleLinear().domain([-lim, lim]).range([0, W]).nice()
    const ys = d3.scaleBand<string>().domain(rows.map(r => r.well)).range([0, rows.length * 18]).padding(0.25)
    g.append('g').attr('transform', 'translate(0,-4)').call(d3.axisTop(xs).ticks(W < 300 ? 3 : 5).tickFormat(d => `${Math.round(+d * 100)}%`)).call(axisStyle)
    g.append('line').attr('x1', xs(0)).attr('x2', xs(0)).attr('y1', 0).attr('y2', rows.length * 18).attr('stroke', 'var(--line)')
    const row = g.selectAll('g.r').data(rows).join('g').attr('class', 'r').style('cursor', 'pointer')
      .on('click', (_, r) => set({ well: r.well }))
      .on('pointermove', (ev, r) => tip(tipRows(r.well, r.bt && r.e != null
        ? [['Cum error', `${r.e > 0 ? '+' : ''}${pct(r.e)}`], ['MAPE', pct(r.bt.mape)], ['Months scored', String(r.bt.n)]]
        : [['Backtest', 'n/a — fewer than 3 producing months in the window']]), ev))
      .on('pointerleave', () => tip(null))
    row.append('rect').attr('x', -64).attr('width', W + 128).attr('y', r => ys(r.well)! - 2).attr('height', ys.step()).attr('fill', r => (r.well === w.id ? 'var(--panel-3)' : 'transparent'))
    row.append('text').attr('class', 'lbl-mono').attr('x', -8).attr('y', r => ys(r.well)! + ys.bandwidth() / 2 + 4).attr('text-anchor', 'end')
      .attr('fill', r => (r.well === w.id ? 'var(--ink-strong)' : 'var(--ink)')).text(r => r.well)
    row.append('rect').attr('y', r => ys(r.well)!).attr('height', ys.bandwidth()).attr('x', xs(0)).attr('width', 0)
      .attr('fill', r => (r.well === w.id ? 'var(--ink-strong)' : 'var(--ink-2)')).attr('fill-opacity', r => (r.well === w.id ? 1 : 0.6))
      .transition().duration(dur(600)).delay((_, i) => dur(i * 15))
      .attr('x', r => xs(Math.min(0, Math.max(-lim, r.e ?? 0)))).attr('width', r => Math.abs(xs(Math.max(-lim, Math.min(lim, r.e ?? 0))) - xs(0)))
    row.append('text').attr('class', 'lbl-mono').attr('y', r => ys(r.well)! + ys.bandwidth() / 2 + 4)
      .attr('x', W + 60).attr('text-anchor', 'end').attr('fill', 'var(--muted)')
      .text(r => (r.e == null ? 'n/a' : `${r.e > 0 ? '+' : ''}${Math.round(r.e * 100)}%`))
  }

  function renderCard() {
    card.innerHTML = ''
    const k = (l: string, v: string, s?: string) => h('div', { class: 'kpi' }, h('div', { class: 'l' }, l), h('div', { class: 'v' }, v), s ? h('div', { class: 's' }, s) : null)
    if (!fc) { card.append(h('div', { class: 'empty' }, 'Not enough producing months before the cutoff. Hide fewer months.')); return }
    const f = fc.fit
    const scored = board.filter(b => b.bt?.cumErr != null).map(b => Math.abs(b.bt!.cumErr!))
    card.append(
      h('span', { class: 'eyebrow' }, 'Arps fit'),
      h('div', { class: 'kpis' },
        k('q_i at fit start', `${fmt(u.liq(f.qi))}`, u.liqU),
        k('D_i nominal', `${fmt(annualDecline(f.di) * 100, 1)}`, '% per year'),
        k('b exponent', f.b.toFixed(2), regime(f.b)),
        k('Fit points', String(fc.fitPts.length), `σ ln q = ${f.sigma.toFixed(2)}`)),
      h('span', { class: 'eyebrow' }, hide ? `Backtest · last ${hide} months hidden` : 'Backtest'),
      !hide ? h('div', { class: 'small muted' }, 'No months hidden: this is a true forecast. Move "Hide last N months" to test the method against data it has not seen.')
        : bt && bt.cumErr != null ? h('div', { class: 'kpis' },
          k('Cum error', `${bt.cumErr > 0 ? '+' : ''}${pct(bt.cumErr, 1)}`, bt.cumErr > 0 ? 'forecast too high' : 'forecast too low'),
          k('MAPE', pct(bt.mape, 0), 'monthly rate'),
          k('In P10–P90 band', pct(bt.coverage), `${bt.n} months scored`),
          k('Hidden volume', `${fmt(u.cum(bt.actualCum) / 1e3)}k`, `${u.cumU} actual`))
          : h('div', { class: 'small muted' }, 'Fewer than 3 producing months in the hidden window (well shut in), so nothing to score.'),
      h('span', { class: 'eyebrow' }, 'EUR to economic limit'),
      h('div', { class: 'kpis' },
        k('P90 (low)', fmt(u.cum(fc.eur.p90) / 1e6, 2), `M${u.cumU}`),
        k('P50', fmt(u.cum(fc.eur.p50) / 1e6, 2), `M${u.cumU}`),
        k('P10 (high)', fmt(u.cum(fc.eur.p10) / 1e6, 2), `M${u.cumU}`),
        k('Limit reached', fc.limitMonth != null ? fmtMonth(dateOf(fc.limitMonth)) : '> 30 yr', 'P50 curve')),
      h('div', { class: 'small muted', style: { lineHeight: 1.6 } },
        `Field scoreboard: median absolute 12-month cum error ${scored.length ? pct(d3.median(scored)!, 0) : '—'} across ${scored.length} wells. `,
        ds.real ? 'Volve is real data: shut-ins, choke changes and water breakthrough are not in the decline model, so large misses usually mark an operating change.'
          : 'Field X is synthetic; its workovers and lift changes deliberately break simple decline behaviour.'))
  }

  update(true)
  return () => { charts.forEach(c => c.destroy()); tip(null) }
}
