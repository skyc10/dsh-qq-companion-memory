import { readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { resolve, join, basename } from 'node:path'
import { createHash } from 'node:crypto'

// 只生成离线审阅清单，不连接旧实例、不改原文件、不推断归属。
const args=process.argv.slice(2)
if(args.length!==3 || !['fish-memory','slang','social-v2'].includes(args[0])) throw new Error('用法：node scripts/prepare-legacy.mjs fish-memory|slang|social-v2 <源JSON或fish-memory目录> <新清单JSON>')
const [kind,inputArg,outputArg]=args
const input=resolve(inputArg);const output=resolve(outputArg)
if(input===output)throw new Error('输出不能覆盖原文件')
const directory=(await stat(input)).isDirectory()
if(directory && kind!=='fish-memory')throw new Error('目录输入仅支持 fish-memory；其它格式请指定 JSON 文件')
const files=directory ? (await readdir(input,{withFileTypes:true})).filter(file=>file.isFile() && file.name.endsWith('.json')).map(file=>join(input,file.name)).sort() : [input]
if(files.some(file=>resolve(file)===output))throw new Error('输出不能覆盖目录中的源文件')
const records=[];const sources=[]
for(const file of files) {
  const bytes=await readFile(file)
  const sourceHash=createHash('sha256').update(bytes).digest('hex')
  const raw=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''))
  const sourceFile=basename(file)
  const legacySessionId=kind==='fish-memory' ? basename(file,'.json') : ''
  sources.push({sourceFile,sourceHash})
  let entries=[]
  if(kind==='fish-memory')entries=Array.isArray(raw)?raw:Array.isArray(raw?.memories)?raw.memories:[]
  if(kind==='slang')entries=Array.isArray(raw)?raw:Array.isArray(raw?.items)?raw.items:Array.isArray(raw?.entries)?raw.entries:[]
  if(kind==='social-v2') {
    const conversations=raw.conversations??raw
    for(const [conversation,value] of Object.entries(conversations)) {
      for(const [nickname,impression] of Object.entries(value?.memberImpressions??{}))entries.push({id:`${conversation}:${nickname}`,text:typeof impression==='string'?impression:impression?.text??impression?.summary??JSON.stringify(impression),legacyConversation:conversation,legacyNickname:nickname,raw:impression})
    }
  }
  for(const [index,value] of entries.entries()) {
    const entry=value && typeof value==='object' && !Array.isArray(value) ? value : {text:String(value??'')}
    const obsolete=Boolean(entry.已被取代 || entry.refinedSkip)
    const fields=kind==='slang' ? Object.fromEntries(['content','meaning','usage','example'].filter(key=>entry[key]!=null).map(key=>[key,String(entry[key])])) : {}
    const text=kind==='slang' ? [['表达',fields.content??entry.text],['含义',fields.meaning],['用法',fields.usage],['例句',fields.example]].filter(([,v])=>v).map(([label,v])=>`${label}：${v}`).join('\n') : String(entry.text??entry.content??entry.summary??entry.meaning??JSON.stringify(entry))
    records.push({id:directory?`${sourceFile}:${entry.id??index}`:String(entry.id??index),text:text||JSON.stringify(entry),...fields,legacyKind:kind,sourceFile,sourceHash,sourceIndex:index,...(legacySessionId?{legacySessionId}:{}),...(entry.legacyConversation?{legacyConversation:entry.legacyConversation,legacyNickname:entry.legacyNickname}:{}),legacyStatus:obsolete?'obsolete':String(entry.status??'unverified'),legacyObsolete:obsolete,original:value,ownership:'quarantine',warning:obsolete?'旧记录已被取代或 refinedSkip；仅供审阅，不应作为当前材料启用':'旧 Session 文件名可能已被净化，仅是归属线索；不能据此确定真实角色或QQ归属'})
  }
}
if(!records.length)throw new Error('没有识别到材料；请检查格式，不自动猜测其它字段')
const sourceHash=directory?createHash('sha256').update(JSON.stringify(sources)).digest('hex'):sources[0].sourceHash
await writeFile(output,JSON.stringify({schemaVersion:1,source:`${kind}:sha256:${sourceHash}`,sources,records,mapping:{},instructions:'将records和source提交管理页导入预览（单批最多1000条/1MB，较大清单须分批）；仅对已核实项填写映射confirmed/characterId/scopeKey，批准后仍停用。legacyObsolete 条目保留待确认标记，不直接启用。'},null,2),{flag:'wx',mode:0o600})
console.log(`已生成 ${records.length} 条隔离审阅材料，未导入数据库。`)
