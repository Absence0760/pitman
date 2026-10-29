# WRSM2000 file formats

This is the field-by-field spec of every file a WRSM2000 v2.11 network uses or produces, written for **reading and writing**. Writers must produce files that the original program opens, and should produce them in the layout the program itself writes, so a saved network diffs cleanly against the original.

Sources, in order of authority:

1. **The files themselves.** These are the reference network (H80, local only) and the 34 networks of the Gouritz WMA deliverable zip (local only). Together they hold 963 module files and about 600 time-series files.
2. TT 691/16, the Programmer's Code Manual, ch.12 "File structure" (pp.147–186), with §11.21 (pp.145–146) and §7.4 (p.103).
3. TT 689/16, the User Manual: §2.1–2.4 (pp.3–9), §3 (p.11), §4 (pp.12–17) and §6.

**Where the manual and the files disagree, the files win.** Every such case is listed in [§15](#15-manual-vs-files-disagreements). Page references are to the printed page numbers.

Every statement carries one of these tags:

| Tag | Meaning |
|---|---|
| **[F]** | Observed in the real files (counts in [§3](#3-inventory-what-was-observed)) |
| **[M]** | From the manual only; no real file showed it |
| **[I]** | Inferred from the files or the manual, not stated anywhere |
| **[U]** | Unknown; listed in [§16](#16-unknowns) with a best guess |

No real values, module names or station codes appear here or in the examples. Every example under [`docs/formats/examples/`](formats/examples/) is synthetic and invented. Each one follows the observed layout byte for byte (see [§17](#17-examples)).

---

## Contents

1. [General rules (all files)](#1-general-rules-all-files)
2. [Number and text formatting for writers](#2-number-and-text-formatting-for-writers)
3. [Inventory: what was observed](#3-inventory-what-was-observed)
4. [Network file `.NET`](#4-network-file-net)
5. [Runoff module `<net>RU<n>.DAT`](#5-runoff-module-netrundat)
6. [Reservoir module `<net>RV<n>.DAT`](#6-reservoir-module-netrvndat)
7. [Channel reach module `<net>CR<n>.DAT`](#7-channel-reach-module-netcrndat)
8. [Irrigation module `<net>RR<n>.DAT`](#8-irrigation-module-netrrndat)
9. [Mine module (manual only)](#9-mine-module-manual-only)
10. [Rainfall `.RAN` and rain-gauge `.MP`](#10-rainfall-ran-and-rain-gauge-mp)
11. [Monthly time-series family: defined flows, demands, `.obs`, `.ANS`, `.MTS`, `.DEM`, `.SHO`, `.nat`](#11-monthly-time-series-family)
12. [Demand files: what to write for a domestic demand](#12-demand-files-what-to-write-for-a-domestic-demand)
13. [`.lst`](#13-lst)
14. [Run log `WRSM2000.ERR`](#14-run-log-wrsm2000err)
15. [Manual vs files disagreements](#15-manual-vs-files-disagreements)
16. [Unknowns](#16-unknowns)
17. [Examples](#17-examples)

---

## 1. General rules (all files)

### 1.1 Encoding and line endings

- The files are plain **ASCII** **[F]**: no byte above 127 and no tab in any of the ~1,800 text files. Readers decode as Latin-1, so a stray byte never throws, and warn on any byte above 127. Writers emit ASCII only, and reject non-ASCII names with an error naming the field.
- Every line ends with **CRLF** **[F]**. The one exception is `WRSM2000.ERR`, which mixes CRLF with **bare CR** ([§14](#14-run-log-wrsm2000err)). Readers split on `\r\n`, then `\r`, then `\n`, so a file saved on Linux still loads. Writers emit CRLF.
- **Final newline.** Files written by WRSM2000 end with CRLF after the last line **[F]**. Hand-made legacy files sometimes don't (7 of 1,725 text files in the zip). Readers accept both. Writers always end with CRLF.
- **Blank lines are significant** in some module files: the reservoir year table writes three empty lines when it has no years ([§6](#6-reservoir-module-netrvndat)). Readers must never skip blank lines in `.DAT` or `.NET` files.

### 1.2 Two read disciplines

WRSM2000 reads two different kinds of file in two different ways.

| Kind | Files | How WRSM2000 reads it | How we read it |
|---|---|---|---|
| **Parameter files** | `.NET`, `*.DAT` | **Free format** (Fortran list-directed): values separated by blanks, strings in single quotes, any spacing (TT 689 §3 p.11) | Line by line, in the grammar of the line types below. Split each line into tokens with the 1.1 tokenizer (`src/io/tokens.ts`). Never let one line type's values run onto the next line (see below) |
| **Time series** | `.RAN`, `.obs`, `.ANS`, defined-flow and demand files, `.nat` | **Fixed columns**. The Fortran format for flow files is given as `(4X,I4,1X,12(F7.0,1A))` (TT 689 §2.3.4 p.8) | Fixed columns exactly as WRSM2000 does, so a misaligned file is read the way WRSM2000 reads it, with a warning ([§11](#11-monthly-time-series-family)) |

**Don't span lines** in parameter files. List-directed READ would carry on into the next record if a line held too few values, but WRSM2000 can't be doing that. Real irrigation files have an optional fourth value on L.003 ([§8](#8-irrigation-module-netrrndat)), and 16 of them leave it out **[F]**. Under true list-directed reading, the next line's count would be swallowed as that fourth value. So a parameter line is self-contained: missing trailing values take their documented default, and extra values are an error **[I]**. TT 689 p.11 warns that the program's own error line numbers are "approximate" for exactly this reason.

**Tokens in parameter files:**

- Values are separated by one or more blanks. Commas are legal list-directed separators but never appear in the files **[F]**. Accept them and warn.
- Strings are in **single quotes**. They may contain blanks and commas (`'Dams Irrig X1A,B'`-style names occur **[F]**). They may be empty (`''`) or a single blank (`' '`), and both mean "no name or no file". A doubled `''` inside a string is Fortran's escaped apostrophe. It's unobserved, but accept it.
- Integers can be signed. Reals may have no leading digit (`.83`), no fractional digit (`597.`) or no decimal point at all (`1` read into a real) **[F]**. Exponent forms (`1.0E-3`) and repeat counts (`3*0`) never appear. Accept them and warn.
- A value written in a field that's too narrow comes out as `****` (Fortran overflow). That's an **error**.

### 1.3 File naming

- A module file is `<net><TT><n>.DAT` (TT 689 §2.3.1 p.6) **[M][F]**:
  - `<net>` is the network code, 1–3 characters, exactly as on `.NET` line 1.
  - `<TT>` is the module type: `RU` runoff, `RV` reservoir, `RR` **irrigation**, `CR` channel reach, `MM` mine.
  - `<n>` is the module number, 1–4 digits, **not zero-padded**.

  The reference network uses exactly these letters: `RR` holds the irrigation blocks and `RV` the reservoirs and lumped farm dams. The content confirms this (the irrigation layout of §8 and the reservoir layout of §6) **[F]**.
- Case: WRSM2000 runs on Windows, so file names are **case-insensitive**. The files mix `.DAT`, `.dat`, `.RAN`, `.ran` and `.obs`/`.OBS`, and a module file can name `'xyz.ran'` while the file on disk is `XYZ.RAN` **[F]**. Readers resolve names case-insensitively within the network folder. Writers keep each name's original spelling, and use upper case (`.DAT`) for new files.
- Paths inside files are names only (resolved in the network input folder), relative paths (`RAIN\MUCH.RAN`), or absolute Windows paths (TT 689 §2.3.2.2 pp.6–7 and §2.4 p.9). The maximum path is 200 characters **[M]**. File names may contain blanks (`'Zero flows 001.abs'` **[F]**).

### 1.4 Error and warning reporting

Every reader returns **values plus diagnostics**. It throws only for errors that stop parsing, and the parse continues where it can so the user sees every problem at once. Each diagnostic carries:

```ts
interface FormatDiagnostic {
  severity: 'error' | 'warning';
  file: string;        // as named in the network, e.g. "SYRU1.DAT"
  line: number;        // 1-based physical line
  lineType?: string;   // "L.022", or the .NET line type, e.g. "NET.14"
  field?: string;      // TT 691 variable name where there is one, e.g. "POW", "NYRF", else a short label
  column?: number;     // 1-based column, for fixed-column files
  expected?: string;   // e.g. "integer", "12 reals", "F7.0 in columns 10–16"
  found?: string;      // the offending text, truncated to 40 characters
  message: string;     // one sentence a hydrologist understands
}
```

**Errors** are fatal for that file: a wrong token count where the count fixes the layout, a non-numeric token, an unknown or unsupported file version, a count that runs past end of file, overflow asterisks, and a route or module reference that's missing.

**Warnings** are things WRSM2000 tolerates but that deserve a look:

- trailing tokens beyond a line type's fields;
- a flag character other than blank or `+` in a time series;
- leading-dot style;
- a missing final newline;
- non-ASCII bytes;
- the abstraction-flag quirk ([§5.5](#55-the-groundwater-abstraction-flag-quirk-tt-691-pp145146));
- a value that will be misread under fixed columns ([§11.4](#114-observed-flows-obs)).

The 1.1 contract should hold this shape. I've noted it for the orchestrator in the PR.

---

## 2. Number and text formatting for writers

WRSM2000 is Lahey Fortran 90 (TT 691 §9) and its reals are default `REAL` (32-bit) (TT 691 §7). Writers reproduce these edit descriptors:

| Descriptor | Meaning | Example |
|---|---|---|
| `Iw` | Integer, right-justified in `w` columns | `I4` of 7 → `   7` |
| `Fw.d` | Real, right-justified in `w` columns, `d` decimals, **with** a leading `0` for \|x\| < 1 | `F6.2` of 0.8 → `  0.80` |
| `Fw.0` | `d` = 0 still prints the point: | `F6.0` of 139 → `  139.` |
| `F0.d` | **Minimal width**: no padding, `d` decimals, leading `0` kept | `0.83`, `597.00` |
| `(1X,F0.d)` | One blank, then the minimal-width value. Used for year/value tables in RU and RV files | ` 2.3 2.3` |
| `L5` | **Integer left-justified, padded with blanks to 5 columns**. Used by RV and CR count/route lines | `6    ` |
| `'…'` | String in single quotes, not padded unless the line table says so | `'SYA.RAN'` |
| `Aw` | Text left-justified and blank-padded to `w` columns | `.NET` module lines `A8` |

Rules:

- **Rounding:** round half away from zero, applied to the **float32** value **[I]**. Write `Math.fround(x)` first, then round in decimal. The difference from rounding a float64 shows only at exact third-decimal ties, but it decides byte-identity of `.ANS` files. The tie behaviour of Lahey's runtime is unverified ([§16](#16-unknowns) U-18).
- **Leading zero:** every file WRSM2000 wrote has `0.80`, never `.80` **[F]**. Leading-dot reals (`.83`, `.06`) appear only in hand-made or older files: 8 channel files, 1 irrigation file, and DWS-derived `.obs` files. Readers accept both. Writers always write the zero.
- **Negative zero:** write `0.00`, never `-0.00` **[I]** ([§16](#16-unknowns) U-18).
- **Overflow** (a value too wide for its field) is an **error**. Never write asterisks.
- **Trailing blanks:** reproduce them where a line table shows them (the `.NET` directory lines, RV and CR `L5` fields, the `.ANS` separator line). Elsewhere write none.
- **Quoted strings:** names longer than 20 characters are legal in the file, but WRSM2000 holds module names in `CHARACTER(LEN=20)` (TT 691 p.103, `RUNAM`). The run log shows them cut to 20 characters **[F]**. Writers warn above 20 characters and keep the full text.

---

## 3. Inventory: what was observed

Two collections were surveyed: the reference network (H80, local) and the Gouritz WMA deliverable zip (34 `.NET` networks in 22 folders, which includes an older copy of H80). Counts are files.

### 3.1 Module files by type and file version

| Module | Version token on line 1 | WMA zip (all files) | Referenced by a `.NET` | Reference network | Notes |
|---|---|---|---|---|---|
| Runoff `RU` | `7` | **244** | 211 | 15 | Only v7 exists anywhere. 216 Sami GW (`L.022`=2) and 28 classic Pitman (`L.022`=0); none Hughes. 60 parents with children |
| Runoff `RU` | 0–6, 8 | 0 | 0 | 0 | Specified from the manual only ([§5.2](#52-file-versions-07)) |
| Irrigation `RR` | `32` | **301** | 285 | 12 | 298 model type 2 (WQT), 3 model type 1 (Pitman); 16 omit the L.003 clipping flag |
| Irrigation `RR` | *(none)* | 1 | 0 | 0 | Orphan WRSM90-style file, 11 lines ([§8.2](#82-unversioned-wrsm90-layout)) |
| Irrigation `RR` | `42` (WQT type 4) | 0 | 0 | 0 | Manual only (TT 691 pp.162–175) |
| Reservoir `RV` | *(none; RV files have no version)* | **173** | 160 | 8 | 5 carry the optional initial-storage line; 3 have zero years (blank table lines); no `'*'` monthly-abstraction routes |
| Channel `CR` | `2` | **244** | 229 | 9 | All wetland type 0; 8 hand-made files in leading-dot style |
| Mine `MM` | – | 0 | 0 | 0 | Manual only |
| Network `.NET` | `1` (storage version) | 34 | – | 1 | None has debug, summary lines or an `N` (unsolved) module |

### 3.2 Other files

| Type | WMA zip | Reference | Variants observed |
|---|---|---|---|
| `.RAN` | 70 | 3 | All 95 columns, one code per file; 67 span 1920–2009, 3 span 1920–2004 |
| `.ANS` | 327 | 68 | All 124 columns with the `AVERAGE` footer; route flows (`RQ`) only, no reservoir volumes (`RV*.ANS`) seen |
| `.MTS` (runoff time series) | 130 | 6 | Same layout as `.ANS` (`<net>RU<n>ncr.MTS` = net catchment runoff) |
| `.obs` | 49 | 4 | 116 columns with an annual total (most). 104 columns, no total (zero-flow files). Flags `+` (most), plus `A`, `E`, `M`, `*`, `#` in a few. Leading-dot style common. One file with appended rows in a 3-decimal layout ([§11.4](#114-observed-flows-obs)) |
| Defined flows / demands: `.abs`, `.prn`, `.IRR`, `.DEF`, `.URB`, `.IND` | 10 / 5 / 10 / 2 / 1 / 3 | 1 / 1 / 0 / 0 / 0 / 0 | Fixed columns with 12 values; with or without an annual column; 1–3 decimals. One `.IRR` is a DWS export with a text header that no network references |
| `.nat` | 39 | 1 | 114 columns (13 values) without footer (38); 1 in full `.ANS` layout |
| `.lst` | 29 | 1 | One absolute path per line |
| `WRSM2000.ERR` | 22 | 2 | Mixed CRLF/CR |
| `.OUT`, `.SUM`, `.dwg`, `.pdf`, `.bak`, `.log`, `.txt`, `.nsi`, `.INF`, `.MAR` | 6 / 0 / 34 / 34 / 9 / 7 / 13 / 3 / 1 / 1 | – | Not read by a network run (see [§11.9](#119-files-present-but-not-read-by-a-run)) |

### 3.3 Reference network vs the zip

Every module, rainfall and output file in the local reference folder is **byte-identical** to the zip's H80 copy. Only two files differ:

- `.NET`: lines 2–3, the directory paths, were edited by hand. The path text was replaced but the original trailing blanks were kept.
- One `.obs`: rows were appended in a different layout ([§11.4](#114-observed-flows-obs)).

The local `Out/` folder was regenerated by a later run. Its `WRSM2000.ERR` has no SFR-child blocks, unlike the older log in the input folder ([§14](#14-run-log-wrsm2000err), U-17). This bears on Round 0.

---

## 4. Network file `.NET`

Example: [`examples/network/SY.NET`](formats/examples/network/SY.NET). The manual's line numbering (TT 691 §12.6 pp.182–184) is kept, so L.005 and L.016 are "absent" lines. The file is read in this order, and **only this order**.

| Line | Present when | Fields | Write format | Meaning |
|---|---|---|---|---|
| NET.1 | always | network code; storage version | `A3,I4` (code left-justified in 3 columns, then the version) → `SY    1` | Code is 1–3 characters and prefixes every module file. Version is `1` in every file **[F]**. A file without it is WRSM90 format (TT 689 §2.3.2.3), which we reject with "convert in WRSM2000 first" |
| NET.2 | always | input directory | text, **left-justified and blank-padded to 287 columns** **[F]** | Absolute path with a trailing `\`. Must exist on the WRSM2000 machine. Readers trim it. Our app ignores it (the files come from the zip), and on save writes the loaded value back unchanged, or a value the user typed |
| NET.3 | always | output directory | as NET.2 | `.ANS`, `.ERR` etc. go here. May equal NET.2 or be a subfolder |
| NET.4 | always | debug flag `N`/`D`/`Y` | `A1` | Always `N` **[F]**. `D`/`Y` (obsolete) bring in NET.5. Reject them |
| NET.5 | only if NET.4 ≠ `N` | debug start, end period | – | Obsolete (TT 691 p.183). Never observed. Unsupported |
| NET.6 | always | summary flag `Y`/`N` | `A1` | `Y` asks for a `<net>RUN.SUM` file. Always `N` **[F]**. A `Y` file reads (NET.16 below) |
| NET.7 | always | number of modules *M* | `I4` | |
| NET.8 ×*M* | always | `<n><TT><Y/N>` | `A8`, e.g. `1RUY    `, `2111RUY ` | The module number (no padding), type, and `Y` = solve or `N` = skip. Listing order is **solution order** and defines the **module index** (1-based) that routes refer to. All observed are `Y` **[F]**. The order rules are in TT 691 p.183 (runoff and irrigation before their downstream sources) |
| NET.9 | always | number of gauges *G* | `I4` | |
| NET.10 ×*G* | always | route number; gauge name | `I4,1X,'A20'`: name **inside the quotes, padded to 20** **[F]** → `   9 'SYH001              '` | A gauge is attached to a route. A blank name means "use the file name" (TT 689 p.7) |
| NET.11 ×*G* | follows each NET.10 | observed-flow file | `'name'`, unpadded | Usually `.obs`. `.nat` files are also used as "observed" series **[F]** |
| NET.12 | always | start year, end year | `I4,1X,I4` | Hydrological years, inclusive ([§10.1](#101-hydrological-year-convention)). At most 150 years (TT 689 p.5) |
| NET.13 | always | number of routes *R* | `I4` | |
| NET.14 ×*R* | always | route no.; source index; sink index; cost | `4I6` → `     9     7     8     0` | Source and sink are **module indexes in the NET.8 list (1-based), not module numbers**. `0` = the external zero module (defined inflow or abstraction) (TT 689 §2.2 and §2.3.2.3). Cost is always `0` (unused dummy) **[M][F]**. Route numbers run 1–9999, are unique, need not be contiguous, and are listed ascending in every file **[F]**. Writers keep the loaded order |
| NET.15 | always | number of summary lines *S* | `I5` → `    0` | The last line of every observed file, which is always `0` **[F]** |
| NET.16 ×*S* | if *S* > 0 | `'RT'`/`'RV'`, number, `'Q'` | free format **[U]** | Summary elements (TT 691 p.184). Never observed. Read free-format and write `'RT' n 'Q'`, single-spaced |

Validation (errors): duplicate route numbers; a source or sink index above *M*; a module line that isn't `\d{1,4}(RU|RV|RR|CR|MM)[YN]`; a gauge on an undefined route; a module file that's missing. TT 689 Table 2.1 (p.5) limits the routes per module:

| Module | In | Out |
|---|---|---|
| Runoff | 1 (Hughes GW only) | 10 |
| Channel | 10 | 10 |
| Reservoir | 5 | 5 |
| Irrigation | 1 | 1 |
| Mine | 0 | 60 |

Breaching a limit is a **warning**: the program enforces it in its editor, but files exceeding it may exist.

**Children (SFR).** A child runoff module ([§5.6](#56-parentchild-sfr)) has its own routes to the **zero sink** (sink index 0) **[F]**.

---

## 5. Runoff module `<net>RU<n>.DAT`

Examples:

- [`SYRU1.DAT`](formats/examples/network/SYRU1.DAT): Sami parent with two children.
- [`SYRU11.DAT`](formats/examples/network/SYRU11.DAT): alien-vegetation child.
- [`SYRU12.DAT`](formats/examples/network/SYRU12.DAT): afforestation child.
- [`SYRU2.DAT`](formats/examples/network/SYRU2.DAT): classic Pitman with paved areas.
- [`legacy/SYRU21.DAT`](formats/examples/legacy/SYRU21.DAT): version 0, manual-derived.

### 5.1 Line table (version 7, the only version observed)

The read and write formats are the widths WRSM2000 writes, measured over all 244 files. The manual's specifiers are often narrower, so treat them as minima ([§15](#15-manual-vs-files-disagreements) D-1). Units and meaning come from TT 691 pp.147–154 and from the parameter legend WRSM2000 prints in its `.OUT` file. The Sami and Hughes physical meaning is owned by `docs/theory/sami.md` and `docs/theory/hughes.md` (Round 1, agent 1.3).

| Line | Present when | Fields (TT 691 names) | Write format | Units / meaning |
|---|---|---|---|---|
| L.001 | always | module no.; `'name'`; file version | `I6,1X,'name',I3` → `     1 'SY Parent'  7` | Name ≤ 20 characters (§2). Version absent = 0 |
| L.002 | always | AREA; MAP; `'rainfile'` | `F7.1,I5,1X,'name'` | km²; mm; `.RAN` name ([§10](#10-rainfall-ran-and-rain-gauge-mp)) |
| L.003 | always | POW SL ST FT GW ZMIN ZMAX PI TL GL R FF | `F6.1,I6,I6,F6.1,F6.1,I6,I6,F6.1,F6.2,F6.2,F6.1,F8.2` | Classic Pitman set. POW –; SL, ST mm; FT, GW mm/month; ZMIN, ZMAX mm/month; PI mm; TL, GL months; R –; FF – (the TT 691 manual names "FF" without a definition) |
| L.004 | always | 12 × Symons-pan evaporation, Oct→Sep | `12F6.0` → `  160.` | mm/month |
| L.005 | always | 12 × pan factors, Oct→Sep | `12F6.2` | – |
| L.006 | always | NYRF; FORESTALG (v ≥ 1) | `2I4` | Years of afforestation data. Algorithm: 0 Van der Zel, 1 CSIR, 2 smoothed Gush/Pitman, 3 LUT Gush, 4 user-defined. Observed: 0, 1, 2 **[F]** |
| L.007 | NYRF > 0 | NYRF × year | `NYRF(1X,I4)` | |
| L.008 | NYRF > 0 | NYRF × afforested area | `NYRF(1X,F0.1)` | km² |
| L.009 | NYRF > 0 and v ≥ 1 | %pine, rotation, %eucalyptus, rotation, %wattle, rotation | `F6.2,I4,F7.2,I4,F7.2,I4` | %; years |
| L.010 | NYRF > 0 and v ≥ 1 | optimal %; user SFR on MAR; user SFR on low flows | `F7.2,F8.2,F8.2` (**all three always written** [F]) | %. The manual says vars 2–3 exist only for a user-defined child (D-3) |
| L.011 | v ≥ 1 | NYRA; VEGETATIONALG; riparian area | `2I4,F7.2` | Algorithm 0 none, 1 CSIR, 2 riparian. Riparian area: % of the alien vegetation area in the riparian zone (U-21, resolved Round 6) |
| L.012 | NYRA > 0 | NYRA × year | `NYRA(1X,I4)` | |
| L.013 | NYRA > 0 | NYRA × alien area | `NYRA(1X,F0.1)` | km² |
| L.014 | NYRA > 0 | %tall trees, age, %medium trees, age, %tall shrubs, age | `F6.2,5F7.2` | %; years |
| L.015 | NYRA > 0 | optimal % | `F6.2` | % |
| L.016 | always **[U]** | NYRP | `I4` | Years of paved-area data. Present in every v7 file. Its presence in v0–v2 is U-2 |
| L.017 | NYRP > 0 | NYRP × year | `NYRP(1X,I4)` | |
| L.018 | NYRP > 0 | NYRP × paved fraction | `NYRP(1X,F5.3)` | Fraction of catchment |
| L.019 | always | number of outflow routes *k* | `I3` | Up to 10 |
| L.020 ×*k* | always | route no.; % of outflow | `I4,F6.1` | Percentages should total 100.0. Warn otherwise |
| L.021 | v ≥ 3 | Hughes inflow route; runoff module influencing this one's GW | `2I4` | Always `0 0` **[F]** |
| L.022 | v ≥ 3 | GW model; HGSL; GPOW; TLGMax; HGGW (v ≥ 4) | `I3,4F9.3` | Model: 0 classic Pitman, 1 Hughes, 2 Sami |
| L.023 | v ≥ 4 | Hughes set: POW … FF | as L.003 | Hughes's copy of the 12 Pitman parameters |
| L.024 | v ≥ 4 | use reaches for drainage density (1/0); drainage density | `I3,F9.5` | |
| L.025 | v ≥ 3 | no. of reaches; riparian width %; riparian strip factor; rest water level; transmissivity; storativity | `I4,F7.2,F8.3,F7.2,F7.2,F7.4` | Hughes |
| L.026 | v ≥ 3 | initial GW slope | `F8.4` | Hughes |
| L.027 | v ≥ 3 | annual GW abstraction, upper zone | `F8.2` | Hughes |
| L.028 | v ≥ 3 | 12 × monthly % of L.027 | `F6.2,11F7.2` | % |
| L.029 | v ≥ 3 | annual abstraction, riparian zone | `F8.2` | Hughes |
| L.030 | v ≥ 3 | 12 × monthly % of L.029 | `F6.2,11F7.2` | % |
| L.031 | v ≥ 4 | aquifer thickness; storativity; initial aquifer storage; static water level; unsaturated storage | `F6.2,F7.4,3F8.2` | Sami. 31 files use `3F7.2` for the last three (both read the same) |
| L.032 | v ≥ 4 | initial unsaturated storage; PPOW; GPOW; max discharge; SW/GW interaction power; HGSL; HGGW | `F7.2,6F8.2` | Sami |
| L.033 | v ≥ 4 | max hydraulic gradient; transmissivity; borehole distance to river; GW evaporation area | `F10.8,3F9.2` | Sami |
| L.034 | v ≥ 4 | K2; K3; interflow lag; months over which recharge is averaged; abstraction flag | `F7.2,2F8.2,I5,I4` | Var 4 is an **integer** in every file (manual: F7.2, D-2). Var 5: see [§5.5](#55-the-groundwater-abstraction-flag-quirk-tt-691-pp145146) |
| L.035 | v ≥ 4 | Sami set: POW … FF | as L.003 | Sami's copy of the 12 Pitman parameters |
| L.036 | v ≥ 4 | NYGA | `I4` | Year/abstraction pairs. Always `0` in real files **[F]** |
| L.037 ×NYGA | NYGA > 0 (see §5.5) | year; abstraction | `1X,I4,1X,F5.3` → ` 1920 0.000` (from the manual's p.144 example **[M]**) | Units **[U]** U-4 |
| L.038 | always | naturalised-flows flag (1/0); number of children *c* | `2I4` | Flag = "produce naturalised flows next run", the last setting the program saved. Always 0 **[F]** |
| L.039 ×*c* | *c* > 0 | child module number | `I4`, **one per line** **[F]** | Manual: `nI4` on one line (D-4) |
| L.040 | always **[U]** | 12 × A-pan factors | `12F6.2` | Manual: `12(F4.2)` (D-5) |

The "Present when" column assumes the file version is high enough; [§5.2](#52-file-versions-07) has the full matrix.

### 5.2 File versions 0–7

TT 691 states the version rules only as "read if version > *n*". Only **v7** files exist in any data we have. So the v0–v6 rows below are **manual-derived [M]**, and the v5–v7 distinctions are **[U]**: the manual never says what v5, v6 or v7 added. TT 691 p.103 fixes `CURRENTFILEVERSION = 7`, so **writers always write v7**.

| Line(s) | v0 | v1 | v2 | v3 | v4 | v5–v6 | v7 |
|---|---|---|---|---|---|---|---|
| L.001 version token | absent | `1` | `2` | `3` | `4` | `5`/`6` | `7` |
| L.006 var 2 FORESTALG | – | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| L.009–L.010 | – | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (L.010 always 3 values **[F]**) |
| L.011–L.015 | – | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| L.016–L.020 | ✓? | ✓? | ✓? | ✓ | ✓ | ✓ | ✓ |
| L.021, L.022 vars 1–4, L.025–L.030 | – | – | – | ✓ | ✓ | ✓ | ✓ |
| L.022 var 5 HGGW, L.023, L.024 | – | – | – | – | ✓ | ✓ | ✓ |
| L.031–L.037 | – | – | – | – | ✓ | ✓ | ✓ |
| L.034 var 5 abstraction flag | – | – | – | – | ? | ? | ✓ (integer 0/1/2 since the Oct 2014 build, TT 691 p.146) |
| L.038–L.039 | ✓? | ✓? | ✓? | ✓? | ✓? | ✓? | ✓ |
| L.040 | ✓? | ✓? | ✓? | ✓? | ✓? | ✓? | ✓ |

`✓?` means the manual puts no version condition on these lines, so by its text they're always present. That's unconfirmed for old files (U-2). Nothing is documented as introduced in v2 (U-1).

Reading policy:

- **v7:** full support. Every one of the 244 real files parses with this grammar and leaves no line over **[F]**.
- **v5, v6:** read as v7, with a warning that the layout is assumed.
- **v0–v4:** read by the matrix above. If the line count doesn't come out exact, fail with an error naming the first line that doesn't fit and the version assumed.
- **v8:** an **error**. It belongs to the daily-time-step build (version 2.6) and adds a daily-rainfall file name in an unknown position (TT 691 §11.15 fig.11-4; U-5).
- **Upgrading old versions to v7 on write.** Fill the missing blocks with the values WRSM2000 itself carries in GW-model-0 files **[F]**, so an upgraded file looks like a native one:

  ```
  L.011   0   0   0.00
  L.021   0   0
  L.022   0    0.000    3.000    2.000    2.000
  L.023   (copy of L.003)
  L.024   1  0.40000
  L.025   1  40.00   0.200  20.00  10.00 0.0010
  L.026   0.0100
  L.027   0.00    L.028 12 × 0.00    L.029 0.00    L.030 12 × 0.00
  L.031  20.00 0.0050   45.00   60.00   20.00
  L.032  10.00    0.20    0.00    2.00   -0.05    0.00    2.00
  L.033  0.00100000    10.00  1000.00     0.00
  L.034   0.10   -3.00    0.00    2   0
  L.035   (copy of L.003)
  L.036   0
  L.038   0   0
  L.040   (copy of L.005 if absent, U-2)
  ```

  Each upgrade is reported as a warning naming the blocks that were filled.

### 5.3 Blocks driven by counts

The counts NYRF, NYRA, NYRP, *k*, NYGA and *c* decide whether the next lines exist. A count of 0 suppresses its value lines entirely, with no blank placeholder line (unlike reservoirs, §6) **[F]**. Year lists are ascending, and the model interpolates between them (TT 690 ch.11–12). Years outside the simulation period are allowed **[F]**.

### 5.4 Fields we change

Our edits (Round 7 land use, Round 5 splits) only ever touch these:

- AREA and MAP (L.002);
- the year tables (L.006–L.008, L.011–L.013, L.016–L.018);
- the routes (L.019–L.020);
- the children (L.038–L.039).

Everything else is carried through unchanged.

### 5.5 The groundwater-abstraction flag quirk (TT 691 pp.145–146)

L.034 var 5 began as a logical, "abstractions on". Since the October 2014 build it's an integer:

| Value | Meaning |
|---|---|
| 0 | no GW abstraction |
| 1 | annual values (the L.036/L.037 pairs) |
| 2 | a time-series file |

Some WR2005-era files have NYGA > 0 with the flag at 0. The old reader keyed on NYGA and coped. The 2014 reader keys on the flag, skips the L.037 lines and reads them as later data, which garbled the A-pan factors.

- **Reader:** L.036 is always present. Read NYGA × L.037 lines whenever **NYGA > 0, whatever the flag** (the old, correct behaviour). If the flag is 0 and NYGA > 0, warn that "WRSM2000 v2.11 would misread this file" and treat the flag as 1.
- **Flag = 2** (time-series file): the file name's position is unknown (U-3). That's an **error**.
- **Writer:** when NYGA > 0, write the flag as 1, not 0, so WRSM2000 v2.11 reads the file correctly. Otherwise write what was read.
- **Observed:** all 244 v7 files have flag 0 and NYGA 0 **[F]**.

### 5.6 Parent/child (SFR)

A parent lists its children on L.038 and L.039. Each child is a full RU file of its own: same climate, its own AREA, with afforestation (L.006–L.010) or alien vegetation (L.011–L.015). Each child routes 100 % to a route ending at the zero sink **[F]**. The run log shows that WRSM2000 copies climate and parameters from the parent into each child at run time ([§14](#14-run-log-wrsm2000err)). Children appear after their parent in the `.NET` list **[F]**.

---

## 6. Reservoir module `<net>RV<n>.DAT`

Examples: [`SYRV3.DAT`](formats/examples/network/SYRV3.DAT) (lumped farm dams) and [`SYRV4.DAT`](formats/examples/network/SYRV4.DAT) (dam with a defined-demand outflow and an initial storage). The same layout serves real dams and the lumped "farm dam" module. RV files carry **no version number** **[M][F]**.

| Line | Present when | Fields | Write format | Units / meaning |
|---|---|---|---|---|
| L.001 | always | module no.; `'name'` | `I0,1X,'name'` → `4 'SY Dam'` | No version token. Empty name `''` occurs **[F]** |
| L.002 | always | MAP; `'rainfile'`; power *p* in area = *k*·V^*p* | `F7.0,1X,'name',2X,F6.4` → `   600. 'SYA.RAN'  0.6500` | mm; –; – (TT 690 ch.2) |
| L.003 | always | NYR | `I4` | Years of capacity/area data |
| L.004 | always | NYR × year | `NYR(1X,I4)`. **An empty line if NYR = 0** **[F]** | |
| L.005 | always | NYR × full supply volume | `NYR(1X,F0.2)`, empty if NYR = 0 | million m³ |
| L.006 | always | NYR × surface area at FSV | `NYR(1X,F0.2)`, empty if NYR = 0 | km² |
| L.007 | always | 12 × pan evaporation, Oct→Sep | `F7.2,11F8.2` | mm/month (pan type up to the user) |
| L.008 | always | 12 × pan factors | `F7.4,11F8.4` | – (pan × factor = lake evaporation) |
| L.009 | always | spillage route | `L5` (left-justified, 5 columns) → `10   ` | Must be one of the outflow routes (TT 689 pp.88–89) |
| L.010 | always | number of inflow routes *i* | `L5` | ≤ 5 |
| L.011 ×*i* | always | route; `'defined-flow file'` | `I0,1X,'name'` → `9 ' '` | `' '` = simulated. A name = the route carries that file's flows (inflows from the zero module) |
| L.012 | always | number of outflow routes *o* | `L5` | ≤ 5 |
| L.013 ×*o* | always | route; `'defined-flow file'` or `'*'` | as L.011 | A file name = defined abstraction. `'*'` = monthly defined abstractions (L.014). Never observed |
| L.014 | per `'*'` route | 12 × monthly volume; minimum storage; restriction factor | free format **[M]** | million m³/month; million m³; – (TT 691 p.158). Position relative to the L.013 lines unknown (U-8). **Writers don't emit `'*'` routes**; they use defined-flow files instead ([§12](#12-demand-files-what-to-write-for-a-domestic-demand)) |
| L.015 | optional, last line | initial storage | `F8.3` → `   2.500` | million m³. Absent → 50 % of FSV (TT 691 p.158). The manual's sentinel value "01.00" is garbled, and `0.000` occurs in 4 of 5 real files (U-9) |

Notes:

- `L5` fields: 166 of 173 files pad to 5 columns; 7 don't **[F]**. Read either way. Write padded.
- Reservoir routes carry a "defined" code in the GUI: `N` simulated, `F` file, `I` irrigation abstraction, `M` monthly defined (TT 689 p.89). Only `N` and `F` are expressible in the file. `I` follows from the route being an irrigation module's abstraction route.

---

## 7. Channel reach module `<net>CR<n>.DAT`

Example: [`SYCR5.DAT`](formats/examples/network/SYCR5.DAT). TT 691 §12.2 (pp.154–156).

| Line | Present when | Fields | Write format | Meaning |
|---|---|---|---|---|
| L.001 | always | module no.; `'name'`; file version | `I0,1X,'name',I4` → `5 'SY River'   2` | Version always `2` **[F]** |
| L.002 | always | wetland MAP; `'rainfile'` | `F7.0,1X,'name'` → `     0. ' '` | mm. 0 and `' '` when there's no wetland **[M][F]** |
| L.003 | always | CHBL bed loss; CHC1 wetland/aquifer storage; CHC2 area; CHC3 recharge coefficient | `F7.2,3F8.2` **[F]** (all 253 files) | million m³/month; million m³; km²; –. Dummies are still required when there's no wetland (TT 691 p.156) |
| L.004 | always | 12 × pan evaporation | `F7.2,11F8.2` | mm/month |
| L.005 | always | 12 × pan factors | `F7.4,11F8.4` | – |
| L.006 | always | principal outflow route | `L5` | Required (TT 689 fig.6.29) |
| L.007 | always | number of inflow routes *i* | `L5` | ≤ 10 |
| L.008 ×*i* | always | route; `'defined-flow file'` | `I0,1X,'name'` | `' '` = simulated |
| L.009 | always | number of outflow routes *o* | `L5` | ≤ 10 |
| L.010 ×*o* | always | route; `'defined-flow file'` | `I0,1X,'name'` | |
| L.011 | always | reserved (=1); wetland type | `2I4` → `   1   0` | 0 none, 1 basic, 2 comprehensive, 3 diversion. All observed are 0 **[F]** |
| L.012 | always **[F]** | wetland area at bankfull; volume at bankfull; area–volume power; bankfull capacity; proportion of excess into wetland; proportion of wetland volume back to channel | `F9.3,5F10.3` **[F]** (all 253 files) | Manual: present "if comprehensive". Files: **always present** (D-11) |
| L.013 | always | QDIV (reserved, 0.0) | `F7.3` | |
| L.014 | always | local wetlands inflow route | `I4` | 0 = none |
| L.015 | always | local wetlands outflow/abstraction route | `I4` | |
| L.016 | always | diversion outflow route | `I4` | |
| L.017 | always | bankfull capacity; diversion efficiency; maximum monthly diversion | `F9.3,2F10.3` **[F]** (all 253 files) | Wetland types 1–3 never observed (U-15) |

Eight hand-made v2 files write L.004 as `F0.0` with spaces and L.005 as leading-dot `.81` **[F]**. Read them as free format. Write as above.

---

## 8. Irrigation module `<net>RR<n>.DAT`

Example: [`SYRR6.DAT`](formats/examples/network/SYRR6.DAT) (v32, WQT, model type 2), with the legacy [`legacy/SYRR22.DAT`](formats/examples/legacy/SYRR22.DAT). TT 691 §12.4 (pp.157–176).

**The version token** has two digits. The first is the file-format family and the rest is the revision (TT 691 p.66: "1x for WRSM/Pitman or 2x for WQT … first digit model type, digits after that the file version"):

| Token | Meaning |
|---|---|
| `32` | WRSM + WQT family, revision 2. Every observed versioned file |
| `42` | WQT type 4. Manual only |
| absent | WRSM90 original |

**Line 2 (model type)** is the method *last used*: 1 Pitman, 2 WQT, 3 WQT-SAPWAT, 4 WQT type 4. A v32 file **always carries all the WQT lines**, even when the model type is 1 **[F]** (D-8).

### 8.1 Version 32

Every line is written in **minimal width, single-space separated**. A plain `F0.d` below means one blank between values.

| Line | Present when | Fields (TT 691 names) | Write format | Units / meaning |
|---|---|---|---|---|
| L.001 | always | NRREN; `'RRNAM'`; version | `1X,I0,2X,'name',1X,I0` → ` 6  'SY Irrigation' 32` | Two blanks before the name **[F]** |
| L.002 | always | MODEL | `1X,I0` → ` 2` | 1 Pitman, 2 WQT, 3 WQT-SAPWAT, 4 WQT type 4. Observed: 2 (298), 1 (3) |
| L.003 | always | RRMAP; `'rainfile'`; DROUGHT_APPLICABLE; CurtailByClipping | `F0.2,2X,'name',1X,I0,1X,I0` | mm; –; drought factor 0/1; clip high months (1) or reduce proportionally (0). **The 4th value may be absent (16 files) → 0** **[F]** |
| L.004 | always | NYR | `I0` | Years of irrigated-area data |
| L.005 | NYR > 0 | NYR × year | `F0` years | No blank placeholder when NYR = 0 (unlike RV) **[F]** |
| L.006 | NYR > 0 | NYR × area | `F0.2` | km² irrigated |
| L.007 | always | 12 × PINDEX | `F0.2` | Proportion of area irrigated each month (Pitman) |
| L.008 | always | 12 × A-pan evaporation | `F0.2` | mm/month |
| L.009 | always | 12 × A-pan/crop factors (type 4 uses these) | `F0.2` | – |
| L.010 | always | PERM; 12 × effective-rainfall factors EFFP | `F0.3, 12F0.4` | Max annual allocation, mm (Pitman); – |
| L.011 | always | NRRARN abstraction route | `I0` | The inflow route |
| L.012 | always | NRRRRN return-flow route; RRPERC | `I0,1X,F0.2` | Route 0 = no return flow; % of the inflow returned |
| L.013 | always | area interpolation (KA+1); RRMA max allocation; NPMA; allocation interpolation (KMA+1); IRRSW runoff module the block lies in | `I0,F0.2,I0,I0,I0` | Interpolation codes (U-14); million m³/a; count; –; module **number** |
| L.014 | always | TLSQRF canal seepage → return flow; NETRETFLOWS | `F0.3,1X,I0` | –; 1 net, 0 total return flows |
| L.015 | always | RRTLPQ, RRTLPS, RRIE, RRLF, RRPRFU, RRPRFL, RRSCF, RRPSL, RRSLD(1), RRSLD(2) | `10F0.4` | Canal flow loss, salt loss, irrigation efficiency, return-flow factor, upper/lower-zone return proportions, salt factors (TT 691 pp.160–161) |
| L.016 | always | RRSSUI, RRSSLI, RRHSU, RRHSL, RRHT, RRHI | `6F0.3` | Initial salt loads; soil-moisture capacities (upper, lower), target, initial (mm) |
| L.017 | always | 12 × RRERF effective-rainfall factors | `12F0.3` | |
| L.018 | always | 12 × APFWQ A-pan factors (WQT type 2) | `12F0.3` | The file holds **two** A-pan factor sets: L.009 (type 4) and L.018 (type 2) |
| L.019 | always | NCPS crops | `I0` | |
| L.020 ×NCPS | always | 12 × crop factors; CPF %; `'crop name'` | `12F0.3,1X,F0.2,1X,'name'` | Default crop `'composite'` **[F]** |
| L.021 | always | RRERL1; RRERL2 | `F0.3,1X,F0.3` | Effective-rainfall limits |
| L.022 | always | NPMA allocation points; interpolation | `I0,1X,I0` | Always `0 1` **[F]** |
| L.023 | L.022 count > 0 | years | `F0` years **[U]** | Never observed (U-11) |
| L.024 | L.022 count > 0 | allocation values | `F0.3` **[U]** | |
| L.025 | always | NRFA return-flow points; interpolation | `I0,1X,I0` | |
| L.026 | L.025 count > 0 | years | single-spaced | |
| L.027 | L.025 count > 0 | return-flow growth factors | `F0.3` | |
| L.028 | always | NIEG efficiency points; interpolation | `I0,1X,I0` | Always `0 1` **[F]** |
| L.029 | L.028 count > 0 | years | **[U]** | Never observed |
| L.030 | L.028 count > 0 | efficiency values | `F0.3` **[U]** | |

**The real files end at L.028** (24 or 26 lines). The manual's example lists L.023/L.024 and L.029/L.030 with counts of 2. Counts of 0 drop those lines **[F]**.

**Version 42 (WQT type 4)** adds L.031–L.040 (TT 691 pp.169–176; RRERFT4, RRERFMT4, the capacity table, canal loss, deep GW, max/min upper-zone storage, canal-end spill). It's **manual only**: read it per TT 691 pp.162–176 and never write it. Our app writes v32 only.

### 8.2 Unversioned (WRSM90) layout

There's one orphan **[F]**, which matches the manual's "original method" lines with **no model-type line**:

| Line | Fields |
|---|---|
| 1 | no.; `'name'` (no version) |
| 2 | MAP; `'rainfile'` |
| 3 | NYR |
| 4–5 | years; areas |
| 6 | PINDEX |
| 7 | pan evaporation |
| 8 | pan/crop factors |
| 9 | PERM + 12 effective-rainfall factors |
| 10 | abstraction route |
| 11 | return route; % |

It uses leading-dot reals and has no final newline. Read it, then upgrade to v32 on write: model type 1, and the WQT lines filled with the defaults most common in v32 files. Warn on the upgrade.

---

## 9. Mine module (manual only)

TT 691 §12.5 (pp.176–181) defines a 68-line-type layout (opencast, underground and slurry sections, each with growth tables). **No mine file exists in any data we have.** It's out of scope for Pitman v1:

- **Reader:** an error, "mine modules not supported".
- **Writer:** none.

Two things are still open: the `.NET` type letters for a mine (TT 689 says `MM`, while TT 691 §12.6 lists only four types; U-13), and the whole layout, which is unverified.

---

## 10. Rainfall `.RAN` and rain-gauge `.MP`

Example: [`SYA.RAN`](formats/examples/network/SYA.RAN).

### 10.1 Hydrological-year convention

Every monthly file is laid out in rows of **12 months, October to September** **[M][F]** (TT 691 pp.148 and 185; TT 689 p.8). **A row labelled *Y* holds October *Y* to September *Y*+1** **[I]**, high confidence. The evidence:

1. The WR2012 period "1920–2009" is 90 rows.
2. An `.obs` file updated recently has its last row partly filled October to January and then marked missing. That fits a row label equal to the October year.
3. TT 690 §6.5 updates irrigation "at the start of each hydrological year" with the year counter IYR.

No manual states the label rule outright, so it's listed as U-19. The CHIRPS extension (method A) must use this convention.

### 10.2 `.RAN`: catchment rainfall as % of MAP

| Columns | Fortran | Field |
|---|---|---|
| 1–7 | `A7` | Code, left-justified (`SYA    `). One code per file **[F]** |
| 8–11 | `I4` | Hydrological year |
| 12–95 | `12F7.2` (read each field as `F7.0`: a value without a decimal point is whole percent, U-23) | Monthly rainfall, % of the catchment MAP, Oct→Sep. The row total is ≈ 100 on average |

- Fixed columns (TT 689 §2.3.3 p.8). There's no header and no footer, years are contiguous and ascending, and the files have CRLF line endings **[F]**.
- **Read** by columns, not by tokens. A 3-character code followed by blanks is fine, but a code longer than 7 characters would shift the year.
- **Write** exactly 95 columns. `F7.2` holds up to 9999.99, so a value too wide for it is an error.
- Rainfall in mm = % × MAP / 100, where MAP is the module's own MAP (L.002 of RU, L.002 of RV or CR, L.003 of RR).
- The legacy HDYP08 two-digit-year variant is accepted by WRSM2000 (TT 689 p.8) but isn't present in any file. Reject it.
- **Appended rows** (method A, CHIRPS) are written in the same layout. Their provenance goes in the `pitman.json` sidecar, never in the `.RAN`, because a comment line would break WRSM2000's fixed read.

### 10.3 Rain-gauge `.MP` and report `.REP` (manual only, not used by a run)

- **`.MP`** (example [`raingauge/0999123.mp`](formats/examples/raingauge/0999123.mp)): a header with the section number, position number, start year, end year and MAP in **tenths of a mm**. Then one line per hydrological year: the 7-digit gauge number, year, and 12 × monthly rainfall in tenths of a mm, each in 5 columns (TT 689 p.32 and TT 691 §12.7.1). The column positions in the two manuals disagree slightly, so read it as free format.
- **`.REP`**: a free-text report (TT 691 §12.7.3). Never read.

Neither file is needed to run a network. Both are listed only for completeness.

---

## 11. Monthly time-series family

All of these share one row skeleton: 4 blanks, `I4` year, then 12 monthly fields of 8 columns each, Oct→Sep. **Units are million m³ per month** for flows, defined flows, demands and shortages (DWS text exports of the same series say `Units: M.m3` **[F]**).

### 11.1 The common read (WRSM2000's format)

WRSM2000 reads every flow-type file with `(4X,I4,1X,12(F7.0,1A))` (TT 689 §2.3.4 p.8):

| Columns | Content |
|---|---|
| 1–4 | ignored |
| 5–8 | year |
| 9 | ignored |
| for month *k* = 0…11: 10+8*k* … 16+8*k* | value (`F7.0`: an explicit decimal point wins) |
| 17+8*k* | one **flag character** |

Everything after column 105 is **ignored**, including annual totals, mean columns and flags.

Consequences for our reader:

- **Read by columns**, as WRSM2000 does. An all-blank value field reads as 0, which is Fortran's blank-as-zero rule **[I]**.
- The flag is kept per month: blank, `+` (patched or incomplete, the DWS convention), or anything else (`A`, `E`, `M`, `*`, `#` appear **[F]**). A flag other than blank or `+` is a warning.
- Non-data lines (a blank line, the `.ANS` separator, the `AVERAGE` footer, a text header) end the data or are skipped:
  - a line whose columns 5–8 aren't a 4-digit year ends the data;
  - text **before** the first data row is an error ("not a WRSM2000 flow file").

  The `.ANS` footer is why this rule exists: TT 689 p.8 says `.ANS` files can be used as defined-flow inputs unchanged.
- Year gaps: all 600+ observed files are contiguous **[F]**. A gap is an error. Defined-flow files must cover the full simulation period (TT 689 p.150); a shorter file is an error, a longer one is fine.

### 11.2 Answer files `.ANS` (and `.MTS`, `.DEM`, `.SHO`), as WRSM2000 writes them

Examples: [`Out/SYRQ9.ANS`](formats/examples/network/Out/SYRQ9.ANS), [`Out/SYRQ7.DEM`](formats/examples/network/Out/SYRQ7.DEM) and [`Out/SYRU1ncr.MTS`](formats/examples/network/Out/SYRU1ncr.MTS).

| Row | Write format | Content |
|---|---|---|
| one per year | `4X,I4,12F8.2,F10.2,F10.2` = 124 columns | year; 12 monthly values; **annual total**; **monthly mean** (= annual / 12) |
| separator | the two characters `  ` (2 blanks) | |
| footer | `' AVERAGE'` (8 columns), `12F8.2,F10.2,F10.2` | Mean of each column over the years |

The file ends with CRLF after the footer **[F]**: all 395 `.ANS`, 136 `.MTS` and 1 truncated-period file share this layout byte for byte.

Arithmetic, checked over 41,125 rows **[F]**:

- The annual total is the sum of the **unrounded** monthly values. In 54 % of rows it differs from the sum of the printed values by more than 0.005.
- The mean column is the **unrounded** annual divided by 12. In 3.3 % of rows it is not the printed annual divided by 12 (Round 2 check over 531 `.ANS`/`.MTS` files, 47,785 rows). `answerFromSeries` therefore needs the unrounded months; fed printed values it can't reproduce a WRSM2000 file.
- `AVERAGE` matches the mean of the printed values to within 0.0063, which means it was computed from unrounded values.

So writers compute from unrounded float32 values and round only when printing.

Names (TT 689 §2.3.4 p.8 and §4.5–4.8, pp.13–17):

| Pattern | Holds |
|---|---|
| `<net>RQ<route>.ANS` | simulated route flow |
| `<net>RV<n>.ANS` | reservoir storage, million m³ |
| `<net>RQ<route>.DEM` | demand on a route |
| `<net>RQ<route>.SHO` | shortage (demand − supply, **positive**) |
| `<net>RU<n><series>.MTS` | runoff-module time series (`ncr` = net catchment runoff, observed **[F]**; for an SFR parent it is the parent's **own** runoff depth × its full L.002 area, not the flow its routes carry (Round 6); `dfl` = daily flows, TT 689 p.198) |

The other `.MTS` series codes (surface runoff, GW outflow, Pitman S, …) are unknown (U-20). For the series given in mm (soil moisture, recharge), the same layout holds but the units are mm. All five types are written to the output folder.

Pitman's results screen downloads `.ANS` files in this layout. When several run modes are shown it appends the mode to the name (`SYRQ4-natural.ANS`); WRSM2000's readers still take the file.

`RV*.ANS` (reservoir storage) was never observed. Its annual and mean columns, which would be meaningless for a storage, are unknown (U-20). Write it in the same layout, with the annual column as the sum, until a real one is seen.

### 11.3 Defined-flow and demand input files (`.abs`, `.prn`, `.IRR`, `.DEF`, `.URB`, `.IND`, or any name)

Examples: [`SYDOM.abs`](formats/examples/network/SYDOM.abs) (demand on a reservoir outflow) and [`SYINF.abs`](formats/examples/network/SYINF.abs) (defined inflow to a channel).

- The name is free; RV and CR route lines name the file ([§6](#6-reservoir-module-netrvndat) and [§7](#7-channel-reach-module-netcrndat)). The extension doesn't matter. `.prn` is used **both** for defined-flow files **and** for WRSM2000's temporary print file `WRSM2000.prn` (TT 689 p.159). Only a `.prn` referenced from a module is a flow file.
- Observed layouts **[F]**, all valid under §11.1:
  - `4X,I4,12F8.2` (104 columns, no annual column);
  - `4X,I4,12F8.1`;
  - `4X,I4,12F8.2,F11.2` with an annual column;
  - `.ANS` layout;
  - `+` and `A` flags.
- **Writers** use `4X,I4,12F8.2` with no annual column. That's the most common hand-made layout, and WRSM2000 ignores anything past column 105 anyway.

### 11.4 Observed flows `.obs`

Example: [`SYH001.obs`](formats/examples/network/SYH001.obs).

- Typical layout **[F]**: `4X,I4,1X,12(F7.2,A1),F10.2,A1` = 116 columns. That's 12 values each followed by a flag, then an annual total with its own flag (`+` if any month is flagged). The annual is ignored on read.
- Many `.obs` files use the **leading-dot** style `    .06+`, which reads the same.
- A record may cover only part of the simulation period (e.g. 4 years); comparison uses only the overlap. Years outside the period are ignored.
- **Missing data:** no convention is documented (U-16). One recently extended file marks missing months `-99.999`, and a DWS export uses `-199.998`. Treat **any negative value as missing**, with a warning, and never compare those months.
- **Misaligned rows (found in the reference network).** Rows appended in a `4X,I4,12F8.3` layout put a 9-character first value at columns 9–17. Under WRSM2000's fixed read, every month is then **truncated to 2 decimals** and its **third decimal lands in the flag column**. `-99.999` is read as `-99.99` with flag `9`.

  Our reader must read these rows the way WRSM2000 does, so comparisons match the original, and must **warn** with the file, line and "3-decimal layout: WRSM2000 reads this as truncated values with digit flags". A rewrite of such a file uses `4X,I4,1X,12(F7.2,A1)`.
- Writers: we never write `.obs` except as the user's own uploads, which are passed through byte-for-byte.

### 11.5 `.nat`: summed natural flows

Example: [`SY.nat`](formats/examples/network/SY.nat).

- `4X,I4,12F8.2,F10.2` = 114 columns, with the annual total and **no footer** **[F]**. One file is in full `.ANS` layout.
- Each month of a `.nat` equals the **sum of the printed values** of the `.MTS` files listed in the same-named `.lst` file (verified to 0.01 for the reference network) **[F]**.
- This looks like the product of a WR2012 post-processing step rather than a WRSM2000 menu (TT 689 describes no `.nat` writer, [§13](#13-lst)) **[I]**.
- Networks name `.nat` files as gauge "observed" series **[F]**, so they must read under §11.1, which they do.

### 11.6 Shortage `.SHO` and demand `.DEM`

These use the `.ANS` layout ([§11.2](#112-answer-files-ans-and-mts-dem-sho-as-wrsm2000-writes-them)), with values in million m³/month. A shortage is stored positive (TT 689 p.17).

### 11.7 Statistics `.OUT` and summary `.SUM`

- **`.OUT`** (`<net>ALL.OUT` or `<net>RTxxx.OUT`, TT 689 §4.2): a printed report with a page header, the parameter legend and boxed tables. It's for people, not machines; we don't read it.
- **`.SUM`**: never observed.

### 11.8 Supply `.SUP`

Obsolete (TT 689 §4.7). Never written.

### 11.9 Files present but not read by a run

- `.dwg` and `.pdf`: network diagrams. `.bak` and `.log`: CAD backups and plot logs.
- `.txt` and `.IRR` with a `Station: … Units: M.m3` header: DWS exports.
- `.nsi`, `.INF`, `.MAR`: other tools' formats.

The app ignores them when loading and keeps them byte-for-byte in a saved zip.

---

## 12. Demand files: what to write for a domestic demand

WRSM2000 has two ways to impose a demand. Neither has a growth parameter, so **growth is applied by us when the file is generated** **[I]**.

1. **A defined-flow file** on a reservoir or channel outflow route to the zero sink (TT 689 §2.2, the "zero module" pattern) or to another module. **Use this one.** It's observed **[F]**, can express any growth path, and supports restrictions only through the reservoir's normal deficit handling (TT 689 ch.8).
2. **Monthly defined abstractions:** `'*'` on an RV outflow route plus an L.014 with 12 volumes, a minimum storage and a restriction factor (TT 691 p.158; TT 689 §6.2.4). It holds a constant monthly pattern with no growth. It's never observed, and its layout position is unknown (U-8). **Read it only.**

Generating a domestic demand for Round 7, with annual volume *A*_*Y* in million m³/a for each hydrological year *Y*, monthly distribution *d*₁…*d*₁₂ (Oct→Sep, summing to 1), and growth:

- *A*_*Y* is given for anchor years and interpolated (linear or compound growth, as the user chooses) between them. It's held constant beyond the last anchor in present-day mode.
- Each month's value is *A*_*Y* · *d*_*m*, written in `4X,I4,12F8.2`.
- The file covers **every** year of the `.NET` period (§11.1).
- It's named after the route, e.g. `SYRQ11.abs`, referenced on the RV L.013 line, and recorded in the sidecar with its inputs (anchors, distribution, growth, source), per rule 8.

The 0.005 Mm³/month write resolution (5,000 m³) is coarse for small towns. The writer must report the total rounding loss per year. If it exceeds 0.5 % of *A*_*Y*, consider `F8.3` (still 8 columns, read correctly by `F7.0` only up to 99.999, U-18).

---

## 13. `.lst`

Example: [`SY.lst`](formats/examples/network/SY.lst). One absolute Windows path per line (CRLF), each naming a `.MTS` file. The `.nat` of the same base name is their monthly sum ([§11.5](#115-nat-summed-natural-flows)) **[F]**. It's not read by a WRSM2000 run. Our reader resolves only the base name of each path inside the zip, and warns about paths that don't resolve.

---

## 14. Run log `WRSM2000.ERR`

Example: [`Out/WRSM2000.ERR`](formats/examples/network/Out/WRSM2000.ERR). A free-text log rewritten at each run. It's found in the input folder (older runs) or the output folder (newer runs) **[F]**. **Line breaks are a mix of CRLF and bare CR**, so split on both. Treat each piece as one line and keep blank pieces as blank lines.

Parsing only what we need:

- **Header:** `          Date of run: YYYY/MM/DD          Time: HH:MM:SS`, then `          Network: <code>`.
- **SFR child block** (one per child module), from `==== CHILD <n>` up to the next `==== CHILD` or the first `Reservoir Module`/`Channel Module` line. Extract these key–value lines with the regex `^(.+?)\s*[:=]\s*(-?\d+(?:\.\d+)?)\s*%?$`:

  | Line | Meaning |
  |---|---|
  | `Virgin MAR: <x>` | Naturalised MAR of the child, **million m³/a** **[I]** (it's ≈ area × natural runoff depth) |
  | `Virgin LQT: <x>` | Naturalised low-flow index, units unknown (U-17) |
  | `Naturalised MAR (VMAR) = <x>`, `Required MAR (QMAR) = <x>` | |
  | `Naturalised Low Flows (VLQT) = <x>`, `Required Low Flows (QLQT) = <x>` | |
  | `Reduction percentage in MAR (TPRM) = <x>`, `… in Low (TPRL) = <x>` | % |
  | `SFR is <text>` | The algorithm: observed `CSIR ALIEN Vegetation` and `a Smoothed Gush` **[F]** |
  | `Original PI/FF/SL/ST/HGSL = <x>` | Parent parameters copied in |
  | `ITERATION : <i>` followed by `ST/PI/SL/FF/HGSL = <x>` | Adjusted parameters at each iteration |
  | `Iteration QMAR/QLQT/ERRM/ERRL: <x>` | |
  | `Number of Iterations: <n>`, `Final QMAR: <x>`, `Final QLQT: <x>` | |

  The Round 6 check (alien vegetation / paved, "Virgin MAR") reads `Virgin MAR`, `Final QMAR`, `TPRM` and `TPRL` per child.
- **Deficit messages** (one block per event, blank-line separated), each with its line pattern:
  - `Reservoir Module <n> <name>`
  - `Water balance error in .. of <YYYY>` (the month is literally `..` **[F]**)
  - `There was not enough water to satisfy calculated demands.`
  - `Calculated outflows were reduced.` / `… were set to zero.`
  - `The reservoir was dry.`, `Defined outflows were set to zero.`
  - `Channel Module <n> (<name>)`
  - Summaries: `Reservoir Module <name>`, then `Module number: <n>` (also `Module number : <n>`), then `At least <k> minor|major failure(s) to supply calculated|defined demands.`
- Anything else: keep it as unparsed text. Never fail on an unknown line.

We never write `.ERR`. Our engine produces its own structured log, and the example exists only as a parser fixture.

---

## 15. Manual vs files disagreements

In every case **the files win**, and readers and writers follow the files.

| # | Topic | Manual says | Files show |
|---|---|---|---|
| D-1 | RU format widths | TT 691 gives specifiers such as POW `F3.1`, SL `I5`, MAP `I4`, pan `F4.0`, A-pan `F4.2` | WRSM2000 writes wider fields: L.003 `F6.1,I6,…,F8.2`, MAP `I5`, pan `F6.0` (§5.1). The manual's widths are minima; reading is free-format anyway |
| D-2 | RU L.034 var 4 (months for recharge averaging) | `F7.2` | Integer (`I5`) in all 244 files |
| D-3 | RU L.010 vars 2–3 | Only for a child with user-defined reductions | Always written: all 27 files with afforestation have 3 values |
| D-4 | RU L.039 children | `nI4`, one line | One child number per line (`I4`) |
| D-5 | RU L.040 A-pan factors | `12(F4.2)` | `12F6.2` |
| D-6 | `.NET` line types | Example numbering suggests a debug-period line and summary lines | Always NET.4 = `N` with no NET.5, NET.6 = `N`, and the file ends with NET.15 = `    0` |
| D-7 | `.NET` directories and gauge names | Plain path; `'Gauging Station 3 '` | Paths blank-padded to 287 columns; gauge names padded to 20 inside the quotes |
| D-8 | RR v32 with model type 1 | The "original method" example has only 12 lines | v32 files always carry the WQT lines (24–26 lines), whatever the model type |
| D-9 | RR v32 tail | The example has L.023–L.024 and L.029–L.030 (counts 2) | Counts are 0 and those lines are absent; files end at L.028 |
| D-10 | RR L.003 | 4 values | 16 files have 3 (no clipping flag) |
| D-11 | CR L.012–L.017 | Present "if a comprehensive channel has been chosen" | Present in all 244 files, all wetland type 0 |
| D-12 | Empty year tables | Not discussed | RV writes three **empty lines** for NYR = 0; RR writes **no** lines; RU writes no lines |
| D-13 | `.RAN` example (TT 691 §12.7.2 p.185) | Shown free-spaced: `B06 1930 1.79 …` | Fixed `A7,I4,12F7.2` (TT 689 §2.3.3 has this right) |
| D-14 | `.ANS` "same format as flow files" (TT 689 p.8) | `(4X,I4,1X,12(F7.0,1A))` | `.ANS` adds an annual total, a monthly-mean column, a 2-blank separator and an `AVERAGE` footer. Still readable as flow input, because the read stops at the footer |
| D-15 | `WRSM2000.ERR` content (TT 689 §4.9) | "Supply errors and deficits" | Also holds the SFR child-calibration trace; mixed CRLF/CR line breaks |
| D-16 | RV L.001 | "Note the parentheses" | Quotes, like every other name |
| D-17 | RV initial storage L.015 | Absent or "01.00" → 50 % FSV | `0.000` occurs; its meaning is unknown (U-9) |

---

## 16. Unknowns

Each unknown has a best guess and the evidence for it. Later rounds resolve these against the reference comparison, or with the operator in WRSM2000 (Wine), never by inspecting the program.

| # | Unknown | Best guess | Evidence |
|---|---|---|---|
| U-1 | What RU file versions 2, 5 and 6 introduced | v2: paved areas (L.016–L.018). v5–v6: the L.010 user-defined SFR values, the L.011 riparian area and L.034 var 5 | TT 691 documents v0/v1/v3/v4 boundaries only. `CURRENTFILEVERSION = 7` (p.103) and the abstraction flag became integer in Oct 2014 (p.146), so v7 ≈ Oct 2014 |
| U-2 | Whether L.016–L.020 and L.038–L.040 exist in v0–v2 | Yes (the manual sets no condition) | TT 691 pp.148–153 conditions only L.006 var 2, L.009–L.015, L.021–L.037 |
| U-3 | RU abstraction flag = 2: where the GW-abstraction time-series file name goes | A quoted name after L.036 | p.146 says only "it will expect certain data later on in the datafile" |
| U-4 | Units of L.037 abstraction values | million m³/a | The manual's example values are 0.000–0.050; Hughes L.027 is described as "annual" |
| U-5 | RU v8 (daily build) layout | A daily-rainfall file name after L.002's rainfile | TT 691 fig.11-4 "For version 8, reads the daily rainfall filename" |
| U-6 | Why `.NET` directory lines are 287 columns, and whether WRSM2000 needs the padding | A fixed-length `CHARACTER` variable; padding not needed (a hand-edited copy with 210/214 columns is in use) | All 34 WRSM2000-written files are exactly 287 |
| U-7 | `.NET` summary lines (NET.16) widths | Free format, `'RT' n 'Q'` | Only the manual example |
| U-8 | Position of RV L.014 for `'*'` routes | Immediately after its own L.013 line | Manual p.158 example numbers it 0014 after 0013 |
| U-9 | RV L.015: does `0.000` mean empty or "use the default 50 %"? "01.00" is probably "-1.00" | `0.000` = start empty; a negative value = 50 % FSV | 4 of 5 files with L.015 have `0.000` on dummy/defined reservoirs |
| U-10 | Why RV/CR count and route lines are left-justified to 5 columns | Written via an internal string (`A5`) | 166/173 RV and 206/244 CR files |
| U-11 | RR L.023/L.024, L.029/L.030 formats; all of v42 (WQT type 4) | `F0` years and `F0.3` values; v42 per TT 691 pp.162–176 | Never observed |
| U-12 | RR L.013 vars 3–4 vs L.022 (both "number of allocation points") | L.013 var 3 is the legacy copy; L.022 governs the table | Variable names NPMA/KMA appear in both (TT 691 pp.170–172) |
| U-13 | Mine module `.NET` letters (`MM`?) and real layout | `MM`, per TT 689 §2.3.1 | No mine files; TT 691 §12.6 lists four types only |
| U-14 | Interpolation codes (RR L.013, L.022, L.025, L.028): which number is linear, exponential or defined | 1 linear, 2 exponential, 3 defined (stored as KA+1) | TT 691 p.171 `KA + 1`; every file has 1 |
| U-15 | CR wetland types 1–3 and diversion (L.012–L.017) semantics | Per TT 690 ch.9–10 | All files are type 0 with dummy values |
| U-16 | Missing-value convention in `.obs`; meaning of flags other than `+` | Negative = missing; `A`/`E` = estimated, `M` = missing, `*`/`#` = DWS quality codes | -99.999 and -199.998 seen; flags A, E, M, *, # in 5 files |
| U-17 | ERR: units of `Virgin LQT`/`VLQT`; when the child block is written | Low-flow index (WR90's "LQT"); written only when the SFR reduction is recomputed | A 2014 log has 9 child blocks; a later run of the same network has none |
| U-18 | Lahey F-format rounding at ties, negative zero, float32 vs float64 at print | Half away from zero on the float32 value; `0.00` | Not testable without the program; affects `.ANS` byte-identity only |
| U-19 | Hydrological-year label (row *Y* = Oct *Y* to Sep *Y*+1) | As stated, high confidence | [§10.1](#101-hydrological-year-convention) |
| U-20 | `.MTS` series codes other than `ncr`/`dfl`; the annual column in `RV*.ANS` | Short codes per series; sum as for flows | Only `ncr` observed; `dfl` in TT 689 p.198 |
| U-21 | Units of RU L.011 riparian area | **Resolved (Round 6):** % of the alien vegetation area (TT 691 §7.4.2 RipVegAreaPerc; `docs/theory/alien.md`) | Values 0.00–0.60 alongside alien areas of a few km² |
| U-22 | Whether WRSM2000 accepts LF-only files | Probably (Fortran formatted reads usually tolerate both) | All files are CRLF; we always write CRLF, so this doesn't matter for output |
| U-23 | How WRSM2000 reads a `.RAN` field with no decimal point | As `F7.0` (`12` = 12 %), provisional | TT 689 gives no read format; one hand-made reference file is affected |

---

## 17. Examples

[`docs/formats/examples/`](formats/examples/) holds a small, complete, **synthetic** network `SY`. Every value is invented. The period is 1990–1994 (5 years), and the layout matches the observed files byte for byte: CRLF line endings, widths, padding and the `.ANS` footer. Round 2 parsers can use it for round-trip tests, and Round 3 can run it.

| File | Format | Demonstrates |
|---|---|---|
| `network/SY.NET` | §4 | 8 modules in solution order, 12 routes including zero-module inflow and outflow, 1 gauge, 287-column directory lines |
| `network/SYRU1.DAT` | §5 v7 | Sami parent, 2 outflow routes (60/40), 2 children |
| `network/SYRU11.DAT` | §5 v7 | CSIR alien-vegetation child (NYRA = 3) routed to the zero sink |
| `network/SYRU12.DAT` | §5 v7 | CSIR afforestation child (NYRF = 2) |
| `network/SYRU2.DAT` | §5 v7 | Classic Pitman (GW model 0), paved areas (NYRP = 2) |
| `network/SYRV3.DAT` | §6 | Lumped farm dams: spill and irrigation abstraction outflows |
| `network/SYRV4.DAT` | §6 | Dam with a defined-demand outflow file and an initial storage (L.015) |
| `network/SYCR5.DAT` | §7 | Channel with 5 inflows (one a defined inflow file) |
| `network/SYRR6.DAT` | §8.1 | WQT v32, model type 2, 3-year area table, return flow |
| `network/SYA.RAN` | §10.2 | Rainfall as % MAP |
| `network/SYH001.obs` | §11.4 | Partial record, `+` flags, a row in leading-dot style, annual totals |
| `network/SYDOM.abs`, `network/SYINF.abs` | §11.3, §12 | Defined demand and defined inflow |
| `network/Out/SYRQ9.ANS` | §11.2 | Route flows with annual, mean and `AVERAGE` footer |
| `network/Out/SYRQ7.DEM` | §11.6 | Demand file (`.ANS` layout) |
| `network/Out/SYRU1ncr.MTS`, `SYRU2ncr.MTS` | §11.2 | Net catchment runoff series |
| `network/SY.lst`, `network/SY.nat` | §13, §11.5 | `.nat` = sum of the listed `.MTS` files' printed values |
| `network/Out/WRSM2000.ERR` | §14 | Child block and deficit messages with mixed CRLF/CR |
| `legacy/SYRU21.DAT` | §5.2 v0 | **Manual-derived and unverified**: a version-0 runoff file |
| `legacy/SYRR22.DAT` | §8.2 | Unversioned irrigation file: leading-dot reals, no final newline |
| `raingauge/0999123.mp` | §10.3 | Rain-gauge input (manual-derived) |

The `legacy/` and `raingauge/` files aren't part of `SY.NET`.

The folder has its own `.gitattributes` (`* -text`) and `.editorconfig`, so git and editors never normalise these bytes: CRLF line endings, padded trailing blanks, one deliberately missing final newline. The root pre-commit hooks `trailing-whitespace` and `end-of-file-fixer` would damage them, so they must exclude `docs/formats/examples/`.
