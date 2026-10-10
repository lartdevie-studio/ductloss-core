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
  DuctNode,
  DuctSystem,
  FlowSide,
  ReducerZetaBasis,
} from './types'
import { bendEquivLength90, coefficientFingerprint, type DesignCoefficients } from './coefficients'
import { ENGINE_VERSION } from './version'
import { RHO_DEFAULT } from './physics'
import { aggregateFlows, calcSystem, ductBends } from './calculator'
import { effectiveDiameterMm, REDUCER_ZETA_BASIS_LABELS } from './tree'

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
  /** 局部抵抗係数。Pa 直入力の端末は null（計算に使った値は zetaUsed） */
  zeta: number | null
  /** Pa 直入力の端末の計画風量時の圧損。ζ 入力なら null */
  targetPa: number | null
  /** 計算に使った ζ（Pa 入力の端末も、Pa を設計風量の動圧で割って保存した ζ で計算する。SPEC.md §3） */
  zetaUsed: number
  /** ダンパ調整の前の ζ（器材カタログ・入力の値）。調整していなければ null（SPEC.md §10） */
  baseZeta: number | null
  /** ダンパ調整で足した ζ（zetaUsed − baseZeta）。調整していなければ 0 */
  addedZeta: number
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
      const baseZeta = p.beforeBalance ? p.beforeBalance.zeta : null
      // 径は計算に使った径（接続ダクトから読んだ径。SPEC.md §4）。保存値を出すと表から検算できない
      const diameterMm = effectiveDiameterMm(system.nodes, node) as DuctDiameter
      const key = `${model}\u0000${usage}\u0000${p.zeta}\u0000${targetPa ?? ''}\u0000${baseZeta ?? ''}\u0000${diameterMm}`

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
        zetaUsed: p.zeta,
        baseZeta,
        addedZeta: baseZeta == null ? 0 : p.zeta - baseZeta,
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
    || a.zetaUsed - b.zetaUsed,
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

/** 重複を消して昇順に並べた数値の一覧（6 桁で同じとみなす） */
const distinctSorted = (values: number[]): number[] =>
  [...new Set(values.map(v => Number(v.toPrecision(6))))].sort((a, b) => a - b)

/**
 * 係数の値を、桁を落とさずに書く（有効 6 桁で後ろの 0 を消す）。
 * 以前は小数 2 桁に丸めていたため、λ 0.025 が「0.03」と出て計算書から検算できなかった
 */
export const formatCoefficient = (v: number): string =>
  Number.isFinite(v) ? String(Number(v.toPrecision(6))) : String(v)

const joinNums = (values: number[]): string => values.map(formatCoefficient).join(' / ')

/**
 * 計算条件の表をつくる。
 *
 * λ・分岐 ζ は系統ごとに変えられるので、**実際に使われている値を集めて並べる**。
 * 固定値を書き写すと、1 箇所だけ変えたときに計算書が嘘をつく。
 */
export function collectCalcConditions(coef: DesignCoefficients, payload: DuctLossPayload): CalcConditionRow[] {
  const rows: CalcConditionRow[] = []

  // 設計係数（名前と出典）。曲がりの相当長と、λ の決まっていない直管の λ はここから来る（SPEC.md §2）
  const fingerprint = coefficientFingerprint(coef)
  rows.push({ label: '設計係数', value: coef.name, note: `出典: ${coef.source}` })
  rows.push({ label: '計算の版', value: `ductloss-core ${ENGINE_VERSION}`, note: `係数の識別 ${fingerprint}` })
  // 保存データを作ったときの係数と違う係数で計算している（部材に写した ζ などは作ったときの係数のまま）
  const stamp = payload.coefficientsStamp
  if (stamp && stamp.fingerprint !== fingerprint) {
    rows.push({
      label: '保存時の設計係数',
      value: `${stamp.name}（識別 ${stamp.fingerprint}・版 ${stamp.engineVersion}）`,
      note: '今の係数と違います。曲がりの相当長と、λ の決まっていない直管の λ は今の係数で、部材に保存された ζ・λ は作ったときの値で計算しています',
    })
  }

  // 空気密度。気温から求めたのでも標準値でもなければ、由来を断定せず保存された値と書く
  // 1.2 は JIS B 8330 の標準空気。「標準大気」（国際標準大気は 15℃・1.225）と書かない
  // （以前は 1.15 にも「20℃ 標準大気」と書いていた。「手入力」とも言い切らない: 気温・標高の
  // 記録だけが落ちた古い保存データもあり、手で入れたとは限らないため）
  const rhoNote = payload.airTempC != null
    ? `気温 ${payload.airTempC}℃${payload.altitudeM ? ` / 標高 ${payload.altitudeM} m` : ''} から算出`
    : Math.abs(payload.rho - RHO_DEFAULT) < 1e-9 ? '標準空気（JIS B 8330: 20℃・101.3 kPa・65%RH）' : '保存された値（気温・標高の記録なし）'
  rows.push({ label: '空気密度 ρ', value: `${payload.rho.toFixed(3).replace(/\.?0+$/, '')} kg/m³`, note: rhoNote })

  // 摩擦係数 λ — 計算そのもの（calcSystem）の直管ごとの λ と出どころを集める。
  // 値ごとに出どころを書く（以前は係数の λ まで「送風機の既定値」と書いていた）。粗さから求めた λ は風速で変わるので別の行
  const tempC = payload.airTempC ?? 20
  const lambdaSources = new Map<number, Set<string>>()
  const rough = new Map<string, number[]>()   // 材料 → 求めた λ
  const ductDetails: { D: number; detail: NonNullable<ReturnType<typeof calcSystem>['byNode'][string]['duct']>; node: DuctNode }[] = []
  for (const system of payload.systems) {
    if (!system.nodes[system.rootId]) continue
    const calc = calcSystem(coef, system, payload.rho, 1, { tempC })
    for (const node of Object.values(system.nodes)) {
      if (node.params.kind !== 'duct') continue
      const det = calc.byNode[node.id]?.duct
      if (!det) continue
      ductDetails.push({ D: node.params.diameterMm, detail: det, node })
      if (det.lambdaSource === 'roughness') {
        const key = det.material ?? ''
        if (!rough.has(key)) rough.set(key, [])
        if (det.lambda > 0) rough.get(key)!.push(det.lambda)
        continue
      }
      const src = det.lambdaSource === 'duct' ? '直管に指定' : det.lambdaSource === 'fan' ? '送風機の既定値' : '設計係数の λ'
      const key = Number(det.lambda.toPrecision(6))
      if (!lambdaSources.has(key)) lambdaSources.set(key, new Set())
      lambdaSources.get(key)!.add(src)
    }
  }
  if (lambdaSources.size > 0) {
    const values = [...lambdaSources.keys()].sort((a, b) => a - b)
    const srcText = (v: number) => [...lambdaSources.get(v)!].join('・')
    rows.push({
      label: '摩擦係数 λ',
      value: values.length === 1 && rough.size === 0 ? `${formatCoefficient(values[0])}（全ダクト共通）` : joinNums(values),
      note: values.length === 1 ? srcText(values[0]) : values.map(v => `${formatCoefficient(v)}: ${srcText(v)}`).join(' ／ '),
    })
  }
  if (rough.size > 0 && coef.friction?.model === 'roughness') {
    const fr = coef.friction
    const parts = [...rough.entries()].map(([key, ls]) => {
      const m = fr.materials[key]
      const range = ls.length ? `λ ${formatCoefficient(Math.min(...ls))}〜${formatCoefficient(Math.max(...ls))}` : ''
      return `${m?.label ?? key}（粗さ ${m ? formatCoefficient(m.roughnessMm) : '?'} mm）${range}`
    })
    const sources = [...new Set([...rough.keys()].map(k => fr.materials[k]?.source).filter(Boolean))]
    rows.push({
      label: '摩擦係数 λ（粗さから）',
      value: parts.join(' ／ '),
      note: `直管ごとに Colebrook の式で求める（風速で変わる）。動粘性係数は ${tempC}℃ の空気。出典: ${sources.join('／')}`,
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
      value: joinNums(branchZetas),
      note: branchZetas.length === 1 ? '全分岐で共通' : '分岐ごとに指定',
    })
  }

  // レジューサの ζ と、ζ を掛ける動圧の断面（SPEC.md §4）
  const reducers = payload.systems.flatMap(s => Object.values(s.nodes)).filter(n => n.params.kind === 'reducer')
  if (reducers.length > 0) {
    const zetas = distinctSorted(reducers.map(n => (n.params as { zeta: number }).zeta))
    const bases = [...new Set(reducers.map(n => {
      const p = n.params as { zetaBasis?: ReducerZetaBasis }
      return REDUCER_ZETA_BASIS_LABELS[p.zetaBasis ?? 'treeLeaf']
    }))]
    rows.push({ label: 'レジューサの ζ', value: joinNums(zetas), note: `ζ を掛ける動圧: ${bases.join('／')}` })
  }

  // 端末の ζ。ダンパ調整で足した分は器材の値ではないので、そう書かない（SPEC.md §10）
  const balanced = payload.systems.some(s => Object.values(s.nodes).some(n => n.params.kind === 'terminal' && !!n.params.beforeBalance))
  rows.push({
    label: '端末の ζ', value: '品番別（下表）',
    note: balanced ? '器材の値（出典は下表）＋ ダンパ調整で足した抵抗（下表に分けて示す）' : '器材の値（出典は下表）',
  })

  // 曲がり — ζ で持つ係数なら、使われている形の ζ90 と角度の補正を載せる
  if (coef.bend?.model === 'zeta') {
    const bm = coef.bend
    const used = new Set<string>()
    let catalogZeta = false
    for (const { node } of ductDetails) {
      if (node.params.kind !== 'duct') continue
      for (const b of ductBends(node.params)) {
        if (typeof b.zeta === 'number') { catalogZeta = true; continue }
        used.add(b.shape && bm.shapes[b.shape] ? b.shape : bm.defaultShape)
      }
    }
    if (used.size > 0 || catalogZeta) {
      const shapes = [...used].map(k => `${bm.shapes[k].label} ζ90 ${formatCoefficient(bm.shapes[k].zeta90)}`)
      if (catalogZeta) shapes.push('器材の ζ（部材ごと）')
      const angles = Object.entries(bm.angleFactor ?? {}).map(([a, f]) => `${a}° ${formatCoefficient(f)}`).join('・')
      rows.push({
        label: '曲がり（局部損失）',
        value: shapes.join(' ／ '),
        note: `ζ90 × 角度の補正（${angles || 'θ/90'}）× 個数 × 動圧。λ によらない。出典: ${[...new Set([...used].map(k => bm.shapes[k].source))].join('／')}${bm.angleFactorSource ? `／角度: ${bm.angleFactorSource}` : ''}`,
      })
    }
  }

  // 曲がり相当長 — 実際に使われている径だけ載せる
  const usedDiameters = distinctSorted(
    payload.systems.flatMap(s =>
      Object.values(s.nodes)
        .filter(n => n.params.kind === 'duct')
        .map(n => (n.params as { diameterMm: number }).diameterMm),
    ),
  ) as DuctDiameter[]
  // 表に無い径は一番近い径の値で計算する（SPEC.md §3）ので、その値を載せる
  const bendRows = usedDiameters.map(d => `φ${d} = ${formatCoefficient(bendEquivLength90(coef, d))} m`)
  if (bendRows.length > 0 && coef.bend?.model !== 'zeta') {
    rows.push({ label: '曲がり相当長', value: `90° ${bendRows.join(' ／ ')}`, note: '設計係数の表（一番近い径の値）。角度に比例配分' })
  }

  // 計算の性格（改良計画 2-1）。設計計算であって、実際の風量配分や運転を解いたものではない
  rows.push({
    label: '風量の扱い',
    value: '設計風量（端末の目標風量から集計）',
    note: '吸込側は端末の目標風量の比で配る設計上の配分。各枝の抵抗から実際の風量配分は解かない',
  })
  rows.push({
    label: '送風機の判定',
    value: '設計点を通る ΔP = k·Q² と機器の特性で推定',
    note: '風量の配分と抵抗が設計どおりの前提。実際の風量は施工後の測定・調整で確かめる',
  })
  const multiFan = payload.systems.some(sys =>
    sys.nodes[sys.rootId] && Object.keys(aggregateFlows(sys.nodes, sys.rootId, 1).aircons).length > 0)
  if (multiFan) {
    rows.push({
      label: '複数の送風機',
      value: '受け持つ区間ごとに評価',
      note: '熱交換器とエアコンの圧力・風量の相互作用は解かない（2 台の運転点は互いに整合しない）',
    })
  }

  for (const note of coef.notes ?? []) rows.push({ label: '係数の注意', value: note, note: '' })

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
