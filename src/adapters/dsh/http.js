import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { DomainError, requireText, digest } from '../../domain/core.js'

const API='/api/qq-companion-memory/v1'
const INTERNAL='/qq-companion-memory/internal/v1'
const json=value=>new Response(JSON.stringify({ok:true,value}),{headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}})
const errorResponse=error=>new Response(JSON.stringify({ok:false,error:{code:error.code??'INTERNAL',message:error instanceof DomainError?error.message:'内部操作失败，请查看服务端日志',details:error.details??{}}}),{status:error.status??500,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}})
export function registerManagement(ctx,service) {
  const bodyOf=async request=>{const bytes=new Uint8Array(await request.arrayBuffer());if(bytes.byteLength>service.config.bridge.maxBodyBytes)throw new DomainError('BODY_TOO_LARGE','请求过大',413);try{return JSON.parse(new TextDecoder().decode(bytes))}catch{throw new DomainError('INVALID_JSON','JSON 无效')}}
  const register=(path,methods,handler)=>ctx.effect(()=>ctx.connection.fetch.register({path:API+path,methods,requestBody:'buffered',fetch:async request=>{
    try {
      if(request.headers.get('content-length') && Number(request.headers.get('content-length'))>service.config.bridge.maxBodyBytes) throw new DomainError('BODY_TOO_LARGE','请求过大',413)
      return await handler(request)
    }catch(error){if(!(error instanceof DomainError))service.logger.error('管理 API 失败',error.message);return errorResponse(error)}
  }}))
  register('/status',['GET'],async()=>json(service.status()))
  register('/query',['POST'],async request=>{const body=await bodyOf(request);return json(service.query(body.kind,body))})
  register('/mutate',['POST'],async request=>{const body=await bodyOf(request);return json(await service.manage(body.action,body.payload,{kind:'owner',id:'web-owner'}))})
  register('/recall',['POST'],async request=>json(service.recall(await bodyOf(request))))
  for(const [route,file,type] of [['/page','index.html','text/html'],['/page.css','page.css','text/css'],['/page.js','page.js','text/javascript']]) register(route,['GET'],async()=>new Response(await readFile(new URL(`./page/${file}`,import.meta.url)),{headers:{'content-type':`${type}; charset=utf-8`,'cache-control':'no-store','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",'x-content-type-options':'nosniff'}}))
}
export async function registerInternal(ctx,service) {
  const {config}=service
  const token=config.bridge.token || (config.bridge.tokenFile ? (await readFile(config.bridge.tokenFile,'utf8')).trim() : '')
  if(!token) return
  if(token.length<32) throw new DomainError('WEAK_BRIDGE_TOKEN','桥接认证 token 须至少 32 字符')
  const expected=Buffer.from(digest(token))
  const handlers={
    events:async body=>service.ingest(body),
    bindings:async body=>service.bind(body),
    deliveries:async body=>service.delivery(body),
    commands:async body=>service.command(body,{kind:'qq-admin',id:String(body.senderQQ??body.actorQQ??'')}),
    controls:async()=>({features:config.features,scopes:service.controls(),adminQQs:config.bridge.adminQQs}),
    acknowledgements:async body=>{
      if(service.isMaintenance())throw new DomainError('MAINTENANCE','数据库恢复中',503)
      const row=service.store.get(requireText(body.id,'接管 ID',300))
      if(!row || row.kind!=='takeover' || row.version!==body.expectedVersion) throw new DomainError('VERSION_CONFLICT','接管版本已变化',409)
      if(row.data.expectedBridgeVersion && row.data.expectedBridgeVersion!==String(body.bridgeVersion??''))throw new DomainError('BRIDGE_VERSION_MISMATCH','桥接版本与预期不符',409)
      if(body.characterId!==row.characterId || body.conversationKey!==row.scopeKey || body.legacyDisabled!==(row.data.desiredOwner==='companion')) throw new DomainError('INVALID_ACK','桥接未确认目标范围旧能力状态',409)
      const data={...row.data,acknowledged:true,acknowledgedAt:service.clock(),bridgeVersion:String(body.bridgeVersion??''),legacyDisabled:body.legacyDisabled}
      const result=service.store.update(row.id,row.version,{status:body.legacyDisabled?'active':'legacy',data})
      service.store.audit({kind:'bridge',id:'authenticated'},'takeoverAck',result.id,row,result)
      return result
    },
  }
  for(const [name,handler] of Object.entries(handlers)) ctx.effect(()=>ctx.webServer.register({kind:'exact',path:`${INTERNAL}/${name}`,handler:async(req,res)=>{
    let status=200;let value
    try {
      const supplied=String(req.headers.authorization??'').replace(/^Bearer /,'')
      if(!timingSafeEqual(expected,Buffer.from(digest(supplied)))) throw new DomainError('UNAUTHORIZED','桥接认证失败',401)
      if(req.method!=='POST' && !(name==='controls' && req.method==='GET')) throw new DomainError('METHOD_NOT_ALLOWED','请求方法无效',405)
      const chunks=[];let size=0
      for await(const chunk of req){size+=chunk.length;if(size>config.bridge.maxBodyBytes)throw new DomainError('BODY_TOO_LARGE','请求过大',413);chunks.push(Buffer.from(chunk))}
      const raw=Buffer.concat(chunks).toString('utf8')
      let body={}
      try{body=raw?JSON.parse(raw):{}}catch{throw new DomainError('INVALID_JSON','JSON 无效')}
      value={ok:true,value:await handler(body)}
    }catch(error){status=error.status??500;value={ok:false,error:{code:error.code??'INTERNAL',message:error instanceof DomainError?error.message:'内部处理失败',details:error.details??{}}};if(!(error instanceof DomainError))service.logger.error('桥接事件处理失败',error.message)}
    res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value))
  }}))
}
export function registerContexts(ctx,service) {
  const mounted=new Map();const queries=new Map()
  function mount(agent) {
    const sid=agent.session.id
    if(mounted.get(sid)?.agent===agent)return
    mounted.get(sid)?.off()
    const off=agent.ctx.systemPrompt.context({name:'qq-companion-memory',order:750,interpolate:false,text:()=>{
      try {
        if(service.isMaintenance())return ''
        const binding=service.identity(sid)
        const takeover=service.controls().find(c=>c.characterId===binding.characterId && c.scopeKey===binding.scopeKey)
        // 与旧功能交接确认前不重复注入。
        if(takeover?.status!=='active' || !takeover.acknowledged)return ''
        return service.recall({sessionId:sid,query:queries.get(sid)??''}).text
      }catch(error){if(!['NO_BINDING','STALE_BINDING','MAINTENANCE'].includes(error.code))service.logger.warn('QQ记忆上下文暂不可用',error.code??error.message);return ''}
    }})
    mounted.set(sid,{agent,off})
  }
  ctx.on('agent/created',({agent})=>{mount(agent)})
  ctx.on('agent/disposed',({agent})=>{const m=mounted.get(agent.session.id);if(m?.agent===agent){m.off();mounted.delete(agent.session.id);queries.delete(agent.session.id)}})
  ctx.on('agent/inbox/inserted',({agent,message})=>{
    const text=(message?.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n')
    if(text)queries.set(agent.session.id,text.slice(-8000))
  })
  for(const agent of ctx.agents.list())mount(agent)
  ctx.effect(()=>()=>{for(const m of mounted.values())m.off();mounted.clear();queries.clear()})
}
