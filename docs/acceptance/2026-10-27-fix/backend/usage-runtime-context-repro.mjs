// Reproduces DSH rc.2 runtime-context shape using only a synthetic temporary Store.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {Store} from '../../../../src/storage/sqlite.js';
import {Config,validateConfig} from '../../../../src/config/index.js';
import {createService} from '../../../../src/application/service.js';
import {registerUsage} from '../../../../src/adapters/dsh/usage.js';
const root=resolve(import.meta.dirname,'../../../..');
const directory=mkdtempSync(join(tmpdir(),'companion-usage-runtime-repro-'));
const config=validateConfig(Config({dataDir:directory,features:{recall:true}}));
const store=new Store(directory),service=createService(store,config,{clock:()=> '2026-10-27T06:00:00Z'});
service.ensureCharacter('synthetic-A','A');service.bind({sessionId:'synthetic-session',conversationKey:'private:10001',characterId:'synthetic-A',botQQ:'90001',bindingVersion:1});
let hook;registerUsage({on(_event,handler){hook=handler}},service);
const recalled={text:'[synthetic-memory v1] 中文 😀 <literal> & {{literal}}',identity:{characterId:'synthetic-A',scopeKey:'private:10001'},budget:{used:24}};
service.runtime.recallSnapshots=new Map([['synthetic-session',recalled]]);
const snapshot='Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n'+recalled.text;
const source={kind:'runtime-context',form:'snapshot',sections:[{name:'qq-companion-memory',text:recalled.text}]};
const run=async options=>{for await(const _ of hook({sessionId:'synthetic-session',...options},async function*(){yield{type:'usage',usage:{inputTokens:30,outputTokens:2}};yield{type:'finish',reason:'stop'}})) {}};
const results=[];
try {
  const runtime=(overrides={})=>({id:'synthetic-runtime',role:'user',content:[{type:'text',text:snapshot}],source:structuredClone(source),...overrides});
  async function test(name,options,expected,mutate){service.runtime.recallSnapshots.set('synthetic-session',structuredClone(recalled));if(mutate)mutate();const before=store.list('usage').filter(r=>r.data.category==='memory').length;await run(options);const rows=store.list('usage').filter(r=>r.data.category==='memory'),actual=rows.length-before;assert.equal(actual,expected,name);if(expected){const row=rows.find(r=>r.data.injectedTokens===24);assert(row);assert.equal(row.data.injectedTokensEstimated,true);assert.equal(row.data.requests,0);assert.equal(row.data.cost,0)}results.push({name,status:'passed',expected,actual})}
  await test('legacy system compatible',{system:snapshot},1);
  await test('real runtime snapshot counts once',{system:snapshot,messages:[runtime(),runtime()]},1);
  await test('ordinary user prose cannot manufacture injection',{messages:[{role:'user',content:snapshot,source:{kind:'qq'}}]},0);
  await test('runtime without sections suppresses system fallback',{system:snapshot,messages:[runtime({source:{kind:'runtime-context',form:'snapshot'}})]},0);
  await test('named section without actual body rejected',{messages:[runtime({content:[{type:'text',text:'unrelated actual body'}]})]},0);
  await test('binding character mismatch',{messages:[runtime()]},0,()=>service.runtime.recallSnapshots.get('synthetic-session').identity.characterId='wrong-role');
  await test('binding scope mismatch',{messages:[runtime()]},0,()=>service.runtime.recallSnapshots.get('synthetic-session').identity.scopeKey='private:10002');
  await test('latest cleared snapshot shadows earlier valid',{system:snapshot,messages:[runtime(),runtime({source:{kind:'runtime-context'},content:'Current runtime context: none.'})]},0);
  await test('latest mismatch shadows earlier valid',{messages:[runtime(),runtime({source:{kind:'runtime-context',form:'snapshot',sections:[{name:'qq-companion-memory',text:'different'}]}})]},0);
  await test('duplicate named sections rejected',{messages:[runtime({source:{kind:'runtime-context',form:'snapshot',sections:[...source.sections,...source.sections]}})]},0);
  await test('wrong section name rejected',{messages:[runtime({source:{kind:'runtime-context',form:'snapshot',sections:[{name:'unrelated-plugin',text:recalled.text}]}})]},0);
  await test('wrong form rejected',{messages:[runtime({source:{...source,form:'other'}})]},0);
  await test('string content runtime accepted',{messages:[runtime({content:snapshot})]},1);
  const result={at:new Date().toISOString(),node:process.version,usageSourceSha256:createHash('sha256').update(readFileSync(join(root,'src/adapters/dsh/usage.js'))).digest('hex'),syntheticOnly:true,results};
  writeFileSync(join(import.meta.dirname,'usage-runtime-context-regression.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
} finally {store.close()}
