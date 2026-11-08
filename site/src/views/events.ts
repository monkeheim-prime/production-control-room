// T8 — event detection on real Petrobras 3W wells: linked sensor lanes, expert labels, and a causal detector replay.
import * as d3 from 'd3'
import type { Ctx } from '../main'
import { fmt } from '../core/units'
import { INSTAB, P, SLUG, TAGS, detect, labelAt, score, type Detection, type Instance, type Score } from '../analysis/events'
import { axisStyle, dur, h, legend, panel, reduced, responsive, tip, tipRows } from '../ui/kit'

export const METHODS = `
<h2>Event detection</h2>
<h3>Data</h3>
<p>Real instances from the <a href="https://github.com/petrobras/3W" target="_blank" rel="noopener">Petrobras 3W dataset</a> (v2, CC BY 4.0): offshore wells with undesirable events labelled by Petrobras experts. Only real instances (files named WELL-*) are used, none of the simulated or hand-drawn ones. <code>pipeline/threew.py</code> takes 15-second means of the 1 Hz data and keeps the useful channels. Pressures are in bar, temperatures in °C, and gas-lift rate in 10³ m³/d. Each sample keeps its expert label: normal, transient (the event developing), or steady-state fault.</p>
<p>Vargas, R.E.V. et al. (2019). A realistic and public dataset with rare undesirable real events in oil wells. <em>Journal of Petroleum Science and Engineering</em> 181, 106223.</p>
<h3>Detector (causal: bin i uses only bins ≤ i)</h3>
<div class="eq">μ_i = μ_{i−1} + α · (x_i − μ_{i−1})                 EWMA baseline, α = ${P.alpha} per 15 s
σ_i = σ_{i−1} + α · (|x_i − μ_{i−1}| − σ_{i−1})        σ ≥ ${P.floorP} bar / ${P.floorT} °C
z_i = (x_i − μ_{i−1}) / (1.25 · σ_i)
S⁺_i = max(0, S⁺_{i−1} + z_i − k)   S⁻_i = max(0, S⁻_{i−1} − z_i − k)   k = ${P.k}
alarm when max(S⁺, S⁻) ≥ h = ${P.h}  and |x − μ| ≥ ${P.minDevP} bar / ${P.minDevT} °C</div>
<p>The two-sided CUSUM (Page 1954) runs on P-TPT, T-TPT, P-PDG and P-MON-CKP. Alarms are suppressed for the first ${P.warmup * 15 / 60} min while the baseline settles. After an alarm the baseline is frozen for ${P.latch * 15 / 60} min, so a slow event is not learned as the new normal.</p>
<h3>Oscillations</h3>
<p><strong>Flow instability:</strong> the peak of the autocorrelation of a detrended ${INSTAB.win * 15 / 60}-min window of P-TPT, at lags of ${INSTAB.lag[0] * 15 / 60}–${INSTAB.lag[1] * 15 / 60} min. It needs ACF ≥ ${INSTAB.acf} and a peak-to-peak of ${INSTAB.amp[0]}–${INSTAB.amp[1]} bar.</p>
<p><strong>Severe slugging:</strong> a zigzag of P-TPT swings of at least ${SLUG.swing} bar, where each of the last two full cycles lasts ${SLUG.minPeriod * 15 / 60}–${SLUG.maxPeriod * 15 / 60} min.</p>
<h3>Naming the event (rule signatures on changes since the alarm)</h3>
<div class="eq">DHSV closure       ΔP-TPT &lt; −5 bar and (ΔP-PDG &gt; +1 bar or ΔT-TPT &lt; −1 °C)
BSW increase       ΔP-TPT &lt; −3 bar and ΔT-TPT &gt; +0.3 °C
productivity loss  ΔT-TPT &lt; −3 °C
choke restriction  ΔP-TPT or ΔP-MON-CKP &gt; +1.5 bar</div>
<p>The guess is re-evaluated for ${P.classifyAfter * 15 / 60} min after the alarm, and the value at that point is scored.</p>
<h3>Scoring</h3>
<p><em>Delay</em>: minutes from the first bin labelled with the event (transient or steady) to the first bin in alarm. If an earlier alarm is still latched at onset, the delay is 0. <em>False alarms</em>: alarms raised in bins labelled normal. <em>Guess</em>: the name given by the latest alarm 15 minutes after detection.</p>
<h3>Limitations</h3>
<p>The thresholds were tuned by looking at these few instances, so the scoreboard is a demonstration, not a validation. A real deployment would tune on hundreds of 3W instances and test on held-out wells. 3W channel availability also varies by well (for example, P-PDG is often missing).</p>
<h3>References</h3>
<ul>
<li>Vargas, R.E.V. et al. (2019). A realistic and public dataset with rare undesirable real events in oil wells. J. Pet. Sci. Eng. 181, 106223.</li>
<li>Page, E.S. (1954). Continuous inspection schemes. Biometrika 41(1/2), 100–115.</li>
<li>Roberts, S.W. (1959). Control chart tests based on geometric moving averages. Technometrics 1(3).</li>
</ul>`

const EVENT_NOTE: Record<number, string> = {
  0: 'A reference period of normal operation. A good detector stays quiet here.',
  1: 'Basic sediment and water (BSW) jumps: the heavier column drops tree pressure, and the warmer water raises temperature.',
  2: 'The downhole safety valve closes by mistake: flow stops, pressure builds below the valve and drops above it.',
  3: 'Liquid accumulates in the riser and is purged in cycles: large, slow, regular pressure swings.',
  4: 'Smaller, faster oscillations than slugging, often a precursor to it.',
  5: 'The well suddenly delivers less: less flow means more cooling on the way up.',
  6: 'The production choke closes or plugs quickly: pressure rises upstream of it.',
  7: 'Scale gradually restricts the choke.',
  8: 'A hydrate plug forms in the production line.',
}

interface Loaded { ins: Instance; det: Detection; sc: Score }
let cache: Promise<{ meta: any; items: Loaded[] }> | null = null
function load() {
  if (!cache) cache = fetch(`${import.meta.env.BASE_URL}data/3w.json`).then(r => { if (!r.ok) throw new Error('failed to load 3w.json'); return r.json() })
    .then(d => ({ meta: d.meta, items: (d.instances as Instance[]).map(ins => { const det = detect(ins); return { ins, det, sc: score(ins, det, ins.event) } }) }))
  return cache
}
let sel = 0

export function mountEvents(el: HTMLElement, { u }: Ctx) {
  const field = u.sys === 'field'
  const tv = (c: number) => (field ? c * 1.8 + 32 : c), tU = field ? '°F' : '°C'
  const val = (tag: string, v: number) => { const k = TAGS[tag]?.kind; return k === 't' ? tv(v) : k === 'q' ? u.gas(v * 1000) : u.p(v) }
  const unit = (tag: string) => { const k = TAGS[tag]?.kind; return k === 't' ? tU : k === 'q' ? u.gasU : u.pU }
  const rail = h('aside', { class: 'rail', 'aria-label': 'Instances' })
  const center = h('div', { class: 'center' })
  const side = h('aside', { class: 'rail right', 'aria-label': 'Detection' })
  el.append(h('div', { class: 'cols chart-first' }, rail, center, side))
  center.append(h('div', { class: 'empty' }, 'Loading 3W instances…'))
  let alive = true, raf = 0
  let chart: ReturnType<typeof responsive> | null = null

  load().then(({ items }) => {
    if (!alive) return
    sel = Math.min(sel, items.length - 1)
    let cursor = items[sel].ins.n - 1, speed = 8, playing = false

    const list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } })
    const drawList = () => {
      list.innerHTML = ''
      items.forEach((it, i) => list.append(h('button', {
        class: i === sel ? 'btn primary' : 'btn', 'aria-pressed': String(i === sel), style: { textAlign: 'left', display: 'flex', flexDirection: 'column', gap: '2px' },
        onclick: () => { sel = i; stop(); cursor = items[sel].ins.n - 1; drawList(); rebuild() },
      }, h('span', {}, it.ins.event), h('span', { class: 'mono small muted' }, `${it.ins.well} · ${it.ins.start.slice(0, 10)}`))))
    }
    drawList()
    const playBtn = h('button', { class: 'btn primary', onclick: () => (playing ? stop() : play()) }, '▶ Replay with detector') as HTMLButtonElement
    const speedBox = h('div', { class: 'seg', role: 'group', 'aria-label': 'Replay speed' })
    const drawSpeed = () => { speedBox.innerHTML = '';[[2, '1×'], [8, '4×'], [32, '16×']].forEach(([v, l]) => speedBox.append(h('button', { 'aria-pressed': String(v === speed), onclick: () => { speed = v as number; drawSpeed() } }, l as string))) }
    drawSpeed()
    rail.append(h('span', { class: 'eyebrow' }, 'Real 3W instances'), list,
      h('span', { class: 'eyebrow' }, 'Replay'), playBtn, h('div', { class: 'field' }, h('span', {}, 'Speed'), speedBox),
      h('div', { class: 'small muted' }, 'Replay sweeps through the recording. The detector sees only the data to the left of the playhead, as an online system would.'))

    function play() {
      if (reduced()) { cursor = items[sel].ins.n - 1; redraw(); return }
      playing = true; playBtn.textContent = '❚❚ Pause'
      if (cursor >= items[sel].ins.n - 1) cursor = 0
      const step = () => {
        if (!playing || !alive) return
        cursor = Math.min(items[sel].ins.n - 1, cursor + speed)
        redraw()
        if (cursor >= items[sel].ins.n - 1) stop(); else raf = requestAnimationFrame(step)
      }
      raf = requestAnimationFrame(step)
    }
    function stop() { playing = false; cancelAnimationFrame(raf); playBtn.textContent = '▶ Replay with detector' }

    const lanesBox = h('div', { class: 'chart' })
    const tableBox = h('div', { class: 'tablewrap' })
    center.innerHTML = ''
    center.append(
      panel('Sensor lanes with expert labels and detector', legend([
        { label: 'normal', color: 'var(--line)' }, { label: 'transient (labelled)', color: 'rgba(227,163,59,.45)' }, { label: 'fault (labelled)', color: 'var(--warn)' }, { label: 'detector alarm (marker + red bar)', color: 'var(--gas)', dash: true },
      ]), lanesBox),
      panel('Scoreboard — every loaded instance', 'click a row to open it', tableBox))

    function rebuild() {
      chart?.destroy(); lanesBox.innerHTML = ''
      const it = items[sel]
      const tags = Object.keys(it.ins.ch).filter(t => it.ins.ch[t].some(v => v != null))
      const laneH = 64, band = 18, det = 54
      chart = responsive(lanesBox, band + 8 + tags.length * (laneH + 10) + det + 30, { t: 4, r: 12, b: 26, l: 64 }, f => draw(f, it, tags, laneH, band, det),
        `${it.ins.event} on ${it.ins.well}: sensor history with labels and detector alarms`)
      redraw()
      drawTable()
    }

    let parts: { clip: d3.Selection<SVGRectElement, unknown, null, undefined>; head: d3.Selection<SVGLineElement, unknown, null, undefined>; marks: d3.Selection<SVGGElement, unknown, null, undefined>; xs: d3.ScaleLinear<number, number>; H: number } | null = null
    function draw({ g, w: W, h: H }: { g: d3.Selection<SVGGElement, unknown, null, undefined>; w: number; h: number }, it: Loaded, tags: string[], laneH: number, band: number, detH: number) {
      g.selectAll('*').remove()
      const { ins } = it, n = ins.n
      const hrs = (i: number) => (i * ins.step) / 3600
      const xs = d3.scaleLinear().domain([0, hrs(n - 1)]).range([0, W])
      const X = (i: number) => xs(hrs(i))
      const id = `clip-${Math.random().toString(36).slice(2)}`
      const clip = g.append('clipPath').attr('id', id).append('rect').attr('x', -2).attr('y', -10).attr('height', H + 20).attr('width', X(cursor) + 2)
      // label band
      const runs = ins.labels.map(([s, v], k) => ({ s, e: k + 1 < ins.labels.length ? ins.labels[k + 1][0] : n - 1, v }))
      const bandColor = (v: number) => (v === 0 ? 'var(--line)' : v === -1 ? 'var(--line-soft)' : v >= 100 ? 'rgba(227,163,59,.45)' : 'var(--warn)')
      g.append('g').selectAll('rect').data(runs).join('rect').attr('x', r => X(r.s)).attr('width', r => Math.max(1, X(r.e) - X(r.s))).attr('y', 0).attr('height', band).attr('fill', r => bandColor(r.v))
      g.append('text').attr('class', 'lbl').attr('x', -8).attr('y', band - 5).attr('text-anchor', 'end').text('label')
      const body = g.append('g').attr('clip-path', `url(#${id})`)
      // sensor lanes
      tags.forEach((t, k) => {
        const y0 = band + 8 + k * (laneH + 10)
        const vals = ins.ch[t].map(v => (v == null ? null : val(t, v)))
        const ext = d3.extent(vals.filter((v): v is number => v != null)) as [number, number]
        const pad = (ext[1] - ext[0]) * 0.1 || 1
        const ys = d3.scaleLinear().domain([ext[0] - pad, ext[1] + pad]).range([y0 + laneH, y0])
        g.append('rect').attr('x', 0).attr('y', y0).attr('width', W).attr('height', laneH).attr('fill', 'var(--sunken)')
        g.append('g').call(d3.axisLeft(ys).ticks(2, '~s')).call(axisStyle)
        g.append('text').attr('class', 'lbl-mono').attr('x', 6).attr('y', y0 + 12).text(`${t} · ${unit(t)}`)
        const color = TAGS[t]?.kind === 't' ? 'var(--gas)' : TAGS[t]?.kind === 'q' ? 'var(--oil)' : 'var(--water)'
        body.append('path').datum(vals).attr('fill', 'none').attr('stroke', color).attr('stroke-width', 1.4)
          .attr('d', d3.line<number | null>().defined(v => v != null).x((_, i) => X(i)).y(v => ys(v!)))
      })
      // detector lane: CUSUM score (clipped at 2) and oscillation flag
      const y0 = band + 8 + tags.length * (laneH + 10)
      const ys = d3.scaleLinear().domain([0, 2]).range([y0 + detH, y0])
      g.append('rect').attr('x', 0).attr('y', y0).attr('width', W).attr('height', detH).attr('fill', 'var(--sunken)')
      g.append('line').attr('x1', 0).attr('x2', W).attr('y1', ys(1)).attr('y2', ys(1)).attr('stroke', 'var(--warn)').attr('stroke-dasharray', '3 3')
      g.append('text').attr('class', 'lbl-mono').attr('x', 6).attr('y', y0 + 12)
        .text(W < 600 ? 'CUSUM score · red bar = alarm' : `CUSUM score · an alarm also needs a ≥ ${P.minDevP} bar / ${P.minDevT} °C change · red bar = alarm`)
      g.append('text').attr('class', 'lbl').attr('x', -8).attr('y', ys(1) + 4).attr('text-anchor', 'end').text('limit')
      const dt = it.det
      body.append('path').datum(Array.from(dt.score)).attr('fill', 'none').attr('stroke', 'var(--ink-2)').attr('stroke-width', 1.2)
        .attr('d', d3.line<number>().x((_, i) => X(i)).y(v => ys(Math.min(2, v))))
      const alarmRuns: [number, number][] = []
      for (let i = 0; i < ins.n; i++) if (dt.alarm[i] && (i === 0 || !dt.alarm[i - 1])) { let j = i; while (j + 1 < ins.n && dt.alarm[j + 1]) j++; alarmRuns.push([i, j]) }
      body.append('g').selectAll('rect').data(alarmRuns).join('rect').attr('x', r => X(r[0])).attr('width', r => Math.max(1, X(r[1]) - X(r[0]))).attr('y', y0 + detH - 6).attr('height', 6).attr('fill', 'var(--gas)')
      body.raise()   // lines above the lane backgrounds
      g.append('g').attr('transform', `translate(0,${H})`).call(d3.axisBottom(xs).ticks(W < 600 ? 4 : 8).tickFormat(d => `${d} h`)).call(axisStyle)
      const marks = g.append('g')
      const head = g.append('line').attr('y1', 0).attr('y2', H).attr('stroke', 'var(--ink-strong)').attr('stroke-width', 1).attr('opacity', 0)
      // crosshair tooltip
      const cross = g.append('line').attr('y1', 0).attr('y2', H).attr('stroke', 'var(--muted)').attr('stroke-dasharray', '2 3').attr('opacity', 0)
      g.append('rect').attr('width', W).attr('height', H).attr('fill', 'transparent')
        .on('pointermove', ev => {
          const i = Math.max(0, Math.min(n - 1, Math.round((xs.invert(d3.pointer(ev)[0]) * 3600) / ins.step)))
          cross.attr('x1', X(i)).attr('x2', X(i)).attr('opacity', 1)
          const l = labelAt(ins, i)
          const lab = l === 0 ? 'normal' : l === -1 ? 'unlabelled' : l >= 100 ? 'transient' : 'fault'
          const t0 = new Date(new Date(ins.start + 'Z').getTime() + i * ins.step * 1000)
          tip(tipRows(`${t0.toISOString().slice(0, 16).replace('T', ' ')} · ${lab}`, [
            ...tags.map(t => [`${t} — ${TAGS[t]?.label ?? t}`, ins.ch[t][i] == null ? '—' : `${fmt(val(t, ins.ch[t][i]!), 1)} ${unit(t)}`] as [string, string]),
            ['Detector score', fmt(dt.score[i], 2)], ['In alarm', dt.alarm[i] ? 'yes' : 'no'],
          ]), ev)
        })
        .on('pointerleave', () => { cross.attr('opacity', 0); tip(null) })
      parts = { clip, head, marks, xs, H }
    }

    function redraw() {
      if (!parts) return
      const it = items[sel], { ins } = it
      const X = (i: number) => parts!.xs((i * ins.step) / 3600)
      parts.clip.attr('width', X(cursor) + 2)
      const showHead = cursor < ins.n - 1 || playing
      parts.head.attr('x1', X(cursor)).attr('x2', X(cursor)).attr('opacity', showHead ? 0.8 : 0)
      const seen = it.det.alarms.filter(a => a.i <= cursor)
      const m = parts.marks.selectAll<SVGGElement, typeof seen[0]>('g.m').data(seen, a => String(a.i))
      const en = m.enter().append('g').attr('class', 'm')
      en.append('line').attr('y1', 0).attr('y2', parts.H).attr('stroke', 'var(--gas)').attr('stroke-dasharray', '4 3').attr('stroke-width', 1.5)
      en.append('text').attr('class', 'lbl-mono').attr('y', 30).attr('fill', 'var(--gas)')
      en.attr('opacity', 0).transition().duration(dur(300)).attr('opacity', 1)
      m.exit().remove()
      parts.marks.selectAll<SVGGElement, typeof seen[0]>('g.m').each(function (a, k) {
        const x = X(a.i), gsel = d3.select(this)
        gsel.select('line').attr('x1', x).attr('x2', x)
        const right = x > (parts!.xs.range()[1] * 0.7)
        gsel.select('text').attr('y', 30 + (k % 2) * 14).attr('x', right ? x - 4 : x + 4).attr('text-anchor', right ? 'end' : 'start').text(`▲ ${a.guess || 'change'}`)
      })
      renderSide(seen.length)
    }

    let lastKey = ''
    function renderSide(nSeen: number) {
      const it = items[sel], { ins, det, sc } = it
      const key = `${sel}:${nSeen}:${cursor >= ins.n - 1}`
      if (key === lastKey) return
      lastKey = key
      const kpi = (l: string, v: string, s?: string) => h('div', { class: 'kpi' }, h('div', { class: 'l' }, l), h('div', { class: 'v', style: { fontSize: '17px' } }, v), s ? h('div', { class: 's' }, s) : null)
      const done = cursor >= ins.n - 1
      const seen = det.alarms.filter(a => a.i <= cursor)
      const latest = seen[seen.length - 1]
      side.innerHTML = ''
      side.append(
        h('span', { class: 'eyebrow' }, `${ins.well} · ${ins.id.split('_')[1]?.slice(0, 8) ?? ''}`),
        h('div', { class: 'kpis' },
          kpi('Expert label', ins.event, `class ${ins.cls}`),
          kpi('Detector', !done ? `${seen.length} alarm${seen.length === 1 ? '' : 's'} so far` : sc.onset == null ? (sc.falseAlarms ? `${sc.falseAlarms} false alarm(s)` : 'quiet ✓') : sc.detectedAt == null ? 'missed ✗' : 'detected ✓',
            done && sc.delayMin != null ? `delay ${fmt(sc.delayMin, 1)} min` : done ? `${det.alarms.length} alarms in total` : 'replaying…'),
          ...(done && sc.onset != null ? [kpi('Named as', sc.guess ?? '—', sc.correct ? '✓ matches the label' : '✗ does not match')] : []),
          ...(done ? [kpi('False alarms', String(sc.falseAlarms), 'in bins labelled normal')] : [])),
        h('div', { class: 'small muted', style: { lineHeight: 1.6 } }, EVENT_NOTE[ins.cls] ?? ''),
        ...(latest ? [h('span', { class: 'eyebrow' }, `Latest alarm · ${fmt((latest.i * ins.step) / 3600, 2)} h`),
          h('div', { class: 'small', style: { lineHeight: 1.6 } }, h('div', { class: 'mono' }, `▲ ${latest.guess || 'change detected'}`),
            ...latest.reasons.map(r => h('div', { class: 'muted' }, `· ${r}`)),
            h('div', { class: 'muted' }, `channels: ${latest.tags.join(', ')}`))] : []),
        h('div', { class: 'small muted' }, 'Hover the lanes for every channel at that moment. Tag names are the original 3W names.'))
    }

    function drawTable() {
      tableBox.innerHTML = ''
      const tot = items.filter(it => it.sc.onset != null)
      const det = tot.filter(it => it.sc.detectedAt != null).length, named = tot.filter(it => it.sc.correct).length
      const fa = d3.sum(items, it => it.sc.falseAlarms)
      tableBox.append(
        h('div', { class: 'small', style: { padding: '0 0 8px' } }, `${det} / ${tot.length} events detected · ${named} / ${tot.length} named correctly · ${fa} false alarm${fa === 1 ? '' : 's'} across ${items.length} instances. Thresholds were tuned on these instances, so this is a demonstration, not a validation.`),
        h('table', { class: 'data' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Instance'), h('th', {}, 'Expert label'), h('th', { class: 'num' }, 'Delay'), h('th', { class: 'num' }, 'False alarms'), h('th', {}, 'Named as'))),
          h('tbody', {}, ...items.map((it, i) => h('tr', { class: i === sel ? 'sel' : null, onclick: () => { sel = i; stop(); cursor = items[sel].ins.n - 1; drawList(); rebuild() } },
            h('td', { class: 'mono' }, it.ins.well),
            h('td', {}, it.ins.event),
            h('td', { class: 'num' }, it.sc.onset == null ? '—' : it.sc.delayMin == null ? 'missed' : `${fmt(it.sc.delayMin, 1)} min`),
            h('td', { class: 'num' }, String(it.sc.falseAlarms)),
            h('td', { class: it.sc.correct === false ? 'warn' : '' }, it.sc.onset == null ? '—' : `${it.sc.guess ?? '—'} ${it.sc.correct ? '✓' : '✗'}`))))))
    }
    rebuild()
  }).catch(err => { if (alive) { center.innerHTML = ''; center.append(h('div', { class: 'empty' }, `Could not load the 3W data: ${err.message}`)) } })

  return () => { alive = false; cancelAnimationFrame(raf); chart?.destroy() }
}
