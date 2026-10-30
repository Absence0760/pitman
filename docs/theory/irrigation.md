# Irrigation

This page specifies the irrigation module (RR): what a block demands, what it
does with the water it gets, and how it is solved with the reservoir or channel
that supplies it. It is the spec for `packages/wrsm/src/irrigation/` (`demand.ts`,
`supply.ts`) and the RR case of `runNetwork`.

Sources, all public WRC reports (issue #3 rule 1):

- **TT 690/16**, the Theory Manual: ch.3 p.11 (Pitman); ch.4 pp.12–19, 24–25
  (WQT type 2); ch.5 pp.26–29 (WQT-SAPWAT); ch.6 pp.30–55 (WQT type 4). The
  equations are images, read from page renders (PDF page = book page + 13).
- **TT 689/16**, the User Manual: §6.1.20 pp.76–85 (the module, the two streams
  on a route); §6.1.22–6.1.25 pp.93–107 (crops, allocation, canal, groundwater,
  efficiency, return flows, capacity); pp.148–149 (diversion to a block); Knowledge
  Base Article 6 pp.166–167 (net and total return flows); ch.7 p.168; ch.8
  pp.169–170 (deficits); defaults pp.174–175.
- **TT 691/16**, the Programmer's Code Manual: §7.5 pp.65–76 (the class, what
  each method does); §12.4 pp.158–176 (file fields); change log pp.201–213.

File layouts are in `docs/formats.md` §8. Salinity (TT 690 §4.2, §6.4.2, §6.5.2
and the salt terms of §6.6) is out of scope. Provisional choices carry an ID
`R7-I…`, listed in §12 and in `docs/decisions.md`.

**This spec has not been checked against WRSM2000's outputs.** It was written
without `WRSM_REFERENCE_DIR`, so every R7-I default below is the reading of the
manuals, not a fit.

## 1. Four methods

L.002 names the method (TT 689 p.77; `irrigationMethod`, R7-I1):

| L.002 | Method | Demand | Land and return |
|---|---|---|---|
| 1 | Pitman | ch.3 | RRPERC % of the supply (eq. 3.4) |
| 2 | WQT | ch.4 | two soil stores (eqs. 4.7–4.31) |
| 3 | WQT-SAPWAT | ch.5 | as type 2 |
| 4 | WQT type 4 | ch.6 | one pseudo tank (eqs. 6.30–6.49) |

A 12-line file has only the Pitman data, so it runs as type 1 whatever L.002
says. Type 4 needs the version 42 lines; a v32 file claiming it is an error.

Which fields each method reads:

| Field | 1 | 2, 3 | 4 |
|---|---|---|---|
| L.007 PINDEX, L.010 PERM and EFFP, L.012 RRPERC | used | no | no (TT 691 pp.170–171) |
| L.008 A-pan | used | used | used |
| L.009 pan factor | crop factor | no | APANF, to lake evaporation (TT 691 p.171) |
| L.018 A-pan factor | no | to lake evaporation | no |
| L.017 RRERF | no | factor | minimum factor |
| L.031 | – | – | "not used" (TT 691 p.174) |
| L.032 RRERFMT4 | – | – | maximum factor |
| L.021 limits, L.020 crops | no | used (type 3: first row is ET, TT 689 p.96) | used |
| L.015 RRIE | no | base efficiency | fallback only (R7-I7) |
| L.016 RRHSU, RRHT | no | used | no (TT 689 p.101) |
| L.016 RRHI | no | initial HE, HNE | initial S |
| L.015 RRPRFU, RRPRFL | no | no water effect (TT 689 p.101) | used (eq. 6.42a) |
| L.033–L.040 | – | – | used |

## 2. Order of solution

"During the simulation of an Irrigation Module, the flows that are demanded by
the crops … are placed in the 'demand' stream of the Irrigation Abstraction
Route … the Irrigation Module assumes that these demands will be supplied
somehow" (TT 689 p.84). The supplier then solves; if it falls short it "sends a
message to the Irrigation module to signal that the Irrigation Module should
re-simulate itself" (p.85; TT 691 p.65, p.72 `RR_AdjRetFlow`).

Pitman solves whole records, one module at a time (R3-1). That works here
because of two facts:

1. **Demand never depends on supply.** Under every method demand is a function
   of rainfall, the module's data and the run mode. TT 690 eq. 4.7 reduces the
   *area* after the fact; eqs. 6.24–6.29 apply before "insufficient water at
   source" (p.42). The one place a reading could make demand depend on supply is
   ACCALOC, and it is charged with the demand (R7-I3).
2. **A return flow can't reach its supplier.** Validation rejects that as a
   circular argument (TT 689 p.85, p.104; `network.md` §4).

So there is no loop inside a month, and nothing iterates. An RR is solved in
**two passes** (R7-I2):

1. **Demand**, at the RR's place in the list: `irrigationDemand` puts QIG on the
   route's demand stream.
2. **Settlement**, once the route has a flow: `settleIrrigation` reads what the
   route carries and puts the return flow on the return route. WRSM2000 re-runs
   only on a failure; settling always gives the same answer, since at full
   supply the two are the same calculation.

`ReservoirSimulator` and `ChannelSimulator` take an optional fourth argument,
`demands`, route → series. The simulators already allocated it (TT 689 ch.8
priorities, proportional sharing, failure messages); only the contract was
missing. RV and CR code is otherwise unchanged.

**One reorder.** R3-N22 allows a return flow into a module listed before the
supplier, on another branch. Whole-record solving needs the return before that
module runs, so `solveOrder` moves the supplier ahead of it, with an info
message. Everything else stays in list order, and a network without this case
runs exactly in list order (R3-N3 otherwise stands).

Routes that don't obey a demand:

- **A route the supplier defines by file** (or `'*'`): the file wins and the
  block takes what it brings (R7-I19), since defined routes are "inviolate"
  (TT 689 p.170).
- **A route from a runoff module**, the principal route of a channel, or a spill
  route: all of it enters the block. TT 689 p.168 calls this wrong but it runs.
  Warned (R7-I16).

## 3. Year values and run modes

Each hydrological year takes its values at the start of the year (TT 690 §6.5.1
p.32), from linear (code 1), exponential (2) or stepped (3) interpolation
(`interpolateYearTable`, U-14), flat beyond the table (OQ-17). Exponential needs
two positive ends, otherwise that stretch is linear. The Pitman method's area is
always linear (TT 689 p.83).

| Table | Types 2, 3 | Type 4 |
|---|---|---|
| Area L.004–L.006 | km² | km² |
| Allocation L.022–L.024 | growth on RRMA (TT 689 p.98) | the value; RRMA when empty |
| Efficiency L.028–L.030 | growth on RRIE (p.102) | the value; RRIE when empty (R7-I7) |
| Return factor L.025–L.027 | growth on RRLF (p.107) | growth on RRLF ("same for both", p.106) |
| Capacity L.033–L.035 | – | the value |

D1: **historical** takes each year's values; **present day** holds every table at
its value in the chosen year; **natural** removes the block, with no demand and
zero on both routes. In present day a block's rainfall still varies, so its
demand does.

Rainfall: RAIN = RRMAP × % MAP / 100 (TT 689 p.80 on using a file with another
MAP). Means run over the file's whole record, CHIRPS-extended years included
(eq. 6.26; R7-I9).

## 4. Pitman (type 1), TT 690 ch.3 p.11

    G = Apan × Cropf                    eq. 3.1   L.008, L.009
    N = max(G − P × Reff, 0)            eq. 3.2   L.010 EFFP
    V = 0.001 × N × Airrig × Pindex     eq. 3.3   L.007
    RF = 0.01 × Ret × V                 eq. 3.4   L.012, V as supplied

PERM (L.010) limits the annual depth Σ N × Pindex (R7-I17): above it every month
is reduced in proportion, or clipped when L.003 v4 says so; "as long as this
figure is 0, the irrigation block will generate no abstractions whatsoever"
(TT 689 p.95). What doesn't return is used: there is no store.

## 5. Effective rainfall

**WQT (L.021 limits, RRERL1 upper, RRERL2 lower):** TT 690 eqs. 5.3–5.6 as
corrected (E-5), the same as TT 689 pp.96–97 and eq. 6.18 with RRERFM = 1.

**Type 4,** eqs. 6.18a–c, 6.19a, with RRERF from L.017 and RRERFM from L.032:

    RAIN ≤ RRERL2:          ERF = RRERFM                                      eq. 6.18a
    RRERL2 < RAIN < RRERL1: ERF = RRERF + (RRERFM − RRERF)(RRERL1 − RAIN)
                                                  / (RRERL1 − RRERL2)         eq. 6.18b
    RAIN ≥ RRERL1:          ERF = RRERF                                       eq. 6.18c
    ER = ERF × RAIN                                                           eq. 6.19a

The manual wants 0 < RRERF ≤ RRERFM ≤ 1 (p.37); TT 691's own example has L.017 =
1 and L.032 = 0.6. They are used as they stand, with a warning (R7-I14).

**SAPWAT,** eq. 5.7 (6.19b), ET capped at 75 mm in this equation only (p.28;
TT 691 p.209 item 75):

    ER = ET (−0.001 R²/ET + 0.025 R²/ET² + 0.0016 R + 0.6 R/ET)

kept within 0 … R, and 0 when ET is 0 (R7-I8).

## 6. Demand (types 2–4)

**Unit demand.** DIN = Σ |CPFᵢ (PE × CFᵢₘ − ER) / 100|, positive values only
(eqs. 4.1, 5.1, 6.17a; R7-I5). A crop under 0.01 % of the area is ignored (TT 689
p.96). SAPWAT: one crop, ET from L.020's first row, DIN = ET − ER (eqs. 5.2,
6.17b, Table 5.1). TCD is PE × CF weighted by area (p.17; ET for SAPWAT). PEL =
PE × the method's pan factor (§1).

**Drought factor** (optional, L.003 v3; TT 690 §5.3, §6.6.3; TT 689 p.78):

    DF = max(RAIN / RAINM, RAINa / RAINavg(a)), 0 ≤ DF ≤ 1     eq. 5.8
    type 4 divides by MAP instead                               eq. 6.21a

RAINa is the whole hydrological year, which "supposes prior knowledge of the
year's rainfall" (p.39). Off, DF = 1 (eq. 6.21b). A month with no mean rain
counts 0 (R7-I9).

**Field edge and source** (the two forms are the same):

    QIG = (DF × DIN × AREA / 1000) × (1 / EFI) × (1 / (1 − TLPQ))     eqs. 4.6, 5.9
    QID = AIRR × DIN / 1000 / RRIE;  QID1 = QID × DF;
    QIG = QID1 / (1 − RRTLPQ)                                          eqs. 6.20, 6.22, 6.23

**Allocation, types 2–3.** AQIG is the year's QIG on the full area, with that
year's real rain. If AQIG > ALL, AREAT = AREA × ALL / AQIG (eq. 4.8), so every
month falls in proportion; or, with L.003 v4 = 1, each month is capped at ALL /
12 (TT 689 p.95; TT 691 p.161; R7-I10). A WQT allocation of 0 or less is no limit
(R7-I4).

**Constraints, type 4,** in the manual's order:

    QIG ≤ RRCAP                                    eq. 6.24   0 = no limit (R7-I15)
    DFAC = DINM / Σ DINM                           eq. 6.25   DINM from eq. 6.17a on mean rain, eq. 6.26
    DALOC = DFAC × RRMA                            eq. 6.27
    ACCALOC = 0 at the start of each year          eq. 6.28a
    QIG = min(QIG, DALOC + ACCALOC)                eqs. 6.28b–c, 6.29
    ACCALOC = DALOC + ACCALOC − QIG

If Σ DINM is 0 the months share equally. Type 4 ignores L.003 v4 (R7-I10).

## 7. Types 2 and 3: the land (TT 690 §4.1.1)

QIG below is the demand, S what the route carried.

    AEFF = AREAT × S / QIG   when S < QIG, else AREAT        eq. 4.7
    ANEFF = AREA − AEFF                                      eq. 4.9

Each month HE and HNE first follow the land (eqs. 4.10–4.14). When the block's
area itself changes, soil water comes or goes with the land (`landTransfer`).
HE and HNE both start at RRHI (R7-I18).

Canal: QTLOS = TLPQ × S (eq. 4.5); RC = Fc × QTLOS (eq. 4.55, Fc L.014 v1); the
rest of QTLOS leaves the system. Field: what arrives × EFI is DIN on AEFF, the
remainder is the efficiency loss, whose fate the model doesn't follow (TT 690
p.38).

**Effective store,** eq. 4.15 corrected (E-2):

    HEF = HES + DIN + PP − ETE − RE
    RE = QC + H̄E × RF                                       eq. 4.17
    H̄E < HT:                    ETE = (TCD / HT) H̄E          eq. 4.20
    H̄E ≥ HT, PEL > TCD:         ETE = TCD + (H̄E − HT)/(HSU − HT) (PEL − TCD)   eq. 4.21
    H̄E ≥ HT, PEL ≤ TCD:         ETE = TCD                     eq. 4.22

with H̄E = (HES + HEF) / 2, which gives eqs. 4.24–4.26 (E-4, E-6). The pieces of
Figure 4.2 join, so trying each in turn finds the one solution. **Non-effective
store:** eq. 4.16, ETNE = (PEL / HSU) H̄NE, RNE = QC + H̄NE × RF, solved by eq.
4.27. Either store spills above HSU into its seepage (eqs. 4.28–4.29). A store
that would go below zero ends at zero and takes the shortfall from ET (R7-I11).

**Return.** RET = RC + (RE × AEFF + RNE × ANEFF) / 1000 (eq. 4.56). PRFU and PRFL
only split RET for salinity (eq. 4.31).

**QC,** eq. 4.18: the unit runoff of the runoff module the block lies in (L.013
v5), its generated runoff less paved flow over its pervious area (R7-I12).

**Net and total** (TT 689 p.106, pp.166–167; R7-I13). Net (L.014 v2 = 1, the
default): the block gives up QC in its soil balance but the water stays with the
runoff module, so the return route carries RET less QC × area, and the module's
area isn't reduced. Total: the return carries RET, and the module's runoff falls
by the block's share of its area.

## 8. Type 4: canal and spill (TT 690 §6.6.6 pp.43–44)

QIG here is the supply.

    QIS1 = QIG (1 − RRTLPQ)                eq. 6.30
    QTLE = QIG × RRTLPQ × RRTLPE           eq. 6.31    L.036
    QTLS = QIG × RRTLPQ × (1 − RRTLPE)     eq. 6.32
    QTLR = QTLS × RRPTLR                   eq. 6.33    L.014 v1
    QTLD = QTLS − QTLR                     eq. 6.34
    QEND = QIS × RRPEND                    eq. 6.35    L.040
    QIS = QIG (1 − RRTLPQ) / (1 + RRPEND)  eq. 6.30a

## 9. Type 4: the tank and the return (TT 690 §6.6.7 pp.44–55)

    S2 = S1 + RAIN − E + (QIS − QUP − QLOW − QDEEP) × 1000 / AIRR     eq. 6.36
    QIOUT = (0.5 (S1 + S2) − RRHMIN) × RRLF × AIRR / 1000             eq. 6.37
    QUP = QIOUT × RRPRFU;  QLOW = QIOUT × RRPRFL;  QDEEP = QIOUT × RRPDL   eqs. 6.38–6.40
    E = (0.5 (S1 + S2) − RRHMIN) × PE × APANF / (RRHMAX − RRHMIN)     eq. 6.41
    S2 = (S1 (1 − 0.5F) + RRHMIN F + RAIN + QIS × 1000 / AIRR) / (1 + 0.5F)   eq. 6.42
    F = RRLF (RRPRFU + RRPRFL + RRPDL) + PE × APANF / (RRHMAX − RRHMIN)       eq. 6.42a

Eq. 6.42 was re-derived from 6.36–6.41 and agrees. When QIS = 0, RAIN is set to
zero so the tank declines smoothly (eq. 6.36a, p.50). S2 is held within RRHMIN …
RRHMAX (eqs. 6.43b, 6.44b), and QIOUT then uses the final S2 (p.54). QE closes the
tank at the top and counts as evaporation; at the bottom the outflows give way
(R7-I11).

QGI and QSI (eqs. 6.45–6.48) pass through and are "flow neutral". TT 691 p.172:
"Net Return flows or Total return flows should give the same answer in Type 4";
TT 689 p.106: "the default is always to Net". So type 4 is always net (R7-I13):

    QIR = QTLR + QEND + QUP + QLOW       eq. 6.49 without QGI + QSI

## 10. Water balance (the invariants)

`IrrigationSettlement` holds each term; every month, for every method:

    S + rain on the land + land transfer
      = return + conveyance loss + efficiency loss + ET + deep percolation
        + catchment runoff (net only) + Δ soil storage

Tested in `supply.test.ts` for all five set-ups × four supply patterns, to 1e-9
million m³, with no term negative. Also tested: application ≤ supply; less supply
never returns more; demand doesn't change with supply; S ≤ demand on a demand
route; the route's flow is the block's supply; the river loses what the block
takes. Through the network the block is a sink for its abstraction and a source
for its return (`network.md` §6.1).

`RunResult.irrigation[n]` gives demand, supply, application, return, ET, soil
depth, area and effective area for the screens.

## 11. TT 690 errata

| ID | Where | Printed | Used |
|---|---|---|---|
| E-1 | eq. 4.6 p.14 | `(1.0 / (1.0 TLPQ))`, minus lost | `1 / (1 − TLPQ)`, from 4.4–4.5 and 6.23 |
| E-2 | eq. 4.15 p.16 | `+ ETE` | `− ETE` |
| E-3 | eqs. 4.16, 4.29 | `HMEF`, `REN` | HNEF, RNE |
| E-4 | eq. 4.24 p.18 | numerator `+ RF / 2.0` | `− RF / 2.0`, derived; compare 4.27 |
| E-5 | eq. 5.5 p.27 | gives ER = Rain at Rlim(a) and (2 − ERF) Rain at Rlim(b) | ERF + (1 − ERF)(a − R)/(a − b), as eq. 6.18b and TT 689 p.97 |
| E-6 | eq. 4.25 p.18 | condition `H̄E < HT`; `HEP` | H̄E > HT; HEP = HES |
| E-7 | eq. 4.23 p.17 | no `=`; `HNE` | ETNE = (PEL / HSU) H̄NE, as 4.27 needs |
| E-8 | Table 5.2, pp.28–29 | "equation 3, 6, 7" | eqs. 5.3, 5.7, 5.8 |
| E-9 | p.39 | text says DIN1; QID1 "at raw water supply source" | QID1 is the field-edge demand after DF; QIG is at the source |
| E-10 | eq. 6.46 p.55 | `QGI = QS × …` | QG |
| E-11 | ch.6 cross-references | §4.1.5, §4.5.2, §4.3 | §6.6.5 and neighbours; the text came from another document |
| E-12 | p.50 | QIOUT "(=QUP+QLOW)" | only if RRPRFU + RRPRFL = 1 |
| E-13 | eq. 6.41; p.43 | `RRMIN`; RRPTLR's limit names RRTLPE | RRHMIN; RRPTLR |
| E-14 | eq. 6.17a p.35 vs eq. 4.1 | total clipped at zero vs per crop | per crop (R7-I5) |

TT 691 p.159's "the value for line type 8" means L.009; TT 691 p.159 repeats the
heading "Other default data" over the Pitman fields; TT 689 p.175 gives lower-zone
return 0.25 where every example has 0.15; TT 689 p.101's "no bearing" on RRPRFU and
RRPRFL holds for types 2–3, not type 4.

## 12. Open questions (with defaults)

- **R7-I1** Method dispatch as §1. A 12-line file with L.002 ≠ 1 runs as type 1.
- **R7-I2** Two passes, and the one reorder (§2). WRSM2000 appears to loop by month
  (TT 689 p.149, R3-N1), so a block whose return enters a module listed before its
  supplier may see that module take the full-supply return there (DP-7).
- **R7-I3** ACCALOC is charged with demand, not supply: eqs. 6.28–6.29 stand before
  "insufficient water at source". The other reading (unused means unsupplied) would
  make next month's demand depend on this month's supply and need month-by-month
  solving.
- **R7-I4** WQT RRMA ≤ 0 means no limit (`zeroAllocation: 'noWater'` for eq. 4.8 as
  printed). TT 689 p.95's "no abstractions" is said of PERM only, and the repo's v32
  example carries a type 2 block with 0.00. Highest-risk default: if WRSM2000 reads 0
  as no water those blocks abstract nothing.
- **R7-I5** Crop demand is cut off per crop (`cropDemandClip: 'total'` for p.35).
- **R7-I6** RRIE and RRLF above 1 are percentages: TT 690 eq. 4.3 has EFI in %, TT
  691 p.160's example has 96 and 6. Efficiency is capped at 1; 0 or less is an error.
- **R7-I7** Table meanings as §3. TT 691 p.172 says type 4's L.015 RRIE "does not
  appear to be used"; used only when L.028 is 0.
- **R7-I8** SAPWAT ER within 0 … rain. TT 691 p.210 item 84 records a "constraint
  condition" without saying what it is.
- **R7-I9** Means run over the rainfall file's whole record, not the run. A month
  with no mean rain counts 0 in DF.
- **R7-I10** Clipping caps each month at the allocation / 12 (TT 689 p.95: "reduced
  evenly to a monthly value"), which can leave the block under its allocation. Type
  4 follows eqs. 6.25–6.29 whatever the flag.
- **R7-I11** Store limits close the balance: a store below zero takes the shortfall
  from ET; the tank's outflows give way at RRHMIN; QE is what's left at RRHMAX; RRHI
  outside RRHMIN … RRHMAX is moved inside it.
- **R7-I12** QC is the runoff module's generated runoff less paved flow over its
  pervious area (the manuals' pervious zone comes from WQT's SW module, which
  WRSM2000 doesn't have). No module, or one not yet solved, gives QC = 0 with a
  warning. TT 691 p.211 item 113 suggests WRSM2000 treats that order as a sequence
  error.
- **R7-I13** Net as §7; total scales the runoff by area share rather than re-running
  it (DP-6); type 4 always net.
- **R7-I14** Type 4's minimum factor is L.017, not L.031 (TT 691 p.174).
- **R7-I15** RRCAP of 0 is no limit: it is the default (TT 689 p.175), and "no
  water" would stop every default block.
- **R7-I16** Everything a route carries enters the block, even above demand.
- **R7-I17** PERM limits Σ N × Pindex with the year's real rain; the return is % of
  the supply (TT 691 p.160; p.161: "of the abstracted flow"). TT 691 p.212 item 123
  corrected this method in three places without saying how.
- **R7-I18** HE and HNE start at RRHI; the first month's areas count as last
  month's, so nothing moves in month 1.
- **R7-I19** A defined or `'*'` route to a block carries its file.
- **R7-I20** TT 689 p.95's "the annual allocation limit is applied to the end of
  period area specified and adjustments are made prior to that" is not modelled:
  p.98 says a volume doesn't follow the area, and eq. 4.8 doesn't either.

## 13. Reference comparison

Not run: `WRSM_REFERENCE_DIR` was unset when this was built. Run the whole-network
comparison before trusting any default; R7-I4, R7-I2 and R7-I12 first.
