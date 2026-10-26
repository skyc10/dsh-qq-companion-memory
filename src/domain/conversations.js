import { digest } from './core.js'

// 只保留交流段时间边界与合并关系，不保存消息正文；删源不拆段，迟到材料只会合并。
export function resolveConversationUnit(store, key) {
  const seen=new Set()
  let current=String(key??'')
  while(current && !seen.has(current)){
    seen.add(current)
    const row=store.get(current)
    if(row?.kind!=='conversation-unit' || !row.data.mergedInto)return current
    current=row.data.mergedInto
  }
  return [...seen].sort()[0]??''
}

// 必须位于入站事件的同步事务内；相距超过 gapMinutes 才建立新段。
export function attachConversationUnit(store,{characterId,scopeKey,botQQ,eventId,occurredAt,gapMinutes=30}){
  const point=Date.parse(occurredAt),gap=gapMinutes*60000
  const matching=[...store.scan('conversation-unit',{characterId,scopeKey})].filter(row=>!row.data.mergedInto && row.data.botQQ===botQQ && point>=row.data.startMs-gap && point<=row.data.endMs+gap).sort((a,b)=>a.id.localeCompare(b.id))
  if(!matching.length)return store.create('conversation-unit',{botQQ,startMs:point,endMs:point,mergedInto:''},{id:`unit-${digest([characterId,scopeKey,botQQ,eventId])}`,characterId,scopeKey}).id
  const root=matching[0]
  store.update(root.id,root.version,{data:{...root.data,startMs:Math.min(point,...matching.map(row=>row.data.startMs)),endMs:Math.max(point,...matching.map(row=>row.data.endMs))}})
  for(const row of matching.slice(1))store.update(row.id,row.version,{status:'merged',data:{...row.data,mergedInto:root.id}})
  return root.id
}
