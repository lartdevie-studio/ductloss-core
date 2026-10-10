// ─────────────────────────────────────────────────────────────
// P-Q 曲線エンジン（純ロジック）
//
// カタログの (風量Q, 静圧/圧損P) 数点から曲線を「逆算」し、
// 描画用サンプリング・運転点（交点）計算を提供する。
//
// 2 種類のカーブを扱う:
//   1) 抵抗カーブ（フィルター・ダクト・系統など固定形状）
//      物理的に ΔP = k·Q²。点群から係数 k を最小二乗で求める。
//      → 1 点でも決まる（複数点で平均的に当てる）。
//   2) ファン P-Q 特性
//      2乗則ではない（流量増で静圧減、凹みもある）。
//      点間を区分線形補間する（多項式フィットの波打ちを避ける）。
//
// 運転点 = ファンカーブ ∩ 抵抗カーブ（ΔP=k·Q²）の交点。
// ─────────────────────────────────────────────────────────────

export interface PQPoint { q: number; p: number }

// ── 抵抗カーブ ΔP = k·Q² ──────────────────────────────────────

/**
 * 点群から ΔP = k·Q² の係数 k を最小二乗で求める。
 * 最小二乗解: k = Σ(Q²·P) / Σ(Q⁴)
 */
export function fitResistanceK(points: PQPoint[]): number {
  let num = 0, den = 0
  for (const { q, p } of points) {
    const q2 = q * q
    num += q2 * p
    den += q2 * q2
  }
  return den > 0 ? num / den : 0
}

/** 抵抗カーブの圧損: ΔP(Q) = k·Q² */
export function resistanceP(k: number, q: number): number {
  return k * q * q
}

/** 抵抗カーブの描画用サンプル（0 〜 qMax を n 分割） */
export function sampleResistance(k: number, qMax: number, n = 40): PQPoint[] {
  const pts: PQPoint[] = []
  for (let i = 0; i <= n; i++) {
    const q = (qMax * i) / n
    pts.push({ q, p: resistanceP(k, q) })
  }
  return pts
}

// ── ファン P-Q カーブ（区分線形補間） ─────────────────────────

/**
 * ファン点列を補間の前提の形にそろえる。
 *   - 数でない点（NaN・Infinity）と負の風量は捨てる
 *   - 同じ風量の点が複数あれば**後に書いた方**を残す（入力欄で書き直した値を正とする）
 *   - Q 昇順に並べる
 *
 * 同じ風量で静圧が違う 2 点が残ると、その風量で補間が不連続になり、
 * 右端の静圧（注記）と運転点の静圧が別の値になっていた。
 */
export function normalizeFanPoints(points: readonly PQPoint[]): PQPoint[] {
  const byQ = new Map<number, number>()
  for (const pt of points) {
    if (!pt || !Number.isFinite(pt.q) || !Number.isFinite(pt.p) || pt.q < 0) continue
    byQ.delete(pt.q)
    byQ.set(pt.q, pt.p)
  }
  return [...byQ.entries()].map(([q, p]) => ({ q, p })).sort((a, b) => a.q - b.q)
}

/** Q 昇順に整列したファン点列を返す（補間の前提） */
function sortedFan(points: readonly PQPoint[]): PQPoint[] {
  return normalizeFanPoints(points)
}

/**
 * ファン P-Q を区分線形補間して、指定 Q での静圧 P を返す。
 * 範囲外は端点で端を延長（クランプ）。点が無ければ 0。
 */
export function interpFanP(points: PQPoint[], q: number): number {
  const pts = sortedFan(points)
  if (pts.length === 0) return 0
  if (pts.length === 1) return pts[0].p
  if (q <= pts[0].q) return pts[0].p
  if (q >= pts[pts.length - 1].q) return pts[pts.length - 1].p
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1]
    if (q >= a.q && q <= b.q) {
      const t = (q - a.q) / (b.q - a.q || 1)
      return a.p + t * (b.p - a.p)
    }
  }
  return pts[pts.length - 1].p
}

/** ファンカーブの描画用サンプル（点列をそのまま線で結ぶ前提でも良いが、密にしたい場合用） */
export function sampleFan(points: PQPoint[], n = 40): PQPoint[] {
  const pts = sortedFan(points)
  if (pts.length < 2) return pts
  const qMin = pts[0].q, qMax = pts[pts.length - 1].q
  const out: PQPoint[] = []
  for (let i = 0; i <= n; i++) {
    const q = qMin + ((qMax - qMin) * i) / n
    out.push({ q, p: interpFanP(pts, q) })
  }
  return out
}

// ── 運転点（ファン ∩ 抵抗） ───────────────────────────────────

/**
 * ファン P-Q（区分線形）と 抵抗カーブ ΔP=k·Q² の交点（運転点）を求める。
 * f(Q) = interpFanP(Q) − k·Q² の符号反転を二分法で探す。
 * 交点が無ければ null。
 */
export function findOperatingPoint(fanPoints: PQPoint[], k: number): PQPoint | null {
  const pts = sortedFan(fanPoints)
  if (pts.length < 2 || k <= 0) return null

  const f = (q: number) => interpFanP(pts, q) - resistanceP(k, q)
  const qMin = pts[0].q
  const qMax = pts[pts.length - 1].q

  // 走査して符号反転区間を探す
  const N = 200
  let qa = qMin, fa = f(qa)
  for (let i = 1; i <= N; i++) {
    const qb = qMin + ((qMax - qMin) * i) / N
    const fb = f(qb)
    if (fa === 0) return { q: qa, p: interpFanP(pts, qa) }
    if (fa * fb < 0) {
      // 二分法
      let lo = qa, hi = qb
      for (let k2 = 0; k2 < 40; k2++) {
        const mid = (lo + hi) / 2
        const fm = f(mid)
        if (fa * fm <= 0) hi = mid
        else { lo = mid; fa = fm }
      }
      const qStar = (lo + hi) / 2
      return { q: qStar, p: interpFanP(pts, qStar) }
    }
    qa = qb; fa = fb
  }
  // 右端でちょうど交わるとき（ループは各区間の左端しか 0 を見ない）
  if (Math.abs(fa) <= 1e-9) return { q: qa, p: interpFanP(pts, qa) }
  return null
}

/**
 * カタログ点（少数）から ΔP=k·Q² を当て、設計風量での圧損を返す簡便関数。
 * 端末/フィルター等の「カタログ差圧 → 任意風量での圧損」用途。
 */
export function resistanceAtFlow(catalogPoints: PQPoint[], qTarget: number): number {
  const k = fitResistanceK(catalogPoints)
  return resistanceP(k, qTarget)
}
