import type { DuctNode, NodeKind, FlowSide } from './types'
import type { DesignCoefficients } from './coefficients'
import { makeNode } from './factory'

// ─────────────────────────────────────────────────────────────
// 不変操作（nodes Record を受け取って新しい Record を返す）
//
// すべての操作は単一系統内のノード集合に対して行う。
// 系統境界をまたぐ操作は呼び出し側でハンドルする。
// ─────────────────────────────────────────────────────────────

type Nodes = Record<string, DuctNode>

/**
 * 指定した親の子として新しいノードを追加する。
 *
 * side の決定:
 *   - 親が fan / aircon の場合: 引数 sideOverride で上流（吸込）/下流（供給）を選択。
 *     省略時は親の side（fan は downstream 既定、aircon は自身の side=下流）。
 *   - それ以外の親: 親の side を継承（fan/aircon の子で決めたら一族すべて同じ）
 *
 * 配置:
 *   - downstream: 親の右に dx ずらす
 *   - upstream:   親の左に dx ずらす（流れの起点が左に来る）
 */
export function addChild(
  coef: DesignCoefficients,
  nodes: Nodes,
  parentId: string,
  kind: NodeKind,
  sideOverride?: FlowSide,
): { nodes: Nodes; nodeId: string } {
  const parent = nodes[parentId]
  if (!parent) throw new Error(`親ノードが見つかりません: ${parentId}`)

  // side の決定: fan / aircon の子なら override 可能、それ以外は親から継承。
  // aircon は下流サブツリー内にあるため、override 省略時は親（aircon）の side を継承する。
  const honorsOverride = parent.params.kind === 'fan' || parent.params.kind === 'aircon'
  const side: FlowSide = honorsOverride
    ? (sideOverride ?? parent.side ?? 'downstream')
    : (parent.side ?? 'downstream')

  const siblingCount = parent.childIds.length
  const dx = side === 'upstream' ? -200 : 200
  const dy = siblingCount === 0 ? 0 : (siblingCount % 2 === 0 ? 1 : -1) * 120 * Math.ceil(siblingCount / 2)

  const node = makeNode(coef, kind, { parentId, x: parent.x + dx, y: parent.y + dy })
  node.side = side

  return {
    nodes: {
      ...nodes,
      [parentId]: { ...parent, childIds: [...parent.childIds, node.id] },
      [node.id]: node,
    },
    nodeId: node.id,
  }
}

/**
 * 既存のエッジ（parent → child）の中間に新しいノードを挿入する。
 * 元の child は新ノードの子になる。
 *
 * 例: A → B  に X を挿入  →  A → X → B
 */
export function insertOnEdge(
  coef: DesignCoefficients,
  nodes: Nodes,
  parentId: string,
  childId: string,
  kind: NodeKind,
): { nodes: Nodes; nodeId: string } {
  const parent = nodes[parentId]
  const child = nodes[childId]
  if (!parent || !child) throw new Error('挿入対象のエッジが見つかりません')
  if (!parent.childIds.includes(childId)) throw new Error('指定したエッジは存在しません')

  // 新ノードは親と子の中点に配置
  const mx = (parent.x + child.x) / 2
  const my = (parent.y + child.y) / 2
  const node = makeNode(coef, kind, { parentId, x: Math.round(mx), y: Math.round(my) })
  // 既存エッジの side（=childの side）を継承
  node.side = child.side ?? parent.side ?? 'downstream'

  // 親の childIds: child を node に置換
  const newParentChildIds = parent.childIds.map(id => (id === childId ? node.id : id))
  // 新ノードの childIds: [child]
  node.childIds = [childId]

  return {
    nodes: {
      ...nodes,
      [parentId]: { ...parent, childIds: newParentChildIds },
      [node.id]: node,
      [childId]: { ...child, parentId: node.id },
    },
    nodeId: node.id,
  }
}

/**
 * ノードを削除（サブツリーごと）。root は削除できない。
 */
export function deleteSubtree(nodes: Nodes, rootId: string, nodeId: string): Nodes {
  if (nodeId === rootId) return nodes
  const target = nodes[nodeId]
  if (!target) return nodes

  const toRemove = new Set<string>()
  const stack: string[] = [nodeId]
  while (stack.length > 0) {
    const id = stack.pop()!
    toRemove.add(id)
    const n = nodes[id]
    if (n) stack.push(...n.childIds)
  }

  const parentId = target.parentId
  const newNodes: Nodes = {}
  for (const [id, node] of Object.entries(nodes)) {
    if (toRemove.has(id)) continue
    if (id === parentId) {
      newNodes[id] = { ...node, childIds: node.childIds.filter(c => !toRemove.has(c)) }
    } else {
      newNodes[id] = node
    }
  }
  return newNodes
}

/** ノードを更新 */
export function updateNode(
  nodes: Nodes,
  nodeId: string,
  patch: Partial<Omit<DuctNode, 'id' | 'parentId' | 'childIds'>>,
): Nodes {
  const node = nodes[nodeId]
  if (!node) return nodes
  return { ...nodes, [nodeId]: { ...node, ...patch } }
}

/** ノードを移動 */
export function moveNode(nodes: Nodes, nodeId: string, x: number, y: number): Nodes {
  return updateNode(nodes, nodeId, { x, y })
}

// ─────────────────────────────────────────────────────────────
// 走査ヘルパー
// ─────────────────────────────────────────────────────────────

/** 葉ノードの id 一覧 */
export function listLeafIds(nodes: Nodes): string[] {
  return Object.values(nodes).filter(n => n.childIds.length === 0).map(n => n.id)
}

/**
 * root → 指定 id までのパス。
 * 親をたどる途中で同じ部材に戻ったら（親子が輪になった壊れたデータ）そこで止める。
 * 輪のあるデータは isValidPayloadV4 がはじくが、確かめずに渡されても止まらないようにする。
 */
export function pathFromRoot(nodes: Nodes, nodeId: string): string[] {
  const path: string[] = []
  const seen = new Set<string>()
  let cur: string | null = nodeId
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    path.unshift(cur)
    const n: DuctNode | undefined = nodes[cur]
    cur = n?.parentId ?? null
  }
  return path
}

/** 後順（葉→根）で全ノード id を返す。同じ部材は 1 回だけ（輪・重なりがあっても止まる） */
export function postOrder(nodes: Nodes, rootId: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const visit = (id: string) => {
    if (seen.has(id)) return
    seen.add(id)
    const n = nodes[id]
    if (!n) return
    for (const c of n.childIds) visit(c)
    out.push(id)
  }
  visit(rootId)
  return out
}

/** 親祖先のうち最初の Fan を返す */
export function findAncestorFan(nodes: Nodes, nodeId: string): DuctNode | null {
  const seen = new Set<string>()
  let cur: string | null = nodeId
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const n: DuctNode | undefined = nodes[cur]
    if (!n) return null
    if (n.params.kind === 'fan') return n
    cur = n.parentId
  }
  return null
}

/** 系統の木の形の崩れ */
export interface StructureIssue {
  /**
   * cycle            親子が輪になっている（計算できない。isValidPayloadV4 がはじく）
   * missing-child    childIds に無い部材の id がある
   * parent-mismatch  子の parentId が親を指していない
   * shared-child     同じ部材が 2 か所以上の子になっている（風量を二重に数える）
   * orphan           根からたどれない部材がある（計算に入らない）
   * root-has-parent  根に親がある
   */
  kind: 'cycle' | 'missing-child' | 'parent-mismatch' | 'shared-child' | 'orphan' | 'root-has-parent'
  nodeId: string
}

/**
 * 系統の木の形を確かめる。崩れが無ければ空配列。
 * 輪（cycle）以外は計算は止まらないが、結果が意図とずれるので点検で知らせる。
 */
export function structureIssues(nodes: Nodes, rootId: string): StructureIssue[] {
  const out: StructureIssue[] = []
  const root = nodes[rootId]
  if (root && root.parentId != null) out.push({ kind: 'root-has-parent', nodeId: rootId })

  // 親をたどる輪（全部材から）
  const cycleNodes = new Set<string>()
  for (const id of Object.keys(nodes)) {
    const seen = new Set<string>()
    let cur: string | null = id
    while (cur && nodes[cur]) {
      if (seen.has(cur)) { cycleNodes.add(cur); break }
      seen.add(cur)
      cur = nodes[cur].parentId
    }
  }
  for (const id of cycleNodes) out.push({ kind: 'cycle', nodeId: id })

  // 子をたどる（根から）。輪・重なり・食い違い・存在しない子
  const reached = new Set<string>()
  const onStack = new Set<string>()
  const childCount = new Map<string, number>()
  const walk = (id: string) => {
    reached.add(id)
    onStack.add(id)
    for (const c of nodes[id]?.childIds ?? []) {
      if (!nodes[c]) { out.push({ kind: 'missing-child', nodeId: id }); continue }
      childCount.set(c, (childCount.get(c) ?? 0) + 1)
      if (nodes[c].parentId !== id) out.push({ kind: 'parent-mismatch', nodeId: c })
      if (onStack.has(c)) { if (!cycleNodes.has(c)) out.push({ kind: 'cycle', nodeId: c }); continue }
      if (reached.has(c)) continue
      walk(c)
    }
    onStack.delete(id)
  }
  if (root) walk(rootId)
  for (const [id, n] of childCount) if (n > 1) out.push({ kind: 'shared-child', nodeId: id })
  for (const id of Object.keys(nodes)) if (!reached.has(id)) out.push({ kind: 'orphan', nodeId: id })
  return out
}

// ─────────────────────────────────────────────────────────────
// 接続径の自動読み取り
//
// 径を入力するのは「ダクト・フィルター・エアコン本体」だけにする（＝径の起点）。
// 分岐・端末（ディフューザー）・レデューサーは、繋がっているダクトから読み取る。
//
// 径は圧損に直接効く（v = Q/A → q = ρv²/2 → ΔP = ζq）ため、実際のダクトと
// 違う径が入っていると圧損が静かに間違う。二重入力をなくして食い違いを防ぐ。
// ─────────────────────────────────────────────────────────────

/** 径の起点になる部材か（自分で径を持ち、他から読み取らない） */
function isDiameterAnchor(node: DuctNode | undefined): boolean {
  const k = node?.params.kind
  return k === 'duct' || k === 'filter' || k === 'aircon'
}

/** 起点部材の径。起点でなければ null */
function anchorDiameter(node: DuctNode | undefined): number | null {
  if (!node) return null
  switch (node.params.kind) {
    case 'duct':
    case 'filter':
    case 'aircon':
      return node.params.diameterMm
    default:
      return null
  }
}

export interface ResolvedDiameter {
  mm: number
  /** どこから読み取ったか。'stored' = 接続ダクトが無く、保存値を使った */
  source: 'upstream' | 'downstream' | 'stored'
  /** 読み取り元のノード id（'stored' なら null） */
  fromNodeId: string | null
}

/** 親方向へたどって最初の起点部材を探す */
function findUpstreamAnchor(nodes: Nodes, nodeId: string): { mm: number; id: string } | null {
  const seen = new Set<string>([nodeId])
  let cur = nodes[nodeId]?.parentId ?? null
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const d = anchorDiameter(nodes[cur])
    if (d != null) return { mm: d, id: cur }
    cur = nodes[cur]?.parentId ?? null
  }
  return null
}

/**
 * 子孫方向へたどって起点部材を探す。
 * 複数見つかったときは最大径を採る（分岐の代表径として幹の太さに最も近いため）。
 */
function findDownstreamAnchor(nodes: Nodes, nodeId: string): { mm: number; id: string } | null {
  let best: { mm: number; id: string } | null = null
  const queue = [...(nodes[nodeId]?.childIds ?? [])]
  const visited = new Set<string>([nodeId])
  while (queue.length > 0) {
    const id = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    const d = anchorDiameter(nodes[id])
    if (d != null) {
      if (!best || d > best.mm) best = { mm: d, id }
      continue   // その先はこのダクトの下流なので、接続径としては見ない
    }
    queue.push(...(nodes[id]?.childIds ?? []))
  }
  return best
}

/**
 * 接続しているダクトから径を読み取る（分岐・端末用）。
 *  1. 上流側の最初の起点部材
 *  2. 無ければ下流側の起点部材（最大径）
 *  3. それも無ければ保存値
 */
export function resolveConnectedDiameter(
  nodes: Nodes, nodeId: string, storedMm: number,
): ResolvedDiameter {
  const up = findUpstreamAnchor(nodes, nodeId)
  if (up) return { mm: up.mm, source: 'upstream', fromNodeId: up.id }
  const down = findDownstreamAnchor(nodes, nodeId)
  if (down) return { mm: down.mm, source: 'downstream', fromNodeId: down.id }
  return { mm: storedMm, source: 'stored', fromNodeId: null }
}

/**
 * レデューサーの両端径を読み取る。
 * 入口＝上流のダクト径、出口＝下流のダクト径。レデューサーは
 * 「ダクト径がここで変わる」ことを示す部材なので、両端とも接続先が正となる。
 */
export function resolveReducerDiameters(
  nodes: Nodes, nodeId: string, storedFromMm: number, storedToMm: number,
): { from: ResolvedDiameter; to: ResolvedDiameter } {
  const up = findUpstreamAnchor(nodes, nodeId)
  const down = findDownstreamAnchor(nodes, nodeId)
  return {
    from: up
      ? { mm: up.mm, source: 'upstream', fromNodeId: up.id }
      : { mm: storedFromMm, source: 'stored', fromNodeId: null },
    to: down
      ? { mm: down.mm, source: 'downstream', fromNodeId: down.id }
      : { mm: storedToMm, source: 'stored', fromNodeId: null },
  }
}

/** 自動読み取りの対象か（diameterAuto === false なら手入力を優先） */
export function usesAutoDiameter(node: DuctNode): boolean {
  const p = node.params
  if (p.kind !== 'branch' && p.kind !== 'terminal' && p.kind !== 'reducer') return false
  return p.diameterAuto !== false
}

/**
 * 圧損計算・表示に使う実効径。
 * レデューサーは出口径（下流側）を返す。入口径が要るときは resolveReducerDiameters を使う。
 */
export function effectiveDiameterMm(nodes: Nodes, node: DuctNode): number {
  const p = node.params
  switch (p.kind) {
    case 'branch':
    case 'terminal':
      return usesAutoDiameter(node)
        ? resolveConnectedDiameter(nodes, node.id, p.diameterMm).mm
        : p.diameterMm
    case 'reducer':
      return usesAutoDiameter(node)
        ? resolveReducerDiameters(nodes, node.id, p.diameterFromMm, p.diameterToMm).to.mm
        : p.diameterToMm
    default:
      return anchorDiameter(node) ?? 0
  }
}

/** レデューサーの実効入口径（自動なら上流のダクト径） */
export function effectiveReducerFromMm(nodes: Nodes, node: DuctNode): number {
  const p = node.params
  if (p.kind !== 'reducer') return 0
  return usesAutoDiameter(node)
    ? resolveReducerDiameters(nodes, node.id, p.diameterFromMm, p.diameterToMm).from.mm
    : p.diameterFromMm
}

export { isDiameterAnchor }
