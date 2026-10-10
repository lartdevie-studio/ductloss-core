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
 * ファン P-Q（点を線でつないだ折れ線）と 抵抗カーブ ΔP=k·Q² の交点を**すべて**求める。
 *
 * 線分ごとに p = a + b·Q と置き、k·Q² − b·Q − a = 0 を解く（解析解）。
 * 以前の「200 分割で符号が変わる区間を探して二分法」は、区間より細い線分の交点・
 * 接するだけの点・端点ちょうどの交点を取りこぼすことがあった。
 *
 * - 範囲は特性の点の最小風量〜最大風量。範囲の外へは延ばさない
 * - 接する点（重解）も交点に数える
 * - k = 0（抵抗なし）は p = 0 になる点
 * - 戻り値は風量の小さい順。同じ点（線分の境目で 2 回見つかったもの）は 1 つにまとめる
 */
export function findOperatingPoints(fanPoints: readonly PQPoint[], k: number): PQPoint[] {
  const pts = sortedFan(fanPoints)
  if (pts.length < 2 || !(k >= 0) || !Number.isFinite(k)) return []
  const roots: number[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i], p1 = pts[i + 1]
    const dq = p1.q - p0.q
    if (!(dq > 0)) continue
    const b = (p1.p - p0.p) / dq
    const a = p0.p - b * p0.q
    const tol = 1e-9 * Math.max(1, Math.abs(p1.q))
    const inSeg = (q: number) => q >= p0.q - tol && q <= p1.q + tol
    if (k === 0) {
      if (b !== 0) { const q = -a / b; if (inSeg(q)) roots.push(q) }
      else if (a === 0) roots.push(p0.q)
      continue
    }
    const disc = b * b + 4 * k * a
    const scale = Math.max(b * b, Math.abs(4 * k * a), 1e-300)
    if (disc < -1e-12 * scale) continue
    const sq = Math.sqrt(Math.max(0, disc))
    // 桁落ちしにくい形: 片方を (b ± √D)/(2k)、もう片方を 根の積 −a/k から求める
    const q1 = (b + (b >= 0 ? sq : -sq)) / (2 * k)
    const cand = q1 !== 0 ? [q1, -a / (k * q1)] : [0, b / k]
    for (const q of cand) if (Number.isFinite(q) && inSeg(q)) roots.push(Math.min(Math.max(q, p0.q), p1.q))
  }
  roots.sort((x, y) => x - y)
  const out: PQPoint[] = []
  for (const q of roots) {
    const last = out[out.length - 1]
    if (last && Math.abs(last.q - q) <= 1e-7 * Math.max(1, Math.abs(q))) continue
    out.push({ q, p: interpFanP(pts, q) })
  }
  return out
}

/**
 * 運転点: ファン P-Q と 抵抗カーブ ΔP=k·Q² の交点のうち、**風量の小さい側の最初の交点**。
 * 範囲の中に交点が無ければ null。交点が複数ある特性（鞍部）では、ほかの交点も
 * `findOperatingPoints` で確かめること（どの交点で安定して運転するかは判定しない）。
 */
export function findOperatingPoint(fanPoints: PQPoint[], k: number): PQPoint | null {
  return findOperatingPoints(fanPoints, k)[0] ?? null
}

/**
 * カタログ点（少数）から ΔP=k·Q² を当て、設計風量での圧損を返す簡便関数。
 * 端末/フィルター等の「カタログ差圧 → 任意風量での圧損」用途。
 */
export function resistanceAtFlow(catalogPoints: PQPoint[], qTarget: number): number {
  const k = fitResistanceK(catalogPoints)
  return resistanceP(k, qTarget)
}
