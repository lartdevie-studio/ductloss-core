import type { DuctNode, NodeResult, SecondaryMover } from './types'
import { effectiveDiameterMm } from './tree'
import type { DesignCoefficients } from './coefficients'
import { ductBends, bendEquivLength } from './calculator'

// ─────────────────────────────────────────────────────────────
// 学習者向け「なぜこの圧損か」解説データの生成
//
// 各ノードの圧損計算を「式 → 実数代入 → 結果」のステップに分解し、
// さらに ΔP–Q 曲線（ΔP ∝ Q²）の動作点をプロットするための
// データを生成する。
// ─────────────────────────────────────────────────────────────

export interface ExplainStep {
  /** 項目名（例: 風速 v） */
  label: string
  /** 一般式（記号、例: v = Q / (3600·A)） */
  formula: string
  /** 実数を代入した式（例: = 150 / (3600·0.0177)） */
  substitution: string
  /** 結果値（単位付き、例: 2.36 m/s） */
  result: string
}

export interface CurvePoint { q: number; pa: number }

export interface NodeExplanation {
  title: string
  /** 1〜2 行の概要 */
  intro: string
  /** 計算式の総括（例: ΔP = ζ·q） */
  headlineFormula: string
  steps: ExplainStep[]
  /** ΔP–Q 曲線のサンプル点（0 〜 2×設計風量） */
  curve: CurvePoint[]
  /** 動作点（設計風量での圧損） */
  designPoint: CurvePoint
  /** 学習ポイント（例: 風量2倍 → 圧損4倍） */
  takeaway: string
}

function fmt(n: number, d = 2): string {
  if (!isFinite(n)) return '—'
  return n.toFixed(d)
}

/** ΔP ∝ Q² を利用して曲線を生成（設計点から外挿） */
function buildQuadraticCurve(qDesign: number, paDesign: number): CurvePoint[] {
  if (qDesign <= 0 || paDesign <= 0) return []
  const qMax = qDesign * 2
  const N = 24
  const pts: CurvePoint[] = []
  for (let i = 0; i <= N; i++) {
    const q = (qMax * i) / N
    const pa = paDesign * (q / qDesign) ** 2
    pts.push({ q, pa })
  }
  return pts
}

/** 系統レベルの文脈（ファンの運転点表示に使用） */
export interface SystemContext {
  /** ファン総風量 (m³/h) */
  fanFlowQh: number
  /** ファンが必要とする静圧 = 系統の総圧損 (Pa) */
  fanRequiredPa: number
  /**
   * 系統の部材一式。分岐・端末・レデューサの径は接続ダクトから読むので（SPEC.md §4）、
   * 渡されれば計算と同じ径で式を書く。無ければ部材に保存された径を使う。
   */
  nodes?: Record<string, DuctNode>
  /** 第 2 の送風機（calc.secondaryMovers）。エアコンの風量の内訳を計算と同じ値で書く */
  secondaryMovers?: SecondaryMover[]
}

/**
 * ノードの計算解説を生成する。
 * @param rho 空気密度（動圧の式表示に使用）
 * @param sys 系統文脈（ファンの運転点 = 系統抵抗曲線上の必要静圧点 を表示する場合に渡す）
 */
export function explainNode(coef: DesignCoefficients, node: DuctNode, result: NodeResult, rho: number, sys?: SystemContext): NodeExplanation {
  const q = result.flowQh        // 設計風量 m³/h
  const v = result.velocity      // m/s
  const qd = result.q            // 動圧 Pa
  const lossPa = result.lossPa

  const curve = buildQuadraticCurve(q, lossPa)
  const designPoint = { q, pa: lossPa }
  const takeaway = '圧損は風量の2乗で増えます（ΔP ∝ Q²）。風量を 2 倍にすると圧損は 4 倍、3 倍なら 9 倍になります。'

  // 計算に使った径（分岐・端末・レデューサは接続ダクトから読む。SPEC.md §4）
  const usedDiameter = (stored: number): number =>
    sys?.nodes ? effectiveDiameterMm(sys.nodes, node) : stored

  // 共通: 風速・動圧の導出（径を持つ kind 用）
  const velocityAndQSteps = (diameterMm: number): ExplainStep[] => {
    const D = diameterMm / 1000
    const A = (Math.PI * D * D) / 4
    return [
      {
        label: '断面積 A',
        formula: 'A = π·D² / 4',
        substitution: `= π × (${fmt(D, 3)})² / 4`,
        result: `${fmt(A, 4)} m²`,
      },
      {
        label: '風速 v',
        formula: 'v = (Q/3600) / A',
        substitution: `= (${fmt(q, 0)}/3600) / ${fmt(A, 4)}`,
        result: `${fmt(v, 2)} m/s`,
      },
      {
        label: '動圧 q',
        formula: 'q = ρ·v² / 2',
        substitution: `= ${rho} × ${fmt(v, 2)}² / 2`,
        result: `${fmt(qd, 2)} Pa`,
      },
    ]
  }

  switch (node.params.kind) {
    case 'duct': {
      const p = node.params
      const D = p.diameterMm / 1000
      // 計算が実際に使った λ を結果から引き戻す（Pa/m = λ·q/D）。ダクトに λ が無いときは
      // 上流のファンの値が使われるので、ここで既定値を出すと計算と違う λ を見せてしまう。
      const lambda = p.lambda ?? (qd > 0 ? result.dpPerMeter * D / qd : coef.lambda)
      const bends = ductBends(p)
      const lBend = bends.reduce((s, b) => s + bendEquivLength(coef, p.diameterMm, b.angleDeg, b.count), 0)
      const lEquiv = p.lengthM + lBend
      return {
        title: 'ダクトの圧損（直管 + 曲がり）',
        intro: '直管の摩擦と曲がりの局部抵抗を、相当長に換算して動圧に掛けて求めます（Darcy-Weisbach）。',
        headlineFormula: 'ΔP = λ·(L_相当 / D)·q',
        steps: [
          ...velocityAndQSteps(p.diameterMm),
          {
            label: '単位長さ圧損',
            formula: 'Pa/m = λ·q / D',
            substitution: `= ${fmt(lambda, 3)} × ${fmt(qd, 2)} / ${fmt(D, 3)}`,
            result: `${fmt(result.dpPerMeter, 2)} Pa/m`,
          },
          {
            label: '曲がり相当長',
            formula: 'L_曲 = L₉₀ × (角度/90) × 個数',
            substitution: bends.length === 0 ? '曲がりなし' : bends.map(b => `${b.angleDeg}° × ${b.count} 個`).join(' ＋ '),
            result: `${fmt(lBend, 2)} m`,
          },
          {
            label: '相当長 合計',
            formula: 'L_相当 = L + L_曲',
            substitution: `= ${fmt(p.lengthM, 2)} + ${fmt(lBend, 2)}`,
            result: `${fmt(lEquiv, 2)} m`,
          },
          {
            label: '圧損 ΔP',
            formula: 'ΔP = Pa/m × L_相当',
            substitution: `= ${fmt(result.dpPerMeter, 2)} × ${fmt(lEquiv, 2)}`,
            result: `${fmt(lossPa, 2)} Pa`,
          },
        ],
        curve, designPoint, takeaway,
      }
    }
    case 'terminal': {
      const p = node.params
      return {
        title: '端末（吹出口・吸込口）の圧損',
        intro: '端末は局部抵抗係数 ζ に動圧を掛けて求めます。ζ はカタログ値、または目標 Pa から逆算します。',
        headlineFormula: 'ΔP = ζ·q',
        steps: [
          ...velocityAndQSteps(usedDiameter(p.diameterMm)),
          {
            label: '局部抵抗係数 ζ',
            formula: p.pressureMode === 'pa' ? 'ζ = 目標Pa / q（逆算）' : 'ζ（カタログ値）',
            substitution: p.pressureMode === 'pa' ? `= ${fmt(p.targetPa, 1)} / ${fmt(qd, 2)}` : '',
            result: `${fmt(p.zeta, 3)}`,
          },
          {
            label: '圧損 ΔP',
            formula: 'ΔP = ζ·q',
            substitution: `= ${fmt(p.zeta, 3)} × ${fmt(qd, 2)}`,
            result: `${fmt(lossPa, 2)} Pa`,
          },
        ],
        curve, designPoint, takeaway,
      }
    }
    case 'filter': {
      const p = node.params
      return {
        title: 'フィルターの圧損',
        intro: 'フィルターも局部抵抗 ζ × 動圧。カタログの差圧（Pa）から ζ を逆算するのが一般的です。',
        headlineFormula: 'ΔP = ζ·q',
        steps: [
          ...velocityAndQSteps(p.diameterMm),
          {
            label: '局部抵抗係数 ζ',
            formula: p.pressureMode === 'pa' ? 'ζ = カタログPa / q' : 'ζ（直接入力）',
            substitution: p.pressureMode === 'pa' ? `= ${fmt(p.targetPa, 1)} / ${fmt(qd, 2)}` : '',
            result: `${fmt(p.zeta, 3)}`,
          },
          {
            label: '圧損 ΔP',
            formula: 'ΔP = ζ·q',
            substitution: `= ${fmt(p.zeta, 3)} × ${fmt(qd, 2)}`,
            result: `${fmt(lossPa, 2)} Pa`,
          },
        ],
        curve, designPoint, takeaway,
      }
    }
    case 'branch': {
      const p = node.params
      return {
        title: '分岐の圧損',
        intro: '分岐は形状・流量比・径比で ζ が変わります。ζ は設計係数やカタログの値を使います。',
        headlineFormula: 'ΔP = ζ·q',
        steps: [
          ...velocityAndQSteps(usedDiameter(p.diameterMm)),
          {
            label: '分岐 ζ',
            formula: 'ζ（分岐形状による）',
            substitution: '',
            result: `${fmt(p.zeta, 2)}`,
          },
          {
            label: '圧損 ΔP',
            formula: 'ΔP = ζ·q',
            substitution: `= ${fmt(p.zeta, 2)} × ${fmt(qd, 2)}`,
            result: `${fmt(lossPa, 2)} Pa`,
          },
        ],
        curve, designPoint, takeaway,
      }
    }
    case 'reducer': {
      const p = node.params
      return {
        title: 'レデューサ（径変更）の圧損',
        intro: '径変更部の局部抵抗。動圧は流速の速い縮小後の径で評価します。',
        headlineFormula: 'ΔP = ζ·q（縮小後の径で動圧）',
        steps: [
          ...velocityAndQSteps(usedDiameter(p.diameterToMm)),
          {
            label: 'レデューサ ζ',
            formula: 'ζ（径比・角度による）',
            substitution: '',
            result: `${fmt(p.zeta, 2)}`,
          },
          {
            label: '圧損 ΔP',
            formula: 'ΔP = ζ·q',
            substitution: `= ${fmt(p.zeta, 2)} × ${fmt(qd, 2)}`,
            result: `${fmt(lossPa, 2)} Pa`,
          },
        ],
        curve, designPoint, takeaway,
      }
    }
    case 'aircon': {
      const p = node.params
      // 風量の内訳は計算（SPEC.md §5）と同じ値を出す。calc の第 2 送風機があればその値、
      // 無ければ同じ規則で入力から求める（リターン量があればそれが追加吸込の正）。
      const mover = sys?.secondaryMovers?.find(m => m.nodeId === node.id)
      const returnMode = p.returnQh != null && p.returnQh >= 0
      const intake = mover ? mover.intakeQh
        : returnMode ? Math.min(q, p.returnQh as number)
        : p.supplyFromHexQh != null && p.supplyFromHexQh >= 0 ? Math.max(0, q - Math.min(q, p.supplyFromHexQh)) : 0
      const supply = mover ? mover.supplyFromHexQh : Math.max(0, q - intake)
      return {
        title: 'エアコン（第2の送風機 + 混合点）',
        intro: 'エアコンは熱交換器からの供給風量に追加吸込（室内の循環）を足した循環風量で吹出します。本体の通過圧損は ζ·q。熱交換器とは別の送風機として、供給側・吸込側の必要静圧を個別に評価します。',
        headlineFormula: returnMode ? '循環 = 吹出端末の合計 ／ 熱交供給 = 循環 − リターン' : '循環 = 吹出端末の合計 ／ 追加吸込 = 循環 − 熱交供給',
        steps: [
          {
            label: '循環風量 Q_循環',
            formula: 'Q_循環 = Σ 吹出端末の風量',
            substitution: '',
            result: `${fmt(q, 0)} m³/h`,
          },
          ...(returnMode ? [
            {
              label: '追加吸込（リターン）',
              formula: '吸込 = min(循環, リターン量)',
              substitution: `= min(${fmt(q, 0)}, ${fmt(p.returnQh as number, 0)})`,
              result: `${fmt(intake, 0)} m³/h`,
            },
            {
              label: '熱交換器からの供給',
              formula: '供給 = 循環 − 吸込',
              substitution: `= ${fmt(q, 0)} − ${fmt(intake, 0)}`,
              result: `${fmt(supply, 0)} m³/h`,
            },
          ] : [
            {
              label: '熱交換器からの供給',
              formula: '供給 = min(循環, 入力値)',
              substitution: p.supplyFromHexQh != null ? `= min(${fmt(q, 0)}, ${fmt(p.supplyFromHexQh, 0)})` : '',
              result: p.supplyFromHexQh != null ? `${fmt(supply, 0)} m³/h` : '未設定（＝循環）',
            },
            {
              label: '追加吸込風量',
              formula: '吸込 = 循環 − 供給',
              substitution: `= ${fmt(q, 0)} − ${fmt(supply, 0)}`,
              result: `${fmt(intake, 0)} m³/h`,
            },
          ]),
          {
            label: '本体 通過圧損 ΔP',
            formula: 'ΔP = ζ·q（循環風量の動圧）',
            substitution: `= ${fmt(p.zeta, 3)} × ${fmt(qd, 2)}`,
            result: `${fmt(lossPa, 2)} Pa`,
          },
        ],
        curve, designPoint, takeaway: 'エアコンは熱交換器とは独立した送風機です。設定した循環風量で、供給側＋吸込側の必要静圧を出せる機器かを確かめます。',
      }
    }
    case 'fan': {
      // 系統抵抗曲線 ΔP = k·Q²（k は必要静圧 / 総風量² から決まる）。
      // 運転点（= 必要静圧点）は (fanFlowQh, fanRequiredPa)。
      const qFan = sys?.fanFlowQh ?? q
      const paReq = sys?.fanRequiredPa ?? 0
      const fanCurve = buildQuadraticCurve(qFan, paReq)
      const fanDesign = { q: qFan, pa: paReq }
      return {
        title: 'ファン（送風機）',
        intro: '送風機は、担当する経路の圧損に見合う静圧を出す機器です。系統の抵抗は ΔP = k·Q² で表され、設定風量と必要静圧の点を通ります（SPEC.md §6・§7）。',
        headlineFormula: '必要静圧 = 上流側 + 下流側',
        steps: [
          {
            label: '総風量 Q_fan',
            formula: 'Q_fan = Σ 吹出側の端末の風量',
            substitution: '',
            result: `${fmt(qFan, 0)} m³/h`,
          },
          {
            label: '必要静圧 ΔP_必要',
            formula: 'ΔP_必要 = 吸込側ルートの最大 + 吹出側ルートの最大',
            substitution: '',
            result: `${fmt(paReq, 1)} Pa`,
          },
          {
            label: '系統抵抗係数 k',
            formula: 'k = ΔP_必要 / Q_fan²',
            substitution: qFan > 0 ? `= ${fmt(paReq, 1)} / ${fmt(qFan, 0)}²` : '',
            result: qFan > 0 ? `${(paReq / (qFan * qFan)).toExponential(2)} Pa·(h/m³)²` : '—',
          },
        ],
        curve: fanCurve,
        designPoint: fanDesign,
        takeaway: '送風機は、その P–Q 特性と系統の抵抗曲線（ΔP ∝ Q²）の交点（運転点）で運転します。設定風量のときに出せる静圧が必要静圧以上なら、設定風量を確保できます（SPEC.md §7）。',
      }
    }
  }
}
