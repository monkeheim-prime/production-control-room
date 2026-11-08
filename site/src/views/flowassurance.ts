// Toolkit T5 — flow assurance: flowing temperature up the tubing and along the flowline against wax and hydrates.
import * as d3 from 'd3'
import type { Ctx } from '../main'
import { fmt } from '../core/units'
import { depression, FA, hydrateT, onsetVsRate, run, type FAInput, type FAResult, type Inhibitor, type PathPoint } from '../analysis/flowassurance'
import { axisStyle, drawIn, dur, grid, h, legend, panel, responsive, slider, tip, tipRows, type Frame } from '../ui/kit'

export const METHODS = `
<h2>Wax &amp; hydrates</h2>
<p>A screening model of where a producing well and its seabed flowline go cold enough to deposit wax or form hydrates. All inputs are generic and adjustable; nothing here comes from a real well.</p>
<h3>Flowing temperature in the tubing (Ramey, 1962)</h3>
<div class="eq">T_f(x) = T_e(x) + g·A·(1 − e^(−x/A))          x = height above the reservoir
T_e(x) = T_res − g·x,   g = (T_res − T_sea) / depth
A      = (ṁ·c_p / 2π) · (k_e + r·U·f(t)) / (r·U·k_e)</div>
<p>ṁ·c_p is the mass-weighted heat capacity rate of oil, water and gas (c_p 2100 / 4180 / 2300 J/kg/K). Tubing 3½″ (ID 2.992″), U = 30 W/m²/K tubing-to-formation, k_e = 2 W/m/K, f(t) = 3 (months of production). Vertical well; Joule–Thomson cooling of gas and latent heat are ignored, so the model is optimistic (slightly warm) for gassy wells.</p>
<h3>Flowline cooling</h3>
<div class="eq">T(y) = T_sea + (T_wh − T_sea) · exp(−π·D·U_fl·y / (ṁ·c_p))</div>
<p>8″ flowline (ID 0.2032 m) on the seabed. U_fl ≈ 15–25 W/m²/K for a bare buried or exposed line, 2–5 W/m²/K for wet insulation, below 1 for pipe-in-pipe. Pressure along the flowline is horizontal friction only (Swamee–Jain friction factor, no-slip mixture), floored at 1.5 bar. Pressure in the tubing uses the no-slip gradient from the nodal module, from the wellhead down.</p>
<h3>Wax</h3>
<p>Wax deposits where the fluid (strictly, the pipe wall) is below the <em>wax appearance temperature</em> (WAT). The model uses bulk fluid temperature, so it under-states deposition near the wall. Below the <em>pour point</em> a dead oil gels and a restart needs extra pressure. Waxy crudes with 20–37 % wax are common in late-life Southeast Asian fields, with WAT often 35–50 °C.</p>
<h3>Hydrates (Hammerschmidt, 1934)</h3>
<div class="eq">T_hyd [°F] = 8.9 · P[psia]^0.285                    natural gas, sg ≈ 0.6–0.7, approximate
ΔT [°F]    = K · W / (M · (100 − W))                 W = wt % inhibitor in the water phase
             methanol M = 32.04, K = 2335 · MEG M = 62.07, K = 2700
W_needed   = 100 · ΔT·M / (K + ΔT·M)                 sized for the worst subcooling + 3 °C margin</div>
<p>Worst subcooling is the larger of the flowing case and the shut-in case (contents settle to sea temperature at about wellhead pressure). Hammerschmidt is a hand-calculation correlation; use a proper hydrate prediction tool for design. Hydrates need free water, which is assumed present.</p>
<h3>Shut-in cooldown</h3>
<div class="eq">T(t) = T_sea + (T_0 − T_sea) · e^(−t/τ),   τ = ρc_p · D / (4·U_fl)</div>
<p>Lumped flowline contents (50/50 oil–water by volume), steel and coating heat capacity ignored, so real cooldown is slower. T_0 is the mean flowing temperature of the line. The time to reach the hydrate temperature is the "no-touch time" before the line must be depressurised or inhibited.</p>
<h3>References</h3>
<ul>
<li>Ramey, H.J. (1962). Wellbore heat transmission. Journal of Petroleum Technology 14(4), SPE 96.</li>
<li>Hammerschmidt, E.G. (1934). Formation of gas hydrates in natural gas transmission lines. Industrial &amp; Engineering Chemistry 26(8).</li>
<li>Swamee, P.K., Jain, A.K. (1976). Explicit equations for pipe-flow problems. J. Hydraulics Division, ASCE.</li>
<li>Sloan, E.D., Koh, C.A. (2008). Clathrate Hydrates of Natural Gases, 3rd ed. — background on inhibitor design.</li>
</ul>`

const DEFAULT: FAInput = { ql: 1200, wc: 0.4, gor: 90, tres: 80, depth: 1600, tsea: 22, whp: 30, flowline: 5, uFl: 15, wat: 44, pour: 27, inh: 'none', inhWt: 0 }
const PRESETS: { label: string; v: Partial<FAInput> }[] = [
  { label: 'Healthy well', v: { ...DEFAULT, ql: 2500, wc: 0.2, uFl: 3 } },
  { label: 'Late-life low rate', v: { ...DEFAULT, ql: 200, wc: 0.3 } },
  { label: 'Deepwater tie-back', v: { ...DEFAULT, ql: 800, tsea: 4, whp: 80, flowline: 15, depth: 2400, tres: 90 } },
]
const C = { fluid: 'var(--ink-strong)', amb: 'var(--dim)', wat: 'var(--cat-stim)', hyd: 'var(--water)', pour: 'var(--cat-mech)' }

export function mountFlowAssurance(el: HTMLElement, { u }: Ctx) {
  const inp: FAInput = { ...DEFAULT }
  const field = u.sys === 'field'
  const tv = (c: number) => (field ? c * 1.8 + 32 : c)
  const dtv = (c: number) => (field ? c * 1.8 : c)
  const tU = field ? '°F' : '°C'
  const tS = (c: number, d = 0) => `${fmt(tv(c), d)} ${tU}`
  const pS = (bar: number) => `${fmt(u.p(bar))} ${u.pU}`
  const zv = (m: number) => (field ? m * 3.28084 : m)
  const zU = field ? 'ft' : 'm'
  const sv = (m: number) => (field ? m * 3.28084 / 1000 : m / 1000)   // path distance: km or kft
  const sU = field ? 'kft' : 'km'

  const rail = h('aside', { class: 'rail', 'aria-label': 'Inputs' })
  const center = h('div', { class: 'center' })
  const card = h('aside', { class: 'rail right', 'aria-label': 'Results' })
  el.append(h('div', { class: 'cols chart-first' }, rail, center, card))

  let r: FAResult = run(inp)
  let raf = 0
  const changed = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { r = run(inp); charts.forEach(c => c.redraw()); renderCard() }) }

  // ---------- rail ----------
  function renderRail() {
    rail.innerHTML = ''
    const set = (k: keyof FAInput) => (v: number) => { (inp as any)[k] = v; changed() }
    const inhSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Inhibitor' },
      ...([['none', 'None'], ['methanol', 'Methanol'], ['meg', 'MEG']] as [Inhibitor, string][]).map(([v, l]) =>
        h('button', { 'aria-pressed': String(inp.inh === v), onclick: () => { inp.inh = v; renderRail(); changed() } }, l)))
    rail.append(
      h('span', { class: 'eyebrow' }, 'Presets'),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
        ...PRESETS.map(p => h('button', { class: 'btn', onclick: () => { Object.assign(inp, p.v); renderRail(); changed() } }, p.label)),
        h('button', { class: 'btn ghost', onclick: () => { Object.assign(inp, DEFAULT); renderRail(); changed() } }, 'Reset')),
      h('span', { class: 'eyebrow' }, 'Well & fluid'),
      slider('Liquid rate', inp.ql, 50, 4000, 25, v => `${fmt(u.liq(v))} ${u.liqU}`, set('ql')),
      slider('Water cut', inp.wc * 100, 0, 95, 1, v => `${v} %`, v => { inp.wc = v / 100; changed() }),
      slider('Producing GOR', inp.gor, 20, 400, 5, v => `${fmt(u.gor(v))} ${u.gorU}`, set('gor')),
      slider('Reservoir temperature', inp.tres, 50, 130, 1, v => tS(v), set('tres')),
      slider('Reservoir depth (TVD below mudline)', inp.depth, 800, 3500, 50, v => `${fmt(zv(v))} ${zU}`, set('depth')),
      slider('Wellhead pressure', inp.whp, 10, 120, 1, v => pS(v), set('whp')),
      h('span', { class: 'eyebrow' }, 'Surroundings'),
      slider('Seabed temperature', inp.tsea, 2, 30, 0.5, v => tS(v, 1), set('tsea')),
      slider('Flowline length (0 = dry tree)', inp.flowline, 0, 25, 0.5, v => field ? `${fmt(v * 3.28084, 1)} kft` : `${v} km`, set('flowline')),
      slider('Flowline U-value', inp.uFl, 0.5, 25, 0.5, v => `${v} W/m²K ${v <= 5 ? '· insulated' : v >= 15 ? '· bare' : ''}`, set('uFl')),
      h('span', { class: 'eyebrow' }, 'Wax'),
      slider('Wax appearance temp. (WAT)', inp.wat, 25, 55, 0.5, v => tS(v, 1), set('wat')),
      slider('Pour point', inp.pour, 5, 40, 0.5, v => tS(v, 1), set('pour')),
      h('span', { class: 'eyebrow' }, 'Hydrate inhibitor'),
      inhSeg,
      ...(inp.inh === 'none' ? [] : [slider(`${inp.inh === 'meg' ? 'MEG' : 'Methanol'} in water phase`, inp.inhWt, 0, 60, 1, v => `${v} wt %`, set('inhWt'))]),
      h('div', { class: 'small muted' }, `Fixed: ${FA.api} °API oil, gas sg ${FA.gasSg}, 3½″ tubing, 8″ flowline, vertical well. Geothermal gradient follows from reservoir and seabed temperature and depth.`))
  }
  renderRail()

  // ---------- charts ----------
  const pathBox = h('div', { class: 'chart' }), ptBox = h('div', { class: 'chart' }), rateBox = h('div', { class: 'chart' }), coolBox = h('div', { class: 'chart' })
  center.append(
    panel('Temperature along the flow path — reservoir → wellhead → host', legend([
      { label: 'fluid', color: C.fluid }, { label: 'formation / sea', color: C.amb, dash: true }, { label: 'WAT', color: C.wat },
      { label: 'hydrate T at local pressure', color: C.hyd }, { label: 'with inhibitor', color: C.hyd, dash: true }]), pathBox),
    h('div', { class: 'row' },
      h('div', { style: { flex: '1 1 340px', display: 'flex' } }, panel('Pressure–temperature path vs hydrate curve', 'shaded = hydrate-stable (approx.)', ptBox)),
      h('div', { style: { flex: '1 1 340px', display: 'flex' } }, panel('Wax onset vs rate', 'why late-life rates bring wax problems', rateBox))),
    panel('Flowline cooldown after a shut-in', 'time before hydrates or gelling — the "no-touch time"', coolBox))

  const T = () => dur(300)
  const ax = (g: d3.Selection<SVGGElement, unknown, null, undefined>, cls: string, transform: string | null) =>
    g.selectAll<SVGGElement, number>(`g.${cls}`).data([0]).join('g').attr('class', cls).attr('transform', transform)
  const one = <E extends d3.BaseType>(g: d3.Selection<SVGGElement, unknown, null, undefined>, tag: string, cls: string) =>
    g.selectAll<E, number>(`${tag}.${cls}`).data([0]).join(tag).attr('class', cls) as unknown as d3.Selection<E, number, SVGGElement, unknown>

  const charts = [
    responsive(pathBox, w => (w < 600 ? 280 : 340), { t: 22, r: 18, b: 40, l: 52 }, (f, first) => drawPath(f, first), 'Temperature along the flow path'),
    responsive(ptBox, 300, { t: 14, r: 16, b: 40, l: 56 }, f => drawPT(f), 'Pressure–temperature path'),
    responsive(rateBox, 300, { t: 14, r: 16, b: 40, l: 52 }, f => drawRate(f), 'Wax onset distance against liquid rate'),
    responsive(coolBox, 220, { t: 14, r: 18, b: 38, l: 52 }, f => drawCool(f), 'Flowline cooldown'),
  ]

  function drawPath({ g, w: W, h: H }: Frame, first: boolean) {
    const p = r.path
    const sMax = p[p.length - 1].s
    const tMin = Math.min(inp.tsea, ...p.map(q => q.thInh), inp.wat) - 4
    const tMax = Math.max(inp.tres, inp.wat) + 4
    const x = d3.scaleLinear().domain([0, sv(sMax)]).range([0, W])
    const y = d3.scaleLinear().domain([tv(tMin), tv(tMax)]).range([H, 0]).nice()
    const X = (q: PathPoint) => x(sv(q.s)), Y = (c: number) => y(tv(c))
    grid(g, y, W, 5)
    ax(g, 'ax-x', `translate(0,${H})`).transition().duration(T()).call(d3.axisBottom(x).ticks(W < 600 ? 5 : 8) as any).call(axisStyle as any)
    ax(g, 'ax-y', null).transition().duration(T()).call(d3.axisLeft(y).ticks(5) as any).call(axisStyle as any)
    one<SVGTextElement>(g, 'text', 'xl').attr('class', 'lbl xl').attr('x', W / 2).attr('y', H + 34).attr('text-anchor', 'middle').text(`distance from reservoir along the flow path (${sU})`)
    one<SVGTextElement>(g, 'text', 'yl').attr('class', 'lbl yl').attr('x', 0).attr('y', -8).text(`temperature (${tU})`)

    // zones
    const waxArea = d3.area<PathPoint>().defined(q => q.t < inp.wat).x(X).y0(() => Y(inp.wat)).y1(q => Y(q.t))
    const hydArea = d3.area<PathPoint>().defined(q => q.t < q.thInh).x(X).y0(q => Y(q.thInh)).y1(q => Y(q.t))
    one<SVGPathElement>(g, 'path', 'z-wax').attr('fill', C.wat).attr('fill-opacity', 0.2).transition().duration(T()).attr('d', waxArea(p))
    one<SVGPathElement>(g, 'path', 'z-hyd').attr('fill', C.hyd).attr('fill-opacity', 0.28).transition().duration(T()).attr('d', hydArea(p))

    // wellhead divider
    const xw = x(sv(inp.depth))
    one<SVGLineElement>(g, 'line', 'wh').attr('y1', 0).attr('y2', H).attr('stroke', 'var(--line)').attr('stroke-dasharray', '3 3').transition().duration(T()).attr('x1', xw).attr('x2', xw)
    one<SVGTextElement>(g, 'text', 'wh-l').attr('class', 'lbl wh-l').attr('y', 12).attr('text-anchor', inp.flowline > 0 ? 'middle' : 'end').transition().duration(T()).attr('x', inp.flowline > 0 ? xw : xw - 4).text('wellhead')
    one<SVGTextElement>(g, 'text', 'seg-t').attr('class', 'lbl seg-t').attr('y', H - 6).attr('x', 4).text('tubing')
    one<SVGTextElement>(g, 'text', 'seg-f').attr('class', 'lbl seg-f').attr('y', H - 6).attr('x', xw + 4).attr('opacity', inp.flowline > 0 && W - xw > 60 ? 1 : 0).text('flowline')

    const line = (f: (q: PathPoint) => number) => d3.line<PathPoint>().x(X).y(q => Y(f(q)))
    one<SVGPathElement>(g, 'path', 'amb').attr('fill', 'none').attr('stroke', C.amb).attr('stroke-width', 1.5).attr('stroke-dasharray', '4 3').transition().duration(T()).attr('d', line(q => q.amb)(p))
    one<SVGPathElement>(g, 'path', 'hyd').attr('fill', 'none').attr('stroke', C.hyd).attr('stroke-width', 1.5).transition().duration(T()).attr('d', line(q => q.th)(p))
    one<SVGPathElement>(g, 'path', 'hydi').attr('fill', 'none').attr('stroke', C.hyd).attr('stroke-width', 1.5).attr('stroke-dasharray', '5 3').attr('opacity', inp.inh !== 'none' && inp.inhWt > 0 ? 1 : 0).transition().duration(T()).attr('d', line(q => q.thInh)(p))
    one<SVGLineElement>(g, 'line', 'watl').attr('x1', 0).attr('x2', W).attr('stroke', C.wat).attr('stroke-width', 1.5).transition().duration(T()).attr('y1', Y(inp.wat)).attr('y2', Y(inp.wat))
    one<SVGTextElement>(g, 'text', 'watt').attr('class', 'lbl watt').attr('x', 4).attr('fill', C.wat).transition().duration(T()).attr('y', Y(inp.wat) - 5).text(`WAT ${tS(inp.wat)}`)
    const fl = one<SVGPathElement>(g, 'path', 'fl').attr('fill', 'none').attr('stroke', C.fluid).attr('stroke-width', 2.5)
    if (first) { fl.attr('d', line(q => q.t)(p)); drawIn(fl, 1200) } else fl.transition().duration(T()).attr('d', line(q => q.t)(p))

    // wax onset marker
    const on = r.waxOnset
    one<SVGCircleElement>(g, 'circle', 'on').attr('r', 5).attr('fill', 'var(--panel)').attr('stroke', C.wat).attr('stroke-width', 2).attr('opacity', on ? 1 : 0)
      .transition().duration(T()).attr('cx', on ? X(on) : 0).attr('cy', on ? Y(on.t) : 0)
    const onRight = on ? X(on) > W - 120 : false
    one<SVGTextElement>(g, 'text', 'on-l').attr('class', 'lbl-mono on-l').attr('fill', C.wat).attr('opacity', on ? 1 : 0).attr('text-anchor', onRight ? 'end' : 'start')
      .transition().duration(T()).attr('x', on ? X(on) + (onRight ? -8 : 8) : 0).attr('y', on ? Y(on.t) + 16 : 0).text('wax onset')

    // crosshair
    const cross = one<SVGLineElement>(g, 'line', 'cross').attr('y1', 0).attr('y2', H).attr('stroke', 'var(--muted)').attr('opacity', 0).style('pointer-events', 'none')
    one<SVGRectElement>(g, 'rect', 'hit').attr('width', W).attr('height', H).attr('fill', 'transparent')
      .on('pointermove', ev => {
        const [mx] = d3.pointer(ev)
        const q = r.path[d3.minIndex(r.path, q => Math.abs(X(q) - mx))]
        cross.attr('x1', X(q)).attr('x2', X(q)).attr('opacity', 0.6)
        tip(tipRows(q.seg === 'well' ? `Tubing · ${fmt(zv(q.z ?? 0))} ${zU} TVD` : `Flowline · ${fmt(sv(q.s - inp.depth), 1)} ${sU} from wellhead`, [
          ['Fluid', tS(q.t, 1)], [q.seg === 'well' ? 'Formation' : 'Sea', tS(q.amb, 1)], ['Pressure', pS(q.p)],
          ['vs WAT', `${q.t >= inp.wat ? '+' : '−'}${fmt(Math.abs(dtv(q.t - inp.wat)), 1)} ${tU}`],
          ['Hydrate T', tS(q.thInh, 1)]]), ev)
      })
      .on('pointerleave', () => { cross.attr('opacity', 0); tip(null) })
  }

  function drawPT({ g, w: W, h: H }: Frame) {
    const p = r.path
    const pMax = Math.max(...p.map(q => q.p)) * 1.08
    const dT = depression(inp.inh, inp.inhWt)
    const tMin = Math.min(inp.tsea, hydrateT(2) - dT, inp.pour) - 4
    const x = d3.scaleLinear().domain([tv(tMin), tv(Math.max(inp.tres, inp.wat) + 4)]).range([0, W]).nice()
    const y = d3.scaleLinear().domain([0, u.p(pMax)]).range([H, 0]).nice()
    const curve = d3.range(1, 61).map(i => { const pb = (pMax * i) / 60; return { p: pb, t: hydrateT(pb) } })
    grid(g, y, W, 5)
    ax(g, 'ax-x', `translate(0,${H})`).transition().duration(T()).call(d3.axisBottom(x).ticks(W < 600 ? 5 : 7) as any).call(axisStyle as any)
    ax(g, 'ax-y', null).transition().duration(T()).call(d3.axisLeft(y).ticks(5, '~s') as any).call(axisStyle as any)
    one<SVGTextElement>(g, 'text', 'xl').attr('class', 'lbl xl').attr('x', W / 2).attr('y', H + 34).attr('text-anchor', 'middle').text(`temperature (${tU})`)
    one<SVGTextElement>(g, 'text', 'yl').attr('class', 'lbl yl').attr('x', 4).attr('y', 4).text(`pressure (${u.pU})`)
    const X = (c: number) => x(tv(c)), Y = (b: number) => y(u.p(b))
    const zone = d3.area<{ p: number; t: number }>().x0(0).x1(d => Math.max(0, X(d.t - dT))).y(d => Y(d.p))
    one<SVGPathElement>(g, 'path', 'hz').attr('fill', C.hyd).attr('fill-opacity', 0.12).transition().duration(T()).attr('d', zone(curve))
    const ln = d3.line<{ p: number; t: number }>().y(d => Y(d.p))
    one<SVGPathElement>(g, 'path', 'h0').attr('fill', 'none').attr('stroke', C.hyd).attr('stroke-width', 1.5).transition().duration(T()).attr('d', ln.x(d => X(d.t))(curve))
    one<SVGPathElement>(g, 'path', 'h1').attr('fill', 'none').attr('stroke', C.hyd).attr('stroke-width', 1.5).attr('stroke-dasharray', '5 3').attr('opacity', dT > 0 ? 1 : 0).transition().duration(T()).attr('d', ln.x(d => X(d.t - dT))(curve))
    const vline = (cls: string, c: number, color: string, dash: string | null, label: string, dy: number) => {
      one<SVGLineElement>(g, 'line', cls).attr('y1', 0).attr('y2', H).attr('stroke', color).attr('stroke-width', 1.5).attr('stroke-dasharray', dash).transition().duration(T()).attr('x1', X(c)).attr('x2', X(c))
      one<SVGTextElement>(g, 'text', cls + '-l').attr('class', `lbl ${cls}-l`).attr('fill', color).attr('y', dy).transition().duration(T()).attr('x', X(c) + 4).text(label)
    }
    vline('wat', inp.wat, C.wat, null, 'WAT', 16)
    vline('pour', inp.pour, C.pour, '4 3', 'pour pt', 30)
    const pl = d3.line<PathPoint>().x(q => X(q.t)).y(q => Y(q.p))
    one<SVGPathElement>(g, 'path', 'pp').attr('fill', 'none').attr('stroke', C.fluid).attr('stroke-width', 2.5).transition().duration(T()).attr('d', pl(p))
    const wh = p.find(q => q.seg === 'well' && q.z === 0)!
    const pts = [{ k: 'reservoir', q: p[0] }, { k: 'wellhead', q: wh }, ...(inp.flowline > 0 ? [{ k: 'arrival', q: p[p.length - 1] }] : [])]
    g.selectAll<SVGCircleElement, typeof pts[0]>('circle.pt').data(pts, d => d.k).join('circle').attr('class', 'pt').attr('r', 4).attr('fill', 'var(--panel)').attr('stroke', C.fluid).attr('stroke-width', 2)
      .transition().duration(T()).attr('cx', d => X(d.q.t)).attr('cy', d => Y(d.q.p))
    g.selectAll<SVGTextElement, typeof pts[0]>('text.ptl').data(pts, d => d.k).join('text').attr('class', 'lbl ptl').attr('text-anchor', 'end')
      .transition().duration(T()).attr('x', d => X(d.q.t) - 7).attr('y', d => Y(d.q.p) - 7).text(d => (W < 420 && d.k === 'wellhead' ? 'WH' : d.k))
  }

  function drawRate({ g, w: W, h: H }: Frame) {
    const rates = d3.range(0, 41).map(i => Math.round(50 * Math.pow(80, i / 40)))
    const data = onsetVsRate(inp, rates)
    const sMax = inp.depth + inp.flowline * 1000
    const x = d3.scaleLog().domain([u.liq(50), u.liq(4000)]).range([0, W])
    const y = d3.scaleLinear().domain([0, sv(sMax) * 1.06]).range([H, 0])
    ax(g, 'ax-x', `translate(0,${H})`).transition().duration(T()).call(d3.axisBottom(x).ticks(W < 420 ? 3 : 5, '~s') as any).call(axisStyle as any)
    ax(g, 'ax-y', null).transition().duration(T()).call(d3.axisLeft(y).ticks(5) as any).call(axisStyle as any)
    one<SVGTextElement>(g, 'text', 'xl').attr('class', 'lbl xl').attr('x', W / 2).attr('y', H + 34).attr('text-anchor', 'middle').text(`liquid rate (${u.liqU}, log)`)
    one<SVGTextElement>(g, 'text', 'yl').attr('class', 'lbl yl').attr('x', 4).attr('y', 4).text(`wax onset, ${sU} from reservoir`)
    const hl = (cls: string, s: number, label: string, show: boolean) => {
      one<SVGLineElement>(g, 'line', cls).attr('x1', 0).attr('x2', W).attr('stroke', 'var(--line)').attr('stroke-dasharray', '3 3').attr('opacity', show ? 1 : 0).transition().duration(T()).attr('y1', y(sv(s))).attr('y2', y(sv(s)))
      one<SVGTextElement>(g, 'text', cls + '-l').attr('class', `lbl ${cls}-l`).attr('text-anchor', 'end').attr('x', W).attr('opacity', show ? 1 : 0).transition().duration(T()).attr('y', y(sv(s)) - 4).text(label)
    }
    hl('whl', inp.depth, 'wellhead', true)
    hl('arl', sMax, 'arrival — above this line: no wax', inp.flowline > 0)
    const ln = d3.line<typeof data[0]>().defined(d => d.s != null).x(d => x(u.liq(d.ql))).y(d => y(sv(d.s!)))
    one<SVGPathElement>(g, 'path', 'rl').attr('fill', 'none').attr('stroke', C.wat).attr('stroke-width', 2).transition().duration(T()).attr('d', ln(data))
    const cur = r.waxOnset
    one<SVGLineElement>(g, 'line', 'cx').attr('y1', 0).attr('y2', H).attr('stroke', 'var(--muted)').attr('stroke-dasharray', '2 3').transition().duration(T()).attr('x1', x(u.liq(inp.ql))).attr('x2', x(u.liq(inp.ql)))
    one<SVGCircleElement>(g, 'circle', 'cp').attr('r', 5).attr('fill', 'var(--panel)').attr('stroke', C.wat).attr('stroke-width', 2).attr('opacity', cur ? 1 : 0)
      .transition().duration(T()).attr('cx', x(u.liq(inp.ql))).attr('cy', cur ? y(sv(cur.s)) : 0)
    one<SVGTextElement>(g, 'text', 'cl').attr('class', 'lbl cl').attr('text-anchor', x(u.liq(inp.ql)) > W - 60 ? 'end' : 'start')
      .transition().duration(T()).attr('x', x(u.liq(inp.ql)) + (x(u.liq(inp.ql)) > W - 60 ? -6 : 6)).attr('y', H - 6).text(cur ? 'today' : 'today · no wax')
    one<SVGRectElement>(g, 'rect', 'hit').attr('width', W).attr('height', H).attr('fill', 'transparent')
      .on('pointermove', ev => {
        const [mx] = d3.pointer(ev)
        const d = data[d3.minIndex(data, d => Math.abs(x(u.liq(d.ql)) - mx))]
        tip(tipRows(`${fmt(u.liq(d.ql))} ${u.liqU}`, [
          ['Wax onset', d.s == null ? 'none' : d.s <= inp.depth ? `tubing, ${fmt(zv(inp.depth - d.s))} ${zU} below wellhead` : `flowline, ${fmt(sv(d.s - inp.depth), 1)} ${sU}`],
          ['Wellhead T', tS(d.twh, 1)], ['Arrival T', tS(d.tarr, 1)]]), ev)
      })
      .on('pointerleave', () => tip(null))
  }

  function drawCool({ g, w: W, h: H }: Frame) {
    const c = r.cooldown
    const dT = depression(inp.inh, inp.inhWt)
    const th = hydrateT(c.p) - dT
    const tEnd = Math.max(12, Math.min(96, c.tau * 4))
    const pts = d3.range(0, 81).map(i => { const t = (tEnd * i) / 80; return { t, T: inp.tsea + (c.t0 - inp.tsea) * Math.exp(-t / c.tau) } })
    const x = d3.scaleLinear().domain([0, tEnd]).range([0, W])
    const y = d3.scaleLinear().domain([tv(Math.min(inp.tsea, th) - 3), tv(Math.max(c.t0, inp.wat) + 3)]).range([H, 0]).nice()
    grid(g, y, W, 4)
    ax(g, 'ax-x', `translate(0,${H})`).transition().duration(T()).call(d3.axisBottom(x).ticks(W < 600 ? 5 : 10) as any).call(axisStyle as any)
    ax(g, 'ax-y', null).transition().duration(T()).call(d3.axisLeft(y).ticks(4) as any).call(axisStyle as any)
    one<SVGTextElement>(g, 'text', 'xl').attr('class', 'lbl xl').attr('x', W / 2).attr('y', H + 32).attr('text-anchor', 'middle').text('hours after shut-in')
    const inactive = inp.flowline <= 0
    one<SVGTextElement>(g, 'text', 'na').attr('class', 'lbl na').attr('x', W / 2).attr('y', H / 2).attr('text-anchor', 'middle').attr('opacity', inactive ? 1 : 0).text('No flowline (dry tree) — set a flowline length to see cooldown')
    const hl = (cls: string, v: number, color: string, label: string, dash: string | null) => {
      one<SVGLineElement>(g, 'line', cls).attr('x1', 0).attr('x2', W).attr('stroke', color).attr('stroke-width', 1.5).attr('stroke-dasharray', dash).attr('opacity', inactive ? 0 : 1).transition().duration(T()).attr('y1', y(tv(v))).attr('y2', y(tv(v)))
      one<SVGTextElement>(g, 'text', cls + '-l').attr('class', `lbl ${cls}-l`).attr('fill', color).attr('text-anchor', 'end').attr('x', W).attr('opacity', inactive ? 0 : 1).transition().duration(T()).attr('y', y(tv(v)) - 4).text(label)
    }
    hl('cw', inp.wat, C.wat, 'WAT', null)
    hl('ch', th, C.hyd, `hydrate T at ${pS(c.p)}`, '5 3')
    hl('cs', inp.tsea, C.amb, 'sea', '4 3')
    one<SVGPathElement>(g, 'path', 'cl').attr('fill', 'none').attr('stroke', C.fluid).attr('stroke-width', 2).attr('opacity', inactive ? 0 : 1)
      .transition().duration(T()).attr('d', d3.line<typeof pts[0]>().x(d => x(d.t)).y(d => y(tv(d.T)))(pts))
    const marks = [{ k: 'wat', t: c.toWat, v: inp.wat, color: C.wat }, { k: 'hyd', t: c.toHyd, v: th, color: C.hyd }].filter(m => !inactive && m.t != null && m.t > 0 && m.t <= tEnd)
    g.selectAll<SVGCircleElement, typeof marks[0]>('circle.m').data(marks, d => d.k).join('circle').attr('class', 'm').attr('r', 4.5).attr('fill', 'var(--panel)').attr('stroke', d => d.color).attr('stroke-width', 2)
      .transition().duration(T()).attr('cx', d => x(d.t!)).attr('cy', d => y(tv(d.v)))
    g.selectAll<SVGTextElement, typeof marks[0]>('text.ml').data(marks, d => d.k).join('text').attr('class', 'lbl-mono ml').attr('fill', d => d.color)
      .transition().duration(T()).attr('x', d => x(d.t!) + 7).attr('y', d => y(tv(d.v)) + 15).text(d => `${fmt(d.t!, 1)} h`)
  }

  // ---------- card ----------
  function renderCard() {
    card.innerHTML = ''
    const kpi = (l: string, v: string, s?: string) => h('div', { class: 'kpi' }, h('div', { class: 'l' }, l), h('div', { class: 'v' }, v), s ? h('div', { class: 's' }, s) : null)
    const on = r.waxOnset
    const onText = !on ? 'none' : on.seg === 'well' ? `${fmt(zv(on.z ?? 0))} ${zU}` : `${fmt(sv(on.s - inp.depth), 1)} ${sU}`
    const onSub = !on ? 'fluid stays above WAT' : on.seg === 'well' ? 'below wellhead, in the tubing' : 'along the flowline from the wellhead'
    const margin = -r.subcoolInh
    const shut = inp.flowline > 0 ? r.subcoolShut - depression(inp.inh, inp.inhWt) : null
    const cd = r.cooldown
    const hrs = (t: number | null) => (t == null ? 'never' : t === 0 ? 'already' : `${fmt(t, 1)} h`)
    const warn: string[] = []
    if (on?.seg === 'well') warn.push(`Wax deposits inside the tubing from ${fmt(zv(on.z ?? 0))} ${zU} below the wellhead — scraper runs or hot-oiling, and a lost-rate risk.`)
    else if (on) warn.push(`Wax deposits in the flowline from ${fmt(sv(on.s - inp.depth), 1)} ${sU} — needs a pigging programme or inhibitor.`)
    if (r.subcoolInh > 0) warn.push(`Flowing fluid is ${fmt(dtv(r.subcoolInh), 1)} ${tU} inside the hydrate zone at ${r.hydOnset?.seg === 'well' ? 'the tubing' : 'the flowline'} — continuous inhibition needed.`)
    if (shut != null && shut > 0) warn.push(`After a shut-in the line settles at sea temperature, ${fmt(dtv(shut), 1)} ${tU} inside the hydrate zone: ${hrs(cd.toHyd)} no-touch time.`)
    if (r.pourRisk && inp.flowline > 0) warn.push(`Arrival temperature is below the pour point — a cold restart may need extra pressure to break the gel.`)
    if (r.chokedFlowline) warn.push(`Arrival pressure hit the floor: this flowline cannot carry ${fmt(u.liq(inp.ql))} ${u.liqU} at this wellhead pressure.`)
    card.append(
      h('span', { class: 'eyebrow' }, 'Result'),
      h('div', { class: 'kpis' },
        kpi('Wellhead T', tS(r.twh, 1), `flowing BHP ${pS(r.bhp)}`),
        kpi('Arrival T', inp.flowline > 0 ? tS(r.tarr, 1) : '—', inp.flowline > 0 ? `at ${pS(r.parr)}` : 'dry tree'),
        kpi('Wax onset', onText, onSub),
        kpi('Hydrate margin, flowing', `${margin >= 0 ? '' : '−'}${fmt(Math.abs(dtv(margin)), 1)} ${tU}`, margin >= 0 ? 'warmer than hydrate T' : 'inside hydrate zone'),
        kpi('No-touch time', inp.flowline > 0 ? hrs(cd.toHyd) : '—', inp.flowline > 0 ? `to hydrate T · WAT in ${hrs(cd.toWat)}` : 'no flowline'),
        kpi('Inhibitor to stay clear', r.inhNeeded.methanol > 0 ? `${fmt(r.inhNeeded.methanol)} wt %` : 'none', r.inhNeeded.methanol > 0 ? `methanol · or ${fmt(r.inhNeeded.meg)} wt % MEG (+${fmt(dtv(3))} ${tU} margin)` : 'flowing and shut-in')),
      h('div', { class: 'small muted' }, `Ramey relaxation distance A = ${fmt(zv(r.A))} ${zU} (longer = less cooling). Geothermal gradient ${fmt(dtv(r.grad * 100), 1)} ${tU}/100 m.`),
      h('span', { class: 'eyebrow' }, 'Flags'),
      ...(warn.length ? warn.map(t => h('div', { class: 'small', style: { color: 'var(--warn)', lineHeight: 1.5 } }, '▲ ', t))
        : [h('div', { class: 'small muted' }, 'No wax or hydrate flags at these inputs.')]),
      h('span', { class: 'eyebrow' }, 'What an engineer would do'),
      h('div', { class: 'small muted', style: { lineHeight: 1.6 } },
        'Keep rate up — heat arrives with the flow, and late-life low rates are the usual trigger. For wax: pig the flowline on a schedule set by the deposition rate, scrape or hot-oil the tubing, inject wax inhibitor or pour-point depressant, or insulate. For hydrates: inhibit with methanol or MEG for the worst case (shut-in at sea temperature), depressurise below the hydrate pressure during long shut-ins, and plan restarts. Check these screening numbers with a proper thermal-hydraulic and hydrate model before design.'))
  }
  renderCard()

  return () => { cancelAnimationFrame(raf); charts.forEach(c => c.destroy()); tip(null) }
}
