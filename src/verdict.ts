import type { PQPoint } from './pqcurve'
import { fitResistanceK, interpFanP, findOperatingPoints, normalizeFanPoints } from './pqcurve'
import { CHARACTERISTIC_RHO } from './physics'

// ─────────────────────────────────────────────────────────────
// 送風機 1 台の合否判定
//
// 【判定はひとつだけ】
//   設定風量で、機器が必要静圧を出せるか。＝ 設定風量が確保できるか。
//
// 機外静圧は「ファン特性の縦軸」であって、必要静圧と別に比べる独立した
// 基準ではない。カタログの機外静圧は**定格風量での値**なので、設定風量が
// それと違えば比較する相手が違う。
//
//   系統の抵抗   ΔP = k·Q²      （k は 設定風量・必要静圧 の 1 点で決まる）
//   機器の特性   P = f(Q)        （カタログの P-Q。風量が増えると静圧は落ちる）
//   運転点       f(Q) = k·Q² の交点
//
//   設定風量が確保できる ⟺ f(設定風量) ≥ 必要静圧 ⟺ 運転点の風量 ≥ 設定風量
//
// 【なぜ機外静圧の 1 点比較だけでは危ないか】
// 例（架空の小型ファンの特性。P-Q: 0→160, 100→130, 200→90, 300→40 Pa）:
//   必要 110 Pa @ 設定 250 m³/h、機外静圧 160 Pa
//     1 点比較   → 「余裕 50 Pa」で合格に見える
//     特性で判定 → 設定 250 m³/h でこの機器が出せるのは 65 Pa しかない。
//                  運転点は 216 m³/h ＝ 設定風量の 86%。**風量が出ない。**
// 機外静圧 160 Pa は風量が最も少ない側の値であり、設定風量では使えない。
// ─────────────────────────────────────────────────────────────

/** 合否 */
export type VerdictLevel =
  | 'ok'            // 設定風量を確保できる
  | 'ng'            // 確保できない
  | 'insufficient'  // 機器の情報が足りず判定できない

/** 何をもとに判定したか */
export type VerdictBasis =
  | 'curve'       // P-Q 特性（2 点以上）— これが正
  | 'ratedPoint'  // 機外静圧 ＋ その定格風量（1 点）
  | 'flatMax'     // 機外静圧のみ（どの風量の値か不明）— 参考
  | 'none'        // 情報なし

export interface MoverVerdict {
  level: VerdictLevel
  basis: VerdictBasis
  /** 設定風量 (m³/h) */
  designQh: number
  /** 必要静圧 (Pa)。損失の合計 × 余裕率 K（K が 1 なら損失の合計そのもの） */
  requiredPa: number
  /** 損失の合計 (Pa)（上流側 + 下流側。K を掛ける前・0.4.0〜） */
  lossPa: number
  /** 余裕率 K（0.4.0〜。渡さなければ 1） */
  safetyFactor: number
  /**
   * 足りないのは余裕だけか（0.4.0〜）。level が 'ng' で、K を掛けない損失の合計なら機器が出せる（設定風量は出る見込み）とき true。
   * 画面・点検は「風量不足」ではなく「余裕不足」と言う（ダクト径を上げる助言は当てはまらない）
   */
  marginOnly: boolean
  /** 設定風量で機器が出せる機外静圧 (Pa)。分からなければ null */
  availableStaticPa: number | null
  /** 設定風量での余裕 = 出せる静圧 − 必要静圧。負なら足りない */
  marginPa: number | null
  /** 運転点（特性が 2 点以上あるときだけ）。ファンカーブ ∩ 抵抗カーブ */
  operating: PQPoint | null
  /** 運転点の風量 ÷ 設定風量。1.0 で過不足なし */
  flowRatio: number | null
  /** 系統の抵抗係数 k（ΔP = k·Q²）。K を掛けない損失の合計から求める（運転点はこの k で求める） */
  k: number
  /** 判定の但し書き（風量が違う・情報が足りない・前提つき等）。無ければ null */
  caveat: string | null
  /**
   * どの判定にも付く前提（SPEC.md §7）。運転点・合否は、設計点（設定風量・必要静圧）を通る
   * ΔP = k·Q² で系統の抵抗を表した推定で、経路ごとの圧損がそろい風量の配分が設計どおりである
   * ことを前提にする。実際の風量・調整後の風量を示すものではない。
   */
  premise: string
  /**
   * 機器の特性に掛けた倍率（計算の ρ ÷ 特性の ρ 1.20）。ρ を渡さないか 1.20 なら 1。
   * availableStaticPa・operating は、この倍率を掛けた特性で求めた値
   */
  densityRatio: number
  /** 画面・PDF にそのまま出せる 1 行 */
  summary: string
}

/** どの判定にも付く前提（MoverVerdict.premise） */
export const VERDICT_PREMISE =
  '設計点（設定風量・必要静圧）を通る ΔP = k·Q² で系統の抵抗を表した推定です。'
  + '経路ごとの圧損がそろい（ダンパ調整が施工で実現され）、風量の配分が設計どおりであることを前提にしています。'
  + '実際の風量は施工後の測定・調整で確かめてください'

/**
 * 系統の抵抗係数 k を、設計点（設定風量・必要静圧）から求める。
 * ΔP = k·Q² を 1 点で通す（ダクト系は 2 乗則に乗るのでこれで決まる）。
 */
export function systemResistanceK(requiredPa: number, designQh: number): number {
  if (designQh <= 0) return 0
  return fitResistanceK([{ q: designQh, p: requiredPa }])
}

/** 機器の特性として使える点列を作る */
function characteristicPoints(
  maxStaticPa: number | null,
  maxStaticAtQh: number | null | undefined,
  pqPoints: PQPoint[] | null | undefined,
): { pts: PQPoint[]; basis: VerdictBasis } {
  // 同じ風量の重複（後勝ち）・数でない点を、補間と同じ規則で先にそろえる。
  // そろえる前に数えると「同じ風量の 2 点」が曲線（curve）扱いになっていた。
  const pq = normalizeFanPoints(pqPoints ?? [])
  if (pq.length >= 2) return { pts: pq, basis: 'curve' }
  // P-Q が 1 点だけなら、それは「定格風量での機外静圧」そのもの。
  // 黙って捨てて「未入力」と言わない（入れた人は入れたつもりでいる）。
  if (pq.length === 1 && pq[0].q > 0) return { pts: pq, basis: 'ratedPoint' }
  if (maxStaticPa != null && maxStaticAtQh != null && maxStaticAtQh > 0) {
    return { pts: [{ q: maxStaticAtQh, p: maxStaticPa }], basis: 'ratedPoint' }
  }
  if (maxStaticPa != null) return { pts: [{ q: 0, p: maxStaticPa }], basis: 'flatMax' }
  return { pts: [], basis: 'none' }
}

/** 余裕率 K として使える値（正の有限の数）。使えなければ 1（SPEC.md §6） */
export function usableSafetyFactor(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 1
}

/** 保存データの余裕率 K（欄が無い・使えない値なら 1） */
export function safetyFactorOf(payload: { safetyFactor?: number | null } | null | undefined): number {
  return usableSafetyFactor(payload?.safetyFactor)
}

/**
 * 送風機 1 台の合否を出す。
 *
 * @param lossPa        損失の合計（上流側 + 下流側）。必要静圧はこれに余裕率 K を掛けた値
 * @param designQh      設定風量（この送風機を通る風量）
 * @param maxStaticPa   機器の機外静圧。未設定は null
 * @param pqPoints      機器の P-Q 特性（カタログの点列）。未設定は null
 * @param maxStaticAtQh 機外静圧が規定される風量（定格風量）。未設定は null
 * @param rho           計算の空気密度。渡せば機器の特性を ρ / 1.20 倍にして比べる（特性は標準空気の値とみなす。SPEC.md §7）
 */
export function judgeMover(
  lossPa: number,
  designQh: number,
  maxStaticPa: number | null,
  pqPoints: PQPoint[] | null | undefined,
  maxStaticAtQh?: number | null,
  rho?: number,
  /** 余裕率 K（0.4.0〜）。省くと 1（0.3.0 までと同じ結果） */
  safetyFactor?: number | null,
): MoverVerdict {
  // 余裕率 K: 機器と比べる必要静圧は 損失の合計 × K。運転点（系統の抵抗 k）は K を掛けない損失で求める（SPEC.md §6・§7）。
  // 特性の範囲の外での確かめ（右端・左端）は、必要静圧と同じく K を掛けた抵抗 kReq で比べる。K = 1 なら k と同じ
  const safety = usableSafetyFactor(safetyFactor)
  const requiredPa = lossPa * safety
  const k = systemResistanceK(lossPa, designQh)
  const kReq = safety === 1 ? k : systemResistanceK(requiredPa, designQh)
  const densityRatio = rho != null && rho > 0 && Number.isFinite(rho) ? rho / CHARACTERISTIC_RHO : 1
  const scaled = Math.abs(densityRatio - 1) > 1e-9
  const raw = characteristicPoints(maxStaticPa, maxStaticAtQh, pqPoints)
  const basis = raw.basis
  const pts = scaled ? raw.pts.map(p => ({ q: p.q, p: p.p * densityRatio })) : raw.pts
  const premise = scaled
    ? `${VERDICT_PREMISE}。機器の特性は標準空気（1.20 kg/m³）での値とみなし、空気密度 ${rho!.toFixed(3)} kg/m³ に合わせて静圧を ${densityRatio.toFixed(3)} 倍にして比べています`
    : VERDICT_PREMISE

  const base = {
    designQh, requiredPa, lossPa, safetyFactor: safety, marginOnly: false, k, premise, densityRatio,
    availableStaticPa: null as number | null,
    marginPa: null as number | null,
    operating: null as PQPoint | null,
    flowRatio: null as number | null,
  }

  // 風量も必要静圧も無い系統（部材ゼロ・端末ゼロ・新規作成直後）を「✓ 風量確保」と
  // 出さない。0 m³/h を確保できるのは当たり前で、判定として意味が無い。
  if (!(designQh > 0) || !(requiredPa > 0)) {
    return {
      ...base, level: 'insufficient', basis, caveat: null,
      summary: !(designQh > 0)
        ? '設定風量が 0 のため判定できません（端末の目標風量を入れてください）'
        : '必要静圧が 0 のため判定できません（部材を繋いでください）',
    }
  }


  if (basis === 'none') {
    return {
      ...base, level: 'insufficient', basis, caveat: null,
      summary: '機器の機外静圧・P-Q 特性が未入力のため、設定風量を確保できるか判定できません',
    }
  }

  const qh = designQh > 0 ? designQh : 0
  const fmtQ = (n: number) => n.toFixed(0)
  const fmtP = (n: number) => n.toFixed(1)

  // ── 機外静圧のみ（どの風量の値か不明） ──
  // 「必要 > 機外静圧」なら確実に足りない。そうでなくても、設定風量で
  // その静圧が出る保証は無いので合格とは言えない。
  if (basis === 'flatMax') {
    const maxPa = pts[0].p   // 空気密度の倍率を掛けた値（maxStaticPa そのものではない）
    if (requiredPa > maxPa) {
      if (safety !== 1 && lossPa <= maxPa + 1e-9) {
        return {
          ...base, level: 'ng', basis, marginOnly: true,
          availableStaticPa: maxPa, marginPa: maxPa - requiredPa,
          caveat: '機外静圧がどの風量での値か未入力です。損失の合計は機外静圧以内ですが、余裕率 K を見込んだ必要静圧には届きません',
          summary: `必要静圧 ${fmtP(requiredPa)} Pa（損失の合計 ${fmtP(lossPa)} Pa × 余裕率 ${safety.toFixed(2)}）が機外静圧 ${fmtP(maxPa)} Pa を超えています`
            + ' → 余裕率 K を見込むと足りません（損失の合計は機外静圧以内）',
        }
      }
      return {
        ...base, level: 'ng', basis,
        availableStaticPa: maxPa, marginPa: maxPa - requiredPa,
        caveat: '機外静圧がどの風量での値か未入力のため、どの風量でもこの値を超える静圧は出ないとみなしています'
          + '（最大静圧の値なら正しい判定です。定格風量での値なら、設定風量が定格より少ないときは出せることがあるので、定格風量を入れてください）',
        summary: `必要静圧 ${fmtP(requiredPa)} Pa が機外静圧 ${fmtP(maxPa)} Pa を超えています`
          + ` → 設定風量 ${fmtQ(qh)} m³/h は確保できません`,
      }
    }
    return {
      ...base, level: 'insufficient', basis,
      availableStaticPa: maxPa, marginPa: maxPa - requiredPa,
      caveat: '機外静圧は定格風量での値です。設定風量で出せる静圧は P-Q 特性が要ります',
      summary: `必要静圧 ${fmtP(requiredPa)} Pa は機外静圧 ${fmtP(maxPa)} Pa 以内ですが、`
        + `設定風量 ${fmtQ(qh)} m³/h を確保できるかは P-Q 特性を入れないと分かりません`,
    }
  }

  // ── 特性の範囲外は判定しない（外挿しない） ──
  //
  // interpFanP は範囲外を端点でクランプする（pqcurve.ts）。点列の右端より
  // 多い風量を渡すと「右端の静圧がそこから先どこまでも出続ける」ことにされる。
  // ratedPoint で insufficient に落としたのと**同じ外挿の誤り**が、
  // 「これが正」と書いた curve 側に無防備に残っていた。
  // findOperatingPoint も qMin..qMax しか走査しないので運転点は null になり、
  // 「運転点 —」なのに「✓ 風量確保」という表示になる。
  const maxQ = Math.max(...pts.map(p => p.q))
  if (basis === 'curve' && qh > maxQ) {
    // 右端の点で既に抵抗曲線 k·Q² を下回っているなら、運転点は右端より左にある。
    // 設定風量（さらに右）に届くには特性が右端より上がらねばならず、それは無い。
    // 特性から読めないのは「どれだけ足りないか」だけで、足りないこと自体は確定する。
    // 点列は normalizeFanPoints で同じ風量の重複を後勝ちで 1 点にしてあるので、
    // 右端の点は interpFanP / findOperatingPoint が見る点と同じ。
    const right = pts.reduce((a, b) => (b.q >= a.q ? b : a))
    const needAtRight = kReq * right.q * right.q
    // 余裕率 K を掛けない損失なら右端で足りているときは、余裕だけの話で、設定風量（範囲の外）の風量は読めない → 下の「判定できない」へ
    const shortWithoutMargin = safety === 1 || right.p < k * right.q * right.q - 1e-9
    if (right.p < needAtRight - 1e-9 && shortWithoutMargin) {
      const operating = findOperatingPoints(pts, k)[0] ?? null
      const flowRatio = operating ? operating.q / qh : null
      return {
        ...base, level: 'ng', basis,
        availableStaticPa: null, marginPa: null, operating, flowRatio,
        caveat: `設定風量 ${fmtQ(qh)} m³/h は P-Q 特性の範囲（最大 ${fmtQ(maxQ)} m³/h）を超えていますが、`
          + `特性の右端 ${fmtQ(maxQ)} m³/h で出せる静圧 ${fmtP(right.p)} Pa が、その風量で必要な `
          + `${fmtP(needAtRight)} Pa を既に下回っています。設定風量ではさらに足りません`,
        summary: `設定風量 ${fmtQ(qh)} m³/h が P-Q 特性の範囲外（特性は ${fmtQ(maxQ)} m³/h まで）ですが、`
          + '右端で既に必要静圧を下回るため確保できません'
          + (operating
            ? `／運転点 ${fmtQ(operating.q)} m³/h・${fmtP(operating.p)} Pa`
              + (flowRatio != null ? `（設定風量の ${(flowRatio * 100).toFixed(0)}%）` : '')
            : ''),
      }
    }
    return {
      ...base, level: 'insufficient', basis,
      availableStaticPa: null, marginPa: null, operating: null, flowRatio: null,
      caveat: `設定風量 ${fmtQ(qh)} m³/h は P-Q 特性の範囲（最大 ${fmtQ(maxQ)} m³/h）を超えています。`
        + 'その風量での静圧は特性から読めないため判定できません',
      summary: `設定風量 ${fmtQ(qh)} m³/h が P-Q 特性の範囲外です`
        + `（特性は ${fmtQ(maxQ)} m³/h まで）。点を足すか、機器を見直してください`,
    }
  }

  // ── 特性の左端より少ない風量（外挿しない） ──
  //
  // 特性の点は左端（最小風量）から始まることが多い。interpFanP は左端より少ない風量に
  // 左端の静圧を返す（クランプ）が、それは「その風量で出せる静圧」ではない。
  // 以前はその値で ok/ng を決めていたため、左端の静圧 < 必要静圧 のときに根拠の無い
  // 「確保できません」を出し、左端の静圧 ≥ 必要静圧 のときに前提を書かない合格を出していた。
  //   左端の静圧 ≥ 必要静圧 → 右下がりの特性（風量が減ると静圧は上がる）なら確保できる。前提つきの ok
  //   左端の静圧 <  必要静圧 → 特性からは読めない。保留（ng とは言えない）
  const crossings = basis === 'curve' ? findOperatingPoints(pts, k) : []
  const minQ = Math.min(...pts.map(p => p.q))
  if (basis === 'curve' && qh < minQ - 1e-9) {
    const left = pts.reduce((a, b) => (b.q < a.q ? b : a))
    const operating = crossings[0] ?? null
    const flowRatio = operating ? operating.q / qh : null
    if (left.p >= requiredPa - 1e-9) {
      return {
        ...base, level: 'ok', basis,
        availableStaticPa: null, marginPa: null, operating, flowRatio,
        caveat: `設定風量 ${fmtQ(qh)} m³/h は P-Q 特性の範囲（${fmtQ(minQ)} m³/h から）より少ないため、`
          + `特性が右下がり（風量が減ると静圧が上がる）であることを前提に、${fmtQ(minQ)} m³/h での静圧 `
          + `${fmtP(left.p)} Pa 以上が出るとみなしています。低風量側に鞍部がある機器では下回ることがあるので、`
          + '確かめるには低風量側の点を足してください',
        summary: `設定風量 ${fmtQ(qh)} m³/h が P-Q 特性の範囲外（${fmtQ(minQ)} m³/h から）`
          + `／特性の左端の静圧 ${fmtP(left.p)} Pa ≥ 必要静圧 ${fmtP(requiredPa)} Pa`
          + '／→ 右下がりの特性なら設定風量を確保できます（前提つき）',
      }
    }
    return {
      ...base, level: 'insufficient', basis,
      availableStaticPa: null, marginPa: null, operating, flowRatio,
      caveat: `設定風量 ${fmtQ(qh)} m³/h は P-Q 特性の範囲（${fmtQ(minQ)} m³/h から）より少なく、`
        + `特性の左端の静圧 ${fmtP(left.p)} Pa は必要静圧 ${fmtP(requiredPa)} Pa を下回ります。`
        + 'その風量で出せる静圧は特性から読めないため判定できません',
      summary: `設定風量 ${fmtQ(qh)} m³/h が P-Q 特性の範囲外です（特性は ${fmtQ(minQ)} m³/h から）。`
        + '低風量側の点を足すか、機器を見直してください',
    }
  }

  // ── 特性から「設定風量で出せる静圧」を読む ──
  const availableStaticPa = interpFanP(pts, qh)
  const marginPa = availableStaticPa - requiredPa
  const operating = crossings[0] ?? null
  const flowRatio = operating && qh > 0 ? operating.q / qh : null

  // 交点が複数ある特性（鞍部）: 最初の交点（風量の小さい側）が設定風量より少ないなら、
  // 設計点で静圧が足りていても、手前の交点で運転が落ち着くおそれがある。
  // どの交点で安定するかは判定しない（交点を求めることは安定性の判定ではない）ので保留にする。
  if (basis === 'curve' && crossings.length > 1) {
    const list = crossings.map(c => `${fmtQ(c.q)} m³/h・${fmtP(c.p)} Pa`).join('、')
    const multiCaveat = `運転点（P-Q 特性と系統の抵抗の交点）が ${crossings.length} つあります（${list}）。`
      + '特性に鞍部があり、どの点で運転が落ち着くかはこの計算では判定しません'
    if (operating && operating.q < qh * (1 - 1e-6)) {
      return {
        ...base, level: 'insufficient', basis,
        availableStaticPa, marginPa, operating, flowRatio,
        caveat: multiCaveat,
        summary: `設定風量 ${fmtQ(qh)} m³/h で機器が出せる静圧 ${fmtP(availableStaticPa)} Pa`
          + `／必要静圧 ${fmtP(requiredPa)} Pa／最初の運転点 ${fmtQ(operating.q)} m³/h（設定風量の `
          + `${((flowRatio ?? 0) * 100).toFixed(0)}%）／→ 交点が複数あるため判定を保留します`,
      }
    }
  }

  // 定格 1 点のときは、設定風量との位置関係で言えることが変わる。
  // ファン特性は右下がり（風量が増えると静圧は落ちる）なので:
  //   設定風量 ≤ 定格風量 → その風量では機外静圧「以上」出る。ok と言ってよい（安全側）
  //   設定風量 > 定格風量 → その風量では機外静圧「未満」しか出ない。
  //                        interpFanP は 1 点だと外挿せず同じ値を返すので、
  //                        そのまま合格にすると「定格より多い風量を、定格の静圧で回せる」
  //                        という誤った判定になる。確認できないので insufficient に落とす。
  let caveat: string | null = null
  let ok = marginPa >= -1e-9
  let level: VerdictLevel = ok ? 'ok' : 'ng'

  if (basis === 'ratedPoint') {
    const rated = pts[0]
    const ratedQ = rated.q
    const near = Math.abs(ratedQ - qh) <= Math.max(1, ratedQ * 0.05)
    if (near) {
      caveat = `機外静圧の定格風量（${fmtQ(ratedQ)} m³/h）と設定風量が近いため、この 1 点で判定しています`
    } else if (qh < ratedQ) {
      // 定格より少ない風量。右下がりの特性なら定格点より高い静圧が出るが、前向き羽根（多翼）の
      // 機器は低風量側に鞍部を持ち、そこでは定格点を下回ることがある。1 点からは読めない。
      //   定格の静圧 ≥ 必要静圧 → 前提つきの ok（出せる静圧の値は書かない）
      //   定格の静圧 <  必要静圧 → 設定風量ではもっと出るかもしれないので ng とは言えない。保留
      if (!ok) {
        return {
          ...base, level: 'insufficient', basis,
          availableStaticPa: null, marginPa: null, operating: null, flowRatio: null,
          caveat: `設定風量 ${fmtQ(qh)} m³/h は定格風量 ${fmtQ(ratedQ)} m³/h より少なく、`
            + 'その風量で出せる静圧は定格点の 1 点からは読めません',
          summary: `必要静圧 ${fmtP(requiredPa)} Pa は定格風量での機外静圧 ${fmtP(rated.p)} Pa を超えていますが、`
            + `設定風量 ${fmtQ(qh)} m³/h は定格より少ないため、確保できるかは P-Q 特性を入れないと分かりません`,
        }
      }
      return {
        ...base, level: 'ok', basis,
        availableStaticPa: null, marginPa: null, operating: null, flowRatio: null,
        caveat: `設定風量 ${fmtQ(qh)} m³/h は定格風量 ${fmtQ(ratedQ)} m³/h より少ないため、`
          + '特性が右下がり（風量が減ると静圧が上がる）であることを前提に、定格点の静圧以上が出るとみなしています。'
          + '低風量側に鞍部がある機器（多翼送風機など）では下回ることがあるので、確かめるには P-Q 特性が要ります',
        summary: `定格風量 ${fmtQ(ratedQ)} m³/h での機外静圧 ${fmtP(rated.p)} Pa ≥ 必要静圧 ${fmtP(requiredPa)} Pa`
          + `／設定風量 ${fmtQ(qh)} m³/h は定格より少ない／→ 右下がりの特性なら設定風量を確保できます（前提つき）`,
      }
    } else {
      // 定格より多い風量。出せる静圧は定格値より小さいはずで、どれだけ小さいかは 1 点では分からない。
      caveat = `設定風量 ${fmtQ(qh)} m³/h は定格風量 ${fmtQ(ratedQ)} m³/h を超えています。`
        + 'この風量で出せる静圧は定格値より小さくなるため、P-Q 特性を入れないと判定できません'
      // 余裕率 K を掛けない損失の合計なら定格点で足りているときも、K を掛けないときと同じく「判定できない」（設定風量では読めない）
      if (ok || (safety !== 1 && rated.p >= lossPa - 1e-9)) {
        return {
          ...base, level: 'insufficient', basis,
          availableStaticPa: null, marginPa: null, operating: null, flowRatio: null,
          caveat,
          summary: `必要静圧 ${fmtP(requiredPa)} Pa は定格風量での機外静圧 ${fmtP(rated.p)} Pa 以内ですが、`
            + `設定風量 ${fmtQ(qh)} m³/h を確保できるかは P-Q 特性を入れないと分かりません`,
        }
      }
      // 必要静圧が定格の静圧すら超えている → 設定風量ではさらに足りない。ng は確定するが、
      // 設定風量で出せる静圧の値は分からないので書かない
      return {
        ...base, level: 'ng', basis,
        availableStaticPa: null, marginPa: null, operating: null, flowRatio: null,
        caveat: `設定風量 ${fmtQ(qh)} m³/h は定格風量 ${fmtQ(ratedQ)} m³/h を超えており、`
          + '定格点ですでに必要静圧に届いていません',
        summary: `定格風量 ${fmtQ(ratedQ)} m³/h での機外静圧 ${fmtP(rated.p)} Pa が必要静圧 ${fmtP(requiredPa)} Pa を下回ります`
          + `／設定風量 ${fmtQ(qh)} m³/h は定格より多いので、さらに足りません／→ 設定風量を確保できません`,
      }
    }
  }

  const parts: string[] = []
  parts.push(`設定風量 ${fmtQ(qh)} m³/h で機器が出せる静圧 ${fmtP(availableStaticPa)} Pa`)
  parts.push(safety === 1 ? `必要静圧 ${fmtP(requiredPa)} Pa` : `必要静圧 ${fmtP(requiredPa)} Pa（損失の合計 ${fmtP(lossPa)} Pa × 余裕率 ${safety.toFixed(2)}）`)
  if (operating) {
    parts.push(`運転点 ${fmtQ(operating.q)} m³/h・${fmtP(operating.p)} Pa`
      + (flowRatio != null ? `（設定風量の ${(flowRatio * 100).toFixed(0)}%）` : ''))
  }
  // 余裕だけが足りない（K を掛けない損失の合計なら出せる）ときは、風量が出ないとは言わない
  const marginOnly = !ok && safety !== 1 && availableStaticPa >= lossPa - 1e-9
  parts.push(ok
    ? `→ 設定風量を確保できます（余裕 ${fmtP(marginPa)} Pa）`
    : marginOnly
      ? `→ 余裕率 ${safety.toFixed(2)} を見込むと ${fmtP(-marginPa)} Pa 足りません（余裕を見込まなければ設定風量は出る見込み）`
      : `→ 設定風量を確保できません（${fmtP(-marginPa)} Pa 不足）`)

  return {
    ...base,
    level,
    basis,
    marginOnly,
    availableStaticPa,
    marginPa,
    operating,
    flowRatio,
    caveat,
    summary: parts.join('／'),
  }
}
