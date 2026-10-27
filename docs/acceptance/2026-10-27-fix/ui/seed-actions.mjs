// Pure synthetic fixture setup; no production paths or external services.
import {Store} from '../../../../src/storage/sqlite.js';
const store=new Store(process.argv[2]);
const meta={characterId:'synthetic-A',scopeKey:'group:10001',status:'active'};
store.tx(()=>{
for(const [id,text]of [['ui-conflict-a','冲突合成甲'],['ui-conflict-b','冲突合成乙']])store.create('memory',{text,type:'fact',importance:3},{...meta,id});
store.create('conflict',{text:'合成冲突待解决',targetIds:['ui-conflict-a','ui-conflict-b'],sourceIds:['ui-conflict-a','ui-conflict-b'],resolved:false},{...meta,id:'ui-conflict'});
for(const id of ['ui-single','ui-batch-a','ui-batch-b'])store.create('candidate',{type:'expression',rule:id,context:'合成回退',matchType:'literal',scopeKind:'group',sourceIds:[],evidenceIds:[],acceptedAt:'2026-10-20T00:00:00Z'},{...meta,id,status:'accepted'});
store.create('candidate',{type:'personality',rule:'合成人格来源',context:'合成人格',personalityChange:'耐心一点',sourceIds:[],evidenceIds:[]},{...meta,scopeKey:'character',id:'ui-personality-source',status:'accepted'});
store.create('personality',{adopted:true,adoptedAt:'2026-10-20T00:00:00Z',snapshot:{changes:[]},changes:['合成初版'],sourceCandidateIds:[]},{...meta,scopeKey:'character',id:'ui-personality-old',status:'superseded'});
store.create('personality',{adopted:true,adoptedAt:'2026-10-24T00:00:00Z',parentId:'ui-personality-old',snapshot:{changes:[{candidateId:'ui-personality-source',change:'耐心一点'}]},changes:['合成新版'],sourceCandidateIds:['ui-personality-source']},{...meta,scopeKey:'character',id:'ui-personality-current'});
});
console.log('seeded synthetic conflict/candidate/personality fixtures');store.close();
