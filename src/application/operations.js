import { mkdir, stat, unlink, copyFile, readFile } from 'node:fs/promises'
import { join, resolve, basename } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DomainError, assertOwner, digest, id, requireText, canonicalScope, shanghaiDay } from '../domain/core.js'

export function createOperations(service, { learning, logger = console } = {}) {
  const { store, config, clock } = service
  const directory = resolve(config.backup.directory || join(store.directory,'backups'))
  let busy = false; let closed = false
  const checks = new Map()
  const snapshotSummary = path => {
    const db = new DatabaseSync(path,{readOnly:true})
    try {
      const v = db.prepare('PRAGMA user_version').get().user_version
      if(v!==1 || db.prepare('PRAGMA quick_check').get().quick_check!=='ok') throw new DomainError('INVALID_BACKUP','备份完整性或版本不兼容')
      const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name))
      if(['records','audit','requests','trash','meta'].some(name=>!tables.has(name)))throw new DomainError('INVALID_BACKUP','备份缺少必需数据表')
      if(!db.prepare("SELECT value FROM meta WHERE key='generation'").get())throw new DomainError('INVALID_BACKUP','备份缺少数据库代次')
      return {schemaVersion:v,counts:db.prepare('SELECT kind,status,count(*) AS count FROM records GROUP BY kind,status').all(),latest:db.prepare('SELECT max(updated_at) AS at FROM records').get().at}
    } finally { db.close() }
  }
  async function createBackup(actor, reason = 'manual') {
    await mkdir(directory,{recursive:true,mode:0o700})
    const name = `${clock().replace(/[:.]/g,'-')}-${id('snapshot')}.sqlite`
    const path = join(directory,name)
    await store.backup(path)
    const info = await stat(path)
    const hash = digest(await readFile(path))
    const row = store.create('backup',{name,bytes:info.size,sha256:hash,createdAt:clock(),reason},{status:'active'})
    store.audit(actor,'backupCreate',row.id,null,row,reason)
    return row
  }
  async function backupTarget(payload) {
    const row = store.get(requireText(payload.id,'备份 ID',300))
    if(!row || row.kind!=='backup') throw new DomainError('NOT_FOUND','备份记录不存在',404)
    if(basename(row.data.name)!==row.data.name || !row.data.name.endsWith('.sqlite')) throw new DomainError('INVALID_PATH','备份名称无效')
    const path = resolve(directory,row.data.name)
    if(!path.startsWith(directory + (directory.includes('\\')?'\\':'/'))) throw new DomainError('INVALID_PATH','备份不在受控目录')
    const hash = digest(await readFile(path))
    if(hash!==row.data.sha256) throw new DomainError('BACKUP_CHANGED','备份内容与登记指纹不一致',409)
    return {row,path,hash}
  }
  async function execute(action,payload,actor) {
    assertOwner(actor,config)
    requireText(payload.requestId,'requestId',200)
    if(busy) throw new DomainError('OPERATIONS_BUSY','另一项运维操作正在执行',409)
    busy=true
    try {
      if(action==='backupCreate') {
        const previous=[...store.scan('backup')].find(r=>r.data.requestId===payload.requestId)
        if(previous) return previous
        const row=await createBackup(actor,String(payload.reason??'manual'))
        return store.update(row.id,row.version,{data:{...row.data,requestId:payload.requestId}})
      }
      if(action==='backupPreview') {
        const {row,path,hash}=await backupTarget(payload)
        const preview={...snapshotSummary(path),backupId:row.id,sha256:hash,currentGeneration:store.generation(),warning:'恢复替换当前库；备份之后的变更会丢失，已删除内容可能复活。旧 DSH 会话快照不由此清理。',current:store.db.prepare('SELECT kind,status,count(*) AS count FROM records GROUP BY kind,status').all()}
        const token=id('restore-confirm')
        checks.set(token,{type:'restore',backupId:row.id,hash,generation:store.generation(),expires:Date.parse(clock())+600000})
        return {...preview,confirmationToken:token,expiresInSeconds:600}
      }
      if(action==='backupRestore') {
        const confirmation=checks.get(payload.confirmationToken)
        if(!confirmation || confirmation.type!=='restore' || confirmation.backupId!==payload.id || confirmation.expires<Date.parse(clock()) || payload.confirm!==true) throw new DomainError('CONFIRMATION_REQUIRED','先预览并明确确认恢复',409)
        if(confirmation.generation!==store.generation()) throw new DomainError('PREVIEW_STALE','预览后数据库已变化，请重新预览',409)
        service.setMaintenance(true)
        try {
          await learning?.close()
          const engine=learning?.status()
          if(engine?.running || engine?.activeRequests?.length || engine?.activeLeases)throw new DomainError('LEARNING_BUSY','学习请求尚未完全停止，请等待收敛后重新预览恢复',409)
          const {path,hash}=await backupTarget(payload)
          if(hash!==confirmation.hash) throw new DomainError('BACKUP_CHANGED','备份已改变',409)
          const safety=await createBackup(actor,'before-restore')
          const temporary=join(store.directory,`${id('restore-stage')}.sqlite`)
          await copyFile(path,temporary)
          store.restoreFile(temporary)
          store.create('backup',safety.data,{status:'active'})
          for (const binding of store.scan('binding')) if (binding.status === 'active') store.update(binding.id,binding.version,{status:'stale'})
          for (const takeover of store.scan('takeover')) store.update(takeover.id,takeover.version,{status:'prepared',data:{...takeover.data,desiredOwner:'legacy',acknowledged:false,restoredAt:clock()}})
          checks.delete(payload.confirmationToken)
          const row=store.create('control',{type:'restored',at:clock(),sourceBackup:payload.id,safetyBackupName:safety.data.name,requiresRestart:true})
          store.audit(actor,'backupRestore',row.id,null,row,String(payload.reason??''),payload.requestId)
          return {restored:true,requiresRestart:true,safetyBackupName:safety.data.name,warning:'学习引擎保持停止，重启插件后再启用；桥接绑定会重新同步。'}
        } finally {service.setMaintenance(false)}
      }
      if(action==='importPreview') {
        const rows=payload.records
        if(!Array.isArray(rows) || !rows.length || rows.length>1000 || JSON.stringify(rows).length>1000000) throw new DomainError('INVALID_IMPORT','单次导入须为 1 至 1000 条且不超过 1MB')
        const source=requireText(payload.source,'导入来源',300)
        const token=id('import-confirm'); const hash=digest({source,rows,mapping:payload.mapping??{}})
        checks.set(token,{type:'import',rows:structuredClone(rows),mapping:structuredClone(payload.mapping??{}),source,hash,expires:Date.parse(clock())+600000})
        return {confirmationToken:token,sha256:hash,count:rows.length,source,warning:'未明确映射到稳定角色和范围的材料进入隔离区；同名昵称不会推断为同一 QQ。不会覆盖现有条目。',rows:rows.slice(0,30)}
      }
      if(action==='importApply') {
        const c=checks.get(payload.confirmationToken)
        if(!c || c.type!=='import' || c.expires<Date.parse(clock()) || payload.confirm!==true || payload.sha256!==c.hash) throw new DomainError('CONFIRMATION_REQUIRED','先预览并明确批准来源映射',409)
        const result=store.once('import',payload.requestId,{hash:c.hash},()=>{
          const ids=[]; let quarantined=0
          for(const [index,old] of c.rows.entries()) {
            const sourceKey=String(old.id??index);const mapped=c.mapping[sourceKey]
            const rid=`import-${digest([c.source,sourceKey])}`
            if(store.get(rid,{includeDeleted:true})){ids.push(rid);continue}
            const allowed=mapped && store.get(mapped.characterId)?.kind==='character' && mapped.confirmed===true
            let scopeKey='quarantine';let characterId=''
            if(allowed){scopeKey=canonicalScope(mapped.scopeKey);characterId=mapped.characterId}else quarantined++
            const data={text:String(old.text??old.content??old.summary??JSON.stringify(old)),legacyId:sourceKey,legacySource:c.source,importHash:c.hash,importedAt:clock(),unverified:true,raw:old}
            store.create('memory',data,{id:rid,characterId,scopeKey,status:allowed?'disabled':'quarantine'})
            ids.push(rid)
          }
          const receipt=store.create('import',{source:c.source,hash:c.hash,ids,quarantined,at:clock()})
          store.audit(actor,'importApply',receipt.id,null,receipt,String(payload.reason??''),payload.requestId)
          return {id:receipt.id,imported:ids.length,quarantined,status:'disabled-until-reviewed'}
        })
        return result
      }
      throw new DomainError('UNKNOWN_ACTION','未知运维操作')
    } finally {busy=false}
  }
  async function manage(action,payload,actor) {
    assertOwner(actor,config)
    requireText(payload.requestId,'requestId',200)
    const durable=['backupCreate','backupRestore','importApply'].includes(action)
    const namespace=`operations:${actor.kind}:${actor.id}`
    const hash=digest({action,payload})
    if (durable) {
      const prior=store.db.prepare('SELECT hash,result FROM requests WHERE namespace=? AND request_id=?').get(namespace,payload.requestId)
      if (prior) {
        if(prior.hash!==hash) throw new DomainError('REQUEST_CONFLICT','相同requestId对应不同运维内容',409)
        return JSON.parse(prior.result)
      }
    }
    const value=await execute(action,payload,actor)
    return durable ? store.once(namespace,payload.requestId,{action,payload},()=>value) : value
  }
  async function tick() {
    if(closed || busy) return
    store.purgeTrash(clock())
    for(const [token,c] of checks) if(c.expires<Date.parse(clock())) checks.delete(token)
    if(!config.backup.enabled || !config.backup.time) return
    const local=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(clock()))
    if(local<config.backup.time) return
    const day=shanghaiDay(clock())
    if([...store.scan('backup')].some(r=>r.data.reason===`daily:${day}`)) return
    busy=true
    try {
      await createBackup({kind:'system',id:'daily-backup'},`daily:${day}`)
      const cutoff=Date.parse(clock())-config.backup.retentionDays*86400000
      for(const row of store.scan('backup',{status:'active'})) if(Date.parse(row.createdAt)<cutoff && row.data.reason.startsWith('daily:')) {
        const path=resolve(directory,row.data.name)
        if(basename(row.data.name)!==row.data.name || !path.startsWith(directory)) continue
        await unlink(path).catch(error=>{if(error.code!=='ENOENT')throw error})
        store.update(row.id,row.version,{status:'expired'})
      }
    } catch(error){logger.error('每日备份失败',error.message)} finally{busy=false}
  }
  return {manage,tick,close(){closed=true;checks.clear()},directory}
}
