# Production Control Room

Interactive production-engineering analyses — surveillance, nodal analysis, gas lift
optimisation, decline forecasting, debottlenecking, economics, and energy-transition
wells (CO₂ injection, geothermal, lithium brine) — built as a static site.

**Live:** https://monkeheim-prime.github.io/production-control-room/

## Structure

| Path | Purpose |
|---|---|
| `site/` | Vite + TypeScript + D3 + GSAP front end |
| `pipeline/` | Python scripts that clean source data into JSON under `site/public/data/` |
| `data/raw/` | Downloaded source data (git-ignored) |

## Data sources & licences

Derived data in this repository remains under its source licence and is **not** covered
by the code licence.

- **Volve field data** — Equinor and the Volve licence partners, Equinor Open Data Licence.
  <https://www.equinor.com/energy/volve-data-sharing>
- **3W dataset** — Petrobras, CC BY 4.0. <https://github.com/petrobras/3W>

Engineering correlations are implemented from the original published papers.

## Development

```sh
cd site
npm install
npm run dev
```

Pushing to `main` deploys to GitHub Pages via `.github/workflows/deploy.yml`.
