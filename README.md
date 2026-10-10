# @monosashi/ductloss-core

住宅の換気・ダクト空調の**圧損計算**の部品です。画面は持たず、計算だけをします。
ブラウザでもサーバーでも動く TypeScript で、ほかの部品に依存しません。

- 部材ごとの圧損（ダクト: ダルシー・ワイスバッハ ＋ 曲がりの相当長／局部: ζ·q）
- 風量の集計（端末の目標風量から足し上げ、吸込側へ質量保存で配分、ダクト形エアコンを第 2 の送風機として扱う）
- 送風機 1 台ごとの必要静圧（上流側 ＋ 下流側）と、P-Q 特性の運転点による合否判定
- 必要換気量との照合、点検（描きかけ・孤立した経路・風量の不釣り合いなど）、ダンパ調整
- 機能の一覧と入／切（画面の出し分けに使う。計算は変わらない）

**計算の仕様は [SPEC.md](./SPEC.md) にすべて書いてあります。** 式・決まり事・判定の条件を確かめたいときはそちらを読んでください。
付録 A に、電卓で追える手計算の例題があります。

**画面（アプリ）は同梱していません。** アプリが必要な方は、[AI_GUIDE.md](./AI_GUIDE.md) を AI（Claude Code など）に読ませて、ご自身で作ってください。

利用条件は MIT です（[LICENSE](./LICENSE)）。

> English summary: A dependency-free TypeScript engine for residential ventilation duct pressure-loss
> calculation (Darcy–Weisbach for ducts, ζ·q for fittings), flow aggregation with mass conservation,
> per-fan required static pressure, fan P-Q operating-point verdicts, diagnostics and feature toggles.
> Design coefficients (λ, bend equivalent lengths, default ζ) are **not bundled**; you supply them with their source.
> The specification is in SPEC.md (Japanese), with a hand-calculation example in Appendix A.
> No app/UI is included — AI_GUIDE.md tells an AI coding assistant how to build one on top of this engine. MIT licensed.

---

## 使い方

### 1. 設計係数を用意する

λ・曲がりの相当長・部材の既定 ζ は、資料や製品によって違うので**この部品には入っていません**。
使う人が、自分の根拠（社内基準・設計資料・メーカーの技術資料）から値を入れ、出典を書きます。

```ts
import { createDuctLoss, type DesignCoefficients } from '@monosashi/ductloss-core'

const coefficients: DesignCoefficients = {
  name: '自社標準 2026',
  source: '（あなたの根拠の資料名・版・ページ）',
  lambda: 0.04,
  bendEquivLength90M: { 75: 0.2, 100: 0.3, 150: 0.45, 200: 0.6 },   // 径(mm) → 90° 1 個の相当長(m)
  zeta: { branch: 1.0, reducer: 0.25, terminal: 1.2, filter: 4.0, aircon: 0.5 },
  terminalPa: 6,
  filterPa: 25,
}

const dl = createDuctLoss(coefficients)   // 使えない係数ならここで例外
```

> 上の数値は書き方の例です。**設計に使える値ではありません。**

### 2. 系統をつくって計算する

```ts
const payload = dl.makeInitialPayload()          // SA 系統 1 つ（送風機だけ）
const sys = payload.systems[0]

let { nodes, nodeId: duct } = dl.addChild(sys.nodes, sys.rootId, 'duct')
;({ nodes } = dl.addChild(nodes, duct, 'terminal'))
sys.nodes = nodes

const calc = dl.calcSystem(sys, payload.rho)
calc.fanFlowQh        // 送風機の風量 (m³/h)
calc.fanRequiredPa    // 必要静圧 (Pa) = fanUpstreamPa + fanDownstreamPa
calc.routes           // ルートごとの圧損
calc.byNode[duct]     // 部材ごとの風量・風速・動圧・圧損
```

### 3. 送風機の判定・点検

```ts
import { collectMovers, diagnose } from '@monosashi/ductloss-core'

const calcBySystem = { [sys.id]: calc }
const movers = collectMovers(payload.systems, calcBySystem)   // 送風機ごとの必要静圧と合否
const issues = diagnose(payload, calcBySystem)                // 点検の結果
```

### 4. 計算書の計算条件（係数の名前と出典が先頭）

```ts
const rows = dl.collectCalcConditions(payload)
// rows[0] = { label: '設計係数', value: '自社標準 2026', note: '出典: …' }
```

### 5. 機能の入／切

```ts
import { resolveFeatures, featuresInUseButOff, defineFeatureSet, DUCTLOSS_FEATURES } from '@monosashi/ductloss-core'

const features = resolveFeatures({ aircon: false })
if (features.fanCurve) { /* P-Q 特性の入力欄を出す */ }

// 切った機能をデータが使っていれば知らせる（計算には入っている）
for (const f of featuresInUseButOff(payload, features)) {
  console.warn(`${f.label} は切られていますが、計算には入っています`)
}

// 画面にだけある機能を足すとき
const appFeatures = defineFeatureSet([
  ...DUCTLOSS_FEATURES,
  { key: 'pdf', label: '計算書（PDF）', description: '…', dependsOn: ['calcConditions'] },
])
```

## 組み立てと試験

```bash
npm install
npm run build      # dist/index.js（ESM）と dist/types/*.d.ts
npm run typecheck
npm test
```

動く環境は Node.js 20 以降と今のブラウザ（ES2022）です。依存する部品はありません。

## 約束

- `src/` は**単独で動く純粋な TypeScript** だけ。相対 import だけで src の外を読まない（`__tests__/boundary.test.ts` が見張る）
- 公開する関数は `src/index.ts` に名前で書く。係数を使う計算は `createDuctLoss` の一式からだけ呼べるようにする
- 外部の資料・製品の数値を持ち込まない。係数は使う側が渡す（同上）
- 式・決まり事を変えたら SPEC.md と `__tests__/` を一緒に直す
- 保存形式（schema v4）を変えるときは `tryUpgradePayload` で古い形を引き上げられるようにする

## 由来と連絡先

L'art de vie studio の設計ポータル Monosashi にあるダクト圧損アプリの、計算部分を切り出して公開したものです（アプリは配布していません）。
お試し版と案内: https://next.lartdevie.info/tools/duct-loss

計算の誤りは課題（Issue）の「計算が仕様書と違う」から知らせてください（CONTRIBUTING.md）。
