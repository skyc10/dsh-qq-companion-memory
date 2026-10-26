import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root=fileURLToPath(new URL('../',import.meta.url))
async function files(dir){const out=[];for(const entry of await readdir(dir,{withFileTypes:true})){const p=join(dir,entry.name);if(entry.isDirectory())out.push(...await files(p));else if(/\.(mjs|js)$/.test(p))out.push(p)}return out}
const targets=[]
for(const dir of ['src','scripts','integration','lib']){try{targets.push(...await files(resolve(root,dir)))}catch(error){if(error.code!=='ENOENT')throw error}}
for(const file of targets)await new Promise((done,reject)=>{const child=spawn(process.execPath,['--check',file],{stdio:'inherit'});child.on('error',reject);child.on('exit',code=>code===0?done():reject(new Error(`语法检查失败 ${file}`)))})
const manifest=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'))
for(const value of Object.values(manifest.exports))await readFile(resolve(root,value))
console.log(`语法检查完成：${targets.length} 个脚本；清单导出文件存在。未运行任何业务代码或测试。`)
