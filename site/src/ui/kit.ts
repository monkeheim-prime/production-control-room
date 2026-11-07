// Small DOM/D3 helpers shared by the views.
import * as d3 from 'd3'

export const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
export const dur = (ms: number) => (reduced() ? 0 : ms)

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...kids: (Node | string | null | undefined | false)[]) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v)
    else if (k === 'html') el.innerHTML = v
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of kids) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(c))
  return el
}

export const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

// ---------- tooltip ----------
let tipEl: HTMLDivElement | null = null
export function tip(html: string | null, ev?: MouseEvent | PointerEvent) {
  if (!tipEl) { tipEl = h('div', { class: 'tip', role: 'status' }); document.body.append(tipEl) }
  if (!html || !ev) { tipEl.classList.remove('on'); return }
  tipEl.innerHTML = html
  tipEl.classList.add('on')
  const pad = 14, r = tipEl.getBoundingClientRect()
  let x = ev.clientX + pad, y = ev.clientY + pad
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - pad
  if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - pad
  tipEl.style.left = `${x}px`; tipEl.style.top = `${y}px`
}
export const tipRows = (title: string, rows: [string, string][]) =>
  `<div class="t">${esc(title)}</div>` + rows.map(([k, v]) => `<div class="r"><span class="muted">${esc(k)}</span><span>${esc(v)}</span></div>`).join('')

// ---------- responsive chart ----------
export interface Frame { svg: d3.Selection<SVGSVGElement, unknown, null, undefined>; g: d3.Selection<SVGGElement, unknown, null, undefined>; w: number; h: number; W: number; H: number }

/** Creates (or reuses) an SVG sized to its container width. `draw` runs on every resize. */
export function responsive(container: HTMLElement, height: number | ((w: number) => number), margin: { t: number; r: number; b: number; l: number }, draw: (f: Frame, first: boolean) => void, label?: string) {
  let first = true
  let lastW = -1
  const render = () => {
    const W = Math.max(280, container.clientWidth)
    if (W === lastW && !first) return
    lastW = W
    const H = typeof height === 'function' ? height(W) : height
    let svg = d3.select(container).select<SVGSVGElement>('svg')
    if (svg.empty()) {
      svg = d3.select(container).append('svg').attr('role', 'img')
      if (label) svg.attr('aria-label', label)
      svg.append('g').attr('class', 'root')
    }
    svg.attr('viewBox', `0 0 ${W} ${H}`).attr('height', H)
    const g = svg.select<SVGGElement>('g.root').attr('transform', `translate(${margin.l},${margin.t})`)
    draw({ svg, g, w: W - margin.l - margin.r, h: H - margin.t - margin.b, W, H }, first)
    first = false
  }
  const ro = new ResizeObserver(() => requestAnimationFrame(render))
  ro.observe(container)
  render()
  return { redraw: () => { lastW = -1; render() }, destroy: () => ro.disconnect() }
}

export function axisStyle<T extends d3.Selection<any, any, any, any>>(sel: T) {
  sel.attr('class', 'axis')
  sel.selectAll('.domain').attr('stroke', 'var(--line)')
  sel.selectAll('.tick line').attr('stroke', 'var(--line)')
  return sel
}

export function grid(g: d3.Selection<SVGGElement, unknown, null, undefined>, y: d3.ScaleLinear<number, number> | d3.ScaleLogarithmic<number, number>, w: number, ticks = 4) {
  g.selectAll('g.gridline').data([0]).join('g').attr('class', 'gridline')
    .call(d3.axisLeft(y as any).ticks(ticks).tickSize(-w).tickFormat(() => '') as any)
    .lower()
}

export function slider(label: string, value: number, min: number, max: number, step: number, show: (v: number) => string, onInput: (v: number) => void) {
  const out = h('span', { class: 'mono' }, show(value))
  const input = h('input', { type: 'range', min, max, step, value, 'aria-label': label }) as HTMLInputElement
  input.addEventListener('input', () => { const v = +input.value; out.textContent = show(v); onInput(v) })
  return h('label', { class: 'field' }, h('span', { class: 'top' }, h('span', {}, label), out), input)
}

export function panel(title: string, sub?: string | Node, ...kids: (Node | null | false)[]) {
  return h('section', { class: 'panel' },
    h('header', {}, h('h2', {}, title), sub ? (typeof sub === 'string' ? h('span', { class: 'small muted' }, sub) : sub) : null),
    ...kids)
}

export function legend(items: { label: string; color: string; dash?: boolean; hollow?: boolean }[]) {
  return h('div', { class: 'small', style: { display: 'flex', flexWrap: 'wrap', gap: '6px 14px', minWidth: '0', flex: '0 1 auto' } },
    ...items.map(i => h('span', { class: 'chip', style: { flex: 'none' } },
      i.dash ? h('span', { style: { width: '14px', borderTop: `2px dashed ${i.color}`, display: 'inline-block' } })
        : h('span', { class: 'dot', style: i.hollow ? { border: `2px solid ${i.color}` } : { background: i.color } }),
      h('span', { class: 'muted' }, i.label))))
}

/** Animate a path being drawn (stroke-dashoffset). */
export function drawIn(path: d3.Selection<SVGPathElement, any, any, any>, ms = 1200, delay = 0) {
  if (reduced()) return
  path.each(function () {
    const len = (this as SVGPathElement).getTotalLength()
    d3.select(this).attr('stroke-dasharray', `${len} ${len}`).attr('stroke-dashoffset', len)
      .transition().delay(delay).duration(ms).ease(d3.easeCubicOut).attr('stroke-dashoffset', 0)
      .on('end', function () { d3.select(this).attr('stroke-dasharray', null) })
  })
}

export function download(name: string, text: string, type = 'text/csv') {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name })
  document.body.append(a); a.click(); a.remove()
}
