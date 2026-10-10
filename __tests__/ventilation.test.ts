/**
 * 必要換気量の照合（SPEC.md §8）。建築基準法 施行令 20条の8 は「必要有効換気量以上」を求める。
 */
import { describe, it, expect } from 'vitest'
import { checkVentilation, type DuctLossPayload, type DuctNode, type DuctSystem, type SystemType } from '../src'

function system(id: string, type: SystemType, flowQh: number, rootKind: 'fan' | 'aircon' = 'fan'): DuctSystem {
  const root: DuctNode = rootKind === 'fan'
    ? { id: 'r', x: 0, y: 0, label: '', parentId: null, childIds: ['t'], side: 'downstream',
        params: { kind: 'fan', defaultLambda: 0.04, maxStaticPa: null, notch: '' } }
    : { id: 'r', x: 0, y: 0, label: '', parentId: null, childIds: ['t'], side: 'downstream',
        params: { kind: 'aircon', diameterMm: 200, pressureMode: 'zeta', zeta: 0, targetPa: 0, supplyFromHexQh: null, returnQh: null } }
  return {
    id, name: id, type, rootId: 'r',
    nodes: {
      r: root,
      t: { id: 't', x: 0, y: 0, label: '', parentId: 'r', childIds: [], side: 'downstream',
        params: { kind: 'terminal', diameterMm: 100, zeta: 1, targetFlowQh: flowQh, targetPa: 0, pressureMode: 'zeta' } },
    },
  }
}
const check = (systems: DuctSystem[]) => checkVentilation({
  schemaVersion: 4, rho: 1.2, systems, ventilation: { volumeM3: 240, achPerH: 0.5 },
} as DuctLossPayload)

describe('必要換気量の照合（必要 240 m³ × 0.5 回/h ＝ 120 m³/h）', () => {
  it('ちょうど 120 なら足りている。119 なら不足（不足を許す幅は無い）', () => {
    expect(check([system('sa', 'SA', 120)]).ok).toBe(true)
    const short = check([system('sa', 'SA', 119)])
    expect(short.ok).toBe(false)
    expect(short.diffQh).toBeCloseTo(-1, 9)
  })
  it('給気の系統が無ければ排気で照合する（第三種換気）', () => {
    const c = check([system('re', 'RE', 125)])
    expect([c.basis, c.ventilationQh, c.ok]).toEqual(['exhaust', 125, true])
  })
  it('給気と排気があれば給気で照合する（第一種換気）', () => {
    const c = check([system('sa', 'SA', 100), system('re', 'RE', 150)])
    expect([c.basis, c.ventilationQh, c.ok]).toEqual(['supply', 100, false])
  })
  it('根がエアコンの循環系統は数えない', () => {
    const c = check([system('sa', 'SA', 100), system('ac', 'SA', 500, 'aircon')])
    expect([c.ventilationQh, c.ok]).toEqual([100, false])
  })
})
