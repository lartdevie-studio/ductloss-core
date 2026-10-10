// ─────────────────────────────────────────────────────────────
// 空気の性質（物理定数。資料に依らない）
// ─────────────────────────────────────────────────────────────

/** 標準の空気密度 (kg/m³)。約 20℃・1 気圧の乾き空気 */
export const RHO_DEFAULT = 1.2

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
