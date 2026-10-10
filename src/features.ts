import type { DuctLossPayload } from './types'

// ─────────────────────────────────────────────────────────────
// 機能の一覧と入／切
//
// 決まり:
//   **機能を切っても計算は変えない。画面と操作を隠すだけ。**
//   同じデータなら、誰が・どの設定で開いても必要静圧は同じでなければならない
//   （設定で計算書の数字が変わると、計算書どうしが食い違う）。
//   切った機能をデータが使っているときは `inUseButOff` で拾い、
//   「この機能は切られていますが、計算には入っています」と知らせる。
//
// この部品が持つのは「計算の部品が実際に持っている機能」だけ（DUCTLOSS_FEATURES）。
// 画面にだけある機能（ひな型・学習・表・数量拾いなど）は、使う側が定義を足して
// `defineFeatureSet([...DUCTLOSS_FEATURES, ...自分の定義])` で同じ決まりのまま扱う。
//
// 依存: ある機能を切ると、それに依存する機能も切れる（`dependsOn`）。
// ─────────────────────────────────────────────────────────────

export interface FeatureDef<K extends string = string> {
  key: K
  /** 画面に出す名前 */
  label: string
  /** 何ができる機能か（設定画面の説明） */
  description: string
  /** これが切れていると、この機能も切れる */
  dependsOn?: readonly K[]
  /**
   * データがこの機能を使っているか。切られているのに使っていれば知らせる。
   * 無い機能（表示だけの機能）は、データに跡を残さない。
   */
  usedBy?: (payload: DuctLossPayload) => boolean
}

export type FeatureFlags<K extends string> = Readonly<Record<K, boolean>>

export interface FeatureSet<K extends string> {
  readonly defs: readonly FeatureDef<K>[]
  readonly keys: readonly K[]
  /** すべて入 */
  readonly allOn: FeatureFlags<K>
  /**
   * 入／切の指定から、実際に使える機能の一覧を作る。
   * - 指定の無い機能は入（既定）
   * - 知らない名前・真偽でない値は無視する（古い設定・別の版の設定が残っていても壊れない）
   * - 依存先が切れている機能は切る（依存の連鎖もたどる）
   */
  resolve(overrides?: Partial<Record<string, unknown>> | null): FeatureFlags<K>
  /** 切られているのにデータが使っている機能 */
  inUseButOff(payload: DuctLossPayload, flags: FeatureFlags<K>): FeatureDef<K>[]
  /** 機能の定義を 1 つ引く */
  def(key: K): FeatureDef<K>
}

/**
 * 機能の一覧から、入／切の決まりを作る。
 * 鍵の重複・知らない依存先・依存の輪は、作る時点で例外にする（設定の誤りを黙って通さない）。
 */
export function defineFeatureSet<K extends string>(defs: readonly FeatureDef<K>[]): FeatureSet<K> {
  const byKey = new Map<K, FeatureDef<K>>()
  for (const d of defs) {
    if (byKey.has(d.key)) throw new Error(`機能の鍵が重複しています: ${d.key}`)
    byKey.set(d.key, Object.freeze({ ...d }))
  }
  for (const d of defs) {
    for (const dep of d.dependsOn ?? []) {
      if (!byKey.has(dep)) throw new Error(`機能 ${d.key} の依存先 ${dep} が一覧にありません`)
    }
  }
  // 依存の輪
  const state = new Map<K, 1 | 2>()
  const visit = (k: K) => {
    if (state.get(k) === 2) return
    if (state.get(k) === 1) throw new Error(`機能の依存が輪になっています: ${k}`)
    state.set(k, 1)
    for (const dep of byKey.get(k)!.dependsOn ?? []) visit(dep)
    state.set(k, 2)
  }
  for (const k of byKey.keys()) visit(k)

  const keys = Object.freeze([...byKey.keys()])
  const allOn = Object.freeze(Object.fromEntries(keys.map(k => [k, true])) as Record<K, boolean>)
  const frozenDefs = Object.freeze([...byKey.values()])

  return Object.freeze({
    defs: frozenDefs,
    keys,
    allOn,
    resolve(overrides?: Partial<Record<string, unknown>> | null): FeatureFlags<K> {
      const out = { ...allOn } as Record<K, boolean>
      for (const k of keys) {
        const v = overrides?.[k]
        if (typeof v === 'boolean') out[k] = v
      }
      let changed = true
      while (changed) {
        changed = false
        for (const d of frozenDefs) {
          if (out[d.key] && d.dependsOn?.some(x => !out[x])) { out[d.key] = false; changed = true }
        }
      }
      return Object.freeze(out)
    },
    inUseButOff(payload: DuctLossPayload, flags: FeatureFlags<K>): FeatureDef<K>[] {
      return frozenDefs.filter(d => !flags[d.key] && d.usedBy?.(payload))
    },
    def(key: K): FeatureDef<K> {
      const d = byKey.get(key)
      if (!d) throw new Error(`知らない機能です: ${key}`)
      return d
    },
  })
}

const anyNode = (p: DuctLossPayload, test: (n: DuctLossPayload['systems'][number]['nodes'][string]) => boolean) =>
  p.systems.some(s => Object.values(s.nodes).some(test))

export type DuctLossFeatureKey =
  | 'multiSystem' | 'aircon' | 'filter' | 'moverVerdict' | 'fanCurve' | 'flowStudy'
  | 'damperBalance' | 'ventilation' | 'airCondition' | 'diagnostics' | 'explain' | 'calcConditions'

/** 計算の部品が持っている機能（この部品の関数に裏付けがあるもの） */
export const DUCTLOSS_FEATURES: readonly FeatureDef<DuctLossFeatureKey>[] = Object.freeze([
  {
    key: 'multiSystem',
    label: '複数の系統',
    description: '1 つの計算に複数の系統（SA・RE）を持つ。切ると 1 系統だけを扱う',
    usedBy: p => p.systems.length > 1,
  },
  {
    key: 'aircon',
    label: 'エアコン（第 2 の送風機）',
    description: 'ダクト形エアコンを置き、循環風量・リターン量・機外静圧を扱う（SPEC.md §5・§6）',
    usedBy: p => anyNode(p, n => n.params.kind === 'aircon'),
  },
  {
    key: 'filter',
    label: 'フィルター部材',
    description: 'ダクトの途中にフィルターを置き、差圧を圧損に入れる',
    usedBy: p => anyNode(p, n => n.params.kind === 'filter'),
  },
  {
    key: 'moverVerdict',
    label: '送風機の合否判定',
    description: '必要静圧と設定風量を、送風機の機外静圧と比べて合否を出す（SPEC.md §7）',
    usedBy: p => anyNode(p, n =>
      (n.params.kind === 'fan' || n.params.kind === 'aircon') && n.params.maxStaticPa != null),
  },
  {
    key: 'fanCurve',
    label: 'P-Q 特性での判定',
    description: '送風機の P-Q 特性（風量と静圧の点列）を入れ、運転点で風量が確保できるかを見る',
    dependsOn: ['moverVerdict'],
    usedBy: p => anyNode(p, n =>
      (n.params.kind === 'fan' || n.params.kind === 'aircon') && (n.params.pqPoints?.length ?? 0) > 0),
  },
  {
    key: 'flowStudy',
    label: '風量の検討（倍率）',
    description: '端末の風量に一律の倍率を掛けて、圧損の変わり方を見る（保存しない）',
  },
  {
    key: 'damperBalance',
    label: 'ダンパ調整',
    description: '吹出側のルートの圧損を、一番大きいルートにそろえる ζ を端末に入れる／元に戻す（SPEC.md §10）',
  },
  {
    key: 'ventilation',
    label: '必要換気量',
    description: '気積と換気回数から必要換気量を出し、端末の風量の合計と照合する（SPEC.md §8）',
    usedBy: p => p.ventilation != null,
  },
  {
    key: 'airCondition',
    label: '空気条件（気温・標高）',
    description: '設計気温と標高から空気密度 ρ を求める。切ると ρ を直接入れる',
    usedBy: p => p.airTempC != null || (p.altitudeM ?? 0) !== 0,
  },
  {
    key: 'diagnostics',
    label: '点検',
    description: '描きかけの枝・孤立したルート・風量の不釣り合い・木の形の崩れなどを知らせる（SPEC.md §9）',
  },
  {
    key: 'explain',
    label: '計算の解説',
    description: '部材ごとに、式・数値の代入・結果と ΔP–Q 曲線を見せる',
  },
  {
    key: 'calcConditions',
    label: '計算条件の表',
    description: '設計係数の名前と出典・空気密度・λ・分岐 ζ・曲がりの相当長を計算書用の表にする',
  },
] satisfies FeatureDef<DuctLossFeatureKey>[])

const CORE_SET = defineFeatureSet(DUCTLOSS_FEATURES)

/** 計算の部品の機能の入／切（DUCTLOSS_FEATURES だけを扱う） */
export const resolveFeatures = (overrides?: Partial<Record<string, unknown>> | null) => CORE_SET.resolve(overrides)
/** 切られているのにデータが使っている機能（DUCTLOSS_FEATURES のうち） */
export const featuresInUseButOff = (payload: DuctLossPayload, flags: FeatureFlags<DuctLossFeatureKey>) =>
  CORE_SET.inUseButOff(payload, flags)
/** すべて入（DUCTLOSS_FEATURES） */
export const ALL_FEATURES_ON = CORE_SET.allOn
/** DUCTLOSS_FEATURES の鍵 */
export const DUCTLOSS_FEATURE_KEYS = CORE_SET.keys
export type DuctLossFeatures = FeatureFlags<DuctLossFeatureKey>
