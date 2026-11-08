"""Prepare a handful of real Petrobras 3W instances for the event-detection page.

Source: https://github.com/petrobras/3W (dataset v2, CC BY 4.0).
Vargas et al. (2019), "A realistic and public dataset with rare undesirable real events in oil wells",
Journal of Petroleum Science and Engineering 181, 106223.

Download (raw parquet files go to data/raw/3w/<class>/, git-ignored):
    for f in 0/WELL-00001_20170424170042 0/WELL-00006_20170209090207 1/WELL-00002_20140126180030 2/WELL-00011_20140530083203 \
             3/WELL-00001_20170320120025 4/WELL-00002_20140121070214 5/WELL-00016_20180426131710 \
             6/WELL-00002_20140301141700; do
        mkdir -p data/raw/3w/${f%%/*}
        curl -sSL -o data/raw/3w/$f.parquet https://raw.githubusercontent.com/petrobras/3W/main/dataset/$f.parquet
    done
    .venv/bin/pip install pyarrow==17.0.0
    .venv/bin/python -I pipeline/threew.py

Output: site/public/data/3w.json — 15-second means of the useful channels, plus the expert label per bin.
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / 'data' / 'raw' / '3w'
OUT = ROOT / 'site' / 'public' / 'data' / '3w.json'
STEP = 15  # seconds per bin

INSTANCES = [
    ('0', 'WELL-00001_20170424170042'),
    ('0', 'WELL-00006_20170209090207'),
    ('1', 'WELL-00002_20140126180030'),
    ('2', 'WELL-00011_20140530083203'),
    ('3', 'WELL-00001_20170320120025'),
    ('4', 'WELL-00002_20140121070214'),
    ('5', 'WELL-00016_20180426131710'),
    ('6', 'WELL-00002_20140301141700'),
]
CLASSES = {
    0: 'Normal operation', 1: 'Abrupt increase of BSW', 2: 'Spurious closure of DHSV', 3: 'Severe slugging',
    4: 'Flow instability', 5: 'Rapid productivity loss', 6: 'Quick restriction in PCK', 7: 'Scaling in PCK',
    8: 'Hydrate in production line', 9: 'Hydrate in service line',
}
# tag -> (scale, decimals). Pressures Pa -> bar; QGL m3/s -> 10^3 m3/d.
CHANNELS = {
    'P-PDG': (1e-5, 2), 'P-TPT': (1e-5, 2), 'T-TPT': (1, 2), 'P-MON-CKP': (1e-5, 2),
    'T-JUS-CKP': (1, 2), 'QGL': (86.4, 2), 'P-ANULAR': (1e-5, 2),
}


def usable(s: pd.Series) -> bool:
    """A channel is kept if it has data and is not a frozen zero (3W marks failed gauges as 0 or NaN)."""
    v = s.dropna()
    if len(v) < 0.5 * len(s):
        return False
    return (v.abs() > 1e-6).mean() > 0.9 and v.std() > 0


def label_of(cl: pd.Series) -> int:
    """Expert label of a bin: the last labelled sample; -1 = unlabelled."""
    v = cl.dropna()
    return int(v.iloc[-1]) if len(v) else -1


def main():
    out = []
    for cls, name in INSTANCES:
        f = RAW / cls / f'{name}.parquet'
        d = pd.read_parquet(f)
        d = d[~d.index.duplicated()].sort_index()
        t0 = d.index[0].floor(f'{STEP}s')
        bins = ((d.index - t0).total_seconds() // STEP).astype(int)
        n = int(bins.max()) + 1
        g = d.groupby(bins)
        ch = {}
        for tag, (k, dec) in CHANNELS.items():
            if tag not in d or not usable(d[tag]):
                continue
            m = g[tag].mean().reindex(range(n)) * k
            ch[tag] = [None if pd.isna(x) else round(float(x), dec) for x in m]
        lab = g['class'].apply(label_of).reindex(range(n)).fillna(-1).astype(int).tolist()
        # run-length encode labels: [[startIndex, label], ...]
        runs = [[0, lab[0]]]
        for i, v in enumerate(lab[1:], 1):
            if v != runs[-1][1]:
                runs.append([i, v])
        well = name.split('_')[0]
        out.append({
            'id': name, 'well': well, 'cls': int(cls), 'event': CLASSES[int(cls)],
            'file': f'dataset/{cls}/{name}.parquet', 'start': t0.strftime('%Y-%m-%dT%H:%M:%S'),
            'step': STEP, 'n': n, 'labels': runs, 'ch': ch,
        })
        print(f'{name}: class {cls}, {n} bins, channels {list(ch)}, labels {runs}')
    meta = {
        'source': 'Petrobras 3W dataset v2', 'url': 'https://github.com/petrobras/3W', 'licence': 'CC BY 4.0',
        'citation': 'Vargas, R.E.V. et al. (2019). A realistic and public dataset with rare undesirable real events in oil wells. '
                    'Journal of Petroleum Science and Engineering 181, 106223.',
        'note': f'Real instances only (WELL-*). {STEP}-s means of 1-Hz data; pressures in bar, temperatures in °C, '
                'QGL converted from m³/s to 10³ m³/d. Label -1 = unlabelled first hour; 1xx = transient of event xx.',
        'classes': CLASSES,
    }
    OUT.write_text(json.dumps({'meta': meta, 'instances': out}, separators=(',', ':'), ensure_ascii=False))
    print(f'wrote {OUT} ({OUT.stat().st_size / 1024:.0f} kB)')


if __name__ == '__main__':
    main()
