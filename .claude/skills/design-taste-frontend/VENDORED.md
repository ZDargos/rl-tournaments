# Vendored: taste-skill

- Source: https://github.com/Leonxlnx/taste-skill (`skills/taste-skill`), commit `f6b76575f949707b4e3c37cd86cb44b0b98643e8`, version 2.5.1, MIT (see LICENSE.txt).
- Installed as a project skill so Claude Code picks it up from `.claude/skills/` without the plugin marketplace.
- Local change: the `hooks:` block (a Stop hook that auto-runs `scripts/gate.mjs` in headless Chrome at the end of every turn) was removed from SKILL.md frontmatter. The checker scripts are still here and can be run by hand, e.g. `node .claude/skills/design-taste-frontend/scripts/gate.mjs <page or localhost url>`.
