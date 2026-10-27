# qq-bridge 集成（薄适配层）

面向 QQ 专用实例。本目录不修改部署源：适配层是独立文件，接线由 `scripts/patch-bridge.mjs` 一次性完成并可回滚。

| 文件 | 作用 |
| --- | --- |
| `bridge-companion-adapter.mjs` | 零裸导入适配层（只用 `node:fs` / `node:path` / `node:crypto` + 全局 `fetch`） |
| `config.example.json` | 合并进 qq-bridge `config.json` 顶层的 `companion` 段 |

## 安装

```bash
cp -r integration /opt/qq-bridge/

node scripts/patch-bridge.mjs --root /opt/qq-bridge              # 报告，不写文件
node scripts/patch-bridge.mjs --root /opt/qq-bridge --apply      # 写入，保留 bridge.js.orig
node scripts/patch-bridge.mjs --root /opt/qq-bridge --check      # CI/巡检：未应用则 exit 1
node scripts/patch-bridge.mjs --root /opt/qq-bridge --revert     # 用 .orig 回滚
```

脚本只改目标 `src/bridge.js`：不启动容器、不构建镜像、不联网、不碰审计副本。

再把 `config.example.json` 的 `companion` 段合并进 `config.json`，重启桥接。

## 核心约束

- **固定源**：只接受 `qq-bridge@a49877f4e58d04e47532d44b803360d0f001160d`（`0.2.1-r1`）的原始 `bridge.js`，字节级 SHA256 校验（允许仅 CRLF/LF 差异）。版本号相同但内容不同一律拒绝。
- **幂等**：已打补丁的文件要求 marker 与补丁定义一一对应（含 `expect:2` 的子调用），并用 `.orig` 复核来源；缺 `.orig` 需显式 `--accept-unverified-source`。任何未定义/缺失/重复 marker 都拒绝。
- **失败不半改**：锚点必须命中声明次数，全部补丁在内存预演通过才写一次文件；写后重读校验，失败自动用 `.orig` 回滚。
- **归属不可变**：三个发送点（`sendToQQ` / `sendBurstToQQ` / `sendMessagesV2`）都在发出前 `captureOwnership`，成功/失败回执都用该快照；服务端以 `STALE_DELIVERY` 拒绝旧归属，绝不改写为新角色。
- **接管 fail-closed**：停用集先落盘 `state/companion/takeover.json`，再 `POST /acknowledgements`。GET 失败、重启、记录消失都保持停用；只有显式 `rollback` 回执成功才恢复旧 slang / 旧群友印象。首次启用且从未接管过的 scope 行为不变。
- **原文保全**：正文不 trim / 不替换控制字符 / 不截断；超上限整条 skip 并记日志。转发段（`forward` / `node`）标 `forwarded`。
- **命令**：只交集 `ownerQQ`（桥接真实值）× `adminQQs`（插件白名单），回复兼容 `reply` / `text` 字段。

## 未解决

1. 旧群友印象数据迁移不在范围：接管只停用旧读写，历史 `social-v2.json` 需单独导入。
2. `event.time` 缺失时按 `timeQuality='unknown'` 处理，不计入有效消息门槛（保守，少量漏计）。
3. 锚点绑定 `0.2.1-r1`；桥接升级需重新核对锚点并更新 `FIXED_SOURCE`（脚本会因哈希/锚点不符拒绝，不会盲改）。
4. 持久会话复用会重新上报可信绑定；同范围重建Session使用递增版本并持久保存，发送前快照使用该Session绑定版本。首次启用不退役会话（`epoch=0` → 令牌空串）；第一次真实角色切换才退役一次。
5. 适配层只记录「角色名 → UUID」；桥接绕过 `writeRoleState` 直改 `state/current-role.json` 时不轮询，需重启才识别。
6. 桥接自带命令（`/reset` `/new` `/status` `/role*` `/silent` `/quiet` `/active` `/speak`）不转交；插件只认 `/memory|/记忆 ...`。
7. 接管门控是逐点拦截，控制台只读接口（`/api/slang`、`/api/socialV2/states`）仍显示旧数据，不影响行为。
8. 没有稳定 `selfUserId` 时不上报绑定；未绑定期间的发送结果也跳过。

## 验证记录

- 37 条补丁（含 1 条 `expect:2`）在固定源上逐条命中；`--apply` → `--check` 幂等，`--revert` 可回滚。
- 补丁产物 `node --check` 通过；`captureOwnership` 3 处、`reportDelivery` 6 处、无 live 归属上报。
- 篡改补丁文件、删除一条 marker、加入未定义 marker 均被拒绝（exit 1）。
- **未执行**：真实启动、QQ 收发、模型调用、容器操作。
