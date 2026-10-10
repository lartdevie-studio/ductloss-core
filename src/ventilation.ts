import type { DuctLossPayload, DuctSystem } from './types'
import { aggregateFlows } from './calculator'

// ─────────────────────────────────────────────────────────────
// 必要換気量（気積 × 換気回数）
//
// ダクトの圧損計算は「端末ごとの目標風量」を起点にするが、その風量が
// どこから来たのかはこれまでアプリの外にあった。ここで
// 「建物の気積 → 必要換気量 → 給気系統の合計と合っているか」までを持つ。
//
// 建築基準法 施行令 20条の8（住宅等の居室の機械換気設備）が 0.5回/h 以上。
// これを既定にして、入力欄で変えられるようにする。
//
// 端末の目標風量には**書き込まない**（照合だけ）。自動で按分すると
// 設計者が意図して振った風量を黙って上書きすることになるため。
// ─────────────────────────────────────────────────────────────

/** 建築基準法 施行令20条の8（住宅等の居室）の換気回数 */
export const ACH_DEFAULT = 0.5

export interface VentilationInput {
  /**
   * 気積 (m³)。直接入力。
   * 延床面積 × 平均天井高 で出すときは floorAreaM2 / ceilingHeightM を使う。
   */
  volumeM3: number | null
  /** 延床面積 (m²)。設定時は volumeM3 より優先して気積を算出する */
  floorAreaM2?: number | null
  /** 平均天井高 (m)。floorAreaM2 とセットで使う */
  ceilingHeightM?: number | null
  /** 換気回数 (回/h) */
  achPerH: number
  /** 備考（用途・根拠のメモ） */
  note?: string
}

export function makeDefaultVentilation(): VentilationInput {
  return { volumeM3: null, floorAreaM2: null, ceilingHeightM: null, achPerH: ACH_DEFAULT, note: '' }
}

/** 入力から気積を決める。延床×天井高があればそちらが正 */
export function resolveVolumeM3(v: VentilationInput): number | null {
  const area = v.floorAreaM2
  const h = v.ceilingHeightM
  if (area != null && area > 0 && h != null && h > 0) return area * h
  return v.volumeM3 != null && v.volumeM3 > 0 ? v.volumeM3 : null
}

/** 必要換気量 (m³/h) = 気積 × 換気回数。気積が決まらなければ null */
export function requiredVentilationQh(v: VentilationInput): number | null {
  const vol = resolveVolumeM3(v)
  if (vol == null) return null
  if (!(v.achPerH > 0)) return null
  return vol * v.achPerH
}

export interface VentilationCheck {
  /** 気積 (m³)。決まらなければ null */
  volumeM3: number | null
  /** 必要換気量 (m³/h) */
  requiredQh: number | null
  /** 給気（SA 系統）の総風量 (m³/h) */
  supplyQh: number
  /** 排気（RE 系統）の総風量 (m³/h) */
  exhaustQh: number
  /** 給気 − 必要換気量。負なら不足 */
  diffQh: number | null
  /** 足りているか（許容差内）。必要換気量が出せないときは null */
  ok: boolean | null
  /** 実際の換気回数（給気の総風量 ÷ 気積）。気積が無ければ null */
  actualAch: number | null
}

/**
 * 循環系統か（root がエアコン）。外気を入れないので換気量に数えない。
 * 循環風量を外気量に足すと、実際より多く換気しているように見えてしまう。
 * 給排気バランスの点検も同じ規則で除外する（画面に「給気の合計」が 2 つあって
 * 数字が食い違うのを防ぐ）。
 */
export function isCirculationSystem(sys: DuctSystem): boolean {
  return sys.nodes[sys.rootId]?.params.kind === 'aircon'
}

/**
 * 換気量として数える設計風量（m³/h）。倍率をかけない設計値。
 *
 * 検討モード（flowScale）の calc を使ってはいけない。必要換気量は設計に対する
 * 法令要件なので、倍率を受けない値と突き合わせる。calc.fanFlowQh は倍率込みなので、
 * ×2 にしただけで「不足」が「✓ 足りています」に反転し、実質換気回数にも嘘が出ていた。
 */
export function designSupplyQh(payload: DuctLossPayload): { supplyQh: number; exhaustQh: number } {
  let supplyQh = 0
  let exhaustQh = 0
  for (const sys of payload.systems) {
    if (isCirculationSystem(sys)) continue
    const { flows } = aggregateFlows(sys.nodes, sys.rootId, 1)
    const q = flows[sys.rootId] ?? 0
    if (sys.type === 'SA') supplyQh += q
    else exhaustQh += q
  }
  return { supplyQh, exhaustQh }
}

/**
 * 必要換気量と、設計した給気風量を突き合わせる。
 * 給気は SA 系統の設計風量の合計（循環系統を除く・倍率なし）。
 */
export function checkVentilation(payload: DuctLossPayload): VentilationCheck {
  const v = payload.ventilation
  const requiredQh = v ? requiredVentilationQh(v) : null
  const volumeM3 = v ? resolveVolumeM3(v) : null
  const { supplyQh, exhaustQh } = designSupplyQh(payload)

  const diffQh = requiredQh != null ? supplyQh - requiredQh : null
  // 許容差: 必要換気量の 2%（丸めと按分のぶれを吸収する）。最低 1 m³/h
  const tol = requiredQh != null ? Math.max(1, requiredQh * 0.02) : 0
  return {
    volumeM3,
    requiredQh,
    supplyQh,
    exhaustQh,
    diffQh,
    ok: diffQh == null ? null : diffQh >= -tol,
    actualAch: volumeM3 != null && volumeM3 > 0 ? supplyQh / volumeM3 : null,
  }
}
