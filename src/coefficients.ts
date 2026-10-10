// ─────────────────────────────────────────────────────────────
// 設計係数（使う側が渡す）
//
// 式（ダルシー・ワイスバッハ、ζ·q）はこの部品が持つ。式に入れる係数
// ── 摩擦係数 λ・曲がりの相当長・部材の既定 ζ ── は、資料や製品によって
// 違い、出典の許諾もそれぞれなので、部品には入れず使う側が渡す。
//
// 渡した係数は計算書に出典ごと載せること（`name` と `source`）。
// どの係数で計算したかが分からない計算書は、照合できない。
// ─────────────────────────────────────────────────────────────

export interface DesignCoefficients {
  /** 係数セットの名前（例「社内標準 2026」）。計算書の計算条件に出す */
  name: string
  /** 出典（資料名・版・ページ）。計算書に出す */
  source: string
  /**
   * 摩擦係数 λ の既定値。ファンの `defaultLambda` とダクトの `lambda` が
   * どちらも無いとき（根がエアコンの系統など）に使う。
   * 新しく作るファンの `defaultLambda` にもこの値が入る。
   */
  lambda: number
  /**
   * 90° 曲がり 1 個の相当長 (m) を径 (mm) ごとに。
   * 表に無い径は、表の中で一番近い径の値を使う（同じ近さなら小さい径）。
   * 角度 θ の曲がりは 90° の値 × θ/90 とする。
   */
  bendEquivLength90M: Readonly<Record<number, number>>
  /** 新しく置く部材の既定 ζ と、ダンパ調整の取り消しで戻す端末の ζ */
  zeta: {
    branch: number
    reducer: number
    terminal: number
    filter: number
    aircon: number
  }
  /** 新しく置く端末の既定の目標圧損 (Pa)（Pa 入力モード） */
  terminalPa: number
  /** 新しく置くフィルターの既定の差圧 (Pa)（Pa 入力モード） */
  filterPa: number
}

/** 係数セットの中身が計算に使える値か。だめなら理由を返す（使えれば空配列） */
export function validateCoefficients(c: DesignCoefficients): string[] {
  const errors: string[] = []
  const nonNeg = (v: number, label: string) => {
    if (!Number.isFinite(v) || v < 0) errors.push(`${label} は 0 以上の数にしてください（${v}）`)
  }
  if (!c.name?.trim()) errors.push('name（係数セットの名前）が空です')
  if (!c.source?.trim()) errors.push('source（出典）が空です')
  if (!Number.isFinite(c.lambda) || c.lambda <= 0) errors.push(`lambda は正の数にしてください（${c.lambda}）`)
  const table = Object.entries(c.bendEquivLength90M ?? {})
  if (table.length === 0) errors.push('bendEquivLength90M（曲がりの相当長の表）が空です')
  for (const [d, l] of table) {
    if (!(Number(d) > 0)) errors.push(`bendEquivLength90M の径 ${d} は正の数にしてください`)
    nonNeg(l, `bendEquivLength90M[${d}]`)
  }
  for (const [k, v] of Object.entries(c.zeta ?? {})) nonNeg(v, `zeta.${k}`)
  nonNeg(c.terminalPa, 'terminalPa')
  nonNeg(c.filterPa, 'filterPa')
  return errors
}

/**
 * 90° 曲がり 1 個の相当長 (m)。表の中で一番近い径の値を使う。
 * 同じ近さの径が 2 つあるときは小さい径（表を径の小さい順に見て、先に見つかった方）。
 */
export function bendEquivLength90(coef: DesignCoefficients, diameterMm: number): number {
  const diameters = Object.keys(coef.bendEquivLength90M).map(Number).sort((a, b) => a - b)
  if (diameters.length === 0) return 0
  const d = diameters.reduce((prev, curr) =>
    Math.abs(curr - diameterMm) < Math.abs(prev - diameterMm) ? curr : prev,
  )
  return coef.bendEquivLength90M[d]
}
