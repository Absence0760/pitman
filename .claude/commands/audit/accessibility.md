---
description: WCAG 2.2 AA pass on Pitman's web app — the steps, the map, the charts, sign-in and the Users page
---

Audit accessibility across Pitman's one surface, the SvelteKit web app. WCAG
2.2 AA is the bar (and what the EU EAA and most procurement rules point to).

## Goal

Find every place the app misses WCAG 2.2 AA, with the success criterion and
a concrete fix. The rules for this app's UI are in `docs/design/ui-playbook.md`;
the existing guards are `frontend/e2e/a11y.spec.ts` (axe on each screen) and
`frontend/e2e/a11y-keyboard.spec.ts`.

## What to check

1. **Semantic HTML.** `<button>` not `<div onclick>`; every icon-only button
   has an accessible name. Walk `frontend/src/lib/` (by topic: `shell/`,
   `network/`, `extend/`, `subdivide/`, `calibrate/`, `landuse/`, `demand/`,
   `results/`, `map/`, `auth/`) and `frontend/src/routes/`.
2. **Focus management.** Dialogs and confirmations trap focus and restore it
   on close; load errors move focus to the issue list; `:focus-visible` on
   every focusable; moving between steps on the step rail
   (`frontend/src/lib/shell/StepRail.svelte`) puts focus somewhere sensible.
3. **Colour contrast.** At least 4.5:1 on text and 3:1 on UI components and
   chart lines, light and dark. Compute it from the tokens in
   `frontend/src/app.css`; don't eyeball it.
4. **Keyboard.** Every flow without a pointer: loading a network (the drop
   area has a file-input alternative), the map (drawing an area or placing a
   module needs a keyboard or paste alternative), the tributary tool, the
   editors' tables.
5. **Forms.** Every input has a label; errors are tied to their field
   (`aria-describedby`) and announced.
6. **Live regions.** Run progress, load results and save status announced
   politely; errors assertively.
7. **Charts and the map.** Each chart (`frontend/src/lib/results/`) and the
   map has a text or table alternative carrying the same information.
8. **Motion.** `prefers-reduced-motion` honoured for transitions and map
   animation.
9. **Headings and landmarks.** One `<h1>` per page, no skipped levels, a skip
   link, `main` / `nav` landmarks.
10. **Small screens.** Layouts hold at 390 px and at 200% zoom without
    horizontal scrolling (WCAG 1.4.10 Reflow).

## Report

- **Critical**: a flow unreachable without sight or without a pointer.
- **High**: a clearly testable WCAG 2.2 AA failure (contrast below the ratio, a missing name, no keyboard alternative).
- **Medium**: a best-practice gap (no skip link, headings out of order, a missing live region).
- **Low**: polish.

For each: file/line, the success criterion (e.g. 2.4.7 Focus Visible, 1.4.3 Contrast Minimum), and the fix. A fixable violation should get a guard in `frontend/e2e/a11y.spec.ts` or `frontend/e2e/a11y-keyboard.spec.ts` with its fix.

End with a **clean** list of screens you confirmed pass.

## Delegate to

Use the `compliance-auditor` agent: `"Audit area: accessibility."`

Read-only. Findings only.
