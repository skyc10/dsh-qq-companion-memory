import { DatabaseSync, backup } from 'node:sqlite'
import { mkdirSync, existsSync, renameSync, unlinkSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { DomainError, id, nowISO, digest, stableJSON } from '../domain/core.js'

const KINDS = new Set('character binding event conversation-unit memory profile supplement share candidate evidence conflict feedback trial application personality task usage recall backup takeover import control'.split(' '))
const parse = row => row ? { id: row.id, kind: row.kind, characterId: row.character_id, scopeKey: row.scope_key, subjectQQ: row.subject_qq, status: row.status, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, data: JSON.parse(row.data) } : null
// 主库改名时必须带着 -wal/-shm 一起走：直接删会丢掉尚未 checkpoint 的已提交事务。
const removeSidecars = base => { for (const suffix of ['-wal', '-shm']) if (existsSync(base + suffix)) unlinkSync(base + suffix) }
// 先把 sidecar 挪到目标基名，再改名主库；任一步失败都尽量复原，避免旧库丢掉未 checkpoint 的事务。
const moveDatabase = (fromBase, toBase) => {
  const moved = []
  const undo = () => { for (const suffix of moved) { try { renameSync(toBase + suffix, fromBase + suffix) } catch { /* 保留现场 */ } } }
  try {
    for (const suffix of ['-wal', '-shm']) {
      if (!existsSync(fromBase + suffix)) continue
      renameSync(fromBase + suffix, toBase + suffix)
      moved.push(suffix)
    }
  } catch (error) { undo(); throw error }
  try { renameSync(fromBase, toBase) } catch (error) { undo(); throw error }
}
// 主库文件已不存在时，残留 sidecar 不能直接删：改名留证，便于人工核对是否还有已提交未回放的事务。
const parkSidecars = base => {
  const parked = []; const stamp = Date.now()
  for (const suffix of ['-wal', '-shm']) {
    const from = base + suffix
    if (!existsSync(from)) continue
    const to = `${from}.orphan-${stamp}`
    try { renameSync(from, to); parked.push(to) } catch { /* 改不动就留在原位，不删 */ }
  }
  return parked
}
export class Store {
  constructor(directory) {
    this.directory = resolve(directory)
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    this.path = join(this.directory, 'memory.sqlite')
    this.depth = 0
    this.db = null
    this.opened = false
    this.recovery = null
    this.failedPath = null
    this.closeError = null
    this.open()
  }
  open() {
    // 连接是否可用以显式 opened 为准，不依赖驱动内部的 db.isOpen。
    if (this.opened || this.db) throw new DomainError('STORE_OPEN', '数据库连接已处于打开状态', 409)
    const oldPath = `${this.path}.restore-old`
    this.recovery = null
    if (!existsSync(this.path) && existsSync(oldPath)) {
      // 上次恢复中断在“原库已换出、新库尚未就位”：把旧库连 sidecar 一起换回主库再打开。
      try { moveDatabase(oldPath, this.path) } catch (error) { throw new DomainError('RESTORE_FAILED', '主库缺失且旧库无法回滚，请人工检查数据目录后重试', 500, { stage: 'open-rollback', oldPath, error: String(error?.message ?? error) }) }
      this.recovery = { state: 'rolled-back-old', path: oldPath, at: nowISO() }
    } else if (existsSync(this.path) && existsSync(oldPath)) {
      // 主库与旧库并存：不自动删除旧库，保留现场待人工确认
      this.recovery = { state: 'old-retained', path: oldPath, at: nowISO() }
    } else if (!existsSync(this.path)) {
      // 主库不存在且没有可回滚的旧库：残留 sidecar 改名留证而不是删除，再新建空库
      const parked = parkSidecars(this.path)
      if (parked.length) this.recovery = { state: 'orphan-sidecars-parked', parked, at: nowISO() }
    }
    this.db = new DatabaseSync(this.path)
    this.opened = true
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;')
      const current = this.db.prepare('PRAGMA user_version').get().user_version
      if (current > 1) throw new DomainError('NEWER_DATABASE', '数据库版本高于插件兼容范围，拒绝加载', 503)
      if (current === 0) this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE records(id TEXT PRIMARY KEY,kind TEXT NOT NULL,character_id TEXT NOT NULL,scope_key TEXT NOT NULL,subject_qq TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>=1),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
        CREATE INDEX records_scope ON records(kind,character_id,scope_key,status,id);
        CREATE INDEX records_person ON records(kind,character_id,subject_qq,status,id);
        CREATE TABLE record_versions(record_id TEXT NOT NULL,version INTEGER NOT NULL,snapshot TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(record_id,version),FOREIGN KEY(record_id) REFERENCES records(id));
        CREATE TABLE audit(id TEXT PRIMARY KEY,at TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,before_json TEXT,after_json TEXT,reason TEXT NOT NULL,request_id TEXT NOT NULL);
        CREATE TABLE requests(namespace TEXT NOT NULL,request_id TEXT NOT NULL,hash TEXT NOT NULL,result TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(namespace,request_id));
        CREATE TABLE trash(id TEXT PRIMARY KEY,payload TEXT NOT NULL,expires_at TEXT NOT NULL);
        CREATE TABLE meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
        INSERT INTO meta VALUES('generation',0);
        PRAGMA user_version=1; COMMIT;`)
      // 已是 v1 但缺历史表的旧库：按需补表，不改产品版本号；已存在时不写库，避免每次打开争锁
      else if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='record_versions'").get()) this.db.exec('CREATE TABLE IF NOT EXISTS record_versions(record_id TEXT NOT NULL,version INTEGER NOT NULL,snapshot TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(record_id,version),FOREIGN KEY(record_id) REFERENCES records(id));')
      // 打开时清理过期回收站；清理失败不应阻断启动
      try {
        if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='trash'").get()) this.purgeTrash(nowISO())
      } catch (error) { this.recovery = this.recovery ?? { state: 'trash-cleanup-skipped', at: nowISO(), reason: String(error?.message ?? error) } }
    } catch (error) {
      // close 内部已吞掉关闭异常，不会覆盖打开时的原始错误
      this.close()
      throw error
    }
  }
  tx(fn) {
    if (this.depth) return fn()
    this.db.exec('BEGIN IMMEDIATE')
    this.depth++
    try {
      const value = fn()
      if (value && typeof value.then === 'function') throw new DomainError('ASYNC_TRANSACTION', '事务回调不能返回 Promise', 500)
      this.db.exec('COMMIT')
      return value
    } catch (error) { this.db.exec('ROLLBACK'); throw error } finally { this.depth-- }
  }
  touch() { this.db.prepare("UPDATE meta SET value=value+1 WHERE key='generation'").run() }
  generation() { return this.db.prepare("SELECT value FROM meta WHERE key='generation'").get().value }
  get(recordId, { includeDeleted = false } = {}) {
    const row = parse(this.db.prepare('SELECT * FROM records WHERE id=?').get(recordId))
    return row && (includeDeleted || row.status !== 'deleted') ? row : null
  }
  list(kind, filter = {}) {
    if (kind === 'history') {
      const record = this.get(String(filter.id ?? filter.targetId ?? ''))
      if (!record) return []
      const beforeVersion=filter.after ? Number(String(filter.after).split('@').at(-1)) : Number.MAX_SAFE_INTEGER
      return this.db.prepare('SELECT * FROM record_versions WHERE record_id=? AND version<? ORDER BY version DESC LIMIT ?').all(record.id, Number.isSafeInteger(beforeVersion)?beforeVersion:Number.MAX_SAFE_INTEGER, Math.min(1000, Math.max(1, Number(filter.limit) || 200))).map(row => ({ ...JSON.parse(row.snapshot), id: `${row.record_id}@${row.version}`, kind: 'history' }))
    }
    if (kind === 'audit') {
      const rows = this.db.prepare('SELECT * FROM audit WHERE id>? ORDER BY id LIMIT ?').all(String(filter.after ?? ''), Math.min(1000, Math.max(1, Number(filter.limit) || 200)))
      return rows.map(r => ({ id: r.id, kind, createdAt: r.at, version: 1, data: { actor: JSON.parse(r.actor), action: r.action, target: r.target, before: JSON.parse(r.before_json), after: JSON.parse(r.after_json), reason: r.reason, requestId: r.request_id } }))
    }
    if (!KINDS.has(kind)) throw new DomainError('INVALID_KIND', '未知实体类型')
    const terms = ['kind=?']; const args = [kind]
    for (const [key, column] of [['characterId', 'character_id'], ['scopeKey', 'scope_key'], ['subjectQQ', 'subject_qq']]) if (filter[key] !== undefined) { terms.push(`${column}=?`); args.push(String(filter[key])) }
    if (filter.status !== undefined) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
      if (!statuses.length) return []
      terms.push(`status IN (${statuses.map(() => '?').join(',')})`); args.push(...statuses)
    }
    if (!filter.includeDeleted) terms.push("status!='deleted'")
    if (filter.after) { terms.push('id>?'); args.push(filter.after) }
    args.push(Math.min(1000, Math.max(1, Number(filter.limit) || 200)))
    return this.db.prepare(`SELECT * FROM records WHERE ${terms.join(' AND ')} ORDER BY id LIMIT ?`).all(...args).map(parse)
  }
  *scan(kind, filter = {}) {
    let after
    do {
      const rows = this.list(kind, { ...filter, after, limit: 1000 })
      yield* rows
      if (rows.length < 1000) return
      after = rows.at(-1).id
    } while (true)
  }
  create(kind, data, meta = {}) {
    if (!KINDS.has(kind)) throw new DomainError('INVALID_KIND', '未知实体类型')
    return this.tx(() => {
      const at = meta.at ?? nowISO(); const rid = meta.id ?? id(kind)
      this.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,1,?,?,?)').run(rid, kind, meta.characterId ?? '', meta.scopeKey ?? '', meta.subjectQQ ?? '', meta.status ?? 'active', at, at, JSON.stringify(data))
      this.touch()
      return this.get(rid, { includeDeleted: true })
    })
  }
  update(recordId, expectedVersion, patch, { at = nowISO() } = {}) {
    return this.tx(() => {
      const before = this.get(recordId, { includeDeleted: true })
      if (!before) throw new DomainError('NOT_FOUND', '目标不存在', 404)
      if (before.version !== expectedVersion) throw new DomainError('VERSION_CONFLICT', '目标已变更，请刷新后重试', 409, { currentVersion: before.version })
      const fields = { ...before, ...patch }
      if (patch.status === 'deleted') this.db.prepare('DELETE FROM record_versions WHERE record_id=?').run(recordId)
      else if (before.status !== 'deleted') this.db.prepare('INSERT OR IGNORE INTO record_versions VALUES(?,?,?,?)').run(recordId, before.version, JSON.stringify(before), at)
      this.db.prepare('UPDATE records SET character_id=?,scope_key=?,subject_qq=?,status=?,version=version+1,updated_at=?,data=? WHERE id=? AND version=?').run(fields.characterId, fields.scopeKey, fields.subjectQQ, fields.status, at, JSON.stringify(fields.data), recordId, expectedVersion)
      this.touch()
      return this.get(recordId, { includeDeleted: true })
    })
  }
  audit(actor, action, target, before, after, reason = '', requestId = '') {
    // 审计只保存元信息和变化字段名；原文不会经通用历史接口泄露。
    const summary = r => r ? { id: r.id, kind: r.kind, version: r.version, status: r.status, characterId: r.characterId, scopeKey: r.scopeKey, fields: Object.keys(r.data ?? {}) } : null
    this.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?,?)').run(id('audit'), nowISO(), JSON.stringify(actor), action, target ?? '', JSON.stringify(summary(before)), JSON.stringify(summary(after)), String(reason), requestId)
  }
  once(namespace, requestId, payload, fn) {
    if (typeof requestId !== 'string' || !requestId || requestId.length > 200) throw new DomainError('REQUEST_ID_REQUIRED', '请提交幂等 requestId')
    return this.tx(() => {
      const hash = digest(stableJSON(payload)); const prior = this.db.prepare('SELECT * FROM requests WHERE namespace=? AND request_id=?').get(namespace, requestId)
      if (prior) {
        if (prior.hash !== hash) throw new DomainError('IDEMPOTENCY_CONFLICT', '同一 requestId 对应不同请求', 409)
        return JSON.parse(prior.result)
      }
      const result = fn()
      if (result?.then) throw new DomainError('ASYNC_TRANSACTION', '幂等事务不能包含异步操作', 500)
      this.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?)').run(namespace, requestId, hash, JSON.stringify(result ?? null), nowISO())
      return result
    })
  }
  stash(record, expiresAt) { this.db.prepare('INSERT OR REPLACE INTO trash VALUES(?,?,?)').run(record.id, JSON.stringify(record), expiresAt) }
  recover(recordId, now = nowISO()) {
    this.db.prepare('DELETE FROM trash WHERE expires_at<=?').run(now)
    const row = this.db.prepare('SELECT payload FROM trash WHERE id=?').get(recordId)
    return row ? JSON.parse(row.payload) : null
  }
  purgeTrash(at = nowISO()) { this.db.prepare('DELETE FROM trash WHERE expires_at<=?').run(at) }
  async backup(destination) {
    const target = resolve(destination)
    if (target === this.path) throw new DomainError('INVALID_BACKUP_PATH', '备份不能覆盖当前数据库')
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    await backup(this.db, target)
    return target
  }
  restoreFile(source) {
    // 调用方已暂停任务、验证确认令牌，并保留恢复前快照。
    const check = new DatabaseSync(source, { readOnly: true })
    try {
      if (check.prepare('PRAGMA user_version').get().user_version !== 1 || check.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new DomainError('INVALID_BACKUP', '备份版本或完整性不兼容')
    } finally { check.close() }
    const oldPath = `${this.path}.restore-old`
    if (existsSync(oldPath)) throw new DomainError('RESTORE_PENDING', '存在未完成恢复的旧数据库，请先人工处理', 409)
    this.recovery = null
    this.failedPath = null
    let stage = 'close'
    try {
      this.close()
      // 关闭失败时不得继续移动文件：句柄仍被占用，后续替换会造成数据错配
      if (this.closeError) throw this.closeError
      stage = 'move-old'
      const hadCurrent = existsSync(this.path)
      if (hadCurrent) moveDatabase(this.path, oldPath)
      stage = 'place-new'
      // 暂存库若自带 sidecar 也一并就位，避免主库与日志错配
      moveDatabase(source, this.path)
      stage = 'reopen'
      this.open()
      if (hadCurrent) {
        stage = 'cleanup-old'
        try { unlinkSync(oldPath) } catch (error) {
          // 新库已可用，清理旧库失败只记录状态，绝不因此回退或关闭新库；此时 sidecar 原样保留
          this.recovery = { state: 'old-retained', path: oldPath, at: nowISO(), reason: String(error?.message ?? error ?? '') }
          return { restored: true, oldRetained: true, oldPath }
        }
        // 主库删除成功后再尽力清 sidecar；残留的 .restore-old-wal 不会被任何连接读取
        try { removeSidecars(oldPath) } catch { /* 忽略：无对应主库的 sidecar 不会被读取 */ }
      }
      this.recovery = { state: 'restored', at: nowISO(), replacedOld: hadCurrent }
      return { restored: true, oldRetained: false }
    } catch (error) {
      // stage 为 close 时连接可能未真正关闭，禁止清理 sidecar，避免破坏仍被占用的 WAL
      const recovered = this.reopenOriginal(oldPath, { detachSidecars: stage !== 'close' })
      const kept = existsSync(oldPath) ? '，旧库保留为 .restore-old' : ''
      const message = recovered
        ? (this.recovery?.state === 'rolled-back-old' ? '恢复失败，已回滚原库并重新打开连接' : '恢复失败，已重新打开当前库，请核对数据状态')
        : `恢复失败且原库未能自动回滚${kept}，请人工处理`
      throw new DomainError('RESTORE_FAILED', message, 500, { stage, oldPath, recovered, recovery: this.recovery, failedPath: this.failedPath ?? null, cause: String(error?.message ?? error) })
    }
  }
  // 恢复失败后的兜底：有 .restore-old 就换回并重开；无旧库时绝不删主库，只尝试重开原文件。
  // 无法确定可用性的主库一律连 sidecar 一起改名为 .restore-failed-* 留证，不做删除。
  reopenOriginal(oldPath, { detachSidecars = true } = {}) {
    try {
      if (existsSync(oldPath)) {
        if (existsSync(this.path)) {
          const failedPath = `${this.path}.restore-failed-${Date.now()}`
          try {
            if (detachSidecars) moveDatabase(this.path, failedPath)
            else renameSync(this.path, failedPath)
          } catch { return false }
          this.failedPath = failedPath
        } else if (detachSidecars) {
          try { parkSidecars(this.path) } catch { return false }
        }
        try { moveDatabase(oldPath, this.path) } catch { return false }
        this.open()
        this.recovery = { state: 'rolled-back-old', path: oldPath, at: nowISO(), failedPath: this.failedPath ?? null }
        return true
      }
      // 没有旧库：主库可能仍然完好（失败发生在换出之前），先用它自己的 sidecar 打开，失败后才挪开 sidecar 重试
      if (!existsSync(this.path)) return false
      try { this.open(); this.recovery = { state: 'reopened-current', at: nowISO() }; return true } catch { /* 继续尝试 */ }
      if (!detachSidecars) return false
      try {
        const parked = parkSidecars(this.path)
        this.open()
        this.recovery = { state: 'reopened-current', at: nowISO(), parkedSidecars: parked }
        return true
      } catch { return false }
    } catch { return false }
  }
  close() {
    // 显式状态先行：无论底层关闭是否报错，都不再把这层连接视为可用；失败记录到 closeError 供换库流程判断。
    const db = this.db
    this.db = null
    this.opened = false
    this.closeError = null
    if (!db) return
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch (error) { this.closeError = error }
    try { db.close() } catch (error) { this.closeError ??= error }
  }
}
