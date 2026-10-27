import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompanionAdapter } from '../../../../integration/bridge-companion-adapter.mjs';
import { Store } from '../../../../src/storage/sqlite.js';
import { Config,validateConfig } from '../../../../src/config/index.js';
import { createService } from '../../../../src/application/service.js';
const here=path.dirname(fileURLToPath(import.meta.url)),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'companion-bindings-'));
const config=validateConfig(Config({dataDir:path.join(tmp,'store')}));
const store=new Store(config.dataDir),service=createService(store,config);
let a;const history=[];
function adapter(){const x=createCompanionAdapter({stateDir:path.join(tmp,'adapter'),config:{token:'synthetic-test-token-never-production-000',endpoint:'http://127.0.0.1:1'},gate:{allowAllWhenEmpty:true}});assert(x.enabled);x._enqueue=(kind,p,payload)=>{history.push({kind,payload});return payload};return x;}
try {
 a=adapter();a.noteRoleState({role:'Synthetic A',mode:'active'});
 const b=sid=>a.reportBinding({sessionId:sid,conversationKey:'private:10001',botQQ:'10002'});
 const p1=b('session-a');service.bind(p1);const own1=a.captureOwnership({sessionId:'session-a',conversationKey:'private:10001',botQQ:'10002'});
 assert.equal(b('session-a').bindingVersion,p1.bindingVersion);
 const p2=b('session-b');assert(p2.bindingVersion>p1.bindingVersion);service.bind(p2);
 assert.equal(a.captureOwnership({sessionId:'session-a',conversationKey:'private:10001'}),null);
 assert.throws(()=>service.delivery({...own1,success:true,messageId:'synthetic-old-message',content:'synthetic'}),e=>e.code==='STALE_BINDING');
 a.close();a=adapter();a.noteRoleState({role:'Synthetic A',mode:'active'});
 const p3=b('session-b');assert.equal(p3.bindingVersion,p2.bindingVersion);service.bind(p3);
 a.noteRoleState({role:'Synthetic B',mode:'active'});const p4=b('session-c');assert.notEqual(p4.characterId,p3.characterId);assert(p4.bindingVersion>p3.bindingVersion);service.bind(p4);
 assert.throws(()=>service.identity('session-b'),e=>e.code==='STALE_BINDING');
 const result={at:new Date().toISOString(),status:'pass',tmp,versions:[p1,p2,p3,p4].map(p=>({sessionId:p.sessionId,characterId:p.characterId,bindingVersion:p.bindingVersion})),oldReceiptRejected:true,history};
 fs.writeFileSync(path.join(here,'binding-version-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,history:undefined},null,2));
}finally{a?.close();store.close();}
