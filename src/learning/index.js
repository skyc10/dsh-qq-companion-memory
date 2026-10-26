/**
 * 学习引擎入口。
 *
 * 契约（docs/IMPLEMENTATION.md）：
 *   createLearningEngine({store,config,model,logger,clock}) → { tick, evaluate, close }
 *
 * - tick(signal) 默认持续调度，close() 或 signal 中止时取消并收敛；
 *   tick(signal, {once:true}) 只跑一轮（供管理端手动触发）。
 * - evaluate(candidateId) 只读：返回未满足条件、试用/采纳进度、人格窗口与建议跃迁。
 * - close() 幂等：取消等待与进行中的模型请求，已发出请求按 unknown 记账，释放本实例租约。
 *
 * 引擎只通过注入的 Store 读写；除模型调用外全部同步，事务回调内不 await。
 * helpers 下附带应用层需要的写操作（应用/反馈/回退），不属于调度契约。
 */

import { DomainError } from '../domain/core.js';
import { clampInt, createLogger, errorSummary, hashText, linkSignals, listAll, toISO } from './util.js';
import { createScheduler } from './scheduler.js';
import { resolveLearningConfig } from './config.js';
import {
  CANDIDATE_STATUS,
  COLLECTING_STATUSES,
  acceptCandidate,
  evaluateCandidate,
  freezeEvidence,
  recordApplication,
  recordFeedback,
  resolveConflict,
  startTrial,
  verifyApplication,
} from './evidence.js';
import { readQuota } from './quota.js';
import {
  currentPersonalityVersion,
  listPersonalityVersions,
  personalityDiff,
  resumeAutoAdopt,
  rollbackBatch,
  rollbackCandidate,
  rollbackPersonality,
} from './versioning.js';
import { PROMPT_VERSION, OUTPUT_SCHEMA_VERSION } from './prompts.js';

/** close() 等待在途一轮收敛的上限，避免宿主关闭被模型请求拖住。 */
const CLOSE_GRACE_MS = 5_000;

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, Number(ms) || 0));
    if (typeof timer?.unref === 'function') timer.unref();
  });
}

/** 可被 AbortSignal 立即打断的等待。 */
function waitOrAbort(ms, signal) {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try {
        signal.removeEventListener('abort', finish);
      } catch {
        /* ignore */
      }
      resolve();
    };
    timer = setTimeout(finish, Math.max(0, ms));
    if (typeof timer?.unref === 'function') timer.unref();
    signal.addEventListener('abort', finish, { once: true });
  });
}

export function createLearningEngine({ store, config, model, logger, clock } = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.tx !== 'function') {
    throw new DomainError('LEARNING_STORE_REQUIRED', 'createLearningEngine 需要有效的 Store', 500);
  }
  const log = createLogger(logger);
  const engineId = `eng_${hashText(`${process.pid}|${Date.now()}|${Math.random()}`)}`;
  const closeController = new AbortController();
  let closed = false;
  let tickPromise = null;
  let lastRound = null;
  let roundCount = 0;

  const scheduler = createScheduler({
    store,
    config,
    model,
    logger,
    clock,
    engineId,
    isClosed: () => closed,
    abortSignal: closeController.signal,
  });

  const cfgFor = (characterId = '') => resolveLearningConfig(config, characterId);

  /** 单轮：按并发处理可学习的范围，再推进试用/采纳（不消耗请求额度）。 */
  async function runRound({ signal } = {}) {
    const startedAt = Date.now();
    const ranges = scheduler.discoverRanges();
    const results = { learned: [], failed: [], skipped: [], transitions: [] };
    if (closed || signal?.aborted) {
      return { round: roundCount, canceled: true, ranges: ranges.length, ...results, durationMs: 0 };
    }

    const globalConcurrency = clampInt(cfgFor('').learning.concurrency, 1, 4, 1);
    const queue = ranges
      .filter((range) => range.learnable)
      .filter((range) => cfgFor(range.characterId).features.learning);

    // 注意：关闭/中止时仍然等待在途请求收尾（AbortSignal 已让模型调用立即失败），
    // 否则宿主可能在 processRange 收尾写入额度/释放租约之前就关闭 Store。
    await new Promise((resolve) => {
      let cursor = 0;
      let inFlight = 0;
      let settled = false;
      const finishIfDone = () => {
        if (settled) return;
        const stops = closed || signal?.aborted === true;
        // 全部派发完且没有在途请求，或已关闭/中止且在途请求收敛，即结束本轮。
        if ((cursor >= queue.length && inFlight === 0) || (stops && inFlight === 0)) {
          settled = true;
          resolve();
        }
      };
      const next = () => {
        if (settled) return;
        if (closed || signal?.aborted) {
          finishIfDone();
          return;
        }
        while (inFlight < globalConcurrency && cursor < queue.length) {
          const item = queue[cursor];
          cursor += 1;
          inFlight += 1;
          scheduler
            .processRange({
              characterId: item.characterId,
              scopeKey: item.scopeKey,
              signal: signal ?? closeController.signal,
            })
            .then((result) => {
              if (result.action === 'learned') results.learned.push(result);
              else if (result.action === 'failed' || result.action === 'canceled') results.failed.push(result);
              else results.skipped.push(result);
            })
            .catch((error) => {
              results.failed.push({
                characterId: item.characterId,
                scopeKey: item.scopeKey,
                action: 'failed',
                reason: 'unexpected',
                error: errorSummary(error),
              });
              log.error('learning.round.range-failed', {
                characterId: item.characterId,
                scopeKey: item.scopeKey,
                error: errorSummary(error),
              });
            })
            .finally(() => {
              inFlight -= 1;
              if (!settled) next();
            });
        }
        if (inFlight === 0) finishIfDone();
      };
      next();
    });

    if (!closed && !signal?.aborted) {
      const targets = new Map();
      for (const range of ranges) {
        targets.set(`${range.characterId}\u0000${range.scopeKey}`, {
          characterId: range.characterId,
          scopeKey: range.scopeKey,
        });
      }
      // 人格候选位于 character 范围，需要单独纳入试用/采纳推进。
      for (const record of listAll(store, 'candidate', {
        status: [...COLLECTING_STATUSES, CANDIDATE_STATUS.trial],
      })) {
        if (record.data?.type !== 'personality') continue;
        targets.set(`${record.characterId}\u0000character`, {
          characterId: record.characterId,
          scopeKey: 'character',
        });
      }
      for (const target of targets.values()) {
        if (closed) break;
        try {
          const transition = scheduler.advanceTransitions({ ...target, at: scheduler.now() });
          if (transition.started.length > 0 || transition.adopted.length > 0) {
            results.transitions.push(transition);
          }
        } catch (error) {
          results.transitions.push({
            characterId: target.characterId,
            scopeKey: target.scopeKey,
            error: errorSummary(error),
          });
          log.error('learning.transition.failed', {
            characterId: target.characterId,
            scopeKey: target.scopeKey,
            error: errorSummary(error),
          });
        }
      }
    }

    roundCount += 1;
    const summary = {
      round: roundCount,
      at: scheduler.now(),
      ranges: ranges.length,
      canceled: closed,
      ...results,
      durationMs: Date.now() - startedAt,
    };
    lastRound = summary;
    return summary;
  }

  /**
   * 调度循环。默认持续运行；{once:true} 只跑一轮。
   * 关闭或 signal 中止后停止下一轮，返回最后一轮摘要。
   */
  async function tick(signal, options = {}) {
    if (closed) return { closed: true, canceled: true, round: roundCount, lastRound };
    if (tickPromise) return tickPromise;
    if (signal && typeof signal === 'object' && signal.aborted) {
      return { closed, canceled: true, round: roundCount, lastRound };
    }
    const once = options?.once === true;

    tickPromise = (async () => {
      const linked = linkSignals(signal, closeController.signal);
      let last = null;
      try {
        for (;;) {
          if (closed || linked.signal?.aborted) break;
          last = await runRound({ signal: linked.signal });
          if (once) break;
          if (closed || linked.signal?.aborted) break;
          const pollMs = clampInt(cfgFor('').learning.pollIntervalSeconds, 5, 3600, 60) * 1000;
          await waitOrAbort(pollMs, linked.signal);
        }
        return last ?? { closed, canceled: true, round: roundCount, lastRound };
      } finally {
        linked.dispose();
        tickPromise = null;
      }
    })();

    return tickPromise;
  }

  /** 只读评估：不创建任务记录、不写库。 */
  function evaluate(candidateId) {
    const id = typeof candidateId === 'string' ? candidateId.trim() : '';
    if (!id) throw new DomainError('CANDIDATE_ID_REQUIRED', 'evaluate 需要候选 ID', 400);
    const candidate = store.get(id);
    if (!candidate || candidate.kind !== 'candidate') {
      throw new DomainError('CANDIDATE_NOT_FOUND', `候选不存在：${id}`, 404);
    }
    const cfg = cfgFor(candidate.characterId);
    const at = scheduler.now();
    const evaluation = evaluateCandidate(store, candidate, cfg, { at });
    const quota = readQuota(store, cfg, {
      characterId: candidate.characterId,
      scopeKey: candidate.scopeKey,
      at,
    });
    const task = scheduler.findTaskRecord(candidate.characterId, candidate.scopeKey);
    const personalityVersion =
      candidate.data?.type === 'personality' ? currentPersonalityVersion(store, candidate.characterId) : null;
    return {
      ...evaluation,
      config: {
        features: cfg.features,
        independentUnits: cfg.evidence.independentUnits,
        distinctDays: cfg.evidence.distinctDays,
        trialDays: cfg.evidence.trialDays,
        applications: cfg.evidence.applications,
        personalityIntervalDays: cfg.evidence.personalityIntervalDays,
      },
      quota,
      task: task
        ? {
            id: task.id,
            cursor: task.data?.cursor ?? { receivedAt: '', eventId: '' },
            firstMaterialAt:toISO(task.data?.firstMaterialAt)??'',
            lastAttemptAt:toISO(task.data?.lastAttemptAt)??'',
            memoryCount:Number(task.data?.memoryCount??0),
            lastLearnedAt: toISO(task.data?.lastLearnedAt) ?? '',
            nextEligibleAt: toISO(task.data?.nextEligibleAt) ?? '',
            consecutiveFailures: Number(task.data?.consecutiveFailures ?? 0),
            lastError: task.data?.lastError ?? '',
            paused: task.data?.paused === true,
            pauseReason: task.data?.pauseReason ?? '',
          }
        : null,
      promptVersion: PROMPT_VERSION,
      schemaVersion: OUTPUT_SCHEMA_VERSION,
      personalityVersion: personalityVersion
        ? {
            id: personalityVersion.id,
            adoptedAt: personalityVersion.data?.adoptedAt ?? personalityVersion.createdAt,
            parentId: personalityVersion.data?.parentId ?? '',
            changes: personalityVersion.data?.changes ?? [],
          }
        : null,
    };
  }

  /** 幂等关闭：取消在途请求、等待收敛，然后释放本实例租约。 */
  async function close() {
    if (closed) {
      return {
        closed: true,
        canceled: true,
        round: roundCount,
        lastRound,
        releasedLeases: scheduler.activeLeaseCount() === 0,
      };
    }
    closed = true;
    try {
      closeController.abort(new Error('learning engine closed'));
    } catch {
      closeController.abort();
    }
    const running = tickPromise;
    if (running) {
      await Promise.race([running.catch(() => null), sleep(CLOSE_GRACE_MS)]);
    }
    try {
      scheduler.releaseAllLeases(scheduler.now());
    } catch (error) {
      log.warn('learning.close.release-failed', { error: errorSummary(error) });
    }
    return {
      closed: true,
      canceled: true,
      round: roundCount,
      lastRound,
      releasedLeases: scheduler.activeLeaseCount() === 0,
    };
  }

  return {
    tick,
    evaluate,
    close,
    /**
     * 应用层写操作。每个 helper 已绑定 store，参数不含 store。
     * 均应在宿主的事务或幂等包装内调用；本层不自行开启外层事务。
     */
    helpers: {
      recordApplication: (payload) => recordApplication(store, payload),
      verifyApplication: (payload) => verifyApplication(store, payload),
      recordFeedback: (payload) => recordFeedback(store, payload),
      startTrial: (candidate, opts) => {
        const fresh = store.get(candidate?.id ?? candidate);
        if (!fresh) throw new DomainError('CANDIDATE_NOT_FOUND', '候选不存在', 404);
        return startTrial(store, fresh, cfgFor(fresh.characterId), opts);
      },
      acceptCandidate: (candidateId, opts) => {
        const fresh = store.get(candidateId);
        if (!fresh) throw new DomainError('CANDIDATE_NOT_FOUND', '候选不存在', 404);
        return acceptCandidate(store, fresh, cfgFor(fresh.characterId), opts);
      },
      freezeEvidence: (candidateId, opts) => {
        const fresh = store.get(candidateId);
        if (!fresh) throw new DomainError('CANDIDATE_NOT_FOUND', '候选不存在', 404);
        return freezeEvidence(store, fresh, opts);
      },
      resolveConflict: (payload) => resolveConflict(store, payload.conflictId ?? payload.id, payload),
      rollbackPersonality: (payload) => rollbackPersonality(store, payload),
      rollbackCandidate: (payload) => rollbackCandidate(store, payload),
      rollbackBatch: (payload) => rollbackBatch(store, payload),
      resumeAutoAdopt: (candidateId, opts) => resumeAutoAdopt(store, candidateId, opts),
      listPersonalityVersions: (characterId, opts) => listPersonalityVersions(store, characterId, opts),
      personalityDiff: (versionId) => personalityDiff(store, versionId),
      currentPersonalityVersion: (characterId) => currentPersonalityVersion(store, characterId),
      resolveConfig: (characterId) => cfgFor(characterId),
      readQuota: (characterId, scopeKey, at) =>
        readQuota(store, cfgFor(characterId), { characterId, scopeKey, at: at ?? scheduler.now() }),
    },
    /** 只读状态，便于宿主健康检查。 */
    status() {
      return {
        engineId,
        closed,
        running: Boolean(tickPromise),
        rounds: roundCount,
        lastRound,
        activeRequests: scheduler.activeTasks(),
        activeLeases: scheduler.activeLeaseCount(),
        promptVersion: PROMPT_VERSION,
        schemaVersion: OUTPUT_SCHEMA_VERSION,
      };
    },
  };
}

export default createLearningEngine;
