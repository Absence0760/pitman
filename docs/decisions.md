# Decisions

Every choice the manuals or the operator leave open is recorded here with its ID, so code can cite it and a change is made here first. Specs propose; this file decides. "Provisional" means the reference comparison (`WRSM_REFERENCE_DIR`) can confirm or overturn it, and the round named will check.

Plan and context: issue #3.

## Operator decisions

| ID | Decision | Status |
|---|---|---|
| D1 | Run modes: **present day** (development held fixed at a chosen year, 2025 by default, over the whole rainfall record), **natural** (no irrigation, dams, abstractions, SFR or paved area) and **historical** (development as the files' year tables give it) | Decided |
| D2 | A sub-catchment's MAP starts at the gridded MAP over its boundary; every piece of a quaternary is scaled by **one common factor**, iterated until the quaternary's natural MAR is within **2 %** of the target (`docs/theory/subdivide.md`) | Decided |
| D2a | **The target natural MAR:** the user enters WR2012's naturalised MAR for the quaternary (value, its WR2012 table and period). The unsplit module's own natural run is shown beside it and is the target when no value is entered. (WR2012 values are not available to Pitman from IC-WBT: `docs/data.md` § Licence-blocked data) | Provisional, operator to confirm |
| D3 | Cape Farm Mapper through its API with an operator-supplied token, used only by the backend proxy; the token never reaches the browser, the repo or an agent | Decided; token pending |
| D4 | 2025 farm-dam capacity from CFM and/or the DWS register (larger dams) and/or satellite surface area × 3 m; de-duplicated by location; precedence register > CFM > area × 3 m unless the user overrides a dam | Decided; register licence pending (D-3) |
| D5 | Bias-factor overlap: whole hydrological years from 1981/82 to the `.RAN`'s last year; the user may narrow it | Default |
| D6 | MAP grid: the finest grid covering the quaternary (WAAS in the SW Cape, else CHELSA v2.1, D-5); the user can still type each piece's MAP | Default |

## Data access (`docs/data.md`)

| ID | Decision | Status |
|---|---|---|
| D-1 | Quaternary boundaries: the operator supplies Pitman's own copy once its licence is confirmed; until then the user can upload a boundary. No source publishes terms: WR2012's download falls under WRC site terms (no public or commercial reuse without permission); DWS's copy is managed by its GI&A unit; the Western Cape Government mirror (`SpatialDataWarehouse/Hydrology/MapServer/7`) states none | **Needs operator** (ask DWS GI&A or the WRC) |
| D-3 | DWS register of dams: same route as D-1. The Dam Safety Office publishes the list with no stated terms; DWS's general wording is non-commercial | **Needs operator** (ask the Dam Safety Office); until then CFM + satellite |
| D-4 | WAAS MAP grid: extend IC-WBT's licence decision to Pitman | **Needs operator** |
| D-5 | National MAP grid: **CHELSA v2.1** annual precipitation (30″ ≈ 1 km, 1981–2010, CC0 1.0; cite Karger et al. 2017, doi:10.1038/sdata.2017.122), stored in Pitman's own bucket. Used for the *ratio* between pieces only: D2's common factor rescales the absolute level to the WR2012 MAR, which matters because CHELSA's skill drops above 500 m in southern Africa. Lynch 2004 stays out (contradictory licence, share-alike); WorldClim is excluded (no commercial use) | Default (2026-10-28 licence research) |
| D-6 | Pitman's AWS resources in `af-south-1`, beside IC-WBT's buckets | Default |
| D-7 | Dam area: JRC surface-water occurrence ≥ 25 % traced around the dam, × 3 m; Digital Earth Africa waterbodies as a cross-check | Default |
| D-8 | "Irrigated" comes from the CFM attribute; failing that, the user marks crops | Default; confirm when the token arrives |

## Specs: proposed defaults accepted

All proposed defaults in these specs are **accepted as provisional**, with the exceptions and notes below. Each spec's open-question list is the authoritative text.

| Spec | IDs | Verified by |
|---|---|---|
| `docs/theory/pitman.md` | OQ-1 … OQ-28 | Round 2 (classic-GW reference run) |
| `docs/theory/sami.md` | OQ-S1 … OQ-S19 | Round 6 (H80 reference, all Sami) |
| `docs/theory/hughes.md` | OQ-H1 … OQ-H12 | none yet: no reference network uses Hughes |
| `docs/formats.md` | U-1 … U-22 | Round 2 (every reference file round-trips) |
| `docs/theory/extend.md` | A1 … A6 | Round 4 |
| `docs/theory/subdivide.md` | B1 … B9 | Round 5 (B1 answered by R3-N8: a route can end at a runoff module) |
| `docs/theory/network.md` | R3-N1 … R3-N22 | Round 6 discrepancy hunter (whole-network comparison, once Sami runs) |
| `docs/theory/reservoir.md` | R3-RV1 … R3-RV23 | Round 3: 39 reference reservoirs, run on WRSM2000's own route flows, all within 1 % spill MAR (NSE ≥ 0.996); the rest when the network runs |
| `docs/theory/channel.md` | OQ-CR1 … OQ-CR19 | Round 6/8 (the reference set has no wetland, bed loss or active diversion: those paths are manual-only) |
| `docs/theory/statistics.md` | R3-S1 … R3-S9 | none yet: no WRSM2000 `.OUT` statistics file in the reference set |

Notes:

- **TT 690 misprints** (`pitman.md`): eq. 1.10 is missing its minus sign, eq. 1.14 is coded with `+ C2(I2 − I1)`, eq. 1.4 has lost its Σ, and p.6's "lagged by GW" means GL. Code follows the corrected forms.
- **OQ-22** (TL below 0.5 month gives negative month-to-month outflow with the printed Muskingum form): keep the literal form; Round 2 checks it against the reference and switches to per-step routing if WRSM2000 doesn't go negative. Recorded in `departures.md` either way.
- **OQ-23** (initial soil moisture ST/2) is a placeholder with no manual basis. #21 (R1) asks the hydrologist to export the "Pitman S" and surface-runoff series from the classic-GW run, which settles it.
- **OQ-S3** (how final runoff is assembled from Pitman and Sami parts) is the highest-risk Sami default; Round 6's discrepancy hunter tests it first.
- **Formats:** writers always produce runoff file version 7 and irrigation version 32; demands are written as defined-flow files, never `'*'` monthly abstractions; a negative `.obs` value means missing; a `.RAN` row labelled Y is October Y to September Y+1 (U-19, A1).
- **Routes** in `.NET` refer to 1-based positions in the module list, not module numbers (`types.ts`, TT 691 L.014).

## Round 2 (2026-10-28)

| ID | Decision | Status |
|---|---|---|
| R2-1 | The provisional classic-Pitman choices (OQ-1, 3, 8, 12, 20/22, 23, 24, 25) are switchable through `PitmanOptions` (`packages/wrsm/src/runoff/pitman.ts`), defaults as accepted above. The comparison against #21 R1 flips them there; the winner is recorded here and the default changed in the same commit | Decided |
| R2-2 | Invalid runoff parameters, a rainfall year missing from the run, or a negative `.RAN` value make `runRunoffModule` throw (`PitmanRunError`); the module is not skipped | Decided |
| R2-3 | Readers return only the typed object: non-fatal warnings (TT 691 quirks, odd flags, non-ASCII bytes) are read silently, as WRSM2000 reads them. A `diagnostics` array beside each reader's result is a later contract change (Round 3) | Provisional |
| R2-4 | Lossless round-trips: `.RAN`, `.obs` and defined-flow readers keep the source lines (`SeriesSource`), and writers reuse any row the caller didn't change; RU, RV and CR keep per-file layout quirks (`RunoffLayout`, `unpaddedRouteLines`, `Network.directoryLineWidths`). Changed or new content is always written in WRSM2000's standard layout | Decided |
| R2-5 | Irrigation: a v32 file that ends at L.012 is the original layout and is upgraded on write; the unversioned WRSM90 layout reads as `fileVersion: 0`, model type 1. v42 (WQT type 4) is read but never written | Decided |
| R2-6 | U-23: `.RAN` fields are read as `F7.0` (a value with no decimal point is whole percent) | Provisional; Round 3 comparison checks |
| R2-7 | Which reference routes are "expected to match" (`compare/expectations.ts`): public WR2012 network folders may be named in git; anything from the operator's own networks goes in an uncommitted `expectations.local.json` under `WRSM_REFERENCE_DIR` | Decided; the loader arrives with the first entry (#21 R1) |

Round 2 reference suite (local, `WRSM_REFERENCE_DIR`): every `.NET` (35), `.RAN` (73), `.obs` and gauge files (56), defined-flow files (44), `.ANS` (395), RV (181) and RR (315) file reads and writes back byte-identical; RU 257/259 and CR 245/253, the rest being hand-edited files that keep every value. The classic-GW exit check waits on #21 R1: no WR2012 output in the archive comes from a classic module (the 27 classic modules are alien-vegetation children routed to the zero sink, plus one empty template).

## Repository follow-ups

| Item | Status |
|---|---|
| The base-owned `.pre-commit-config.yaml` hooks `trailing-whitespace` and `end-of-file-fixer` would rewrite `docs/formats/examples/` (byte-exact CRLF files). The fix belongs in the templates repo's `base` (an exclude for byte-exact fixture folders), not here | Open: proposed for templates `base` |
| CodeQL ("Analyze") fails: code scanning isn't available on this private repo without GitHub Advanced Security | Open: resolved when the repo goes public (#22 step 2) |
| The labeler workflow fails with "Resource not accessible by integration" | Open: check repository Actions workflow permissions |
| Workflow: commit and push straight to `main`, no PRs, while the engine is built (operator, 2026-10-28). The repo is treated as public | Decided; PRs and branch protection return later (#22 steps 10–11) |

## Round 3 (2026-10-29)

| ID | Decision | Status |
|---|---|---|
| R3-1 | The network is solved **one module at a time over the whole record, in `.NET` order** (TT 689 §6.1.16: a "sequence error" is raised when a module's upstream module "has not yet been solved"). Module simulators get complete inflow series and return complete outflow series (`packages/wrsm/src/network/contract.ts`) | Provisional; the reference comparison checks it |
| R3-2 | Defined-flow and demand files per mode (`definedFlowSeries`): historical takes each year's row and a missing year is an error; present day holds the chosen year's row (the nearest year the file has when it lacks it, reported); natural is zero | Provisional |
| R3-3 | Reservoirs and channel reaches share one failure threshold: a month short by more than 0.009 million m³ is a "major" failure (TT 691 p.80, §7.7.1; `MAJOR_FAILURE_MM3` in `contract.ts`) | Decided |
| R3-4 | **Calculated demands are not in the contract yet.** Irrigation abstraction routes from reservoirs (151 of 168 reference reservoirs) and channels (146 channel outflow routes) carry zero until Round 7 adds a `demands` argument and returns the supply to the irrigation module (R3-N2, R3-RV13, OQ-CR4). A channel diverting into a reservoir would need the reservoir's previous-month storage, which whole-record solving (R3-1) can't give; no reference channel diverts (R3-N1) | Open: Round 7 |
| R3-5 | **RV9** (defined outflows cut when water runs short) contradicts TT 689 p.169 ("NEVER adjusted downwards") but matches pp.16–17, p.170 and the real `.ERR` wording. Kept; asked on #21 | Provisional; hydrologist to confirm |
| R3-6 | A network folder in the app (`packages/wrsm/src/io/bundle.ts`): WRSM2000 files are decoded as Latin-1 (one character per byte) and `pitman.json` as UTF-8. Names resolve case-insensitively inside the `.NET`'s folder; a name inside the `.NET`'s input directory counts as relative; failing that, a unique base-name match is used with a warning (R3-A3). A missing module, rainfall, gauge or defined-flow file blocks loading; a type-0 channel's dummy wetland rainfall file only warns (R3-A2). Unchanged files are written back verbatim, changed ones in the standard layout (R3-A4, extends R2-4). Non-ASCII bytes are a bundle-level warning (R3-A5, supersedes R2-3's "read silently" for the app). Files no reader uses (`Out/`, diagrams, other `.NET`s) are kept and written back. `__MACOSX` and `._*` entries are ignored when finding the `.NET` (R3-A9) | Decided |
| R3-7 | The app's working copy is the network's files in IndexedDB, one network at a time (R3-A6); every save stamps the sidecar with `writtenBy`/`savedAt` (R3-A7); load limits 20,000 files, 64 MB per file, 256 MB in all (R3-A8, reviewed in Round 8.5) | Provisional |
| R3-8 | Synthetic test networks give every reservoir at least two capacity rows covering the run (TT 689 p.91: "at least two year – area – volume triplet[s]", the first in or before the first simulated year and the last in or after the last) | Decided |

Round 3 reference checks (local, `WRSM_REFERENCE_DIR`): 34 of 35 `.NET` files validate (connectivity, sequence, percentages); one public network lists an SFR parent after the channel it drains into yet has outputs (R3-N3). 3,140 of 3,140 files in 35 networks read and write back byte-identical through `readBundle`/`writeBundle`. No reference network runs end to end yet: every one has Sami runoff modules (Round 6).
| R4-T1 | TypeScript 7 in the `tsc`-only workspaces (`packages/wrsm`, `packages/wrsm-cli`, `backend`); the frontend stays on 6.0.2 because `typescript@7.0.2` ships no compiler API until 7.1, which `svelte-kit sync` (sveltejs/kit#17537) and `svelte-check` (sveltejs/language-tools#3063) need. Retry when 7.1 is out and both raise their peer ranges (`docs/STACK.md`) | Decided |
| R4-E1 | A computed bias factor above the hard limit (5) is never capped silently: the fit warns and `apply` refuses until the user edits it or narrows the window. (The local check hit it on 51 of 73 files only because the synthetic CHIRPS has a summer-rainfall season; real CHIRPS over the same quaternaries is the real test) | Provisional; Round 4 exit check with real CHIRPS |
| R4-E2 | Re-extending a file that already has a sidecar entry (`refitFromSidecar`): rows after `originalEndYear` are dropped, the fit reuses the recorded overlap, `MAP_c` and factors, so CHIRPS-derived rows never enter an overlap | Decided |
| R4-E3 | `applyRainfallExtension` refuses a fit made for a different file or CHIRPS series ("fit again") | Decided |
| R4-E4 | Fit statistics that can't be computed are `NaN` (shown as "–"); annual statistics use only overlap years with all 12 CHIRPS months. The overlap is the file's years inside the CHIRPS record; a missing CHIRPS month drops out of that month's factor only (`extend.md` corrected) | Decided |
| R4-I1 | CSP: the CloudFront header (`infra/csp.json`) is strict except `script-src 'unsafe-inline'`; SvelteKit's hash-mode meta CSP (`frontend/vite.config.ts`) is enforced on top, so only the hashed bootstrap script runs. `style-src` has no `'unsafe-inline'` (the one inline style is allowed by hash); `connect-src`, `worker-src`, `img-src` are `'self'`. `infra/scripts/check-csp.mjs` refuses a frontend deploy that breaks this | Decided |
| R4-I2 | Cross-account read of IC-WBT's copy: `s3:GetObject` on `rnl/*` plus `s3:ListBucket` conditioned on the `rnl/` prefix. Whether a prefix-conditioned `ListBucket` makes a missing chunk read as 404 (not 403) is unverified; if not, the fallback is an unconditioned `ListBucket` (lists keys, reads no objects) | Open: test when 4.1 lands |
| R4-I3 | Terraform state bucket and the sops KMS key in `us-east-1` (af-south-1 is opt-in and not enabled when the account is created); the app's resources in `af-south-1` (D-6) | Provisional; operator confirms at bootstrap (#22) |
| R4-I4 | CloudFront strips `/api` before the Lambda: the backend's routes are mounted unprefixed (`/chirps/monthly`); the frontend calls `${PUBLIC_API_URL}/chirps/monthly` with `PUBLIC_API_URL` = `http://localhost:3001` in dev and `/api` in production | Decided |
| R4-I5 | Lambda: nodejs24.x on arm64, ≥ 1 024 MB, 30 s timeout, reserved concurrency 10 (1–50), logs 30 days; WAF 300 requests / 5 min / IP on `/api/*`; budget alarm $25/month | Default |
| R4-D1 | CHIRPS 90 % coverage rule (`extend.md` § Step 3) is measured against the **land** cells' weight, after all-NaN (sea) cells are removed, so a coastal quaternary keeps its months; the removed share is reported as `weightRemovedPct` | Provisional |
| R4-D2 | A calendar month with any day after the copy's `finalThrough` is returned with `mm: null`, not left out, so `months` is always contiguous from 1981-01 | Decided |
| R4-D3 | `POST /map-grid/mean`: `meanMapMm` in whole mm (as IC-WBT); `cellSizeM` is the square root of the mean cell area | Provisional |
| R4-D4 | API limits: body 2 MiB, 50 000 positions, 1 000 rings, 2 000 CHIRPS cells; 30 CHIRPS / 120 MAP-grid requests per client per 10 min **per Lambda instance** (WAF is the cross-instance limit); caches of 200 / 500 results per instance keyed by (geometry hash, copy, manifest revision); a 25 s read deadline under the 30 s Lambda timeout | Default; reviewed in Round 8.5 |
| R4-D5 | Local-first data: `CHIRPS_SOURCE=local` / `MAP_GRID_SOURCE=local` in the committed `backend/.env.development`, read from `backend/.local/` written by `pnpm dev:data:synthetic` (a seeded, invented 1° block, 1981 to the last complete month). An unset source answers 503 "not configured", never silently local | Decided |
| R4-U1 | An uploaded FeatureCollection of several polygons is sent as one MultiPolygon; overlapping features would count twice, so the screen warns (it does not refuse) | Provisional |
| R4-U2 | Client limits match the backend's (R4-D4): boundary file ≤ 5 MB read, ≤ 50 000 vertices sent; 60 s request timeout | Decided |
| R4-U3 | After applying, the screen offers to move the `.NET`'s last year (L.012) to the new end, only when every rainfall file the modules read reaches it (at most 150 years, TT 691 §12.6); never automatic | Decided |
| R4-U4 | Applying an extension clears the previous run results (they describe the old rainfall) | Decided |
| R4-U5 | Re-extending (R4-E2): the first fit reuses the recorded `MAP_c`; narrowing the window afterwards refits with a fresh `MAP_c` | Provisional |
| R4-U6 | No "undo extension": extending again replaces the appended years; the original is the user's saved zip | Provisional |

## Round 6 (2026-10-29)

| ID | Decision | Status |
|---|---|---|
| R6-S0 | Sami soil-side open questions are switchable (`SamiSoilOptions`, `SamiInterflowOptions` in `groundwater/sami/soil.ts`): OQ-S5 recharge threshold `HGSL` (alt. `SL`); OQ-S6 moving-average start `available` (alt. `zeroPadded`); OQ-S8 eq. 8.5 uses P `afterRecharge` (alt. `previous`); OQ-S10 standard Muskingum as `runoff/lag.ts` (k = 0 no routing); OQ-S17 lag starts `steady` (alt. `zero`). The reference comparison picks the winners | Provisional |
| R6-S1 | PMAX = 0 means no percolating store: all recharge is EXRECH, PERC = 0. PMAX < 0, P₀ < 0, MMA < 1 or non-finite S are errors (R2-2) | Decided |
| R6-S2 | MMA (F7.2 in the file) is read as the nearest integer; below 1 is an error, never raised to 1 | Provisional |
| R6-A0 | Sami aquifer switches (`SamiAquiferOptions` in `groundwater/sami/aquifer.ts`): R6-A1 depletion may exceed ABS and the surplus returns to STORE ("rewatering", TT 690 p.91; alt. `depletionCap: 'abstraction'`); R6-A2 transmission losses are not capped at CAP, the surplus spills to interflow next month (alt. `transmissionLossCap: 'runoffAndCapacity'`); OQ-S14 the pumping clock never resets (alt. `pumpingClock: 'resetWhenIdle'`) | Provisional; reference comparison |
| R6-A3 | `fromStorage` is all the abstraction takes from STORE; `pctFromGw` is 0 until pumping starts | Provisional |
| R6-A4 | CAP ≤ SWL is an error (TT 691 p.209) | Decided |
| R6-A5 | **Changes eq. 8.9's literal HEAD:** a negative runoff counts as 0 in HEAD and in the TL cap | Provisional |
| R6-A6 | **Changes OQ-S12's default:** the baseflow curve uses −\|BPOW\| | Provisional |
| R6-A7 | STORE has no floor (heavy abstraction can take it below 0); a clamp would need an unmet-abstraction output | Provisional |
| R6-A8 | The aquifer step rejects storativity ≤ 0, borehole distance ≤ 0, an evaporation area outside [0, AREA], a negative or non-finite abstraction (R2-2) | Decided |
| R6-A9 | `SamiAquiferParams` carries `areaKm2` (contract change); `SamiParameters.staticWaterLevelM` renamed `staticWaterLevelMm`: the value is mm (TT 689 p.43) | Decided |
