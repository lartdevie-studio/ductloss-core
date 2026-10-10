/**
 * レジューサの ζ の基準断面（SPEC.md §4・改良計画 2-2）。
 *
 * 期待値は本体の関数を使わず、手計算で書く（ρ = 1.2、風量 100 m³/h、ζ = 0.2）:
 *   φ100: A = π·0.10²/4 = 0.0078540 m²、v = 100/3600/A = 3.5368 m/s、q = 0.6·v² = 7.5053 Pa、ζq = 1.5011 Pa
 *   φ150: A = π·0.15²/4 = 0.0176715 m²、v = 100/3600/A = 1.5719 m/s、q = 0.6·v² = 1.4825 Pa、ζq = 0.2965 Pa
 *   動圧の比 (150/100)⁴ = 5.0625
 */
import { describe, it, expect } from 'vitest'
import {
  createDuctLoss, diagnose, reducerDiameters, reducerZetaForBasis, REDUCER_ZETA_BASIS_LABELS,
  type DuctLossPayload, type DuctNode, type DuctSystem, type NodeParams, type ReducerZetaBasis,
} from '../src'
import { TEST_COEFFICIENTS } from './testCoefficients'

const dl = createDuctLoss(TEST_COEFFICIENTS)
const RHO = 1.2
const LOSS_AT_100 = 1.5011   // φ100 の動圧で ζ 0.2
const LOSS_AT_150 = 0.2965   // φ150 の動圧で ζ 0.2

type Side = 'upstream' | 'downstream'
type Spec = { id: string; parent: string | null; side?: Side; params: NodeParams }
function build(specs: Spec[]): DuctSystem {
  const nodes: Record<string, DuctNode> = {}
  for (const s of specs) nodes[s.id] = { id: s.id, x: 0, y: 0, label: s.id, parentId: s.parent, childIds: [], side: s.side ?? 'downstream', params: s.params }
  for (const s of specs) if (s.parent) nodes[s.parent].childIds.push(s.id)
  return { id: 'sys', name: '系統', type: 'SA', rootId: specs[0].id, nodes }
}
const fan = (): NodeParams => ({ kind: 'fan', maxStaticPa: null, notch: '', defaultLambda: 0.04 })
const duct = (d: 100 | 150, l = 1): NodeParams => ({ kind: 'duct', diameterMm: d, lengthM: l, bendAngleDeg: 90, bendCount: 0, lambda: null })
const term = (q: number, d: 100 | 150): NodeParams => ({ kind: 'terminal', diameterMm: d, targetFlowQh: q, pressureMode: 'zeta', zeta: 1, targetPa: 0 })
// 保存値（φ250）は使われない: 径はつながっているダクトから読む（SPEC.md §4）
const reducer = (basis: ReducerZetaBasis | undefined): NodeParams => ({
  kind: 'reducer', diameterFromMm: 250, diameterToMm: 250, zeta: 0.2, ...(basis ? { zetaBasis: basis } : {}),
})

/**
 * 送風機 → ダクト(根の側の径) → レジューサ → ダクト(端末の側の径) → 端末。
 * side が upstream なら吸込側の枝として作り、吹出側にも同じ 100 m³/h の端末を置く
 * （吸込側の風量は吹出側の合計を端末の比で分けるので、1 本なら 100 m³/h）。
 */
function system(side: Side, rootSideMm: 100 | 150, leafSideMm: 100 | 150, basis: ReducerZetaBasis | undefined): DuctSystem {
  const branch: Spec[] = [
    { id: 'd1', parent: 'fan', side, params: duct(rootSideMm) },
    { id: 'red', parent: 'd1', side, params: reducer(basis) },
    { id: 'd2', parent: 'red', side, params: duct(leafSideMm) },
    { id: 't', parent: 'd2', side, params: term(100, leafSideMm) },
  ]
  const supply: Spec[] = side === 'upstream'
    ? [{ id: 's', parent: 'fan', params: duct(100) }, { id: 'st', parent: 's', params: term(100, 100) }]
    : []
  return build([{ id: 'fan', parent: null, params: fan() }, ...branch, ...supply])
}
const reducerLoss = (sys: DuctSystem) => {
  const r = dl.calcSystem(sys, RHO).byNode.red
  expect(r.flowQh).toBeCloseTo(100, 6)
  return r.lossPa
}

describe('4 つの形: 吹出・吸込 × 縮小・拡大（空気の流れの向きで見る）', () => {
  it('吹出側の縮小（φ150 → φ100）: 入口 φ150・出口 φ100', () => {
    const sys = system('downstream', 150, 100, 'small')
    const d = reducerDiameters(sys.nodes, sys.nodes.red)
    expect([d.flowInletMm, d.flowOutletMm, d.change]).toEqual([150, 100, 'contraction'])
    expect(reducerLoss(system('downstream', 150, 100, 'small'))).toBeCloseTo(LOSS_AT_100, 3)
    expect(reducerLoss(system('downstream', 150, 100, 'large'))).toBeCloseTo(LOSS_AT_150, 3)
    expect(reducerLoss(system('downstream', 150, 100, 'flowInlet'))).toBeCloseTo(LOSS_AT_150, 3)
    expect(reducerLoss(system('downstream', 150, 100, 'flowOutlet'))).toBeCloseTo(LOSS_AT_100, 3)
  })

  it('吹出側の拡大（φ100 → φ150）: 入口 φ100・出口 φ150', () => {
    const sys = system('downstream', 100, 150, 'small')
    const d = reducerDiameters(sys.nodes, sys.nodes.red)
    expect([d.flowInletMm, d.flowOutletMm, d.change]).toEqual([100, 150, 'expansion'])
    expect(reducerLoss(system('downstream', 100, 150, 'small'))).toBeCloseTo(LOSS_AT_100, 3)
    expect(reducerLoss(system('downstream', 100, 150, 'large'))).toBeCloseTo(LOSS_AT_150, 3)
    expect(reducerLoss(system('downstream', 100, 150, 'flowInlet'))).toBeCloseTo(LOSS_AT_100, 3)
    expect(reducerLoss(system('downstream', 100, 150, 'flowOutlet'))).toBeCloseTo(LOSS_AT_150, 3)
  })

  it('吸込側の縮小（端末の側 φ150 → 送風機の側 φ100）: 空気は端末の側から入る', () => {
    const sys = system('upstream', 100, 150, 'small')
    const d = reducerDiameters(sys.nodes, sys.nodes.red)
    expect([d.flowInletMm, d.flowOutletMm, d.change]).toEqual([150, 100, 'contraction'])
    expect(reducerLoss(system('upstream', 100, 150, 'small'))).toBeCloseTo(LOSS_AT_100, 3)
    expect(reducerLoss(system('upstream', 100, 150, 'flowInlet'))).toBeCloseTo(LOSS_AT_150, 3)
    expect(reducerLoss(system('upstream', 100, 150, 'flowOutlet'))).toBeCloseTo(LOSS_AT_100, 3)
  })

  it('吸込側の拡大（端末の側 φ100 → 送風機の側 φ150）', () => {
    const sys = system('upstream', 150, 100, 'small')
    const d = reducerDiameters(sys.nodes, sys.nodes.red)
    expect([d.flowInletMm, d.flowOutletMm, d.change]).toEqual([100, 150, 'expansion'])
    expect(reducerLoss(system('upstream', 150, 100, 'small'))).toBeCloseTo(LOSS_AT_100, 3)
    expect(reducerLoss(system('upstream', 150, 100, 'large'))).toBeCloseTo(LOSS_AT_150, 3)
    expect(reducerLoss(system('upstream', 150, 100, 'flowInlet'))).toBeCloseTo(LOSS_AT_100, 3)
    expect(reducerLoss(system('upstream', 150, 100, 'flowOutlet'))).toBeCloseTo(LOSS_AT_150, 3)
  })
})

describe('欄の無い古いデータは今までどおり（端末の側の径）', () => {
  it('端末の側が細い形は「細い側」と同じ値', () => {
    expect(reducerLoss(system('downstream', 150, 100, undefined))).toBeCloseTo(LOSS_AT_100, 3)
  })
  it('端末の側が太い形は太い側の動圧のまま（黙って変えない）', () => {
    expect(reducerLoss(system('downstream', 100, 150, undefined))).toBeCloseTo(LOSS_AT_150, 3)
    expect(reducerLoss(system('upstream', 100, 150, undefined))).toBeCloseTo(LOSS_AT_150, 3)
  })
  it('基準を「細い側」に選び直すと (150/100)⁴ = 5.0625 倍', () => {
    const before = reducerLoss(system('downstream', 100, 150, undefined))
    const after = reducerLoss(system('downstream', 100, 150, 'small'))
    expect(after / before).toBeCloseTo(5.0625, 3)
  })
})

describe('基準断面を選び直すときの ζ の換算（損失を保つ）', () => {
  it('細い側 φ100 → 太い側 φ150 では ζ × (150/100)⁴、損失は同じ', () => {
    const sys = system('downstream', 150, 100, 'small')
    const z = reducerZetaForBasis(sys.nodes, sys.nodes.red, 'large')
    expect(z).toBeCloseTo(0.2 * 5.0625, 6)
    const after = system('downstream', 150, 100, 'large')
    after.nodes.red.params = { ...after.nodes.red.params, zeta: z } as NodeParams
    expect(reducerLoss(after)).toBeCloseTo(LOSS_AT_100, 3)
  })
  it('同じ径になる選び直しでは変わらない（吹出側の縮小で 細い側 → 出口側）', () => {
    const sys = system('downstream', 150, 100, 'small')
    expect(reducerZetaForBasis(sys.nodes, sys.nodes.red, 'flowOutlet')).toBeCloseTo(0.2, 9)
  })
})

describe('点検と説明', () => {
  const payloadOf = (sys: DuctSystem): DuctLossPayload => ({ schemaVersion: 4, rho: RHO, systems: [sys] })
  const keys = (sys: DuctSystem) => diagnose(payloadOf(sys), { sys: dl.calcSystem(sys, RHO) }).map(i => i.id)

  it('古いデータで端末の側が太い形だけ知らせる', () => {
    expect(keys(system('downstream', 100, 150, undefined)).some(k => k.includes('reducer-legacy-basis'))).toBe(true)
    expect(keys(system('downstream', 150, 100, undefined)).some(k => k.includes('reducer-legacy-basis'))).toBe(false)
    expect(keys(system('downstream', 100, 150, 'large')).some(k => k.includes('reducer-legacy-basis'))).toBe(false)
  })

  it('新しく置くレジューサの既定は「細い側」', () => {
    const p = dl.makeNode('reducer').params
    expect(p.kind === 'reducer' && p.zetaBasis).toBe('small')
  })

  it('説明は計算と同じ径の動圧を書く', () => {
    const sys = system('upstream', 100, 150, 'flowInlet')
    const calc = dl.calcSystem(sys, RHO)
    const ex = dl.explainNode(sys.nodes.red, calc.byNode.red, RHO, { fanFlowQh: 100, fanRequiredPa: 0, nodes: sys.nodes })
    const area = ex.steps.find(s => s.label === '断面積 A')
    expect(area?.substitution).toContain('0.150')
    expect(ex.headlineFormula).toContain(REDUCER_ZETA_BASIS_LABELS.flowInlet)
  })

  it('計算条件に ζ を掛ける動圧の断面が出る', () => {
    const sys = system('downstream', 150, 100, 'small')
    const rows = dl.collectCalcConditions(payloadOf(sys))
    const row = rows.find(r => r.label === 'レジューサの ζ')
    expect(row?.value).toBe('0.2')
    expect(row?.note).toContain(REDUCER_ZETA_BASIS_LABELS.small)
  })
})
