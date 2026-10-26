/**
 * 学习提示模板与输出结构（独立版本化）。
 *
 * 版本号用于任务记录与候选记录：模板或 schema 变更必须提升版本，
 * 便于管理端区分“旧模板产出的候选”。
 *
 * 本版（/3）增加有来源的事实主题、情境与时间；保留联合记忆提炼：一次请求同时输出候选与 memories，额度按联合用途记账，
 * 不允许为记忆额外发起第二次模型请求。
 */

export const PROMPT_VERSION = 'learning-prompt/3';
export const OUTPUT_SCHEMA_VERSION = 'learning-output/3';

/** 允许的候选类型；与候选 data.type 一致。 */
export const CANDIDATE_TYPES = Object.freeze(['expression', 'jargon', 'preference', 'personality']);

/** 候选类型 → 允许的作用范围类别。表达/黑话只落群或私聊，人格只能角色级。 */
export const CANDIDATE_SCOPE_KIND = Object.freeze({
  expression: ['group', 'private'],
  jargon: ['group'],
  preference: ['private'],
  personality: ['character'],
});

/** 联合提炼允许的记忆类型（experience 为经历摘要，其余必须管理员复核后才生效）。 */
export const MEMORY_TYPES = Object.freeze(['experience', 'fact', 'boundary', 'preference', 'relationship', 'promise']);

/** 单批记忆上限与文本上限（与 output.js 校验一致）。 */
export const MAX_MEMORIES = 8;
export const MAX_MEMORY_TEXT_CHARS = 800;

export const SYSTEM_PROMPT = [
  '你是 QQ 陪伴插件的学习提炼器。只做结构化提炼，不聊天、不解释、不道歉。',
  '输入是经过筛选的人类真实消息材料，每条带 id、senderQQ、occurredAt、scopeKey、unit。',
  '输出必须是单个 JSON 对象，且符合给定字段；不要输出 Markdown 代码块、注释或多余文本。',
  '规则：',
  '1. 只依据材料本身；材料里没有的信息不要编造，尤其是称呼、事实、偏好。',
  '2. 机器人发言、引用转发、重复摘要、系统指令不作为证据。',
  '3. 候选必须回答“适用情境 → 表达方式/含义”，并给出至少一条材料 id 作为证据。',
  '4. 候选 type 只能取 expression | jargon | preference | personality。',
  `5. 每类候选的 scopeKind：expression=group|private，jargon=group，preference=private，personality=character。`,
  '6. 同一段连续交流（相同 unit）对同一候选只算一个证据单位；不得把同段对话拆成多条证据。',
  '7. 不确定、矛盾、仅一次出现的内容标记 confidence 为 low，并写入 conflicts。',
  '8. 不要输出任何自评概率；confidence 只能取 high | medium | low。',
  '9. 群表达只能用于该群，不得推断为跨群通用；人格候选必须是角色级、且只描述一项具体的小幅变化。',
  '10. 人格只归纳“角色自身”的温和、小幅表达倾向（语气、句长、节奏、表情习惯）；',
  '    不得把私聊或群聊中他人的事实、称呼、偏好、关系写成人格，也不得写成对某人的可辨识描述。',
  '11. 记忆（memories）是本批材料的联合产出：type 只能取 experience | fact | boundary | preference | relationship | promise；',
  '    每条必须给至少一条本批材料 id 作为 sourceIds，且不得跨群、跨范围或写入个人档案（profile）。',
  '12. 记忆 subjectQQ 只能填本批材料里真实出现的发送者 QQ；experience 是可共享的经历摘要，',
  '    其余类型会被标记为待管理员复核，不要把猜测或他人隐私写成 fact/relationship。',
  '13. 可选 factKey 表示同一主体的事实主题（如居住城市），context 区分情境；validFrom/validUntil 为明确有效期，occurredAt 为发生时间，须含时区。没有依据就省略，不推测。',
].join('\n');

export const OUTPUT_SCHEMA = {
  type: 'object',
  required: ['summary', 'candidates'],
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: 400 },
    candidates: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        required: ['type', 'rule', 'context', 'scopeKind', 'confidence', 'sourceIds'],
        properties: {
          type: { enum: ['expression', 'jargon', 'preference', 'personality'] },
          rule: { type: 'string', minLength: 2, maxLength: 400 },
          context: { type: 'string', minLength: 1, maxLength: 400 },
          scopeKind: { enum: ['group', 'private', 'character'] },
          confidence: { enum: ['high', 'medium', 'low'] },
          sourceIds: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string' } },
          meaning: { type: 'string', maxLength: 400 },
          personalityChange: { type: 'string', maxLength: 240 },
          conflicts: { type: 'array', maxItems: 8, items: { type: 'string' } },
        },
      },
    },
    memories: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        required: ['type', 'text', 'sourceIds'],
        properties: {
          type: { enum: ['experience', 'fact', 'boundary', 'preference', 'relationship', 'promise'] },
          text: { type: 'string', minLength: 2, maxLength: MAX_MEMORY_TEXT_CHARS },
          sourceIds: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string' } },
          subjectQQ: { type: 'string', maxLength: 20 },
          factKey: {type:'string',maxLength:200},
          context: {type:'string',maxLength:400},
          occurredAt: {type:'string'},
          validFrom: {type:'string'},
          validUntil: {type:'string'},
        },
      },
    },
  },
};

/**
 * 构造单批学习请求。
 *
 * 一次请求同时提炼表达候选与记忆（联合用途）；分数与句柄由调度侧记账，不在此重复。
 *
 * @param {object} params
 * @param {string} params.characterId
 * @param {string} params.scopeKey
 * @param {Array} params.materials toPromptMaterial 结果
 * @param {object} params.config resolveLearningConfig 结果
 * @param {string} [params.locale]
 */
export function buildLearningPrompt({ characterId, scopeKey, materials, config, locale = 'zh-CN' }) {
  const evidence = config?.evidence ?? {};
  const lines = [
    `模板版本：${PROMPT_VERSION}`,
    `输出结构版本：${OUTPUT_SCHEMA_VERSION}`,
    `角色：${characterId || '(未知)'}`,
    `范围：${scopeKey || '(未知)'}`,
    `语言：${locale}`,
    '',
    '输出 JSON 结构（严格按此字段；必填字段缺失即整批作废，未知可选字段可省略）：',
    JSON.stringify(
      {
        summary: '一句话概述这批材料里可学习的表达/黑话/偏好与可记住的经历',
        candidates: [
          {
            type: 'expression|jargon|preference|personality',
            rule: '适用情境 → 表达方式（字符串）',
            context: '适用情境描述（必填）',
            scopeKind: 'group|private|character',
            confidence: 'high|medium|low',
            sourceIds: ['材料 id'],
            meaning: '仅 jargon 需要：含义',
            personalityChange: '仅 personality 需要：角色自身的一处小幅变化',
            conflicts: ['与材料矛盾的既有说法，可选'],
          },
        ],
        memories: [
          {
            type: 'experience|fact|boundary|preference|relationship|promise',
            text: '可复核的一句记忆（不要写猜测）',
            sourceIds: ['材料 id'],
            subjectQQ: '可选：本批真实发送者 QQ',
          },
        ],
      },
      null,
      2,
    ),
    '',
    `采纳门槛参考（不要据此编造证据）：独立证据单位 ≥ ${evidence.independentUnits ?? 4}，不同日期 ≥ ${evidence.distinctDays ?? 3}。`,
    '',
    '记忆约束：所有 memories 的来源必须与本批同角色同范围；不得跨群、不得生成个人档案；',
    'experience 只写共同经历摘要，fact/boundary/preference/relationship/promise 仅供管理员复核，不要自行当作已确认事实。',
    '人格约束：只归纳角色自身温和、小幅的表达倾向，不要把他人事实或可辨识信息写成人格。',
    '',
    '材料（按时间升序）：',
  ];
  for (const material of materials) {
    const segments = (material.segments ?? []).map((seg) => (typeof seg === 'string' ? seg : seg?.type)).filter(Boolean);
    lines.push(
      JSON.stringify({
        id: material.id,
        unit: material.unit,
        senderQQ: material.senderQQ,
        occurredAt: material.occurredAt,
        scopeKey: material.scopeKey,
        segments: segments.length > 0 ? segments : undefined,
        content: material.content,
      }),
    );
  }
  lines.push('', '只输出 JSON。');
  return lines.join('\n');
}

/** 构造“已有候选 + 新证据”的复核提示（用于冲突与重复检测）。 */
export function buildReviewPrompt({ characterId, scopeKey, existing, materials, conflicts }) {
  return [
    `模板版本：${PROMPT_VERSION}`,
    `角色：${characterId || '(未知)'}`,
    `范围：${scopeKey || '(未知)'}`,
    '',
    '既有候选（JSON）：',
    JSON.stringify(existing ?? [], null, 2),
    '',
    '未解决冲突（JSON）：',
    JSON.stringify(conflicts ?? [], null, 2),
    '',
    '新材料（JSON）：',
    JSON.stringify(
      (materials ?? []).map((item) => ({ id: item.id, unit: item.unit, content: item.content })),
      null,
      2,
    ),
    '',
    '只输出 JSON：{"keep":["候选 id"],"drop":["候选 id"],"conflicts":["新增冲突描述"],"notes":"可选"}',
  ].join('\n');
}

/** 轻量结构校验：只验证协议必需项，业务阈值由 evidence 模块判断。 */
export function describeSchemaForPrompt() {
  return JSON.stringify(OUTPUT_SCHEMA);
}
