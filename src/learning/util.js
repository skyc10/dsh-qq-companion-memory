/**
 * 学习引擎内部通用工具。
 *
 * 契约来源：docs/IMPLEMENTATION.md
 * - 时间统一为 UTC ISO 字符串；日界线由 domain.shanghaiDay 解释。
 * - Store 为同步接口，事务回调内不得 await（本模块自身不发起事务，只被调用方包裹）。
 */

import { createHash } from 'node:crypto';
import { DomainError, shanghaiDay } from '../domain/core.js';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** 学习引擎消费的记录类型。 */
export const KIND = Object.freeze({
  event: 'event',
  binding: 'binding',
  candidate: 'candidate',
  evidence: 'evidence',
  trial: 'trial',
  application: 'application',
  feedback: 'feedback',
  conflict: 'conflict',
  personality: 'personality',
  task: 'task',
  usage: 'usage',
});

/** 学习引擎自己的 task 记录类型（data.type）。 */
export const TASK_TYPE = Object.freeze({
  range: 'learning-range',
  discovery: 'learning-discovery',
  slot: 'learning-slot',
});

/** 模型输出结构或来源校验失败：不提交任何内容，保留材料等待重试。 */
export class LearningOutputError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LearningOutputError';
    this.code = code;
    this.details = details;
    this.retryable = true;
  }
}

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value).trim();
  }
  return '';
}

export function normalizeSpaces(value) {
  return asString(value).replace(/\s+/gu, ' ').trim();
}

export function limitText(value, max) {
  const text = normalizeSpaces(value);
  if (Number.isFinite(max) && max > 0 && text.length > max) return text.slice(0, max);
  return text;
}

export function hashText(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex').slice(0, 32);
}

export function toISO(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Date(value).toISOString() : null;
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  if (typeof value.toISOString === 'function') {
    try {
      const text = value.toISOString();
      return toISO(text);
    } catch {
      return null;
    }
  }
  return null;
}

export function isoAdd(iso, ms) {
  const base = toISO(iso);
  if (!base || !Number.isFinite(ms)) {
    throw new DomainError('INVALID_TIME', `时间无法解析：${String(iso)}`, 500);
  }
  return new Date(Date.parse(base) + ms).toISOString();
}

export function isoDiff(a, b) {
  const left = toISO(a);
  const right = toISO(b);
  if (!left || !right) return null;
  return Date.parse(left) - Date.parse(right);
}

/**
 * 上海日界线口径的日期键（YYYY-MM-DD）。
 * 统一走 domain.shanghaiDay；若其返回不是 YYYY-MM-DD（版本差异），
 * 回退到显式 +08:00 偏移换算，保证策略层日期口径一致。
 */
export function dayKey(at) {
  const iso = toISO(at);
  if (!iso) return '';
  try {
    const value = shanghaiDay(iso);
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  } catch {
    /* 回退显式换算 */
  }
  return new Date(Date.parse(iso) + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** 从注入的 Clock 读取当前时间；Clock 未提供时回退系统时间。 */
export function nowFrom(clock) {
  try {
    if (typeof clock === 'function') {
      const value = clock();
      const iso = toISO(value);
      if (iso) return iso;
    }
    if (clock && typeof clock === 'object') {
      if (typeof clock.now === 'function') {
        const iso = toISO(clock.now());
        if (iso) return iso;
      }
      if (typeof clock.nowISO === 'function') {
        const iso = toISO(clock.nowISO());
        if (iso) return iso;
      }
      if (clock.now) {
        const iso = toISO(clock.now);
        if (iso) return iso;
      }
    }
  } catch {
    /* 回退系统时间 */
  }
  return new Date().toISOString();
}

export function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, Number(ms) || 0));
    if (typeof timer?.unref === 'function') timer.unref();
  });
}

export function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const int = Math.trunc(num);
  return Math.min(max, Math.max(min, int));
}

export function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

/**
 * 分页读取全部记录。
 * store.list 单页最多 1000，after 为 ID 游标；游标不再前进时停止，避免死循环。
 */
export function listAll(store, kind, filter = {}, { pageSize = 1000, maxPages = 200 } = {}) {
  const rows = [];
  let after = null;
  let pages = 0;
  for (;;) {
    const params = { ...filter, limit: pageSize };
    if (after) params.after = after;
    const page = store.list(kind, params);
    if (!Array.isArray(page) || page.length === 0) break;
    rows.push(...page);
    pages += 1;
    const lastId = page[page.length - 1]?.id;
    if (!lastId || lastId === after) break;
    after = lastId;
    if (page.length < pageSize) break;
    if (pages >= maxPages) break;
  }
  return rows;
}

export function createLogger(logger) {
  const target = logger && typeof logger === 'object' ? logger : null;
  const bind = (level) => (message, meta) => {
    try {
      const fn = target?.[level];
      if (typeof fn === 'function') {
        fn.call(target, message, meta);
        return;
      }
      // 宿主可能只给一个日志函数（如 console.log），退化为单通道输出。
      if (typeof logger === 'function') logger(`[learning:${level}] ${message}`, meta);
    } catch {
      /* 日志失败不影响学习流程 */
    }
  };
  return { debug: bind('debug'), info: bind('info'), warn: bind('warn'), error: bind('error') };
}

export function errorSummary(error) {
  const code = asString(error?.code) || asString(error?.name) || 'ERROR';
  const message = limitText(error?.message ?? String(error ?? '未知错误'), 240);
  return { code, message };
}

export function scopeKind(scopeKey) {
  const text = asString(scopeKey);
  if (text.startsWith('group:')) return 'group';
  if (text.startsWith('private:')) return 'private';
  if (text.startsWith('profile:')) return 'profile';
  if (text === 'character' || text.startsWith('character:')) return 'character';
  return 'other';
}

/** 组合多个 AbortSignal；任一取消即整体取消。 */
export function linkSignals(...signals) {
  const present = signals.filter((item) => item && typeof item === 'object' && 'aborted' in item);
  if (present.length === 0) {
    return { signal: undefined, dispose() {} };
  }
  if (present.length === 1) {
    return { signal: present[0], dispose() {} };
  }
  const controller = new AbortController();
  const bindings = [];
  for (const signal of present) {
    const handler = () => {
      try {
        controller.abort(signal.reason);
      } catch {
        controller.abort();
      }
    };
    if (signal.aborted) {
      handler();
      continue;
    }
    signal.addEventListener('abort', handler, { once: true });
    bindings.push([signal, handler]);
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const [signal, handler] of bindings) {
        try {
          signal.removeEventListener('abort', handler);
        } catch {
          /* ignore */
        }
      }
    },
  };
}

/**
 * 执行一次可取消、可超时的异步调用（例如模型请求）。
 * 返回结构稳定，不向调用方抛异常，便于统一记账。
 */
export async function runCancelable(run, { signal, timeoutMs = 0 } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    try {
      controller.abort(signal.reason);
    } catch {
      controller.abort();
    }
  };
  if (signal && typeof signal === 'object') {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  let timer = null;
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
  }
  try {
    const value = await run(controller.signal);
    return { ok: true, value, timedOut, aborted };
  } catch (error) {
    return { ok: false, error, timedOut, aborted };
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && typeof signal === 'object') {
      try {
        signal.removeEventListener('abort', onAbort);
      } catch {
        /* ignore */
      }
    }
  }
}
