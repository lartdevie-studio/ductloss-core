/**
 * 計算書の計算条件の表（collectCalcConditions）。
 * 先頭の行は設計係数の名前と出典（SPEC.md §2）。λ・曲がりの相当長は計算と同じ決まりで拾う。
 */
import { describe, it, expect } from 'vitest'
import { createDuctLoss, summarizeTerminalZeta, hasReportNotes, type DuctLossPayload, type DuctNode, type NodeParams } from '../src'
import { TEST_COEFFICIENTS } from './testCoefficients'

const dl = createDuctLoss(TEST_COEFFICIENTS)

function payload(ducts: { d: 75 | 100 | 125 | 150 | 200; lambda?: number | null }[], fanLambda: unknown = 0.04, rho = 1.2): DuctLossPayload {
  const nodes: Record<string, DuctNode> = {
    fan: { id: 'fan', x: 0, y: 0, label: '', parentId: null, childIds: [], side: 'downstream',
      params: { kind: 'fan', maxStaticPa: null, notch: '', defaultLambda: fanLambda } as NodeParams },
  }
  ducts.forEach((x, i) => {
    const id = `d${i}`
    nodes[id] = { id, x: 0, y: 0, label: '', parentId: 'fan', childIds: [], side: 'downstream',
      params: { kind: 'duct', diameterMm: x.d, lengthM: 1, bendAngleDeg: 90, bendCount: 1, lambda: x.lambda ?? null } }
    nodes.fan.childIds.push(id)
  })
  return { schemaVersion: 4, rho, systems: [{ id: 's', name: 's', type: 'SA', rootId: 'fan', nodes }] }
}
const row = (p: DuctLossPayload, label: string) => dl.collectCalcConditions(p).find(r => r.label === label)

describe('計算条件の表', () => {
  it('先頭は設計係数の名前と出典', () => {
    expect(dl.collectCalcConditions(payload([]))[0]).toEqual({
      label: '設計係数', value: TEST_COEFFICIENTS.name, note: `出典: ${TEST_COEFFICIENTS.source}`,
    })
  })

  it('曲がりの相当長は計算と同じ「一番近い径」の値（表に無い φ125 は同じ近さの小さい径 φ100 の値）', () => {
    expect(row(payload([{ d: 125 }]), '曲がり相当長')?.value).toBe('90° φ125 = 0.3 m')
  })

  it('送風機の λ が空・壊れた値なら、計算と同じく係数の λ を載せる', () => {
    expect(row(payload([{ d: 100 }], null), '摩擦係数 λ')?.value).toBe('0.04（全ダクト共通）')
    expect(row(payload([{ d: 100 }], undefined), '摩擦係数 λ')?.value).toBe('0.04（全ダクト共通）')
    // 出どころも計算と同じ（以前は係数の λ まで「送風機の既定値」と書いていた）
    expect(row(payload([{ d: 100 }], null), '摩擦係数 λ')?.note).toBe('設計係数の λ')
  })

  it('空気密度: 1.2 は「標準空気（JIS B 8330）」、それ以外で気温の記録が無ければ「保存された値」', () => {
    expect(row(payload([]), '空気密度 ρ')?.note).toBe('標準空気（JIS B 8330: 20℃・101.3 kPa・65%RH）')
    expect(row(payload([], 0.04, 1.15), '空気密度 ρ')?.note).toBe('保存された値（気温・標高の記録なし）')
  })

  it('端末の一覧の径は計算に使った径（保存値 φ100 でも接続ダクトが φ150 なら φ150）', () => {
    const p = payload([{ d: 150 }])
    const sys = p.systems[0]
    sys.nodes.t = { id: 't', x: 0, y: 0, label: '', parentId: 'd0', childIds: [], side: 'downstream',
      params: { kind: 'terminal', diameterMm: 100, targetFlowQh: 80, pressureMode: 'zeta', zeta: 1.2, targetPa: 0 } }
    sys.nodes.d0.childIds.push('t')
    expect(summarizeTerminalZeta(p).map(r => r.diameterMm)).toEqual([150])
  })

  it('端末が無ければ端末の一覧は空、注記が無ければ注記の章は出さない', () => {
    expect(summarizeTerminalZeta(payload([]))).toEqual([])
    expect(hasReportNotes(payload([]))).toBe(false)
  })
})
