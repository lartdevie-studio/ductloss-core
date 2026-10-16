// ─────────────────────────────────────────────────────────────
// 空気の性質（物理定数。資料に依らない）
// ─────────────────────────────────────────────────────────────

/** 標準の空気密度 (kg/m³)。JIS B 8330 の標準空気（20℃・101.3 kPa・65%RH）の 1.20。国際標準大気（15℃・1.225）とは別 */
export const RHO_DEFAULT = 1.2

/**
 * 機器の特性（P-Q 特性・機外静圧）を表す空気密度 (kg/m³)。カタログの特性は JIS B 8330 などの標準空気 1.20 で
 * 表すのが普通なので、計算の ρ が違えば、同じ風量で出せる静圧を ρ / 1.20 倍にして比べる（送風機の法則:
 * 回転数が同じなら風量は変わらず、圧力は密度に比例する。SPEC.md §7）
 */
export const CHARACTERISTIC_RHO = 1.2

/** 乾き空気の気体定数 J/(kg·K) */
const R_DRY_AIR = 287.05

/**
 * 空気密度 ρ (kg/m³) を 気温(℃) と 標高(m) から算出する。
 *   気圧 P = 101325 × (1 − 2.25577e-5 × h)^5.25588  （標準大気・高度式）
 *   ρ = P / (R·T)   （R=乾き空気の気体定数, T=絶対温度）
 * 既定（20℃・標高0m）で約 1.204 ≒ 1.2。気温が高い/標高が高いほど ρ は下がる。
 */
export function airDensity(tempC: number, altitudeM = 0): number {
  const T = tempC + 273.15
  if (!(T > 0)) return RHO_DEFAULT
  const h = Math.max(0, altitudeM)
  const P = 101325 * Math.pow(Math.max(0, 1 - 2.25577e-5 * h), 5.25588)
  return P / (R_DRY_AIR * T)
}

/**
 * 空気の動粘性係数 ν (m²/s) ＝ μ / ρ。粘性係数 μ はサザーランドの式（μ0 1.716e-5 Pa·s・T0 273.15 K・S 110.4 K）。
 * 20℃・ρ 1.2 で約 1.51e-5。粗さから λ を求めるときのレイノルズ数に使う（SPEC.md §3）
 */
export function airKinematicViscosity(tempC = 20, rho = RHO_DEFAULT): number {
  const T = tempC + 273.15
  const mu = 1.716e-5 * Math.pow(T / 273.15, 1.5) * (273.15 + 110.4) / (T + 110.4)
  return mu / (rho > 0 ? rho : RHO_DEFAULT)
}

/**
 * 摩擦係数 λ をレイノルズ数と相対粗さ ε/D から求める（SPEC.md §3）。
 *  - Re < 2300: 層流 λ = 64/Re
 *  - Re ≥ 2300: Colebrook の式 1/√λ = −2·log10(ε/(3.7D) + 2.51/(Re·√λ)) を繰り返しで解く
 *    （2300〜4000 の遷移域も Colebrook で求める。層流の値より大きく出るので安全側）
 *  - Re ≤ 0 は 0（風量 0）
 */
export function colebrookLambda(re: number, relRoughness: number): number {
  if (!(re > 0) || !Number.isFinite(re)) return 0
  if (re < 2300) return 64 / re
  const rr = Math.max(0, relRoughness)
  // Swamee–Jain で初期値を作り、Colebrook を固定点反復で詰める
  let lam = 0.25 / Math.pow(Math.log10(rr / 3.7 + 5.74 / Math.pow(re, 0.9)), 2)
  for (let i = 0; i < 60; i++) {
    const next = Math.pow(-2 * Math.log10(rr / 3.7 + 2.51 / (re * Math.sqrt(lam))), -2)
    if (Math.abs(next - lam) <= 1e-14 * lam) { lam = next; break }
    lam = next
  }
  return lam
}

/**
 * 摩擦係数 λ を Moody の近似式で求める（SPEC.md §3・0.4.0〜）。
 *   λ = 0.0055·[1 + (20,000·ε/D + 10⁶/Re)^(1/3)]
 * 粗い管・普通の風速では Colebrook の式との差はおよそ 2% 以内（Colebrook より少し大きめ）。
 * Re < 2300 は層流 64/Re、Re ≤ 0 は 0（colebrookLambda と同じ決まり）
 */
export function moodyLambda(re: number, relRoughness: number): number {
  if (!(re > 0) || !Number.isFinite(re)) return 0
  if (re < 2300) return 64 / re
  const rr = Math.max(0, relRoughness)
  return 0.0055 * (1 + Math.cbrt(20000 * rr + 1e6 / re))
}
