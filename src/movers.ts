import type { CalcResult, DuctSystem } from './types'
import type { PQPoint } from './pqcurve'
import { judgeMover, type MoverVerdict } from './verdict'

// ─────────────────────────────────────────────────────────────
// 送風機（検討単位）の抽出
//
// 利用者の設計手順は「系統」ではなく「送風機1台」を単位に進む：
//   送風機 = 上流側（吸込）経路 + 下流側（吹出）経路 + その合計（必要静圧）
//
// この 1 つの型で 3 つのケースを表せる。
//   Case1 熱交換器のみ      → 給気(OA→SA) / 排気(RE→EA)                の 2 台
//   Case2 エアコンのみ      → エアコン(RE(REC)→SA)                     の 1 台
//   Case3 熱交換器＋エアコン → Case1 の 2 台 + エアコン 1 台             の 3 台
//
// ツリーは実際のダクトの繋がりどおり（Case3 なら給気系統の中にエアコンを置く）に
// 保ったまま、評価だけを送風機ごとに切り出す。
// ─────────────────────────────────────────────────────────────

/** 検討単位 1 台ぶん */
export interface MoverRow {
  /** 一意キー（系統id または 系統id:ノードid） */
  key: string
  systemId: string
  /** エアコン等の第2送風機なら、そのノード id。主送風機は null */
  nodeId: string | null
  /** 機器名（例「熱交換器 給気」「エアコン」） */
  unitLabel: string
  /** 経路（例「OA → SA」） */
  pathLabel: string
  /** 系統名（機器名と別に、どのタブの系統かを示す） */
  systemName: string
  /** 送風機を通過する風量 (m³/h) */
  flowQh: number
  /** 上流側（吸込）の必要静圧 */
  upstreamPa: number
  /** 下流側（吹出）の必要静圧 */
  downstreamPa: number
  /** 必要静圧 = 上流 + 下流 */
  requiredPa: number
  /** 機器の最大静圧（未設定は null） */
  maxStaticPa: number | null
  /** 機器の P-Q 特性（未設定は null） */
  pqPoints: PQPoint[] | null
  /** 合否。設定風量で機器が必要静圧を出せるか（judgeMover）。機外静圧との 1 点比較ではない */
  verdict: MoverVerdict
  /** 主送風機か（false = エアコン等の第2送風機） */
  isPrimary: boolean
  /** 機器がエアコンか（根がエアコン／第2送風機のどちらも true） */
  isAircon: boolean
  /**
   * エアコンの風量内訳（主送風機は null）。
   * エアコンSA（= flowQh）= 熱交換器からのSA + REC という釣り合いを表す。
   * 熱交換器からのSA を手入力すると REC が引き算で決まる（逆も可）。
   */
  split: { fromHexQh: number; recircQh: number } | null
}

/** 系統種別ごとの既定の経路名（上流側 → 下流側） */
export function defaultPathLabel(system: DuctSystem, isAirconRoot: boolean): string {
  if (isAirconRoot) return 'RE(REC) → SA'
  const [inlet, outlet] = system.type === 'RE' ? ['RE', 'EA'] : ['OA', 'SA']
  // 描いていない側の記号は出さない。吹出側だけを描いた例題のような系統で
  // 「OA → SA／上流側 0.0 Pa」と並ぶと、外気側を数え忘れたように読める。
  const kids = Object.values(system.nodes).filter(n => n.id !== system.rootId)
  const hasUp   = kids.some(n => n.side === 'upstream')
  const hasDown = kids.some(n => n.side !== 'upstream')
  if (hasUp && !hasDown) return `${inlet}（吸込側のみ）`
  if (hasDown && !hasUp) return `${outlet}（吹出側のみ）`
  return `${inlet} → ${outlet}`
}

/** 主送風機の機器名。根がエアコンならエアコン、それ以外は系統種別から */
function defaultUnitLabel(system: DuctSystem, isAirconRoot: boolean): string {
  if (isAirconRoot) return 'エアコン'
  return system.type === 'RE' ? '熱交換器 排気' : '熱交換器 給気'
}

/** 新規作成時に自動で入る汎用ラベル。機器名としては情報が無いので既定名を優先する */
const GENERIC_ROOT_LABELS = new Set(['', 'ファン', 'エアコン'])

function unitLabelOf(system: DuctSystem, isAirconRoot: boolean): string {
  const raw = (system.nodes[system.rootId]?.label ?? '').trim()
  return GENERIC_ROOT_LABELS.has(raw) ? defaultUnitLabel(system, isAirconRoot) : raw
}

/**
 * 全系統から送風機の一覧を組み立てる。
 * 主送風機（各系統の根）に続けて、その系統に含まれるエアコン（第2送風機）を並べる。
 */
export function collectMovers(
  systems: DuctSystem[],
  calcBySystem: Record<string, CalcResult>,
  /** 計算の空気密度。省くと計算結果の meta の ρ を使う（機器の特性を ρ/1.20 倍にして比べる。SPEC.md §7） */
  rho?: number,
): MoverRow[] {
  const rows: MoverRow[] = []

  for (const sys of systems) {
    const calc = calcBySystem[sys.id]
    if (!calc) continue
    const airRho = rho ?? calc.meta?.rho
    const root = sys.nodes[sys.rootId]
    const isAirconRoot = root?.params.kind === 'aircon'
    // 機器能力は「root がファンなら FanParams、root がエアコンなら AirconParams」。
    // 以前は fanParams からしか読まず、エアコン単独（Case2）の系統は
    // 合否を出す相手が居ないまま必要静圧だけ表示していた。
    const rootMaxStaticPa = root?.params.kind === 'fan' ? root.params.maxStaticPa
      : root?.params.kind === 'aircon' ? (root.params.maxStaticPa ?? null)
      : null
    const rootPqPoints = (root?.params.kind === 'fan' || root?.params.kind === 'aircon')
      ? (root.params.pqPoints ?? null)
      : null
    const rootMaxStaticAtQh = (root?.params.kind === 'fan' || root?.params.kind === 'aircon')
      ? (root.params.maxStaticAtQh ?? null)
      : null

    rows.push({
      key:          sys.id,
      systemId:     sys.id,
      nodeId:       null,
      unitLabel:    unitLabelOf(sys, isAirconRoot),
      pathLabel:    defaultPathLabel(sys, isAirconRoot),
      systemName:   sys.name,
      flowQh:       calc.fanFlowQh,
      upstreamPa:   calc.fanUpstreamPa,
      downstreamPa: calc.fanDownstreamPa,
      requiredPa:   calc.fanRequiredPa,
      maxStaticPa:  rootMaxStaticPa,
      pqPoints:     rootPqPoints,
      verdict:      judgeMover(calc.fanRequiredPa, calc.fanFlowQh, rootMaxStaticPa, rootPqPoints, rootMaxStaticAtQh, airRho),
      isPrimary:    true,
      isAircon:     isAirconRoot,
      split:        null,
    })

    for (const m of calc.secondaryMovers) {
      rows.push({
        key:          `${sys.id}:${m.nodeId}`,
        systemId:     sys.id,
        nodeId:       m.nodeId,
        unitLabel:    m.label || 'エアコン',
        pathLabel:    'RE(REC) → SA',
        systemName:   sys.name,
        flowQh:       m.circulationQh,
        upstreamPa:   m.intakeCriticalPa,
        downstreamPa: m.supplyCriticalPa,
        requiredPa:   m.requiredPa,
        maxStaticPa:  m.maxStaticPa,
        pqPoints:     m.pqPoints,
        verdict:      judgeMover(m.requiredPa, m.circulationQh, m.maxStaticPa, m.pqPoints, m.maxStaticAtQh, airRho),
        isPrimary:    false,
        isAircon:     true,
        split:        { fromHexQh: m.supplyFromHexQh, recircQh: m.intakeQh },
      })
    }
  }

  return rows
}
