# 交付与版本管理

当前交付版本为 `0.1.1`，在 `0.1.0` 基础上重新按原计划复核并补齐遗漏，详见[复核记录](RECHECK.md)。内容包括插件源码、构建脚本、管理页、桥接适配与迁移工具。私有仓库：[skyc10/dsh-qq-companion-memory](https://github.com/skyc10/dsh-qq-companion-memory)，主分支 `main`；生成目录不进 Git。

已核对：构建、源码与产物语法、服务端内置模块依赖、客户端加载包装、固定桥接源补丁及幂等、心情绑定生成结果、发布包逐文件一致性。检查详情和 SHA256 在本地产物 `dist/build-report.json`；发布包为 `dist/dsh-qq-companion-memory-0.1.1.tgz`，固定源离线副本位于该报告指向的 prepared 目录。

未执行任何测试、插件业务验收、QQ发送、真实模型调用、部署或实际接管。业务开关默认关闭。专用 Node24 / DSH rc.2 的实际运行性仍待验收；桥接升级必须重新核对固定源。安装和回退见[操作说明](OPERATIONS.md)。

复现：按锁文件安装依赖 → `npm run build` → `npm run check` → `npm run pack:release`。检查不加载或运行插件业务。源码变更后重新生成发布包并提交；不得提交真实配置、token、数据库或用户材料。
