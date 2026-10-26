import { resolve, join } from 'node:path'
import { Store } from './storage/sqlite.js'
import { Config, validateConfig } from './config/index.js'
import { createService } from './application/service.js'
import { createOperations } from './application/operations.js'
import { createModelAdapter } from './adapters/dsh/model.js'
import { registerManagement, registerInternal, registerContexts } from './adapters/dsh/http.js'
import { createLearningEngine } from './learning/index.js'

export { Config }
export const name='qq-companion-memory'
export const inject=['agents','llm','webServer','connection']
export async function apply(ctx, input) {
  const config=validateConfig(input)
  const dataDir=resolve(config.dataDir || join(process.env.DSH_HOME || '.', 'qq-companion-memory'))
  const logger=ctx.logger?.('qq-companion-memory') ?? console
  const store=new Store(dataDir)
  const controller=new AbortController()
  const service=createService(store,config,{logger})
  const model=createModelAdapter(ctx,service)
  const learning=createLearningEngine({store,config,model,logger})
  const operations=createOperations(service,{learning,logger})
  service.attach({learning,operations})
  let running=null;let timer
  const cycle=()=>{
    if(running || controller.signal.aborted)return
    running=(async()=>{
      try { if(!learning.status().closed)await learning.tick(controller.signal, { once: true }) }
      finally { if(!controller.signal.aborted)await operations.tick() }
    })().catch(error=>{if(!controller.signal.aborted)logger.error('后台调度失败',error.message)}).finally(()=>{running=null})
  }
  ctx.effect(()=>async()=>{
    controller.abort(new Error('插件卸载'))
    clearInterval(timer)
    operations.close()
    await learning.close()
    await running
    store.close()
  })
  registerManagement(ctx,service)
  await registerInternal(ctx,service)
  registerContexts(ctx,service)
  timer=setInterval(cycle,config.learning.pollIntervalSeconds*1000)
  timer.unref?.()
  cycle()
}
