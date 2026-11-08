// Toolkit T3 — share a limited lift-gas supply across gas-lift wells by the equal-slope rule.
import * as d3 from 'd3'
import type { Ctx } from '../main'
import { go, set } from '../core/state'
import { fmt, pct } from '../core/units'
import { currentRatio, equalSplit, gasLiftWells, gasToHold, optimise, qOf, type Alloc } from '../analysis/gaslift'
import { axisStyle, dur, grid, h, legend, panel, responsive, slider, tip, tipRows } from '../ui/kit'

export const METHODS = `
<h2>Gas lift allocation</h2>
<p>Field X gas-lift producers that flowed in the latest month (average of the last 3 months). Field X is synthetic and the performance curves are <em>illustrative fits</em>: in practice each curve comes from a nodal model or a multi-rate gas-lift test of the well.</p>
<h3>Well performance curve (oil vs injected gas)</h3>
<div class="eq">q(g)  = q0 + c · [ (g_opt + g1) · ln(1 + g/g1) − g ]
q'(g) = c · [ (g_opt + g1) / (g1 + g) − 1 ]          = 0 at g = g_opt</div>
<p>Concave, rising to a maximum at g_opt and falling beyond it as tubing friction outweighs the lighter gradient. Calibration per well: the curve passes through today's (g, q); g_opt = k · g_today with k by diagnosed mechanism (under-injected 2.4–3.2, healthy 1.05–1.35, damaged 0.95–1.2, high water cut 0.85–1.15); natural-flow share q0 / q(g_opt) 15–45 %; g1 = 0.30–0.55 · g_opt. Within each range the value is fixed per well (hash of the well name), so results are repeatable.</p>
<h3>Equal-slope optimum</h3>
<div class="eq">maximise   Σ q_i(g_i)
subject to Σ g_i ≤ G,   0 ≤ g_i ≤ min(g_opt,i , g_max)

KKT:  ∂q_i/∂g_i = λ   for every well with 0 &lt; g_i &lt; cap
      ∂q_i/∂g_i(0) ≤ λ  → g_i = 0
      g_i(λ) = (g_opt,i + g1,i) / (1 + λ/c_i) − g1,i     (closed form, then clipped)</div>
<p>λ is the marginal oil from one more unit of gas, the same in every well at the optimum. It is found by bisection so that Σ g_i(λ) = G. Because every curve is concave the KKT point is the global optimum. If G exceeds Σ g_opt, the surplus is left unused (λ = 0).</p>
<h3>Comparison cases</h3>
<ul>
<li><strong>Current ratio</strong>: today's split, scaled to the gas available.</li>
<li><strong>Equal split</strong>: G / n to every well.</li>
<li><strong>Gas freed</strong>: the least gas that, optimally allocated, holds today's oil rate (bisection on G).</li>
</ul>
<p>Not modelled: compressor and separator constraints, water-handling limits, casing-pressure and valve-port limits other than the single per-well cap, multipointing, and unstable (heading) flow at low injection rates.</p>
<h3>References</h3>
<ul>
<li>Kanu, E.P., Mach, J., Brown, K.E. (1981). Economic approach to oil production and gas allocation in continuous gas lift. JPT 33(10).</li>
<li>Nishikiori, N., Redner, R.A., Doty, D.R., Schmidt, Z. (1995). An improved method for gas lift allocation optimization. J. Energy Resour. Technol. 117(2).</li>
<li>Brown, K.E. (1980). The Technology of Artificial Lift Methods, Vol. 2a. PennWell.</li>
</ul>`

type Mode = 'cur' | 'eq' | 'opt'
const MODE_LABEL: Record<Mode, string> = { cur: 'Current', eq: 'Equal split', opt: 'Optimised' }

export function mountGasLift(el: HTMLElement, { ds, u }: Ctx) {
  if (ds.id !== 'fieldx') {
    el.append(h('div', { class: 'empty', style: { margin: '20px', display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'flex-start' } },
      h('strong', {}, "Volve's public file has no gas-lift data."),
      h('span', {}, 'The Volve producers report no lift type or lift-gas rate, so there is nothing to allocate. This page runs on Field X, whose 21 gas-lift wells (synthetic) share one compressor.'),
      h('button', { class: 'btn primary', onclick: () => set({ ds: 'fieldx' }) }, 'Switch to Field X · synthetic')))
    return
  }

  const ws = gasLiftWells(ds).sort((a, b) => b.qCur - a.qCur)
  const n = ws.length
  const Gcur = d3.sum(ws, w => w.gCur)
  const qToday = d3.sum(ws, w => w.qCur)
  const idleGL = ds.producers.filter(w => w.lift === 'Gas lift').length - n

  // display units: total and per-well gas in MMscf/d (field) or 10³ Sm³/d (SI)
  const field = u.sys === 'field'
  const gD = (v: number) => (field ? u.gas(v) / 1000 : v / 1000)
  const gFromD = (d: number) => (field ? (d * 1000) / u.gas(1) : d * 1000)
  const gU = field ? 'MMscf/d' : '10³ Sm³/d'
  const gTxt = (v: number, digits = 1) => `${fmt(gD(v), digits)} ${gU}`
  const lamTxt = (lam: number) => `${fmt(lam * (u.liq(1) / gD(1)), 0)} ${field ? 'bbl/MMscf' : 'Sm³ / 10³ Sm³'}`

  let G = Gcur
  let gMax = Infinity
  let mode: Mode = 'opt'
  let opt: Alloc, eq: Alloc, cr: Alloc, cur: Alloc
  let shown = ws.map(w => w.gCur)   // gas currently drawn by the bar chart (animation start point)
  const compute = () => {
    opt = optimise(ws, G, gMax); eq = equalSplit(ws, G, gMax); cr = currentRatio(ws, G, gMax)
    cur = { g: ws.map(w => w.gCur), q: ws.map(w => w.qCur), total: qToday, lam: NaN }
  }
  const alloc = (m: Mode) => (m === 'opt' ? opt : m === 'eq' ? eq : cur)
  compute()

  const rail = h('aside', { class: 'rail', 'aria-label': 'Lift gas' })
  const center = h('div', { class: 'center' })
  const card = h('aside', { class: 'rail right', 'aria-label': 'Result' })
  el.append(h('div', { class: 'cols chart-first' }, rail, center, card))

  let raf = 0
  const changed = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { compute(); redrawAll() }) }
  const gSlider = slider('Lift gas available', +gD(Gcur).toFixed(1), +gD(Gcur * 0.2).toFixed(1), +gD(Gcur * 1.8).toFixed(1), field ? 0.1 : 1,
    v => `${fmt(v, field ? 1 : 0)} ${gU}`, v => { G = gFromD(v); changed() })
  const gInput = gSlider.querySelector('input') as HTMLInputElement
  const setGas = (frac: number) => { gInput.value = String(gD(Gcur * frac)); gInput.dispatchEvent(new Event('input')) }
  const capSlider = slider('Per-well injection limit', 4, 1, 4, 0.1, v => (v >= 4 ? 'none' : `${fmt(v, 1)} × today's mean`),
    v => { gMax = v >= 4 ? Infinity : (v * Gcur) / n; changed() })
  const modeSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Allocation shown' },
    ...(['cur', 'eq', 'opt'] as Mode[]).map(m => h('button', { 'aria-pressed': String(m === mode), 'data-m': m, onclick: () => setMode(m) }, MODE_LABEL[m])))
  function setMode(m: Mode) {
    mode = m
    modeSeg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.getAttribute('data-m') === m)))
    animateBars()
  }
  rail.append(
    h('span', { class: 'eyebrow' }, 'Compressor'),
    gSlider,
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
      h('button', { class: 'btn', onclick: () => setGas(1) }, 'Today'),
      h('button', { class: 'btn', onclick: () => setGas(0.6) }, 'Compressor trip −40 %'),
      h('button', { class: 'btn', onclick: () => setGas(1.25) }, 'Extra compressor +25 %')),
    capSlider,
    h('span', { class: 'eyebrow' }, 'Bars show'),
    modeSeg,
    h('div', { class: 'small muted', style: { lineHeight: 1.5 } },
      `${n} gas-lift wells flowing now${idleGL > 0 ? ` (${idleGL} idle, excluded — see Screen)` : ''}. Field X is synthetic; each curve is an illustrative fit through the well's latest month (see Methods).`))

  const barBox = h('div', { class: 'chart' }), curveBox = h('div', { class: 'chart' }), fieldBox = h('div', { class: 'chart' })
  center.append(
    panel('Lift-gas allocation by well', legend([{ label: 'lift gas', color: 'var(--gas)' }, { label: 'today', color: 'var(--ink-2)', hollow: true }, { label: 'well optimum', color: 'var(--dim)', dash: true }]), barBox),
    h('div', { class: 'row' },
      h('div', { style: { flex: '3 1 420px', display: 'flex' } }, panel('Well performance curves', legend([{ label: 'optimised', color: 'var(--oil)' }, { label: 'today', color: 'var(--ink-2)', hollow: true }, { label: 'slope λ', color: 'var(--ink-2)', dash: true }]), curveBox)),
      h('div', { style: { flex: '2 1 300px', display: 'flex' } }, panel('Field lift curve', legend([{ label: 'optimised', color: 'var(--oil)' }, { label: 'current ratio', color: 'var(--ink-2)' }, { label: 'equal split', color: 'var(--dim)', dash: true }]), fieldBox))))

  type G3 = d3.Selection<SVGGElement, unknown, null, undefined>
  let barG: G3 | null = null
  let barX: d3.ScaleLinear<number, number> | null = null
  const charts = [
    responsive(barBox, n * 20 + 40, { t: 8, r: 70, b: 30, l: 48 }, f => drawBars(f)),
    responsive(curveBox, 340, { t: 14, r: 14, b: 40, l: 54 }, f => drawCurves(f)),
    responsive(fieldBox, 340, { t: 14, r: 14, b: 40, l: 54 }, f => drawField(f)),
  ]
  function redrawAll() { charts[1].redraw(); charts[2].redraw(); animateBars(); renderCard() }

  // ---------- bars ----------
  function drawBars({ g, w: W, h: H }: { g: G3; w: number; h: number }) {
    g.selectAll('*').remove()
    barG = g
    const ys = d3.scaleBand<string>().domain(ws.map(w => w.id)).range([0, H]).padding(0.28)
    const xmax = d3.max(ws, w => Math.max(w.gOpt, w.gCur)) ?? 1
    barX = d3.scaleLinear().domain([0, gD(xmax) * 1.05]).range([0, W]).nice()
    const xs = barX
    g.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(xs).ticks(W < 600 ? 4 : 7)).call(axisStyle)
    g.append('text').attr('class', 'lbl').attr('x', W).attr('y', H + 28).attr('text-anchor', 'end').text(`lift gas per well (${gU})`)
    g.append('text').attr('class', 'lbl').attr('x', W + 66).attr('y', -1).attr('text-anchor', 'end').text(W < 600 ? `Δ oil` : `Δ oil ${u.liqU}`)
    const row = g.selectAll('g.r').data(ws).join('g').attr('class', 'r').attr('transform', w => `translate(0,${ys(w.id)})`)
    row.append('text').attr('class', 'lbl-mono').attr('x', -8).attr('y', ys.bandwidth() / 2 + 4).attr('text-anchor', 'end').text(w => w.id)
    row.append('rect').attr('class', 'track').attr('width', W).attr('height', ys.bandwidth()).attr('fill', 'var(--panel-2)')
    row.append('rect').attr('class', 'bar').attr('height', ys.bandwidth()).attr('fill', 'var(--gas)').attr('fill-opacity', 0.85)
      .attr('width', (_, i) => xs(gD(shown[i])))
    row.append('line').attr('x1', w => xs(gD(w.gOpt))).attr('x2', w => xs(gD(w.gOpt))).attr('y1', -2).attr('y2', ys.bandwidth() + 2)
      .attr('stroke', 'var(--dim)').attr('stroke-width', 2).attr('stroke-dasharray', '3 2')
    row.append('circle').attr('cx', w => xs(gD(w.gCur))).attr('cy', ys.bandwidth() / 2).attr('r', 3.5).attr('fill', 'var(--panel)').attr('stroke', 'var(--ink-2)').attr('stroke-width', 1.5)
    row.append('text').attr('class', 'lbl-mono dq').attr('x', W + 66).attr('y', ys.bandwidth() / 2 + 4).attr('text-anchor', 'end')
    row.append('rect').attr('x', -48).attr('width', W + 118).attr('height', ys.bandwidth()).attr('fill', 'transparent')
      .on('pointermove', (ev, w) => {
        const i = ws.indexOf(w), a = alloc(mode)
        tip(tipRows(`${w.id} · ${MODE_LABEL[mode].toLowerCase()}`, [
          ['Lift gas', `${gTxt(a.g[i], 2)} (today ${gTxt(w.gCur, 2)})`], ['Oil', `${fmt(u.liq(a.q[i]))} ${u.liqU} (today ${fmt(u.liq(w.qCur))})`],
          ['Well optimum', gTxt(w.gOpt, 2)], ['Water cut', pct(w.wc)], ['Diagnosis', w.truth ?? '—']]), ev)
      })
      .on('pointerleave', () => tip(null))
  }
  function animateBars() {
    if (!barG || !barX) return
    const a = alloc(mode), xs = barX
    barG.selectAll<SVGRectElement, unknown>('rect.bar').data(a.g)
      .transition().duration(dur(900)).delay((_, i) => dur(i * 25)).ease(d3.easeCubicInOut).attr('width', g => xs(gD(g)))
    barG.selectAll<SVGTextElement, unknown>('text.dq').data(a.q)
      .text((q, i) => {
        const d = q - ws[i].qCur
        return mode === 'cur' ? fmt(u.liq(q)) : `${d >= 0 ? '+' : '−'}${fmt(u.liq(Math.abs(d)))}`
      })
      .attr('fill', (q, i) => (mode !== 'cur' && q - ws[i].qCur < -0.5 ? 'var(--muted)' : 'var(--ink)'))
    shown = a.g.slice()
  }

  // ---------- curves ----------
  function drawCurves({ g, w: W, h: H }: { g: G3; w: number; h: number }) {
    g.selectAll('*').remove()
    const gmaxD = (d3.max(ws, w => w.gOpt) ?? 1) * 1.6
    const xs = d3.scaleLinear().domain([0, gD(gmaxD)]).range([0, W]).nice()
    const ys = d3.scaleLinear().domain([0, u.liq(d3.max(ws, w => qOf(w, w.gOpt)) ?? 1) * 1.08]).range([H, 0]).nice()
    grid(g, ys, W)
    g.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(xs).ticks(W < 600 ? 4 : 6)).call(axisStyle)
    g.append('g').call(d3.axisLeft(ys).ticks(5, '~s')).call(axisStyle)
    g.append('text').attr('class', 'lbl').attr('x', W / 2).attr('y', H + 34).attr('text-anchor', 'middle').text(`lift gas (${gU})`)
    g.append('text').attr('class', 'lbl').attr('transform', `translate(-42,${H / 2}) rotate(-90)`).attr('text-anchor', 'middle').text(`oil (${u.liqU})`)
    const gsamp = d3.range(0, 61).map(k => (k / 60) * gmaxD)
    const line = (w: typeof ws[0]) => d3.line<number>().x(v => xs(gD(v))).y(v => ys(u.liq(Math.max(0, qOf(w, v)))))(gsamp)
    const paths = g.append('g').selectAll('path').data(ws).join('path').attr('d', line).attr('fill', 'none')
      .attr('stroke', 'var(--dim)').attr('stroke-width', 1.2).attr('stroke-opacity', 0.8)
    const lam = opt.lam
    const span = gmaxD * 0.09
    const tan = g.append('g').selectAll('line').data(ws.filter((_, i) => opt.g[i] > 0)).join('line')
      .attr('stroke', 'var(--ink-2)').attr('stroke-dasharray', '3 2').attr('stroke-width', 1)
      .each(function (w) {
        const i = ws.indexOf(w), g0 = opt.g[i], q0 = opt.q[i]
        const sl = isFinite(lam) ? lam : 0
        d3.select(this).attr('x1', xs(gD(g0 - span))).attr('x2', xs(gD(g0 + span)))
          .attr('y1', ys(u.liq(q0 - sl * span))).attr('y2', ys(u.liq(q0 + sl * span)))
      })
    g.append('g').selectAll('circle').data(ws).join('circle').attr('cx', w => xs(gD(w.gCur))).attr('cy', w => ys(u.liq(w.qCur))).attr('r', 3.5)
      .attr('fill', 'var(--panel)').attr('stroke', 'var(--ink-2)').attr('stroke-width', 1.5)
    const dots = g.append('g').selectAll('circle').data(ws).join('circle').attr('r', 4).attr('fill', 'var(--oil)').attr('stroke', 'var(--panel)').attr('stroke-width', 1.5)
      .attr('cx', w => xs(gD(w.gCur))).attr('cy', w => ys(u.liq(w.qCur)))
    dots.transition().duration(dur(900)).ease(d3.easeCubicInOut)
      .attr('cx', (_, i) => xs(gD(opt.g[i]))).attr('cy', (_, i) => ys(u.liq(opt.q[i])))
    tan.attr('opacity', 0).transition().delay(dur(800)).duration(dur(300)).attr('opacity', 1)
    g.append('text').attr('class', 'lbl').attr('x', W).attr('y', 4).attr('text-anchor', 'end')
      .text(lam > 0 ? `common slope λ = ${lamTxt(lam)}` : 'surplus gas: every well at its optimum')
    const hl = g.append('text').attr('class', 'lbl-mono').attr('opacity', 0)
    g.append('g').selectAll('path').data(ws).join('path').attr('d', line).attr('fill', 'none').attr('stroke', 'transparent').attr('stroke-width', 10)
      .on('pointermove', (ev, w) => {
        const i = ws.indexOf(w)
        paths.attr('stroke', p => (p === w ? 'var(--oil)' : 'var(--dim)')).attr('stroke-width', p => (p === w ? 2.5 : 1.2)).attr('stroke-opacity', p => (p === w ? 1 : 0.35))
        hl.attr('opacity', 1).attr('x', Math.min(W - 40, xs(gD(w.gOpt)) + 4)).attr('y', ys(u.liq(qOf(w, w.gOpt))) - 6).text(w.id)
        tip(tipRows(w.id, [['Optimised', `${gTxt(opt.g[i], 2)} → ${fmt(u.liq(opt.q[i]))} ${u.liqU}`], ['Today', `${gTxt(w.gCur, 2)} → ${fmt(u.liq(w.qCur))} ${u.liqU}`], ['Max oil', `${fmt(u.liq(qOf(w, w.gOpt)))} at ${gTxt(w.gOpt, 2)}`]]), ev)
      })
      .on('pointerleave', () => { paths.attr('stroke', 'var(--dim)').attr('stroke-width', 1.2).attr('stroke-opacity', 0.8); hl.attr('opacity', 0); tip(null) })
  }

  // ---------- field lift curve ----------
  function drawField({ g, w: W, h: H }: { g: G3; w: number; h: number }) {
    g.selectAll('*').remove()
    const need = d3.sum(ws, w => Math.min(w.gOpt, gMax))
    const gTop = Math.max(Gcur * 1.8, need * 1.1)
    const pts = d3.range(0, 41).map(k => {
      const Gk = (k / 40) * gTop
      return { G: Gk, o: optimise(ws, Gk, gMax).total, c: currentRatio(ws, Gk, gMax).total, e: equalSplit(ws, Gk, gMax).total }
    })
    const xs = d3.scaleLinear().domain([0, gD(gTop)]).range([0, W]).nice()
    const ys = d3.scaleLinear().domain([u.liq(d3.min(pts, p => Math.min(p.o, p.c, p.e))! * 0.95), u.liq(d3.max(pts, p => p.o)! * 1.03)]).range([H, 0]).nice()
    grid(g, ys, W)
    g.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(xs).ticks(W < 400 ? 4 : 5)).call(axisStyle)
    g.append('g').call(d3.axisLeft(ys).ticks(5, '~s')).call(axisStyle)
    g.append('text').attr('class', 'lbl').attr('x', W / 2).attr('y', H + 34).attr('text-anchor', 'middle').text(`total lift gas (${gU})`)
    g.append('text').attr('class', 'lbl').attr('transform', `translate(-42,${H / 2}) rotate(-90)`).attr('text-anchor', 'middle').text(`field oil (${u.liqU})`)
    const series: ['o' | 'c' | 'e', string, string | null][] = [['e', 'var(--dim)', '4 3'], ['c', 'var(--ink-2)', null], ['o', 'var(--oil)', null]]
    series.forEach(([k, col, dash]) => {
      g.append('path').datum(pts).attr('fill', 'none').attr('stroke', col).attr('stroke-width', 2).attr('stroke-dasharray', dash)
        .attr('d', d3.line<typeof pts[0]>().x(p => xs(gD(p.G))).y(p => ys(u.liq(p[k]))).curve(d3.curveMonotoneX))
    })
    const x = xs(gD(G))
    g.append('line').attr('x1', x).attr('x2', x).attr('y1', 0).attr('y2', H).attr('stroke', 'var(--gas)').attr('stroke-dasharray', '3 3')
    g.append('text').attr('class', 'lbl').attr('x', x + (x > W - 70 ? -4 : 4)).attr('y', H - 6).attr('text-anchor', x > W - 70 ? 'end' : 'start').attr('fill', 'var(--gas)').text('available')
    ;([[opt.total, 'var(--oil)'], [cr.total, 'var(--ink-2)'], [eq.total, 'var(--dim)']] as [number, string][]).forEach(([v, c]) =>
      g.append('circle').attr('cx', x).attr('cy', ys(u.liq(v))).attr('r', 4).attr('fill', c).attr('stroke', 'var(--panel)').attr('stroke-width', 1.5))
    g.append('path').attr('d', d3.symbol(d3.symbolCross, 60)()).attr('transform', `translate(${xs(gD(Gcur))},${ys(u.liq(qToday))})`).attr('fill', 'var(--ink-strong)')
    g.append('text').attr('class', 'lbl').attr('x', xs(gD(Gcur)) + 6).attr('y', ys(u.liq(qToday)) + 14).text('today')
    const hit = g.append('rect').attr('width', W).attr('height', H).attr('fill', 'transparent')
    hit.on('pointermove', ev => {
      const [mx] = d3.pointer(ev)
      const p = pts[Math.max(0, Math.min(pts.length - 1, Math.round((xs.invert(mx) / gD(gTop)) * 40)))]
      tip(tipRows(`${gTxt(p.G)} lift gas`, [['Optimised', `${fmt(u.liq(p.o))} ${u.liqU}`], ['Current ratio', `${fmt(u.liq(p.c))} ${u.liqU}`], ['Equal split', `${fmt(u.liq(p.e))} ${u.liqU}`]]), ev)
    }).on('pointerleave', () => tip(null))
  }

  // ---------- card ----------
  function renderCard() {
    card.innerHTML = ''
    const gain = opt.total - qToday
    const hold = gasToHold(ws, qToday, gMax)
    const zero = opt.g.filter(g => g < 1).length
    const moves = ws.map((w, i) => ({ w, dg: opt.g[i] - w.gCur, dq: opt.q[i] - w.qCur })).sort((a, b) => Math.abs(b.dq) - Math.abs(a.dq)).slice(0, 6)
    card.append(
      h('span', { class: 'eyebrow' }, `Optimised at ${gTxt(G)}`),
      h('div', { class: 'kpis' },
        kpi(`Field oil today (${u.liqU})`, fmt(u.liq(qToday)), `${n} gas-lift wells · ${gTxt(Gcur)}`),
        kpi(`Optimised (${u.liqU})`, fmt(u.liq(opt.total)), `${gain >= 0 ? '+' : '−'}${fmt(u.liq(Math.abs(gain)))} · ${gain >= 0 ? '+' : '−'}${pct(Math.abs(gain) / qToday, 1)}`),
        kpi('Marginal oil λ', opt.lam > 0 ? lamTxt(opt.lam) : 'surplus', opt.lam > 0 ? 'same for every well with gas' : 'every well at its optimum'),
        kpi('Wells at zero gas', String(zero), zero ? 'gas better used elsewhere' : 'all wells keep gas'),
        kpi('Gas freed', isFinite(hold) ? gTxt(Math.max(0, Gcur - hold)) : '—', "holding today's oil, optimised"),
        kpi('vs equal split', `${opt.total - eq.total >= 0 ? '+' : '−'}${fmt(u.liq(Math.abs(opt.total - eq.total)))}`, `${u.liqU} better`)),
      h('span', { class: 'eyebrow' }, 'Biggest moves'),
      h('div', { class: 'tablewrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Well'), h('th', { class: 'num' }, `Δ gas`), h('th', { class: 'num' }, `Δ oil`))),
        h('tbody', {}, ...moves.map(m => h('tr', {},
          h('td', { class: 'mono' }, h('a', { href: `#/producer?ds=fieldx&w=${m.w.id}`, onclick: (e: Event) => { e.preventDefault(); go('producer', { well: m.w.id }) } }, m.w.id)),
          h('td', { class: 'num' }, `${m.dg >= 0 ? '+' : '−'}${fmt(gD(Math.abs(m.dg)), 2)}`),
          h('td', { class: 'num' }, `${m.dq >= 0 ? '+' : '−'}${fmt(u.liq(Math.abs(m.dq)))}`)))))),
      h('div', { class: 'small muted', style: { lineHeight: 1.5 } },
        `Gas in ${gU}, oil in ${u.liqU}. Gas moves from high-water-cut and inflow-limited wells, where the curve is flat, to under-injected wells, where it is steep. Check casing pressure and valve ports before resetting injection rates.`))
  }

  renderCard()
  const t0 = setTimeout(() => animateBars(), dur(400))
  return () => { charts.forEach(c => c.destroy()); cancelAnimationFrame(raf); clearTimeout(t0); tip(null) }
}

const kpi = (l: string, v: string, s?: string) => h('div', { class: 'kpi' }, h('div', { class: 'l' }, l), h('div', { class: 'v', style: { fontSize: '16px' } }, v), s ? h('div', { class: 's' }, s) : null)
