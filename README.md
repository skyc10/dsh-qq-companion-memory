# QQ 陪伴记忆与学习插件

面向 QQ 专用 DSH 的独立插件。按稳定角色＋QQ 范围保存记忆，提供显式共享、证据学习、试用反馈和人格版本管理；学习不训练模型权重。

当前状态：`0.1.1` 已按原计划重新复核并补齐遗漏，详见[复核记录](docs/RECHECK.md)。发布包与离线接线产物随交付提供。所有业务开关默认关闭；未部署、未接管旧能力，未执行 QQ／模型运行性验收，未编写执行测试。目标 Node 24、DSH `0.2.1-rc.2`（清单兼容到 `rc.3`，运行兼容仍待验收）。

版本管理：[GitHub 私有仓库](https://github.com/skyc10/dsh-qq-companion-memory)，主分支 `main`。依赖、构建目录、数据库与凭据不进 Git；发布包由锁文件和源码构建。

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

数据默认位于 `$DSH_HOME/qq-companion-memory`。删除保留受控撤销窗口，旧备份和 DSH 历史快照可能留有旧文本；停用更新当前有效快照，不物理改写 DSH 会话历史。
