import { randomUUID } from 'node:crypto'
import { DomainError, estimateTokens, active } from '../../domain/core.js'
import { roleConfig } from '../../config/index.js'

export function createModelAdapter(ctx, service) {
  const { store, config } = service
  const prepared = new Map()
  const routes = new Map()
  return {
    async resolve({characterId,scopeKey,sessionId,signal}) {
      if(service.isMaintenance() || !active(store.get(characterId)))throw new DomainError('LEARNING_DISABLED','角色已停用或数据库正在维护',409)
      const ownership=service.controls().find(control=>control.characterId===characterId && control.scopeKey===scopeKey)
      if (ownership?.status !== 'active' || !ownership.acknowledged || !ownership.legacyDisabled) throw new DomainError('TAKEOVER_REQUIRED','需先确认该范围旧学习与注入已停用',409)
      const effective=roleConfig(config,characterId)
      let {provider,model}=effective.models
      if(!provider || !model) {
        if(!effective.models.followChat) throw new DomainError('MODEL_REQUIRED','请配置学习模型或启用跟随当前聊天模型',503)
        const bindings=[...store.scan('binding',{characterId,scopeKey,status:'active'})].sort((a,b)=>b.data.bindingVersion-a.data.bindingVersion)
        const bound=bindings.find(b=>!sessionId || b.data.sessionId===sessionId)
        if (!bound) throw new DomainError('MODEL_REQUIRED','此范围尚无可信模型绑定',503)
        service.identity(bound.data.sessionId)
        const agent=bound && ctx.agents.get(bound.data.sessionId)
        const header=agent?.session?.requestHeader?.()
        provider=header?.config?.provider
        model=header?.config?.model
        if(!provider || !model) throw new DomainError('MODEL_REQUIRED','当前可信绑定尚未取得聊天模型，不猜测模型路由',503)
      }
      const info=await ctx.llm.resolveModelInfo(provider,model,signal)
      const contextWindow=effective.budget.contextWindow || info.context?.contextWindow
      const maxOutputTokens=effective.budget.maxOutputTokens || info.defaultMaxTokens
      if(!Number.isSafeInteger(contextWindow) || contextWindow<1 || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens<1) throw new DomainError('CAPACITY_REQUIRED','模型容量未知，请填写上下文和输出上限',503)
      const reserveTokens=effective.budget.reserveTokens
      if(maxOutputTokens+reserveTokens>=contextWindow)throw new DomainError('CAPACITY_REQUIRED','输出上限与预留空间超过模型容量',503)
      routes.set(`${provider}\0${model}`, {characterId,scopeKey,contextWindow,maxOutputTokens,maxInputTokens:effective.budget.maxInputTokens,reserveTokens})
      return {provider,model,characterId,scopeKey,contextWindow:contextWindow-reserveTokens,maxOutputTokens,maxInputTokens:effective.budget.maxInputTokens,estimate:estimateTokens}
    },
    async generate({selection,system,input,maxTokens,signal,requestId}) {
      const route=routes.get(`${selection.provider}\0${selection.model}`)
      const ownership=service.controls().find(control=>control.characterId===route?.characterId && control.scopeKey===route?.scopeKey)
      if (service.isMaintenance() || !route || !active(store.get(route.characterId)) || ownership?.status !== 'active' || !ownership.acknowledged || !ownership.legacyDisabled) throw new DomainError('TAKEOVER_REQUIRED','范围所有权已改变，取消学习请求',409)
      const inputTokens=Math.ceil(estimateTokens(system)+estimateTokens(input))
      if(!Number.isSafeInteger(maxTokens) || maxTokens<1 || maxTokens>route.maxOutputTokens || route.maxInputTokens>0 && inputTokens>route.maxInputTokens || inputTokens+maxTokens+route.reserveTokens>route.contextWindow)throw new DomainError('INPUT_BUDGET_EXCEEDED','本地保守输入估算超过配置容量，未派发模型请求',409)
      // prepareCall 固定 provider/model，本适配层不自动重试。引擎为每个调用预留额度。
      const call=await ctx.llm.prepareCall({provider:selection.provider,model:selection.model,maxTokens},signal,controls=>controls)
      let text='';let finish=null;let usage=null
      const options={...call.config,system,messages:[Object.freeze({id:randomUUID(),role:'user',content:[{type:'text',text:input}],source:{kind:'qq-companion-learning'}})],signal}
      prepared.set(requestId,options)
      try {
        for await(const chunk of call.stream(options)) {
          signal?.throwIfAborted()
          if(chunk.type==='text-delta') text+=chunk.text
          else if(chunk.type==='usage') usage={...chunk.usage}
          else if(chunk.type==='finish') finish=chunk.reason
          if(text.length>2000000) throw new DomainError('OUTPUT_TOO_LARGE','提炼输出超过安全结构解析上限')
        }
      } finally {prepared.delete(requestId)}
      return {text,finish,usage}
    },
  }
}
