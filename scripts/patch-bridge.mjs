#!/usr/bin/env node
// dsh-qq-companion-memory · qq-bridge 接线补丁 CLI（幂等、固定源校验、锚点强校验）
//
// 它把 `integration/bridge-companion-adapter.mjs` 接到 qq-bridge 的固定锚点上：
// 入站采集（白名单后、空消息 return 前）、角色 hook、会话隔离、真实发送 ID、
// 管理员命令转交、接管门控。**只改目标 bridge.js**（首次写入时留 .orig 备份）。
//
// 安全约定（失败不半改）：
//   1. 未打过补丁的 bridge.js 必须是**固定源**：先比对 package.json 版本，再比对字节级
//      SHA256（见 FIXED_SOURCE），不一致整份拒绝——绝不盲接受任意源码；
//   2. 已打过补丁的文件走幂等检查：marker 必须与补丁定义一一对应，并用 .orig 复核原始源
//      仍是固定源（缺失 .orig 时要求显式 --accept-unverified-source）；
//   3. 每条补丁的锚点必须**恰好命中**声明次数，否则整份拒绝；
//   4. 先在内存里跑完全部补丁并做后置断言，**全部通过才写一次文件**；
//   5. 写后重读校验；任何不一致立即用 .orig 回滚。
//
// 用法：
//   node scripts/patch-bridge.mjs --bridge <qq-bridge>/src/bridge.js            # 报告（默认不写）
//   node scripts/patch-bridge.mjs --bridge ... --check                          # 同上；有未应用补丁则 exit 1
//   node scripts/patch-bridge.mjs --bridge ... --apply                          # 真正写入
//   node scripts/patch-bridge.mjs --bridge ... --revert                         # 用 .orig 回滚
//   node scripts/patch-bridge.mjs --root <qq-bridge>                            # 用目录代替 --bridge
//   node scripts/patch-bridge.mjs --bridge ... --print-hash                     # 只打印目标 SHA256
//
// 注意：本脚本不启动/停止容器、不构建镜像、不联网、不碰审计副本。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const SUPPORTED_BRIDGE_VERSIONS = ['0.2.1-r1']
const ADAPTER_REL = 'integration/bridge-companion-adapter.mjs'

// ── 固定源 ───────────────────────────────────────────────────────────────────
// 目标源被钉死在审计快照上（qq-bridge 仓库 commit a49877f4e58d04e47532d44b803360d0f001160d）。
// 补丁锚点只对这份源码逐字验证过；版本号相同但内容不同（改过一行）也必须拒绝。
//   raw        ：文件原始字节的 SHA256
//   normalized ：把 CRLF 归一为 LF 后的 SHA256（部署副本换了行尾仍可识别为同一源码）
const FIXED_SOURCE = {
  repository: 'qq-bridge',
  commit: 'a49877f4e58d04e47532d44b803360d0f001160d',
  version: '0.2.1-r1',
  raw: '04ac5ba1ea84aecbb829baabaeb32712cf3a347f17b0590cd156a918aefc3961',
  normalized: '021f2e986fa62e724ea0ccf03b627a872413032f31d48166ef6cd8a6779d1ffa'
}

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')
// 把 CRLF 归一为 LF 后再算哈希：只抹平台行尾差异，不碰任何内容字节。
const normalizeEol = (buffer) => {
  const out = Buffer.allocUnsafe(buffer.length)
  let size = 0
  for (let i = 0; i < buffer.length; i += 1) {
    const byte = buffer[i]
    if (byte === 0x0d && buffer[i + 1] === 0x0a) continue
    out[size] = byte
    size += 1
  }
  return out.subarray(0, size)
}

// ── 补丁定义 ─────────────────────────────────────────────────────────────────
// anchor：目标源码里逐字出现的行（数组，运行时按目标 EOL 拼接）
// replace：可选；省略时表示「在原锚点之后追加 insert」
// marker：应用后必然出现、原文必不出现的唯一标记（幂等判定用）

const PATCHES = [
  {
    id: 'import',
    title: '导入适配层（相对路径，零裸导入）',
    marker: '// [companion:import]',
    anchor: ["} from './sticker-lib.js';"],
    insert: [
      '// [companion:import] dsh-qq-companion-memory 薄适配层（零裸导入；未配置时是空实现）',
      "import { createCompanionAdapter } from '../integration/bridge-companion-adapter.mjs';"
    ]
  },
  {
    id: 'config',
    title: 'loadConfig 透传 companion 配置段（无该段即 null）',
    marker: '// [companion:config]',
    anchor: ["    consoleToken: file.consoleToken ?? '',"],
    insert: [
      '    // [companion:config] 只透传，不给默认值：config.json 没有 companion 段时保持 null（无行为）',
      "    companion: file.companion && typeof file.companion === 'object' && !Array.isArray(file.companion) ? file.companion : null,"
    ]
  },
  {
    id: 'instance',
    title: '模块级适配层占位（null = 全部钩子 no-op）',
    marker: '// [companion:instance]',
    anchor: ['let state = { sessions: {} };'],
    insert: [
      '// [companion:instance] 适配层实例；main() 按配置创建，null 时所有钩子 no-op',
      'let companion = null;'
    ]
  },
  {
    id: 'init',
    title: 'main() 内按配置创建适配层',
    marker: '// [companion:init]',
    anchor: [
      '  const cfg = loadConfig();',
      '  fs.mkdirSync(STATE_DIR, { recursive: true });',
      '  hardenStateDirAcl();',
      '  acquireLock();',
      '  loadState();'
    ],
    insert: [
      '  // [companion:init] token 只从 config.json / tokenFile 读，日志与错误里都会抹掉',
      '  companion = createCompanionAdapter({',
      "    config: cfg.companion && typeof cfg.companion === 'object' ? cfg.companion : {},",
      "    stateDir: path.join(STATE_DIR, 'companion'),",
      '    ownerQQ: cfg.ownerQQ,',
      '    gate: { allow: cfg.allow, deny: cfg.deny, allowAllWhenEmpty: cfg.allowAllWhenEmpty },',
      '    logger: (level, message) => log(`[companion/${level}] ${message}`)',
      '  });',
      '  // 启动同步一次角色状态：首次只登记基线，不推进 epoch（不误退役既有会话）',
      '  companion.noteRoleState(readRoleState());',
      '  // [companion:role-listener] 之后每次角色写入都同步：只有角色名真的变化才推进 epoch',
      '  roleStateListener = (nextState) => { companion?.noteRoleState(nextState); };',
      '  // [companion:takeover-sync] 异步拉一次接管状态；失败只沿用上次确认状态，不反向切换',
      '  void companion.syncTakeover().catch(() => {});'
    ]
  },
  {
    id: 'session-policy',
    title: '会话策略纳入角色令牌（切角色即隔离旧会话）',
    marker: '// [companion:session-policy]',
    anchor: [
      '  function sessionPolicy(key) {',
      "    return JSON.stringify([currentMode, modePreset(key, currentMode, cfg) ?? '', currentMode === 'closed-agent' ? cfg.ownerQQ : null]);",
      '  }'
    ],
    replace: [
      '  // [companion:session-policy] 角色令牌进 policy：角色变化 → policy 变化 → 旧会话被退役，不跨角色复用上下文',
      '  // 无活跃角色时令牌为空串，policy 与历史持久化值完全一致，不会因刚启用适配层而误退役会话。',
      '  function sessionPolicy(key) {',
      "    const roleToken = companion?.sessionToken?.() ?? '';",
      "    return JSON.stringify([currentMode, modePreset(key, currentMode, cfg) ?? '', currentMode === 'closed-agent' ? cfg.ownerQQ : null, ...(roleToken ? [roleToken] : [])]);",
      '  }'
    ]
  },
  {
    id: 'role-state-hook',
    title: '角色状态写入 hook',
    marker: '// [companion:role-state]',
    anchor: [
      'function writeRoleState(role, mode) {',
      "  atomicWriteJson(ROLE_STATE_FILE, { role: role ?? null, mode: mode ?? 'active' });",
      '}'
    ],
    replace: [
      '// [companion:role-state] 角色状态监听：main() 里注册；未注册时行为与原来完全一致',
      'let roleStateListener = null;',
      'function writeRoleState(role, mode) {',
      "  const nextRoleState = { role: role ?? null, mode: mode ?? 'active' };",
      '  atomicWriteJson(ROLE_STATE_FILE, nextRoleState);',
      "  try { roleStateListener?.(nextRoleState); } catch (error) { log('角色状态监听失败:', error?.message ?? error); }",
      '}'
    ]
  },
  {
    id: 'role-rename',
    title: '显式改名 hook：保留 characterId，禁止按内容/哈希自动合并',
    marker: '// [companion:rename]',
    anchor: [
      '          fs.renameSync(roleFilePath(from), roleFilePath(to));',
      '          const rs = readRoleState();'
    ],
    insertAfterLine: 1,
    insert: [
      '          // [companion:rename] 必须在 writeRoleState 之前：先迁移名字映射，同名才判为「同一角色改名」',
      "          const renameResult = companion?.noteRoleRenamed({ from, to });",
      "          if (renameResult && renameResult.ok === false && renameResult.reason === 'rename-conflict') {",
      '            log(`⚠️ 角色改名未同步到记忆插件：目标名已被另一个 characterId 占用（需人工处理）`);',
      '          }'
    ]
  },
  {
    id: 'role-delete',
    title: '删除角色 hook：保留历史 characterId，只解除名字映射',
    marker: '// [companion:delete]',
    anchor: ['          fs.rmSync(roleFilePath(name));'],
    insert: [
      '          // [companion:delete] 删除只解除名字映射；已采集记忆仍按原 characterId 保留',
      '          companion?.noteRoleDeleted({ name });'
    ]
  },
  {
    id: 'inbound',
    title: '可信入站采集（白名单后、空消息 return 前）',
    marker: '// [companion:inbound]',
    anchor: [
      '    const quoteTargetIsSelf = await isQuoteTargetSelf(event.message ?? [], kind, id, event.self_id);',
      '    if (!isSessionAllowedInCurrentMode(key)) return;',
      '    if (!plainContent && !quoteTargetIsSelf) return;'
    ],
    insertAfterLine: 2,
    insert: [
      '    // [companion:inbound] 白名单已过、空消息过滤之前：只引用不附文 / 纯表情也算有效可信事件',
      '    companion?.captureInbound({ kind, conversationId: id, event, plainContent, mediaList, quoteTargetIsSelf });'
    ]
  },
  {
    id: 'queue-owner-retry',
    title: '重试队列项带采集时的角色归属',
    marker: '// [companion:queue-owner-retry]',
    anchor: [
      '    const items = queued.get(key) ?? [];',
      '    if (!items.some((it) => it.promptText === promptText)) {',
      '      if (items.length >= QUEUE_MAX) {',
      '        items.shift();',
      '        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);',
      '      }',
      '      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason });'
    ],
    replace: [
      '    const items = queued.get(key) ?? [];',
      '    if (!items.some((it) => it.promptText === promptText)) {',
      '      if (items.length >= QUEUE_MAX) {',
      '        items.shift();',
      '        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);',
      '      }',
      '      // [companion:queue-owner-retry] 固定采集时的角色归属，重投前据此校验，防止切角色串投',
      "      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason, characterId: companion?.characterId ?? '' });"
    ]
  },
  {
    id: 'queue-owner-prompt',
    title: '投递队列项带采集时的角色归属',
    marker: '// [companion:queue-owner-prompt]',
    anchor: [
      '      const items = queued.get(key) ?? [];',
      '      if (items.length >= QUEUE_MAX) {',
      '        items.shift();',
      '        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);',
      '      }',
      '      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason });'
    ],
    replace: [
      '      const items = queued.get(key) ?? [];',
      '      if (items.length >= QUEUE_MAX) {',
      '        items.shift();',
      '        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);',
      '      }',
      '      // [companion:queue-owner-prompt] 同上：投递队列不因角色变化改变归属',
      "      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason, characterId: companion?.characterId ?? '' });"
    ]
  },
  {
    id: 'queue-owner-inbound',
    title: 'DSH 不可用队列带角色归属',
    marker: '// [companion:queue-owner-inbound]',
    anchor: [
      '      items.push({ promptText, media: mediaList });',
      '      queued.set(key, items);'
    ],
    replace: [
      '      // [companion:queue-owner-inbound] 固定采集时的角色归属（重启补投也不串角色）',
      "      items.push({ promptText, media: mediaList, characterId: companion?.characterId ?? '' });",
      '      queued.set(key, items);'
    ]
  },
  {
    id: 'queue-guard',
    title: '补投前校验归属：角色已变化则跳过',
    marker: '// [companion:queue-guard]',
    anchor: [
      '            if (!modeAllowed(key, kind, id, cfg, currentMode)) {',
      '              log(`补投跳过未授权会话 ${key}（当前模式 ${currentMode}）`);',
      '              continue;',
      '            }'
    ],
    insert: [
      '            // [companion:queue-guard] 归属角色已变化：跳过而不是投给另一个角色（旧队列项无该字段时按放行处理）',
      "            if (item.characterId !== undefined && String(item.characterId) !== String(companion?.characterId ?? '')) {",
      '              log(`补投跳过：消息归属角色已变化 (${key})`);',
      '              continue;',
      '            }'
    ]
  },
  {
    id: 'binding',
    title: '会话建立后上报绑定（身份只来自绑定）',
    marker: '// [companion:binding]',
    anchor: [
      '      state.sessions[key] = sessionId;',
      '      state.sessionPolicies[key] = policy;',
      '      reverse.set(sessionId, key);',
      '      saveState();'
    ],
    insert: [
      '      // [companion:binding] 身份只来自绑定：插件按此把会话挂到角色＋范围，DSH Session.id 只作绑定',
      '      if (selfUserId && companion) {',
      '        companion.reportBinding({',
      '          sessionId,',
      "          characterId: companion.characterId ?? '',",
      '          conversationKey: key,',
      '          bindingVersion: companion.bindingVersion,',
      '          botQQ: selfUserId,',
      "          provider: String(cfg.dsh?.provider ?? ''),",
      "          model: String(cfg.dsh?.model ?? '')",
      '        });',
      '      } else if (companion?.enabled) {',
      '        log(\'⚠️ 尚未取到机器人 QQ，绑定不上报：该会话的发送结果也无法归属\');',
      '      }'
    ]
  },
  {
    id: 'delivery',
    title: '实际发送结果上报（发送前捕获归属 + 真实 message_id）',
    marker: '// [companion:delivery]',
    anchor: [
      '      sendChain = sendChain',
      '        .then(async () => {',
      '          assertSendAllowed();',
      "          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);",
      '          else await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);',
      '        })',
      '        .catch((error) => {',
      '          lastSendFailed.set(key, true);',
      '          log(`QQ 发送失败 (${key}):`, error?.message ?? error);',
      '        })'
    ],
    replace: [
      '      // [companion:delivery] 归属在进入发送链**之前**固定：异步回执回来时角色可能已切换，',
      '      // 那时再读 live characterId/epoch 会把旧结果错记到新角色身上。',
      "      const deliveryOwner = companion?.captureOwnership({ sessionId: state.sessions[key] ?? '', conversationKey: key });",
      '      sendChain = sendChain',
      '        .then(async () => {',
      '          assertSendAllowed();',
      '          // [companion:delivery] 取 OneBot 回执里的真实 message_id 上报；取不到就留空，绝不编造',
      "          const sendReceipt = kind === 'private'",
      '            ? await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`)',
      '            : await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);',
      '          const deliveredId = sendReceipt?.message_id ?? sendReceipt?.data?.message_id ?? null;',
      "          companion?.reportDelivery({ ownership: deliveryOwner, success: deliveredId !== null && deliveredId !== undefined, content: escapeCqText(part), messageId: deliveredId === null || deliveredId === undefined ? '' : String(deliveredId) });",
      '        })',
      '        .catch((error) => {',
      '          lastSendFailed.set(key, true);',
      '          log(`QQ 发送失败 (${key}):`, error?.message ?? error);',
      '          // [companion:delivery-fail] 失败也必须上报：不把「没发出去」当已送达；归属仍用发出前的快照',
      "          companion?.reportDelivery({ ownership: deliveryOwner, success: false, content: escapeCqText(part), error: String(error?.message ?? error) });",
      '        })'
    ]
  },
  {
    id: 'delivery-burst',
    title: '一代分条发送的 message_id 上报',
    marker: '// [companion:delivery-burst]',
    anchor: [
      '      const isLast = i === messages.length - 1;',
      '      sendChain = sendChain',
      '        .then(async () => {',
      '          assertSendAllowed();',
      "          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);",
      '          else await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);',
      '          sent.push(msg);',
      '        })',
      '        .catch((error) => {',
      '          log(`QQ 发送失败 (${key}):`, error?.message ?? error);',
      '          // 与 sendToQQ 同样的失败记账。少了这一步，调用方 `lastSendSucceeded(key)`',
      '          // 会把「一条都没发出去」当成「我已经说过话了」：刷新 lastActiveMessageAt /',
      '          // lastAiReplyAt 并抑制后续接话，而群里什么都没收到 —— 静默丢回复。',
      '          lastSendFailed.set(key, true);',
      '        });'
    ],
    replace: [
      '      const isLast = i === messages.length - 1;',
      '      // [companion:delivery-burst] 归属在**进入发送链之前**固定：分条之间有间隔，期间可能切角色',
      "      const burstOwner = companion?.captureOwnership({ sessionId: state.sessions[key] ?? '', conversationKey: key });",
      '      sendChain = sendChain',
      '        .then(async () => {',
      '          assertSendAllowed();',
      '          // [companion:delivery-burst] 一代分条发送同样上报真实 message_id（取不到就留空）',
      "          const burstReceipt = kind === 'private'",
      '            ? await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`)',
      '            : await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);',
      '          sent.push(msg);',
      '          const burstId = burstReceipt?.message_id ?? burstReceipt?.data?.message_id ?? null;',
      "          companion?.reportDelivery({ ownership: burstOwner, success: burstId !== null && burstId !== undefined, content: escapeCqText(msg), messageId: burstId === null || burstId === undefined ? '' : String(burstId) });",
      '        })',
      '        .catch((error) => {',
      '          log(`QQ 发送失败 (${key}):`, error?.message ?? error);',
      '          // 与 sendToQQ 同样的失败记账。少了这一步，调用方 `lastSendSucceeded(key)`',
      '          // 会把「一条都没发出去」当成「我已经说过话了」：刷新 lastActiveMessageAt /',
      '          // lastAiReplyAt 并抑制后续接话，而群里什么都没收到 —— 静默丢回复。',
      '          lastSendFailed.set(key, true);',
      "          companion?.reportDelivery({ ownership: burstOwner, success: false, content: escapeCqText(msg), error: String(error?.message ?? error) });",
      '        });'
    ]
  },
  {
    id: 'delivery-v2',
    title: '二代分条发送的 message_id 上报',
    marker: '// [companion:delivery-v2]',
    anchor: [
      '      sendChain = sendChain',
      '        .then(async () => {',
      '          assertSendAllowed();',
      '          await onebotSend(kind, id, msg, useReply, useAt);',
      '          sent.push(msg);',
      '        })',
      '        .catch((error) => {',
      '          log(`QQ 发送失败 (${key}):`, error?.message ?? error);',
      '          failed.push(error);',
      '        });'
    ],
    replace: [
      '      // [companion:delivery-v2] 归属在**进入发送链之前**固定：异步回执返回时角色可能已切换',
      "      const ownerV2 = companion?.captureOwnership({ sessionId: state.sessions[key] ?? '', conversationKey: key });",
      '      sendChain = sendChain',
      '        .then(async () => {',
      '          assertSendAllowed();',
      '          const sendBody = await onebotSend(kind, id, msg, useReply, useAt);',
      '          sent.push(msg);',
      '          // [companion:delivery-v2] 真实 message_id：OneBot send_*_msg 返回 data.message_id',
      '          const deliveredId = sendBody?.message_id ?? null;',
      "          companion?.reportDelivery({ ownership: ownerV2, success: deliveredId !== null && deliveredId !== undefined && deliveredId !== '', content: escapeCqText(msg), messageId: deliveredId === null || deliveredId === undefined ? '' : String(deliveredId) });",
      '        })',
      '        .catch((error) => {',
      '          log(`QQ 发送失败 (${key}):`, error?.message ?? error);',
      '          failed.push(error);',
      "          companion?.reportDelivery({ ownership: ownerV2, success: false, content: escapeCqText(msg), error: String(error?.message ?? error) });",
      '        });'
    ]
  },
  {
    id: 'command-forward',
    title: '管理员命令转交（只认真实 ownerQQ + adminQQs）',
    marker: '// [companion:command]',
    anchor: [
      "    if (plainContent.startsWith('/')) {",
      '      if (!isOwner) {',
      "        await sendToQQ(key, '管理命令仅管理员可用。');",
      '        return;',
      '      }'
    ],
    insert: [
      '      // [companion:command] 先转交新插件；它未接管/未启用时继续走桥接原有管理命令，行为不变',
      '      // 管理员判定用「真实 ownerQQ ∩ 插件 adminQQs」：ownerQQ 取实时 cfg 值，不依赖适配层创建时的快照',
      '      if (companion?.enabled) {',
      '        const forwarded = await companion.forwardCommand({',
      '          conversationKey: key,',
      "          senderQQ: String(event.user_id ?? ''),",
      '          ownerQQ: String(cfg.ownerQQ ?? \'\'),',
      '          text: plainContent,',
      '          messageId: messageRef,',
      '          occurredAt: event.time',
      '        });',
      '        if (forwarded?.handled) {',
      '          // 服务端回复字段是 reply（历史字段 text 已由适配层兼容读取）',
      '          if (forwarded.reply) await sendToQQ(key, forwarded.reply);',
      '          return;',
      '        }',
      '      }'
    ]
  },
  {
    id: 'slang-signature',
    title: '旧黑话注入按会话范围判定（新增 key 参数）',
    marker: '// [companion:slang-signature]',
    anchor: ['  function withSlangContext(promptText) {'],
    replace: [
      '  // [companion:slang-signature] 增加会话 key：接管判定必须按范围，不能全局一刀切',
      "  function withSlangContext(promptText, key = '') {"
    ]
  },
  {
    id: 'slang-inject',
    title: '接管范围停用旧黑话注入（保留时间行）',
    marker: '// [companion:takeover-slang]',
    anchor: [
      '    if (cfg.slang?.enabled !== false) {',
      '      const block = buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 8);',
      '      if (block) parts.push(block);',
      '    }'
    ],
    replace: [
      '    // [companion:takeover-slang] 新插件接管该范围后停止旧黑话注入；时间行与其它上下文完全不变',
      '    if (cfg.slang?.enabled !== false && !companion?.isTakeoverActive(key)) {',
      '      const block = buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 8);',
      '      if (block) parts.push(block);',
      '    }'
    ]
  },
  {
    id: 'slang-call-v2',
    title: '二代投递把 key 传给注入器',
    marker: '// [companion:slang-call-v2]',
    anchor: [
      "    let content = [{ type: 'text', text: withSlangContext(promptText) }];",
      '    if (Array.isArray(opts.media) && opts.media.length > 0) {',
      '      const imageParts = await resolveMediaList(opts.media);',
      "      content = [{ type: 'text', text: withSlangContext(promptText) }, ...imageParts];"
    ],
    replace: [
      '    // [companion:slang-call-v2] 传入会话 key，接管判定按范围生效',
      "    let content = [{ type: 'text', text: withSlangContext(promptText, key) }];",
      '    if (Array.isArray(opts.media) && opts.media.length > 0) {',
      '      const imageParts = await resolveMediaList(opts.media);',
      "      content = [{ type: 'text', text: withSlangContext(promptText, key) }, ...imageParts];"
    ]
  },
  {
    id: 'slang-call-v1',
    title: '一代投递把 key 传给注入器',
    marker: '// [companion:slang-call-v1]',
    anchor: [
      "    let content = [{ type: 'text', text: withSlangContext(promptText) }];",
      '    if (Array.isArray(mediaList) && mediaList.length > 0) {',
      '      const imageParts = await resolveMediaList(mediaList);',
      "      content = [{ type: 'text', text: withSlangContext(promptText) }, ...imageParts];"
    ],
    replace: [
      '    // [companion:slang-call-v1] 传入会话 key，接管判定按范围生效',
      "    let content = [{ type: 'text', text: withSlangContext(promptText, key) }];",
      '    if (Array.isArray(mediaList) && mediaList.length > 0) {',
      '      const imageParts = await resolveMediaList(mediaList);',
      "      content = [{ type: 'text', text: withSlangContext(promptText, key) }, ...imageParts];"
    ]
  },
  {
    id: 'slang-collect',
    title: '接管范围停用旧黑话采集',
    marker: '// [companion:takeover-slang-collect]',
    anchor: [
      '  function feedSlangWindow(key, sender, plainContent) {',
      '    if (cfg.slang?.enabled === false) return;'
    ],
    insertAfterLine: 2,
    insert: [
      '    // [companion:takeover-slang-collect] 该范围已由新插件接管：停止旧采集，避免重复提炼与重复计证据',
      '    if (companion?.isTakeoverActive(key)) return;'
    ]
  },
  {
    id: 'impression-write',
    title: '群友印象写入门控（activeTopic / pendingThought 保留）',
    marker: '// [companion:takeover-impression]',
    anchor: [
      '  function appendMemoryV2(st, category, content, extra = {}) {',
      '    if (!st) return;'
    ],
    replace: [
      '  // [companion:takeover-impression] 接管后群友印象只走新插件；activeTopic / pendingThought 不受影响',
      "  function appendMemoryV2(st, category, content, extra = {}, key = '') {",
      '    if (!st) return;',
      "    if (category === 'memberImpression' && companion?.isTakeoverActive(key)) {",
      "      log('群友印象已由 dsh-qq-companion-memory 接管，忽略旧写入');",
      '      return;',
      '    }'
    ]
  },
  {
    id: 'impression-write-call',
    title: '旧写入口把 key 传入',
    marker: '// [companion:takeover-impression-call]',
    anchor: ['          appendMemoryV2(st, category, content, extra);'],
    replace: [
      '          // [companion:takeover-impression-call] 带上 key 才能按范围判定接管',
      '          appendMemoryV2(st, category, content, extra, key);'
    ]
  },
  {
    id: 'impression-read',
    title: '群友印象注入门控（保留 activeTopic / pendingThought）',
    marker: '// [companion:takeover-impression-read]',
    anchor: [
      '  function formatMemoryV2(st) {',
      "    if (!st) return '';"
    ],
    replace: [
      '  // [companion:takeover-impression-read] 增加会话 key；接管后不再向旧提示注入群友印象',
      "  function formatMemoryV2(st, key = '') {",
      "    if (!st) return '';"
    ]
  },
  {
    id: 'impression-read-filter',
    title: '群友印象读取按接管范围过滤',
    marker: '// [companion:takeover-impression-filter]',
    anchor: [
      "    const impressions = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};",
      '    const names = Object.keys(impressions);'
    ],
    replace: [
      '    // [companion:takeover-impression-filter] 接管范围不注入旧群友印象；进行中的话题与待说想法照旧',
      "    const impressions = (!companion?.isTakeoverActive(key) && st.memberImpressions && typeof st.memberImpressions === 'object') ? st.memberImpressions : {};",
      '    const names = Object.keys(impressions);'
    ]
  },
  {
    id: 'impression-read-call-prompt',
    title: 'qq_get_prompt 调用带上 key',
    marker: '// [companion:takeover-impression-call-prompt]',
    anchor: ['            memory: formatMemoryV2(st),'],
    replace: [
      '            // [companion:takeover-impression-call-prompt] 按范围判定',
      '            memory: formatMemoryV2(st, key),'
    ]
  },
  {
    id: 'impression-read-call-wake',
    title: '二代唤醒提示带上 key',
    marker: '// [companion:takeover-impression-call-wake]',
    anchor: ['    const memoryText = formatMemoryV2(st);'],
    replace: [
      '    // [companion:takeover-impression-call-wake] 按范围判定',
      '    const memoryText = formatMemoryV2(st, key);'
    ]
  },
  {
    id: 'impression-read-call-query',
    title: 'qq_memory_query 调用带上 key',
    marker: '// [companion:takeover-impression-call-query]',
    anchor: [
      "          sendJson({ ok: true, key, category, formatted: formatMemoryV2({ ...st, ...raw }), raw });"
    ],
    replace: [
      '          // [companion:takeover-impression-call-query] 按范围判定：接管后旧通道不再返回群友印象',
      '          sendJson({ ok: true, key, category, formatted: formatMemoryV2({ ...st, ...raw }, key), raw });'
    ]
  },
  {
    id: 'impression-read-call-append',
    title: 'memory-append 回显带上 key',
    marker: '// [companion:takeover-impression-call-append]',
    anchor: [
      '          sendJson({ ok: true, key, category, content, memory: formatMemoryV2(st) });'
    ],
    replace: [
      '          // [companion:takeover-impression-call-append] 话题/想法仍可写，但要按范围过滤回显',
      '          sendJson({ ok: true, key, category, content, memory: formatMemoryV2(st, key) });'
    ]
  },
  {
    id: 'impression-read-call-admin',
    title: 'memory-update / memory-remove 回显带上 key（两处同形调用）',
    marker: '// [companion:takeover-impression-call-admin]',
    expect: 2,
    anchor: [
      '          sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });'
    ],
    replace: [
      '          // [companion:takeover-impression-call-admin] 按范围过滤：接管后不再回显旧群友印象',
      '          sendJson({ ok: true, key, category, memory: formatMemoryV2(st, key) });'
    ]
  },
  {
    id: 'impression-read-call-clear',
    title: 'memory-clear 回显带上 key',
    marker: '// [companion:takeover-impression-call-clear]',
    anchor: [
      "          sendJson({ ok: true, key, category: category || 'all', memory: formatMemoryV2(st) });"
    ],
    replace: [
      '          // [companion:takeover-impression-call-clear] 按范围过滤：接管后不再回显旧群友印象',
      "          sendJson({ ok: true, key, category: category || 'all', memory: formatMemoryV2(st, key) });"
    ]
  },
  {
    id: 'impression-endpoint-update',
    title: 'memory-update 的群友印象分支门控（放在鉴权之后）',
    marker: '// [companion:takeover-impression-update]',
    anchor: [
      "          if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定原群友名字' }, 400); return; }",
      "          if (category !== 'memberImpression' && !oldContent) { sendJson({ ok: false, error: '该类别需要 oldContent 指定要编辑的记忆内容' }, 400); return; }",
      "          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }",
      "          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }",
      "          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_*' }, 403); return; }"
    ],
    insert: [
      '          // [companion:takeover-impression-update] 鉴权之后才判定接管：不向未授权调用者泄露范围状态',
      "          if (category === 'memberImpression' && companion?.isTakeoverActive(key)) { sendJson({ ok: false, error: '群友印象已由 dsh-qq-companion-memory 接管，请在新插件管理端编辑' }, 409); return; }"
    ]
  },
  {
    id: 'impression-endpoint-remove',
    title: 'memory-remove 的群友印象分支门控（放在鉴权之后）',
    marker: '// [companion:takeover-impression-remove]',
    anchor: [
      "          if (category === 'memberImpression' && ['__proto__', 'constructor', 'prototype'].includes(target)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }",
      "          if (category !== 'memberImpression' && !content) { sendJson({ ok: false, error: '该类别需要 content 指定要删除的记忆内容' }, 400); return; }",
      "          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }",
      "          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }",
      "          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_remove' }, 403); return; }"
    ],
    insert: [
      '          // [companion:takeover-impression-remove] 鉴权之后才判定接管；话题/想法仍可删',
      "          if (category === 'memberImpression' && companion?.isTakeoverActive(key)) { sendJson({ ok: false, error: '群友印象已由 dsh-qq-companion-memory 接管，请在新插件管理端删除' }, 409); return; }"
    ]
  },
  {
    id: 'impression-endpoint-clear',
    title: 'memory-clear 的群友印象分支门控（放在鉴权之后）',
    marker: '// [companion:takeover-impression-clear]',
    anchor: [
      "          if (category && !['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }",
      "          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }",
      "          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }",
      "          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_clear' }, 403); return; }"
    ],
    insert: [
      '          // [companion:takeover-impression-clear] 鉴权之后才判定接管；只拦「会清掉群友印象」的调用',
      "          if ((!category || category === 'memberImpression') && companion?.isTakeoverActive(key)) { sendJson({ ok: false, error: '群友印象已由 dsh-qq-companion-memory 接管，请在新插件管理端清理' }, 409); return; }"
    ]
  }
]

// ── CLI 工具 ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const hasFlag = (name) => args.includes(`--${name}`)
const valueOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  if (index < 0) return fallback
  const value = args[index + 1]
  return value && !value.startsWith('--') ? value : fallback
}

function fail(message) {
  console.error(`[companion-patch] ✗ ${message}`)
  process.exit(1)
}

const detectEol = (text) => (text.includes('\r\n') ? '\r\n' : '\n')
const joinLines = (lines, eol) => lines.join(eol)
const countOf = (text, needle) => {
  if (!needle) return 0
  let count = 0
  let index = text.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = text.indexOf(needle, index + needle.length)
  }
  return count
}

function resolveLayout() {
  const bridgeArg = valueOf('bridge', '')
  const rootArg = valueOf('root', '')
  let bridgePath
  let root
  if (bridgeArg) {
    bridgePath = path.resolve(bridgeArg)
    root = path.resolve(rootArg || path.dirname(path.dirname(bridgePath)))
  } else if (rootArg) {
    root = path.resolve(rootArg)
    bridgePath = path.join(root, 'src', 'bridge.js')
  } else {
    fail('请用 --bridge <qq-bridge/src/bridge.js> 或 --root <qq-bridge 目录> 指定目标（脚本不猜默认部署路径）')
  }
  if (!fs.existsSync(bridgePath)) fail(`目标 bridge.js 不存在：${bridgePath}`)
  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  } catch (error) {
    fail(`读取 ${path.join(root, 'package.json')} 失败：${error?.message ?? error}`)
  }
  if (pkg?.name !== 'qq-bridge') fail(`目标不是 qq-bridge（package.json name=${JSON.stringify(pkg?.name)}）`)
  const version = String(pkg?.version ?? '')
  if (!SUPPORTED_BRIDGE_VERSIONS.includes(version)) {
    fail(`桥接版本 ${version || '（缺失）'} 不在已验证范围 ${SUPPORTED_BRIDGE_VERSIONS.join(' / ')}；请先在 integration/README.md 核对该版本锚点`)
  }
  return { root, bridgePath, version }
}

/**
 * 固定源校验：只对**未打过补丁**的原始 bridge.js 生效。
 *
 * 版本号相同不代表内容相同——任何人改一行、换个来源，锚点都可能恰好命中而含义已变。
 * 因此原始源必须字节级等于审计快照（允许 CRLF/LF 行尾差异这一种等价）。
 * 已打过 marker 的文件不能用这里的哈希（那是补丁后内容），改由 .orig 复核。
 */
function verifyFixedSource(bridgePath, label) {
  let buffer
  try {
    buffer = fs.readFileSync(bridgePath)
  } catch (error) {
    fail(`读取${label}失败：${error?.message ?? error}`)
  }
  const rawHash = sha256(buffer)
  const normHash = sha256(normalizeEol(buffer))
  const rawOk = rawHash === FIXED_SOURCE.raw
  const normOk = normHash === FIXED_SOURCE.normalized
  if (!rawOk && !normOk) {
    fail([
      `${label}不是固定源：拒绝在未知源码上打补丁。`,
      `  期望 SHA256 ${FIXED_SOURCE.raw}（${FIXED_SOURCE.repository}@${FIXED_SOURCE.commit.slice(0, 12)} / ${FIXED_SOURCE.version}）`,
      `  实际 SHA256 ${rawHash}`,
      `  若确实要接入新版本，先人工核对全部锚点并更新 FIXED_SOURCE（不要盲接受）。`
    ].join('\n'))
  }
  return { rawHash, normHash, exact: rawOk }
}

/** 在内存里按顺序应用全部补丁；返回计划与冲突清单（不写任何文件）。 */
function planPatches(source) {
  const eol = detectEol(source)
  let working = source
  const applied = []
  const already = []
  const problems = []

  for (const patch of PATCHES) {
    if (working.includes(patch.marker)) {
      already.push(patch.id)
      continue
    }
    const anchor = joinLines(patch.anchor, eol)
    const expected = Number.isSafeInteger(patch.expect) ? patch.expect : 1
    const hits = countOf(working, anchor)
    if (hits === 0) {
      problems.push({ id: patch.id, title: patch.title, reason: '锚点未命中（源码版本/内容与预期不符，拒绝盲改）' })
      continue
    }
    if (hits !== expected) {
      problems.push({ id: patch.id, title: patch.title, reason: `锚点命中 ${hits} 次（要求 ${expected} 次，拒绝猜测位置）` })
      continue
    }
    let replacement
    if (Array.isArray(patch.replace)) {
      replacement = joinLines(patch.replace, eol)
    } else {
      const at = Number.isSafeInteger(patch.insertAfterLine) ? patch.insertAfterLine : patch.anchor.length
      const head = patch.anchor.slice(0, at)
      const tail = patch.anchor.slice(at)
      replacement = joinLines([...head, ...patch.insert, ...tail], eol)
    }
    // 用函数形式替换：避免替换串里的 $& / $` 等被当成特殊模式；multi=true 处理多命中。
    const next = expected === 1
      ? working.replace(anchor, () => replacement)
      : working.split(anchor).join(replacement)
    if (!next.includes(patch.marker)) {
      problems.push({ id: patch.id, title: patch.title, reason: '应用后未出现预期标记（补丁定义有误）' })
      continue
    }
    working = next
    applied.push(patch.id)
  }

  const missingMarkers = PATCHES.filter((p) => !working.includes(p.marker)).map((p) => p.id)
  if (missingMarkers.length) {
    problems.push({ id: '*', title: '全局', reason: `最终文本缺少标记：${missingMarkers.join(', ')}` })
  }
  return { eol, working, applied, already, problems, changed: working !== source }
}

function verifyStructure(text) {
  const issues = []
  if (!text.includes("from '../integration/bridge-companion-adapter.mjs'")) issues.push('缺少适配层 import')
  const hooks = countOf(text, 'companion?.')
  if (hooks < 12) issues.push(`companion 钩子过少（${hooks}），疑似补丁未生效`)
  if (!text.includes('let companion = null;')) issues.push('缺少模块级 companion 变量')
  // 归属纪律：每个发送点都必须先 captureOwnership 再 reportDelivery，且 reportDelivery 不得再读 live 归属。
  const ownerCaptures = countOf(text, 'captureOwnership(')
  const deliveries = countOf(text, 'reportDelivery(')
  if (ownerCaptures < 3) issues.push(`captureOwnership 调用过少（${ownerCaptures}，期望 3 处发送点各自捕获）`)
  if (deliveries < 6) issues.push(`reportDelivery 调用过少（${deliveries}，期望成功/失败各一条 × 3 处）`)
  const liveOwnership = countOf(text, 'reviewDelivery')
  if (liveOwnership) issues.push('出现未知的 reviewDelivery 调用')
  return issues
}

/**
 * 幂等检查：文件里出现的 companion 标记必须**恰好**是补丁定义产生的那一批。
 *
 * 盲判「含 marker 就跳过」会让半应用/被篡改的文件继续通过。这里区分两类标记：
 *   - 主标记（patch.marker）：每个补丁的应用证据，出现次数必须等于该补丁的 expect；
 *   - 子标记：补丁 insert/replace 文本里自带的 `// [companion:xxx]` 注释（如 delivery-fail），
 *     只要求它是某个补丁自己写出来的，且不能凭空多出次数。
 * 任何不在定义里的标记、或主标记次数不符，都整份拒绝。
 */
function verifyExistingMarkers(text) {
  const issues = []
  const markerRe = /\/\/ \[companion:([^\]]+)\]/g
  const collect = (value) => {
    const found = []
    const lines = Array.isArray(value) ? value : []
    for (const line of lines) {
      markerRe.lastIndex = 0
      let m
      while ((m = markerRe.exec(String(line))) !== null) found.push(`// [companion:${m[1]}]`)
    }
    return found
  }

  const expectedCount = new Map()
  const secondary = new Set()
  for (const patch of PATCHES) {
    const own = [...collect(patch.replace), ...collect(patch.insert)]
    const expect = Number.isSafeInteger(patch.expect) ? patch.expect : 1
    // 主标记总次数 = 单次替换写入次数 × 锚点命中次数（expect）。
    // 例：delivery 成功/失败各带一次 marker → 2×1；call-admin 一次替换、锚点命中 2 次 → 1×2。
    const ownCount = Math.max(1, own.filter((marker) => marker === patch.marker).length)
    expectedCount.set(patch.marker, ownCount * expect)
    for (const marker of own) {
      if (marker !== patch.marker) secondary.add(marker)
    }
  }

  const seen = new Map()
  markerRe.lastIndex = 0
  let match
  while ((match = markerRe.exec(text)) !== null) {
    const marker = `// [companion:${match[1]}]`
    seen.set(marker, (seen.get(marker) ?? 0) + 1)
  }

  for (const [marker, count] of seen) {
    if (expectedCount.has(marker)) {
      const want = expectedCount.get(marker)
      if (count !== want) issues.push(`主标记 ${marker} 出现 ${count} 次（要求 ${want} 次）：疑似重复/缺失应用`)
      continue
    }
    if (secondary.has(marker)) {
      if (count !== 1) issues.push(`子标记 ${marker} 出现 ${count} 次（要求 1 次）：疑似重复应用`)
      continue
    }
    issues.push(`出现未定义标记 ${marker}（${count} 次）：源码被手工改过，拒绝继续`)
  }

  const missing = [...expectedCount.keys()].filter((marker) => !seen.has(marker))
  if (missing.length) {
    issues.push(`缺少标记 ${missing.join(', ')}：文件处于半应用状态，拒绝继续（请用 --revert 回到 .orig 后重跑）`)
  }
  return issues
}

/** 用 .orig 复核：备份必须仍是固定源，才能证明待补丁文件是它的确定性产物。 */
function verifyBackupOrigin(bridgePath) {
  const backup = `${bridgePath}.orig`
  if (!fs.existsSync(backup)) {
    if (!hasFlag('accept-unverified-source')) {
      fail([
        `目标已含 companion 标记，但没有 ${path.basename(backup)} 原始备份，无法证明它来自固定源。`,
        `  如确认该文件就是本脚本的产物，显式加 --accept-unverified-source 重跑；否则请人工核对。`
      ].join('\n'))
    }
    console.log('[companion-patch] ⚠️ 已跳过固定源复核（--accept-unverified-source）')
    return null
  }
  return verifyFixedSource(backup, `原始备份 ${path.basename(backup)} `)
}

function writeAtomic(file, content) {
  const tmp = `${file}.companion-tmp-${process.pid}`
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, file)
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

function main() {
  const { root, bridgePath, version } = resolveLayout()
  const adapterPath = path.join(root, ADAPTER_REL)
  if (!fs.existsSync(adapterPath)) {
    fail(`适配层文件缺失：${adapterPath}（先把 integration/bridge-companion-adapter.mjs 放进部署目录）`)
  }

  if (hasFlag('print-hash')) {
    const buffer = fs.readFileSync(bridgePath)
    console.log(`[companion-patch] raw SHA256        : ${sha256(buffer)}`)
    console.log(`[companion-patch] normalized SHA256 : ${sha256(normalizeEol(buffer))}（CRLF→LF）`)
    console.log(`[companion-patch] 固定源期望         : ${FIXED_SOURCE.raw}（${FIXED_SOURCE.repository}@${FIXED_SOURCE.commit.slice(0, 12)}）`)
    return
  }

  if (hasFlag('revert')) {
    const backup = `${bridgePath}.orig`
    if (!fs.existsSync(backup)) fail(`没有 ${backup} 备份，无法回滚`)
    verifyFixedSource(backup, `备份 ${path.basename(backup)} `)
    const current = fs.readFileSync(bridgePath, 'utf8')
    if (!PATCHES.some((p) => current.includes(p.marker))) {
      fail('当前文件不含 companion 标记，疑似已回滚；如需强制覆盖请人工处理')
    }
    fs.copyFileSync(bridgePath, `${bridgePath}.companion-before-revert`)
    writeAtomic(bridgePath, fs.readFileSync(backup, 'utf8'))
    console.log(`[companion-patch] ✓ 已用 ${path.basename(backup)} 回滚 ${bridgePath}`)
    console.log(`[companion-patch]   回滚前的版本留在 ${path.basename(bridgePath)}.companion-before-revert`)
    return
  }

  const source = fs.readFileSync(bridgePath, 'utf8')
  const hasAnyMarker = PATCHES.some((p) => source.includes(p.marker))
  let sourceCheck
  if (hasAnyMarker) {
    // 已应用（或半应用）的文件：哈希必然不是固定源，改用 .orig 复核来源 + 标记一一对应。
    const markerIssues = verifyExistingMarkers(source)
    if (markerIssues.length) {
      for (const issue of markerIssues) console.error(`[companion-patch] ✗ ${issue}`)
      console.error('[companion-patch] 幂等检查失败，未写入任何文件')
      process.exit(1)
    }
    sourceCheck = verifyBackupOrigin(bridgePath)
  } else {
    sourceCheck = verifyFixedSource(bridgePath, '目标 bridge.js ')
  }

  const plan = planPatches(source)

  console.log(`[companion-patch] 目标：${bridgePath}`)
  console.log(`[companion-patch] 桥接版本：${version}（已验证 ${SUPPORTED_BRIDGE_VERSIONS.join(' / ')}）`)
  if (sourceCheck) {
    console.log(`[companion-patch] 固定源：✓ ${sourceCheck.exact ? 'raw 字节一致' : 'LF 归一后一致（仅行尾差异）'}`)
  }
  console.log(`[companion-patch] 补丁 ${PATCHES.length} 条：已应用 ${plan.already.length}，待应用 ${plan.applied.length}`)

  if (plan.problems.length) {
    for (const p of plan.problems) console.error(`[companion-patch] ✗ ${p.id} ${p.title}：${p.reason}`)
    console.error('[companion-patch] 存在冲突，未写入任何文件（源码保持原样）')
    process.exit(1)
  }

  const structural = verifyStructure(plan.working)
  if (structural.length) {
    for (const issue of structural) console.error(`[companion-patch] ✗ ${issue}`)
    console.error('[companion-patch] 结构校验失败，未写入任何文件')
    process.exit(1)
  }

  if (!plan.changed) {
    console.log('[companion-patch] ✓ 幂等：全部补丁已在位，无需改动')
    return
  }

  if (hasFlag('check')) {
    console.log('[companion-patch] --check：仍有未应用补丁')
    for (const id of plan.applied) console.log(`[companion-patch]   + ${id}`)
    process.exit(1)
  }

  if (!hasFlag('apply')) {
    console.log('[companion-patch] 报告模式（未写入）。确认无误后加 --apply；写入前会自动保留 .orig 备份')
    for (const id of plan.applied) console.log(`[companion-patch]   + ${id}`)
    return
  }

  const backup = `${bridgePath}.orig`
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(bridgePath, backup)
    console.log(`[companion-patch] 已保留原始备份：${path.basename(backup)}`)
  } else {
    console.log(`[companion-patch] 已存在原始备份 ${path.basename(backup)}（保留不动）`)
  }

  writeAtomic(bridgePath, plan.working)

  const after = fs.readFileSync(bridgePath, 'utf8')
  const missing = PATCHES.filter((p) => !after.includes(p.marker)).map((p) => p.id)
  const postIssues = [
    ...(missing.length ? [`写入后缺少标记：${missing.join(', ')}`] : []),
    ...verifyStructure(after)
  ]
  if (postIssues.length) {
    fs.copyFileSync(backup, bridgePath)
    for (const issue of postIssues) console.error(`[companion-patch] ✗ ${issue}`)
    console.error('[companion-patch] 写入校验失败，已用 .orig 回滚')
    process.exit(1)
  }

  console.log('[companion-patch] ✓ 写入完成：')
  for (const id of plan.applied) console.log(`[companion-patch]   + ${id}`)
  console.log('[companion-patch] 下一步：给 config.json 加 companion 段（见 integration/config.example.json），再重启 QQ 专用实例的桥接')
}

main()
