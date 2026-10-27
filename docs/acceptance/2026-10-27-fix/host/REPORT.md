# 隔离宿主与装配验收（进行中）

范围：P1工具链、P1双补丁装配、REG-08~10。2026-10-27，Asia/Shanghai。

## 已完成：补丁装配

`node docs/acceptance/2026-10-27-fix/host/patch-matrix.mjs` 使用只读审计原件复制出的系统临时目录。脚本不会写审计原件、启动QQ桥接或调用模型。

结果：13/13通过，逐项原始输出、脚本SHA256、临时目录位置见 `patch-results.json`。

- 正确顺序：固定源 → companion --apply → runtime → companion --check → runtime重复 → companion --check。重复验证全目录文件hash不变。
- companion拒绝未知源码、缺失/重复锚点、marker损坏及原件备份损坏。
- runtime拒绝缺失/重复锚点、marker损坏、原件备份损坏，以及保留marker但修改健康状态正文的已装配产物。
- runtime在后续mcp-host-server.js锚点失败时，前面bridge.js及整个测试目录均无文件变化。
- 另以Node --import测试注入在后续mcp-host-server.js实际rename时抛错；此前已写文件和备份全部恢复，整个目录hash与初始相同。

安全边界：固定源验证由装配入口companion负责。runtime首次应用仅验证锚点；companion --check不代替runtime完整产物校验。因此装配验收必须同时运行两套验证。逆序runtime → companion不在支持流程内。

## 现存持久会话绑定（已修复并隔离复测）

`existing-session.mjs` 在VM内执行临时已装配副本的真实ensureSession函数，合成 `state.sessions['private:10001']='synthetic-existing-session'`，当前代际合法、ensureChatModel成功。实际返回现存session，reportBinding调用为0，见 `existing-session-results.json`。源码启动路径只对持久会话follow；绑定补丁只位于新建saveState之后，因此新插件空库配桥接旧持久映射时身份不会补齐。主代理新增binding-existing补丁后，VM重测现存session上报一次可信绑定，missingBinding=false。补丁矩阵13/13再次通过。binding-versions.mjs使用真实adapter与SQLite service、拦截_enqueue避免联网：同session重报v1稳定，同角色重建升v2，adapter重启仍v2，切角色升v3且characterId不同；旧session不取得新ownership，旧回执被service以STALE_BINDING拒绝，见binding-version-results.json。未执行生产操作。

## REG-08 / P1工具链：隔离真实宿主通过

最终不可变镜像 `sha256:9acf0187a7b69ddc383cae5a0ea6832d0b55c69bc902312efaced38160520b8e`，Node24.22.1/DSH0.2.1-rc.2/pnpm10.34.9。容器仅新可写层，不挂宿主或生产卷；测试网络none或Docker internal，未启动qq-bridge或调用QQ/模型。

现有bootstrap准备基础宿主后，正式 `dsh plugin --profile web add --offline /opt/plugins/dsh-qq-companion-memory` 成功，依赖与bundle由正式管理器登记。真实DSH启动创建SQLite；未认证status/page/css/js均401，官方根token换cookie后四路均200。合成角色和记忆写入成功。正式remove后重启API404且数据保留；正式readd后重启API200，原合成memory记录ID/版本/正文不变，SQLite integrity_check=ok。所有特性保持false。

既有id override（无name/insert）配置bridge.tokenFile、adminQQs及budget成功；内部controls缺token401，正确合成token200，五项feature仍false。真实DSH LocalSubprocessRuntime运行node回声退出0/stdout42/stderr空，无Missing native spawn helper。镜像构建有依赖脚本策略warning，但实际spawn通过；PTY及全MCP工具调用未作为本次通过范围。

UI代理已在Edge确认18890侧栏iframe、官方新窗口独立页和合成角色创建/查询均成功，版本0.1.2，无console错误；见其UI报告截图。无官方认证引导的新tab直接API路径为forbidden，不能据此绕过宿主认证。详细宿主结果见 `host-runtime-results.json`。

结论：隔离安装/加载/卸载/重启/SQLite/认证/原生spawn门槛通过，可进入主代理负责的生产新备份安装阶段；不代表真实QQ回执、模型学习或全REG已通过。

清理：UI代理确认18890测试完成后，已核对两个独有测试容器Mounts均为空，测试网络internal=true且只连测试浏览器容器。随后删除companion-host-acceptance-20261027、companion-host-browser-20261027及companion-host-test-net；核对进程命令为host/local-relay.cjs后停止本机relay，18890已无监听。保留全部报告/证据、冻结9acf0187镜像、候选包及测试snapshot镜像；未删除生产资源。

### 早期环境探查

隔离探查旧 `dafeiyu/fish-bot:memory-acceptance` 镜像确认DSH `0.2.1-rc.2` 和Node `v24.22.1`、正式命令为 `dsh plugin --profile <name> add <pkg>`。探查使用新临时容器、`--network none`、不挂任何数据卷，未启动入口脚本/桥接。此探查不算候选宿主验收。

真实QQ/模型不在本次授权范围。

## REG-10：候选包核验

冻结源码commit：`1c8bd8d06eb8f6b4a10f2d79d3f41fce72d5ff95`。干净git archive检出目录 `D:\deepseek_flash\backup\companion-package-1c8bd8d`；候选包为其中 `dist/dsh-qq-companion-memory-0.1.2.tgz`。SHA256：`1efc7b563ce0d548d4c3ce8911455726eec0d5c0c0f69dd356c587194b391183`。

`check-release.mjs` 60/60通过，见 `release-results.json`。tgz内src/lib/scripts/integration/清单/锁文件逐文件与冻结目录字节一致；未包含运行时config.json、数据库、state、依赖目录或Git目录。锁版本及客户端加载包装符合0.1.2。src页面是LF，已构建lib/page为CRLF；文本LF归一后完全一致，未将其称为字节一致。

旧0.1.0/0.1.1 tgz/zip及其sha256旁文件哈希已先保留于 `old-artifact-hashes.json`，核验保持不变。候选ZIP SHA256为 2783e223ea7442737891bde820c6f9dd1cc8a04aeb8e418d8688a3cd6f56953f。ZIP只含tgz、SHA256SUMS、候选commit清单、操作及变更说明；内嵌tgz与独立tgz字节hash一致，清单hash匹配，见 zip-results.json。此核验不代表发布或标签已完成。
