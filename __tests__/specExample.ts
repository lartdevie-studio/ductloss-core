/**
 * SPEC.md 付録 A「手計算の例題」の系統と係数。
 *
 * 係数は例題のための架空の値（設計に使わないこと）。数字を追いやすいように丸めてある。
 * SPEC.md に書いた数値がこの系統の計算結果と一致することは specExample.test.ts が見張る。
 */
import type { DesignCoefficients, DuctNode, DuctSystem, NodeParams } from '../src'

export const EXAMPLE_COEFFICIENTS: DesignCoefficients = {
  name: '例題用（架空）',
  source: 'SPEC.md 付録 A の例題のために作った値。設計に使わないこと',
  lambda: 0.03,
  bendEquivLength90M: { 100: 0.25, 125: 0.3 },
  zeta: { branch: 1.0, reducer: 0.3, terminal: 2.0, filter: 5.0, aircon: 0 },
  terminalPa: 5,
  filterPa: 30,
}

export const EXAMPLE_RHO = 1.2

const n = (id: string, parentId: string | null, side: 'upstream' | 'downstream', params: NodeParams): DuctNode =>
  ({ id, x: 0, y: 0, label: id, parentId, childIds: [], side, params })

/**
 *   OA フード(ζ3.0) ← OA ダクト φ100・2 m ← [送風機] → SA 主管 φ125・4 m・90°×1 → 分岐(ζ1.0)
 *                                                      ├→ 枝 A φ100・3 m・90°×1 → 吹出口 A(ζ2.0・60 m³/h)
 *                                                      └→ 枝 B φ100・5 m・90°×2 → 吹出口 B(ζ2.0・40 m³/h)
 */
export function buildSpecExample(): DuctSystem {
  const list: DuctNode[] = [
    n('FAN', null, 'downstream', { kind: 'fan', maxStaticPa: null, notch: '', defaultLambda: EXAMPLE_COEFFICIENTS.lambda }),
    n('OA', 'FAN', 'upstream', { kind: 'duct', diameterMm: 100, lengthM: 2, bendAngleDeg: 90, bendCount: 0, lambda: null }),
    n('HOOD', 'OA', 'upstream', { kind: 'terminal', diameterMm: 100, targetFlowQh: 100, pressureMode: 'zeta', zeta: 3.0, targetPa: 0 }),
    n('MAIN', 'FAN', 'downstream', { kind: 'duct', diameterMm: 125, lengthM: 4, bendAngleDeg: 90, bendCount: 1, lambda: null }),
    n('BR', 'MAIN', 'downstream', { kind: 'branch', diameterMm: 125, zeta: 1.0 }),
    n('A', 'BR', 'downstream', { kind: 'duct', diameterMm: 100, lengthM: 3, bendAngleDeg: 90, bendCount: 1, lambda: null }),
    n('TA', 'A', 'downstream', { kind: 'terminal', diameterMm: 100, targetFlowQh: 60, pressureMode: 'zeta', zeta: 2.0, targetPa: 0 }),
    n('B', 'BR', 'downstream', { kind: 'duct', diameterMm: 100, lengthM: 5, bendAngleDeg: 90, bendCount: 2, lambda: null }),
    n('TB', 'B', 'downstream', { kind: 'terminal', diameterMm: 100, targetFlowQh: 40, pressureMode: 'zeta', zeta: 2.0, targetPa: 0 }),
  ]
  const nodes: Record<string, DuctNode> = {}
  for (const x of list) nodes[x.id] = x
  for (const x of list) if (x.parentId) nodes[x.parentId].childIds.push(x.id)
  return { id: 'example', name: '例題', type: 'SA', rootId: 'FAN', nodes }
}
