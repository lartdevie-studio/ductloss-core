/**
 * 計算書（PDF）の前付け章をつくるための集計。
 *
 * ねらい: **計算から導けるものは人に書かせない。**
 * 端末の ζ 一覧・計算条件は、いま系統に置かれているノードから機械的に出せる。
 * 手で書き写すと、ノードを直したのに表が古いまま、という食い違いが必ず起きる。
 *
 * 人の判断が要る文章（前提を置いた理由・図面との相違）だけを
 * `payload.report` に持つ。ここでは扱わない。
 *
 * **設計係数の名前と出典は計算条件の先頭に必ず載せる。** 係数は使う側が渡すので、
 * どの係数で計算したかが計算書から読めないと、第三者が照合できない（SPEC.md §2）。
 */

import type {
  DuctDiameter,
  DuctLossPayload,
  DuctSystem,
  FlowSide,
} from './types'
import { bendEquivLength90, type DesignCoefficients } from './coefficients'
import { RHO_DEFAULT } from './physics'
import { usableLambda } from './calculator'
import { effectiveDiameterMm } from './tree'

// ─────────────────────────────────────────────────────────────
// 端末の局部抵抗係数 一覧
// ─────────────────────────────────────────────────────────────

export interface TerminalZetaRow {
  /** 品番（カタログ参照の表示名）。器材未選択なら '（型番未定）' */
  model: string
  /** 用途（流れの向きから決める）。'吹出' / '吸込' / '—'（向き不明） */
  usage: string
  /** 同じ品番・用途・ζ・径の端末が何箇所あるか */
  count: number
  /** 局部抵抗係数。Pa 直入力の端末は null */
  zeta: number | null
  /** Pa 直入力の端末の計画風量時の圧損。ζ 入力なら null */
  targetPa: number | null
  /** 計算に使った径（接続ダクトから読んだ径。保存値ではない） */
  diameterMm: DuctDiameter
  /** カタログの出典。未選択なら '' */
  source: string
}

/**
 * ノードの流れの向きを求める。
 *
 * `side` はファンの直接の子にだけ入り、子孫は親から継ぐ約束になっている
 * （`DuctNode.side` のコメント参照）。そのため端末ノード自身は
 * 持っていないことがあり、親をたどって最初に見つかったものを答えとする。
 */
export function resolveNodeSide(system: DuctSystem, nodeId: string): FlowSide | null {
  const seen = new Set<string>()
  let cur = system.nodes[nodeId]
  while (cur && !seen.has(cur.id)) {
    if (cur.side) return cur.side
    seen.add(cur.id)
    if (!cur.parentId) return null
    cur = system.nodes[cur.parentId]
  }
  return null
}

const usageOf = (side: FlowSide | null): string =>
  side === 'downstream' ? '吹出' : side === 'upstream' ? '吸込' : '—'

/**
 * 全系統の端末を品番・用途・ζ・径でまとめる。
 *
 * 同じ品番でも取付方法で ζ が変わる器具があるため（壁面 0.6 ／ 天井 1.3 など）、
 * **ζ が違えば別の行にする**。まとめてしまうと「どちらの値で計算したのか」が
 * 計算書から読めなくなる。
 */
export function summarizeTerminalZeta(payload: DuctLossPayload): TerminalZetaRow[] {
  const byKey = new Map<string, TerminalZetaRow>()

  for (const system of payload.systems) {
    for (const node of Object.values(system.nodes)) {
      if (node.params.kind !== 'terminal') continue
      const p = node.params
      const model = p.catalogRef?.label ?? '（型番未定）'
      const usage = usageOf(resolveNodeSide(system, node.id))
      const zeta = p.pressureMode === 'zeta' ? p.zeta : null
      const targetPa = p.pressureMode === 'pa' ? p.targetPa : null
      // 径は計算に使った径（接続ダクトから読んだ径。SPEC.md §4）。保存値を出すと表から検算できない
      const diameterMm = effectiveDiameterMm(system.nodes, node) as DuctDiameter
      const key = `${model}\u0000${usage}\u0000${zeta ?? 'pa'}\u0000${targetPa ?? ''}\u0000${diameterMm}`

      const hit = byKey.get(key)
      if (hit) {
        hit.count += 1
        continue
      }
      byKey.set(key, {
        model,
        usage,
        count: 1,
        zeta,
        targetPa,
        diameterMm,
        source: p.catalogRef?.source ?? '',
      })
    }
  }

  // 吹出 → 吸込 → 向き不明 の順。同じ用途では品番、さらに ζ の小さい順。
  const usageRank = (u: string) => (u === '吹出' ? 0 : u === '吸込' ? 1 : 2)
  return [...byKey.values()].sort((a, b) =>
    usageRank(a.usage) - usageRank(b.usage)
    || a.model.localeCompare(b.model, 'ja')
    || (a.zeta ?? Infinity) - (b.zeta ?? Infinity),
  )
}

/** 端末の総数（一覧の「合計」欄） */
export const totalTerminalCount = (rows: TerminalZetaRow[]): number =>
  rows.reduce((sum, r) => sum + r.count, 0)

// ─────────────────────────────────────────────────────────────
// 計算条件
// ─────────────────────────────────────────────────────────────

export interface CalcConditionRow {
  label: string
  value: string
  /** 右端の補足。根拠や出典を置く */
  note: string
}

/** 重複を消して昇順に並べた数値の一覧 */
const distinctSorted = (values: number[]): number[] =>
  [...new Set(values.map(v => Number(v.toFixed(6))))].sort((a, b) => a - b)

const joinNums = (values: number[], digits: number): string =>
  values.map(v => v.toFixed(digits)).join(' / ')

/**
 * 計算条件の表をつくる。
 *
 * λ・分岐 ζ は系統ごとに変えられるので、**実際に使われている値を集めて並べる**。
 * 固定値を書き写すと、1 箇所だけ変えたときに計算書が嘘をつく。
 */
export function collectCalcConditions(coef: DesignCoefficients, payload: DuctLossPayload): CalcConditionRow[] {
  const rows: CalcConditionRow[] = []

  // 設計係数（名前と出典）。λ・曲がりの相当長はここから来る
  rows.push({ label: '設計係数', value: coef.name, note: `出典: ${coef.source}` })

  // 空気密度。気温から求めたのでも標準値でもなければ、由来を断定せず保存された値と書く
  // （以前は 1.15 にも「20℃ 標準大気」と書いていた。「手入力」とも言い切らない: 気温・標高の
  // 記録だけが落ちた古い保存データもあり、手で入れたとは限らないため）
  const rhoNote = payload.airTempC != null
    ? `気温 ${payload.airTempC}℃${payload.altitudeM ? ` / 標高 ${payload.altitudeM} m` : ''} から算出`
    : Math.abs(payload.rho - RHO_DEFAULT) < 1e-9 ? '20℃ 標準大気' : '保存された値（気温・標高の記録なし）'
  rows.push({ label: '空気密度 ρ', value: `${payload.rho.toFixed(3).replace(/\.?0+$/, '')} kg/m³`, note: rhoNote })

  // 摩擦係数 λ — 直管が持つ値。未設定の直管は祖先ファンの既定 λ に落ちる
  const lambdas: number[] = []
  let usedFanDefault = false
  const fanDefaults: number[] = []
  for (const system of payload.systems) {
    const fan = system.nodes[system.rootId]
    // 計算（calcNodeResult）と同じ順: ダクトの λ → 送風機の既定値 → 係数の λ
    const fanDefault = usableLambda(fan?.params.kind === 'fan' ? fan.params.defaultLambda : undefined) ?? coef.lambda
    for (const node of Object.values(system.nodes)) {
      if (node.params.kind !== 'duct') continue
      const own = usableLambda(node.params.lambda)
      if (own == null) {
        usedFanDefault = true
        fanDefaults.push(fanDefault)
      } else {
        lambdas.push(own)
      }
    }
  }
  const allLambdas = distinctSorted([...lambdas, ...(usedFanDefault ? fanDefaults : [])])
  if (allLambdas.length > 0) {
    rows.push({
      label: '摩擦係数 λ',
      value: allLambdas.length === 1 ? `${joinNums(allLambdas, 2)}（全ダクト共通）` : joinNums(allLambdas, 2),
      note: usedFanDefault ? '未設定の直管は送風機の既定値' : '直管ごとに指定',
    })
  }

  // 分岐の ζ
  const branchZetas = distinctSorted(
    payload.systems.flatMap(s =>
      Object.values(s.nodes)
        .filter(n => n.params.kind === 'branch')
        .map(n => (n.params as { zeta: number }).zeta),
    ),
  )
  if (branchZetas.length > 0) {
    rows.push({
      label: '分岐の ζ',
      value: joinNums(branchZetas, 2),
      note: branchZetas.length === 1 ? '全分岐で共通' : '分岐ごとに指定',
    })
  }

  rows.push({ label: '端末の ζ', value: '品番別（下表）', note: '器材カタログの提示値' })

  // 曲がり相当長 — 実際に使われている径だけ載せる
  const usedDiameters = distinctSorted(
    payload.systems.flatMap(s =>
      Object.values(s.nodes)
        .filter(n => n.params.kind === 'duct')
        .map(n => (n.params as { diameterMm: number }).diameterMm),
    ),
  ) as DuctDiameter[]
  // 表に無い径は一番近い径の値で計算する（SPEC.md §3）ので、その値を載せる
  const bendRows = usedDiameters.map(d => `φ${d} = ${bendEquivLength90(coef, d).toFixed(3)} m`)
  if (bendRows.length > 0) {
    rows.push({ label: '曲がり相当長', value: `90° ${bendRows.join(' ／ ')}`, note: '角度に比例配分' })
  }

  rows.push({
    label: '計算式',
    value: '直管 ΔP = λ(L/D)q ／ 局部 ΔP = ζq ／ q = ρv²/2',
    note: 'Darcy-Weisbach ＋ 局部抵抗',
  })

  return rows
}

// ─────────────────────────────────────────────────────────────
// 注記（自由記述）
// ─────────────────────────────────────────────────────────────

/**
 * 注記のテキストを 1 行 1 項目に割る。
 * 空行・空白だけの行は落とす（末尾の改行で空番号が出るのを防ぐ）。
 */
export const splitNoteLines = (text: string | undefined): string[] =>
  (text ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)

/** 注記がひとつでも書かれているか（章ごと出すかの判定） */
export const hasReportNotes = (payload: DuctLossPayload): boolean => {
  const r = payload.report
  if (!r) return false
  return [r.assumptions, r.designNotes, r.drawingDiffs, r.sources]
    .some(t => splitNoteLines(t).length > 0)
}
