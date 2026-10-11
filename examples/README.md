# 検算例

計算本体の結果を、計算本体を使わない手計算と突き合わせるための例です。方法と結果は [VALIDATION.md](../VALIDATION.md)。
**係数は検算のために作った架空の値です。設計には使わないでください。**

| フォルダ | 系統 |
|---|---|
| `01-single-fan` | 送風機 1 台＋外気側のフィルター・フード＋主管＋分岐＋2 枝（片方にレジューサ）。P-Q 特性 4 点、ダンパ調整 |
| `02-hex-aircon` | 熱交換器＋ダクト形エアコン（第 2 の送風機）。混合点の質量保存、送風機ごとの必要静圧 |
| `03-roughness-bend-zeta` | 粗さから求める λ（Colebrook）と曲がりの ζ（形・角度の補正・器材の ζ）。気温 30℃ |
| `04-bend-zeta-by-diameter` | 曲がりの ζ を径ごとに持つ形（一番近い径）・形ごとの角度の比例・器材の ζ。手計算は本体のコードを見ずに仕様書から書いた |

各フォルダの中身:

- `input.json` — 係数（`coefficients`）と保存データ（`payload`、schema v4）。アプリで開ける形
- `handcalc.py` — 手計算（Python 3 の標準ライブラリだけ）。部材の風量・径・ルートを手で書き、式を書き下す。`expected.json` を書き出す
- `expected.json` — 手計算の結果

```bash
npm run build && node examples/run.mjs     # 突き合わせ
python3 examples/01-single-fan/handcalc.py # 手計算を回し直す
python3 examples/same_numbers.py 保存した.json 回し直した.json  # 2 つの期待値を比べる（数は相対 1e-12 まで）
```
