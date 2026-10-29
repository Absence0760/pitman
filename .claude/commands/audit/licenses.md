---
description: Inventory dependency licences across the pnpm workspace and the data Pitman redistributes or displays, and flag copyleft / unknown / attribution-missing licences that create risk for a public MIT repo, a public static SPA bundle, a Lambda bundle and CC BY / ODbL data
---

Walk the dependency tree, collect each package's declared licence, and walk
the data Pitman uses, and flag what creates legal risk for this project:
a **public, MIT-licensed repo**, a **static SPA bundle** served to every
visitor, an **esbuild Lambda bundle**, network zips users download, and
datasets under CC BY, CC0, ODbL and terms not yet confirmed.

## Goal

`/audit/deps` answers "is anything vulnerable or out of date". This audit
answers "are we clear to ship and redistribute every byte of this, with the
attribution each licence requires". **Do not re-report CVEs, version drift
or Actions pinning here**; those belong to `/audit/deps`. The deliverable is
a licence *inventory* plus a flagged risk list.

Facts that shape the risk model (confirm each at HEAD):

- **Everything committed is redistributed**: the repo is treated as public
  and its `LICENSE` is MIT (`Copyright (c) 2026 Jared Howard`).
- **The frontend bundle ships to every visitor** (S3 + CloudFront). Its
  runtime `dependencies`, bundled by Vite, are redistributed in minified
  form, so their notices must travel with it (a licences page or a
  `THIRD_PARTY_NOTICES` file the site links to).
- **The backend bundle** (`backend/`, esbuild → `dist/lambda.mjs`) runs on
  Pitman's own Lambda: bundled, but not distributed to users. AGPL/SSPL
  would still bite (network use); GPL generally would not.
- **No package is published to npm** (all workspaces are `private`).
- **Copied code**: IC-WBT files copied under `docs/data.md` § Code to copy
  are MIT, same author; each keeps a header naming its origin path and
  commit. Check the headers exist on copied files.
- **Data**: `docs/data.md` § Summary lists each dataset and its licence;
  `docs/decisions.md` § Data access records what is decided and what still
  needs the operator (D-1, D-3, D-4).

## What to check

1. **Run the licence tooling and keep the raw output.** At the repo root,
   `pnpm licenses list` and `pnpm licenses list --json` (walks every
   workspace in `pnpm-workspace.yaml`), then per workspace with `--prod`
   (`pnpm --filter @pitman/frontend licenses list --prod`, same for
   `@pitman/backend`, `@pitman/wrsm`, `@pitman/wrsm-cli`) to separate what
   ships from build-only tooling. Put the histograms in the report so the
   inventory is reproducible.

2. **Copyleft and network copyleft (High).** Flag every `GPL-*`, `AGPL-*`,
   `LGPL-*`, `MPL-*`, `EUPL`, `CDDL`, `SSPL`, `OSL`, `CC-BY-SA` and
   `ODbL` *on code* (a dual licence that includes a permissive option is
   fine). For each, say which tree it's in:
   - frontend runtime (shipped to every visitor) → High;
   - backend runtime (hosted; AGPL/SSPL network clauses) → High for
     AGPL/SSPL, Medium otherwise;
   - `devDependencies` / build-only → Low, saying why it doesn't reach the
     output.

3. **UNLICENSED / UNKNOWN / blank (Medium).** No grant to redistribute
   until clarified. List each with its dependency path.

4. **Attribution for permissive code licences.** MIT, BSD, ISC, Apache-2.0
   need their notices kept; Apache-2.0 also its NOTICE file. If the
   frontend has no licences page or notices file, that's a Medium for the
   shipped bundle; recommend generating one from `pnpm licenses list
   --json --prod` and where to link it.

5. **Data attribution and redistribution.** For each dataset in
   `docs/data.md` § Summary that Pitman serves, shows on the map, stores in
   its own bucket or writes into a network zip:
   - the licence and its version, and the attribution text it requires
     (CHIRPS: CC BY 4.0 with the Funk et al. citation; CHELSA v2.1: CC0,
     cite Karger et al. 2017 as D-5 records; OpenStreetMap via Protomaps:
     ODbL 1.0, "© OpenStreetMap contributors"; Copernicus DEM: its
     licence's notice; label fonts: SIL OFL 1.1);
   - **where the attribution shows** in the app (the map's attribution
     control, an about or sources page) and in the saved `pitman.json`
     sidecar where the data shaped a number;
   - **whether it is committed to git.** Any dataset with unconfirmed
     terms (quaternary boundaries, WR2012 values, the DWS register, the
     WAAS grid, Cape Farm Mapper data) in the repo, a fixture or a
     committed screenshot is High: committing is publishing.

6. **The clean-room rule.** Nothing in the repo derives from WRSM2000's
   executable or DLLs (CLAUDE.md project rule 1); equations cite the WRC
   manuals; no manual PDFs are committed (issue #3: keep the PDFs out of
   git). A hit is High and goes to the operator.

7. **The repo's own licence.** `LICENSE` is present and MIT;
   `package.json` files are `private` (a missing `license` field there is
   hygiene only, Low).

8. **Per finding, recommend one of:** *replace* (name a candidate),
   *pin*, *add attribution* (the text and where), *remove from git*, or
   *legal review* (the `za-legal-researcher` agent, then the operator).

## Report

- **High**: copyleft in a shipped path; unconfirmed-terms data in git; a
  clean-room breach.
- **Medium**: UNKNOWN/UNLICENSED anywhere; missing attribution for shipped
  code or for displayed data.
- **Low**: uncommon permissive licences worth recording (`0BSD`,
  `BlueOak`, `Unlicense`, `Zlib`, `Python-2.0`, `CC0-1.0` on code);
  build-only copyleft (with the no-infect reasoning); hygiene.

For each: the package and version (or dataset), the tree or place it lives,
the declared licence, the dependency path, whether it ships, and the
recommended action. Lead with the raw histograms.

## Delegate to

The `general-purpose` agent with this file as the prompt body. It writes the
full report to `reviews/licenses.md` (overwrite if present) and returns a
short summary. Read-only otherwise: it changes no dependency, licence or
attribution; those are the operator's calls, surfaced as recommendations.
