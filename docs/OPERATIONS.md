# 安装、启用与回退

目标是 QQ 专用实例（当前部署源 D:\deepseek_flash\project），不修改宿主 DSH。开发不等于完成上线验收；本次不启动容器、不发送 QQ、不请求模型。

## 安装准备

1. 使用 Node 24，执行构建、语法检查与发布打包；保留原部署镜像和 `/data` 一致性快照。
2. 将发布目录放入镜像的 `/opt/plugins/dsh-qq-companion-memory`，在专用 profile 内使用 `dsh plugin --profile web add` 安装 bundle。已有持久 profile 也须走此命令，不手写 bundle 包条目。
3. 用本插件桥接补丁脚本修改固定 `a49877f4e58d04e47532d44b803360d0f001160d` 桥接源码，构建期保存原文件。版本或锚点不符必须停止构建，不能跳过补丁继续上线。
4. 按插件 Config 填写独立内部 token（至少 32 字符，推荐 tokenFile）、有效管理员 QQ 白名单；桥接必须使用相同认证和实际 ownerQQ。勿将凭据写进仓库。
5. 召回默认按当前聊天模型可用上下文的 `recallPercent`（默认10%）自动分配；`recallTokens>0` 可设手动上限。能力未知时须填手动预算。学习可显式配置 provider/model，或跟随当前可信绑定模型；未知上下文、输出能力必须填手动上限。备份启用前填写上海时区 HH:mm。

## 分阶段启用

- 先只开 capture，核对角色 UUID、群号／QQ、事件时间和重放去重。改名必须保留 UUID；不能用文件内容或同名昵称推断合并。
- 在专用 DSH 插件管理中停用旧 fish-memory 的工具、上下文与采集，并部署仅保留心情绑定的新迁移脚本；桥接 ACK 只确认它自身的黑话和印象通道，不替代这一步。管理页先 prepare 再 activate 目标范围，等待桥接停旧输出并 ACK；active 后才允许新注入。
- 在隔离区审阅旧材料；导入预览给出明确角色和范围映射，批准后仍保持停用，逐项复核启用。
- 分别开启 recall、learning、trial、autoAdopt；检查配额、来源、试用和实际成功发送的核验记录。没有可靠应用依据的条目保持待核验。
- 日常管理使用 DSH 侧栏“记忆管理”；QQ 管理命令以桥接实际 owner 与插件白名单的交集为准，不依赖聊天自称身份。

## 备份与恢复

默认数据根 `$DSH_HOME/qq-companion-memory`，SQLite 一致性快照保存在 backups。每日时刻未填则不能启用计划备份。删除撤销窗口默认 7 天，撤销后保持停用；旧备份和 DSH 会话可能仍含旧文本。

恢复顺序：选择备份 → 预览计数、时间及复活风险 → 明确确认 → 自动保存恢复前快照 → 替换数据库。预览后数据有变化须重新预览。恢复后学习停止，重新加载插件并重新同步可信绑定后再启用；恢复不会改写 DSH 会话历史。

## 回退

先关闭新学习与召回，发起目标范围 rollback 并等待桥接恢复旧能力确认；停用新插件 bundle，恢复旧镜像／构建配置及备份。保留新库作追溯，不把新记录重新全量灌入旧 Session。人格回退创建新版本、冻结旧证据，保留记忆经历。

旧迁移脚本的全会话合并必须停用，其心情绑定部分独立保留。[生成器](../scripts/prepare-migration.mjs)只读取原件、写到新路径，不执行迁移；核对生成结果后在部署阶段替换原脚本。

```sh
node scripts/prepare-migration.mjs --source /path/fish-bot/migrate-memory.mjs --output ./prepared/migrate-memory.mjs
```
