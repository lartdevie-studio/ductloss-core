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
  /** 新しく置く部材の既定 ζ と、端末を既定値に戻すとき（resetTerminals）の ζ */
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
  /**
   * 直管の摩擦の求め方（SPEC.md §3）。省くと λ 一定（直管の λ → 送風機の既定 λ → 係数の λ）。
   * 'roughness' は、直管にも送風機にも λ が無いとき、材料の粗さとレイノルズ数から Colebrook の式で λ を求める
   */
  friction?: FrictionModel
  /**
   * 曲がりの持ち方（SPEC.md §3）。省くと相当長の表（bendEquivLength90M × θ/90 × 個数 に λ/D·q を掛ける）。
   * 'zeta' は、曲がりを λ によらない局部損失 ζ90 × 角度の補正 × 個数 × q で数える（相当長の表は使わない）
   */
  bend?: BendModel
  /** 計算書に出す、係数の組についての注意（出典の無い仮置きの値など） */
  notes?: readonly string[]
}

export type FrictionModel =
  | { model: 'constant' }
  | { model: 'roughness'; materials: Readonly<Record<string, DuctMaterial>>; defaultMaterial: string }

/** ダクトの材料（粗さから λ を求めるとき） */
export interface DuctMaterial {
  label: string
  /** 絶対粗さ ε (mm) */
  roughnessMm: number
  /** 出典（資料名・版・ページ） */
  source: string
}

export type BendModel =
  | { model: 'equivalentLength' }
  | {
      model: 'zeta'
      shapes: Readonly<Record<string, BendShape>>
      defaultShape: string
      /** 角度 → 補正（90° を 1）。表の角度の間は直線で補間し、表の外は端の値。省くと θ/90 */
      angleFactor?: Readonly<Record<number, number>>
      /** 角度の補正の出典 */
      angleFactorSource?: string
    }

/** 曲がりの形（ζ で持つとき） */
export interface BendShape {
  label: string
  /** 90° 1 個の局部抵抗係数（そのダクトの動圧に対する値） */
  zeta90: number
  source: string
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
  const zetaBends = c.bend?.model === 'zeta'
  if (table.length === 0 && !zetaBends) errors.push('bendEquivLength90M（曲がりの相当長の表）が空です（曲がりを ζ で持つなら bend を渡す）')
  if (c.friction?.model === 'roughness') {
    const mats = Object.entries(c.friction.materials ?? {})
    if (mats.length === 0) errors.push('friction.materials（材料）が空です')
    if (!c.friction.materials?.[c.friction.defaultMaterial]) errors.push(`friction.defaultMaterial「${c.friction.defaultMaterial}」が materials にありません`)
    for (const [k, m] of mats) {
      nonNeg(m.roughnessMm, `friction.materials.${k}.roughnessMm`)
      if (!m.source?.trim()) errors.push(`friction.materials.${k} の出典が空です`)
    }
  }
  if (zetaBends && c.bend?.model === 'zeta') {
    const shapes = Object.entries(c.bend.shapes ?? {})
    if (shapes.length === 0) errors.push('bend.shapes（曲がりの形）が空です')
    if (!c.bend.shapes?.[c.bend.defaultShape]) errors.push(`bend.defaultShape「${c.bend.defaultShape}」が shapes にありません`)
    for (const [k, sh] of shapes) {
      nonNeg(sh.zeta90, `bend.shapes.${k}.zeta90`)
      if (!sh.source?.trim()) errors.push(`bend.shapes.${k} の出典が空です`)
    }
    for (const [a, f] of Object.entries(c.bend.angleFactor ?? {})) {
      if (!(Number(a) > 0)) errors.push(`bend.angleFactor の角度 ${a} は正の数にしてください`)
      nonNeg(f, `bend.angleFactor[${a}]`)
    }
  }
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

/**
 * 係数の値から作る識別（例 `cf1-1a2b3c4d5e6f7a8b`）。名前・出典は含めない（同じ名前で値を変えたら別の識別になる）。
 * 計算結果（CalcResult.meta）と保存データの記録（coefficientsStamp）を突き合わせ、
 * 保存したときと別の係数で計算し直していないかを見分けるために使う。暗号のための値ではない。
 *
 * ⚠ 識別があること・名前や出典が書いてあることは、係数の根拠が確かであることを示さない。
 */
export function coefficientFingerprint(c: DesignCoefficients): string {
  const num = (v: number) => (Number.isFinite(v) ? String(v) : 'NaN')
  const bends = Object.entries(c.bendEquivLength90M ?? {})
    .map(([d, l]) => [Number(d), l] as const)
    .sort((a, b) => a[0] - b[0])
    .map(([d, l]) => `${num(d)}:${num(l)}`).join(',')
  const z = c.zeta
  const parts = [
    `lambda=${num(c.lambda)}`,
    `bend90=${bends}`,
    `zeta=${num(z.branch)},${num(z.reducer)},${num(z.terminal)},${num(z.filter)},${num(z.aircon)}`,
    `terminalPa=${num(c.terminalPa)}`,
    `filterPa=${num(c.filterPa)}`,
  ]
  // 摩擦・曲がりのモデルは、渡したときだけ足す（渡さない係数の識別は 0.2.0 の最初の形のまま変えない）
  if (c.friction?.model === 'roughness') {
    const mats = Object.entries(c.friction.materials).sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, m]) => `${k}:${num(m.roughnessMm)}`).join(',')
    parts.push(`friction=roughness;${mats};default=${c.friction.defaultMaterial}`)
  }
  if (c.bend?.model === 'zeta') {
    const shapes = Object.entries(c.bend.shapes).sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, sh]) => `${k}:${num(sh.zeta90)}`).join(',')
    const angles = Object.entries(c.bend.angleFactor ?? {}).map(([a, f]) => [Number(a), f] as const)
      .sort((a, b) => a[0] - b[0]).map(([a, f]) => `${num(a)}:${num(f)}`).join(',')
    parts.push(`bend=zeta;${shapes};default=${c.bend.defaultShape};angle=${angles}`)
  }
  const text = parts.join('|')
  return `cf1-${fnv1a32(text, 0x811c9dc5)}${fnv1a32(text, 0x01000193)}`
}

/** FNV-1a（32 ビット）。文字は UTF-16 の単位で混ぜる */
function fnv1a32(text: string, seed: number): string {
  let h = seed >>> 0
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * 曲がりの角度の補正（90° を 1）。係数に表があれば表の角度の間を直線で補間（表の外は端の値）、無ければ θ/90。
 */
export function bendAngleFactor(coef: DesignCoefficients, angleDeg: number): number {
  const table = coef.bend?.model === 'zeta' ? coef.bend.angleFactor : undefined
  const pts = Object.entries(table ?? {}).map(([a, f]) => [Number(a), f] as const).sort((a, b) => a[0] - b[0])
  if (pts.length === 0) return angleDeg / 90
  if (angleDeg <= pts[0][0]) return pts[0][1]
  if (angleDeg >= pts[pts.length - 1][0]) return pts[pts.length - 1][1]
  for (let i = 0; i < pts.length - 1; i++) {
    const [a0, f0] = pts[i], [a1, f1] = pts[i + 1]
    if (angleDeg >= a0 && angleDeg <= a1) return f0 + (f1 - f0) * (angleDeg - a0) / (a1 - a0)
  }
  return angleDeg / 90
}

/**
 * 曲がり 1 個の ζ（ζ で持つ係数のとき）。器材の ζ があればそれ（その角度での値なので補正しない）、
 * 無ければ形の ζ90 × 角度の補正。形が係数に無ければ既定の形
 */
export function bendZeta(coef: DesignCoefficients, bend: { angleDeg: number; shape?: string | null; zeta?: number | null }): number {
  if (coef.bend?.model !== 'zeta') return 0
  if (typeof bend.zeta === 'number' && Number.isFinite(bend.zeta) && bend.zeta >= 0) return bend.zeta
  const shape = (bend.shape && coef.bend.shapes[bend.shape]) || coef.bend.shapes[coef.bend.defaultShape]
  return (shape?.zeta90 ?? 0) * bendAngleFactor(coef, bend.angleDeg)
}
