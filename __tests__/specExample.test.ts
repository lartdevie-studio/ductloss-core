/**
 * SPEC.md 付録 A（手計算の例題）に書いた数値が、計算結果と一致すること。
 *
 * 仕様書の例題は「この手順で電卓を叩けば同じ値になる」と約束している。
 * 式・既定の決まり事を変えたのに仕様書の数字が古いまま、を止める。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDuctLoss, judgeMover, balanceTerminals } from '../src'
import { EXAMPLE_COEFFICIENTS, EXAMPLE_RHO, buildSpecExample } from './specExample'

const spec = readFileSync(join(fileURLToPath(new URL('..', import.meta.url)), 'SPEC.md'), 'utf8')
const appendix = spec.slice(spec.indexOf('## 付録 A'))
const f3 = (x: number) => x.toFixed(3)

const dl = createDuctLoss(EXAMPLE_COEFFICIENTS)
const sys = buildSpecExample()
const calc = dl.calcSystem(sys, EXAMPLE_RHO)

/** 節（### A-n）の中から表の 1 行を先頭の名前で探す。同じ名前が別の節の表にもあるので節で絞る */
function rowIn(section: string, label: string): string {
  const start = appendix.indexOf(`### ${section}`)
  const next = appendix.indexOf('### ', start + 4)
  const body = appendix.slice(start, next < 0 ? undefined : next)
  const line = body.split('\n').find(l => l.startsWith(`| ${label} |`))
  if (!line) throw new Error(`付録 A の ${section} に「${label}」の行がありません`)
  return line
}
const cells = (line: string) => line.split('|').slice(1, -1).map(c => c.trim())

describe('SPEC.md 付録 A は計算結果と一致する', () => {
  it('付録 A がある', () => {
    expect(appendix.startsWith('## 付録 A')).toBe(true)
  })

  it('A-1 の入力表は例題の系統・係数と同じ', () => {
    const c = EXAMPLE_COEFFICIENTS
    const a1 = appendix.slice(appendix.indexOf('### A-1'), appendix.indexOf('### A-2'))
    expect(a1).toContain(`| λ | ${c.lambda} |`)
    expect(a1).toContain(`φ100 = ${c.bendEquivLength90M[100]} m ／ φ125 = ${c.bendEquivLength90M[125].toFixed(2)} m`)
    expect(a1).toContain(`| 空気密度 ρ | ${EXAMPLE_RHO} kg/m³ |`)
    const NAMES: [string, string][] = [
      ['OA ダクト', 'OA'], ['OA フード', 'HOOD'], ['SA 主管', 'MAIN'], ['分岐', 'BR'],
      ['枝 A', 'A'], ['吹出口 A', 'TA'], ['枝 B', 'B'], ['吹出口 B', 'TB'],
    ]
    for (const [label, id] of NAMES) {
      const line = rowIn('A-1', label)
      const p = sys.nodes[id].params
      if (p.kind === 'duct') {
        expect(line).toContain(`φ${p.diameterMm}・長さ ${p.lengthM} m`)
        expect(line).toContain(p.bendCount === 0 ? '曲がりなし' : `90°×${p.bendCount}`)
      } else if (p.kind === 'terminal') {
        expect(line).toContain(`ζ = ${p.zeta.toFixed(1)}・目標風量 ${p.targetFlowQh} m³/h`)
      } else if (p.kind === 'branch') {
        expect(line).toContain(`ζ = ${p.zeta.toFixed(1)}`)
      }
    }
  })

  const PARTS: [string, string][] = [
    ['OA ダクト', 'OA'], ['OA フード', 'HOOD'], ['SA 主管', 'MAIN'], ['分岐', 'BR'],
    ['枝 A', 'A'], ['吹出口 A', 'TA'], ['枝 B', 'B'], ['吹出口 B', 'TB'],
  ]
  it.each(PARTS)('A-3 %s の Q・v・q・ΔP', (label, id) => {
    const r = calc.byNode[id]
    const c = cells(rowIn('A-3', label))
    expect(c[1]).toBe(String(Math.round(r.flowQh)))
    expect(c[3]).toBe(f3(r.velocity))
    expect(c[4]).toBe(f3(r.q))
    expect(c[6]).toBe(f3(r.lossPa))
    const p = sys.nodes[id].params
    const dMm = Math.round(Math.sqrt((4 * r.flowQh) / (3600 * Math.PI * r.velocity)) * 1000)
    expect(c[2]).toBe(`φ${dMm}`)
    if (p.kind === 'duct') {
      const lEquiv = r.lossPa / r.dpPerMeter
      expect(c[5]).toContain(`${r.dpPerMeter.toFixed(4)} Pa/m × ${f3(lEquiv)} m`)
    }
  })

  it('A-4 ルートの合計', () => {
    const total = (tid: string) => calc.routes.find(r => r.terminalId === tid)!.totalPa
    expect(cells(rowIn('A-4', '吹出口 A')).at(-1)).toBe(f3(total('TA')))
    expect(cells(rowIn('A-4', '吹出口 B')).at(-1)).toBe(f3(total('TB')))
    expect(cells(rowIn('A-4', 'OA フード')).at(-1)).toBe(f3(total('HOOD')))
  })

  it('A-5 必要静圧', () => {
    const a5 = appendix.slice(appendix.indexOf('### A-5'), appendix.indexOf('### A-6'))
    expect(a5).toContain(`上流側 ＝ 吸込側ルートの最大 ＝ **${f3(calc.fanUpstreamPa)} Pa**`)
    expect(a5).toContain(`下流側 ＝ 吹出側ルートの最大 ＝ **${f3(calc.fanDownstreamPa)} Pa**`)
    expect(a5).toContain(`＝ **${f3(calc.fanRequiredPa)} Pa**`)
  })

  it('A-6 送風機の判定と運転点', () => {
    const v = judgeMover(calc.fanRequiredPa, calc.fanFlowQh, null, [{ q: 0, p: 120 }, { q: 100, p: 60 }, { q: 150, p: 0 }])
    const a6 = appendix.slice(appendix.indexOf('### A-6'), appendix.indexOf('### A-7'))
    expect(v.level).toBe('ok')
    expect(a6).toContain(`k ＝ ${f3(calc.fanRequiredPa)} / 100² ＝ ${v.k.toFixed(6)}`)
    expect(a6).toContain(`余裕 ${v.marginPa!.toFixed(1)} Pa`)
    expect(a6).toContain(`**Q ＝ ${v.operating!.q.toFixed(2)} m³/h、P ＝ ${v.operating!.p.toFixed(2)} Pa**`)
    expect(a6).toContain(`設定風量の ${(v.flowRatio! * 100).toFixed(0)}%`)
  })

  it('AI_GUIDE.md に書いた例題の数値も同じ', () => {
    const guide = readFileSync(join(fileURLToPath(new URL('..', import.meta.url)), 'AI_GUIDE.md'), 'utf8')
    const v = judgeMover(calc.fanRequiredPa, calc.fanFlowQh, null, [{ q: 0, p: 120 }, { q: 100, p: 60 }, { q: 150, p: 0 }])
    expect(guide).toContain(`必要静圧 ${f3(calc.fanRequiredPa)} Pa`)
    expect(guide).toContain(`運転点 ${v.operating!.q.toFixed(2)} m³/h`)
    expect(guide).toContain(`fanUpstreamPa ${f3(calc.fanUpstreamPa)} / fanDownstreamPa ${f3(calc.fanDownstreamPa)} / fanRequiredPa ${f3(calc.fanRequiredPa)}`)
  })

  it('A-7 ダンパ調整', () => {
    const after = balanceTerminals(sys, calc)
    const tb = after.nodes.TB.params
    const a7 = appendix.slice(appendix.indexOf('### A-7'))
    expect(tb.kind === 'terminal' && tb.zeta.toFixed(3)).toBe('5.035')
    expect(a7).toContain('**5.035**')
    const calc2 = dl.calcSystem(after, EXAMPLE_RHO)
    expect(a7).toContain(`吹出口 B のルート ＝ ${f3(calc2.routes.find(r => r.terminalId === 'TB')!.totalPa)} Pa`)
    expect(f3(calc2.fanRequiredPa)).toBe(f3(calc.fanRequiredPa))
  })
})
