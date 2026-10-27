# 浏览器合成环境阶段验收

负责人：UI 子代理；时间：2026-10-27 13:29–14:10 Asia/Shanghai。未提交，由主代理统一留档。以下主表为合并后最终状态；后续时间段仅作证据过程记录，不覆盖主表。

环境：Windows Node v24.16.0，Microsoft Edge 浏览器（扩展控制，版本未核验），127.0.0.1:18764。`host.mjs` 使用真实 src Store/application service/operations 和临时 SQLite；HTTP transport 为测试脚本，**不是实际 DSH**，不验证 DSH 认证、安装或侧栏。未打开生产配置/数据库，未触碰真实 QQ/模型/容器/profile。

阶段基线：测试期间主代理更新到0.1.2并修复UI07，页面修复基线 HEAD `53688ef007858bf506e4785d0e2f128e61f71f5b`（后续最终候选1c8bd8d仅桥接变更，页面代码不变；实际隔离DSH测试使用最终候选镜像）。页面JS SHA256 `FCCF4C7B542FB11F7CFED28CE17CE0BF6BA0B2944BF58D2C0E4322E556147D7F`；CSS `F5E588848807887B5F3010864AC5D79E5553BD830A9F840A318A7C114C12E2BE`；HTML `6C0FF7188FEF1A5A71489B625A4A42FC4028B7EE483D0C5C906300930AED5072`。未对最终冻结清单作全量比对，本报告为阶段结果，不代表完整验收通过。

| ID | 状态 | 实测与剩余内容 |
|---|---|---|
| UI-01 | 部分通过 | 实际隔离DSH侧栏iframe、官方新窗口独立页0.1.2和真实API通过；无认证引导直开forbidden。子路径资源/API仅合成transport通过，实际DSH子路径未搭建。dsh-iframe/dsh-standalone证据。 |
| UI-02 | 通过（合成HTTP） | 正常、401、404接口未挂载、500、200坏JSON、socket断开均实际浏览器执行；错误可读、无伪成功，恢复正常后重试成功。401/404/500/json-error/network.txt。 |
| UI-03 | 部分通过 | 已启用指标真实27→28跳active列表；旧范围/主体QQ筛选经总览卡清空。其余卡完整组合未测。 |
| UI-04 | 部分通过 | 实际DSH角色及六类型记忆表单全部成功，默认重要性1/3/5/3/3/4；合成群来源profile随主体QQ范围、人格character候选通过。群内补充及全部范围组合未测。 |
| UI-05 | 通过（合成数据） | custom嵌套/null、raw原件保留；表单→JSON→表单；sourceIds按行/逗号去重，清context/sourceIds移除key且保存成功。clear-fields.txt、requests.jsonl。 |
| UI-06 | 通过（本地校验分支） | 空白转JSON；数组/null/破损JSON阻止切回且保留输入；无时区时间、importance6本地拒绝不发mutate。业务后端另有50001字正文拒绝。invalid-form.txt。 |
| UI-07 | 修复后通过（合成数据） | 真实两页v1并发先提交v2、后提交409不覆盖；服务端创建成功后socket丢响应，原样重试同ID仅一条v1；409原样同ID、变内容换ID修复通过。lost-response.jsonl、two-tabs.txt、retry-fixed.txt。 |
| UI-08 | 部分通过 | 16分区逐一真实导航，候选application hash恢复；记忆20/8分页，next为真实ID，搜索后重置第1页1条；其他状态有界面选项，完整数据链未测。 |
| UI-09 | 通过（已执行导航） | #candidate/application直开恢复；back/forward恢复#memory和#memory/event；未知hash安全回总览，URL无QQ/正文；未发现无限查询。 |
| UI-10 | 通过（已执行键盘分支） | 背景inert；详情Tab/ShiftTab在抽屉循环，嵌套dialog Escape仅关前层，抽屉关闭回记录；Enter展开只读历史。keyboard-history.txt。 |
| UI-11 | 部分通过 | 1440/1024/820/390/360五宽主页面无横溢，360导航局部横滚截图。200%缩放、暗色、减动画未执行；不使用未授权隐蔽环境修改。 |
| UI-12 | 部分通过 | script文本/中文emoji原样，不执行；实际CSP16分区无console错误；50001字符创建由真实业务后端可读INVALID_INPUT拒绝。昵称XSS、HTTP总请求体1MB限制未实测。too-long-error.txt。 |
| UI-13 | 部分通过 | 共享→撤销disabled；停用/启用、删除/撤销、删除后无历史；冲突retain保留甲resolved另一方paused；纠正反馈暂停目标；真实engine evaluate未满足S1-S6、pause/resume；单项、双目标批次、人格回退真实成功且autoAdoptPaused。仅来源失效全传播和所有解决方式矩阵未全测。action-results.json及requests.jsonl。 |
| UI-14 | 通过（合成协议分支） | 备份创建预览恢复，缺确认拒绝；导入preview→token/hash批准→逐项归属停用；时钟前进11分钟后预览批准409拒绝；prepare→activate pending未ACK→rollback-pending，未强制active。restore/expired-preview/import-assigned/takeover证据。 |
| FIX-08 | 通过（合成脚本+页面） | slang真实预处理→预览批准→quarantine→逐项group归属disabled，meaning/usage/example/sourceHash/raw.original完整保留，非已采纳候选。slang-manifest.json、slang-reviewed.txt。 |
| FIX-13 | 部分通过 | 浏览器归档显示2026-10-27/28、2027-01-01三组9/9/9条（另有新建1条）；对应原始三UTC边界。浏览器时区切换能力未提供，未测UTC/纽约；导出download事件等待超时，不能标导出通过。 |

发现与修复：UI07 P1 requestId变内容不更新已修复并实际复测，证据保留初次失败和修复后请求，不改写旧日志。409提示currentVersion为空属于反馈细节，可读“请刷新”仍可见。接管通用表单已有同范围记录时未自动填版本，但可手填且后端校验生效；不是强制激活。

限制：导出点击后的浏览器download等待30秒超时并重置会话，已恢复同页；未证明导出文件内容与命名。所有部分通过均保留剩余用例，不能汇总成UI-01至14全通过。截图与原始请求只含合成数据。

## 13:40–13:44追加实测

- UI-02：已补404（接口未挂载）与socket断开（连接失败），恢复正常后重新读取成功。所有要求的状态分支现已浏览器执行；证据404.txt、network.txt，其余上表证据。
- UI-14、FIX-09页面：真实导入预览两个同昵称不同会话材料，一条明确映射A/private:10001，一条不映射；批准自动携带token/hash/confirm。列表分别disabled和quarantine；第二条详情保留legacyNickname/legacyConversation，逐项分配至B/private:10002后仍disabled，再人工理由启用才active v3。没有因同昵称合并。见import-assigned.txt及requests.jsonl。
- UI-10：补Shift+Tab从关闭按钮回最后JSON summary、Tab再回关闭，焦点均位于抽屉；Enter展开历史，v2/v1只读可见，无通用回退。keyboard-history.txt。
- UI-11：1440、1024、820、390、360五宽度实测documentElement和body scrollWidth均等于innerWidth，无主页面横向溢出；360截图见已有证据。未提供colorScheme/reducedMotion/timezone能力，未声称暗色、减动画或三时区浏览器实测。
- UI-04、FIX-01页面：个人档案表单范围固定profile、随主体QQ更新，群originScope经真实创建显示同角色跨群认识与profile:10001；前导零非canonical号码在本地拒绝并保留输入。未误称任意字符串均合法。

## 13:45–13:48追加实测

- UI-06补null、破损JSON切回均拒绝且保持JSON输入；importance=6在本地拒绝。invalid-form.txt；未发送这些无效创建mutate。
- UI-09补未知分区/标签回退总览，浏览器back恢复#memory、forward恢复#memory/event，无无限查询。
- UI-03补旧范围private:99999和主体99999筛选后回总览点已启用卡，两字段均清空。
- FIX-15页面补人格候选表单选择character创建，manual/matchType=personality/scopeKind=character显示正确；候选evaluate因测试宿主未挂learning engine返回NOT_READY，保留为环境未执行。
- 真实DSH UI01尝试：host代理提供的隔离回环18889首次浏览器访问ERR_CONNECTION_REFUSED，已反馈host代理核对；未访问生产。

## 13:49–13:52实际DSH补测

host代理修复隔离端口转发后使用回环18890，容器internal网络、无宿主卷、未启动QQ bridge、全功能关闭。通过测试DSH认证进入，无生产凭据。

- 侧栏“记忆管理”实际iframe成功加载0.1.2，真实status空库0计数，全关状态正确；console error/warn为空。iframe src为相对`api/qq-companion-memory/v1/page`。见dsh-iframe.txt/png。
- 在iframe点击“新窗口打开”，新独立页实际加载0.1.2和真实status/API，无桥接token输入，无token出现在最终URL；console为空。见dsh-standalone.txt/png。
- 直接无引导另开API page显示forbidden，证明未认证直开受保护；官方新窗口认证路径可用，不能把这个forbidden归为页面加载失败。
- 独立页表单新建纯合成角色ui-host-synthetic，角色范围固定character，真实提交成功并系统记录显示v1。见dsh-created-role.txt。没有发送模型或QQ消息。
- UI13/FIX06合成环境追加停用→可恢复删除→删除正文为空且历史入口消失→撤销删除（恢复停用）页面真实动作，版本3→4→5→6；取消停用不发送写请求。deleted-no-history.txt及requests.jsonl。

实际DSH子路径部署未搭建；子路径仅前述合成HTTP transport实测，不以根路径宿主代替。

13:52–13:54追加UI04/FIX11真实宿主六类型表单：共同经历、事实、边界、偏好、关系、承诺均通过普通表单创建，真实列表默认重要性分别1、3、5、3、3、4。角色ui-host-synthetic、group:10001，全为纯合成数据。见dsh-six-memory.txt/png。测试中两次连续操作观察赶在请求结束前超时，重新观察后均确认已成功，没有重复提交或重复记录，最终仅六条。已通知host代理该隔离容器可清理。

## 最后一轮补测证据说明

18764宿主挂真实createLearningEngine，model.generate仅为必定抛错的隔离mock，未tick、不访问外网。新增drop-next在真实manage成功后仅断开socket；lost-response.jsonl记录成功返回，requests.jsonl保留原样重试。两页同版本并发和来源去重/清字段、slang逐项复核、过期预览、超长限制均以实际浏览器操作。

seed-actions.mjs仅向独有临时合成SQLite预置已采纳候选、人格快照链、冲突两方，未伪装成学习门槛实跑。UI单项/批次回退后candidate版本3且autoAdoptPaused=true；人格回退创建新restored版本、旧current为superseded、来源人格候选paused且autoAdoptPaused=true；共同经历/记忆保留。冲突resolved后另一方paused，纠正反馈再暂停保留方；共享引用disabled。action-results.json为事后只读数据库核对，浏览器请求见requests.jsonl。

为验证过期令牌，测试时钟仅在此进程前进11分钟，因此部分记录UTC与浏览器真实当前时间相差11分钟；不代表时区显示错误。补测完成后停止18764服务，日志不再变化。最终主表已同步；未执行项保留限制，不能宣称40项全通过。
