// dsh-qq-companion-memory · qq-bridge 薄适配层
//
// 依赖纪律：**零裸导入** —— 只 import `node:` 内置模块（fs/path/crypto），HTTP 用全局 fetch。
// 因此本文件可以原样复制进部署目录 `/opt/qq-bridge/integration/`，不需要改桥接的
// package.json、不需要 npm install。
//
// 职责边界（只做适配，不做业务判断）：
//   1. 可信入站事件规范化 + 持久化（先落 outbox，再由后台重放；失败只告警，不阻塞聊天）
//   2. 角色 → 稳定 UUID 映射（显式改名保留 ID；绝不按内容哈希/名字自动合并两个角色）
//   3. 会话绑定与**实际**发送 message_id 上报（交给插件做归属与消息引用）
//   4. 管理员命令转交（只认真实 ownerQQ，且必须在管理员白名单内）
//   5. 接管门控状态同步（旧 slang 注入/采集、旧群友印象读写）
//
// 无配置/配置不全时 createCompanionAdapter 返回 `enabled=false` 的空实现：
// 不建目录、不起定时器、不发请求、不改变桥接任何行为。
//
// 内部接口（Bearer token），字段与 docs/IMPLEMENTATION.md + src/adapters/dsh/http.js 一致：
//   POST <endpoint>/qq-companion-memory/internal/v1/events
//   POST .../bindings
//   POST .../deliveries
//   POST .../commands
//   POST .../acknowledgements   （接管确认：桥接回执「旧能力已关」）
//   GET  .../controls           （当前接管清单，含 status/acknowledged/desiredOwner）
// 请求体加 `requestId`（幂等键，重放时不变）。HTTP 2xx 且 ok!==false 视为已处理。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const SCHEMA_VERSION = 1
const INTERNAL_BASE = '/qq-companion-memory/internal/v1'
const ROLES_VERSION = 1
const CURSOR_VERSION = 1
const TAKEOVER_VERSION = 1
const MAX_SEGMENTS = 40
const MAX_QUOTE_REFS = 20
const RECENT_EVENT_LIMIT = 5000
const SEGMENT_KEYS = ['text', 'id', 'qq', 'url', 'file', 'summary', 'name', 'title', 'content']
// 转发/合并转发段：forward 是合并转发，node 是合并转发里的节点。两者都不能算有效新证据。
const FORWARD_SEGMENT_TYPES = new Set(['forward', 'node'])

const nowISO = (at) => new Date(Number.isFinite(at) ? at : Date.now()).toISOString()
// cleanText 只用于**派生展示字段**（角色名、失败原因、命令回复），绝不用于消息正文：
// 正文必须原样保留，截断/替换会无声改变证据原文。
const cleanText = (value, max = 200) => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
  .trim()
  .slice(0, max)
/** 原文保全：只做字符串化，不做 trim / 控制字符替换 / 截断。 */
const sourceText = (value) => String(value ?? '')
const isQQ = (value) => /^[1-9]\d{0,19}$/.test(String(value ?? ''))
const idList = (value) => (Array.isArray(value) ? [...new Set(value.map((v) => String(v).trim()).filter(isQQ))] : [])
const clampInt = (value, min, max, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback
}
const roleName = (value) => String(value ?? '').replace(/[^\w\u4e00-\u9fff-]/g, '').slice(0, 100)

// 桥接自有的管理命令：必须继续由桥接执行（会话重置 / 静默 / 角色切换 / 状态），
// 适配层只转交「记忆与学习」类命令，避免把桥接生命周期命令抢走。
const BRIDGE_BUILTIN_COMMANDS = new Set(['/reset', '/new', '/status', '/silent', '/quiet', '/active', '/speak'])
const isBridgeBuiltin = (text) => {
  const head = String(text ?? '').trim().split(/\s+/)[0].toLowerCase()
  return BRIDGE_BUILTIN_COMMANDS.has(head) || head === '/role'
}

/** OneBot 的 event.time 是秒；部分网关给毫秒。非法/越界一律返回 null（= 时间未知）。 */
export function normalizeOccurredAt(raw) {
  if (raw === undefined || raw === null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  const ms = n > 1e12 ? n : n * 1000
  const lower = Date.UTC(2000, 0, 1)
  const upper = Date.now() + 24 * 60 * 60 * 1000
  if (!Number.isFinite(ms) || ms < lower || ms > upper) return null
  return new Date(ms).toISOString()
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return fallback
  }
}

/** 按字节切行：返回 [{start,end,complete}]，end 不含换行符；complete=false 表示末尾残行。 */
function splitLines(buffer) {
  const lines = []
  let start = 0
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] !== 0x0a) continue
    lines.push({ start, end: i, complete: true })
    start = i + 1
  }
  if (start < buffer.length) lines.push({ start, end: buffer.length, complete: false })
  return lines
}

/** 配置不全时的空实现：所有方法可调用、全部无副作用。 */
export class DisabledCompanionAdapter {
  constructor(reason = 'disabled') {
    this.enabled = false
    this.reason = String(reason)
    this.characterId = null
    this.bindingVersion = 0
  }
  roleToken() { return '' }
  roleTokenMatches() { return false }
  sessionToken() { return '' }
  occurredAtFor(raw) { return normalizeOccurredAt(raw) }
  captureOwnership() { return null }
  captureInbound() { return { ok: false, disabled: true, reason: this.reason } }
  reportBinding() { return { ok: false, disabled: true, reason: this.reason } }
  reportDelivery() { return { ok: false, disabled: true, reason: this.reason } }
  async forwardCommand() { return { handled: false, disabled: true, reason: this.reason } }
  noteRoleSwitch() { return null }
  noteRoleState() { return null }
  noteRoleRenamed() { return { ok: false, disabled: true, reason: this.reason } }
  noteRoleDeleted() { return { ok: false, disabled: true, reason: this.reason } }
  isTakeoverActive() { return false }
  async syncTakeover() { return { active: false, reason: 'disabled' } }
  async acknowledgeTakeover() { return { ok: false, reason: 'disabled' } }
  status() { return { enabled: false, reason: this.reason } }
  close() {}
}

export class CompanionAdapter {
  constructor(options = {}) {
    const config = options.config && typeof options.config === 'object' ? options.config : {}
    this.logger = typeof options.logger === 'function' ? options.logger : () => {}
    this.clock = typeof options.clock === 'function' ? options.clock : Date.now
    this.fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : null

    if (config.enabled === false) throw new Error('companion.enabled=false')

    // ── Bearer token：配置或文件，二者只能其一；任何日志/错误里都经 _redact 抹掉 ──
    const inlineToken = String(config.token ?? '').trim()
    const tokenFile = String(config.tokenFile ?? '').trim()
    if (inlineToken && tokenFile) throw new Error('companion.token 与 companion.tokenFile 只能配置一项')
    let token = inlineToken
    if (!token && tokenFile) {
      try {
        token = fs.readFileSync(tokenFile, 'utf8').trim()
      } catch (error) {
        throw new Error(`读取 companion.tokenFile 失败（${error?.code ?? 'IO'}；未输出文件内容）`)
      }
    }
    if (!token) throw new Error('未配置 companion.token / companion.tokenFile')
    // 插件侧 registerInternal 要求 ≥32 字符，过短会整体拒绝内部接口；这里提前给明确提示。
    if (token.length < 32) throw new Error(`companion token 过短（插件要求至少 32 字符，当前 ${token.length}）`)
    this.token = token

    const endpoint = String(config.endpoint ?? '').trim().replace(/\/+$/, '')
    if (!/^https?:\/\//.test(endpoint)) throw new Error('companion.endpoint 必须是 http(s) 地址')
    this.endpoint = endpoint
    this.internalBase = String(config.internalBasePath ?? INTERNAL_BASE).replace(/\/+$/, '')
    try { this.endpointLabel = new URL(endpoint).host } catch { this.endpointLabel = '（无法解析）' }

    const stateDir = String(config.stateDir ?? options.stateDir ?? '').trim()
    if (!stateDir) throw new Error('缺少 companion 状态目录（stateDir）')
    this.stateDir = path.resolve(stateDir)

    // ── 白名单闸门（与桥接 allowed() 同语义，独立再校验一次）──
    const gate = options.gate && typeof options.gate === 'object' ? options.gate : {}
    this.gate = {
      allow: { private: idList(gate.allow?.private), groups: idList(gate.allow?.groups) },
      deny: { private: idList(gate.deny?.private), groups: idList(gate.deny?.groups) },
      allowAllWhenEmpty: gate.allowAllWhenEmpty === true
    }

    this.ownerQQ = isQQ(options.ownerQQ) ? String(options.ownerQQ) : ''
    this.adminQQs = idList(config.adminQQs)

    this.requestTimeoutMs = clampInt(config.requestTimeoutMs, 1000, 30000, 8000)
    this.maxOutboxBytes = clampInt(config.outboxMaxBytes, 256 * 1024, 256 * 1024 * 1024, 8 * 1024 * 1024)
    this.maxPendingRecords = clampInt(config.outboxMaxPendingRecords, 100, 200000, 5000)
    this.maxContentChars = clampInt(config.maxContentChars, 1000, 200000, 20000)
    // 服务端要求 bindingVersion 为正整数（见 service.js bind）：
    // 1 是第一个真实绑定，之后每次角色切换 +1。
    this.bridgeVersion = String(config.bridgeVersion ?? '0.2.1-r1')

    this.takeoverConfig = {
      enabled: config.takeover?.enabled === true,
      // 服务端已有 /controls（GET），返回 takeovers 清单；不需要新接口。
      controlsPath: String(config.takeover?.controlsPath ?? '/controls'),
      pollMs: clampInt(config.takeover?.pollIntervalSeconds, 30, 3600, 300) * 1000
    }
    this.takeover = {
      active: false,
      scopes: [],
      confirmedAt: null,
      checkedAt: null,
      stale: false,
      reason: this.takeoverConfig.enabled ? 'pending' : 'disabled',
      pendingAcks: []
    }
    // 已确认「旧能力已关」的范围：落盘，重启/GET 失败都不得自行恢复旧注入，
    // 只有服务端明确的 rollback（desiredOwner=legacy）回执成功后才会移除。
    this.disabledScopes = new Map()
    this.ackedVersions = new Map()

    this.outboxPath = path.join(this.stateDir, 'outbox.jsonl')
    this.cursorPath = path.join(this.stateDir, 'outbox.cursor.json')
    this.rolesPath = path.join(this.stateDir, 'roles.json')
    this.takeoverPath = path.join(this.stateDir, 'takeover.json')

    this.logger('info', `适配层准备落盘：${this.stateDir}`)
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })

    this.roles = this._loadRoles()
    this.botQQ = ''
    const persistedTakeover = this._loadTakeover()
    this.disabledScopes = new Map(persistedTakeover.disabledScopes)
    this.ackedVersions = new Map(persistedTakeover.ackedVersions)
    if (this.disabledScopes.size) {
      this.takeover = {
        ...this.takeover,
        active: true,
        scopes: [...this.disabledScopes.keys()],
        reason: 'restored-disabled',
        stale: true
      }
    }
    this.cursor = this._loadCursor()
    if(!fs.existsSync(this.outboxPath) && fs.existsSync(`${this.outboxPath}.1`)){
      fs.copyFileSync(`${this.outboxPath}.1`,this.outboxPath)
      this.cursor={...this.cursor,offset:0}
      this._persistCursor()
    }
    this.outboxBytes = this._fileSize(this.outboxPath)
    const scanned = this._scanOutbox()
    this.nextSeq = scanned.lastSeq + 1
    if (this.cursor.offset > this.outboxBytes) this.cursor.offset = 0
    this.pendingRecords = scanned.pendingAfterOffset
    this.outboxFull = false
    this.failures = 0
    this.retryAt = 0
    this.lastError = ''
    this.lastFlushAt = 0
    this.flushing = null
    this.flushScheduled = false
    this.flushTimer = null
    this.takeoverTimer = null
    this.recentEventIds = new Set()
    this.warnAt = new Map()
    this.closed = false
    this.enabled = true

    this._startTimers()
  }

  // ── 角色映射 ─────────────────────────────────────────────────────────────

  get characterId() {
    const active = this.roles?.active
    return active && this.roles.byId[active] ? active : null
  }

  get bindingVersion() {
    // 服务端要求正整数，且同一范围的新版本必须严格大于旧版本（service.js bind 里的
    // STALE_BINDING / BINDING_COLLISION 判定）。所以用 epoch+1：epoch=0 → 1，
    // 每次真实角色切换都严格递增，不会出现「两个会话同版本」被 409 拒掉。
    const epoch = Number.isSafeInteger(this.roles?.epoch) ? this.roles.epoch : 0
    return epoch + 1
  }

  /** 会话隔离令牌：角色切换 → epoch 递增 → 令牌变化 → 桥接 sessionPolicy 变化 → 旧 DSH 会话被退役。
   *  epoch=0（还没发生过切换，含首次启用时桥接已有的角色）返回空串：
   *  policy 与历史持久化值完全一致，不会因为「刚启用适配层」而误退役全部会话。 */
  roleToken() {
    if (!this.enabled) return ''
    const active = this.characterId
    const epoch = Number.isSafeInteger(this.roles?.epoch) ? this.roles.epoch : 0
    if (!active || epoch === 0) return ''
    return `${active}#${epoch}`
  }

  roleTokenMatches(token) {
    return Boolean(this.enabled && token) && String(token) === this.roleToken()
  }

  sessionToken() {
    return this.roleToken()
  }

  /**
   * 捕获**不可变**归属快照：必须在真正发起异步发送之前调用。
   * 发送 Promise 解析时角色可能已经切换；那时再读 this.characterId / epoch
   * 会把结果错记到新角色身上。回执一律用这里捕获的值。
   */
  captureOwnership(input = {}) {
    if (!this.enabled) return null
    const conversationKey = String(input.conversationKey ?? '')
    if (!/^(private|group):[1-9]\d{0,19}$/.test(conversationKey)) return null
    const characterId = String(this.characterId ?? '')
    if (!characterId) return null
    return Object.freeze({
      sessionId: String(input.sessionId ?? ''),
      characterId,
      conversationKey,
      bindingVersion: this.bindingVersion,
      botQQ: String(input.botQQ ?? this.botQQ ?? ''),
      capturedAt: nowISO(this.clock())
    })
  }

  _roleSnapshot() {
    const epoch = Number.isSafeInteger(this.roles?.epoch) ? this.roles.epoch : 0
    return {
      characterId: this.characterId,
      epoch,
      bindingVersion: this.bindingVersion,
      tokenActive: Boolean(this.roleToken()),
      active: this.characterId ? { id: this.characterId, name: this.roles.byId[this.characterId]?.name ?? '' } : null
    }
  }

  /**
   * 名字 → characterId。已登记名字必须复用同一 UUID。
   *
   * 删除/失效纪律：
   *  - 已删除的旧 ID 永久 retired，**绝不复用**（否则旧记忆会被当成新角色自己的）。
   *  - 同名重新出现时新建全新 UUID，并记 `recreatedFrom` 供审计；新 UUID 不继承旧记忆，
   *    采集因此不会被挡住（不要求用户先人为切换一次角色）。
   */
  _ensureRole(name) {
    const key = roleName(name)
    if (!key) return null
    const existing = this.roles.byName[key]
    if (existing && this.roles.byId[existing] && !this.roles.byId[existing].retiredAt) return existing
    const retiredId = existing && this.roles.byId[existing]?.retiredAt ? existing : null
    if (retiredId) {
      this.logger('warn', `角色名「${key}」曾属于已删除的 characterId=${retiredId}：建新角色（旧记忆不继承）`)
      delete this.roles.byName[key]
    }
    const retiredSameName = retiredId ? null : Object.values(this.roles.byId)
      .find((entry) => entry && entry.retiredAt && roleName(entry.name) === key)
    const at = nowISO(this.clock())
    const id = crypto.randomUUID()
    this.roles.byId[id] = {
      id,
      name: key,
      createdAt: at,
      updatedAt: at,
      renamedFrom: [],
      retiredAt: null,
      // 只记录来源，方便审计「这个名字以前是谁」；不据此合并记忆。
      recreatedFrom: retiredId || retiredSameName?.id || null
    }
    this.roles.byName[key] = id
    this._persistRoles()
    this.logger('info', `新角色登记：${key} → characterId=${id}${retiredId || retiredSameName ? '（同名重建，不复用旧记忆）' : ''}`)
    return id
  }

  characterIdFor(name) {
    if (!this.enabled) return null
    try { return this._ensureRole(name) } catch (error) {
      this.logger('error', `角色登记失败：${this._redact(error?.message ?? error)}`)
      return null
    }
  }

  /** 内部 epoch 递增（从 0 起）；上报用的 bindingVersion 是 max(1, epoch)。 */
  _bumpEpoch() {
    const current = Number.isSafeInteger(this.roles?.epoch) ? this.roles.epoch : 0
    this.roles.epoch = current + 1
    return this.roles.epoch
  }

  /** 角色切换钩子：只有名字真的变了才推进 epoch（静默/活跃切换不算）。 */
  noteRoleSwitch(change = {}) {
    if (!this.enabled) return null
    try {
      const from = roleName(change.from)
      const to = roleName(change.to)
      if (from === to) return this._roleSnapshot()
      const previous = this.roles.active
      const target = to ? this._ensureRole(to) : null
      if (target !== previous) {
        this.roles.active = target
        this._bumpEpoch()
        this.roles.updatedAt = nowISO(this.clock())
        this._persistRoles()
        this.logger('info', `角色切换：${from || '（无）'} → ${to || '（无）'}；会话 epoch=${this.roles.epoch}`)
      }
      return this._roleSnapshot()
    } catch (error) {
      this.logger('error', `角色切换记账失败：${this._redact(error?.message ?? error)}`)
      return null
    }
  }

  /** 桥接 current-role.json 变化时调用。
   *  首次（基线）只登记当前角色、**不**推进 epoch：启用适配层本身不能让既有会话全部退役。
   *  之后每次按名字比较，只有角色真的变了才推进 epoch。
   *
   *  另外：启动时若适配层已有 roles.json 但 active 为空（上次退出时无角色 / 只跑过空基线），
   *  而桥接当前确实有角色，则把它当作**启动基线**收养（不推进 epoch）。
   *  否则必须先由用户切换一次角色才能采集，这是不必要的门槛。 */
  noteRoleState(state = {}) {
    if (!this.enabled) return null
    try {
      const target = roleName(state?.role)
      const epoch = Number.isSafeInteger(this.roles?.epoch) ? this.roles.epoch : 0
      const adoptAsBaseline = this.roles.baseline !== true || (!this.roles.active && epoch === 0)
      if (adoptAsBaseline) {
        const adopted = target ? this._ensureRole(target) : null
        this.roles.active = adopted
        this.roles.baseline = true
        this.roles.updatedAt = nowISO(this.clock())
        this._persistRoles()
        this.logger('info', `角色基线登记：${target || '（无角色）'}（epoch 保持 ${this.bindingVersion}）`)
        return this._roleSnapshot()
      }
      const from = this.roles.byId[this.roles.active]?.name ?? null
      return this.noteRoleSwitch({ from, to: target, mode: state?.mode })
    } catch (error) {
      this.logger('error', `角色状态同步失败：${this._redact(error?.message ?? error)}`)
      return null
    }
  }

  /** 显式改名钩子：迁移名字映射并保留同一 characterId，绝不按内容/哈希合并。 */
  noteRoleRenamed(change = {}) {
    if (!this.enabled) return { ok: false, disabled: true }
    const from = roleName(change.from)
    const to = roleName(change.to)
    if (!from || !to || from === to) return { ok: false, reason: 'invalid-rename' }
    try {
      const fromId = this.roles.byName[from]
      // 旧名字没有有效映射（从未登记或已删除）：改名不能凭名字新建 UUID，否则等于伪造历史。
      if (!fromId || !this.roles.byId[fromId] || this.roles.byId[fromId].retiredAt) {
        this.logger('warn', `角色改名跳过：${from} 没有有效 characterId 映射（已删除或未登记）`)
        return { ok: false, reason: 'unknown-source' }
      }
      const targetId = this.roles.byName[to]
      if (targetId && targetId !== fromId) {
        this.logger('error', `角色改名冲突：${to} 已绑定另一个 characterId，拒绝自动合并（需人工处理）`)
        return { ok: false, reason: 'rename-conflict', characterId: fromId }
      }
      delete this.roles.byName[from]
      this.roles.byName[to] = fromId
      const entry = this.roles.byId[fromId]
      if (entry) {
        entry.name = to
        entry.renamedFrom = Array.from(new Set([...(entry.renamedFrom || []), from])).slice(-20)
        entry.updatedAt = nowISO(this.clock())
      }
      this._persistRoles()
      this.logger('info', `角色改名：${from} → ${to}（characterId 保持不变，epoch 不推进）`)
      return { ok: true, characterId: fromId }
    } catch (error) {
      this.logger('error', `角色改名记账失败：${this._redact(error?.message ?? error)}`)
      return { ok: false, reason: 'persist-failed' }
    }
  }

  noteRoleDeleted(change = {}) {
    if (!this.enabled) return { ok: false, disabled: true }
    const name = roleName(change.name)
    if (!name) return { ok: false, reason: 'invalid-name' }
    try {
      const id = this.roles.byName[name]
      if (!id) return { ok: true, characterId: null }
      delete this.roles.byName[name]
      const entry = this.roles.byId[id]
      if (entry) { entry.retiredAt = nowISO(this.clock()); entry.updatedAt = entry.retiredAt }
      if (this.roles.active === id) {
        this.roles.active = null
        this._bumpEpoch()
      }
      this._persistRoles()
      this.logger('info', `角色删除：${name}（characterId=${id} 保留历史，名字映射解除）`)
      return { ok: true, characterId: id }
    } catch (error) {
      this.logger('error', `角色删除记账失败：${this._redact(error?.message ?? error)}`)
      return { ok: false, reason: 'persist-failed' }
    }
  }

  // ── 入站采集 ─────────────────────────────────────────────────────────────

  isTrustedConversation(kind, id) {
    const group = kind === 'group'
    const bucket = group ? 'groups' : 'private'
    const value = String(id)
    if (this.gate.deny[bucket].includes(value)) return false
    const allow = this.gate.allow[bucket]
    if (allow.length > 0) return allow.includes(value)
    return this.gate.allowAllWhenEmpty
  }

  captureInbound(input = {}) {
    if (!this.enabled) return { ok: false, disabled: true }
    try {
      const event = input.event && typeof input.event === 'object' ? input.event : {}
      const kind = input.kind === 'group' ? 'group' : 'private'
      const conversationId = String(input.conversationId ?? (kind === 'group' ? event.group_id : event.user_id) ?? '')
      if (!isQQ(conversationId)) return { ok: false, reason: 'invalid-conversation' }
      if (!this.isTrustedConversation(kind, conversationId)) return { ok: false, reason: 'not-allowlisted' }

      const senderQQ = String(kind === 'group'
        ? (event.sender?.user_id ?? event.user_id ?? '')
        : (event.user_id ?? ''))
      if (!isQQ(senderQQ)) return { ok: false, reason: 'invalid-sender' }
      if (String(event.user_id ?? '') === String(event.self_id ?? '')) return { ok: false, reason: 'self-message' }

      const media = Array.isArray(input.mediaList) ? input.mediaList : []
      // 原文保全：正文不做 trim / 控制字符替换 / 截断。超上限时整条 skip 并记日志，
      // 绝不截半——截断会把「原文」和「实际内容」无声拉开。
      const content = sourceText(input.plainContent ?? input.content ?? '')
      const quoteTargetIsSelf = input.quoteTargetIsSelf === true
      if (!content.trim() && !quoteTargetIsSelf && media.length === 0) return { ok: false, reason: 'empty' }

      // 服务端 ingest 需要有效 characterId 才能建立归属；没有可信角色时不写（不猜）。
      const characterId = this.characterId
      if (!characterId) {
        this._warnOnce('no-character', '当前没有已登记的角色：入站事件不写入（缺少可信归属，从启动角色状态建立映射）')
        return { ok: false, reason: 'no-character' }
      }
      const botQQ = String(event.self_id ?? '')
      if (!isQQ(botQQ)) return { ok: false, reason: 'invalid-bot-qq' }
      this.botQQ = botQQ

      const contentLimit = Math.min(this.maxContentChars, 200000)
      if (content.length > contentLimit) {
        this.logger('error', `入站消息超长（${content.length} > ${contentLimit} 字符），整条跳过而不截断（避免改变原文）`)
        return { ok: false, reason: 'content-too-large' }
      }

      const conversationKey = `${kind}:${conversationId}`
      const messageIdRaw = event.message_id ?? event.msg_id
      const messageId = messageIdRaw === undefined || messageIdRaw === null || messageIdRaw === '' ? '' : String(messageIdRaw)
      // botQQ 进 eventId：多机器人共用同一 OneBot 网关/群时，消息 ID 会重复，避免跨 bot 冲突。
      const eventId = messageId
        ? `qq:${botQQ}:${conversationKey}:${messageId}`
        : `qq:${botQQ}:${conversationKey}:nomid:${crypto.randomUUID()}`
      if (this.recentEventIds.has(eventId)) return { ok: true, duplicate: true, eventId }

      const occurredAt = normalizeOccurredAt(event.time)
      const payload = {
        schemaVersion: SCHEMA_VERSION,
        eventId,
        botQQ,
        characterId,
        characterName: this.roles.byId[characterId]?.name ?? '',
        conversationKey,
        groupId: kind === 'group' ? conversationId : '',
        senderQQ,
        messageId,
        // 时间未知时**不伪造** occurredAt，用 occurredAtUnknown 显式标记（服务端按 unknown 处理）。
        ...(occurredAt ? { occurredAt } : { occurredAtUnknown: true }),
        receivedAt: nowISO(this.clock()),
        content,
        quoteRefs: this._quoteRefs(event, messageId),
        sourceKind: 'qq',
        bindingVersion: this.bindingVersion,
        segments: this._segments(event.message),
        forwarded: this._isForward(event.message),
        hasMedia: media.length > 0,
        quoteTargetIsSelf
      }
      const result = this._enqueue('event', '/events', payload, `event:${eventId}`)
      // 只有真的落盘成功才记为「已见」：否则 outbox 写失败后再来同一条会被误判为重复而丢弃。
      if (result.ok) this._rememberEvent(eventId)
      else this.logger('error', `入站事件未能持久化（${conversationKey}）：${result.reason ?? 'unknown'}`)
      return { ok: result.ok, eventId, reason: result.reason }
    } catch (error) {
      const message = this._redact(error?.message ?? error)
      this.logger('error', `入站采集异常：${message}`)
      return { ok: false, reason: 'exception', error: message }
    }
  }

  _quoteRefs(event, messageId) {
    const refs = []
    const segments = Array.isArray(event.message) ? event.message : []
    for (const seg of segments.slice(0, MAX_SEGMENTS)) {
      if (seg?.type !== 'reply') continue
      const id = seg?.data?.id
      if (id === undefined || id === null || id === '') continue
      refs.push(String(id))
    }
    if (!refs.length && event.reply_to_message_id !== undefined && event.reply_to_message_id !== null) {
      refs.push(String(event.reply_to_message_id))
    }
    // 自身消息 ID 由 messageId 字段承担；quoteRefs 只放被引用 ID，避免重复。
    return [...new Set(refs.filter((ref) => ref && ref !== messageId))].slice(0, MAX_QUOTE_REFS)
  }

  _segments(message) {
    const list = Array.isArray(message) ? message : (typeof message === 'string' ? [{ type: 'text', data: { text: message } }] : [])
    const out = []
    const textLimit = Math.min(this.maxContentChars, 200000)
    for (const seg of list.slice(0, MAX_SEGMENTS)) {
      const type = cleanText(seg?.type, 24)
      if (!type) continue
      const data = seg?.data && typeof seg.data === 'object' ? seg.data : {}
      const item = { type }
      for (const key of SEGMENT_KEYS) {
        if (data[key] === undefined || data[key] === null) continue
        // 文本正文原样保留（不 trim/不替换），结构化短字段才走 cleanText。
        if (key === 'text') {
          const value = sourceText(data[key])
          if (value.length > textLimit) {
            this.logger('error', `消息段文本超长（${value.length} > ${textLimit} 字符），整段跳过而不截断`)
            continue
          }
          item[key] = value
          continue
        }
        item[key] = cleanText(data[key], 500)
      }
      out.push(item)
    }
    // 截断段数会丢内容：超出上限时整条标记 forwarded=false 但显式告知调用方。
    if (list.length > MAX_SEGMENTS) {
      this._warnOnce('segments-truncated', `消息段数 ${list.length} 超过上限 ${MAX_SEGMENTS}：仅提交前 ${MAX_SEGMENTS} 段，其余已丢弃并记日志`)
      this.logger('warn', `消息段被截断：${list.length} → ${MAX_SEGMENTS}（原文正文仍完整保存于 content）`)
    }
    return out
  }

  /** 转发/合并转发：转发消息不能算有效新证据（服务端 effective 判定会读 forwarded）。
   *  forward / node 都算转发；服务端另有 /^\s*\// 与 quoteRefs 规则，这里只补最直接的一层。 */
  _isForward(message) {
    const list = Array.isArray(message) ? message : []
    return list.some((seg) => FORWARD_SEGMENT_TYPES.has(String(seg?.type ?? '').toLowerCase()))
  }

  _rememberEvent(eventId) {
    this.recentEventIds.add(eventId)
    if (this.recentEventIds.size > RECENT_EVENT_LIMIT) {
      const first = this.recentEventIds.values().next().value
      if (first) this.recentEventIds.delete(first)
    }
  }

  // ── 绑定 / 发送结果 / 管理命令 ─────────────────────────────────────────

  reportBinding(binding = {}) {
    if (!this.enabled) return { ok: false, disabled: true }
    try {
      const sessionId = String(binding.sessionId ?? '')
      if (!sessionId) return { ok: false, reason: 'missing-session' }
      const conversationKey = String(binding.conversationKey ?? '')
      if (!/^(private|group):[1-9]\d{0,19}$/.test(conversationKey)) return { ok: false, reason: 'invalid-scope' }
      const characterId = String(binding.characterId ?? this.characterId ?? '')
      if (!characterId) return { ok: false, reason: 'no-character' }
      const payload = {
        schemaVersion: SCHEMA_VERSION,
        sessionId,
        characterId,
        characterName: cleanText(binding.characterName ?? this.roles.byId[characterId]?.name ?? '', 100),
        conversationKey,
        bindingVersion: this.bindingVersion,
        botQQ: String(binding.botQQ ?? ''),
        participants: idList(binding.participants).slice(0, 50),
        provider: String(binding.provider ?? ''),
        model: String(binding.model ?? '')
      }
      if (!isQQ(payload.botQQ)) return { ok: false, reason: 'missing-bot-qq' }
      const requestId = `binding:${sessionId}:${characterId}:${payload.bindingVersion}`
      return this._enqueue('binding', '/bindings', payload, requestId)
    } catch (error) {
      const message = this._redact(error?.message ?? error)
      this.logger('error', `绑定上报异常：${message}`)
      return { ok: false, reason: 'exception', error: message }
    }
  }

  /**
   * 发送结果上报。服务端契约（service.js delivery）：
   *   { sessionId, characterId, conversationKey, bindingVersion, success, messageId, content, sentAt }
   * - success!==true 或没有 messageId → 服务端记 not-confirmed，不当作已应用。
   * - 每次实际发送调用一次，逐条带真实 message_id；取不到 ID 也要上报 success:false。
   *
   * 归属纪律：`ownership` 必须是**发送前**捕获的快照（captureOwnership）。
   * 不得在此处读 live this.characterId / epoch —— 异步发送期间切角色会把旧结果
   * 错记到新角色。快照已过期（当前 epoch 变了）时仍按旧值上报，让服务端以
   * STALE_DELIVERY 拒绝/丢弃，绝不改写成新角色的归属。
   */
  reportDelivery(delivery = {}) {
    if (!this.enabled) return { ok: false, disabled: true }
    try {
      const ownership = delivery.ownership && typeof delivery.ownership === 'object' ? delivery.ownership : null
      const conversationKey = String(ownership?.conversationKey ?? delivery.conversationKey ?? '')
      if (!conversationKey) return { ok: false, reason: 'missing-conversation' }
      const messageId = delivery.messageId === undefined || delivery.messageId === null
        ? ''
        : String(delivery.messageId)
      const success = delivery.success === true && Boolean(messageId)
      const characterId = String(ownership?.characterId ?? '')
      const bindingVersion = Number(ownership?.bindingVersion)
      const sessionId = String(ownership?.sessionId ?? delivery.sessionId ?? '')
      if (!characterId) {
        // 没有发送前归属快照就无法证明这是谁发的：宁可不报，也不猜。
        this._warnOnce('delivery-no-ownership', '发送结果缺少发送前归属快照，已跳过上报（不把消息归给当前角色）')
        return { ok: false, reason: 'missing-ownership' }
      }
      if (!Number.isSafeInteger(bindingVersion) || bindingVersion < 1) return { ok: false, reason: 'missing-ownership' }
      const payload = {
        schemaVersion: SCHEMA_VERSION,
        sessionId,
        characterId,
        conversationKey,
        bindingVersion,
        success,
        messageId,
        // 正文原样：截断会让服务端登记的实际发送文本与真实发送不一致。
        content: sourceText(delivery.content ?? ''),
        sentAt: nowISO(this.clock()),
        // 失败原因只进桥接日志，不进契约字段（服务端不消费，避免误当内容）
        reason: success ? '' : cleanText(delivery.error ?? (messageId ? '' : 'no-message-id'), 300)
      }
      if (!payload.sessionId) {
        // 还没建立 DSH 会话就没有可信绑定，服务端会以 NO_BINDING 拒绝；不入队。
        return { ok: false, reason: 'missing-session' }
      }
      const requestId = `delivery:${payload.sessionId}:${payload.characterId}:${payload.bindingVersion}:${messageId || crypto.randomUUID()}`
      return this._enqueue('delivery', '/deliveries', payload, requestId)
    } catch (error) {
      const message = this._redact(error?.message ?? error)
      this.logger('error', `发送结果上报异常：${message}`)
      return { ok: false, reason: 'exception', error: message }
    }
  }

  /**
   * 只认真实 ownerQQ，且必须与插件管理员白名单（adminQQs）一致。
   *
   * 两条来源都必须满足（交集，而非并集）：
   *   ① 桥接侧 config.json 的 ownerQQ —— 真实账号所有权证明；
   *   ② 插件侧 companion.adminQQs —— 插件管理员白名单；
   *   ③ 加上 live ownerQQ（input.ownerQQ）兜底：桥接可能在适配层创建后才拿到 ownerQQ，
   *      或配置里 ownerQQ 与真实 event.user_id 类型不同（数字/字符串），这里统一按字符串比较。
   */
  isAdmin(senderQQ, liveOwnerQQ = '') {
    const qq = String(senderQQ ?? '')
    if (!isQQ(qq)) return false
    const owners = new Set([String(this.ownerQQ ?? ''), String(liveOwnerQQ ?? '')].filter(isQQ))
    if (!owners.size) {
      this._warnOnce('owner-missing', '没有可用 ownerQQ：管理命令不会转交（不猜管理员）')
      return false
    }
    if (!owners.has(qq)) return false
    if (!this.adminQQs.length) {
      this._warnOnce('admin-empty', 'companion.adminQQs 为空：管理命令不会转交（插件侧 assertOwner 也会拒绝）')
      return false
    }
    return this.adminQQs.includes(qq)
  }

  async forwardCommand(input = {}) {
    if (!this.enabled) return { handled: false, disabled: true }
    const conversationKey = String(input.conversationKey ?? '')
    const senderQQ = String(input.senderQQ ?? '')
    if (!conversationKey) return { handled: false, reason: 'missing-conversation' }
    if (!this.isAdmin(senderQQ, input.ownerQQ)) return { handled: false, reason: 'not-admin' }
    // 命令原文：不 trim、不替换控制字符（命令可能含敏感排版）；只做长度上限判断。
    const text = sourceText(input.text ?? '')
    if (!text.trimStart().startsWith('/')) return { handled: false, reason: 'not-command' }
    // 桥接自带命令（/reset、/silent、/role …）保持由桥接处理，适配层不抢生命周期命令。
    if (isBridgeBuiltin(text)) return { handled: false, reason: 'bridge-builtin' }
    if (text.length > Math.min(this.maxContentChars, 10000)) {
      this.logger('warn', `管理命令超长（${text.length} 字符），不转交也不截断`)
      return { handled: false, reason: 'command-too-large' }
    }
    const occurredAt = normalizeOccurredAt(input.occurredAt)
    const messageId = String(input.messageId ?? '')
    const requestId = `command:${conversationKey}:${messageId || crypto.randomUUID()}`
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      characterId: this.characterId ?? '',
      conversationKey,
      senderQQ,
      messageId,
      ...(occurredAt ? { occurredAt } : { occurredAtUnknown: true }),
      text,
      sourceKind: 'qq'
    }
    const result = await this._postRequest('/commands', { requestId, ...payload }, this.requestTimeoutMs)
    if (result.ok) {
      const value = result.value && typeof result.value === 'object' ? result.value : {}
      // 服务端未识别该命令时返回 { handled:false }；此时按「未处理」交给桥接原逻辑。
      const handled = value.handled === true
      // 服务端当前字段是 `reply`（management.js），历史上用过 `text`：两者都读。
      // 回复正文原样发送，不 trim / 不截断改变实际发出内容。
      const replyRaw = value.reply ?? value.text ?? ''
      const reply = sourceText(replyRaw)
      if (reply.length > 4000) {
        this.logger('warn', `管理命令回复超长（${reply.length} 字符），不下发并保留 handled=true（避免截断后发出一半）`)
        return { handled, reply: '', value, reason: 'reply-too-large' }
      }
      return { handled, reply, value }
    }
    // 插件不可用：命令落 outbox 后台重放，不丢；本次按「未处理」返回，聊天继续。
    const queued = this._enqueue('command', '/commands', payload, requestId)
    if (queued.ok) this.logger('warn', `管理命令未能即时转交（${result.error}），已进入 outbox 重放队列`)
    return { handled: false, queued: queued.ok, reason: result.error }
  }

  occurredAtFor(raw) {
    return normalizeOccurredAt(raw)
  }

  // ── 接管门控（旧 slang / 旧群友印象）────────────────────────────────────

  /**
   * 该会话范围是否必须停用旧能力。
   *
   * 判定只看**已落盘的停用集**（disabledScopes），不看瞬时 `takeover.active`：
   * 后者来自最近一次 GET，接口抖动或进程重启都会丢；若按它判定，就会出现
   * 「服务端仍 active、桥接却把旧 slang/印象又开回来」的双注入。
   * 一旦某个 scope 被停用过，只有服务端明确的 rollback 回执成功才会移除。
   */
  isTakeoverActive(key) {
    if (!this.enabled) return false
    const conversationKey = String(key ?? '')
    if (!conversationKey) return false
    if (this.disabledScopes.has('*')) return true
    return this.disabledScopes.has(conversationKey)
  }

  /** 落盘停用集与已回执版本（先落盘，再 ACK；顺序不可颠倒）。 */
  _persistTakeover() {
    const data = {
      version: TAKEOVER_VERSION,
      disabledScopes: [...this.disabledScopes.entries()].map(([scopeKey, entry]) => ({ scopeKey, ...entry })),
      ackedVersions: [...this.ackedVersions.entries()].map(([id, version]) => ({ id, version })),
      updatedAt: nowISO(this.clock())
    }
    const tmp = `${this.takeoverPath}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(tmp, this.takeoverPath)
  }

  _loadTakeover() {
    if (!fs.existsSync(this.takeoverPath)) return { disabledScopes: [], ackedVersions: [] }
    let raw
    try {
      raw = JSON.parse(fs.readFileSync(this.takeoverPath, 'utf8').replace(/^\uFEFF/, ''))
    } catch (error) {
      // 解析失败不能当作「没有停用范围」：那样会在服务端仍 active 时重开旧注入。
      throw new Error(`takeover.json 无法解析（${error?.message ?? error}）；为避免双注入，拒绝按空状态启动，请人工检查`)
    }
    if (!raw || raw.version !== TAKEOVER_VERSION) throw new Error(`takeover.json 版本不兼容（version=${raw?.version}），请人工检查`)
    const disabledScopes = (Array.isArray(raw.disabledScopes) ? raw.disabledScopes : [])
      .filter((entry) => entry && /^(\*|(private|group):[1-9]\d{0,19})$/.test(String(entry.scopeKey ?? '')))
      .map((entry) => [String(entry.scopeKey), {
        characterId: String(entry.characterId ?? ''),
        takeoverId: String(entry.takeoverId ?? ''),
        version: Number.isSafeInteger(entry.version) ? entry.version : 0,
        acknowledged: entry.acknowledged === true,
        at: String(entry.at ?? '')
      }])
    const ackedVersions = (Array.isArray(raw.ackedVersions) ? raw.ackedVersions : [])
      .filter((entry) => entry && entry.id)
      .map((entry) => [String(entry.id), Number(entry.version) || 0])
    return { disabledScopes, ackedVersions }
  }

  /** 记录一个必须停用旧能力的范围：**先落盘**，再返回；失败即抛。 */
  _disableScope(scopeKey, row = {}) {
    const key = String(scopeKey ?? '')
    if (!key) return
    const previous = this.disabledScopes.get(key) ?? {}
    this.disabledScopes.set(key, {
      characterId: String(row.characterId ?? previous.characterId ?? this.characterId ?? ''),
      takeoverId: String(row.id ?? previous.takeoverId ?? ''),
      version: Number.isSafeInteger(row.version) ? row.version : (previous.version ?? 0),
      acknowledged: false,
      at: previous.at || nowISO(this.clock())
    })
    this._persistTakeover()
  }

  _restoreScope(scopeKey) {
    const key = String(scopeKey ?? '')
    if (!key) return
    if (!this.disabledScopes.delete(key)) return
    this._persistTakeover()
  }

  /**
   * 拉取接管状态（GET /controls）。
   *
   * 服务端 /controls 返回 { features, scopes: <takeover 记录数组>, adminQQs }；
   * 每条记录形如 { id, characterId, scopeKey, version, status, operation, desiredOwner,
   * acknowledged, expectedBridgeVersion, ... }。
   *
   * 握手顺序（与 src/adapters/dsh/http.js + management.js 一致）：
   *   ① 管理端 manage('takeover',{operation:'activate'}) → status=pending, acknowledged=false
   *   ② 桥接看到 desiredOwner=companion 且未 acknowledged → **先落盘停用**该范围旧能力 → 回执
   *   ③ 服务端置 status=active, acknowledged=true → 召回端才开始注入
   *
   * fail-closed 规则：
   *   - GET 失败 / 返回里缺少某条已停用范围 / 没有自己的记录 → 一律保持停用，绝不自动恢复旧注入。
   *   - 只有 desiredOwner=legacy 的明确 rollback 才允许恢复旧能力（并 ACK false）。
   *   - 首次启用且从未接管过的 scope 不在停用集里 → 旧行为保持原样。
   */
  async syncTakeover() {
    if (!this.enabled) return { active: false, reason: 'disabled' }
    const checkedAt = nowISO(this.clock())
    if (!this.takeoverConfig.enabled) {
      // 配置关闭不等于可以重开旧能力：已停用的范围继续停用（fail-closed）。
      this.takeover = {
        active: this.disabledScopes.size > 0,
        scopes: [...this.disabledScopes.keys()],
        confirmedAt: null,
        checkedAt,
        stale: false,
        reason: this.disabledScopes.size ? 'disabled-but-scopes-pinned' : 'disabled',
        pendingAcks: []
      }
      if (this.disabledScopes.size) {
        this._warnOnce('takeover-off-pinned', `takeover.enabled=false，但状态文件里有 ${this.disabledScopes.size} 个已停用范围：继续保持停用（需显式 rollback 才恢复）`)
      }
      return this.takeover
    }
    const result = await this._getRequest(this.takeoverConfig.controlsPath, this.requestTimeoutMs)
    if (!result.ok) {
      // 拿不到确认时保持已落盘的停用集（不因瞬时故障把范围切回旧实现），只标记 stale。
      this.takeover = { ...this.takeover, checkedAt, stale: true, reason: result.error }
      this._warnOnce('takeover-stale', `接管状态接口不可用（${result.error}），沿用已落盘的停用状态`)
      return this.takeover
    }
    const value = result.value && typeof result.value === 'object' ? result.value : {}
    const list = Array.isArray(value) ? value
      : Array.isArray(value.scopes) ? value.scopes
        : Array.isArray(value.takeover) ? value.takeover
          : Array.isArray(value.rows) ? value.rows
            : []
    const characterId = String(this.characterId ?? '')
    const own = list.filter((row) => row && String(row.characterId ?? '') === characterId)

    // ① 明确 rollback（desiredOwner=legacy）：允许恢复旧能力，但必须 ACK false 完成闭环。
    const rollbacks = own.filter((row) => row.desiredOwner === 'legacy' || row.status === 'legacy' || row.status === 'rollback-pending')
    const rollbackAcks = []
    for (const row of rollbacks) {
      const scopeKey = String(row.scopeKey ?? '')
      if (!scopeKey) continue
      // 服务端侧已停用新注入；恢复旧能力是此状态下的唯一正确行为。
      if (this.disabledScopes.has(scopeKey)) {
        this.logger('info', `接管回滚：恢复 ${scopeKey} 的旧能力`)
        this._restoreScope(scopeKey)
      }
      if (row.acknowledged !== true) rollbackAcks.push(row)
    }

    // ② desiredOwner=companion 的范围：先落盘停用，再回执。
    const requested = own.filter((row) => row.desiredOwner === 'companion' && row.status !== 'legacy')
    let persistedChanged = false
    for (const row of requested) {
      const scopeKey = String(row.scopeKey ?? '')
      if (!scopeKey) continue
      if (!this.disabledScopes.has(scopeKey)) persistedChanged = true
      try {
        this._disableScope(scopeKey, row)
      } catch (error) {
        // 落盘失败 → 不能 ACK（否则服务端会 active，而本进程重启后旧注入会回来）。
        this.logger('error', `接管停用状态落盘失败（${scopeKey}）：${this._redact(error?.message ?? error)}；本轮不回执`)
        this.takeover = { ...this.takeover, checkedAt, stale: true, reason: 'persist-failed' }
        return this.takeover
      }
    }
    if (persistedChanged) {
      this.logger('info', `已落盘停用范围：${[...this.disabledScopes.keys()].join(', ') || '（无）'}`)
    }

    const acknowledged = requested.filter((row) => this.ackedVersions.get(String(row.id)) === Number(row.version))
    const pendingAcks = requested.filter((row) => this.ackedVersions.get(String(row.id)) !== Number(row.version))
    const confirmedAt = acknowledged
      .map((row) => String(row.acknowledgedAt ?? row.updatedAt ?? ''))
      .filter(Boolean)
      .sort()
      .pop() ?? (acknowledged.length ? checkedAt : null)
    this.takeover = {
      // 只要有任何范围被停用过就必须保持 active（fail-closed），即使 GET 里短暂看不到。
      active: this.disabledScopes.size > 0,
      scopes: [...this.disabledScopes.keys()],
      confirmedAt,
      checkedAt,
      stale: false,
      reason: acknowledged.length ? 'confirmed' : pendingAcks.length ? 'awaiting-ack' : requested.length ? 'requested' : this.disabledScopes.size ? 'pinned' : 'no-takeover',
      acknowledged: acknowledged.length,
      pendingAcks,
      rollbackAcks
    }
    if (!own.length && this.disabledScopes.size) {
      this._warnOnce('takeover-vanished', '服务端未返回本角色的接管记录，但本地仍有已停用范围：继续保持停用（不自动恢复旧注入）')
    }
    // 停用状态已落盘：现在才可以诚实回执。
    if (pendingAcks.length || rollbackAcks.length) await this.acknowledgeTakeover()
    return this.takeover
  }

  /**
   * 接管回执：POST /acknowledgements。
   * legacyDisabled=true 表示「本桥接已关闭该范围的旧输出（slang 注入/采集、旧群友印象读写）」。
   * 服务端会校验 legacyDisabled === (desiredOwner==='companion') 与 bridgeVersion 预期值。
   *
   * 顺序纪律（activate）：先停用并**落盘** → 再 ACK。ACK 失败或响应丢失只会保留停用状态并重试，
   * 绝不因为没收到确认就恢复旧注入。只有 rollback 分支才会 ACK legacyDisabled:false。
   */
  async acknowledgeTakeover() {
    if (!this.enabled) return { ok: false, reason: 'disabled' }
    const pending = Array.isArray(this.takeover?.pendingAcks) ? this.takeover.pendingAcks : []
    const rollbacks = Array.isArray(this.takeover?.rollbackAcks) ? this.takeover.rollbackAcks : []
    if (!pending.length && !rollbacks.length) return { ok: true, acknowledged: 0 }
    let acknowledged = 0
    for (const row of pending) {
      const expectedBridgeVersion = String(row.expectedBridgeVersion ?? '')
      if (expectedBridgeVersion && expectedBridgeVersion !== this.bridgeVersion) {
        this._warnOnce(`ack-ver-${row.id}`, `接管回执跳过（${row.scopeKey}）：插件预期桥接版本 ${expectedBridgeVersion}，实际 ${this.bridgeVersion}`)
        continue
      }
      const scopeKey = String(row.scopeKey ?? '')
      const body = {
        requestId: `ack:${row.id}:${row.version}`,
        id: String(row.id ?? ''),
        expectedVersion: Number(row.version),
        characterId: String(row.characterId ?? ''),
        conversationKey: scopeKey,
        bridgeVersion: this.bridgeVersion,
        // 只认「已落盘停用」，不认瞬时状态：回执必须能经受重启复核。
        legacyDisabled: this.disabledScopes.has(scopeKey)
      }
      if (!body.legacyDisabled) {
        this._warnOnce(`ack-scope-${row.id}`, `接管回执跳过（${scopeKey}）：该范围未进入已落盘停用集`)
        continue
      }
      const result = await this._postRequest('/acknowledgements', body, this.requestTimeoutMs)
      if (result.ok) {
        acknowledged += 1
        this.ackedVersions.set(String(row.id), Number(row.version))
        const entry = this.disabledScopes.get(scopeKey)
        if (entry) this.disabledScopes.set(scopeKey, { ...entry, acknowledged: true })
        try { this._persistTakeover() } catch (error) {
          this.logger('error', `接管已回执版本落盘失败（${scopeKey}）：${this._redact(error?.message ?? error)}`)
        }
        this.takeover = { ...this.takeover, pendingAcks: this.takeover.pendingAcks.filter((r) => r !== row) }
      } else {
        // 失败或响应丢失：保持停用，下一轮重试（服务端以 requestId 幂等）。
        this._warnOnce(`ack-${row.id}`, `接管回执失败（${scopeKey}）：${result.error}；旧能力保持停用`)
      }
    }
    for (const row of rollbacks) {
      const scopeKey = String(row.scopeKey ?? '')
      const expectedBridgeVersion = String(row.expectedBridgeVersion ?? '')
      if (expectedBridgeVersion && expectedBridgeVersion !== this.bridgeVersion) continue
      // 恢复旧能力只由明确 rollback 驱动；ACK false 表示「旧侧已恢复」。
      this._restoreScope(scopeKey)
      const body = {
        requestId: `ack-rollback:${row.id}:${row.version}`,
        id: String(row.id ?? ''),
        expectedVersion: Number(row.version),
        characterId: String(row.characterId ?? ''),
        conversationKey: scopeKey,
        bridgeVersion: this.bridgeVersion,
        legacyDisabled: false
      }
      const result = await this._postRequest('/acknowledgements', body, this.requestTimeoutMs)
      if (result.ok) {
        acknowledged += 1
        this.ackedVersions.set(String(row.id), Number(row.version))
        try { this._persistTakeover() } catch (error) {
          this.logger('error', `接管回滚回执落盘失败（${scopeKey}）：${this._redact(error?.message ?? error)}`)
        }
        this.logger('info', `接管回滚已确认：${scopeKey} 旧能力恢复`)
        this.takeover = { ...this.takeover, rollbackAcks: (this.takeover.rollbackAcks ?? []).filter((r) => r !== row) }
      } else {
        this._warnOnce(`ack-rollback-${row.id}`, `接管回滚回执失败（${scopeKey}）：${result.error}；旧能力保持恢复（新侧已停用）`)
      }
    }
    if (acknowledged) this.logger('info', `已回执 ${acknowledged}/${pending.length + rollbacks.length} 个范围的接管状态`)
    return { ok: true, acknowledged }
  }

  // ── outbox：追加 + 后台重放 ─────────────────────────────────────────────

  _enqueue(kind, uriPath, payload, requestId) {
    if (!this.enabled) return { ok: false, disabled: true }
    if (this.closed) return { ok: false, reason: 'closed' }
    try {
      if (this.outboxFull) return { ok: false, reason: 'outbox-full' }
      this._rotateIfNeeded()
      if (this.outboxFull) return { ok: false, reason: 'outbox-full' }
      const record = {
        seq: this.nextSeq,
        at: nowISO(this.clock()),
        kind,
        path: uriPath,
        requestId: String(requestId || crypto.randomUUID()),
        payload
      }
      const line = `${JSON.stringify(record)}\n`
      const fd = fs.openSync(this.outboxPath, 'a')
      try {
        fs.writeFileSync(fd, line, 'utf8')
        try { fs.fsyncSync(fd) } catch {}
      } finally {
        fs.closeSync(fd)
      }
      this.nextSeq += 1
      this.outboxBytes += Buffer.byteLength(line)
      this.pendingRecords = (Number(this.pendingRecords) || 0) + 1
      this._scheduleFlush(0)
      return { ok: true, seq: record.seq, requestId: record.requestId }
    } catch (error) {
      const message = this._redact(error?.message ?? error)
      this.lastError = `outbox 写入失败：${message}`
      this.logger('error', this.lastError)
      return { ok: false, reason: 'outbox-write-failed', error: message }
    }
  }

  get pendingCount() {
    return Math.max(0, Number(this.pendingRecords) || 0)
  }

  /** 一次扫描得出：最大 seq + 游标之后的待投递条数（重启后计数由此恢复）。
   *  按**字节**切行：多字节字符跨窗口/跨行时不产生偏移漂移。 */
  _scanOutbox() {
    const out = { lastSeq: 0, pendingAfterOffset: 0 }
    const size = this._fileSize(this.outboxPath)
    if (!size) return out
    let buffer
    try {
      buffer = fs.readFileSync(this.outboxPath)
    } catch (error) {
      this.logger('warn', `读取 outbox 失败：${this._redact(error?.message ?? error)}`)
      return out
    }
    const lines = splitLines(buffer)
    for (const { start, end, complete } of lines) {
      if (start < this.cursor.offset) continue
      if (!complete || end === start) continue // 末尾残行 / 空行不算待投递
      out.pendingAfterOffset += 1
      try {
        const record = JSON.parse(buffer.subarray(start, end).toString('utf8'))
        if (Number.isSafeInteger(record?.seq) && record.seq > out.lastSeq) out.lastSeq = record.seq
      } catch {}
    }
    return out
  }

  _rotateIfNeeded() {
    if (this.outboxBytes < this.maxOutboxBytes) return
    // 轮转会把文件换掉、游标归零；若正在 flush，批次里的绝对 offset 会全部失效。
    // 宁可暂时继续追加，等这一轮投递结束再回收。
    if (this.flushing) return
    if (this.pendingCount >= this.maxPendingRecords) {
      this.outboxFull = true
      this._warnOnce('outbox-full', `outbox 已达上限（${this.pendingCount} 条 / ${this.outboxBytes} 字节待投递），暂停入站写入以免静默丢材料；请检查插件内部接口与 Bearer token`)
      return
    }
    if (this.cursor.offset <= 0) {
      // 没有任何「已确认前缀」可回收：轮转不会缩小文件，放任增长到 pending 上限即可。
      this._warnOnce('outbox-grow', `outbox 超过 ${this.maxOutboxBytes} 字节但尚无已确认记录可回收，继续追加（上限 ${this.maxPendingRecords} 条）`)
      return
    }
    try {
      const remainder = this._readFrom(this.cursor.offset, Math.max(0, this.outboxBytes - this.cursor.offset))
      // 只保留完整行：末尾无换行的残行宁可丢弃（它本就是未落盘完成的半条）。
      const lastNewline = remainder.lastIndexOf(0x0a)
      const complete = lastNewline < 0 ? Buffer.alloc(0) : remainder.subarray(0, lastNewline + 1)
      const tmp = `${this.outboxPath}.tmp-${process.pid}`
      fs.writeFileSync(tmp, complete)
      this.cursor={...this.cursor,offset:0}
      this._persistCursor()
      const backup = `${this.outboxPath}.1`
      try { fs.rmSync(backup, { force: true }) } catch {}
      try { fs.renameSync(this.outboxPath, backup) } catch {}
      fs.renameSync(tmp, this.outboxPath)
      this.outboxBytes = complete.length
      this.cursor = { ...this.cursor, offset: 0 }
      // 轮转后重新计数：只算完整且非空的记录行。
      this.pendingRecords = splitLines(complete)
        .filter((line) => line.complete && line.end > line.start)
        .length
      this._persistCursor()
      this.logger('info', `outbox 已轮转，保留 ${this.pendingCount} 条待投递（旧文件：outbox.jsonl.1）`)
    } catch (error) {
      this.outboxFull = true
      this.logger('error', `outbox 轮转失败，暂停写入：${this._redact(error?.message ?? error)}`)
    }
  }

  _scheduleFlush(delayMs) {
    if (!this.enabled || this.closed || this.flushScheduled) return
    this.flushScheduled = true
    const timer = setTimeout(() => {
      this.flushScheduled = false
      this.flush().catch(() => {})
    }, Math.max(0, delayMs))
    if (typeof timer.unref === 'function') timer.unref()
  }

  async flush() {
    if (!this.enabled || this.closed) return
    if (this.flushing) return this.flushing
    if (this.pendingCount === 0) return
    if (Date.now() < this.retryAt) return
    this.flushing = (async () => {
      try {
        for (let round = 0; round < 20; round += 1) {
          const batch = this._nextBatch(200)
          if (!batch.items.length) break
          for (const item of batch.items) {
            if (item.corrupt) {
              this.logger('warn', 'outbox 中存在无法解析的记录，已跳过（不影响后续记录）')
              this._ack(item)
              continue
            }
            const record = item.record
            const result = await this._postRequest(record.path, { requestId: record.requestId, ...record.payload }, this.requestTimeoutMs)
            if (result.ok) {
              this._ack(item, record.seq)
              this.failures = 0
              this.outboxFull = false
              this.lastError = ''
              continue
            }
            if (!result.retry) {
              // 4xx/校验失败：重试不会成功，记录后跳过，避免队列永久卡死。
              this.lastError = `${record.kind} 被插件拒绝：${result.error}`
              this.logger('warn', `${this.lastError}（requestId=${record.requestId}）`)
              this._ack(item, record.seq)
              continue
            }
            this.failures += 1
            this.lastError = result.error
            this.retryAt = Date.now() + Math.min(60000, 1000 * 2 ** Math.min(6, this.failures))
            this._warnOnce('flush-fail', `投递失败（${result.error}），将退避重试；待投递 ${this.pendingCount} 条`)
            return
          }
          if (batch.items.length < 200) break
        }
        this.lastFlushAt = Date.now()
      } finally {
        this.flushing = null
      }
    })()
    return this.flushing
  }

  /** 推进游标并维护待投递计数（游标只能前进，防止乱序 ack 回退）。 */
  _ack(item, ackedSeq) {
    // 已经推进过的位置不再重复计数：否则同一条记录被 ack 两次会让 pending 少算。
    if (item.endOffset <= this.cursor.offset) return
    this.pendingRecords = Math.max(0, (Number(this.pendingRecords) || 0) - 1)
    this.cursor = {
      ackedSeq: Number.isSafeInteger(ackedSeq) ? ackedSeq : this.cursor.ackedSeq,
      offset: item.endOffset,
      updatedAt: nowISO(this.clock())
    }
    try { this._persistCursor() } catch (error) {
      this.logger('error', `游标持久化失败：${this._redact(error?.message ?? error)}`)
    }
  }

  _nextBatch(limit) {
    const windowBytes = 256 * 1024
    const buffer = this._readFrom(this.cursor.offset, windowBytes)
    const items = []
    if (!buffer.length) return { items }
    for (const { start, end, complete } of splitLines(buffer)) {
      if (!complete) break // 末尾残行（可能被截断）：不消费，下次从同一 offset 重读
      if (items.length >= limit) break
      const endOffset = this.cursor.offset + end + 1
      if (end === start) continue // 空行
      try {
        const record = JSON.parse(buffer.subarray(start, end).toString('utf8'))
        if (!record || typeof record !== 'object' || !record.path || !record.requestId) throw new Error('bad record')
        items.push({ record, endOffset })
      } catch {
        items.push({ corrupt: true, endOffset })
      }
    }    if (!items.length && buffer.length >= windowBytes && !buffer.includes(0x0a)) {
      // 这条记录本身超过窗口：整行读取（上限 4MB）再判。
      const oversized = this._readLineAt(this.cursor.offset, 4 * 1024 * 1024)
      if (oversized.complete) {
        try {
          const record = JSON.parse(oversized.line)
          if (!record || !record.path || !record.requestId) throw new Error('bad record')
          items.push({ record, endOffset: oversized.endOffset })
        } catch {
          items.push({ corrupt: true, endOffset: oversized.endOffset })
        }
      } else {
        this.outboxFull = true
        this._warnOnce('outbox-oversized', `outbox 中存在超过 ${oversized.limit} 字节且无换行的记录，无法解析，已暂停写入；请人工检查 ${this.outboxPath}`)
      }
    }
    return { items }
  }

  /** 从 offset 读一整行（不含换行符）。maxBytes 内找不到换行则 complete=false。 */
  _readLineAt(offset, maxBytes) {
    const buffer = this._readFrom(offset, maxBytes)
    const index = buffer.indexOf(0x0a)
    if (index < 0) return { complete: false, limit: maxBytes }
    return { complete: true, line: buffer.subarray(0, index).toString('utf8'), endOffset: offset + index + 1 }
  }

  async _postRequest(uriPath, body, timeoutMs) {
    const url = `${this.endpoint}${this.internalBase}${uriPath}`
    const fetchImpl = this.fetchImpl ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') return { ok: false, retry: false, error: 'fetch 不可用' }
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.token}`
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      })
      return this._parseResponse(response)
    } catch (error) {
      const message = error?.name === 'TimeoutError' ? `请求超时(${timeoutMs}ms)` : this._redact(error?.message ?? error)
      return { ok: false, retry: true, error: message }
    }
  }

  async _getRequest(uriPath, timeoutMs) {
    const url = `${this.endpoint}${this.internalBase}${uriPath}`
    const fetchImpl = this.fetchImpl ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') return { ok: false, retry: false, error: 'fetch 不可用' }
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(timeoutMs)
      })
      return this._parseResponse(response)
    } catch (error) {
      const message = error?.name === 'TimeoutError' ? `请求超时(${timeoutMs}ms)` : this._redact(error?.message ?? error)
      return { ok: false, retry: true, error: message }
    }
  }

  async _parseResponse(response) {
    let parsed = null
    let raw = ''
    try { raw = await response.text() } catch {}
    if (raw) {
      try { parsed = JSON.parse(raw) } catch {}
    }
    const status = Number(response.status) || 0
    if (status === 408 || status === 429 || status >= 500) {
      return { ok: false, retry: true, error: `HTTP ${status}` }
    }
    if (!response.ok) {
      const code = parsed?.error?.code ?? parsed?.code ?? ''
      return { ok: false, retry: false, error: this._redact(`HTTP ${status}${code ? ` ${code}` : ''}`) }
    }
    if (parsed && parsed.ok === false) {
      const code = parsed?.error?.code ?? 'REJECTED'
      return { ok: false, retry: false, error: this._redact(String(code)), value: parsed?.error }
    }
    return { ok: true, value: parsed?.value ?? parsed ?? null, status }
  }

  // ── 文件与游标 ─────────────────────────────────────────────────────────

  _loadRoles() {
    if (!fs.existsSync(this.rolesPath)) {
      return { version: ROLES_VERSION, epoch: 0, baseline: false, active: null, byName: {}, byId: {}, updatedAt: nowISO(this.clock()) }
    }
    let raw
    try {
      raw = JSON.parse(fs.readFileSync(this.rolesPath, 'utf8').replace(/^\uFEFF/, ''))
    } catch (error) {
      throw new Error(`roles.json 无法解析（${error?.message ?? error}）；为避免记忆归属分裂，拒绝自动重建，请人工检查`)
    }
    if (!raw || raw.version !== ROLES_VERSION || !raw.byName || typeof raw.byName !== 'object' || !raw.byId || typeof raw.byId !== 'object') {
      throw new Error(`roles.json 版本/结构不兼容（version=${raw?.version}），请人工检查`)
    }
    const byId = {}
    for (const [id, entry] of Object.entries(raw.byId)) {
      if (!entry || typeof entry !== 'object') continue
      byId[id] = {
        id,
        name: roleName(entry.name),
        createdAt: String(entry.createdAt ?? ''),
        updatedAt: String(entry.updatedAt ?? ''),
        renamedFrom: Array.isArray(entry.renamedFrom) ? entry.renamedFrom.map(roleName).filter(Boolean).slice(-20) : [],
        retiredAt: entry.retiredAt ? String(entry.retiredAt) : null,
        recreatedFrom: entry.recreatedFrom ? String(entry.recreatedFrom) : null
      }
    }
    const byName = {}
    for (const [name, id] of Object.entries(raw.byName)) {
      const key = roleName(name)
      if (key && byId[id]) byName[key] = id
    }
    const active = raw.active && byId[raw.active] && !byId[raw.active].retiredAt ? raw.active : null
    return {
      version: ROLES_VERSION,
      epoch: Number.isSafeInteger(raw.epoch) && raw.epoch >= 0 ? raw.epoch : 0,
      // 旧文件没有 baseline 字段：有 epoch>0 或已有 active 都视为已建立基线
      baseline: raw.baseline === true || (Number.isSafeInteger(raw.epoch) && raw.epoch > 0),
      active,
      byName,
      byId,
      updatedAt: String(raw.updatedAt ?? '')
    }
  }

  _persistRoles() {
    const tmp = `${this.rolesPath}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(this.roles, null, 2), 'utf8')
    fs.renameSync(tmp, this.rolesPath)
  }

  _loadCursor() {
    const raw = readJsonFile(this.cursorPath, null)
    if (!raw || raw.version !== CURSOR_VERSION) return { version: CURSOR_VERSION, ackedSeq: 0, offset: 0 }
    return {
      version: CURSOR_VERSION,
      ackedSeq: Number.isSafeInteger(raw.ackedSeq) && raw.ackedSeq >= 0 ? raw.ackedSeq : 0,
      offset: Number.isSafeInteger(raw.offset) && raw.offset >= 0 ? raw.offset : 0,
      updatedAt: String(raw.updatedAt ?? '')
    }
  }

  _persistCursor() {
    const tmp = `${this.cursorPath}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify({ version: CURSOR_VERSION, ...this.cursor }, null, 2), 'utf8')
    fs.renameSync(tmp, this.cursorPath)
  }

  _fileSize(file) {
    try { return fs.statSync(file).size } catch { return 0 }
  }

  _readFrom(offset, maxBytes) {
    let fd
    try {
      fd = fs.openSync(this.outboxPath, 'r')
      const size = fs.fstatSync(fd).size
      const length = Math.max(0, Math.min(maxBytes, size - offset))
      if (!length) return Buffer.alloc(0)
      const buffer = Buffer.alloc(length)
      const read = fs.readSync(fd, buffer, 0, length, offset)
      return buffer.subarray(0, read)
    } catch {
      return Buffer.alloc(0)
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd) } catch {}
      }
    }
  }

  // ── 生命周期与状态 ─────────────────────────────────────────────────────

  _startTimers() {
    this.flushTimer = setInterval(() => { this.flush().catch(() => {}) }, 2000)
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref()
    if (this.takeoverConfig.enabled) {
      // 角色可能稍后才建立：等一轮再第一次同步，避免启动时 characterId 还是空。
      this.takeoverTimer = setInterval(() => { this.syncTakeover().catch(() => {}) }, this.takeoverConfig.pollMs)
      if (typeof this.takeoverTimer.unref === 'function') this.takeoverTimer.unref()
      const kick = setTimeout(() => { this.syncTakeover().catch(() => {}) }, 5000)
      if (typeof kick.unref === 'function') kick.unref()
    }
    this._scheduleFlush(0)
  }

  _warnOnce(key, message) {
    const now = Date.now()
    if (now - (this.warnAt.get(key) ?? 0) < 60000) return
    this.warnAt.set(key, now)
    this.logger('warn', this._redact(message))
  }

  _redact(value) {
    let text = String(value ?? '')
    if (this.token && text.includes(this.token)) text = text.split(this.token).join('***')
    return text
  }

  status() {
    if (!this.enabled) return { enabled: false, reason: this.reason ?? 'disabled' }
    return {
      enabled: true,
      endpoint: this.endpointLabel,
      characterId: this.characterId,
      bindingVersion: this.bindingVersion,
      roles: { total: Object.keys(this.roles.byId).length, active: this.characterId },
      outbox: {
        pending: this.pendingCount,
        bytes: this.outboxBytes,
        ackedSeq: this.cursor.ackedSeq,
        failures: this.failures,
        full: this.outboxFull,
        lastError: this._redact(this.lastError)
      },
      takeover: {
        ...this.takeover,
        scopes: [...(this.takeover.scopes || [])],
        // 已落盘的停用集：重启后仍生效，只有显式 rollback 才移除。
        disabledScopes: [...this.disabledScopes.keys()],
        ackedVersions: Object.fromEntries(this.ackedVersions)
      },
      botQQ: this.botQQ
    }
  }

  close() {
    this.closed = true
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null }
    if (this.takeoverTimer) { clearInterval(this.takeoverTimer); this.takeoverTimer = null }
  }
}

/**
 * 工厂：配置不全或初始化失败时返回 DisabledCompanionAdapter（不抛错、不产生行为），
 * 保证桥接主链路不受影响。
 */
export function createCompanionAdapter(options = {}) {
  const logger = typeof options.logger === 'function' ? options.logger : () => {}
  const config = options.config && typeof options.config === 'object' ? options.config : null
  // 完全没有 companion 段：静默空实现（不建目录、不打告警、不改变桥接任何行为）
  if (!config || Object.keys(config).length === 0) return new DisabledCompanionAdapter('unconfigured')
  if (config.enabled === false) return new DisabledCompanionAdapter('disabled-by-config')
  try {
    return new CompanionAdapter({ ...options, config, logger })
  } catch (error) {
    const reason = String(error?.message ?? error)
    logger('warn', `适配层未启用：${reason}`)
    return new DisabledCompanionAdapter(reason)
  }
}

export default createCompanionAdapter
