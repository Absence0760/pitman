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
| D6 | MAP grid: the finest grid covering the quaternary; where none does, the user types each piece's MAP | Default; national grid licence pending (D-5) |

## Data access (`docs/data.md`)

| ID | Decision | Status |
|---|---|---|
| D-1 | Quaternary boundaries: the operator supplies Pitman's own copy (WR2012 publishes them) once its licence is confirmed; until then the user can upload a boundary | **Needs operator** |
| D-3 | DWS register of dams: same route as D-1 | **Needs operator** |
| D-4 | WAAS MAP grid: extend IC-WBT's licence decision to Pitman | **Needs operator** |
| D-5 | National MAP grid: not used until licensed; outside the WAAS area the user types MAPs | Default |
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
| `docs/theory/subdivide.md` | B1 … B9 | Round 5 |

Notes:

- **TT 690 misprints** (`pitman.md`): eq. 1.10 is missing its minus sign, eq. 1.14 is coded with `+ C2(I2 − I1)`, eq. 1.4 has lost its Σ, and p.6's "lagged by GW" means GL. Code follows the corrected forms.
- **OQ-22** (TL below 0.5 month gives negative month-to-month outflow with the printed Muskingum form): keep the literal form; Round 2 checks it against the reference and switches to per-step routing if WRSM2000 doesn't go negative. Recorded in `departures.md` either way.
- **OQ-23** (initial soil moisture ST/2) is a placeholder with no manual basis. #21 (R1) asks the hydrologist to export the "Pitman S" and surface-runoff series from the classic-GW run, which settles it.
- **OQ-S3** (how final runoff is assembled from Pitman and Sami parts) is the highest-risk Sami default; Round 6's discrepancy hunter tests it first.
- **Formats:** writers always produce runoff file version 7 and irrigation version 32; demands are written as defined-flow files, never `'*'` monthly abstractions; a negative `.obs` value means missing; a `.RAN` row labelled Y is October Y to September Y+1 (U-19, A1).
- **Routes** in `.NET` refer to 1-based positions in the module list, not module numbers (`types.ts`, TT 691 L.014).

## Repository follow-ups

| Item | Status |
|---|---|
| The base-owned `.pre-commit-config.yaml` hooks `trailing-whitespace` and `end-of-file-fixer` would rewrite `docs/formats/examples/` (byte-exact CRLF files). The fix belongs in the templates repo's `base` (an exclude for byte-exact fixture folders), not here | Open: proposed for templates `base` |
| CodeQL ("Analyze") fails: code scanning isn't available on this private repo without GitHub Advanced Security | Open: resolved when the repo goes public (#22 step 2) |
| The labeler workflow fails with "Resource not accessible by integration" | Open: check repository Actions workflow permissions |
| Workflow: commit and push straight to `main`, no PRs, while the engine is built (operator, 2026-10-28). The repo is treated as public | Decided; PRs and branch protection return later (#22 steps 10–11) |
