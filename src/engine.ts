import type { DesignCoefficients } from './coefficients'
import { validateCoefficients, bendEquivLength90 } from './coefficients'
import type { CalcResult, DuctNode, DuctSystem, FlowSide, NodeKind, NodeResult, SystemType } from './types'
import {
  bendEquivLength, calcNodeResult, calcSystem, ductBendEquivLength, resetTerminals,
} from './calculator'
import { defaultParams, makeInitialPayload, makeNode, makeSystem } from './factory'
import { addChild, insertOnEdge } from './tree'
import { explainNode, type SystemContext } from './explain'
import { collectCalcConditions } from './report'
import type { DuctLossPayload } from './types'

/**
 * 設計係数を結び付けた計算一式。
 *
 * ```ts
 * const dl = createDuctLoss(myCoefficients)
 * const calc = dl.calcSystem(system, 1.2)
 * ```
 *
 * 係数の要らない関数（風量の集計・判定・点検など）は index から直接使う。
 * 係数が使えない値なら、作る時点で例外にする（黙って 0 Pa を返さない）。
 */
export function createDuctLoss(coefficients: DesignCoefficients) {
  const errors = validateCoefficients(coefficients)
  if (errors.length > 0) throw new Error(`設計係数が使えません: ${errors.join(' / ')}`)
  // 入れ子まで写して凍らせる。作ったあとで元の係数（曲がりの表を含む）を書き換えても、
  // 計算一式の結果が変わったり、確かめをすり抜けたりしないように
  const coef: DesignCoefficients = Object.freeze({
    ...coefficients,
    zeta: Object.freeze({ ...coefficients.zeta }),
    bendEquivLength90M: Object.freeze({ ...coefficients.bendEquivLength90M }),
  })
  return {
    coefficients: coef,
    calcSystem: (system: DuctSystem, rho: number, flowScale = 1): CalcResult => calcSystem(coef, system, rho, flowScale),
    calcNodeResult: (nodes: Record<string, DuctNode>, node: DuctNode, flowQh: number, rho: number): NodeResult =>
      calcNodeResult(coef, nodes, node, flowQh, rho),
    bendEquivLength90: (diameterMm: number) => bendEquivLength90(coef, diameterMm),
    bendEquivLength: (diameterMm: number, angleDeg: number, count: number) => bendEquivLength(coef, diameterMm, angleDeg, count),
    ductBendEquivLength: (diameterMm: number, params: Parameters<typeof ductBendEquivLength>[2]) =>
      ductBendEquivLength(coef, diameterMm, params),
    resetTerminals: (system: DuctSystem, calc?: CalcResult) => resetTerminals(coef, system, calc),
    defaultParams: (kind: NodeKind) => defaultParams(coef, kind),
    makeNode: (kind: NodeKind, opts?: Parameters<typeof makeNode>[2]) => makeNode(coef, kind, opts),
    makeSystem: (type: SystemType, name?: string, rootKind: 'fan' | 'aircon' = 'fan') => makeSystem(coef, type, name, rootKind),
    makeInitialPayload: () => makeInitialPayload(coef),
    addChild: (nodes: Record<string, DuctNode>, parentId: string, kind: NodeKind, sideOverride?: FlowSide) =>
      addChild(coef, nodes, parentId, kind, sideOverride),
    insertOnEdge: (nodes: Record<string, DuctNode>, parentId: string, childId: string, kind: NodeKind) =>
      insertOnEdge(coef, nodes, parentId, childId, kind),
    explainNode: (node: DuctNode, result: NodeResult, rho: number, sys?: SystemContext) => explainNode(coef, node, result, rho, sys),
    /** 計算書の計算条件の表。先頭の行は設計係数の名前と出典 */
    collectCalcConditions: (payload: DuctLossPayload) => collectCalcConditions(coef, payload),
  }
}

export type DuctLossEngine = ReturnType<typeof createDuctLoss>
