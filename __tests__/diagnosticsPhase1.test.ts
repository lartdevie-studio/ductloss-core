/**
 * 第 1 段階で直した点検と既定値（docs/DUCTLOSS_PHASE1_FINDINGS.md の TRACE-4・AIRCON-BASIS・DVA-7/8）。
 */
import { describe, it, expect } from 'vitest'
import { createDuctLoss, diagnose, fanUpstreamBalance, type DuctLossPayload, type DuctNode, type DuctSystem, type NodeParams } from '../src'
import { TEST_COEFFICIENTS } from './testCoefficients'

const dl = createDuctLoss(TEST_COEFFICIENTS)
type Spec = { id: string; parent: string | null; side?: 'upstream' | 'downstream'; params: NodeParams }
function build(specs: Spec[]): DuctSystem {
  const nodes: Record<string, DuctNode> = {}
  for (const s of specs) nodes[s.id] = { id: s.id, x: 0, y: 0, label: s.id, parentId: s.parent, childIds: [], side: s.side ?? 'downstream', params: s.params }
  for (const s of specs) if (s.parent) nodes[s.parent].childIds.push(s.id)
  return { id: 'sys', name: '系統', type: 'SA', rootId: specs[0].id, nodes }
}
const payloadOf = (sys: DuctSystem): DuctLossPayload => ({ schemaVersion: 4, rho: 1.2, systems: [sys] })
const fan = (): NodeParams => ({ kind: 'fan', maxStaticPa: null, notch: '', defaultLambda: 0.04 })
const duct = (d: 100 | 150 | 200, l: number): NodeParams => ({ kind: 'duct', diameterMm: d, lengthM: l, bendAngleDeg: 90, bendCount: 0, lambda: null })
const term = (q: number, d: 100 | 150 | 200 = 100): NodeParams => ({ kind: 'terminal', diameterMm: d, targetFlowQh: q, pressureMode: 'zeta', zeta: 1.2, targetPa: 0 })
const ids = (sys: DuctSystem, scale = 1) => diagnose(payloadOf(sys), { sys: dl.calcSystem(sys, 1.2, scale) }).map(i => i.id)

describe('新しく置く部材の既定値は食い違わない', () => {
  it('フィルター・エアコンは ζ 入力が既定（以前は Pa 入力の 30 Pa と ζ 5 が食い違っていた）', () => {
    const f = dl.makeNode('filter').params
    const a = dl.makeNode('aircon').params
    expect(f.kind === 'filter' && f.pressureMode).toBe('zeta')
    expect(a.kind === 'aircon' && a.pressureMode).toBe('zeta')
  })
})

describe('Pa で入れた値と計算の値の食い違い', () => {
  const withFilter = (targetPa: number, zeta: number) => build([
    { id: 'fan', parent: null, params: fan() },
    { id: 'd', parent: 'fan', params: duct(150, 3) },
    { id: 'flt', parent: 'd', params: { kind: 'filter', diameterMm: 150, pressureMode: 'pa', zeta, targetPa, filterNote: '' } },
    { id: 't', parent: 'flt', params: term(120, 150) },
  ])
  it('目標 30 Pa なのに ζ 5（φ150・120 m³/h の動圧 ≈ 2.13 Pa → 10.7 Pa）なら知らせる', () => {
    // 手計算: v = 120/3600/(π·0.15²/4) = 1.886 m/s、q = 0.6·1.886² = 2.134 Pa、5·2.134 = 10.7 Pa ≠ 30 Pa
    expect(ids(withFilter(30, 5)).some(id => id.includes('pa-mode-mismatch'))).toBe(true)
  })
  it('ζ が目標 Pa から逆算した値なら知らせない', () => {
    const v = 120 / 3600 / (Math.PI * 0.15 * 0.15 / 4)
    const q = 0.6 * v * v
    expect(ids(withFilter(30, 30 / q)).some(id => id.includes('pa-mode-mismatch'))).toBe(false)
  })
})

describe('送風機として評価するエアコンの本体 ζ', () => {
  const rootAircon = (zeta: number, maxStaticPa: number | null) => build([
    { id: 'ac', parent: null, params: { kind: 'aircon', diameterMm: 200, pressureMode: 'zeta', zeta, targetPa: 0, supplyFromHexQh: null, returnQh: null, maxStaticPa, maxStaticAtQh: 600 } },
    { id: 'blow', parent: 'ac', params: duct(200, 6) },
    { id: 't', parent: 'blow', params: term(500, 200) },
    { id: 'rec', parent: 'ac', side: 'upstream', params: duct(200, 1) },
    { id: 'g', parent: 'rec', side: 'upstream', params: term(500, 200) },
  ])
  it('本体 ζ > 0 で機外静圧と比べるなら、二重計上を知らせる', () => {
    expect(ids(rootAircon(0.5, 80)).some(id => id.includes('aircon-body-loss'))).toBe(true)
  })
  it('本体 ζ 0 なら知らせない／機外静圧が無ければ知らせない', () => {
    expect(ids(rootAircon(0, 80)).some(id => id.includes('aircon-body-loss'))).toBe(false)
    expect(ids(rootAircon(0.5, null)).some(id => id.includes('aircon-body-loss'))).toBe(false)
  })
})

describe('風量の倍率をかけた検討中も、入力どうしの比べは設計風量で', () => {
  const balanced = build([
    { id: 'fan', parent: null, params: fan() },
    { id: 'oa', parent: 'fan', side: 'upstream', params: duct(150, 2) },
    { id: 'hood', parent: 'oa', side: 'upstream', params: term(120, 150) },
    { id: 'sa', parent: 'fan', params: duct(150, 4) },
    { id: 't', parent: 'sa', params: term(120, 150) },
  ])
  it('吸込側 120・吹出側 120 で釣り合っていれば、倍率 2 でも「合っていません」と言わない', () => {
    expect(ids(balanced, 2).some(id => id.includes('upstream-balance'))).toBe(false)
    expect(fanUpstreamBalance(balanced, dl.calcSystem(balanced, 1.2, 2)).balanced).toBe(true)
  })
})
