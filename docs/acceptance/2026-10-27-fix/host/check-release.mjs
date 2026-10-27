import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)), workspace=path.resolve(here,'../../../..'),root=process.env.RELEASE_SOURCE_ROOT||workspace;
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version;
const results=[];
const check=(name,ok,details)=>results.push({name,status:ok?'pass':'fail',details});
check('new version 0.1.2',version==='0.1.2',version);
const old=JSON.parse(fs.readFileSync(path.join(here,'old-artifact-hashes.json'),'utf8').replace(/^\uFEFF/,''));
for(const item of old)check('old unchanged '+item.file,hash(fs.readFileSync(path.join(workspace,'dist',item.file))).toUpperCase()===item.Hash,item.Hash);
const tgz=process.env.RELEASE_TGZ||path.join(root,'dist',`dsh-qq-companion-memory-${version}.tgz`);
const bytes=fs.readFileSync(tgz),tar=gunzipSync(bytes),entries=[];
for(let offset=0;offset+512<=tar.length;) {
  const h=tar.subarray(offset,offset+512);if(h.every(x=>x===0))break;
  const name=h.subarray(0,100).toString().split('\0')[0];
  const size=parseInt(h.subarray(124,136).toString().replace(/\0/g,'').trim(),8)||0;
  const content=tar.subarray(offset+512,offset+512+size);entries.push(name);
  const relative=name.replace(/^package\//,'');
  if(/^(package(?:-lock)?\.json|src\/|lib\/|scripts\/|integration\/|cordis\.patch\.yml)/.test(relative)) {
    const local=path.join(root,relative);
    check('tar matches '+relative,fs.existsSync(local)&&hash(fs.readFileSync(local))===hash(content),hash(content));
  }
  offset+=512+Math.ceil(size/512)*512;
}
check('tar contains no runtime data or dependencies',!entries.some(p=>/(^|\/)(node_modules|\.git|credentials|data|state)(\/|$)|\.(sqlite|db)$|(^|\/)config\.json$/.test(p)),entries.length);
for(const [s,t]of [['page.html','index.html'],['page.css','page.css'],['page.js','page.js']]){
  const a=fs.readFileSync(path.join(root,'src/client',s),'utf8'),b=fs.readFileSync(path.join(root,'lib/page',t),'utf8');
  check('page source matches lib '+t,a.replace(/\r\n/g,'\n')===b.replace(/\r\n/g,'\n'),{exact:a===b,comparison:'LF-normalized text'});
}
const client=fs.readFileSync(path.join(root,'lib/client.js'),'utf8');
check('client module loader wrapper',client.includes('window.__ModuleLoader__.load')&&client.includes('id:"dsh-qq-companion-memory"'),null);
check('package lock version',JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'))).version===version,null);
const report={at:new Date().toISOString(),version,tgzSha256:hash(bytes),entryCount:entries.length,results};
fs.writeFileSync(path.join(here,'release-results.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({version,tgzSha256:report.tgzSha256,total:results.length,failures:results.filter(r=>r.status==='fail')},null,2));
process.exitCode=results.some(r=>r.status==='fail')?1:0;
