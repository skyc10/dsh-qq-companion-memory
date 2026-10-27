# 0.1.2 安装候选

2026-10-27，Asia/Shanghai。此版本包含0.1.1之后的修复与WebUI，新增部署工具链和补丁装配验收；发行状态以本轮最终验收报告为准，不覆盖0.1.1产物或标签。

- 部署镜像固定使用pnpm 10.34.9，通过DSH正式插件管理器安装。
- 桥接装配顺序固定为审计上游原件→companion补丁→部署runtime补丁；保留固定源验证，不接受现场哈希替代。
- runtime补丁由部署仓库负责完整预检、已有产物验证与失败恢复；程序回退优先换镜像，不单独用companion的revert移除部署补丁。
- 未自动迁移旧记忆。生产目标仅capture/recall，learning/trial/autoAdopt关闭；接管须真实ACK。

完整测试范围与证据在docs/acceptance/2026-10-27-fix；合成结果不代表真实QQ或宿主通过。
