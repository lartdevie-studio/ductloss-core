// ── ダクト圧損計算アプリの型定義（schema v4: マルチ系統 × ツリーストラクチャー）
//
//   - ファンを根、端末を葉とする木（rooted tree）で系統を表現する
//   - 端末の targetFlowQh を起点に風量を逆算（後順走査で集計）
//   - 各ノードの圧損は Darcy-Weisbach（直管）または ζ q （局部）で求める
//   - クリティカルパス = 葉ごとに集計したルート圧損のうち最大のもの

// ─────────────────────────────────────────────────────────────
// 共通
// ─────────────────────────────────────────────────────────────

import type { PQPoint } from './pqcurve'
import type { VentilationInput } from './ventilation'

export const DUCT_DIAMETERS = [75, 100, 125, 150, 200, 250] as const
export type DuctDiameter = typeof DUCT_DIAMETERS[number]

export const BEND_ANGLES = [30, 45, 60, 90] as const
export type BendAngle = typeof BEND_ANGLES[number]

/** 1種類の曲がり（角度×個数）。1ノードに最大3種まで設定可。 */
export interface BendSpec {
  angleDeg: BendAngle
  count: number
  /**
   * 曲がりの形（係数の bend.shapes の鍵）。曲がりを ζ で持つ係数のときだけ使う。省くと係数の既定の形（SPEC.md §3）
   */
  shape?: string | null
  /** 器材カタログなどの 1 個あたりの ζ（この角度での値）。形の値より優先する。ζ で持つ係数のときだけ使う */
  zeta?: number | null
}
/** 1ノードに設定できる曲がり種類の上限 */
export const MAX_BENDS_PER_DUCT = 3

// ─────────────────────────────────────────────────────────────
// ノード種別とパラメータ（discriminated union）
// ─────────────────────────────────────────────────────────────

export type NodeKind =
  | 'fan'        // 給排気ファン / HEX（根）
  | 'duct'       // ダクト要素：直管 + 曲がり（図面の「D-1: 5.0m/φ100」のような 1 区間に相当）
  | 'filter'     // フィルター（OA 系統等で間に挿入。インラインの圧損要素）
  | 'branch'     // 分岐（T 分岐 / Y 分岐 等。子を 2 本以上持つ）
  | 'reducer'    // 径変更
  | 'aircon'     // エアコン（第2の送風機 + 追加吸込口の混合点）
  | 'terminal'   // 吹出口・吸込口（葉）

export interface FanParams {
  kind: 'fan'
  /**
   * カタログの機外静圧 (Pa)。null=未設定。
   * **定格風量での値**なので、単独では設定風量を確保できるかは判定できない。
   * maxStaticAtQh（その静圧が規定される風量）か pqPoints を併せて入れる。
   */
  maxStaticPa: number | null
  /** 機外静圧が規定される風量 (m³/h)。未設定は「どの風量の値か不明」扱い */
  maxStaticAtQh?: number | null
  /** ノッチ／設定段（任意のテキスト） */
  notch: string
  /**
   * 既定 λ（直管が λ を持たない場合のフォールバック）。
   * null は「係数の摩擦の求め方に従う」（粗さから求める係数なら粗さ、λ 一定の係数なら係数の λ。SPEC.md §3）
   */
  defaultLambda: number | null
  /**
   * カタログの P-Q 特性（風量 Q m³/h, 静圧 P Pa）の点列。2 点以上で運転点を出す。
   * 上限静圧だけの 1 点判定より厳しい（静圧が上がると風量が落ちるため）。
   * 既存の保存データには無いので任意。
   */
  pqPoints?: PQPoint[] | null
  /** カタログ器材参照（根拠表示用） */
  catalogRef?: CatalogRef
}

/**
 * ダクト要素：1 本の連続するダクト区間。
 * 図面で「D-1: 5.0m/φ100」のように 1 本として扱う単位に相当する。
 * 区間内に同角度の曲がりがいくつあるかも一緒に持つ
 *  （別角度の曲がりが混在する場合はノードを分割する）。
 */
export interface DuctParams {
  kind: 'duct'
  diameterMm: DuctDiameter
  /** 直管長 (m)。0 なら純粋に曲がりのみのノード */
  lengthM: number
  /** 区間内に含まれる曲がりの 1 個あたり角度（後方互換／bends[0] と同期） */
  bendAngleDeg: BendAngle
  /** 同じ角度の曲がりが何個あるか（0 なら直管のみ）（後方互換／bends[0] と同期） */
  bendCount: number
  /**
   * 曲がりの種類（角度×個数）を最大3種まで保持。設定時はこちらを優先して圧損を計算。
   * 未設定（空/undefined）の旧データは bendAngleDeg/bendCount を1種として扱う。
   */
  bends?: BendSpec[]
  /** 摩擦係数（未設定なら祖先 fan の defaultLambda を使う） */
  lambda: number | null
  /**
   * ダクトの材料（係数の friction.materials の鍵）。粗さから λ を求める係数のときだけ使う。省くと係数の既定の材料
   */
  material?: string | null
}

/**
 * フィルター要素（OA 取入口直後など）。
 * インライン配置（単一の子を持つ）。風量は上流から伝搬し、
 * カタログ Pa 値 → ζ 逆算 or ζ 直接入力で圧損を算定する。
 */
export interface FilterParams {
  kind: 'filter'
  diameterMm: DuctDiameter
  /** 圧損入力モード: 'pa' は設計風量での Pa 値、'zeta' は ζ 直接 */
  pressureMode: 'zeta' | 'pa'
  zeta: number
  /** カタログのフィルター差圧 (Pa)。Pa モード時に ζ を逆算する基準 */
  targetPa: number
  /** 任意のメモ（"中性能 F7" 等） */
  filterNote?: string
  /** カタログ器材参照（根拠表示用） */
  catalogRef?: CatalogRef
}

export interface BranchParams {
  kind: 'branch'
  /** 代表径（動圧の評価径）。既定では上流のダクト径を自動で読み取る（diameterAuto 参照） */
  diameterMm: DuctDiameter
  /**
   * 径を接続ダクトから自動で決めるか。
   *  - undefined / true : 自動（上流のダクト径。無ければ下流の最大径）
   *  - false            : diameterMm を手入力値として使う
   * 既存データは undefined = 自動として扱う（径の付け忘れ・付け間違いを無くす）。
   */
  diameterAuto?: boolean
  /** 局部抵抗係数（カタログ値など。新しく置く分岐は設計係数の zeta.branch が入る） */
  zeta: number
  catalogRef?: CatalogRef
}

export interface ReducerParams {
  kind: 'reducer'
  /** 入口径。既定では上流のダクト径を自動で読み取る（diameterAuto 参照） */
  diameterFromMm: DuctDiameter
  /** 出口径。既定では下流のダクト径を自動で読み取る（diameterAuto 参照） */
  diameterToMm: DuctDiameter
  /**
   * 両端の径を接続ダクトから自動で決めるか。
   *  - undefined / true : 自動（入口＝上流のダクト径、出口＝下流のダクト径）
   *  - false            : diameterFromMm / diameterToMm を手入力値として使う
   * レデューサーは「ここでダクト径が変わる」ことを示す部材なので、
   * 既定では前後のダクトが正となる（二重入力による食い違いを防ぐ）。
   */
  diameterAuto?: boolean
  zeta: number
  /**
   * ζ がどの断面の動圧を基準にした値か（SPEC.md §3・§4）。ζ の出典の定義に合わせて選ぶ。
   * 欄の無い保存データは 'treeLeaf'（2026-10 までの決まり）として計算し、意味を黙って変えない。
   */
  zetaBasis?: ReducerZetaBasis
  /**
   * 径の変わり目の形（0.4.0〜・任意）。係数に径の変わり目の表（DesignCoefficients.reducer）があり、
   * zetaAuto を切っていなければ、ζ を面積比（と角度）から表で求め、流れの入口側の動圧に掛ける（zeta・zetaBasis は使わない）。
   * 欄の無い保存データ・表の無い係数では、これまでどおり部材の ζ を使う
   */
  form?: 'abrupt' | 'gradual'
  /** 漸拡大・漸縮小の角度（°）。form が 'gradual' のときに使う */
  angleDeg?: number | null
  /** false なら表を使わず部材の ζ を使う（器材カタログの値を入れたときなど）。省くと表を使う */
  zetaAuto?: boolean
  catalogRef?: CatalogRef
}

/**
 * レジューサの ζ の基準断面。
 *  - 'small'      細い側（速い側）。縮小・拡大とも一般的な ζ の定義。新しく置く部材の既定
 *  - 'large'      太い側（遅い側）
 *  - 'flowInlet'  空気の流れの入口側（吹出側は根の側、吸込側は葉の側）
 *  - 'flowOutlet' 空気の流れの出口側（吹出側は葉の側、吸込側は根の側）
 *  - 'treeLeaf'   木の葉の側（端末の側）。2026-10 までの決まりで、吸込側や径が太くなる形では遅い側になる
 */
export type ReducerZetaBasis = 'small' | 'large' | 'flowInlet' | 'flowOutlet' | 'treeLeaf'

/**
 * エアコン（ダクト形エアコン / 全館空調の室内機など）。
 *
 * HEX（ファン）から供給される換気風量に、追加の吸込口（室内循環）から取り込む
 * 風量を足して、より大きな循環風量で下流端末へ送る「第 2 の送風機」。
 *   循環風量   = 下流の吹出端末の合計（質量保存）
 *   追加吸込風量 = 循環風量 − HEX からの供給風量（supplyFromHexQh）
 *
 * 圧損は HEX とは別の送風機として、供給側（エアコン→吹出）と吸込側
 * （吸込口→エアコン）の必要静圧を個別に評価する。
 *
 * ツリー上の表現:
 *   - 下流側（side='downstream'）の子 = 供給（循環）側 → 吹出端末へ
 *   - 上流側（side='upstream'）の子   = 追加吸込口 → 室内循環の取り込み
 */
export interface AirconParams {
  kind: 'aircon'
  /** 接続径（本体接続・通過圧損の評価径） */
  diameterMm: DuctDiameter
  /** 本体の通過圧損の入力モード（機外静圧の能力比較は別途） */
  pressureMode: 'zeta' | 'pa'
  zeta: number
  targetPa: number
  /** HEX（ファン）から供給される換気風量 (m³/h)。
   *  null の場合は追加吸込なし（循環 = 供給として扱う）。
   *  returnQh が設定されている場合はそちらが優先され、供給は循環 − returnQh で派生する。 */
  supplyFromHexQh: number | null
  /**
   * リターン（追加吸込）風量 (m³/h)。リターン主の入力モード。
   *  - null（既定）: 旧挙動。supplyFromHexQh から intake = 循環 − 供給 を逆算
   *    （supplyFromHexQh も null なら intake = 0 ＝ 吸込なし）。
   *  - 数値: こちらを追加吸込の設計入力として使い、供給(HEX) = 循環 − 追加吸込 を求める。
   *    リターンが主で熱交換器の換気量が少ない計画で、設計者がリターン量を直接決められる。
   */
  returnQh: number | null
  /**
   * このエアコン（第2送風機）の機外静圧の上限 (Pa)。必要静圧との比較用。null=未設定。
   * ファンの FanParams.maxStaticPa と同じ役割。ダクト接続型エアコンは
   * 「機外静圧 ◯Pa まで」とカタログに書かれているので、それを入れる。
   *
   * 既存の保存データには無いので任意。読むときは必ず `?? null` で正規化する
   * （undefined のまま表示に回すと「機器最大 undefined」になる）。
   * FanParams と同じく**定格風量での値**。maxStaticAtQh か pqPoints を併せて入れる。
   *
   * **エアコンは強設定（定格風量）をベースにする。** 段（強/中/弱）ごとの特性は
   * 持たない — 設計で使うのは強なので、1 機器 = 1 特性で足りる。
   */
  maxStaticPa?: number | null
  /** 機外静圧が規定される風量 (m³/h)。＝ 強設定の定格風量 */
  maxStaticAtQh?: number | null
  /** カタログの P-Q 特性。FanParams.pqPoints と同じ扱い */
  pqPoints?: PQPoint[] | null
  /** カタログ器材参照（根拠表示用） */
  catalogRef?: CatalogRef
}

export interface TerminalParams {
  kind: 'terminal'
  /** 接続管径。既定では上流のダクト径を自動で読み取る（diameterAuto 参照） */
  diameterMm: DuctDiameter
  /**
   * 径を接続ダクトから自動で決めるか。
   *  - undefined / true : 自動（上流のダクト径）
   *  - false            : diameterMm を手入力値として使う（首径が異なる器具など）
   */
  diameterAuto?: boolean
  /** 端末の目標風量 (m³/h)。これが逆算の起点 */
  targetFlowQh: number
  /** 圧損入力モード: 'zeta' は ζ 値、'pa' は計画風量時の Pa 直入力 */
  pressureMode: 'zeta' | 'pa'
  zeta: number
  targetPa: number
  catalogRef?: CatalogRef
  /**
   * ダンパ調整（balanceTerminals）の前の値（SPEC.md §10）。最初に調整したときに入り、
   * 調整の取り消し（undoBalanceTerminals）はここへ戻す。器材カタログ・手入力の ζ を、調整で上書きして失わないため。
   * `zeta − beforeBalance.zeta` が、調整で足した抵抗（ダンパなどで設計風量に絞るのに要る ζ）。
   * 使う側は、ζ・目標 Pa・入力の仕方を人が直したらこの欄を消すこと（直した値が新しい「調整前」になる）。
   */
  beforeBalance?: { zeta: number; targetPa: number }
}

export type NodeParams =
  | FanParams
  | DuctParams
  | FilterParams
  | BranchParams
  | ReducerParams
  | AirconParams
  | TerminalParams

// ─────────────────────────────────────────────────────────────
// ノードと payload
// ─────────────────────────────────────────────────────────────

/** ファンを基準とした流れ方向。
 *  - 'downstream' (既定): ファンの押し出し側（SAなら吹出口、REならEAへ向かう）
 *  - 'upstream':            ファンの吸込側（SAならOA→ファン、RE系統なら吸込口→ファン）
 *
 * 質量保存により ファン流量 = 下流側端末の合計流量。
 * 上流側の部材の風量は、ファン流量を**上流側端末の targetFlowQh の比で配った設計上の値**
 * （SPEC.md §5。各枝の抵抗から実際の配分を解いたものではない）。上流側端末の targetFlowQh は
 * 配る比として使い、その値どおりに流れるとは限らない。
 */
export type FlowSide = 'upstream' | 'downstream'

export interface DuctNode {
  id: string
  parentId: string | null
  childIds: string[]
  /** CAD 模式図上の座標（自由配置） */
  x: number
  y: number
  /** ユーザーが付けるラベル（例「リビング吹出」） */
  label: string
  /** ファン基準の流れ方向。fan 自身は undefined。
   *  fan の直接の子で上流／下流を分け、子孫は親の side を継承する。 */
  side?: FlowSide
  params: NodeParams
}

// ─────────────────────────────────────────────────────────────
// 系統（SA / RE / EA / OA）
// ─────────────────────────────────────────────────────────────

/**
 * 系統種別。
 *  - SA: 給気系統（OA はこの系統内、ファンの上流側に配置）
 *  - RE: 還気系統（EA はこの系統内、ファンの上流側に配置）
 *
 * OA / EA は独立した系統ではなく、SA / RE の入口・出口要素として
 * 同一系統内に節点として配置する想定。
 */
export type SystemType = 'SA' | 'RE'

export const SYSTEM_TYPES: SystemType[] = ['SA', 'RE']

/** カタログ器材への参照（根拠データ表示用）。値はノードに転記される */
export interface CatalogRef {
  /** 器材の id（使う側のカタログの id） */
  equipmentId: string
  /** 表示名（メーカー 型式 仕様） */
  label: string
  /** 出典 */
  source: string
}

/** 1 系統 = 1 つのファンを根とするツリーストラクチャー */
export interface DuctSystem {
  id:      string
  /** ユーザー編集可能な系統名（例「LDK 給気」） */
  name:    string
  /** 流体種別（カラーコーディング・PDF 章分けに使用） */
  type:    SystemType
  /** この系統のファンノード id */
  rootId:  string
  /** id → ノード。系統ごとに独立して持つ */
  nodes:   Record<string, DuctNode>
}

/**
 * 計算書の注記（自由記述）。PDF の末尾に章として出す。
 *
 * 計算から自動で出せるもの（計算条件・端末 ζ・経路一覧・クリティカル内訳・判定）は
 * 自動生成する。ここに持つのは**人の判断が要る文章**だけ——なぜその前提を置いたか、
 * 図面と食い違っているのはどこか、といった、計算結果からは導けないもの。
 *
 * 各欄は 1 行 1 項目。空行は捨て、番号付きで並べる。中身が無い章は出力しない。
 * 既存の保存データには無いので任意。
 */
export interface ReportNotes {
  /** 前提条件（例「λ は図面に記載がないため設計係数の値を使った」） */
  assumptions?: string
  /** 設計上の留意点（例「主管の風速が高めなので施工時に騒音を確認する」） */
  designNotes?: string
  /** 図面との相違（未修正）（例「図面の区間 A と計算の区間名が違う」） */
  drawingDiffs?: string
  /** 出典（例「係数の出典・使った資料」） */
  sources?: string
}

export interface DuctLossPayload {
  schemaVersion: 4
  /** 空気密度 (kg/m³)。全系統共通。airTempC/altitudeM を設定時はそれらから自動算出した値を保持する。 */
  rho: number
  /** 設計気温 (℃)。設定時は rho を airDensity(airTempC, altitudeM) で自動算出。未設定＝手動 rho。 */
  airTempC?: number
  /** 標高 (m)。気圧（=ρ）補正に使用。未設定は 0（標準大気・海面）扱い。 */
  altitudeM?: number
  /** SA / RE / EA / OA 系統の配列。最低 1 つ */
  systems: DuctSystem[]
  /**
   * 必要換気量の入力（気積・換気回数）。未設定＝これまでどおり端末風量だけで進める。
   * 端末の目標風量には書き込まず、合計が足りているかの照合にだけ使う。
   * 既存の保存データには無いので任意。
   */
  ventilation?: VentilationInput
  /**
   * 計算書の注記（自由記述）。未設定＝注記の章を出力しない。
   * 既存の保存データには無いので任意。
   */
  report?: ReportNotes
  /**
   * このデータを作ったときの設計係数と計算の版（SPEC.md §2・§12）。新しく置く部材の ζ などは
   * 作ったときの係数で部材に写されるので、別の係数で計算し直すと一部だけが切り替わる。
   * それを計算書で知らせるための記録。2026-10 より前のデータには無い（不明として扱う）。
   */
  coefficientsStamp?: CoefficientsStamp
  /**
   * 送風機の余裕率 K（0.4.0〜・任意。SPEC.md §6）。必要静圧 ＝ 損失の合計 × K として機器と比べる。
   * 運転点（系統の抵抗）は K を掛けない損失で求める。無い・null・正の数でないものは 1（0.3.0 までと同じ）
   */
  safetyFactor?: number | null
}

/** 設計係数と計算の版の記録（DuctLossPayload.coefficientsStamp・CalcResult.meta） */
export interface CoefficientsStamp {
  /** 係数セットの名前（DesignCoefficients.name） */
  name: string
  /** 出典（DesignCoefficients.source） */
  source: string
  /** 係数の値から作る識別（coefficientFingerprint）。名前や出典が同じでも値が違えば変わる */
  fingerprint: string
  /** 計算の版（ENGINE_VERSION） */
  engineVersion: string
}

// ─────────────────────────────────────────────────────────────
// 計算結果
// ─────────────────────────────────────────────────────────────

/** ノード単体の計算結果 */
export interface NodeResult {
  /** このノードを通る風量 (m³/h) */
  flowQh: number
  /** 風速 (m/s)。代表径での値 */
  velocity: number
  /** 動圧 q (Pa) */
  q: number
  /** Pa/m（直管のみ。それ以外は 0） */
  dpPerMeter: number
  /** このノードが消費する圧損 (Pa) */
  lossPa: number
  /**
   * 計算に使った値（直管だけ）。λ と曲がりの相当長は計算のたびに決まる（SPEC.md §2）ので、
   * 計算書・説明はここを読む（結果から逆算しない）。
   */
  duct?: DuctCalcDetail
  /** 径の変わり目の計算に使った値（レジューサだけ・0.4.0〜） */
  reducer?: ReducerCalcDetail
}

/** 径の変わり目の計算に使った値 */
export interface ReducerCalcDetail {
  /** 使った ζ */
  zeta: number
  /** ζ の出どころ: 係数の表／部材に入れた値 */
  zetaSource: 'table' | 'node'
  /** ζ を掛けた動圧の断面の径 (mm) */
  basisMm: number
  /** 流れの入口・出口の径 (mm) */
  flowInletMm: number
  flowOutletMm: number
  /** 表で求めたときの値: 面積比（入口 ÷ 出口）・拡大か縮小か・使った表・表の外だったか */
  areaRatio?: number
  change?: 'expansion' | 'contraction'
  table?: 'abrupt' | 'gradual'
  angleDeg?: number
  clamped?: boolean
}

/** 直管の計算に使った値 */
export interface DuctCalcDetail {
  /** 使った λ */
  lambda: number
  /** λ の出どころ: 直管に指定／上流の送風機の既定値／設計係数の λ／粗さから求めた（Colebrook） */
  lambdaSource: 'duct' | 'fan' | 'coefficients' | 'roughness'
  /** 粗さから求めたときのレイノルズ数と材料の鍵 */
  reynolds?: number
  material?: string
  /** 粗さから求めたときの式（0.4.0〜。省くのは Colebrook） */
  formula?: 'colebrook' | 'moody'
  /** 直管の摩擦の圧損 (Pa)（λ·L/D·q） */
  frictionPa: number
  /** 曲がりの圧損 (Pa) */
  bendPa: number
  /** 曲がりの持ち方: 相当長（λ に比例）／ζ（λ によらない局部損失） */
  bendModel: 'equivalentLength' | 'zeta'
  /** 曲がりの相当長の合計 (m)（ζ で持つときは 0） */
  bendLengthM: number
  /** 曲がりの ζ の合計（角度の補正と個数を掛けたもの。相当長で持つときは λ·L曲/D に当たる値） */
  bendZeta: number
  /** 相当長の合計（直管長＋曲がりの相当長）(m) */
  equivLengthM: number
}

/**
 * 1 ルート（root の送風機 → 経路の末端）の集計。
 *
 * 末端は端末（ディフューザー等）とは限らない。OA 吸込のように
 * 端末を描かずダクトやフィルターで終わっている枝も 1 ルートとして数える。
 * そうしないと、その枝の圧損が必要静圧に一切入らず静かに小さく出る。
 * 末端が端末かどうかは endsAtTerminal で判別する。
 */
export interface RouteResult {
  /** 経路の末端ノード id（端末とは限らない。歴史的にこの名前） */
  terminalId: string
  /** root → 末端の経路上の nodeId 列（root, ..., 末端） */
  path: string[]
  totalPa: number
  /** 末端を流れる風量 (m³/h) */
  terminalFlowQh: number
  /** ルートの流れ方向（upstream は OA 側、downstream は SA/吹出口側など） */
  side: FlowSide
  /** 末端が端末（terminal）か。false = 描きかけの枝 */
  endsAtTerminal: boolean
}

/**
 * 第 2 の送風機（エアコン）の集計。
 * HEX とは別系統として必要静圧を個別評価する（送風機 2 台構成）。
 */
export interface SecondaryMover {
  nodeId: string
  label: string
  /** 循環風量（供給側端末の合計） */
  circulationQh: number
  /** HEX からの供給風量 */
  supplyFromHexQh: number
  /** 追加吸込風量 = 循環 − 供給 */
  intakeQh: number
  /** 供給側クリティカル (Pa)（エアコン→吹出端末） */
  supplyCriticalPa: number
  /** 吸込側クリティカル (Pa)（吸込口→エアコン） */
  intakeCriticalPa: number
  /** 必要静圧 = 供給側 + 吸込側 */
  requiredPa: number
  /** このエアコンの機外静圧 (Pa)。未設定は null */
  maxStaticPa: number | null
  /** 機外静圧が規定される風量 (m³/h)。未設定は null */
  maxStaticAtQh: number | null
  /** このエアコンの P-Q 特性。未設定は null */
  pqPoints: PQPoint[] | null
}

/** ペイロード全体の集計結果 */
export interface CalcResult {
  /** nodeId → 風量・圧損 */
  byNode: Record<string, NodeResult>
  /** 葉ごとのルート（fan からの経路） */
  routes: RouteResult[]
  /** 最大圧損のルート（全方向通じてのクリティカルパス）。なし=routes が空 */
  criticalRouteIndex: number | null
  /** 下流側クリティカルのルートインデックス */
  criticalDownstreamIndex: number | null
  /** 上流側クリティカルのルートインデックス */
  criticalUpstreamIndex: number | null
  /** ファン総風量（root の流量 = 下流側合計） */
  fanFlowQh: number
  /** ファン（HEX）が必要とする静圧。
   *  エアコンが無ければ 上流クリティカル + 下流クリティカル。
   *  エアコンがある場合は HEX 区間（OA 吸込 + ファン→エアコン供給）のみで評価。 */
  fanRequiredPa: number
  /** fanRequiredPa の上流側の内訳。必ず fanUpstreamPa + fanDownstreamPa = fanRequiredPa。
   *  エアコンがある場合は「この送風機が受け持つ区間」の値であり、
   *  系統全体の上流クリティカル（criticalUpstreamIndex）とは一致しない。 */
  fanUpstreamPa: number
  /** fanRequiredPa の下流側の内訳 */
  fanDownstreamPa: number
  /** エアコン等の第 2 送風機（無ければ空配列） */
  secondaryMovers: SecondaryMover[]
  /** どの版・どの係数・どの条件で出した結果か（createDuctLoss の calcSystem が入れる） */
  meta?: CalcMeta
}

/** 計算結果の出どころ（SPEC.md §2） */
export interface CalcMeta {
  engineVersion: string
  /** 計算に使った設計係数 */
  coefficients: { name: string; source: string; fingerprint: string }
  rho: number
  flowScale: number
  /** 粗さから λ を求めるときに使った気温（渡したときだけ） */
  tempC?: number
}
