# Channel reach module

Spec for the WRSM2000 **channel reach** (CR) module: bed losses, the outflow
routes and how a shortfall is shared, the basic wetland (type 1), the
comprehensive wetland (type 2) and the diversion channel (type 3). Written so
`packages/wrsm/src/channel/` (Round 3, agent 3.3) can be coded and reviewed
without opening the PDFs. File layout: `docs/formats.md` §7.

## Sources and how to cite them

| Short name | Report | Used for |
|---|---|---|
| TT 689 | WRC TT 689/16, *User Manual*: channel module summary (p.xvi), time series a wetland can save (§2.5 p.14), the `.ANS`/`.SHO` note on channel abstractions (§4.8 p.17), primary outflow route (§6.1 p.52), irrigation abstraction from a channel (§6.1.20.3 p.80), special features (§6.2.3 pp.143–149), "don't define the principal route" (§7.2 p.168), deficit handling (ch.8 pp.169–170) | order of operations, routes, allocation, diversions |
| TT 690 | WRC TT 690/16, *Theory Manual*, ch.9 "Simple wetland algorithm" (pp.112–113) and ch.10 "Comprehensive wetland sub-model" (pp.114–118) | every wetland equation |
| TT 691 | WRC TT 691/16, *Programmer's Code Manual*, §7.7 Channel_Type (pp.84–92) and §12.2 CR file (pp.154–156) | variable names, CRFAIL codes, which routine adjusts which route |

Citations use **book** page numbers. PDF page = book page + 13 for TT 690.
TT 690's equations are images; every equation here was read from page
renders at 120 dpi (PDF pp.125–130).

## What the module does, in one paragraph

A channel reach collects its inflow routes and redistributes the water over
its outflow routes (TT 689 p.xvi). Each month it sums the inflows, takes off
a fixed monthly bed loss CHBL (lost to the system), supplies the defined
outflows, then the calculated demands (irrigation abstractions), sharing a
shortfall in proportion to demand; then one optional special feature acts on
what is left — a basic wetland, a comprehensive wetland or a diversion
channel — and the remainder leaves by the principal outflow route.

---

## 1. Symbols, file fields and TT 691 names

CR `.DAT` line types are TT 691 §12.2 (pp.154–156). `types.ts` field in
`ChannelModule`.

| Symbol | Meaning | Units | CR line | `types.ts` | TT 691 §7.7 |
|---|---|---|---|---|---|
| MAPw | MAP over the wetland | mm/yr | L.002 v1 | `wetlandMapMm` | `CRMAP` |
| — | wetland rainfall file (% MAP) | — | L.002 v2 | `wetlandRainfallFile` | `NPC` |
| CHBL | bed loss | million m³/month | L.003 v1 | `bedLossMm3PerMonth` | `CHBL` |
| CHC1 | basic wetland/aquifer storage when full | million m³ | L.003 v2 | `wetlandStorageMm3` | `CHC1` |
| CHC2 | basic wetland/aquifer area when full | km² | L.003 v3 | `wetlandAreaKm2` | `CHC2` |
| CHC3 | recharge coefficient (1, ~0.1 for a transmissivity-limited aquifer) | – | L.003 v4 | `rechargeCoefficient` | `CHC3` |
| PAN(m), PF(m) | pan evaporation and pan factor, Oct…Sep | mm, – | L.004, L.005 | `panMm`, `panFactors` | `WPAN`, `WPF` |
| — | principal outflow route | – | L.006 | `principalOutflowRoute` | `JOUTC` |
| — | wetland model | 0–3 | L.011 v2 | `wetlandType` | `WLMODEL` |
| Anom | wetland area at bankfull | km² | L.012 v1 | `comprehensiveWetland.bankfullAreaKm2` | `AWB` |
| Snom | wetland volume at bankfull | million m³ | L.012 v2 | `.bankfullVolumeMm3` | `VWB` |
| b | power of A = a·S^b | – | L.012 v3 | `.areaVolumePower` | `PAV` |
| Qbf | channel bankfull capacity | million m³/month | L.012 v4 | `.channelBankfullCapacity` | `QBNK` |
| Kin | share of flow above Qbf into the wetland | 0–1 | L.012 v5 | `.excessToWetland` | `PRQIN` |
| Kout | share of storage above Snom back to the channel per month | 0–1 | L.012 v6 | `.wetlandToChannel` | `PRVOUT` |
| Qdiv | channel→wetland link capacity ("reserved, always 0.0") | million m³/month | L.013 | `qdiv` | `QDIV` |
| — | local wetland inflow route | – | L.014 | `localWetlandInflowRoute` | `WRTIN` |
| — | local wetland outflow/abstraction route | – | L.015 | `localWetlandOutflowRoute` | `WRTON` |
| — | diversion route | – | L.016 | `diversionRoute` | `DRTON` |
| drqbnk | flow above which diversion can happen | million m³/month | L.017 v1 | `diversion.bankfullCapacity` | `DRQBNK` |
| drprqin | diversion efficiency | 0–1 | L.017 v2 | `diversion.efficiency` | `DRPRQIN` |
| qdivcap | maximum monthly diversion | million m³/month | L.017 v3 | `diversion.maxMonthlyMm3` | `DRQDIV` |
| WETS, S1/S2 | wetland storage (start/end of month) | million m³ | — | output `storage` | `WETS` |

Only one special feature is simulated at a time; bed loss applies whatever
the feature (TT 689 p.143).

---

## 2. Calculation procedure (one month)

### 2.1 Inflows

Sum every inflow route (L.008). A route with a defined-flow file takes the
file's flow for the month, through `definedFlowSeries` (R3-2); otherwise the
flow the upstream module produced. With a comprehensive wetland, the local
wetland inflow route (L.014) goes to the wetland (Qloc), not the channel
(TT 689 p.146). Call the channel's share Qriver.

### 2.2 Bed loss (TT 689 §6.2.3.1 p.144)

> "If enough flow enters the Channel Module via the inflow route(s) in a given
> month, the bedlosses will be subtracted from the inflows ... If the flow is
> less than the bedloss, the resultant outflow will be zero. ... The bedlosses
> ... are lost to the system."

`bedLoss = min(CHBL, Qriver)`, `Q = Qriver − bedLoss`. (OQ-CR2.)

### 2.3 Outflow routes and their roles

Each outflow route (L.010) is one of:

| Role | When | Supplied |
|---|---|---|
| principal | the L.006 route | the remainder (§2.5). It need not be listed in L.010 (TT 691 p.155) |
| defined | has a defined-flow file | §2.4 step 1 |
| calculated | has a calculated demand (an irrigation module's abstraction route, TT 689 p.80) | §2.4 step 2 |
| diversion | the L.016 route, **type 3 only** | §2.6.3 |
| wetland outflow | the L.015 route, **type 2 only** | from the wetland, §2.6.2 |
| idle | none of the above | zero ("no flows would be sent down the route", TT 689 p.149) |

When the feature is not active the L.015 and L.016 routes are ordinary routes
(TT 689 pp.148–149; OQ-CR15).

### 2.4 Defined outflows, then calculated demands (TT 689 p.144 and ch.8 pp.169–170)

> "If the Channel Module has defined outflow routes, then these demands from
> these routes are satisfied after the bedlosses are served. It is only after
> these demands are satisfied that the calculated demands (such as those
> calculated from Irrigation Modules) are serviced." (p.144)

1. **Defined.** If ΣD ≤ Q, each gets its demand and Q −= ΣD. Otherwise
   TT 689 ch.8 p.169: "The flows in DEFINED routes are NEVER adjusted
   downwards ... Even if a reservoir or channel reach is bone dry, but a
   defined flow is given for an outflow route, that route will carry the
   full defined flow." The missing water is *created* (TT 689 p.17 says
   the same of `.ANS`/`.SHO` for a channel). Default: supply in full, record
   `created = ΣD − Q`, Q = 0 (OQ-CR3).
2. **Calculated.** Shared in proportion to demand when short: "if route 1
   demands 2.5 million m³ and route 2 demands 3 ... but only 3.5 million m³
   is available, route 1 will receive (2.5 × 3.5 / 5.5 =) 1.59 ... and
   route 2 ... 1.91" (p.170). If step 1 used everything, they get 0 (p.169).

Each route-month that falls short is a failure: **minor** below 0.009
million m³ and **major** above (TT 691 p.86, CRFAIL), listed for at most the
first 255 of each type (p.87) (OQ-CR14).

### 2.5 Special feature, then the principal route

The feature acts on Q after the abstractions (OQ-CR1), then whatever is left
is the principal outflow.

A **defined principal route** is "possible, [but] should be avoided. If
more water is available ... the channel reach will 'lose' the water, and if
less water is available, an error message is generated and water will be
'created' to match the defined flow" (TT 689 §7.2 p.168). We do exactly
that, with a warning (OQ-CR16).

### 2.6 Special features

#### 2.6.1 Basic wetland (type 1): §3.
`Qr = Q`; the wetland changes it to `Qr − Qloss`.

#### 2.6.2 Comprehensive wetland (type 2): §4.
`Qus = Q`, `Qloc` = local inflow (§2.1), `Qabs` = demand on the L.015 route
(defined file or calculated demand). Principal gets `Qds`; L.015 gets the
Qabs supplied. TT 691 p.92: CR_CalcWetlands2 "adjusts the outflow in the
main outflow route and in the local outflow / abstraction route".

#### 2.6.3 Diversion channel (type 3), TT 689 §6.2.3.4 pp.147–149

> "Available flow as used below is the flow over bankfull level multiplied by
> the diversion efficiency. The maximum flow that is diverted in a given
> month is therefore the minimum of the available flow and the diversion
> capacity. `qinw = AMIN1(qdivcap, drprqin * (qtot – drqbnk))` where 'qtot'
> is the total flow in the Channel Module AFTER discounting all bedlosses and
> defined and calculated abstractions" (p.148).

`div = 0` if `qtot ≤ drqbnk`, else `min(qdivcap, drprqin·(qtot − drqbnk), demand)`,
where `demand` is the route's defined flow or calculated demand when it has
one ("the minimum between what is available, what is demanded and the
maximum capacity", p.148; a diversion route's defined flow is **not**
inviolate) and unlimited otherwise (OQ-CR17). `Q −= div`.

---

## 3. Basic wetland (TT 690 ch.9, pp.112–113)

"This algorithm permits the modelling of a wetland or aquifer with a minimum
of parameters" (p.112): CHC1, CHC2, CHC3. Enet is the month's net
evaporation in **mm** (§5).

### 3.1 Equations as printed

| Eq. | Printed |
|---|---|
| 9.1 | R = CHC3 × ( CHC1 − WETS + √Qr ) |
| 9.2 | Qloss = MIN ( R , Qr ), "i.e. recharge cannot be greater than riverflow" |
| 9.3 | ETC = 0.001 × Enet × CHC2 / ( 2 × CHC1 ) |
| 9.4 | SAE = ( Qloss + WETS × ( 1 − ETC ) ) / ( 1 + ETC ) |
| 9.5 | SAVT = ( WETS + SAE ) / 2 |
| 9.6 | IF (SAE > CHC1) "capacity is exceeded throughout month": SAVA = CHC1 |
| 9.7 | IF (SAE < CHC1) "capacity is exceeded at start of month": SAVA = SAVT − 0.5 × (WETS − CHC1)² / (WETS − SAE) |
| 9.8 | IF (SAE > CHC1 and WETS < CHC1) "at end of month only": SAVA = SAVT − 0.5 × (SAE − CHC1)² / (SAE − WETS) |
| — | otherwise SAVA = SAVT |
| 9.9 | ETA = CHC2 × Enet × 0.001 × SAVA / CHC1 |
| 9.10 | WETS = WETS + QLOSS − ETA |
| 9.11–9.12 | IF (WETS < 0): ETA = ETA + WETS and WETS = 0 |
| 9.13 | Qr = Qr − Qloss |

### 3.2 Reading

- Area grows linearly with storage, A = CHC2 × S / CHC1, so ETA is net
  evaporation over the average area: mm × km² × 0.001 = million m³.
  Eq. 9.4 is the implicit (trapezoidal) form of
  `SAE = WETS + Qloss − ETC·(WETS + SAE)`.
- Eqs. 9.6 and 9.7 are both under the heading "Check for exceedance of
  capacity (i.e. IF WETS > CHC1)". So 9.6 is `WETS > CHC1 and SAE > CHC1`,
  9.7 is `WETS > CHC1 and SAE ≤ CHC1`, 9.8 is `WETS ≤ CHC1 and SAE > CHC1`.
  9.7 and 9.8 are the time-average of `min(S, CHC1)` along a straight line
  from WETS to SAE, so evaporation never acts on more than CHC2.
- Storage may exceed CHC1 ("it is possible for the nominal wetland/aquifer
  capacity to be exceeded during the passage of a flood", TT 691 p.156).
- R < 0 when WETS > CHC1 + √Qr; then Qloss = R < 0 and the wetland drains
  back to the river (OQ-CR6).

### 3.3 Worked examples (synthetic; `wetland.test.ts`)

CHC1 = 10, CHC2 = 5, Enet = 90 mm (pan 150 × 0.8 − 5 % × 600 mm).

**Example 1** (fills past CHC1): CHC3 = 1, WETS = 8, Qr = 4.
R = 1 × (10 − 8 + 2) = 4; Qloss = min(4, 4) = 4.
ETC = 0.001 × 90 × 5 / 20 = 0.0225.
SAE = (4 + 8 × 0.9775) / 1.0225 = 11.82 / 1.0225 = 11.559902.
WETS < CHC1 < SAE → 9.8: SAVT = 9.779951; SAVA = 9.779951 − 0.5 × 1.559902² / 3.559902 = **9.438187**.
ETA = 5 × 90 × 0.001 × 9.438187 / 10 = **0.424718**.
WETS = 8 + 4 − 0.424718 = **11.575282**; Qr out = **0**.
Rain on the wetland = 0.030 m × 5 × 0.9438187 km² = 0.141573; gross evaporation 0.566291.

**Example 2** (drains back): CHC3 = 0.5, WETS = 12, Qr = 1.
R = 0.5 × (10 − 12 + 1) = −0.5 = Qloss. SAE = (−0.5 + 12 × 0.9775)/1.0225 = 10.982885 > CHC1 with WETS > CHC1 → SAVA = 10.
ETA = 0.45; WETS = 12 − 0.5 − 0.45 = **11.05**; Qr out = 1 + 0.5 = **1.5**.

**Example 3** (eq. 9.11): CHC1 = 1, CHC2 = 50, WETS = 1, Qr = 0, Enet = 100.
ETC = 2.5, SAE = −0.428571, SAVA = SAVT = 0.285714, ETA = 1.428571, WETS = −0.428571 → **ETA = 1, WETS = 0**.

The printed-vs-prose form of 9.1 (OQ-CR5): CHC3 = 0.5, WETS = 8, Qr = 4 gives
R = 2 printed, 3 prose.

---

## 4. Comprehensive wetland (TT 690 ch.10, pp.114–117)

Off- or in-channel storage that the river feeds only above bankfull, which
drains back in proportion to the storage above nominal; it "can also be
employed to simulate the effect of a man-made off-channel storage dam"
(p.114). Units million m³ and million m³/month; **Enet in metres** (p.115).

### 4.1 Equations as printed

| Eq. | Printed |
|---|---|
| 10.1 | S2 = S1 + Qloc + Qin − Qout − Qevap − Qabs |
| 10.2 | Qin = MIN [ Qdiv , Kin × ( Qus − Qbf ) ] [or 0 if Qus < Qbf] |
| 10.3 | Qout = Kout × ( Save − Snom ) [or 0 if Save < Snom] |
| 10.4 | Qevap = Enet × Aave |
| 10.5 | a = Anom / Snom^b; = Anom / Snom^0.5 "if no estimate of b available" |
| 10.6 | Qnet = Enet × a × Save^0.5 = Enet × Anom × (Save/Snom)^0.5 |
| 10.7 | Qds = Qus − Qin + Qout |

§10.7.1: "it is necessary to perform some kind of iteration ... by making
successive approximations to the average wetland storage (Save) until the
difference between successive estimates is less than a predetermined value."

### 4.2 Reading

- The superscripts are lost in the printed 10.5 ("Snomb", "Snom0.5") and
  10.6 ("Save 0.5"); 10.6 is 10.4 with b = 0.5. We use A = a·Save^b with the
  file's b (L.012 v3), as §10.6's text says.
- Save = (S1 + S2)/2. Solve: guess Save = S1; compute Qout (10.3), Qevap
  (10.4), S2 (10.1); new Save = (S1 + S2)/2 (floored at 0); repeat until the
  change is below the tolerance (OQ-CR10).
- Qdiv: TT 691 calls L.013 "reserved ... should always be 0.0"; TT 690
  p.116 says "for a natural wetland Qdiv is not used, hence an arbitrary large
  value is assigned", and SWAMP2's line 2 "maximum diversion capacity (set
  to 0.0 if not applicable)" (p.118). So Qdiv ≤ 0 means unlimited (OQ-CR9).
- In-channel wetland: Qbf = 0, Kin = 1 sends everything in (p.116).

### 4.3 Worked example (synthetic; `wetland.test.ts`, and through the run in `channel.test.ts`)

Anom = 4, Snom = 8, b = 0.5 → a = 4/√8 = 1.414214. Qbf = 10, Kin = 0.5,
Kout = 0.25, Qdiv unlimited. S1 = 8, Qus = 30, Qloc = 1, Qabs = 0.5,
Enet = 0.09 m.

Qin = 0.5 × (30 − 10) = **10**. Converged Save = **12.466931**:
Qout = 0.25 × 4.466931 = **1.116733**; Aave = 1.414214 × √12.466931 =
**4.993382** km²; Qevap = 0.09 × 4.993382 = **0.449404**;
S2 = 8 + 1 + 10 − 1.116733 − 0.449404 − 0.5 = **16.933863**
(check: (8 + 16.933863)/2 = 12.466931). Qds = 30 − 10 + 1.116733 = **21.116733**.

Empty-wetland case: S1 = 0.2, Qus = 2 (< Qbf), Qabs = 1 → S2 would be −0.8:
Qabs is cut to **0.2**, S2 = 0, Qds = 2 (OQ-CR11).

---

## 5. Rain on and evaporation from the wetland

TT 689 p.xvi: a wetland needs "twelve monthly pan values and associated pan
factors. A rainfile and MAP must also be specified so that the net
evaporative loss can be computed". TT 690 p.116: "The net evaporation loss
Enet is determined in the usual manner by subtracting rainfall from the gross
evaporation, which is derived by applying a coefficient to the monthly pan
evaporation."

- Gross evaporation (mm) = PAN(m) × PF(m).
- Rain (mm) = %MAP(y, m) / 100 × MAPw (the `.RAN` convention, TT 690 §1.3).
- Enet = gross − rain, mm (basic) or /1000 m (comprehensive). It may be
  negative ("In times of heavy rain the net evaporation rate can be negative",
  p.116).
- For the breakdown, rain and gross volumes are depth × the same average
  area the equations use; their difference is the net term (after any cut).

Rainfall is read only when the feature is a wetland (types 0 and 3 carry
dummy values, TT 691 p.156 note 1).

---

## 6. Outputs

`ModuleRunResult`: every outflow route keyed by route number (principal,
defined, calculated, diversion, wetland outflow, idle), `storage` = wetland
storage at month end for types 1–2, and messages (failures with `module` and
`at`; one summary per failure type).

`runChannel` also returns a `breakdown` (million m³/month): inflow, bed loss,
defined and calculated outflow, flow upstream of the feature, wetland inflow
and return, local inflow and abstraction, rain, gross and net evaporation,
diversion, principal, created, lost, storage, initial storage. These cover
TT 689 p.14's saveable wetland series (flow upstream, inflow, storage,
return flow). The water balance every month:

`inflow + created = Σ outflow routes + bedLoss + lost + netEvaporation + ΔS`.

---

## 7. Run modes (D1) and contract notes

| Item | Natural | Present day / historical |
|---|---|---|
| Bed loss | kept (natural) | kept |
| Basic and comprehensive wetland | kept (natural) (OQ-CR18) | kept |
| Defined outflows, calculated demands, wetland abstraction | zero (abstractions are development) | per R3-2 / as passed |
| Diversion channel | removed; all to the principal route (OQ-CR12) | simulated |
| Defined inflow | zero (R3-2), or kept with `definedInflowInNatural: 'keep'` (OQ-CR13) | per R3-2 |

Contract needs (not in `contract.ts` yet):

- **C-1** calculated demands. 146 of the reference networks' CR outflow
  routes are irrigation abstraction routes; the channel needs each month's
  demand before it can share water. `simulateChannel` takes an optional
  fourth argument `demands: RouteFlows` (assignable to `ChannelSimulator`).
  The runner must compute the irrigation demands first and feed the supplied
  flow back to the irrigation module (TT 689 p.149: "the Irrigation Module is
  told to adjust the supply to what is supplied in the route").
- **C-2** diversion to a reservoir uses the reservoir's spare capacity at the
  end of the previous month as the demand (TT 689 p.149); under R3-1 the
  reservoir is solved after the channel, so the runner would have to
  interleave them. Until then such a diversion is unlimited unless the runner
  passes a demand (OQ-CR17).

Invalid data throws `ChannelRunError` naming the module: no principal route;
a route that is both inflow and principal; a repeated outflow route;
negative CHBL; type 1 with CHC1 ≤ 0, CHC2 < 0 or CHC3 outside 0–1; type 2
without L.012, Snom ≤ 0, b ≤ 0, Kin/Kout outside 0–1, local routes not in
the route lists or the local outflow = principal; type 3 without a diversion
route, a diversion route that is principal or not an outflow, efficiency
outside 0–1; a wetland without its rainfall file or a year of it; a missing
defined-flow file; a series of the wrong length or with negative flows.

---

## 8. Open questions

Each has the evidence, the readings and a **proposed default**.

**OQ-CR1 Where the special feature sits.** Evidence: diversion uses qtot
"AFTER discounting all bedlosses and defined and calculated abstractions"
(TT 689 p.148); "Special Features ... are calculated after the bedlosses"
(p.144); CR_CalcWetlands1 "adjusts the outflow in the main outflow route
only" (TT 691 p.92). Readings: (a) after all abstractions; (b) wetlands
before abstractions. **Default (a)** for all three features.

**OQ-CR2 Bed loss on which flow.** Readings: (a) the channel inflows only
(the comprehensive wetland's local inflow bypasses the channel); (b) all
inflows. **Default (a).** Identical when there's no local inflow route.

**OQ-CR3 A defined outflow the reach can't supply.** TT 689 p.169 says
defined routes carry the full flow even when the reach is dry, and p.17 that
`.ANS` then shows full supply. **Default: supply in full and record the
created water** (`definedShortfall: 'supplyInFull'`); alternative
`limitToAvailable` shares Q in proportion. Only 1 reference CR outflow route
is defined, so this rarely matters.

**OQ-CR4 Where calculated demands come from.** The contract has no slot.
**Default:** optional fourth argument `demands` (contract change C-1).

**OQ-CR5 Eq. 9.1's √Qr.** Printed inside the CHC3 bracket (TT 690 p.112);
TT 691 p.156 says recharge is "the product of CHC3 and the available
storage ... plus a quantity related to the flow in the channel", i.e.
outside. The term is dimensionally odd either way. **Default: printed**
(`basicRechargeForm`); identical when CHC3 = 1, the usual value.

**OQ-CR6 Negative recharge and CHC3's range.** Eq. 9.2 has no floor, so
Qloss < 0 releases water to the river. **Default: allow it** (the old model
"works very much like a reservoir where downstream flow takes place only
when the ... capacity ... is exceeded", TT 690 p.114) and require
0 ≤ CHC3 ≤ 1, which keeps WETS + Qloss ≥ 0.

**OQ-CR7 ETC ≤ −1.** Eq. 9.4 divides by 1 + ETC; very wet months on a
wetland with a large area and small storage break it. **Default: throw**
naming the module and month. Never seen (no reference reach has a wetland).

**OQ-CR8 Initial wetland storage.** No manual value. **Default: nominal**
(CHC1, Snom): the level a type-2 wetland drains back to. `half`, `empty` or
a number are options (`initialWetlandStorage`).

**OQ-CR9 Qdiv = 0.** **Default: unlimited** (§4.2).

**OQ-CR10 Iteration.** "A predetermined value" is not given. **Default:**
tolerance 1e-9 million m³, 200 successive approximations, then bisection on
Save − (S1 + S2(Save))/2 (`wetlandSolver`). Bisection finds the same fixed
point when the approximations oscillate (b well below 1 with high Enet).

**OQ-CR11 S2 < 0 in the comprehensive wetland.** Not covered. **Default:**
cut evaporation, then the return flow, then the abstraction; a defined
abstraction's shortfall is created as in OQ-CR3.

**OQ-CR12 Natural mode.** D1 removes "irrigation, dams, abstractions".
**Default:** bed losses and wetlands are natural and stay; defined outflows,
calculated demands, wetland abstraction and diversions are development and
go. A distributary modelled as a type-3 diversion would wrongly disappear;
no reference reach uses one.

**OQ-CR13 Defined inflow in natural mode.** R3-2 makes it zero. A defined
inflow may be an observed upstream flow rather than a transfer.
**Default: zero** (`definedInflowInNatural: 'keep'` reads it as historical).
19 reference inflow routes have files.

**OQ-CR14 Failure counting.** CRFAIL flags "at least one" minor (< 0.009
per month) or major (> 0.009) failure per module. **Default:** one message per
route-month short by more than 1e-12, major when > 0.009, first 255 of each
type (defined, calculated), then one summary per type.

**OQ-CR15 L.014–L.016 routes when their feature is off.** TT 689
pp.148–149 says so for the diversion route. **Default:** all of them act as
ordinary routes.

**OQ-CR16 Defined principal route.** TT 689 p.52 says the primary route
"cannot be a defined route"; p.168 says it can and describes the result.
**Default:** simulate p.168 with a warning. None in the reference set.

**OQ-CR17 Diversion demand.** **Default:** the route's defined flow or
calculated demand; else unlimited. qdivcap = 0 diverts nothing (literal).

**OQ-CR18 Off-channel dam as a comprehensive wetland in natural mode.** Not
distinguishable from a natural wetland. **Default: kept.**

**OQ-CR19 Inflow route with neither an upstream flow nor a file.**
**Default:** zero with an info message (the runner should not let it happen,
TT 689 §6.1.16 sequence error).

---

## 9. What real networks use

The local reference set (`WRSM_REFERENCE_DIR`, public WR2012 archive), counts
only: 253 CR files (238 listed by a `.NET`), **all wetland type 0**; **no
non-zero bed loss**; no L.016 diversion route; L.017 non-zero in 4 files (type
0, inactive). CR routes: 843 inflow routes, 19 with defined-flow files;
397 outflow routes, 1 defined (not a principal route). Across 35 `.NET`
files, CR outflow routes go to RR (146, irrigation abstraction), CR (186),
RV (15) and the zero sink (38). So the load-bearing paths are summing
inflows, irrigation demands with proportional shortfall sharing and the
principal route; the wetland and diversion code is from the manuals alone and
unverified (as `docs/formats.md` U-15 says of the file lines).

`channel.reference.test.ts` runs every listed reference reach in all three
modes with synthetic inflows and demands and checks the water balance.

## 10. Not covered

- Routing time: a channel reach has no lag (routes and channels are
  "without any time delay", TT 691 p.30).
- Groundwater-fed wetlands ("This wetlands model links only to surface water
  flow", TT 690 p.114).
- Diversion to a reservoir by spare capacity (C-2).
- Return flows recalculated by irrigation modules after a shortfall: the
  network runner's and the irrigation module's job.
