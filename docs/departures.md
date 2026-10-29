# Departures from WRSM2000

Every known difference between this rebuild's output and WRSM2000 v2.11's, with its cause. A difference that isn't listed here is a bug (CLAUDE.md, project rule 3). Each row names the module type, the outputs affected, the size of the difference on the reference comparison, the cause and the decision ID (`docs/decisions.md`).

| ID | Module | Affects | Size | Cause | Decision |
|---|---|---|---|---|---|
| DP-1 | RU, SFR child with CSIR alien vegetation | the child's target MAR reduction TPRM, and so its calibrated outflow | TPRM against WRSM2000's logged targets, 25 children: mean 0.71 %, max 3.53 % (4 of 25 exact to 4 dp) | TT 690 eq. 12.5's tall-shrub constant is printed as 3.1868; WRSM2000's logs fit 3.4165 better (mean 0.17 %, max 0.69 %). Pitman follows the manual; `TALL_SHRUB_C_REFERENCE_FIT` switches | R6-V6 |
| DP-2 | RU, SFR child with CSIR alien vegetation | the child's target low-flow reduction TPRL | 4.0 percentage points mean against the logs (25 children) | WRSM2000 derives TPRL from a flow series in a way the manuals don't describe; Pitman takes the curve value, raised to TPRM when below it | R6-V7 |
| DP-3 | RU, SFR child with CSIR afforestation | the child's targets and calibrated outflow | not measurable on the reference (no reference child uses CSIR afforestation) | the CSIR curves (Scott & Smith 1997, TT 691 p.61) aren't printed in the manuals; Pitman calibrates the child to Smoothed Gush targets (TT 690 eq. 11.1), with a warning | R6-F2, R6-F18 |
| DP-4 | RU, free module with CSIR, Van der Zel or LUT Gush afforestation | the module's runoff (no reduction) | not measurable on the reference (no reference module uses them) | those algorithms' curves aren't printed in the manuals; Pitman applies no reduction, with a warning | R6-F3, R6-F4 |

Round 6 has not yet compared whole networks (Sami integration); rows are added as the comparison finds and explains differences.
