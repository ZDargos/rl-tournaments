# Website design

This is the brief the website was redesigned from, plus the tools it is built with. Use it as the prompt for any future UI work so new pages match.

## Tools

| Tool | Why |
|---|---|
| [Tailwind CSS v4](https://github.com/tailwindlabs/tailwindcss) (`@tailwindcss/vite`) | The most widely used CSS framework. Gives the reset, design tokens (`@theme` in `apps/web/src/styles.css`) and utility classes. No config file needed in v4. |
| [shadcn/ui](https://github.com/shadcn-ui/ui) approach on [Radix UI](https://github.com/radix-ui/primitives) (`radix-ui`) | shadcn/ui is the most popular React component approach today: you own the component code instead of depending on a styled library. Our primitives live in `apps/web/src/components/ui.tsx` (Tabs, Modal, DropdownMenu, Segmented, Alert…) on top of Radix, which handles keyboard navigation, focus trapping and screen readers. |
| [lucide-react](https://github.com/lucide-icons/lucide) | The icon set shadcn/ui uses: consistent, tree-shaken, one stroke weight. |
| [sonner](https://github.com/emilkowalski/sonner) | The toast library shadcn/ui recommends. Stacked, accessible notifications. |
| Barlow + Barlow Condensed (`@fontsource/*`) | Self-hosted, so no third-party font requests. |
| [Anthropic's `frontend-design` skill](https://github.com/anthropics/skills/tree/main/skills/frontend-design) | Installed in `.claude/skills/frontend-design/`. Claude Code loads it automatically when working on the UI in this repo, so future changes follow the same design discipline. |

## Claude Code design setup

These skills live in `.claude/skills/` and load automatically when Claude Code works on the UI in this repo.

| Skill | Source | What it does here |
|---|---|---|
| `frontend-design` | [anthropics/skills](https://github.com/anthropics/skills) (Apache 2.0) | Anthropic's official design skill, and the most installed one. It picks one clear visual direction before writing any code and steers away from generic "AI-made" layouts. |
| `ui-ux-pro-max` | [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) (MIT) | The most-starred community design skill. It includes searchable data (styles, palettes, font pairings, 120 UX rules and React/Tailwind stack guides) and a checklist covering accessibility, touch, layout and contrast. `references/quick-reference.md` is the audit list. |
| `web-design-guidelines` | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) (MIT) | Vercel's Web Interface Guidelines, used to review pages ("review my UI"). It reports findings as `file:line`. |

The `ui-ux-pro-max` search command runs from the repo root as `python3 .claude/skills/ui-ux-pro-max/scripts/search.py "<query>" --domain ux`. Its install path was changed from the plugin layout to the project layout.

These skills were considered and left out:
- **taste-skill.** It is built for marketing landing pages: photos, shader effects, one section per screen. It also adds a stop hook that runs its own browser checks after every turn. Neither suits an app UI.
- **Agent bundles** such as wshobson/agents and awesome-claude-code-subagents. They are general purpose, so they add little for design.

The audit with these skills changed the following:
- Muted text was below 4.5:1 contrast on panels and menus. It is now 4.9:1 or higher on every surface.
- Added a "Skip to content" link.
- Tap targets are at least 44px on touch screens.
- Inputs use 16px text on phones so iOS doesn't zoom in.
- The tap delay and grey tap flash are gone on mobile.
- Focused fields scroll clear of the sticky header.
- Headings wrap in balanced lines.
- The setting help (ⓘ) targets grew to 24px.
- The "needs you" cards use the full width on phones.

Native `<input>` and `<select>` are kept (styled) on purpose: they work best on phones and with autofill.

## The brief (redesign prompt)

> Redesign the RL Tournaments website, a free tool for running Rocket League tournaments from a Discord server. Keep every existing feature, route, API call and permission check working exactly as before; only the presentation and organization change. Run `npm run typecheck`, `npm test` and `npm run test:e2e` before you finish, and look at screenshots at 1280px and 390px.
>
> **Who uses it.** Players arrive from a Discord link, often on a phone, and want to know one thing: what do I need to do (join, vote, answer, check in, report a score)? Organizers are usually on a desktop and want to move the tournament to its next step without hunting through settings.
>
> **Ease of use rules.**
> 1. Every page leads with the viewer's next action. On a tournament page, anything that needs the player (their live match, a date change question, a start time vote) sits at the top, then registration, then everything else. On phones it stacks in that order.
> 2. The organizer's control panel shows the lifecycle as a stepper and makes the most likely next step the one orange button.
> 3. Organizer tools are a side menu on desktop (a scrolling tab strip on phones): Control panel, Registrations, 6mans, Matches, Settings, Admins & access, Activity. Counts (pending registrations, matches needing attention) sit on the menu items.
> 4. Long forms are split into titled sections with one-line explanations, and the Save button stays in reach (sticky).
> 5. Copy is plain, sentence case, verb-first ("Move to the new date", "Ask everyone if they can make it"). An action keeps the same name in its button and its toast. Empty states say what to do next.
>
> **Look: match night.** Dark, because people play at night and the game is played under stadium lights, but navy rather than black. The two team colors carry meaning everywhere and are the only accents: blue is side A, orange is side B and also the "boost" color for primary actions. Green, red and yellow are reserved for status.
>
> | Token | Hex | Use |
> |---|---|---|
> | pitch | `#0b1324` | page background, inputs |
> | stand | `#111b30` | panels |
> | line | `#24355a` | borders, dividers |
> | ink / dim | `#eaf0fa` / `#96a3c0` | text / secondary text |
> | blue | `#3b8bff` | side A, links, focus |
> | orange | `#ff8a1f` | side B, primary buttons |
>
> **Type.** Barlow Condensed (700–800) for headings, team names and scores, like a broadcast graphic; Barlow for everything else. Numbers are tabular. No all-caps labels.
>
> **The one bold element** is the scorebug: match headers are drawn like the in-game score display, a blue slab and an orange slab with slanted edges around the score. The brand mark and the tournament banner's blue/orange edge echo it. Everything else stays quiet: flat panels with 1px borders, one radius per level (12px panels, 9px controls, round chips), no decorative gradients on cards, motion only in response to an action.
>
> **Quality floor.** Works at 375px with no sideways scrolling (wide tables and brackets scroll inside their box), visible keyboard focus, Radix primitives for anything interactive, respects reduced motion.

## Where things are

- Tokens and component classes: `apps/web/src/styles.css`
- Primitives: `apps/web/src/components/ui.tsx`
- Date change vote UI: `apps/web/src/components/DateVote.tsx`
