"""Generate "Field X": a synthetic 40-well offshore oil field for population-scale review.

Field X is SYNTHETIC. It is shaped like a late-life, gas-lift-dominated offshore field so the
screening, ranking and portfolio views have a population to work on. Each producer is given a
hidden "true" problem mechanism; the site's diagnosis rules must recover it from the data alone.

Output: site/public/data/fieldx.json (monthly, SI units: Sm3/d, bar).
"""
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "site/public/data/fieldx.json"
rng = np.random.default_rng(42)

START_YEAR = 2012
N_MONTHS = 14 * 12
T = np.arange(N_MONTHS)

BLOCKS = {
    "A": {"x": (0.4, 3.8), "y": (0.4, 3.0), "p0": 240.0},
    "B": {"x": (4.4, 7.8), "y": (0.8, 3.8), "p0": 226.0},
    "C": {"x": (1.8, 5.8), "y": (3.6, 6.4), "p0": 252.0},
}
PB = 200.0  # bubble point, bar

MECHS = (["healthy"] * 12 + ["channeling"] * 5 + ["coning"] * 3 + ["damage"] * 4 +
         ["gaslift_sub"] * 4 + ["idle"] * 3 + ["sand"] * 2 + ["choke"] * 1)
LIFT_FOR = {"gaslift_sub": "GL", "sand": "ESP", "choke": "NF"}
PWF_MIN = {"GL": 95.0, "ESP": 55.0, "NF": 140.0}
ZONE_NAMES = ["I-35", "I-60", "J-18", "J-40", "K-10"]


def block_pressure(p0: float) -> np.ndarray:
    decline = 42 * (1 - np.exp(-T / 55))
    support = np.where(T > 30, 18 * (1 - np.exp(-(T - 30) / 40)), 0)
    return p0 - decline + support + rng.normal(0, 0.4, N_MONTHS)


def r(a, b):
    return float(rng.uniform(a, b))


def make_injectors(blocks):
    injs = []
    kinds = ["matrix", "fracture", "plugging", "matrix", "fracture", "plugging"]
    for i, (bk, kind) in enumerate(zip(["A", "A", "B", "B", "C", "C"], kinds)):
        b = BLOCKS[bk]
        start = int(rng.integers(24, 40))
        tvd = r(1900, 2300)
        q = np.zeros(N_MONTHS)
        level = r(900, 1500)
        for t in range(start, N_MONTHS):
            if (t - start) % int(rng.integers(12, 24)) == 0 and t > start:
                level *= r(0.85, 1.25)
            q[t] = level
        if kind == "fracture":
            q[start:] *= np.linspace(1.0, 1.7, N_MONTHS - start)
        q *= np.where(rng.random(N_MONTHS) < 0.06, r(0.0, 0.4), 1.0)
        ii0 = r(28, 45)
        pres = blocks[bk]
        pfrac = pres.max() + r(24, 32)
        tf = start + int(rng.integers(30, 50))
        ii = np.full(N_MONTHS, ii0)
        if kind == "plugging":
            ii = np.where(T > start, ii0 / (1 + (T - start) / 45), ii0)
        elif kind == "matrix":
            ii = ii0 * (1 - 0.0004 * np.clip(T - start, 0, None))
        pbh = pres + q / ii
        if kind == "fracture":
            over = (T > tf) & (pbh > pfrac)
            pbh = np.where(over, pfrac + (pbh - pfrac) * 0.12, pbh)
        pbh = np.where(q > 0, pbh + rng.normal(0, 1.2, N_MONTHS), np.nan)
        whp = pbh - 0.098 * tvd
        injs.append({
            "id": f"XI-{i + 1:02d}", "block": bk, "type": "injector", "lift": "Injector", "truth": kind,
            "x": round(r(*b["x"]), 2), "y": round(r(*b["y"]), 2), "start": start, "tvd": round(tvd),
            "q": q, "bhp": pbh, "whp": whp,
        })
    return injs


def wor_curve(mech: str, tp: np.ndarray, tb: float) -> np.ndarray:
    after = np.clip(tp - tb, 0, None)
    if mech == "channeling":
        w = 0.03 + 0.09 * (after / 6) ** 1.8
    elif mech == "coning":
        w = 0.02 + r(1.6, 2.6) * (1 - np.exp(-after / 14)) + 0.004 * after
    else:
        w = 0.02 + np.where(after > 0, 0.04 * np.exp(0.028 * after) - 0.04, 0)
    return np.where(tp >= 0, w, 0)


def make_producer(i, mech, lift, blocks, injs):
    bk = ["A", "B", "C"][i % 3]
    b = BLOCKS[bk]
    pres = blocks[bk]
    start = int(rng.integers(0, 60))
    tp = T - start
    tvd = r(1800, 2500)
    pi_ref = r(1.5, 6)
    pwf_min = PWF_MIN[lift]
    offset = r(8, 22)
    tb = {"channeling": r(22, 45), "coning": r(3, 10)}.get(mech, r(35, 70))

    wor = wor_curve(mech, tp, tb)
    wc = wor / (1 + wor)
    pi = pi_ref * (1 - 0.35 * wc)
    events = [{"t": start, "type": "start", "label": "Online"}]

    pwf = np.full(N_MONTHS, pwf_min + offset)
    choke = np.full(N_MONTHS, r(45, 80))
    gl = np.zeros(N_MONTHS)
    if lift == "GL":
        gl[:] = r(35e3, 60e3)

    if mech == "damage":
        te = start + int(rng.integers(50, 90))
        pi = np.where(T > te, pi * np.maximum(0.42, np.exp(-(T - te) / 30)), pi)
        events.append({"t": te, "type": "workover", "label": "Scale squeeze (suspect)"})
    if mech == "gaslift_sub":
        te = start + int(rng.integers(40, 80))
        pwf = np.where(T > te, pwf_min + r(48, 62), pwf)
        gl = np.where(T > te, gl * r(0.35, 0.5), gl)
        events.append({"t": te, "type": "gl_change", "label": "Lift gas cut / valve issue"})
    if mech == "choke":
        te = start + int(rng.integers(30, 60))
        pwf = np.where(T > te, pwf_min + r(60, 75), pwf)
        choke = np.where(T > te, r(18, 26), choke)
        events.append({"t": te, "type": "choke", "label": "Choked back (reason undocumented)"})

    ql = np.clip(pi * (pres - pwf), 0, None)

    # Injector support: connected injectors push liquid and, for channeling wells, water.
    links = []
    for inj in injs:
        if inj["block"] != bk:
            continue
        w = r(0.05, 0.35)
        if mech == "channeling" and inj["truth"] == "fracture":
            w = r(0.7, 0.9)
        links.append({"inj": inj["id"], "w": round(w, 2)})
        lag = np.roll(inj["q"], 1)
        dev = lag - inj["q"][inj["q"] > 0].mean() if (inj["q"] > 0).any() else lag * 0
        ql = ql + 0.08 * w * np.where(inj["q"] > 0, dev, 0)
    ql = np.clip(ql, 0, None)

    oil = ql / (1 + wor)
    wat = ql - oil
    if mech == "channeling":
        frac = next((x for x in injs if x["block"] == bk and x["truth"] == "fracture"), None)
        if frac is not None:
            extra = np.where(tp > tb, 0.25 * np.roll(frac["q"], 1), 0)
            wat = wat + extra
    gor = 95 * (1 + 0.025 * np.clip(PB - pres, 0, None))
    uptime = np.clip(rng.normal(0.95, 0.03, N_MONTHS), 0.6, 1.0)
    down = rng.random(N_MONTHS) < 0.04
    uptime[down] = r(0.1, 0.5)

    if mech == "sand":
        for _ in range(int(rng.integers(3, 6))):
            ts = start + int(rng.integers(20, N_MONTHS - start - 2))
            uptime[ts:ts + 2] *= 0.55
            choke[ts:] = np.maximum(choke[ts:] - r(3, 8), 20)
            events.append({"t": ts, "type": "sand", "label": "Sand production, choked back"})
    if mech == "idle":
        ti = start + int(rng.integers(70, 110))
        ti = min(ti, N_MONTHS - 12)
        uptime[ti:] = 0
        events.append({"t": ti, "type": "shutin", "label": rng.choice(["Shut-in: high water cut",
                                                                      "Shut-in: tubing leak",
                                                                      "Shut-in: lift failure"])})

    noise = rng.normal(1, 0.035, N_MONTHS)
    on = (tp >= 0).astype(float) * uptime
    oil = oil * noise * on
    wat = wat * rng.normal(1, 0.04, N_MONTHS) * on
    gas = oil * gor
    gl = gl * (on > 0)
    alive = on > 0
    pwf_meas = np.where(alive, pwf + rng.normal(0, 1.5, N_MONTHS), np.nan)
    grad = {"NF": 0.058, "GL": 0.036, "ESP": 0.0}[lift] + 0.018 * wc
    whp = np.where(lift == "ESP", r(12, 20) + rng.normal(0, 0.8, N_MONTHS), pwf_meas - grad * tvd)
    whp = np.where(alive, np.maximum(whp, 6), np.nan)

    bt = np.argmax((wc > 0.1) & (tp >= 0))
    if wc[bt] > 0.1:
        events.append({"t": int(bt), "type": "breakthrough", "label": "Water breakthrough (WC > 10 %)"})

    tests = []
    t = start + int(rng.integers(3, 8))
    while t < N_MONTHS:
        if alive[t]:
            tests.append({"t": int(t), "ql": round(float(ql[t] * rng.normal(1, 0.04)), 1),
                          "pwf": round(float(pwf[t] + rng.normal(0, 2)), 1),
                          "wc": round(float(wc[t]), 3), "pres": round(float(pres[t] + rng.normal(0, 3)), 1)})
        t += int(rng.integers(9, 16))

    zones = sorted(rng.choice(len(ZONE_NAMES), size=int(rng.integers(2, 4)), replace=False).tolist())
    md = tvd * r(1.15, 1.6)
    ztops = np.sort(rng.uniform(md - 260, md - 40, len(zones)))
    suspect = None
    if mech in ("channeling", "coning"):
        suspect = len(zones) - 1 if mech == "coning" else int(rng.integers(0, len(zones)))
    completion = {
        "illustrative": True, "lift": {"GL": "Gas lift", "ESP": "ESP", "NF": "Natural flow"}[lift],
        "td": round(md), "tvd": round(tvd), "tubing": float(rng.choice([3.5, 4.5])),
        "sssv": round(r(120, 180)), "packer": round(md - 300),
        "glm": [round(d) for d in np.linspace(600, md - 380, 4)] if lift == "GL" else [],
        "esp": round(md - 340) if lift == "ESP" else None,
        "zones": [[round(z), round(z + r(12, 30)), ZONE_NAMES[k]] for z, k in zip(ztops, zones)],
        "suspectZone": suspect,
        "barriers": [
            {"name": "Tubing", "status": "ok"},
            {"name": "A-annulus", "status": "warn" if rng.random() < 0.12 else "ok"},
            {"name": "SSSV test", "status": "warn" if rng.random() < 0.2 else "ok"},
        ],
    }
    return {
        "id": f"X-{i + 1:02d}", "block": bk, "type": "producer", "lift": completion["lift"], "truth": mech,
        "x": round(r(*b["x"]), 2), "y": round(r(*b["y"]), 2), "start": start,
        "pwfMin": pwf_min, "links": links, "events": sorted(events, key=lambda e: e["t"]),
        "tests": tests, "completion": completion,
        "s": {"oil": oil, "wat": wat, "gas": gas, "gl": gl, "bhp": pwf_meas, "whp": whp,
              "choke": np.where(alive, choke, np.nan), "up": on},
    }


def inject_qa_artifacts(prods):
    """A few realistic data problems for the QA/QC panel to find."""
    a, b, c = prods[4], prods[13], prods[22]
    s = a["s"]["bhp"]; s[90:97] = np.nan
    b["s"]["wat"][100] = -abs(b["s"]["wat"][100]) - 5
    c["s"]["oil"][120] *= 3.2
    return [a["id"], b["id"], c["id"]]


def qa(w):
    s = w["s"]
    flags = []
    alive = np.nan_to_num(s["oil"]) > 0

    def add(rule, mask, sev, detail):
        n = int(np.sum(mask))
        if n:
            idx = np.flatnonzero(mask)
            flags.append({"rule": rule, "severity": sev, "days": n, "unit": "months",
                          "first": month_str(idx[0]), "last": month_str(idx[-1]), "detail": detail})

    add("negative_volume", (s["wat"] < 0) | (s["oil"] < 0), "high", "Negative allocated volume")
    add("bhp_missing", alive & np.isnan(s["bhp"]), "medium", "Producing with no valid downhole pressure")
    o = np.where(alive, s["oil"], np.nan)
    med = np.array([np.nanmedian(o[max(0, k - 6):k + 7]) if alive[k] else np.nan for k in range(N_MONTHS)])
    add("rate_spike", alive & (o > 1.8 * med), "low", "Monthly oil rate spike vs 13-month median")
    return flags


def month_str(t: int) -> str:
    return f"{START_YEAR + t // 12}-{t % 12 + 1:02d}"


def arr(x, d=1):
    x = np.asarray(x, dtype=float)
    return [None if np.isnan(v) else round(float(v), d) for v in x]


def main():
    blocks = {k: block_pressure(v["p0"]) for k, v in BLOCKS.items()}
    injs = make_injectors(blocks)
    mechs = list(MECHS)
    rng.shuffle(mechs)
    lifts = []
    for m in mechs:
        lifts.append(LIFT_FOR.get(m) or rng.choice(["GL"] * 6 + ["ESP"] * 2 + ["NF"] * 2))
    prods = [make_producer(i, m, l, blocks, injs) for i, (m, l) in enumerate(zip(mechs, lifts))]
    inject_qa_artifacts(prods)

    wells = []
    for p in prods:
        s = p.pop("s")
        p["qa"] = qa({"s": s})
        p["series"] = {"oil": arr(s["oil"]), "wat": arr(s["wat"]), "gas": arr(s["gas"], 0),
                       "gl": arr(s["gl"], 0), "bhp": arr(s["bhp"]), "whp": arr(s["whp"]),
                       "choke": arr(s["choke"]), "hrs": arr(s["up"] * 24, 2)}
        wells.append(p)
    for inj in injs:
        q, bhp, whp = inj.pop("q"), inj.pop("bhp"), inj.pop("whp")
        inj["qa"] = []
        inj["events"] = [{"t": inj["start"], "type": "start", "label": "Injection start"}]
        inj["tests"] = []
        inj["completion"] = {"illustrative": True, "lift": "Injector", "td": round(inj["tvd"] * 1.2),
                             "tvd": inj["tvd"], "tubing": 4.5, "sssv": 150, "packer": round(inj["tvd"] * 1.2 - 250),
                             "glm": [], "esp": None, "zones": [[round(inj["tvd"] * 1.2 - 180), round(inj["tvd"] * 1.2 - 120), "J-18"]],
                             "suspectZone": None, "barriers": [{"name": "Tubing", "status": "ok"},
                                                               {"name": "A-annulus", "status": "ok"}]}
        inj["series"] = {"wi": arr(q), "bhp": arr(bhp), "whp": arr(whp), "hrs": arr(np.where(q > 0, 24, 0), 1)}
        wells.append(inj)

    out = {
        "meta": {"id": "fieldx", "label": "Field X (synthetic)", "real": False, "frequency": "monthly",
                 "start": f"{START_YEAR}-01", "months": N_MONTHS, "pb": PB,
                 "units": {"rate": "Sm3/d", "gas": "Sm3/d", "pressure": "bar"},
                 "note": "Synthetic field generated by pipeline/fieldx.py (seed 42). Not real data."},
        "blocks": [{"id": k, "x": v["x"], "y": v["y"], "pres": arr(blocks[k])} for k, v in BLOCKS.items()],
        "wells": wells,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e3:.0f} kB): {len(prods)} producers, {len(injs)} injectors")
    for p in prods:
        last = next((v for v in reversed(p["series"]["oil"]) if v), 0)
        print(f"  {p['id']} {p['block']} {p['lift']:12} {p['truth']:12} last oil {last:7.1f}  qa={[f['rule'] for f in p['qa']]}")


if __name__ == "__main__":
    main()
