/**
 * 計算の解説が、計算と同じ値を見せること。
 *
 * 以前は解説だけが λ を既定値で、曲がりを 1 種類目だけで書いていた
 * （ファンの λ を変えた系統・曲がり 2 種のダクトで、解説の式と結果が食い違う）。
 */
import { describe, it, expect } from 'vitest'
import { createDuctLoss, type DuctNode, type DuctSystem } from '../src'
import { TEST_COEFFICIENTS } from './testCoefficients'

const dl = createDuctLoss(TEST_COEFFICIENTS)

function system(fanLambda: number): DuctSystem {
  const nodes: Record<string, DuctNode> = {
    fan: { id: 'fan', x: 0, y: 0, label: '', parentId: null, childIds: ['d'], side: 'downstream',
      params: { kind: 'fan', maxStaticPa: null, notch: '', defaultLambda: fanLambda } },
    d: { id: 'd', x: 0, y: 0, label: '', parentId: 'fan', childIds: ['t'], side: 'downstream',
      params: { kind: 'duct', diameterMm: 100, lengthM: 4, bendAngleDeg: 90, bendCount: 0, lambda: null,
        bends: [{ angleDeg: 90, count: 2 }, { angleDeg: 45, count: 1 }] } },
    t: { id: 't', x: 0, y: 0, label: '', parentId: 'd', childIds: [], side: 'downstream',
      params: { kind: 'terminal', diameterMm: 100, targetFlowQh: 120, pressureMode: 'zeta', zeta: 1, targetPa: 0 } },
  }
  return { id: 's', name: 's', type: 'SA', rootId: 'fan', nodes }
}

describe('ダクトの解説', () => {
  const sys = system(0.07)
  const calc = dl.calcSystem(sys, 1.2)
  const ex = dl.explainNode(sys.nodes.d, calc.byNode.d, 1.2)
  const step = (label: string) => ex.steps.find(s => s.label === label)!

  it('λ は計算が使ったファンの値（係数の既定値ではない）', () => {
    expect(step('単位長さ圧損').substitution).toContain('0.070')
  })

  it('曲がりは全種類を出し、相当長は計算と同じ', () => {
    expect(step('曲がり相当長').substitution).toBe('90° × 2 個 ＋ 45° × 1 個')
    const lBend = dl.ductBendEquivLength(100, sys.nodes.d.params as Parameters<typeof dl.ductBendEquivLength>[1])
    expect(lBend).toBeCloseTo(0.3 * 2 + 0.3 * 0.5, 9)
    expect(step('曲がり相当長').result).toBe(`${lBend.toFixed(2)} m`)
  })
})
