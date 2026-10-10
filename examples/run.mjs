// 検算例を計算本体で計算し、手計算（各例の expected.json）と突き合わせて表にする。
//
//   npm run build            # dist/ を作る
//   node examples/run.mjs    # 突き合わせ（差が許容差を超えると終了コード 1）
//
// expected.json は各例の handcalc.py（Python 3 の標準ライブラリだけ・計算本体を使わない）が書き出す:
//   python3 examples/01-single-fan/handcalc.py
//
// 許容差: 同じ式を倍精度で計算しているので、差は計算の順番による丸めだけ（1e-12 程度）。
// 運転点は解き方が違う（本体は解析解、手計算は二分法）が、どちらも 1e-9 より細かく詰める。
// 余裕を見て 1e-6（Pa・m³/h・m/s）を許容差とする。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createDuctLoss, collectMovers, balanceTerminals } from '../dist/index.js'

const TOL = 1e-6
const here = p => fileURLToPath(new URL(p, import.meta.url))
const load = p => JSON.parse(readFileSync(here(p), 'utf8'))

let worst = 0
const rows = []
const check = (example, item, hand, engine) => {
  const diff = Math.abs(hand - engine)
  worst = Math.max(worst, diff)
  rows.push({ example, item, hand, engine, diff, ok: diff <= TOL })
}

function memberRows(name, exp, calc) {
  for (const [id, m] of Object.entries(exp.members)) {
    const r = calc.byNode[id]
    check(name, `${id} 風量 Q`, m.Q, r.flowQh)
    check(name, `${id} 風速 v`, m.v, r.velocity)
    check(name, `${id} 動圧 q`, m.q, r.q)
    check(name, `${id} 圧損 ΔP`, m.dP, r.lossPa)
  }
  for (const [leaf, pa] of Object.entries(exp.routes)) {
    const route = calc.routes.find(rt => rt.terminalId === leaf)
    check(name, `ルート ${leaf}`, pa, route ? route.totalPa : NaN)
  }
}

// ── 例 1 ──
{
  const name = '01'
  const inp = load('./01-single-fan/input.json')
  const exp = load('./01-single-fan/expected.json')
  const dl = createDuctLoss(inp.coefficients)
  const sys = inp.payload.systems[0]
  const calc = dl.calcSystem(sys, inp.payload.rho)
  memberRows(name, exp, calc)
  check(name, '上流側', exp.fan.upstreamPa, calc.fanUpstreamPa)
  check(name, '下流側', exp.fan.downstreamPa, calc.fanDownstreamPa)
  check(name, '必要静圧', exp.fan.requiredPa, calc.fanRequiredPa)
  const mover = collectMovers(inp.payload.systems, { [sys.id]: calc })[0]
  check(name, '出せる静圧（設定風量）', exp.fan.availableAtDesignPa, mover.verdict.availableStaticPa)
  check(name, '運転点 Q', exp.fan.operatingPoints[0].q, mover.verdict.operating.q)
  check(name, '運転点 P', exp.fan.operatingPoints[0].p, mover.verdict.operating.p)
  rows.push({ example: name, item: `判定 ${exp.fan.level} / ${mover.verdict.level}`, ok: exp.fan.level === mover.verdict.level })
  const balanced = balanceTerminals(sys, calc)
  check(name, `ダンパ調整後の ${exp.balance.adjusted} の ζ`, exp.balance.zetaNew, balanced.nodes[exp.balance.adjusted].params.zeta)
}

// ── 例 2 ──
{
  const name = '02'
  const inp = load('./02-hex-aircon/input.json')
  const exp = load('./02-hex-aircon/expected.json')
  const dl = createDuctLoss(inp.coefficients)
  const sys = inp.payload.systems[0]
  const calc = dl.calcSystem(sys, inp.payload.rho)
  memberRows(name, exp, calc)
  const ac = calc.secondaryMovers[0]
  check(name, '循環風量', exp.flows.circulation, ac.circulationQh)
  check(name, '追加吸込', exp.flows.return, ac.intakeQh)
  check(name, '熱交からの供給', exp.flows.supplyFromHex, ac.supplyFromHexQh)
  check(name, '熱交 上流側', exp.hex.upstreamPa, calc.fanUpstreamPa)
  check(name, '熱交 下流側', exp.hex.downstreamPa, calc.fanDownstreamPa)
  check(name, '熱交 必要静圧', exp.hex.requiredPa, calc.fanRequiredPa)
  check(name, 'エアコン 供給側', exp.aircon.supplyPa, ac.supplyCriticalPa)
  check(name, 'エアコン 吸込側', exp.aircon.intakePa, ac.intakeCriticalPa)
  check(name, 'エアコン 必要静圧', exp.aircon.requiredPa, ac.requiredPa)
  const movers = collectMovers(inp.payload.systems, { [sys.id]: calc })
  const hexRow = movers.find(m => m.nodeId === null)
  const acRow = movers.find(m => m.nodeId === 'ac')
  rows.push({ example: name, item: `熱交の判定 ${exp.hex.level} / ${hexRow.verdict.level}`, ok: exp.hex.level === hexRow.verdict.level })
  check(name, 'エアコン 出せる静圧', exp.aircon.availableAtDesignPa, acRow.verdict.availableStaticPa)
  check(name, 'エアコン 運転点 Q', exp.aircon.operatingPoints[0].q, acRow.verdict.operating.q)
  rows.push({ example: name, item: `エアコンの判定 ${exp.aircon.level} / ${acRow.verdict.level}`, ok: exp.aircon.level === acRow.verdict.level })
}

// ── 例 3（粗さから求める λ・曲がりの ζ・気温 30℃）──
{
  const name = '03'
  const inp = load('./03-roughness-bend-zeta/input.json')
  const exp = load('./03-roughness-bend-zeta/expected.json')
  const dl = createDuctLoss(inp.coefficients)
  const sys = inp.payload.systems[0]
  const calc = dl.calcSystem(sys, inp.payload.rho, 1, { tempC: inp.tempC })
  for (const [id, m] of Object.entries(exp.members)) {
    const r = calc.byNode[id]
    check(name, `${id} 動圧 q`, m.q, r.q)
    check(name, `${id} 圧損 ΔP`, m.dP, r.lossPa)
    if (m.lambda != null) {
      check(name, `${id} レイノルズ数`, m.Re, r.duct.reynolds)
      check(name, `${id} λ（粗さから）`, m.lambda, r.duct.lambda)
      check(name, `${id} 曲がりの ζ`, m.bendZeta, r.duct.bendZeta)
    }
  }
  for (const [leaf, pa] of Object.entries(exp.routes)) check(name, `ルート ${leaf}`, pa, calc.routes.find(rt => rt.terminalId === leaf).totalPa)
  check(name, '必要静圧', exp.fan.requiredPa, calc.fanRequiredPa)
  const v = collectMovers(inp.payload.systems, { [sys.id]: calc })[0].verdict
  check(name, '出せる静圧（ρ/1.20 倍）', exp.fan.availableAtDesignPa, v.availableStaticPa)
  check(name, '運転点 Q', exp.fan.operatingPoints[0].q, v.operating.q)
}

const f = v => (typeof v === 'number' ? v.toFixed(6) : '')
console.log('例  項目                              手計算          本体            差')
for (const r of rows) {
  console.log(`${r.example}  ${r.item.padEnd(30)} ${f(r.hand).padStart(14)} ${f(r.engine).padStart(14)} ${r.diff != null ? r.diff.toExponential(1).padStart(9) : ''} ${r.ok ? 'OK' : '★違う'}`)
}
const bad = rows.filter(r => !r.ok)
console.log(`\n${rows.length} 項目・最大の差 ${worst.toExponential(2)}（許容差 ${TOL}）→ ${bad.length === 0 ? 'すべて一致' : `${bad.length} 項目が違う`}`)
process.exit(bad.length === 0 ? 0 : 1)
