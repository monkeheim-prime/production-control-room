// Causal event detector for 3W well instances: EWMA baseline + two-sided CUSUM per channel,
// autocorrelation periodicity for slugging / instability, and rule signatures to name the event.
// Every quantity at bin i uses only bins ≤ i, so a replay shows exactly what an online system would see.

export type Series = (number | null)[]
export interface Instance {
  id: string; well: string; cls: number; event: string; file: string; start: string
  step: number; n: number; labels: [number, number][]; ch: Record<string, Series>
}

export const TAGS: Record<string, { label: string; kind: 'p' | 't' | 'q' }> = {
  'P-PDG': { label: 'Downhole pressure (PDG)', kind: 'p' },
  'P-TPT': { label: 'Subsea tree pressure (TPT)', kind: 'p' },
  'T-TPT': { label: 'Subsea tree temperature (TPT)', kind: 't' },
  'P-MON-CKP': { label: 'Pressure upstream of production choke', kind: 'p' },
  'T-JUS-CKP': { label: 'Temperature downstream of production choke', kind: 't' },
  'QGL': { label: 'Gas-lift rate', kind: 'q' },
  'P-ANULAR': { label: 'Annulus pressure', kind: 'p' },
}

// Channels the level-shift detector watches (annulus and gas-lift rate are context only).
const WATCH = ['P-TPT', 'T-TPT', 'P-PDG', 'P-MON-CKP']

export const P = {
  alpha: 0.01,       // EWMA weight per 15-s bin (time constant ≈ 25 min)
  k: 0.5,            // CUSUM allowance, in σ
  h: 12,             // CUSUM decision threshold, in σ
  floorP: 0.3,       // σ floor, bar
  floorT: 0.3,       // σ floor, °C
  minDevP: 2.0,      // an alarm also needs |x − μ| ≥ 2 bar …
  minDevT: 1.0,      // … or ≥ 1 °C
  warmup: 120,       // bins (30 min) before alarms are allowed
  latch: 80,         // bins (20 min) an alarm stays latched; baseline frozen meanwhile
  classifyAfter: 60, // bins (15 min) after the alarm at which the class guess is scored
}

// Fast oscillation (flow instability): autocorrelation peak of a detrended 20-min window.
export const INSTAB = { win: 80, lag: [4, 32] as [number, number], amp: [0.3, 3] as [number, number], acf: 0.55, on: 2, off: 8, label: 'Flow instability' }
// Slow, large oscillation (severe slugging): a zigzag of P-TPT swings ≥ 3 bar whose last two
// full cycles each last 20–120 min. Slug periods (~1 h here) are too long for a short ACF window.
export const SLUG = { swing: 3, minPeriod: 80, maxPeriod: 480, smooth: 4, label: 'Severe slugging' }

export interface Alarm { i: number; tags: string[]; kind: 'shift' | 'osc'; guess: string; reasons: string[]; guessAt: number }
export interface Detection {
  score: Float32Array          // max CUSUM / h across watched channels (≥ 1 = alarm)
  osc: { instab: Float32Array; period: Float32Array; kind: Uint8Array }  // ACF peak; period in bins; 1 slug, 2 instability
  alarm: Uint8Array            // 1 while latched or an oscillation is active
  alarms: Alarm[]
}

const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length

/** Fill short gaps by carrying the last value forward (causal). */
export function filled(s: Series | undefined, n: number): Float64Array | null {
  if (!s) return null
  const out = new Float64Array(n)
  let last = NaN
  for (let i = 0; i < n; i++) { const v = s[i]; if (v != null) last = v; out[i] = last }
  // leading NaNs take the first valid value
  const f = out.findIndex(v => !isNaN(v))
  if (f < 0) return null
  for (let i = 0; i < f; i++) out[i] = out[f]
  return out
}

/** Peak of the autocorrelation of a detrended trailing window within a lag range. */
export function periodicity(x: Float64Array, i: number, win: number, lag: [number, number]) {
  if (i + 1 < win) return { acf: 0, lag: 0, amp: 0 }
  const a = x.subarray(i + 1 - win, i + 1)
  // least-squares detrend
  const n = a.length, mx = (n - 1) / 2
  let my = 0; for (const v of a) my += v; my /= n
  let sxy = 0, sxx = 0
  for (let j = 0; j < n; j++) { sxy += (j - mx) * (a[j] - my); sxx += (j - mx) ** 2 }
  const b = sxy / sxx
  const d = new Float64Array(n)
  let lo = Infinity, hi = -Infinity, v0 = 0
  for (let j = 0; j < n; j++) { d[j] = a[j] - my - b * (j - mx); lo = Math.min(lo, d[j]); hi = Math.max(hi, d[j]); v0 += d[j] * d[j] }
  if (v0 <= 1e-9) return { acf: 0, lag: 0, amp: 0 }
  let best = 0, bestLag = 0, prev = 1, rising = false
  for (let L = 1; L <= Math.min(lag[1], n - 2); L++) {
    let s = 0
    for (let j = 0; j + L < n; j++) s += d[j] * d[j + L]
    const r = s / v0 * n / (n - L)
    if (L >= lag[0] && rising && r < prev && prev > best) { best = prev; bestLag = L - 1 }
    rising = r > prev
    prev = r
  }
  return { acf: best, lag: bestLag, amp: hi - lo }
}

export function detect(ins: Instance): Detection {
  const n = ins.n
  const X: Record<string, Float64Array> = {}
  for (const t of Object.keys(ins.ch)) { const f = filled(ins.ch[t], n); if (f) X[t] = f }
  const watch = WATCH.filter(t => X[t])
  const score = new Float32Array(n), alarm = new Uint8Array(n)
  const instab = new Float32Array(n), period = new Float32Array(n), kind = new Uint8Array(n)
  const alarms: Alarm[] = []

  // EWMA baseline and scale per channel
  const mu: Record<string, number> = {}, sd: Record<string, number> = {}, Sp: Record<string, number> = {}, Sn: Record<string, number> = {}
  for (const t of watch) {
    mu[t] = mean(Array.from(X[t].subarray(0, 40)))
    sd[t] = 0; Sp[t] = 0; Sn[t] = 0
  }
  const floor = (t: string) => (TAGS[t]?.kind === 't' ? P.floorT : P.floorP)
  const minDev = (t: string) => (TAGS[t]?.kind === 't' ? P.minDevT : P.minDevP)
  let latchUntil = -1, oscOn = 0
  let base: Record<string, number> = {}

  const p = X['P-TPT']
  let ac = { acf: 0, lag: 0, amp: 0 }
  const hits: boolean[] = []
  // zigzag state for slugging: extremes of the smoothed signal that reverse by ≥ SLUG.swing
  const ext: { i: number; v: number }[] = []
  let dir = 0, cand = { i: 0, v: p ? p[0] : 0 }
  for (let i = 0; i < n; i++) {
    // --- flow instability (evaluated every 4 bins = 1 min) with on/off hysteresis ---
    let inst = false
    if (p && i % 4 === 0) {
      ac = periodicity(p, i, INSTAB.win, INSTAB.lag)
      hits.push(ac.acf >= INSTAB.acf && ac.amp >= INSTAB.amp[0] && ac.amp <= INSTAB.amp[1])
    }
    const recent = hits.slice(-INSTAB.off)
    const wasInst = oscOn === 2
    inst = wasInst ? recent.some(Boolean) : recent.slice(-4).filter(Boolean).length >= INSTAB.on
    instab[i] = ac.acf

    // --- severe slugging: zigzag on a 1-min moving average ---
    let slug = false, slugPeriod = 0
    if (p) {
      const v = mean(Array.from(p.subarray(Math.max(0, i - SLUG.smooth + 1), i + 1)))
      if (dir >= 0 && v > cand.v) cand = { i, v }
      if (dir <= 0 && v < cand.v) cand = { i, v }
      if (dir >= 0 && cand.v - v >= SLUG.swing) { ext.push(cand); dir = -1; cand = { i, v } }
      else if (dir <= 0 && v - cand.v >= SLUG.swing) { ext.push(cand); dir = 1; cand = { i, v } }
      if (ext.length >= 5) {
        const e = ext.slice(-5)
        const p1 = e[2].i - e[0].i, p2 = e[4].i - e[2].i
        const fresh = i - e[4].i <= Math.max(p1, p2)
        if (fresh && [p1, p2].every(x => x >= SLUG.minPeriod && x <= SLUG.maxPeriod)) { slug = true; slugPeriod = (p1 + p2) / 2 }
      }
    }
    const k = i < P.warmup ? 0 : slug ? 1 : inst ? 2 : 0
    kind[i] = k
    period[i] = k === 1 ? slugPeriod : k === 2 ? ac.lag : 0
    if (k && k !== oscOn && i > latchUntil) {
      const reasons = k === 1
        ? [`P-TPT swings ≥ ${SLUG.swing} bar, last two cycles ${(slugPeriod * ins.step / 60).toFixed(0)} min apart on average`, 'regular, large, slow oscillation: liquid accumulates and is purged cyclically']
        : [`P-TPT oscillates with a period of ${(ac.lag * ins.step / 60).toFixed(1)} min`, `peak-to-peak ${ac.amp.toFixed(2)} bar, autocorrelation ${ac.acf.toFixed(2)} at that lag`]
      alarms.push({ i, tags: ['P-TPT'], kind: 'osc', guess: k === 1 ? SLUG.label : INSTAB.label, guessAt: i, reasons })
    }
    oscOn = k

    // --- level shift: EWMA residual + two-sided CUSUM ---
    let worst = 0
    const fired: string[] = []
    for (const t of watch) {
      const x = X[t][i]
      const r = x - mu[t]
      const s = Math.max(sd[t] * 1.25, floor(t))   // mean |r| × 1.25 ≈ σ for a normal residual
      const z = r / s
      Sp[t] = Math.max(0, Sp[t] + z - P.k)
      Sn[t] = Math.max(0, Sn[t] - z - P.k)
      const sc = Math.max(Sp[t], Sn[t]) / P.h
      worst = Math.max(worst, sc)
      if (sc >= 1 && Math.abs(r) >= minDev(t)) fired.push(t)
      if (i > latchUntil) {
        mu[t] += P.alpha * r
        sd[t] += P.alpha * (Math.abs(r) - sd[t])
      }
    }
    score[i] = worst
    if (i >= P.warmup && i > latchUntil && fired.length && !oscOn) {
      base = { ...mu }
      latchUntil = i + P.latch
      alarms.push({ i, tags: fired, kind: 'shift', guess: '', guessAt: i, reasons: [] })
    }
    // refresh the guess of the latest shift alarm while it is young
    const last = alarms[alarms.length - 1]
    if (last && last.kind === 'shift' && i - last.i <= P.classifyAfter) {
      const g = classify(X, base, i, last.i, ins.step)
      last.guess = g.guess; last.reasons = g.reasons; last.guessAt = i
    }
    if (i === latchUntil) {
      for (const t of watch) { mu[t] = X[t][i]; Sp[t] = 0; Sn[t] = 0 }
    }
    alarm[i] = i <= latchUntil || oscOn ? 1 : 0
  }
  return { score, osc: { instab, period, kind }, alarm, alarms }
}

/** Rule signatures on changes since the alarm baseline (2-min mean of the latest bins). */
function classify(X: Record<string, Float64Array>, base: Record<string, number>, i: number, i0: number, step: number) {
  const now = (t: string) => (X[t] ? mean(Array.from(X[t].subarray(Math.max(0, i - 7), i + 1))) : NaN)
  const d = (t: string) => (X[t] && base[t] != null ? now(t) - base[t] : NaN)
  const dP = d('P-TPT'), dT = d('T-TPT'), dPDG = d('P-PDG'), dCK = d('P-MON-CKP')
  const mins = ((i - i0) * step / 60).toFixed(0)
  const f = (v: number, u: string) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)} ${u}`
  const R = (s: string) => `${s} in ${mins} min`
  if (dP < -5 && (dPDG > 1 || dT < -1))
    return { guess: 'Spurious closure of DHSV', reasons: [R(`P-TPT ${f(dP, 'bar')}`), isNaN(dPDG) ? R(`T-TPT ${f(dT, '°C')} (flow stopping)`) : R(`P-PDG ${f(dPDG, 'bar')} (pressure builds below a closed valve)`)] }
  if (dP < -3 && dT > 0.3)
    return { guess: 'Abrupt increase of BSW', reasons: [R(`P-TPT ${f(dP, 'bar')} (heavier column)`), R(`T-TPT ${f(dT, '°C')} (more water carries more heat)`)] }
  if (dT < -3)
    return { guess: 'Rapid productivity loss', reasons: [R(`T-TPT ${f(dT, '°C')} (less flow, more cooling)`), isNaN(dP) ? '' : R(`P-TPT ${f(dP, 'bar')}`)].filter(Boolean) }
  if (dP > 1.5 || dCK > 1.5)
    return { guess: 'Quick restriction in PCK', reasons: [R(`${dP > 1.5 ? 'P-TPT' : 'P-MON-CKP'} ${f(dP > 1.5 ? dP : dCK, 'bar')} (pressure rising upstream of the choke)`)] }
  return { guess: 'Unclassified change', reasons: [`no signature matched yet (P-TPT ${isNaN(dP) ? 'n/a' : f(dP, 'bar')}, T-TPT ${isNaN(dT) ? 'n/a' : f(dT, '°C')})`] }
}

export const labelAt = (ins: Instance, i: number) => {
  let l = -1
  for (const [s, v] of ins.labels) { if (s <= i) l = v; else break }
  return l
}

export interface Score {
  onset: number | null      // first bin labelled with the event (transient or steady)
  detectedAt: number | null // first bin ≥ onset at which the detector is in alarm
  delayMin: number | null
  falseAlarms: number       // alarms raised in bins labelled normal (0)
  guess: string | null      // class guess 15 min after detection
  correct: boolean | null
}

export function score(ins: Instance, det: Detection, eventName: string): Score {
  const onsetRun = ins.labels.find(([, v]) => v > 0)
  const onset = onsetRun ? onsetRun[0] : null
  const falseAlarms = det.alarms.filter(a => labelAt(ins, a.i) === 0).length
  if (onset == null) return { onset, detectedAt: null, delayMin: null, falseAlarms, guess: null, correct: null }
  let detectedAt: number | null = null
  for (let i = onset; i < ins.n; i++) if (det.alarm[i]) { detectedAt = i; break }
  // what the operator is told 15 min after detection: the latest alarm raised by then
  const by = detectedAt == null ? -1 : Math.min(ins.n - 1, detectedAt + P.classifyAfter)
  const a = detectedAt == null ? null : [...det.alarms].reverse().find(x => x.i <= by) ?? null
  const guess = a?.guess ?? null
  return {
    onset, detectedAt, falseAlarms, guess,
    delayMin: detectedAt == null ? null : (detectedAt - onset) * ins.step / 60,
    correct: guess == null ? null : guess === eventName,
  }
}
