// T6 — artificial lift: method screening radar, ESP design with a VSD envelope, rod-pump card diagnosis.
import * as d3 from 'd3'
import type { Ctx } from '../main'
import { fmt, pct } from '../core/units'
import {
  AXES, AXIS_LABEL, CARD_ACTION, CARD_LABEL, CARDS, METHOD_COLOR, METHOD_LABEL, PUMPS, REC,
  cardFeatures, classifyCard, espPoint, headRequired, pumpHead, runout, sampleCard, screen, stageEff, surfaceCard,
  type Card, type EspInput, type Method, type Sand, type ScreenInput,
} from '../analysis/lift'
import { aof } from '../analysis/nodal'
import { axisStyle, dur, grid, h, legend, panel, responsive, slider, tip, tipRows } from '../ui/kit'

export const METHODS = `
<h2>Artificial lift</h2>
<p>Three tools a production technologist uses when a well can no longer flow at its potential. Every curve and rule here is generic and illustrative; a real design uses vendor catalogue curves and a calibrated well model.</p>
<h3>Method screening</h3>
<p>Each method is scored 0–5 on nine criteria (rate, depth, gas, water cut, sand, viscosity, deviation, temperature, surface &amp; utilities) from a step table that follows published screening guides (Brown 1982; Clegg, Bucaram &amp; Hein 1993). The plunger gas requirement uses the rule of thumb of about 400 scf/bbl per 1,000 ft of lift.</p>
<div class="eq">score = mean(axis scores)
score = 0.6 · mean    if any axis ≤ 1  (near show-stopper)
score = 0             if any axis = 0  (not feasible)</div>
<p>The radar shows the axis scores; the ranking shows the final score and the weakest axis (the limiting factor). The table is a screening aid, not a substitute for a design study and life-cycle cost comparison.</p>
<h3>ESP design</h3>
<p>A generic single-stage head curve at 60 Hz is scaled by the affinity laws; efficiency is unchanged by speed.</p>
<div class="eq">Q₂ = Q₁ · (f₂/f₁)        H₂ = H₁ · (f₂/f₁)²        P₂ = P₁ · (f₂/f₁)³
H_stage(q, 60 Hz) = H₀ · (1 − 0.25·x − 0.75·x²),   x = q / q_runout
η(q) = η_max · (2·x_b − x_b²),   x_b = q / q_BEP(f)
PIP(q)   = P_wf(q) − ρ_liq · g · (TVD_perf − TVD_pump)
H_req(q) = (P_discharge(q) − PIP(q)) / (ρ_liq · g)
operating point: N_stages · H_stage(q, f) = H_req(q)       (bisection)
P_brake = ρ_liq · g · q · H / η</div>
<p>P_wf(q) comes from the straight-line PI + Vogel inflow model and P_discharge from the simplified no-slip tubing model used on the Nodal page, with a rotary gas separator assumed (the tubing carries only gas still in solution at the intake). The recommended operating range is 75–125 % of the frequency-scaled best-efficiency rate (illustrative); left of it the stages run in downthrust, right of it in upthrust.</p>
<h3>Rod-pump dynamometer cards (synthetic)</h3>
<p>Downhole cards are drawn from parametric shapes for six classic conditions (full pump, fluid pound, gas interference, unanchored tubing, leaking travelling valve, leaking standing valve). The surface card is an illustrative forward sketch (buoyant rod weight + rod stretch + a dynamic term), not a wave-equation solution; Gibbs (1963) computes the downhole card from a measured surface card.</p>
<p>The classifier reads the features a pumper reads off a card — pump fillage (where the load drops on the downstroke), sharpness of that drop, how slowly load picks up on the upstroke, load lost late in the upstroke, and fluid load carried on the downstroke — and combines them with fuzzy rules (logistic memberships, normalised to confidence). It recovers all six synthetic conditions; real cards need a library of field examples to tune the thresholds.</p>
<h3>References</h3>
<ul>
<li>Brown, K.E. (1982). Overview of artificial lift systems. JPT 34(10).</li>
<li>Clegg, J.D., Bucaram, S.M., Hein, N.W. (1993). Recommendations and comparisons for selecting artificial-lift methods. JPT 45(12).</li>
<li>Gibbs, S.G. (1963). Predicting the behavior of sucker-rod pumping systems. JPT 15(7).</li>
<li>API RP 11S. Recommended practice for the operation, maintenance and troubleshooting of electric submersible pump installations.</li>
<li>Vogel, J.V. (1968). Inflow performance relationships for solution-gas drive wells. JPT.</li>
</ul>`

type Tab = 'screen' | 'esp' | 'cards'
let tab: Tab = 'screen'

const SCREEN0: ScreenInput = { rate: 300, depth: 2200, glr: 60, wc: 0.7, sand: 'low', visc: 5, dev: 35, dls: 3, temp: 95, offshore: true, power: true, gas: true }
const ESP0: EspInput = {
  inflow: { pres: 200, pi: 4, pb: 90 }, fluid: { api: 32, gor: 60, wc: 0.7, gasSg: 0.75, waterSg: 1.03 },
  perf: 2300, pump: 2100, whp: 15, tubingId: 2.992, stage: PUMPS[1], stages: 180, freq: 55, tBh: 95,
}

export function mountLift(el: HTMLElement, { u }: Ctx) {
  const field = u.sys === 'field'
  const zv = (m: number) => (field ? m * 3.28084 : m), zU = field ? 'ft' : 'm'
  const tS = (c: number) => (field ? `${fmt(c * 1.8 + 32)} °F` : `${fmt(c)} °C`)
  const hS = (m: number) => `${fmt(zv(m))} ${zU}`
  const kwS = (kw: number) => (field ? `${fmt(kw * 1.341)} hp` : `${fmt(kw)} kW`)
  const sx: ScreenInput = { ...SCREEN0 }
  const ex: EspInput = { ...ESP0, inflow: { ...ESP0.inflow }, fluid: { ...ESP0.fluid } }
  let card: Card = 'pound', fill = 0.6, noise = 0.015, playing = 0

  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Lift tool' })
  const rail = h('aside', { class: 'rail', 'aria-label': 'Inputs' })
  const center = h('div', { class: 'center' })
  const side = h('aside', { class: 'rail right', 'aria-label': 'Results' })
  el.append(h('div', { class: 'cols chart-first' }, rail, center, side))
  let charts: { redraw: () => void; destroy: () => void }[] = []
  let refresh = () => {}

  const TABS: [Tab, string][] = [['screen', 'Method screening'], ['esp', 'ESP design'], ['cards', 'Rod-pump cards']]
  function build() {
    charts.forEach(c => c.destroy()); charts = []
    clearInterval(playing); playing = 0
    tabs.innerHTML = ''
    TABS.forEach(([k, l]) => tabs.append(h('button', { role: 'tab', 'aria-selected': String(k === tab), onclick: () => { tab = k; build() } }, l)))
    rail.innerHTML = ''; center.innerHTML = ''; side.innerHTML = ''
    center.append(h('div', { class: 'row', style: { alignItems: 'center' } }, h('div', { style: { flex: '0 0 auto' } }, tabs),
      h('span', { class: 'small muted', style: { flex: '1 1 260px' } }, {
        screen: 'Which lift method suits this well? Scores follow published screening guides.',
        esp: 'Size an electric submersible pump and see where it runs as the drive frequency changes.',
        cards: 'Read a sucker-rod pump card the way a pumper does. Cards are synthetic.',
      }[tab])))
    ;({ screen: buildScreen, esp: buildEsp, cards: buildCards })[tab]()
  }

  const seg = (label: string, opts: [string, string][], cur: () => string, on: (v: string) => void) => {
    const box = h('div', { class: 'seg', role: 'group', 'aria-label': label })
    const draw = () => { box.innerHTML = ''; opts.forEach(([v, l]) => box.append(h('button', { 'aria-pressed': String(v === cur()), onclick: () => { on(v); draw() } }, l))) }
    draw()
    return h('div', { class: 'field' }, h('span', {}, label), box)
  }
  const check = (label: string, v: boolean, on: (v: boolean) => void) => {
    const i = h('input', { type: 'checkbox' }) as HTMLInputElement
    i.checked = v; i.addEventListener('change', () => on(i.checked))
    return h('label', { class: 'small', style: { display: 'flex', gap: '8px', alignItems: 'center', minHeight: '28px' } }, i, label)
  }
  const kpi = (l: string, v: string, s?: string) => h('div', { class: 'kpi' }, h('div', { class: 'l' }, l), h('div', { class: 'v' }, v), s ? h('div', { class: 's' }, s) : null)
  const flag = (t: string) => h('div', { class: 'small warn' }, '▲ ', t)
  let raf = 0
  const changed = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => refresh()) }

  // ================================================================ screening
  function buildScreen() {
    // rate slider is logarithmic: 3 … 3,000 Sm³/d
    const toRate = (s: number) => 3 * Math.pow(1000, s / 100), toS = (q: number) => 100 * Math.log10(q / 3) / 3
    rail.append(
      h('span', { class: 'eyebrow' }, 'Well'),
      slider('Liquid rate', toS(sx.rate), 0, 100, 1, s => `${fmt(u.liq(toRate(s)))} ${u.liqU}`, s => { sx.rate = toRate(s); changed() }),
      slider('Pump / injection depth (TVD)', sx.depth, 300, 5000, 50, hS, v => { sx.depth = v; changed() }),
      slider('Gas-liquid ratio', sx.glr, 0, 600, 5, v => `${fmt(u.gor(v))} ${u.gorU}`, v => { sx.glr = v; changed() }),
      slider('Water cut', sx.wc * 100, 0, 98, 1, v => `${v} %`, v => { sx.wc = v / 100; changed() }),
      slider('Oil viscosity downhole', Math.log10(sx.visc) * 25, 0, 100, 1, s => `${fmt(Math.pow(10, s / 25))} cP`, s => { sx.visc = Math.pow(10, s / 25); changed() }),
      seg('Sand', [['none', 'None'], ['low', 'Some'], ['high', 'Severe']], () => sx.sand, v => { sx.sand = v as Sand; changed() }),
      h('span', { class: 'eyebrow' }, 'Trajectory & environment'),
      slider('Max inclination', sx.dev, 0, 90, 1, v => `${v}°`, v => { sx.dev = v; changed() }),
      slider('Dogleg at pump', sx.dls, 0, 15, 0.5, v => `${v}°/30 m`, v => { sx.dls = v; changed() }),
      slider('Bottomhole temperature', sx.temp, 30, 220, 1, tS, v => { sx.temp = v; changed() }),
      check('Offshore (space and weight limited)', sx.offshore, v => { sx.offshore = v; changed() }),
      check('Electrical power available', sx.power, v => { sx.power = v; changed() }),
      check('High-pressure lift gas available', sx.gas, v => { sx.gas = v; changed() }),
      h('button', { class: 'btn', onclick: () => { Object.assign(sx, SCREEN0); build() } }, 'Reset'))

    let hover: Method | null = null
    const radarBox = h('div', { class: 'chart' }), rankBox = h('div', { class: 'chart' })
    center.append(
      h('div', { class: 'row' },
        h('div', { style: { flex: '3 1 420px', display: 'flex' } }, panel('Screening radar — score per criterion', legend((Object.keys(METHOD_LABEL) as Method[]).map(m => ({ label: METHOD_LABEL[m], color: METHOD_COLOR[m] }))), radarBox)),
        h('div', { style: { flex: '2 1 300px', display: 'flex' } }, panel('Ranking', 'bar = overall score · text = limiting factor', rankBox))))
    const radar = responsive(radarBox, w => Math.min(460, Math.max(320, w * 0.8)), { t: 30, r: 10, b: 30, l: 10 }, f => drawRadar(f))
    const rank = responsive(rankBox, 300, { t: 6, r: 12, b: 10, l: 76 }, f => drawRank(f))
    charts.push(radar, rank)

    function drawRadar({ g, w, h: H }: { g: d3.Selection<SVGGElement, unknown, null, undefined>; w: number; h: number }) {
      const res = screen(sx)
      const R = Math.min(w, H) / 2 - (w < 420 ? 34 : 50), cx = w / 2, cy = H / 2
      const ang = (i: number) => (i / AXES.length) * 2 * Math.PI
      let root = g.select<SVGGElement>('g.rad')
      if (root.empty()) {
        root = g.append('g').attr('class', 'rad')
        root.append('g').attr('class', 'web'); root.append('g').attr('class', 'polys'); root.append('g').attr('class', 'labels')
      }
      root.attr('transform', `translate(${cx},${cy})`)
      const web = root.select('g.web'); web.selectAll('*').remove()
      for (const lvl of [1, 2, 3, 4, 5]) web.append('path').attr('fill', 'none').attr('stroke', lvl === 5 ? 'var(--line)' : 'var(--line-soft)')
        .attr('d', d3.lineRadial<number>().angle((_, i) => ang(i)).radius(() => (R * lvl) / 5).curve(d3.curveLinearClosed)(AXES.map(() => 0)))
      AXES.forEach((_, i) => web.append('line').attr('x2', R * Math.sin(ang(i))).attr('y2', -R * Math.cos(ang(i))).attr('stroke', 'var(--line-soft)'))
      const short: Record<string, string> = { surface: 'Surface', temp: 'Temp.', visc: 'Visc.', dev: 'Dev.' }
      root.select('g.labels').selectAll<SVGTextElement, string>('text').data(AXES).join('text').attr('class', 'lbl')
        .attr('x', (_, i) => (R + 14) * Math.sin(ang(i))).attr('y', (_, i) => -(R + 14) * Math.cos(ang(i)) + 4)
        .attr('text-anchor', (_, i) => { const s = Math.sin(ang(i)); return Math.abs(s) < 0.2 ? 'middle' : s > 0 ? 'start' : 'end' })
        .text(a => (w < 420 ? short[a] ?? AXIS_LABEL[a] : AXIS_LABEL[a]))
      const line = d3.lineRadial<number>().angle((_, i) => ang(i)).radius(v => (R * v) / 5).curve(d3.curveLinearClosed)
      const top = res[0].m
      root.select('g.polys').selectAll<SVGPathElement, typeof res[0]>('path').data(res, r => r.m).join(
        en => en.append('path').attr('d', r => line(AXES.map(() => 0 * r.mean))!),
      ).attr('stroke', r => METHOD_COLOR[r.m]).attr('stroke-width', r => (r.m === (hover ?? top) ? 2.5 : 1.2))
        .attr('fill', r => METHOD_COLOR[r.m]).attr('fill-opacity', r => (r.m === (hover ?? top) ? 0.18 : 0.02))
        .attr('opacity', r => (hover && r.m !== hover ? 0.25 : 1)).style('cursor', 'pointer')
        .on('pointermove', (ev, r) => { if (hover !== r.m) { hover = r.m; radar.redraw(); rank.redraw() } tip(tipRows(METHOD_LABEL[r.m], AXES.map(a => [AXIS_LABEL[a], `${r.axes[a].s} / 5`] as [string, string])), ev) })
        .on('pointerleave', () => { hover = null; tip(null); radar.redraw(); rank.redraw() })
        .transition().duration(dur(600)).ease(d3.easeCubicOut).attr('d', r => line(AXES.map(a => r.axes[a].s))!)
      root.select('g.polys').selectAll<SVGPathElement, typeof res[0]>('path').filter(r => r.m === (hover ?? top)).raise()
    }

    function drawRank({ g, w, h: H }: { g: d3.Selection<SVGGElement, unknown, null, undefined>; w: number; h: number }) {
      const res = screen(sx)
      const ys = d3.scaleBand<string>().domain(res.map(r => r.m)).range([0, H]).padding(0.38)
      const xs = d3.scaleLinear().domain([0, 5]).range([0, w])
      g.selectAll('rect.bg').data(res, (r: any) => r.m).join('rect').attr('class', 'bg').attr('x', 0).attr('width', w).attr('fill', 'var(--sunken)')
        .attr('height', ys.bandwidth()).transition().duration(dur(500)).attr('y', r => ys(r.m)!)
      g.selectAll('rect.b').data(res, (r: any) => r.m).join('rect').attr('class', 'b').attr('x', 0).attr('height', ys.bandwidth()).attr('rx', 2)
        .attr('fill', r => METHOD_COLOR[r.m]).attr('opacity', r => (hover && r.m !== hover ? 0.35 : 1))
        .transition().duration(dur(500)).attr('y', r => ys(r.m)!).attr('width', r => xs(r.score))
      g.selectAll('text.m').data(res, (r: any) => r.m).join('text').attr('class', 'lbl-strong m').attr('x', -8).attr('text-anchor', 'end')
        .transition().duration(dur(500)).attr('y', r => ys(r.m)! + ys.bandwidth() / 2 + 4).text(r => METHOD_LABEL[r.m])
      g.selectAll('text.s').data(res, (r: any) => r.m).join('text').attr('class', 'lbl-mono s').attr('x', 6)
        .transition().duration(dur(500)).attr('y', r => ys(r.m)! - 4)
        .text(r => (r.feasible ? `${r.score.toFixed(1)} · limit: ${AXIS_LABEL[r.limit].toLowerCase()}` : `not feasible · ${AXIS_LABEL[r.limit].toLowerCase()}`))
    }

    refresh = () => {
      radar.redraw(); rank.redraw()
      const res = screen(sx), best = res[0], second = res[1]
      side.innerHTML = ''
      side.append(
        h('span', { class: 'eyebrow' }, 'Recommendation'),
        h('div', { class: 'kpis' }, kpi('First choice', METHOD_LABEL[best.m], `score ${best.score.toFixed(1)} / 5`), kpi('Runner-up', METHOD_LABEL[second.m], `score ${second.score.toFixed(1)} / 5`)),
        ...(best.score - second.score < 0.3 ? [h('div', { class: 'small muted' }, 'Close call — compare life-cycle cost, run life and intervention access before choosing.')] : []),
        h('span', { class: 'eyebrow' }, `Why ${METHOD_LABEL[best.m]}`),
        h('div', { class: 'tablewrap' }, h('table', { class: 'data' }, h('tbody', {}, ...AXES.map(a => h('tr', {},
          h('td', { style: { whiteSpace: 'normal' } }, AXIS_LABEL[a]), h('td', { class: 'num' }, `${best.axes[a].s}`), h('td', { class: 'small muted', style: { whiteSpace: 'normal', minWidth: '140px' } }, best.axes[a].why)))))),
        ...res.filter(r => !r.feasible).map(r => flag(`${METHOD_LABEL[r.m]} ruled out: ${r.axes[r.limit].why}.`)),
        h('div', { class: 'small muted' }, 'Hover a polygon to see one method; the highlighted polygon is the top-ranked method.'))
    }
    refresh()
  }

  // ================================================================ ESP
  function buildEsp() {
    const pSv = (bar: number) => `${fmt(u.p(bar))} ${u.pU}`
    const pumpSel = h('select', { 'aria-label': 'Pump size', style: { width: '100%' } }, ...PUMPS.map((p, i) => h('option', { value: i, selected: p === ex.stage ? true : null }, p.name))) as HTMLSelectElement
    pumpSel.addEventListener('change', () => { ex.stage = PUMPS[+pumpSel.value]; changed() })
    rail.append(
      h('span', { class: 'eyebrow' }, 'Drive'),
      slider('VSD frequency', ex.freq, 40, 70, 1, v => `${v} Hz`, v => { ex.freq = v; changed() }),
      h('span', { class: 'eyebrow' }, 'Pump'),
      h('label', { class: 'field' }, h('span', {}, 'Stage type (generic)'), pumpSel),
      slider('Stages', ex.stages, 40, 400, 5, v => `${v}`, v => { ex.stages = v; changed() }),
      slider('Pump setting depth (TVD)', ex.pump, 800, 2280, 10, hS, v => { ex.pump = v; changed() }),
      h('span', { class: 'eyebrow' }, 'Well'),
      slider('Reservoir pressure', ex.inflow.pres, 80, 350, 1, pSv, v => { ex.inflow.pres = v; changed() }),
      slider('Productivity index', ex.inflow.pi, 0.5, 15, 0.1, v => `${fmt(u.pi(v), 2)} ${u.piU}`, v => { ex.inflow.pi = v; changed() }),
      slider('Water cut', ex.fluid.wc * 100, 0, 98, 1, v => `${v} %`, v => { ex.fluid.wc = v / 100; changed() }),
      slider('Producing GOR', ex.fluid.gor, 10, 300, 5, v => `${fmt(u.gor(v))} ${u.gorU}`, v => { ex.fluid.gor = v; changed() }),
      slider('Wellhead pressure', ex.whp, 5, 60, 1, pSv, v => { ex.whp = v; changed() }),
      h('div', { class: 'small muted' }, `Mid-perforations at ${hS(ex.perf)} TVD, 3½″ tubing, ${tS(ex.tBh)} at the pump. Generic stage curves — not a vendor pump.`),
      h('button', { class: 'btn', onclick: () => { Object.assign(ex, { ...ESP0, inflow: { ...ESP0.inflow }, fluid: { ...ESP0.fluid } }); build() } }, 'Reset'))

    const hqBox = h('div', { class: 'chart' }), swBox = h('div', { class: 'chart' })
    center.append(
      panel('Pump head vs system curve', legend([{ label: 'pump at set frequency', color: 'var(--ink)' }, { label: '40 · 50 · 60 · 70 Hz', color: 'var(--dim)', dash: true }, { label: 'well needs (system)', color: 'var(--water)' }, { label: 'recommended range', color: 'var(--oil)' }]), hqBox),
      panel('Frequency sweep', 'rate and pump intake pressure the well settles at, 40–70 Hz', swBox))
    const hq = responsive(hqBox, w => (w < 600 ? 300 : 360), { t: 16, r: 20, b: 40, l: 58 }, f => drawHQ(f))
    const sw = responsive(swBox, 220, { t: 16, r: 58, b: 36, l: 58 }, f => drawSweep(f))
    charts.push(hq, sw)

    function drawHQ({ g, w: W, h: H }: { g: d3.Selection<SVGGElement, unknown, null, undefined>; w: number; h: number }) {
      const qMax = runout(ex.stage, 70) * 1.02
      const xs = d3.scaleLinear().domain([0, u.liq(qMax)]).range([0, W])
      const hMax = ex.stages * ex.stage.h0 * (70 / 60) ** 2 * 1.05
      const ys = d3.scaleLinear().domain([0, zv(hMax)]).range([H, 0]).nice()
      const X = (q: number) => xs(u.liq(q)), Y = (m: number) => ys(zv(m))
      if (g.select('g.ax').empty()) { g.append('g').attr('class', 'ax'); g.append('g').attr('class', 'ay'); g.append('g').attr('class', 'body') }
      grid(g, ys, W)
      g.select<SVGGElement>('g.ax').attr('transform', `translate(0,${H})`).call(d3.axisBottom(xs).ticks(W < 600 ? 4 : 7, '~s')).call(axisStyle)
      g.select<SVGGElement>('g.ay').call(d3.axisLeft(ys).ticks(5, '~s')).call(axisStyle)
      const body = g.select<SVGGElement>('g.body')
      body.selectAll('text.t').data([0, 1]).join('text').attr('class', 'lbl t')
        .attr('x', (_, i) => (i ? W / 2 : 0)).attr('y', (_, i) => (i ? H + 34 : -4)).attr('text-anchor', (_, i) => (i ? 'middle' : 'start'))
        .text((_, i) => (i ? `liquid rate (${u.liqU})` : `head (${zU})`))
      const qs = (f: number) => d3.range(0, 61).map(i => (i / 60) * runout(ex.stage, f))
      const line = d3.line<[number, number]>().x(d => X(d[0])).y(d => Y(d[1]))
      // recommended-range envelope across 40–70 Hz
      const fs = d3.range(40, 70.1, 1)
      const env: [number, number][] = [...fs.map(f => { const q = REC[0] * ex.stage.qBep * f / 60; return [q, pumpHead(ex, q, f)] as [number, number] }),
        ...fs.slice().reverse().map(f => { const q = REC[1] * ex.stage.qBep * f / 60; return [q, pumpHead(ex, q, f)] as [number, number] })]
      body.selectAll('path.env').data([env]).join('path').attr('class', 'env').attr('fill', 'var(--oil)').attr('fill-opacity', 0.1).attr('stroke', 'var(--oil)').attr('stroke-opacity', 0.5).attr('stroke-dasharray', '3 3')
        .transition().duration(dur(400)).attr('d', d => line(d) + 'Z')
      body.selectAll('path.fam').data([40, 50, 60, 70]).join('path').attr('class', 'fam').attr('fill', 'none').attr('stroke', 'var(--dim)').attr('stroke-dasharray', '4 4')
        .transition().duration(dur(400)).attr('d', f => line(qs(f).map(q => [q, pumpHead(ex, q, f)])))
      body.selectAll('text.fl').data([40, 50, 60, 70]).join('text').attr('class', 'lbl fl')
        .attr('x', f => X(runout(ex.stage, f) * 0.04) + 2).attr('y', f => Y(pumpHead(ex, runout(ex.stage, f) * 0.04, f)) - 4).text(f => `${f} Hz`)
      const qSys = Math.min(qMax, aof(ex.inflow) * 0.995)   // beyond the AOF the well cannot deliver
      const sys: [number, number][] = d3.range(1, 61).map(i => (i / 60) * qSys).map(q => [q, headRequired(ex, q)] as [number, number]).filter(d => isFinite(d[1]) && d[1] < hMax * 1.3)
      body.selectAll('path.sys').data([sys]).join('path').attr('class', 'sys').attr('fill', 'none').attr('stroke', 'var(--water)').attr('stroke-width', 2)
        .transition().duration(dur(400)).attr('d', d => line(d))
      body.selectAll('path.cur').data([qs(ex.freq).map(q => [q, pumpHead(ex, q)] as [number, number])]).join('path').attr('class', 'cur').attr('fill', 'none').attr('stroke', 'var(--ink)').attr('stroke-width', 2.5)
        .transition().duration(dur(400)).attr('d', d => line(d))
      const op = espPoint(ex)
      body.selectAll('circle.op').data(op ? [op] : []).join('circle').attr('class', 'op').attr('r', 6).attr('fill', 'var(--panel)').attr('stroke-width', 2.5)
        .attr('stroke', p => (p.zone === 'ok' ? 'var(--ink-strong)' : 'var(--warn)'))
        .transition().duration(dur(400)).attr('cx', p => X(p.q)).attr('cy', p => Y(p.head))
      body.selectAll('text.opl').data(op ? [op] : []).join('text').attr('class', 'lbl-mono opl')
        .attr('text-anchor', p => (X(p.q) > W * 0.6 ? 'end' : 'start'))
        .transition().duration(dur(400)).attr('x', p => X(p.q) + (X(p.q) > W * 0.6 ? -10 : 10)).attr('y', p => Y(p.head) - 10)
        .text(p => `${fmt(u.liq(p.q))} ${u.liqU} · ${ex.freq} Hz`)
      // hover readout
      body.selectAll('rect.hit').data([0]).join('rect').attr('class', 'hit').attr('width', W).attr('height', H).attr('fill', 'transparent')
        .on('pointermove', ev => {
          const q = xs.invert(d3.pointer(ev)[0]) / u.liq(1)
          tip(tipRows(`${fmt(u.liq(q))} ${u.liqU}`, [['Pump head', hS(pumpHead(ex, q))], ['Well needs', hS(headRequired(ex, q))], ['Stage efficiency', pct(stageEff(ex.stage, q, ex.freq))]]), ev)
        }).on('pointerleave', () => tip(null)).lower()
    }

    function drawSweep({ g, w: W, h: H }: { g: d3.Selection<SVGGElement, unknown, null, undefined>; w: number; h: number }) {
      g.selectAll('*').remove()
      const pts = d3.range(40, 70.1, 1).map(f => ({ f, p: espPoint(ex, f) })).filter((d): d is { f: number; p: NonNullable<ReturnType<typeof espPoint>> } => d.p != null)
      const xs = d3.scaleLinear().domain([40, 70]).range([0, W])
      const yq = d3.scaleLinear().domain([0, u.liq(d3.max(pts, d => d.p.q) || 1) * 1.1]).range([H, 0]).nice()
      const yp = d3.scaleLinear().domain([0, u.p(d3.max(pts, d => d.p.pip) || 1) * 1.1]).range([H, 0]).nice()
      g.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(xs).ticks(6).tickFormat(d => `${d} Hz`)).call(axisStyle)
      g.append('g').call(d3.axisLeft(yq).ticks(4, '~s')).call(axisStyle)
      g.append('g').attr('transform', `translate(${W},0)`).call(d3.axisRight(yp).ticks(4, '~s')).call(axisStyle)
      g.append('text').attr('class', 'lbl').attr('y', -4).text(`rate (${u.liqU})`)
      g.append('text').attr('class', 'lbl').attr('x', W).attr('y', -4).attr('text-anchor', 'end').text(`intake pressure (${u.pU})`)
      if (!pts.length) { g.append('text').attr('class', 'lbl').attr('x', W / 2).attr('y', H / 2).attr('text-anchor', 'middle').text('pump cannot lift the well at any frequency'); return }
      const lq = g.append('path').datum(pts).attr('fill', 'none').attr('stroke', 'var(--oil)').attr('stroke-width', 2).attr('d', d3.line<typeof pts[0]>().x(d => xs(d.f)).y(d => yq(u.liq(d.p.q))))
      const lp = g.append('path').datum(pts).attr('fill', 'none').attr('stroke', 'var(--water)').attr('stroke-width', 2).attr('stroke-dasharray', '5 3').attr('d', d3.line<typeof pts[0]>().x(d => xs(d.f)).y(d => yp(u.p(d.p.pip))))
      ;[lq, lp].forEach(p => p.attr('opacity', 0).transition().duration(dur(500)).attr('opacity', 1))
      g.selectAll('circle.z').data(pts).join('circle').attr('class', 'z').attr('cx', d => xs(d.f)).attr('cy', d => yq(u.liq(d.p.q))).attr('r', 2.5)
        .attr('fill', d => (d.p.zone === 'ok' ? 'var(--oil)' : 'var(--warn)'))
      g.append('line').attr('x1', xs(ex.freq)).attr('x2', xs(ex.freq)).attr('y1', 0).attr('y2', H).attr('stroke', 'var(--ink-2)').attr('stroke-dasharray', '2 3')
      g.append('text').attr('class', 'lbl').attr('x', 6).attr('y', H - 6).text(W < 600 ? '— rate · - - PIP · amber = outside range' : '— rate   - - pump intake pressure   amber dots = outside recommended range')
      g.append('rect').attr('width', W).attr('height', H).attr('fill', 'transparent')
        .on('pointermove', ev => {
          const f = Math.round(xs.invert(d3.pointer(ev)[0])), d = pts.find(p => p.f === f)
          if (d) tip(tipRows(`${f} Hz`, [['Rate', `${fmt(u.liq(d.p.q))} ${u.liqU}`], ['Intake pressure', pSv(d.p.pip)], ['Efficiency', pct(d.p.eff)], ['Brake power', kwS(d.p.brakeKw)]]), ev)
        }).on('pointerleave', () => tip(null))
    }

    refresh = () => {
      hq.redraw(); sw.redraw()
      const op = espPoint(ex)
      side.innerHTML = ''
      side.append(h('span', { class: 'eyebrow' }, `Operating point · ${ex.freq} Hz`))
      if (!op) { side.append(flag('The pump cannot lift fluid to surface at this frequency and stage count. Add stages or raise frequency.')); return }
      const warn: string[] = []
      if (op.zone === 'down') warn.push('Below the recommended range: downthrust wear and poor motor cooling. Lower the stage count or use a smaller pump.')
      if (op.zone === 'up') warn.push('Above the recommended range: upthrust. Choose a larger pump or reduce frequency.')
      if (op.pip < 0.3 * ex.inflow.pres && op.pip < ex.inflow.pb) warn.push('Intake pressure is low — the pump is close to pumping the well off.')
      if (op.gvf > 0.1) warn.push(`Free gas at the intake is ${pct(op.gvf)}: needs a gas separator or gas handler.`)
      side.append(
        h('div', { class: 'kpis' },
          kpi(`Liquid (${u.liqU})`, fmt(u.liq(op.q)), `oil ${fmt(u.liq(op.q * (1 - ex.fluid.wc)))}`),
          kpi(`Intake pressure (${u.pU})`, fmt(u.p(op.pip)), `reservoir ${pSv(ex.inflow.pres)}`),
          kpi(`Pump head (${zU})`, fmt(zv(op.head)), `${ex.stages} stages`),
          kpi('Stage efficiency', pct(op.eff), op.zone === 'ok' ? 'inside recommended range' : op.zone === 'down' ? 'left of range (downthrust)' : 'right of range (upthrust)'),
          kpi('Brake power', kwS(op.brakeKw), `hydraulic ${kwS(op.hydKw)}`),
          kpi('Free gas at intake', pct(op.gvf), 'before the separator')),
        ...warn.map(flag),
        h('div', { class: 'small muted', style: { lineHeight: 1.6 } }, 'Move the frequency slider: the pump curve scales by the affinity laws (rate ∝ f, head ∝ f²) and the operating point slides along the well curve. A good design sits inside the green band across the frequencies you expect to run, so the drive can follow the well as it depletes or waters out.'))
    }
    refresh()
  }

  // ================================================================ cards
  function buildCards() {
    const btns = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } })
    const drawBtns = () => { btns.innerHTML = ''; CARDS.forEach(c => btns.append(h('button', { class: c === card ? 'btn primary' : 'btn', 'aria-pressed': String(c === card), onclick: () => { stop(); card = c; drawBtns(); changed() } }, CARD_LABEL[c]))) }
    drawBtns()
    const playBtn = h('button', { class: 'btn', onclick: () => (playing ? stop() : play()) }, '▶ Auto-play') as HTMLButtonElement
    function play() {
      playBtn.textContent = '❚❚ Stop'
      playing = window.setInterval(() => { card = CARDS[(CARDS.indexOf(card) + 1) % CARDS.length]; drawBtns(); refresh() }, 2600)
    }
    function stop() { clearInterval(playing); playing = 0; playBtn.textContent = '▶ Auto-play' }
    rail.append(
      h('span', { class: 'eyebrow' }, 'Pump condition'), btns, playBtn,
      h('span', { class: 'eyebrow' }, 'Card'),
      slider('Pump fillage (pound / gas)', fill * 100, 30, 90, 1, v => `${v} %`, v => { fill = v / 100; changed() }),
      slider('Load-cell noise', noise * 100, 0, 6, 0.5, v => `${v} %`, v => { noise = v / 100; changed() }),
      h('div', { class: 'small muted' }, 'Cards are synthetic shapes for the classic textbook conditions; the classifier does not know which one you picked.'))

    const dhBox = h('div', { class: 'chart' }), sfBox = h('div', { class: 'chart' })
    center.append(h('div', { class: 'row' },
      panel('Downhole card', 'pump load vs plunger position', dhBox),
      panel('Surface card (sketch)', 'polished-rod load vs stroke', sfBox)))
    const k = () => sampleCard(card, fill, noise)
    type G = d3.Selection<SVGGElement, unknown, null, undefined>
    let dhG: G | null = null, sfG: G | null = null
    let dhW = 0, dhH = 0, sfW = 0, sfH = 0
    const dh = responsive(dhBox, 280, { t: 16, r: 14, b: 34, l: 44 }, f => { dhG = f.g; dhW = f.w; dhH = f.h; drawDown() })
    const sf = responsive(sfBox, 280, { t: 16, r: 14, b: 34, l: 44 }, f => { sfG = f.g; sfW = f.w; sfH = f.h; drawSurf() })
    charts.push(dh, sf)

    function axes(g: G, W: number, H: number, xl: string, yl: string, yMax: number) {
      const xs = d3.scaleLinear().domain([0, 1]).range([0, W]), ys = d3.scaleLinear().domain([-0.15, yMax]).range([H, 0])
      if (g.select('g.ax').empty()) { g.append('g').attr('class', 'ax'); g.append('g').attr('class', 'ay'); g.append('text').attr('class', 'lbl xl'); g.append('text').attr('class', 'lbl yl') }
      g.select<SVGGElement>('g.ax').attr('transform', `translate(0,${H})`).call(d3.axisBottom(xs).ticks(4).tickFormat(d => `${Math.round(+d * 100)}%`)).call(axisStyle)
      g.select<SVGGElement>('g.ay').call(d3.axisLeft(ys).ticks(4).tickFormat(d => `${Math.round(+d * 100)}`)).call(axisStyle)
      g.select('text.xl').attr('x', W / 2).attr('y', H + 30).attr('text-anchor', 'middle').text(xl)
      g.select('text.yl').attr('x', 0).attr('y', -4).text(yl)
      return { xs, ys }
    }
    function drawDown() {
      if (!dhG) return
      const { xs, ys } = axes(dhG, dhW, dhH, 'plunger position (% of stroke)', 'load (% of full fluid load)', 1.2)
      const kk = k()
      const pts: [number, number][] = [...kk.x.map((x, i) => [x, kk.up[i]] as [number, number]), ...kk.x.map((x, i) => [x, kk.down[i]] as [number, number]).reverse()]
      const line = d3.line<[number, number]>().x(d => xs(d[0])).y(d => ys(d[1])).curve(d3.curveLinearClosed)
      dhG.selectAll('path.ideal').data([0]).join('path').attr('class', 'ideal').attr('fill', 'none').attr('stroke', 'var(--dim)').attr('stroke-dasharray', '4 4')
        .attr('d', line([[0, 0], [0, 1], [1, 1], [1, 0]]))
      dhG.selectAll('path.card').data([pts]).join('path').attr('class', 'card').attr('fill', 'var(--oil)').attr('fill-opacity', 0.14).attr('stroke', 'var(--oil)').attr('stroke-width', 2)
        .transition().duration(dur(700)).ease(d3.easeCubicInOut).attr('d', line)
      const feat = cardFeatures(kk)
      dhG.selectAll('line.fill').data([feat.fill]).join('line').attr('class', 'fill').attr('y1', ys(1.12)).attr('y2', ys(-0.1)).attr('stroke', 'var(--warn)').attr('stroke-dasharray', '2 3')
        .transition().duration(dur(700)).attr('x1', v => xs(v)).attr('x2', v => xs(v))
      dhG.selectAll('text.fillt').data([feat.fill]).join('text').attr('class', 'lbl fillt').attr('y', ys(1.14)).attr('text-anchor', 'middle')
        .transition().duration(dur(700)).attr('x', v => Math.min(dhW - 30, Math.max(30, xs(v)))).text(v => `fillage ${Math.round(v * 100)}%`)
    }
    function drawSurf() {
      if (!sfG) return
      const { xs, ys } = axes(sfG, sfW, sfH, 'polished-rod position (% of stroke)', 'load (% of fluid load)', 2.1)
      const pts = surfaceCard(k(), 1, 0.55, 0.12)
      sfG.selectAll('path.card').data([pts]).join('path').attr('class', 'card').attr('fill', 'var(--ink-2)').attr('fill-opacity', 0.08).attr('stroke', 'var(--ink-2)').attr('stroke-width', 2)
        .transition().duration(dur(700)).ease(d3.easeCubicInOut).attr('d', d3.line<[number, number]>().x(d => xs(d[0])).y(d => ys(d[1])).curve(d3.curveLinearClosed))
      sfG.selectAll('line.wrf').data([0.55]).join('line').attr('class', 'wrf').attr('x1', 0).attr('x2', sfW).attr('y1', v => ys(v)).attr('y2', v => ys(v)).attr('stroke', 'var(--dim)').attr('stroke-dasharray', '4 4')
      sfG.selectAll('text.wrf').data([0.55]).join('text').attr('class', 'lbl wrf').attr('x', sfW - 2).attr('y', v => ys(v) + 14).attr('text-anchor', 'end').text('buoyant rod weight')
    }

    refresh = () => {
      drawDown(); drawSurf()
      const kk = k(), feat = cardFeatures(kk), cls = classifyCard(feat), top = cls[0]
      side.innerHTML = ''
      const ok = top.c === card
      side.append(
        h('span', { class: 'eyebrow' }, 'Automatic diagnosis'),
        h('div', { class: 'kpis' }, kpi('Classifier says', CARD_LABEL[top.c], `confidence ${pct(top.p)}`), kpi('Shown card', CARD_LABEL[card], ok ? '✓ correct' : '✗ misread')),
        ...(!ok ? [flag('The classifier misread this card — usually when noise is high or fillage is close to full.')] : []),
        h('div', { class: 'tablewrap' }, h('table', { class: 'data' }, h('tbody', {}, ...cls.map(c => h('tr', {},
          h('td', {}, CARD_LABEL[c.c]),
          h('td', { style: { width: '45%' } }, h('span', { class: 'bar-inline', style: { width: `${Math.round(c.p * 100)}%`, background: c.c === top.c ? 'var(--oil)' : 'var(--dim)' } })),
          h('td', { class: 'num' }, pct(c.p))))))),
        h('span', { class: 'eyebrow' }, 'Features read off the card'),
        h('div', { class: 'small', style: { lineHeight: 1.7 } },
          h('div', {}, `Pump fillage ${pct(feat.fill)} · load drop width ${pct(feat.drop)}`),
          h('div', {}, `Upstroke load pick-up at ${pct(feat.rise)} of stroke`),
          h('div', {}, `Load lost late in upstroke ${pct(feat.topLoss)} · fluid load on downstroke ${pct(feat.svCreep)}`)),
        h('span', { class: 'eyebrow' }, 'What to do'),
        h('div', { class: 'small muted', style: { lineHeight: 1.6 } }, CARD_ACTION[top.c]))
    }
    refresh()
  }

  build()
  return () => { charts.forEach(c => c.destroy()); clearInterval(playing); cancelAnimationFrame(raf) }
}
