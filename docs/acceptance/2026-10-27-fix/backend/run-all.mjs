// Provenance wrapper: only synthetic acceptance scripts are invoked.
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync,execFileSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'../../../..');
const sha=b=>createHash('sha256').update(b).digest('hex');
function snapshot(){const paths=['package.json','package-lock.json','docs/acceptance/2026-10-27/run-backend.mjs','docs/acceptance/2026-10-27-fix/backend/extra.mjs','docs/acceptance/2026-10-27-fix/backend/phase2.mjs','docs/acceptance/2026-10-27-fix/backend/usage-runtime-context-repro.mjs','docs/acceptance/2026-10-27-fix/backend/run-all.mjs'];function walk(p){for(const e of readdirSync(join(root,p),{withFileTypes:true})){const n=p+'/'+e.name;if(e.isDirectory())walk(n);else paths.push(n)}}for(const p of ['src','lib'])walk(p);return Object.fromEntries(paths.map(p=>[p,{raw:sha(readFileSync(join(root,p))),lf:sha(readFileSync(join(root,p),'utf8').replace(/\r\n/g,'\n'))}]))}
const before=snapshot(),runs=[];
for(const [script,name] of [['docs/acceptance/2026-10-27/run-backend.mjs','backend-results'],['docs/acceptance/2026-10-27-fix/backend/extra.mjs','extra-results'],['docs/acceptance/2026-10-27-fix/backend/phase2.mjs','phase2-results'],['docs/acceptance/2026-10-27-fix/backend/usage-runtime-context-repro.mjs','usage-runtime-context-regression']]){const r=spawnSync(process.execPath,[script],{cwd:root,env:{...process.env,ACCEPTANCE_OUTPUT:join(import.meta.dirname,name+'.json')},encoding:'utf8'});writeFileSync(join(import.meta.dirname,name+'.log'),r.stdout+r.stderr);runs.push({script,exitCode:r.status,error:r.error?.message})}
const after=snapshot(),result={at:new Date().toISOString(),node:process.version,version:JSON.parse(readFileSync(join(root,'package.json'))).version,head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceStable:JSON.stringify(before)===JSON.stringify(after),fingerprints:before,runs};
writeFileSync(join(import.meta.dirname,'provenance.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({sourceStable:result.sourceStable,runs}));if(!result.sourceStable||runs.some(r=>r.exitCode!==0))process.exitCode=1;
