import Schema from '@deepseek-ai/schemastery'
import { DomainError } from '../domain/core.js'

const positive = (n) => Schema.number().min(1).default(n)
const nonnegative = (n = 0) => Schema.number().min(0).default(n)
const model = Schema.object({ provider: Schema.string().default(''), model: Schema.string().default(''), followChat: Schema.boolean().default(true) })
export const Config = Schema.object({
  dataDir: Schema.string().default('').description('留空使用专用 DSH_HOME 下 qq-companion-memory；修改需重启'),
  features: Schema.object(Object.fromEntries(['capture', 'recall', 'learning', 'trial', 'autoAdopt'].map(k => [k, Schema.boolean().default(false)]))).default({}),
  memory: Schema.object({ recentDays: positive(7), halfLifeDays: positive(30), recallHistoryLimit: positive(200) }).default({}),
  learning: Schema.object({ privateThreshold: positive(20), groupThreshold: positive(60), minIntervalHours: positive(4), localDailyLimit: positive(12), globalDailyLimit: positive(60), batchSize: positive(80), concurrency: positive(1), pollIntervalSeconds: positive(60), requestTimeoutSeconds: positive(120), leaseMinutes: positive(10) }).default({}),
  evidence: Schema.object({ independentUnits: positive(4), distinctDays: positive(3), trialDays: positive(3), applications: positive(2), personalityIntervalDays: positive(3), conversationGapMinutes: positive(30) }).default({}),
  budget: Schema.object({ contextWindow: nonnegative(), maxOutputTokens: nonnegative(), maxInputTokens: nonnegative(), recallTokens: nonnegative(), recallPercent: positive(10).max(100), reserveTokens: positive(1024) }).default({}),
  models: model.default({}),
  roles: Schema.dict(Schema.object({ models: Schema.object({provider:Schema.string(),model:Schema.string(),followChat:Schema.boolean()}), features: Schema.object({learning:Schema.boolean(),trial:Schema.boolean(),autoAdopt:Schema.boolean()}), learning: Schema.object({privateThreshold:Schema.number().min(1),groupThreshold:Schema.number().min(1),minIntervalHours:Schema.number().min(1),batchSize:Schema.number().min(1).max(80),pollIntervalSeconds:Schema.number().min(1),requestTimeoutSeconds:Schema.number().min(1)}), evidence: Schema.object({independentUnits:Schema.number().min(1),distinctDays:Schema.number().min(1),trialDays:Schema.number().min(1),applications:Schema.number().min(1),personalityIntervalDays:Schema.number().min(1),conversationGapMinutes:Schema.number().min(1)}), budget: Schema.object({ contextWindow: Schema.number().min(0), maxOutputTokens: Schema.number().min(0), maxInputTokens: Schema.number().min(0), recallTokens: Schema.number().min(0) }) })).default({}),
  bridge: Schema.object({ token: Schema.string().role('secret').default(''), tokenFile: Schema.string().default(''), adminQQs: Schema.array(Schema.string().pattern(/^[1-9]\d{0,19}$/)).default([]), maxBodyBytes: positive(2097152) }).default({}),
  backup: Schema.object({ enabled: Schema.boolean().default(false), time: Schema.string().default('').description('Asia/Shanghai HH:mm，启用每日备份前必填'), retentionDays: positive(14), directory: Schema.string().default('') }).default({}),
  deletion: Schema.object({ undoDays: positive(7) }).default({}),
})
export function validateConfig(config) {
  for (const [group, values] of Object.entries(config)) if (['learning', 'evidence', 'budget', 'memory'].includes(group)) for (const [key, value] of Object.entries(values)) {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) throw new DomainError('INVALID_CONFIG', `${group}.${key} 必须是有限整数`)
  }
  if (config.learning.batchSize > 80) throw new DomainError('INVALID_CONFIG', '首版单批最多 80 条材料')
  if (config.learning.concurrency !== 1) throw new DomainError('INVALID_CONFIG', '首版仅支持全局单个学习任务，避免并发租约歧义')
  if (config.backup.enabled && !/^([01]\d|2[0-3]):[0-5]\d$/.test(config.backup.time)) throw new DomainError('INVALID_CONFIG', '启用每日备份前必须配置上海时区 HH:mm')
  if (Object.values(config.features).some(Boolean) && !config.dataDir && !process.env.DSH_HOME) throw new DomainError('INVALID_CONFIG', '请设置专用 DSH_HOME 或显式 dataDir')
  for (const role of Object.values(config.roles ?? {})) {
    for (const group of ['learning','evidence','budget']) for (const [key,value] of Object.entries(role[group] ?? {})) {
      if (!Number.isSafeInteger(value)) throw new DomainError('INVALID_CONFIG', `角色覆盖 ${group}.${key} 必须是整数`)
      if (group === 'evidence' && key !== 'conversationGapMinutes' && value < config.evidence[key]) throw new DomainError('INVALID_CONFIG', `角色覆盖不能放宽 ${key}`)
    }
  }
  for (const models of [config.models, ...Object.values(config.roles ?? {}).map(role => role.models).filter(Boolean)]) {
    if (Boolean(models.provider) !== Boolean(models.model)) throw new DomainError('INVALID_CONFIG', 'provider 与 model 必须成对配置')
  }
  const checkBudget=budget=>{
    if(budget.contextWindow && budget.maxOutputTokens && budget.maxOutputTokens+budget.reserveTokens>=budget.contextWindow)throw new DomainError('INVALID_CONFIG','输出与预留空间必须小于上下文容量')
    if(budget.contextWindow && budget.maxInputTokens && budget.maxOutputTokens && budget.maxInputTokens+budget.maxOutputTokens+budget.reserveTokens>budget.contextWindow)throw new DomainError('INVALID_CONFIG','输入、输出与预留空间超过上下文容量')
  }
  checkBudget(config.budget)
  for(const role of Object.values(config.roles ?? {})){
    checkBudget({...config.budget,...role.budget})
    if(config.budget.recallTokens>0 && role.budget?.recallTokens>config.budget.recallTokens)throw new DomainError('INVALID_CONFIG','角色召回预算不能放宽全局上限')
  }
  if (config.bridge.token && config.bridge.tokenFile) throw new DomainError('INVALID_CONFIG', 'token 与 tokenFile 只能配置一项')
  return config
}
export function roleConfig(config, characterId) {
  const local = config.roles?.[characterId] ?? {}
  return { ...config, models: { ...config.models, ...local.models }, budget: { ...config.budget, ...local.budget } }
}
