# QQ 陪伴记忆与学习插件

面向 QQ 专用 DSH 的独立插件。按稳定角色＋QQ 范围保存记忆，提供显式共享、证据学习、试用反馈和人格版本管理；学习不训练模型权重。

当前版本：`0.1.3`。当前专用实例启用采集、召回、学习、试用、自动采纳与每日备份；自动采纳仍受完整证据和时间门槛约束。管理面板1.1.0提供认证跳转入口。安装模板默认全关，其他实例不自动启用。此前65组合成检查与限定私聊真实联调见[0.1.2验收](docs/acceptance/2026-10-27-fix/REPORT.md)，本次配置、面板和产物交付见[0.1.3变更](docs/CHANGELOG-0.1.3.md)。

版本管理：[GitHub 仓库](https://github.com/skyc10/dsh-qq-companion-memory)，主分支 `main`。依赖、构建目录、数据库与凭据不进 Git；发布包由锁文件和源码构建。

源码、测试证据与交接分别推送对应 GitHub 仓库。测试组通过不代表40项整项全过；0.1.2尚未创建正式发行标签，剩余页面视觉与组合范围见本轮报告。[工作区规则副本](docs/WORKSPACE-GITHUB-RULES.md)。

工作区关联的部署代码、独立管理面板和本插件三项目的仓库、实际路径及核验状态，见[三个项目登记](docs/WORKSPACE-PROJECTS.md)。

## 开发与安装

```sh
npm install --ignore-scripts
npm run build
npm run check
npm run pack:release
# 仅在专用实例内执行，不指向宿主的 web profile
DSH_HOME=/data/dsh-home dsh plugin --profile web add /opt/plugins/dsh-qq-companion-memory
```

构建打包 Schemastery；服务端不依赖外部裸导入。管理页通过 DSH owner 已鉴权通道提供，侧栏“记忆管理”可打开。完整接入顺序见[操作说明](docs/OPERATIONS.md)。

| 入口 | 内容 |
| --- | --- |
| [开发计划](PLAN.md) | 需求、T/S/R 参数与验收基线 |
| [架构](docs/ARCHITECTURE.md) | 模块及边界 |
| [决策](docs/DECISIONS.md) | 实施口径、缺项和限制 |
| [模块契约](docs/IMPLEMENTATION.md) | 内部记录及 API |
| [交付记录](docs/DELIVERY.md) | 已完成核对、发布产物与版本管理 |
| [操作说明](docs/OPERATIONS.md) | 安装、分阶段启用、恢复与回退 |
| [WebUI管理工作台](docs/WEBUI.md) | 总览、待处理入口、表单编辑、历史与管理动作 |
| [独立测试待测清单](docs/TEST-CHECKLIST.md) | 后端修复、页面人工检查、回归和宿主验收；当前均待测 |

数据默认位于 `$DSH_HOME/qq-companion-memory`。删除保留受控撤销窗口，旧备份和 DSH 历史快照可能留有旧文本；停用更新当前有效快照，不物理改写 DSH 会话历史。

WebUI沿用 DSH 侧栏“记忆管理”和同源 `/api/qq-companion-memory/v1/page`。新增状态总览、待核验/隔离材料入口、常用内容表单和高级JSON切换；后台仍独立校验来源、版本及确认。没有新增独立端口或替换宿主认证。运行交互证据和未覆盖项见本轮验收报告，不以构建通过替代业务验收。

## 下载与问题反馈

- [下载发布包](https://github.com/skyc10/dsh-qq-companion-memory/releases)（查看对应版本的要求与已知限制）。
- [提交 Bug](https://github.com/skyc10/dsh-qq-companion-memory/issues/new/choose)：附版本、环境和复现步骤，日志与截图先脱敏。
- [协作说明](CONTRIBUTING.md)。
