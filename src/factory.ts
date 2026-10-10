import type { BendAngle, DuctLossPayload, DuctNode, DuctSystem, NodeKind, NodeParams, RouteResult, SystemType } from './types'
import type { DesignCoefficients } from './coefficients'
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
      return { kind: 'fan', maxStaticPa: null, notch: '', defaultLambda: coef.lambda }
    case 'duct':
      return { kind: 'duct', diameterMm: 150, lengthM: 1.0, bendAngleDeg: 90 as BendAngle, bendCount: 0, lambda: null }
    case 'filter':
      return {
        kind: 'filter',
        diameterMm: 150,
        pressureMode: 'pa',
        zeta: coef.zeta.filter,
        targetPa: coef.filterPa,
        filterNote: '',
      }
    case 'branch':
      return { kind: 'branch', diameterMm: 150, zeta: coef.zeta.branch }
    case 'reducer':
      return { kind: 'reducer', diameterFromMm: 150, diameterToMm: 100, zeta: coef.zeta.reducer }
    case 'aircon':
      return {
        kind: 'aircon',
        diameterMm: 200,
        pressureMode: 'pa',
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
  }
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
