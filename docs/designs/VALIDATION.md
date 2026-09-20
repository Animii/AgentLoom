# UI comparison validation — 2026-09-20

Historical report: these comparison screens were subsequently retired following the [UX review](../UX-REVIEW.md). The current app uses one simplified interface.

Three independent Claude Code sessions generated the variants using `claude-fable-5-1`, high effort. Each received the current components, a shared shell contract and a distinct design brief in its own workspace. Their result records all confirm that model and successful completion. The coordinator integrated and reviewed the output.

The deployed Docker Compose app at http://localhost:4317 exposes Studio, Mission and Garden through a persistent comparison bar. Query parameters select shareable variants; browser storage remembers the selection. A stable portal preserves the operational component tree when the surrounding shell changes, including unsaved workflow edits. All variants use the existing backend.

## Completed checks

- TypeScript typecheck and production build passed.
- All 42 backend tests passed.
- Four existing platform browser tests passed: gated revision flow, automatic review and cancellation, workflow editing and provider discovery, failed workspace recovery.
- Four new browser tests passed: each variant's two-stage demo approval workflow, README inspection, Runs/Workflows/Agents navigation, 1440px and 390px layouts, dialogs, and switcher persistence with unsaved workflow drafts.
- The first new test runs exposed ambiguous heading selectors and Studio's decorative heading punctuation. Selectors were corrected; affected checks passed on focused reruns. No unresolved test failures remain.
- Jev browser regression passed against an isolated temporary server with a deterministic upstream fixture: key save, restart persistence, connection check, all three evaluator types, mobile layout, removal. The running app's real key was not changed.
- Desktop and mobile screenshots for all three variants were visually reviewed.
- Docker service reports healthy. The existing browser test's temporary workflow description change was restored.

## Evidence

Ignored local artifacts: `artifacts/design-provenance.json`, `design-unit-tests.txt`, `design-browser-tests.txt`, `design-browser-variants.txt`, `design-browser-studio-final.txt`, `design-jev-browser.txt`, and `design-{studio,mission,garden}-{desktop,mobile}.png`.

The three design rationales are retained alongside this report. Browser workflow exercises used demo mode; they verify application behavior without further provider charges. Actual Claude calls were used to create the designs.
