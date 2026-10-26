import { build } from 'esbuild'
import { mkdir, copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root=fileURLToPath(new URL('../',import.meta.url))
await mkdir(resolve(root,'lib/page'),{recursive:true})
const server=await build({absWorkingDir:root,entryPoints:['src/index.js'],outfile:'lib/index.js',bundle:true,platform:'node',target:'node24',format:'esm',packages:'bundle',sourcemap:true,metafile:true,banner:{js:"// QQ 陪伴记忆插件；运行环境 Node 24 / DSH 0.2.1-rc.2。"}})
for(const [source,target] of [['page.html','index.html'],['page.css','page.css'],['page.js','page.js']])await copyFile(resolve(root,'src/client',source),resolve(root,'lib/page',target))
await build({absWorkingDir:root,entryPoints:['src/client/index.js'],outfile:'lib/client.js',bundle:true,platform:'browser',target:'es2022',format:'cjs',external:['react'],sourcemap:true,banner:{js:'window.__ModuleLoader__.load({id:"dsh-qq-companion-memory",factory:(require)=>{var module={exports:{}};var exports=module.exports;'},footer:{js:'return module.exports;}});'}})
const imports=Object.values(server.metafile.outputs).flatMap(o=>o.imports).filter(i=>i.external&&!i.path.startsWith('node:')&&!i.path.startsWith('.'))
if(imports.length)throw new Error(`服务端含未打包依赖：${imports.map(i=>i.path).join(', ')}`)
console.log('构建完成：服务端仅依赖 Node 内置模块，客户端页面已复制。')
