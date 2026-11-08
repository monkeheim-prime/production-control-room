// Toolkit T4 — energy-transition wells: CO₂ injection into a depleted gas reservoir, and a geothermal producer with lithium.
import * as d3 from 'd3'
import type { Ctx } from '../main'
import { fmt } from '../core/units'
import { HYDRATE, injectionWell, PC, satCurve, TC, type WellInput, type WellResult } from '../analysis/co2'
import { geo, LCE_PER_LI, T_COND, WHP_MIN, type GeoInput } from '../analysis/geothermal'
import { axisStyle, drawIn, dur, grid, h, legend, panel, responsive, slider, tip, tipRows, type Frame } from '../ui/kit'

type Tab = 'co2' | 'geo'

const CO2_DEFAULT: WellInput = { rate: 1.0, whp: 60, wht: 10, pres: 40, depth: 2500, id: 4.9, grad: 3.5, tsurf: 20 }
const GEO_DEFAULT: GeoInput = { q: 60, tres: 140, tinj: 60, pi: 5, depth: 3000, eff: 0.6, li: 150, rec: 0.8, secondLaw: 0.5, uptime: 0.95 }

// Publicly reported injection scale (rounded; see Methods for sources).
const PROJECTS = [
  { name: 'Sleipner, Norway (since 1996)', short: 'Sleipner', v: 0.9 },
  { name: 'Quest, Canada (since 2015)', short: 'Quest', v: 1.0 },
  { name: 'Northern Lights phase 1 capacity', short: 'N. Lights 1', v: 1.5 },
]

const C = { sat: 'var(--ink-2)', hyd: 'var(--water)', path: 'var(--gas)', geo: 'var(--muted)', gross: 'var(--cat-stim)', pump: 'var(--cat-mech)', net: 'var(--ink-strong)', heat: 'var(--gas)', li: 'var(--cat-lift)' }

export function mountTransition(el: HTMLElement, { u }: Ctx) {
  let tab: Tab = 'co2'
  const co2 = { ...CO2_DEFAULT }
  const g0 = { ...GEO_DEFAULT }
  const field = u.sys === 'field'
  const tv = (c: number) => (field ? c * 1.8 + 32 : c)
  const dtv = (c: number) => (field ? c * 1.8 : c)
  const tU = field ? '°F' : '°C'
  const zv = (m: number) => (field ? m * 3.28084 : m)
  const zU = field ? 'ft' : 'm'
  const pS = (bar: number) => `${fmt(u.p(bar))} ${u.pU}`
  const tS = (c: number, d = 0) => `${fmt(tv(c), d)} ${tU}`

  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Well type' })
  const rail = h('aside', { class: 'rail', 'aria-label': 'Inputs' })
  const center = h('div', { class: 'center' })
  const card = h('aside', { class: 'rail right', 'aria-label': 'Results' })
  el.append(h('div', { class: 'cols chart-first' }, rail, center, card))

  let charts: { redraw: () => void; destroy: () => void }[] = []
  let raf = 0
  const changed = (fn: () => void) => { cancelAnimationFrame(raf); raf = requestAnimationFrame(fn) }

  function render() {
    charts.forEach(c => c.destroy()); charts = []
    rail.innerHTML = ''; center.innerHTML = ''; card.innerHTML = ''
    tabs.innerHTML = ''
    for (const [id, label] of [['co2', 'CO₂ injection well'], ['geo', 'Geothermal + lithium']] as [Tab, string][]) {
      tabs.append(h('button', { role: 'tab', 'aria-selected': String(tab === id), onclick: () => { if (tab !== id) { tab = id; render() } } }, label))
    }
    center.append(h('div', { class: 'row', style: { alignItems: 'center', flex: 'none' } },
      h('div', { style: { flex: '0 1 auto', minWidth: '0' } }, tabs),
      h('span', { class: 'small muted', style: { flex: '1 1 260px' } }, tab === 'co2'
        ? 'Dense CO₂ down the tubing, then expansion into a depleted gas reservoir: where does it cool, and does it reach hydrate conditions?'
        : 'A sedimentary-basin geothermal doublet: heat and power from the brine, minus the pumping cost, plus the lithium it carries.')))
    if (tab === 'co2') mountCO2(); else mountGeo()
  }

  // ===================================================== CO₂ =====================================================
  function mountCO2() {
    let r: WellResult = injectionWell(co2)
    const set = (k: keyof WellInput) => (v: number) => { co2[k] = v; changed(update) }
    rail.append(
      h('span', { class: 'eyebrow' }, 'Injection well'),
      slider('Injection rate', co2.rate, 0.2, 3, 0.1, v => `${v.toFixed(1)} Mt/yr`, set('rate')),
      slider('Wellhead pressure', co2.whp, 20, 120, 1, pS, set('whp')),
      slider('Wellhead temperature', co2.wht, 0, 40, 1, v => tS(v), set('wht')),
      slider('Reservoir pressure (depleted)', co2.pres, 30, 300, 5, pS, set('pres')),
      slider('Depth (vertical)', co2.depth, 1000, 4000, 100, v => `${fmt(zv(v))} ${zU}`, set('depth')),
      slider('Tubing ID', co2.id, 2.9, 8.5, 0.1, v => `${v.toFixed(1)} in`, set('id')),
      slider('Geothermal gradient', co2.grad, 2, 5, 0.1, v => `${fmt(dtv(v), 1)} ${tU}/100 m`, set('grad')),
      h('div', { class: 'small muted' }, `Pure CO₂, vertical well, steady state. Wellhead ambient ${tS(co2.tsurf)}. The pressure above reservoir pressure is assumed to be lost at the sandface (isenthalpic). See Methods.`))

    const phBox = h('div', { class: 'chart' }), pBox = h('div', { class: 'chart' }), tBox = h('div', { class: 'chart' }), sBox = h('div', { class: 'chart' })
    center.append(
      panel('Phase path — wellhead → bottomhole → sandface', legend([
        { label: 'saturation line', color: C.sat }, { label: 'hydrate line (approx.)', color: C.hyd, dash: true },
        { label: 'in tubing', color: C.path }, { label: 'expansion to reservoir', color: C.path, dash: true }]), phBox),
      h('div', { class: 'row' },
        h('div', { style: { flex: '1 1 240px', display: 'flex' } }, grow(panel('Pressure down the tubing', u.pU, pBox))),
        h('div', { style: { flex: '1 1 240px', display: 'flex' } }, grow(panel('Temperature down the tubing', legend([{ label: 'CO₂', color: C.path }, { label: 'formation', color: C.geo, dash: true }]), tBox))),
        h('div', { style: { flex: '1 1 260px', display: 'flex' } }, grow(panel('Scale', 'Mt CO₂ per year, publicly reported, rounded', sBox)))))

    charts = [
      responsive(phBox, w => (w < 600 ? 320 : 400), { t: 16, r: 18, b: 40, l: 56 }, (f, first) => drawPhase(f, first), 'CO₂ pressure–temperature phase diagram with the well path'),
      responsive(pBox, 230, { t: 10, r: 14, b: 36, l: 52 }, f => drawProfile(f, 'P')),
      responsive(tBox, 230, { t: 10, r: 14, b: 36, l: 52 }, f => drawProfile(f, 'T')),
      responsive(sBox, 230, { t: 10, r: 46, b: 24, l: 96 }, f => drawScale(f)),
    ]
    renderCard()

    function update() { r = injectionWell(co2); charts.forEach(c => c.redraw()); renderCard() }

    function drawPhase({ g, w: W, h: H }: Frame, first: boolean) {
      g.selectAll('*').remove()
      const pts = [...r.path.map(p => ({ T: p.T, P: p.P })), ...r.jt]
      const tmin = Math.min(-20, d3.min(pts, p => p.T)! - 5), tmax = Math.max(60, d3.max(pts, p => p.T)! + 5)
      const pmax = Math.max(120, d3.max(pts, p => p.P)! * 1.08)
      const xs = d3.scaleLinear().domain([tv(tmin), tv(tmax)]).range([0, W])
      const ys = d3.scaleLinear().domain([0, u.p(pmax)]).range([H, 0]).nice()
      const X = (t: number) => xs(tv(t)), Y = (p: number) => ys(u.p(p))
      grid(g, ys, W, 5)
      g.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(xs).ticks(W < 600 ? 5 : 8)).call(axisStyle)
      g.append('g').call(d3.axisLeft(ys).ticks(5).tickFormat(d3.format('~s'))).call(axisStyle)
      g.append('text').attr('class', 'lbl').attr('x', W / 2).attr('y', H + 34).attr('text-anchor', 'middle').text(`Temperature (${tU})`)
      g.append('text').attr('class', 'lbl').attr('transform', `translate(-44,${H / 2}) rotate(-90)`).attr('text-anchor', 'middle').text(`Pressure (${u.pU})`)
      const tcC = TC - 273.15
      // hydrate-stable region (left of the hydrate line, if free water is present)
      g.append('clipPath').attr('id', 'co2-clip').append('rect').attr('width', W).attr('height', H)
      const hyd = HYDRATE.filter(([, p]) => p <= pmax * 1.2)
      const area = [[tmin, hyd[0][1]] as [number, number], ...hyd, [hyd[hyd.length - 1][0], pmax * 3], [tmin, pmax * 3]]
      g.append('path').attr('d', d3.line<[number, number]>().x(d => X(d[0])).y(d => Y(d[1]))(area as [number, number][]))
        .attr('clip-path', 'url(#co2-clip)').attr('fill', C.hyd).attr('fill-opacity', 0.08).attr('stroke', 'none')
      g.append('path').attr('d', d3.line<[number, number]>().x(d => X(d[0])).y(d => Y(Math.min(d[1], pmax)))(hyd)).attr('fill', 'none').attr('stroke', C.hyd).attr('stroke-width', 2).attr('stroke-dasharray', '5 4')
      g.append('text').attr('class', 'lbl').attr('x', X(tmin) + 6).attr('y', 14).text(W < 600 ? 'hydrate zone' : 'hydrate-stable if free water (approx.)').attr('fill', C.hyd)
      // supercritical quadrant guides
      g.append('line').attr('x1', X(tcC)).attr('x2', X(tcC)).attr('y1', Y(PC)).attr('y2', Y(pmax)).attr('stroke', 'var(--line)').attr('stroke-dasharray', '2 3')
      g.append('line').attr('x1', X(tcC)).attr('x2', X(tmax)).attr('y1', Y(PC)).attr('y2', Y(PC)).attr('stroke', 'var(--line)').attr('stroke-dasharray', '2 3')
      const sat = satCurve(tmin)
      g.append('path').attr('d', d3.line<{ T: number; P: number }>().x(d => X(d.T)).y(d => Y(d.P))(sat)).attr('fill', 'none').attr('stroke', C.sat).attr('stroke-width', 2)
      g.append('circle').attr('cx', X(tcC)).attr('cy', Y(PC)).attr('r', 4).attr('fill', C.sat)
      g.append('text').attr('class', 'lbl').attr('x', X(tcC) + 7).attr('y', Y(PC) + 14).attr('text-anchor', W < 600 ? 'end' : 'start').attr('dx', W < 600 ? -14 : 0).text(W < 600 ? 'critical point' : `critical point ${tS(tcC, 1)}, ${pS(PC)}`)
      const regions: [string, number, number][] = [['LIQUID', tmin + (tcC - tmin) * 0.35, pmax * 0.55], ['GAS', tcC + (tmax - tcC) * 0.5, PC * 0.35], ['SUPERCRITICAL', tcC + (tmax - tcC) * 0.5, pmax * 0.9]]
      g.selectAll('text.reg').data(regions).join('text').attr('class', 'eyebrow reg').attr('x', d => X(d[1])).attr('y', d => Y(d[2])).attr('text-anchor', 'middle').attr('fill', 'var(--dim)').style('font-size', '10px').text(d => d[0])

      const line = d3.line<{ T: number; P: number }>().x(d => X(d.T)).y(d => Y(d.P))
      const tub = g.append('path').attr('d', line(r.path)).attr('fill', 'none').attr('stroke', C.path).attr('stroke-width', 2.5)
      const jt = g.append('path').attr('d', line(r.jt)).attr('fill', 'none').attr('stroke', C.path).attr('stroke-width', 2).attr('stroke-dasharray', '6 4')
      if (first) drawIn(tub, 1000)
      const wh = r.path[0], bh = r.path[r.path.length - 1], sf = r.jt[r.jt.length - 1]
      const marks: [string, { T: number; P: number }][] = [['WH', wh], ['BH', bh]]
      if (sf) marks.push(['SF', sf])
      g.selectAll('g.mk').data(marks).join('g').attr('class', 'mk').attr('transform', d => `translate(${X(d[1].T)},${Y(d[1].P)})`)
        .call(s => s.append('circle').attr('r', 5).attr('fill', 'var(--panel)').attr('stroke', C.path).attr('stroke-width', 2))
        .call(s => s.append('text').attr('class', 'lbl-mono').attr('x', 8).attr('y', -6).text(d => d[0]))
        .on('pointermove', (ev, d) => tip(tipRows({ WH: 'Wellhead', BH: 'Bottomhole (flowing)', SF: 'Sandface, after expansion' }[d[0]]!, [['Pressure', pS(d[1].P)], ['Temperature', tS(d[1].T, 1)]]), ev))
        .on('pointerleave', () => tip(null))
      // a CO₂ "parcel" travels the whole path
      const all = g.append('path').attr('d', line([...r.path, ...r.jt])).attr('fill', 'none').attr('stroke', 'none')
      const node = all.node()!
      const len = node.getTotalLength()
      const dot = g.append('circle').attr('r', 6).attr('fill', C.path).style('pointer-events', 'none')
      const end = node.getPointAtLength(len)
      dot.attr('cx', end.x).attr('cy', end.y)
      if (dur(1) && len > 0) {
        dot.transition().duration(2400).ease(d3.easeCubicInOut).attrTween('cx', () => t => String(node.getPointAtLength(t * len).x)).attrTween('cy', () => t => String(node.getPointAtLength(t * len).y))
      }
      void jt
    }

    function drawProfile({ g, w: W, h: H }: Frame, k: 'P' | 'T') {
      g.selectAll('*').remove()
      const ys = d3.scaleLinear().domain([0, zv(co2.depth)]).range([0, H])
      const geoT = (z: number) => co2.tsurf + co2.grad / 100 * z
      const vals = k === 'P' ? r.path.map(p => u.p(p.P)) : [...r.path.map(p => tv(p.T)), tv(geoT(co2.depth)), tv(co2.tsurf)]
      const xs = d3.scaleLinear().domain(k === 'P' ? [0, d3.max(vals)! * 1.05] : [Math.min(0, d3.min(vals)!), d3.max(vals)! * 1.05]).range([0, W]).nice()
      g.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(xs).ticks(W < 300 ? 3 : 5).tickFormat(d3.format('~s'))).call(axisStyle)
      g.append('g').call(d3.axisLeft(ys).ticks(5).tickFormat(d3.format('~s'))).call(axisStyle)
      g.append('text').attr('class', 'lbl').attr('transform', `translate(-40,${H / 2}) rotate(-90)`).attr('text-anchor', 'middle').text(`Depth (${zU})`)
      g.append('text').attr('class', 'lbl').attr('x', W).attr('y', H + 32).attr('text-anchor', 'end').text(k === 'P' ? `pressure (${u.pU})` : `temperature (${tU})`)
      if (k === 'T') {
        g.append('line').attr('x1', xs(tv(co2.tsurf))).attr('x2', xs(tv(geoT(co2.depth)))).attr('y1', 0).attr('y2', H).attr('stroke', C.geo).attr('stroke-dasharray', '5 4').attr('stroke-width', 1.5)
      } else {
        g.append('line').attr('x1', xs(u.p(co2.pres))).attr('x2', xs(u.p(co2.pres))).attr('y1', 0).attr('y2', H).attr('stroke', C.geo).attr('stroke-dasharray', '5 4')
        g.append('text').attr('class', 'lbl').attr('x', xs(u.p(co2.pres)) + 4).attr('y', 12).text('reservoir')
      }
      const val = (p: WellResult['path'][0]) => (k === 'P' ? u.p(p.P) : tv(p.T))
      g.append('path').attr('d', d3.line<WellResult['path'][0]>().x(p => xs(val(p))).y(p => ys(zv(p.z)))(r.path)).attr('fill', 'none').attr('stroke', C.path).attr('stroke-width', 2)
      // two-phase segments flagged on the profile
      g.selectAll('circle.tp').data(r.path.filter(p => p.phase === 'two-phase')).join('circle').attr('class', 'tp')
        .attr('cx', p => xs(val(p))).attr('cy', p => ys(zv(p.z))).attr('r', 2.5).attr('fill', 'var(--warn)')
      const hover = g.append('rect').attr('width', W).attr('height', H).attr('fill', 'transparent')
      hover.on('pointermove', ev => {
        const z = ys.invert(d3.pointer(ev)[1])
        const p = r.path[Math.max(0, Math.min(r.path.length - 1, Math.round(z / zv(co2.depth) * (r.path.length - 1))))]
        tip(tipRows(`${fmt(zv(p.z))} ${zU}`, [['Pressure', pS(p.P)], ['Temperature', tS(p.T, 1)], ['Density', `${fmt(p.rho)} kg/m³`], ['Phase', p.phase]]), ev)
      }).on('pointerleave', () => tip(null))
    }

    function drawScale({ g, w: W, h: H }: Frame) {
      g.selectAll('*').remove()
      const rows = [...PROJECTS, { name: 'This well', short: 'This well', v: co2.rate }]
      const ys = d3.scaleBand<string>().domain(rows.map(r => r.name)).range([0, H]).padding(0.35)
      const xs = d3.scaleLinear().domain([0, Math.max(3, co2.rate)]).range([0, W])
      g.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(xs).ticks(4)).call(axisStyle)
      g.selectAll('text.n').data(rows).join('text').attr('class', 'lbl n').attr('x', -8).attr('y', d => ys(d.name)! + ys.bandwidth() / 2 + 4).attr('text-anchor', 'end')
        .text(d => (W < 260 || d.name.length > 14 ? d.short : d.name)).attr('fill', d => (d.name === 'This well' ? 'var(--ink)' : null))
      g.selectAll('rect').data(rows).join('rect').attr('x', 0).attr('y', d => ys(d.name)!).attr('height', ys.bandwidth()).attr('rx', 2)
        .attr('fill', d => (d.name === 'This well' ? C.path : 'var(--dim)')).attr('width', d => xs(d.v))
      g.selectAll('text.v').data(rows).join('text').attr('class', 'lbl-mono v').attr('x', d => xs(d.v) + 5).attr('y', d => ys(d.name)! + ys.bandwidth() / 2 + 4).text(d => `${d.name === 'This well' ? '' : '~'}${d.v.toFixed(1)}`)
    }

    function renderCard() {
      card.innerHTML = ''
      const warn: string[] = []
      if (!r.canInject) warn.push(r.bhp <= 1.5 ? 'Friction exceeds the hydrostatic gain: this rate needs a higher wellhead pressure or a bigger tubing.' : 'Flowing bottomhole pressure is below reservoir pressure: no injection at these settings.')
      if (r.twoPhaseTubing) warn.push('Two-phase CO₂ in the tubing: unstable flow, density swings and noisy wellhead pressure.')
      if (r.hydrate) warn.push(`Sandface ${tS(r.sandT, 1)} is inside the hydrate zone at ${pS(co2.pres)} (approx. line). Risk if residual water is present.`)
      if (r.belowZero) warn.push('Sandface below 0 °C: risk of freezing residual water and thermal stress on the near-wellbore rock.')
      const kpi = (l: string, v: string, s?: string) => h('div', { class: 'kpi' }, h('div', { class: 'l' }, l), h('div', { class: 'v' }, v), s ? h('div', { class: 's' }, s) : null)
      card.append(
        h('span', { class: 'eyebrow' }, 'Result'),
        h('div', { class: 'kpis' },
          kpi('Flowing BHP', pS(r.bhp), `reservoir ${pS(co2.pres)}`),
          kpi('Bottomhole T', tS(r.tbh, 1), r.phaseBh),
          kpi('Sandface T', r.canInject ? tS(r.sandT, 1) : '—', r.canInject ? (r.sandPhase === 'two-phase' ? `two-phase, ${Math.round((r.sandQuality ?? 0) * 100)} % vapour` : r.sandPhase) : 'no injection'),
          kpi('ΔT expansion', r.canInject ? `${fmt(dtv(r.dTjt), 1)} ${tU}` : '—', 'Joule–Thomson'),
          kpi('Density at bottom', `${fmt(r.rhoBh)} kg/m³`, 'Peng–Robinson'),
          kpi('Velocity at bottom', `${fmt(r.vel, 1)} m/s`, `${fmt(r.mdot, 1)} kg/s`)),
        h('span', { class: 'eyebrow' }, 'Flags'),
        ...(warn.length ? warn.map(t => h('div', { class: 'small', style: { color: 'var(--warn)', lineHeight: 1.5 } }, '▲ ', t))
          : [h('div', { class: 'small muted' }, '● No phase, hydrate or freezing flags at these inputs.')]),
        h('div', { class: 'small muted', style: { lineHeight: 1.6 } },
          'Why it matters: a depleted gas field has low reservoir pressure. The dense CO₂ column arrives at the bottom far above that pressure, and the excess is lost as the CO₂ expands into the rock. Expansion cools it (Joule–Thomson); if it drops into the two-phase region the temperature falls to the boiling point at reservoir pressure. Raise reservoir pressure or wellhead temperature to see the risk go away.'))
    }
  }

  // ===================================================== Geothermal =====================================================
  function mountGeo() {
    let r = geo(g0)
    const set = (k: keyof GeoInput, scale = 1) => (v: number) => { (g0 as any)[k] = v * scale; changed(update) }
    rail.append(
      h('span', { class: 'eyebrow' }, 'Producer'),
      slider('Flow rate', g0.q, 10, 200, 5, v => `${v} L/s`, set('q')),
      slider('Production temperature', g0.tres, 110, 170, 1, v => tS(v), set('tres')),
      slider('Reinjection temperature', g0.tinj, 40, 90, 1, v => tS(v), set('tinj')),
      slider('Productivity index', g0.pi, 1, 20, 0.5, v => `${v} L/s/bar`, set('pi')),
      slider('Well depth', g0.depth, 1500, 5000, 100, v => `${fmt(zv(v))} ${zU}`, set('depth')),
      slider('Pump efficiency', g0.eff * 100, 40, 75, 1, v => `${v} %`, set('eff', 0.01)),
      h('span', { class: 'eyebrow' }, 'Lithium in the brine'),
      slider('Li concentration', g0.li, 0, 400, 10, v => `${v} mg/L`, set('li')),
      slider('Li recovery', g0.rec * 100, 30, 95, 1, v => `${v} %`, set('rec', 0.01)),
      h('div', { class: 'small muted' }, `Brine 1080 kg/m³, cp 3.8 kJ/kg·K. ORC at ${g0.secondLaw * 100} % of Carnot, condensing at ${tS(T_COND)}. Injectivity = productivity. ${Math.round(g0.uptime * 100)} % uptime. All assumed — see Methods.`))

    const pwBox = h('div', { class: 'chart' }), heatBox = h('div', { class: 'chart' }), liBox = h('div', { class: 'chart' })
    center.append(
      panel('Electric power vs flow rate', legend([{ label: 'gross ORC', color: C.gross }, { label: 'pumps', color: C.pump }, { label: 'net', color: C.net }]), pwBox),
      h('div', { class: 'row' },
        h('div', { style: { flex: '1 1 280px', display: 'flex' } }, grow(panel('Heat extracted vs flow rate', 'MWth', heatBox))),
        h('div', { style: { flex: '1 1 280px', display: 'flex' } }, grow(panel('Lithium carbonate equivalent', 't LCE / yr vs Li concentration', liBox)))))
    charts = [
      responsive(pwBox, w => (w < 600 ? 280 : 340), { t: 16, r: 20, b: 40, l: 52 }, (f, first) => drawPower(f, first), 'Gross, pump and net electric power versus flow rate'),
      responsive(heatBox, 220, { t: 12, r: 16, b: 36, l: 48 }, f => drawHeat(f)),
      responsive(liBox, 220, { t: 12, r: 16, b: 36, l: 52 }, f => drawLi(f)),
    ]
    renderCard()

    function update() { r = geo(g0); charts.forEach(c => c.redraw()); renderCard() }

    function curve(qmax: number) { return d3.range(0, qmax + 0.01, qmax / 120).map(q => ({ q, ...geo({ ...g0, q: Math.max(q, 0.01) }) })) }
    function optimum() {
      const pts = curve(600)
      return pts.reduce((a, b) => (b.net > a.net ? b : a))
    }

    function drawPower({ g, w: W, h: H }: Frame, first: boolean) {
      g.selectAll('*').remove()
      const opt = optimum()
      const qmax = Math.max(200, Math.min(400, opt.q * 1.3))
      const pts = curve(qmax)
      const xs = d3.scaleLinear().domain([0, qmax]).range([0, W])
      const ymax = d3.max(pts, p => Math.max(p.gross, p.pump))!
      const ymin = Math.min(0, d3.min(pts, p => p.net)!)
      const ys = d3.scaleLinear().domain([Math.max(ymin, -ymax), ymax * 1.08]).range([H, 0]).nice()
      grid(g, ys, W, 5)
      g.append('g').attr('transform', `translate(0,${ys(0)})`).call(d3.axisBottom(xs).ticks(W < 600 ? 4 : 8).tickFormat(() => '')).call(axisStyle)
      g.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(xs).ticks(W < 600 ? 4 : 8)).call(axisStyle)
      g.append('g').call(d3.axisLeft(ys).ticks(5)).call(axisStyle)
      g.append('text').attr('class', 'lbl').attr('x', W / 2).attr('y', H + 34).attr('text-anchor', 'middle').text('Flow rate (L/s)')
      g.append('text').attr('class', 'lbl').attr('transform', `translate(-38,${H / 2}) rotate(-90)`).attr('text-anchor', 'middle').text('MWe')
      if (opt.q < qmax) {
        g.append('line').attr('x1', xs(opt.q)).attr('x2', xs(opt.q)).attr('y1', ys(opt.net)).attr('y2', H).attr('stroke', 'var(--line)').attr('stroke-dasharray', '3 3')
        g.append('text').attr('class', 'lbl').attr('x', xs(opt.q)).attr('y', ys(opt.net) - 10).attr('text-anchor', opt.q > qmax * 0.8 ? 'end' : 'middle').text(`net optimum ${Math.round(opt.q)} L/s`)
      }
      const keys: ['gross' | 'pump' | 'net', string][] = [['gross', C.gross], ['pump', C.pump], ['net', C.net]]
      keys.forEach(([k, c], i) => {
        const p = g.append('path').datum(pts).attr('d', d3.line<typeof pts[0]>().x(d => xs(d.q)).y(d => ys(d[k]))).attr('fill', 'none').attr('stroke', c).attr('stroke-width', k === 'net' ? 2.5 : 2)
        if (first) drawIn(p, 1000, i * 150)
      })
      const op = g.append('g').attr('transform', `translate(${xs(g0.q)},${ys(r.net)})`)
      op.append('circle').attr('r', 6).attr('fill', 'var(--panel)').attr('stroke', C.net).attr('stroke-width', 2.5)
      op.append('text').attr('class', 'lbl-mono').attr('x', xs(g0.q) > W - 90 ? -10 : 10).attr('text-anchor', xs(g0.q) > W - 90 ? 'end' : 'start').attr('y', 16).text(`${fmt(r.net, 2)} MWe`)
      // crosshair tooltip
      const cross = g.append('line').attr('y1', 0).attr('y2', H).attr('stroke', 'var(--muted)').attr('opacity', 0)
      g.append('rect').attr('width', W).attr('height', H).attr('fill', 'transparent')
        .on('pointermove', ev => {
          const q = Math.max(0, Math.min(qmax, xs.invert(d3.pointer(ev)[0])))
          const p = geo({ ...g0, q: Math.max(q, 0.01) })
          cross.attr('x1', xs(q)).attr('x2', xs(q)).attr('opacity', 0.6)
          tip(tipRows(`${Math.round(q)} L/s`, [['Thermal', `${fmt(p.thermal, 1)} MWth`], ['Gross ORC', `${fmt(p.gross, 2)} MWe`], ['Pumps', `${fmt(p.pump, 2)} MW`], ['Net', `${fmt(p.net, 2)} MWe`], ['Pump Δp', pS(p.dp)]]), ev)
        })
        .on('pointerleave', () => { cross.attr('opacity', 0); tip(null) })
    }

    function drawHeat({ g, w: W, h: H }: Frame) {
      g.selectAll('*').remove()
      const pts = curve(200)
      const xs = d3.scaleLinear().domain([0, 200]).range([0, W])
      const ys = d3.scaleLinear().domain([0, d3.max(pts, p => p.thermal)! * 1.05]).range([H, 0]).nice()
      grid(g, ys, W, 4)
      g.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(xs).ticks(4)).call(axisStyle)
      g.append('g').call(d3.axisLeft(ys).ticks(4)).call(axisStyle)
      g.append('text').attr('class', 'lbl').attr('x', W).attr('y', H + 32).attr('text-anchor', 'end').text('L/s')
      g.append('path').datum(pts).attr('d', d3.line<typeof pts[0]>().x(d => xs(d.q)).y(d => ys(d.thermal))).attr('fill', 'none').attr('stroke', C.heat).attr('stroke-width', 2)
      g.append('circle').attr('cx', xs(g0.q)).attr('cy', ys(r.thermal)).attr('r', 5).attr('fill', 'var(--panel)').attr('stroke', C.heat).attr('stroke-width', 2)
      g.append('text').attr('class', 'lbl-mono').attr('x', xs(g0.q) + (xs(g0.q) > W - 80 ? -8 : 8)).attr('text-anchor', xs(g0.q) > W - 80 ? 'end' : 'start').attr('y', ys(r.thermal) + (xs(g0.q) > W - 80 ? 16 : -6)).text(`${fmt(r.thermal, 1)} MWth`)
    }

    function drawLi({ g, w: W, h: H }: Frame) {
      g.selectAll('*').remove()
      const pts = d3.range(0, 401, 10).map(li => ({ li, lce: geo({ ...g0, li }).lce }))
      const xs = d3.scaleLinear().domain([0, 400]).range([0, W])
      const ys = d3.scaleLinear().domain([0, Math.max(100, d3.max(pts, p => p.lce)! * 1.05)]).range([H, 0]).nice()
      grid(g, ys, W, 4)
      g.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(xs).ticks(4)).call(axisStyle)
      g.append('g').call(d3.axisLeft(ys).ticks(4).tickFormat(d3.format('~s'))).call(axisStyle)
      g.append('text').attr('class', 'lbl').attr('x', W).attr('y', H + 32).attr('text-anchor', 'end').text('Li mg/L')
      g.append('path').datum(pts).attr('d', d3.line<typeof pts[0]>().x(d => xs(d.li)).y(d => ys(d.lce))).attr('fill', 'none').attr('stroke', C.li).attr('stroke-width', 2)
      const x0 = xs(g0.li), right = x0 > W - 90
      g.append('circle').attr('cx', x0).attr('cy', ys(r.lce)).attr('r', 5).attr('fill', 'var(--panel)').attr('stroke', C.li).attr('stroke-width', 2)
      g.append('text').attr('class', 'lbl-mono').attr('x', x0 + (right ? -8 : 8)).attr('text-anchor', right ? 'end' : 'start').attr('y', ys(r.lce) + (right ? 16 : -6)).text(`${fmt(r.lce)} t`)
    }

    function renderCard() {
      card.innerHTML = ''
      const opt = optimum()
      const kpi = (l: string, v: string, s?: string) => h('div', { class: 'kpi' }, h('div', { class: 'l' }, l), h('div', { class: 'v' }, v), s ? h('div', { class: 's' }, s) : null)
      const flags: string[] = []
      if (r.net <= 0) flags.push('Pumps use more power than the ORC makes: sell the heat instead, or improve productivity.')
      if (g0.q > 150) flags.push('Above ~150 L/s is beyond a typical single line-shaft or electric submersible pump; expect two producers.')
      if (g0.tres - g0.tinj < 30) flags.push('Small temperature drop: little heat per litre, poor economics.')
      card.append(
        h('span', { class: 'eyebrow' }, 'Result'),
        h('div', { class: 'kpis' },
          kpi('Heat extracted', `${fmt(r.thermal, 1)} MWth`, `${fmt(r.heatGWh)} GWh/yr if sold as heat`),
          kpi('Net electric', `${fmt(r.net, 2)} MWe`, `${fmt(r.elecGWh, 1)} GWh/yr`),
          kpi('Gross ORC', `${fmt(r.gross, 2)} MWe`, `efficiency ${fmt(r.eta * 100, 1)} %`),
          kpi('Pumps', `${fmt(r.pump, 2)} MW`, `Δp ${pS(r.dp)} total`),
          kpi('Lithium metal', `${fmt(r.li)} t`, `per year · × ${LCE_PER_LI} → LCE`),
          kpi('Lithium carbonate eq.', `${fmt(r.lce)} t`, `per year · ${g0.li} mg/L, ${Math.round(g0.rec * 100)} % rec.`)),
        h('div', { class: 'small muted', style: { lineHeight: 1.6 } },
          opt.q >= 599 ? 'Net power still rising at 600 L/s: flow is limited by pump and well size, not by pumping cost.' : `Net power peaks at about ${Math.round(opt.q)} L/s (${fmt(opt.net, 2)} MWe). Beyond that, extra pumping costs more than the extra heat earns.`),
        ...(flags.length ? flags.map(t => h('div', { class: 'small', style: { color: 'var(--warn)', lineHeight: 1.5 } }, '▲ ', t)) : []),
        h('div', { class: 'small muted', style: { lineHeight: 1.6 } },
          `Why it matters: in a 110–170 °C sedimentary basin the power plant is small and the pumps take a real share of it, so productivity index decides the project. The same brine can carry lithium; at ${g0.li} mg/L every litre per second is worth about ${fmt(r.lce / g0.q)} t of lithium carbonate a year.`))
    }
  }

  render()
  return () => { cancelAnimationFrame(raf); charts.forEach(c => c.destroy()); tip(null) }
}

function grow(p: HTMLElement) { p.style.flex = '1 1 auto'; return p }

export const METHODS = `
<h2>CO₂ injection well and geothermal producer</h2>
<p>Illustrative physics models with generic inputs. They do not use the Volve or Field X data. Every input is a slider; every constant is listed here.</p>
<h3>CO₂ properties — Peng–Robinson (1976)</h3>
<div class="eq">P = RT/(v − b) − a·α(T) / (v² + 2bv − b²)
a = 0.45724 R²Tc²/Pc     b = 0.07780 R Tc/Pc
α = [1 + κ(1 − √(T/Tc))]²,  κ = 0.37464 + 1.54226ω − 0.26992ω²
Tc = 304.13 K, Pc = 73.77 bar, ω = 0.225, M = 44.01 g/mol</div>
<p>Root choice: below Tc the liquid or vapour root is picked by comparing P with the Span &amp; Wagner vapour pressure; above Tc, the lower-Gibbs root. Check: at 100 bar and 40 °C PR gives about 563 kg/m³ against about 630 kg/m³ from the reference equation of state, so dense-phase densities are roughly 10 % low (a known PR weakness near the critical point). At 200 bar and 25 °C PR gives about 920 kg/m³ (reference ≈ 940).</p>
<div class="eq">h = h_ig(T) + R T (Z − 1) + (T·da/dT − a)/(2√2 b) · ln[(Z + (1+√2)B)/(Z + (1−√2)B)]
h_ig from the NIST Shomate equation for CO₂ (A–E = 24.997, 55.187, −33.691, 7.948, −0.1366;
valid 298–1200 K, extrapolated slightly below 298 K)</div>
<h3>Saturation line — Span &amp; Wagner (1996) ancillary equation</h3>
<div class="eq">ln(p_s/p_c) = (T_c/T)·[−7.0602087ϑ + 1.9391218ϑ^1.5 − 1.6463597ϑ² − 3.2995634ϑ⁴],  ϑ = 1 − T/T_c
T_c = 304.1282 K, p_c = 73.773 bar</div>
<h3>Wellbore (vertical, steady state, 120 steps)</h3>
<div class="eq">dP/dz = ρ g − f ρ v² / (2 d)                 (downward flow; Haaland friction factor, ε = 0.045 mm)
dh/dz = g + c_p (T_geo − T) / A               (potential energy + heat from the rock)
A     = ṁ c_p f(t) / (2π λ),  λ = 2 W/m·K,  f(t) = 3   (Ramey 1962 relaxation length, ~1 year of injection)
μ     ≈ 1.5·10⁻⁵ + 9.5·10⁻⁸ ρ  Pa·s              (simple density fit, about ±30 %)</div>
<p>T is recovered from (P, h). If h falls between the saturated-liquid and saturated-vapour enthalpies the fluid is two-phase at T_sat with quality x, and mixture density is homogeneous.</p>
<h3>Expansion into the reservoir</h3>
<p>The flowing bottomhole pressure above reservoir pressure is assumed to be lost across the sandface and near-wellbore region at constant enthalpy (Joule–Thomson). The sandface temperature solves h(P_res, T) = h_BH. If the expansion enters the two-phase region, temperature is pinned to T_sat(P_res). This is the main cooling risk when injecting into depleted gas fields.</p>
<h3>Hydrate line (approximate)</h3>
<p>CO₂–water hydrate equilibrium points read from the compilation in Sloan &amp; Koh (2008), with the upper quadruple point near 9.8 °C / 45 bar and a near-vertical line above it. Used only as a screening line, assuming free water is present.</p>
<h3>Scale references (rounded, public)</h3>
<p>Sleipner (Norway): about 0.9 Mt CO₂/yr injected since 1996 (Equinor). Quest (Alberta, Canada): about 1 Mt/yr since 2015 (Shell / Government of Alberta reports). Northern Lights phase 1 (Norway): 1.5 Mt/yr capacity (Northern Lights JV).</p>
<h3>Geothermal producer</h3>
<div class="eq">Q_th  = ρ c_p q (T_prod − T_inj)                      ρ = 1080 kg/m³, c_p = 3.8 kJ/kg·K (saline brine, assumed)
η_ORC = 0.5 · (1 − T_cond / T_m),  T_m = (T_prod − T_inj) / ln(T_prod/T_inj)   (kelvin; T_cond = ${T_COND} °C)
Δp    = 2 q / PI + 2 Δp_friction + ${WHP_MIN} bar                 (producer drawdown + injector, II = PI; 0.2 m ID string)
P_pump = q Δp / η_pump          P_net = η_ORC Q_th − P_pump</div>
<p>The ORC is taken as 50 % of the Carnot efficiency between the log-mean heat-source temperature and the condenser, in line with the second-law efficiencies of binary plants reviewed by DiPippo (2004, 2016). Static water level is assumed at surface (no artesian flow). Heat losses up the well are ignored.</p>
<h3>Lithium</h3>
<div class="eq">Li  [t/yr] = q [L/s] · c_Li [mg/L] · recovery · uptime · 3.156·10⁷ s / 10⁹
LCE [t/yr] = 5.323 · Li                                  (M Li₂CO₃ / (2·M Li) = 73.89 / 13.88)</div>
<h3>References</h3>
<ul>
<li>Peng, D.-Y., Robinson, D.B. (1976). A new two-constant equation of state. Ind. Eng. Chem. Fundam. 15(1).</li>
<li>Span, R., Wagner, W. (1996). A new equation of state for carbon dioxide… J. Phys. Chem. Ref. Data 25(6).</li>
<li>NIST Chemistry WebBook, CO₂ gas-phase heat capacity (Shomate equation).</li>
<li>Ramey, H.J. (1962). Wellbore heat transmission. JPT 14(4).</li>
<li>Haaland, S.E. (1983). Simple and explicit formulas for the friction factor in turbulent pipe flow. J. Fluids Eng. 105.</li>
<li>Sloan, E.D., Koh, C.A. (2008). Clathrate Hydrates of Natural Gases, 3rd ed. CRC Press.</li>
<li>DiPippo, R. (2004). Second law assessment of binary plants generating power from low-temperature geothermal fluids. Geothermics 33.</li>
</ul>`
