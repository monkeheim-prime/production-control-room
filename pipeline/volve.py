"""Clean the Equinor Volve daily production data into compact JSON for the site.

Source: Equinor and the Volve licence partners, Equinor Open Data Licence.
Input:  data/raw/volve/mehrdad.xlsx (public mirror, byte-identical sheets to a second mirror)
Output: site/public/data/volve.json

All values stay in the source units (Sm3/d, bar, degC, %); the site converts.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "data/raw/volve/mehrdad.xlsx"
OUT = ROOT / "site/public/data/volve.json"

COLS = {
    "ON_STREAM_HRS": "hrs",
    "BORE_OIL_VOL": "oil",
    "BORE_GAS_VOL": "gas",
    "BORE_WAT_VOL": "wat",
    "BORE_WI_VOL": "wi",
    "AVG_DOWNHOLE_PRESSURE": "bhp",
    "AVG_DOWNHOLE_TEMPERATURE": "bht",
    "AVG_WHP_P": "whp",
    "AVG_WHT_P": "wht",
    "AVG_CHOKE_SIZE_P": "choke",
    "AVG_DP_TUBING": "dpt",
    "AVG_ANNULUS_PRESS": "ann",
}
DECIMALS = {"gas": 0, "hrs": 2}

# Illustrative completions: Volve completion reports are not part of the production file,
# so these are generic templates and are labelled as such in the UI.
COMPLETION = {
    "F-1 C": {"lift": "Not in public data", "td": 3700, "zones": [[3460, 3520, "Hugin A"], [3560, 3600, "Hugin B"]]},
    "F-11": {"lift": "Not in public data", "td": 3800, "zones": [[3520, 3600, "Hugin A"], [3640, 3690, "Hugin B"]]},
    "F-12": {"lift": "Not in public data", "td": 3500, "zones": [[3180, 3270, "Hugin A"], [3310, 3360, "Hugin B"]]},
    "F-14": {"lift": "Not in public data", "td": 3600, "zones": [[3260, 3340, "Hugin A"], [3380, 3430, "Hugin B"]]},
    "F-15 D": {"lift": "Not in public data", "td": 4100, "zones": [[3830, 3900, "Hugin A"], [3940, 3990, "Hugin B"]]},
    "F-4": {"lift": "Injector", "td": 3400, "zones": [[3120, 3220, "Hugin"]]},
    "F-5": {"lift": "Injector", "td": 3500, "zones": [[3200, 3300, "Hugin"]]},
}


def short(name: str) -> str:
    return name.replace("15/9-", "")


def series(df: pd.DataFrame) -> dict:
    out = {}
    for src, key in COLS.items():
        v = df[src].astype(float).round(DECIMALS.get(key, 1))
        out[key] = [None if np.isnan(x) else x for x in v.tolist()]
    return out


def qa_flags(df: pd.DataFrame, monthly: pd.DataFrame, is_producer: bool) -> list:
    """Return QA/QC findings as [{rule, severity, days, first, last, detail}]."""
    flags = []

    def add(rule, mask, severity, detail):
        n = int(mask.sum())
        if n:
            d = df.loc[mask, "DATEPRD"]
            flags.append({"rule": rule, "severity": severity, "days": n,
                          "first": d.min().strftime("%Y-%m-%d"), "last": d.max().strftime("%Y-%m-%d"),
                          "detail": detail})

    vols = df[["BORE_OIL_VOL", "BORE_GAS_VOL", "BORE_WAT_VOL", "BORE_WI_VOL"]]
    add("negative_volume", (vols < 0).any(axis=1), "high", "Negative allocated volume")
    flowing = (df["BORE_OIL_VOL"].fillna(0) > 0) | (df["BORE_WI_VOL"].fillna(0) > 0)
    add("rate_without_hours", flowing & (df["ON_STREAM_HRS"].fillna(0) == 0), "high",
        "Volume reported with zero on-stream hours")
    add("hours_over_24", df["ON_STREAM_HRS"] > 24.01, "low", "On-stream hours above 24 (likely daylight-saving / timestamp artefact)")
    if is_producer:
        oil = df["BORE_OIL_VOL"].fillna(0) > 0
        add("bhp_missing", oil & ~(df["AVG_DOWNHOLE_PRESSURE"] > 0), "medium",
            "Producing with no valid downhole pressure (gauge failure or missing)")
        add("whp_missing", oil & ~(df["AVG_WHP_P"] > 0), "low", "Producing with no wellhead pressure")
        # Spike: daily oil more than 3 robust sigmas from a 31-day rolling median.
        o = df["BORE_OIL_VOL"].where(oil)
        med = o.rolling(31, center=True, min_periods=10).median()
        mad = (o - med).abs().rolling(31, center=True, min_periods=10).median() * 1.4826
        add("rate_spike", (o - med).abs() > 3 * mad.clip(lower=20), "low", "Daily oil rate outlier vs 31-day median")

    # Allocation check: daily sums vs the monthly sheet, by month.
    if not monthly.empty:
        d = df.assign(ym=df["DATEPRD"].dt.to_period("M"))
        key = "BORE_OIL_VOL" if is_producer else "BORE_WI_VOL"
        mkey = "Oil" if is_producer else "WI"
        daily_sum = d.groupby("ym")[key].sum()
        m = monthly.assign(ym=pd.PeriodIndex.from_fields(year=monthly["Year"].astype(int),
                                                        month=monthly["Month"].astype(int), freq="M"))
        m = m.set_index("ym")[mkey].astype(float)
        both = pd.concat([daily_sum.rename("d"), m.rename("m")], axis=1).dropna()
        both = both[(both["m"] > 100) | (both["d"] > 100)]
        rel = (both["d"] - both["m"]).abs() / both[["d", "m"]].max(axis=1)
        bad = rel[rel > 0.05]
        flags.append({"rule": "allocation_check", "severity": "pass" if not len(bad) else "info", "days": 0,
                      "first": str(both.index.min()), "last": str(both.index.max()),
                      "detail": f"Daily totals reconciled against the monthly sheet for {len(both)} months "
                                f"(max difference {rel.max() * 100:.2g}%)", "unit": "months"})
        if len(bad):
            flags.append({"rule": "allocation_mismatch", "severity": "medium", "days": int(len(bad)),
                          "first": str(bad.index.min()), "last": str(bad.index.max()),
                          "detail": f"{len(bad)} month(s) where daily sum differs from monthly sheet by >5% "
                                    f"(worst {rel.max() * 100:.0f}%)", "unit": "months"})
    return flags


def main() -> None:
    if not SRC.exists():
        sys.exit(f"missing {SRC}; see README for the download step")
    sheets = pd.read_excel(SRC, sheet_name=None)
    daily = sheets["Daily Production Data"]
    monthly = sheets["Monthly Production Data"].iloc[1:]  # first row holds units
    monthly = monthly.rename(columns={"Wellbore name": "well"})

    wells = []
    for name, df in daily.groupby("NPD_WELL_BORE_NAME"):
        df = df.sort_values("DATEPRD")
        full = pd.date_range(df["DATEPRD"].min(), df["DATEPRD"].max(), freq="D")
        df = df.set_index("DATEPRD").reindex(full).rename_axis("DATEPRD").reset_index()
        kinds = daily.loc[daily.NPD_WELL_BORE_NAME == name, "FLOW_KIND"].unique().tolist()
        is_producer = "injection" not in kinds or name == "15/9-F-1 C"
        wtype = "producer" if "injection" not in kinds else "injector"
        sid = short(name)
        m = monthly[monthly["well"] == name]
        flags = qa_flags(df, m, wtype == "producer")
        wells.append({
            "id": sid,
            "name": name,
            "type": wtype,
            "start": df["DATEPRD"].min().strftime("%Y-%m-%d"),
            "days": len(df),
            "completion": dict(COMPLETION.get(sid, {}), illustrative=True),
            "qa": flags,
            "series": series(df),
        })

    out = {
        "meta": {
            "id": "volve",
            "label": "Volve (Equinor)",
            "real": True,
            "frequency": "daily",
            "source": "Equinor and the Volve licence partners",
            "licence": "Equinor Open Data Licence",
            "url": "https://www.equinor.com/energy/volve-data-sharing",
            "units": {"rate": "Sm3/d", "gas": "Sm3/d", "pressure": "bar", "temperature": "degC"},
        },
        "wells": wells,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.2f} MB), {len(wells)} wells")
    for w in wells:
        print(f"  {w['id']:7} {w['type']:9} {w['start']} days={w['days']} qa={[f['rule'] for f in w['qa']]}")


if __name__ == "__main__":
    main()
