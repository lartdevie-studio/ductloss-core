import type { CalcResult, DuctSystem, DuctLossPayload } from './types'
import { aggregateFlows, fanUpstreamBalance, routeOwner } from './calculator'
import { pathFromRoot, structureIssues, type StructureIssue } from './tree'
import { checkVentilation, isCirculationSystem } from './ventilation'
import { judgeMover, type MoverVerdict } from './verdict'

// ─────────────────────────────────────────────────────────────
// 作図の点検（診断）
//
// 「描いた図が計算の前提を満たしているか」「満たしていないなら何が足りないか」
// を一覧で返す。判定は次の 4 つの観点。
//
//   1. 描きかけ   … 端末が無い / 末端が部材のまま など、計算が成立しない形
//   2. 風量の釣り合い … 上流入力 = 下流合計、エアコンSA = 熱交SA + REC
//   3. 機器能力   … 必要静圧が機器の最大静圧を超えていないか
//   4. ケース整合 … 給気だけで排気が無い、給排気の風量が揃っていない など
//
// 純粋関数。UI から独立させ、表示は DiagnosticsPanel が担当する。
// ─────────────────────────────────────────────────────────────

export type IssueLevel = 'error' | 'warn' | 'info'

export interface Issue {
  id: string
  level: IssueLevel
  /** 見出し（何が条件を満たしていないか） */
  title: string
  /** 具体的な状況と直し方 */
  detail: string
  /** 該当系統（全体に関わるものは null） */
  systemId: string | null
  /** 該当ノード（クリックで選択する。無ければ null） */
  nodeId: string | null
}

/** 末端に置かれていても「描きかけ」とみなさない種別 */
const LEAF_OK_KINDS = new Set(['terminal'])

/** 部材の日本語名（メッセージ用） */
const KIND_JA: Record<string, string> = {
  fan: 'ファン', duct: 'ダクト', filter: 'フィルター', branch: '分岐',
  reducer: 'レデューサ', aircon: 'エアコン', terminal: '端末',
}

/** メッセージ中の部材名。地の文に埋もれないよう「」で括る */
function nodeName(sys: DuctSystem, id: string): string {
  const n = sys.nodes[id]
  if (!n) return `「${id}」`
  return `「${n.label?.trim() || KIND_JA[n.params.kind] || n.params.kind}」`
}

/**
 * 1 系統ぶんの点検。
 */
function diagnoseSystem(sys: DuctSystem, calc: CalcResult): Issue[] {
  const out: Issue[] = []
  const push = (
    level: IssueLevel, key: string, title: string, detail: string, nodeId: string | null = null,
  ) => out.push({ id: `${sys.id}:${key}${nodeId ? `:${nodeId}` : ''}`, level, title, detail, systemId: sys.id, nodeId })

  // ── 0. 木の形 ───────────────────────────────────────────
  // 形が崩れていると、ほかの点検も計算も意図と違う結果になる。先に知らせる。
  const STRUCTURE_TEXT: Record<StructureIssue['kind'], [string, string]> = {
    'cycle':           ['部材のつながりが輪になっています', 'この系統は計算できません。保存データが壊れている可能性があります。'],
    'missing-child':   ['存在しない部材につながっています', 'つながり先の部材が見つかりません。その先は計算に入っていません。'],
    'parent-mismatch': ['部材の親子の記録が食い違っています', '親から見た子と、子から見た親が一致しません。経路の圧損がずれることがあります。'],
    'shared-child':    ['同じ部材が 2 か所につながっています', '風量を二重に数えます。つなぎ直してください。'],
    'orphan':          ['どこにもつながっていない部材があります', 'この部材は計算に入っていません。'],
    'root-has-parent': ['送風機に親が設定されています', '送風機（系統の根）は親を持てません。'],
  }
  const structure = structureIssues(sys.nodes, sys.rootId)
  for (const it of structure) {
    const [title, detail] = STRUCTURE_TEXT[it.kind]
    push('error', `structure-${it.kind}`, title, `${nodeName(sys, it.nodeId)}: ${detail}`, it.nodeId)
  }
  if (structure.some(i => i.kind === 'cycle')) return out

  // 数でない圧損（入力の欠け・壊れた値）。最大を取るときに黙って落ち、必要静圧が小さく出るので必ず知らせる
  for (const [id, r] of Object.entries(calc.byNode)) {
    if (![r.flowQh, r.velocity, r.q, r.lossPa].every(Number.isFinite)) {
      push('error', 'non-finite', '圧損を数として計算できない部材があります',
        `${nodeName(sys, id)}: 径・長さ・ζ などの入力が欠けているか、数ではありません。この部材を含む経路は必要静圧に正しく入っていません。`, id)
    }
  }

  const nodes = Object.values(sys.nodes)
  const downTerminals = nodes.filter(n => n.params.kind === 'terminal' && (n.side ?? 'downstream') === 'downstream')
  const upTerminals   = nodes.filter(n => n.params.kind === 'terminal' && n.side === 'upstream')

  // ── 1. 描きかけ ─────────────────────────────────────────
  if (nodes.length <= 1) {
    push('error', 'empty', '部材が置かれていません',
      `「${sys.name}」はまだ機器だけです。パーツパレットからダクトや端末を繋いでください。`)
    return out   // 以降の判定は意味を持たない
  }

  if (downTerminals.length === 0) {
    push('error', 'no-down-terminal', '吹出側の端末がありません',
      `「${sys.name}」の下流側に端末が 1 つもないため、風量が決まらず圧損を計算できません。`
      + '端末の目標風量が計算の起点です。')
  }

  // 末端が端末以外＝繋ぎ忘れ。
  //
  // 影響は「方向」ではなく「実際に風量が流れているか」で決まる。
  // 上流側は風量比で配分されるが、同じ配分グループに端末付きの兄弟枝が
  // 1 本でもあると端末なしの枝は重み 0 になり、風量も圧損も 0 になる
  // （calculator.ts の distributeWeighted）。下流側は端末の目標風量が
  // 起点なので、端末が無ければやはり 0。実際の計算結果を見て説明する。
  for (const n of nodes) {
    if (n.childIds.length > 0) continue
    if (n.id === sys.rootId) continue
    if (LEAF_OK_KINDS.has(n.params.kind)) continue
    const carriesFlow = (calc.byNode[n.id]?.flowQh ?? 0) > 0
    push('error', 'dangling', '末端が端末になっていません',
      `${nodeName(sys, n.id)}（${KIND_JA[n.params.kind]}）の先に何も繋がっていません。`
      + (carriesFlow
        ? 'ここまでの圧損は必要静圧に入りますが、フード・ガラリ等の端末ぶんが抜けています。'
        : 'この枝は風量が決まらないため、風量 0・圧損 0 として扱われ、必要静圧に入っていません。')
      + '端末まで繋ぐか、この部材を削除してください。', n.id)
  }

  // ── 1b. 送風機として登録されないエアコン／どの送風機にも属さない経路 ──
  //
  // aggregateFlows が第2送風機として登録するのは、root から下流へたどって需要が
  // 届いたエアコン（＝吹出側の子を持つもの）だけ。それ以外のエアコンは通過抵抗
  // （本体通過圧損 ζ）として上位の送風機の経路に含める。意図してそう描くこと
  // （OA プレヒーター等）はあるが、第2送風機のつもりで描いた人には「必要静圧も
  // 合否も出ない」ことが伝わらないので知らせる。
  const moverIds = new Set(calc.secondaryMovers.map(m => m.nodeId))
  const validRoutes = calc.routes.filter(r => routeOwner(sys.nodes, r.path, r.side, moverIds).valid)
  for (const n of nodes) {
    if (n.params.kind !== 'aircon') continue
    if (n.id === sys.rootId) continue
    if (moverIds.has(n.id)) continue
    // 文言は実際の計算結果に合わせる。同じ図で route-orphan / dangling が
    // 「必要静圧に入っていません」と出るのに、ここだけ「含めています」と書くと
    // 点検パネルに正反対の説明が並ぶ。
    //
    // 「含めている」は flowQh > 0 の代理では決められない。風量が流れていても、
    // 通る経路がすべて valid=false（孤立）なら必要静圧のどこにも入っていない。
    // 実際に必要静圧に入る経路（valid なルート）の上にあるかで判定する。
    //
    // 「吸込側に置かれている」も自分の side だけでは決められない。吸込側の枝の下に
    // 吹出側の枝を作り、その先にエアコンを置くと side は downstream だが、
    // root からの経路に吸込側のノードがあるので登録されない（aggregateFlows は
    // root の下流側の子からしか辿らない）。吹出側に端末を足しても直らないので、
    // 経路に吸込側のノードが 1 つでもあれば「置き直す」を案内する。
    const path = pathFromRoot(sys.nodes, n.id)
    const onIntakeSide = path.slice(1).some(id => sys.nodes[id]?.side === 'upstream')
    const onValidRoute = validRoutes.some(r => r.path.includes(n.id))
    const carriesFlow = (calc.byNode[n.id]?.flowQh ?? 0) > 0
    const why = onIntakeSide
      ? 'は上位の送風機の吸込側に置かれているため、送風機としては登録されません。'
      : 'は吹出側に端末が無いため、送風機として登録されていません。'
    const effect = onValidRoute && carriesFlow
      ? '通過抵抗（本体通過圧損 ζ）として上位の送風機の必要静圧に含めています。'
      : !onValidRoute
        ? 'この部材を通る経路が必要静圧の対象になっていないため（点検のエラー参照）、この部材と配下の圧損は必要静圧に入っていません。'
        : '風量が流れないため、この部材と配下の圧損は必要静圧に入っていません。'
    const advice = onIntakeSide
      ? 'OA プレヒーター等の意図ならこのままで構いません。第2送風機として必要静圧と合否を出すなら、吹出側に置き直してください。'
      : '第2送風機として必要静圧と合否を出すなら、吹出側に端末を繋いでください。'
    push('warn', 'aircon-passive', 'エアコンが第2送風機として評価されていません',
      `${nodeName(sys, n.id)}${why}${effect}${advice}`, n.id)
  }
  // 送風機より下の経路に吸込側と吹出側が混ざったルートは、どの送風機の必要静圧にも
  // 入れていない（入れると反対側のトランクを二重計上する）。黙って落とすと
  // 必要静圧が静かに小さくなるので、エラーで知らせる。
  for (const r of calc.routes) {
    const owner = routeOwner(sys.nodes, r.path, r.side, moverIds)
    if (owner.valid) continue
    const ownerName = nodeName(sys, owner.moverId ?? sys.rootId)
    // 直し方は枝の向きで変わる。吸込枝（吹出側に置いたエアコンの下）なら、その
    // エアコンに吹出側の端末を足せば第2送風機になり経路が成立する。吹出枝（吸込側に
    // 置いた部材の下）は、端末を足しても登録されないので、枝ごと吹出側へ繋ぎ直す。
    const advice = r.side === 'upstream'
      ? '（例: 吹出側に置いたエアコンに吸込側の枝だけを繋いだ形）。この経路の圧損は必要静圧に入っていません。'
        + 'エアコンを第2送風機として評価するには吹出側にも端末を繋ぎ、そうでなければこの枝を繋ぎ直してください。'
      : '（例: 吸込側に置いたエアコンの下に吹出側の枝を繋いだ形）。この経路の圧損は必要静圧に入っていません。'
        + '吹出側の枝は送風機の吹出側に繋ぎ直してください。エアコンを第2送風機にするなら吹出側に置き直してください。'
    push('error', 'route-orphan', 'どの送風機の必要静圧にも入っていない経路があります',
      `${nodeName(sys, r.terminalId)}までの経路は、${ownerName}の下で吸込側と吹出側が混ざっています${advice}`,
      r.terminalId)
  }

  // 分岐なのに子が 1 本以下
  for (const n of nodes) {
    if (n.params.kind !== 'branch') continue
    if (n.childIds.length >= 2) continue
    push('warn', 'branch-single', '分岐から 1 系統しか出ていません',
      `${nodeName(sys, n.id)}の先が ${n.childIds.length} 本です。分岐は 2 本以上に枝分かれする部材です。`, n.id)
  }

  // 目標風量が 0 の端末
  for (const n of downTerminals) {
    if (n.params.kind !== 'terminal') continue
    if (n.params.targetFlowQh > 0) continue
    push('warn', 'zero-flow', '端末の目標風量が 0 です',
      `${nodeName(sys, n.id)}の目標風量が入力されていません。この端末は風量 0 として集計されます。`, n.id)
  }

  // 上流（吸込）側が無い。判定は端末の有無ではなく「上流の部材があるか」。
  // 端末なしのダクトだけでも圧損は必要静圧に入るため、それを「無い」とは言えない。
  const hasUpstreamNode = nodes.some(n => n.side === 'upstream' && n.id !== sys.rootId)
  if (!hasUpstreamNode && downTerminals.length > 0) {
    push('warn', 'no-upstream', '吸込側の経路がありません',
      `「${sys.name}」は下流側だけで、必要静圧が吹出側のみの評価になります。`
      + '機器の必要静圧は 上流側＋下流側 です。吸込（OA / RA）側も描いてください。')
  } else if (hasUpstreamNode && upTerminals.length === 0) {
    push('warn', 'no-upstream-terminal', '吸込側に端末がありません',
      `「${sys.name}」の吸込側はダクト等で終わっています。`
      + '外気フード・ガラリ等の端末ぶんが必要静圧に入っていません。'
      + '端末を置いて ζ（または Pa）を入れてください。')
  }

  // ── 2. 風量の釣り合い ────────────────────────────────────
  const balance = fanUpstreamBalance(sys, calc)
  if (!balance.balanced && balance.terminalIds.length > 0) {
    push('warn', 'upstream-balance', '吸込側と吹出側の風量が合っていません',
      `吸込側の入力合計 ${balance.enteredTotal.toFixed(0)} に対し、吹出側の合計は ${balance.requiredTotal.toFixed(0)} m³/h です`
      + `（差 ${balance.diff > 0 ? '+' : ''}${balance.diff.toFixed(0)}）。`
      + '実際の計算は質量保存で按分するため、入力値と表示がずれます。')
  }

  // エアコン: エアコンSA = 熱交SA + REC
  //
  // 入力（リターン量・熱交からの SA）と比べるので、風量の倍率をかけない設計風量で見る
  // （calc は検討モードの倍率込みのことがある）。リターン量を入れているときは
  // 熱交からの SA は計算で決まる値なので、使われていない入力欄の値とは比べない
  // （以前はそれで「熱交換器からのSAが吹出合計を超えています」と誤って出ていた）。
  const design = calc.secondaryMovers.length > 0 ? aggregateFlows(sys.nodes, sys.rootId, 1).aircons : {}
  for (const m of calc.secondaryMovers) {
    const node = sys.nodes[m.nodeId]
    if (node?.params.kind !== 'aircon') continue
    const d = design[m.nodeId]
    const circulation = d?.circulation ?? 0
    if (circulation <= 0) continue
    const returnMode = node.params.returnQh != null && node.params.returnQh >= 0
    if ((d?.intake ?? 0) <= 0) {
      push('warn', 'aircon-no-recirc', 'エアコンの REC が 0 です',
        returnMode
          ? `「${m.label}」のリターン量が 0 のため、吹出合計 ${circulation.toFixed(0)} をすべて熱交換器からの SA でまかなう計算になっています。`
          : `「${m.label}」の吹出合計 ${circulation.toFixed(0)} をすべて熱交換器からの SA でまかなう設定です。`
            + '「熱交換器からのSA」が吹出合計以上になっていないか確認してください。', m.nodeId)
    }
    if (returnMode) {
      const ret = node.params.returnQh as number
      if (ret > circulation + 0.5) {
        push('error', 'aircon-over-return', 'リターン量が吹出合計を超えています',
          `「${m.label}」は リターン ${ret.toFixed(0)} に対し 吹出合計 ${circulation.toFixed(0)} m³/h です。`
          + 'エアコンSA ＝ 熱交SA ＋ REC が成り立たず、REC を吹出合計で頭打ちにして計算しています。', m.nodeId)
      }
    } else {
      const entered = node.params.supplyFromHexQh
      if (entered != null && entered > circulation + 0.5) {
        push('error', 'aircon-over-supply', '熱交換器からのSAが吹出合計を超えています',
          `「${m.label}」は 熱交SA ${entered.toFixed(0)} に対し 吹出合計 ${circulation.toFixed(0)} m³/h です。`
          + 'エアコンSA ＝ 熱交SA ＋ REC が成り立たず、REC が 0 に丸められています。', m.nodeId)
      }
    }
  }

  // ── 3. 機器能力 ─────────────────────────────────────────
  //
  // 判定はひとつ ——「設定風量で、機器が必要静圧を出せるか」。
  // 機外静圧はファン特性の縦軸であって、必要静圧と別に比べる基準ではない。
  // カタログの機外静圧は定格風量での値なので、単独では設定風量を確保できるか
  // 判定できない（1 点比較だけだと風量不足を合格と誤判定する）。詳細は verdict.ts。

  /** 送風機 1 台ぶんの合否を点検に落とす */
  const pushVerdict = (
    v: MoverVerdict, label: string, nodeId: string, keyPrefix: string,
  ) => {
    if (v.level === 'ng') {
      push('error', `${keyPrefix}-flow-short`, '設定風量を確保できません',
        `「${label}」: ${v.summary}。`
        + 'ダクト径を上げる、経路を短くする、曲がりを減らす等の見直しが必要です。', nodeId)
    } else if (v.level === 'insufficient') {
      push('info', `${keyPrefix}-no-characteristic`, '機器の特性が未入力で判定できません',
        `「${label}」は必要静圧 ${v.requiredPa.toFixed(1)} Pa・設定風量 ${v.designQh.toFixed(0)} m³/h です。`
        + (v.caveat ? v.caveat + '。' : '')
        + '機外静圧（と、その定格風量）または P-Q 特性を入れてください。', nodeId)
    }
  }

  // エアコン（第2送風機）は HEX とは別に必要静圧を持つので個別に見る。
  // エアコンは強設定（定格風量）をベースにする決まりなので、循環風量が
  // その定格風量を超えていたら機器の選定そのものを疑う。
  for (const m of calc.secondaryMovers) {
    if (m.requiredPa <= 0) continue
    if (m.maxStaticAtQh != null && m.maxStaticAtQh > 0
        && m.circulationQh > m.maxStaticAtQh * 1.05) {
      push('warn', 'aircon-over-rated-flow', '循環風量が強設定の定格風量を超えています',
        `「${m.label}」の循環風量 ${m.circulationQh.toFixed(0)} m³/h に対し、`
        + `強設定の定格風量は ${m.maxStaticAtQh.toFixed(0)} m³/h です。`
        + '吹出端末の目標風量を見直すか、機器を上位機種にしてください。', m.nodeId)
    }
    pushVerdict(
      judgeMover(m.requiredPa, m.circulationQh, m.maxStaticPa, m.pqPoints, m.maxStaticAtQh),
      m.label, m.nodeId, 'aircon',
    )
  }

  // 主送風機。root はファンとは限らない（ひな型「エアコンのみ」は root がエアコン）
  const root = sys.nodes[sys.rootId]
  const rootParams = root?.params
  if (rootParams && (rootParams.kind === 'fan' || rootParams.kind === 'aircon') && calc.fanRequiredPa > 0) {
    pushVerdict(
      judgeMover(
        calc.fanRequiredPa, calc.fanFlowQh,
        rootParams.maxStaticPa ?? null,
        rootParams.pqPoints ?? null,
        rootParams.maxStaticAtQh ?? null,
      ),
      sys.name, sys.rootId, 'fan',
    )
  }

  return out
}

/**
 * 全系統 + ケース整合の点検。
 */
export function diagnose(
  payload: DuctLossPayload,
  calcBySystem: Record<string, CalcResult>,
): Issue[] {
  const out: Issue[] = []

  for (const sys of payload.systems) {
    const calc = calcBySystem[sys.id]
    if (!calc) continue
    out.push(...diagnoseSystem(sys, calc))
  }

  // ── 4-0. 必要換気量との照合 ──────────────────────────────
  // 気積 × 換気回数 で出した必要換気量に対し、設計した給気が足りているか。
  // 端末風量には書き込まないので、ここで気づけないと誰も気づかない。
  const vent = checkVentilation(payload)
  // 気積は入っているのに換気回数が 0 → 照合が静かに止まる。点検からも消えるので明示する
  if (vent.requiredQh == null && vent.volumeM3 != null && !((payload.ventilation?.achPerH ?? 0) > 0)) {
    out.push({
      id: 'vent:no-ach', level: 'warn', systemId: null, nodeId: null,
      title: '換気回数が入っていないため照合していません',
      detail: `気積 ${vent.volumeM3.toFixed(0)} m³ は入っていますが、換気回数が `
        + `${payload.ventilation?.achPerH ?? 0} です。0 より大きい値`
        + '（住宅等の居室は建築基準法 施行令20条の8 で 0.5 回/h 以上）を入れてください。',
    })
  }
  if (vent.requiredQh != null && vent.ok === false && vent.diffQh != null) {
    out.push({
      id: 'vent:short', level: 'error', systemId: null, nodeId: null,
      title: '給気が必要換気量に足りていません',
      detail: `気積 ${vent.volumeM3?.toFixed(1)} m³ × ${payload.ventilation?.achPerH} 回/h = `
        + `必要換気量 ${vent.requiredQh.toFixed(0)} m³/h に対し、給気の合計は ${vent.supplyQh.toFixed(0)} m³/h です`
        + `（不足 ${(-vent.diffQh).toFixed(0)} m³/h`
        + (vent.actualAch != null ? `／実質 ${vent.actualAch.toFixed(2)} 回/h` : '') + '）。'
        + '端末の目標風量を見直してください。',
    })
  }

  // ── 4. ケース整合（系統をまたぐ） ────────────────────────
  const supply = payload.systems.filter(s => s.type === 'SA')
  const exhaust = payload.systems.filter(s => s.type === 'RE')
  const hasAircon = payload.systems.some(s => (calcBySystem[s.id]?.secondaryMovers.length ?? 0) > 0)

  if (supply.length > 0 && exhaust.length === 0) {
    out.push({
      id: 'case:no-exhaust', level: 'info', systemId: null, nodeId: null,
      title: '排気（RE→EA）系統がありません',
      detail: hasAircon
        ? '熱交換器＋エアコン（Case 3）なら、熱交換器の排気側（RE→EA）も検討対象です。'
        : '熱交換器を使う構成（Case 1 / 3）なら、給気（OA→SA）と排気（RE→EA）の 2 系統になります。'
        + 'エアコンのみ（Case 2）ならこのままで構いません。',
    })
  }

  // 第1種換気なら 給気の総風量 ≒ 排気の総風量
  if (supply.length > 0 && exhaust.length > 0) {
    // 循環系統（root がエアコン）は外気を入れないので数えない。
    // 必要換気量の照合（checkVentilation）と同じ規則にしないと、
    // 同じ画面の「給気の合計」が 2 つあって数字が食い違う。
    const supplyTotal = supply.filter(x => !isCirculationSystem(x))
      .reduce((s, x) => s + (calcBySystem[x.id]?.fanFlowQh ?? 0), 0)
    const exhaustTotal = exhaust.filter(x => !isCirculationSystem(x))
      .reduce((s, x) => s + (calcBySystem[x.id]?.fanFlowQh ?? 0), 0)
    const tol = Math.max(1, Math.max(supplyTotal, exhaustTotal) * 0.05)
    if (supplyTotal > 0 && exhaustTotal > 0 && Math.abs(supplyTotal - exhaustTotal) > tol) {
      out.push({
        id: 'case:sa-ea-imbalance', level: 'warn', systemId: null, nodeId: null,
        title: '給気と排気の総風量が揃っていません',
        detail: `給気 ${supplyTotal.toFixed(0)} / 排気 ${exhaustTotal.toFixed(0)} m³/h（差 ${(supplyTotal - exhaustTotal).toFixed(0)}）。`
          + '熱交換器（第1種換気）では給気と排気を揃えるのが基本です。意図した不均衡でなければ端末の目標風量を見直してください。',
      })
    }
  }

  return out
}

/** レベル別の件数 */
export function countByLevel(issues: Issue[]): Record<IssueLevel, number> {
  return {
    error: issues.filter(i => i.level === 'error').length,
    warn:  issues.filter(i => i.level === 'warn').length,
    info:  issues.filter(i => i.level === 'info').length,
  }
}
