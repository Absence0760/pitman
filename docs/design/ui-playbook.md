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
- **The map reads tokens too.** MapLibre paints on a canvas and can't take
  `var()`, so `lib/map/palette.ts` reads the `--map-*` tokens and `Map.svelte`
  redraws with `setStyle` when the theme flips. `lib/map/mapStyle.test.ts` holds
  the marks to 3:1 on the map's ground and names to 4.5:1 on their halo.
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
- **Optional cards start closed** (`shell/Fold.svelte`, R7-U1): the title stays,
  with where the step stands, and what's under it leaves the view and the tab
  order, still mounted. A closed card's map isn't near the view, so it makes no
  WebGL context. The rail opens what it links to, and so does a link from outside.
- **The rail marks where you are** with `aria-current="location"`, an edge and a
  tint. A section is current when it crosses a line just under the bar; the last
  short sections can't reach that line, so the link just followed holds the mark
  until the user scrolls.
- **Names tell cards apart.** "Land use" above "Land-use tables" said nothing; a
  card is named for what it does.
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

- **A screen that previews values refuses what the file can't hold.** The
  writer rounds through float32, so a preview of an unwritable value would
  show a result the saved network can't reproduce (`calibrate/validate.ts`).

- **A notice ends in the next step.** Every card's "Applied" (`.applied`) says
  what changed and carries Rerun the network, so nobody has to find Run again.
- **A change elsewhere isn't "not run yet".** Results cleared by an apply say why
  where the results were, and the rail and the bar say to run again.
- **Ask before losing the only copy, and only then.** A confirmation moves the
  focus to its safe button and hands it back to the button that opened it.
- **Don't identify "another network" by object identity.** `applyDemand` returns a
  new `bundle.files`, which two cards took for a new network and dropped what was
  typed in them. Loading goes through an empty page, so the cards remount anyway.

## The map

- **The map is on the first screen.** It shows the quaternaries before anything
  is loaded, because it is what the app works on; hiding it behind a load read
  as no map at all.
- **The map is never the only way.** A quaternary can be chosen by code, a shape
  pasted as GeoJSON or WKT; without WebGL the map says so and the rest works.
- **No tiles is not an error.** A laptop with no cloud gets a plain background
  and one small note. Only the panel's missing boundaries are a `.warn`, and it
  says how to go on.
- **Write names in the DOM.** MapLibre needs glyphs to draw text, and with no
  tiles there are none: quaternary codes and piece numbers are DOM markers,
  `aria-hidden`, `pointer-events: none`. Anything else named on the map (a
  module, a cell's MAP) shows in the chip at its corner under the pointer.
- **A piece's number names it; the tint only helps the eye.** Selection is said
  in the chip and the canvas's name as well as drawn.
- **Don't tint what carries a ramp.** A selection fill over the MAP grid changed
  the colours the key explains; the selected quaternary is outlined only.
- **What is there isn't drawn like what is proposed.** A dash means "not accepted
  yet", so crop fields, which are the data, take a solid edge and their own layer;
  the key under the map names only the marks on it, in words.
- **A slot's height is the map's height.** `Map.svelte` sizes itself alone but
  fills a `.map-slot`: at its own 560 px in a 384 px slot the middle, where the
  crosshair acts, the attribution and the drawing bar were all cut off, and only
  the keyboard could reach Finish. A slot grows while drawing.
- **The wheel belongs to the page.** On the one long page a map must not trap
  scrolling, so it takes `cooperativeGestures`.
- **Load the heavy thing when it is near the view.** Every section stays
  mounted, so `Map.svelte` waits for an `IntersectionObserver` before importing
  MapLibre (about 1 MB, plus a worker of 500 KB).
- **Test under the real CSP.** `vite preview` sends no CloudFront header, so
  `e2e/map.spec.ts` adds `infra/csp.json`'s. That is how MapLibre's `data:` icons
  and SvelteKit's announcer style were caught; neither shows without it.

- **A long flow lists its steps at the top, each state in words.** The
  sub-division's five steps stay on the page, so a list of links says where
  it stands (`subdivide/steps.ts`), and focus moves to each new step's heading.
  Later steps appear when they can be used, never greyed out.
- **The map sits beside the steps that use it,** sticky, and the steps that
  don't take the full width: the iteration table for 8 pieces needs it. On a
  narrow screen the map comes first, above the controls that act on it.
- **Keep the number the user is after on-screen.** A wide table on a phone
  scrolls, so its answer sits next to the row's name: the final MAP comes
  straight after the piece, then what produced it.
- **A table of tries counts from 1.** "Converged in 4 tries" above a table
  ending at try 3 reads as a bug, whatever the engine's `n` says.

## Controls that take a value

- **An override sits beside the number it replaces,** with that number's
  source still in view: a piece's card shows the grid MAP, its cell size and
  coverage, then "Type a MAP instead"; "MAP used" says which won (rule 8).
- **A slider has a number box beside it,** for the keyboard and exact values,
  with `aria-valuetext` carrying the unit.
- **Never accept what the controls no longer say.** The threshold's zone is
  traced after a pause, so for that moment the proposal on screen belongs to
  the old value. Accept is disabled until they match; a quick click after
  changing high to low once recorded the opposite zone.
- **Check early.** A wrong quaternary shows as an area mismatch: say so in
  step 1, not after the user has split and reviewed it.
- **A dead end names the way out.** A refused module says what to do instead;
  an optional source that fails (no quaternary service) opens the alternative
  (upload the boundary) rather than stopping the screen.
- **A preview is the plan, not a sketch of it.** The demand form asks the engine
  for its plan on every keystroke and Apply carries out that same object, so
  there is no second calculation to drift. Rows are shown at the file's rounding;
  a total of 0.36 beside an asked 0.30 is the file's truth, said beside the ask.
- **A method that can fail offers the choices in its own words,** and the
  risky one is never the default: an unconverged calibration has no primary
  button, and only an explicit "Use the best factor" reaches Apply.
- **A result stays visible when it goes stale, marked in words.** Editing the
  target keeps the iteration log to compare against, says it is out of date
  and removes Apply.

- **A row's extras take the line under it.** In a table of editable values the
  source note, a refusal and any hint span the full width below the row, so the
  four short columns still fit a phone and nothing wide needs a sideways scroll
  (`landuse/editor/YearTable.svelte`).
- **A refusal is said again at Apply.** A long table scrolls in its box, so the row
  that disables Apply can be out of sight; the list above the button names it.
- **Edited points differ in shape.** A hollow diamond on a dashed line against a
  dot on a solid one, drawn on the canvas, since uPlot's points have one shape.
- **Say what an edit does beyond its own cell.** A new last year turns a flat tail
  into a line, so it changes every year back to the row before it; the row says so.

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
