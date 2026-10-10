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
  /**
   * 必要換気量と比べる風量の種類。給気系統があれば給気（第一種・第二種）、
   * 給気系統が無く排気系統があれば排気（第三種）。建築研究所 技術情報 第五章 6.4 と同じ分け方
   */
  basis: 'supply' | 'exhaust'
  /** basis の呼び名（「給気」「排気」） */
  basisLabel: string
  /** 必要換気量と比べた風量 (m³/h) */
  ventilationQh: number
  /** 比べた風量 − 必要換気量。負なら不足 */
  diffQh: number | null
  /** 必要換気量以上か（施行令 20条の8 は「以上」を求める。不足を許す幅は持たない）。必要換気量が出せないときは null */
  ok: boolean | null
  /** 実際の換気回数（比べた風量 ÷ 気積）。気積が無ければ null */
  actualAch: number | null
}

/** 計算の丸めだけを吸収する幅 (m³/h)。設計上の不足を許すための幅ではない */
const VENT_EPS_QH = 1e-6

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
 * 必要換気量と、設計した換気の風量を突き合わせる（SPEC.md §8）。
 *  - 比べる風量: 給気（SA 系統）の設計風量の合計。給気系統が無く排気（RE 系統）があれば排気の合計（第三種換気）。
 *    循環系統（根がエアコン）は外気を入れないので数えない。倍率はかけない
 *  - 足りている ⟺ 比べる風量 ≥ 必要換気量（施行令 20条の8 は「以上」。以前は 2% までの不足を足りているとしていた）
 */
export function checkVentilation(payload: DuctLossPayload): VentilationCheck {
  const v = payload.ventilation
  const requiredQh = v ? requiredVentilationQh(v) : null
  const volumeM3 = v ? resolveVolumeM3(v) : null
  const { supplyQh, exhaustQh } = designSupplyQh(payload)
  const hasSupply = payload.systems.some(s => s.type === 'SA' && !isCirculationSystem(s))
  const hasExhaust = payload.systems.some(s => s.type !== 'SA' && !isCirculationSystem(s))
  const basis: 'supply' | 'exhaust' = !hasSupply && hasExhaust ? 'exhaust' : 'supply'
  const ventilationQh = basis === 'supply' ? supplyQh : exhaustQh

  const diffQh = requiredQh != null ? ventilationQh - requiredQh : null
  return {
    volumeM3,
    requiredQh,
    supplyQh,
    exhaustQh,
    basis,
    basisLabel: basis === 'supply' ? '給気' : '排気',
    ventilationQh,
    diffQh,
    ok: diffQh == null ? null : diffQh >= -VENT_EPS_QH,
    actualAch: volumeM3 != null && volumeM3 > 0 ? ventilationQh / volumeM3 : null,
  }
}
