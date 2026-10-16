import type { BendAngle, CoefficientsStamp, DuctLossPayload, DuctNode, DuctSystem, NodeKind, NodeParams, RouteResult, SystemType } from './types'
import { coefficientFingerprint, type DesignCoefficients } from './coefficients'
import { ENGINE_VERSION } from './version'
import { RHO_DEFAULT } from './physics'
import { DEFAULT_SYSTEM_NAME } from './payload'
import { newId } from './id'

// ─────────────────────────────────────────────────────────────
// 部材・系統をつくる（既定値は設計係数から）
// ─────────────────────────────────────────────────────────────

/** 部材の種類の名前（画面・計算書・点検の文で使う） */
export const NODE_KIND_LABEL: Record<NodeKind, string> = {
  fan: 'ファン',
  duct: 'ダクト',
  filter: 'フィルター',
  branch: '分岐',
  reducer: 'レデューサ',
  aircon: 'エアコン',
  terminal: '端末',
}

/** 新しく置く部材の既定の入力値 */
export function defaultParams(coef: DesignCoefficients, kind: NodeKind): NodeParams {
  switch (kind) {
    case 'fan':
      // 粗さから λ を求める係数なら null（直管ごとに材料と風速で求める）。λ 一定の係数なら係数の λ
      return { kind: 'fan', maxStaticPa: null, notch: '', defaultLambda: coef.friction?.model === 'roughness' ? null : coef.lambda }
    case 'duct':
      return { kind: 'duct', diameterMm: 150, lengthM: 1.0, bendAngleDeg: 90 as BendAngle, bendCount: 0, lambda: null }
    case 'filter':
      // ζ 入力を既定にする。以前は Pa 入力（目標 filterPa）なのに ζ は zeta.filter のままで、
      // 画面は「30 Pa」、計算は ζ 5 × 動圧 という食い違いのまま置かれていた。
      // filterPa は Pa 入力に切り替えたときの初期値として持つ
      return {
        kind: 'filter',
        diameterMm: 150,
        pressureMode: 'zeta',
        zeta: coef.zeta.filter,
        targetPa: coef.filterPa,
        filterNote: '',
      }
    case 'branch':
      return { kind: 'branch', diameterMm: 150, zeta: coef.zeta.branch }
    case 'reducer':
      // ζ は細い側（速い側）の動圧を基準にした値とする（縮小・拡大とも一般的な定義。SPEC.md §4）
      // 係数に径の変わり目の表があれば、形「急（段付き）」で表から ζ を求める（0.4.0〜。SPEC.md §4）
      return coef.reducer
        ? { kind: 'reducer', diameterFromMm: 150, diameterToMm: 100, zeta: coef.zeta.reducer, zetaBasis: 'small', form: 'abrupt' }
        : { kind: 'reducer', diameterFromMm: 150, diameterToMm: 100, zeta: coef.zeta.reducer, zetaBasis: 'small' }
    case 'aircon':
      return {
        kind: 'aircon',
        diameterMm: 200,
        // ζ 入力を既定にする（フィルターと同じ理由）。機外静圧と比べるなら本体の ζ は 0（SPEC.md §3）
        pressureMode: 'zeta',
        zeta: coef.zeta.aircon,
        targetPa: 0,
        supplyFromHexQh: null,
        returnQh: null,
        maxStaticPa: null,
        maxStaticAtQh: null,
      }
    case 'terminal':
      return {
        kind: 'terminal',
        diameterMm: 100,
        targetFlowQh: 30,
        // 基本はカタログから ζ を直接入力するモードを既定に。
        // 圧損を特定の Pa に合わせたい時のみ 'pa' モードに切替える運用。
        pressureMode: 'zeta',
        zeta: coef.zeta.terminal,
        targetPa: coef.terminalPa,
      }
  }
}

export function makeNode(
  coef: DesignCoefficients,
  kind: NodeKind,
  opts?: Partial<Pick<DuctNode, 'x' | 'y' | 'label' | 'parentId'>>,
): DuctNode {
  return {
    id: newId(),
    parentId: opts?.parentId ?? null,
    childIds: [],
    x: opts?.x ?? 0,
    y: opts?.y ?? 0,
    label: opts?.label ?? '',
    params: defaultParams(coef, kind),
  }
}

/**
 * 新規系統（送風機 1 個のみ）を作成。
 *
 * rootKind='aircon' はエアコン単独用。ダクト形エアコン自身が送風機なので、
 * 根をエアコンにすると循環風量・REC の入力欄がそのまま使え、
 * 必要静圧も 上流側（REC）＋ 下流側（SA）で評価される。
 */
export function makeSystem(
  coef: DesignCoefficients,
  type: SystemType,
  name?: string,
  rootKind: 'fan' | 'aircon' = 'fan',
): DuctSystem {
  const root = rootKind === 'aircon'
    ? makeNode(coef, 'aircon', { x: 100, y: 200, label: 'エアコン' })
    : makeNode(coef, 'fan', { x: 100, y: 200, label: 'ファン' })
  return {
    id: newId(),
    name: name ?? DEFAULT_SYSTEM_NAME[type],
    type,
    rootId: root.id,
    nodes: { [root.id]: root },
  }
}

/** 新規の計算の初期 payload（SA 系統 1 つ） */
export function makeInitialPayload(coef: DesignCoefficients): DuctLossPayload {
  return {
    schemaVersion: 4,
    rho: RHO_DEFAULT,
    systems: [makeSystem(coef, 'SA')],
    // 部材の既定値をどの係数で入れたかを残す（SPEC.md §2・§12）
    coefficientsStamp: coefficientsStampOf(coef),
  }
}

/** 係数セットと計算の版の記録（保存データ・計算結果に入れる） */
export function coefficientsStampOf(coef: DesignCoefficients): CoefficientsStamp {
  return { name: coef.name, source: coef.source, fingerprint: coefficientFingerprint(coef), engineVersion: ENGINE_VERSION }
}

/**
 * ルート末端の表示名。
 *
 * 末端は端末（ディフューザー等）とは限らない。OA 吸込のようにダクトや
 * フィルターで終わっている枝もルートとして数えるため、その場合は
 * 「ダクト（端末なし）」のように、端末を描いていないことが分かる名前を返す。
 */
export function routeEndLabel(system: DuctSystem, route: RouteResult): string {
  const node = system.nodes[route.terminalId]
  const name = node?.label?.trim()
  if (route.endsAtTerminal) return name || `端末 ${route.terminalId.slice(0, 6)}`
  const kind = node ? NODE_KIND_LABEL[node.params.kind] : '部材'
  return `${name || kind}（端末なし）`
}
