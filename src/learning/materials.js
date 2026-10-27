/**
 * 学习材料选择：从 event 记录中挑出“有效人类消息”。
 *
 * 契约：ingest 为有效 event 持久分配 conversationUnit；
 * 本模块仍自行做保守过滤（sourceKind / messageId / quoteRefs / control / 去重），
 * 交流段合并关系由调用方提供解析器，Session 不参与分段。
 *
 * 保守原则：
 * - 机器人发言、控制指令、空消息、纯引用转发不进门槛；
 * - 重复文本、转发链、已注入规则命中的内容不作为独立材料；
 * - 无法确认是连续交流时宁可少计证据。
 */

import {
  asString,
  normalizeSpaces,
  hashText,
  toISO,
  scopeKind,
  dayKey,
  MINUTE_MS,
  DAY_MS,
} from './util.js';

/** 允许作为人类学习材料的 sourceKind；未知类型一律保守排除。 */
const HUMAN_SOURCE_KINDS = new Set([
  'human',
  'user',
  'member',
  'friend',
  'private',
  'group',
  'group-member',
  'qq',
  'qq-message',
  'message',
]);

/** 明确不是人类新内容的来源。 */
const NON_HUMAN_SOURCE_KINDS = new Set([
  'bot',
  'robot',
  'assistant',
  'system',
  'control',
  'command',
  'admin-command',
  'summary',
  'digest',
  'forward',
  'quote',
  'recall',
  'inject',
  'injection',
  'memory',
  'rule',
  'bridge',
  'delivery',
]);

const EMPTY_MARKERS = new Set(['', '[图片]', '[表情]', '[语音]', '[视频]', '[文件]', '[卡片]', '[位置]', '[分享]']);

/** 控制指令特征：QQ 管理命令与普通消息的区分由上游 control 记录保证，这里再做一次文本兜底。 */
const CONTROL_PREFIXES = ['/记住', '/忘记', '/不要再这样说', '记住：', '忘记：', '不要再这样说'];

/**
 * 判断一条 event 是否可作为学习材料。
 * @returns {{ok: true, reason?: undefined} | {ok: false, reason: string}}
 */
export function classifyEvent(record, options = {}) {
  if (!record || record.kind !== 'event') return { ok: false, reason: 'not-event' };
  const data = record.data ?? {};
  if (record.status === 'deleted' || data.deleted === true) return { ok: false, reason: 'deleted' };
  if (data.effective !== true) return { ok: false, reason: 'not-effective' };
  if (data.control === true || data.kind === 'control') return { ok: false, reason: 'control' };

  const sourceKind = asString(data.sourceKind).toLowerCase();
  if (sourceKind) {
    if (NON_HUMAN_SOURCE_KINDS.has(sourceKind)) return { ok: false, reason: `source:${sourceKind}` };
    if (!HUMAN_SOURCE_KINDS.has(sourceKind)) return { ok: false, reason: `source-unknown:${sourceKind}` };
  }

  const senderQQ = asString(data.senderQQ);
  if (!senderQQ) return { ok: false, reason: 'no-sender' };
  const botQQ = asString(data.botQQ);
  if (botQQ && senderQQ === botQQ) return { ok: false, reason: 'self' };
  if (data.fromBot === true || data.bot === true) return { ok: false, reason: 'bot-flag' };

  const messageId = asString(data.messageId ?? record.id);
  if (!messageId) return { ok: false, reason: 'no-message-id' };

  const content = normalizeSpaces(data.content);
  if (EMPTY_MARKERS.has(content)) return { ok: false, reason: 'empty-content' };
  if (content && CONTROL_PREFIXES.some((prefix) => content.startsWith(prefix))) {
    return { ok: false, reason: 'control-text' };
  }

  // 纯引用转发：有引用且正文与引用文本一致 / 无自有正文。
  const quoteRefs = Array.isArray(data.quoteRefs) ? data.quoteRefs : [];
  if (quoteRefs.length > 0) {
    const quoted = normalizeSpaces(
      // 桥接的字符串引用是 message ID，不能当作引用正文比较。
      data.quoteText ?? quoteRefs.map((ref) => (typeof ref === 'object' ? ref?.text ?? '' : '')).join(' '),
    );
    if (!content && quoted) return { ok: false, reason: 'quote-only' };
    if (quoted && content && (quoted === content || quoted.includes(content))) {
      return { ok: false, reason: 'quote-repeat' };
    }
  }

  if (options.injectedHashes instanceof Set && content) {
    if (options.injectedHashes.has(hashText(content))) return { ok: false, reason: 'injected' };
  }

  const occurredAt = toISO(data.occurredAt ?? record.createdAt);
  if (!occurredAt) return { ok: false, reason: 'no-time' };

  return { ok: true };
}

/**
 * 从 event 记录集合中选出有效材料，按时间排序并附加去重/分段信息。
 *
 * 分段使用持久交流段及合并关系，不依赖 DSH Session。
 * 新事件按可配置的30分钟间隔分段；缺失段信息的旧资料保守按上海日归并。
 * 删除段首不拆段，迟到事件仅合并段，不创造额外证据。
 *
 * @param {Array} records event 记录
 * @param {object} options { injectedHashes }
 * @returns {{materials: Array, dropped: Array<{id: string, reason: string}>, stats: object}}
 */
export function selectMaterials(records, options = {}) {
  const accepted = [];
  const dropped = [];
  const seenMessageIds = new Set();
  const seenHashes = new Map();

  const sorted = [...(records ?? [])].sort((a, b) => {
    const left = toISO(a?.data?.occurredAt ?? a?.createdAt) ?? '';
    const right = toISO(b?.data?.occurredAt ?? b?.createdAt) ?? '';
    if (left === right) return String(a?.id).localeCompare(String(b?.id));
    return left < right ? -1 : 1;
  });

  for (const record of sorted) {
    const verdict = classifyEvent(record, options);
    if (!verdict.ok) {
      dropped.push({ id: record?.id ?? '', reason: verdict.reason });
      continue;
    }
    const data = record.data ?? {};
    const messageId = asString(data.messageId ?? record.id);
    if (seenMessageIds.has(messageId)) {
      dropped.push({ id: record.id, reason: 'duplicate-message-id' });
      continue;
    }
    seenMessageIds.add(messageId);

    const content = normalizeSpaces(data.content);
    const contentHash = hashText(content);
    const senderQQ = asString(data.senderQQ);
    const previous = seenHashes.get(contentHash);
    if (previous) {
      // 同文本5分钟内由同一人重复发送不增加材料；更久后的重复仍保留但标记。
      const delta = Math.abs(
        Date.parse(toISO(data.occurredAt ?? record.createdAt)) -
          Date.parse(toISO(previous.data?.occurredAt ?? previous.createdAt)),
      );
      if (previous.senderQQ === senderQQ && delta <= 5 * MINUTE_MS) {
        dropped.push({ id: record.id, reason: 'duplicate-text' });
        continue;
      }
    }
    const occurredAt = toISO(data.occurredAt ?? record.createdAt);
    seenHashes.set(contentHash, { id: record.id, senderQQ, data, createdAt: record.createdAt, occurredAt });

    accepted.push({
      id: record.id,
      record,
      messageId,
      senderQQ,
      content,
      contentHash,
      occurredAt,
      receivedAt: toISO(data.receivedAt ?? record.createdAt) ?? occurredAt,
      scopeKey: record.scopeKey,
      characterId: record.characterId,
      sourceKind: asString(data.sourceKind) || 'human',
      quoteRefs: Array.isArray(data.quoteRefs) ? data.quoteRefs : [],
      segments: Array.isArray(data.segments) ? data.segments : [],
      duplicateText: Boolean(previous),
    });
  }

  // 持久交流段仅会合并；旧资料缺少段信息时保守按日归并。
  for (const item of accepted) {
    item.evidenceUnitKey = item.record.data.conversationUnit ? (options.resolveUnit?.(item.record.data.conversationUnit)??item.record.data.conversationUnit) : `${scopeKind(item.scopeKey)}|${item.scopeKey}|legacy-day-${dayKey(item.occurredAt)}`;
  }

  const dayKeys = new Set(accepted.map((item) => dayKey(item.occurredAt)));
  return {
    materials: accepted,
    dropped,
    stats: {
      total: sorted.length,
      accepted: accepted.length,
      dropped: dropped.length,
      units: new Set(accepted.map((item) => item.evidenceUnitKey)).size,
      distinctDays: dayKeys.size,
      earliestAt: accepted[0]?.occurredAt ?? null,
      latestAt: accepted[accepted.length - 1]?.occurredAt ?? null,
      spanDays:
        accepted.length > 0
          ? Math.max(
              1,
              Math.floor((Date.parse(accepted[accepted.length - 1].occurredAt) - Date.parse(accepted[0].occurredAt)) / DAY_MS) + 1,
            )
          : 0,
    },
  };
}

/** 供提示模板使用的材料精简视图（不携带原始记录对象）。 */
export function toPromptMaterial(item, maxChars = 400) {
  const content = maxChars > 0 && item.content.length > maxChars ? `${item.content.slice(0, maxChars)}…` : item.content;
  return {
    id: item.id,
    messageId: item.messageId,
    senderQQ: item.senderQQ,
    occurredAt: item.occurredAt,
    scopeKey: item.scopeKey,
    unit: item.evidenceUnitKey,
    content,
  };
}
