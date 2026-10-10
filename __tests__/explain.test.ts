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

describe('送風機の解説（熱交換器＋エアコンの系統。DVA-5）', () => {
  // 熱交換器 → 幹 → エアコン（循環 400・リターン 300 → 熱交からの供給 100）→ 吹出 2 口。外気側にも 1 本
  const n = (id: string, parent: string | null, side: 'upstream' | 'downstream', params: DuctNode['params']): DuctNode =>
    ({ id, x: 0, y: 0, label: id, parentId: parent, childIds: [], side, params })
  const duct = (l: number): DuctNode['params'] => ({ kind: 'duct', diameterMm: 150, lengthM: l, bendAngleDeg: 90, bendCount: 0, lambda: null })
  const term = (q: number): DuctNode['params'] => ({ kind: 'terminal', diameterMm: 100, targetFlowQh: q, pressureMode: 'zeta', zeta: 1, targetPa: 0 })
  const list: DuctNode[] = [
    n('fan', null, 'downstream', { kind: 'fan', maxStaticPa: null, notch: '', defaultLambda: 0.04 }),
    n('oa', 'fan', 'upstream', duct(3)),
    n('hood', 'oa', 'upstream', term(100)),
    n('trunk', 'fan', 'downstream', duct(6)),
    n('ac', 'trunk', 'downstream', { kind: 'aircon', diameterMm: 150, pressureMode: 'zeta', zeta: 0, targetPa: 0, supplyFromHexQh: null, returnQh: 300, maxStaticPa: null, maxStaticAtQh: null }),
    n('s1', 'ac', 'downstream', duct(4)),
    n('t1', 's1', 'downstream', term(200)),
    n('s2', 'ac', 'downstream', duct(2)),
    n('t2', 's2', 'downstream', term(200)),
    n('ra', 'ac', 'upstream', duct(2)),
    n('g', 'ra', 'upstream', term(300)),
  ]
  const nodes: Record<string, DuctNode> = Object.fromEntries(list.map(x => [x.id, x]))
  for (const x of list) if (x.parentId) nodes[x.parentId].childIds.push(x.id)
  const sys: DuctSystem = { id: 's', name: 's', type: 'SA', rootId: 'fan', nodes }
  const calc = dl.calcSystem(sys, 1.2)
  const ex = dl.explainNode(sys.nodes.fan, calc.byNode.fan, 1.2, {
    fanFlowQh: calc.fanFlowQh, fanRequiredPa: calc.fanRequiredPa,
    fanUpstreamPa: calc.fanUpstreamPa, fanDownstreamPa: calc.fanDownstreamPa,
    nodes, secondaryMovers: calc.secondaryMovers,
  })
  const step = (label: string) => ex.steps.find(s => s.label === label)!

  it('前提: エアコンが第 2 の送風機で、熱交換器の風量は供給分の 100 m³/h', () => {
    expect(calc.secondaryMovers.map(m => m.nodeId)).toEqual(['ac'])
    expect(calc.fanFlowQh).toBeCloseTo(100, 9)
  })

  it('式は「エアコンの手前まで」を受け持つ形で、数は計算と同じ（上流側 ＋ 下流側 ＝ 必要静圧）', () => {
    expect(step('下流側').formula).toContain('エアコンの手前')
    expect(step('上流側').result).toBe(`${calc.fanUpstreamPa.toFixed(1)} Pa`)
    expect(step('下流側').result).toBe(`${calc.fanDownstreamPa.toFixed(1)} Pa`)
    expect(step('必要静圧 ΔP_必要').substitution).toBe(`= ${calc.fanUpstreamPa.toFixed(1)} + ${calc.fanDownstreamPa.toFixed(1)}`)
    expect(calc.fanUpstreamPa + calc.fanDownstreamPa).toBeCloseTo(calc.fanRequiredPa, 9)
    // 幹（エアコンの手前まで）の圧損は、主送風機の下流側に入っている
    expect(calc.fanDownstreamPa).toBeCloseTo(calc.byNode.trunk.lossPa, 9)
  })
})
