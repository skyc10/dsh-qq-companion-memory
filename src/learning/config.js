/**
 * 学习引擎配置解析。
 *
 * 只消费 docs/IMPLEMENTATION.md 约定的全局默认与 roles 角色覆盖；本模块不读数据库配置。
 * 硬边界（不能被角色覆盖放宽）：
 * - 全局/局部每日额度、并发、日界线；
 * - S1–S6 的达标阈值（只能收紧）；
 * - 来源范围校验由 output/evidence 模块负责，与此处配置无关。
 */

import { clampInt, clampNumber, asString, isPlainObject } from './util.js';

/** 学习相关的全部缺省值（与契约一致）。 */
export const LEARNING_DEFAULTS = Object.freeze({
  features: Object.freeze({
    capture: false,
    recall: false,
    learning: false,
    trial: false,
    autoAdopt: false,
  }),
  learning: Object.freeze({
    privateThreshold: 20,
    groupThreshold: 60,
    minIntervalHours: 4,
    localDailyLimit: 12,
    globalDailyLimit: 60,
    batchSize: 80,
    concurrency: 1,
    pollIntervalSeconds: 60,
    requestTimeoutSeconds: 120,
    leaseMinutes: 10,
  }),
  evidence: Object.freeze({
    independentUnits: 4,
    distinctDays: 3,
    trialDays: 3,
    applications: 2,
    personalityIntervalDays: 3,
    conversationGapMinutes: 30,
  }),
  budget: Object.freeze({
    contextWindow: 0,
    maxOutputTokens: 0,
    maxInputTokens: 0,
    recallTokens: 0,
  }),
  models: Object.freeze({
    provider: '',
    model: '',
    followChat: true,
  }),
  roles: Object.freeze({}),
});

/** 实例级（全局）允许读取的键；角色覆盖另有白名单，二者不能混用。 */
const GLOBAL_KEYS = Object.freeze({
  learning: new Set([
    'privateThreshold',
    'groupThreshold',
    'minIntervalHours',
    'localDailyLimit',
    'globalDailyLimit',
    'batchSize',
    'concurrency',
    'pollIntervalSeconds',
    'requestTimeoutSeconds',
    'leaseMinutes',
  ]),
  evidence: new Set([
    'independentUnits',
    'distinctDays',
    'trialDays',
    'applications',
    'personalityIntervalDays',
    'conversationGapMinutes',
  ]),
  budget: new Set(['contextWindow', 'maxOutputTokens', 'maxInputTokens', 'recallTokens']),
  models: new Set(['provider', 'model', 'followChat']),
});

/**
 * 角色覆盖允许的键；其余键被忽略，避免通过角色配置放宽硬边界。
 * 特别地：localDailyLimit / globalDailyLimit / concurrency / recallTokens 不允许角色覆盖。
 */
const ROLE_OVERRIDE_KEYS = Object.freeze({
  learning: new Set([
    'privateThreshold',
    'groupThreshold',
    'minIntervalHours',
    'batchSize',
    'pollIntervalSeconds',
    'requestTimeoutSeconds',
  ]),
  evidence: new Set([
    'independentUnits',
    'distinctDays',
    'trialDays',
    'applications',
    'personalityIntervalDays',
    'conversationGapMinutes',
  ]),
  budget: new Set(['contextWindow', 'maxOutputTokens', 'maxInputTokens']),
  models: new Set(['provider', 'model', 'followChat']),
});

/** S1–S6 的硬下限（来自 PLAN，任何配置层级都不能低于）。 */
export const HARD_FLOOR = Object.freeze({
  evidence: Object.freeze({
    independentUnits: 4,
    distinctDays: 3,
    trialDays: 3,
    applications: 2,
    personalityIntervalDays: 3,
  }),
});

function pickNumber(source, key, fallback) {
  const value = source?.[key];
  if (value === undefined || value === null || value === '') return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function pickBool(source, key, fallback) {
  const value = source?.[key];
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function mergeGroup(base, override, allowed) {
  const out = { ...base };
  if (!isPlainObject(override)) return out;
  for (const key of allowed) {
    if (override[key] !== undefined) out[key] = override[key];
  }
  return out;
}

/**
 * 取值并按“硬下限 + 实例值”双重约束收紧。
 * 角色覆盖只能 ≥ 实例值（更严），实例值本身也 ≥ 硬下限。
 */
function clampRoleFloor(globalSource, roleSource, key, floor, max) {
  const globalValue = clampInt(pickNumber(globalSource, key, floor), floor, max, floor);
  const roleValue = pickNumber(roleSource, key, globalValue);
  if (!Number.isFinite(Number(roleValue))) return globalValue;
  return clampInt(roleValue, Math.max(floor, globalValue), max, globalValue);
}

function normalizeRoleAliases(roles, characterId) {
  if (!isPlainObject(roles) || !characterId) return null;
  if (isPlainObject(roles[characterId])) return roles[characterId];
  const lower = characterId.toLowerCase();
  for (const [key, value] of Object.entries(roles)) {
    if (!isPlainObject(value)) continue;
    if (key.toLowerCase() === lower) return value;
  }
  return null;
}

/**
 * 解析某角色的有效配置。
 *
 * 角色覆盖规则：
 * - 只能调整学习节奏（门槛、间隔、批次、超时、模型），不能提高每日上限；
 * - 不能放开全局上限、局部上限、并发与召回预算；
 * - S1–S6 的阈值只能收紧（≥4 单位 / ≥3 日期 / ≥3 天 / ≥2 次应用 / ≥3 天人格间隔），
 *   避免角色配置把产品硬门槛降成“零证据即可采纳”。
 */
export function resolveLearningConfig(config, characterId = '') {
  const raw = isPlainObject(config) ? config : {};
  const role = normalizeRoleAliases(raw.roles, characterId) ?? {};
  const roleFeatures = isPlainObject(role.features) ? role.features : {};

  const features = {
    capture: pickBool(raw.features, 'capture', LEARNING_DEFAULTS.features.capture),
    recall: pickBool(raw.features, 'recall', LEARNING_DEFAULTS.features.recall),
    // 角色可关闭学习/试用/采纳，但不能在全局关闭时自行打开。
    learning:
      pickBool(raw.features, 'learning', LEARNING_DEFAULTS.features.learning) &&
      pickBool(roleFeatures, 'learning', true),
    trial:
      pickBool(raw.features, 'trial', LEARNING_DEFAULTS.features.trial) &&
      pickBool(roleFeatures, 'trial', true),
    autoAdopt:
      pickBool(raw.features, 'autoAdopt', LEARNING_DEFAULTS.features.autoAdopt) &&
      pickBool(roleFeatures, 'autoAdopt', true),
  };

  const globalLearning = mergeGroup(LEARNING_DEFAULTS.learning, raw.learning, GLOBAL_KEYS.learning);
  const globalEvidence = mergeGroup(LEARNING_DEFAULTS.evidence, raw.evidence, GLOBAL_KEYS.evidence);
  const globalBudget = mergeGroup(LEARNING_DEFAULTS.budget, raw.budget, GLOBAL_KEYS.budget);
  const globalModels = mergeGroup(LEARNING_DEFAULTS.models, raw.models, GLOBAL_KEYS.models);

  const roleLearning = mergeGroup(globalLearning, role.learning, ROLE_OVERRIDE_KEYS.learning);
  const roleEvidence = mergeGroup(globalEvidence, role.evidence, ROLE_OVERRIDE_KEYS.evidence);
  const roleBudget = mergeGroup(globalBudget, role.budget, ROLE_OVERRIDE_KEYS.budget);
  const roleModels = mergeGroup(globalModels, role.models, ROLE_OVERRIDE_KEYS.models);

  // 全局与局部每日上限都只能来自实例配置，角色覆盖一律忽略。
  const globalDailyLimit = clampInt(
    pickNumber(globalLearning, 'globalDailyLimit', LEARNING_DEFAULTS.learning.globalDailyLimit),
    1,
    10000,
    LEARNING_DEFAULTS.learning.globalDailyLimit,
  );
  const configuredLocal = clampInt(
    pickNumber(globalLearning, 'localDailyLimit', LEARNING_DEFAULTS.learning.localDailyLimit),
    1,
    10000,
    LEARNING_DEFAULTS.learning.localDailyLimit,
  );
  // 局部上限不得超过全局上限，否则局部额度会变成绕过全局的通道。
  const localDailyLimit = Math.min(configuredLocal, globalDailyLimit);

  const learning = {
    privateThreshold: clampInt(
      pickNumber(roleLearning, 'privateThreshold', LEARNING_DEFAULTS.learning.privateThreshold),
      1,
      100000,
      LEARNING_DEFAULTS.learning.privateThreshold,
    ),
    groupThreshold: clampInt(
      pickNumber(roleLearning, 'groupThreshold', LEARNING_DEFAULTS.learning.groupThreshold),
      1,
      100000,
      LEARNING_DEFAULTS.learning.groupThreshold,
    ),
    minIntervalHours: clampNumber(
      pickNumber(roleLearning, 'minIntervalHours', LEARNING_DEFAULTS.learning.minIntervalHours),
      0,
      24 * 30,
      LEARNING_DEFAULTS.learning.minIntervalHours,
    ),
    localDailyLimit,
    globalDailyLimit,
    batchSize: clampInt(
      pickNumber(roleLearning, 'batchSize', LEARNING_DEFAULTS.learning.batchSize),
      1,
      80,
      LEARNING_DEFAULTS.learning.batchSize,
    ),
    concurrency: clampInt(
      pickNumber(globalLearning, 'concurrency', LEARNING_DEFAULTS.learning.concurrency),
      1,
      4,
      LEARNING_DEFAULTS.learning.concurrency,
    ),
    pollIntervalSeconds: clampInt(
      pickNumber(roleLearning, 'pollIntervalSeconds', LEARNING_DEFAULTS.learning.pollIntervalSeconds),
      5,
      3600,
      LEARNING_DEFAULTS.learning.pollIntervalSeconds,
    ),
    requestTimeoutSeconds: clampInt(
      pickNumber(roleLearning, 'requestTimeoutSeconds', LEARNING_DEFAULTS.learning.requestTimeoutSeconds),
      5,
      1800,
      LEARNING_DEFAULTS.learning.requestTimeoutSeconds,
    ),
    leaseMinutes: clampInt(
      pickNumber(globalLearning, 'leaseMinutes', LEARNING_DEFAULTS.learning.leaseMinutes),
      1,
      120,
      LEARNING_DEFAULTS.learning.leaseMinutes,
    ),
  };

  const evidence = {
    // S1–S6 是产品硬参数：实例可上调，角色只能在实例值之上收紧，不能低于 PLAN 的下限。
    independentUnits: clampRoleFloor(
      globalEvidence,
      roleEvidence,
      'independentUnits',
      HARD_FLOOR.evidence.independentUnits,
      100,
    ),
    distinctDays: clampRoleFloor(globalEvidence, roleEvidence, 'distinctDays', HARD_FLOOR.evidence.distinctDays, 100),
    trialDays: clampRoleFloor(globalEvidence, roleEvidence, 'trialDays', HARD_FLOOR.evidence.trialDays, 365),
    applications: clampRoleFloor(globalEvidence, roleEvidence, 'applications', HARD_FLOOR.evidence.applications, 100),
    personalityIntervalDays: clampRoleFloor(
      globalEvidence,
      roleEvidence,
      'personalityIntervalDays',
      HARD_FLOOR.evidence.personalityIntervalDays,
      365,
    ),
    // 连续交流间隔不是达标门槛，允许在合理区间内调整（越长越保守）。
    conversationGapMinutes: clampInt(
      pickNumber(roleEvidence, 'conversationGapMinutes', LEARNING_DEFAULTS.evidence.conversationGapMinutes),
      1,
      24 * 60,
      LEARNING_DEFAULTS.evidence.conversationGapMinutes,
    ),
  };

  const budget = {
    contextWindow: clampInt(pickNumber(roleBudget, 'contextWindow', 0), 0, 10_000_000, 0),
    maxOutputTokens: clampInt(pickNumber(roleBudget, 'maxOutputTokens', 0), 0, 200_000, 0),
    maxInputTokens: clampInt(pickNumber(roleBudget, 'maxInputTokens', 0), 0, 10_000_000, 0),
    recallTokens: clampInt(pickNumber(globalBudget, 'recallTokens', 0), 0, 10_000_000, 0),
  };

  const models = {
    provider: asString(roleModels.provider),
    model: asString(roleModels.model),
    followChat: pickBool(roleModels, 'followChat', true),
  };

  return { features, learning, evidence, budget, models };
}
