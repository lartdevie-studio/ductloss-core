/**
 * 検算例（examples/）の手計算と、計算本体の結果の突き合わせ（VALIDATION.md）。
 *
 * 期待値の expected.json は各例の handcalc.py（Python・計算本体を使わない手計算）が書き出したもの。
 * ここでは Python を動かさず、書き出された値と比べる。入力（input.json）を変えたら handcalc.py を回し直すこと
 * （入力と期待値の組がずれると、このテストが落ちる）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createDuctLoss, collectMovers, balanceTerminals, type CalcResult, type DesignCoefficients, type DuctLossPayload } from '../src'

const TOL = 1e-6
const load = (p: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../examples/${p}`, import.meta.url)), 'utf8'))
type Member = { Q: number; v: number; q: number; dP: number }
type Input = { coefficients: DesignCoefficients; payload: DuctLossPayload }

function expectMembersAndRoutes(exp: { members: Record<string, Member>; routes: Record<string, number> }, calc: CalcResult) {
  for (const [id, m] of Object.entries(exp.members)) {
    const r = calc.byNode[id]
    expect(r, id).toBeDefined()
    expect(Math.abs(r.flowQh - m.Q), `${id} Q`).toBeLessThanOrEqual(TOL)
    expect(Math.abs(r.velocity - m.v), `${id} v`).toBeLessThanOrEqual(TOL)
    expect(Math.abs(r.q - m.q), `${id} q`).toBeLessThanOrEqual(TOL)
    expect(Math.abs(r.lossPa - m.dP), `${id} ΔP`).toBeLessThanOrEqual(TOL)
  }
  for (const [leaf, pa] of Object.entries(exp.routes)) {
    const route = calc.routes.find(rt => rt.terminalId === leaf)
    expect(route, leaf).toBeDefined()
    expect(Math.abs(route!.totalPa - pa), `ルート ${leaf}`).toBeLessThanOrEqual(TOL)
  }
}

describe('検算例 1: 送風機 1 台＋外気側のフィルター・フード＋主管＋2 枝', () => {
  const inp: Input = load('01-single-fan/input.json')
  const exp = load('01-single-fan/expected.json')
  const dl = createDuctLoss(inp.coefficients)
  const sys = inp.payload.systems[0]
  const calc = dl.calcSystem(sys, inp.payload.rho)

  it('部材ごとの風量・風速・動圧・圧損とルートの合計', () => expectMembersAndRoutes(exp, calc))

  it('必要静圧・判定・運転点', () => {
    expect(Math.abs(calc.fanUpstreamPa - exp.fan.upstreamPa)).toBeLessThanOrEqual(TOL)
    expect(Math.abs(calc.fanDownstreamPa - exp.fan.downstreamPa)).toBeLessThanOrEqual(TOL)
    expect(Math.abs(calc.fanRequiredPa - exp.fan.requiredPa)).toBeLessThanOrEqual(TOL)
    const v = collectMovers(inp.payload.systems, { [sys.id]: calc })[0].verdict
    expect(v.level).toBe(exp.fan.level)
    expect(Math.abs((v.availableStaticPa ?? NaN) - exp.fan.availableAtDesignPa)).toBeLessThanOrEqual(TOL)
    expect(exp.fan.operatingPoints).toHaveLength(1)
    expect(Math.abs((v.operating?.q ?? NaN) - exp.fan.operatingPoints[0].q)).toBeLessThanOrEqual(TOL)
    expect(Math.abs((v.operating?.p ?? NaN) - exp.fan.operatingPoints[0].p)).toBeLessThanOrEqual(TOL)
  })

  it('ダンパ調整の ζ', () => {
    const p = balanceTerminals(sys, calc).nodes[exp.balance.adjusted].params
    expect(p.kind).toBe('terminal')
    expect(Math.abs((p as { zeta: number }).zeta - exp.balance.zetaNew)).toBeLessThanOrEqual(TOL)
  })
})

describe('検算例 2: 熱交換器＋ダクト形エアコン', () => {
  const inp: Input = load('02-hex-aircon/input.json')
  const exp = load('02-hex-aircon/expected.json')
  const dl = createDuctLoss(inp.coefficients)
  const sys = inp.payload.systems[0]
  const calc = dl.calcSystem(sys, inp.payload.rho)

  it('部材ごとの風量・風速・動圧・圧損とルートの合計', () => expectMembersAndRoutes(exp, calc))

  it('混合点の質量保存（循環 ＝ 熱交からの供給 ＋ 追加吸込）', () => {
    const ac = calc.secondaryMovers[0]
    expect([ac.circulationQh, ac.supplyFromHexQh, ac.intakeQh]).toEqual([exp.flows.circulation, exp.flows.supplyFromHex, exp.flows.return])
    expect(calc.fanFlowQh).toBe(exp.flows.hex)
  })

  it('送風機ごとの必要静圧（熱交換器はエアコンの手前まで、エアコンは本体から先）', () => {
    const ac = calc.secondaryMovers[0]
    expect(Math.abs(calc.fanUpstreamPa - exp.hex.upstreamPa)).toBeLessThanOrEqual(TOL)
    expect(Math.abs(calc.fanDownstreamPa - exp.hex.downstreamPa)).toBeLessThanOrEqual(TOL)
    expect(Math.abs(calc.fanRequiredPa - exp.hex.requiredPa)).toBeLessThanOrEqual(TOL)
    expect(Math.abs(ac.supplyCriticalPa - exp.aircon.supplyPa)).toBeLessThanOrEqual(TOL)
    expect(Math.abs(ac.intakeCriticalPa - exp.aircon.intakePa)).toBeLessThanOrEqual(TOL)
    expect(Math.abs(ac.requiredPa - exp.aircon.requiredPa)).toBeLessThanOrEqual(TOL)
  })

  it('判定（熱交は定格 1 点、エアコンは P-Q 特性）', () => {
    const movers = collectMovers(inp.payload.systems, { [sys.id]: calc })
    const hex = movers.find(m => m.nodeId === null)!
    const ac = movers.find(m => m.nodeId === 'ac')!
    expect(hex.verdict.level).toBe(exp.hex.level)
    expect(ac.verdict.level).toBe(exp.aircon.level)
    expect(Math.abs((ac.verdict.availableStaticPa ?? NaN) - exp.aircon.availableAtDesignPa)).toBeLessThanOrEqual(TOL)
    expect(Math.abs((ac.verdict.operating?.q ?? NaN) - exp.aircon.operatingPoints[0].q)).toBeLessThanOrEqual(TOL)
  })
})

describe('検算例 3: 粗さから求める λ（Colebrook）と、曲がりの ζ（形・角度の補正・器材の ζ）', () => {
  const inp: Input & { tempC: number } = load('03-roughness-bend-zeta/input.json')
  const exp = load('03-roughness-bend-zeta/expected.json')
  const dl = createDuctLoss(inp.coefficients)
  const sys = inp.payload.systems[0]
  const calc = dl.calcSystem(sys, inp.payload.rho, 1, { tempC: inp.tempC })

  it('直管ごとのレイノルズ数・λ・曲がりの ζ と、部材の圧損', () => {
    for (const [id, m] of Object.entries(exp.members as Record<string, Member & { Re?: number; lambda?: number; bendZeta?: number; material?: string }>)) {
      const r = calc.byNode[id]
      expect(Math.abs(r.lossPa - m.dP), `${id} ΔP`).toBeLessThanOrEqual(TOL)
      if (m.lambda != null) {
        expect(r.duct?.lambdaSource, id).toBe('roughness')
        expect(r.duct?.material, id).toBe(m.material)
        expect(Math.abs((r.duct?.reynolds ?? NaN) - m.Re!) / m.Re!, `${id} Re`).toBeLessThanOrEqual(1e-9)
        expect(Math.abs((r.duct?.lambda ?? NaN) - m.lambda), `${id} λ`).toBeLessThanOrEqual(1e-9)
        expect(Math.abs((r.duct?.bendZeta ?? NaN) - m.bendZeta!), `${id} 曲がりの ζ`).toBeLessThanOrEqual(1e-12)
        expect(r.duct?.bendModel).toBe('zeta')
      }
    }
  })
  it('ルートと必要静圧・判定（特性は ρ/1.20 倍）', () => {
    for (const [leaf, pa] of Object.entries(exp.routes as Record<string, number>)) {
      expect(Math.abs(calc.routes.find(rt => rt.terminalId === leaf)!.totalPa - pa), leaf).toBeLessThanOrEqual(TOL)
    }
    expect(Math.abs(calc.fanRequiredPa - exp.fan.requiredPa)).toBeLessThanOrEqual(TOL)
    const v = collectMovers(inp.payload.systems, { [sys.id]: calc })[0].verdict
    expect(Math.abs(v.densityRatio - exp.fan.densityRatio)).toBeLessThanOrEqual(1e-12)
    expect(Math.abs((v.availableStaticPa ?? NaN) - exp.fan.availableAtDesignPa)).toBeLessThanOrEqual(TOL)
    expect(Math.abs((v.operating?.q ?? NaN) - exp.fan.operatingPoints[0].q)).toBeLessThanOrEqual(TOL)
  })
})

describe('検算例 4: 曲がりの ζ を径ごとに持つ形・角度の比例・器材の ζ（0.3.0）', () => {
  const inp: Input & { tempC?: number } = load('04-bend-zeta-by-diameter/input.json')
  const exp = load('04-bend-zeta-by-diameter/expected.json')
  const dl = createDuctLoss(inp.coefficients)
  const sys = inp.payload.systems[0]
  const calc = dl.calcSystem(sys, inp.payload.rho, 1, { tempC: inp.tempC })

  it('直管ごとの λ・曲がりの ζ・直管と曲がりの圧損と、部材の圧損', () => {
    for (const [id, m] of Object.entries(exp.members as Record<string, Member & { lambda?: number; bendZeta?: number; frictionPa?: number; bendPa?: number }>)) {
      const r = calc.byNode[id]
      expect(Math.abs(r.lossPa - m.dP), `${id} ΔP`).toBeLessThanOrEqual(TOL)
      if (m.lambda != null) {
        expect(Math.abs((r.duct?.lambda ?? NaN) - m.lambda), `${id} λ`).toBeLessThanOrEqual(1e-12)
        expect(Math.abs((r.duct?.bendZeta ?? NaN) - m.bendZeta!), `${id} 曲がりの ζ`).toBeLessThanOrEqual(1e-12)
        expect(Math.abs((r.duct?.frictionPa ?? NaN) - m.frictionPa!), `${id} 直管`).toBeLessThanOrEqual(TOL)
        expect(Math.abs((r.duct?.bendPa ?? NaN) - m.bendPa!), `${id} 曲がり`).toBeLessThanOrEqual(TOL)
        expect(r.duct?.bendModel).toBe('zeta')
      }
    }
  })
  it('ルートと必要静圧・判定・運転点', () => {
    for (const [leaf, pa] of Object.entries(exp.routes as Record<string, number>)) {
      expect(Math.abs(calc.routes.find(rt => rt.terminalId === leaf)!.totalPa - pa), leaf).toBeLessThanOrEqual(TOL)
    }
    expect(Math.abs(calc.fanRequiredPa - exp.fan.requiredPa)).toBeLessThanOrEqual(TOL)
    const v = collectMovers(inp.payload.systems, { [sys.id]: calc })[0].verdict
    expect(v.level).toBe(exp.fan.level)
    expect(Math.abs((v.availableStaticPa ?? NaN) - exp.fan.availableAtDesignPa)).toBeLessThanOrEqual(TOL)
    expect(Math.abs((v.operating?.q ?? NaN) - exp.fan.operatingPoints[0].q)).toBeLessThanOrEqual(TOL)
    expect(Math.abs((v.operating?.p ?? NaN) - exp.fan.operatingPoints[0].p)).toBeLessThanOrEqual(TOL)
  })
})
