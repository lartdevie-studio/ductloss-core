/**
 * 粗さから求める λ（Colebrook）と、曲がりを ζ で持つ係数（SPEC.md §2・§3）。
 * 期待値は教科書の値・手計算で書く（本体の関数から作らない）。
 */
import { describe, it, expect } from 'vitest'
import {
  airKinematicViscosity, bendAngleFactor, bendZeta, coefficientFingerprint, colebrookLambda, createDuctLoss, validateCoefficients,
  type DesignCoefficients, type DuctNode, type DuctSystem, type NodeParams,
} from '../src'
import { TEST_COEFFICIENTS } from './testCoefficients'

describe('Colebrook の式と空気の動粘性係数', () => {
  it('滑らかな管・Re 1e5 で λ ≈ 0.0180、ε/D 0.001・Re 1e5 で λ ≈ 0.0222（教科書のムーディ線図の値）', () => {
    expect(colebrookLambda(1e5, 0)).toBeCloseTo(0.0180, 3)
    expect(colebrookLambda(1e5, 0.001)).toBeCloseTo(0.0222, 3)
  })
  it('Colebrook の式をそのまま満たす（残差がほぼ 0）', () => {
    for (const [re, rr] of [[5e3, 0], [2e4, 0.0012], [8e4, 0.01]]) {
      const lam = colebrookLambda(re, rr)
      const resid = 1 / Math.sqrt(lam) + 2 * Math.log10(rr / 3.7 + 2.51 / (re * Math.sqrt(lam)))
      expect(Math.abs(resid)).toBeLessThan(1e-9)
    }
  })
  it('Re < 2300 は層流 64/Re、Re 0 は 0', () => {
    expect(colebrookLambda(1000, 0.001)).toBeCloseTo(0.064, 12)
    expect(colebrookLambda(0, 0.001)).toBe(0)
  })
  it('20℃・ρ 1.2 の ν ≈ 1.511e-5 m²/s（μ ≈ 1.813e-5 Pa·s）', () => {
    expect(airKinematicViscosity(20, 1.2)).toBeCloseTo(1.5111e-5, 8)
  })
})

const ZETA_COEF: DesignCoefficients = {
  ...TEST_COEFFICIENTS,
  name: '粗さと曲がり ζ（架空）',
  bendEquivLength90M: {},
  friction: { model: 'roughness', defaultMaterial: 'm1', materials: {
    m1: { label: '材料 1（架空）', roughnessMm: 0.1, source: '架空' },
    m2: { label: '材料 2（架空）', roughnessMm: 0.01, source: '架空' },
  } },
  bend: { model: 'zeta', defaultShape: 's1', shapes: {
    s1: { label: '形 1（架空）', zeta90: 0.3, source: '架空' },
    s2: { label: '形 2（架空）', zeta90: 0.2, source: '架空' },
  }, angleFactor: { 30: 0.5, 90: 1.0 }, angleFactorSource: '架空' },
  notes: ['テストの注意'],
}

describe('係数の確かめと識別', () => {
  it('曲がりを ζ で持つなら相当長の表は空でよい。材料・形の既定が無ければ例外', () => {
    expect(validateCoefficients(ZETA_COEF)).toEqual([])
    const fr = ZETA_COEF.friction as Extract<DesignCoefficients['friction'], { model: 'roughness' }>
    const bm = ZETA_COEF.bend as Extract<DesignCoefficients['bend'], { model: 'zeta' }>
    expect(validateCoefficients({ ...ZETA_COEF, friction: { ...fr, defaultMaterial: 'x' } }).length).toBeGreaterThan(0)
    expect(validateCoefficients({ ...ZETA_COEF, bend: { ...bm, defaultShape: 'x' } }).length).toBeGreaterThan(0)
    expect(validateCoefficients({ ...TEST_COEFFICIENTS, bendEquivLength90M: {} }).length).toBeGreaterThan(0)
  })
  it('摩擦・曲がりのモデルを渡さない係数の識別は変わらない。渡すと変わり、値が 1 つ違っても変わる', () => {
    const base = coefficientFingerprint(TEST_COEFFICIENTS)
    expect(coefficientFingerprint({ ...TEST_COEFFICIENTS, friction: { model: 'constant' } })).toBe(base)
    const z = coefficientFingerprint(ZETA_COEF)
    expect(z).not.toBe(coefficientFingerprint({ ...ZETA_COEF, bendEquivLength90M: TEST_COEFFICIENTS.bendEquivLength90M, friction: undefined, bend: undefined }))
    const changed: DesignCoefficients = { ...ZETA_COEF, bend: { ...(ZETA_COEF.bend as Extract<DesignCoefficients['bend'], { model: 'zeta' }>), angleFactor: { 30: 0.51, 90: 1.0 } } }
    expect(coefficientFingerprint(changed)).not.toBe(z)
  })
})

describe('曲がりの ζ', () => {
  it('角度の補正は表を直線で補間（60° は 0.5 と 1.0 の真ん中 0.75）、表が無ければ θ/90', () => {
    expect(bendAngleFactor(ZETA_COEF, 60)).toBeCloseTo(0.75, 12)
    expect(bendAngleFactor(ZETA_COEF, 15)).toBe(0.5)
    expect(bendAngleFactor(TEST_COEFFICIENTS, 45)).toBe(0.5)
  })
  it('器材の ζ は角度の補正をかけずにそのまま、形が無ければ既定の形', () => {
    expect(bendZeta(ZETA_COEF, { angleDeg: 30, zeta: 0.9 })).toBe(0.9)
    expect(bendZeta(ZETA_COEF, { angleDeg: 90, shape: 's2' })).toBeCloseTo(0.2, 12)
    expect(bendZeta(ZETA_COEF, { angleDeg: 30, shape: 'unknown' })).toBeCloseTo(0.15, 12)
  })
})

describe('計算・計算書・解説', () => {
  const dl = createDuctLoss(ZETA_COEF)
  // φ100・4 m・材料 2・90°×2（形 2）＋ 30°×1、端末 ζ 1、60 m³/h、20℃・ρ 1.2
  // 手計算: v = 60/3600/(π·0.1²/4) = 2.12207 m/s、q = 0.6·v² = 2.70190 Pa、Re = v·0.1/1.5111e-5 ≈ 14043
  //         Σζ曲 = 0.2·1·2 + 0.3·0.5·1 = 0.55 → 曲がり 0.55·2.70190 = 1.48604 Pa
  const nodes: Record<string, DuctNode> = {
    fan: { id: 'fan', x: 0, y: 0, label: '', parentId: null, childIds: ['d'], side: 'downstream', params: dl.defaultParams('fan') },
    d: { id: 'd', x: 0, y: 0, label: '', parentId: 'fan', childIds: ['t'], side: 'downstream',
      params: { kind: 'duct', diameterMm: 100, lengthM: 4, bendAngleDeg: 90, bendCount: 0, lambda: null, material: 'm2',
        bends: [{ angleDeg: 90, count: 2, shape: 's2' }, { angleDeg: 30, count: 1 }] } as NodeParams },
    t: { id: 't', x: 0, y: 0, label: '', parentId: 'd', childIds: [], side: 'downstream',
      params: { kind: 'terminal', diameterMm: 100, targetFlowQh: 60, pressureMode: 'zeta', zeta: 1, targetPa: 0 } },
  }
  const sys: DuctSystem = { id: 's', name: 's', type: 'SA', rootId: 'fan', nodes }
  const calc = dl.calcSystem(sys, 1.2)
  const det = calc.byNode.d.duct!

  it('新しく作る送風機の既定 λ は null（材料と風速で求める）', () => {
    expect(nodes.fan.params.kind === 'fan' && nodes.fan.params.defaultLambda).toBeNull()
  })
  it('λ は材料 2 の粗さから、曲がりは λ によらない ζ·q', () => {
    expect(det.lambdaSource).toBe('roughness')
    expect(det.material).toBe('m2')
    expect(det.reynolds).toBeCloseTo(2.12207 * 0.1 / 1.5111e-5, -1)
    expect(det.lambda).toBeCloseTo(colebrookLambda(det.reynolds!, 0.01 / 100), 12)
    expect(det.bendZeta).toBeCloseTo(0.55, 12)
    expect(det.bendPa).toBeCloseTo(1.48604, 4)
    expect(calc.byNode.d.lossPa).toBeCloseTo(det.frictionPa + det.bendPa, 12)
    expect(det.frictionPa).toBeCloseTo(det.lambda / 0.1 * 2.70190 * 4, 4)
  })
  it('直管に λ を指定すれば粗さより優先（器材の λ・フレキの製品値を入れるとき）', () => {
    const withLambda: DuctSystem = { ...sys, nodes: { ...nodes, d: { ...nodes.d, params: { ...nodes.d.params, lambda: 0.025 } as NodeParams } } }
    const r = dl.calcSystem(withLambda, 1.2).byNode.d.duct!
    expect([r.lambda, r.lambdaSource]).toEqual([0.025, 'duct'])
    expect(r.bendPa).toBeCloseTo(det.bendPa, 12)   // 曲がりは λ によらない
  })
  it('気温を渡すと動粘性係数が変わり、Re が変わる', () => {
    const hot = dl.calcSystem(sys, 1.2, 1, { tempC: 35 })
    expect(hot.byNode.d.duct!.reynolds!).toBeLessThan(det.reynolds!)
    expect(hot.meta?.tempC).toBe(35)
  })
  it('計算書に粗さの行・曲がり（局部損失）の行・係数の注意が出て、相当長の行は出ない', () => {
    const rows = dl.collectCalcConditions({ schemaVersion: 4, rho: 1.2, systems: [sys] })
    const labels = rows.map(r => r.label)
    expect(labels).toContain('摩擦係数 λ（粗さから）')
    expect(labels).toContain('曲がり（局部損失）')
    expect(labels).not.toContain('曲がり相当長')
    expect(rows.find(r => r.label === '係数の注意')?.value).toBe('テストの注意')
    expect(rows.find(r => r.label === '摩擦係数 λ（粗さから）')?.value).toContain('材料 2（架空）')
    expect(rows.find(r => r.label === '曲がり（局部損失）')?.value).toContain('形 2（架空）')
  })
  it('解説は Re・Colebrook・曲がりの ζ の手順を、計算と同じ数で書く', () => {
    const ex = dl.explainNode(nodes.d, calc.byNode.d, 1.2)
    const labels = ex.steps.map(s => s.label)
    expect(labels).toEqual(expect.arrayContaining(['レイノルズ数 Re', '摩擦係数 λ', '曲がりの ζ', '曲がりの圧損']))
    expect(ex.steps.find(s => s.label === '曲がりの ζ')?.result).toBe('0.550')
  })
})
