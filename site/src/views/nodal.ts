// Toolkit T2 — nodal analysis: inflow vs tubing performance, and a model-vs-measured pressure match.
import * as d3 from 'd3'
import type { Ctx } from '../main'
import { fmtMonth, presAt, type Dataset, type Well } from '../core/data'
import { set, state } from '../core/state'
import { fmt, pct } from '../core/units'
import { aof, calibrate, iprPwf, operatingPoint, TUBING, vlp, type Fluid, type Inflow, type Lift, type Tubing } from '../analysis/nodal'
import { axisStyle, dur, grid, h, legend, panel, responsive, slider, tip, tipRows, type Frame } from '../ui/kit'

export const METHODS = `
<h2>Nodal analysis</h2>
<p>The well flows where the reservoir's inflow (IPR) meets the pressure the tubing needs to lift that rate to the wellhead (VLP). The solution node is the sandface; the "today" point is the latest measured rate and flowing pressure.</p>
<h3>Inflow — composite PI / Vogel (Vogel, 1968)</h3>
<div class="eq">P_wf ≥ P_b :  q = J · (P_res − P_wf)
P_wf &lt; P_b :  q = J·(P_res − P_b) + (J·P_b / 1.8) · [1 − 0.2·(P_wf/P_b) − 0.8·(P_wf/P_b)²]</div>
<p>Applied to total liquid. Bubble point is not in either dataset: it is an assumed slider (default 0.6 × P_res). Default J = q_today / (P_res − P_wf,today).</p>
<h3>Outflow — simplified no-slip gradient</h3>
<div class="eq">dP/dz = k · ρ_ns · g  +  f · ρ_ns · v_m² / (2D) · (MD/TVD)
ρ_ns  = (q_o·ρ_o + q_w·ρ_w + q_g,total·ρ_g)_sc / (q_o·B_o + q_w + q_g,free·B_g)
q_g,free = q_o·(GOR − R_s(P,T)) + q_gl (above the injection depth)
B_g   = z·(T/T_sc)·(P_sc/P),  z = 0.9
f     = 0.25 / [log10(ε/3.7D + 5.74/Re^0.9)]²       (Swamee &amp; Jain, 1976)</div>
<p>R_s and B_o from Standing (1947). The tubing is marched from the wellhead in 60 segments with a linear temperature profile. This is <strong>not</strong> Beggs–Brill or Hagedorn–Brown: with no slip between gas and liquid it under-predicts liquid holdup, especially at low rates, so the VLP has no unstable "U" at low rates.</p>
<h3>Calibration</h3>
<p>A single multiplier <em>k</em> on the gravity term (a holdup correction) is fitted by golden-section search to minimise the mean absolute percentage error between model and measured flowing pressure (k stays at 1 if fitting does not help): monthly downhole-gauge pressure on Volve, well tests on Field X. Error is reported as mean absolute percentage error before and after. Field practice tunes holdup and friction factors the same way before using a VLP for prediction.</p>
<h3>Assumptions</h3>
<ul>
<li>Volve: tubing 5½″ (ID 4.892″), node TVD 2,900–3,100 m and gauge at the node, oil 28 °API, gas SG 0.75, temperatures 60 °C wellhead / 105 °C bottomhole — illustrative, not from the public file. Reservoir pressure is the adjustable Volve assumption.</li>
<li>Field X (synthetic): completion depths and tubing size from the synthetic schematic, oil 32 °API, 45 / 95 °C.</li>
<li>Liquid viscosity 1.5 cP oil / 0.5 cP water, gas 0.018 cP, roughness 0.015 mm.</li>
</ul>
<h3>References</h3>
<ul>
<li>Vogel, J.V. (1968). Inflow performance relationships for solution-gas drive wells. JPT 20(1).</li>
<li>Standing, M.B. (1947). A pressure-volume-temperature correlation for mixtures of California oils and gases. API Drilling and Production Practice.</li>
<li>Swamee, P.K., Jain, A.K. (1976). Explicit equations for pipe-flow problems. J. Hydraulics Division, ASCE 102(5).</li>
<li>Brown, K.E., Lea, J.F. (1985). Nodal systems analysis of oil and gas wells. JPT 37(10).</li>
</ul>`

interface Inputs { pres: number; pi: number; pb: number; whp: number; wc: number; gor: number; tub: number; qgl: number }
interface Today { t: number; q: number; pwf: number; oil: number }
interface CalPt { t: number; date: Date; ql: number; whp: number; pwf: number; fluid: Fluid; lift: Lift | null }

const API = { volve: 28, fieldx: 32 }
const GAS_SG = { volve: 0.75, fieldx: 0.7 }
const fluidOf = (ds: Dataset, wc: number, gor: number): Fluid => ({ api: API[ds.id], gor, wc, gasSg: GAS_SG[ds.id], waterSg: 1.03 })
const clampGor = (g: number) => Math.max(20, Math.min(800, g))

/** On-stream liquid rate for month t (calendar-day average corrected by uptime). */
function onStream(w: Well, t: number) {
  const up = Math.max(0.05, Math.min(1, (w.m.hrs[t] ?? 24) / 24))
  const o = Math.max(0, w.m.oil[t] ?? 0), wa = Math.max(0, w.m.wat[t] ?? 0), g = Math.max(0, w.m.gas[t] ?? 0)
  return { oil: o / up, wat: wa / up, gas: g / up, up }
}

function usable(ds: Dataset, w: Well) {
  return ds.id === 'volve' ? w.m.bhp.some(v => (v ?? 0) > 0) && w.m.whp.some(v => (v ?? 0) > 0) : w.tests.length > 0
}

function tubingOf(ds: Dataset, w: Well): Tubing {
  if (ds.id === 'volve') {
    const top = w.completion.zones[0]?.top ?? 3400
    const tvd = Math.max(2900, Math.min(3100, top * 0.85))
    return { tvd, md: top, id: TUBING[3].id, rough: 1.5e-5, tWh: 60, tBh: 105 }
  }
  const c = w.completion
  const k = Math.max(0, TUBING.findIndex(x => x.od === c.tubing))
  return { tvd: c.tvd ?? 2300, md: c.td, id: TUBING[k].id, rough: 1.5e-5, tWh: 45, tBh: 95 }
}

function liftDepth(w: Well, tub: Tubing) {
  const glm = w.completion.glm
  if (!glm?.length) return tub.tvd * 0.85
  return Math.min(tub.tvd * 0.95, Math.max(...glm) * (tub.tvd / tub.md))
}

function calPoints(ds: Dataset, w: Well, tub: Tubing): CalPt[] {
  const depth = liftDepth(w, tub)
  if (ds.id === 'volve') {
    const out: CalPt[] = []
    for (let t = w.first; t <= w.last; t++) {
      const bhp = w.m.bhp[t], whp = w.m.whp[t]
      if (!bhp || !whp || bhp < 20 || (w.m.hrs[t] ?? 0) < 12) continue
      const s = onStream(w, t)
      if (s.oil < 20) continue
      const ql = s.oil + s.wat
      out.push({ t, date: ds.months[t], ql, whp, pwf: bhp, fluid: fluidOf(ds, s.wat / ql, clampGor(s.gas / s.oil)), lift: null })
    }
    return out
  }
  return w.tests.map(te => {
    const t = Math.min(te.t, ds.months.length - 1)
    const o = w.m.oil[t] ?? 0
    const gor = o > 0 ? clampGor((w.m.gas[t] ?? 0) / o) : 100
    const gl = w.m.gl[t] ?? 0
    return { t, date: ds.months[t], ql: te.ql, whp: w.m.whp[t] ?? nearest(w.m.whp, t) ?? 10, pwf: te.pwf, fluid: fluidOf(ds, te.wc, gor), lift: gl > 0 ? { qgl: gl, depth } : null }
  })
}

function nearest(a: (number | null)[], t: number): number | null {
  for (let d = 0; d < a.length; d++) {
    const x = a[t - d] ?? a[t + d]
    if (x != null && x > 0) return x
  }
  return null
}

function defaults(ds: Dataset, w: Well, pts: CalPt[]): { inp: Inputs; today: Today } {
  const k = Math.max(0, TUBING.findIndex(x => Math.abs(x.id - tubingOf(ds, w).id) < 1e-6))
  if (ds.id === 'volve') {
    const p = pts[pts.length - 1]
    const pres = state.a.volvePres
    const ql = p.ql
    return {
      inp: { pres, pi: ql / Math.max(5, pres - p.pwf), pb: Math.round(pres * 0.6), whp: p.whp, wc: p.fluid.wc, gor: p.fluid.gor, tub: k, qgl: 0 },
      today: { t: p.t, q: ql, pwf: p.pwf, oil: ql * (1 - p.fluid.wc) },
    }
  }
  const te = w.tests[w.tests.length - 1]
  const p = pts[pts.length - 1]
  const pres = te.pres ?? presAt(ds, w, te.t, state.a)
  return {
    inp: { pres, pi: te.ql / Math.max(5, pres - te.pwf), pb: Math.round(pres * 0.6), whp: p.whp, wc: te.wc, gor: p.fluid.gor, tub: k, qgl: p.lift?.qgl ?? 0 },
    today: { t: p.t, q: te.ql, pwf: te.pwf, oil: te.ql * (1 - te.wc) },
  }
}

export function mountNodal(el: HTMLElement, { ds, u }: Ctx) {
  const wells = ds.producers.filter(w => usable(ds, w))
  if (!wells.length) { el.append(h('div', { class: 'empty', style: { margin: '20px' } }, 'No producer has the pressure data needed for nodal analysis.')); return }
  const w = wells.find(x => x.id === state.well) ?? wells[0]
  if (state.well !== w.id) state.well = w.id
  const idx = wells.indexOf(w)

  const baseTub = tubingOf(ds, w)
  const pts = calPoints(ds, w, baseTub)
  const cal = calibrate(pts, baseTub)
  const def = defaults(ds, w, pts)
  const today = def.today
  def.inp.wc = Math.round(def.inp.wc * 100) / 100
  def.inp.gor = Math.round(def.inp.gor)
  def.inp.whp = Math.round(def.inp.whp * 2) / 2
  def.inp.pi = Math.round(def.inp.pi * 10) / 10
  let inp: Inputs = { ...def.inp }
  let useCal = true
  const depth = liftDepth(w, baseTub)
  const hasLift = ds.id === 'fieldx' && w.lift === 'Gas lift'

  const rail = h('aside', { class: 'rail', 'aria-label': 'Nodal inputs' })
  const center = h('div', { class: 'center' })
  const card = h('aside', { class: 'rail right', 'aria-label': 'Operating point' })
  el.append(h('div', { class: 'cols chart-first' }, rail, center, card))

  const tubing = (i: number): Tubing => ({ ...baseTub, id: TUBING[i].id })
  const inflow = (): Inflow => ({ pres: inp.pres, pi: inp.pi, pb: Math.min(inp.pb, inp.pres) })
  const k = () => (useCal ? cal.k : 1)
  const bhpFn = (tubI: number) => {
    const f = fluidOf(ds, inp.wc, inp.gor)
    const lift = inp.qgl > 0 ? { qgl: inp.qgl, depth } : null
    const t = tubing(tubI), kk = k()
    return (q: number) => vlp(q, inp.whp, f, t, lift, kk)
  }

  // ---------- rail ----------
  let raf = 0
  const changed = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { paint(true); renderCard() }) }
  function buildRail() {
    rail.innerHTML = ''
    const sel = h('select', { 'aria-label': 'Well', style: { flex: '1 1 auto' } }, ...wells.map(x => h('option', { value: x.id, selected: x.id === w.id }, x.id))) as HTMLSelectElement
    sel.addEventListener('change', () => set({ well: sel.value }))
    const nav = (d: number) => set({ well: wells[(idx + d + wells.length) % wells.length].id })
    const pP = (v: number) => `${fmt(u.p(v))} ${u.pU}`
    rail.append(
      h('span', { class: 'eyebrow' }, 'Well'),
      h('div', { style: { display: 'flex', gap: '6px' } },
        h('button', { class: 'btn', 'aria-label': 'Previous well', onclick: () => nav(-1) }, '◂'), sel,
        h('button', { class: 'btn', 'aria-label': 'Next well', onclick: () => nav(1) }, '▸')),
      h('div', { class: 'small muted' }, `Lift: ${w.lift} · node TVD ${fmt(baseTub.tvd)} m${ds.id === 'volve' ? ' (assumed)' : ''} · defaults from ${ds.id === 'volve' ? 'gauge data' : 'last well test'}, ${fmtMonth(ds.months[today.t])}`),
      h('span', { class: 'eyebrow' }, 'Reservoir'),
      slider(ds.id === 'volve' ? 'Reservoir pressure (assumed)' : 'Reservoir pressure', inp.pres, 80, 420, 1, pP, v => { inp.pres = v; changed() }),
      slider('Productivity index J', inp.pi, 0.2, Math.max(60, inp.pi * 3), 0.1, v => `${fmt(u.pi(v), 2)} ${u.piU}`, v => { inp.pi = v; changed() }),
      slider('Bubble point (assumed)', inp.pb, 20, 380, 1, pP, v => { inp.pb = v; changed() }),
      h('span', { class: 'eyebrow' }, 'Well & fluids'),
      slider('Wellhead pressure', inp.whp, 2, 120, 0.5, pP, v => { inp.whp = v; changed() }),
      slider('Water cut', Math.round(inp.wc * 100), 0, 98, 1, v => `${v} %`, v => { inp.wc = v / 100; changed() }),
      slider('Producing GOR', inp.gor, 20, 800, 1, v => `${fmt(u.gor(v))} ${u.gorU}`, v => { inp.gor = v; changed() }),
      slider('Tubing size', inp.tub, 0, TUBING.length - 1, 1, v => `${odLabel(TUBING[v].od)} (ID ${TUBING[v].id.toFixed(2)}″)`, v => { inp.tub = v; changed() }),
      slider(hasLift ? 'Lift gas injection' : 'Lift gas injection (what-if)', inp.qgl, 0, 120000, 1000, v => `${fmt(u.gas(v))} ${u.gasU}`, v => { inp.qgl = v; changed() }),
      h('button', { class: 'btn ghost', onclick: () => { inp = { ...def.inp }; buildRail(); changed() } }, 'Reset to well data'))
  }
  buildRail()

  // ---------- center ----------
  const nodBox = h('div', { class: 'chart' }), matchBox = h('div', { class: 'chart' })
  center.append(
    panel('Inflow vs outflow', legend([
      { label: 'IPR (inflow)', color: 'var(--oil)' }, { label: 'VLP (tubing)', color: 'var(--ink-2)' },
      { label: 'other tubing sizes', color: 'var(--dim)', dash: true }, { label: 'today (measured)', color: 'var(--water)', hollow: true },
    ]), nodBox,
      h('div', { class: 'small muted' }, 'Simplified no-slip multiphase gradient with Standing PVT — not Beggs–Brill or Hagedorn–Brown. Drag any slider: the curves and the operating point move together.')),
    panel('Model vs measured flowing pressure', legend([
      { label: ds.id === 'volve' ? 'measured (downhole gauge)' : 'measured (well test)', color: 'var(--water)' },
      { label: 'model, calibrated', color: 'var(--ink-2)' }, { label: 'model, uncalibrated', color: 'var(--dim)', dash: true },
    ]), matchBox))

  let fr: Frame | null = null
  let xs = d3.scaleLinear(), ys = d3.scaleLinear()
  const charts = [
    responsive(nodBox, W => (W < 600 ? 300 : 380), { t: 18, r: 20, b: 40, l: 58 }, f => drawNodal(f), 'IPR and VLP curves with operating point'),
    pts.length ? responsive(matchBox, W => (W < 600 ? 220 : 260), { t: 14, r: 16, b: 30, l: 58 }, f => drawMatch(f), 'Modelled vs measured flowing pressure') : null,
  ]
  if (!pts.length) matchBox.append(h('div', { class: 'empty' }, 'This well has no paired wellhead and downhole pressure readings, so the tubing model cannot be checked against measurements.'))

  // ---------- nodal chart ----------
  function drawNodal(f: Frame) {
    fr = f
    const { g, w: W, h: H } = f
    g.selectAll('*').remove()
    const defs = f.svg.selectAll('defs').data([0]).join('defs')
    defs.selectAll('clipPath#nod-clip').data([0]).join('clipPath').attr('id', 'nod-clip').selectAll('rect').data([0]).join('rect').attr('width', W).attr('height', H)
    g.append('g').attr('class', 'gridwrap')
    g.append('g').attr('class', 'xa').attr('transform', `translate(0,${H})`)
    g.append('g').attr('class', 'ya')
    g.append('text').attr('class', 'lbl').attr('x', W / 2).attr('y', H + 34).attr('text-anchor', 'middle').text(`Liquid rate (${u.liqU})`)
    g.append('text').attr('class', 'lbl').attr('transform', `translate(-46,${H / 2}) rotate(-90)`).attr('text-anchor', 'middle').text(`Flowing pressure at node (${u.pU})`)
    const plot = g.append('g').attr('class', 'plot').attr('clip-path', 'url(#nod-clip)')
    plot.append('line').attr('class', 'pb').attr('stroke', 'var(--line)').attr('stroke-dasharray', '2 3')
    plot.append('g').attr('class', 'fam')
    plot.append('path').attr('class', 'ipr').attr('fill', 'none').attr('stroke', 'var(--oil)').attr('stroke-width', 2)
    plot.append('path').attr('class', 'vlp').attr('fill', 'none').attr('stroke', 'var(--ink-2)').attr('stroke-width', 2)
    plot.append('line').attr('class', 'opx').attr('stroke', 'var(--muted)').attr('stroke-dasharray', '3 3')
    plot.append('line').attr('class', 'opy').attr('stroke', 'var(--muted)').attr('stroke-dasharray', '3 3')
    g.append('text').attr('class', 'lbl pbl')
    g.append('g').attr('class', 'famlbl')
    g.append('circle').attr('class', 'today').attr('r', 6).attr('fill', 'var(--panel)').attr('stroke', 'var(--water)').attr('stroke-width', 2)
    g.append('text').attr('class', 'lbl todayl').attr('fill', 'var(--water)').text('today')
    g.append('circle').attr('class', 'op').attr('r', 7).attr('fill', 'var(--ink-strong)').attr('stroke', 'var(--panel)').attr('stroke-width', 2)
    g.append('text').attr('class', 'lbl-mono opl')
    g.append('text').attr('class', 'lbl nof').attr('fill', 'var(--warn)').attr('x', W / 2).attr('y', 16).attr('text-anchor', 'middle')
    const hit = g.append('rect').attr('width', W).attr('height', H).attr('fill', 'transparent')
    hit.on('pointermove', ev => {
      const [mx] = d3.pointer(ev)
      const q = xs.invert(mx) / u.liq(1)
      if (q <= 0) return tip(null)
      const r = inflow()
      tip(tipRows(`${fmt(u.liq(q))} ${u.liqU}`, [['IPR P_wf', `${fmt(u.p(iprPwf(q, r)))} ${u.pU}`], ['VLP P_wf', `${fmt(u.p(bhpFn(inp.tub)(q)))} ${u.pU}`]]), ev)
    }).on('pointerleave', () => tip(null))
    paint(false)
  }

  function paint(animate: boolean) {
    if (!fr) return
    const { g, w: W, h: H } = fr
    const r = inflow()
    const qa = aof(r)
    const curF = bhpFn(inp.tub)
    const op = operatingPoint(r, curF)
    // keep the operating region readable when AOF is far beyond it (very high-PI wells)
    const xmax = Math.min(Math.max(qa, today.q) * 1.08, Math.max(today.q, op?.q ?? 0) * 2.6)
    xs = d3.scaleLinear().domain([0, u.liq(xmax)]).range([0, W]).nice()
    ys = d3.scaleLinear().domain([0, u.p(Math.max(inp.pres, today.pwf) * 1.15)]).range([H, 0]).nice()
    const ms = animate ? dur(450) : 0
    const N = 70
    const qs = d3.range(N).map(i => xmax * (0.004 + 0.996 * i / (N - 1)))
    const line = d3.line<[number, number]>().x(d => xs(u.liq(d[0]))).y(d => ys(u.p(d[1])))
    const short = W < 600
    g.select<SVGGElement>('g.xa').transition().duration(ms).call(d3.axisBottom(xs).ticks(short ? 4 : 7, '~s') as any).call(axisStyle as any)
    g.select<SVGGElement>('g.ya').transition().duration(ms).call(d3.axisLeft(ys).ticks(5, '~s') as any).call(axisStyle as any)
    grid(g.select<SVGGElement>('g.gridwrap') as any, ys, W, 5)

    const iprD = line([[0, r.pres], ...qs.map(q => [q, iprPwf(q, r)] as [number, number])])
    const vlpD = line(qs.map(q => [q, curF(q)]))
    g.select('path.ipr').transition().duration(ms).attr('d', iprD)
    g.select('path.vlp').transition().duration(ms).attr('d', vlpD)
    g.select('line.pb').transition().duration(ms).attr('x1', 0).attr('x2', W).attr('y1', ys(u.p(r.pb))).attr('y2', ys(u.p(r.pb)))
    g.select('text.pbl').transition().duration(ms).attr('x', 4).attr('y', ys(u.p(r.pb)) - 4).text(`P_b ${fmt(u.p(r.pb))}`)

    const fam = TUBING.map((t, i) => ({ i, t })).filter(d => d.i !== inp.tub)
    const famD = fam.map(d => { const fn = bhpFn(d.i); return { ...d, pts: qs.map(q => [q, fn(q)] as [number, number]) } })
    g.select('g.fam').selectAll<SVGPathElement, typeof famD[0]>('path').data(famD, d => String(d.i)).join('path')
      .attr('fill', 'none').attr('stroke', 'var(--dim)').attr('stroke-dasharray', '4 4').attr('stroke-width', 1.2)
      .transition().duration(ms).attr('d', d => line(d.pts))
    // label each faint curve where it leaves the plot (right edge or top)
    const famLbl = famD.map(d => {
      let last = d.pts[0]
      for (const p of d.pts) { if (ys(u.p(p[1])) < 8) break; last = p }
      return { ...d, x: Math.min(W - 4, xs(u.liq(last[0]))), y: Math.max(10, ys(u.p(last[1]))) }
    })
    g.select('g.famlbl').selectAll<SVGTextElement, typeof famLbl[0]>('text').data(famLbl, d => String(d.i)).join('text')
      .attr('class', 'lbl').attr('text-anchor', 'end').attr('fill', 'var(--dim)').style('font-size', '10px')
      .text(d => odLabel(d.t.od)).transition().duration(ms).attr('x', d => d.x).attr('y', d => d.y - 4)

    g.select('circle.today').attr('cx', xs(u.liq(today.q))).attr('cy', ys(u.p(today.pwf)))
    g.select('text.todayl').attr('x', xs(u.liq(today.q)) + 9).attr('y', ys(u.p(today.pwf)) + 14)

    const opC = g.select('circle.op'), opL = g.select('text.opl')
    g.select('text.nof').text(op ? '' : 'No intersection — the well cannot flow at these settings (needs lift or lower WHP)')
    if (op) {
      const cx = xs(u.liq(op.q)), cy = ys(u.p(op.pwf))
      opC.attr('opacity', 1).transition().duration(ms).ease(d3.easeCubicOut).attr('cx', cx).attr('cy', cy)
      g.select('line.opx').attr('opacity', 1).transition().duration(ms).attr('x1', cx).attr('x2', cx).attr('y1', cy).attr('y2', H)
      g.select('line.opy').attr('opacity', 1).transition().duration(ms).attr('x1', 0).attr('x2', cx).attr('y1', cy).attr('y2', cy)
      const right = cx < W - 150
      opL.attr('opacity', 1).attr('text-anchor', right ? 'start' : 'end')
        .text(short ? `${fmt(u.liq(op.q))}` : `${fmt(u.liq(op.q))} ${u.liqU} @ ${fmt(u.p(op.pwf))} ${u.pU}`)
        .transition().duration(ms).attr('x', cx + (right ? 11 : -11)).attr('y', cy - 10)
    } else {
      opC.attr('opacity', 0); opL.attr('opacity', 0); g.selectAll('line.opx, line.opy').attr('opacity', 0)
    }
  }

  // ---------- model vs measured ----------
  function drawMatch({ g, w: W, h: H }: Frame) {
    g.selectAll('*').remove()
    const rows = pts.map(p => ({ ...p, raw: vlp(p.ql, p.whp, p.fluid, baseTub, p.lift, 1), cal: vlp(p.ql, p.whp, p.fluid, baseTub, p.lift, cal.k) }))
    const x = d3.scaleTime().domain(rows.length > 1 ? d3.extent(rows, r => r.date) as [Date, Date] : [d3.timeMonth.offset(rows[0].date, -6), d3.timeMonth.offset(rows[0].date, 6)]).range([0, W])
    const lo = d3.min(rows, r => Math.min(r.pwf, r.raw, r.cal))!, hi = d3.max(rows, r => Math.max(r.pwf, r.raw, r.cal))!
    const y = d3.scaleLinear().domain([u.p(lo) * 0.9, u.p(hi) * 1.05]).range([H, 0]).nice()
    grid(g, y, W, 4)
    g.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(x).ticks(W < 600 ? 4 : 8)).call(axisStyle)
    g.append('g').call(d3.axisLeft(y).ticks(4, '~s')).call(axisStyle)
    g.append('text').attr('class', 'lbl').attr('x', 0).attr('y', -4).text(`P_wf (${u.pU})`)
    const ln = (k: 'pwf' | 'raw' | 'cal') => d3.line<typeof rows[0]>().x(r => x(r.date)).y(r => y(u.p(r[k])))
      .defined((r, i) => ds.id === 'fieldx' || i === 0 || r.t - rows[i - 1].t <= 2)
    const series: ['pwf' | 'raw' | 'cal', string, string | null][] = [['raw', 'var(--dim)', '4 4'], ['cal', 'var(--ink-2)', null], ['pwf', 'var(--water)', null]]
    const isTests = ds.id === 'fieldx'
    series.forEach(([k, c, dash], i) => {
      const p = g.append('path').datum(rows).attr('fill', 'none').attr('stroke', c).attr('stroke-width', isTests ? 1 : 1.8).attr('stroke-dasharray', dash).attr('d', ln(k))
      if (!dash && dur(1)) {
        const len = (p.node() as SVGPathElement).getTotalLength()
        p.attr('stroke-dasharray', `${len} ${len}`).attr('stroke-dashoffset', len).transition().delay(i * 200).duration(1100).attr('stroke-dashoffset', 0).on('end', function () { d3.select(this).attr('stroke-dasharray', null) })
      }
      if (isTests) g.selectAll(`circle.m-${k}`).data(rows).join('circle').attr('class', `m-${k}`).attr('cx', r => x(r.date)).attr('cy', r => y(u.p(r[k]))).attr('r', k === 'pwf' ? 4.5 : 3)
        .attr('fill', k === 'pwf' ? 'var(--panel)' : c).attr('stroke', c).attr('stroke-width', 1.5)
    })
    const bis = d3.bisector<typeof rows[0], Date>(r => r.date).center
    const cross = g.append('line').attr('y1', 0).attr('y2', H).attr('stroke', 'var(--muted)').attr('opacity', 0)
    g.append('rect').attr('width', W).attr('height', H).attr('fill', 'transparent')
      .on('pointermove', ev => {
        const r = rows[bis(rows, x.invert(d3.pointer(ev)[0]))]
        cross.attr('x1', x(r.date)).attr('x2', x(r.date)).attr('opacity', 1)
        tip(tipRows(fmtMonth(r.date), [
          ['Measured', `${fmt(u.p(r.pwf))} ${u.pU}`], ['Model, calibrated', `${fmt(u.p(r.cal))} ${u.pU}`], ['Model, raw', `${fmt(u.p(r.raw))} ${u.pU}`],
          ['Liquid', `${fmt(u.liq(r.ql))} ${u.liqU}`], ['WHP', `${fmt(u.p(r.whp))} ${u.pU}`], ['WC', pct(r.fluid.wc)]]), ev)
      }).on('pointerleave', () => { cross.attr('opacity', 0); tip(null) })
  }

  // ---------- card ----------
  function renderCard() {
    const r = inflow()
    const op = operatingPoint(r, bhpFn(inp.tub))
    const qa = aof(r)
    const oil = op ? op.q * (1 - inp.wc) : 0
    const gain = oil - today.oil
    const warns: string[] = []
    if (!op) warns.push('No natural-flow solution: the tubing needs more pressure than the reservoir can give. Lower WHP, add lift gas or reduce water cut.')
    else {
      if (!op.stable) warns.push('Operating point sits on the falling part of the VLP — expect heading / unstable flow.')
      if (op.pwf < r.pb) warns.push('Flowing pressure is below the bubble point: free gas at the sandface (Vogel region).')
      if (op.q / qa > 0.85) warns.push('Above 85 % of AOF — little left to gain from lowering P_wf.')
    }
    const kpi = (l: string, v: string, s?: string) => h('div', { class: 'kpi' }, h('div', { class: 'l' }, l), h('div', { class: 'v' }, v), s ? h('div', { class: 's' }, s) : null)
    card.innerHTML = ''
    card.append(
      h('span', { class: 'eyebrow' }, `Operating point · ${w.id}`),
      h('div', { class: 'kpis' },
        kpi(`Liquid (${u.liqU})`, op ? fmt(u.liq(op.q)) : '—'),
        kpi(`Oil (${u.liqU})`, op ? fmt(u.liq(oil)) : '—'),
        kpi(`P_wf (${u.pU})`, op ? fmt(u.p(op.pwf)) : '—'),
        kpi(`Drawdown (${u.pU})`, op ? fmt(u.p(r.pres - op.pwf)) : '—'),
        kpi('Share of AOF', op ? pct(op.q / qa) : '—', `AOF ${fmt(u.liq(qa))} ${u.liqU}`),
        kpi(`Oil vs today (${u.liqU})`, op ? `${gain >= 0 ? '+' : '−'}${fmt(u.liq(Math.abs(gain)))}` : '—', `today ${fmt(u.liq(today.oil))} · ${fmtMonth(ds.months[today.t])}`)),
      ...warns.map(t => h('div', { class: 'small', style: { color: 'var(--warn)', lineHeight: 1.5 } }, '▲ ', t)),
      h('span', { class: 'eyebrow' }, 'Tubing model match'),
      pts.length ? h('div', { class: 'kpis' },
        kpi('Error, uncalibrated', pct(cal.rawErr, 1), 'mean |model − measured|'),
        kpi('Error, calibrated', pct(cal.calErr, 1), `gravity factor k = ${cal.k.toFixed(2)}`)) : h('div', { class: 'small muted' }, 'No measured pressures to match.'),
      pts.length ? h('label', { class: 'small', style: { display: 'flex', gap: '8px', alignItems: 'center', minHeight: '34px' } },
        (() => { const c = h('input', { type: 'checkbox', checked: useCal }) as HTMLInputElement; c.addEventListener('change', () => { useCal = c.checked; changed() }); return c })(),
        'Use calibrated VLP in the chart') : '',
      h('div', { class: 'small muted', style: { lineHeight: 1.5 } },
        `Fitted on ${pts.length} ${ds.id === 'volve' ? 'monthly gauge readings' : 'well tests'}. ` + (cal.k >= 1
          ? `k = ${cal.k.toFixed(2)} > 1: the real column is heavier than a no-slip model predicts — liquid holdup the simple model misses.`
          : `k = ${cal.k.toFixed(2)} < 1: measured pressure is lower than modelled — ${ds.id === 'volve' ? 'the gauge likely sits shallower than the assumed node, or the assumed depth, tubing or fluid properties are off' : 'the generated test pressures imply a lighter column (more gas or a lower density) than the assumed fluid'}.`)),
      ds.id === 'volve' ? h('div', { class: 'small muted', style: { lineHeight: 1.5 } }, 'Volve: tubing size, depths, temperatures and reservoir pressure are assumptions; gauge pressure is treated as the node pressure.') :
        h('div', { class: 'small muted', style: { lineHeight: 1.5 } }, 'Field X is synthetic: its test pressures were generated, not measured.'))
  }
  renderCard()

  return () => { cancelAnimationFrame(raf); charts.forEach(c => c?.destroy()); tip(null) }
}

const odLabel = (od: number) => ({ 2.875: '2⅞″', 3.5: '3½″', 4.5: '4½″', 5.5: '5½″', 7: '7″' } as Record<number, string>)[od] ?? `${od}″`
