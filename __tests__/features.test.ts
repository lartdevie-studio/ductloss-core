/**
 * 機能の入／切と設計係数の確かめ。
 *
 * 決まり: 機能を切っても計算は変えない（画面と操作を隠すだけ）。
 * 切った機能をデータが使っていれば `featuresInUseButOff` が拾う。
 */

import { describe, it, expect } from 'vitest'
import {
  ALL_FEATURES_ON, DUCTLOSS_FEATURES, DUCTLOSS_FEATURE_KEYS, resolveFeatures, featuresInUseButOff,
  defineFeatureSet, createDuctLoss, validateCoefficients,
  type DuctLossPayload,
} from '../src'
import { TEST_COEFFICIENTS } from './testCoefficients'

describe('機能の一覧', () => {
  it('一覧と鍵の並びが 1 対 1（重複・抜けが無い）', () => {
    expect(DUCTLOSS_FEATURES.map(d => d.key)).toEqual([...DUCTLOSS_FEATURE_KEYS])
  })

  it('依存先はすべて一覧にあり、自分自身には依存しない', () => {
    const keys = new Set<string>(DUCTLOSS_FEATURE_KEYS)
    for (const d of DUCTLOSS_FEATURES) {
      for (const dep of d.dependsOn ?? []) {
        expect(keys.has(dep)).toBe(true)
        expect(dep).not.toBe(d.key)
      }
    }
  })
})

describe('resolveFeatures', () => {
  it('指定なし → すべて入', () => {
    expect(resolveFeatures()).toEqual(ALL_FEATURES_ON)
    expect(resolveFeatures(null)).toEqual(ALL_FEATURES_ON)
  })

  it('切ったものだけ切れる', () => {
    const f = resolveFeatures({ explain: false })
    expect(f.explain).toBe(false)
    expect(f.diagnostics).toBe(true)
  })

  it('依存先を切ると依存している機能も切れる（送風機の判定 → P-Q 特性）', () => {
    const f = resolveFeatures({ moverVerdict: false, fanCurve: true })
    expect(f.moverVerdict).toBe(false)
    expect(f.fanCurve).toBe(false)
  })

  it('知らない名前・真偽でない値は無視する（古い設定が残っていても壊れない）', () => {
    const f = resolveFeatures({ nosuchFeature: false, explain: 'no' })
    expect(f).toEqual(ALL_FEATURES_ON)
  })

  it('結果は書き換えられない', () => {
    const f = resolveFeatures({}) as Record<string, boolean>
    expect(() => { f.explain = false }).toThrow()
  })
})

describe('defineFeatureSet（使う側が画面の機能を足す）', () => {
  it('部品の機能に自分の機能を足しても、同じ決まり（依存の連鎖・知らない鍵は無視）で動く', () => {
    const set = defineFeatureSet<string>([
      ...DUCTLOSS_FEATURES,
      { key: 'pdf', label: 'PDF', description: '計算書', dependsOn: ['calcConditions'] },
    ])
    expect(set.resolve({ calcConditions: false }).pdf).toBe(false)
    expect(set.resolve({ unknown: false })).toEqual(set.allOn)
  })

  it('鍵の重複・知らない依存先・依存の輪は、作る時点で例外', () => {
    expect(() => defineFeatureSet([{ key: 'a', label: '', description: '' }, { key: 'a', label: '', description: '' }])).toThrow(/重複/)
    expect(() => defineFeatureSet([{ key: 'a', label: '', description: '', dependsOn: ['b'] }])).toThrow(/依存先/)
    expect(() => defineFeatureSet([
      { key: 'a', label: '', description: '', dependsOn: ['b'] },
      { key: 'b', label: '', description: '', dependsOn: ['a'] },
    ])).toThrow(/輪/)
  })
})

describe('featuresInUseButOff（切っているがデータが使っている）', () => {
  const dl = createDuctLoss(TEST_COEFFICIENTS)
  const payload = (): DuctLossPayload => {
    const p = dl.makeInitialPayload()
    const sys = p.systems[0]
    const { nodes, nodeId } = dl.addChild(sys.nodes, sys.rootId, 'aircon')
    sys.nodes = nodes
    void nodeId
    return { ...p, ventilation: { volumeM3: 300, achPerH: 0.5 } }
  }

  it('エアコン入りのデータでエアコンを切ると知らせる。入のままなら知らせない', () => {
    const p = payload()
    expect(featuresInUseButOff(p, resolveFeatures({ aircon: false })).map(d => d.key)).toContain('aircon')
    expect(featuresInUseButOff(p, ALL_FEATURES_ON)).toEqual([])
  })

  it('表示だけの機能（解説・点検など）はデータに跡を残さないので知らせない', () => {
    expect(featuresInUseButOff(payload(), resolveFeatures({ diagnostics: false, explain: false }))).toEqual([])
  })

  it('計算は機能の入／切に依らない（計算の関数は機能を受け取らない）', () => {
    // 入／切は画面の側で使う。計算の入口が機能を受け取れないことを型で守っている。
    // ここでは同じデータの計算が 2 回とも同じになることだけ確かめる。
    const p = payload()
    const a = dl.calcSystem(p.systems[0], p.rho)
    const b = dl.calcSystem(p.systems[0], p.rho)
    expect(a).toEqual(b)
  })
})

describe('設計係数', () => {
  it('テスト用の係数は使える', () => {
    expect(validateCoefficients(TEST_COEFFICIENTS)).toEqual([])
  })

  it('出典が空・λ が 0・表が空 は作る時点で止める（黙って 0 Pa を返さない）', () => {
    const bad = { ...TEST_COEFFICIENTS, source: '', lambda: 0, bendEquivLength90M: {} }
    expect(validateCoefficients(bad).length).toBe(3)
    expect(() => createDuctLoss(bad)).toThrow(/設計係数が使えません/)
  })

  it('曲がりの相当長は表の一番近い径。同じ近さなら小さい径', () => {
    const dl = createDuctLoss(TEST_COEFFICIENTS)
    expect(dl.bendEquivLength90(100)).toBe(0.3)
    expect(dl.bendEquivLength90(120)).toBe(0.3)    // 100 が近い
    expect(dl.bendEquivLength90(125)).toBe(0.3)    // 100 と 150 が同じ近さ → 100
    expect(dl.bendEquivLength90(300)).toBe(0.6)    // 表の外は端
  })

  it('新しい部材の既定値は渡した係数から入る', () => {
    const dl = createDuctLoss(TEST_COEFFICIENTS)
    const br = dl.makeNode('branch').params
    expect(br.kind === 'branch' && br.zeta).toBe(1.0)
    const fan = dl.makeNode('fan').params
    expect(fan.kind === 'fan' && fan.defaultLambda).toBe(0.04)
  })

  it('作ったあとで元の係数を書き換えても、計算一式は変わらない（曲がりの表も）', () => {
    const table: Record<number, number> = { ...TEST_COEFFICIENTS.bendEquivLength90M }
    const c = { ...TEST_COEFFICIENTS, zeta: { ...TEST_COEFFICIENTS.zeta }, bendEquivLength90M: table }
    const dl = createDuctLoss(c)
    c.zeta.branch = 99
    table[100] = 99
    const br = dl.makeNode('branch').params
    expect(br.kind === 'branch' && br.zeta).toBe(1.0)
    expect(dl.bendEquivLength90(100)).toBe(0.3)
  })
})
