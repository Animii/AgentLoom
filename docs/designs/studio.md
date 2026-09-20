# AgentLoom · Creative Studio variant

A warm, editorial take on AgentLoom. The product should feel like a well-made creative tool: ivory paper, one confident burnt-orange accent, serif display type at scale, and a horizontal masthead instead of a dark sidebar.

Files: `StudioShell.tsx`, `studio.css`, `DESIGN.md`. Nothing else is touched.

## Concept

The app is about handoffs between roles, so the interface borrows from print and studio tools rather than dashboards.

- **Masthead, not sidebar.** Brand, primary navigation and the two global actions sit on one horizontal bar. The content gets the full page width.
- **Figures, not stat cards.** Run totals become a ruled row of large serif numerals under a heavy ink rule, like the figures line of a printed report.
- **Index, not card stack.** Runs read as a ruled index with serif titles. The selected run is marked with an orange edge and a lifted surface.
- **Storyboard, not timeline.** Workflow steps become numbered frames (01, 02, 03) in a responsive grid, so a run reads as a sequence of handoffs.
- **Darkroom output.** Agent output and file contents sit on a dark espresso surface. It is the one inverted element, and it makes the actual work the focal point of the detail pane.

## Shell

`StudioShell` renders, in order: the masthead, `children` exactly once, and a quiet footer. `children` is always mounted and never wrapped in anything that hides or clips it, so the dialog inherits the root tokens.

| Element | Source | Behaviour |
| --- | --- | --- |
| Primary nav | `props.navigation` inside `nav aria-label="Primary"` | Parent owns state. Styled as text tabs with an animated orange underline. |
| Workspace summary | `summary.total`, `summary.running`, `summary.finished` | Shown at 1400px and wider. Plain real counts, correct singular and plural. |
| Approvals button | `summary.approval`, `onShowApprovals` | Always enabled. Turns orange only when the real count is above zero. Accessible name reads "Approvals N waiting". |
| Start a workflow | `onNewRun` | The one orange call to action. Named differently from the in-page "New run" to keep accessible names unique. |

There are no invented projects, names, metrics, statuses or charts. The brand mark is a decorative inline SVG. The footer sentence restates privacy copy that already exists in the app.

Because the shell call to action is orange, the in-page "New run" and "Save workflow" buttons take a solid ink treatment. Each view keeps one clear accent instead of two competing ones.

## Tokens

All tokens are set on `.design-studio`, reusing the existing variable names so base rules recolour themselves. The `--violet` slot now carries burnt orange.

| Token | Value | Use |
| --- | --- | --- |
| `--paper` | `#f8f1e4` | Page ivory, with a soft peach glow top right |
| `--panel` | `#fffaf0` | Raised surfaces, dialog |
| `--violet` | `#b8400e` | Accent. 5.1:1 on paper, 5.6:1 under white text |
| `--ink` | `#241c15` | Text, heavy rules, ink buttons |
| `--muted` | `#6b6155` | Secondary text, at least 5:1 on every surface |
| `--field-border` | `#9c8a6e` | Input borders, above 3:1 against the field |
| `--darkroom` | `#221a14` | Output and file viewer |
| `--display` | Iowan Old Style, Palatino, Georgia | Titles, numerals, run and step names |
| `--font` | Avenir Next, Segoe UI, system-ui | Interface text at 15px |

Status colours were re-tuned to the warm palette: teal for running, ochre for approval, olive for completed, brick for failed. Each chip is 6:1 or better and carries a dot, so state is not colour-only. Buttons and filters are pills. Panels use 26px radii. No web fonts or new dependencies are loaded.

## Layout and responsiveness

The page scrolls naturally. The root uses `min-height: calc(100dvh - 76px)` to sit under the parent's switcher, overrides the base fixed height, and sets `.main` to `overflow: visible`. Horizontal overflow is guarded with `overflow-x: clip`, which keeps sticky positioning working.

- **Compact head.** The large title and its lede share one baseline row, so the big type costs little height and the board stays within the first screen on a desktop viewport.
- **Sticky aids.** On desktop the run index sticks below the switcher and scrolls internally. The approval bar sticks to the viewport bottom while a run is on screen, so Approve, Revise and Cancel stay reachable.
- **1020px and below.** The masthead becomes two rows: brand and actions, then navigation.
- **900px and below.** The board stacks. The run index is capped in height so the detail stays reachable. The workflow editor stacks.
- **760px and below.** Navigation becomes three equal tabs. Stats become a two by two grid. Padding tightens to 16px. Inputs go to 16px to avoid iOS zoom. The dialog goes near full width.
- **559px and below.** The Approvals label is visually hidden but kept in the accessible name. The masthead can wrap rather than overflow at 390px.

Every base media query that would conflict is overridden by specificity, since all rules carry the `.design-studio` prefix. This covers the base two-column run list, the 180px shell column, the single-column stats and the dialog sizing.

## Accessibility

- A visible 2px orange focus ring on every interactive element, including inputs, checkboxes, shell buttons and the scrollable output pane. Rings are inset where a container would clip them.
- Existing semantics such as `aria-current`, `aria-pressed`, tabs and the dialog are untouched. The shell adds one labelled list and two buttons with unique names.
- `prefers-reduced-motion` removes transitions, the spinner, and the pulse animations. `forced-colors` keeps the active navigation, selected run and active step visible.
- Touch targets are 36 to 48px. No existing control is hidden at any width.
