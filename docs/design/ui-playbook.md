# UI playbook

How Pitman's screens are built. It starts from the rules in IC-WBT's playbook
that apply here; add to it, in the section it belongs to, with the example
that taught the rule. What each screen does is in `docs/architecture.md`
§ App flow.

## The look

A calm, dense engineering tool: closer to a data workbench than a marketing
site. The dark band (app bar and landing) carries the identity; the work sits
on quiet cards. The numbers are the content, so nothing decorative competes
with them.

- **Colours are tokens** in `frontend/src/app.css`, each with a dark value.
  Components write no raw hex in their styles. `src/lib/shell/tokens.test.ts`
  refuses one, and checks the contrast of the text pairs (4.5:1), control
  outlines and chart marks (3:1) in both themes. Add a new pair there.
- **Canvas charts read tokens too.** uPlot can't use `var()`, so `tokenColour`
  (`results/plot.ts`) resolves `--series-*` on the node, `axisStyle` themes
  the axes (uPlot's defaults are black, unreadable in dark) and
  `onThemeChange` redraws when the theme flips.
- **Type:** Inter, self-hosted (`@fontsource-variable/inter`, OFL 1.1), so the
  screens look the same on every machine and nothing is fetched from a third
  party; `shell.spec.ts` checks it loads under the CSP. Tabular numerals
  wherever numbers line up. Small text uses `--font-sm` and `--font-xs`.
- **File inputs:** `<input class="file-pick">` then its `<label>`, which is the
  button. The input stays focusable, so the keyboard still opens the chooser.
- **Chart bars are solid.** A dash reads as hatching at their width; their
  place in the group, in the key's order, is the cue beside colour.
- **uPlot's readout floats over the key on hover**, never over the data, and
  is off on touch, where the data table carries the values. A chart under
  480 px drops its axis titles, which the caption already gives.
- **Controls** are 44 px on touch and 36 px with a precise pointer
  (`--control-h`), which is where the dense screens gain their room.
- **Shared element styles live in `app.css`**: buttons, inputs, tables
  (`table.data` is the numeric kind), `.card`, `.facts`, `.actions`, `.scroll`,
  `.note`, `.warn`, `.error`, `.sr`. Don't restate them in a component; a
  component's scoped rule beats the shared one and drifts from it.

## Layout

- **One page, every section mounted.** The step rail links into the page; it
  doesn't swap screens, because unmounting would lose a half-done extension.
- **One `h1`:** the landing headline, or `Network <code>` once one is loaded.
- **Save stays in the bar**, in reach from every step.
- **Facts read as tiles:** label above value, `.facts`. `.provenance` marks
  the ones that say where a number came from (issue #3, ground rule 8).
- **State is said in words as well as shown** (WCAG 1.4.1): the rail's
  `.sr` state, the bar's pill text. `lib/shell/steps.ts` owns the wording.
- **Tables scroll in their box.** A wide table goes in `.scroll`, and gets a
  `min-width` rather than letting file names break letter by letter. Its
  action column sticks to the edge, so Extend is never off-screen.
- **Every step fits a phone:** the rail shows mark and name; the detail stays
  for screen readers, and the bar's pill says how the run stands.
- **Position the box that scrolls.** A visually hidden `.sr` is absolutely
  positioned, so inside an unpositioned scroller it widens the page: the
  rail and the rainfall table added 2 px of sideways scroll at 390 px until
  `.scroll` and the rail's list were `position: relative`.

## Before calling a screen done

Screenshot it at 1440×960, 1280×800 and 390×844, light and dark: a throwaway
`frontend/e2e/zz-shot.spec.ts` that loads `syntheticNetworkZip()` and calls
`page.screenshot`, PNGs in the scratchpad, the spec deleted afterwards and
never committed. This is the sanctioned exception to "don't start the dev
server" (it runs against the e2e build). Measure: no sideways scroll, no
pointless page scroll, exactly one `h1`. `frontend/e2e/shell.spec.ts` keeps
the first and last of those.

**Nothing lost:** a redesign moves things, never drops them. List every
control, figure and note on the old screen and find each a home.
