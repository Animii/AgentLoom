# Garden: a calm review workspace

Garden treats AgentLoom as a place where a person reads agent work and decides what happens next.
The interface is quiet until a decision is needed, and then the decision is the loudest thing on the page.

## Files

- `GardenShell.tsx` is the shell. It renders the sidebar, the review summary, and `children` exactly once.
- `garden.css` holds all styling. Every selector is scoped under `.design-garden`.

## Principles

1. **Approvals first.** The approval queue is the only element that changes weight. With runs waiting it becomes a deep forest block with a large serif count and a cream "Review approvals" button. With nothing waiting it relaxes into pale sage with a check mark.
2. **Editorial hierarchy.** Headings, counts, and run titles in the detail view use a system serif stack. Body text and controls stay in the system sans at 15px for legibility.
3. **Whitespace over boxes.** Totals, activity, and the run list use hairlines and one shared surface instead of many separate cards.
4. **Only real data.** The shell shows the four values from `props.summary` and nothing else. There are no invented projects, metrics, charts, or connection claims.

## Layout

- **Sidebar, 264px, pale sage.** Brand, the "Start a workflow" call to action, the parent navigation inside `nav[aria-label="Primary"]`, and a local workspace note. DOM order matches visual order on every breakpoint. The inner column is sticky below the 76px switcher.
- **Review summary.** One rounded band split in two. The left side is the approval queue with its action. The right side is a typographic run ledger showing running, finished, and all runs.
- **Runs board.** The run list is a single surface with hairline rows and a sticky column. Selected rows carry a forest rule. Rows waiting for approval carry an amber rule. The detail panel has a numbered step timeline, underline tabs, and a decision bar that sticks to the bottom of the viewport. When approval is possible the bar turns amber and is labelled "Your decision".
- **Run totals.** The existing totals stay visible as a slim inline strip so they do not compete with the summary band.
- **Workflows and Agents.** Large panels, italic serif step headings, a forest "Save workflow" button, and an auto fitting provider grid. The nested Jev panel becomes a flat section with a hairline.
- **Dialog.** Wider padding, a serif title, full width title and mode fields. It inherits the tokens from the root.

## Tokens

The existing variables are overridden on the root element only. `--violet` maps to forest `#2f5d44` and `--violet-soft` maps to sage `#e0ebdd`, so every existing accent follows. Extra tokens are `--serif`, `--forest-deep`, `--well`, `--hover`, `--field-border`, and `--garden-offset`.

## Responsive behaviour

| Width | Behaviour |
| --- | --- |
| Above 1240px | 264px sidebar, 360px run list beside the detail panel |
| 1081 to 1240px | 228px sidebar, 300px run list, narrower ledger |
| 760 to 1080px | 208px sidebar, summary ledger moves under the queue, board stacks, run list scrolls within a capped height, "Back to runs" appears |
| Below 760px | Sidebar becomes a top bar with brand, call to action, and three equal navigation tabs. The queue band is compact. Totals sit in a two column grid. Fields use 16px text. Dialog actions stack. |

The shell uses `min-height: calc(100dvh - 76px)` with natural page scrolling. `.main` no longer scrolls on its own. Because scoped rules outrank the base media queries, every responsive rule is declared again in `garden.css`.

## Accessibility

- Body and muted text meet 4.5:1 on paper, panel, and sidebar. Field borders meet 3:1.
- Every interactive element has a visible 2px focus outline. It switches to cream on the forest block.
- Touch targets are 44px or larger for navigation, primary actions, tabs, and fields.
- The queue headline is a polite status region, so a change in the waiting count is announced once.
- Shell buttons are named "Start a workflow", "Review approvals", and "Open approval queue", so they never duplicate "New run".
- `prefers-reduced-motion` removes transitions and animation.
- `:has()` is used only for enhancement. Without it the amber markers and active step marker fall back to the neutral style.
