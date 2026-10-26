#!/usr/bin/env node
// 离线生成仅保留心情绑定的迁移脚本；不执行原迁移，也不覆盖原件。
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname, basename } from 'node:path'
import { createHash } from 'node:crypto'
const args=process.argv.slice(2)
const value=key=>{const at=args.indexOf(key);return at<0?null:args[at+1]}
const source=value('--source');const output=value('--output')
if(!source || !output)throw new Error('用法：node scripts/prepare-migration.mjs --source <migrate-memory.mjs> --output <新文件>')
const inputPath=resolve(source);const outputPath=resolve(output)
if(inputPath===outputPath || basename(inputPath)!=='migrate-memory.mjs')throw new Error('必须指定原迁移脚本，并输出到不同的新路径')
const original=await readFile(inputPath,'utf8')
const lines=original.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n').split('\n')
function lineOf(prefix){const hits=lines.map((line,index)=>line.startsWith(prefix)?index:-1).filter(index=>index>=0);if(hits.length!==1)throw new Error(`锚点须唯一：${prefix}`);return hits[0]}
const first=lineOf('// ── 1. 取当前会话 id ')
const second=lineOf('// ── 2. 收集所有记忆文件 ')
const mood=lineOf('// ── 5. 同步心情插件的会话绑定 ')
const end=lineOf('log(migratedAny ? ')
if(!(first<second && second<mood && mood<end))throw new Error('迁移脚本结构不兼容，拒绝猜测')
const preserved=lines.slice(mood,end).join('\n')
const generated=[
  '#!/usr/bin/env node',
  '// qq-companion-memory：停止跨会话记忆合并与旧工具自动绑定；保留原心情绑定逻辑。',
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  lines[lineOf('const DSH_HOME = ')],
  lines[lineOf('const STATE = ')],
  lines[lineOf('function log(')],
  '',
  ...lines.slice(first,second),
  preserved,
  "log('心情绑定处理完成；旧记忆全会话合并已停用');",
  '',
].join('\n')
if(!generated.includes(preserved) || generated.includes('base.memories =') || generated.includes('fish-memory-config.json'))throw new Error('输出结构检查失败')
await mkdir(dirname(outputPath),{recursive:true})
await writeFile(outputPath,generated,{encoding:'utf8',flag:'wx'})
console.log(JSON.stringify({source:inputPath,output:outputPath,sourceSha256:createHash('sha256').update(original).digest('hex'),moodBlock:'原文保留',legacyMerge:'已从输出移除',executedMigration:false},null,2))
