import type { BendAngle, DuctDiameter, DuctLossPayload, DuctNode, DuctSystem, NodeKind, SystemType } from './types'
import { structureIssues } from './tree'
import { newId } from './id'

// ─────────────────────────────────────────────────────────────
// 保存形式（schema v4）の確認と、古い形式からの引き上げ
// ─────────────────────────────────────────────────────────────

/** 既定の系統名 */
export const DEFAULT_SYSTEM_NAME: Record<SystemType, string> = {
  SA: 'SA 系統',
  RE: 'RE 系統',
}

/**
 * 旧系統種別 ('EA' / 'OA') を新型 ('SA' / 'RE') にマップする。
 *  EA → RE（排気は還気系統の出口として扱う）
 *  OA → SA（外気は給気系統の入口として扱う）
 *  SA / RE はそのまま、それ以外（不明値）は SA にフォールバック。
 */
export function migrateLegacySystemType(raw: string): SystemType {
  if (raw === 'SA' || raw === 'RE') return raw
  if (raw === 'EA') return 'RE'
  if (raw === 'OA') return 'SA'
  return 'SA'
}

/**
 * payload から schema_version（DB 列）の値を導く。
 *
 * 保存先に版の列を別に持つときは、payload と別々に書くと必ずズレるので、ここを通す。
 */
export function schemaVersionOf(p: unknown): number {
  const v = (p as { schemaVersion?: unknown } | null)?.schemaVersion
  return typeof v === 'number' ? v : 1
}

// ─────────────────────────────────────────────────────────────
// バリデーション ＆ マイグレーション
// ─────────────────────────────────────────────────────────────

const VALID_KINDS: NodeKind[] = ['fan', 'duct', 'filter', 'branch', 'reducer', 'aircon', 'terminal']

function isValidNode(n: unknown): n is DuctNode {
  if (!n || typeof n !== 'object') return false
  const o = n as Partial<DuctNode>
  return (
    typeof o.id === 'string' &&
    Array.isArray(o.childIds) &&
    typeof o.x === 'number' &&
    typeof o.y === 'number' &&
    !!o.params &&
    VALID_KINDS.includes((o.params as { kind?: NodeKind })?.kind ?? ('' as NodeKind))
  )
}

function isValidSystem(s: unknown): s is DuctSystem {
  if (!s || typeof s !== 'object') return false
  const o = s as Partial<DuctSystem>
  if (typeof o.id !== 'string' || typeof o.name !== 'string' || typeof o.rootId !== 'string') return false
  if (!o.type || !['SA','RE'].includes(o.type)) return false
  if (!o.nodes || typeof o.nodes !== 'object') return false
  if (!o.nodes[o.rootId]) return false
  for (const node of Object.values(o.nodes)) {
    if (!isValidNode(node)) return false
  }
  // 親子が輪になったデータは計算が終わらないので受け付けない。
  // それ以外の形の崩れ（どこにもつながらない部材など）は開けるようにして、点検で知らせる
  // （既存の保存データを開けなくしないため）。
  if (structureIssues(o.nodes as Record<string, DuctNode>, o.rootId).some(i => i.kind === 'cycle')) return false
  return true
}

/** payload がそのまま v4 として有効か（type は SA/RE のみ） */
export function isValidPayloadV4(p: unknown): p is DuctLossPayload {
  if (!p || typeof p !== 'object') return false
  const o = p as Partial<DuctLossPayload>
  if (o.schemaVersion !== 4 || typeof o.rho !== 'number') return false
  if (!Array.isArray(o.systems) || o.systems.length === 0) return false
  return o.systems.every(isValidSystem)
}

/**
 * v4 の形状チェック（type は EA/OA を含む旧データも一旦許容）。
 * tryUpgradePayload で type 正規化のために使う。
 */
function isPayloadShapeV4(p: unknown): boolean {
  if (!p || typeof p !== 'object') return false
  const o = p as Partial<DuctLossPayload>
  if (o.schemaVersion !== 4 || typeof o.rho !== 'number') return false
  if (!Array.isArray(o.systems) || o.systems.length === 0) return false
  for (const s of o.systems) {
    const sys = s as Partial<DuctSystem>
    if (typeof sys.id !== 'string' || typeof sys.name !== 'string' || typeof sys.rootId !== 'string') return false
    if (!sys.nodes || typeof sys.nodes !== 'object') return false
    if (!sys.nodes[sys.rootId]) return false
  }
  return true
}

/** v2 / v3 / v4 を v4 にアップグレード（不可なら null） */
export function tryUpgradePayload(p: unknown): DuctLossPayload | null {
  // v4 で systems 内に旧 type ('EA' / 'OA') が混在している場合は SA / RE に正規化。
  //
  // **payload 直下のフィールドは丸ごと引き継ぐこと（スプレッド）。**
  // ここで schemaVersion / rho / systems だけを組み直していたため、
  // airTempC・altitudeM（設計気温・標高）が開き直すたびに黙って捨てられ、
  // 次の保存で DB からも消えていた。あとから足した ventilation も同じ穴に落ちる。
  // 新しいフィールドを足すときにここを直す必要が無いよう、スプレッドで残す。
  if (isPayloadShapeV4(p)) {
    const src = p as DuctLossPayload
    const normalized: DuctLossPayload = {
      ...src,
      schemaVersion: 4,
      rho: src.rho,
      systems: src.systems.map(s => ({
        ...s,
        type: migrateLegacySystemType((s as DuctSystem & { type: string }).type),
      })),
    }
    return isValidPayloadV4(normalized) ? normalized : null
  }

  if (!p || typeof p !== 'object') return null
  const o = p as { schemaVersion?: number; rho?: unknown; rootId?: unknown; nodes?: Record<string, unknown> }
  if (typeof o.rho !== 'number' || typeof o.rootId !== 'string' || !o.nodes) return null
  if (!o.nodes[o.rootId]) return null

  // v2 / v3 共通: 単一ツリーを 1 つの SA 系統に包む
  const rootId = o.rootId
  const nodes: Record<string, DuctNode> = {}

  for (const [id, raw] of Object.entries(o.nodes)) {
    const n = raw as {
      id: string; parentId: string | null; childIds: string[]
      x: number; y: number; label: string
      params: { kind: string; [k: string]: unknown }
    }
    const k = n?.params?.kind
    const base = {
      id: n.id, parentId: n.parentId ?? null, childIds: n.childIds ?? [],
      x: n.x ?? 0, y: n.y ?? 0, label: n.label ?? '',
    }

    // v2: 'straight' / 'bend' を 'duct' に変換
    if (k === 'straight') {
      nodes[id] = {
        ...base,
        params: {
          kind: 'duct',
          diameterMm: n.params.diameterMm as DuctDiameter,
          lengthM: (n.params.lengthM as number) ?? 0,
          bendAngleDeg: 90 as BendAngle,
          bendCount: 0,
          lambda: (n.params.lambda as number | null) ?? null,
        },
      }
    } else if (k === 'bend') {
      nodes[id] = {
        ...base,
        params: {
          kind: 'duct',
          diameterMm: n.params.diameterMm as DuctDiameter,
          lengthM: 0,
          bendAngleDeg: (n.params.angleDeg as BendAngle) ?? (90 as BendAngle),
          bendCount: (n.params.count as number) ?? 1,
          lambda: (n.params.lambda as number | null) ?? null,
        },
      }
    } else if (VALID_KINDS.includes(k as NodeKind)) {
      nodes[id] = raw as DuctNode
    } else {
      return null
    }
  }

  return {
    schemaVersion: 4,
    rho: o.rho,
    systems: [{
      id: newId(),
      name: DEFAULT_SYSTEM_NAME.SA,
      type: 'SA',
      rootId,
      nodes,
    }],
  }
}
