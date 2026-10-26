/**
 * 证据、试用与采纳判定（S1–S6 / R1–R6）。
 *
 * 核心不变量：
 * - 同一段连续交流对同一候选只算一个证据单位；
 * - 同一来源消息不能对同一候选重复计证据；
 * - 日期按上海日界线去重；
 * - 注入不等于应用；只有已核验的实际应用计入 S4；
 * - 普通感谢、沉默、未投诉不算正向反馈；
 * - 回退后旧证据冻结（frozenEvidenceIds），重新采纳必须有新的独立支持；
 * - 人格每次只合并一项变化，且同一角色每 personalityIntervalDays 天最多一次。
 */

import { DomainError } from '../domain/core.js';
import { resolveConversationUnit } from '../domain/conversations.js';
import {
  KIND,
  dayKey,
  hashText,
  isoAdd,
  isoDiff,
  listAll,
  nowFrom,
  toISO,
  asString,
  normalizeSpaces,
  clampInt,
  DAY_MS,
} from './util.js';

export const CANDIDATE_STATUS = Object.freeze({
  collecting: 'active',
  trial: 'trial',
  accepted: 'accepted',
  paused: 'paused',
  rejected: 'rejected',
});

/**
 * 收集态状态集合：`active` 是引擎自己新建的候选，`pending` 是管理端手工创建的候选。
 * 两者都还会继续积累证据，不能与试用/采纳混淆。
 */
export const COLLECTING_STATUSES = Object.freeze(['active', 'pending']);

export function isCollectingStatus(status) {
  return COLLECTING_STATUSES.includes(String(status));
}

export const EVIDENCE_STATUS = Object.freeze({
  active: 'active',
  frozen: 'frozen',
  void: 'void',
});

export const TRIAL_STATUS = Object.freeze({
  running: 'running',
  passed: 'passed',
  failed: 'failed',
  cancelled: 'cancelled',
});

/** 普通感谢/沉默的判定用语；只用于“不算正向反馈”，不用于判定恶意。 */
const THANKS_PATTERN =
  /^(谢谢|谢谢你|谢啦|多谢|感谢|太感谢|thanks|thank you|thx|3q|ok|嗯+|好的?|收到|辛苦了|666)[\s!！。.,，~～]*$/iu;
const SILENCE_MARKERS = new Set(['', '（无回复）', '(无回复)', '[无回复]', 'silence', 'no-reply', '无回应']);

/**
 * 正向反馈分类。
 * 返回 positive 表示可作为明确支持；thanks / silence / neutral 都不计入 S6。
 * 注意：调用方已给出 positive 时，只有“纯感谢/沉默”才被降级，其余按 positive 保留。
 */
export function classifyFeedbackText(text) {
  const content = normalizeSpaces(text);
  if (SILENCE_MARKERS.has(content.toLowerCase())) return 'silence';
  if (content && THANKS_PATTERN.test(content)) return 'thanks';
  return 'positive';
}

/**
 * 记录一条反馈（候选维度）。
 * source 为可信的人类消息 event 记录或人工核验动作。
 *
 * R3：普通私聊用户的负向反馈只暂停“对该用户”的使用，不修改其他用户或整个角色。
 * 普通感谢、沉默、未投诉不算认可（counted=false）。
 */
export function recordFeedback(store, {
  candidateId,
  kind,
  text = '',
  sourceId = '',
  actor = 'qq',
  sourceQQ = '',
  at,
  reason = '',
}) {
  const candidate = store.get(candidateId);
  if (!candidate || candidate.kind !== KIND.candidate) {
    throw new DomainError('CANDIDATE_NOT_FOUND', `候选不存在：${candidateId}`, 404);
  }
  const normalizedKind = ['positive', 'negative', 'neutral'].includes(kind) ? kind : 'neutral';
  const effectiveKind = normalizedKind === 'positive' ? classifyFeedbackText(text) : normalizedKind;
  const counted = effectiveKind === 'positive';
  const qq = asString(sourceQQ);
  const record = store.create(
    KIND.feedback,
    {
      candidateId,
      kind: effectiveKind,
      rawKind: normalizedKind,
      text: normalizeSpaces(text).slice(0, 400),
      sourceId: asString(sourceId),
      sourceQQ: qq,
      actor: asString(actor) || 'qq',
      counted,
      // 普通用户反馈只对其本人生效；管理员/人工核验可标 scope='owner'。
      scope: qq && asString(actor) !== 'owner' ? 'user' : 'owner',
      reason: normalizeSpaces(reason).slice(0, 200),
      at: toISO(at),
    },
    { characterId: candidate.characterId, scopeKey: candidate.scopeKey, status: 'active', at },
  );
  const feedbackIds = Array.isArray(candidate.data?.feedbackIds) ? [...candidate.data.feedbackIds] : [];
  if (!feedbackIds.includes(record.id)) feedbackIds.push(record.id);
  const pausedForQQ = [...new Set([...(candidate.data?.pausedForQQ ?? [])].map(String).filter(Boolean))];
  if (counted === false && effectiveKind === 'negative' && qq && asString(actor) !== 'owner') {
    if (!pausedForQQ.includes(qq)) pausedForQQ.push(qq);
  }
  store.update(
    candidate.id,
    candidate.version,
    { data: { ...candidate.data, feedbackIds, pausedForQQ } },
    { at },
  );
  return { record, counted, kind: effectiveKind };
}

/**
 * 把材料折算成候选的证据增量；已冻结或用过的来源不再计入。
 *
 * 冻结口径（R6）：
 * - 学习引擎自己的冻结会把 evidence 记录状态改为 frozen；
 * - 管理端停用候选时只把 evidence ID 写进 candidate.data.frozenEvidenceIds，
 *   这里同样把这些记录对应的来源事件视为已冻结，避免重放复活旧证据。
 */
export function planEvidence(candidate, materials, options = {}) {
  const existing = options.existingEvidence ?? [];
  const usedSourceIds = new Set(existing.map((row) => asString(row.data?.sourceId)).filter(Boolean));
  const normalizeUnit=options.resolveUnit??(key=>key)
  const usedUnits = new Set(existing.map((row) => normalizeUnit(asString(row.data?.unitKey))).filter(Boolean));
  const frozenIds = new Set(
    (Array.isArray(candidate.data?.frozenEvidenceIds) ? candidate.data.frozenEvidenceIds : []).map(String),
  );
  const frozenSourceIds = new Set();
  for (const row of existing) {
    const isFrozenRow = row.status === EVIDENCE_STATUS.frozen || row.status === EVIDENCE_STATUS.void;
    if (isFrozenRow || frozenIds.has(String(row.id))) {
      const sourceId = asString(row.data?.sourceId);
      if (sourceId) frozenSourceIds.add(sourceId);
    }
  }
  const pick = [];
  const skipped = [];
  for (const material of materials ?? []) {
    if (!material?.id) {
      skipped.push({ sourceId: '', reason: 'no-id' });
      continue;
    }
    if (frozenSourceIds.has(material.id)) {
      skipped.push({ sourceId: material.id, reason: 'frozen' });
      continue;
    }
    if (usedSourceIds.has(material.id)) {
      skipped.push({ sourceId: material.id, reason: 'duplicate-source' });
      continue;
    }
    const unitKey = normalizeUnit(asString(material.evidenceUnitKey));
    if (!unitKey) {
      skipped.push({ sourceId: material.id, reason: 'no-unit' });
      continue;
    }
    if (usedUnits.has(unitKey)) {
      // 同一连续交流已经贡献过证据，不重复计数。
      skipped.push({ sourceId: material.id, reason: 'duplicate-unit' });
      continue;
    }
    usedSourceIds.add(material.id);
    usedUnits.add(unitKey);
    pick.push({
      sourceId: material.id,
      messageId: material.messageId,
      unitKey,
      day: dayKey(material.occurredAt),
      occurredAt: material.occurredAt,
      senderQQ: material.senderQQ,
      scopeKey: material.scopeKey,
      contentHash: material.contentHash,
    });
  }
  return { create: pick, skipped };
}

/** 在事务内落库证据；返回新记录。同一候选+来源唯一，重放不会新建，也不会复活已冻结的证据。 */
export function commitEvidence(store, candidate, planned, { at } = {}) {
  const created = [];
  for (const item of planned) {
    const evidenceId = `ev_${hashText(`${candidate.id}|${item.sourceId}`)}`;
    const existing = store.get(evidenceId);
    if (existing) continue;
    const record = store.create(
      KIND.evidence,
      {
        candidateId: candidate.id,
        sourceId: item.sourceId,
        messageId: item.messageId,
        unitKey: item.unitKey,
        day: item.day,
        occurredAt: item.occurredAt,
        senderQQ: item.senderQQ,
        role: 'support',
        scopeKey: item.scopeKey,
        contentHash: item.contentHash,
        addedAt: toISO(at),
      },
      {
        id: evidenceId,
        characterId: candidate.characterId,
        scopeKey: candidate.scopeKey,
        status: EVIDENCE_STATUS.active,
        at,
      },
    );
    created.push(record);
  }
  return created;
}

/** 读取某候选的全部证据（含冻结/暂停，便于审计；冻结与暂停都不参与达标计算）。 */
/** 读取某候选的全部证据（含冻结/暂停，便于审计；非 active 不参与达标计算）。 */
export function loadEvidence(store, candidateOrId) {
  const candidateId = typeof candidateOrId === 'string' ? candidateOrId : asString(candidateOrId?.id);
  if (!candidateId) return [];
  const characterId = typeof candidateOrId === 'string' ? '' : asString(candidateOrId?.characterId);
  const filter = {
    status: [EVIDENCE_STATUS.active, EVIDENCE_STATUS.frozen, EVIDENCE_STATUS.void, 'paused'],
  };
  if (characterId) filter.characterId = characterId;
  return listAll(store, KIND.evidence, filter).filter((row) => row.data?.candidateId === candidateId);
}

export function loadConflicts(store, candidateId) {
  return listAll(store, KIND.conflict, { status: 'active' }).filter(
    (row) => row.data?.candidateId === candidateId && row.data?.resolved !== true,
  );
}

export function loadTrials(store, candidateOrId) {
  const candidateId = typeof candidateOrId === 'string' ? candidateOrId : asString(candidateOrId?.id);
  if (!candidateId) return [];
  const characterId = typeof candidateOrId === 'string' ? '' : asString(candidateOrId?.characterId);
  const filter = { status: 'active' };
  if (characterId) filter.characterId = characterId;
  return listAll(store, KIND.trial, filter)
    .filter((row) => row.data?.candidateId === candidateId)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/**
 * 读取与某候选关联的反馈。
 *
 * 兼容两种写入形态：
 * - 学习引擎自己的 recordFeedback：data.candidateId + counted/kind；
 * - 宿主管理动作 feedback：data.targetId + sentiment + verified。
 * 两条路径都必须显式标注正向且已核验，才算“明确正向反馈”。
 */
export function loadCandidateFeedback(store, candidate) {
  const rows = listAll(store, KIND.feedback, { characterId: candidate.characterId, status: 'active' });
  return rows.filter((row) => {
    const data = row.data ?? {};
    const direct = asString(data.candidateId);
    if (direct === candidate.id) return true;
    const target = asString(data.targetId);
    if (target === candidate.id) return true;
    if (Array.isArray(data.targetIds) && data.targetIds.map(String).includes(candidate.id)) return true;
    return false;
  });
}

export function isCountedPositiveFeedback(row) {
  const data = row?.data ?? {};
  if (data.counted === true && data.kind === 'positive') return true;
  // 宿主管理端反馈：只接受明确 positive 且已核验的条目；普通感谢不会被标成 verified。
  if (data.sentiment === 'positive' && data.verified === true) {
    return classifyFeedbackText(data.text) === 'positive';
  }
  return false;
}

/**
 * 读取与某候选相关的应用记录。
 *
 * 兼容两种写入形态：
 * - 学习引擎自己的 recordApplication：data.candidateId；
 * - 宿主投递反馈 delivery → application：data.candidateIds/actualMatchIds（数组，可能待核验）。
 * 第二参数可传候选记录（推荐，可把查询限定到同一角色，避免全表扫描）。
 */
export function loadApplications(store, candidateOrId) {
  const candidateId = typeof candidateOrId === 'string' ? candidateOrId : asString(candidateOrId?.id);
  if (!candidateId) return [];
  const characterId = typeof candidateOrId === 'string' ? '' : asString(candidateOrId?.characterId);
  const filter = { status: ['active', 'pending', 'verified', 'injected'] };
  if (characterId) filter.characterId = characterId;
  return listAll(store, KIND.application, filter).filter((row) => {
    const data = row.data ?? {};
    if (asString(data.candidateId) === candidateId) return true;
    if (Array.isArray(data.candidateIds) && data.candidateIds.map(String).includes(candidateId)) return true;
    if (Array.isArray(data.actualMatchIds) && data.actualMatchIds.map(String).includes(candidateId)) return true;
    return false;
  });
}

/**
 * 汇总候选证据状态（纯计算，不做写入）。
 *
 * @returns {{
 *   units: number, days: number, dayList: string[], supportIds: string[],
 *   frozenIds: string[], contradictions: number, lastSupportAt: string|null,
 *   newSupportAfterTrial: number, countedPositiveFeedback: number
 * }}
 */
export function summarizeEvidence(store, candidate, options = {}) {
  const rows = options.evidence ?? loadEvidence(store, candidate);
  // 冻结有两种来源：证据记录本身被标 frozen，或候选记录里列出 frozenEvidenceIds（管理端停用）。
  // 两者都必须排除在达标计算之外，否则“停用后仍算达标”会绕过 R6。
  const frozenSet = new Set(
    (Array.isArray(candidate.data?.frozenEvidenceIds) ? candidate.data.frozenEvidenceIds : []).map(String),
  );
  const units = new Set();
  const days = new Set();
  const scopes = new Set();
  const supportIds = [];
  const frozenIds = [];
  let contradictions = 0;
  let lastSupportAt = null;
  for (const row of rows) {
    const frozenRow = row.status !== EVIDENCE_STATUS.active || frozenSet.has(String(row.id));
    if (frozenRow) {
      frozenIds.push(row.id);
      continue;
    }
    const data = row.data ?? {};
    if (data.role === 'contradiction') {
      contradictions += 1;
      continue;
    }
    if (data.unitKey) units.add(resolveConversationUnit(store,data.unitKey));
    if (data.day) days.add(data.day);
    if (data.scopeKey) scopes.add(data.scopeKey);
    supportIds.push(row.id);
    const at = toISO(data.occurredAt ?? row.createdAt);
    if (at && (!lastSupportAt || at > lastSupportAt)) lastSupportAt = at;
  }
  const frozenAll = new Set([...frozenSet, ...frozenIds]);
  // 试用后真实发生且新入库的独立支持；迟到旧消息不计。
  const trialStartedAt = toISO(candidate.data?.trialStartedAt);
  let newSupportAfterTrial = 0;
  if (trialStartedAt) {
    const freshUnits = new Set();
    const beforeUnits=new Set(rows.filter(row=>{const at=toISO(row.data?.occurredAt);return at && at<=trialStartedAt}).map(row=>resolveConversationUnit(store,row.data?.unitKey)))
    for (const row of rows) {
      if (row.status !== EVIDENCE_STATUS.active || row.data?.role==='contradiction') continue;
      if (frozenAll.has(String(row.id))) continue;
      const occurredAt=toISO(row.data?.occurredAt)
      if(!occurredAt || occurredAt<=trialStartedAt)continue
      const unit=resolveConversationUnit(store,row.data?.unitKey)
      if(beforeUnits.has(unit))continue
      const addedAt = toISO(row.data?.addedAt ?? row.createdAt);
      if (!addedAt || addedAt <= trialStartedAt) continue;
      freshUnits.add(unit);
    }
    newSupportAfterTrial = freshUnits.size;
  }

  const feedbackIds = Array.isArray(candidate.data?.feedbackIds) ? candidate.data.feedbackIds : [];
  const feedbackRows = new Set();
  for (const feedbackId of feedbackIds) {
    const record = store.get(feedbackId);
    if (record && record.kind === KIND.feedback) feedbackRows.add(record);
  }
  for (const row of loadCandidateFeedback(store, candidate)) feedbackRows.add(row);
  let countedPositiveFeedback = 0;
  for (const row of feedbackRows) {
    if (isCountedPositiveFeedback(row)) countedPositiveFeedback += 1;
  }

  return {
    units: units.size,
    days: days.size,
    dayList: [...days].sort(),
    scopeList: [...scopes].sort(),
    supportIds,
    frozenIds: [...frozenAll],
    contradictions,
    lastSupportAt,
    newSupportAfterTrial,
    countedPositiveFeedback,
  };
}

/** 试用进度汇总。 */
export function summarizeTrial(store, candidate, evidenceSummary, { at, config } = {}) {
  const trial = loadTrials(store, candidate).find((row) => row.data?.status === TRIAL_STATUS.running) ?? null;
  const trialStartedAt = toISO(trial?.data?.startedAt ?? candidate.data?.trialStartedAt);
  const trialDays = config?.evidence?.trialDays ?? 3;
  const now = toISO(at) ?? nowFrom();
  const trialEndsAt = trialStartedAt ? toISO(trial?.data?.endsAt) ?? isoAdd(trialStartedAt, trialDays * DAY_MS) : null;

  const applications = loadApplications(store, candidate);
  // 注入（applied=false / 未发送成功）不等于应用：只有“已实际应用且已核验”的记录计入 S4。
  // 兼容宿主 delivery→application 形态（successful=true 表示实际发出）与本模块 applied 标记。
  const isApplied = (row) => row.data?.applied === true || row.data?.successful === true;
  const isVerified = (row) => row.data?.verified === true;
  const seenMessages=new Set()
  const verified = applications.filter((row) => {
    const messageId=asString(row.data?.messageId || row.data?.replyId)
    const key=`${row.scopeKey}|${messageId}`
    if(!isApplied(row) || !isVerified(row) || !messageId || seenMessages.has(key))return false
    seenMessages.add(key);return true
  });
  const verifiedAfterTrial = verified.filter((row) => {
    const atValue = toISO(row.data?.sentAt || row.data?.appliedAt || row.createdAt);
    return Boolean(atValue) && Boolean(trialStartedAt) && atValue >= trialStartedAt;
  });
  const daysElapsed = trialStartedAt
    ? Math.max(0, Math.floor((Date.parse(now) - Date.parse(trialStartedAt)) / DAY_MS))
    : 0;

  return {
    trialId: trial?.id ?? '',
    startedAt: trialStartedAt,
    endsAt: trialEndsAt,
    daysElapsed,
    requiredDays: trialDays,
    timeMet: Boolean(trialStartedAt) && daysElapsed >= trialDays,
    requiredApplications: config?.evidence?.applications ?? 2,
    verifiedApplications: verifiedAfterTrial.length,
    injectedOnly: applications.filter((row) => !isApplied(row)).length,
    pendingVerification: applications.filter((row) => isApplied(row) && !isVerified(row)).length,
    applicationsMet: verifiedAfterTrial.length >= (config?.evidence?.applications ?? 2),
    evidenceSummary,
  };
}

/**
 * 完整评估一个候选：返回未满足项与建议跃迁。
 *
 * 这是 evaluate() 的实现基础，纯读 + 纯计算，不写库。
 */
export function evaluateCandidate(store, candidate, config, { at } = {}) {
  const now = toISO(at) ?? nowFrom();
  const evidenceSummary = summarizeEvidence(store, candidate);
  const trialSummary = summarizeTrial(store, candidate, evidenceSummary, { at: now, config });
  const conflicts = loadConflicts(store, candidate.id);

  const required = config.evidence;
  const unmet = [];
  const notes = [];

  const candidateStatus = candidate.status;
  const isPersonality = candidate.data?.type === 'personality';
  const autoAdopt = Boolean(config.features?.autoAdopt);
  const trialEnabled = Boolean(config.features?.trial);

  // 冲突（R1）：有未解决冲突一律不得自动采纳。
  if (conflicts.length > 0) {
    unmet.push({
      code: 'conflicts',
      message: `存在 ${conflicts.length} 个未解决冲突，自动采纳暂停`,
      detail: conflicts.map((row) => ({ id: row.id, summary: asString(row.data?.summary ?? row.data?.description) })),
    });
  }

  // 回退后（R6）：该变化的自动采纳保持暂停，旧证据已冻结，需人工恢复或全新支持。
  if (candidate.data?.autoAdoptPaused === true) {
    unmet.push({
      code: 'rollbackPaused',
      message: `回退后自动采纳已暂停：${asString(candidate.data?.rollbackReason) || '需人工确认重新启用'}`,
      detail: { rolledBackAt: toISO(candidate.data?.rolledBackAt) ?? '' },
    });
  }

  // S1/S2：独立单位与日期。已采纳候选不再展示“未满足”，改为只读信息。
  if (candidateStatus !== CANDIDATE_STATUS.accepted) {
    if (evidenceSummary.units < required.independentUnits) {
      unmet.push({
        code: 'independentUnits',
        message: `独立证据单位不足：${evidenceSummary.units}/${required.independentUnits}`,
        detail: { current: evidenceSummary.units, required: required.independentUnits },
      });
    }
    if (evidenceSummary.days < required.distinctDays) {
      unmet.push({
        code: 'distinctDays',
        message: `证据覆盖日期不足：${evidenceSummary.days}/${required.distinctDays}`,
        detail: { current: evidenceSummary.days, required: required.distinctDays, days: evidenceSummary.dayList },
      });
    }
  }

  // 正向反馈/新支持（S6 的明确支持）：普通感谢、沉默不计。
  const explicitSupport = evidenceSummary.countedPositiveFeedback > 0 || evidenceSummary.newSupportAfterTrial > 0;
  if (!explicitSupport && candidateStatus !== CANDIDATE_STATUS.accepted) {
    unmet.push({
      code: 'explicitSupport',
      message: '尚无明确正向反馈或新独立支持（感谢、沉默不计）',
      detail: {
        positiveFeedback: evidenceSummary.countedPositiveFeedback,
        newSupportAfterTrial: evidenceSummary.newSupportAfterTrial,
      },
    });
  }

  // S3/S4：试用时间与实际应用。
  if (candidateStatus !== CANDIDATE_STATUS.accepted) {
    if (!trialSummary.startedAt) {
      unmet.push({ code: 'trialNotStarted', message: '试用尚未开始', detail: { status: candidateStatus } });
    } else {
      if (!trialSummary.timeMet) {
        unmet.push({
          code: 'trialDays',
          message: `试用期未满：${trialSummary.daysElapsed}/${required.trialDays} 天`,
          detail: { startedAt: trialSummary.startedAt, endsAt: trialSummary.endsAt },
        });
      }
      if (!trialSummary.applicationsMet) {
        unmet.push({
          code: 'applications',
          message: `已核验实际应用不足：${trialSummary.verifiedApplications}/${required.applications}`,
          detail: {
            verified: trialSummary.verifiedApplications,
            injectedOnly: trialSummary.injectedOnly,
            pendingVerification: trialSummary.pendingVerification,
          },
        });
      }
    }
  }

  if (!trialEnabled && candidateStatus !== CANDIDATE_STATUS.accepted) {
    unmet.push({ code: 'trialDisabled', message: '试用功能未开启（features.trial=false）' });
  }
  if (!autoAdopt && candidateStatus !== CANDIDATE_STATUS.accepted) {
    unmet.push({ code: 'autoAdoptDisabled', message: '自动采纳未开启（features.autoAdopt=false）' });
  }

  // 人格（S5 / R4）：角色级、每 3 天一次、每次一项。
  let personality = null;
  if (isPersonality) {
    personality = evaluatePersonalityWindow(store, candidate, config, { at: now });
    if (!personality.canMerge) {
      unmet.push({
        code: 'personalityInterval',
        message: personality.reason,
        detail: personality.detail,
      });
    }
    if (candidate.scopeKey !== 'character') {
      unmet.push({
        code: 'personalityScope',
        message: '人格候选只能位于角色级（scopeKey=character）',
        detail: { scopeKey: candidate.scopeKey },
      });
    }
  }

  // 候选类型与范围一致性（群表达不自动跨群）。
  if (candidate.data?.type !== 'personality' && !String(candidate.scopeKey).startsWith('group:') && !String(candidate.scopeKey).startsWith('private:')) {
    unmet.push({
      code: 'candidateScopeInvalid',
      message: '表达/黑话/偏好候选必须绑定群或私聊范围',
      detail: { scopeKey: candidate.scopeKey },
    });
  }

  const evidenceReady =
    evidenceSummary.units >= required.independentUnits &&
    evidenceSummary.days >= required.distinctDays &&
    conflicts.length === 0;

  let transition = null;
  if (candidateStatus === CANDIDATE_STATUS.rejected || candidateStatus === CANDIDATE_STATUS.paused) {
    transition = null;
    notes.push(`候选处于 ${candidateStatus}，需人工处理或新证据才能继续`);
  } else if (candidateStatus === CANDIDATE_STATUS.accepted) {
    transition = null;
  } else if (isCollectingStatus(candidateStatus)) {
    if (evidenceReady && trialEnabled) transition = CANDIDATE_STATUS.trial;
  } else if (candidateStatus === CANDIDATE_STATUS.trial) {
    const canAdopt =
      unmet.length === 0 && trialSummary.timeMet && trialSummary.applicationsMet && evidenceReady && explicitSupport;
    if (canAdopt) transition = CANDIDATE_STATUS.accepted;
  }

  return {
    candidateId: candidate.id,
    type: candidate.data?.type ?? '',
    status: candidateStatus,
    rule: candidate.data?.rule ?? '',
    scopeKey: candidate.scopeKey,
    characterId: candidate.characterId,
    evidence: evidenceSummary,
    trial: trialSummary,
    conflicts: conflicts.map((row) => ({
      id: row.id,
      summary: asString(row.data?.summary ?? row.data?.description ?? row.data?.reason),
      createdAt: row.createdAt,
    })),
    personality,
    explicitSupport,
    unmet,
    canAdopt: unmet.length === 0 && transition === CANDIDATE_STATUS.accepted,
    canStartTrial: evidenceReady && trialEnabled && isCollectingStatus(candidateStatus),
    transition,
    notes,
    evaluatedAt: now,
  };
}

/**
 * 人格合并窗口：同一角色每 personalityIntervalDays 天最多一次，且每次只合并一项。
 */
export function evaluatePersonalityWindow(store, candidate, config, { at } = {}) {
  const now = toISO(at) ?? nowFrom();
  const intervalDays = config.evidence.personalityIntervalDays;
  const versions = listAll(store, KIND.personality, {
    characterId: candidate.characterId,
    status: ['active', 'superseded'],
  })
    // 只有“真正合并/恢复过人格”的版本参与 3 天窗口计算；
    // 初始角色卡等基线记录（无 adopted/restored/rollback 标记）不算一次合并。
    .filter(
      (row) =>
        row.data?.adopted === true ||
        row.data?.restored === true ||
        Boolean(row.data?.rollbackAt) ||
        Boolean(row.data?.restoredFrom) ||
        Boolean(asString(row.data?.restoredFromId)),
    )
    .sort((a, b) => {
      const left = String(b.data?.adoptedAt ?? b.createdAt);
      const right = String(a.data?.adoptedAt ?? a.createdAt);
      if (left === right) return String(b.id).localeCompare(String(a.id));
      return left < right ? -1 : 1;
    });
  const latest = versions[0] ?? null;
  const lastAdoptedAt = toISO(latest?.data?.adoptedAt ?? latest?.data?.rollbackAt ?? latest?.createdAt);
  const diffMs = lastAdoptedAt ? isoDiff(now, lastAdoptedAt) : null;
  const daysSince = diffMs === null ? null : diffMs / DAY_MS;
  const pendingPersonality = listAll(store, KIND.candidate, {
    characterId: candidate.characterId,
    status: [...COLLECTING_STATUSES, CANDIDATE_STATUS.trial, CANDIDATE_STATUS.accepted],
  }).filter((row) => row.data?.type === 'personality' && row.id !== candidate.id);

  // 已采纳但尚未生成人格版本的候选会阻塞下一次合并；已生成版本的不再阻塞（改为按时间窗口）。
  const acceptedThisWindow = pendingPersonality.filter(
    (row) => row.status === CANDIDATE_STATUS.accepted && !asString(row.data?.personalityVersionId),
  );

  let canMerge = true;
  let reason = '';
  if (lastAdoptedAt && daysSince !== null && daysSince < intervalDays) {
    canMerge = false;
    reason = `距上次人格合并仅 ${daysSince.toFixed(2)} 天，未满 ${intervalDays} 天`;
  }
  if (acceptedThisWindow.length > 0) {
    canMerge = false;
    reason = '已有采纳未合并的人格候选，需先完成该次合并';
  }
  const changeText = asString(candidate.data?.changes?.[0] ?? candidate.data?.personalityChange);
  // 一次人格合并只能含一项变化：changes 为空时按 1 项计（具体文本回退到 rule）。
  const rawChangeCount = Array.isArray(candidate.data?.changes) ? candidate.data.changes.length : 0;
  const changeCount = Math.max(1, rawChangeCount);
  if (changeCount > 1) {
    canMerge = false;
    reason = `人格候选包含 ${changeCount} 项变化，每次只能合并一项`;
  }
  return {
    canMerge,
    reason,
    lastAdoptedAt,
    daysSince,
    intervalDays,
    parentCandidateId: latest?.id ?? '',
    latestVersionId: latest?.id ?? '',
    pendingPersonalityCandidates: pendingPersonality.map((row) => row.id),
    change: changeText,
    changeCount,
    detail: { lastAdoptedAt, daysSince, intervalDays, pending: pendingPersonality.map((row) => row.id) },
  };
}

/**
 * 应用一次实际使用记录（注入 / 实际应用 / 核验分离）。
 *
 * applied=false 只是注入；只有 applied=true 且 verified=true 才算 S4 的一次实际应用。
 * 兼容宿主 delivery→application 的字段名（successful/sentAt），便于直接核验宿主记录。
 */
export function recordApplication(store, {
  candidateId,
  replyId = '',
  messageId = '',
  sessionId = '',
  scopeKey = '',
  applied = false,
  verified = false,
  verifiedBy = '',
  reason = '',
  at,
}) {
  const candidate = store.get(candidateId);
  if (!candidate || candidate.kind !== KIND.candidate) {
    throw new DomainError('CANDIDATE_NOT_FOUND', `候选不存在：${candidateId}`, 404);
  }
  const now = toISO(at) ?? nowFrom();
  const record = store.create(
    KIND.application,
    {
      candidateId,
      candidateIds: [candidateId],
      actualMatchIds: [candidateId],
      replyId: asString(replyId),
      messageId: asString(messageId),
      sessionId: asString(sessionId),
      scopeKey: asString(scopeKey) || candidate.scopeKey,
      applied: applied === true,
      successful: applied === true,
      verified: verified === true,
      verification: verified === true ? 'verified' : 'pending',
      verifiedAt: verified === true ? now : '',
      verifiedBy: asString(verifiedBy),
      reason: normalizeSpaces(reason).slice(0, 200),
      appliedAt: applied === true ? now : '',
      sentAt: applied === true ? now : '',
    },
    {
      characterId: candidate.characterId,
      scopeKey: candidate.scopeKey,
      status: applied === true ? 'active' : 'injected',
      at: now,
    },
  );
  return record;
}

/** 人工/自动核验既有应用记录。 */
export function verifyApplication(store, { id, verified = true, verifiedBy = '', at }) {
  const record = store.get(id);
  if (!record || record.kind !== KIND.application) {
    throw new DomainError('APPLICATION_NOT_FOUND', `应用记录不存在：${id}`, 404);
  }
  const now = toISO(at) ?? nowFrom();
  return store.update(
    id,
    record.version,
    {
      data: {
        ...record.data,
        verified: verified === true,
        verifiedAt: verified === true ? now : '',
        verifiedBy: asString(verifiedBy),
      },
    },
    { at: now },
  );
}

/** 开启试用（写 trial 记录并把候选状态推到 trial）。只允许从收集态进入。 */
export function startTrial(store, candidate, config, { at } = {}) {
  if (!isCollectingStatus(candidate.status)) {
    throw new DomainError(
      'CANDIDATE_STATE_INVALID',
      `候选当前状态 ${candidate.status} 不能开始试用`,
      409,
      { status: candidate.status },
    );
  }
  const now = toISO(at) ?? nowFrom();
  const trialDays = config.evidence.trialDays;
  const running = loadTrials(store, candidate).find((row) => row.data?.status === TRIAL_STATUS.running);
  if (running) {
    // 已经有进行中的试用：不重复创建，直接把候选同步到 trial 状态。
    return { trial: running, candidate };
  }
  const trial = store.create(
    KIND.trial,
    {
      candidateId: candidate.id,
      status: TRIAL_STATUS.running,
      startedAt: now,
      endsAt: isoAdd(now, trialDays * DAY_MS),
      requiredDays: trialDays,
      requiredApplications: config.evidence.applications,
      promptVersion: candidate.data?.promptVersion ?? '',
    },
    {
      characterId: candidate.characterId,
      scopeKey: candidate.scopeKey,
      status: 'active',
      at: now,
    },
  );
  const updated = store.update(
    candidate.id,
    candidate.version,
    {
      status: CANDIDATE_STATUS.trial,
      data: {
        ...candidate.data,
        trialStartedAt: now,
        trialId: trial.id,
      },
    },
    { at: now },
  );
  return { trial, candidate: updated };
}

/**
 * 回退：冻结旧证据（R6），并把候选打回 collecting 或 paused。
 * 旧证据不会被删除，但不再参与任何达标计算。
 */
export function freezeEvidence(store, candidate, { at, reason = '' } = {}) {
  const now = toISO(at) ?? nowFrom();
  const evidence = loadEvidence(store, candidate);
  const frozen = [];
  for (const row of evidence) {
    if (row.status !== EVIDENCE_STATUS.active) continue;
    store.update(row.id, row.version, { status: EVIDENCE_STATUS.frozen, data: { ...row.data, frozenAt: now, frozenReason: reason } }, { at: now });
    frozen.push(row.id);
  }
  const frozenEvidenceIds = [...new Set([...(candidate.data?.frozenEvidenceIds ?? []), ...frozen])];
  const updated = store.update(
    candidate.id,
    candidate.version,
    { data: { ...candidate.data, frozenEvidenceIds, frozenAt: now, frozenReason: reason } },
    { at: now },
  );
  return { candidate: updated, frozen };
}

/**
 * 采纳：写出范围规则（候选记录本身）并（仅人格）创建角色级版本。
 *
 * 普通表达/黑话/偏好候选只把自身状态改为 accepted；跨群由 scopeKey 隔离。
 * 人格候选必须 scopeKey=character，创建一个只含一项变化的新版本记录。
 */
export function acceptCandidate(store, candidate, config, { at, actor = 'learning' } = {}) {
  const now = toISO(at) ?? nowFrom();
  const isPersonality = candidate.data?.type === 'personality';
  let personality = null;

  if (isPersonality) {
    const window = evaluatePersonalityWindow(store, candidate, config, { at: now });
    if (!window.canMerge) {
      throw new DomainError('PERSONALITY_WINDOW_BLOCKED', window.reason || '人格合并窗口未满足', 409, window.detail);
    }
    const change =
      asString(candidate.data?.changes?.[0] ?? candidate.data?.personalityChange) ||
      asString(candidate.data?.rule);
    if (!change) {
      throw new DomainError('PERSONALITY_CHANGE_MISSING', '人格候选缺少具体变化描述', 400);
    }
    const parentId = window.latestVersionId;
    const parent = parentId ? store.get(parentId) : null;
    const snapshot = parent?.data?.snapshot
      ? { ...parent.data.snapshot }
      : { parentId: '', adoptedAt: '', changes: [] };
    const nextSnapshot = {
      ...snapshot,
      parentId,
      adoptedAt: now,
      changes: [...(Array.isArray(snapshot.changes) ? snapshot.changes : []), { at: now, change, candidateId: candidate.id }],
    };
    personality = store.create(
      KIND.personality,
      {
        parentId: parentId ?? '',
        changes: [change],
        changeCount: 1,
        snapshot: nextSnapshot,
        sourceCandidateIds: [...new Set([...(parent?.data?.sourceCandidateIds ?? []),candidate.id])],
        adopted: true,
        adoptedAt: now,
        adoptedBy: actor,
        personalityChange: change,
        promptVersion: candidate.data?.promptVersion ?? '',
      },
      { characterId: candidate.characterId, scopeKey: 'character', status: 'active', at: now },
    );
    // 新版本生效后，旧的活动版本转为 superseded：任何时刻只有一个“当前人格”。
    for (const row of listAll(store, KIND.personality, { characterId: candidate.characterId, status: 'active' })) {
      if (row.id === personality.id) continue;
      store.update(row.id, row.version, { status: 'superseded' }, { at: now });
    }
  }

  const updated = store.update(
    candidate.id,
    candidate.version,
    {
      status: CANDIDATE_STATUS.accepted,
      data: {
        ...candidate.data,
        acceptedAt: now,
        acceptedBy: actor,
        personalityVersionId: personality?.id ?? '',
      },
    },
    { at: now },
  );
  return { candidate: updated, personality };
}

/** 标记冲突（R1）：自动采纳暂停，双方来源留存。 */
export function recordConflict(store, candidate, { summary, sourceIds = [], at, kind = 'rule' } = {}) {
  const now = toISO(at) ?? nowFrom();
  const conflict = store.create(
    KIND.conflict,
    {
      candidateId: candidate.id,
      kind,
      summary: normalizeSpaces(summary).slice(0, 400),
      sourceIds: sourceIds.map(String),
      resolved: false,
      resolvedAt: '',
      resolution: '',
    },
    { characterId: candidate.characterId, scopeKey: candidate.scopeKey, status: 'active', at: now },
  );
  return conflict;
}

/** 新建候选（供引擎在提取成功后调用）；sourceIds 必须是原始 event 记录 ID。 */
export function createCandidate(store, {
  characterId,
  scopeKey,
  type,
  rule,
  context = '',
  sourceIds,
  confidence = 'low',
  personalityChange = '',
  meaning = '',
  promptVersion = '',
  schemaVersion = '',
  at,
}) {
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
    throw new DomainError('CANDIDATE_SOURCE_REQUIRED', '候选必须包含至少一个来源事件 ID', 400);
  }
  if (typeof rule !== 'string') {
    throw new DomainError('CANDIDATE_RULE_INVALID', 'candidate.rule 必须是字符串', 400);
  }
  const now = toISO(at) ?? nowFrom();
  const record = store.create(
    KIND.candidate,
    {
      type,
      rule,
      context,
      // 宿主按 matchType 判断“这条候选是否出现在实际发送文本里”，用于产生待核验的应用记录。
      matchType: type === 'personality' ? 'personality' : 'literal',
      meaning,
      personalityChange,
      changes: type === 'personality' && personalityChange ? [personalityChange] : [],
      scopeKind: type === 'personality' ? 'character' : scopeKey.startsWith('group:') ? 'group' : 'private',
      confidence,
      sourceIds: [...new Set(sourceIds.map(String))],
      originScopes: [...new Set(sourceIds.map(sourceId=>store.get(sourceId)?.scopeKey).filter(Boolean))],
      evidenceIds: [],
      feedbackIds: [],
      pausedForQQ: [],
      trialStartedAt: '',
      acceptedAt: '',
      frozenEvidenceIds: [],
      promptVersion,
      schemaVersion,
      createdAt: now,
      updatedAt: now,
    },
    { characterId, scopeKey, status: CANDIDATE_STATUS.collecting, at: now },
  );
  return record;
}

/**
 * 从材料为候选补证据（事务内调用）：不改变状态，只累加。
 * 返回增量摘要，供上层决定是否开试用。
 */
export function attachEvidence(store, candidate, materials, { at } = {}) {
  const existing = loadEvidence(store, candidate);
  const planned = planEvidence(candidate, materials, { existingEvidence: existing,resolveUnit:key=>resolveConversationUnit(store,key) });
  const created = commitEvidence(store, candidate, planned.create, { at });
  const evidenceIds = [...new Set([...(candidate.data?.evidenceIds ?? []), ...created.map((row) => row.id)])];
  const updated =
    created.length > 0
      ? store.update(
          candidate.id,
          candidate.version,
          { data: { ...candidate.data, evidenceIds, sourceIds:[...new Set([...(candidate.data.sourceIds??[]),...created.map(row=>row.data.sourceId)])], originScopes:[...new Set([...(candidate.data.originScopes??[]),...created.map(row=>row.data.scopeKey).filter(Boolean)])] } },
          { at },
        )
      : candidate;
  return { candidate: updated, created, skipped: planned.skipped };
}

/** 冲突解决后方可恢复自动采纳：清除冻结的冲突标记。 */
export function resolveConflict(store, conflictId, { resolution = '', at } = {}) {
  const record = store.get(conflictId);
  if (!record || record.kind !== KIND.conflict) {
    throw new DomainError('CONFLICT_NOT_FOUND', `冲突不存在：${conflictId}`, 404);
  }
  const now = toISO(at) ?? nowFrom();
  return store.update(
    conflictId,
    record.version,
    {
      data: {
        ...record.data,
        resolved: true,
        resolvedAt: now,
        resolution: normalizeSpaces(resolution).slice(0, 400),
      },
    },
    { at: now },
  );
}

/** 把候选关联的冲突批量视为未解决（供 evaluate 展示）。 */
export function unresolvedConflictCount(store, candidateId) {
  return loadConflicts(store, candidateId).length;
}

export function personalityIntervalDays(config) {
  return clampInt(config?.evidence?.personalityIntervalDays, 3, 365, 3);
}
