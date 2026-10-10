/**
 * 係数と計算の版の追跡（改良計画 2-4・docs/DUCTLOSS_PHASE1_FINDINGS.md の TRACE-1〜6）と、
 * ダンパ調整の前の値（DVA-4）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  createDuctLoss, coefficientFingerprint, ENGINE_VERSION, balanceTerminals, undoBalanceTerminals,
  canUndoBalanceTerminals, summarizeTerminalZeta,
  type DesignCoefficients, type DuctLossPayload, type DuctNode, type DuctSystem, type NodeParams,
} from '../src'
import { TEST_COEFFICIENTS } from './testCoefficients'

const dl = createDuctLoss(TEST_COEFFICIENTS)
const RHO = 1.2

describe('計算の版', () => {
  it('ENGINE_VERSION は package.json の version と同じ', () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
    expect(ENGINE_VERSION).toBe(pkg.version)
  })
})

describe('係数の識別', () => {
  it('同じ値なら同じ識別。名前・出典は含めない', () => {
    const renamed: DesignCoefficients = { ...TEST_COEFFICIENTS, name: '別の名前', source: '別の出典' }
    expect(coefficientFingerprint(renamed)).toBe(coefficientFingerprint(TEST_COEFFICIENTS))
  })
  it('値が 1 つでも違えば別の識別（λ・曲がりの表・ζ・既定 Pa）', () => {
    const base = coefficientFingerprint(TEST_COEFFICIENTS)
    const variants: DesignCoefficients[] = [
      { ...TEST_COEFFICIENTS, lambda: 0.041 },
      { ...TEST_COEFFICIENTS, bendEquivLength90M: { ...TEST_COEFFICIENTS.bendEquivLength90M, 100: 0.31 } },
      { ...TEST_COEFFICIENTS, zeta: { ...TEST_COEFFICIENTS.zeta, branch: 1.01 } },
      { ...TEST_COEFFICIENTS, terminalPa: 7 },
    ]
    for (const v of variants) expect(coefficientFingerprint(v)).not.toBe(base)
  })
  it('曲がりの表の書き順に依らない', () => {
    const reordered: DesignCoefficients = { ...TEST_COEFFICIENTS, bendEquivLength90M: { 200: 0.6, 75: 0.2, 150: 0.45, 100: 0.3 } }
    expect(coefficientFingerprint(reordered)).toBe(coefficientFingerprint(TEST_COEFFICIENTS))
  })
  it('形は cf1- と 16 桁の 16 進数', () => {
    expect(coefficientFingerprint(TEST_COEFFICIENTS)).toMatch(/^cf1-[0-9a-f]{16}$/)
  })
})

type Spec = { id: string; parent: string | null; params: NodeParams }
function build(specs: Spec[]): DuctSystem {
  const nodes: Record<string, DuctNode> = {}
  for (const s of specs) nodes[s.id] = { id: s.id, x: 0, y: 0, label: s.id, parentId: s.parent, childIds: [], side: 'downstream', params: s.params }
  for (const s of specs) if (s.parent) nodes[s.parent].childIds.push(s.id)
  return { id: 'sys', name: '系統', type: 'SA', rootId: specs[0].id, nodes }
}
const duct = (l: number, lambda: number | null = null): NodeParams => ({ kind: 'duct', diameterMm: 100, lengthM: l, bendAngleDeg: 90, bendCount: 0, lambda })
const catalogTerminal = (q: number): NodeParams => ({
  kind: 'terminal', diameterMm: 100, targetFlowQh: q, pressureMode: 'zeta', zeta: 1.5, targetPa: 0,
  catalogRef: { equipmentId: 'x', label: '架空の吹出口 D-100', source: '架空のカタログ p.1' },
})
/** 送風機 → 幹 → 2 本の枝（長い枝 A・短い枝 B）。B の端末だけがダンパ調整で上がる */
const twoBranches = (fanLambda: number | null = 0.04): DuctSystem => build([
  { id: 'fan', parent: null, params: { kind: 'fan', maxStaticPa: null, notch: '', defaultLambda: fanLambda } as NodeParams },
  { id: 'trunk', parent: 'fan', params: duct(2) },
  { id: 'br', parent: 'trunk', params: { kind: 'branch', diameterMm: 100, zeta: 1.0 } },
  { id: 'dA', parent: 'br', params: duct(8, 0.05) },
  { id: 'tA', parent: 'dA', params: catalogTerminal(60) },
  { id: 'dB', parent: 'br', params: duct(1) },
  { id: 'tB', parent: 'dB', params: catalogTerminal(60) },
])

describe('計算結果の出どころ（CalcResult.meta・NodeResult.duct）', () => {
  it('版・係数の名前と識別・ρ・倍率が入る', () => {
    const calc = dl.calcSystem(twoBranches(), RHO, 1.2)
    expect(calc.meta).toEqual({
      engineVersion: ENGINE_VERSION,
      coefficients: { name: TEST_COEFFICIENTS.name, source: TEST_COEFFICIENTS.source, fingerprint: coefficientFingerprint(TEST_COEFFICIENTS) },
      rho: RHO, flowScale: 1.2,
    })
  })
  it('直管ごとに、使った λ とその出どころ', () => {
    const calc = dl.calcSystem(twoBranches(), RHO)
    expect(calc.byNode.dA.duct).toMatchObject({ lambda: 0.05, lambdaSource: 'duct' })
    expect(calc.byNode.trunk.duct).toMatchObject({ lambda: 0.04, lambdaSource: 'fan' })
    const noFanLambda = dl.calcSystem(twoBranches(null), RHO)
    expect(noFanLambda.byNode.trunk.duct).toMatchObject({ lambda: TEST_COEFFICIENTS.lambda, lambdaSource: 'coefficients' })
  })
})

describe('保存データの記録（coefficientsStamp）', () => {
  const payloadOf = (sys: DuctSystem, stamp?: DuctLossPayload['coefficientsStamp']): DuctLossPayload =>
    ({ schemaVersion: 4, rho: RHO, systems: [sys], ...(stamp ? { coefficientsStamp: stamp } : {}) })

  it('新しく作るデータには、作った係数の記録が付く', () => {
    expect(dl.makeInitialPayload().coefficientsStamp).toEqual(dl.stamp)
  })
  it('同じ係数で計算するなら「保存時の設計係数」の行は出ない', () => {
    const rows = dl.collectCalcConditions(payloadOf(twoBranches(), dl.stamp))
    expect(rows.some(r => r.label === '保存時の設計係数')).toBe(false)
    expect(rows.find(r => r.label === '計算の版')?.value).toBe(`ductloss-core ${ENGINE_VERSION}`)
  })
  it('別の係数で計算し直すと、計算条件に保存時の係数を出して知らせる', () => {
    const other = createDuctLoss({ ...TEST_COEFFICIENTS, name: '別の係数', bendEquivLength90M: { 100: 0.5 } })
    const rows = other.collectCalcConditions(payloadOf(twoBranches(), dl.stamp))
    const row = rows.find(r => r.label === '保存時の設計係数')
    expect(row?.value).toContain(TEST_COEFFICIENTS.name)
    expect(row?.note).toContain('曲がりの相当長')
  })
  it('記録の無い古いデータでは出さない（不明として扱う）', () => {
    const rows = dl.collectCalcConditions(payloadOf(twoBranches()))
    expect(rows.some(r => r.label === '保存時の設計係数')).toBe(false)
  })
})

describe('ダンパ調整の前の値（DVA-4）', () => {
  const sys = twoBranches()
  const calc = dl.calcSystem(sys, RHO)
  const balanced = balanceTerminals(sys, calc)

  it('調整で上がった端末は、調整前の ζ（カタログの 1.5）を記録する。基準の枝は触らない', () => {
    const tB = balanced.nodes.tB.params
    expect(tB.kind === 'terminal' && tB.beforeBalance?.zeta).toBe(1.5)
    expect(tB.kind === 'terminal' && tB.zeta).toBeGreaterThan(1.5)
    const tA = balanced.nodes.tA.params
    expect(tA.kind === 'terminal' && tA.beforeBalance).toBeUndefined()
    expect(canUndoBalanceTerminals(balanced)).toBe(true)
    expect(canUndoBalanceTerminals(sys)).toBe(false)
  })

  it('2 回調整しても、最初の値を残す', () => {
    const again = balanceTerminals(balanced, dl.calcSystem(balanced, RHO))
    const tB = again.nodes.tB.params
    expect(tB.kind === 'terminal' && tB.beforeBalance?.zeta).toBe(1.5)
  })

  it('計算書の端末の表は、カタログの ζ と調整で足した ζ を分けて出す', () => {
    const rows = summarizeTerminalZeta({ schemaVersion: 4, rho: RHO, systems: [balanced] })
    const adjusted = rows.find(r => r.baseZeta != null)!
    expect(adjusted.baseZeta).toBe(1.5)
    expect(adjusted.addedZeta).toBeCloseTo(adjusted.zetaUsed - 1.5, 12)
    expect(adjusted.source).toBe('架空のカタログ p.1')
    const untouched = rows.find(r => r.baseZeta == null)!
    expect([untouched.zetaUsed, untouched.addedZeta]).toEqual([1.5, 0])
  })

  it('調整の取り消しは調整前の値に戻し、記録も消す', () => {
    const undone = undoBalanceTerminals(balanced)
    const tB = undone.nodes.tB.params
    expect(tB.kind === 'terminal' && tB.zeta).toBe(1.5)
    expect(tB.kind === 'terminal' && tB.beforeBalance).toBeUndefined()
    expect(dl.calcSystem(undone, RHO).byNode.tB.lossPa).toBeCloseTo(calc.byNode.tB.lossPa, 12)
  })

  it('既定値に戻す操作でも、カタログから選んだ端末の ζ は消さない（調整前の値に戻す）', () => {
    const reset = dl.resetTerminals(balanced, dl.calcSystem(balanced, RHO))
    for (const id of ['tA', 'tB']) {
      const p = reset.nodes[id].params
      expect(p.kind === 'terminal' && p.zeta, id).toBe(1.5)
    }
  })
})
