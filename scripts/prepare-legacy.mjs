import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'

// 只生成离线审阅清单，不连接旧实例、不改原文件、不推断归属。
const args=process.argv.slice(2)
if(args.length!==3 || !['fish-memory','slang','social-v2'].includes(args[0])) throw new Error('用法：node scripts/prepare-legacy.mjs fish-memory|slang|social-v2 <源JSON> <新清单JSON>')
const [kind,inputArg,outputArg]=args
const input=resolve(inputArg);const output=resolve(outputArg)
if(input===output)throw new Error('输出不能覆盖原文件')
const bytes=await readFile(input)
const sourceHash=createHash('sha256').update(bytes).digest('hex')
const raw=JSON.parse(bytes.toString('utf8'))
let entries=[]
if(kind==='fish-memory')entries=Array.isArray(raw)?raw:Array.isArray(raw.memories)?raw.memories:[]
if(kind==='slang')entries=Array.isArray(raw)?raw:Array.isArray(raw.items)?raw.items:Array.isArray(raw.entries)?raw.entries:[]
if(kind==='social-v2') {
  const conversations=raw.conversations??raw
  for(const [conversation,value] of Object.entries(conversations)) {
    for(const [nickname,impression] of Object.entries(value?.memberImpressions??{}))entries.push({id:`${conversation}:${nickname}`,text:typeof impression==='string'?impression:impression.text??impression.summary??JSON.stringify(impression),legacyConversation:conversation,legacyNickname:nickname,raw:impression})
  }
}
if(!entries.length)throw new Error('没有识别到材料；请检查格式，不自动猜测其它字段')
const records=entries.map((entry,index)=>({id:String(entry.id??index),text:String(entry.text??entry.content??entry.summary??entry.meaning??JSON.stringify(entry)),legacyKind:kind,sourceHash,sourceIndex:index,original:entry,ownership:'quarantine',warning:'旧 Session、昵称和被全量合并的材料不能据此确定真实角色或QQ归属'}))
await writeFile(output,JSON.stringify({schemaVersion:1,source:`${kind}:sha256:${sourceHash}`,records,mapping:{},instructions:'将records和source提交管理页导入预览；仅对已核实项填写映射confirmed/characterId/scopeKey，批准后仍停用。'},null,2),{flag:'wx',mode:0o600})
console.log(`已生成 ${records.length} 条隔离审阅材料，未导入数据库。`)
