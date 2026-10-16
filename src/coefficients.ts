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
    /**
     * 吸込側（送風機が吸い込む側）に新しく置く端末の既定 ζ（0.4.0〜・任意）。管の入口の損失。
     * 省くと吸込側も terminal と同じ値（0.3.0 までと同じ）
     */
    terminalIntake?: number
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
  /**
   * 径の変わり目（レジューサ）の ζ を、面積比と角度の表から求める（0.4.0〜・任意。SPEC.md §4）。
   * 表で求めるのは、部材に形（form）が入っていて、ζ の自動（zetaAuto）を切っていないレジューサだけ。
   * 省くと、どのレジューサも部材の ζ を使う（0.3.0 までと同じ）
   */
  reducer?: ReducerModel
  /** 計算書に出す、係数の組についての注意（出典の無い仮置きの値など） */
  notes?: readonly string[]
}

export type FrictionModel =
  | { model: 'constant' }
  | {
      model: 'roughness'
      materials: Readonly<Record<string, DuctMaterial>>
      defaultMaterial: string
      /**
       * 粗さとレイノルズ数から λ を求める式（0.4.0〜）。省くと 'colebrook'。
       * 'moody' は Moody の近似式 λ = 0.0055·[1 + (20,000·ε/D + 10⁶/Re)^(1/3)]（Colebrook の式との差はおよそ 2% 以内）
       */
      formula?: FrictionFormula
      /** 式の出典（formula を書いたとき） */
      formulaSource?: string
    }

export type FrictionFormula = 'colebrook' | 'moody'

/**
 * 表の 1 本の線。[x, y] を x の小さい順に並べる。x の間は直線で補間し、x の外は端の値（外挿しない）
 */
export type CoefficientCurve = readonly (readonly [number, number])[]

/**
 * 径の変わり目の ζ の表（0.4.0〜）。ζ は**空気の流れの入口側**の断面の動圧に掛ける値とする
 * （拡大なら細い側、縮小なら太い側。表の出典の定義がこれと違う値は入れない）。
 * x は面積比 = 入口側の断面積 ÷ 出口側の断面積（拡大は 1 未満、縮小は 1 より大きい）
 */
export interface ReducerModel {
  model: 'areaRatioTable'
  /** 急拡大（段付き）: 面積比（< 1）→ ζ */
  abruptExpansion: CoefficientCurve
  /** 漸拡大: 広がりの角度（°）→ 面積比（< 1）→ ζ。角度の間は直線で補間し、外は端の角度の線 */
  gradualExpansion?: Readonly<Record<number, CoefficientCurve>>
  /** 急縮小（段付き）: 面積比（> 1）→ ζ */
  abruptContraction: CoefficientCurve
  /** 漸縮小: 絞りの角度（°）→ 面積比（> 1）→ ζ */
  gradualContraction?: Readonly<Record<number, CoefficientCurve>>
  source: string
}

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

/**
 * 曲がりの形（ζ で持つとき）。90° 1 個の ζ は、全部の径で同じ値（zeta90）か、径ごとの値（zeta90ByDiameter）の
 * どちらか一方で持つ（0.3.0〜。製品の資料では、同じ曲げ方でも径で ζ が大きく変わることがあるため）
 */
export interface BendShape {
  label: string
  /** 90° 1 個の局部抵抗係数（そのダクトの動圧に対する値）。全部の径で同じ値 */
  zeta90?: number
  /**
   * 径 (mm) → 90° 1 個の局部抵抗係数。ダクトの径に一番近い径の値を使う
   * （同じ近さなら小さい径。相当長の表 bendEquivLength90M と同じ決まり）
   */
  zeta90ByDiameter?: Readonly<Record<number, number>>
  /**
   * 角度（°）→ その角度の曲がり 1 個の ζ（0.4.0〜・任意）。突付エルボのように角度ごとの値が表で決まっている形に使う。
   * あれば zeta90 × 角度の補正より優先する（角度の間は直線で補間し、外は端の値）
   */
  zetaByAngle?: Readonly<Record<number, number>>
  /**
   * true なら、この形の角度の補正は θ/90（係数の angleFactor の表より優先）。
   * 製品の資料が「θ° の曲がりは 90° の値 × θ/90」と決めているときに使う
   */
  angleProportional?: boolean
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
    const formula = c.friction.formula
    if (formula !== undefined && formula !== 'colebrook' && formula !== 'moody') errors.push(`friction.formula「${String(formula)}」は colebrook か moody にしてください`)
    if (formula !== undefined && !c.friction.formulaSource?.trim()) errors.push('friction.formulaSource（式の出典）が空です')
  }
  if (c.reducer !== undefined) {
    if (c.reducer.model !== 'areaRatioTable') errors.push('reducer.model は areaRatioTable にしてください')
    if (!c.reducer.source?.trim()) errors.push('reducer.source（出典）が空です')
    const curve = (cv: CoefficientCurve | undefined, label: string, side: 'lt1' | 'gt1') => {
      if (!cv || cv.length === 0) { errors.push(`${label} が空です`); return }
      let prev = -Infinity
      for (const [x, z] of cv) {
        if (!Number.isFinite(x) || x <= 0 || (side === 'lt1' ? x >= 1 : x <= 1)) errors.push(`${label} の面積比 ${x} は ${side === 'lt1' ? '0 より大きく 1 未満' : '1 より大きい数'}にしてください`)
        if (!(x > prev)) errors.push(`${label} の面積比は小さい順に並べ、重ねないでください`)
        nonNeg(z, `${label}[${x}]`)
        prev = x
      }
    }
    const byAngle = (t: Readonly<Record<number, CoefficientCurve>> | undefined, label: string, side: 'lt1' | 'gt1') => {
      if (t === undefined) return
      const rows = Object.entries(t)
      if (rows.length === 0) errors.push(`${label} が空です`)
      for (const [a, cv] of rows) {
        if (!(Number(a) > 0 && Number(a) <= 180)) errors.push(`${label} の角度 ${a} は 0 より大きく 180 以下にしてください`)
        curve(cv, `${label}[${a}°]`, side)
      }
    }
    curve(c.reducer.abruptExpansion, 'reducer.abruptExpansion', 'lt1')
    curve(c.reducer.abruptContraction, 'reducer.abruptContraction', 'gt1')
    byAngle(c.reducer.gradualExpansion, 'reducer.gradualExpansion', 'lt1')
    byAngle(c.reducer.gradualContraction, 'reducer.gradualContraction', 'gt1')
  }
  if (zetaBends && c.bend?.model === 'zeta') {
    const shapes = Object.entries(c.bend.shapes ?? {})
    if (shapes.length === 0) errors.push('bend.shapes（曲がりの形）が空です')
    if (!c.bend.shapes?.[c.bend.defaultShape]) errors.push(`bend.defaultShape「${c.bend.defaultShape}」が shapes にありません`)
    for (const [k, sh] of shapes) {
      const byD = sh.zeta90ByDiameter === undefined ? undefined : Object.entries(sh.zeta90ByDiameter)
      if ((sh.zeta90 === undefined) === (byD === undefined)) {
        errors.push(`bend.shapes.${k} は zeta90 か zeta90ByDiameter のどちらか一方を書いてください`)
      } else if (byD === undefined) {
        nonNeg(sh.zeta90 as number, `bend.shapes.${k}.zeta90`)
      } else {
        if (byD.length === 0) errors.push(`bend.shapes.${k}.zeta90ByDiameter が空です`)
        for (const [d, z] of byD) {
          if (!(Number(d) > 0)) errors.push(`bend.shapes.${k}.zeta90ByDiameter の径 ${d} は正の数にしてください`)
          nonNeg(z, `bend.shapes.${k}.zeta90ByDiameter[${d}]`)
        }
      }
      for (const [a, z] of Object.entries(sh.zetaByAngle ?? {})) {
        if (!(Number(a) > 0)) errors.push(`bend.shapes.${k}.zetaByAngle の角度 ${a} は正の数にしてください`)
        nonNeg(z, `bend.shapes.${k}.zetaByAngle[${a}]`)
      }
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
  for (const [k, v] of Object.entries(c.zeta ?? {})) if (v !== undefined) nonNeg(v, `zeta.${k}`)
  nonNeg(c.terminalPa, 'terminalPa')
  nonNeg(c.filterPa, 'filterPa')
  return errors
}

/**
 * 径の表から、一番近い径の値を読む。同じ近さの径が 2 つあるときは小さい径
 * （表を径の小さい順に見て、先に見つかった方）。表が空なら 0
 */
function nearestDiameterValue(table: Readonly<Record<number, number>>, diameterMm: number): number {
  const diameters = Object.keys(table).map(Number).sort((a, b) => a - b)
  if (diameters.length === 0) return 0
  const d = diameters.reduce((prev, curr) =>
    Math.abs(curr - diameterMm) < Math.abs(prev - diameterMm) ? curr : prev,
  )
  return table[d]
}

/**
 * 90° 曲がり 1 個の相当長 (m)。表の中で一番近い径の値を使う。
 * 同じ近さの径が 2 つあるときは小さい径（表を径の小さい順に見て、先に見つかった方）。
 */
export function bendEquivLength90(coef: DesignCoefficients, diameterMm: number): number {
  return nearestDiameterValue(coef.bendEquivLength90M, diameterMm)
}

/** 曲がりの形の、90° 1 個の ζ。径ごとの値を持つ形は、一番近い径の値（同じ近さなら小さい径） */
export function bendShapeZeta90(shape: BendShape, diameterMm: number): number {
  if (shape.zeta90ByDiameter) return nearestDiameterValue(shape.zeta90ByDiameter, diameterMm)
  return shape.zeta90 ?? 0
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
  // 0.4.0 で足した欄（吸込側の端末・式・径の変わり目の表・角度ごとの ζ）も、渡したときだけ足す（渡さない係数の識別は変えない）
  if (z.terminalIntake !== undefined) parts.push(`terminalIntake=${num(z.terminalIntake)}`)
  // 摩擦・曲がりのモデルは、渡したときだけ足す（渡さない係数の識別は 0.2.0 の最初の形のまま変えない）
  if (c.friction?.model === 'roughness') {
    const mats = Object.entries(c.friction.materials).sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, m]) => `${k}:${num(m.roughnessMm)}`).join(',')
    parts.push(`friction=roughness;${mats};default=${c.friction.defaultMaterial}${c.friction.formula && c.friction.formula !== 'colebrook' ? `;formula=${c.friction.formula}` : ''}`)
  }
  if (c.bend?.model === 'zeta') {
    // 全部の径で同じ ζ の形は 0.2.0 と同じ書き方（その係数の識別を変えない）。径ごとの値・角度の比例は、あるときだけ足す
    const shapeText = (sh: BendShape) => {
      const base = sh.zeta90ByDiameter
        ? `d[${Object.entries(sh.zeta90ByDiameter).map(([d, z]) => [Number(d), z] as const).sort((a, b) => a[0] - b[0]).map(([d, z]) => `${num(d)}=${num(z)}`).join(',')}]`
        : num(sh.zeta90 as number)
      const angles = sh.zetaByAngle
        ? `;a[${Object.entries(sh.zetaByAngle).map(([a, z]) => [Number(a), z] as const).sort((x, y) => x[0] - y[0]).map(([a, z]) => `${num(a)}=${num(z)}`).join(',')}]`
        : ''
      return (sh.angleProportional ? `${base};p` : base) + angles
    }
    const shapes = Object.entries(c.bend.shapes).sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, sh]) => `${k}:${shapeText(sh)}`).join(',')
    const angles = Object.entries(c.bend.angleFactor ?? {}).map(([a, f]) => [Number(a), f] as const)
      .sort((a, b) => a[0] - b[0]).map(([a, f]) => `${num(a)}:${num(f)}`).join(',')
    parts.push(`bend=zeta;${shapes};default=${c.bend.defaultShape};angle=${angles}`)
  }
  if (c.reducer?.model === 'areaRatioTable') {
    const cv = (x: CoefficientCurve | undefined) => (x ?? []).map(([a, b]) => `${num(a)}:${num(b)}`).join(',')
    const ang = (t: Readonly<Record<number, CoefficientCurve>> | undefined) => Object.entries(t ?? {})
      .map(([a, x]) => [Number(a), x] as const).sort((a, b) => a[0] - b[0]).map(([a, x]) => `${num(a)}{${cv(x)}}`).join(',')
    parts.push(`reducer=table;ae=${cv(c.reducer.abruptExpansion)};ge=${ang(c.reducer.gradualExpansion)};ac=${cv(c.reducer.abruptContraction)};gc=${ang(c.reducer.gradualContraction)}`)
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
 * 曲がりの角度の補正（90° を 1）。形が角度の比例（angleProportional）を指定していれば θ/90。
 * そうでなければ、係数に表があれば表の角度の間を直線で補間（表の外は端の値）、無ければ θ/90。
 */
export function bendAngleFactor(coef: DesignCoefficients, angleDeg: number, shape?: BendShape): number {
  if (shape?.angleProportional) return angleDeg / 90
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
 * 無ければ形の ζ90（径ごとの値を持つ形は diameterMm に一番近い径の値）× 角度の補正。形が係数に無ければ既定の形
 */
export function bendZeta(
  coef: DesignCoefficients,
  bend: { angleDeg: number; shape?: string | null; zeta?: number | null },
  diameterMm: number,
): number {
  if (coef.bend?.model !== 'zeta') return 0
  if (typeof bend.zeta === 'number' && Number.isFinite(bend.zeta) && bend.zeta >= 0) return bend.zeta
  const shape = (bend.shape && coef.bend.shapes[bend.shape]) || coef.bend.shapes[coef.bend.defaultShape]
  if (!shape) return 0
  if (shape.zetaByAngle && Object.keys(shape.zetaByAngle).length > 0) {
    return interpolateCurve(Object.entries(shape.zetaByAngle).map(([a, z]) => [Number(a), z] as const).sort((a, b) => a[0] - b[0]), bend.angleDeg).value
  }
  return bendShapeZeta90(shape, diameterMm) * bendAngleFactor(coef, bend.angleDeg, shape)
}

/**
 * 表の線から値を読む（x の間は直線で補間し、x の外は端の値）。clamped は表の外だったか
 */
export function interpolateCurve(curve: CoefficientCurve, x: number): { value: number; clamped: boolean } {
  if (curve.length === 0) return { value: 0, clamped: true }
  if (x <= curve[0][0]) return { value: curve[0][1], clamped: x < curve[0][0] }
  const last = curve[curve.length - 1]
  if (x >= last[0]) return { value: last[1], clamped: x > last[0] }
  for (let i = 0; i < curve.length - 1; i++) {
    const [x0, y0] = curve[i], [x1, y1] = curve[i + 1]
    if (x >= x0 && x <= x1) return { value: y0 + (y1 - y0) * (x - x0) / (x1 - x0), clamped: false }
  }
  return { value: last[1], clamped: true }
}

/** 角度ごとの線の表から値を読む（角度の間は、両側の角度の線で読んだ値を直線で補間。角度の外は端の角度の線） */
function interpolateByAngle(table: Readonly<Record<number, CoefficientCurve>>, angleDeg: number, x: number): { value: number; clamped: boolean } {
  const rows = Object.entries(table).map(([a, cv]) => [Number(a), cv] as const).sort((a, b) => a[0] - b[0])
  if (rows.length === 0) return { value: 0, clamped: true }
  if (angleDeg <= rows[0][0]) { const r = interpolateCurve(rows[0][1], x); return { value: r.value, clamped: r.clamped || angleDeg < rows[0][0] } }
  const last = rows[rows.length - 1]
  if (angleDeg >= last[0]) { const r = interpolateCurve(last[1], x); return { value: r.value, clamped: r.clamped || angleDeg > last[0] } }
  for (let i = 0; i < rows.length - 1; i++) {
    const [a0, c0] = rows[i], [a1, c1] = rows[i + 1]
    if (angleDeg >= a0 && angleDeg <= a1) {
      const r0 = interpolateCurve(c0, x), r1 = interpolateCurve(c1, x)
      return { value: r0.value + (r1.value - r0.value) * (angleDeg - a0) / (a1 - a0), clamped: r0.clamped || r1.clamped }
    }
  }
  return { ...interpolateCurve(last[1], x), clamped: true }
}

/** 径の変わり目の形（ReducerParams.form） */
export type ReducerForm = 'abrupt' | 'gradual'

/**
 * 径の変わり目の ζ を表から求める（SPEC.md §4）。ζ は流れの入口側の断面の動圧に掛ける値。
 * 表が無い・径が変わらない・径が 0 なら null（部材の ζ を使う）。
 * 漸拡大・漸縮小の表が無い係数では、急拡大・急縮小の表を使う（角度による違いを数えない＝大きめ）
 */
export function reducerTableZeta(
  coef: DesignCoefficients,
  flowInletMm: number,
  flowOutletMm: number,
  form: ReducerForm,
  angleDeg?: number | null,
): { zeta: number; areaRatio: number; change: 'expansion' | 'contraction'; table: 'abrupt' | 'gradual'; clamped: boolean } | null {
  const m = coef.reducer
  if (!m || m.model !== 'areaRatioTable') return null
  if (!(flowInletMm > 0) || !(flowOutletMm > 0) || flowInletMm === flowOutletMm) return null
  const areaRatio = (flowInletMm / flowOutletMm) ** 2
  const change = areaRatio < 1 ? 'expansion' : 'contraction'
  const gradualTable = change === 'expansion' ? m.gradualExpansion : m.gradualContraction
  const useGradual = form === 'gradual' && gradualTable !== undefined && Object.keys(gradualTable).length > 0
    && typeof angleDeg === 'number' && Number.isFinite(angleDeg) && angleDeg > 0
  const r = useGradual
    ? interpolateByAngle(gradualTable!, angleDeg as number, areaRatio)
    : interpolateCurve(change === 'expansion' ? m.abruptExpansion : m.abruptContraction, areaRatio)
  return { zeta: r.value, areaRatio, change, table: useGradual ? 'gradual' : 'abrupt', clamped: r.clamped }
}
