/**
 * 圧損計算の「決まり事」を、どんな形の系統でも成り立つ性質として確かめる。
 *
 * 個別の数値の照合は、使う側がその係数で行う。
 * こちらは式を変えても崩れてはいけない性質を見る。
 *
 *   1. ダクト 1 本はダルシー・ワイスバッハの式 ΔP = λ·(L/D)·ρv²/2 そのもの
 *   2. ルートの合計 ＝ 経路上の部材の圧損の和（吸込側のルートは送風機本体を数えない。
 *      本体の通過圧損は吹出側で 1 回だけ数える＝SPEC.md §6）
 *   3. 必要静圧 ＝ 上流側 ＋ 下流側（内訳と合計が食い違わない）
 *   4. 圧損はすべて 0 以上の有限の数
 *   5. 風量の保存（分岐の手前の風量 ＝ 分岐の先の風量の和）
 *   6. 風量を k 倍 → 圧損はすべて k² 倍（すべて動圧に比例する式なので）
 *   7. 空気密度を k 倍 → 圧損はすべて k 倍
 *   8. 径を 2 倍（直管・λ 一定・相当長なし）→ 1 m あたり圧損は 1/32
 *
 * 外部の資料の数値は使わない。係数は架空の値（testCoefficients.ts）。
 */

import { describe, it, expect } from 'vitest'
import {
  createDuctLoss, calcVelocity, dynamicPressure, frictionPerMeter, canBalanceTerminals, balanceTerminals,
  normalizeFanPoints, interpFanP, defaultPathLabel, RHO_DEFAULT,
  type CalcResult, type DuctDiameter, type DuctNode, type DuctSystem, type FlowSide, type NodeParams,
} from '../src'
import { TEST_COEFFICIENTS } from './testCoefficients'

const dl = createDuctLoss(TEST_COEFFICIENTS)
const calcSystem = (s: DuctSystem, rho: number, k = 1) => dl.calcSystem(s, rho, k)
const LAMBDA_DEFAULT = TEST_COEFFICIENTS.lambda

// ── 系統を組む小道具 ──────────────────────────────────────────

type Spec = { id: string; parent: string | null; side?: FlowSide; params: NodeParams }

function build(specs: Spec[], type: DuctSystem['type'] = 'SA'): DuctSystem {
  const nodes: Record<string, DuctNode> = {}
  for (const s of specs) {
    nodes[s.id] = { id: s.id, x: 0, y: 0, label: s.id, parentId: s.parent, childIds: [], side: s.side ?? 'downstream', params: s.params }
  }
  for (const s of specs) if (s.parent) nodes[s.parent].childIds.push(s.id)
  return { id: 'sys', name: '系統', type, rootId: specs[0].id, nodes }
}

const fan = (): NodeParams => ({ kind: 'fan', maxStaticPa: null, notch: '', defaultLambda: LAMBDA_DEFAULT })
const duct = (d: DuctDiameter, l: number, bends = 0): NodeParams =>
  ({ kind: 'duct', diameterMm: d, lengthM: l, bendAngleDeg: 90, bendCount: bends, lambda: null })
const term = (q: number, zeta = 1.5, d: DuctDiameter = 100): NodeParams =>
  ({ kind: 'terminal', diameterMm: d, targetFlowQh: q, pressureMode: 'zeta', zeta, targetPa: 0 })
const branch = (zeta = 1.0): NodeParams => ({ kind: 'branch', diameterMm: 150, zeta })
const reducer = (from: DuctDiameter, to: DuctDiameter): NodeParams => ({ kind: 'reducer', diameterFromMm: from, diameterToMm: to, zeta: 0.35 })
const filter = (zeta = 4): NodeParams => ({ kind: 'filter', diameterMm: 150, pressureMode: 'zeta', zeta, targetPa: 0, filterNote: '' })
const aircon = (returnQh: number | null): NodeParams => ({
  kind: 'aircon', diameterMm: 200, pressureMode: 'zeta', zeta: 0.8, targetPa: 0,
  supplyFromHexQh: null, returnQh, maxStaticPa: null, maxStaticAtQh: null,
})

/** 熱交換器の給気: 吸込側（OA ダクト＋フィルター＋フード）と、吹出側（主管→分岐→2 口、片方はレデューサ経由） */
const hexSupply = () => build([
  { id: 'fan', parent: null, params: fan() },
  { id: 'oa', parent: 'fan', side: 'upstream', params: duct(150, 3, 1) },
  { id: 'flt', parent: 'oa', side: 'upstream', params: filter() },
  { id: 'hood', parent: 'flt', side: 'upstream', params: term(180, 2.2, 150) },
  { id: 'main', parent: 'fan', params: duct(150, 6, 2) },
  { id: 'br', parent: 'main', params: branch() },
  { id: 'd1', parent: 'br', params: duct(100, 4, 1) },
  { id: 't1', parent: 'd1', params: term(80) },
  { id: 'd2', parent: 'br', params: duct(150, 2) },
  { id: 'red', parent: 'd2', params: reducer(150, 100) },
  { id: 'd3', parent: 'red', params: duct(100, 5, 3) },
  { id: 't2', parent: 'd3', params: term(100) },
])

/** 熱交換器の給気の途中に、第 2 の送風機として登録されたエアコン（リターン量あり） */
const hexWithAircon = () => build([
  { id: 'fan', parent: null, params: fan() },
  { id: 'oa', parent: 'fan', side: 'upstream', params: duct(150, 2) },
  { id: 'hood', parent: 'oa', side: 'upstream', params: term(150, 2.2, 150) },
  { id: 'sa', parent: 'fan', params: duct(150, 4, 1) },
  { id: 'ac', parent: 'sa', params: aircon(250) },
  { id: 'blow', parent: 'ac', params: duct(200, 6, 2) },
  { id: 'br', parent: 'blow', params: branch() },
  { id: 'b1', parent: 'br', params: duct(150, 3) },
  { id: 'tb1', parent: 'b1', params: term(200, 1.2, 150) },
  { id: 'b2', parent: 'br', params: duct(150, 5, 1) },
  { id: 'tb2', parent: 'b2', params: term(200, 1.2, 150) },
  { id: 'rec', parent: 'ac', side: 'upstream', params: duct(200, 2) },
  { id: 'grill', parent: 'rec', side: 'upstream', params: term(250, 0.6, 200) },
])

/** エアコンだけの系統（根がエアコン） */
const airconOnly = () => build([
  { id: 'ac', parent: null, params: aircon(null) },
  { id: 'blow', parent: 'ac', params: duct(200, 8, 2) },
  { id: 't', parent: 'blow', params: term(500, 1.0, 200) },
  { id: 'rec', parent: 'ac', side: 'upstream', params: duct(200, 1) },
  { id: 'g', parent: 'rec', side: 'upstream', params: term(500, 0.6, 200) },
])

/** 吹出側だけの排気系統 */
const exhaustDownOnly = () => build([
  { id: 'fan', parent: null, params: fan() },
  { id: 'ea', parent: 'fan', params: duct(150, 3, 1) },
  { id: 'hood', parent: 'ea', params: term(150, 2.2, 150) },
], 'RE')

const SHAPES: [string, () => DuctSystem][] = [
  ['熱交換器の給気', hexSupply],
  ['熱交換器＋エアコン', hexWithAircon],
  ['エアコンだけ', airconOnly],
  ['吹出側だけの排気', exhaustDownOnly],
]

const relClose = (a: number, b: number, tol = 1e-9) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(tol * Math.max(1, Math.abs(a), Math.abs(b)))

// ── 1. 式そのもの ─────────────────────────────────────────────

describe('ダクト 1 本 ＝ ダルシー・ワイスバッハの式', () => {
  it('φ125・7 m・90 m³/h・ρ 1.2 を式から直接計算した値と一致する', () => {
    const sys = build([
      { id: 'fan', parent: null, params: fan() },
      { id: 'd', parent: 'fan', params: duct(125, 7) },
      { id: 't', parent: 'd', params: term(90, 0) },
    ])
    const r = calcSystem(sys, 1.2).byNode['d']
    const D = 0.125
    const v = (90 / 3600) / (Math.PI * D * D / 4)
    const expected = LAMBDA_DEFAULT * (7 / D) * (1.2 * v * v / 2)
    relClose(r.velocity, v)
    relClose(r.lossPa, expected)
    // 端末 ζ=0 なのでルート合計もダクトだけ
    relClose(calcSystem(sys, 1.2).fanRequiredPa, expected)
  })

  it('径を 2 倍にすると 1 m あたりの圧損は 1/32（v∝1/D²・動圧∝v²・摩擦∝1/D）', () => {
    const per = (d: number) => frictionPerMeter(LAMBDA_DEFAULT, d, dynamicPressure(RHO_DEFAULT, calcVelocity(150, d)))
    relClose(per(100) / per(200), 32)
  })
})

// ── 2〜8. 形によらない性質 ───────────────────────────────────

describe.each(SHAPES)('%s', (_name, make) => {
  const sys = make()
  const calc = calcSystem(sys, RHO_DEFAULT)

  it('計算ができている（ルートがあり、必要静圧が正）', () => {
    expect(calc.routes.length).toBeGreaterThan(0)
    expect(calc.fanRequiredPa).toBeGreaterThan(0)
  })

  it('圧損・風量・風速はすべて 0 以上の有限の数', () => {
    for (const r of Object.values(calc.byNode)) {
      for (const v of [r.flowQh, r.velocity, r.q, r.dpPerMeter, r.lossPa]) {
        expect(Number.isFinite(v)).toBe(true)
        expect(v).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('ルートの合計 ＝ 経路上の部材の圧損の和（吸込側は送風機本体を除く）', () => {
    for (const route of calc.routes) {
      const from = route.side === 'upstream' ? 1 : 0
      const sum = route.path.slice(from).reduce((s, id) => s + (calc.byNode[id]?.lossPa ?? 0), 0)
      relClose(route.totalPa, sum)
    }
  })

  it('必要静圧 ＝ 上流側 ＋ 下流側（主送風機・エアコンとも）', () => {
    relClose(calc.fanRequiredPa, calc.fanUpstreamPa + calc.fanDownstreamPa)
    for (const m of calc.secondaryMovers) {
      relClose(m.requiredPa, m.supplyCriticalPa + m.intakeCriticalPa)
    }
  })

  it('吹出側の風量の保存: 部材は、吹出側の子の風量の和を流す', () => {
    // エアコンは自分で循環風量を作るので、エアコン自身と、エアコンの手前の部材
    // （流れるのは熱交換器からの供給分だけ）は対象外。そちらは次の it で見る。
    for (const n of Object.values(sys.nodes)) {
      if (n.params.kind === 'aircon' || n.side === 'upstream') continue
      const kids = n.childIds.filter(c => sys.nodes[c].side !== 'upstream')
      if (kids.length === 0) continue
      if (kids.some(c => sys.nodes[c].params.kind === 'aircon')) continue
      const sum = kids.reduce((s, c) => s + calc.byNode[c].flowQh, 0)
      relClose(calc.byNode[n.id].flowQh, sum)
    }
  })

  it('エアコン: 循環 ＝ 供給 ＋ 追加吸込、手前のダクトには供給分だけが流れる', () => {
    for (const m of calc.secondaryMovers) {
      relClose(m.circulationQh, m.supplyFromHexQh + m.intakeQh)
      relClose(calc.byNode[m.nodeId].flowQh, m.circulationQh)
      const parent = sys.nodes[m.nodeId].parentId
      if (parent) relClose(calc.byNode[parent].flowQh, m.supplyFromHexQh)
    }
  })

  it('風量を k 倍すると、圧損はすべて k² 倍', () => {
    for (const k of [0.5, 1.3, 2]) {
      const scaled = calcSystem(sys, RHO_DEFAULT, k)
      for (const id of Object.keys(sys.nodes)) {
        relClose(scaled.byNode[id].lossPa, calc.byNode[id].lossPa * k * k, 1e-9)
      }
      relClose(scaled.fanRequiredPa, calc.fanRequiredPa * k * k)
      scaled.secondaryMovers.forEach((m, i) => relClose(m.requiredPa, calc.secondaryMovers[i].requiredPa * k * k))
    }
  })

  it('空気密度を k 倍すると、圧損はすべて k 倍（風量は変わらない）', () => {
    const k = 1.1
    const heavy = calcSystem(sys, RHO_DEFAULT * k)
    for (const id of Object.keys(sys.nodes)) {
      relClose(heavy.byNode[id].lossPa, calc.byNode[id].lossPa * k)
      relClose(heavy.byNode[id].flowQh, calc.byNode[id].flowQh)
    }
  })

  it('ダンパ調整は、どの送風機の必要静圧も変えない', () => {
    const after = calcSystem(balanceTerminals(sys, calc), RHO_DEFAULT)
    relClose(after.fanRequiredPa, calc.fanRequiredPa, 1e-9)
    after.secondaryMovers.forEach((m, i) => relClose(m.requiredPa, calc.secondaryMovers[i].requiredPa, 1e-9))
  })

  it('ダンパ調整は、押せるときだけ端末の ζ を変え、押したあとは押せない', () => {
    const can = canBalanceTerminals(sys, calc)
    const after = balanceTerminals(sys, calc)
    const changed = Object.keys(sys.nodes).some(id => {
      const a = sys.nodes[id].params, b = after.nodes[id].params
      return a.kind === 'terminal' && b.kind === 'terminal' && a.zeta !== b.zeta
    })
    expect(can).toBe(changed)
    if (can) {
      const again: CalcResult = calcSystem(after, RHO_DEFAULT)
      expect(canBalanceTerminals(after, again)).toBe(false)
    }
  })
})

// ── 送風機の特性の点列 ───────────────────────────────────────

describe('送風機の P-Q 特性の点列をそろえる', () => {
  it('同じ風量の点は後に書いた方を残し、風量順に並べる', () => {
    expect(normalizeFanPoints([{ q: 200, p: 60 }, { q: 100, p: 120 }, { q: 200, p: 50 }]))
      .toEqual([{ q: 100, p: 120 }, { q: 200, p: 50 }])
  })

  it('数でない点・負の風量は捨てる', () => {
    expect(normalizeFanPoints([{ q: NaN, p: 1 }, { q: 50, p: Infinity }, { q: -1, p: 10 }, { q: 80, p: 90 }]))
      .toEqual([{ q: 80, p: 90 }])
  })

  it('重複があっても補間は右端の 1 点に連続する', () => {
    const pts = [{ q: 100, p: 120 }, { q: 200, p: 60 }, { q: 200, p: 40 }]
    expect(interpFanP(pts, 200)).toBe(40)
    expect(interpFanP(pts, 199.999)).toBeCloseTo(40, 1)
  })
})

// ── 送風機一覧の経路の書き方 ─────────────────────────────────

describe('経路の書き方は、描いてある側だけを出す', () => {
  it('両側あり → 「OA → SA」', () => expect(defaultPathLabel(hexSupply(), false)).toBe('OA → SA'))
  it('排気で吹出側だけ → 「EA（吹出側のみ）」', () => expect(defaultPathLabel(exhaustDownOnly(), false)).toBe('EA（吹出側のみ）'))
  it('給気で吸込側だけ → 「OA（吸込側のみ）」', () => {
    const sys = build([
      { id: 'fan', parent: null, params: fan() },
      { id: 'oa', parent: 'fan', side: 'upstream', params: duct(150, 2) },
    ])
    expect(defaultPathLabel(sys, false)).toBe('OA（吸込側のみ）')
  })
  it('根がエアコン → 「RE(REC) → SA」', () => expect(defaultPathLabel(airconOnly(), true)).toBe('RE(REC) → SA'))
})
