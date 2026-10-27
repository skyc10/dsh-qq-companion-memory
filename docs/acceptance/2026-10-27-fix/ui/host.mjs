// Isolated synthetic HTTP transport, NOT a DSH host or authentication test.
import {createServer} from 'node:http';
import {mkdtempSync,readFileSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../../../../src/storage/sqlite.js';
import {Config,validateConfig} from '../../../../src/config/index.js';
import {createService} from '../../../../src/application/service.js';
import {createOperations} from '../../../../src/application/operations.js';
import {createLearningEngine} from '../../../../src/learning/index.js';
const dir=mkdtempSync(join(tmpdir(),'companion-ui-synthetic-'));
const config=validateConfig(Config({dataDir:dir,features:{capture:false,recall:false}}));
let offset=0;const clock=()=>new Date(Date.now()+offset).toISOString();
const store=new Store(dir); const service=createService(store,config,{clock});
const learning=createLearningEngine({store,config,clock,model:{generate:async()=>{throw Error('Synthetic UI host must never call a model')}}});
const operations=createOperations(service,{learning});service.attach({operations,learning});
service.ensureCharacter('synthetic-A','合成角色A');service.ensureCharacter('synthetic-B','合成角色B');
for(let i=0;i<27;i++)store.create('memory',{text:i===0?'<script>window.XSS=1</script>中文😀':`合成记忆${i}`,type:'fact',importance:3,custom:{nested:[null,{x:'保留'}]},sourceIds:['synthetic-source'],occurredAt:['2026-10-27T15:59:59Z','2026-10-27T16:00:00Z','2026-12-31T16:00:00Z'][i%3]},{characterId:'synthetic-A',scopeKey:'private:10001',subjectQQ:'10001',status:'active'});
const base='/api/qq-companion-memory/v1';let fail='',dropNext=false;
createServer(async(req,res)=>{try{
 const path=new URL(req.url,'http://localhost').pathname;
 if(path==='/test/drop-next'){dropNext=true;res.end('armed');return;}
 if(path==='/test/advance'){offset+=660000;res.end('advanced eleven minutes');return;}
 if(path==='/test/fault'){fail=new URL(req.url,'http://localhost').searchParams.get('mode')??'';res.end('set');return;}
 const route=path.replace(/^\/subpath/,'').slice(base.length);
 if(['page','page.css','page.js'].includes(route.slice(1))){const file=route==='/page'?'page.html':route.slice(1);res.writeHead(200,{'content-type':file.endsWith('html')?'text/html; charset=utf-8':file.endsWith('css')?'text/css':'text/javascript','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'self'; base-uri 'none'; form-action 'self'"});res.end(readFileSync(new URL('../../../../src/client/'+file,import.meta.url)));return;}
 if(route==='/status'&&fail){if(fail==='network'){req.socket.destroy();return;}res.writeHead(Number(fail)||200,{'content-type':'application/json'});res.end(fail==='json'?'broken':JSON.stringify({ok:false,error:{code:'SYNTHETIC_'+fail,message:'合成状态失败'}}));return;}
 let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{};
 appendFileSync(new URL('./requests.jsonl',import.meta.url),JSON.stringify({path,body})+'\n');
 const value=route==='/status'?service.status():route==='/query'?service.query(body.kind,body):route==='/mutate'?await service.manage(body.action,body.payload,{kind:'owner',id:'web-owner'}):undefined;
 if(route==='/mutate'&&dropNext){dropNext=false;appendFileSync(new URL('./lost-response.jsonl',import.meta.url),JSON.stringify({body,result:value})+'\n');req.socket.destroy();return;}
 if(value===undefined){res.writeHead(404);res.end('not found');return;}res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,value}));
}catch(e){res.writeHead(e.status??500,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,error:{code:e.code??'ERROR',message:e.message}}));}}).listen(18764,'127.0.0.1',()=>console.log(JSON.stringify({url:`http://127.0.0.1:18764${base}/page`,dataDir:dir,node:process.version})));
