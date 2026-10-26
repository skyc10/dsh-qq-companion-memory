/**
 * 学习调度：持久游标、任务租约、门槛与间隔、额度预留、失败退避、整批提交。
 *
 * 关键约束（docs/IMPLEMENTATION.md + PLAN T/S 系列）：
 * - store.tx 回调内一律同步，不 await；
 * - 游标只在整批成功提交后推进；失败 / 截断 / 额度不足保留材料；
 * - 额度在事务内先预留再发请求，失败与取消同样计数；
 * - 最短学习间隔对首次、重试、积压同样生效（重试不会绕过间隔）。
 */

import { DomainError } from '../domain/core.js';
import {
  KIND,
  TASK_TYPE,
  LearningOutputError,
  asString,
  clampInt,
  createLogger,
  dayKey,
  errorSummary,
  hashText,
  isoAdd,
  listAll,
  linkSignals,
  normalizeSpaces,
  nowFrom,
  runCancelable,
  toISO,
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
} from './util.js';
import { resolveLearningConfig } from './config.js';
import { resolveConversationUnit } from '../domain/conversations.js';
import { classifyEvent, selectMaterials, toPromptMaterial } from './materials.js';
import { SYSTEM_PROMPT, PROMPT_VERSION, OUTPUT_SCHEMA_VERSION, MEMORY_TYPES, buildLearningPrompt } from './prompts.js';
import { readLearningResult } from './output.js';
import {
  CANDIDATE_STATUS,
  COLLECTING_STATUSES,
  acceptCandidate,
  attachEvidence,
  createCandidate,
  evaluateCandidate,
  isCollectingStatus,
  startTrial,
  recordConflict,
} from './evidence.js';
import { USAGE_STATE, markUsageAfterFailure, readQuota, reserveQuota, settleUsage } from './quota.js';
import { classifyLearningFailure } from './failures.js';

const LEASE_GRACE_MS = 60_000;
/** 模型能力未知时的输入字符安全界（不是 token 口径，只用于保守修剪）。 */
const SAFETY_INPUT_CHARS = 24_000;
const MAX_BACKOFF_MS = 24 * HOUR_MS;
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

/** 下一个上海零点（UTC ISO）。 */
export function nextShanghaiMidnight(at) {
  const day = dayKey(at);
  const start = Date.parse(`${day}T00:00:00+08:00`);
  if (!Number.isFinite(start)) return isoAdd(at, DAY_MS);
  return new Date(start + DAY_MS).toISOString();
}

function cursorOf(task) {
  const cursor = task?.data?.cursor;
  return { receivedAt: toISO(cursor?.receivedAt) ?? '', eventId: asString(cursor?.eventId) };
}

/** 游标之后的材料（窗口内按 receivedAt 单调，窗口外靠 eventId 兜底）。 */
function afterCursor(materials, cursor) {
  if (!cursor.receivedAt) return materials;
  return materials.filter((item) => {
    if (item.receivedAt > cursor.receivedAt) return true;
    if (item.receivedAt < cursor.receivedAt) return false;
    return item.id > cursor.eventId;
  });
}

function sortByReceived(list) {
  return [...list].sort((a, b) => {
    if (a.receivedAt === b.receivedAt) return a.id < b.id ? -1 : 1;
    return a.receivedAt < b.receivedAt ? -1 : 1;
  });
}

export function createScheduler({ store, config, model, logger, clock, engineId, isClosed, abortSignal, onActiveChange }) {
  const log = createLogger(logger);
  const activeLeases = new Map(); // taskId -> leaseId
  /** 材料扫描结论缓存（仅内存）：key=characterId\0scopeKey，用于跳过无写入的重复扫描。 */
  const scanCache = new Map();
  let activeCount = 0;
  /** 事件轮转扫描游标（仅内存，属扫描优化，不是学习进度）。 */
  let discoveryCursor = '';

  function now() {
    return nowFrom(clock);
  }

  function trackActive(delta) {
    activeCount = Math.max(0, activeCount + delta);
    if (typeof onActiveChange === 'function') onActiveChange(activeCount);
  }

  function taskIdFor(characterId, scopeKey) {
    return `task_${hashText(`${TASK_TYPE.range}|${characterId}|${scopeKey}`)}`;
  }

  /** 读取或创建某角色+范围的持久任务记录。 */
  function getTaskRecord(characterId, scopeKey) {
    const id = taskIdFor(characterId, scopeKey);
    const existing = store.get(id);
    if (existing) return existing;
    const at = now();
    try {
      return store.create(
        KIND.task,
        {
          type: TASK_TYPE.range,
          characterId,
          scopeKey,
          cursor: { receivedAt: '', eventId: '' },
          // 首个有效人类材料的 receivedAt：持久计时点，首次学习也必须等满最短间隔。
          firstMaterialAt: '',
          lastLearnedAt: '',
          lastAttemptAt: '',
          nextEligibleAt: '',
          attempts: 0,
          consecutiveFailures: 0,
          lastError: '',
          lastSuccessAt: '',
          lease: null,
          paused: false,
          pauseReason: '',
          learnedCount: 0,
          memoryCount: 0,
          promptVersion: PROMPT_VERSION,
          schemaVersion: OUTPUT_SCHEMA_VERSION,
          createdAt: at,
          updatedAt: at,
        },
        { id, characterId, scopeKey, status: 'active', at },
      );
    } catch (error) {
      // 并发下另一实例可能已建好同名任务；读回即可，其它异常照旧抛出。
      const retry = store.get(id);
      if (retry) return retry;
      throw error;
    }
  }

  /** 只读查找任务记录（不存在返回 null，不创建）。供 evaluate 使用。 */
  function findTaskRecord(characterId, scopeKey) {
    if (!asString(characterId) || !asString(scopeKey)) return null;
    return store.get(taskIdFor(characterId, scopeKey));
  }

  /**
   * 该范围游标之后、通过保守过滤的有效材料。
   *
   * 扫描策略（不改变存储契约的工程折中）：
   * - 全量按页扫描该范围的事件：Store.list 的 after 游标按记录 ID 排序，
   *   而 event ID 是消息摘要、不是时间序，因此不能用“读到最后一条”判断读全；
   *   页数上限（默认 200 页 / 20 万条）仅作安全闸，超限标记 truncated 并跳过缓存。
   * - generation 门控：Store 每次写入都会递增 generation；缓存（仅内存，不落库）
   *   记录“扫描时的游标 + 代数 + 待处理数”，代数未变且上次不足门槛时直接跳过扫描。
   *   重启后最多多扫一轮，不影响正确性；不把消息正文或标记写进任何记录。
   */
  function pendingMaterials(characterId, scopeKey, task, options = {}) {
    const cursor = cursorOf(task);
    const maxPages = clampInt(options.maxPages ?? 200, 1, 2000, 200);
    const threshold = clampInt(options.threshold ?? 20, 1, 100000, 20);
    const generation = store.generation();
    const cursorKey = `${cursor.receivedAt}|${cursor.eventId}`;
    const cacheKey = `${characterId}\u0000${scopeKey}`;
    const cached = scanCache.get(cacheKey);
    if (
      cached &&
      cached.cursorKey === cursorKey &&
      cached.generation === generation &&
      cached.pendingCount < threshold
    ) {
      // 自上次扫描后没有任何写入：结论（不足门槛）仍然成立。
      return {
        pending: [],
        pendingCount: cached.pendingCount,
        selection: { materials: [], dropped: [], stats: cached.stats ?? {} },
        cursor,
        noNew: true,
      };
    }

    const injectedHashes = new Set();
    for (const candidate of listAll(store, KIND.candidate, {
      characterId,
      scopeKey,
      status: [CANDIDATE_STATUS.accepted],
    })) {
      const rule = asString(candidate.data?.rule);
      if (rule) injectedHashes.add(hashText(rule));
    }

    // 按页读取原始事件（有上限），再统一做保守过滤与分段，保证分段对同一批事件确定。
    // 只用契约内的 store.list(after 游标)，不依赖未写入契约的扩展方法。
    const raw = [];
    let after = '';
    let pages = 0;
    let truncated = false;
    for (;;) {
      const page = store.list(KIND.event, {
        characterId,
        scopeKey,
        status: 'active',
        limit: 1000,
        ...(after ? { after } : {}),
      });
      if (!Array.isArray(page) || page.length === 0) break;
      raw.push(...page);
      pages += 1;
      after = page[page.length - 1].id;
      if (page.length < 1000) break;
      if (pages >= maxPages) {
        truncated = true;
        break;
      }
    }
    const selection = selectMaterials(raw, { injectedHashes,resolveUnit:key=>resolveConversationUnit(store,key) });
    const pending = afterCursor(selection.materials, cursor);

    if (!truncated) {
      scanCache.set(cacheKey, {
        cursorKey,
        generation,
        pendingCount: pending.length,
        stats: selection.stats,
        at: now(),
      });
    } else {
      scanCache.delete(cacheKey);
    }
    return { pending, pendingCount: pending.length, selection, cursor, truncated };
  }

  function thresholdFor(scopeKey, cfg) {
    return String(scopeKey).startsWith('group:') ? cfg.learning.groupThreshold : cfg.learning.privateThreshold;
  }

  function leaseActive(task, at) {
    const lease = task?.data?.lease;
    const expiresAt = toISO(lease?.expiresAt);
    if (!expiresAt || expiresAt <= at) return null;
    if (!asString(lease?.owner) && !asString(lease?.id)) return null;
    return { owner: asString(lease?.owner), id: asString(lease?.id), expiresAt, acquiredAt: toISO(lease?.acquiredAt) ?? '' };
  }

  function leaseTtlMs(cfg) {
    // 租约必须覆盖整个请求（含超时与写回），并与配置的 leaseMinutes 取较大者。
    const fromTimeout = cfg.learning.requestTimeoutSeconds * 1000 + LEASE_GRACE_MS;
    const fromConfig = cfg.learning.leaseMinutes * MINUTE_MS;
    return Math.max(fromTimeout, fromConfig);
  }

  /**
   * 硬最短间隔的下一个可学时间：lastLearnedAt / lastAttemptAt / firstMaterialAt 三者 + minIntervalHours 取最晚。
   * 返回 '' 表示尚无任何计时点（首次材料计时会由调用方补上）。
   */
  function hardFloorAt(task, cfg) {
    const intervalMs = cfg.learning.minIntervalHours * HOUR_MS;
    let floor = '';
    for (const iso of [toISO(task?.data?.lastLearnedAt), toISO(task?.data?.lastAttemptAt), toISO(task?.data?.firstMaterialAt)]) {
      if (!iso) continue;
      const value = isoAdd(iso, intervalMs);
      if (!floor || value > floor) floor = value;
    }
    return floor;
  }

  /**
   * 门槛 + 间隔 + 暂停检查。
   *
   * 最短间隔是硬闸（T3），对首次、重试、积压、额度恢复一律生效：
   * - 计时起点按优先级取 lastLearnedAt / lastAttemptAt / firstMaterialAt；
   * - firstMaterialAt 是“首个有效人类材料 receivedAt”的持久计时点，首次学习同样要等满间隔；
   * - nextEligibleAt 只是额外的退避/额度等待，不能被用来缩短硬闸（取两者较晚者）。
   * firstMaterialAt 尚未建立时返回 ok，由调用方扫描材料后先落计时点再复查。
   */
  function checkEligibility(task, cfg, at) {
    if (!cfg.features.learning) return { ok: false, reason: 'learning-disabled' };
    if (task?.data?.paused === true) {
      return { ok: false, reason: `paused:${asString(task.data.pauseReason) || 'manual'}`, until: '' };
    }
    const lastLearnedAt = toISO(task?.data?.lastLearnedAt);
    const lastAttemptAt = toISO(task?.data?.lastAttemptAt);
    const firstMaterialAt = toISO(task?.data?.firstMaterialAt);
    const hardUntil = hardFloorAt(task, cfg);

    const nextEligibleAt = toISO(task?.data?.nextEligibleAt);
    let until = hardUntil;
    if (nextEligibleAt && (!until || nextEligibleAt > until)) until = nextEligibleAt;
    if (!until) return { ok: true };
    if (until > at) {
      let reason = 'interval';
      if (hardUntil && hardUntil >= until) {
        reason = !lastLearnedAt && !lastAttemptAt && firstMaterialAt ? 'first-interval' : 'min-interval';
      }
      return { ok: false, reason, until };
    }
    return { ok: true };
  }

  /**
   * 建立首个有效人类材料的持久计时点（首次只在事务内写一次，不覆盖已有值）。
   * 只记 receivedAt，不把消息正文写进任务记录。
   */
  function ensureFirstMaterialAt(task, pending) {
    if (!task || toISO(task.data?.firstMaterialAt)) return task;
    let earliest = '';
    for (const item of pending) {
      const at = toISO(item.receivedAt);
      if (at && (!earliest || at < earliest)) earliest = at;
    }
    if (!earliest) return task;
    let updated = task;
    const stamp = now();
    try {
      store.tx(() => {
        const fresh = store.get(task.id);
        if (!fresh || toISO(fresh.data?.firstMaterialAt)) {
          updated = fresh ?? task;
          return;
        }
        updated = store.update(
          fresh.id,
          fresh.version,
          { data: { ...fresh.data, firstMaterialAt: earliest, updatedAt: stamp } },
          { at: stamp },
        );
      });
    } catch (error) {
      log.warn('learning.first-material.failed', { taskId: task.id, error: errorSummary(error) });
      return task;
    }
    return updated;
  }

  /** 事务内抢租约 + 预留额度。失败整体回滚，不留下半个任务状态。 */
  function beginRequest({ characterId, scopeKey, cfg, at, purpose }) {
    const task = getTaskRecord(characterId, scopeKey);
    const lease = leaseActive(task, at);
    if (lease && lease.owner && lease.owner !== engineId) {
      return { blocked: 'lease', task, lease };
    }
    const attempt = clampInt(Number(task.data?.attempts ?? 0) + 1, 1, 1_000_000, 1);
    let usage = null;
    let updated = null;
    try {
      store.tx(() => {
        const fresh = store.get(task.id);
        if (!fresh) throw new DomainError('LEARNING_TASK_MISSING', '学习任务记录丢失', 500);
        const freshLease = leaseActive(fresh, at);
        if (freshLease && freshLease.owner && freshLease.owner !== engineId) {
          throw new DomainError('LEARNING_TASK_LEASED', '学习任务已被其它实例占用', 409, {
            owner: freshLease.owner,
            expiresAt: freshLease.expiresAt,
          });
        }
        const reservation = reserveQuota(store, cfg, {
          characterId,
          scopeKey,
          at,
          taskId: fresh.id,
          purpose,
          attempt,
        });
        usage = reservation.record;
        updated = store.update(
          fresh.id,
          fresh.version,
          {
            data: {
              ...fresh.data,
              lease: {
                owner: engineId,
                id: `lease_${hashText(`${fresh.id}|${at}|${attempt}`)}`,
                acquiredAt: at,
                expiresAt: isoAdd(at, leaseTtlMs(cfg)),
              },
              attempts: attempt,
              lastAttemptAt: at,
              inFlightUsageId: reservation.record.id,
              updatedAt: at,
            },
          },
          { at },
        );
      });
    } catch (error) {
      return {
        blocked: error?.code === 'LEARNING_QUOTA_EXHAUSTED' ? 'quota' : 'error',
        error,
        task,
      };
    }
    if (updated?.data?.lease?.id) activeLeases.set(updated.id, updated.data.lease.id);
    return { task: updated, usage, attempt, requestId: `${updated.id}:${attempt}` };
  }

  /** 释放租约并写回任务字段（独立事务；失败不掩盖已提交的业务）。 */
  function releaseLease(taskId, patch = {}, { at } = {}) {
    let record = null;
    try {
      record = store.get(taskId);
    } catch (error) {
      // Store 已关闭（宿主先关库）时静默放弃写回，避免二次异常掩盖业务结果。
      activeLeases.delete(taskId);
      log.warn('learning.lease.store-closed', { taskId, error: errorSummary(error) });
      return null;
    }
    if (!record) {
      activeLeases.delete(taskId);
      return null;
    }
    const stamp = toISO(at) ?? now();
    const expectedLeaseId = activeLeases.get(taskId) ?? '';
    const currentLease = record.data?.lease ?? null;
    const currentLeaseId = asString(currentLease?.id);
    // 只有“本实例持有”或“当前无租约”时才清空；绝不覆盖其它实例的租约。
    const mayClearLease =
      !currentLeaseId || currentLeaseId === expectedLeaseId || asString(currentLease?.owner) === engineId;
    const nextData = {
      ...record.data,
      ...patch,
      lease: mayClearLease ? null : record.data.lease,
      inFlightUsageId: mayClearLease ? '' : record.data.inFlightUsageId ?? '',
      updatedAt: stamp,
    };
    let updated = null;
    try {
      updated = store.update(record.id, record.version, { data: nextData }, { at: stamp });
    } catch (error) {
      const retry = store.get(taskId);
      if (retry) {
        const retryLease = retry.data?.lease ?? null;
        const retryLeaseId = asString(retryLease?.id);
        const retryMayClear =
          !retryLeaseId || retryLeaseId === expectedLeaseId || asString(retryLease?.owner) === engineId;
        try {
          updated = store.update(
            retry.id,
            retry.version,
            {
              data: {
                ...retry.data,
                ...patch,
                lease: retryMayClear ? null : retry.data.lease,
                inFlightUsageId: retryMayClear ? '' : retry.data.inFlightUsageId ?? '',
                updatedAt: stamp,
              },
            },
            { at: stamp },
          );
        } catch (secondError) {
          log.warn('learning.lease.release-failed', { taskId, error: errorSummary(secondError) });
        }
      } else {
        log.warn('learning.lease.release-failed', { taskId, error: errorSummary(error) });
      }
    }
    activeLeases.delete(taskId);
    return updated;
  }

  function backoffMs(cfg, failures) {
    const base = Math.max(cfg.learning.minIntervalHours * HOUR_MS, 30 * MINUTE_MS);
    const factor = 2 ** Math.min(Math.max(failures - 1, 0), 5);
    return Math.min(base * factor, MAX_BACKOFF_MS);
  }

  /** 失败收尾：连续失败计数、退避、额度耗尽等到上海零点、认证配置错误暂停自动重试。 */
  function applyFailure(task, cfg, { at, error, extra = {} }) {
    let record = task;
    try {
      record = store.get(task.id) ?? task;
    } catch {
      // Store 不可用：仍释放内存租约，避免本实例永久认为该任务在跑。
      activeLeases.delete(task.id);
      return null;
    }
    const failures = clampInt(Number(record.data?.consecutiveFailures ?? 0) + 1, 1, 1000, 1);
    const summary = errorSummary(error);
    const classification = classifyLearningFailure(error);
    // 管理员已暂停的任务不因失败收尾被自动恢复：只有认证/配置错误才会新增暂停。
    const alreadyPaused = record.data?.paused === true;
    const paused = alreadyPaused || classification.pauseAutoRetry;
    const nextEligibleAt = classification.quotaRelated
      ? nextShanghaiMidnight(at)
      : isoAdd(at, Math.max(backoffMs(cfg, failures), cfg.learning.minIntervalHours * HOUR_MS));
    return releaseLease(
      record.id,
      {
        consecutiveFailures: failures,
        lastError: `${summary.code}: ${summary.message}`,
        lastFailureAt: at,
        nextEligibleAt,
        paused,
        pauseReason: alreadyPaused
          ? asString(record.data?.pauseReason) || 'manual'
          : classification.pauseAutoRetry
            ? 'auth-or-config'
            : '',
        ...extra,
      },
      { at },
    );
  }

  /** 预算：只用显式配置或模型自报能力；都没有则走字符安全界并标记 unknown。 */
  function budgetFor(selection, cfg) {
    const contextWindow = clampInt(Number(selection?.contextWindow) || cfg.budget.contextWindow || 0, 0, 10_000_000, 0);
    const maxOutputRaw = clampInt(Number(selection?.maxOutputTokens) || cfg.budget.maxOutputTokens || 0, 0, 200_000, 0);
    const manualInput = clampInt(
      Number(selection?.maxInputTokens) || cfg.budget.maxInputTokens || 0,
      0,
      10_000_000,
      0,
    );
    let inputTokens = 0;
    if (manualInput > 0) inputTokens = manualInput;
    else if (contextWindow > 0) inputTokens = Math.max(256, contextWindow - (maxOutputRaw || DEFAULT_MAX_OUTPUT_TOKENS) - 512);
    return {
      inputTokens,
      maxOutputTokens: maxOutputRaw > 0 ? maxOutputRaw : DEFAULT_MAX_OUTPUT_TOKENS,
      known: inputTokens > 0,
      contextWindow,
    };
  }

  function estimateTokens(selection, text) {
    try {
      if (typeof selection?.estimate === 'function') {
        const value = Number(selection.estimate(text));
        if (Number.isFinite(value) && value >= 0) return value;
      }
    } catch {
      /* 估算失败回退字符口径，仅用于修剪 */
    }
    return Math.ceil(String(text ?? '').length / 4);
  }

  function buildPromptFor(characterId, scopeKey, cfg, rawList) {
    const ordered = [...rawList].sort((a, b) => {
      if (a.occurredAt === b.occurredAt) return a.id < b.id ? -1 : 1;
      return a.occurredAt < b.occurredAt ? -1 : 1;
    });
    return buildLearningPrompt({
      characterId,
      scopeKey,
      materials: ordered.map((item) => ({
        ...toPromptMaterial(item, 400),
        segments: item.segments,
      })),
      config: cfg,
    });
  }

  /** 按预算从尾部修剪批次；至少保留 1 条，否则本批跳过。 */
  function fitBatch(characterId, scopeKey, cfg, rawList, budget, selection) {
    let size = rawList.length;
    let prompt = buildPromptFor(characterId, scopeKey, cfg, rawList.slice(0, size));
    while (size > 1) {
      const over = budget.inputTokens > 0
        ? estimateTokens(selection, prompt) > budget.inputTokens
        : prompt.length > SAFETY_INPUT_CHARS;
      if (!over) break;
      size -= 1;
      prompt = buildPromptFor(characterId, scopeKey, cfg, rawList.slice(0, size));
    }
    return { batch: rawList.slice(0, size), prompt };
  }

  function usageFromGenerated(generated) {
    const usage = generated?.usage;
    if (!usage || typeof usage !== 'object') return null;
    const inputTokens = Number(usage.inputTokens);
    const outputTokens = Number(usage.outputTokens);
    return {
      inputTokens: Number.isFinite(inputTokens) ? inputTokens : null,
      outputTokens: Number.isFinite(outputTokens) ? outputTokens : null,
    };
  }

  /** 同角色同范围同类型同规则的可复用候选（不重复建候选，只补证据）。 */
  function findReusableCandidate(characterId, scopeKey, item) {
    const rows = listAll(store, KIND.candidate, {
      characterId,
      scopeKey,
      status: [...COLLECTING_STATUSES, CANDIDATE_STATUS.trial, CANDIDATE_STATUS.paused, CANDIDATE_STATUS.accepted],
    });
    const rule = asString(item.rule).toLowerCase();
    for (const row of rows) {
      if (asString(row.data?.type) !== item.type) continue;
      if (asString(row.data?.rule).toLowerCase() === rule) return row;
    }
    return null;
  }

  const MEMORY_TYPE_SET = new Set(MEMORY_TYPES);
  /** 只有经历摘要可以在本批直接生效；其余记忆必须管理员复核。 */
  const MEMORY_ACTIVE_TYPES = new Set(['experience']);

  /**
   * 联合提炼写记忆（事务内）：
   * - experience 只是共同经历摘要，可 active；
   * - fact/boundary/preference/relationship/promise 一律 pending + confirmed:false，必须管理员复核后才生效；
   * - 同角色同范围的稳定 hash 去重；已有记录（含人工手改、已删除）一律跳过，绝不覆盖；
   * - 不创建 profile、不建共享，跨群共享只能走人工 share 动作。
   */
  function commitMemories({ characterId, scopeKey, memories, at, batchById }) {
    const created = [];
    const skipped = [];
    if (!Array.isArray(memories) || memories.length === 0) return { created, skipped };

    // 同范围已有记忆（含停用/待复核）：同 hash 或同类型同文本即视为已有，不覆盖人工改动。
    const existingKeys = new Set();
    const existingTexts = new Set();
    for (const row of listAll(store, 'memory', { characterId, scopeKey, includeDeleted: true }, { maxPages: 20 })) {
      const key = asString(row.data?.memoryKey);
      if (key) existingKeys.add(key);
      const text = normalizeSpaces(row.data?.text).toLowerCase();
      if (text) existingTexts.add(`${asString(row.data?.type)}|${text}`);
    }

    for (const memory of memories) {
      if (!MEMORY_TYPE_SET.has(memory.type)) {
        throw new LearningOutputError(
          'LEARNING_OUTPUT_INVALID_MEMORY_TYPE',
          `记忆类型非法：${String(memory.type)}`,
        );
      }
      // 来源必须是本批真实材料，且同角色同范围；越界整批失败而不是静默丢记忆。
      for (const sourceId of memory.sourceIds) {
        const material = batchById.get(sourceId);
        if (!material) {
          throw new LearningOutputError(
            'LEARNING_OUTPUT_SOURCE_UNKNOWN',
            `记忆来源不在本批内：${sourceId}`,
          );
        }
        if (
          (material.characterId && material.characterId !== characterId) ||
          material.scopeKey !== scopeKey
        ) {
          throw new LearningOutputError(
            'LEARNING_OUTPUT_SOURCE_SCOPE',
            `记忆来源与批次范围不一致：${material.scopeKey}`,
          );
        }
      }

      const textKey = `${memory.type}|${normalizeSpaces(memory.text).toLowerCase()}`;
      const id = `memory-${hashText(`learning|${characterId}|${scopeKey}|${memory.memoryKey}`)}`;
      if (
        existingKeys.has(memory.memoryKey) ||
        existingTexts.has(textKey) ||
        store.get(id, { includeDeleted: true })
      ) {
        skipped.push({ id, reason: 'duplicate' });
        continue;
      }
      const active = MEMORY_ACTIVE_TYPES.has(memory.type);
      const record = store.create(
        'memory',
        {
          type: memory.type,
          text: memory.text,
          sourceIds: [...memory.sourceIds],
          confirmed: active,
          reviewRequired: !active,
          memoryKey: memory.memoryKey,
          origin: 'learning',
          subjectQQ: asString(memory.subjectQQ),
          promptVersion: PROMPT_VERSION,
          schemaVersion: OUTPUT_SCHEMA_VERSION,
          learnedAt: at,
        },
        {
          id,
          characterId,
          scopeKey,
          subjectQQ: asString(memory.subjectQQ),
          status: active ? 'active' : 'pending',
          at,
        },
      );
      existingKeys.add(memory.memoryKey);
      existingTexts.add(textKey);
      created.push(record);
    }
    return { created, skipped };
  }

  /** 事务内复核一条材料是否仍与送模时一致；返回空串表示一致。 */
  function batchMaterialProblem(sent, current) {
    if (!current || current.kind !== KIND.event) return 'missing';
    if (current.status !== 'active') return 'inactive';
    const verdict = classifyEvent(current);
    if (!verdict.ok) return `not-effective:${verdict.reason}`;
    if (current.characterId !== sent.characterId) return 'character-changed';
    if (current.scopeKey !== sent.scopeKey) return 'scope-changed';
    const data = current.data ?? {};
    // 版本一致即可直接通过；版本变了则退回逐字段比对（contentHash / 发送者 / 消息 ID / 时间）。
    if (current.version === sent.record?.version) return '';
    if (asString(data.senderQQ) !== sent.senderQQ) return 'sender-changed';
    if (asString(data.messageId ?? current.id) !== sent.messageId) return 'message-id-changed';
    if (hashText(normalizeSpaces(data.content)) !== sent.contentHash) return 'content-changed';
    if ((toISO(data.occurredAt ?? current.createdAt) ?? '') !== sent.occurredAt) return 'occurred-at-changed';
    if ((toISO(data.receivedAt ?? current.createdAt) ?? '') !== sent.receivedAt) return 'received-at-changed';
    return '';
  }

  /** 整批提交：材料复核 + 候选 + 证据 + 记忆 + 游标 + 额度终态在同一事务；任何异常整批回滚。 */
  function commitBatch({ task, usageId, validated, batch, cfg, at, requestId, generated }) {
    let committed = null;
    store.tx(() => {
      const fresh = store.get(task.id);
      if (!fresh) throw new DomainError('LEARNING_TASK_MISSING', '提交前任务记录丢失', 500);
      if (fresh.data?.paused === true) {
        throw new DomainError('LEARNING_TASK_PAUSED', '提交前任务已被暂停，整批不应用', 409, {
          pauseReason: asString(fresh.data?.pauseReason),
        });
      }
      // 租约必须仍是本实例、同一 leaseID 且未过期；否则整批不提交。
      const freshLease = fresh.data?.lease;
      const leaseId = asString(freshLease?.id);
      const expectedLeaseId = activeLeases.get(task.id) ?? asString(task.data?.lease?.id);
      const leaseExpiresAt = toISO(freshLease?.expiresAt) ?? '';
      if (
        !leaseId ||
        leaseId !== expectedLeaseId ||
        asString(freshLease?.owner) !== engineId ||
        !leaseExpiresAt ||
        leaseExpiresAt <= at
      ) {
        throw new DomainError('LEARNING_TASK_LEASED', '提交前任务租约已失效或被其它实例接管', 409, {
          expectedLeaseId,
          leaseId,
          expiresAt: leaseExpiresAt,
        });
      }

      // 逐条重取本批 event：删除源、停用、改写、改归属都整批失败，游标不前进。
      // 即使本批不产出任何候选，也必须走完这段复核。
      const batchById = new Map();
      for (const sent of batch) {
        const current = store.get(sent.id);
        const problem = batchMaterialProblem(sent, current);
        if (problem) {
          throw new LearningOutputError(
            'LEARNING_MATERIAL_CHANGED',
            `本批材料在送模后发生变化（${sent.id}：${problem}），整批不提交且游标不推进`,
            { eventId: sent.id, problem },
          );
        }
        batchById.set(sent.id, sent);
      }

      const ordered = sortByReceived(batch);
      const last = ordered[ordered.length - 1];

      // 复核全部来源：必须本批、同角色、同范围（人格候选允许同角色其它范围）。
      const planned = [];
      for (const item of validated.candidates) {
        const materials = [];
        for (const sourceId of item.sourceIds) {
          const material = batchById.get(sourceId);
          if (!material) {
            throw new LearningOutputError(
              'LEARNING_OUTPUT_SOURCE_SCOPE',
              `候选来源不在本批内：${item.type} / ${item.rule.slice(0, 60)}`,
            );
          }
          if (item.type === 'personality') {
            // 人格候选可来自同角色的群/私聊材料，但来源必须在本批内且属于同一角色。
            if (material.characterId && material.characterId !== fresh.characterId) {
              throw new LearningOutputError(
                'LEARNING_OUTPUT_SOURCE_CHARACTER',
                `候选来源属于其它角色：${material.characterId}`,
              );
            }
          } else if (material.scopeKey !== fresh.scopeKey) {
            throw new LearningOutputError(
              'LEARNING_OUTPUT_SOURCE_SCOPE',
              `候选来源属于其它范围：${material.scopeKey}`,
            );
          }
          materials.push(material);
        }
        if (materials.length === 0) {
          throw new LearningOutputError(
            'LEARNING_OUTPUT_SOURCE_SCOPE',
            `候选来源不在本批范围内：${item.type} / ${item.rule.slice(0, 60)}`,
          );
        }
        planned.push({ item, materials });
      }

      const createdCandidates = [];
      const attached = [];
      for (const { item, materials } of planned) {
        const targetScope = item.type === 'personality' ? 'character' : fresh.scopeKey;
        const existing = findReusableCandidate(fresh.characterId, targetScope, item);
        if (existing) {
          const result = attachEvidence(store, existing, materials, { at });
          attached.push({ candidateId: result.candidate.id, added: result.created.length });
          continue;
        }
        const candidate = createCandidate(store, {
          characterId: fresh.characterId,
          scopeKey: targetScope,
          type: item.type,
          rule: item.rule,
          context: item.context,
          meaning: item.meaning,
          personalityChange: item.personalityChange,
          sourceIds: materials.map((material) => material.id),
          confidence: item.confidence,
          promptVersion: PROMPT_VERSION,
          schemaVersion: OUTPUT_SCHEMA_VERSION,
          at,
        });
        const result = attachEvidence(store, candidate, materials, { at });
        createdCandidates.push({
          id: result.candidate.id,
          type: item.type,
          scopeKey: targetScope,
          evidence: result.created.length,
          conflicts: item.conflicts.length,
        });
        if (item.conflicts.length > 0) {
          recordConflict(store, result.candidate, {
            summary: item.conflicts.join('；'),
            sourceIds: materials.map((material) => material.id),
            at,
          });
        }
      }

      // 联合记忆提炼：与候选同一事务；任何一条来源越界都会抛出并回滚整批。
      const memoryPlan = commitMemories({
        characterId: fresh.characterId,
        scopeKey: fresh.scopeKey,
        memories: validated.memories,
        at,
        batchById,
      });

      const latest = store.get(fresh.id) ?? fresh;
      const nextData = {
        ...latest.data,
        cursor: { receivedAt: last?.receivedAt ?? '', eventId: last?.id ?? '' },
        lastLearnedAt: at,
        // 成功后的下次可学时间只由最短间隔决定，不被任何配额午夜缩短。
        nextEligibleAt: isoAdd(at, cfg.learning.minIntervalHours * HOUR_MS),
        consecutiveFailures: 0,
        lastError: '',
        lastSuccessAt: at,
        lastRequestId: requestId,
        learnedCount: Number(latest.data?.learnedCount ?? 0) + batch.length,
        memoryCount: Number(latest.data?.memoryCount ?? 0) + memoryPlan.created.length,
        promptVersion: PROMPT_VERSION,
        schemaVersion: OUTPUT_SCHEMA_VERSION,
        lastOutcome: {
          at,
          status: 'ok',
          materials: batch.length,
          candidates: createdCandidates.length,
          attached: attached.length,
          memories: memoryPlan.created.length,
          memoryPending: memoryPlan.created.filter((row) => row.status !== 'active').length,
          summary: validated.summary,
        },
        lease: null,
        inFlightUsageId: '',
        updatedAt: at,
      };
      const updatedTask = store.update(fresh.id, latest.version, { data: nextData }, { at });

      if (usageId) {
        settleUsage(
          store,
          usageId,
          {
            state: USAGE_STATE.done,
            finish: asString(generated?.finish),
            usage: usageFromGenerated(generated),
            promptVersion: PROMPT_VERSION,
            candidates: createdCandidates.length,
            materials: batch.length,
            memories: memoryPlan.created.length,
          },
          { at },
        );
      }

      committed = {
        task: updatedTask,
        candidates: createdCandidates,
        attached,
        memories: memoryPlan.created.map((row) => ({ id: row.id, type: row.data?.type, status: row.status })),
        memoriesPending: memoryPlan.created.filter((row) => row.status !== 'active').length,
        memoriesSkipped: memoryPlan.skipped.length,
        materials: batch.length,
        cursor: nextData.cursor,
      };
    });
    activeLeases.delete(task.id);
    return committed;
  }

  /** 处理单个角色+范围的一次学习（一次模型请求）。 */
  async function processRange({ characterId, scopeKey, signal }) {
    const at = now();
    const cfg = resolveLearningConfig(config, characterId);
    if (!cfg.features.learning) {
      return { characterId, scopeKey, action: 'skip', reason: 'learning-disabled' };
    }

    let task = getTaskRecord(characterId, scopeKey);
    const lease = leaseActive(task, at);
    if (lease && lease.owner && lease.owner !== engineId) {
      return { characterId, scopeKey, action: 'skip', reason: 'leased', detail: lease };
    }
    let eligibility = checkEligibility(task, cfg, at);
    if (!eligibility.ok) {
      return { characterId, scopeKey, action: 'skip', reason: eligibility.reason, detail: { until: eligibility.until ?? null } };
    }

    const threshold = thresholdFor(scopeKey, cfg);
    const scanned = pendingMaterials(characterId, scopeKey, task, {
      threshold,
    });
    const { pending, selection } = scanned;
    if (scanned.noNew) {
      // 自上次扫描后没有新写入：不重复扫描，也不推进游标。
      return {
        characterId,
        scopeKey,
        action: 'skip',
        reason: 'no-new-materials',
        detail: { pending: scanned.pendingCount ?? 0, cached: true },
      };
    }
    if (pending.length === 0) {
      return { characterId, scopeKey, action: 'skip', reason: 'no-new-materials', detail: { dropped: selection.dropped.length } };
    }

    // 首次材料计时：首个有效人类材料的 receivedAt 落库后，首次学习同样要等满最短间隔。
    if (!toISO(task.data?.firstMaterialAt)) {
      task = ensureFirstMaterialAt(task, pending);
      // 计时点写不进去时保守跳过：不能凭“没有计时点”绕过最短间隔硬闸。
      if (!toISO(task.data?.firstMaterialAt)) {
        return {
          characterId,
          scopeKey,
          action: 'skip',
          reason: 'first-material-unavailable',
          detail: { pending: pending.length },
        };
      }
      eligibility = checkEligibility(task, cfg, now());
      if (!eligibility.ok) {
        return {
          characterId,
          scopeKey,
          action: 'skip',
          reason: eligibility.reason,
          detail: { until: eligibility.until ?? null, firstMaterialAt: toISO(task.data?.firstMaterialAt) ?? '' },
        };
      }
    }

    if (pending.length < threshold) {
      return { characterId, scopeKey, action: 'skip', reason: 'below-threshold', detail: { pending: pending.length, threshold } };
    }

    const quota = readQuota(store, cfg, { characterId, scopeKey, at });
    if (quota.globalRemaining <= 0 || quota.localRemaining <= 0) {
      return { characterId, scopeKey, action: 'skip', reason: 'quota-exhausted', detail: quota };
    }

    if (typeof model?.generate !== 'function') {
      const failure = new DomainError('LEARNING_MODEL_MISSING', '未配置学习模型适配器', 503);
      applyFailure(task, cfg, { at, error: failure });
      return { characterId, scopeKey, action: 'failed', reason: 'model-missing', error: errorSummary(failure) };
    }

    let resolved = null;
    try {
      resolved = typeof model?.resolve === 'function' ? await model.resolve({ characterId, scopeKey, sessionId: '', signal }) : null;
    } catch (error) {
      applyFailure(task, cfg, { at: now(), error });
      return { characterId, scopeKey, action: 'failed', reason: 'model-resolve', error: errorSummary(error) };
    }

    const selectionInfo = {
      provider: asString(resolved?.provider) || cfg.models.provider,
      model: asString(resolved?.model) || cfg.models.model,
      contextWindow: resolved?.contextWindow,
      maxOutputTokens: resolved?.maxOutputTokens,
      maxInputTokens: resolved?.maxInputTokens,
      estimate: resolved?.estimate,
    };
    const budget = budgetFor(selectionInfo, cfg);

    const ordered = sortByReceived(pending).slice(0, cfg.learning.batchSize);
    const fitted = fitBatch(characterId, scopeKey, cfg, ordered, budget, selectionInfo);
    const batch = fitted.batch;
    if (batch.length === 0) {
      return { characterId, scopeKey, action: 'skip', reason: 'no-budget' };
    }

    // 门槛与预算都通过后才抢租约、预留额度；额度不足不推进游标。
    // 额度按“候选 + 记忆联合提炼”记账：一次请求同时产出两者，不允许为记忆再发第二次请求。
    const begin = beginRequest({ characterId, scopeKey, cfg, at: now(), purpose: 'extract+memory' });
    if (begin.blocked) {
      if (begin.blocked === 'quota') {
        // 事务已回滚，任务记录没有残留租约；只记录“等到上海零点再试”，材料与游标保留。
        const latest = store.get(task.id);
        if (latest) {
          store.update(
            latest.id,
            latest.version,
            { data: { ...latest.data, nextEligibleAt: nextShanghaiMidnight(now()), updatedAt: now() } },
            { at: now() },
          );
        }
        return {
          characterId,
          scopeKey,
          action: 'skip',
          reason: 'quota-exhausted',
          detail: begin.error?.details ?? readQuota(store, cfg, { characterId, scopeKey, at: now() }),
        };
      }
      if (begin.blocked === 'lease') {
        return { characterId, scopeKey, action: 'skip', reason: 'leased', detail: begin.lease };
      }
      return {
        characterId,
        scopeKey,
        action: 'skip',
        reason: 'reserve-failed',
        error: begin.error ? errorSummary(begin.error) : undefined,
      };
    }

    task = begin.task;
    const usageId = begin.usage?.id ?? '';
    const requestId = begin.requestId;
    const materialIds = batch.map((item) => item.id);
    const linked = linkSignals(signal, abortSignal);
    const timeoutMs = cfg.learning.requestTimeoutSeconds * 1000;
    trackActive(1);

    let runResult;
    try {
      runResult = await runCancelable(
        (reqSignal) =>
          model.generate({
            selection: selectionInfo,
            // 稳定的角色指令放 system；输出结构与材料已在 input 内，避免重复粘贴 schema。
            system: SYSTEM_PROMPT,
            input: fitted.prompt,
            maxTokens: budget.maxOutputTokens,
            signal: reqSignal,
            requestId,
          }),
        { signal: linked.signal, timeoutMs },
      );
    } catch (error) {
      runResult = { ok: false, error, timedOut: false, aborted: false };
    } finally {
      linked.dispose();
      trackActive(-1);
    }

    // 关闭 / 取消 / 超时：请求可能已发出，按不确定或失败记账；不推进游标、不提交候选。
    if (isClosed() || runResult.aborted || runResult.timedOut) {
      const isTimeout = runResult.timedOut === true;
      if (usageId) {
        markUsageAfterFailure(store, usageId, isTimeout ? 'timeout' : 'canceled', {
          at: now(),
          state: USAGE_STATE.unknown,
        });
      }
      if (isTimeout) {
        applyFailure(task, cfg, {
          at: now(),
          error: new LearningOutputError('LEARNING_TIMEOUT', '模型请求超时，整批不应用'),
          extra: { lastMaterialIds: materialIds.slice(0, 20) },
        });
      } else {
        // 关闭导致的中断不算学习失败：只释放租约、记录原因，材料与游标原样保留。
        releaseLease(
          task.id,
          {
            lastError: 'LEARNING_ABORTED: 引擎关闭，批次未提交',
            lastAbortedAt: now(),
            lastMaterialIds: materialIds.slice(0, 20),
          },
          { at: now() },
        );
      }
      return {
        characterId,
        scopeKey,
        action: isTimeout ? 'failed' : 'canceled',
        reason: isTimeout ? 'timeout' : 'closed',
        usageId,
        materials: batch.length,
      };
    }

    if (!runResult.ok) {
      const error = runResult.error ?? new LearningOutputError('LEARNING_GENERATE_FAILED', '模型请求失败');
      if (usageId) {
        markUsageAfterFailure(store, usageId, errorSummary(error), { at: now(), state: USAGE_STATE.failed });
      }
      applyFailure(task, cfg, { at: now(), error, extra: { lastMaterialIds: materialIds.slice(0, 20) } });
      return { characterId, scopeKey, action: 'failed', reason: 'generate', error: errorSummary(error) };
    }

    const generated = runResult.value ?? {};
    let validated;
    try {
      validated = readLearningResult(generated, {
        materials: batch,
        characterId,
        scopeKey,
        config: cfg,
      });
    } catch (error) {
      if (usageId) {
        markUsageAfterFailure(store, usageId, errorSummary(error), { at: now(), state: USAGE_STATE.failed });
      }
      applyFailure(task, cfg, { at: now(), error, extra: { lastMaterialIds: materialIds.slice(0, 20) } });
      return { characterId, scopeKey, action: 'failed', reason: 'invalid-output', error: errorSummary(error) };
    }

    let committed;
    try {
      committed = commitBatch({ task, usageId, validated, batch, cfg, at: now(), requestId, generated });
    } catch (error) {
      if (usageId) {
        markUsageAfterFailure(store, usageId, errorSummary(error), { at: now(), state: USAGE_STATE.failed });
      }
      applyFailure(task, cfg, { at: now(), error, extra: { lastMaterialIds: materialIds.slice(0, 20) } });
      return { characterId, scopeKey, action: 'failed', reason: 'commit', error: errorSummary(error) };
    }

    log.info('learning.batch.committed', {
      characterId,
      scopeKey,
      materials: committed.materials,
      candidates: committed.candidates.length,
      attached: committed.attached.length,
      memories: committed.memories.length,
      requestId,
    });

    return {
      characterId,
      scopeKey,
      action: 'learned',
      reason: 'ok',
      materials: committed.materials,
      candidates: committed.candidates,
      attached: committed.attached,
      memories: committed.memories,
      memoriesPending: committed.memoriesPending,
      memoriesSkipped: committed.memoriesSkipped,
      cursor: committed.cursor,
      usageId,
      summary: validated.summary,
    };
  }

  /** 复核阶段：开试用与自动采纳；不消耗学习额度（纯本地判定 + 事务写入）。 */
  function advanceTransitions({ characterId, scopeKey, at }) {
    const cfg = resolveLearningConfig(config, characterId);
    const stamp = toISO(at) ?? now();
    if (!cfg.features.trial && !cfg.features.autoAdopt) {
      return { characterId, scopeKey, started: [], adopted: [], skipped: [{ reason: 'trial-and-adopt-disabled' }] };
    }
    const started = [];
    const adopted = [];
    const skipped = [];
    const candidates = listAll(store, KIND.candidate, {
      characterId,
      scopeKey,
      status: [...COLLECTING_STATUSES, CANDIDATE_STATUS.trial],
    });
    for (const candidate of candidates) {
      const evaluation = evaluateCandidate(store, candidate, cfg, { at: stamp });
      if (isCollectingStatus(candidate.status) && cfg.features.trial) {
        if (!evaluation.canStartTrial) {
          skipped.push({
            candidateId: candidate.id,
            reason: 'trial-not-ready',
            unmet: evaluation.unmet.map((item) => item.code),
          });
          continue;
        }
        try {
          let result = null;
          // 试用创建与候选状态在同一事务，避免只建了 trial 没改状态。
          store.tx(() => {
            const fresh = store.get(candidate.id);
            if (!fresh) throw new DomainError('CANDIDATE_NOT_FOUND', '候选已不存在', 404);
            result = startTrial(store, fresh, cfg, { at: stamp });
          });
          started.push({ candidateId: result.candidate.id, trialId: result.trial.id });
        } catch (error) {
          skipped.push({ candidateId: candidate.id, reason: 'start-trial', error: errorSummary(error) });
        }
        continue;
      }
      if (candidate.status === CANDIDATE_STATUS.trial && cfg.features.autoAdopt) {
        const fresh = store.get(candidate.id);
        if (!fresh) continue;
        const freshEval = evaluateCandidate(store, fresh, cfg, { at: stamp });
        if (!freshEval.canAdopt || freshEval.transition !== CANDIDATE_STATUS.accepted) {
          skipped.push({
            candidateId: fresh.id,
            reason: 'adopt-not-ready',
            unmet: freshEval.unmet.map((item) => item.code),
          });
          continue;
        }
        try {
          let result = null;
          // 采纳与人格版本创建在同一事务；失败整体回滚，候选保持试用态。
          store.tx(() => {
            const latest = store.get(fresh.id);
            if (!latest) throw new DomainError('CANDIDATE_NOT_FOUND', '候选已不存在', 404);
            result = acceptCandidate(store, latest, cfg, { at: stamp, actor: 'learning' });
          });
          adopted.push({
            candidateId: result.candidate.id,
            type: asString(fresh.data?.type),
            personalityVersionId: result.personality?.id ?? '',
          });
        } catch (error) {
          skipped.push({
            candidateId: fresh.id,
            reason: 'accept',
            error: errorSummary(error),
          });
        }
      }
    }
    return { characterId, scopeKey, started, adopted, skipped };
  }

  /**
   * 扫描所有可能需要处理的角色+范围：
   * - 已存在的任务记录（重试、积压、间隔到点）；
   * - 有待推进的候选（试用/采纳）；
   * - 新出现的 effective 事件所属范围（分页轮转，避免每轮全表扫描）。
   */
  function discoverRanges({ eventPageSize = 2000 } = {}) {
    const map = new Map();
    const add = (characterId, scopeKey, learnable) => {
      const cid = asString(characterId);
      const scope = asString(scopeKey);
      if (!cid || !scope) return;
      const scopeIsLearnable = scope.startsWith('group:') || scope.startsWith('private:');
      if (!scopeIsLearnable && scope !== 'character') return;
      const key = `${cid}\u0000${scope}`;
      const entry = map.get(key);
      if (entry) {
        entry.count += 1;
        entry.learnable = entry.learnable || Boolean(learnable && scopeIsLearnable);
      } else {
        map.set(key, { characterId: cid, scopeKey: scope, count: 1, learnable: Boolean(learnable && scopeIsLearnable) });
      }
    };

    // 已有任务：保证失败重试、积压与间隔到点都能被再次调度。
    for (const record of listAll(store, KIND.task, { status: 'active' })) {
      if (asString(record.data?.type) !== TASK_TYPE.range) continue;
      add(record.characterId, record.scopeKey, true);
    }
    // 已有绑定：会话绑定天然覆盖全部活跃角色+范围，避免只靠事件轮转慢慢发现。
    for (const record of listAll(store, KIND.binding, { status: 'active' })) {
      add(record.characterId, record.scopeKey, true);
    }
    // 待推进候选：人格候选位于 character 范围，只参与试用/采纳推进。
    for (const record of listAll(store, KIND.candidate, {
      status: [...COLLECTING_STATUSES, CANDIDATE_STATUS.trial],
    })) {
      add(record.characterId, record.scopeKey, false);
    }
    // 新范围发现：按 ID 游标轮转扫描 event，每轮有上界；扫到尾部则回头。
    // 轮转游标只保存在内存：它只是扫描优化，不是学习进度；不写库以免每次写入
    // 递增 generation、使所有范围的分段缓存失效。
    let after = discoveryCursor;
    let scanned = 0;
    let reachedEnd = false;
    while (scanned < eventPageSize) {
      const page = store.list(KIND.event, { status: 'active', after, limit: 1000 });
      if (!Array.isArray(page) || page.length === 0) {
        reachedEnd = true;
        break;
      }
      for (const record of page) {
        const data = record.data ?? {};
        if (data.effective === true && data.control !== true) {
          add(record.characterId, record.scopeKey, true);
        }
      }
      scanned += page.length;
      after = page[page.length - 1].id;
      if (page.length < 1000) {
        reachedEnd = true;
        break;
      }
    }
    discoveryCursor = reachedEnd ? '' : after;

    return [...map.values()].sort((a, b) => {
      if (a.characterId === b.characterId) return a.scopeKey < b.scopeKey ? -1 : 1;
      return a.characterId < b.characterId ? -1 : 1;
    });
  }

  /** 关闭时释放本实例持有的全部租约（同步）。 */
  function releaseAllLeases(at = now()) {
    for (const [taskId, leaseId] of [...activeLeases.entries()]) {
      const record = store.get(taskId);
      if (!record || asString(record.data?.lease?.id) !== leaseId) {
        activeLeases.delete(taskId);
        continue;
      }
      try {
        store.update(
          taskId,
          record.version,
          { data: { ...record.data, lease: null, inFlightUsageId: '', updatedAt: at } },
          { at },
        );
      } catch (error) {
        log.warn('learning.lease.close-release-failed', { taskId, error: errorSummary(error) });
      }
      activeLeases.delete(taskId);
    }
  }

  return {
    now,
    trackActive,
    activeTasks: () => activeCount,
    activeLeaseCount: () => activeLeases.size,
    discoverRanges,
    getTaskRecord,
    findTaskRecord,
    pendingMaterials,
    checkEligibility,
    beginRequest,
    releaseLease,
    applyFailure,
    commitBatch,
    advanceTransitions,
    releaseAllLeases,
    processRange,
    thresholdFor,
    resolveConfig: (characterId) => resolveLearningConfig(config, characterId),
    nextShanghaiMidnight,
  };
}
