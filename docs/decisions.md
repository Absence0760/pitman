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
