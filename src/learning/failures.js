/**
 * 学习失败分类：决定是否自动重试、是否暂停、是否占用额度。
 *
 * 口径（PLAN T 系列 / ARCHITECTURE）：
 * - 认证与配置错误：暂停自动重试并留痕，等待人工处理；
 * - 额度耗尽：不视为失败，等到下一个上海日界线；
 * - 截断/结构不完整/超时/来源非法：可重试，材料与游标保留；
 * - 存储类未知异常：保守按可重试处理，但用退避避免抖动。
 */

import { errorSummary } from './util.js';

/** 认证/配置类错误：暂停自动重试，等待人工处理。 */
const PAUSE_ON = new Set([
  'AUTH_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'INVALID_API_KEY',
  'MODEL_NOT_FOUND',
  'PROVIDER_NOT_FOUND',
  'CONFIG_ERROR',
  'LEARNING_CONFIG_INVALID',
  // 宿主侧前置条件：需人工完成接管确认或填写模型容量，重试不会自愈。
  'TAKEOVER_REQUIRED',
  'MODEL_REQUIRED',
  'CAPACITY_REQUIRED',
  'INPUT_BUDGET_EXCEEDED',
]);

/** 材料/调用前提错误：重试也不会成功，需要人工或数据修复。 */
const FATAL = new Set([
  'LEARNING_NO_MATERIALS',
  'LEARNING_INVALID_SCOPE',
  'LEARNING_TASK_MISSING',
  'LEARNING_MODEL_MISSING',
  'LEARNING_STORE_REQUIRED',
]);

/**
 * @returns {{code: string, message: string, retryable: boolean, pauseAutoRetry: boolean, quotaRelated: boolean, fatal: boolean}}
 */
export function classifyLearningFailure(error) {
  const summary = errorSummary(error);
  const code = summary.code.toUpperCase();
  const quotaRelated = code === 'LEARNING_QUOTA_EXHAUSTED';
  const pauseAutoRetry = PAUSE_ON.has(code);
  const fatal = FATAL.has(code);
  return {
    code: summary.code,
    message: summary.message,
    // 未识别的错误保守按可重试处理（有退避），但不属于暂停类。
    retryable: !pauseAutoRetry && !quotaRelated && !fatal,
    pauseAutoRetry,
    quotaRelated,
    fatal,
  };
}

export { PAUSE_ON as PAUSE_ON_AUTH_CONFIG, FATAL as FATAL_LEARNING_CODES };
