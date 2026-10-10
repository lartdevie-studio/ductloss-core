import type { DesignCoefficients } from '../src'

/**
 * テスト用の架空の係数。実在の資料・製品の値ではない。
 * 性質のテスト（形によらない決まり事）は係数の値に依らないので、これで足りる。
 */
export const TEST_COEFFICIENTS: DesignCoefficients = {
  name: 'テスト用（架空）',
  source: 'テストのために作った値。設計には使わないこと',
  lambda: 0.04,
  bendEquivLength90M: { 75: 0.2, 100: 0.3, 150: 0.45, 200: 0.6 },
  zeta: { branch: 1.0, reducer: 0.25, terminal: 1.2, filter: 4.0, aircon: 0.5 },
  terminalPa: 6,
  filterPa: 25,
}
