// Synthetic acceptance probes only. Never opens the deployment database or QQ/model endpoints.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { Store } from '../../../src/storage/sqlite.js'
import { Config, validateConfig } from '../../../src/config/index.js'
import { createService } from '../../../src/application/service.js'
import { createOperations } from '../../../src/application/operations.js'
import { memoryCurrent } from '../../../src/domain/memory.js'
import { shanghaiDay } from '../../../src/domain/core.js'
import { reserveQuota, readQuota, markUsageAfterFailure } from '../../../src/learning/quota.js'
import { parseLearningOutput, validateLearningOutput } from '../../../src/learning/output.js'
import { registerUsage } from '../../../src/adapters/dsh/usage.js'
import { evaluateCandidate } from '../../../src/learning/evidence.js'
import { registerManagement, registerInternal } from '../../../src/adapters/dsh/http.js'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const directory = mkdtempSync(join(tmpdir(), 'companion-acceptance-'))
const results = []
const owner = {kind:'owner',id:'web-owner'}
let serial = 0
async function probe(ids, name, fn) {
  try { await fn(); results.push({ids,name,status:'passed'}) }
  catch(error) { results.push({ids,name,status:'failed',error:{message:error.message,code:error.code,stack:error.stack}}) }
}
function fixture() {
  const dataDir=join(directory, String(++serial))
  const config=validateConfig(Config({dataDir,features:{capture:true,recall:true},budget:{recallTokens:10000}}))
  const store=new Store(dataDir)
  const service=createService(store,config,{clock:()=> '2026-10-27T08:00:00Z'})
  service.ensureCharacter('synthetic-A','A'); service.ensureCharacter('synthetic-B','B')
  const operations=createOperations(service)
  service.attach({operations})
  const manage=(action,payload)=>service.manage(action,{requestId:`probe-${++serial}`,reason:'synthetic acceptance',...payload},owner)
  const create=(kind,data,extra={})=>manage('create',{kind,data,characterId:'synthetic-A',scopeKey:'private:10001',...extra})
  return {store,service,config,operations,manage,create,close(){operations.close();store.close()}}
}
async function withFixture(fn){const f=fixture();try{await fn(f)}finally{f.close()}}
const bind=(f,id,scope,role='synthetic-A',participants=[])=>f.service.bind({sessionId:id,conversationKey:scope,characterId:role,botQQ:'90001',bindingVersion:1,participants})
const rejectCode=(fn,code)=>assert.rejects(fn,e=>e.code===code)

await probe(['FIX-01','FIX-02'],'public profile cross-group and role/private isolation',()=>withFixture(async f=>{
  const pub=await f.create('profile',{text:'synthetic public profile',originScope:'group:10001'},{scopeKey:'profile:10001',subjectQQ:'10001'})
  assert.equal(pub.data.visibility,'public-profile')
  const priv=await f.create('profile',{text:'synthetic private profile',originScope:'private:10001'},{scopeKey:'profile:10001',subjectQQ:'10001'})
  bind(f,'group-a','group:10002','synthetic-A',['10001'])
  const selected=f.service.recall({sessionId:'group-a'}).selected.map(r=>r.id)
  assert(selected.includes(pub.id));assert(!selected.includes(priv.id))
  f.service.bind({sessionId:'group-b',conversationKey:'group:10002',characterId:'synthetic-B',botQQ:'90001',bindingVersion:2,participants:['10001']})
  assert(!f.service.recall({sessionId:'group-b'}).selected.some(r=>r.id===pub.id))
  for(const originScope of [42,'group:invalid'])await assert.rejects(()=>f.create('profile',{text:'bad',originScope},{scopeKey:'profile:10001',subjectQQ:'10001'}),e=>e.status===400)
}))
await probe(['FIX-02','FIX-12'],'legacy profile/importance persists on explicit enable',()=>withFixture(async f=>{
  const p=f.store.create('profile',{text:'old',originScope:'group:10001'},{characterId:'synthetic-A',scopeKey:'profile:10001',subjectQQ:'10001',status:'disabled'})
  const enabled=await f.manage('enable',{id:p.id,expectedVersion:1});assert.equal(enabled.data.visibility,'public-profile');assert.equal(f.store.get(p.id).data.importance,1)
  const m=f.store.create('memory',{text:'old',type:'boundary',pendingConfirmation:true},{characterId:'synthetic-A',scopeKey:'private:10001',status:'pending'})
  await rejectCode(()=>f.manage('enable',{id:m.id,expectedVersion:1}),'CONFIRMATION_REQUIRED')
  const confirmed=await f.manage('enable',{id:m.id,expectedVersion:1,confirm:true});assert.equal(confirmed.data.importance,5);assert.equal(confirmed.data.pendingConfirmation,false)
}))
await probe(['FIX-04'],'quoted/new/forward/control material classification',()=>withFixture(async f=>{
  const ingest=(content,extra={})=>f.service.ingest({schemaVersion:1,eventId:`e${++serial}`,messageId:`m${serial}`,characterId:'synthetic-A',conversationKey:'private:10001',botQQ:'90001',senderQQ:'10001',sourceKind:'human',occurredAt:'2026-10-27T07:00:00Z',content,...extra})
  assert.equal(ingest('new human text',{quoteRefs:['12345']}).effective,true)
  assert.equal(ingest('12345 is a number',{quoteRefs:['12345']}).effective,true)
  assert.equal(ingest('',{quoteRefs:['12345']}).effective,false)
  assert.equal(ingest('quoted text',{quoteRefs:[{messageId:'12345',text:'quoted text'}]}).effective,false)
  for(const extra of [{forwarded:true},{sourceKind:'bot'},{sourceKind:'control'}])assert.equal(ingest('not learning',extra).effective,false)
  const raw='  中文😀\noriginal  ';const row=ingest(raw);assert.equal(f.store.get(row.id).data.content,raw)
}))
await probe(['FIX-06'],'35 history versions, cursor pagination and delete redaction',()=>withFixture(async f=>{
  let row=await f.create('memory',{text:'original-secret',type:'fact'})
  for(let i=0;i<35;i++)row=await f.manage('edit',{id:row.id,expectedVersion:row.version,data:{...row.data,text:`edit-${i}`}})
  const first=f.service.query('history',{id:row.id,limit:20});const second=f.service.query('history',{id:row.id,limit:20,after:first.next})
  assert.equal(first.rows.length,20);assert.equal(second.rows.length,15);assert.equal(new Set([...first.rows,...second.rows].map(r=>r.id)).size,35)
  assert.deepEqual([...first.rows,...second.rows].map(r=>r.version),Array.from({length:35},(_,i)=>35-i))
  await f.manage('delete',{id:row.id,expectedVersion:row.version});assert.equal(f.service.query('history',{id:row.id}).rows.length,0)
  assert(!JSON.stringify(f.store.list('audit',{limit:200})).includes('original-secret'))
}))
await probe(['FIX-10'],'obsolete legacy cannot enable',()=>withFixture(async f=>{
  const row=f.store.create('memory',{text:'obsolete',legacyObsolete:true,pendingConfirmation:true},{characterId:'synthetic-A',scopeKey:'private:10001',status:'disabled'})
  await rejectCode(()=>f.manage('enable',{id:row.id,expectedVersion:1}),'LEGACY_OBSOLETE');assert.equal(f.store.get(row.id).status,'disabled')
}))
await probe(['FIX-11','FIX-12'],'importance defaults, manual boundaries and edit provenance',()=>withFixture(async f=>{
  for(const [type,expected] of Object.entries({experience:1,fact:3,preference:3,relationship:3,promise:4,boundary:5,unknown:1})){
    const row=await f.create('memory',{text:type,type});assert.equal(row.data.importance,expected);assert.equal(row.data.importanceSource,'type-default')
    const edited=await f.manage('edit',{id:row.id,expectedVersion:1,data:{...row.data,text:'edited'}});assert.equal(edited.data.importanceSource,'type-default')
  }
  for(const importance of [0,6,1.5,'3'])await rejectCode(()=>f.create('memory',{text:'bad',importance}),'INVALID_IMPORTANCE')
  for(const importance of [1,5])assert.equal((await f.create('memory',{text:'valid',importance})).data.importanceSource,'manual')
}))
await probe(['FIX-13','REG-01'],'Shanghai date boundaries independent of process TZ',async()=>{
  for(const zone of ['Asia/Shanghai','UTC','America/New_York']){
    const out=execFileSync(process.execPath,['--input-type=module','-e',`import {shanghaiDay} from ${JSON.stringify(new URL('../../../src/domain/core.js',import.meta.url).href)};console.log(JSON.stringify(['2026-10-27T15:59:59Z','2026-10-27T16:00:00Z','2026-12-31T16:00:00Z'].map(shanghaiDay)))`],{env:{...process.env,TZ:zone},encoding:'utf8'})
    assert.deepEqual(JSON.parse(out),['2026-10-27','2026-10-28','2027-01-01'])
  }
})
await probe(['FIX-15'],'manual candidate type/scope rules and source array rejection',()=>withFixture(async f=>{
  for(const [type,scope] of [['expression','private:10001'],['jargon','group:10001'],['preference','private:10001'],['personality','character']]){
    const row=await f.create('candidate',{type,rule:'synthetic rule'},{scopeKey:scope});assert.equal(row.data.matchType,type==='personality'?'personality':'literal');assert(Array.isArray(row.data.originScopes))
  }
  await rejectCode(()=>f.create('candidate',{type:'jargon',rule:'bad'}),'INVALID_CANDIDATE_SCOPE')
  const count=f.store.list('candidate').length;await assert.rejects(()=>f.create('candidate',{type:'expression',rule:'bad',sourceIds:'invalid'}));assert.equal(f.store.list('candidate').length,count)
}))
await probe(['FIX-16'],'status database counts, version and maintenance null',()=>withFixture(async f=>{
  await f.create('memory',{text:'count'});assert.deepEqual(f.service.status().counts,f.store.db.prepare('SELECT kind,status,count(*) AS count FROM records GROUP BY kind,status').all())
  assert.equal(f.service.status().version,JSON.parse(readFileSync(join(root,'package.json'))).version)
  f.service.setMaintenance(true);assert.equal(f.service.status().counts,null)
}))
await probe(['UI-07'],'backend optimistic concurrency and request idempotency',()=>withFixture(async f=>{
  const payload={requestId:'same-request',kind:'memory',characterId:'synthetic-A',scopeKey:'private:10001',data:{text:'same'},reason:'probe'}
  const one=await f.service.manage('create',payload,owner);const two=await f.service.manage('create',payload,owner);assert.equal(one.id,two.id)
  await assert.rejects(()=>f.service.manage('create',{...payload,data:{text:'different'}},owner))
  await f.manage('edit',{id:one.id,expectedVersion:1,data:{text:'new'}})
  await rejectCode(()=>f.manage('edit',{id:one.id,expectedVersion:1,data:{text:'stale'}}),'VERSION_CONFLICT')
}))
await probe(['REG-01'],'local/global request quotas and failed request consumption',()=>withFixture(async f=>{
  const at='2026-10-27T15:00:00Z';f.config.learning.localDailyLimit=2;f.config.learning.globalDailyLimit=3
  const reserve=(scope)=>f.store.tx(()=>reserveQuota(f.store,f.config,{characterId:'synthetic-A',scopeKey:scope,at,taskId:`task-${++serial}`,purpose:'learning',provider:'mock',model:'mock',attempt:1}))
  const row=reserve('private:10001');markUsageAfterFailure(f.store,row.id,new Error('mock failure'),{at});reserve('private:10001')
  assert.throws(()=>reserve('private:10001'),e=>e.code==='LEARNING_QUOTA_EXHAUSTED');reserve('private:10002');assert.throws(()=>reserve('private:10003'))
  assert.equal(readQuota(f.store,f.config,{characterId:'synthetic-A',scopeKey:'private:10001',at}).global,3)
  assert.equal(readQuota(f.store,f.config,{characterId:'synthetic-A',scopeKey:'private:10001',at:'2026-10-27T16:00:00Z'}).global,0)
}))
await probe(['REG-02'],'unknown model capacity prevents recall without manual budget',()=>withFixture(async f=>{
  bind(f,'budget','private:10001');await f.create('memory',{text:'budget text'});f.config.budget.recallTokens=0
  const value=f.service.recall({sessionId:'budget'});assert.equal(value.text,'')
}))
await probe(['REG-03'],'manual candidate cannot bypass evidence gates',()=>withFixture(async f=>{
  const row=await f.create('candidate',{type:'expression',rule:'synthetic expression'})
  const value=evaluateCandidate(f.store,row,f.config,{at:'2026-10-27T08:00:00Z'});assert.equal(value.canAdopt,false);assert.equal(value.canStartTrial,false);assert(value.unmet.length>0)
  assert.equal(f.store.get(row.id).status,'active')
}))
await probe(['REG-04','REG-05'],'fact validity, role isolation, conflict and disable recall',()=>withFixture(async f=>{
  bind(f,'fact','private:10001');const row=await f.create('memory',{text:'old fact',type:'fact',validFrom:'2026-10-27T07:00:00Z',validUntil:'2026-10-27T09:00:00Z'})
  assert(memoryCurrent(row,'2026-10-27T07:00:00Z'));assert(!memoryCurrent(row,'2026-10-27T09:00:00Z'))
  assert(f.service.recall({sessionId:'fact'}).selected.some(r=>r.id===row.id));await f.manage('disable',{id:row.id,expectedVersion:1});assert(!f.service.recall({sessionId:'fact'}).selected.some(r=>r.id===row.id))
  const a=await f.create('memory',{text:'conflict-a',factKey:'test-key'});const b=await f.create('memory',{text:'conflict-b',factKey:'test-key'})
  assert(f.store.list('conflict').length);const selected=f.service.recall({sessionId:'fact'}).selected;assert(!selected.some(r=>[a.id,b.id].includes(r.id)))
}))
await probe(['REG-06'],'malformed/truncated model output rejected',async()=>{
  for(const text of ['', '{"summary":', 'prefix {"summary":"a"}', '```json\n{}'])assert.throws(()=>parseLearningOutput(text))
})
await probe(['UI-14','REG-07'],'synthetic backup preview, confirmation and stale generation',()=>withFixture(async f=>{
  const backup=await f.manage('backupCreate',{});const preview=await f.manage('backupPreview',{id:backup.id})
  assert(preview.confirmationToken);await f.create('memory',{text:'post-preview'})
  await assert.rejects(()=>f.manage('backupRestore',{id:backup.id,confirmationToken:preview.confirmationToken,confirm:true}))
  assert.equal(f.store.db.prepare('PRAGMA quick_check').get().quick_check,'ok')
}))
await probe(['UI-14'],'takeover stays pending without real bridge ACK',()=>withFixture(async f=>{
  const row=await f.manage('takeover',{characterId:'synthetic-A',scopeKey:'private:10001',operation:'activate',bridgeVersion:'0.2.1-r1'})
  assert.equal(row.status,'pending');assert.equal(row.data.acknowledged,false)
}))
await probe(['REG-08'],'Node24 SQLite and bundle apply/dispose under mock host',async()=>{
  const {apply,Config:BundledConfig}=await import('../../../lib/index.js')
  const cleanups=[];const handlers=[]
  const ctx={logger:()=>({error(){},warn(){}}),effect(fn){const off=fn();if(typeof off==='function')cleanups.push(off)},on(){return()=>{}},agents:{list:()=>[]},connection:{fetch:{register(route){handlers.push(route);return()=>{}}}},webServer:{register(){return()=>{}}},llm:{}}
  await apply(ctx,BundledConfig({dataDir:join(directory,'bundle')}))
  assert(handlers.some(h=>h.path.endsWith('/status')))
  for(const off of cleanups.reverse())await off()
})
await probe(['UI-01','UI-02','UI-12'],'management status/error responses and source page assets via mock transport',()=>withFixture(async f=>{
  const routes=[];const ctx={effect(fn){fn()},connection:{fetch:{register(route){routes.push(route);return()=>{}}}}}
  registerManagement(ctx,f.service)
  const status=await routes.find(r=>r.path.endsWith('/status')).fetch(new Request('http://synthetic/status'));assert.equal(status.status,200);assert.equal((await status.json()).ok,true)
  const bad=await routes.find(r=>r.path.endsWith('/mutate')).fetch(new Request('http://synthetic/mutate',{method:'POST',body:'{'}));assert.equal(bad.status,400)
  // The source module's relative page path is not the built bundle path; page asset is tested separately below.
}))

for(const kind of ['fish-memory','slang','social-v2'])await probe(kind==='fish-memory'?['FIX-07']:kind==='slang'?['FIX-08']:['FIX-09'],`${kind} offline preparation preserves original metadata`,async()=>{
  const base=join(directory,`legacy-${kind}`);mkdirSync(base)
  const input=join(base,'input.json');const output=join(base,'output.json')
  const raw=kind==='fish-memory'?[{id:'same',text:'original',refinedSkip:true}]:kind==='slang'?[{content:'word',meaning:'meaning',usage:'usage',example:'example',evidence:['source'],status:'old'}]:{conversations:{'group:10001':{memberImpressions:{nickname:'impression'}}}}
  writeFileSync(input,JSON.stringify(raw));const original=readFileSync(input)
  execFileSync(process.execPath,[join(root,'scripts/prepare-legacy.mjs'),kind,input,output])
  const value=JSON.parse(readFileSync(output));assert.deepEqual(readFileSync(input),original);assert.equal(value.records[0].ownership,'quarantine');assert(value.records[0].sourceHash)
  if(kind==='slang')for(const text of ['word','meaning','usage','example'])assert(value.records[0].text.includes(text))
  if(kind==='social-v2'){assert.equal(value.records[0].legacyNickname,'nickname');assert.equal(value.records[0].legacyConversation,'group:10001')}
  if(kind==='fish-memory'){
    assert.equal(value.records[0].legacyObsolete,true);assert.equal(value.records[0].legacySessionId,'input')
    const folder=join(base,'sessions');mkdirSync(folder);writeFileSync(join(folder,'a.json'),JSON.stringify(raw));writeFileSync(join(folder,'b.json'),JSON.stringify({memories:raw}));writeFileSync(join(folder,'ignore.txt'),'ignored')
    const out=join(base,'directory.json');execFileSync(process.execPath,[join(root,'scripts/prepare-legacy.mjs'),kind,folder,out]);assert.equal(new Set(JSON.parse(readFileSync(out)).records.map(r=>r.id)).size,2)
  }
  assert.throws(()=>execFileSync(process.execPath,[join(root,'scripts/prepare-legacy.mjs'),kind,input,output],{stdio:'pipe'}))
})
await probe(['FIX-05','REG-07'],'chat usage with capture disabled, missing usage, purpose and storage epoch',()=>withFixture(async f=>{
  f.config.features.capture=false;bind(f,'usage','private:10001');let hook
  registerUsage({on(event,handler){assert.equal(event,'llm/stream');hook=handler}},f.service)
  const run=async(options,chunks)=>{for await(const chunk of hook(options,async function*(){yield* chunks}))assert(chunk)}
  await run({sessionId:'usage'},[{type:'usage',usage:{inputTokens:10,outputTokens:3}},{type:'finish',reason:'stop'}])
  let rows=f.store.list('usage');assert.equal(rows.length,1);assert.equal(rows[0].data.inputTokens,10)
  await run({sessionId:'usage'},[]);assert(f.store.list('usage').some(r=>r.data.state==='unknown'&&r.data.cost===null&&r.data.inputTokens===null))
  const count=f.store.list('usage').length;await run({sessionId:'usage',purpose:'learning'},[]);await run({sessionId:'not-bound'},[]);assert.equal(f.store.list('usage').length,count)
  const recall={text:'synthetic injected memory',identity:{characterId:'synthetic-A',scopeKey:'private:10001'},budget:{used:20}}
  f.service.runtime.recallSnapshots=new Map([['usage',recall]])
  await run({sessionId:'usage',system:recall.text},[{type:'finish',reason:'stop'}]);assert.equal(f.store.list('usage').filter(r=>r.data.category==='memory').length,1)
  const stream=hook({sessionId:'usage'},async function*(){yield {type:'delta',text:'start'};yield {type:'finish',reason:'stop'}})
  await stream.next();const pending=f.store.list('usage').find(r=>r.data.state==='pending');assert(pending)
  f.service.runtime.storageEpoch=1;while(!(await stream.next()).done){};assert.equal(f.store.get(pending.id).data.state,'pending')
}))
await probe(['FIX-11','REG-06'],'model importance validation rejects entire output',async()=>{
  const context={characterId:'synthetic-A',scopeKey:'private:10001',materials:[{id:'source-1',characterId:'synthetic-A',scopeKey:'private:10001',senderQQ:'10001'}]}
  const memory={type:'fact',text:'synthetic model fact',sourceIds:['source-1']}
  const good={summary:'synthetic summary',candidates:[],memories:[memory]}
  assert.equal(validateLearningOutput(good,context).memories.length,1)
  for(const importance of [0,6,1.5,'3'])assert.throws(()=>validateLearningOutput({...good,memories:[memory,{...memory,importance}]},context),e=>e.code==='LEARNING_OUTPUT_INVALID_IMPORTANCE')
})
await probe(['FIX-08','FIX-09','FIX-10','UI-14'],'approved mapped legacy import remains disabled and preserves metadata',()=>withFixture(async f=>{
  const records=[{id:'old-1',text:'legacy jargon meaning usage example',meaning:'meaning',usage:'usage',example:'example',legacyNickname:'nickname',legacyConversation:'group:10001',legacyObsolete:true},{id:'old-2',text:'unmapped'}]
  const preview=await f.manage('importPreview',{source:'synthetic-source',records,mapping:{'old-1':{confirmed:true,characterId:'synthetic-A',scopeKey:'group:10001'}}})
  await assert.rejects(()=>f.manage('importApply',{confirmationToken:preview.confirmationToken,sha256:preview.sha256}))
  const receipt=await f.manage('importApply',{confirmationToken:preview.confirmationToken,sha256:preview.sha256,confirm:true});assert.equal(receipt.quarantined,1)
  const row=f.store.list('memory',{characterId:'synthetic-A'})[0];assert.equal(row.status,'disabled');assert.equal(row.data.meaning,'meaning');assert.equal(row.data.legacyNickname,'nickname');assert.equal(row.data.pendingConfirmation,true)
  await rejectCode(()=>f.manage('enable',{id:row.id,expectedVersion:row.version}),'LEGACY_OBSOLETE')
}))
await probe(['REG-07','UI-14'],'synthetic successful restore preserves safety snapshot and invalidates bindings',()=>withFixture(async f=>{
  bind(f,'restore','private:10001');const original=await f.create('memory',{text:'before restore'});const backup=await f.manage('backupCreate',{})
  const newer=await f.create('memory',{text:'after backup'});const preview=await f.manage('backupPreview',{id:backup.id})
  const restored=await f.manage('backupRestore',{id:backup.id,confirmationToken:preview.confirmationToken,confirm:true})
  assert.equal(restored.restored,true);assert.equal(restored.requiresRestart,true);assert(f.store.get(original.id));assert.equal(f.store.get(newer.id),null)
  assert.throws(()=>f.service.identity('restore'),e=>e.code==='NO_BINDING');assert(f.store.list('backup').some(r=>r.data.reason==='before-restore'));assert.equal(f.store.db.prepare('PRAGMA quick_check').get().quick_check,'ok')
}))
await probe(['UI-01','UI-12'],'built bundle serves page/CSS/JS with same-origin CSP',async()=>{
  const {apply,Config:BundledConfig}=await import('../../../lib/index.js');const cleanups=[];const routes=[]
  const ctx={logger:()=>({error(){},warn(){}}),effect(fn){const off=fn();if(typeof off==='function')cleanups.push(off)},on(){return()=>{}},agents:{list:()=>[]},connection:{fetch:{register(route){routes.push(route);return()=>{}}}},webServer:{register(){return()=>{}}},llm:{}}
  try{
    await apply(ctx,BundledConfig({dataDir:join(directory,'bundle-assets')}))
    for(const suffix of ['/page','/page.css','/page.js']){const response=await routes.find(r=>r.path.endsWith(suffix)).fetch(new Request('http://synthetic'+suffix));assert.equal(response.status,200);assert((await response.text()).length>100);assert(response.headers.get('content-security-policy').includes("script-src 'self'"))}
  }finally{for(const off of cleanups.reverse())await off()}
})
const result={at:new Date().toISOString(),node:process.version,syntheticDataDirectory:directory,results}
writeFileSync(process.env.ACCEPTANCE_OUTPUT || new URL('./backend-results.json',import.meta.url),JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify(result,null,2))
process.exitCode=results.some(r=>r.status==='failed')?1:0
