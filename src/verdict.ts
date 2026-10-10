import type { PQPoint } from './pqcurve'
import { fitResistanceK, interpFanP, findOperatingPoint, normalizeFanPoints } from './pqcurve'

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
  /** 必要静圧 (Pa) */
  requiredPa: number
  /** 設定風量で機器が出せる機外静圧 (Pa)。分からなければ null */
  availableStaticPa: number | null
  /** 設定風量での余裕 = 出せる静圧 − 必要静圧。負なら足りない */
  marginPa: number | null
  /** 運転点（特性が 2 点以上あるときだけ）。ファンカーブ ∩ 抵抗カーブ */
  operating: PQPoint | null
  /** 運転点の風量 ÷ 設定風量。1.0 で過不足なし */
  flowRatio: number | null
  /** 系統の抵抗係数 k（ΔP = k·Q²） */
  k: number
  /** 判定の但し書き（風量が違う・情報が足りない等）。無ければ null */
  caveat: string | null
  /** 画面・PDF にそのまま出せる 1 行 */
  summary: string
}

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

/**
 * 送風機 1 台の合否を出す。
 *
 * @param requiredPa    必要静圧（上流側 + 下流側）
 * @param designQh      設定風量（この送風機を通る風量）
 * @param maxStaticPa   機器の機外静圧。未設定は null
 * @param pqPoints      機器の P-Q 特性（カタログの点列）。未設定は null
 * @param maxStaticAtQh 機外静圧が規定される風量（定格風量）。未設定は null
 */
export function judgeMover(
  requiredPa: number,
  designQh: number,
  maxStaticPa: number | null,
  pqPoints: PQPoint[] | null | undefined,
  maxStaticAtQh?: number | null,
): MoverVerdict {
  const k = systemResistanceK(requiredPa, designQh)
  const { pts, basis } = characteristicPoints(maxStaticPa, maxStaticAtQh, pqPoints)

  const base = {
    designQh, requiredPa, k,
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
    const maxPa = maxStaticPa as number
    if (requiredPa > maxPa) {
      return {
        ...base, level: 'ng', basis,
        availableStaticPa: maxPa, marginPa: maxPa - requiredPa,
        caveat: '機外静圧がどの風量での値か未入力のため、風量を問わず一定とみなしています',
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
    const needAtRight = k * right.q * right.q
    if (right.p < needAtRight - 1e-9) {
      const operating = findOperatingPoint(pts, k)
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

  // ── 特性から「設定風量で出せる静圧」を読む ──
  const availableStaticPa = interpFanP(pts, qh)
  const marginPa = availableStaticPa - requiredPa
  const operating = basis === 'curve' ? findOperatingPoint(pts, k) : null
  const flowRatio = operating && qh > 0 ? operating.q / qh : null

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
    const ratedQ = pts[0].q
    const near = Math.abs(ratedQ - qh) <= Math.max(1, ratedQ * 0.05)
    if (near) {
      caveat = `機外静圧の定格風量（${fmtQ(ratedQ)} m³/h）と設定風量が近いため、この 1 点で判定しています`
    } else if (qh < ratedQ) {
      // 単調右下がりなら定格点より高い静圧が出る。ただし前傾翼（シロッコ）は
      // 締切側と最高効率点の間に鞍部を持ち、そこでは定格点より低いことがある。
      // 「安全側」と断定せず、確かめるなら P-Q が要ると書く。
      caveat = `設定風量 ${fmtQ(qh)} m³/h は定格風量 ${fmtQ(ratedQ)} m³/h より少ないため、`
        + '通常はこれ以上の静圧が出ます。ただし特性に鞍部（サージング領域）がある機器では'
        + '定格点を下回ることがあるので、確かめるには P-Q 特性が要ります'
    } else {
      // 定格より多い風量を要求している。出せる静圧は定格値より小さいはずで、
      // どれだけ小さいかは 1 点では分からない。
      caveat = `設定風量 ${fmtQ(qh)} m³/h は定格風量 ${fmtQ(ratedQ)} m³/h を超えています。`
        + 'この風量で出せる静圧は定格値より小さくなるため、P-Q 特性を入れないと判定できません'
      if (ok) {
        // 「必要 ≤ 定格静圧」でも、設定風量で出せるかは確認できない
        ok = false
        level = 'insufficient'
        return {
          ...base, level, basis,
          availableStaticPa: null, marginPa: null, operating: null, flowRatio: null,
          caveat,
          summary: `必要静圧 ${fmtP(requiredPa)} Pa は定格風量での機外静圧 ${fmtP(pts[0].p)} Pa 以内ですが、`
            + `設定風量 ${fmtQ(qh)} m³/h を確保できるかは P-Q 特性を入れないと分かりません`,
        }
      }
      // 必要静圧が定格静圧すら超えている → 設定風量ではさらに足りない。確実に ng
    }
  }

  const parts: string[] = []
  parts.push(`設定風量 ${fmtQ(qh)} m³/h で機器が出せる静圧 ${fmtP(availableStaticPa)} Pa`)
  parts.push(`必要静圧 ${fmtP(requiredPa)} Pa`)
  if (operating) {
    parts.push(`運転点 ${fmtQ(operating.q)} m³/h・${fmtP(operating.p)} Pa`
      + (flowRatio != null ? `（設定風量の ${(flowRatio * 100).toFixed(0)}%）` : ''))
  }
  parts.push(ok
    ? `→ 設定風量を確保できます（余裕 ${fmtP(marginPa)} Pa）`
    : `→ 設定風量を確保できません（${fmtP(-marginPa)} Pa 不足）`)

  return {
    ...base,
    level,
    basis,
    availableStaticPa,
    marginPa,
    operating,
    flowRatio,
    caveat,
    summary: parts.join('／'),
  }
}
