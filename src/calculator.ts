import type {
  DuctNode,
  DuctSystem,
  NodeResult,
  RouteResult,
  CalcResult,
  SecondaryMover,
  FlowSide,
} from './types'
import { bendEquivLength90, bendZeta, type DesignCoefficients } from './coefficients'
import { airKinematicViscosity, colebrookLambda } from './physics'

/** 計算の環境（SPEC.md §3）。粗さから λ を求めるときの気温（動粘性係数に使う）。省くと 20℃ */
export interface CalcEnv {
  tempC?: number
}
import { findAncestorFan, pathFromRoot, effectiveDiameterMm, reducerDiameters } from './tree'

// ─────────────────────────────────────────────────────────────
// 基礎式（動圧 q = ρv²/2・ダルシー・ワイスバッハ・局部損失 ζ·q。SPEC.md §3）
// ─────────────────────────────────────────────────────────────

export function dynamicPressure(rho: number, v: number): number {
  return (rho * v * v) / 2
}

export function calcVelocity(flowQh: number, diameterMm: number): number {
  if (flowQh <= 0 || diameterMm <= 0) return 0
  const D = diameterMm / 1000
  const A = (Math.PI * D * D) / 4
  return flowQh / 3600 / A
}

export function frictionPerMeter(lambda: number, diameterMm: number, q: number): number {
  if (diameterMm <= 0) return 0
  const D = diameterMm / 1000
  return lambda * (1 / D) * q
}

/** λ として使える値か（正の有限の数）。使えなければ undefined */
export function usableLambda(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
}

export function bendEquivLength(coef: DesignCoefficients, diameterMm: number, angleDeg: number, count: number): number {
  if (count <= 0) return 0
  return bendEquivLength90(coef, diameterMm) * (angleDeg / 90) * count
}

/**
 * ダクト要素の曲がり一覧を返す（最大3種）。
 * params.bends が設定されていればそれ（個数>0のみ）、無ければ旧 bendAngleDeg/bendCount を1種として扱う。
 */
export function ductBends(params: {
  bends?: { angleDeg: number; count: number; shape?: string | null; zeta?: number | null }[]
  bendAngleDeg: number
  bendCount: number
}): { angleDeg: number; count: number; shape?: string | null; zeta?: number | null }[] {
  if (params.bends && params.bends.length > 0) {
    return params.bends.filter(b => b && b.count > 0)
  }
  return params.bendCount > 0 ? [{ angleDeg: params.bendAngleDeg, count: params.bendCount }] : []
}

/** ダクト要素の全曲がりの相当長合計 (m) */
export function ductBendEquivLength(coef: DesignCoefficients, diameterMm: number, params: {
  bends?: { angleDeg: number; count: number }[]
  bendAngleDeg: number
  bendCount: number
}): number {
  return ductBends(params).reduce((s, b) => s + bendEquivLength(coef, diameterMm, b.angleDeg, b.count), 0)
}

// ─────────────────────────────────────────────────────────────
// ノード単体の計算
// ─────────────────────────────────────────────────────────────

export function calcNodeResult(
  coef: DesignCoefficients,
  nodes: Record<string, DuctNode>,
  node: DuctNode,
  flowQh: number,
  rho: number,
  env: CalcEnv = {},
): NodeResult {
  switch (node.params.kind) {
    case 'fan':
      return { flowQh, velocity: 0, q: 0, dpPerMeter: 0, lossPa: 0 }
    case 'duct': {
      const { diameterMm, lengthM, lambda } = node.params
      const v = calcVelocity(flowQh, diameterMm)
      const q = dynamicPressure(rho, v)
      // λ: ダクトの値 → 上流の送風機の既定値 → 係数の λ。「無い」は未設定・null・正の有限の数でない値。
      // 以前は送風機の既定値が未設定だと NaN、null だと 0 になり、必要静圧が黙って 0 Pa になっていた
      const fan = findAncestorFan(nodes, node.id)
      const fanLambda = fan?.params.kind === 'fan' ? fan.params.defaultLambda : undefined
      const own = usableLambda(lambda)
      const fromFan = own == null ? usableLambda(fanLambda) : undefined
      // 直管にも送風機にも λ が無いとき: 粗さの係数なら Colebrook、λ 一定の係数なら係数の λ
      let effectiveLambda: number
      let lambdaSource: 'duct' | 'fan' | 'coefficients' | 'roughness'
      let reynolds: number | undefined
      let material: string | undefined
      if (own != null) { effectiveLambda = own; lambdaSource = 'duct' }
      else if (fromFan != null) { effectiveLambda = fromFan; lambdaSource = 'fan' }
      else if (coef.friction?.model === 'roughness') {
        const key = node.params.material && coef.friction.materials[node.params.material] ? node.params.material : coef.friction.defaultMaterial
        const mat = coef.friction.materials[key]
        reynolds = v * (diameterMm / 1000) / airKinematicViscosity(env.tempC ?? 20, rho)
        effectiveLambda = colebrookLambda(reynolds, (mat?.roughnessMm ?? 0) / diameterMm)
        lambdaSource = 'roughness'
        material = key
      } else { effectiveLambda = coef.lambda; lambdaSource = 'coefficients' }
      const dpPerMeter = frictionPerMeter(effectiveLambda, diameterMm, q)
      if (coef.bend?.model === 'zeta') {
        // 曲がりは λ によらない局部損失（ζ90 × 角度の補正 × 個数 × q）。直管の長さ L は曲がりを含む中心線の長さとする
        const bendZetaSum = ductBends(node.params).reduce((s, b) => s + bendZeta(coef, b) * b.count, 0)
        const frictionPa = dpPerMeter * lengthM
        const bendPa = bendZetaSum * q
        return {
          flowQh, velocity: v, q, dpPerMeter, lossPa: frictionPa + bendPa,
          duct: { lambda: effectiveLambda, lambdaSource, reynolds, material, frictionPa, bendPa, bendModel: 'zeta', bendLengthM: 0, bendZeta: bendZetaSum, equivLengthM: lengthM },
        }
      }
      // 曲がりは最大3種（bends）の相当長を合算。旧データは bendAngleDeg/bendCount を1種扱い。
      // 損失は今までと同じ式（λ/D·q·(L + L曲)）で求め、内訳は別に出す（結果の値を 1 ビットも変えないため）
      const bendLengthM = ductBendEquivLength(coef, diameterMm, node.params)
      const lEquiv = lengthM + bendLengthM
      return {
        flowQh, velocity: v, q, dpPerMeter, lossPa: dpPerMeter * lEquiv,
        duct: {
          lambda: effectiveLambda, lambdaSource, reynolds, material,
          frictionPa: dpPerMeter * lengthM, bendPa: dpPerMeter * bendLengthM, bendModel: 'equivalentLength',
          bendLengthM, bendZeta: diameterMm > 0 ? effectiveLambda * bendLengthM / (diameterMm / 1000) : 0, equivLengthM: lEquiv,
        },
      }
    }
    case 'filter': {
      // フィルターはインライン要素。ζ × q で圧損を計算（terminal と同式）
      const { diameterMm, zeta } = node.params
      const v = calcVelocity(flowQh, diameterMm)
      const q = dynamicPressure(rho, v)
      return { flowQh, velocity: v, q, dpPerMeter: 0, lossPa: zeta * q }
    }
    case 'branch': {
      const { zeta } = node.params
      // 径は接続ダクトから自動（diameterAuto === false のときだけ手入力値）
      const diameterMm = effectiveDiameterMm(nodes, node)
      const v = calcVelocity(flowQh, diameterMm)
      const q = dynamicPressure(rho, v)
      return { flowQh, velocity: v, q, dpPerMeter: 0, lossPa: zeta * q }
    }
    case 'reducer': {
      const { zeta } = node.params
      // ζ の基準断面の径で動圧を求める（SPEC.md §4）。欄の無い保存データは木の葉の側（2026-10 までの決まり）
      const v = calcVelocity(flowQh, reducerDiameters(nodes, node).referenceMm)
      const q = dynamicPressure(rho, v)
      return { flowQh, velocity: v, q, dpPerMeter: 0, lossPa: zeta * q }
    }
    case 'aircon': {
      // エアコン本体の通過圧損。flowQh は循環風量。機外静圧の能力比較は別途。
      const { diameterMm, zeta } = node.params
      const v = calcVelocity(flowQh, diameterMm)
      const q = dynamicPressure(rho, v)
      return { flowQh, velocity: v, q, dpPerMeter: 0, lossPa: zeta * q }
    }
    case 'terminal': {
      const { zeta } = node.params
      // 径は接続ダクトから自動（diameterAuto === false のときだけ手入力値）
      const diameterMm = effectiveDiameterMm(nodes, node)
      const v = calcVelocity(flowQh, diameterMm)
      const q = dynamicPressure(rho, v)
      return { flowQh, velocity: v, q, dpPerMeter: 0, lossPa: zeta * q }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 風量集計（side + エアコン境界を考慮）
//
// 質量保存:
//  - 下流側 (side='downstream'): 端末の targetFlowQh を起点に葉→根へ集計。
//  - 上流側 (side='upstream'): ファン流量を上流端末の風量比で各枝へ配分。
//    上流が複数系統に分岐するケース（熱交換換気の OA/RA 2 経路など）に対応。
//  - エアコン (kind='aircon'): 第 2 の送風機 + 混合点。
//      循環風量 = 下流（供給）側の子の端末合計
//      ファンへ伝える需要 = HEX 供給風量（supplyFromHexQh）で頭打ち
//      追加吸込風量 = 循環 − 供給 → 吸込側（upstream）の子へ風量比で配分
// ─────────────────────────────────────────────────────────────

/** エアコン 1 台分の風量集計 */
interface AirconAgg {
  circulation: number
  supply: number
  intake: number
}

/**
 * 風量集計。
 * @param flowScale 端末風量に一律で掛ける倍率（既定 1）。検討モード用。
 * @returns flows（nodeId→風量）と aircons（エアコン nodeId→循環/供給/吸込）
 */
export function aggregateFlows(
  nodes: Record<string, DuctNode>,
  rootId: string,
  flowScale = 1,
): { flows: Record<string, number>; aircons: Record<string, AirconAgg> } {
  const flows: Record<string, number> = {}
  const aircons: Record<string, AirconAgg> = {}
  const root = nodes[rootId]
  if (!root) return { flows, aircons }

  const isUpstream = (id: string) => nodes[id]?.side === 'upstream'

  // ── netDemand: そのノードが親（上流）から引く流量（上のダクトを流れる量） ──
  // エアコンは循環風量を内部生成するため、上へ伝える需要は supply で頭打ち。
  // 輪のある壊れたデータでも止まるように、計算中の部材にもう一度来たら 0 とする
  // （輪のあるデータは isValidPayloadV4 がはじき、点検が cycle として知らせる）
  const memo: Record<string, number> = {}
  const inProgress = new Set<string>()
  const netDemand = (id: string): number => {
    if (memo[id] != null) return memo[id]
    if (inProgress.has(id)) return 0
    const n = nodes[id]
    if (!n) return 0
    inProgress.add(id)
    // 下流（供給）側の子だけを需要として集計（吸込側＝upstream の子は除外）
    const downKids = n.childIds.filter(c => nodes[c] && !isUpstream(c))
    let val: number
    if (downKids.length === 0) {
      val = n.params.kind === 'terminal' ? Math.max(0, n.params.targetFlowQh) * flowScale : 0
    } else {
      const childSum = downKids.reduce((s, c) => s + netDemand(c), 0)
      if (n.params.kind === 'aircon') {
        const circulation = childSum
        const ret = n.params.returnQh
        let supply: number
        let intake: number
        if (ret != null && ret >= 0) {
          // リターン主モード: リターン量を追加吸込の設計入力とし、供給(HEX)を求める
          intake = Math.min(circulation, ret * flowScale)
          supply = Math.max(0, circulation - intake)
        } else {
          // 旧挙動: HEX供給から intake を逆算（supplyFromHexQh=null は循環=供給 ＝ intake 0）
          const sup = n.params.supplyFromHexQh
          supply = sup != null && sup >= 0 ? Math.min(circulation, sup * flowScale) : circulation
          intake = Math.max(0, circulation - supply)
        }
        aircons[id] = { circulation, supply, intake }
        val = supply
      } else {
        val = childSum
      }
    }
    memo[id] = val
    inProgress.delete(id)
    return val
  }

  // ファン流量 = 下流側の子の netDemand 合計（エアコンは supply で頭打ち）
  let fanFlow = 0
  for (const cid of root.childIds) {
    if (nodes[cid] && !isUpstream(cid)) fanFlow += netDemand(cid)
  }
  flows[rootId] = fanFlow

  // ── 重み（端末風量比）配分ヘルパー: ファン上流 / エアコン吸込 で共用 ──
  const distributeWeighted = (rootIds: string[], total: number) => {
    if (rootIds.length === 0) return
    const weight: Record<string, number> = {}
    const ids: string[] = []
    const weighed = new Set<string>()
    const computeWeight = (id: string): number => {
      const n = nodes[id]
      if (!n || weighed.has(id)) return 0
      weighed.add(id)
      ids.push(id)
      if (n.childIds.length === 0) {
        const w = n.params.kind === 'terminal' ? Math.max(0, n.params.targetFlowQh) * flowScale : 0
        weight[id] = w
        return w
      }
      let s = 0
      for (const c of n.childIds) s += computeWeight(c)
      weight[id] = s
      return s
    }
    let totalW = 0
    for (const rid of rootIds) totalW += computeWeight(rid)
    if (totalW > 0) {
      for (const id of ids) flows[id] = total * (weight[id] / totalW)
    } else {
      // 重み無し → 均等配分（フォールバック）
      const spread = new Set<string>()
      const distributeEqual = (id: string, flow: number) => {
        if (spread.has(id)) return
        spread.add(id)
        flows[id] = flow
        const n = nodes[id]
        if (!n || n.childIds.length === 0) return
        const per = flow / n.childIds.length
        for (const c of n.childIds) distributeEqual(c, per)
      }
      const per = total / rootIds.length
      for (const rid of rootIds) distributeEqual(rid, per)
    }
  }

  // ── 下流サブツリーへ流量を割り当て（エアコン境界・吸込を処理） ──
  const assigned = new Set<string>()
  const assignDown = (id: string) => {
    const n = nodes[id]
    if (!n || assigned.has(id)) return
    assigned.add(id)
    const agg = aircons[id]
    // エアコン本体は循環風量、それ以外は netDemand（エアコン上はsupply、下は循環の按分）
    flows[id] = agg ? agg.circulation : netDemand(id)
    for (const c of n.childIds) {
      if (!isUpstream(c)) assignDown(c)
    }
    // エアコンの吸込（上流側）子に追加吸込風量を風量比で配分
    if (agg) {
      const intakeRoots = n.childIds.filter(c => isUpstream(c))
      distributeWeighted(intakeRoots, agg.intake)
    }
  }
  for (const cid of root.childIds) {
    if (nodes[cid] && !isUpstream(cid)) assignDown(cid)
  }

  // ── ファン上流（OA）に fanFlow を風量比で配分 ──
  const fanUpstreamRoots = root.childIds.filter(c => isUpstream(c))
  distributeWeighted(fanUpstreamRoots, fanFlow)

  return { flows, aircons }
}

// ─────────────────────────────────────────────────────────────
// 1 系統の集計
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// ダンパ調整（端末ζをクリティカルパスに合わせて引き上げる）
// ─────────────────────────────────────────────────────────────

/**
 * 全ルートの圧損をクリティカルパスに「ほぼ」揃える（ダンパ調整）。
 *
 * ポリシー（元のクリティカルパスをそのまま維持するため）:
 *  - クリティカルパス端末は変更しない（ζ そのまま、Pa = critical_pa を維持）
 *  - 他の端末: ζ を引き上げ、Pa を critical_pa − BALANCE_EPSILON_PA まで持ち上げる
 *  - これにより元のクリティカルが必ず最大圧損ルートとして残り、
 *    クリティカルパス判定が他のルートに移らない
 *  - 既に target を超えている非クリティカル（≒ tie）は減らせないため変更しない
 *  - q が 0（風量未設定）の端末はスキップ
 *
 * 圧損入力モードが 'pa' の端末は targetPa も新しい値で同期（表示整合性）。
 */
const BALANCE_EPSILON_PA = 0.01

export function balanceTerminals(system: DuctSystem, calc: CalcResult): DuctSystem {
  // 吹出側のルートを、受け持つ送風機ごとにそろえる（SPEC.md §10）。
  //   主送風機:   基準 ＝ 主送風機の下流側（calc.fanDownstreamPa。受け持つルートと、各エアコンの手前までの幹の最大）
  //   エアコン:   基準 ＝ そのエアコンの供給側（supplyCriticalPa。エアコン本体から吹出口までの区間の最大）
  //   比べる値は、その送風機から先の区間の圧損（主送風機はルート全体、エアコンはエアコン本体から先）。
  // 以前は送風機の別なく系統全体の最大に合わせていたため、エアコンの昇圧分まで主送風機の端末に
  // 背負わせ、主送風機の必要静圧が跳ね上がっていた（実測 12.5 → 41.1 Pa）。送風機ごとにそろえれば、
  // どの送風機の必要静圧も変わらない。
  // 吸込側（OA 等）の端末は質量保存で風量が決まるので対象外。成立していないルートも触らない。
  if (calc.criticalDownstreamIndex === null) return system
  const moverIds = new Set(calc.secondaryMovers.map(m => m.nodeId))
  const targetOf = new Map<string | null, number>([[null, calc.fanDownstreamPa]])
  for (const m of calc.secondaryMovers) targetOf.set(m.nodeId, m.supplyCriticalPa)

  const newNodes = { ...system.nodes }
  for (const route of calc.routes) {
    if (route.side !== 'downstream') continue
    const owner = routeOwner(system.nodes, route.path, route.side, moverIds)
    if (!owner.valid) continue

    const terminal = newNodes[route.terminalId]
    if (!terminal || terminal.params.kind !== 'terminal') continue

    const start = owner.moverId === null ? 0 : route.path.indexOf(owner.moverId)
    if (start < 0) continue
    let owned = 0
    for (let i = start; i < route.path.length; i++) owned += calc.byNode[route.path[i]]?.lossPa ?? 0

    const base = targetOf.get(owner.moverId)
    if (base == null) continue
    // 基準ちょうどのルート（クリティカル）は delta ≤ 0 で触らない。基準より 0.01 Pa 低くそろえるのは、
    // クリティカルが別のルートに移らないようにするため
    const delta = base - BALANCE_EPSILON_PA - owned
    if (delta <= 0.001) continue

    const r = calc.byNode[route.terminalId]
    if (!r || r.q <= 0) continue

    const oldZeta = terminal.params.zeta
    const newZeta = oldZeta + delta / r.q
    const newPa = newZeta * r.q

    newNodes[route.terminalId] = {
      ...terminal,
      params: {
        ...terminal.params,
        zeta: newZeta,
        // Pa 入力の端末は、新しい ζ で生じる Pa を目標圧損に書き戻す（ζ と Pa を食い違わせない）
        targetPa: terminal.params.pressureMode === 'pa' ? newPa : terminal.params.targetPa,
        // 調整前の値を残す（2 回目以降の調整では最初の値を残す）。取り消しはここへ戻す
        beforeBalance: terminal.params.beforeBalance
          ?? { zeta: oldZeta, targetPa: terminal.params.targetPa },
      },
    }
  }
  return { ...system, nodes: newNodes }
}

/**
 * ダンパ調整（balanceTerminals）を押して、何か 1 つでも端末の ζ が変わるか。
 *
 * 以前は「下流のルートが 2 本以上」で押せるかを決めていたため、成立していない
 * ルート（点検がエラーで知らせる孤立ルート）や同じ圧損のルートまで数え、
 * 押しても何も変わらないボタンが有効のまま出ていた。
 * 実際に調整した結果と比べるので、押せる＝必ず何かが変わる。
 */
export function canBalanceTerminals(system: DuctSystem, calc: CalcResult): boolean {
  if (calc.criticalDownstreamIndex === null) return false
  const next = balanceTerminals(system, calc)
  return Object.keys(system.nodes).some(id => {
    const a = system.nodes[id].params
    const b = next.nodes[id]?.params
    return a.kind === 'terminal' && b?.kind === 'terminal' && a.zeta !== b.zeta
  })
}

/**
 * ダンパ調整の取り消し: 調整前の値（`beforeBalance`）を持つ端末を、その値に戻す（SPEC.md §10）。
 * 記録の無い端末（調整していない・2026-10 より前の版で調整した）には触らない。係数は使わない。
 */
export function undoBalanceTerminals(system: DuctSystem): DuctSystem {
  let changed = false
  const newNodes = { ...system.nodes }
  for (const [id, node] of Object.entries(system.nodes)) {
    if (node.params.kind !== 'terminal' || !node.params.beforeBalance) continue
    const { beforeBalance, ...rest } = node.params
    newNodes[id] = { ...node, params: { ...rest, zeta: beforeBalance.zeta, targetPa: beforeBalance.targetPa } }
    changed = true
  }
  return changed ? { ...system, nodes: newNodes } : system
}

/** 取り消せるダンパ調整があるか（調整前の値を持つ端末が 1 つでもあるか） */
export function canUndoBalanceTerminals(system: DuctSystem): boolean {
  return Object.values(system.nodes).some(n => n.params.kind === 'terminal' && !!n.params.beforeBalance)
}

/**
 * 吹出側の端末の ζ を既定値に戻す。
 *  - 器材カタログから選んだ端末（catalogRef あり）は既定値にしない。ダンパ調整していれば調整前の値に戻す
 *    （以前はカタログの ζ まで係数の既定値で上書きし、計算書の「出典」と食い違っていた）
 *  - それ以外の端末は ζ = coef.zeta.terminal。調整前の値の記録も消す
 *  - 吸込側の端末は触らない（balance と同じ範囲）
 *  - pressureMode は維持。'pa' の端末は **その ζ で実際に生じる Pa** を targetPa に同期する
 *
 * ⚠ ζ と targetPa を別々に書いてはいけない。以前は `targetPa: 既定の端末 Pa` と
 * 決め打ちしていたため、Pa 入力モードの端末で「目標 5 Pa／ζ 1.000」と表示しながら
 * 実際の圧損は 0.7 Pa、という**画面が嘘をつく状態**になっていた。
 *
 * @param calc その系統の計算結果（設計風量）。'pa' モードの端末で動圧 q を読むのに要る
 */
export function resetTerminals(coef: DesignCoefficients, system: DuctSystem, calc?: CalcResult): DuctSystem {
  const newNodes = { ...system.nodes }
  for (const [id, node] of Object.entries(system.nodes)) {
    if (node.params.kind !== 'terminal') continue
    if (node.side === 'upstream') continue
    const { beforeBalance, ...rest } = node.params
    if (rest.catalogRef) {
      if (beforeBalance) newNodes[id] = { ...node, params: { ...rest, zeta: beforeBalance.zeta, targetPa: beforeBalance.targetPa } }
      continue
    }
    const zeta = coef.zeta.terminal
    // Pa モードは ζ×q を表示 Pa にする。q が無い（計算前・風量 0）ときだけ既定値に置く
    const q = calc?.byNode[id]?.q ?? 0
    const targetPa = rest.pressureMode === 'pa'
      ? (q > 0 ? zeta * q : coef.terminalPa)
      : coef.terminalPa
    newNodes[id] = { ...node, params: { ...rest, zeta, targetPa } }
  }
  return { ...system, nodes: newNodes }
}

// ─────────────────────────────────────────────────────────────
// ルートを受け持つ送風機
//
// 必要静圧は「送風機 1 台 ＝ 上流側（吸込）＋ 下流側（吹出）」の単位で出す。
// そのために各ルート（root→末端）を、主送風機（root）か、第2送風機として
// 登録されたエアコン（aggregateFlows の aircons）のどれかに振り分ける。
//
// 振り分けの規則はここ 1 か所に置く。計算根拠表（CalcMatrix）も点検
// （diagnostics）も同じ関数で判定しないと、必要静圧と表の数字が食い違う。
// ─────────────────────────────────────────────────────────────

export interface RouteOwner {
  /** 受け持つ送風機のノード id。null は主送風機（root） */
  moverId: string | null
  /**
   * 経路が成立しているか。送風機より下の経路に反対側のノードが混ざっていると false。
   *
   * 例: 吹出側に置いたエアコンに吸込側の枝だけを繋いだ形。そのエアコンは吹出側の
   * 端末を持たないので送風機として登録されず、吸込枝のルートは root→SA主管→…と
   * 吹出側のトランクを通ったまま「上流ルート」になる。これを主送風機の上流側に
   * 入れると SA 主管を上流と下流で二重計上する。false のルートはどの送風機の
   * 必要静圧にも入れず、点検（diagnostics: route-orphan）で知らせる。
   */
  valid: boolean
}

/**
 * 経路（root→末端）を受け持つ送風機を決める。
 *
 * @param moverIds 第2送風機として登録されたエアコンの id 集合（calc.secondaryMovers）
 *
 * `kind === 'aircon'` で判定してはいけない。aggregateFlows が登録するのは root から
 * 下流へたどって需要が届いたエアコンだけで、ファンの上流側に置いたエアコン
 * （OA プレヒーター等）や吹出側の端末を持たないエアコンは登録されない。
 * 登録されないエアコンは送風機ではなく通過抵抗（本体通過圧損 ζ）として、
 * 上位の送風機の経路にそのまま含める。kind で弾くと、その配下のルートが
 * どの送風機にも属さず必要静圧から静かに落ちる（実測で 15 倍過小だった）。
 */
export function routeOwner(
  nodes: Record<string, DuctNode>,
  path: string[],
  side: FlowSide,
  moverIds: ReadonlySet<string>,
): RouteOwner {
  // 末端に最も近い登録済み送風機。末端自身は送風機ではない（送風機は子を持つ）
  let moverIdx = 0
  let moverId: string | null = null
  for (let i = path.length - 2; i >= 1; i--) {
    if (moverIds.has(path[i])) { moverIdx = i; moverId = path[i]; break }
  }
  let valid = true
  for (let i = moverIdx + 1; i < path.length; i++) {
    if ((nodes[path[i]]?.side ?? 'downstream') !== side) { valid = false; break }
  }
  return { moverId, valid }
}

/** 上流（OA）風量の入力合計 と 必要合計（=下流合計）の照合結果 */
export interface UpstreamBalance {
  /** ファン直下 OA 系上流端末の targetFlowQh 入力合計 */
  enteredTotal: number
  /** 必要合計（質量保存より = ファン総風量 = 下流合計） */
  requiredTotal: number
  /** enteredTotal − requiredTotal */
  diff: number
  /** 釣り合っているか（許容差内 or 上流端末なし） */
  balanced: boolean
  /** 対象の上流端末 id 群（エアコン吸込は除外） */
  terminalIds: string[]
}

/**
 * ファン直下の OA（上流）端末について、入力風量の合計が
 * 下流合計（=ファン総風量）と釣り合っているかを確認する。
 *
 * 計算自体は風量比で配分するため実流量は常に保存されるが、ユーザーが
 * 入力した「設計上の」上流風量が下流と食い違っていると、画面表示と入力値が
 * ずれる（再スケールされる）。その不整合を検知してアラート表示するための情報。
 * エアコンの追加吸込は循環−供給で自動決定されるため対象外。
 */
export function fanUpstreamBalance(system: DuctSystem, calc: CalcResult): UpstreamBalance {
  const nodes = system.nodes
  const moverIds = new Set(calc.secondaryMovers.map(m => m.nodeId))
  const ids: string[] = []
  let entered = 0
  for (const [id, n] of Object.entries(nodes)) {
    if (n.params.kind !== 'terminal') continue
    if (n.side !== 'upstream') continue
    // 登録済みエアコンの吸込（REC）は循環−供給で自動決定されるので別管理。
    // 未登録のエアコン（OA プレヒーター等）の先の端末は主送風機の OA なので数える。
    // 経路が成立していない端末（吹出側に置いたエアコンの吸込枝）は対象外。
    const owner = routeOwner(nodes, pathFromRoot(nodes, id), 'upstream', moverIds)
    if (owner.moverId !== null || !owner.valid) continue
    ids.push(id)
    entered += Math.max(0, n.params.targetFlowQh)
  }
  // 入力（目標風量）どうしの比べなので、風量の倍率をかけない設計風量と比べる。
  // calc.fanFlowQh は検討モードの倍率込みのことがあり、入力どおりでも食い違いが出ていた
  const required = aggregateFlows(nodes, system.rootId, 1).flows[system.rootId] ?? 0
  const diff = entered - required
  const tol = Math.max(0.5, required * 0.005)
  return {
    enteredTotal: entered,
    requiredTotal: required,
    diff,
    balanced: ids.length === 0 || Math.abs(diff) <= tol,
    terminalIds: ids,
  }
}

export function calcSystem(coef: DesignCoefficients, system: DuctSystem, rho: number, flowScale = 1, env: CalcEnv = {}): CalcResult {
  const { flows, aircons } = aggregateFlows(system.nodes, system.rootId, flowScale)
  const nodes = system.nodes

  const byNode: Record<string, NodeResult> = {}
  for (const [id, node] of Object.entries(system.nodes)) {
    byNode[id] = calcNodeResult(coef, system.nodes, node, flows[id] ?? 0, rho, env)
  }

  // ルートは「枝の末端」ごとに 1 本。末端が端末（ディフューザー等）とは限らない。
  //
  // 端末で終わる枝だけを数えると、端末を描いていない枝の圧損がどこにも
  // 足されない。OA 吸込はフード・ガラリを部材として描かずダクトやフィルターで
  // 終わらせることが多く、その枝の損失（ダクト摩擦・フィルター差圧）が丸ごと
  // 必要静圧から抜け落ちていた。末端の種別に関わらずルートにする。
  //
  // ただし風量が流れない枝はルートにしない。端末で終わっていない枝は風量の
  // 根拠が無く、質量保存では 0 になることがある（下流側は netDemand が 0、
  // 上流側も同じ配分グループに端末付きの兄弟枝があれば重み 0 になる）。
  // route.totalPa は root からの経路全体の合計なので、枝自身が 0 Pa でも
  // 共有トランクの圧損を引き継いで非ゼロの「実在しない経路」になってしまう。
  // 必要静圧は元々変わらない（兄弟の端末ルートが必ず同値以上）が、
  // 計算根拠表に風量 0 の列が並んで読み手が実在のダクトと誤読する。
  const routes: RouteResult[] = []
  for (const [id, node] of Object.entries(system.nodes)) {
    if (node.childIds.length > 0) continue
    if (id === system.rootId) continue   // 部材が 1 つも無い系統
    if (node.params.kind !== 'terminal' && (flows[id] ?? 0) <= 0) continue
    const path = pathFromRoot(system.nodes, id)
    const side: FlowSide = node.side ?? 'downstream'
    // 送風機本体（root）の通過圧損は下流側（吹出）で 1 回だけ数える。上流ルートにも
    // 入れると、root がエアコンの系統で本体通過圧損が上流＋下流の 2 回、必要静圧に
    // 入っていた（登録済みエアコンの吸込側は本体の次から数えており、矛盾していた）。
    // ファンは lossPa = 0 なので影響しない。
    let total = 0
    for (let i = side === 'upstream' ? 1 : 0; i < path.length; i++) total += byNode[path[i]]?.lossPa ?? 0
    // 検討モード時は倍率を反映した実流量で表示（flows[id] = targetFlowQh × flowScale）
    const fallbackFlow = node.params.kind === 'terminal' ? node.params.targetFlowQh * flowScale : 0
    routes.push({
      terminalId: id,
      path,
      totalPa: total,
      terminalFlowQh: flows[id] ?? fallbackFlow,
      side,
      endsAtTerminal: node.params.kind === 'terminal',
    })
  }
  // 下流ルートを上に、上流ルートを下に。同方向内では totalPa 降順、tie-break は terminalId
  routes.sort((a, b) => {
    if (a.side !== b.side) return a.side === 'downstream' ? -1 : 1
    return b.totalPa - a.totalPa || a.terminalId.localeCompare(b.terminalId)
  })

  // ── ルートを受け持つ送風機（routeOwner）──
  // クリティカル判定より先に求める。成立していないルート（valid=false）は
  // どの送風機の必要静圧にも入らないので、クリティカルにもしない。
  // ★・系統図の強調・PDF 見出し・AI の「クリティカルパス」・ダンパ調整の目標が
  // 必要静圧のどこにも無い Pa を指すことになるため。
  const airconIds = Object.keys(aircons)
  const moverIds = new Set(airconIds)
  const owners = routes.map(r => routeOwner(nodes, r.path, r.side, moverIds))

  // 全体クリティカル
  let critIdx: number | null = null
  let critPa = -Infinity
  routes.forEach((r, i) => {
    if (!owners[i].valid) return
    if (r.totalPa > critPa) { critPa = r.totalPa; critIdx = i }
  })

  // 方向別クリティカル
  let critDownIdx: number | null = null, critDownPa = -Infinity
  let critUpIdx:   number | null = null, critUpPa   = -Infinity
  routes.forEach((r, i) => {
    if (!owners[i].valid) return
    if (r.side === 'downstream' && r.totalPa > critDownPa) { critDownPa = r.totalPa; critDownIdx = i }
    if (r.side === 'upstream'   && r.totalPa > critUpPa)   { critUpPa   = r.totalPa; critUpIdx   = i }
  })

  // ── 送風機ごとの必要静圧（主送風機 + 第2送風機のエアコン） ──
  //
  // 各ルートを「受け持つ送風機」に振り分ける（routeOwner）。登録済みエアコンが
  // 1 台も無ければ全ルートが主送風機のもので、従来の「上流クリティカル＋下流
  // クリティカル」と同じ値になる。振り分けの規則は routeOwner に集約してあり、
  // 計算根拠表（CalcMatrix）と点検（diagnostics）も同じ関数で判定する。
  //
  // 必要静圧の内訳（上流側・下流側）は「その送風機が受け持つ区間」の値であり、
  // エアコンがある場合は系統全体のクリティカルとは一致しない。表示で
  // 「上流 + 下流 = 必要静圧」が必ず成立するよう、合計と同じ根拠の値を返す。

  /** path の [from, to) 区間の lossPa 合計 */
  const sumLoss = (path: string[], from: number, to: number): number => {
    let s = 0
    for (let i = from; i < to; i++) s += byNode[path[i]]?.lossPa ?? 0
    return s
  }

  // 主送風機: 受け持つルートの方向別の最大。上流ルートの totalPa は root の次から
  // 数えてあるので、root がエアコンでも本体通過圧損は下流側にしか入らない。
  let fanUpstreamPa = 0
  let fanDownstreamPa = 0
  routes.forEach((r, i) => {
    const o = owners[i]
    if (!o.valid || o.moverId !== null) return
    if (r.side === 'upstream') { if (r.totalPa > fanUpstreamPa) fanUpstreamPa = r.totalPa }
    else if (r.totalPa > fanDownstreamPa) fanDownstreamPa = r.totalPa
  })
  // ファン → エアコン入口までの供給ダクトも主送風機の下流側
  // （エアコン本体の損失は除外＝エアコン側の供給側で計上）
  for (const aid of airconIds) {
    const path = pathFromRoot(nodes, aid) // root..aircon
    const loss = sumLoss(path, 0, path.length - 1)
    if (loss > fanDownstreamPa) fanDownstreamPa = loss
  }
  const fanRequiredPa = fanUpstreamPa + fanDownstreamPa

  // ── 各エアコン区間: 供給側（本体→吹出）+ 吸込側（吸込口→本体の手前） ──
  const secondaryMovers: SecondaryMover[] = []
  for (const aid of airconIds) {
    const agg = aircons[aid]
    let supplyPa = 0
    let intakePa = 0
    routes.forEach((r, i) => {
      const o = owners[i]
      if (!o.valid || o.moverId !== aid) return
      const idx = r.path.indexOf(aid)
      if (idx < 0) return
      if (r.side === 'downstream') {
        // 供給側: エアコン本体（idx）から吹出端末まで
        const loss = sumLoss(r.path, idx, r.path.length)
        if (loss > supplyPa) supplyPa = loss
      } else {
        // 吸込側: エアコンの次（idx+1）から吸込口まで（本体損失は供給側で計上済）
        const loss = sumLoss(r.path, idx + 1, r.path.length)
        if (loss > intakePa) intakePa = loss
      }
    })
    const acNode = nodes[aid]
    secondaryMovers.push({
      nodeId:           aid,
      label:            acNode?.label || 'エアコン',
      maxStaticPa:      acNode?.params.kind === 'aircon' ? (acNode.params.maxStaticPa ?? null) : null,
      maxStaticAtQh:    acNode?.params.kind === 'aircon' ? (acNode.params.maxStaticAtQh ?? null) : null,
      pqPoints:         acNode?.params.kind === 'aircon' ? (acNode.params.pqPoints ?? null) : null,
      circulationQh:    agg.circulation,
      supplyFromHexQh:  agg.supply,
      intakeQh:         agg.intake,
      supplyCriticalPa: supplyPa,
      intakeCriticalPa: intakePa,
      requiredPa:       supplyPa + intakePa,
    })
  }

  return {
    byNode,
    routes,
    criticalRouteIndex:      critIdx,
    criticalDownstreamIndex: critDownIdx,
    criticalUpstreamIndex:   critUpIdx,
    fanFlowQh:               flows[system.rootId] ?? 0,
    fanRequiredPa,
    fanUpstreamPa,
    fanDownstreamPa,
    secondaryMovers,
  }
}
