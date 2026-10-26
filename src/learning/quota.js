/**
 * 学习请求额度：按上海日界线记账、事务内预留、失败重试继续计数。
 *
 * 口径（PLAN T4/T5 + “请求口径”）：
 * - 提炼、复核、重试都算 1 次请求，不论成功、失败或结果不确定；
 * - 额度不足时不调用模型，材料与游标保留，等待恢复；
 * - 预留记录先落库再发请求，避免并发绕过上限。
 */

import { DomainError } from '../domain/core.js';
import { KIND, dayKey, hashText, toISO } from './util.js';

export const USAGE_STATE = Object.freeze({
  reserved: 'reserved',
  sent: 'sent',
  done: 'done',
  failed: 'failed',
  unknown: 'unknown',
});

/** usage 记录 ID 带上海日期前缀，便于按天只扫描当天记录（避免全表扫描）。 */
function usagePrefix(day) {
  return `usage_${String(day).replace(/-/gu, '')}_`;
}

/**
 * 读取某天全部 usage 记录。
 *
 * 主路径：本引擎创建的 usage 记录 ID 以 `usage_YYYYMMDD_` 开头，按 ID 翻页扫到前缀之外即停止，
 * 成本与当天请求数成正比。
 * 防御路径：若当天前缀下一条都没有，再做一次单页扫描，容纳外部写入的 usage 记录
 * （它们必须带 data.dayKey 或可解析的 data.day，否则无法归属日期，不会计入额度）。
 */
function usageRowsForDay(store, day) {
  const prefix = usagePrefix(day);
  const rows = [];
  let after = prefix.slice(0, -1);
  for (let page = 0; page < 50; page += 1) {
    const batch = store.list(KIND.usage, { status: 'active', after, limit: 1000 });
    if (!Array.isArray(batch) || batch.length === 0) break;
    let stopped = false;
    for (const row of batch) {
      if (!String(row.id).startsWith(prefix)) {
        stopped = true;
        break;
      }
      const markedDay = row.data?.dayKey ?? (row.data?.day ? dayKey(row.data.day) : '');
      if (markedDay === day) rows.push(row);
    }
    if (stopped || batch.length < 1000) break;
    after = batch[batch.length - 1].id;
  }
  if (rows.length === 0) {
    for (const row of store.list(KIND.usage, { status: 'active', limit: 1000 })) {
      if (String(row.id).startsWith(prefix)) continue;
      const markedDay = row.data?.dayKey ?? (row.data?.day ? dayKey(row.data.day) : '');
      if (markedDay === day) rows.push(row);
    }
  }
  return rows;
}

/**
 * 统计当天额度占用。
 * @returns {{day: string, global: number, local: number, globalLimit: number, localLimit: number,
 *            globalRemaining: number, localRemaining: number}}
 */
export function readQuota(store, config, { characterId, scopeKey, at }) {
  const day = dayKey(at);
  const rows = usageRowsForDay(store, day);
  let global = 0;
  let local = 0;
  for (const row of rows) {
    global += 1;
    if (row.characterId === characterId && row.scopeKey === scopeKey) local += 1;
  }
  const globalLimit = Math.max(1, Number(config.learning.globalDailyLimit) || 60);
  const localLimit = Math.min(Math.max(1, Number(config.learning.localDailyLimit) || 12), globalLimit);
  return {
    day,
    global,
    local,
    globalLimit,
    localLimit,
    globalRemaining: Math.max(0, globalLimit - global),
    localRemaining: Math.max(0, localLimit - local),
  };
}

/**
 * 在调用方提供的同步事务中预留一次模型请求额度。
 *
 * 必须由调用方在 store.tx 内调用；本函数自身不开启事务，也不 await。
 * 超限抛 DomainError('LEARNING_QUOTA_EXHAUSTED')，调用方事务应整体回滚。
 */
export function reserveQuota(store, config, { characterId, scopeKey, at, taskId, purpose, provider, model, attempt }) {
  const quota = readQuota(store, config, { characterId, scopeKey, at });
  if (quota.globalRemaining <= 0 || quota.localRemaining <= 0) {
    const which = quota.localRemaining <= 0 ? 'local' : 'global';
    throw new DomainError(
      'LEARNING_QUOTA_EXHAUSTED',
      which === 'local' ? '本范围今日学习额度已用尽' : '今日全局学习额度已用尽',
      429,
      {
        scope: which,
        day: quota.day,
        global: quota.global,
        globalLimit: quota.globalLimit,
        local: quota.local,
        localLimit: quota.localLimit,
      },
    );
  }
  const usageId = `${usagePrefix(quota.day)}${hashText(`${characterId}|${scopeKey}|${at}|${attempt}|${taskId ?? ''}|${Math.random()}`).slice(0, 16)}`;
  const record = store.create(
    KIND.usage,
    {
      dayKey: quota.day,
      day: toISO(at),
      purpose: purpose ?? 'learning',
      state: USAGE_STATE.reserved,
      taskId: taskId ?? '',
      provider: provider ?? '',
      model: model ?? '',
      attempt: Number(attempt) || 1,
      promptVersion: '',
      usage: null,
      error: '',
    },
    { id: usageId, characterId, scopeKey, status: 'active', at },
  );
  return { record, quota: { ...quota, global: quota.global + 1, local: quota.local + 1 } };
}

/**
 * 将预留推进到终态；未知用量不得伪造为 0。
 *
 * 该函数在成功提交的事务内调用，因此不吞异常：记账失败必须让整批回滚，
 * 否则会出现“内容已提交但额度没结算”的不一致。
 * 事务外的失败收尾请用 markUsageAfterFailure（它对 Store 已关闭做兜底）。
 */
export function settleUsage(store, usageId, patch, { at } = {}) {
  if (!usageId) return null;
  const record = store.get(usageId);
  if (!record) return null;
  const nextData = { ...record.data, ...patch };
  if (patch?.state === USAGE_STATE.failed && !nextData.error) nextData.error = 'unknown-error';
  return store.update(usageId, record.version, { data: nextData }, { at });
}

/**
 * 失败/取消后的收尾：已预留的请求一律保留为 failed 或 unknown，继续占额度。
 * 这是“失败重试也计数”的直接体现；Store 已关闭或记录缺失时返回 null，不掩盖业务错误。
 */
export function markUsageAfterFailure(store, usageId, error, { at, state = USAGE_STATE.failed } = {}) {
  try {
    return settleUsage(
      store,
      usageId,
      {
        state,
        error: typeof error === 'string' ? error : error?.code || error?.message || 'error',
      },
      { at },
    );
  } catch {
    return null;
  }
}

/** 当天某范围的请求数（供 status/evaluate 展示）。 */
export function usageSummary(store, config, { characterId, scopeKey, at }) {
  return readQuota(store, config, { characterId, scopeKey, at });
}
