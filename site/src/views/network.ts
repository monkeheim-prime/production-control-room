// Toolkit T7 — surface network debottlenecking: facility constraints, choke-back allocation, what-ifs.
import * as d3 from 'd3'
import type { Ctx } from '../main'
import { fmtMonth } from '../core/data'
import { go, state } from '../core/state'
import { fmt, pct } from '../core/units'
import {
  allocate, buildNetwork, CON_LABEL, defaultCaps, fieldHistory, whatIfs, WSO_WATER_CUT,
  type Alloc, type Caps, type ConKey, type Rule,
} from '../analysis/network'
import { axisStyle, dur, grid, h, legend, panel, responsive, slider, tip, tipRows, type Frame } from '../ui/kit'

export const METHODS = `
<h2>Network — debottlenecking</h2>
<h3>Network model</h3>
<p>Every flowing producer is a source at its <em>potential</em>: the 3-month trailing average oil, water and gas rate at the latest month (the same numbers as Screen). Field X wells gather by reservoir block into one manifold and flowline each (A, B, C); Volve wells share one manifold. All manifolds feed one separator, which sends oil to export, gas to compression and water to treatment, then reinjection (current injector rates) or overboard. Pressure interaction between wells in the gathering system is not modelled: each well is assumed to deliver its potential unless choked.</p>
<h3>Constraints</h3>
<p>Choking well <em>i</em> back to a fraction f<sub>i</sub> of its potential scales its oil, water and gas together (constant water cut and GOR over the choke range — a simplification). The facility capacities are linear constraints:</p>
<div class="eq">Σ f_i · q_w,i        ≤ C_water        water treatment
Σ f_i · q_l,i        ≤ C_liquid       separator liquid
Σ f_i · q_g,i        ≤ C_gas          gas compression (formation gas; lift gas not counted)
Σ f_i · q_o,i        ≤ C_export       oil export
Σ_(i∈m) f_i · q_l,i  ≤ C_line         flowline of manifold m
0 ≤ f_i ≤ 1</div>
<p>Default capacities are illustrative, set relative to today's potential so that water handling binds (water 85 %, liquid 104 %, gas 115 %, export 125 % of potential; flowline 115 % of the largest manifold). That is the typical late-life situation in a waterflooded field.</p>
<h3>Allocation rules</h3>
<p><strong>Optimised</strong>: maximise Σ f<sub>i</sub>·q<sub>o,i</sub> subject to all constraints — a linear programme, solved exactly with a dense simplex method (Bland's anti-cycling rule). When a single constraint binds, the LP solution is the greedy rule: keep wells in order of oil per unit of the scarce resource and choke the last one partly. For water that ratio is (1 − WC)/WC, so the highest water-cut wells are choked first. With two or more binding constraints the greedy rule is no longer optimal, which is why an LP is used.</p>
<p><strong>Pro-rata</strong>: each manifold is cut by one factor to fit its flowline, then every well by a single field factor so that all facility limits hold. It is what happens when operators trim everything equally; the gap to Optimised is the value of choking the right wells.</p>
<h3>What-if debottlenecks</h3>
<p>Each case re-solves the allocation with one change and reports the oil gain against the base case under the selected rule: +X % on a capacity; shutting in the top-N water-cut wells; or executing the water shut-off jobs proposed by the review (Diagnose → Evaluate), applied risked: oil + P(s)·gain, water × (1 − ${WSO_WATER_CUT}·P(s)) — the water reduction is an assumption. The marginal value of water capacity is the oil gained per extra unit of water handling (finite difference, +1 %).</p>
<h3>History</h3>
<p>Field oil and water by month, against today's water-handling capacity: the month the field water rate first exceeded it marks when the present limit would have started to bind.</p>`

const SHORT: Record<ConKey, string> = { wat: 'Water', liq: 'Liquid', gas: 'Gas', oil: 'Export', line: 'Flowline' }
const ORDER: ConKey[] = ['wat', 'liq', 'gas', 'oil', 'line']

export function mountNetwork(el: HTMLElement, { ds, u }: Ctx) {
  const net = buildNetwork(ds, state.a)
  if (!net.wells.length) {
    el.append(h('div', { class: 'empty', style: { margin: '20px' } }, 'No producers are flowing at the latest month, so there is no network to allocate.'))
    return
  }
  const def = defaultCaps(net)
  let caps: Caps = { ...def }
  let rule: Rule = 'opt'
  let pctUp = 20, topN = 3
  let alloc: Alloc, other: Alloc

  const L = u.liq(1), G = u.gas(1)
  const step = (span: number) => { const s = 10 ** Math.floor(Math.log10(span / 200)); return span / 200 / s > 5 ? 5 * s : span / 200 / s > 2 ? 2 * s : s }

  const rail = h('aside', { class: 'rail', 'aria-label': 'Facility capacities' })
  const center = h('div', { class: 'center' })
  const card = h('aside', { class: 'rail right', 'aria-label': 'Network result' })
  el.append(h('div', { class: 'cols chart-first' }, rail, center, card))

  let raf = 0
  const changed = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { compute(); redrawAll() }) }

  type Cap = { key: keyof Caps; label: string; gas?: boolean; lo: number; hi: number }
  const CAPS: Cap[] = [
    { key: 'wat', label: 'Water handling', lo: 0.3 * net.pot.wat, hi: 1.6 * net.pot.wat },
    { key: 'liq', label: 'Separator liquid', lo: 0.4 * net.pot.liq, hi: 1.6 * net.pot.liq },
    { key: 'gas', label: 'Gas compression', gas: true, lo: 0.3 * net.pot.gas, hi: 1.8 * net.pot.gas },
    { key: 'oil', label: 'Oil export', lo: 0.4 * net.pot.oil, hi: 1.8 * net.pot.oil },
    { key: 'line', label: net.manifolds.length > 1 ? 'Flowline (each manifold)' : 'Flowline', lo: 0.3 * def.line, hi: 1.6 * def.line },
  ]
  const inputs: { c: Cap; input: HTMLInputElement }[] = []
  const capSliders = CAPS.map(c => {
    const k = c.gas ? G : L, unit = c.gas ? u.gasU : u.liqU
    const s = step((c.hi - c.lo) * k)
    const r = (v: number) => Math.round(v / s) * s
    const el = slider(c.label, r(caps[c.key] * k), r(c.lo * k), r(c.hi * k), s, v => `${fmt(v)} ${unit}`, v => { caps = { ...caps, [c.key]: v / k }; changed() })
    inputs.push({ c, input: el.querySelector('input') as HTMLInputElement })
    return el
  })
  const ruleSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Choke-back rule' },
    ...([['opt', 'Optimised (LP)'], ['pro', 'Pro-rata']] as [Rule, string][]).map(([r, l]) =>
      h('button', { 'aria-pressed': String(r === rule), 'data-r': r, onclick: () => setRule(r) }, l)))
  function setRule(r: Rule) {
    rule = r
    ruleSeg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.getAttribute('data-r') === r)))
    changed()
  }
  const reset = () => {
    for (const { c, input } of inputs) { input.value = String(def[c.key] * (c.gas ? G : L)); input.dispatchEvent(new Event('input')) }
  }
  rail.append(
    h('span', { class: 'eyebrow' }, 'Choke-back rule'),
    ruleSeg,
    h('div', { class: 'small muted', style: { lineHeight: 1.5 } },
      'Optimised keeps the most oil per unit of the scarce capacity — with water binding, the highest water-cut wells are choked first. Pro-rata trims every well equally.'),
    h('span', { class: 'eyebrow' }, 'Facility capacity'),
    ...capSliders,
    h('button', { class: 'btn', onclick: reset }, 'Reset to defaults'),
    h('span', { class: 'eyebrow' }, 'What-if'),
    slider('Capacity increase tested', pctUp, 5, 50, 5, v => `+${v} %`, v => { pctUp = v; changed() }),
    slider('Water wells to shut in', topN, 1, Math.min(8, net.wells.length), 1, v => `${v}`, v => { topN = v; changed() }),
    h('div', { class: 'small muted', style: { lineHeight: 1.5 } },
      `Default capacities are illustrative, set so water handling binds — the usual late-life limit. Well potentials are the latest 3-month rates${ds.real ? '' : ' of synthetic Field X'}.`))

  const schemBox = h('div', { class: 'chart' }), utilBox = h('div', { class: 'chart' }), histBox = h('div', { class: 'chart' })
  const wiBody = h('tbody')
  center.append(
    panel('Network — wells → manifolds → separator → outlets', legend([
      { label: 'oil', color: 'var(--oil)' }, { label: 'water', color: 'var(--water)' }, { label: 'gas', color: 'var(--gas)' }, { label: 'choked well', color: 'var(--warn)' }]), schemBox),
    h('div', { class: 'row' },
      h('div', { style: { flex: '1 1 320px', display: 'flex' } }, panel('Facility utilisation', legend([{ label: 'allocated', color: 'var(--ink-2)' }, { label: 'unconstrained demand', color: 'var(--muted)', hollow: true }]), utilBox)),
      h('div', { style: { flex: '1.4 1 380px', display: 'flex' } }, panel('Field history vs today\'s water capacity', legend([{ label: 'oil', color: 'var(--oil)' }, { label: 'water', color: 'var(--water)' }, { label: 'water capacity', color: 'var(--warn)', dash: true }]), histBox))),
    panel('What-if — which debottleneck is worth most?', 'oil gain vs base case, same rule',
      h('div', { class: 'tablewrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Change'), h('th', { class: 'num' }, `Oil gain (${u.liqU})`), h('th', {}, ''), h('th', {}, 'Detail'))), wiBody))))

  function compute() {
    alloc = allocate(net, caps, rule)
    other = allocate(net, caps, rule === 'opt' ? 'pro' : 'opt')
  }
  compute()
  const hist = fieldHistory(ds)

  const charts = [
    responsive(schemBox, w => Math.max(300, net.wells.length * (w < 600 ? 13 : 16) + 50), { t: 10, r: 4, b: 10, l: 4 }, f => drawSchematic(f), 'Animated network schematic'),
    responsive(utilBox, 200, { t: 8, r: 46, b: 26, l: 70 }, f => drawUtil(f), 'Facility utilisation bars'),
    responsive(histBox, 200, { t: 14, r: 12, b: 26, l: 50 }, f => drawHist(f), 'Field oil and water history'),
  ]
  function redrawAll() { charts.forEach(c => c.redraw()); renderTable(); renderCard() }

  // ---------- particles: one timer moves every striped flow path ----------
  const timer = dur(1) ? d3.timer(ms => {
    schemBox.querySelectorAll<SVGPathElement>('path.flow').forEach(p => {
      const sp = +(p.dataset.speed ?? 0), per = +(p.dataset.per ?? 14), o = +(p.dataset.off ?? 0)
      p.setAttribute('stroke-dashoffset', String(o - ((ms / 1000) * sp) % per))
    })
  }) : null

  // ---------- schematic ----------
  function drawSchematic({ g, w: W, h: H }: Frame) {
    g.selectAll('*').remove()
    const narrow = W < 600
    const rowH = narrow ? 13 : 16
    const xW = narrow ? 44 : 64, xM = W * (narrow ? 0.36 : 0.36), xS = W * (narrow ? 0.56 : 0.58)
    const boxW = narrow ? 92 : 176, xO = W - boxW
    const top = 18
    const wy = new Map(net.wells.map((w, i) => [w.id, top + i * rowH + rowH / 2]))
    const my = new Map(net.manifolds.map(m => [m.id, d3.mean(m.wells, id => wy.get(id)!)!]))
    const sy = H / 2
    const oy = { oil: H * 0.17, gas: H * 0.5, wat: H * 0.83 }
    const link = d3.linkHorizontal<{ source: [number, number]; target: [number, number] }, [number, number]>()
    const maxWellLiq = d3.max(net.wells, w => w.liq) || 1
    const wS = d3.scaleSqrt().domain([0, maxWellLiq]).range([0.8, narrow ? 4 : 6])
    const mS = d3.scaleSqrt().domain([0, net.pot.liq || 1]).range([1.5, narrow ? 9 : 14])
    const spd = (r: number, max: number) => 8 + 46 * Math.min(1, r / (max || 1))

    // striped flow: a base path plus one dashed overlay per phase, dash lengths ∝ phase share
    const flow = (d: string, width: number, parts: { c: string; v: number }[], speed: number, opacity = 1) => {
      const tot = d3.sum(parts, p => p.v)
      g.append('path').attr('d', d).attr('fill', 'none').attr('stroke', 'var(--panel-3)').attr('stroke-width', width + 2).attr('opacity', opacity)
      if (tot <= 0) return
      const per = 16
      let off = 0
      for (const p of parts) {
        const len = (per * p.v) / tot
        if (len < 0.3) continue
        g.append('path').attr('class', 'flow').attr('d', d).attr('fill', 'none').attr('stroke', p.c).attr('stroke-width', width)
          .attr('stroke-dasharray', `${len} ${per - len}`).attr('stroke-dashoffset', -off).attr('opacity', opacity)
          .attr('data-speed', speed).attr('data-per', per).attr('data-off', -off)
        off += len
      }
    }

    // wells → manifolds
    for (const w of net.wells) {
      const k = alloc.f.get(w.id) ?? 1
      const y = wy.get(w.id)!, ym = my.get(w.man)!
      flow(link({ source: [xW + 6, y], target: [xM - 6, ym] })!, wS(w.liq * k), [{ c: 'var(--oil)', v: w.oil * k }, { c: 'var(--water)', v: w.wat * k }], spd(w.liq * k, maxWellLiq), k < 0.02 ? 0.25 : 1)
    }
    // manifolds → separator
    for (const m of net.manifolds) {
      const ws = net.wells.filter(w => w.man === m.id)
      const oil = d3.sum(ws, w => w.oil * (alloc.f.get(w.id) ?? 1)), wat = d3.sum(ws, w => w.wat * (alloc.f.get(w.id) ?? 1))
      flow(link({ source: [xM + 6, my.get(m.id)!], target: [xS - (narrow ? 26 : 40), sy] })!, mS(oil + wat), [{ c: 'var(--oil)', v: oil }, { c: 'var(--water)', v: wat }], spd(oil + wat, net.pot.liq))
    }
    // separator → outlets
    const sepR = xS + (narrow ? 26 : 40)
    flow(link({ source: [sepR, sy - 6], target: [xO, oy.oil] })!, mS(alloc.oil), [{ c: 'var(--oil)', v: alloc.oil }], spd(alloc.oil, net.pot.liq))
    flow(link({ source: [sepR, sy], target: [xO, oy.gas] })!, Math.max(1.5, mS(alloc.gas * (net.pot.liq / Math.max(net.pot.gas, 1)))), [{ c: 'var(--gas)', v: alloc.gas }], spd(alloc.gas, net.pot.gas))
    flow(link({ source: [sepR, sy + 6], target: [xO, oy.wat] })!, mS(alloc.wat), [{ c: 'var(--water)', v: alloc.wat }], spd(alloc.wat, net.pot.liq))

    // wells: label, choke marker, hit row
    const fs = narrow ? '9px' : '11px'
    for (const w of net.wells) {
      const k = alloc.f.get(w.id) ?? 1, y = wy.get(w.id)!
      const choked = k < 0.99
      const gw = g.append('g').style('cursor', 'pointer')
        .on('pointermove', ev => tip(tipRows(`${w.id} · ${w.man === 'Main' ? 'manifold' : `manifold ${w.man}`}`, [
          ['Potential oil', `${fmt(u.liq(w.oil))} ${u.liqU}`], ['Potential water', `${fmt(u.liq(w.wat))} ${u.liqU}`],
          ['Water cut', pct(w.wc)], ['Allowed', pct(k)], ['Oil deferred', `${fmt(u.liq(w.oil * (1 - k)))} ${u.liqU}`], ['', 'click to diagnose']]), ev))
        .on('pointerleave', () => tip(null))
        .on('click', () => { tip(null); go('producer', { well: w.id }) })
      gw.append('rect').attr('x', 0).attr('y', y - rowH / 2).attr('width', xM * 0.6).attr('height', rowH).attr('fill', 'transparent')
      gw.append('text').attr('class', 'lbl-mono').attr('x', xW - 8).attr('y', y + 3.5).attr('text-anchor', 'end').style('font-size', fs)
        .attr('fill', choked ? 'var(--warn)' : null).text(w.id)
      if (choked) {
        const s = narrow ? 3.5 : 4.5
        gw.append('path').attr('d', `M${xW - s},${y - s}L${xW + s},${y + s}L${xW + s},${y - s}L${xW - s},${y + s}Z`).attr('fill', 'var(--warn)')
        if (!narrow) gw.append('text').attr('class', 'lbl-mono').attr('x', xW + 10).attr('y', y - 3).style('font-size', '9px').attr('fill', 'var(--warn)').text(`${Math.round(k * 100)}%`)
      } else gw.append('circle').attr('cx', xW).attr('cy', y).attr('r', narrow ? 2.5 : 3).attr('fill', 'var(--ink-2)')
    }

    // gauges
    const gauge = (x: number, y: number, w: number, util: number, key: ConKey | null) => {
      const bind = key != null && alloc.binding.includes(key)
      g.append('rect').attr('x', x).attr('y', y).attr('width', w).attr('height', 4).attr('fill', 'var(--sunken)').attr('stroke', 'var(--line)')
      g.append('rect').attr('x', x).attr('y', y).attr('height', 4).attr('fill', bind ? 'var(--warn)' : 'var(--ink-2)')
        .attr('width', 0).transition().duration(dur(500)).attr('width', w * Math.min(1, util))
    }
    const box = (x: number, y: number, w: number, hh: number, key: ConKey | null) => {
      const bind = key != null && alloc.binding.includes(key)
      g.append('rect').attr('x', x).attr('y', y).attr('width', w).attr('height', hh).attr('fill', 'var(--panel-2)').attr('stroke', bind ? 'var(--warn)' : 'var(--line)')
      if (bind) g.append('rect').attr('class', 'pulse').attr('x', x - 3).attr('y', y - 3).attr('width', w + 6).attr('height', hh + 6).attr('fill', 'none').attr('stroke', 'var(--warn)').attr('stroke-width', 1.5)
    }
    // manifolds
    for (const m of net.manifolds) {
      const y = my.get(m.id)!, ml = alloc.manLiq.get(m.id) ?? 0
      const lineBind = alloc.binding.includes('line') && ml / caps.line >= 0.995
      g.append('rect').attr('x', xM - 6).attr('y', y - 16).attr('width', 12).attr('height', 32).attr('fill', 'var(--panel-2)').attr('stroke', lineBind ? 'var(--warn)' : 'var(--line)')
      g.append('text').attr('class', 'lbl-strong').attr('x', xM).attr('y', y - 22).attr('text-anchor', 'middle').style('font-size', narrow ? '10px' : '12px').text(m.id === 'Main' ? 'Manifold' : m.id)
      g.append('rect').attr('x', xM - 14).attr('y', y + 20).attr('width', 28).attr('height', 3).attr('fill', 'var(--sunken)')
      g.append('rect').attr('x', xM - 14).attr('y', y + 20).attr('width', 28 * Math.min(1, ml / caps.line)).attr('height', 3).attr('fill', lineBind ? 'var(--warn)' : 'var(--ink-2)')
    }
    // separator
    const sw = narrow ? 52 : 80, sh = narrow ? 46 : 50
    box(xS - sw / 2, sy - sh / 2, sw, sh, 'liq')
    g.append('text').attr('class', 'lbl-strong').attr('x', xS).attr('y', sy - 8).attr('text-anchor', 'middle').style('font-size', narrow ? '9px' : '12px').text(narrow ? 'Sep.' : 'Separator')
    g.append('text').attr('class', 'lbl-mono').attr('x', xS).attr('y', sy + 5).attr('text-anchor', 'middle').style('font-size', '9px').text(`${Math.round(alloc.util.liq * 100)}% liq`)
    gauge(xS - sw / 2 + 5, sy + sh / 2 - 9, sw - 10, alloc.util.liq, 'liq')
    // outlets
    const outlet = (y: number, title: string, val: string, sub: string | null, key: ConKey) => {
      const hh = narrow ? (sub ? 50 : 40) : (sub ? 58 : 46)
      box(xO, y - hh / 2, boxW, hh, key)
      const bind = alloc.binding.includes(key)
      g.append('text').attr('class', 'lbl-strong').attr('x', xO + 6).attr('y', y - hh / 2 + 13).style('font-size', narrow ? '10px' : '12px')
        .text(bind ? `▲ ${title}` : title).attr('fill', bind ? 'var(--warn)' : null)
      g.append('text').attr('class', 'lbl-mono').attr('x', xO + 6).attr('y', y - hh / 2 + 26).style('font-size', narrow ? '9px' : '11px').text(val)
      if (sub) g.append('text').attr('class', 'lbl').attr('x', xO + 6).attr('y', y - hh / 2 + 38).style('font-size', narrow ? '8.5px' : '10px').text(sub)
      gauge(xO + 6, y + hh / 2 - 9, boxW - 12, alloc.util[key], key)
    }
    const reinj = Math.min(alloc.wat, net.injection)
    outlet(oy.oil, narrow ? 'Export' : 'Oil export', `${fmt(u.liq(alloc.oil))} ${narrow ? '' : u.liqU} · ${Math.round(alloc.util.oil * 100)}%`, null, 'oil')
    outlet(oy.gas, narrow ? 'Compr.' : 'Gas compression', `${fmt(u.gas(alloc.gas))} ${narrow ? '' : u.gasU} · ${Math.round(alloc.util.gas * 100)}%`, null, 'gas')
    outlet(oy.wat, narrow ? 'Water' : 'Water treatment', `${fmt(u.liq(alloc.wat))} ${narrow ? '' : u.liqU} · ${Math.round(alloc.util.wat * 100)}%`,
      net.injection > 0 ? `${narrow ? 'reinj.' : 'reinjected'} ${fmt(u.liq(reinj))} · ${narrow ? 'o/b' : 'overboard'} ${fmt(u.liq(alloc.wat - reinj))}` : 'no injection in latest months', 'wat')
    if (alloc.binding.length) {
      g.append('text').attr('class', 'lbl').attr('x', W).attr('y', H - 2).attr('text-anchor', 'end').attr('fill', 'var(--warn)').style('font-size', narrow ? '9px' : '11px')
        .text(`▲ binding: ${alloc.binding.map(k => CON_LABEL[k].toLowerCase()).join(', ')}`)
    }
  }

  // ---------- utilisation bars ----------
  function drawUtil({ g, w: W, h: H }: Frame) {
    g.selectAll('*').remove()
    const maxMan = Math.max(...net.manifolds.map(m => m.liq))
    const demand: Record<ConKey, number> = { wat: net.pot.wat / caps.wat, liq: net.pot.liq / caps.liq, gas: net.pot.gas / caps.gas, oil: net.pot.oil / caps.oil, line: maxMan / caps.line }
    const rows = ORDER.map(k => ({ k, a: alloc.util[k], d: demand[k] }))
    const y = d3.scaleBand<ConKey>().domain(ORDER).range([0, H]).padding(0.35)
    const x = d3.scaleLinear().domain([0, Math.max(1.2, d3.max(rows, r => r.d)! * 1.05)]).range([0, W])
    g.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(x).ticks(4).tickFormat(d => `${Math.round(+d * 100)}%`)).call(axisStyle)
    g.selectAll('text.k').data(rows).join('text').attr('class', 'lbl-strong k').attr('x', -8).attr('y', r => y(r.k)! + y.bandwidth() / 2 + 4)
      .attr('text-anchor', 'end').style('font-size', '11px').attr('fill', r => (alloc.binding.includes(r.k) ? 'var(--warn)' : null))
      .text(r => (alloc.binding.includes(r.k) ? '▲ ' : '') + SHORT[r.k])
    g.selectAll('rect.d').data(rows).join('rect').attr('class', 'd').attr('x', 0).attr('y', r => y(r.k)!).attr('height', y.bandwidth())
      .attr('width', r => x(r.d)).attr('fill', 'none').attr('stroke', 'var(--muted)').attr('stroke-dasharray', '3 2')
    g.selectAll('rect.a').data(rows).join('rect').attr('class', 'a').attr('x', 0).attr('y', r => y(r.k)! + 3).attr('height', Math.max(1, y.bandwidth() - 6))
      .attr('fill', r => (alloc.binding.includes(r.k) ? 'var(--warn)' : 'var(--ink-2)')).attr('width', 0)
      .on('pointermove', (ev, r) => tip(tipRows(CON_LABEL[r.k], [['Allocated', pct(r.a)], ['Unconstrained demand', pct(r.d)]]), ev)).on('pointerleave', () => tip(null))
      .transition().duration(dur(600)).attr('width', r => x(Math.min(r.a, x.domain()[1])))
    g.append('line').attr('x1', x(1)).attr('x2', x(1)).attr('y1', -4).attr('y2', H).attr('stroke', 'var(--ink)').attr('stroke-dasharray', '2 2')
    g.selectAll('text.v').data(rows).join('text').attr('class', 'lbl-mono v').attr('y', r => y(r.k)! + y.bandwidth() / 2 + 4)
      .attr('x', r => x(Math.max(r.a, r.d)) + 5).style('font-size', '10px').text(r => `${Math.round(r.a * 100)}%`)
  }

  // ---------- history ----------
  function drawHist({ g, w: W, h: H }: Frame) {
    g.selectAll('*').remove()
    if (hist.length < 2) return
    const x = d3.scaleTime().domain(d3.extent(hist, r => r.date) as [Date, Date]).range([0, W])
    const y = d3.scaleLinear().domain([0, u.liq(Math.max(d3.max(hist, r => Math.max(r.oil, r.wat))!, caps.wat) * 1.1)]).range([H, 0]).nice()
    grid(g, y, W, 4)
    g.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(x).ticks(W < 400 ? 4 : 7)).call(axisStyle)
    g.append('g').call(d3.axisLeft(y).ticks(4, '~s')).call(axisStyle)
    g.append('text').attr('class', 'lbl').attr('x', 0).attr('y', -4).text(u.liqU)
    const line = (k: 'oil' | 'wat') => d3.line<typeof hist[0]>().x(r => x(r.date)).y(r => y(u.liq(r[k])))
    g.append('path').datum(hist).attr('d', line('oil')).attr('fill', 'none').attr('stroke', 'var(--oil)').attr('stroke-width', 2)
    g.append('path').datum(hist).attr('d', line('wat')).attr('fill', 'none').attr('stroke', 'var(--water)').attr('stroke-width', 2)
    g.append('line').attr('x1', 0).attr('x2', W).attr('y1', y(u.liq(caps.wat))).attr('y2', y(u.liq(caps.wat))).attr('stroke', 'var(--warn)').attr('stroke-dasharray', '5 3')
    const first = hist.find(r => r.wat > caps.wat)
    if (first) {
      const xx = x(first.date)
      g.append('line').attr('x1', xx).attr('x2', xx).attr('y1', 0).attr('y2', H).attr('stroke', 'var(--warn)').attr('opacity', 0.6)
      g.append('text').attr('class', 'lbl').attr('x', xx < W * 0.6 ? xx + 5 : xx - 5).attr('y', 12).attr('text-anchor', xx < W * 0.6 ? 'start' : 'end')
        .attr('fill', 'var(--warn)').text(`▲ binds from ${fmtMonth(first.date)}`)
    } else g.append('text').attr('class', 'lbl').attr('x', W).attr('y', 12).attr('text-anchor', 'end').text('field water never exceeded this capacity')
    // crosshair
    const cross = g.append('line').attr('y1', 0).attr('y2', H).attr('stroke', 'var(--muted)').attr('opacity', 0)
    g.append('rect').attr('width', W).attr('height', H).attr('fill', 'transparent')
      .on('pointermove', ev => {
        const [mx] = d3.pointer(ev), d = x.invert(mx)
        const r = hist[Math.min(hist.length - 1, d3.bisector((r: typeof hist[0]) => r.date).center(hist, d))]
        cross.attr('x1', x(r.date)).attr('x2', x(r.date)).attr('opacity', 1)
        tip(tipRows(fmtMonth(r.date), [['Oil', `${fmt(u.liq(r.oil))} ${u.liqU}`], ['Water', `${fmt(u.liq(r.wat))} ${u.liqU}`], ['Water cut', pct(r.wat / (r.oil + r.wat))]]), ev)
      })
      .on('pointerleave', () => { cross.attr('opacity', 0); tip(null) })
  }

  // ---------- what-if table ----------
  function renderTable() {
    const rows = whatIfs(ds, state.a, net, caps, rule, pctUp, topN)
    const max = Math.max(1, ...rows.map(r => Math.abs(r.gain)))
    wiBody.innerHTML = ''
    rows.forEach((r, i) => wiBody.append(h('tr', { class: i === 0 && r.gain > 0.5 ? 'sel' : null },
      h('td', {}, r.label),
      h('td', { class: 'num', style: { color: r.gain > 0.5 ? 'var(--ink-strong)' : 'var(--muted)' } }, `${r.gain >= 0 ? '+' : '−'}${fmt(u.liq(Math.abs(r.gain)))}`),
      h('td', {}, h('span', { class: 'bar-inline', style: { width: `${Math.round((60 * Math.abs(r.gain)) / max)}px`, background: r.gain >= 0 ? 'var(--oil)' : 'var(--warn)' } })),
      h('td', { class: 'small muted', style: { whiteSpace: 'normal', minWidth: '140px' } }, r.note))))
  }

  // ---------- right card ----------
  function renderCard() {
    card.innerHTML = ''
    const lost = net.pot.oil - alloc.oil
    const ruleGap = rule === 'opt' ? alloc.oil - other.oil : other.oil - alloc.oil
    const bind = alloc.binding[0] ?? null
    let marg: number | null = null
    if (bind && bind !== 'line') {
      const bumped = allocate(net, { ...caps, [bind]: caps[bind] * 1.01 }, rule).oil
      marg = (bumped - alloc.oil) / (caps[bind] * 0.01)
    }
    const kpi = (l: string, v: string, s?: string) => h('div', { class: 'kpi' }, h('div', { class: 'l' }, l), h('div', { class: 'v' }, v), s ? h('div', { class: 's' }, s) : null)
    const choked = net.wells.map(w => ({ w, k: alloc.f.get(w.id) ?? 1 })).filter(r => r.k < 0.99).sort((a, b) => b.w.oil * (1 - b.k) - a.w.oil * (1 - a.k))
    card.append(
      h('span', { class: 'eyebrow' }, `Result · ${rule === 'opt' ? 'optimised' : 'pro-rata'}`),
      h('div', { class: 'kpis' },
        kpi(`Oil potential (${u.liqU})`, fmt(u.liq(net.pot.oil)), `${net.wells.length} flowing wells`),
        kpi(`Oil delivered (${u.liqU})`, fmt(u.liq(alloc.oil)), pct(alloc.oil / net.pot.oil) + ' of potential'),
        kpi(`Oil deferred (${u.liqU})`, fmt(u.liq(lost)), lost > 0.5 ? `${choked.length} wells choked back` : 'no well choked'),
        kpi(`Optimised vs pro-rata (${u.liqU})`, `+${fmt(u.liq(Math.max(0, ruleGap)))}`, 'value of choking the right wells')),
      bind
        ? h('div', { class: 'small', style: { color: 'var(--warn)', lineHeight: 1.5 } }, `▲ Binding: ${alloc.binding.map(k => CON_LABEL[k]).join(' + ')}.`,
          marg != null ? h('span', { class: 'muted' }, ` Each extra 1,000 ${bind === 'gas' ? u.gasU : u.liqU} of ${CON_LABEL[bind].toLowerCase()} capacity adds about ${fmt(u.liq(marg * 1000 / (bind === 'gas' ? G : L)))} ${u.liqU} of oil.`) : null)
        : h('div', { class: 'small muted' }, 'No facility limit binds: every well flows at potential.'),
      h('span', { class: 'eyebrow' }, 'Choked wells'),
      choked.length
        ? h('div', { class: 'tablewrap' }, h('table', { class: 'data' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Well'), h('th', { class: 'num' }, 'WC'), h('th', { class: 'num' }, 'Allowed'), h('th', { class: 'num' }, `Oil lost`))),
          h('tbody', {}, ...choked.slice(0, 10).map(r => h('tr', { style: { cursor: 'pointer' }, onclick: () => go('producer', { well: r.w.id }) },
            h('td', { class: 'mono' }, r.w.id), h('td', { class: 'num' }, pct(r.w.wc)), h('td', { class: 'num' }, pct(r.k)), h('td', { class: 'num' }, fmt(u.liq(r.w.oil * (1 - r.k)))))))))
        : h('div', { class: 'small muted' }, 'None.'),
      h('div', { class: 'small muted', style: { lineHeight: 1.5 } },
        rule === 'opt'
          ? 'With water as the only binding limit, the optimiser shuts or chokes the highest water-cut wells first: they cost the most water per barrel of oil. Check the choked wells for water shut-off before accepting the deferment.'
          : 'Pro-rata cuts every well by the same share, so low water-cut wells give up oil to make room for water from wet wells. Switch to Optimised to see the difference.'))
  }
  renderTable(); renderCard()

  return () => { timer?.stop(); cancelAnimationFrame(raf); charts.forEach(c => c.destroy()); tip(null) }
}
