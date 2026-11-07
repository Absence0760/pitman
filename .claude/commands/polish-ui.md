---
description: Polish the UI/UX of one existing Pitman screen or component to the UI playbook (docs/design/ui-playbook.md) - tokens, shared element styles, dense tables, sources beside numbers, WCAG 2.2 AA, stacking at 390 px. Delegates to the `ui-polisher` agent; a new screen or a redesign goes to `ui-designer`.
argument-hint: <section, route or component path>
---

Polish the UI/UX of `$ARGUMENTS` using the `ui-polisher` agent.

## When to use this command

**Right fit:**

- A card or screen that misses the playbook: a raw colour instead of a token, a scoped rule restating an `app.css` style, a number without its source or unit, months not October first, a table that scrolls sideways on a phone, a heading that skips a level, a control under the target size.
- A component used in several places (the shell's `Fold.svelte`, `StepRail.svelte`, a results chart) where consistency matters.

**Wrong fit (say so and stop):**

- A new screen, a new step or a layout-level redesign: use the `ui-designer` agent (`build: <target>`).
- A review of a UI diff without edits: `ui-designer` in review mode (`review: the working diff`).
- Sign-in behaviour (`frontend/src/lib/auth/`, the gate in `frontend/src/routes/+layout.svelte`) or what a run writes to the network: `/safe-edit`.
- A one-line CSS tweak: just edit it.
- "Polish everything": pick one target; run the command again for the next.

## Resolving the target

- A **section name** ("Extend rainfall", "Sub-divide", "Results", "Land-use tables", "Demands", "Calibrate") → its folder under `frontend/src/lib/` (`extend/`, `subdivide/`, `results/`, `landuse/editor/`, `demand/`, `calibrate/`) and the panel component in it; the step names are in `frontend/src/lib/shell/steps.ts`.
- A **route** (`/methods`, `/privacy`, `/sign-in`, `/users`) → `frontend/src/routes/<route>/+page.svelte`; the app itself is `frontend/src/routes/+page.svelte`.
- A **file path** → used as-is.
- Empty → list the sections with one line each on the most visible playbook gap, and ask which.

## The flow

1. **Pre-flight:** the target exists; `pnpm check` passes on the tree (if it already fails, fix that first). Don't start the dev server to look (CLAUDE.md § UI verification); the agent's screenshots come from a throwaway Playwright spec against the e2e build, per the playbook.
2. **Spawn `ui-polisher`:** "Polish `<resolved path>`. The operator's intent: `<original argument>`. Follow your spec: audit, plan, edit, verify, report. Do not commit." Pass `isolation: "worktree"` when other sessions or agents are working in this checkout.
3. **Relay the report:** files changed (`git diff --stat`), the gaps by playbook rule, the inventory check, the tests that ran, screenshot paths, and the notes for the human.
4. **Commit on the operator's word**, path-scoped (`git commit -m "…" -- <paths>`), a plain conventional message (`fix(ui): …`, `feat(ui): …`), no AI attribution trailer.

## Cost

A polish run costs a type-check, the affected e2e specs and an agent context. Don't spend it on a padding tweak; it earns its cost when a screen misses several playbook rules at once.

## What this command does not replace

- `/check` for the pre-commit gate (code-review, test-gap, doc-hygiene).
- `/audit/accessibility` or `/a11y-hunt` for a sweep across every screen.
- The operator's own look at the page.
