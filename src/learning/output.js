/**
 * 学习输出解析与严格校验。
 *
 * 核心要求（T7）：结构不完整、截断、来源缺失或范围不符时一律整批失败，
 * 不部分提交。校验在写事务内再进行一次，任何异常导致事务回滚。
 *
 * 本版（learning-output/2）：
 * - 只接受“完整对象”：不允许从解释性文字或截断片段里抠 JSON；
 * - 必填字段（summary/candidates/context/scopeKind/confidence）严格校验类型与长度，
 *   不静默截短、不补默认值；
 * - 新增可选 memories（联合记忆提炼），每条来源必须同批同角色同范围。
 */

import { LearningOutputError } from './util.js';
import { asString, hashText, isPlainObject, normalizeSpaces } from './util.js';
import {
  CANDIDATE_TYPES,
  CANDIDATE_SCOPE_KIND,
  MEMORY_TYPES,
  MAX_MEMORIES,
  MAX_MEMORY_TEXT_CHARS,
  PROMPT_VERSION,
  OUTPUT_SCHEMA_VERSION,
} from './prompts.js';

const MAX_CANDIDATES = 8;
const MAX_SOURCE_IDS = 12;
const MIN_RULE_CHARS = 2;
const MAX_RULE_CHARS = 400;
const MAX_SUMMARY_CHARS = 400;
const MAX_CONTEXT_CHARS = 400;
const MAX_MEANING_CHARS = 400;
const MAX_PERSONALITY_CHANGE_CHARS = 240;
const MAX_CONFLICT_CHARS = 240;
const MAX_CONFLICTS = 8;
const MAX_SUBJECT_CHARS = 20;

function invalid(code, message) {
  return new LearningOutputError(code, message);
}

/**
 * 从完整输出中取出 JSON 文本。
 *
 * 只接受两种形态：
 * - 整段就是一个 JSON 对象（首尾即 { }）；
 * - 整段被一对代码围栏完整包裹（围栏内容自身仍必须是完整对象）。
 *
 * 带解释前缀/后缀、或围栏未闭合（截断）一律拒绝，不做“猜字段”的修补。
 */
export function extractJSONText(text) {
  const raw = typeof text === 'string' ? text : '';
  let body = raw.replace(/^\uFEFF/u, '').trim();
  if (!body) throw invalid('LEARNING_EMPTY_OUTPUT', '模型输出为空');
  if (body.startsWith('```')) {
    if (body.length < 6 || !body.endsWith('```')) {
      throw invalid('LEARNING_OUTPUT_INCOMPLETE', '模型输出以代码围栏开头但未完整闭合，整批不应用');
    }
    let inner = body.slice(3, body.length - 3);
    // 去掉紧跟在开围栏后的语言标记（json / JSON / 空）。
    const firstLineEnd = inner.indexOf('\n');
    if (firstLineEnd >= 0) inner = inner.slice(firstLineEnd + 1);
    else inner = inner.replace(/^[a-zA-Z0-9_-]*/u, '');
    body = inner.trim();
  }
  if (!body.startsWith('{') || !body.endsWith('}')) {
    throw invalid(
      'LEARNING_OUTPUT_NOT_OBJECT',
      '模型输出（或其代码围栏内容）不是单个完整 JSON 对象，含解释文字或截断片段时整批不应用',
    );
  }
  return body;
}

export function parseLearningOutput(text) {
  const body = extractJSONText(text);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw invalid('LEARNING_OUTPUT_INVALID_JSON', `模型输出不是完整 JSON：${error.message}`);
  }
  if (!isPlainObject(parsed)) {
    throw invalid('LEARNING_OUTPUT_INVALID_SHAPE', '模型输出必须是 JSON 对象');
  }
  return parsed;
}

function scopeKindOf(scopeKey) {
  const text = typeof scopeKey === 'string' ? scopeKey : '';
  if (text === 'character') return 'character';
  if (text.startsWith('group:')) return 'group';
  if (text.startsWith('private:')) return 'private';
  return 'other';
}

/** 必填/受限字符串：必须是字符串，非空，长度在上限内；超长直接失败而非截短。 */
function strictText(value, { where, field, min = 0, max, code = 'LEARNING_OUTPUT_INVALID_TEXT' }) {
  if (typeof value !== 'string') {
    throw invalid(code, `${where}.${field} 必须是字符串`);
  }
  if (value.includes('\u0000')) throw invalid(code, `${where}.${field} 含非法字符`);
  const text = value.trim();
  if (text.length < min) throw invalid(code, `${where}.${field} 过短或为空`);
  if (Number.isFinite(max) && text.length > max) {
    throw invalid(code, `${where}.${field} 超过 ${max} 字符（不自动截短）`);
  }
  return text;
}

/** 可选字符串：缺省或空串视为未提供；出现则必须是不超长的字符串（超长失败，不截短）。 */
function optionalText(value, { where, field, max, code = 'LEARNING_OUTPUT_INVALID_TEXT' }) {
  if (value === undefined || value === null) return { present: false, text: '' };
  if (typeof value === 'string' && value.trim() === '') return { present: false, text: '' };
  return { present: true, text: strictText(value, { where, field, min: 1, max, code }) };
}

/** 校验来源 ID：必须是本批材料，且范围内合法。返回去重后的 id 与材料。 */
function readSources(rawSources, { where, materialById, type, scopeKey, characterId }) {
  if (!Array.isArray(rawSources) || rawSources.length === 0) {
    throw invalid('LEARNING_OUTPUT_NO_SOURCE', `${where}.sourceIds 缺失`);
  }
  if (rawSources.length > MAX_SOURCE_IDS) {
    throw invalid('LEARNING_OUTPUT_NO_SOURCE', `${where}.sourceIds 超过 ${MAX_SOURCE_IDS} 条`);
  }
  const sourceIds = [];
  const materials = [];
  for (const value of rawSources) {
    if (typeof value !== 'string' || !value.trim()) {
      throw invalid('LEARNING_OUTPUT_NO_SOURCE', `${where}.sourceIds 含非字符串或空值`);
    }
    const sourceId = value.trim();
    const material = materialById.get(sourceId);
    if (!material) {
      throw invalid('LEARNING_OUTPUT_SOURCE_UNKNOWN', `${where}.sourceIds 引用了本批之外的材料：${sourceId}`);
    }
    if (type === 'personality') {
      // 人格候选可来自同角色的群/私聊材料，但来源必须在本批内且属于同一角色。
      if (material.characterId && material.characterId !== characterId) {
        throw invalid('LEARNING_OUTPUT_SOURCE_CHARACTER', `${where} 引用了其它角色材料：${material.characterId}`);
      }
    } else if (material.scopeKey !== scopeKey) {
      throw invalid('LEARNING_OUTPUT_SOURCE_SCOPE', `${where} 引用了其它范围材料：${material.scopeKey}`);
    }
    if (!sourceIds.includes(sourceId)) {
      sourceIds.push(sourceId);
      materials.push(material);
    }
  }
  return { sourceIds, materials };
}

function validateCandidateItem(item, index, context) {
  const { materialById, scopeKey, characterId, batchScopeKind } = context;
  const where = `candidates[${index}]`;
  if (!isPlainObject(item)) throw invalid('LEARNING_OUTPUT_INVALID_SHAPE', `${where} 必须是对象`);

  if (typeof item.type !== 'string' || !CANDIDATE_TYPES.includes(item.type)) {
    throw invalid('LEARNING_OUTPUT_INVALID_TYPE', `${where}.type 非法：${String(item.type)}`);
  }
  const type = item.type;

  const rule = strictText(item.rule, {
    where,
    field: 'rule',
    min: MIN_RULE_CHARS,
    max: MAX_RULE_CHARS,
    code: 'LEARNING_OUTPUT_INVALID_RULE',
  });

  if (item.context === undefined || item.context === null) {
    throw invalid('LEARNING_OUTPUT_INVALID_CONTEXT', `${where}.context 缺失`);
  }
  const contextText = strictText(item.context, {
    where,
    field: 'context',
    min: 1,
    max: MAX_CONTEXT_CHARS,
    code: 'LEARNING_OUTPUT_INVALID_CONTEXT',
  });

  if (typeof item.scopeKind !== 'string' || !item.scopeKind.trim()) {
    throw invalid('LEARNING_OUTPUT_SCOPE_MISMATCH', `${where}.scopeKind 缺失`);
  }
  const scopeKind = item.scopeKind.trim();
  const allowedScopeKinds = CANDIDATE_SCOPE_KIND[type] ?? [];
  if (!allowedScopeKinds.includes(scopeKind)) {
    throw invalid('LEARNING_OUTPUT_SCOPE_MISMATCH', `${where}.scopeKind=${scopeKind} 不适用于 type=${type}`);
  }
  // 群表达不自动跨群：非人格候选必须与批次范围完全一致。
  if (type !== 'personality' && scopeKind !== batchScopeKind) {
    throw invalid('LEARNING_OUTPUT_SCOPE_MISMATCH', `${where} 试图把 ${batchScopeKind} 材料写成 ${scopeKind} 候选`);
  }

  if (typeof item.confidence !== 'string' || !['high', 'medium', 'low'].includes(item.confidence)) {
    throw invalid('LEARNING_OUTPUT_INVALID_CONFIDENCE', `${where}.confidence 必须是 high | medium | low`);
  }
  const confidence = item.confidence;

  const { sourceIds, materials } = readSources(item.sourceIds, {
    where,
    materialById,
    type,
    scopeKey,
    characterId,
  });

  const meaning = optionalText(item.meaning, {
    where,
    field: 'meaning',
    max: MAX_MEANING_CHARS,
  });
  const personalityChange = optionalText(item.personalityChange, {
    where,
    field: 'personalityChange',
    max: MAX_PERSONALITY_CHANGE_CHARS,
  });

  // 人格候选的具体变化：personalityChange 可选，缺省时由 rule 兜底（版本记录仍非空）。

  let conflicts = [];
  if (item.conflicts !== undefined && item.conflicts !== null) {
    if (!Array.isArray(item.conflicts)) {
      throw invalid('LEARNING_OUTPUT_INVALID_TEXT', `${where}.conflicts 必须是数组`);
    }
    if (item.conflicts.length > MAX_CONFLICTS) {
      throw invalid('LEARNING_OUTPUT_INVALID_TEXT', `${where}.conflicts 超过 ${MAX_CONFLICTS} 条`);
    }
    conflicts = item.conflicts.map((conflict, at) => {
      const text = strictText(conflict, {
        where: `${where}.conflicts[${at}]`,
        field: 'value',
        min: 1,
        max: MAX_CONFLICT_CHARS,
      });
      return normalizeSpaces(text);
    });
  }

  return {
    type,
    rule,
    context: contextText,
    scopeKind,
    confidence,
    sourceIds,
    materials,
    meaning: meaning.text,
    personalityChange: personalityChange.text,
    conflicts,
    ruleHash: hashText(`${type}|${rule.toLowerCase()}`),
  };
}

function validateMemoryItem(item, index, context) {
  const { materialById, scopeKey, characterId, batchSenders } = context;
  const where = `memories[${index}]`;
  if (!isPlainObject(item)) throw invalid('LEARNING_OUTPUT_INVALID_SHAPE', `${where} 必须是对象`);

  if (typeof item.type !== 'string' || !MEMORY_TYPES.includes(item.type)) {
    throw invalid('LEARNING_OUTPUT_INVALID_MEMORY_TYPE', `${where}.type 非法：${String(item.type)}`);
  }
  const type = item.type;
  const text = strictText(item.text, {
    where,
    field: 'text',
    min: 2,
    max: MAX_MEMORY_TEXT_CHARS,
    code: 'LEARNING_OUTPUT_INVALID_MEMORY_TEXT',
  });

  if (!Array.isArray(item.sourceIds) || item.sourceIds.length === 0) {
    throw invalid('LEARNING_OUTPUT_NO_SOURCE', `${where}.sourceIds 缺失`);
  }
  if (item.sourceIds.length > MAX_SOURCE_IDS) {
    throw invalid('LEARNING_OUTPUT_NO_SOURCE', `${where}.sourceIds 超过 ${MAX_SOURCE_IDS} 条`);
  }
  const sourceIds = [];
  const materials = [];
  const senders = new Set();
  for (const value of item.sourceIds) {
    if (typeof value !== 'string' || !value.trim()) {
      throw invalid('LEARNING_OUTPUT_NO_SOURCE', `${where}.sourceIds 含非字符串或空值`);
    }
    const sourceId = value.trim();
    const material = materialById.get(sourceId);
    if (!material) {
      throw invalid('LEARNING_OUTPUT_SOURCE_UNKNOWN', `${where}.sourceIds 引用了本批之外的材料：${sourceId}`);
    }
    // 联合记忆不允许跨角色、跨范围：所有来源必须同批同角色同范围。
    if (material.characterId && material.characterId !== characterId) {
      throw invalid('LEARNING_OUTPUT_SOURCE_CHARACTER', `${where} 引用了其它角色材料：${material.characterId}`);
    }
    if (material.scopeKey !== scopeKey) {
      throw invalid('LEARNING_OUTPUT_SOURCE_SCOPE', `${where} 引用了其它范围材料：${material.scopeKey}`);
    }
    if (!sourceIds.includes(sourceId)) {
      sourceIds.push(sourceId);
      materials.push(material);
    }
    const sender = asString(material.senderQQ);
    if (sender) senders.add(sender);
  }

  let subjectQQ = '';
  if (item.subjectQQ !== undefined && item.subjectQQ !== null && item.subjectQQ !== '') {
    const value = strictText(item.subjectQQ, {
      where,
      field: 'subjectQQ',
      min: 1,
      max: MAX_SUBJECT_CHARS,
      code: 'LEARNING_OUTPUT_INVALID_MEMORY_SUBJECT',
    });
    if (!/^[1-9]\d{0,19}$/u.test(value)) {
      throw invalid('LEARNING_OUTPUT_INVALID_MEMORY_SUBJECT', `${where}.subjectQQ 不是规范的 QQ 号`);
    }
    // subjectQQ 只能是本批真实发送者（优先用整批发送者集合），避免把第三人写成主体。
    const allowed = batchSenders && batchSenders.size > 0 ? batchSenders : senders;
    if (!allowed.has(value)) {
      throw invalid('LEARNING_OUTPUT_INVALID_MEMORY_SUBJECT', `${where}.subjectQQ 不在本批真实发送者中`);
    }
    subjectQQ = value;
  }

  return {
    type,
    text,
    sourceIds,
    materials,
    subjectQQ,
    // 稳定 hash：同角色 + 同范围 + 类型 + 规范化文本；用于跨批次去重，不覆盖人工记录。
    memoryKey: hashText(`${characterId}|${scopeKey}|${type}|${text.toLowerCase()}`),
  };
}

/**
 * 校验并规范化单批输出。
 *
 * @param {object} raw parseLearningOutput 结果
 * @param {object} context {materials, characterId, scopeKey, config}
 * @returns {{summary: string, candidates: Array, memories: Array, promptVersion: string, schemaVersion: string}}
 */
export function validateLearningOutput(raw, context) {
  const { materials, characterId, scopeKey } = context ?? {};
  const batchScopeKind = scopeKindOf(scopeKey);
  if (batchScopeKind !== 'group' && batchScopeKind !== 'private') {
    throw invalid('LEARNING_INVALID_SCOPE', `学习批次范围非法：${String(scopeKey)}`);
  }

  const materialById = new Map();
  for (const material of materials ?? []) {
    if (material?.id) materialById.set(material.id, material);
  }
  if (materialById.size === 0) {
    throw invalid('LEARNING_NO_MATERIALS', '学习批次没有可用材料');
  }

  const summary = strictText(raw.summary, {
    where: 'root',
    field: 'summary',
    min: 1,
    max: MAX_SUMMARY_CHARS,
    code: 'LEARNING_OUTPUT_INVALID_SUMMARY',
  });

  if (!Array.isArray(raw.candidates)) {
    throw invalid('LEARNING_OUTPUT_INVALID_SHAPE', '缺少 candidates 数组');
  }
  if (raw.candidates.length > MAX_CANDIDATES) {
    throw invalid('LEARNING_OUTPUT_TOO_LARGE', `候选数量 ${raw.candidates.length} 超过单批上限 ${MAX_CANDIDATES}`);
  }

  const itemContext = { materialById, scopeKey, characterId, batchScopeKind };
  // 本批真实发送者集合：subjectQQ 只能取其中之一，不能凭模型编造。
  const batchSenders = new Set();
  for (const material of materialById.values()) {
    const sender = asString(material?.senderQQ);
    if (sender) batchSenders.add(sender);
  }
  itemContext.batchSenders = batchSenders;
  const seenKeys = new Map();
  const candidates = [];

  for (let index = 0; index < raw.candidates.length; index += 1) {
    const candidate = validateCandidateItem(raw.candidates[index], index, itemContext);

    // 同一批内同一候选多条合并来源，保留更具体的上下文。
    const dedupeKey = `${candidate.type}|${candidate.scopeKind}|${candidate.rule.toLowerCase()}`;
    const existing = seenKeys.get(dedupeKey);
    if (existing) {
      for (const sourceId of candidate.sourceIds) {
        if (existing.sourceIds.includes(sourceId)) continue;
        existing.sourceIds.push(sourceId);
        const material = candidate.materials.find((item) => item.id === sourceId);
        if (material) existing.materials.push(material);
      }
      for (const conflict of candidate.conflicts) {
        if (!existing.conflicts.includes(conflict)) existing.conflicts.push(conflict);
      }
      if (candidate.confidence === 'high') existing.confidence = 'high';
      continue;
    }
    seenKeys.set(dedupeKey, candidate);
    candidates.push(candidate);
  }

  let memories = [];
  if (raw.memories !== undefined && raw.memories !== null) {
    if (!Array.isArray(raw.memories)) {
      throw invalid('LEARNING_OUTPUT_INVALID_SHAPE', 'memories 必须是数组');
    }
    if (raw.memories.length > MAX_MEMORIES) {
      throw invalid(
        'LEARNING_OUTPUT_TOO_LARGE',
        `记忆数量 ${raw.memories.length} 超过单批上限 ${MAX_MEMORIES}`,
      );
    }
    const seenMemory = new Set();
    for (let index = 0; index < raw.memories.length; index += 1) {
      const memory = validateMemoryItem(raw.memories[index], index, itemContext);
      // 同批内同 hash 只保留一条（来源以第一条为准，不静默并入其它条目）。
      if (seenMemory.has(memory.memoryKey)) continue;
      seenMemory.add(memory.memoryKey);
      memories.push(memory);
    }
  }

  return {
    summary,
    candidates,
    memories,
    promptVersion: PROMPT_VERSION,
    schemaVersion: OUTPUT_SCHEMA_VERSION,
  };
}

/** 完整的“解析 + 校验”流程；finish 非 stop 直接视为截断失败。 */
export function readLearningResult(generated, context) {
  const finish = asString(generated?.finish);
  if (finish !== 'stop') {
    throw invalid('LEARNING_TRUNCATED', `模型未正常完成（finish=${finish || 'unknown'}），整批不应用`);
  }
  if (typeof generated?.text !== 'string') {
    throw invalid('LEARNING_OUTPUT_INVALID_SHAPE', '模型输出缺少文本内容');
  }
  const raw = parseLearningOutput(generated.text);
  return validateLearningOutput(raw, context);
}
