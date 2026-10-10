/**
 * @monosashi/ductloss-core — ダクトの圧損計算（式・風量の集計・送風機の判定・点検）
 *
 * 計算の仕様は SPEC.md、使い方は README.md、AI に開発させるときの手引きは AI_GUIDE.md。
 * 設計係数（λ・曲がりの相当長・既定 ζ）は同梱しない。`createDuctLoss(係数)` に渡す。
 *
 * 公開するものはここに名前で書く（export * にしない）。係数を直接受け取る下請けの関数
 * （calcSystem(coef, …) など）は公開しない。係数の確かめ（validateCoefficients）を
 * すり抜けられないよう、係数を使う計算は必ず createDuctLoss の一式を通す。
 *
 * SPDX-License-Identifier: MIT
 */

// 計算一式（係数を結び付ける入口）
export { createDuctLoss, type DuctLossEngine } from './engine'
export {
  validateCoefficients, coefficientFingerprint, bendAngleFactor, bendZeta,
  type DesignCoefficients, type FrictionModel, type BendModel, type DuctMaterial, type BendShape,
} from './coefficients'
export { ENGINE_VERSION } from './version'

// データの形
export * from './types'
export {
  DEFAULT_SYSTEM_NAME, migrateLegacySystemType, schemaVersionOf, isValidPayloadV4, tryUpgradePayload,
} from './payload'
export { NODE_KIND_LABEL, routeEndLabel, coefficientsStampOf } from './factory'

// 空気
export { RHO_DEFAULT, CHARACTERISTIC_RHO, airDensity, airKinematicViscosity, colebrookLambda } from './physics'

// 木の操作・走査・径の読み取り（部材を足す操作は createDuctLoss の addChild / insertOnEdge）
export {
  deleteSubtree, updateNode, moveNode, listLeafIds, pathFromRoot, postOrder, findAncestorFan,
  resolveConnectedDiameter, resolveReducerDiameters, usesAutoDiameter, effectiveDiameterMm, effectiveReducerFromMm,
  structureIssues, nodeFlowSide, reducerDiameters, reducerZetaForBasis, REDUCER_ZETA_BASIS_LABELS, type ResolvedDiameter, type StructureIssue, type ReducerDiameters,
} from './tree'

// 係数に依らない計算
export {
  dynamicPressure, calcVelocity, frictionPerMeter, ductBends, aggregateFlows,
  balanceTerminals, canBalanceTerminals, undoBalanceTerminals, canUndoBalanceTerminals, routeOwner, fanUpstreamBalance,
  type RouteOwner, type UpstreamBalance, type CalcEnv,
} from './calculator'
export {
  fitResistanceK, resistanceP, sampleResistance, normalizeFanPoints, interpFanP, sampleFan,
  findOperatingPoint, findOperatingPoints, resistanceAtFlow, type PQPoint,
} from './pqcurve'
export {
  systemResistanceK, judgeMover, VERDICT_PREMISE, type VerdictLevel, type VerdictBasis, type MoverVerdict,
} from './verdict'
export {
  ACH_DEFAULT, makeDefaultVentilation, resolveVolumeM3, requiredVentilationQh, isCirculationSystem,
  designSupplyQh, checkVentilation, type VentilationInput, type VentilationCheck,
} from './ventilation'
export { defaultPathLabel, collectMovers, type MoverRow } from './movers'
export { diagnose, countByLevel, type IssueLevel, type Issue } from './diagnostics'

// 表示・計算書の下ごしらえ（計算条件の表・解説は createDuctLoss の一式から）
export type { ExplainStep, CurvePoint, NodeExplanation, SystemContext } from './explain'
export {
  resolveNodeSide, summarizeTerminalZeta, totalTerminalCount, splitNoteLines, hasReportNotes, formatCoefficient,
  type TerminalZetaRow, type CalcConditionRow,
} from './report'
export { autoLayout, getBounds } from './layout'

// 機能の入／切
export {
  defineFeatureSet, DUCTLOSS_FEATURES, DUCTLOSS_FEATURE_KEYS, ALL_FEATURES_ON, resolveFeatures, featuresInUseButOff,
  type FeatureDef, type FeatureFlags, type FeatureSet, type DuctLossFeatureKey, type DuctLossFeatures,
} from './features'
