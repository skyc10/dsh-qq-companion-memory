/**
 * 人格版本与回退（S5 / R5 / R6）。
 *
 * 规则：
 * - 人格版本只存在于角色级（scopeKey=character），群表达不自动跨群；
 * - 每次合并只允许一项具体变化，保留父版本、差异与前后快照；
 * - 回退创建新的恢复版本，保留历史，不删除事实记忆或共同经历；
 * - 回退后冻结旧证据，并暂停该变化的自动采纳（R6）。
 */

import { DomainError } from '../domain/core.js';
import {
  KIND,
  asString,
  errorSummary,
  isoAdd,
  listAll,
  normalizeSpaces,
  nowFrom,
  toISO,
  DAY_MS,
} from './util.js';
import { CANDIDATE_STATUS, freezeEvidence, loadTrials } from './evidence.js';

/** 读取某角色的人格版本链（新到旧），含已被取代的版本以便审计与回退。 */
export function listPersonalityVersions(store, characterId, { limit = 200 } = {}) {
  return listAll(store, KIND.personality, { characterId, status: ['active', 'superseded'] })
    .sort((a, b) => {
      const left = String(b.data?.adoptedAt ?? b.createdAt);
      const right = String(a.data?.adoptedAt ?? a.createdAt);
      if (left === right) return String(b.id).localeCompare(String(a.id));
      return left < right ? -1 : 1;
    })
    .slice(0, limit);
}

/** 当前生效的人格版本（最新且仍 active 的 adopted/restored 版本）。 */
export function currentPersonalityVersion(store, characterId) {
  const versions = listPersonalityVersions(store, characterId);
  return (
    versions.find(
      (row) => row.status === 'active' && (row.data?.adopted === true || row.data?.restored === true),
    ) ??
    versions.find((row) => row.status === 'active') ??
    versions[0] ??
    null
  );
}

/** 差异视图：给管理页展示“从父版本到本版本”的具体变化。 */
export function personalityDiff(store, versionId) {
  const record = store.get(versionId);
  if (!record || record.kind !== KIND.personality) {
    throw new DomainError('PERSONALITY_NOT_FOUND', `人格版本不存在：${versionId}`, 404);
  }
  const parentId = asString(record.data?.parentId);
  const parent = parentId ? store.get(parentId) : null;
  return {
    id: record.id,
    characterId: record.characterId,
    parentId,
    parentVersionId: parentId || '',
    changes: Array.isArray(record.data?.changes) ? record.data.changes : [],
    changeCount: Number(record.data?.changeCount ?? 1),
    adoptedAt: toISO(record.data?.adoptedAt) ?? record.createdAt,
    sourceCandidateIds: Array.isArray(record.data?.sourceCandidateIds) ? record.data.sourceCandidateIds : [],
    snapshotBefore: parent?.data?.snapshot ?? null,
    snapshotAfter: record.data?.snapshot ?? null,
    restored: record.data?.restored === true,
    restoredFromId: asString(record.data?.restoredFromId),
  };
}

/**
 * 回退到指定人格版本：创建恢复版本（不覆盖历史），冻结原候选证据并暂停自动采纳。
 *
 * @returns {{version: object, frozenCandidates: Array, restoredFrom: object|null}}
 */
export function rollbackPersonality(store, options={}) {
  return store.tx(()=>rollbackPersonalityVersion(store,options))
}
function rollbackPersonalityVersion(store, {
  characterId,
  versionId = '',
  reason = '',
  actor = 'owner',
  at,
} = {}) {
  const now = toISO(at) ?? nowFrom();
  if (!characterId) throw new DomainError('CHARACTER_REQUIRED', '回退人格必须指定角色', 400);

  const versions = listPersonalityVersions(store, characterId);
  const current = currentPersonalityVersion(store, characterId);
  // 未显式指定版本时回退到“当前版本的父版本”；没有父版本则视为回到初始状态。
  const currentParentId = asString(current?.data?.parentId);
  const target = versionId
    ? store.get(versionId)
    : (currentParentId ? store.get(currentParentId) : null) ?? versions[1] ?? null;
  if (versionId && (!target || target.kind !== KIND.personality)) {
    throw new DomainError('PERSONALITY_NOT_FOUND', `人格版本不存在：${versionId}`, 404);
  }
  if (target && target.characterId !== characterId) {
    throw new DomainError('PERSONALITY_CHARACTER_MISMATCH', '人格版本与角色不匹配', 409);
  }

  const baseSnapshot = target?.data?.snapshot ?? { parentId: '', adoptedAt: '', changes: [] };
  const restoreSnapshot = {
    ...baseSnapshot,
    restoredAt: now,
    restoredFromId: target?.id ?? '',
    changes: Array.isArray(baseSnapshot.changes) ? [...baseSnapshot.changes] : [],
  };
  const changes = normalizeSpaces(reason)
    ? [`回退：${normalizeSpaces(reason).slice(0, 200)}`]
    : [`回退到 ${target ? asString(target.data?.adoptedAt) || target.id : '初始状态'}`];

  const version = store.create(
    KIND.personality,
    {
      parentId: current?.id ?? '',
      changes,
      changeCount: 1,
      snapshot: restoreSnapshot,
      sourceCandidateIds: [...(target?.data?.sourceCandidateIds ?? [])],
      adopted: true,
      adoptedAt: now,
      adoptedBy: asString(actor) || 'owner',
      restored: true,
      restoredFromId: target?.id ?? '',
      rollbackReason: normalizeSpaces(reason).slice(0, 400),
    },
    { characterId, scopeKey: 'character', status: 'active', at: now },
  );
  // 恢复版本生效后，其余活动版本转为 superseded，保证只有一个“当前人格”。
  for (const row of listAll(store, KIND.personality, { characterId, status: 'active' })) {
    if (row.id === version.id) continue;
    store.update(row.id, row.version, { status: 'superseded' }, { at: now });
  }

  // R6：冻结被回退版本的支持证据，并暂停对应候选的自动采纳；旧证据不能立即再次触发。
  const frozenCandidates = [];
  const retainedIds=new Set(target?.data?.sourceCandidateIds ?? [])
  const sourceCandidateIds = new Set((current?.data?.sourceCandidateIds ?? []).filter(candidateId=>!retainedIds.has(candidateId)));
  for (const candidateId of sourceCandidateIds) {
    const candidate = store.get(candidateId);
    if (!candidate || candidate.kind !== KIND.candidate) continue;
    try {
      const frozen = freezeEvidence(store, candidate, { at: now, reason: `rollback:${version.id}` });
      const trials = loadTrials(store, candidate);
      for (const trial of trials) {
        if (trial.data?.status !== 'running') continue;
        store.update(
          trial.id,
          trial.version,
          { data: { ...trial.data, status: 'cancelled', cancelledAt: now, cancelReason: 'rollback' } },
          { at: now },
        );
      }
      store.update(
        frozen.candidate.id,
        frozen.candidate.version,
        {
          status: fixedPausedStatus(frozen.candidate),
          data: {
            ...frozen.candidate.data,
            autoAdoptPaused: true,
            rolledBackAt: now,
            rollbackReason: normalizeSpaces(reason).slice(0, 400),
            personalityVersionId: version.id,
          },
        },
        { at: now },
      );
      frozenCandidates.push({ candidateId: candidate.id, frozenEvidence: frozen.frozen.length });
    } catch (error) {
      // 任一候选冻结失败让外层事务整体回滚。
      store.audit?.(
        asString(actor) || 'owner',
        'learning.rollback.freeze-failed',
        candidate.id,
        null,
        null,
        `freeze failed: ${errorSummary(error).message}`,
        '',
      );
      throw error
    }
  }

  // 当前生效版本的支持候选已在上面统一冻结并暂停；这里不再重复处理。

  return {
    version,
    frozenCandidates,
    restoredFrom: target ? { id: target.id, adoptedAt: toISO(target.data?.adoptedAt) ?? target.createdAt } : null,
  };
}

function fixedPausedStatus(candidate) {
  if (candidate.status === CANDIDATE_STATUS.accepted || candidate.status === CANDIDATE_STATUS.trial) {
    return CANDIDATE_STATUS.paused;
  }
  return candidate.status;
}

/**
 * 单条候选回退：不删除候选，冻结证据并回到收集态，等待新支持（或被人工驳回）。
 * 用于 R5 的“单条”粒度。
 */
export function rollbackCandidate(store,options={}){return store.tx(()=>rollbackCandidateChange(store,options))}
function rollbackCandidateChange(store, { candidateId, reason = '', actor = 'owner', at } = {}) {
  const now = toISO(at) ?? nowFrom();
  const candidate = store.get(candidateId);
  if (!candidate || candidate.kind !== KIND.candidate) {
    throw new DomainError('CANDIDATE_NOT_FOUND', `候选不存在：${candidateId}`, 404);
  }
  const frozen = freezeEvidence(store, candidate, { at: now, reason: `rollback-candidate:${asString(reason)}` });
  const trials = loadTrials(store, candidate);
  for (const trial of trials) {
    if (trial.data?.status !== 'running') continue;
    store.update(
      trial.id,
      trial.version,
      { data: { ...trial.data, status: 'cancelled', cancelledAt: now, cancelReason: 'rollback-candidate' } },
      { at: now },
    );
  }
  const updated = store.update(
    frozen.candidate.id,
    frozen.candidate.version,
    {
      status: CANDIDATE_STATUS.collecting,
      data: {
        ...frozen.candidate.data,
        autoAdoptPaused: true,
        rolledBackAt: now,
        rollbackReason: normalizeSpaces(reason).slice(0, 400),
        trialStartedAt: '',
        acceptedAt: '',
      },
    },
    { at: now },
  );
  let personalityVersion=null
  const current=currentPersonalityVersion(store,candidate.characterId)
  if(candidate.data.type==='personality' && (current?.data?.sourceCandidateIds??[]).includes(candidate.id)){
    const snapshot=current.data.snapshot??{}
    personalityVersion=store.create(KIND.personality,{parentId:current.id,changes:[`撤回：${candidate.data.rule}`],changeCount:1,snapshot:{...snapshot,changes:(snapshot.changes??[]).filter(change=>change?.candidateId!==candidate.id),restoredAt:now},sourceCandidateIds:current.data.sourceCandidateIds.filter(sourceId=>sourceId!==candidate.id),adopted:true,restored:true,adoptedAt:now,restoredFromId:current.id,rollbackCandidateId:candidate.id,rollbackReason:normalizeSpaces(reason).slice(0,400)},{characterId:candidate.characterId,scopeKey:'character',status:'active',at:now})
    for(const row of listAll(store,KIND.personality,{characterId:candidate.characterId,status:'active'}))if(row.id!==personalityVersion.id)store.update(row.id,row.version,{status:'superseded'},{at:now})
  }
  return { candidate: updated, frozen: frozen.frozen,personalityVersion };
}

/**
 * 批次回退：一组候选（同一次学习产出）一起回退。
 * 与单条回退语义一致，只是把批量结果汇总返回。
 */
export function rollbackBatch(store, { candidateIds, reason = '', actor = 'owner', at } = {}) {
  const results = [];
  const errors = [];
  for (const candidateId of candidateIds ?? []) {
    try {
      results.push(rollbackCandidate(store, { candidateId, reason, actor, at }));
    } catch (error) {
      errors.push({ candidateId, error: errorSummary(error) });
    }
  }
  return { rolledBack: results, errors };
}

/** 恢复自动采纳：需显式管理动作（回退后不会自动恢复）。 */
export function resumeAutoAdopt(store, candidateId, { at, reason = '' } = {}) {
  const candidate = store.get(candidateId);
  if (!candidate || candidate.kind !== KIND.candidate) {
    throw new DomainError('CANDIDATE_NOT_FOUND', `候选不存在：${candidateId}`, 404);
  }
  const now = toISO(at) ?? nowFrom();
  for(const trial of loadTrials(store,candidate))if(trial.data.status==='running')store.update(trial.id,trial.version,{data:{...trial.data,status:'cancelled',cancelledAt:now,cancelReason:'manual-resume'}},{at:now})
  return store.update(
    candidateId,
    candidate.version,
    {
      status: CANDIDATE_STATUS.collecting,
      data: {
        ...candidate.data,
        trialStartedAt:'',trialId:'',acceptedAt:'',
        autoAdoptPaused: false,
        resumedAt: now,
        resumeReason: normalizeSpaces(reason).slice(0, 400),
      },
    },
    { at: now },
  );
}

/** 下一次允许人格合并的时点（供管理页提示）；间隔下限固定为 3 天。 */
export function nextPersonalityWindow(store, characterId, intervalDays) {
  const current = currentPersonalityVersion(store, characterId);
  const adoptedAt = toISO(current?.data?.adoptedAt ?? current?.data?.rollbackAt ?? current?.createdAt);
  if (!adoptedAt) return { allowedNow: true, nextAt: '', lastAdoptedAt: '' };
  const days = Math.max(3, Number(intervalDays) || 3);
  const nextAt = isoAdd(adoptedAt, days * DAY_MS);
  return { allowedNow: Date.parse(nextAt) <= Date.now(), nextAt, lastAdoptedAt: adoptedAt };
}
