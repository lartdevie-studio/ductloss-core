/**
 * 0.4.0 で足した任意の欄（Moody の近似式・径の変わり目の表・角度ごとの曲がりの ζ・吸込側の端末・余裕率 K）。
 * 値は架空（実在の資料・製品の値ではない）。欄を渡さなければ 0.3.0 と同じ結果になることも確かめる。
 */
import { describe, it, expect } from 'vitest'
import {
  createDuctLoss, colebrookLambda, moodyLambda, judgeMover, collectMovers, coefficientFingerprint, reducerTableZeta, interpolateCurve,
  validateCoefficients, diagnose, type DesignCoefficients, type DuctNode, type DuctSystem, type NodeParams,
} from '../src'
import { TEST_COEFFICIENTS } from './testCoefficients'

const ROUGH: DesignCoefficients = {
  ...TEST_COEFFICIENTS,
  friction: { model: 'roughness', defaultMaterial: 'm', materials: { m: { label: '架空の材料', roughnessMm: 0.1, source: '架空' } } },
  bend: { model: 'zeta', defaultShape: 's', shapes: { s: { label: '架空の曲がり', zeta90: 0.3, source: '架空' } } },
}
const WITH_OPTIONS: DesignCoefficients = {
  ...ROUGH,
  zeta: { ...ROUGH.zeta, terminalIntake: 0.4 },
  friction: { ...(ROUGH.friction as Extract<DesignCoefficients['friction'], { model: 'roughness' }>), formula: 'moody', formulaSource: '架空' },
  bend: { model: 'zeta', defaultShape: 's', shapes: {
    s: { label: '架空の曲がり', zeta90: 0.3, source: '架空' },
    a: { label: '架空の角度表', zeta90: 1.0, zetaByAngle: { 30: 0.2, 90: 1.0 }, source: '架空' },
  } },
  reducer: {
    model: 'areaRatioTable', source: '架空',
    abruptExpansion: [[0.2, 0.7], [0.6, 0.2]],
    gradualExpansion: { 20: [[0.2, 0.3], [0.6, 0.1]], 60: [[0.2, 0.6], [0.6, 0.2]] },
    abruptContraction: [[2, 0.8], [5, 4.0]],
  },
}

type Spec = { id: string; parent: string | null; side?: 'upstream' | 'downstream'; params: NodeParams }
function build(specs: Spec[]): DuctSystem {
  const nodes: Record<string, DuctNode> = {}
  for (const s of specs) nodes[s.id] = { id: s.id, x: 0, y: 0, label: s.id, parentId: s.parent, childIds: [], side: s.side ?? 'downstream', params: s.params }
  for (const s of specs) if (s.parent) nodes[s.parent].childIds.push(s.id)
  return { id: 'sys', name: '系統', type: 'SA', rootId: specs[0].id, nodes }
}
const fan: NodeParams = { kind: 'fan', maxStaticPa: null, notch: '', defaultLambda: null }
const duct = (d: 100 | 150, l: number): NodeParams => ({ kind: 'duct', diameterMm: d, lengthM: l, bendAngleDeg: 90, bendCount: 0, lambda: null })
const term = (q: number): NodeParams => ({ kind: 'terminal', diameterMm: 100, targetFlowQh: q, pressureMode: 'zeta', zeta: 1, targetPa: 0 })
const reducer = (extra: Partial<Extract<NodeParams, { kind: 'reducer' }>> = {}): NodeParams =>
  ({ kind: 'reducer', diameterFromMm: 150, diameterToMm: 100, zeta: 0.25, zetaBasis: 'small', ...extra })
const sysWith = (r: NodeParams) => build([
  { id: 'fan', parent: null, params: fan },
  { id: 'd1', parent: 'fan', params: duct(150, 3) },
  { id: 'r', parent: 'd1', params: r },
  { id: 'd2', parent: 'r', params: duct(100, 2) },
  { id: 't', parent: 'd2', params: term(100) },
])

describe('Moody の近似式', () => {
  it('式どおり（λ = 0.0055·[1 + (20000·ε/D + 1e6/Re)^(1/3)]）で、Colebrook と 3% 以内', () => {
    const re = 30000, rr = 0.001
    expect(moodyLambda(re, rr)).toBeCloseTo(0.0055 * (1 + Math.cbrt(20000 * rr + 1e6 / re)), 12)
    expect(Math.abs(moodyLambda(re, rr) / colebrookLambda(re, rr) - 1)).toBeLessThan(0.03)
    expect(moodyLambda(1000, rr)).toBeCloseTo(64 / 1000, 12)
    expect(moodyLambda(0, rr)).toBe(0)
  })
  it('係数で式を選ぶと直管の λ が変わり、内訳に式が出る。選ばなければ Colebrook で内訳に式は出ない', () => {
    const s = sysWith(reducer())
    const a = createDuctLoss(ROUGH).calcSystem(s, 1.2).byNode.d1.duct!
    const b = createDuctLoss(WITH_OPTIONS).calcSystem(s, 1.2).byNode.d1.duct!
    expect(a.formula).toBeUndefined()
    expect(b.formula).toBe('moody')
    expect(b.lambda).not.toBe(a.lambda)
  })
})

describe('径の変わり目の表', () => {
  it('面積比の間は直線で補間、表の外は端の値（clamped）', () => {
    expect(interpolateCurve([[1, 1], [3, 5]], 2)).toEqual({ value: 3, clamped: false })
    expect(interpolateCurve([[1, 1], [3, 5]], 9)).toEqual({ value: 5, clamped: true })
  })
  it('縮小（φ150→φ100・面積比 2.25）は急縮小の表を入口側（φ150）の動圧に掛ける', () => {
    const t = reducerTableZeta(WITH_OPTIONS, 150, 100, 'abrupt')!
    expect(t.change).toBe('contraction')
    expect(t.areaRatio).toBeCloseTo(2.25, 12)
    expect(t.zeta).toBeCloseTo(0.8 + (4.0 - 0.8) * (2.25 - 2) / 3, 12)
    const c = createDuctLoss(WITH_OPTIONS).calcSystem(sysWith(reducer({ form: 'abrupt' })), 1.2)
    const r = c.byNode.r
    expect(r.reducer).toMatchObject({ zetaSource: 'table', basisMm: 150, change: 'contraction' })
    expect(r.lossPa).toBeCloseTo(t.zeta * r.q, 12)
    expect(r.q).toBeCloseTo(c.byNode.d1.q, 12)
  })
  it('漸拡大は角度の間を補間する（吸込側で φ100→φ150 に広がる面積比 0.444・角度 40°）', () => {
    const t = reducerTableZeta(WITH_OPTIONS, 100, 150, 'gradual', 40)!
    const x = (100 / 150) ** 2
    const at20 = 0.3 + (0.1 - 0.3) * (x - 0.2) / 0.4
    const at60 = 0.6 + (0.2 - 0.6) * (x - 0.2) / 0.4
    expect(t).toMatchObject({ change: 'expansion', table: 'gradual', clamped: false })
    expect(t.zeta).toBeCloseTo((at20 + at60) / 2, 12)
    // 漸縮小の表が無い係数では、漸縮小を選んでも急縮小の表で求める
    expect(reducerTableZeta(WITH_OPTIONS, 150, 100, 'gradual', 30)!.table).toBe('abrupt')
  })
  it('形の無いレジューサ・自動を切ったレジューサは部材の ζ（0.3.0 と同じ）', () => {
    const plain = createDuctLoss(ROUGH).calcSystem(sysWith(reducer()), 1.2).byNode.r
    const noForm = createDuctLoss(WITH_OPTIONS).calcSystem(sysWith(reducer()), 1.2).byNode.r
    const manual = createDuctLoss(WITH_OPTIONS).calcSystem(sysWith(reducer({ form: 'abrupt', zetaAuto: false })), 1.2).byNode.r
    expect(noForm.lossPa).toBe(plain.lossPa)
    expect(manual.lossPa).toBe(plain.lossPa)
    expect(manual.reducer?.zetaSource).toBe('node')
  })
})

describe('角度ごとの曲がりの ζ・吸込側の端末', () => {
  it('zetaByAngle の形は角度の表を補間する（60° は 0.2 と 1.0 の真ん中）', () => {
    const e = createDuctLoss(WITH_OPTIONS)
    const d: NodeParams = { ...duct(100, 0), bends: [{ angleDeg: 60, count: 1, shape: 'a' }] } as NodeParams
    const s = build([{ id: 'fan', parent: null, params: fan }, { id: 'd', parent: 'fan', params: d }, { id: 't', parent: 'd', params: term(100) }])
    expect(e.calcSystem(s, 1.2).byNode.d.duct!.bendZeta).toBeCloseTo(0.6, 12)
  })
  it('吸込側に置いた端末は terminalIntake、吹出側は terminal。係数に無ければ両方 terminal', () => {
    const e = createDuctLoss(WITH_OPTIONS)
    const base = e.makeSystem('SA')
    const up = e.addChild(base.nodes, base.rootId, 'terminal', 'upstream')
    const down = e.addChild(base.nodes, base.rootId, 'terminal', 'downstream')
    expect((up.nodes[up.nodeId].params as { zeta: number }).zeta).toBe(0.4)
    expect((down.nodes[down.nodeId].params as { zeta: number }).zeta).toBe(TEST_COEFFICIENTS.zeta.terminal)
    const plain = createDuctLoss(ROUGH)
    const up2 = plain.addChild(base.nodes, base.rootId, 'terminal', 'upstream')
    expect((up2.nodes[up2.nodeId].params as { zeta: number }).zeta).toBe(TEST_COEFFICIENTS.zeta.terminal)
  })
})

describe('余裕率 K', () => {
  const pq = [{ q: 0, p: 120 }, { q: 200, p: 60 }]
  it('K を渡さないときと K = 1 は同じ結果（0.3.0 と同じ）', () => {
    expect(judgeMover(40, 150, null, pq, null, 1.2, 1)).toEqual(judgeMover(40, 150, null, pq, null, 1.2))
  })
  it('必要静圧は 損失の合計 × K、運転点は K を掛けない損失で求める', () => {
    const v1 = judgeMover(40, 150, null, pq, null, 1.2)
    const vk = judgeMover(40, 150, null, pq, null, 1.2, 1.2)
    expect(vk.requiredPa).toBeCloseTo(48, 12)
    expect(vk.lossPa).toBe(40)
    expect(vk.safetyFactor).toBe(1.2)
    expect(vk.k).toBe(v1.k)
    expect(vk.operating).toEqual(v1.operating)
    expect(vk.marginPa).toBeCloseTo(v1.marginPa! - 8, 12)
    expect(vk.summary).toContain('余裕率 1.20')
  })
  it('K で合否が変わる（設定風量で出せる静圧 75 Pa に対し、損失 70 Pa は合格・K 1.1 で 77 Pa は不合格）。足りないのは余裕だけと分かる', () => {
    expect(judgeMover(70, 150, null, pq, null, 1.2).level).toBe('ok')
    const v = judgeMover(70, 150, null, pq, null, 1.2, 1.1)
    expect(v.level).toBe('ng')
    expect(v.marginOnly).toBe(true)
    expect(v.summary).toContain('余裕を見込まなければ設定風量は出る見込み')
    expect(v.summary).not.toContain('設定風量を確保できません')
    // 損失の合計でも出せないなら、余裕だけの不足ではない
    expect(judgeMover(80, 150, null, pq, null, 1.2, 1.1).marginOnly).toBe(false)
    // 機外静圧だけのとき
    expect(judgeMover(70, 150, 75, null, null, 1.2, 1.1)).toMatchObject({ level: 'ng', marginOnly: true })
  })
  it('特性の範囲の外（右端より多い風量）で、K を掛けなければ右端で足りるなら ng ではなく「判定できない」', () => {
    const short = [{ q: 0, p: 120 }, { q: 100, p: 80 }]
    // 損失 150 Pa・設定 150 m³/h → 右端 100 m³/h で要るのは 66.7 Pa（K なし）／86.7 Pa（K 1.3）。右端は 80 Pa
    expect(judgeMover(150, 150, null, short, null, 1.2).level).toBe('insufficient')
    expect(judgeMover(150, 150, null, short, null, 1.2, 1.3).level).toBe('insufficient')
    // K を掛けなくても右端で足りないなら ng のまま
    expect(judgeMover(200, 150, null, short, null, 1.2, 1.3).level).toBe('ng')
  })
  it('点検: 余裕だけ足りないときは warn の margin-short（flow-short の error ではない）', () => {
    const e = createDuctLoss(ROUGH)
    const s0 = sysWith(reducer())
    const calc0 = e.calcSystem(s0, 1.2)
    const loss = calc0.fanRequiredPa
    // 損失の合計ちょうどを出せる機外静圧の機器に K 1.1 → 余裕だけ足りない
    const s = { ...s0, nodes: { ...s0.nodes, fan: { ...s0.nodes.fan, params: { ...s0.nodes.fan.params, maxStaticPa: loss + 0.01 } as NodeParams } } }
    const ids = diagnose({ schemaVersion: 4, rho: 1.2, systems: [s], safetyFactor: 1.1 }, { [s.id]: e.calcSystem(s, 1.2) }).map(i => i.id)
    expect(ids.some(i => i.includes('fan-margin-short'))).toBe(true)
    expect(ids.some(i => i.includes('fan-flow-short'))).toBe(false)
  })
  it('送風機の一覧は損失の合計と K を持ち、必要静圧は掛けた値', () => {
    const e = createDuctLoss(ROUGH)
    const s = sysWith(reducer())
    const calc = e.calcSystem(s, 1.2)
    const [row] = collectMovers([s], { [s.id]: calc }, 1.2, 1.1)
    expect(row.lossPa).toBe(calc.fanRequiredPa)
    expect(row.requiredPa).toBeCloseTo(calc.fanRequiredPa * 1.1, 12)
    expect(row.verdict.requiredPa).toBeCloseTo(row.requiredPa, 12)
  })
  it('点検: 1 未満・2 を超える・正でない K を知らせる', () => {
    const e = createDuctLoss(ROUGH)
    const s = sysWith(reducer())
    const calcs = { [s.id]: e.calcSystem(s, 1.2) }
    const ids = (sf: number | null) => diagnose({ schemaVersion: 4, rho: 1.2, systems: [s], safetyFactor: sf }, calcs).map(i => i.id)
    expect(ids(0.9)).toContain('payload:safety-factor-below-one')
    expect(ids(2.5)).toContain('payload:safety-factor-large')
    expect(ids(-1)).toContain('payload:safety-factor-invalid')
    expect(ids(1.1).some(i => i.includes('safety-factor'))).toBe(false)
    expect(ids(null).some(i => i.includes('safety-factor'))).toBe(false)
  })
})

describe('係数の検査と識別', () => {
  it('新しい欄を渡さない係数の識別は変わらない・渡すと変わる', () => {
    expect(coefficientFingerprint({ ...ROUGH })).toBe(coefficientFingerprint(ROUGH))
    expect(coefficientFingerprint(WITH_OPTIONS)).not.toBe(coefficientFingerprint(ROUGH))
    expect(validateCoefficients(WITH_OPTIONS)).toEqual([])
  })
  it('径の変わり目の表の面積比が逆向き・式の出典が無いなどは検査で止める', () => {
    const bad: DesignCoefficients = { ...WITH_OPTIONS, reducer: { ...WITH_OPTIONS.reducer!, abruptExpansion: [[1.5, 0.2]] },
      friction: { ...(WITH_OPTIONS.friction as Extract<DesignCoefficients['friction'], { model: 'roughness' }>), formulaSource: '' } }
    const errs = validateCoefficients(bad)
    expect(errs.some(e => e.includes('abruptExpansion'))).toBe(true)
    expect(errs.some(e => e.includes('formulaSource'))).toBe(true)
  })
})
