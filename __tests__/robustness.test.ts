/**
 * 壊れたデータ・紛らわしい入力で、計算・点検・解説が嘘をつかないこと（2026-10-10 の点検で見つかったもの）。
 *
 * 1. 親子が輪になったデータ: 以前は確かめをすり抜け、計算が終わらなかった（親の輪）／
 *    スタックがあふれた（子の輪）。→ 確かめではじき、計算も止まり、点検が知らせる
 * 2. リターン量を入れたエアコン: 点検が使われていない「熱交からの SA」の入力と比べ、
 *    「熱交換器からのSAが吹出合計を超えています」と誤って出していた
 * 3. 解説: 分岐・端末の径を保存値で書き、計算（接続ダクトから読んだ径）と食い違っていた。
 *    エアコンの内訳もリターン量を無視していた
 */
import { describe, it, expect } from 'vitest'
import {
  createDuctLoss, diagnose, isValidPayloadV4, structureIssues, balanceTerminals,
  type DuctLossPayload, type DuctNode, type DuctSystem, type NodeParams,
} from '../src'
import { TEST_COEFFICIENTS } from './testCoefficients'

const dl = createDuctLoss(TEST_COEFFICIENTS)

type Spec = { id: string; parent: string | null; side?: 'upstream' | 'downstream'; params: NodeParams }
function build(specs: Spec[]): DuctSystem {
  const nodes: Record<string, DuctNode> = {}
  for (const s of specs) nodes[s.id] = { id: s.id, x: 0, y: 0, label: s.id, parentId: s.parent, childIds: [], side: s.side ?? 'downstream', params: s.params }
  for (const s of specs) if (s.parent && nodes[s.parent]) nodes[s.parent].childIds.push(s.id)
  return { id: 'sys', name: '系統', type: 'SA', rootId: specs[0].id, nodes }
}
const payloadOf = (sys: DuctSystem): DuctLossPayload => ({ schemaVersion: 4, rho: 1.2, systems: [sys] })
const fan = (): NodeParams => ({ kind: 'fan', maxStaticPa: null, notch: '', defaultLambda: 0.04 })
const duct = (d: 100 | 150 | 200, l: number): NodeParams => ({ kind: 'duct', diameterMm: d, lengthM: l, bendAngleDeg: 90, bendCount: 0, lambda: null })
const term = (q: number, d: 100 | 150 | 200 = 100): NodeParams => ({ kind: 'terminal', diameterMm: d, targetFlowQh: q, pressureMode: 'zeta', zeta: 1.2, targetPa: 0 })
const aircon = (returnQh: number | null, supply: number | null): NodeParams => ({
  kind: 'aircon', diameterMm: 200, pressureMode: 'zeta', zeta: 0.5, targetPa: 0,
  supplyFromHexQh: supply, returnQh, maxStaticPa: null, maxStaticAtQh: null,
})

describe('1. 親子が輪になったデータ', () => {
  const healthy = () => build([
    { id: 'fan', parent: null, params: fan() },
    { id: 'd1', parent: 'fan', params: duct(150, 3) },
    { id: 'd2', parent: 'd1', params: duct(150, 3) },
    { id: 't', parent: 'd2', params: term(100) },
  ])

  it('正しい木は輪とみなさない', () => {
    expect(structureIssues(healthy().nodes, 'fan')).toEqual([])
    expect(isValidPayloadV4(payloadOf(healthy()))).toBe(true)
  })

  it('親の輪（d1 の親が d2）: 確かめではじき、計算は止まり、点検が知らせる', () => {
    const sys = healthy()
    sys.nodes.d1 = { ...sys.nodes.d1, parentId: 'd2' }
    expect(isValidPayloadV4(payloadOf(sys))).toBe(false)
    const calc = dl.calcSystem(sys, 1.2)          // 以前はここで止まらなかった
    expect(Number.isFinite(calc.fanRequiredPa)).toBe(true)
    const issues = diagnose(payloadOf(sys), { sys: calc })
    expect(issues.some(i => i.id.includes('structure-cycle') && i.level === 'error')).toBe(true)
  })

  it('子の輪（d2 の子に d1）: 確かめではじき、計算はスタックをあふれさせない', () => {
    const sys = healthy()
    sys.nodes.d2 = { ...sys.nodes.d2, childIds: ['t', 'd1'] }
    expect(isValidPayloadV4(payloadOf(sys))).toBe(false)
    expect(() => dl.calcSystem(sys, 1.2)).not.toThrow()
  })

  it('どこにもつながらない部材は開ける（既存データを開けなくしない）が、点検が知らせる', () => {
    const sys = healthy()
    sys.nodes.lost = { id: 'lost', x: 0, y: 0, label: '迷子', parentId: null, childIds: [], side: 'downstream', params: duct(100, 1) }
    expect(isValidPayloadV4(payloadOf(sys))).toBe(true)
    const issues = diagnose(payloadOf(sys), { sys: dl.calcSystem(sys, 1.2) })
    expect(issues.some(i => i.id.includes('structure-orphan') && i.nodeId === 'lost')).toBe(true)
  })

  it('同じ部材が 2 か所の子: 点検が知らせる', () => {
    const sys = healthy()
    sys.nodes.fan = { ...sys.nodes.fan, childIds: ['d1', 'd2'] }
    const kinds = structureIssues(sys.nodes, 'fan').map(i => i.kind)
    expect(kinds).toContain('shared-child')
    expect(kinds).toContain('parent-mismatch')
  })
})

describe('2. リターン量を入れたエアコンの点検', () => {
  /** fan → SA → エアコン → 吹出 400、エアコンの吸込側に REC 端末 */
  const withAircon = (returnQh: number | null, supply: number | null) => build([
    { id: 'fan', parent: null, params: fan() },
    { id: 'oa', parent: 'fan', side: 'upstream', params: duct(150, 2) },
    { id: 'hood', parent: 'oa', side: 'upstream', params: term(150, 150) },
    { id: 'sa', parent: 'fan', params: duct(150, 4) },
    { id: 'ac', parent: 'sa', params: aircon(returnQh, supply) },
    { id: 'blow', parent: 'ac', params: duct(200, 6) },
    { id: 'tb', parent: 'blow', params: term(400, 200) },
    { id: 'rec', parent: 'ac', side: 'upstream', params: duct(200, 2) },
    { id: 'grill', parent: 'rec', side: 'upstream', params: term(250, 200) },
  ])
  const ids = (sys: DuctSystem, scale = 1) =>
    diagnose(payloadOf(sys), { sys: dl.calcSystem(sys, 1.2, scale) }).map(i => i.id)

  it('リターン 250 を入れ、熱交 SA の欄に古い値 999 が残っていても「熱交SA超過」は出ない', () => {
    expect(ids(withAircon(250, 999)).some(id => id.includes('aircon-over-supply'))).toBe(false)
  })

  it('リターン量が吹出合計（400）を超えたら、リターン超過のエラーを出す', () => {
    expect(ids(withAircon(500, null)).some(id => id.includes('aircon-over-return'))).toBe(true)
    expect(ids(withAircon(300, null)).some(id => id.includes('aircon-over-return'))).toBe(false)
  })

  it('リターン量を入れない旧来の入力: 熱交 SA が吹出合計を超えたらエラー（従来どおり）', () => {
    expect(ids(withAircon(null, 500)).some(id => id.includes('aircon-over-supply'))).toBe(true)
    expect(ids(withAircon(null, 300)).some(id => id.includes('aircon-over-supply'))).toBe(false)
  })

  it('風量の倍率をかけても、入力との比べ方は変わらない（設計風量で見る）', () => {
    // 熱交 SA 300 は吹出 400 以内。倍率 0.5 で吹出 200 になっても「超過」にしない
    expect(ids(withAircon(null, 300), 0.5).some(id => id.includes('aircon-over-supply'))).toBe(false)
  })
})

describe('3. 解説は計算と同じ値で書く', () => {
  it('端末の径は接続ダクトから読んだ径（保存値 φ100 ではなく φ150）で式を書く', () => {
    const sys = build([
      { id: 'fan', parent: null, params: fan() },
      { id: 'd', parent: 'fan', params: duct(150, 3) },
      { id: 't', parent: 'd', params: term(120, 100) },   // 保存値は φ100 だが接続ダクトは φ150
    ])
    const calc = dl.calcSystem(sys, 1.2)
    const ex = dl.explainNode(sys.nodes.t, calc.byNode.t, 1.2, { fanFlowQh: calc.fanFlowQh, fanRequiredPa: calc.fanRequiredPa, nodes: sys.nodes })
    const area = ex.steps.find(s => s.label === '断面積 A')!
    expect(area.substitution).toContain('0.150')
    // 断面積から求めた風速が計算の風速と一致する
    const A = Math.PI * 0.15 * 0.15 / 4
    expect(120 / 3600 / A).toBeCloseTo(calc.byNode.t.velocity, 9)
  })

  it('エアコンの内訳はリターン量の規則で書く（循環 400・リターン 250 → 熱交供給 150）', () => {
    const sys = build([
      { id: 'fan', parent: null, params: fan() },
      { id: 'sa', parent: 'fan', params: duct(150, 4) },
      { id: 'ac', parent: 'sa', params: aircon(250, 999) },
      { id: 'blow', parent: 'ac', params: duct(200, 6) },
      { id: 'tb', parent: 'blow', params: term(400, 200) },
      { id: 'rec', parent: 'ac', side: 'upstream', params: duct(200, 2) },
      { id: 'grill', parent: 'rec', side: 'upstream', params: term(250, 200) },
    ])
    const calc = dl.calcSystem(sys, 1.2)
    const ex = dl.explainNode(sys.nodes.ac, calc.byNode.ac, 1.2, {
      fanFlowQh: calc.fanFlowQh, fanRequiredPa: calc.fanRequiredPa, nodes: sys.nodes, secondaryMovers: calc.secondaryMovers,
    })
    const step = (label: string) => ex.steps.find(s => s.label === label)?.result
    expect(step('循環風量 Q_循環')).toBe('400 m³/h')
    expect(step('追加吸込（リターン）')).toBe('250 m³/h')
    expect(step('熱交換器からの供給')).toBe('150 m³/h')
    expect(calc.secondaryMovers[0].supplyFromHexQh).toBeCloseTo(150, 9)
  })
})

describe('4. 送風機の λ が空・壊れた値でも黙って 0 Pa にしない', () => {
  const withFanLambda = (v: unknown) => {
    const sys = build([
      { id: 'fan', parent: null, params: fan() },
      { id: 'd', parent: 'fan', params: duct(150, 5) },
      { id: 't', parent: 'd', params: term(100, 150) },
    ])
    const f = sys.nodes.fan
    sys.nodes.fan = { ...f, params: { ...f.params, defaultLambda: v } as NodeParams }
    return sys
  }
  const ref = dl.calcSystem(withFanLambda(TEST_COEFFICIENTS.lambda), 1.2).byNode.d.lossPa

  it.each([['未設定', undefined], ['null', null], ['0', 0], ['負', -0.02], ['NaN', NaN]])('送風機の λ が %s → 係数の λ を使う', (_l, v) => {
    const calc = dl.calcSystem(withFanLambda(v), 1.2)
    expect(calc.byNode.d.lossPa).toBeCloseTo(ref, 12)
    expect(calc.fanRequiredPa).toBeGreaterThan(0)
  })

  it('数でない圧損があれば点検が error を出す（径が壊れている）', () => {
    const sys = withFanLambda(0.04)
    const d = sys.nodes.d
    sys.nodes.d = { ...d, params: { ...d.params, diameterMm: undefined } as unknown as NodeParams }
    const calc = dl.calcSystem(sys, 1.2)
    const issues = diagnose(payloadOf(sys), { sys: calc })
    expect(issues.some(i => i.id.includes('non-finite') && i.level === 'error')).toBe(true)
  })
})

describe('5. ダンパ調整は送風機ごと（エアコンの昇圧分を主送風機に背負わせない）', () => {
  // 主送風機 ┬→ 長い幹 s1 → 登録エアコン → 長い吹出 r1 → tr1
  //          └→ 短い枝 s5 → 主送風機の端末 t5
  // 主送風機の下流側の最大は「エアコンの手前までの幹 s1」。t5 はそこにそろうべきで、
  // エアコンの先まで含めたルート（tr1）にそろえてはいけない。
  const sys = build([
    { id: 'fan', parent: null, params: fan() },
    { id: 'oa', parent: 'fan', side: 'upstream', params: duct(150, 2) },
    { id: 'hood', parent: 'oa', side: 'upstream', params: term(300, 150) },
    { id: 's1', parent: 'fan', params: duct(150, 10) },
    { id: 'ac', parent: 's1', params: aircon(150, null) },
    { id: 'r1', parent: 'ac', params: duct(150, 12) },
    { id: 'tr1', parent: 'r1', params: term(250, 150) },
    { id: 'rec', parent: 'ac', side: 'upstream', params: duct(200, 1) },
    { id: 'grill', parent: 'rec', side: 'upstream', params: term(150, 200) },
    { id: 's5', parent: 'fan', params: duct(100, 1) },
    { id: 't5', parent: 's5', params: term(50, 100) },
  ])
  const calc = dl.calcSystem(sys, 1.2)
  const after = dl.calcSystem(balanceTerminals(sys, calc), 1.2)
  const total = (c: typeof calc, id: string) => c.routes.find(r => r.terminalId === id)!.totalPa

  it('前提: エアコンが第 2 の送風機で、主送風機の下流側の最大はエアコンの手前までの幹', () => {
    expect(calc.secondaryMovers.map(m => m.nodeId)).toEqual(['ac'])
    expect(calc.fanDownstreamPa).toBeCloseTo(calc.byNode.s1.lossPa, 9)
    expect(total(calc, 't5')).toBeLessThan(calc.fanDownstreamPa)
  })

  it('調整しても、主送風機とエアコンの必要静圧は変わらない', () => {
    expect(after.fanRequiredPa).toBeCloseTo(calc.fanRequiredPa, 9)
    expect(after.secondaryMovers[0].requiredPa).toBeCloseTo(calc.secondaryMovers[0].requiredPa, 9)
  })

  it('主送風機の端末 t5 は、主送風機の下流側 − 0.01 Pa にそろい、エアコンの先のルートには合わせない', () => {
    expect(total(after, 't5')).toBeCloseTo(calc.fanDownstreamPa - 0.01, 6)
    expect(total(after, 't5')).toBeLessThan(total(calc, 'tr1') - 1)
  })
})
