/**
 * 送風機の判定の境目（改良計画 2-3・docs/DUCTLOSS_PHASE1_FINDINGS.md）。
 * 期待値は部品の関数ではなく手計算で出している。
 */
import { describe, it, expect } from 'vitest'
import { judgeMover, findOperatingPoints, VERDICT_PREMISE } from '../src'

const CURVE = [{ q: 50, p: 100 }, { q: 100, p: 80 }, { q: 200, p: 40 }]

describe('特性の左端より少ない風量', () => {
  it('左端の静圧 < 必要静圧 → 保留（以前は根拠の無い「確保できません」）', () => {
    // 設定 20 m³/h・必要 120 Pa。左端 50 m³/h の 100 Pa は 20 m³/h での静圧ではない
    const v = judgeMover(120, 20, null, CURVE)
    expect(v.level).toBe('insufficient')
    expect(v.availableStaticPa).toBeNull()
    expect(v.marginPa).toBeNull()
  })

  it('左端の静圧 ≥ 必要静圧 → 前提つきの ok（右下がりの特性を前提にした下限）', () => {
    const v = judgeMover(90, 20, null, CURVE)
    expect(v.level).toBe('ok')
    expect(v.availableStaticPa).toBeNull()
    expect(v.caveat).toContain('右下がり')
  })
})

describe('定格 1 点の判定', () => {
  it('定格より少ない風量で、必要静圧 > 定格の静圧 → 保留（以前は但し書きと逆の ng）', () => {
    const v = judgeMover(120, 100, 100, null, 150)
    expect(v.level).toBe('insufficient')
  })

  it('定格より少ない風量で、必要静圧 ≤ 定格の静圧 → 前提つきの ok。出せる静圧の値は書かない', () => {
    const v = judgeMover(80, 100, 100, null, 150)
    expect(v.level).toBe('ok')
    expect(v.availableStaticPa).toBeNull()
    expect(v.caveat).toContain('右下がり')
  })

  it('定格より多い風量で、必要静圧 > 定格の静圧 → ng。定格の静圧を設定風量の静圧として書かない', () => {
    const v = judgeMover(120, 200, 100, null, 150)
    expect(v.level).toBe('ng')
    expect(v.availableStaticPa).toBeNull()
    expect(v.summary).toContain('定格風量 150 m³/h での機外静圧 100.0 Pa')
  })
})

describe('交点（運転点）の求め方', () => {
  it('線分ごとの解析解: 付録 A と同じ特性・抵抗で 109.06 m³/h（手計算: 0.0041304Q² + 1.2Q − 180 = 0）', () => {
    const k = 41.303822181585154 / 100 ** 2
    const [op] = findOperatingPoints([{ q: 0, p: 120 }, { q: 100, p: 60 }, { q: 150, p: 0 }], k)
    const exact = (-1.2 + Math.sqrt(1.44 + 4 * k * 180)) / (2 * k)
    expect(op.q).toBeCloseTo(exact, 9)
  })

  it('走査の刻みより細い線分の交点も見つける（以前は取りこぼした）', () => {
    // 500→500.5 m³/h で 90 → 0.1 Pa に落ちる。k = 1e-4 なら k·Q² ≈ 25 Pa の線と、この細い線分で交わる
    const pts = [{ q: 0, p: 100 }, { q: 500, p: 90 }, { q: 500.5, p: 0.1 }, { q: 1000, p: 0 }]
    const ops = findOperatingPoints(pts, 1e-4)
    expect(ops.length).toBe(1)
    expect(ops[0].q).toBeGreaterThan(500)
    expect(ops[0].q).toBeLessThan(500.5)
  })

  it('接するだけの点（重解）も交点に数える', () => {
    // 特性の線分 (60,20)→(140,180) は p = −100 + 2Q。k = 0.01 で 0.01Q² − 2Q + 100 = 0 の判別式は 0、
    // 重解 Q = 2/(2·0.01) = 100（p = 100 = 0.01·100²）で接する
    const ops = findOperatingPoints([{ q: 60, p: 20 }, { q: 140, p: 180 }], 0.01)
    expect(ops.length).toBe(1)
    expect(ops[0].q).toBeCloseTo(100, 6)
    expect(ops[0].p).toBeCloseTo(100, 6)
  })

  it('抵抗 0（k = 0）は静圧 0 になる点', () => {
    const ops = findOperatingPoints([{ q: 0, p: 100 }, { q: 200, p: 0 }], 0)
    expect(ops[0].q).toBeCloseTo(200, 9)
  })

  it('左端ちょうどの交点も見つける（両端を同じ決まりで扱う）', () => {
    // 左端 (50, 25) で k·50² = 25 → k = 0.01
    const ops = findOperatingPoints([{ q: 50, p: 25 }, { q: 100, p: 10 }], 0.01)
    expect(ops[0].q).toBeCloseTo(50, 9)
  })

  it('鞍部で交点が複数あり、最初の交点が設定風量より少なければ保留', () => {
    // 特性 (0,100)(30,20)(60,120)(150,0)。設定 60 m³/h・必要 108 Pa → k = 108/60² = 0.03。
    // 設定風量では 120 Pa ≥ 108 Pa だが、手計算で交点は 3 つ:
    //   0〜30:  0.03Q² + (8/3)Q − 100 = 0 → Q ≈ 28.4
    //   30〜60: 0.03Q² − (10/3)Q + 80 = 0 → Q ≈ 35.1（もう一方の根 ≈ 76 は区間外）
    //   60〜150: 0.03Q² + (4/3)Q − 200 = 0 → Q ≈ 62.4
    const pts = [{ q: 0, p: 100 }, { q: 30, p: 20 }, { q: 60, p: 120 }, { q: 150, p: 0 }]
    const ops = findOperatingPoints(pts, 0.03)
    expect(ops.map(o => Math.round(o.q * 10) / 10)).toEqual([28.4, 35.1, 62.4])
    const v = judgeMover(108, 60, null, pts)
    expect(v.level).toBe('insufficient')
    expect(v.caveat).toContain('3 つ')
  })
})

describe('前提', () => {
  it('どの判定にも前提が付く（設計点を通る ΔP=k·Q² の推定・調整が実現される前提）', () => {
    for (const v of [judgeMover(30, 100, null, CURVE), judgeMover(0, 0, null, null), judgeMover(120, 200, 100, null, 150)]) {
      expect(v.premise).toBe(VERDICT_PREMISE)
    }
    expect(VERDICT_PREMISE).toContain('測定・調整')
  })
})

describe('空気密度と機器の特性（特性は標準空気 1.20 の値とみなし、ρ/1.20 倍にして比べる）', () => {
  // SPEC 付録 A-6 の特性 (0,120)・(100,60)・(150,0)、必要静圧 41.30382 Pa・設定風量 100 m³/h を、ρ = 1.0 で比べる。
  // 手計算: 倍率 1.0/1.2 = 0.8333…。100 m³/h で出せる静圧 60 × 0.8333 = 50.0 Pa。
  // 運転点は 100〜150 の区間 P = 0.8333·(180 − 1.2Q) と k·Q²（k = 41.30382/100²）の交点: Q = 104.712 m³/h、P = 45.288 Pa
  const pts = [{ q: 0, p: 120 }, { q: 100, p: 60 }, { q: 150, p: 0 }]
  it('ρ = 1.0 なら出せる静圧と運転点が 1.0/1.2 倍の特性で決まる', () => {
    const v = judgeMover(41.30382, 100, null, pts, null, 1.0)
    expect(v.densityRatio).toBeCloseTo(1 / 1.2, 12)
    expect(v.availableStaticPa).toBeCloseTo(50.0, 9)
    expect(v.operating?.q).toBeCloseTo(104.712, 3)
    expect(v.operating?.p).toBeCloseTo(45.288, 3)
    expect(v.premise).toContain('標準空気')
  })
  it('ρ を渡さないか 1.2 なら倍率 1（以前と同じ）', () => {
    for (const v of [judgeMover(41.30382, 100, null, pts, null), judgeMover(41.30382, 100, null, pts, null, 1.2)]) {
      expect(v.densityRatio).toBe(1)
      expect(v.availableStaticPa).toBeCloseTo(60, 9)
    }
  })
  it('定格 1 点・機外静圧だけでも同じ倍率を掛ける', () => {
    expect(judgeMover(70, 100, 80, null, 100, 1.0).level).toBe('ng')   // 80 × 0.833 = 66.7 < 70
    expect(judgeMover(70, 100, 80, null, 100, 1.2).level).toBe('ok')
  })
})
