import { normalizeMemory, registerMemoryConflicts } from '../domain/memory.js'
import { DomainError, assertOwner, active, canonicalScope, digest, requireText, version, qq } from '../domain/core.js'
import { CANDIDATE_SCOPE_KIND } from '../learning/prompts.js'

const DELETABLE = new Set(['character','event','evidence','memory','profile','supplement','share','candidate','conflict','feedback'])
const EDITABLE = new Set(['memory','profile','supplement','candidate','conflict','feedback','personality','character','control'])
export function createManagement(service) {
  const { store, config, clock } = service
  const dependencies = {}; const attach = value => Object.assign(dependencies, value)
  const get = (payload, deleted = false) => {
    const row = store.get(requireText(payload.id, '目标 ID', 300), { includeDeleted: deleted })
    if (!row) throw new DomainError('NOT_FOUND', '目标不存在', 404)
    version(payload.expectedVersion)
    if (row.version !== payload.expectedVersion) throw new DomainError('VERSION_CONFLICT', '目标版本已改变', 409, { currentVersion: row.version })
    return row
  }
  const invalidate = (source, reason, visited = new Set()) => {
    if (visited.has(source.id)) return
    visited.add(source.id)
    for (const kind of ['memory','profile','supplement','candidate','evidence','personality','share','trial','application','feedback','conflict']) for (const row of store.scan(kind, { characterId: source.characterId })) {
      if(visited.has(row.id))continue
      const refs = [...(row.data.sourceIds ?? []), ...(row.data.evidenceIds ?? []), ...(row.data.sourceCandidateIds ?? []), ...(row.data.candidateIds ?? []), row.data.sourceId, row.data.candidateId, row.data.targetId, ...(row.data.targetIds ?? [])].filter(Boolean)
      if (refs.includes(source.id) && (active(row) || reason === 'source-deleted' && row.status !== 'deleted')) {
        if (kind === 'share' && reason === 'source-edited') {
          const latest = store.get(source.id)
          const available = (row.data.fields ?? []).every(field => typeof latest?.data[field] === 'string')
          store.update(row.id, row.version, { status: available ? 'active' : 'paused', data: { ...row.data, sourceVersion: latest.version, ...(available ? {} : { invalidationReason: 'shared-field-removed' }) } })
          continue
        }
        const data=reason==='source-deleted' ? {sourceIds:refs,sourceId:row.data.sourceId,candidateIds:row.data.candidateIds,sourceCandidateIds:row.data.sourceCandidateIds,messageId:row.data.messageId,sentAt:row.data.sentAt,redactedAt:clock()} : row.data
        const updated = store.update(row.id, row.version, { status: 'paused', data: { ...data, invalidatedBy: source.id, invalidationReason: reason } })
        if(reason==='source-deleted')store.db.prepare('DELETE FROM record_versions WHERE record_id=?').run(row.id)
        invalidate(updated, reason, visited)
      }
    }
  }
  const validateSources = (data, characterId, scopeKey) => {
    if (!Array.isArray(data.sourceIds)) return
    for (const sourceId of data.sourceIds) {
      const source = store.get(sourceId)
      const sameScope = source?.scopeKey === scopeKey
      const publicProfile = scopeKey.startsWith('profile:') && data.originScope === source?.scopeKey && data.originScope?.startsWith('group:') && source?.subjectQQ === scopeKey.slice(8)
      const characterSource=scopeKey==='character' && /^(private|group):/.test(source?.scopeKey??'')
      if (!active(source) || source.characterId !== characterId || (!sameScope && !publicProfile && !characterSource)) throw new DomainError('INVALID_SOURCE', '来源须为同角色同范围，或该成员经确认的群来源')
    }
  }
  const normalizeProfile = data => {
    if (data.originScope != null && typeof data.originScope !== 'string') throw new DomainError('INVALID_PROFILE', '档案来源范围须为文本')
    if (data.originScope?.startsWith('group:')) {
      canonicalScope(data.originScope)
      data.visibility = 'public-profile'
    } else data.visibility = 'private'
  }
  const normalizeCandidate = (data, scopeKey) => {
    const scopeKind = scopeKey === 'character' ? 'character' : scopeKey.split(':')[0]
    if (!Object.hasOwn(CANDIDATE_SCOPE_KIND, data.type) || !CANDIDATE_SCOPE_KIND[data.type].includes(scopeKind)) throw new DomainError('INVALID_CANDIDATE_SCOPE', '表达用于群/私聊，黑话用于群，偏好用于私聊，人格用于角色级')
    data.rule = requireText(data.rule ?? data.text ?? data.summary ?? data.content, '候选规则', 50000)
    data.matchType = data.type === 'personality' ? 'personality' : 'literal'
    data.scopeKind = scopeKind
    data.originScopes = [...new Set((data.sourceIds ?? []).map(id => store.get(id)?.scopeKey).filter(Boolean))]
  }
  const create = payload => {
    if (!EDITABLE.has(payload.kind) || payload.kind === 'personality') throw new DomainError('INVALID_KIND', '此实体须通过专用操作创建')
    const characterId = requireText(payload.characterId, '角色 ID', 200)
    if (payload.kind !== 'character' && !active(store.get(characterId))) throw new DomainError('INVALID_CHARACTER', '请先创建角色')
    const scopeKey = payload.scopeKey === 'character' && (['character','control'].includes(payload.kind) || payload.kind==='candidate' && payload.data?.type==='personality') ? 'character' : canonicalScope(payload.scopeKey)
    const subjectQQ = payload.subjectQQ ? qq(payload.subjectQQ) : ''
    const data = structuredClone(payload.data ?? {})
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new DomainError('INVALID_DATA', 'data 必须是对象')
    if (payload.kind === 'profile') {
      if (!subjectQQ || scopeKey !== `profile:${subjectQQ}`) throw new DomainError('INVALID_PROFILE', '档案须指定真实 QQ，范围为 profile:QQ')
      normalizeProfile(data)
      data.confirmed = true
    }
    if (payload.kind === 'supplement' && (!scopeKey.startsWith('group:') || !subjectQQ)) throw new DomainError('INVALID_SUPPLEMENT', '群内补充须指定群范围及成员 QQ')
    validateSources(data, characterId, scopeKey)
    if (!['character','control'].includes(payload.kind)) requireText(data.text ?? data.rule ?? data.summary ?? data.content, '条目内容', 50000)
    if (payload.kind === 'candidate') {
      data.evidenceIds ??= []; data.sourceIds ??= []; data.manual = true
      if (!Array.isArray(data.sourceIds)) throw new DomainError('INVALID_SOURCE', '候选来源须为记录 ID 数组')
      normalizeCandidate(data,scopeKey)
    }
    if(['memory','profile','supplement'].includes(payload.kind))normalizeMemory(data,{store,characterId,scopeKey,subjectQQ})
    const row=store.create(payload.kind, data, { characterId, scopeKey, subjectQQ, status: 'active', ...(payload.kind === 'character' ? { id: characterId } : {}) })
    registerMemoryConflicts(store,row,clock())
    return row
  }
  function mutate(action, payload, actor) {
    const before = ['create','feedback','takeover','rollbackBatch'].includes(action) ? null : get(payload, action === 'undo')
    let after
    switch (action) {
      case 'create': after = create(payload); break
      case 'edit': {
        if (!EDITABLE.has(before.kind)) throw new DomainError('IMMUTABLE', '此类记录不可编辑')
        if (before.kind === 'personality') throw new DomainError('USE_ROLLBACK', '人格版本不可改写，请使用回退或新候选')
        const data = structuredClone(payload.data)
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new DomainError('INVALID_DATA', 'data 必须是对象')
        if (before.kind === 'profile') normalizeProfile(data)
        if (before.kind === 'candidate') {
          data.sourceIds ??= []
          if (!Array.isArray(data.sourceIds)) throw new DomainError('INVALID_SOURCE', '候选来源须为记录 ID 数组')
          normalizeCandidate(data,before.scopeKey)
        }
        validateSources(data, before.characterId, before.scopeKey)
        if(['memory','profile','supplement'].includes(before.kind))normalizeMemory(data,{store,characterId:before.characterId,scopeKey:before.scopeKey,subjectQQ:before.subjectQQ,recordId:before.id,importanceSource:data.importance===before.data.importance ? before.data.importanceSource??'manual' : 'manual'})
        if(before.kind==='candidate' && (data.rule!==before.data.rule || data.type!==before.data.type)){
          const frozen=dependencies.learning.helpers.freezeEvidence(before.id,{at:clock(),reason:'candidate-edited'}).candidate
          after=store.update(frozen.id,frozen.version,{status:'paused',data:{...data,frozenEvidenceIds:frozen.data.frozenEvidenceIds,autoAdoptPaused:true}})
        }else after = store.update(before.id, before.version, { data })
        invalidate(before, 'source-edited')
        registerMemoryConflicts(store,after,clock())
        break
      }
      case 'disable': case 'enable': {
        if (!EDITABLE.has(before.kind) && !['share','event'].includes(before.kind)) throw new DomainError('IMMUTABLE', '此记录不可直接改变状态')
        const pendingReview=action==='enable' && before.status==='pending' && ['memory','profile','supplement'].includes(before.kind)
        if (action === 'enable' && !pendingReview && !['disabled','paused'].includes(before.status)) throw new DomainError('INVALID_STATE', '仅可重新启用已停用或暂停条目')
        if(pendingReview && payload.confirm!==true)throw new DomainError('CONFIRMATION_REQUIRED','请审阅原文后明确确认该内容')
        let enabledData
        if (action === 'enable') {
          if (before.data.legacyObsolete) throw new DomainError('LEGACY_OBSOLETE', '旧材料已被取代或跳过；先核对替代关系并编辑失效标记，不能直接启用')
          if (['memory','profile','supplement'].includes(before.kind)) {
            enabledData = { ...before.data, ...(pendingReview ? {confirmed:true,reviewRequired:false,pendingConfirmation:false,uncertain:false,confirmedAt:clock()} : {}) }
            if (before.kind === 'profile') normalizeProfile(enabledData)
            normalizeMemory(enabledData,{store,characterId:before.characterId,scopeKey:before.scopeKey,subjectQQ:before.subjectQQ,recordId:before.id,importanceSource:before.data.importanceSource??'manual'})
          }
          validateSources(enabledData ?? before.data, before.characterId, before.scopeKey)
        }
        if(action==='disable' && before.kind==='candidate'){
          const frozen=dependencies.learning.helpers.freezeEvidence(before.id,{at:clock(),reason:String(payload.reason??'管理员停用')}).candidate
          after=store.update(frozen.id,frozen.version,{status:'disabled',data:{...frozen.data,autoAdoptPaused:true}})
        }else if(action==='enable' && before.kind==='candidate')after=dependencies.learning.helpers.resumeAutoAdopt(before.id,{at:clock(),reason:String(payload.reason??'管理员重新启用')})
        else after = store.update(before.id, before.version, { status: action === 'enable' ? 'active' : 'disabled', ...(enabledData ? { data: enabledData } : {}) })
        if(action==='enable'){
          registerMemoryConflicts(store,after,clock())
        }
        if (action === 'disable') invalidate(before, 'source-disabled')
        break
      }
      case 'delete': {
        if(!DELETABLE.has(before.kind))throw new DomainError('INVALID_DELETE','该系统记录不支持通用删除')
        const expiresAt = new Date(Date.parse(clock()) + config.deletion.undoDays * 86400000).toISOString()
        store.stash(before, expiresAt)
        after = store.update(before.id, before.version, { status: 'deleted', data: { deletedAt: clock(), undoUntil: expiresAt } })
        const affected=new Set()
        invalidate(before, 'source-deleted',affected)
        for (const recall of store.scan('recall', { characterId: before.characterId })) {
          if (recall.data.redactedAt === undefined) {
            store.update(recall.id, recall.version, { data: { identity: recall.data.identity, signature: recall.data.signature, redactedAt: clock(), reason: 'source-deleted', selected: (recall.data.selected ?? []).map(item => ({ id: item.id, version: item.version, redacted: true })), omitted: recall.data.omitted, budget: recall.data.budget } })
            store.db.prepare('DELETE FROM record_versions WHERE record_id=?').run(recall.id)
          }
        }
        // 涂除关联结果，但保留请求指纹；重试仍返回已完成收据。
        for(const receipt of store.db.prepare('SELECT namespace,request_id,result FROM requests').all()) {
          if([...affected].some(targetId=>receipt.result.includes(targetId)))store.db.prepare('UPDATE requests SET result=? WHERE namespace=? AND request_id=?').run(JSON.stringify({redacted:true,completed:true,targetId:before.id}),receipt.namespace,receipt.request_id)
        }
        break
      }
      case 'undo': {
        if (before.status !== 'deleted') throw new DomainError('INVALID_STATE', '目标没有删除')
        const original = store.recover(before.id, clock())
        if (!original) throw new DomainError('UNDO_EXPIRED', '受控撤销窗口已结束', 410)
        after = store.update(before.id, before.version, { data: original.data, status: 'disabled' })
        // 恢复后保持停用，不自动复活共享或派生内容。
        break
      }
      case 'assignImport': {
        if(before.status!=='quarantine' || !before.data.legacySource || payload.confirm!==true)throw new DomainError('INVALID_IMPORT_MAPPING','仅可明确确认隔离材料的归属')
        const character=store.get(requireText(payload.characterId,'角色 ID',200))
        if(character?.kind!=='character' || !active(character))throw new DomainError('INVALID_CHARACTER','角色无效')
        after=store.update(before.id,before.version,{characterId:character.id,scopeKey:canonicalScope(payload.scopeKey),status:'disabled',data:{...before.data,mappedBy:actor,mappedAt:clock()}})
        break
      }
      case 'share': {
        if (!['memory','profile','supplement'].includes(before.kind) || !active(before)) throw new DomainError('INVALID_SHARE', '只有有效记忆或档案可共享')
        const target = canonicalScope(payload.targetScope)
        if (target === before.scopeKey) throw new DomainError('INVALID_SHARE', '目标范围与源相同')
        const fields = [...new Set(payload.fields ?? [])]
        if (!fields.length || fields.some(f => !['text','summary','rule','content'].includes(f) || typeof before.data[f] !== 'string')) throw new DomainError('INVALID_SHARE', '必须手动选择现有文本字段')
        after = store.create('share', { sourceId: before.id, sourceVersion: before.version, fields, grantedBy: actor, grantedAt: clock() }, { characterId: before.characterId, scopeKey: target, subjectQQ: before.subjectQQ })
        break
      }
      case 'unshare': {
        if (before.kind !== 'share') throw new DomainError('INVALID_SHARE', '目标不是共享引用')
        after = store.update(before.id, before.version, { status: 'disabled' }); break
      }
      case 'resolveConflict': {
        if (before.kind !== 'conflict') throw new DomainError('INVALID_CONFLICT', '目标不是冲突')
        if (!['retain','replace','separate','dismiss'].includes(payload.resolution)) throw new DomainError('INVALID_RESOLUTION', '请选择保留、替换、区分情境或驳回')
        const targets=(before.data.targetIds??[]).map(id=>store.get(id)).filter(Boolean)
        if(['retain','replace'].includes(payload.resolution) && targets.length>1){
          const keep=targets.find(row=>row.id===payload.keepId)
          if(!keep)throw new DomainError('CONFLICT_TARGET_REQUIRED','请选择冲突双方中要保留的条目')
          for(const target of targets)if(target.id!==keep.id){
            const paused=store.update(target.id,target.version,{status:'paused',data:{...target.data,conflictResolution:before.id}})
            invalidate(paused,'conflict-resolved',new Set([before.id]))
          }
        }
        if(payload.resolution==='separate' && targets.length>1){
          const contexts=payload.contexts
          if(!contexts || targets.some(row=>typeof contexts[row.id]!=='string' || !contexts[row.id].trim() || contexts[row.id].length>400) || new Set(targets.map(row=>contexts[row.id].trim())).size!==targets.length)throw new DomainError('CONFLICT_CONTEXT_REQUIRED','请为冲突双方填写不同的适用情境（最多400字符）')
          for(const target of targets)store.update(target.id,target.version,{data:{...target.data,context:contexts[target.id].trim()}})
          for(const target of targets)invalidate(target,'source-edited',new Set([before.id]))
          for(const target of targets)registerMemoryConflicts(store,store.get(target.id),clock())
        }
        after = store.update(before.id, before.version, { status: 'resolved', data: { ...before.data, resolved:true, resolution: payload.resolution, keepId:payload.keepId, resolvedBy: actor, resolvedAt: clock(), reason: payload.reason } })
        break
      }
      case 'feedback': {
        const target = store.get(requireText(payload.targetId, '反馈目标', 300))
        if (!target) throw new DomainError('NOT_FOUND', '反馈目标不存在', 404)
        version(payload.expectedVersion)
        if(target.version!==payload.expectedVersion)throw new DomainError('VERSION_CONFLICT','反馈目标已改变，请刷新',409)
        if (!['positive','negative','correction'].includes(payload.sentiment)) throw new DomainError('INVALID_FEEDBACK', '反馈类型无效')
        const text = requireText(payload.text, '具体反馈内容', 5000)
        after = store.create('feedback', { targetId: target.id, sourceIds: [target.id], sentiment: payload.sentiment, text, verified: true, actor, at: clock() }, { characterId: target.characterId, scopeKey: target.scopeKey })
        if (payload.sentiment !== 'positive' && ['candidate','memory','profile','supplement'].includes(target.kind)) {
          const paused = store.update(target.id, target.version, { status: 'paused', data: { ...target.data, feedbackIds: [...(target.data.feedbackIds ?? []), after.id] } }); invalidate(paused, 'negative-feedback')
        }
        break
      }
      case 'verifyApplication': {
        if (before.kind !== 'application' || !before.data.successful) throw new DomainError('INVALID_APPLICATION', '只能核验实际成功发送的记录')
        const candidate = store.get(requireText(payload.candidateId, '候选 ID', 300))
        if (!candidate || candidate.kind !== 'candidate' || candidate.characterId !== before.characterId || !(candidate.scopeKey===before.scopeKey || candidate.scopeKey==='character' && candidate.data.type==='personality' && (['accepted','adopted'].includes(candidate.status) || (candidate.data.originScopes??candidate.data.sourceIds?.map(sourceId=>store.get(sourceId)?.scopeKey)??[]).includes(before.scopeKey)) && !(before.scopeKey.startsWith('private:') && (candidate.data.pausedForQQ??[]).includes(before.scopeKey.slice(8)))) || !['trial','adopted','accepted'].includes(candidate.status)) throw new DomainError('INVALID_APPLICATION', '候选与发送记录归属或状态不符')
        const excerpt = requireText(payload.excerpt, '核验片段', 5000)
        if (!before.data.content.includes(excerpt)) throw new DomainError('INVALID_APPLICATION', '片段不在实际发送原文中')
        after = store.update(before.id, before.version, { status: 'verified', data: { ...before.data, verified: true, candidateId: candidate.id, candidateIds: [...new Set([...(before.data.candidateIds ?? []),candidate.id])], verifiedCandidateIds:[...new Set([...(before.data.verifiedCandidateIds ?? (before.data.verified && before.data.candidateId ? [before.data.candidateId] : [])),candidate.id])], verifications:{...before.data.verifications,[candidate.id]:{verifiedBy:actor,excerpt,verifiedAt:clock()}}, verification: 'administrator', verifiedBy: actor, excerpt, verifiedAt: clock() } })
        break
      }
      case 'task': {
        if(before.kind!=='task' || !['pause','resume'].includes(payload.operation))throw new DomainError('INVALID_TASK','请选择任务暂停或恢复')
        if(before.data.lease?.expiresAt && before.data.lease.expiresAt>clock())throw new DomainError('TASK_BUSY','进行中的任务请等待收敛',409)
        after=store.update(before.id,before.version,{data:{...before.data,paused:payload.operation==='pause',pauseReason:payload.operation==='pause'?String(payload.reason??'manual'):'',...(payload.operation==='resume'?{lastError:'',consecutiveFailures:0}:{}),resumedAt:clock()}})
        break
      }
      case 'candidate': {
        if (before.kind !== 'candidate') throw new DomainError('INVALID_CANDIDATE', '目标不是候选')
        if (!['pause','reject','evaluate','resume'].includes(payload.operation)) throw new DomainError('INVALID_OPERATION', '请选择暂停、驳回、评估或恢复')
        if (payload.operation === 'resume') { if(!['paused','disabled','rejected'].includes(before.status))throw new DomainError('INVALID_STATE','仅可恢复已经停止的候选'); after=dependencies.learning.helpers.resumeAutoAdopt(before.id,{at:clock(),reason:String(payload.reason??'管理员恢复候选')});break }
        if (payload.operation === 'evaluate') return { evaluate: before.id }
        const frozen = dependencies.learning.helpers.freezeEvidence(before.id,{at:clock(),reason:String(payload.reason??'管理员停用候选')}).candidate
        after = store.update(frozen.id, frozen.version, { status: payload.operation === 'reject' ? 'rejected' : 'paused' })
        invalidate(before, 'candidate-stopped'); break
      }
      case 'rollbackBatch':{
        if(!Array.isArray(payload.targets) || payload.targets.length<1 || payload.targets.length>80 || new Set(payload.targets.map(target=>target.id)).size!==payload.targets.length)throw new DomainError('INVALID_BATCH','请选择1到80个不同的候选及其当前版本')
        const targets=payload.targets.map(target=>get(target))
        if(targets.some(target=>target.kind!=='candidate' || target.characterId!==targets[0].characterId))throw new DomainError('INVALID_BATCH','批次须为同一角色的候选')
        const results=targets.map(target=>{const result=dependencies.learning.helpers.rollbackCandidate({candidateId:target.id,reason:String(payload.reason??''),actor:actor.id,at:clock()});invalidate(target,'candidate-rollback');return result})
        after={id:'batch',results};break
      }
      case 'rollback': {
        if(before.kind==='candidate'){
          after=dependencies.learning.helpers.rollbackCandidate({candidateId:before.id,reason:String(payload.reason??''),actor:actor.id,at:clock()}).candidate
          invalidate(before,'candidate-rollback');break
        }
        if (before.kind !== 'personality') throw new DomainError('INVALID_PERSONALITY', '请选择人格版本')
        const result=dependencies.learning.helpers.rollbackPersonality({characterId:before.characterId,versionId:before.id,reason:String(payload.reason??''),actor,at:clock()})
        after=result.version
        break
      }
      case 'takeover': {
        const characterId = requireText(payload.characterId,'角色 ID',200); const scopeKey = canonicalScope(payload.scopeKey)
        if (!active(store.get(characterId))) throw new DomainError('INVALID_CHARACTER','角色不存在')
        const existing = [...store.scan('takeover',{characterId,scopeKey})][0]
        if (existing) { version(payload.expectedVersion); if (existing.version !== payload.expectedVersion) throw new DomainError('VERSION_CONFLICT','接管状态已改变',409) }
        if (!['prepare','activate','rollback'].includes(payload.operation)) throw new DomainError('INVALID_TAKEOVER','接管操作无效')
        const data = { operation:payload.operation, requestedAt:clock(), requestedBy:actor, desiredOwner:payload.operation === 'activate' ? 'companion' : 'legacy', acknowledged:false, expectedBridgeVersion:payload.bridgeVersion ?? '' }
        // prepare只是准备；activate也必须等桥接确认旧输出已关，召回端随后才可启用。
        after = existing ? store.update(existing.id,existing.version,{status:payload.operation === 'activate' ? 'pending' : payload.operation === 'rollback' ? 'rollback-pending' : 'prepared',data}) : store.create('takeover',data,{characterId,scopeKey,status:payload.operation === 'activate' ? 'pending' : 'prepared'})
        break
      }
      default: throw new DomainError('UNKNOWN_ACTION','未知管理操作')
    }
    store.audit(actor,action,after?.id ?? before?.id,before,after,String(payload.reason ?? ''),payload.requestId)
    return after
  }
  async function manage(action, payload = {}, actor) {
    assertOwner(actor, config)
    if (service.isMaintenance()) throw new DomainError('MAINTENANCE', '正在恢复数据库，请稍后重试', 503)
    if (['backupCreate','backupPreview','backupRestore','importPreview','importApply'].includes(action)) {
      if (!dependencies.operations) throw new DomainError('NOT_READY','运维服务未就绪',503)
      return dependencies.operations.manage(action,payload,actor)
    }
    const value = store.once(`manage:${actor.kind}:${actor.id}`,payload.requestId,{action,payload},()=>mutate(action,payload,actor))
    if (value?.evaluate) {
      if (!dependencies.learning) throw new DomainError('NOT_READY','学习引擎未就绪',503)
      return dependencies.learning.evaluate(value.evaluate)
    }
    return value
  }
  async function command(payload, actor) {
    if (actor?.kind !== 'qq-admin' || !config.bridge.adminQQs.includes(actor.id)) throw new DomainError('FORBIDDEN','QQ 管理命令不在有效插件管理员白名单',403)
    const scopeKey = canonicalScope(payload.conversationKey)
    const characterId = requireText(payload.characterId,'角色 ID',200)
    const text = requireText(payload.text ?? payload.command,'命令',10000)
    const match = /^\/(?:memory|记忆)\s+(记住|remember|忘记|forget|停用|disable|状态|status)\s*([\s\S]*)$/iu.exec(text)
    if (!match) return { handled:false }
    if (/^(状态|status)$/i.test(match[1])) return {handled:true,reply:JSON.stringify(service.status().configuration)}
    if (/^(记住|remember)$/i.test(match[1])) {
      const result = await manage('create',{requestId:payload.requestId,kind:'memory',characterId,scopeKey,subjectQQ:actor.id,data:{text:requireText(match[2],'记忆内容',8000),type:'fact',protected:true,manual:true},reason:'可信 QQ 管理命令'},actor)
      return {handled:true,reply:`已记录：${result.id}`}
    }
    const target = store.get(match[2].trim())
    if (!target || target.characterId !== characterId || target.scopeKey !== scopeKey) return {handled:true,reply:'请给出本范围内明确的条目 ID；未对任何条目执行操作。'}
    const result = await manage(/忘记|forget/i.test(match[1])?'delete':'disable',{requestId:payload.requestId,id:target.id,expectedVersion:target.version,reason:'可信 QQ 管理命令'},actor)
    return {handled:true,reply:`已处理 ${result.id}（${result.status}）`}
  }
  return { manage, command, attach, invalidate }
}
