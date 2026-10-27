import { DomainError, iso, textOf } from './core.js'

// 重要性影响召回排序；默认按材料类型分级，人工或模型可提供 1–5 的整数。
export function normalizeImportance(data, source = 'manual') {
  if (data.importance == null) {
    const defaults = { experience: 1, fact: 3, preference: 3, relationship: 3, promise: 4, boundary: 5 }
    data.importance = Object.hasOwn(defaults, data.type) ? defaults[data.type] : 1
    data.importanceSource = 'type-default'
  } else {
    if (!Number.isInteger(data.importance) || data.importance < 1 || data.importance > 5) throw new DomainError('INVALID_IMPORTANCE', '重要性须为 1 至 5 的整数')
    data.importanceSource = source
  }
  return data
}

// 有效期是半开区间；被替代的事实保留原文，仅停止作为当前事实召回。
export function memoryWindow(data = {}) {
  const from = data.validFrom ? Date.parse(data.validFrom) : -Infinity
  const until = data.validUntil ? Date.parse(data.validUntil) : Infinity
  return { from, until }
}
export function normalizeMemory(data, { store, characterId, scopeKey, subjectQQ = '', recordId = '', importanceSource = 'manual' }) {
  normalizeImportance(data, importanceSource)
  for (const key of ['occurredAt','validFrom','validUntil']) if (data[key] != null && data[key] !== '') {
    if(typeof data[key]!=='string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(data[key]))throw new DomainError('INVALID_TIME',`${key} 须含明确时区`)
    data[key] = iso(data[key],key)
  }
  if(data.context!=null && (typeof data.context!=='string' || data.context.length>400))throw new DomainError('INVALID_CONTEXT','适用情境须为短文本')
  const {from,until}=memoryWindow(data)
  if (from >= until) throw new DomainError('INVALID_VALIDITY','有效期结束须晚于开始')
  if (data.factKey != null && (typeof data.factKey !== 'string' || !data.factKey.trim() || data.factKey.length > 200)) throw new DomainError('INVALID_FACT_KEY','事实主题须为非空短文本')
  if (data.factKey) data.factKey=data.factKey.trim()
  if (data.supersedesId) {
    const seen=new Set([recordId]);let sourceId=data.supersedesId
    while(sourceId) {
      if(seen.has(sourceId))throw new DomainError('INVALID_SUPERSESSION','事实替代链不能循环')
      seen.add(sourceId)
      const old=store.get(sourceId)
      if(!old || !['memory','profile','supplement'].includes(old.kind) || old.characterId!==characterId || old.scopeKey!==scopeKey)throw new DomainError('INVALID_SUPERSESSION','只能替代同角色同范围的记忆或档案')
      if(old.subjectQQ!==subjectQQ)throw new DomainError('INVALID_SUPERSESSION','被替代事实须属于同一主体')
      sourceId=old.data.supersedesId
    }
  }
  return data
}
export function memoryCurrent(row, at) {
  const {from,until}=memoryWindow(row.data)
  const point=Date.parse(at)
  return Number.isFinite(point) && point>=from && point<until
}
export function registerMemoryConflicts(store,row,at) {
  if(!['memory','profile','supplement'].includes(row.kind) || !row.data.factKey)return
  const window=memoryWindow(row.data)
  for(const other of store.scan(row.kind,{characterId:row.characterId,scopeKey:row.scopeKey,status:['active','pending']})) {
    if(other.id===row.id || other.subjectQQ!==row.subjectQQ || other.data.factKey!==row.data.factKey || (other.data.context??'')!==(row.data.context??'') || textOf(other)===textOf(row) || other.id===row.data.supersedesId || other.data.supersedesId===row.id)continue
    const prior=memoryWindow(other.data)
    if(Math.max(window.from,prior.from)>=Math.min(window.until,prior.until))continue
    const targets=[other.id,row.id].sort()
    if([...store.scan('conflict',{characterId:row.characterId,status:['active','pending']})].some(conflict=>targets.every(id=>(conflict.data.targetIds??[]).includes(id))))continue
    store.create('conflict',{kind:'fact',summary:`同一事实主题存在不同内容：${row.data.factKey}`,targetIds:targets,sourceIds:[...new Set([...(other.data.sourceIds??[]),...(row.data.sourceIds??[])])],resolved:false},{characterId:row.characterId,scopeKey:row.scopeKey,subjectQQ:row.subjectQQ,at})
  }
}
