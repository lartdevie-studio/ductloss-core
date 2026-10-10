import type { DuctNode } from './types'

// ─────────────────────────────────────────────────────────────
// 自動レイアウト（系統単位で実行）
// ─────────────────────────────────────────────────────────────

const COL_WIDTH  = 230
const ROW_HEIGHT = 150
const X_ORIGIN   = 100
const Y_ORIGIN   = 80

type Nodes = Record<string, DuctNode>

/**
 * nodes 全体を rootId 起点でツリー配置する。
 *
 * side を考慮: ファン直下の子は side ごとに分離し、
 *  - upstream: ファンの左に展開（depth が増えるほど左へ）
 *  - downstream: ファンの右に展開（従来通り）
 *  - 子孫は親の方向を継承する
 *
 * 各方向ごとに葉数を数えて y 方向のスパンを確保する。
 */
export function autoLayout(nodes: Nodes, rootId: string): Nodes {
  const leafCount: Record<string, number> = {}
  const countLeaves = (id: string): number => {
    const n = nodes[id]
    if (!n) return 0
    if (n.childIds.length === 0) {
      leafCount[id] = 1
      return 1
    }
    let s = 0
    for (const c of n.childIds) s += countLeaves(c)
    leafCount[id] = Math.max(1, s)
    return leafCount[id]
  }
  countLeaves(rootId)

  const newNodes: Nodes = { ...nodes }
  const root = nodes[rootId]
  if (!root) return newNodes

  // ファン直下の子を side で分離
  const upstreamChildren   = root.childIds.filter(cid => nodes[cid]?.side === 'upstream')
  const downstreamChildren = root.childIds.filter(cid => nodes[cid]?.side !== 'upstream')

  // 全体の縦スパン（上流＋下流の葉数を合算しても良いが、揃えるため大きい方に合わせる）
  const upstreamLeafTotal   = upstreamChildren.reduce(  (s, c) => s + (leafCount[c] ?? 1), 0)
  const downstreamLeafTotal = downstreamChildren.reduce((s, c) => s + (leafCount[c] ?? 1), 0)
  const maxLeafTotal = Math.max(upstreamLeafTotal, downstreamLeafTotal, 1)

  // ファンの y は中央
  const fanX = X_ORIGIN + COL_WIDTH * Math.max(...[1].concat(
    upstreamChildren.map(cid => maxDepthFromRoot(nodes, cid)),
  ))
  const totalH = maxLeafTotal * ROW_HEIGHT
  const fanY = Y_ORIGIN + totalH / 2
  newNodes[rootId] = { ...root, x: fanX, y: fanY }

  // 配置: 子の方向に応じて左右に展開
  const place = (id: string, depth: number, yTop: number, dir: 1 | -1) => {
    const n = newNodes[id]
    if (!n) return
    const span = (leafCount[id] ?? 1) * ROW_HEIGHT
    const cx = fanX + depth * COL_WIDTH * dir
    const cy = yTop + span / 2
    newNodes[id] = { ...n, x: cx, y: cy }

    let curY = yTop
    for (const cid of n.childIds) {
      const childSpan = (leafCount[cid] ?? 1) * ROW_HEIGHT
      place(cid, depth + 1, curY, dir)
      curY += childSpan
    }
  }

  // 下流側
  let yCursor = Y_ORIGIN + (totalH - downstreamLeafTotal * ROW_HEIGHT) / 2
  for (const cid of downstreamChildren) {
    const childSpan = (leafCount[cid] ?? 1) * ROW_HEIGHT
    place(cid, 1, yCursor, 1)
    yCursor += childSpan
  }
  // 上流側
  yCursor = Y_ORIGIN + (totalH - upstreamLeafTotal * ROW_HEIGHT) / 2
  for (const cid of upstreamChildren) {
    const childSpan = (leafCount[cid] ?? 1) * ROW_HEIGHT
    place(cid, 1, yCursor, -1)
    yCursor += childSpan
  }

  return newNodes
}

/** 指定ノードを起点とする部分木の最大深さ（COL_WIDTH 計算用） */
function maxDepthFromRoot(nodes: Nodes, id: string, depth = 0): number {
  const n = nodes[id]
  if (!n || n.childIds.length === 0) return depth
  let max = depth
  for (const c of n.childIds) {
    const d = maxDepthFromRoot(nodes, c, depth + 1)
    if (d > max) max = d
  }
  return max
}

const MIN_VIEW_W = 900
const MIN_VIEW_H = 540

/** バウンディングボックス（SVG viewBox 用） */
export function getBounds(nodes: Nodes, padding = 80): {
  minX: number; minY: number; maxX: number; maxY: number; width: number; height: number
} {
  const arr = Object.values(nodes)
  if (arr.length === 0) {
    return { minX: 0, minY: 0, maxX: MIN_VIEW_W, maxY: MIN_VIEW_H, width: MIN_VIEW_W, height: MIN_VIEW_H }
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const n of arr) {
    if (n.x < minX) minX = n.x
    if (n.y < minY) minY = n.y
    if (n.x > maxX) maxX = n.x
    if (n.y > maxY) maxY = n.y
  }
  minX -= padding; minY -= padding
  maxX += padding; maxY += padding

  let width  = maxX - minX
  let height = maxY - minY
  if (width < MIN_VIEW_W) {
    const cx = (minX + maxX) / 2
    minX = cx - MIN_VIEW_W / 2
    maxX = cx + MIN_VIEW_W / 2
    width = MIN_VIEW_W
  }
  if (height < MIN_VIEW_H) {
    const cy = (minY + maxY) / 2
    minY = cy - MIN_VIEW_H / 2
    maxY = cy + MIN_VIEW_H / 2
    height = MIN_VIEW_H
  }
  return { minX, minY, maxX, maxY, width, height }
}
