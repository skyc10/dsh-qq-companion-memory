import { randomUUID, createHash } from 'node:crypto'

export class DomainError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message)
    this.name = 'DomainError'
    Object.assign(this, { code, status, details })
  }
}
export const id = (prefix = 'r') => `${prefix}-${randomUUID()}`
export const nowISO = () => new Date().toISOString()
export function iso(value, label = '时间') {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new DomainError('INVALID_TIME', `${label}无效`)
  return date.toISOString()
}
export function shanghaiDay(at = nowISO()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at))
}
export function requireText(value, label, max = 100000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new DomainError('INVALID_INPUT', `${label}须为非空字符串且不超过 ${max} 字符`)
  return value.trim()
}
export function qq(value, label = 'QQ') {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)) throw new DomainError('INVALID_IDENTITY', `${label}须为规范数字字符串`)
  return value
}
export function canonicalScope(value) {
  if (typeof value !== 'string' || !/^(private|group|profile):[1-9]\d{0,19}$/.test(value)) throw new DomainError('INVALID_SCOPE', '范围无效')
  return value
}
export function stableJSON(value) {
  const visit = (v) => Array.isArray(v) ? v.map(visit) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, visit(v[k])])) : v
  return JSON.stringify(visit(value))
}
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) || value instanceof Uint8Array ? value : stableJSON(value)).digest('hex')
export function version(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new DomainError('EXPECTED_VERSION_REQUIRED', '请提交当前版本', 409)
  return value
}
export function assertOwner(actor, config) {
  if (actor?.kind === 'owner' && actor.id === 'web-owner') return
  if (actor?.kind === 'qq-admin' && config.bridge.adminQQs.includes(actor.id)) return
  throw new DomainError('FORBIDDEN', '当前通道没有管理权限', 403)
}
export function abort(signal) { if (signal?.aborted) throw signal.reason ?? new DomainError('ABORTED', '操作已取消', 499) }
export const active = r => Boolean(r && ['active','trial','accepted','adopted'].includes(r.status))
export function textOf(record) {
  const d = record?.data ?? {}
  return String(d.text ?? d.rule ?? d.summary ?? d.content ?? d.name ?? '')
}
export function sourceIdsOf(record) {
  const d=record?.data ?? {}
  return [...new Set([...(Array.isArray(d.sourceIds)?d.sourceIds:[]),...(Array.isArray(d.sourceCandidateIds)?d.sourceCandidateIds:[]),d.sourceId].filter(v=>typeof v==='string' && v))]
}
export function estimateTokens(text) {
  // 保守的本地估算；不声称等于 provider 实际 token。
  return [...String(text)].reduce((sum, char) => sum + (/\p{Script=Han}|[^\x00-\x7F]/u.test(char) ? 1 : 0.5), 0) + 8
}
