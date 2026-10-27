import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const plugin = path.resolve(here, '../../../..');
const deploy = process.env.DEPLOY_ROOT || 'D:/deepseek_flash/project';
const audit = process.env.BRIDGE_AUDIT || 'D:/大肥鱼QQ/过时与待清理/2026-10-27/05-审计与调研/源码审计/qq-bridge';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-host-patches-'));
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const scripts = { runtime: path.join(deploy, 'fish-bot/apply-runtime-patches.mjs'), companion: path.join(plugin, 'scripts/patch-bridge.mjs') };
const results = [];
function snapshot(root) {
  const out = {};
  function walk(p) { for (const e of fs.readdirSync(p, {withFileTypes:true})) { const f=path.join(p,e.name); if(e.isDirectory())walk(f); else out[path.relative(root,f)] = sha(fs.readFileSync(f)); } }
  walk(root); return out;
}
function fresh(name) {
  const root = path.join(tmp,name); fs.mkdirSync(root);
  fs.copyFileSync(path.join(audit,'package.json'), path.join(root,'package.json'));
  fs.cpSync(path.join(audit,'src'),path.join(root,'src'), {recursive:true});
  fs.mkdirSync(path.join(root,'integration'));
  fs.copyFileSync(path.join(plugin,'integration/bridge-companion-adapter.mjs'),path.join(root,'integration/bridge-companion-adapter.mjs'));
  return root;
}
function run(kind,root,check=false) {const p=spawnSync(process.execPath,[scripts[kind], ...(kind==='runtime'?[root]:['--root',root,check?'--check':'--apply'])],{encoding:'utf8'}); return {code:p.status,output:(p.stdout||'')+(p.stderr||'')};}
function expect(ok,message) {if(!ok)throw new Error(message);}
function test(name,fn) {try {const evidence=fn(); results.push({name,status:'pass',evidence});}catch(e){results.push({name,status:'fail',error:e.message});}}
function mutate(root,file,fn) {const p=path.join(root,'src',file); fs.writeFileSync(p,fn(fs.readFileSync(p,'utf8')));}
function rejectUnchanged(kind,root) {const before=snapshot(root),r=run(kind,root); expect(r.code!==0,'unexpected acceptance'); expect(JSON.stringify(snapshot(root))===JSON.stringify(before),'rejection modified files');return r;}
test('fixed source then companion then runtime; both idempotent',()=>{
  const root=fresh('normal'); const log=[];
  for(const kind of ['companion','runtime']) {const r=run(kind,root);log.push(r);expect(r.code===0,kind+' initial failed: '+r.output);}
  const before=snapshot(root);
  for(const kind of ['companion','runtime','companion']) {const r=run(kind,root,kind==='companion');log.push(r);expect(r.code===0,kind+' idempotence failed: '+r.output);expect(JSON.stringify(snapshot(root))===JSON.stringify(before),kind+' idempotence changed files');}
  return log;
});
for(const kind of ['runtime','companion']) {
  for(const mode of (kind==='runtime'?['missing-anchor','duplicate-anchor']:['unknown-source','missing-anchor','duplicate-anchor'])) test(kind+' rejects '+mode,()=>{
    const root=fresh(kind+'-'+mode);
    mutate(root,'bridge.js',s=>mode==='unknown-source'?s+'\n// unexpected drift\n':mode==='missing-anchor'?s.replace("path.join(ROOT, 'config.json')","path.join(ROOT, 'config-unknown.json')"):s+"\n// path.join(ROOT, 'config.json')\n");
    return rejectUnchanged(kind,root);
  });
  test(kind+' rejects corrupt marker',()=>{
    const root=fresh(kind+'-marker'); const r=run(kind,root);expect(r.code===0,r.output);
    mutate(root,'bridge.js',s=>s.replace(kind==='runtime'?'DAFEIYU_RUNTIME_V2':'[companion:import]',kind==='runtime'?'DAFEIYU_RUNTIME_BROKEN':'[companion:broken]'));
    return rejectUnchanged(kind,root);
  });
  test(kind+' rejects corrupt original backup',()=>{
    const root=fresh(kind+'-backup');const r=run(kind,root);expect(r.code===0,r.output);
    const backups=Object.keys(snapshot(root)).filter(p=>/orig|original|runtime-source/.test(p));expect(backups.length>0,'no provenance backup produced');
    for(const p of backups)fs.appendFileSync(path.join(root,p),'\n// corrupt provenance\n');
    return rejectUnchanged(kind,root);
  });
}
test('runtime later-file failure is atomic',()=>{
  const root=fresh('atomic');mutate(root,'mcp-host-server.js',s=>s.replaceAll("path.join(ROOT, 'config.json')","path.join(ROOT, 'wrong.json')"));
  return rejectUnchanged('runtime',root);
});
test('runtime detects composed output tampering preserving all markers',()=>{
  const root=fresh('content-tamper');
  for(const kind of ['companion','runtime']) {const r=run(kind,root);expect(r.code===0,r.output);}
  mutate(root,'bridge.js',s=>s.replace('const dshHealth = { connected: false','const dshHealth = { connected: true'));
  return rejectUnchanged('runtime',root);
});
test('runtime later-file rename failure restores all earlier writes',()=>{
  const root=fresh('write-fault'),before=snapshot(root);
  const preload=path.join(tmp,'inject-write-fault.mjs');
  fs.writeFileSync(preload,`import fs from 'node:fs';\nconst original=fs.renameSync;let fired=false;fs.renameSync=function(from,to){if(!fired&&String(to).endsWith('mcp-host-server.js')){fired=true;throw new Error('synthetic later-file rename failure')}return original.call(this,from,to)};\n`);
  const p=spawnSync(process.execPath,['--import',pathToFileURL(preload).href,scripts.runtime,root],{encoding:'utf8'});
  expect(p.status!==0,'fault did not fail');
  expect((p.stderr||'').includes('synthetic later-file rename failure'),'fault not triggered');
  expect(JSON.stringify(snapshot(root))===JSON.stringify(before),'write fault left partial files');
  return {code:p.status,output:(p.stdout||'')+(p.stderr||'')};
});
const report={at:new Date().toISOString(),node:process.version,tmp,audit,scriptHashes:Object.fromEntries(Object.entries(scripts).map(([k,p])=>[k,sha(fs.readFileSync(p))])),results};
fs.writeFileSync(process.env.HOST_PATCH_OUTPUT||path.join(here,'patch-results.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({tmp,results:results.map(({name,status,error})=>({name,status,error}))},null,2));
process.exitCode=results.some(r=>r.status==='fail')?1:0;
