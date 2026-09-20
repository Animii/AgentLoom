# Mission — operations console for AgentLoom

## Intent

AgentLoom is supervision work: watch runs, catch the ones waiting on a human, read output, approve or
revise. Mission treats it as an operations console rather than a studio. Deep navy surfaces, one
electric-cyan accent, hairline borders, monospace for anything that is data. Nothing decorative
competes with the run list and the run detail.

## Files

| File | Role |
| --- | --- |
| `MissionShell.tsx` | Shell only: rail, top bar, slots for `navigation` and `children`. No state, no data fetching. |
| `mission.css` | Tokens, shell layout, and a full restyle of the existing operational UI. Every selector is under `.design-mission`. |

## Layout

- **Compact rail (76px).** Brand mark, then the parent-supplied nav buttons inside `nav[aria-label="Primary"]`,
  restacked as icon-over-label. The active item gets a cyan edge bar and a tinted cell. The rail content is
  sticky at `top: 76px` so it stays clear of the comparison switcher whether that switcher scrolls or sticks.
- **Top bar (52px).** Wordmark, an `Approvals` button with the live waiting count (calls `onShowApprovals`,
  turns amber only when the count is above zero), and the `Start a workflow` call to action (calls `onNewRun`).
  A small readout of running, finished and total runs appears on Workflows and Agents. On Runs it steps aside,
  because the page already carries the full totals strip.
- **Totals strip.** The four stat cards become one segmented, single-line strip with colour pips that match
  the status colours. It costs about 40px of height instead of a card row.
- **Framed split pane.** The board is one bordered surface. The run list is a sticky, independently scrolling
  column of dense two-line rows: title and status on the first line, workflow and timestamp on the second.
  Selection is a cyan edge bar, not a glow.
- **Second split at 1280px and up.** Inside the run detail, the step timeline sits in a left pane and the
  Output, Activity and Files tabs fill the right pane, so steps and output are visible together. Below that width
  the detail returns to a single column.
- **Approval bar.** Sticky to the viewport bottom inside the detail pane, so approve, revise, retry and cancel
  stay reachable while reading long output.
- **Empty state.** The 48px hero is reduced to a compact brief with a 22px heading so the run list and
  the demo button stay in view.
- **Workflows and Agents.** Flat panels, inset step cards, a six-track field grid at 1000px and up that packs
  the step fields without reordering them, and a cyan primary treatment for `Save workflow`. The nested Jev
  panel reads as a section of its parent rather than a card inside a card.
- **Dialog.** Inherits the tokens from the shell root, with a cyan top rule, dark backdrop and dark native
  controls through `color-scheme: dark`.

## Scrolling and sizing

- Root uses `min-height: calc(100dvh - 76px)` with a `100vh` fallback, `height: auto`, and natural page scrolling.
  `.main` is set back to `overflow: visible`, which also lets the sticky list and approval bar work.
- Root uses `overflow-x: clip` so nothing can create a horizontal scrollbar without breaking sticky positioning.
- Breakpoints: 1280 (inner split), 1100 (narrower list), 900 (board stacks, list capped at 300px tall),
  760 (rail becomes a horizontal tab strip, stats go two by two, touch-sized controls, 16px inputs), 480
  (the approvals button keeps its icon and count, with the word kept for assistive technology).
- The base stylesheet's own media queries are either left in charge (form grid, providers grid, workflow editor
  columns, activity rows) or explicitly re-declared where Mission overrides the same property.

## Tokens

The existing custom properties are overridden on `.design-mission`, so `--violet` now resolves to cyan and
every component that used it follows. Mission adds a small set of `--ms-*` tokens for wells, raised hover
surfaces, field outlines and cyan text. Hard-coded light colours in the base stylesheet are each overridden.

## Accessibility

- Body text is about 15:1 on the panel colour, muted text about 7:1, and status colours are all above 4.5:1
  on their tinted chips. Field outlines are above 3:1.
- A 2px cyan focus ring on every interactive element, white on cyan-filled buttons, inset on list rows and tabs.
- Status never relies on colour alone. Chips keep their text labels and the dot is decorative.
- `prefers-reduced-motion` removes the pulse, spinner and transitions. `forced-colors` gets explicit selection outlines.
- DOM order is untouched. The dense run row uses grid placement within a single button, and the workflow
  step grid keeps source order.
- One `Primary` nav, one banner, the existing `main`. The shell call to action is named `Start a workflow`
  so it never collides with the page's `New run` button.

## Truthfulness

Every number in the shell comes from `props.summary`. There are no invented projects, metrics, charts or
connection indicators. The rail's `local` tag is a static label, not a status.
