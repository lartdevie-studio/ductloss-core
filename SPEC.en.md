# ductloss-core — specification summary (English)

This is a summary of [SPEC.md](./SPEC.md). **The Japanese SPEC.md is authoritative**; section numbers below refer to it.
Version 0.3.0, saved-data format schema v4.

## §0 Scope — this is a design calculation

Residential ventilation and ducted air-conditioning systems with **round ducts**, arranged as a tree from a fan
(heat-recovery unit, extract fan or ducted air-conditioner) to terminals. Steady, incompressible flow; one air density ρ per
calculation. Units: Q m³/h, D mm (m inside formulas), L m, P Pa, ρ kg/m³, v m/s. Diameters φ75/100/125/150/200/250.
Not covered: rectangular ducts, loops, stack effect, duct heat loss, noise.

| Item | What the engine does | What it does not do |
|---|---|---|
| Member flows | Uses **design flows** aggregated from terminal targets (§5) | Solve the actual flow split from branch resistances and node pressures |
| Intake side | Splits the fan flow by the **ratio of intake-terminal targets** (a design allocation) | Allocate by resistance |
| Operating point | **Estimates** it as the intersection of the fan curve with ΔP = k·Q² through the design point (§7), assuming the flow split and resistances stay as designed | Predict pre-balancing or as-built operation |
| Several fans | Evaluates the heat-recovery unit and the air-conditioner **per owned section** (§6) | Couple their pressures and flows (their operating points are not mutually consistent) |
| Damper balancing | Returns the **additional ζ** each terminal needs to pass its design flow (§10) | Give a damper position or confirm that balancing is done |
| Actual airflow | — | Handle measurements. Measure and adjust after installation |

## §1 Data

A payload holds ρ, one or more systems and optional inputs. A system is a tree of nodes (`fan`, `duct`, `filter`, `branch`,
`reducer`, `aircon`, `terminal`). Each node stores its parent, children, flow side (`downstream` = supply/discharge side,
`upstream` = intake side of the fan) and parameters.

## §2 Design coefficients (supplied by the user)

λ, the 90° bend equivalent length per diameter, default ζ values and default Pa are **not bundled**; pass them to
`createDuctLoss(coefficients)` with a name and a source. Invalid sets throw. Coefficients are used in four ways:
(1) copied into new parts when they are created (default ζ, Pa, a new fan's λ) — saved parts keep them;
(2) read at every calculation (bend table; the coefficient λ when neither the duct nor an upstream fan has a usable λ);
(3) written by an action (`resetTerminals`); roughness materials and bend shapes are read at every calculation like the bend table;
(4) printed in the report (name, source, value fingerprint).
Traceability: `ENGINE_VERSION`, `coefficientFingerprint` (values only, `cf1-` + 16 hex), `CalcResult.meta`, per-duct
`NodeResult.duct` (λ used and its origin, bend length) and `DuctLossPayload.coefficientsStamp` (the set used when the data
was created). The report flags a recalculation with a different set. A fingerprint or a source string does not prove that the
coefficients are well founded. Coefficient values are printed unrounded (6 significant digits).

## §3 Loss of one member

v = (Q/3600)/(π·D²/4), q = ρ·v²/2. Duct: ΔP = (λ/D)·q·(L + L_bend), with L_bend = Σ L90(D)·(angle/90)·count, where L90 is
the table value of the nearest diameter (the smaller one on ties). Filter, branch, reducer, air-conditioner body and terminal:
ΔP = ζ·q. Parts entered in Pa store ζ = Pa / q at the design flow; the calculation always uses ζ.
Optional models (0.2): with `friction: { model: 'roughness' }`, ducts without an explicit λ (duct or fan) get λ from the
material roughness and Re via Colebrook (64/Re below Re 2300; ν from Sutherland's law at `tempC`, default 20 °C). With
`bend: { model: 'zeta' }`, bends are a local loss ζ90 × angle factor × count × q independent of λ (catalogue ζ per bend
overrides), and the duct length is the centreline length including bends. Since 0.3.0 a bend shape may give ζ90 per diameter
(`zeta90ByDiameter`, nearest diameter, ties go to the smaller one) instead of one `zeta90`, and may set
`angleProportional: true` to use θ/90 instead of the set's angle-factor table. Without these fields nothing changes.

## §4 Diameters and the reducer reference section

Branches, terminals and reducers read their diameters from the connected ducts unless `diameterAuto` is false.
Tree direction (root/leaf side) is not airflow direction: on the intake side air flows from the leaf to the root.
A reducer's ζ is applied to the dynamic pressure of the section chosen by `zetaBasis`: `small`, `large`, `flowInlet`,
`flowOutlet` or `treeLeaf`. New reducers default to `small`; saved reducers without the field are computed as `treeLeaf`
(the pre-0.2 rule) and flagged when the leaf side is the larger one. Converting ζ between sections: ζ' = ζ·(D'/D)⁴.

## §5 Flow aggregation

Supply side: terminal targets summed from leaves to root. A registered air-conditioner (second fan) circulates the sum of its
supply-side terminals; with a return flow entered, extra intake = min(circulation, return) and supply from the heat-recovery
unit = circulation − extra intake; only the supply share flows upstream of the air-conditioner. Intake side: the fan flow is
split by the ratio of intake-terminal targets (equal split if all are zero). An optional flow scale multiplies targets for studies.

## §6 Routes and required static pressure

One route per leaf; its total is the sum of member losses on the path (the root fan is not counted on intake routes). Routes
are assigned to the nearest registered air-conditioner, else the root fan. Main fan: upstream = max owned intake route;
downstream = max(owned supply routes, path to each air-conditioner inlet excluding its body). Air-conditioner: supply side
from its body to the terminals, intake side from its next member to the grilles. Required = upstream + downstream, always.

## §7 Fan verdict

System resistance ΔP = k·Q² with k = required / design flow². Operating points are found exactly on each segment of the
piecewise-linear fan curve (all intersections; the first one is reported). Every verdict carries a premise (an estimate under
design flow split and resistances). Outside the curve's range the end values are not treated as the fan's capability: below
the left end → ok with a stated premise if the left-end pressure ≥ required, otherwise no verdict; above the right end → ng if
the right end already falls below k·Q², otherwise no verdict. Several intersections with the first below the design flow →
no verdict. Single rated point: near the rated flow compare directly; below it → ok with a premise if rated ≥ required,
otherwise no verdict; above it → ng if rated < required, otherwise no verdict. Catalogue external static pressure already
excludes internal losses: do not draw built-in filters, and set the air-conditioner body ζ to 0 when comparing with it.
Fan characteristics are taken to be at standard air (1.20 kg/m³, JIS B 8330); when the calculation's ρ differs, the available
pressure is scaled by ρ/1.20 (fan laws at constant speed), reported as `densityRatio`.

## §8 Ventilation check

Required = volume × air changes per hour (default 0.5). Compared with the supply design flow, or with the exhaust design
flow when there is no supply system (exhaust-only ventilation); systems rooted at an air-conditioner are excluded and no
flow scale is applied. It passes only when the compared flow is **at least** the required flow (Japanese Building Standard
Law Enforcement Order Art. 20-8); versions before 0.2 allowed a 2 % shortfall.

## §9 Diagnostics

Structure errors, incomplete drawings, flow imbalances, fan shortfalls, premises and holds, Pa/ζ mismatches,
double-counted air-conditioner body losses, legacy reducer references, non-finite losses (keys listed in SPEC.md §9).

## §10 Damper balancing

Per fan, supply routes below the reference (main fan: its downstream value; air-conditioner: its supply side) are raised to
reference − 0.01 Pa by increasing the terminal ζ. The pre-balance ζ and Pa are kept in `beforeBalance`; `undoBalanceTerminals`
restores them; `resetTerminals` sets non-catalogue terminals to the default ζ and restores catalogue terminals to their
pre-balance values. Intake terminals are not balanced.

## §12 Compatibility

schema v4; older v2/v3 data are upgraded. All 0.2 fields (`zetaBasis`, `beforeBalance`, `coefficientsStamp`) are optional
and absent fields keep the previous behaviour.

## Validation

See [VALIDATION.md](./VALIDATION.md) (Japanese): independent hand calculations in Python for two examples (112 items match),
SPEC Appendix A, boundary tests (195 items across four examples, including Colebrook, ζ bends and per-diameter bend ζ). Not yet compared with other software or with measurements.
