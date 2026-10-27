import { createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGzip } from 'node:zlib'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// 使用标准 ustar 格式，无需执行 npm pack 或隐式生命周期脚本。
const root=fileURLToPath(new URL('../',import.meta.url))
const manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8'))
const targets=['package.json',...manifest.files]
async function expand(path){const abs=resolve(root,path);try{const entries=await readdir(abs,{withFileTypes:true});return(await Promise.all(entries.map(e=>expand(`${path}/${e.name}`)))).flat()}catch(error){if(error.code==='ENOTDIR')return[path];throw error}}
const files=[...new Set((await Promise.all(targets.map(expand))).flat())].sort()
const octal=(n,len)=>n.toString(8).padStart(len-1,'0')+'\0'
async function* tar(){
  for(const file of files){
    const name=`package/${file.replaceAll('\\','/')}`;const data=await readFile(join(root,file));const header=Buffer.alloc(512)
    let entryName=name;let prefix=''
    if(Buffer.byteLength(name)>100){
      const splits=[...name.matchAll(/\//g)].map(match=>match.index).reverse()
      const split=splits.find(at=>Buffer.byteLength(name.slice(0,at))<=155 && Buffer.byteLength(name.slice(at+1))<=100)
      if(split===undefined)throw new Error(`打包路径过长：${name}`)
      prefix=name.slice(0,split);entryName=name.slice(split+1)
    }
    header.write(entryName,0,100);header.write(prefix,345,155);header.write(octal(0o644,8),100);header.write(octal(0,8),108);header.write(octal(0,8),116);header.write(octal(data.length,12),124);header.write(octal(0,12),136);header.fill(32,148,156);header.write('0',156);header.write('ustar\0',257);header.write('00',263)
    const checksum=header.reduce((a,b)=>a+b,0);header.write(checksum.toString(8).padStart(6,'0')+'\0 ',148)
    yield header;yield data;if(data.length%512)yield Buffer.alloc(512-data.length%512)
  }
  yield Buffer.alloc(1024)
}
await mkdir(join(root,'dist'),{recursive:true})
const path=join(root,'dist',`${manifest.name}-${manifest.version}.tgz`)
await pipeline(Readable.from(tar()),createGzip(),createWriteStream(path))
console.log(`发布包已生成：${path}`)
