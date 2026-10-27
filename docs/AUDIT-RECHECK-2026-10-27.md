# 子代理报告与当前源码核对

2026-10-27（Asia/Shanghai）。按本轮用户要求，先读取 WORK-STATE.md、HANDOVER.md 和两份审计原文，再核对实际源码，最后修正仍存在的缺口。基线提交为 `adf5af5666160a835d4b461f974b3165ec7bc189`；未重新委派子代理。

原报告保留在本地 `dist/audit-bd3b626e-pending.md`、`dist/audit-c0be56f8-pending.md`，没有覆盖原文。“待用户确认”是接收时的历史状态；本轮用户已要求核对并在修改前比对代码。本次修改仅在本地，未打包、提交、推送或部署。

## 逐项结论

| 报告主张 | 修改前核对 | 源码证据与本轮处理 |
| --- | --- | --- |
| C：人格试用永远无法通过 S4 | 不成立，报告遗漏既有人工路径 | `service.delivery` 在成功发送时无条件创建 application，literal 过滤只决定预填候选；`management.verifyApplication` 已允许符合来源范围、状态和本人暂停条件的人格候选，核验后加入 verifiedCandidateIds；`evidence.summarizeTrial` 按候选和消息去重计数。本轮只修正页面候选 ID 提示，没有新增自动计数或把注入视为应用。 |
| B：跨群个人档案永不召回 | 默认创建路径属实；“永不”过强 | 创建时群来源缺省 visibility，召回要求 public-profile；原始 JSON 手填或编辑可以写入该值。本轮在创建和编辑统一规范：群 originScope 经 canonicalScope 校验后写 public-profile，其余写 private。列表增加可见性；旧记录不批量改写，需编辑确认来源。 |
| C：复用候选丢弃冲突 | 属实 | scheduler 的 existing 分支 attachEvidence 后直接 continue；现与新建分支一样在同一提交事务登记 conflicts。原有冲突读取继续阻断试用/采纳/召回。 |
| C：带引用的自有正文整体排除 | 属实 | ingest 原先以 quoteRefs 非空直接否决，而桥接 plainContent 为新增正文、quoteRefs 字符串为引用消息 ID。现 ingest 与学习复用 classifyEvent，仍保留人类、时间、非转发等前置条件；空正文、引用文本重复继续排除。字符串引用 ID 不再被错误当作引用文本。 |
| B：capture 关闭导致用量漏记 | 属实；“伪零”表述不准确 | usage 观察器确实受 capture 门控；页面原本显示“未记录/暂无记录”，并非数值零。本轮移除 capture 依赖，仍限可信当前 QQ 绑定、非 purpose 专用请求且非恢复期。未知 token/费用继续保持 null。 |
| B/C：历史入口缺失 | 属实 | sqlite.list 已支持 history，需传 id/targetId、after=记录ID@版本号；删除会清除版本表。现详情抽屉提供只读历史、数据字段差异和原快照，每页20条，沿用真实 next 游标；已删除记录不展示入口。没有添加后端不支持的回退操作。 |
| B：旧格式预处理缺失 | 属实，顶层数组本来已支持 | 只读核对旧 fish-memory 的每会话 JSON、桥接 slang-learner 的 content/meaning/usage/example，以及 refinedSkip/已被取代标记。本轮支持 fish-memory 目录；保留文件名线索、文件 hash、来源序号和原文；目录内记录 ID 加文件名前缀。黑话正文合并表达、含义、用法、例句。social-v2 会话/昵称线索与上述字段在 operations 导入时均保留到顶层 data。过时记录保留 legacyObsolete 和 pendingConfirmation，不当当前材料使用。未执行预处理或真实迁移。 |
| C：重要性从未写入 | 部分属实 | 原始 JSON 已可手填且召回/归档读取有效，但默认学习与人工流程没有生成或校验。现统一校验1至5整数；默认经历1、事实/偏好/关系3、承诺4、边界5，未知类型1。记录 manual/model/type-default 来源，未改数值的编辑保留来源。模型可给出合法重要性；提示与输出结构升至 /4。归档和召回继续读取同一个字段。旧数据无批量回填，未标注继续如实显示。 |
| B：归档按浏览器时区分组 | 属实 | dayKey 原用本地 getFullYear/getMonth/getDate。现与服务端使用相同 Intl Asia/Shanghai 日键，时间显示、导出文件名及 timeZone 元数据同步。 |

## 静态核对与限制

- 本地 Node `v24.16.0`；构建通过，服务端仍仅依赖 Node 内置模块，管理页已复制到 lib。
- `npm run check` 完成35个脚本语法检查及清单导出存在性检查；`git diff --check` 通过。
- 独立日期公式计算（未导入业务）：UTC `2026-10-27 15:59:59` 对应上海10月27日，UTC `16:00:00` 对应10月28日；UTC `2026-12-31 16:00:00` 对应上海2027年1月1日。
- 没有编写或执行任何测试，没有动态导入插件业务、访问真实 QQ/模型、改容器/profile、迁移数据或接管。
- 管理页交互、数据库及导入实际执行、人格全链路和专用 DSH rc.2 兼容仍待运行验收。构建/语法检查不证明这些业务结果。
- 插件清单版本仍为既有0.1.1；lib 为本次本地构建。dist 的0.1.1发布包及原 SHA256 仍代表旧交付，不包含本次修改；后续发布应创建新版本，不能改写 v0.1.1。

## 后续：完成修复与管理工作台

用户随后明确要求完成修复，写待测清单供其它agent测试，并开发WebUI。追加检查修正了启用链路：原normalizeMemory只修改副本；现在重要性、档案可见性随显式启用写回。旧失效材料直接启用返回LEGACY_OBSOLETE；确认旧标记有误时须先明确编辑。没有批量回填旧记录。

人工候选创建/编辑也按既有类型范围校验，并补matchType/scopeKind/originScopes。管理状态版本改从package.json读取，避免旧硬编码0.1.0；新增全库kind/status聚合计数与读取时间。

WebUI在既有路由上增加状态工作台、待处理入口、常用内容表单/高级JSON双模式、导航深链接、窄屏样式和焦点管理。详见[界面说明](WEBUI.md)。所有行为测试和人工检查仍为待测，见[待测清单](TEST-CHECKLIST.md)及对应源码指纹；未在本轮启动页面或插件业务。

## 源码备份续记

用户随后要求先推送GitHub留档。本文件前文“尚未提交/推送”描述当时阶段；本次备份提交包含修复源码、WebUI、核对说明、待测清单和源码指纹。没有创建新发行版本、改写v0.1.1或重打旧包；测试和上线状态不因GitHub备份改变。远端提交是否同步以实际推送后的核对结果及WORK-STATE.md最新记录为准。
