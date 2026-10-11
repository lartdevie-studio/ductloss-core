# @monosashi/ductloss-core

住宅の換気・ダクト空調の**設計風量**に対し、必要静圧・送風機の能力・調整に要る抵抗を、**根拠を追える形で**計算する TypeScript の部品です。
画面は持たず、計算だけをします。ブラウザでもサーバーでも動き、ほかの部品に依存しません。

**計算の仕様は [SPEC.md](./SPEC.md) にすべて書いてあります**（付録 A に、電卓で追える手計算の例題）。
**画面（アプリ）は同梱していません。** アプリが必要な方は、[AI_GUIDE.md](./AI_GUIDE.md) を AI（Claude Code など）に読ませて、ご自身で作ってください。
利用条件は MIT です（[LICENSE](./LICENSE)）。公開先: https://github.com/lartdevie-studio/ductloss-core

## できること

- 部材ごとの圧損（円形ダクト: ダルシー・ワイスバッハ／分岐・レジューサ・端末など: ζ·q）
  - 摩擦係数 λ は一定値、または材料の粗さとレイノルズ数から Colebrook の式で求める（係数の `friction`）
  - 曲がりは相当長、または λ によらない ζ ＋ 角度の補正（係数の `bend`。形ごとの ζ・器材の ζ）
- 風量の集計（端末の目標風量から足し上げ、吸込側へ配分。ダクト形エアコンを第 2 の送風機として、熱交換器からの供給と室内の循環を分ける）
- 送風機 1 台ごとの必要静圧（上流側 ＋ 下流側）と、機器の特性（機外静圧・P-Q 特性）による合否の推定。前提が成り立たないときは理由つきで「判定しない」を返す
- ダンパ調整（各ルートを設計風量で流すのに端末で足す抵抗）、必要換気量との照合、作図の点検
- 計算書の計算条件（係数の名前・出典・値の識別・計算の版）と、部材ごとの「式 → 代入 → 結果」の解説
- 機能の一覧と入／切（画面の出し分けに使う。計算は変わらない）

## 前提（設計計算です）

- 部材の風量は、端末の目標風量と配分の決まりから決まる**設計風量**です。各枝の抵抗から実際の風量配分を解くものではありません
- 吸込側の風量は、端末の目標風量の**比で配る**設計上の配分です
- 運転点は、設計点を通る `ΔP = k·Q²` と機器の特性の交点としての**推定**です。風量の配分と抵抗が設計どおりに保たれる前提です
- 熱交換器とエアコンは、**受け持つ区間ごと**に評価します。送風機どうしの圧力・風量の相互作用は解きません
- 設計係数（摩擦係数 λ・曲がりの相当長・部材の既定 ζ）は**同梱していません**。使う人が根拠の資料から値を入れ、出典を書きます

## できないこと

- 実際の風量・施工後の運転の予測（施工後に風量を測って調整してください。この部品は測定値を扱いません）
- ループのある網・節点の圧力を同時に解く計算、複数の送風機の連成
- ダンパの開度（必要な抵抗 ζ までを出します。開度との対応は製品ごとに違います）
- 矩形ダクト、流量比による分岐の損失（分岐は 1 つの ζ）、縮めて施工したフレキの割り増し、騒音・熱損失
- 係数の根拠の確かさを確かめること（識別や出典の文字があることは、根拠が確かであることを示しません）

## 検証の状況

- **自動テスト**（`npm test`）・型チェック・ビルドを、公開先の GitHub Actions で確かめています。これは**実装が仕様どおりか**の確かめで、実際の設備と一致することの証明ではありません
- **手計算との照合**: SPEC.md 付録 A の例題、検算例 4 つ（送風機 1 台＋外気側のフィルター・フード＋2 枝／熱交換器＋エアコン／粗さからの λ と曲がりの ζ／径ごとの曲がりの ζ。`examples/`・Python の手計算と 195 項目が一致）、
  レジューサの吹出・吸込 × 縮小・拡大の 4 通り、送風機の判定の境目（範囲の外・鞍部・接する点・定格 1 点）を、本体の関数を使わずに求めた値と照合しています。方法と結果は [VALIDATION.md](./VALIDATION.md)
- **ほかのソフトとの比較**: まだです（比べるのに要る資料の一覧は VALIDATION.md §7）
- 計算結果は `calc.meta` に計算の版と係数の識別を持ち、保存データには作ったときの係数の記録（`coefficientsStamp`）が付きます

## 最小の実行例

```ts
import { createDuctLoss } from '@monosashi/ductloss-core'

const dl = createDuctLoss({
  name: '例（設計には使えない値）', source: '書き方の例',
  lambda: 0.04, bendEquivLength90M: { 100: 0.3, 150: 0.45 },
  zeta: { branch: 1.0, reducer: 0.25, terminal: 1.2, filter: 4.0, aircon: 0.5 },
  terminalPa: 6, filterPa: 25,
})
const payload = dl.makeInitialPayload()
const sys = payload.systems[0]
let { nodes, nodeId } = dl.addChild(sys.nodes, sys.rootId, 'duct')
;({ nodes } = dl.addChild(nodes, nodeId, 'terminal'))
sys.nodes = nodes
const calc = dl.calcSystem(sys, payload.rho)
console.log(calc.fanFlowQh, calc.fanRequiredPa, calc.meta)
```

## 似た公開コード（2026-10-10 時点の調べ）

ひとつずつの計算は珍しくありません。目的や範囲が違うので、用途に合うものを選んでください（「無い」と書いていない機能は、確かめていないだけのことがあります）。

- [python-hvac](https://github.com/TomLXXVI/python-hvac)（Python・MIT）: ループのある網も解く。最も不利な経路と設計時のダンパ調整
- [fluids](https://github.com/CalebBell/fluids)（Python・MIT）: 摩擦係数（Colebrook など）や継手の損失の式が豊富
- [pyduct](https://github.com/TunaLobster/pyduct)（Python・MIT）: 木の形と端末からの風量の積み上げ。等摩擦法での径の選定
- [openmep](https://github.com/samarmstrong/openmep)（TypeScript・MIT）: 依存なし。等摩擦法での径の選定が目的
- 建築研究所『エネルギー消費性能の算定方法（住宅）』第五章 付録B: 最大圧力損失経路の合計を送風機の特性と比べる手順（文書。コードではない）

この部品の特徴は、住宅の換気・ダクト空調向けに、ダクト形エアコンを第 2 の送風機として扱うこと、送風機ごとの必要静圧と前提つきの判定、係数を同梱せず出典と識別を計算書に残すこと、Web に組み込める依存なしの TypeScript であることです。

> **English summary**: A dependency-free TypeScript engine that computes, for the **design airflows** of residential
> ventilation and ducted air-conditioning, the required static pressure per fan, a fan-capacity verdict and the
> balancing resistance, in a form whose basis can be traced. Ducts use Darcy–Weisbach; fittings use ζ·q. Member flows are design flows aggregated from terminal targets (the intake
> side is split by target ratio) — the engine does **not** solve the actual flow distribution, does not couple
> multiple fans (a heat-recovery unit and a ducted air-conditioner are evaluated per owned section), and its
> operating point is an estimate from ΔP = k·Q² through the design point. Damper balancing returns the additional ζ
> required at the terminal, not a damper position. Design coefficients (λ, bend equivalent lengths, default ζ) are
> **not bundled**: you supply them with their source; results carry the engine version and a coefficient fingerprint.
> Friction can be a constant λ or computed from material roughness via Colebrook; bends can be equivalent lengths or
> λ-independent ζ with an angle factor. Verified by automated tests and independent hand calculations against the
> specification (SPEC.md, Japanese, Appendix A; VALIDATION.md); not validated against measurements or other software yet. No UI is included — AI_GUIDE.md tells an
> AI coding assistant how to build one. MIT licensed. An English summary of the specification is in [SPEC.en.md](./SPEC.en.md)
> (the Japanese SPEC.md is authoritative).

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
calc.byNode[duct]     // 部材ごとの風量・風速・動圧・圧損（直管は使った λ と出どころも .duct に）
calc.meta             // 計算の版・係数の名前と識別・ρ・風量の倍率
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
// rows[1] = { label: '計算の版', value: 'ductloss-core 0.3.0', note: '係数の識別 cf1-…' }
// 保存したときと違う係数で計算すると「保存時の設計係数」の行が出る
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
