# 管理页面

原生 DOM 页面，外部 CSS/JS，无新增前端依赖。[入口](index.js)注册侧栏及 iframe，[页面](page.js)仅调用同源 `status/query/mutate`。样式见[CSS](page.css)，骨架见[HTML](page.html)。

所有写动作生成 requestId；现有目标带 expectedVersion，409 显示冲突。动作取值以[管理实现](../application/management.js)和[运维实现](../application/operations.js)为准。

| 动作 | 核心参数 |
| --- | --- |
| create / edit | kind、归属、data；edit 完整替换 data |
| disable / enable / delete / undo | id、expectedVersion；待确认记忆启用另带 confirm:true |
| share / unshare | 源 id、targetScope、fields[]，或共享引用 id |
| candidate | operation=evaluate/pause/reject/resume；恢复不复用冻结证据 |
| task | operation=pause/resume，保留游标与最短间隔 |
| feedback | targetId、expectedVersion、sentiment、text |
| resolveConflict | id、expectedVersion、resolution；事实保留／替换另填 keepId，区分情境填 contexts |
| verifyApplication | id、expectedVersion、candidateId、excerpt；须为真实成功发送，仅该候选计次 |
| rollback | 候选或人格版本 id、expectedVersion |
| rollbackBatch | targets:[{id,expectedVersion}]，同角色；任一版本过期则整批不执行 |
| assignImport | 隔离材料 id、expectedVersion、characterId、scopeKey、confirm:true |
| takeover | characterId、scopeKey、operation=prepare/activate/rollback、已有版本 |
| backupCreate / backupPreview | reason，或备份 id；preview 返回 confirmationToken |
| backupRestore | id、confirmationToken、confirm:true |
| importPreview / importApply | source、records[]、mapping → confirmationToken/sha256 → confirm:true |

日期归档按来源时间分组，可导出已加载记录；导出文件明确标记 partial 和后续游标。分页使用服务端 next，错误与空结果分别展示。界面未做运行性验收。
