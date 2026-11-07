// Stage 4 — maturation funnel, opportunity register, lookback, schedule and one-pager.
import * as d3 from 'd3'
import type { Ctx } from '../main'
import type { Dataset } from '../core/data'
import { go, set, state } from '../core/state'
import { ev, fmt, money, pct } from '../core/units'
import { defaultStage, MECH_LABEL, review, STAGES, type Opportunity, type Stage } from '../analysis/diagnose'
import { CAT_COLOR, CAT_LABEL } from '../analysis/econ'
import { axisStyle, download, dur, h, panel, reduced, responsive, tip, tipRows } from '../ui/kit'

export function stageOf(ds: Dataset, opps: Opportunity[], o: Opportunity): Stage {
  const k = `${ds.id}:${o.id}`
  return (state.stages[k] as Stage) ?? defaultStage(o, opps.indexOf(o), opps.length)
}

/** Deterministic synthetic "actual" result for executed jobs (Field X only) — for the lookback chart. */
function actualFactor(id: string) {
  let s = 0
  for (const c of id) s = (s * 31 + c.charCodeAt(0)) % 9973
  return 0.55 + (s % 70) / 100
}

export function mountRegister(el: HTMLElement, ctx: Ctx) {
  const { ds, u } = ctx
  const rv = review(ds, state.a)
  const opps = rv.opps
  const destroyers: (() => void)[] = []
  let sortKey: 'rnpv' | 'gain' | 'cost' | 'stage' | 'well' = 'rnpv'
  if (!state.opp || !opps.some(o => o.id === state.opp)) state.opp = opps[0]?.id ?? null

  const funnelBox = h('div', { class: 'chart' })
  const tableBox = h('div', { class: 'tablewrap', style: { maxHeight: '420px' } })
  const lookBox = h('div', { class: 'chart' }), ganttBox = h('div', { class: 'chart' })
  const pager = h('aside', { class: 'rail right onepager-wrap', style: { maxWidth: '400px', flexBasis: '340px' } })
  const center = h('div', { class: 'center' })
  el.append(h('div', { class: 'cols' }, center, pager))
  center.append(
    panel('Opportunity maturation — wells flow through stage gates', 'band height = count · particles = P50 oil moving through the gates', funnelBox),
    h('section', { class: 'panel' },
      h('header', {}, h('h2', {}, 'Opportunity register'),
        h('div', { style: { display: 'flex', gap: '8px' } },
          h('button', { class: 'btn ghost', onclick: () => { set({ stages: Object.fromEntries(Object.entries(state.stages).filter(([k]) => !k.startsWith(ds.id + ':'))) }); render() } }, 'Reset stages'),
          h('button', { class: 'btn', onclick: () => exportCsv() }, 'Export CSV'))),
      tableBox),
    h('div', { class: 'row' },
      panel('Lookback — predicted vs actual (executed jobs)', ds.real ? 'none in public data' : 'synthetic actuals', lookBox),
      panel('Execution schedule', 'approved jobs in value order, rig days', ganttBox)))

  function stages() { return new Map(opps.map(o => [o.id, stageOf(ds, opps, o)])) }

  function render() {
    destroyers.splice(0).forEach(f => f())
    const st = stages()
    destroyers.push(funnel(funnelBox, ds, opps, st, rv, u))
    renderTable(st)
    destroyers.push(lookback(lookBox, ds, opps.filter(o => st.get(o.id) === 'Executed'), u))
    destroyers.push(gantt(ganttBox, opps.filter(o => st.get(o.id) === 'Approved')))
    renderPager()
  }

  function renderTable(st: Map<string, Stage>) {
    const order = [...opps].sort((a, b) => {
      if (sortKey === 'rnpv') return b.e.rnpv - a.e.rnpv
      if (sortKey === 'gain') return b.gain - a.gain
      if (sortKey === 'cost') return a.cost - b.cost
      if (sortKey === 'well') return a.well.localeCompare(b.well)
      return STAGES.indexOf(st.get(a.id)!) - STAGES.indexOf(st.get(b.id)!)
    })
    const th = (label: string, key?: typeof sortKey, num = false) => h('th', { class: num ? 'num' : '' },
      key ? h('button', { onclick: () => { sortKey = key; renderTable(st) }, 'aria-sort': sortKey === key ? 'descending' : null }, label + (sortKey === key ? ' ▾' : '')) : label)
    tableBox.innerHTML = ''
    tableBox.append(h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, th('ID'), th('Well', 'well'), th('Intervention'), th('Stage', 'stage'), th(`P50 ${u.liqU}`, 'gain', true), th('Cost', 'cost', true), th('P(s)', undefined, true), th('Risked NPV', 'rnpv', true), th('Next action'))),
      h('tbody', {}, ...order.map((o, i) => {
        const s = h('select', { 'aria-label': `Stage for ${o.id}`, style: { minHeight: '28px', padding: '2px 4px' }, onclick: (e: Event) => e.stopPropagation() },
          ...STAGES.map(x => h('option', { value: x, selected: x === st.get(o.id) }, x))) as HTMLSelectElement
        s.addEventListener('change', () => { set({ stages: { ...state.stages, [`${ds.id}:${o.id}`]: s.value } }); render() })
        const next = st.get(o.id) === 'Executed' ? 'Lookback at +3 months' : st.get(o.id) === 'Rejected' ? '—' : o.preJob[0]?.split(' — ')[0] ?? 'Prepare programme'
        return h('tr', { class: o.id === state.opp ? 'sel' : '', onclick: () => { set({ opp: o.id }); renderTable(st); renderPager() } },
          h('td', { class: 'mono' }, `OPP-${String(i + 1).padStart(2, '0')}`),
          h('td', { class: 'mono' }, o.well),
          h('td', {}, h('span', { class: 'chip', style: { fontFamily: 'var(--sans)', fontSize: '12px' } }, h('span', { class: 'dot', style: { background: CAT_COLOR[o.cat] } }), o.label)),
          h('td', {}, s),
          h('td', { class: 'num' }, fmt(u.liq(o.gain))), h('td', { class: 'num' }, money(o.cost)), h('td', { class: 'num' }, pct(o.ps)),
          h('td', { class: 'num' }, money(o.e.rnpv)), h('td', { class: 'muted' }, next))
      }))))
  }

  function renderPager() {
    pager.innerHTML = ''
    const o = opps.find(x => x.id === state.opp)
    if (!o) return
    const w = ds.wells.find(x => x.id === o.well)!
    const spark = h('div', { class: 'chart' })
    const dx = rv.dx.get(o.well)
    pager.append(
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
        h('span', { class: 'eyebrow' }, 'Well one-pager'),
        h('button', { class: 'btn ghost no-print', onclick: () => { document.body.classList.add('print-pager'); print(); setTimeout(() => document.body.classList.remove('print-pager'), 500) } }, 'Print / PDF')),
      h('div', { class: 'panel onepager', style: { gap: '10px' } },
        h('div', { class: 'mono', style: { fontSize: '16px', color: 'var(--ink-strong)' } }, `${o.well} · ${o.label}`),
        h('div', { class: 'small muted' }, `${ds.label} · ${w.lift} · stage ${stageOf(ds, opps, o)}`),
        spark,
        h('div', { class: 'small', style: { lineHeight: 1.7 } },
          row('Problem', dx?.primary ? MECH_LABEL[dx.primary.key] : o.mech === 'inj' ? 'Injector performance' : '—'),
          row('Evidence', ev(o.rationale, u)),
          row('Proposal', o.label),
          row('Value', `P50 +${fmt(u.liq(o.gain))} ${u.liqU} · risked NPV ${money(o.e.rnpv)} · payback ${o.e.payback ?? '>60'} mo`),
          row('Cost / risk', `${money(o.cost)} · P(s) ${pct(o.ps)} · ${o.riskText}`),
          row('Pre-job data', o.preJob.map(p => p.split(' — ')[0]).join('; ') || 'none')),
        h('div', { class: 'mono small', style: { borderTop: '1px solid var(--line)', paddingTop: '8px' } },
          `Recommendation: ${o.e.rnpv > 0 ? 'GO' : 'NO-GO'} · ${CAT_LABEL[o.cat]}`)),
      h('button', { class: 'btn no-print', onclick: () => go(o.mech === 'inj' ? 'injector' : 'producer', o.mech === 'inj' ? { injector: o.well } : { well: o.well }) }, 'Open diagnosis'),
      h('div', { class: 'small muted no-print' }, 'Use ▶ Present in the top bar for a full-screen review meeting that steps through the approved jobs.'))
    destroyers.push(sparkline(spark, ds, w, u))
  }

  function exportCsv() {
    const st = stages()
    const rows = [['id', 'well', 'intervention', 'category', 'stage', `p50_oil_${u.liqU}`, 'p90', 'p10', 'cost_usd', 'p_success', 'risked_npv_usd', 'payback_months', 'rig_days', 'evidence']]
    opps.forEach((o, i) => rows.push([`OPP-${i + 1}`, o.well, o.label, CAT_LABEL[o.cat], st.get(o.id)!, u.liq(o.gain).toFixed(0), u.liq(o.p90).toFixed(0), u.liq(o.p10).toFixed(0),
      o.cost.toFixed(0), o.ps.toFixed(2), o.e.rnpv.toFixed(0), String(o.e.payback ?? ''), String(o.rig), ev(o.rationale, u)]))
    download(`opportunity-register-${ds.id}.csv`, rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n'))
  }

  render()
  return () => { destroyers.forEach(f => f()); tip(null) }
}

const row = (k: string, v: string) => h('div', {}, h('span', { class: 'muted' }, `${k}  `), v)

function funnel(box: HTMLElement, ds: Dataset, opps: Opportunity[], st: Map<string, Stage>, rv: ReturnType<typeof review>, u: Ctx['u']) {
  const withIssue = new Set([...rv.dx.values()].filter(d => d.primary).map(d => d.well.id))
  rv.inj.forEach((d, id) => { if (d.hall.verdict === 'fracture' || d.hall.verdict === 'plugging') withIssue.add(id) })
  const at = (ss: Stage[]) => opps.filter(o => ss.includes(st.get(o.id)!))
  const sum = (os: Opportunity[]) => d3.sum(os, o => o.gain)
  const cols = [
    { label: 'Wells reviewed', n: ds.wells.length, gain: null as number | null },
    { label: 'With an issue', n: withIssue.size, gain: null },
    { label: 'Opportunities', n: opps.length, gain: sum(opps) },
    { label: 'Evaluated', n: at(['Evaluated', 'Approved', 'Executed']).length, gain: sum(at(['Evaluated', 'Approved', 'Executed'])) },
    { label: 'Approved', n: at(['Approved', 'Executed']).length, gain: sum(at(['Approved', 'Executed'])) },
    { label: 'Executed', n: at(['Executed']).length, gain: sum(at(['Executed'])) },
  ]
  let timer: d3.Timer | null = null
  const r = responsive(box, 210, { t: 24, r: 12, b: 40, l: 12 }, ({ g, w: W, h: H }) => {
    g.selectAll('*').remove(); timer?.stop()
    const xs = d3.scaleBand<string>().domain(cols.map(c => c.label)).range([0, W]).paddingInner(0.42)
    const hs = d3.scaleLinear().domain([0, cols[0].n]).range([4, H])
    const mid = H / 2
    const bw = xs.bandwidth()
    // connecting bands
    for (let i = 0; i < cols.length - 1; i++) {
      const a = cols[i], b = cols[i + 1]
      const x0 = xs(a.label)! + bw, x1 = xs(b.label)!
      g.append('path').attr('fill', 'var(--panel-3)').attr('opacity', 0.6)
        .attr('d', `M${x0},${mid - hs(a.n) / 2} C${(x0 + x1) / 2},${mid - hs(a.n) / 2} ${(x0 + x1) / 2},${mid - hs(b.n) / 2} ${x1},${mid - hs(b.n) / 2} L${x1},${mid + hs(b.n) / 2} C${(x0 + x1) / 2},${mid + hs(b.n) / 2} ${(x0 + x1) / 2},${mid + hs(a.n) / 2} ${x0},${mid + hs(a.n) / 2}Z`)
    }
    const fills = ['var(--dim)', 'var(--dim)', 'var(--muted)', 'var(--muted)', 'var(--ink-2)', 'var(--ink)']
    g.selectAll('rect.col').data(cols).join('rect').attr('class', 'col').attr('x', c => xs(c.label)!).attr('width', bw)
      .attr('y', mid).attr('height', 0).attr('fill', (_, i) => fills[i])
      .on('pointermove', (ev, c) => tip(tipRows(c.label, [['Count', String(c.n)], ['P50 oil', c.gain == null ? '—' : `${fmt(u.liq(c.gain))} ${u.liqU}`]]), ev)).on('pointerleave', () => tip(null))
      .transition().delay((_, i) => dur(i * 150)).duration(dur(500)).attr('y', c => mid - hs(c.n) / 2).attr('height', c => hs(c.n))
    g.selectAll('text.n').data(cols).join('text').attr('class', 'lbl-mono n').attr('x', c => xs(c.label)! + bw / 2).attr('y', c => mid - hs(c.n) / 2 - 6).attr('text-anchor', 'middle').text(c => c.n)
    const narrow = W < 600
    const SHORT: Record<string, string> = { 'Wells reviewed': 'Reviewed', 'With an issue': 'Issues', 'Opportunities': 'Opps', 'Evaluated': 'Evaluated', 'Approved': 'Approved', 'Executed': 'Executed' }
    g.selectAll('text.l').data(cols).join('text').attr('class', 'lbl l').attr('x', c => xs(c.label)! + bw / 2).attr('y', H + 16).attr('text-anchor', 'middle').style('font-size', () => (narrow ? '10px' : null)).text(c => (narrow ? SHORT[c.label] : c.label))
    g.selectAll('text.g').data(cols).join('text').attr('class', 'lbl g').attr('x', c => xs(c.label)! + bw / 2).attr('y', H + 30).attr('text-anchor', 'middle')
      .style('font-size', () => (narrow ? '9px' : null))
      .text(c => (c.gain == null ? '' : narrow ? fmt(u.liq(c.gain)) : `${fmt(u.liq(c.gain))} ${u.liqU}`))
    if (reduced()) return
    // particles travel from column to column; fewer survive each gate
    const parts = d3.range(60).map(i => ({ i, seed: (i * 0.6180339) % 1, lane: ((i * 0.7548) % 1) - 0.5 }))
    const dots = g.append('g').selectAll('circle').data(parts).join('circle').attr('r', 1.8).attr('fill', 'var(--oil)')
    const xsC = cols.map(c => xs(c.label)! + bw / 2)
    timer = d3.timer(el => {
      dots.each(function (p) {
        const s = ((el / 9000) + p.seed) % 1
        const pos = s * (cols.length - 1)
        const k = Math.floor(pos), f = pos - k
        // drop particles at gates proportionally to the funnel narrowing
        const survive = cols[Math.min(cols.length - 1, k + 1)].n / cols[0].n
        const alive = p.seed < survive + 0.02
        const hk = hs(cols[k].n), hk1 = hs(cols[Math.min(k + 1, cols.length - 1)].n)
        const x = xsC[k] + (xsC[Math.min(k + 1, cols.length - 1)] - xsC[k]) * f
        const y = mid + p.lane * (hk + (hk1 - hk) * f) * 0.85
        d3.select(this).attr('cx', x).attr('cy', y).attr('opacity', alive ? 0.85 : Math.max(0, 0.85 - f * 2))
      })
    })
  }, 'Opportunity maturation funnel')
  return () => { timer?.stop(); r.destroy() }
}

function lookback(box: HTMLElement, ds: Dataset, done: Opportunity[], u: Ctx['u']) {
  return responsive(box, 220, { t: 12, r: 16, b: 36, l: 52 }, ({ g, w: W, h: H }) => {
    g.selectAll('*').remove()
    if (ds.real || !done.length) {
      g.append('text').attr('class', 'lbl').attr('x', W / 2).attr('y', H / 2).attr('text-anchor', 'middle')
        .text(ds.real ? 'No post-job results in the public Volve data' : 'No executed jobs yet — set a stage to Executed')
      return
    }
    const pts = done.map(o => ({ o, p: u.liq(o.gain), a: u.liq(o.gain * actualFactor(o.id)) }))
    const m = (d3.max(pts, p => Math.max(p.p, p.a)) || 1) * 1.15
    const s = d3.scaleLinear().domain([0, m]).nice()
    const xs = s.copy().range([0, W]), ys = s.copy().range([H, 0])
    g.append('path').attr('d', `M${xs(0)},${ys(0)} L${xs(m)},${ys(m * 1.3)} L${xs(m)},${ys(m * 0.7)}Z`).attr('fill', 'var(--panel-3)').attr('opacity', 0.6)
    g.append('line').attr('x1', xs(0)).attr('y1', ys(0)).attr('x2', xs(m)).attr('y2', ys(m)).attr('stroke', 'var(--muted)').attr('stroke-dasharray', '4 4')
    g.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(xs).ticks(4, '~s')).call(axisStyle)
    g.append('g').call(d3.axisLeft(ys).ticks(4, '~s')).call(axisStyle)
    g.append('text').attr('class', 'lbl').attr('x', W).attr('y', H + 30).attr('text-anchor', 'end').text(`predicted P50 (${u.liqU})`)
    g.append('text').attr('class', 'lbl').attr('x', 4).attr('y', 4).text('actual ↑ · band = ±30 %')
    g.selectAll('circle').data(pts).join('circle').attr('cx', p => xs(p.p)).attr('cy', ys(0)).attr('r', 6)
      .attr('fill', p => CAT_COLOR[p.o.cat]).attr('stroke', 'var(--panel)').attr('stroke-width', 2)
      .on('pointermove', (ev, p) => tip(tipRows(`${p.o.well} · ${p.o.label}`, [['Predicted', fmt(p.p)], ['Actual', fmt(p.a)], ['Ratio', (p.a / p.p).toFixed(2)]]), ev)).on('pointerleave', () => tip(null))
      .transition().delay((_, i) => dur(i * 120)).duration(dur(700)).ease(d3.easeBackOut).attr('cy', p => ys(p.a))
  }, 'Lookback of predicted versus actual gains').destroy
}

function gantt(box: HTMLElement, jobs: Opportunity[]) {
  const n = Math.max(1, jobs.length)
  return responsive(box, Math.max(140, 40 + n * 20), { t: 8, r: 16, b: 28, l: 70 }, ({ g, w: W, h: H }) => {
    g.selectAll('*').remove()
    if (!jobs.length) { g.append('text').attr('class', 'lbl').attr('x', W / 2).attr('y', H / 2).attr('text-anchor', 'middle').text('No approved jobs'); return }
    let t = 0
    const bars = jobs.map(o => { const b = { o, s: t, d: Math.max(o.rig, 0) }; t += Math.max(o.rig, 0.5); return b })
    const xs = d3.scaleLinear().domain([0, Math.max(t, 10)]).range([0, W])
    const ys = d3.scaleBand<string>().domain(bars.map(b => b.o.id)).range([0, H]).padding(0.3)
    g.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(xs).ticks(6).tickFormat(d => `${d} d`)).call(axisStyle)
    g.selectAll('text.w').data(bars).join('text').attr('class', 'lbl w').attr('x', -6).attr('y', b => ys(b.o.id)! + ys.bandwidth() / 2 + 3).attr('text-anchor', 'end')
      .style('font-family', 'var(--mono)').style('font-size', '10px').text(b => b.o.well)
    g.selectAll('rect').data(bars.filter(b => b.d > 0)).join('rect').attr('x', b => xs(b.s)).attr('y', b => ys(b.o.id)!).attr('height', ys.bandwidth())
      .attr('width', 0).attr('fill', b => CAT_COLOR[b.o.cat])
      .on('pointermove', (ev, b) => tip(tipRows(b.o.label, [['Well', b.o.well], ['Rig days', String(b.o.rig)], ['Start', `day ${Math.round(b.s)}`]]), ev)).on('pointerleave', () => tip(null))
      .transition().delay((_, i) => dur(i * 90)).duration(dur(500)).attr('width', b => Math.max(2, xs(b.s + b.d) - xs(b.s)))
    g.selectAll('path.rigless').data(bars.filter(b => b.d === 0)).join('path').attr('class', 'rigless')
      .attr('d', d3.symbol(d3.symbolDiamond, 50)).attr('transform', b => `translate(${xs(b.s)},${ys(b.o.id)! + ys.bandwidth() / 2})`).attr('fill', b => CAT_COLOR[b.o.cat])
  }, 'Execution schedule').destroy
}

function sparkline(box: HTMLElement, ds: Dataset, w: Dataset['wells'][0], u: Ctx['u']) {
  const rows = ds.months.map((d, t) => ({ d, o: w.m.oil[t], wa: w.m.wat[t], wi: w.m.wi[t] })).slice(w.first, w.last + 1)
  return responsive(box, 90, { t: 4, r: 4, b: 16, l: 4 }, ({ g, w: W, h: H }) => {
    g.selectAll('*').remove()
    const xs = d3.scaleTime().domain(d3.extent(rows, r => r.d) as [Date, Date]).range([0, W])
    const inj = w.type === 'injector'
    const ys = d3.scaleLinear().domain([0, d3.max(rows, r => (inj ? r.wi ?? 0 : Math.max(r.o ?? 0, r.wa ?? 0))) || 1]).range([H, 0])
    const line = (k: 'o' | 'wa' | 'wi') => d3.line<typeof rows[0]>().defined(r => r[k] != null).x(r => xs(r.d)).y(r => ys(Math.max(0, r[k] ?? 0)))
    if (inj) g.append('path').datum(rows).attr('d', line('wi')).attr('fill', 'none').attr('stroke', 'var(--water)').attr('stroke-width', 1.4)
    else {
      g.append('path').datum(rows).attr('d', line('wa')).attr('fill', 'none').attr('stroke', 'var(--water)').attr('stroke-width', 1.4)
      g.append('path').datum(rows).attr('d', line('o')).attr('fill', 'none').attr('stroke', 'var(--oil)').attr('stroke-width', 1.6)
    }
    g.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(xs).ticks(4)).call(axisStyle)
    void u
  }).destroy
}
