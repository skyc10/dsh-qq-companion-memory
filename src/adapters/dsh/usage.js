import { randomUUID } from 'node:crypto'

// 只观察已有可信 QQ 会话的请求；不派发请求、不改变模型输入或重试策略。
export function registerUsage(ctx, service) {
  ctx.on('llm/stream', async function* (options, next) {
    let binding
    if (!service.isMaintenance() && options.sessionId && !options.purpose) {
      try { binding = service.identity(options.sessionId) } catch { /* 非当前 QQ 绑定不归入统计。 */ }
    }
    if (!binding) { yield* next(); return }
    const epoch=service.runtime.storageEpoch
    const requestId = randomUUID()
    const at = service.clock()
    const fields = { characterId: binding.characterId, scopeKey: binding.scopeKey, at }
    let record
    try {
      record = service.store.create('usage', { category: 'chat', purpose: 'chat', requests: 1, inputTokens: null, outputTokens: null, injectedTokens: null, cost: null, state: 'pending', sessionId: options.sessionId, provider: options.provider, model: options.model, bindingVersion: binding.data.bindingVersion }, { ...fields, id: `chat-usage-${requestId}` })
      const recalled = service.runtime.recallSnapshots?.get(options.sessionId)
      const messageText = message => typeof message.content === 'string' ? message.content : (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
      const messages = options.messages ?? []
      const system = [options.system, ...messages.filter(message => message.role === 'system').map(messageText)].filter(Boolean).join('\n')
      // DSH rc.2 publishes dynamic context as a trusted user-role snapshot. Only
      // its latest named contribution counts; ordinary user prose and stale
      // snapshots must never manufacture an injection estimate.
      const runtime = messages.findLast(message => message.role === 'user' && message.source?.kind === 'runtime-context')
      const sections = runtime?.source?.form === 'snapshot' && Array.isArray(runtime.source.sections) ? runtime.source.sections.filter(section => section.name === 'qq-companion-memory') : []
      const injected = runtime
        ? sections.length === 1 && sections[0].text === recalled?.text && messageText(runtime).includes(recalled?.text ?? '')
        : Boolean(recalled?.text && system.includes(recalled.text))
      if (recalled?.text && recalled.identity.characterId === binding.characterId && recalled.identity.scopeKey === binding.scopeKey && injected) {
        service.store.create('usage', { category: 'memory', purpose: 'local-recall', requests: 0, inputTokens: 0, outputTokens: 0, injectedTokens: recalled.budget.used, injectedTokensEstimated: true, cost: 0, state: 'done', sessionId: options.sessionId, requestId }, { ...fields, id: `memory-usage-${requestId}` })
      }
    } catch (error) { service.logger.warn('QQ用量登记失败', error.message) }
    let usage = null; let finish = ''; let failed = false
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') usage = chunk.usage
        if (chunk.type === 'finish') finish = chunk.reason
        yield chunk
      }
    } catch (error) { failed = true; throw error }
    finally {
      if (record && !service.isMaintenance() && epoch===service.runtime.storageEpoch) try {
        const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
        service.store.update(record.id, record.version, { data: { ...record.data, state: failed ? 'failed' : finish ? 'done' : 'unknown', finish, usage, inputTokens: number(usage?.inputTokens), outputTokens: number(usage?.outputTokens), completedAt: service.clock() } })
      } catch (error) { service.logger.warn('QQ用量结算失败', error.message) }
    }
  })
}
