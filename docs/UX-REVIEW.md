# UI review and simplification

Reviewed and implemented on 2026-09-20 after feedback that all three variants were noisy and complicated.

## Findings and changes

| UX problem | Implemented change |
| --- | --- |
| The design switcher, branding, summary banners and totals competed with actual work. | One compact navigation header. Removed the switcher, large banners, metric cards and decorative sidebars. |
| Multiple start buttons made the hierarchy unclear. | One consistent **New run** action. |
| A long list remained above the selected run on phones. | Separate list and detail screens at every size, with **Back to runs** and preserved search/filter state. |
| Every run and step displayed several badges, model names, effort and attempt details. | Simple run rows and compact step navigation. Technical metadata lives in **Step details**. Completed status is visually quiet. |
| Browsing history required scanning every card. | Search by title, project or workflow, status filters, and 20-row progressive loading. **Needs attention** includes approvals, blocked, failed and interrupted runs. |
| Sticky approval controls covered output and tabs. | Actions follow the output in normal document flow. A sentence states which step approval will start, or whether it completes the run. |
| Approvals remained available while inspecting an earlier step. | **Review current step** returns the user to the output being approved. Approval is unavailable while drafting a revision. |
| Completed runs could fall back to the first step because the engine advances its index past the last step. | Completed runs select the final step's output. |
| Raw Markdown and full timestamp strings made reading difficult. | Text-only output formatting for headings, paragraphs, emphasis, lists and fenced code. Activity shows local time; the full timestamp remains in the semantic time element. No provider HTML or executable links are interpreted. |
| The workflow editor exposed every field of every step at once. | Collapsed step summaries expose settings on demand. Mobile uses a workflow picker rather than a long navigation list. New steps open for editing and stay open while typing. |
| Provider setup and evaluator forms dominated the Agents page. | Connection details, Jev API settings and the optional evaluator are expandable. Installation status does not claim authentication. |
| Navigation could discard an unsaved workflow edit. | Workflow and provider views retain their mounted state when switching primary pages. |

## Deliberate limits

This is one interface rather than another visual variant. Historical design rationales remain in `docs/designs`; their runtime components were removed. Existing run history and workflow data remain available. Search and pagination operate on the list returned by the existing API; server-side pagination is outside this UI change. The output formatter supports a small safe subset of Markdown, not a complete Markdown implementation.

## Verification

- Typecheck and production build.
- 44 automated tests, including output escaping and incomplete streamed code blocks.
- All six browser tests passed: gated revisions, automatic workflows, cancellation, retries, workflow saves, search, draft persistence, new-step editing, mobile navigation, and approvals while viewing previous steps.
- Jev settings and evaluator regression on an isolated fixture server; production credentials are not changed.
- Visual review of desktop and 390px mobile screenshots under `artifacts/quiet-*.png`.
- Docker Compose service healthy after deployment. The test's temporary workflow description was restored.

The comparison work showed that passing interaction tests alone was not enough: all three previous versions functioned, but their hierarchy demanded too much attention. This iteration explicitly checks reading order, progressive disclosure and non-overlapping approval controls.

## Run overview follow-up

The next iteration adds grouped attention, active and finished sections to make multiple runs easier to supervise. Rows show the current step, its agent, completed-step progress and relative update time. Project and live/demo filters reduce test-history clutter. Groups are disjoint; failed and interrupted runs remain attention items. Each group starts with eight rows instead of the earlier global 20-row list. Filters and expansion survive opening and returning from a run.

Validated with a production build, typecheck, 44 automated tests and seven browser tests. The new browser fixture covers attention priority, progress before approval, live polling moving a run between groups, per-group pagination, combined filters, preserved navigation state and mobile overflow. Existing real-server demo workflow tests cover revisions, approvals, cancellation and recovery. Desktop and 390px screenshots were visually reviewed; the Docker service is healthy. Test-modified workflow copy was restored.
