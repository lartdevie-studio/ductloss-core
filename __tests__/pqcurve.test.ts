import { describe, it, expect } from 'vitest'
import { findOperatingPoint } from '../src'

describe('運転点（findOperatingPoint）', () => {
  it('特性のちょうど右端で交わるときも運転点を返す', () => {
    // 右端 (150, 45)、k = 45/150² → 右端でちょうど k·Q² = P
    const op = findOperatingPoint([{ q: 0, p: 120 }, { q: 100, p: 60 }, { q: 150, p: 45 }], 45 / 150 ** 2)
    expect(op).not.toBeNull()
    expect(op!.q).toBeCloseTo(150, 6)
    expect(op!.p).toBeCloseTo(45, 6)
  })

  it('交点が複数あるとき（鞍部のある特性）は風量の小さい側の最初の交点', () => {
    const op = findOperatingPoint([{ q: 0, p: 100 }, { q: 30, p: 20 }, { q: 60, p: 120 }, { q: 150, p: 0 }], 0.03)
    expect(op!.q).toBeLessThan(30)
  })

  it('範囲の中に交点が無ければ null', () => {
    expect(findOperatingPoint([{ q: 0, p: 100 }, { q: 50, p: 90 }], 0.001)).toBeNull()
  })
})
