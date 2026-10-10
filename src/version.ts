/**
 * この部品の版。package.json の version と同じ値にする（__tests__/traceability.test.ts が照合）。
 * 計算結果（CalcResult.meta）と保存データの記録（DuctLossPayload.coefficientsStamp）に入り、
 * どの版の計算で出した数字かを後から追えるようにする。計算結果が変わる変更をしたら版を上げ、
 * CHANGELOG.md に「何が・なぜ変わるか」を書く。
 */
export const ENGINE_VERSION = '0.2.0'
