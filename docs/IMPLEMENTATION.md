# 首版内部开发契约

状态：首版源码完成，运行性验收待专用实例执行；需求以[计划](../PLAN.md)为准。

## 存储与应用

[Store](../src/storage/sqlite.js)采用同步事务，回调不得 await。记录统一为 `{id,kind,characterId,scopeKey,subjectQQ,status,version,createdAt,updatedAt,data}`，时间使用 UTC ISO，QQ 使用字符串。

- `get(id,{includeDeleted})`；`list/scan(kind,filter)`；`create(kind,data,options)`；`update(id,expectedVersion,patch)`，data 为完整替换。
- `tx(fn)` 可嵌套；`once(namespace,requestId,payload,fn)` 对不同内容的同键请求返回 409；`audit` 不复制正文；`generation()` 用于预览失效。
- `backup(destination)` 是一致性快照；版本历史单独保存，删除源时清理；受控撤销期默认 7 天。
- 公共范围：`private:QQ`、`group:群号`、`profile:QQ`。角色级用 `character`，隔离导入用 `quarantine`，两者只在专用动作处理。
- 同一次学习请求联合提炼候选及最多8条有来源记忆；经历摘要直接有效，事实等其余类型待管理员核对后确认。来源或租约在请求期间变化则整批不提交，游标不推进。
- `conversation-unit`仅存角色／范围／bot下的时间边界和合并指向，不存正文。新材料按30分钟间隔附段；计证据时解析合并，删源不拆段，迟到消息不虚增独立交流。
- kind：character、binding、event、conversation-unit、memory、profile、supplement、share、candidate、evidence、conflict、feedback、trial、application、personality、task、usage、recall、backup、takeover、import、control；查询另支持 audit 和 history。
- 来源保留 `data.sourceIds`；人格还保留 `sourceCandidateIds`。召回递归复核来源；有效原文可按经历本地检索，不另调模型。

[应用服务](../src/application/service.js)提供 `ingest/bind/delivery/command/recall/manage/query/status`。`query` 参数为 `{kind,characterId,scopeKey,subjectQQ,status,search,limit,after}`，结果为 `{rows,next}`。`recall` 只按可信 Session 绑定归属，结果为 `{text,selected,omitted,budget,identity}`；每范围召回轨迹默认保留最近 200 条，可配置。

管理动作见[实际实现](../src/application/management.js)：create、edit、disable、enable、delete、undo、share、unshare、resolveConflict、feedback、verifyApplication、candidate、task、rollback、rollbackBatch、takeover、assignImport；[运维动作](../src/application/operations.js)：importPreview、importApply、backupCreate、backupPreview、backupRestore。通用写参数为 `{requestId,id,expectedVersion,reason,...}`，新建及预览不要求不存在的目标版本。系统元数据不接受通用删除。

## 学习与宿主

[学习入口](../src/learning/index.js)：`createLearningEngine({store,config,model,logger,clock})` → `tick(signal,{once:true}) / evaluate(candidateId) / close() / status()`。模型适配 `resolve({characterId,scopeKey,sessionId,signal})` 返回固定 provider/model、容量及保守估算器；`generate({selection,system,input,maxTokens,signal,requestId})` 返回 `{text,finish,usage}`，只有完整 stop 输出可提交。

[配置](../src/config/index.js)默认关闭五个业务开关。T/S/R 默认数值保留计划；近期 7 天、半衰期 30 天、连续交流间隔 30 分钟。模型、召回预算和备份时刻未填写时不猜测容量或可用状态。角色覆盖不得放宽证据和召回上限；输入、输出与预留空间在派发前复核。

## HTTP 与桥接

管理接口位于 `/api/qq-companion-memory/v1`：`GET status/page/page.css/page.js`、`POST query/mutate/recall`；mutate 传 `{action,payload}`。走 DSH 同源浏览器认证，当前单 owner 连接视为管理者。响应统一为 `{ok:true,value}` 或 `{ok:false,error:{code,message,details}}`。

内部前缀 `/qq-companion-memory/internal/v1`，独立 Bearer token：

| 方法/路径 | 字段或响应 value |
| --- | --- |
| POST events | schemaVersion=1，eventId、botQQ、characterId、conversationKey、groupId、senderQQ、messageId、occurredAt（缺失则 occurredAtUnknown=true）、receivedAt、content、quoteRefs、sourceKind、bindingVersion、segments；可信 qq 归一为 human，未知时间不计有效材料 |
| POST bindings | sessionId、characterId、conversationKey、bindingVersion、botQQ、participants、provider、model；私聊参与者固定为本人 QQ |
| POST deliveries | **单条回执**：sessionId、characterId、conversationKey、bindingVersion、success、messageId、content、sentAt；只有成功且真实 messageId 才登记，登记不等于已核验应用 |
| POST commands | requestId、characterId、conversationKey、senderQQ、text；桥接须同时检查真实 ownerQQ 与 adminQQs；响应 `{handled,reply}` |
| GET controls | `{features,adminQQs,scopes:[{id,characterId,scopeKey,version,status,desiredOwner,acknowledged,legacyDisabled,expectedBridgeVersion,...}]}` |
| POST acknowledgements | `{id,expectedVersion,characterId,conversationKey,legacyDisabled,bridgeVersion}`；服务端校验精确目标与版本 |

接管步骤：prepare 只准备；activate 写 desiredOwner=companion、status=pending。桥接先停用该范围旧注入及旧学习，再 ACK `legacyDisabled:true`；服务端随后变为 active，才允许新召回和模型请求。rollback 请求 desiredOwner=legacy，新侧立即停用，桥接恢复旧侧后 ACK false。不能用未经确认的 active 查询替代此闭环。

## 写范围与验证边界

主代理负责 application/config/adapters/构建/文档；学习、界面、桥接分别负责自己的目录，存储恢复专项仅改 storage。禁止测试、真实模型调用、QQ 发送和容器变更；仅进行构建、语法及静态产物核对。
