# Maintenance notes

- Node is installed locally at `~/.local/node/bin` (not on the default PATH): prefix commands
  with `export PATH="$HOME/.local/node/bin:$PATH";`.
- Vite `base` is `/production-control-room/` — fetch data with `import.meta.env.BASE_URL`.
- `research_notes/` and `reports/` hold private research about the employer; they are
  git-ignored and must never be committed.
- Never add employer branding/logos or name the employer on the site.
- Do not port GPL code (e.g. pyResToolbox); implement correlations from original papers and
  cite them in the module's methods panel.
- Synthetic data must be labelled as synthetic in the UI.
