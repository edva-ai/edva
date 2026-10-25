# ext/ — owner-approved, agent-authored capability modules (WP11)

Modules here were **written by Edva** and **explicitly approved by the user** before
they were allowed to load (see `system/wp11-self-improvement-gate-design.md`).
Each is a WP5 plugin (`<name>/manifest.json` + optional `index.mjs`). They are served
as real `mcp__tools__*` tools + skills by `tools-mcp`.

- `.staging/` — proposals awaiting owner review (transient, gitignored). NOT loaded.
- Approved modules are git-committed for reviewability + reversibility.
- Rails: a module referencing financial/destructive/outbound capabilities is refused
  at propose time and never reaches here. Kill-switch: `data/self-improve-disabled`.
