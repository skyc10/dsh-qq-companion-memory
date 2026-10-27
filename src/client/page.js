/*
 * QQ 陪伴记忆 · 管理页面脚本。
 *
 * 独立文档，原生 DOM，不引入第三方依赖（不裸导入 schemastery / react）。
 * 所有数据都来自服务端真实接口（相对页面目录，兼容 DSH 子路径部署）：
 *   GET  ./status
 *   POST ./query   {kind, characterId?, scopeKey?, subjectQQ?, status?, search?, limit?, after?}
 *   POST ./mutate  {action, payload}
 * 信封约定 {ok:true,value} / {ok:false,error:{code,message,details}}。
 *
 * 页面不伪造记录、不伪造分页、不预留假的功能位：拿不到数据就显示真实错误，
 * 并明确区分「未配置 / 已停用 / 失败 / 未知」。
 */

/**
 * 接口基址。管理页固定挂在 `.../v1/page`，接口是同一路由族下的 /status、
 * /query、/mutate，因此按当前地址退掉最后一段（page 或 page/）再拼，
 * 兼容 DSH 部署在子路径（例如 /dsh/）的情况。取不到时退回文档相对地址。
 */
function resolveApiBase() {
  try {
    const url = new URL(window.location.href);
    let path = url.pathname.replace(/\/+$/, '');
    if (path.endsWith('/page')) path = path.slice(0, -'/page'.length);
    if (path === '' || !path.endsWith('/v1')) {
      // 结构不符时不猜测，交给文档相对地址（服务端按同族路由解析）。
      return './';
    }
    return path + '/';
  } catch {
    return './';
  }
}

const API_BASE = resolveApiBase();

const KIND_LABELS = {
  character: '角色',
  binding: '会话绑定',
  event: '原文事件',
  memory: '记忆',
  profile: '个人档案',
  supplement: '群内补充',
  share: '共享引用',
  candidate: '候选',
  evidence: '证据',
  conflict: '冲突',
  feedback: '反馈',
  trial: '试用',
  application: '实际应用',
  personality: '人格版本',
  task: '任务',
  usage: '用量',
  recall: '召回记录',
  backup: '备份',
  takeover: '接管',
  import: '导入',
  control: '管理命令',
  audit: '审计',
};

const STATUS_LABELS = {
  active: '生效',
  enabled: '启用',
  disabled: '已停用',
  deleted: '已删除',
  pending: '待确认',
  'active,pending': '生效或待确认',
  trial: '试用中',
  adopted: '已采纳',
  accepted: '已采纳',
  rejected: '已驳回',
  paused: '已暂停',
  frozen: '已冻结',
  conflict: '冲突',
  resolved: '已解决',
  applied: '已应用',
  verified: '已核验',
  unverified: '待核验',
  quarantine: '隔离待确认',
  void: '已作废',
  passed: '已通过',
  cancelled: '已取消',
  superseded: '已被取代',
  expired: '已过期',
  stale: '待重新同步',
  prepared: '已准备',
  'rollback-pending': '待回退',
  failed: '失败',
  ready: '就绪',
  running: '运行中',
};

const FIELD_LABELS = {
  text: '正文',
  summary: '摘要',
  content: '内容',
  statement: '陈述',
  note: '说明',
  notes: '说明',
  importance: '重要性',
  importanceSource: '重要性来源（manual人工 / model模型 / type-default类型默认）',
  visibility: '可见性（public-profile跨群认识 / private私有）',
  originScope: '原始来源范围',
  legacySessionId: '旧会话文件名线索',
  legacyObsolete: '旧材料已失效',
  occurredAt: '发生时间',
  createdAt: '记录时间',
  sourceIds: '来源关联',
  sourceId: '源记录',
  rule: '规则',
  context: '适用情境',
  type: '类型',
  evidenceIds: '证据',
  feedbackIds: '反馈',
  trialStartedAt: '试用开始',
  acceptedAt: '采纳时间',
  frozenEvidenceIds: '冻结证据',
  parentId: '父版本',
  changes: '变更',
  snapshot: '快照',
  sourceCandidateIds: '来源候选',
  selected: '入选',
  omitted: '省略',
  budget: '预算',
  identity: '身份',
  targetScope: '目标范围',
  target: '目标',
  fields: '共享字段',
  reason: '原因',
  sentiment: '反馈类型',
  targetId: '反馈目标',
  targetIds: '反馈目标',
  applicationId: '实际发送记录',
  sourceMessageId: '来源消息',
  verification: '核验状态',
  excerpt: '核验片段',
  candidateId: '候选',
  candidateIds: '关联候选',
  actualMatchIds: '实际命中候选',
  successful: '发送成功',
  messageId: '消息 ID',
  sentAt: '发送时间',
  verified: '已核验',
  verifiedBy: '核验人',
  verifiedAt: '核验时间',
  resolution: '解决方式',
  resolvedBy: '解决人',
  resolvedAt: '解决时间',
  operation: '操作',
  desiredOwner: '目标归属',
  acknowledged: '桥接已确认',
  acknowledgedAt: '确认时间',
  bridgeVersion: '桥接版本',
  expectedBridgeVersion: '预期桥接版本',
  legacyDisabled: '旧能力已停',
  legacySource: '旧数据来源',
  legacyId: '旧数据 ID',
  importHash: '导入指纹',
  importedAt: '导入时间',
  quarantined: '隔离数量',
  ids: '记录 ID',
  confirmationToken: '确认令牌',
  sha256: 'SHA-256',
  schemaVersion: '库版本',
  current: '当前库',
  currentGeneration: '当前代数',
  expiresInSeconds: '有效期（秒）',
  restored: '已恢复',
  requiresRestart: '需要重启',
  safetyBackupName: '安全备份',
  pauseReason: '暂停原因',
  mappedBy: '分配人',
  mappedAt: '分配时间',
  invalidatedBy: '失效来源',
  invalidationReason: '失效原因',
  sourceVersion: '来源版本',
  uncertain: '待确认',
  unverified: '未核验',
  inputTokens: '输入 token',
  outputTokens: '输出 token',
  totalTokens: '合计 token',
  injectedTokens: '注入 token',
  requests: '请求数',
  cachedTokens: '缓存 token',
  provider: 'provider',
  model: 'model',
  day: '日期',
  scope: '范围',
  characterId: '角色',
  scopeKey: '范围',
  subjectQQ: '主体 QQ',
  name: '名称',
  labels: '称呼',
  impression: '印象',
  members: '成员',
  lastSeenAt: '最近出现',
};

const FILTER_STATUSES = ['', 'active', 'disabled', 'deleted', 'pending', 'active,pending', 'trial', 'accepted', 'adopted', 'rejected', 'paused', 'quarantine', 'verified', 'resolved', 'superseded', 'expired', 'failed'];

/**
 * 服务端真实枚举（取自 src/application/management.js 与 operations.js）。
 * 界面只提供这些取值，不臆造 decision / note / mode 之类不存在的字段。
 */
const ENUMS = {
  candidateOperation: [
    ['evaluate', '评估（交由学习引擎核算 S1–S6）'],
    ['pause', '暂停'],
    ['reject', '驳回'],
    ['resume','恢复收集（旧冻结证据不复用）'],
  ],
  resolution: [
    ['retain', '保留原有'],
    ['replace', '替换为新值'],
    ['separate', '区分情境并存'],
    ['dismiss', '驳回该冲突'],
  ],
  sentiment: [
    ['positive', '正面'],
    ['negative', '负面'],
    ['correction', '纠正'],
  ],
  takeoverOperation: [
    ['prepare', '准备（旧能力保持开启）'],
    ['activate', '激活（等待桥接确认）'],
    ['rollback', '回退接管'],
  ],
  shareFields: ['text', 'summary', 'rule', 'content'],
};

const state = {
  view: 'overview',
  tab: '',
  filter: { characterId: '', scopeKey: '', subjectQQ: '', status: '', search: '', limit: 50 },
  characters: [],
  status: { phase: 'idle', value: null, error: null, summary: null },
};

let currentView = null;
let drawerReturnFocus = null;

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textOf(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function clip(value, max) {
  const text = textOf(value);
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

function pickText(data, keys) {
  if (!isPlainObject(data)) return null;
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (typeof value === 'number') return String(value);
  }
  return null;
}

function formatTime(value) {
  if (typeof value !== 'string' || value.trim() === '') return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'medium' }).format(date);
  } catch {
    return value;
  }
}

function dayKey(value) {
  if (typeof value !== 'string' || value.trim() === '') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function newRequestId() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  } catch {
    /* 回退到手工拼接 */
  }
  return 'req-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function stableStringify(value) {
  try {
    return JSON.stringify(value, (key, inner) => {
      if (isPlainObject(inner)) {
        const sorted = {};
        for (const name of Object.keys(inner).sort()) sorted[name] = inner[name];
        return sorted;
      }
      return inner;
    });
  } catch {
    return String(value);
  }
}

function numOrDash(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '未记录';
}

function statusChip(status) {
  const raw = typeof status === 'string' && status !== '' ? status : '';
  const label = STATUS_LABELS[raw] || raw || '未知';
  let tone = '';
  if (raw === 'active' || raw === 'enabled' || raw === 'accepted' || raw === 'adopted' || raw === 'applied' || raw === 'verified' || raw === 'ready' || raw === 'resolved' || raw === 'passed') tone = 'is-ok';
  else if (raw === 'disabled' || raw === 'rejected' || raw === 'deleted' || raw === 'frozen' || raw === 'expired' || raw === 'superseded' || raw === 'void' || raw === 'cancelled') tone = 'is-off';
  else if (raw === 'pending' || raw === 'trial' || raw === 'paused' || raw === 'unverified' || raw === 'quarantine' || raw === 'prepared' || raw === 'rollback-pending' || raw === 'stale') tone = 'is-pending';
  else if (raw === 'conflict' || raw === 'failed') tone = 'is-warn';
  else if (raw === '') tone = 'is-unknown';
  return el('span', {
    class: 'chip ' + tone,
    text: label,
    title: raw === '' ? '记录未给出 status' : 'status=' + raw,
  });
}

function chipList(values, max) {
  const wrap = el('div', { class: 'chips' });
  const list = Array.isArray(values) ? values : values === undefined || values === null ? [] : [values];
  const limit = typeof max === 'number' ? max : 12;
  for (const item of list.slice(0, limit)) {
    const text = isPlainObject(item) ? clip(JSON.stringify(item), 60) : clip(item, 80);
    if (text === '') continue;
    wrap.append(el('span', { class: 'chip', text }));
  }
  if (list.length > limit) wrap.append(el('span', { class: 'chip is-off', text: `另有 ${list.length - limit} 项` }));
  if (wrap.children.length === 0) wrap.append(el('span', { class: 'muted small', text: '无' }));
  return wrap;
}

/* ------------------------------------------------------------------ */
/* DOM 构造                                                            */
/* ------------------------------------------------------------------ */

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  applyProps(node, props);
  append(node, children);
  return node;
}

function applyProps(node, props) {
  if (!props) return;
  for (const key of Object.keys(props)) {
    const value = props[key];
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class' || key === 'className') {
      node.className = String(value);
      continue;
    }
    if (key === 'text') {
      node.textContent = String(value);
      continue;
    }
    if (key === 'dataset') {
      for (const name of Object.keys(value)) node.dataset[name] = String(value[name]);
      continue;
    }
    if (key === 'style' && isPlainObject(value)) {
      for (const name of Object.keys(value)) node.style[name] = value[name];
      continue;
    }
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
      continue;
    }
    if (key === 'value') {
      node.value = value === null ? '' : String(value);
      continue;
    }
    if (key === 'checked' || key === 'disabled' || key === 'hidden' || key === 'selected' || key === 'readOnly' || key === 'open') {
      if (value === true) node[key] = true;
      continue;
    }
    node.setAttribute(key, String(value));
  }
}

function append(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      append(node, child);
      continue;
    }
    if (child instanceof Node) {
      node.append(child);
      continue;
    }
    node.append(document.createTextNode(String(child)));
  }
}

function toast(message, tone) {
  const host = $('toasts');
  if (!host) return;
  const box = el('div', { class: 'toast ' + (tone ? 'is-' + tone : ''), text: message });
  host.append(box);
  setTimeout(() => box.remove(), 5200);
}

function showBanner(title, message, detail) {
  const box = $('banner');
  const details = $('bannerDetails');
  $('bannerTitle').textContent = title;
  $('bannerText').textContent = message;
  if (detail) {
    $('bannerPre').textContent = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2);
    details.hidden = false;
  } else {
    $('bannerPre').textContent = '';
    details.hidden = true;
  }
  box.hidden = false;
}

function hideBanner() {
  $('banner').hidden = true;
}

function renderJson(value, summary) {
  let text;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return el(
    'details',
    { class: 'json' },
    el('summary', { text: summary || '原始 JSON' }),
    el('pre', { text: text === undefined ? '（无）' : text }),
  );
}

function kvRow(label, content) {
  const dd = el('dd');
  if (content instanceof Node) dd.append(content);
  else dd.append(document.createTextNode(content === undefined || content === null ? '—' : String(content)));
  return [el('dt', { text: label }), dd];
}

function kvList(entries) {
  const dl = el('dl', { class: 'kvlist' });
  for (const [label, content] of entries) {
    if (content === undefined) continue;
    const [dt, dd] = kvRow(label, content);
    dl.append(dt, dd);
  }
  return dl;
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

class ApiError extends Error {
  constructor(message, options) {
    super(message);
    const opts = options || {};
    this.name = 'ApiError';
    this.code = typeof opts.code === 'string' ? opts.code : 'unknown';
    this.status = typeof opts.status === 'number' ? opts.status : 0;
    this.details = opts.details === undefined ? null : opts.details;
  }
}

async function requestJson(path, init) {
  const options = init || {};
  const headers = Object.assign({ accept: 'application/json' }, options.headers || {});
  let body;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let response;
  try {
    response = await fetch(API_BASE + path, {
      method: options.method || 'GET',
      headers,
      body,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (error) {
    throw new ApiError('网络请求失败：' + (error && error.message ? error.message : '未知原因'), { code: 'transport' });
  }

  let text = '';
  try {
    text = await response.text();
  } catch (error) {
    throw new ApiError('读取响应失败：' + (error && error.message ? error.message : '未知原因'), {
      code: 'transport',
      status: response.status,
    });
  }

  let parsed = null;
  let parseFailed = false;
  if (text !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      parseFailed = true;
    }
  }

  if (isPlainObject(parsed) && parsed.ok === true) {
    return { value: parsed.value === undefined ? null : parsed.value, httpStatus: response.status };
  }
  if (isPlainObject(parsed) && parsed.ok === false) {
    const error = isPlainObject(parsed.error) ? parsed.error : {};
    throw new ApiError(typeof error.message === 'string' ? error.message : '服务端拒绝了本次请求', {
      code: typeof error.code === 'string' ? error.code : 'error',
      status: response.status,
      details: error.details === undefined ? null : error.details,
    });
  }
  if (parseFailed) {
    throw new ApiError('响应不是 JSON，无法按 {ok,value} 解析（HTTP ' + response.status + '）', {
      code: 'bad-envelope',
      status: response.status,
      details: text.slice(0, 600),
    });
  }
  throw new ApiError(
    text === '' ? '服务端返回空响应（HTTP ' + response.status + '）' : '响应缺少 {ok,value} 信封（HTTP ' + response.status + '）',
    { code: 'bad-envelope', status: response.status, details: text.slice(0, 600) },
  );
}

const api = {
  status() {
    return requestJson('status', { method: 'GET' });
  },
  query(filter) {
    return requestJson('query', { method: 'POST', body: filter });
  },
  mutate(action, payload) {
    return requestJson('mutate', { method: 'POST', body: { action, payload } });
  },
};

/* ------------------------------------------------------------------ */
/* 状态：未配置 / 已停用 / 失败 / 未知，分别表达                         */
/* ------------------------------------------------------------------ */

function summarizeStatus(value) {
  if (value === null || value === undefined) {
    return { state: 'unknown', label: '无返回值', detail: 'status 接口成功返回，但没有携带 value。' };
  }
  if (!isPlainObject(value)) {
    return { state: 'unknown', label: '结构未知', detail: 'status 的 value 不是对象，无法判断运行状态。' };
  }

  const rawState = typeof value.state === 'string' ? value.state : typeof value.status === 'string' ? value.status : '';
  const lower = rawState.toLowerCase();

  if (value.configured === false || value.isConfigured === false) {
    return { state: 'unconfigured', label: '未配置', detail: '服务端明确报告 configured=false。' };
  }
  if (value.enabled === false || value.disabled === true) {
    return { state: 'disabled', label: '已停用', detail: '服务端明确报告已停用（enabled=false / disabled=true）。' };
  }
  if (/(fail|error|broken|degraded|fatal)/.test(lower)) {
    return { state: 'failed', label: '运行失败', detail: 'state=' + rawState };
  }
  if (/(disabled|paused|stopped|off)/.test(lower)) {
    return { state: 'disabled', label: '已停用', detail: 'state=' + rawState };
  }
  if (/(unconfigured|not.?configured|missing)/.test(lower)) {
    return { state: 'unconfigured', label: '未配置', detail: 'state=' + rawState };
  }
  if (/(ok|ready|running|healthy|active|enabled)/.test(lower)) {
    return { state: 'ok', label: '运行中', detail: 'state=' + rawState };
  }

  if (isPlainObject(value.features)) {
    const flags = Object.keys(value.features).map((key) => value.features[key]);
    const enabledCount = flags.filter((flag) => flag === true).length;
    if (flags.length > 0 && enabledCount === 0) {
      return { state: 'disabled', label: '功能全关', detail: 'features 全部为 false（采集、召回、学习均未启用）。' };
    }
    return { state: 'ok', label: '运行中', detail: 'features 已启用 ' + enabledCount + ' / ' + flags.length + ' 项。' };
  }

  return {
    state: 'unknown',
    label: '状态未知',
    detail: '服务端未给出可比对的 state/status/configured/enabled/features；页面不据此推断“正常”。',
  };
}

function summarizeStatusError(error) {
  if (error && error.status === 404) {
    return {
      state: 'unknown',
      label: '接口未挂载',
      detail: 'HTTP 404：管理路由可能尚未注册，或插件未在当前实例启用。',
    };
  }
  if (error && error.code === 'transport') {
    return { state: 'failed', label: '连接失败', detail: error.message };
  }
  return {
    state: 'failed',
    label: '状态读取失败',
    detail: (error && error.code ? error.code + '：' : '') + (error && error.message ? error.message : '未知错误'),
  };
}

async function loadStatus() {
  state.status.phase = 'loading';
  renderStatusBadge();
  try {
    const result = await api.status();
    state.status.value = result.value;
    state.status.error = null;
    state.status.summary = summarizeStatus(result.value);
    state.status.phase = 'ready';
  } catch (error) {
    state.status.value = null;
    state.status.error = error;
    state.status.summary = summarizeStatusError(error);
    state.status.phase = 'error';
    showBanner('状态读取失败', state.status.summary.detail, error && error.details ? error.details : null);
  }
  renderStatusBadge();
  return state.status;
}

function renderStatusBadge() {
  const badge = $('statusBadge');
  const meta = $('statusMeta');
  if (!badge || !meta) return;
  const summary = state.status.summary;
  if (state.status.phase === 'loading') {
    badge.dataset.state = 'unknown';
    badge.textContent = '读取中…';
    meta.textContent = '正在读取服务端状态';
    return;
  }
  if (!summary) {
    badge.dataset.state = 'unknown';
    badge.textContent = '状态未知';
    meta.textContent = '尚未读取状态';
    return;
  }
  badge.dataset.state = summary.state;
  badge.textContent = summary.label;
  badge.title = summary.detail || '';
  const extra = [];
  if (isPlainObject(state.status.value) && typeof state.status.value.version === 'string') extra.push('版本 ' + state.status.value.version);
  if (isPlainObject(state.status.value) && typeof state.status.value.updatedAt === 'string') extra.push('更新于 ' + formatTime(state.status.value.updatedAt));
  meta.textContent = extra.length > 0 ? extra.join(' · ') : summary.detail || '';
}

async function loadCharacters() {
  try {
    const result = await api.query({ kind: 'character', limit: 200 });
    const value = result.value;
    const rows = isPlainObject(value) && Array.isArray(value.rows) ? value.rows : [];
    state.characters = rows
      .map((row) => {
        const data = isPlainObject(row.data) ? row.data : {};
        const name = pickText(data, ['name', 'displayName', 'nickname', 'title']);
        return { id: String(row.id || ''), name: name || '' };
      })
      .filter((item) => item.id !== '');
  } catch {
    // 角色列表只用于筛选补全；失败不阻断页面，角色 ID 仍可手填。
    state.characters = [];
  }
}

/* ------------------------------------------------------------------ */
/* 导航                                                                */
/* ------------------------------------------------------------------ */

function buildNav() {
  const nav = $('nav');
  nav.replaceChildren();
  const groups = { overview: '工作台', memory: '记忆资料', candidate: '学习与成长', recall: '观察与维护' };
  for (const view of VIEWS) {
    if (groups[view.id]) nav.append(el('p', { class: 'nav-group', text: groups[view.id] }));
    const button = el('button', {
      type: 'button',
      class: 'navitem' + (state.view === view.id ? ' is-active' : ''),
      text: view.label,
      'aria-current': state.view === view.id ? 'page' : null,
    });
    button.addEventListener('click', () => {
      if (state.view === view.id) return;
      navigate(view.id);
    });
    nav.append(button);
  }
}

function navigate(viewId, { kind = '', filter = {} } = {}) {
  if (!VIEWS.some(view => view.id === viewId)) return;
  closeDrawer();
  state.view = viewId;
  state.tab = kind;
  state.filter = { ...state.filter, status: '', search: '', ...filter };
  window.location.hash = viewId + (kind ? '/' + kind : '');
  hideBanner();
  buildNav();
  renderView();
  $('content').focus();
}

function readLocation() {
  const [view, kind = ''] = window.location.hash.slice(1).split('/');
  return { view: VIEWS.some(item => item.id === view) ? view : 'overview', kind };
}

function renderView() {
  if (currentView && typeof currentView.dispose === 'function') currentView.dispose();
  const content = $('content');
  content.replaceChildren();
  const view = VIEWS.find((item) => item.id === state.view) || VIEWS[0];
  try {
    currentView = view.mount(content) || null;
  } catch (error) {
    currentView = null;
    content.append(
      el(
        'div',
        { class: 'errorbox' },
        el('span', { class: 'errortitle', text: '页面渲染失败' }),
        el('p', { text: error && error.message ? error.message : String(error) }),
      ),
    );
  }
}

/* ------------------------------------------------------------------ */
/* 详情抽屉                                                            */
/* ------------------------------------------------------------------ */

function openDrawer(record, options) {
  if ($('drawer').hidden) drawerReturnFocus = document.activeElement;
  const opts = options || {};
  const siblings = Array.isArray(opts.siblings) ? opts.siblings : [];
  const onChanged = typeof opts.onChanged === 'function' ? opts.onChanged : null;
  $('drawer').replaceChildren(buildDrawer(record, siblings, onChanged));
  $('drawer').hidden = false;
  $('overlay').hidden = false;
  $('main').inert = true;
  document.querySelector('.topbar').inert = true;
  const closeButton = $('drawer').querySelector('[data-drawer-close]');
  if (closeButton) closeButton.focus();
}

function closeDrawer() {
  const wasOpen = !$('drawer').hidden;
  $('drawer').hidden = true;
  $('overlay').hidden = true;
  $('drawer').replaceChildren();
  $('main').inert = false;
  document.querySelector('.topbar').inert = false;
  if (wasOpen && drawerReturnFocus?.isConnected) drawerReturnFocus.focus();
  drawerReturnFocus = null;
}

function buildDrawer(record, siblings, onChanged) {
  const kind = String(record.kind || '');
  const data = isPlainObject(record.data) ? record.data : {};
  const wrapper = el('div', { class: 'drawer-inner' });

  wrapper.append(
    el(
      'div',
      { class: 'drawer-head' },
      el(
        'div',
        { class: 'stack', style: { gap: '4px' } },
        el('h3', { text: KIND_LABELS[kind] || kind || '记录' }),
        el('div', { class: 'chips' }, statusChip(record.status), el('span', { class: 'chip', text: 'v' + (record.version ?? '?') })),
        el('code', { class: 'muted small', text: String(record.id || '') }),
      ),
      el('button', {
        type: 'button',
        class: 'btn btn-ghost',
        text: '关闭',
        dataset: { drawerClose: '1' },
        onclick: closeDrawer,
      }),
    ),
  );

  wrapper.append(
    el(
      'div',
      { class: 'card' },
      el('h5', { text: '归属与版本' }),
      kvList([
        ['记录 ID', el('code', { text: String(record.id || '—') })],
        ['类型', (KIND_LABELS[kind] || kind || '—') + (kind ? '（' + kind + '）' : '')],
        ['角色', record.characterId || '—'],
        ['范围', record.scopeKey || '—'],
        ['主体 QQ', record.subjectQQ || '—'],
        ['状态', record.status || '—'],
        ['版本', record.version === undefined || record.version === null ? '—' : String(record.version)],
        ['创建', formatTime(record.createdAt)],
        ['更新', formatTime(record.updatedAt)],
      ]),
    ),
  );

  wrapper.append(renderRecordContent(record, data, siblings));
  if (!['audit','history'].includes(kind) && record.status !== 'deleted') wrapper.append(buildHistoryCard(record));

  const actions = actionsForRecord(record);
  const actionsCard = el('div', { class: 'card' });
  actionsCard.append(el('h5', { text: '可用操作' }));
  if (actions.length === 0) {
    actionsCard.append(el('p', { class: 'muted small', text: '这类记录在本页没有可直接执行的管理动作，仅供查看。' }));
  } else {
    actionsCard.append(
      el('p', {
        class: 'muted small',
        text: '变更会携带 requestId 与服务端要求的字段（expectedVersion / reason / confirm:true 按动作而定），服务端独立校验权限、幂等与版本。目标不明确时页面不提交。',
      }),
    );
    const row = el('div', { class: 'actions', style: { marginTop: '8px' } });
    for (const action of actions) {
      row.append(
        el('button', {
          type: 'button',
          class: 'btn' + (action.danger ? ' btn-danger' : ''),
          text: action.label,
          onclick: () => {
            openActionDialog({
              action: action.action,
              record: action.record || record,
              title: action.title || action.label,
              description: action.description || '',
              consequence: action.consequence || '',
              fields: action.fields || [],
              confirmationText: action.confirmationText || '',
              requiresTarget: action.requiresTarget,
              targetKey: action.targetKey,
              versionMode: action.versionMode,
              reasonMode: action.reasonMode,
              confirmFlag: action.confirmFlag === true,
              resultFollowUp: action.resultFollowUp,
              onDone: () => {
                closeDrawer();
                if (onChanged) onChanged();
              },
            });
          },
        }),
      );
    }
    actionsCard.append(row);
  }
  wrapper.append(actionsCard);

  wrapper.append(el('div', { class: 'card' }, el('h5', { text: '原始记录' }), renderJson(record, '展开完整 JSON')));
  return wrapper;
}

function buildHistoryCard(record) {
  const card = el('div', { class: 'card' }, el('h5', { text: '历史版本（只读）' }));
  const list = el('div', { class: 'stack' });
  const errorBox = el('p', { class: 'muted small', hidden: true });
  let after;
  let previous = record;
  let loaded = 0;
  const button = el('button', { type: 'button', class: 'btn', text: '查看历史版本', onclick: async () => {
    button.disabled = true;
    errorBox.hidden = true;
    try {
      const result = await api.query({ kind: 'history', id: record.id, limit: 20, ...(after ? { after } : {}) });
      const value = result.value;
      if (!isPlainObject(value) || !Array.isArray(value.rows)) throw new Error('历史查询未返回 {rows,next}');
      if (!card.isConnected) return;
      for (const snapshot of value.rows) {
        const data = isPlainObject(snapshot.data) ? snapshot.data : {};
        const newer = isPlainObject(previous.data) ? previous.data : {};
        const fields = [...new Set([...Object.keys(data), ...Object.keys(newer)])].filter(key => stableStringify(data[key]) !== stableStringify(newer[key]));
        const entry = el('details', {}, el('summary', { text: 'v' + snapshot.version + ' · ' + formatTime(snapshot.updatedAt) + ' · ' + (STATUS_LABELS[snapshot.status] || snapshot.status) }));
        entry.append(el('p', { class: 'muted small', text: '与较新 v' + previous.version + ' 相比，数据变化：' + (fields.map(key => FIELD_LABELS[key] || key).join('、') || '无（可能仅状态变更）') }));
        entry.append(renderRecordContent({ ...snapshot, kind: record.kind }, data, []), renderJson(snapshot, '完整历史快照'));
        list.append(entry);
        previous = snapshot;
        loaded += 1;
      }
      after = value.next;
      if (!loaded) list.append(el('p', { class: 'muted small', text: '没有保留的历史版本。删除记录时历史快照会清除。' }));
      button.hidden = !after;
      button.textContent = '加载更早版本';
    } catch (error) {
      errorBox.textContent = '读取历史失败：' + (error.message || String(error));
      errorBox.hidden = false;
    } finally { button.disabled = false; }
  } });
  card.append(list, errorBox, button);
  return card;
}

function describeValue(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null; // 数组与对象交给 chips / JSON
}

function renderRecordContent(record, data, siblings) {
  const kind = String(record.kind || '');
  const card = el('div', { class: 'card' });
  card.append(el('h5', { text: '内容' }));

  const mainText = pickText(data, ['text', 'content', 'summary', 'statement', 'rule']);
  if ((kind === 'memory' || kind === 'event') && mainText !== null) {
    card.append(
      el(
        'div',
        { class: 'stack', style: { gap: '6px', marginBottom: '10px' } },
        el('span', { class: 'muted small', text: kind === 'event' ? '原文内容（原始材料，保留至用户删除）' : '记忆正文' }),
        el('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }, text: mainText }),
      ),
    );
  }

  const rows = [];
  const arrays = [];
  const nested = [];
  for (const key of Object.keys(data)) {
    if ((kind === 'memory' || kind === 'event') && (key === 'text' || key === 'content') && typeof data[key] === 'string') continue;
    const label = FIELD_LABELS[key] || key;
    const value = data[key];
    if (Array.isArray(value)) {
      arrays.push([label, chipList(value)]);
      continue;
    }
    if (isPlainObject(value)) {
      nested.push([label, value]);
      continue;
    }
    const described = describeValue(value);
    if (described !== null) rows.push([label, described]);
  }

  if (rows.length > 0) {
    card.append(kvList(rows.map(([label, value]) => [label, el('span', { class: 'text', text: value })])));
  }
  for (const [label, node] of arrays) {
    card.append(
      el('div', { style: { height: '8px' } }),
      el('dl', { class: 'kvlist' }, el('dt', { text: label }), el('dd', {}, node)),
    );
  }
  for (const [label, value] of nested) {
    card.append(el('div', { style: { height: '8px' } }), renderJson(value, label + '（展开）'));
  }
  if (rows.length === 0 && arrays.length === 0 && nested.length === 0) {
    card.append(el('p', { class: 'muted small', text: 'data 为空或没有可读字段。' }));
  }

  if (kind === 'personality') card.append(buildPersonalityDiff(data, siblings));
  if (kind === 'recall') card.append(buildRecallDetail(data));
  return card;
}

function buildPersonalityDiff(data, siblings) {
  const box = el('div', { class: 'card' });
  box.append(el('h5', { text: '版本差异' }));

  const changes = data.changes;
  if (Array.isArray(changes)) {
    if (changes.length === 0) box.append(el('p', { class: 'muted small', text: 'changes 为空数组。' }));
    else box.append(el('ul', { class: 'recalllist' }, changes.map((item) => el('li', { text: clip(textOf(item), 800) }))));
  } else if (isPlainObject(changes)) {
    const keys = Object.keys(changes);
    if (keys.length === 0) box.append(el('p', { class: 'muted small', text: 'changes 为空对象。' }));
    else box.append(el('ul', { class: 'recalllist' }, keys.map((key) => el('li', { text: key + '：' + clip(textOf(changes[key]), 800) }))));
  } else {
    box.append(el('p', { class: 'muted small', text: '该版本没有记录 changes 字段。' }));
  }

  const parentId = typeof data.parentId === 'string' ? data.parentId : '';
  if (parentId === '') {
    box.append(el('p', { class: 'muted small', text: '没有父版本 ID（首个版本）。' }));
    return box;
  }

  const parent = siblings.find((row) => row && String(row.id) === parentId) || null;
  if (parent === null) {
    box.append(
      el('p', {
        class: 'muted small',
        text: '父版本 ' + parentId + ' 不在当前已加载记录中；页面不做跨页拼接，也不猜差异。',
      }),
    );
    return box;
  }

  const parentData = isPlainObject(parent.data) ? parent.data : {};
  const before = new Set(Object.keys(parentData));
  const after = new Set(Object.keys(data));
  const added = [];
  const removed = [];
  const changed = [];
  for (const key of after) {
    if (!before.has(key)) added.push(key);
    else if (stableStringify(parentData[key]) !== stableStringify(data[key])) changed.push(key);
  }
  for (const key of before) {
    if (!after.has(key)) removed.push(key);
  }

  box.append(el('p', { class: 'muted small', text: '与父版本 data 的顶层字段比较（仅顶层，不含深层合并）：' }));
  box.append(
    kvList([
      ['新增键', added.length > 0 ? chipList(added) : '无'],
      ['删除键', removed.length > 0 ? chipList(removed) : '无'],
      ['变更键', changed.length > 0 ? chipList(changed) : '无'],
    ]),
  );
  for (const key of changed) {
    box.append(
      el(
        'details',
        { class: 'json' },
        el('summary', { text: key + '（展开前后值）' }),
        el('pre', {
          text: '父版本：\n' + clip(textOf(parentData[key]), 1200) + '\n\n当前版本：\n' + clip(textOf(data[key]), 1200),
        }),
      ),
    );
  }
  return box;
}

function buildRecallDetail(data) {
  const box = el('div', { class: 'card' });
  box.append(el('h5', { text: '本轮召回：入选与省略' }));
  const selected = Array.isArray(data.selected) ? data.selected : null;
  const omitted = Array.isArray(data.omitted) ? data.omitted : null;

  if (selected === null && omitted === null) {
    box.append(el('p', { class: 'muted small', text: '该记录没有 selected / omitted 字段，无法区分入选与省略。' }));
    return box;
  }

  box.append(el('h5', { text: '入选 ' + (selected ? selected.length : 0) + ' 条' }));
  if (selected && selected.length > 0) {
    box.append(el('ul', { class: 'recalllist' }, selected.map((item) => el('li', { text: describeRecallItem(item) }))));
  } else {
    box.append(el('p', { class: 'muted small', text: '无入选条目。' }));
  }

  box.append(el('h5', { text: '省略 ' + (omitted ? omitted.length : 0) + ' 条' }));
  if (omitted && omitted.length > 0) {
    box.append(el('ul', { class: 'recalllist' }, omitted.map((item) => el('li', { text: describeRecallItem(item) }))));
  } else {
    box.append(el('p', { class: 'muted small', text: '无省略条目，或服务端未记录省略内容。' }));
  }

  box.append(el('p', { class: 'muted small', text: '省略原因只在服务端记录时展示；页面不补写理由。' }));
  if (isPlainObject(data.budget)) {
    box.append(el('div', { style: { height: '8px' } }), renderJson(data.budget, '召回预算（展开）'));
  }
  return box;
}

function describeRecallItem(item) {
  if (isPlainObject(item)) {
    const id = typeof item.id === 'string' ? item.id : '';
    const reason = item.reason || item.why || item.omittedReason || '';
    const label = KIND_LABELS[item.kind] || item.kind || '';
    const head = [label, id ? '(' + id + ')' : ''].filter(Boolean).join(' ');
    return (head || '条目') + (reason ? ' — ' + textOf(reason) : '');
  }
  return clip(item, 300);
}

/* ------------------------------------------------------------------ */
/* 动作定义                                                            */
/* ------------------------------------------------------------------ */

function textField(name, label, value, help, required) {
  return { name, label, type: 'text', value: value === undefined ? '' : value, help, required: required === true };
}

function selectField(name, label, options, value, help, required) {
  const list = Array.isArray(options) ? options : [];
  const initial = value === undefined || value === null || value === '' ? (list[0] ? list[0][0] : '') : value;
  return { name, label, type: 'select', options: list, value: initial, help, required: required === true };
}

function listField(name, label, value, help, choices, required) {
  return {
    name,
    label,
    type: 'list',
    value: value === undefined ? '' : value,
    help,
    choices: Array.isArray(choices) ? choices : null,
    required: required === true,
  };
}

function jsonField(name, label, value, help, shape, required) {
  return {
    name,
    label,
    type: 'json',
    value: value === undefined ? (shape === 'array' ? [] : {}) : value,
    help,
    shape: shape || 'any',
    required: required === true,
  };
}

function editAction(record, label) {
  return {
    action: 'edit',
    label: '编辑' + label,
    title: '编辑' + label + '内容',
    description: 'data 为完整替换：请保留未改动的字段，只修改需要变更的部分。记忆重要性 importance 可设为1至5整数；清除该值会按类型重新分级。',
    fields: [jsonField('data', 'data（完整 JSON）', isPlainObject(record.data) ? record.data : {}, '提交后整个 data 被替换，请先把未改字段一起带上。', 'object', true)],
  };
}

/** 常用内容用表单编辑；未知字段、来源与状态元数据保留，JSON 模式可完整查看。 */
function createRecordEditor(kind, initial = {}, isNew = false) {
  let currentKind = kind;
  let baseline = structuredClone(initial);
  let mode = 'form';
  let controls = [];
  const node = el('div', { class: 'record-editor' });
  const tabs = el('div', { class: 'tabs', role: 'group', 'aria-label': '内容编辑方式' });
  const form = el('div', { class: 'form-grid' });
  const raw = el('textarea', { class: 'textarea json-editor', 'aria-label': '完整内容 JSON', spellcheck: 'false', hidden: true });
  const errorBox = el('p', { class: 'editor-error', role: 'alert', hidden: true });
  const formButton = el('button', { type: 'button', class: 'tab is-active', 'aria-pressed': 'true', text: '表单编辑' });
  const jsonButton = el('button', { type: 'button', class: 'tab', 'aria-pressed': 'false', text: '高级 JSON' });
  tabs.append(formButton, jsonButton);
  node.append(tabs, errorBox, form, raw, el('p', { class: 'muted small', text: '未显示的字段会保留；提交前请核对来源、归属和变更原因。' }));

  function specs() {
    const mainKey = ['text','summary','content'].find(key => typeof baseline[key] === 'string') || 'text';
    if (currentKind === 'character') return [{ key: 'name', label: '角色名称', required: true }];
    const common = [
      { key: mainKey, label: '正文', type: 'textarea', required: true, wide: true },
      { key: 'context', label: '适用情境', placeholder: '这条内容在什么情况下适用' },
      { key: 'importance', label: '重要性', type: 'number', help: '1–5；留空按类型分级，边界5、承诺4、事实/偏好/关系3、经历1。' },
      { key: 'sourceIds', label: '来源记录 ID', type: 'lines', wide: true, help: '每行一个原文记录 ID，也可用逗号分隔。' },
      { key: 'factKey', label: '事实主题', placeholder: '例如：居住城市；同一主体的同一事实用同一主题' },
      { key: 'supersedesId', label: '替代的旧记录 ID' },
      { key: 'occurredAt', label: '发生时间', type: 'time' },
      { key: 'validFrom', label: '生效时间', type: 'time' },
      { key: 'validUntil', label: '失效时间', type: 'time' },
    ];
    if (currentKind === 'memory') common.unshift({ key: 'type', label: '记忆类型', options: [['experience','共同经历'],['fact','事实'],['boundary','边界'],['preference','偏好'],['relationship','关系'],['promise','承诺']] });
    if (currentKind === 'profile') common.unshift({ key: 'originScope', label: '原始来源范围', help: '群来源填写 group:群号，经确认用于同角色跨群认识；私聊来源保持私有。' });
    if (currentKind === 'candidate') return [
      { key: 'type', label: '候选类型', options: [['expression','表达（群/私聊）'],['jargon','黑话（群）'],['preference','偏好（私聊）'],['personality','人格变化（角色级）']] },
      { key: 'rule', label: '规则或表达', type: 'textarea', required: true, wide: true },
      { key: 'context', label: '适用情境', required: true },
      { key: 'meaning', label: '黑话含义' },
      { key: 'personalityChange', label: '人格的一处具体小幅变化' },
      { key: 'sourceIds', label: '来源记录 ID', type: 'lines', wide: true, help: '不因人工创建跳过证据、试用或实际应用门槛。' },
    ];
    return common;
  }

  function renderForm() {
    form.replaceChildren();
    controls = [];
    if (isNew && !Object.hasOwn(baseline, 'type') && ['memory','candidate'].includes(currentKind)) baseline.type = currentKind === 'memory' ? 'experience' : 'expression';
    for (const spec of specs()) {
      const id = 'editor-' + spec.key + '-' + Math.random().toString(36).slice(2, 8);
      const value = baseline[spec.key];
      let input;
      if (spec.options) {
        input = el('select', { class: 'select', id });
        input.append(el('option', { value: '', text: '未指定' }));
        const options = spec.options.slice();
        if (value != null && !options.some(([key]) => key === value)) options.push([String(value), String(value) + '（原值）']);
        for (const [key, label] of options) input.append(el('option', { value: key, text: label }));
        input.value = value == null ? '' : String(value);
      } else {
        input = el(['textarea','lines'].includes(spec.type) ? 'textarea' : 'input', {
          class: ['textarea','lines'].includes(spec.type) ? 'textarea' : 'input', id,
          ...(!['textarea','lines'].includes(spec.type) ? { type: spec.type === 'number' ? 'number' : 'text' } : {}),
          placeholder: spec.type === 'time' ? '2026-10-27T18:00:00+08:00（含时区）' : spec.placeholder || '',
        });
        input.value = value == null ? '' : spec.type === 'lines' && Array.isArray(value) ? value.join('\n') : textOf(value);
        if (spec.type === 'number') { input.min = '1'; input.max = '5'; input.step = '1'; }
      }
      input.setAttribute('aria-required', String(Boolean(spec.required)));
      const wrap = el('div', { class: 'fieldrow' + (spec.wide ? ' field-wide' : '') }, el('label', { for: id, class: 'fieldlabel', text: spec.label + (spec.required ? ' *' : '') }), input);
      if (spec.help) wrap.append(el('p', { class: 'muted small', text: spec.help }));
      form.append(wrap);
      controls.push({ spec, input, initial: input.value });
    }
  }

  function read(validate = true) {
    if (mode === 'json') {
      const data = JSON.parse(raw.value);
      if (!isPlainObject(data)) throw new Error('内容必须是 JSON 对象');
      return data;
    }
    const data = structuredClone(baseline);
    for (const { spec, input, initial } of controls) {
      const text = input.value.trim();
      if (validate && spec.required && !text) throw new Error(spec.label + '不能为空');
      if (input.value === initial) continue;
      if (!text) { delete data[spec.key]; continue; }
      if (spec.type === 'number') {
        const number = Number(text);
        if (!Number.isInteger(number) || number < 1 || number > 5) throw new Error('重要性须为1至5整数');
        data[spec.key] = number;
      } else if (spec.type === 'time') {
        if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(text) || !Number.isFinite(Date.parse(text))) throw new Error(spec.label + '必须是含时区的有效时间');
        data[spec.key] = new Date(text).toISOString();
      } else if (spec.type === 'lines') data[spec.key] = [...new Set(text.split(/[\n,，]+/).map(value => value.trim()).filter(Boolean))];
      else data[spec.key] = input.value;
    }
    return data;
  }

  function switchMode(nextMode) {
    if (nextMode === mode) return;
    try {
      baseline = read(false);
      if (nextMode === 'json') raw.value = JSON.stringify(baseline, null, 2);
      else renderForm();
      mode = nextMode;
      form.hidden = mode !== 'form';
      raw.hidden = mode !== 'json';
      formButton.classList.toggle('is-active', mode === 'form');
      jsonButton.classList.toggle('is-active', mode === 'json');
      formButton.setAttribute('aria-pressed', String(mode === 'form'));
      jsonButton.setAttribute('aria-pressed', String(mode === 'json'));
      errorBox.hidden = true;
    } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; }
  }
  formButton.onclick = () => switchMode('form');
  jsonButton.onclick = () => switchMode('json');
  renderForm();
  return { node, read, setKind(nextKind) {
    try {
      baseline = read(false); currentKind = nextKind;
      if (mode === 'form') renderForm();
      errorBox.hidden = true;
      return true;
    } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; return false; }
  } };
}

function deleteAction(label, title, consequence) {
  return {
    action: 'delete',
    label,
    danger: true,
    title,
    description: '记录被标记删除，不再参与召回与学习；可在受控保留期内撤销。',
    consequence: consequence || '删除后不再使用；备份保留期内它仍可能存在于备份里，恢复会让它复活。',
    confirmationText: '删除',
    fields: [],
  };
}

/** 共享：服务端只允许 memory / profile / supplement 的现有文本字段，且源须为生效状态。 */
function shareAction(record) {
  const data = isPlainObject(record.data) ? record.data : {};
  if (!['active', 'trial', 'accepted', 'adopted'].includes(String(record.status || ''))) return null;
  const shareable = ENUMS.shareFields.filter((key) => typeof data[key] === 'string' && data[key] !== '');
  if (shareable.length === 0) return null;
  return {
    action: 'share',
    label: '加入共享',
    title: '把字段加入共享',
    description: '共享是显式动作：目标范围必须与源不同，字段须是记录里已有的文本字段。',
    reasonMode: 'optional',
    fields: [
      textField('targetScope', '目标范围', '', '范围写法：private:<QQ> / group:<群号> / profile:<QQ>；不能与源相同。', true),
      listField('fields', '共享字段（逗号分隔）', shareable.join(','), '仅可选记录里已有的文本字段：' + shareable.join(' / '), shareable, true),
    ],
  };
}

/** 反馈是创建在目标记录上的新记录（targetId），不是“处理 feedback 实体”。 */
function feedbackAction(record) {
  return {
    action: 'feedback',
    label: '记录管理员反馈',
    title: '对目标记录登记管理员反馈',
    description: '服务端在目标上新建 feedback 记录；负面与纠正反馈会暂停目标并使其派生内容失效。',
    targetKey: 'targetId',
    reasonMode: 'optional',
    fields: [
      selectField('sentiment', '反馈类型', ENUMS.sentiment, 'positive', 'positive 正面 / negative 负面 / correction 纠正。negative、correction 会暂停目标记录。', true),
      textField('text', '具体反馈内容', '', '写入 feedback.text，例如“该称呼让我不适，请改回昵称”。', true),
    ],
  };
}

function candidateOperationAction() {
  return {
    action: 'candidate',
    label: '候选操作',
    title: '候选：评估 / 暂停 / 驳回 / 恢复',
    description: '评估只读取进度；暂停或驳回冻结当前证据；恢复重新收集并开始新的试用。试用与采纳仍须达到 S1–S6。',
    reasonMode: 'optional',
    fields: [
      selectField('operation', '操作', ENUMS.candidateOperation, 'evaluate', 'evaluate 只核算进度；pause/reject 冻结当前证据；resume 恢复收集但不复用冻结证据。', true),
    ],
  };
}

function backupRestoreAction(record, preview) {
  return {
    action: 'backupRestore',
    record,
    title: '从该备份恢复',
    versionMode: 'none',
    reasonMode: 'optional',
    confirmFlag: true,
    confirmationText: '恢复',
    description: '恢复是覆盖性操作：服务端按 confirmationToken + sha256 双重校验，并要求 confirm:true。',
    consequence: '备份之后的新变更会丢失，已删除的原文可能复活；恢复后需重启插件再启用学习引擎。',
    fields: [
      textField(
        'confirmationToken',
        '确认令牌 confirmationToken',
        preview && typeof preview.confirmationToken === 'string' ? preview.confirmationToken : '',
        '来自 backupPreview 的返回值，10 分钟内有效；预览后数据库变化会使其失效。',
        true,
      ),
    ],
  };
}

function importApplyAction(preview) {
  return {
    action: 'importApply',
    requiresTarget: false,
    versionMode: 'none',
    reasonMode: 'optional',
    confirmFlag: true,
    confirmationText: '批准',
    title: '批准导入',
    description: '服务端校验 confirmationToken 与 sha256，并要求 confirm:true 才会写入。',
    consequence: '导入会新增记录（默认 disabled 或 quarantine），不会覆盖现有条目。',
    fields: [
      textField(
        'confirmationToken',
        '确认令牌 confirmationToken',
        preview && typeof preview.confirmationToken === 'string' ? preview.confirmationToken : '',
        '来自 importPreview 的返回值，10 分钟内有效。',
        true,
      ),
      textField('sha256', '预览指纹 sha256', preview && typeof preview.sha256 === 'string' ? preview.sha256 : '', '必须与 importPreview 返回的 sha256 完全一致。', true),
    ],
  };
}

function actionsForRecord(record) {
  const kind = String(record.kind || '');
  const status = String(record.status || '');
  const data = isPlainObject(record.data) ? record.data : {};
  const deleted = status === 'deleted';
  const canDisable = !deleted && status !== 'disabled';
  const canEnable = status === 'disabled' || status === 'paused' || status==='pending' && ['memory','profile','supplement'].includes(kind);
  const actions = [];

  if (deleted) {
    // 删除后服务端只保留 undo 通道；受控保留期外会返回 UNDO_EXPIRED。
    return [{ action: 'undo', label: '撤销删除', title: '撤销删除', description: '按服务端受控保留机制恢复；超出保留期会失败，恢复后保持停用。', fields: [] }];
  }

  if (kind === 'memory' && status === 'quarantine' && typeof data.legacySource === 'string' && data.legacySource !== '') {
    // 隔离材料只能做“停用分配”（服务端要求 status=quarantine 且带 legacySource）。
    actions.push({
      action: 'assignImport',
      label: '分配隔离材料归属',
      title: '为隔离材料指定角色与范围',
      description: '仅对 status=quarantine 且带 legacySource 的导入材料有效；分配后状态为 disabled，需再次复核启用。',
      consequence: '一旦分配，该条记录归属到指定角色与范围；归属错误需要人工删除后重新导入。',
      confirmFlag: true,
      confirmationText: '分配',
      reasonMode: 'optional',
      fields: [
        textField('characterId', '角色 ID', state.filter.characterId || record.characterId || '', '必须是已存在且生效的角色。', true),
        textField('scopeKey', '范围 scopeKey', state.filter.scopeKey || '', 'canonical scope：private:<QQ> / group:<群号> / profile:<QQ>。', true),
      ],
    });
    actions.push(deleteAction('删除隔离材料', '删除该隔离材料'));
    return actions;
  }

  switch (kind) {
    case 'character': {
      actions.push(editAction(record, '角色'));
      if (canDisable) actions.push({ action: 'disable', label: '停用角色', title: '停用角色', description: '停用后该角色不再写入或召回。', fields: [] });
      if (canEnable) actions.push({ action: 'enable', confirmFlag: status==='pending', label: '启用角色', title: '启用角色', fields: [] });
      actions.push(deleteAction('删除角色', '删除角色', '该角色下的记忆、档案与共享引用都会停止使用；备份保留期内仍可能存在于备份中。'));
      return actions;
    }
    case 'memory': {
      actions.push(editAction(record, '记忆'));
      actions.push(feedbackAction(record));
      const share = shareAction(record);
      if (share) actions.push(share);
      if (canDisable) actions.push({ action: 'disable', label: '停用', title: '停用该记忆', description: '停用后不再参与召回与上下文装配；原文与历史保留。', fields: [] });
      if (canEnable) actions.push({ action: 'enable', confirmFlag: status==='pending', label: status==='pending'?'审阅后确认启用':'启用', title: status==='pending'?'核对来源后启用这条记忆':'重新启用该记忆', description:status==='pending'?'请先核对原文与归属；确认后才作为有效记忆召回。':'', fields: [] });
      actions.push(deleteAction('删除', '删除该记忆'));
      return actions;
    }
    case 'event': {
      if (canDisable) {
        actions.push({ action: 'disable', label: '停用原文', title: '停用这段原文', description: '停用后原文不再作为材料参与提炼与召回。', fields: [] });
      }
      if (canEnable) actions.push({ action: 'enable', confirmFlag: status==='pending', label: '启用原文', title: '重新启用原文', fields: [] });
      actions.push(deleteAction('删除原文', '删除原文', '删除原始材料会撤销其证据资格，并可能暂停仅由它支持的派生内容；备份保留期内仍可能留在备份中。'));
      return actions;
    }
    case 'profile': {
      actions.push(editAction(record, '个人档案'));
      actions.push(feedbackAction(record));
      const share = shareAction(record);
      if (share) actions.push(share);
      if (canDisable) actions.push({ action: 'disable', label: '停用', title: '停用该档案', fields: [] });
      if (canEnable) actions.push({ action: 'enable', confirmFlag: status==='pending', label: '启用', title: '重新启用该档案', fields: [] });
      actions.push(deleteAction('删除', '删除个人档案', '依赖该档案的共享引用会停止使用。'));
      return actions;
    }
    case 'supplement': {
      actions.push(editAction(record, '群内补充'));
      actions.push(feedbackAction(record));
      const share = shareAction(record);
      if (share) actions.push(share);
      if (canDisable) actions.push({ action: 'disable', label: '停用', title: '停用群内补充', fields: [] });
      if (canEnable) actions.push({ action: 'enable', confirmFlag: status==='pending', label: '启用', title: '重新启用群内补充', fields: [] });
      actions.push(deleteAction('删除', '删除群内补充'));
      return actions;
    }
    case 'share': {
      if (status === 'active') actions.push({ action: 'unshare', label: '撤销共享', title: '撤销这条共享引用', description: '撤销后关联端停止使用。', fields: [] });
      if (canDisable) actions.push({ action: 'disable', label: '停用', title: '停用共享引用', fields: [] });
      actions.push(deleteAction('删除', '删除共享引用'));
      return actions;
    }
    case 'candidate': {
      actions.push(candidateOperationAction());
      actions.push({action:'rollback',label:'回退这条变化',title:'回退单条候选',confirmationText:'回退',description:'冻结旧证据并暂停自动采纳；人格候选只撤回这项变化，保留其他变化与记忆经历。',fields:[]});
      actions.push({action:'rollbackBatch',label:'按目标列表批次回退',title:'回退一批候选',requiresTarget:false,targetKey:null,versionMode:'none',confirmationText:'回退',description:'只处理下面明确列出的同角色候选；任一版本过期则整批不执行。',fields:[jsonField('targets','候选及当前版本',[{id:record.id,expectedVersion:record.version}],'填写数组，每项包含 id 和 expectedVersion，最多80条。','array',true)]});
      actions.push(editAction(record, '候选'));
      actions.push(feedbackAction(record));
      if (canDisable) actions.push({ action: 'disable', label: '停用候选', title: '停用该候选', fields: [] });
      if (canEnable) actions.push({ action: 'enable', confirmFlag: status==='pending', label: '重新启用候选', title: '重新启用候选', description: '重新启用会把候选状态改回 pending（收集态），需重新积累证据。', fields: [] });
      actions.push(deleteAction('删除候选', '删除该候选'));
      return actions;
    }
    case 'trial':
      // trial 不在服务端 EDITABLE 集合内：编辑与状态变更都会被拒绝，这里保持只读。
      return [];
    case 'control': {
      // control 在 EDITABLE 内，可编辑与停用；type 等字段结构以服务端记录为准。
      actions.push(editAction(record, '管理记录'));
      if (canDisable) actions.push({ action: 'disable', label: '停用该记录', title: '停用管理记录', fields: [] });
      if (canEnable) actions.push({ action: 'enable', confirmFlag: status==='pending', label: '启用该记录', title: '启用管理记录', fields: [] });
      return actions;
    }
    case 'evidence':
      // evidence 不在服务端可编辑集合内，disable 会被拒绝；仅支持删除。
      actions.push(deleteAction('删除证据', '删除证据', '删除证据会撤销其证据资格，可能暂停仅由它支持的候选。'));
      return actions;
    case 'conflict': {
      if (status !== 'resolved') {
        actions.push({
          action: 'resolveConflict',
          label: '解决冲突',
          title: '解决记忆冲突',
          description: '双方原文与来源保留。选择保留或替换时暂停另一项；区分情境时更新双方适用条件。',
          fields: [selectField('resolution', '解决方式', ENUMS.resolution, 'retain', '保留／替换需填写保留条目；区分情境需填写双方不同情境。', true),textField('keepId','保留条目 ID','','从冲突 targetIds 中选择；保留／替换事实冲突时必填。'),jsonField('contexts','双方适用情境',{},'区分情境时填写 {"条目ID":"适用情境"}。','object',false)],
        });
      }
      if (canDisable) actions.push({ action: 'disable', label: '停用冲突记录', title: '停用冲突记录', fields: [] });
      return actions;
    }
    case 'feedback': {
      // feedback 实体只读查看；可编辑原文与停用，没有“处理反馈”这类服务端动作。
      actions.push(editAction(record, '反馈'));
      if (canDisable) actions.push({ action: 'disable', label: '停用反馈', title: '停用反馈', fields: [] });
      return actions;
    }
    case 'application': {
      if (data.successful === true) {
        actions.push({
          action: 'verifyApplication',
          label: '核验实际应用',
          title: '核验实际应用',
          description: '注入不等于应用（S4）。只有发送原文里确实出现核验片段时才会登记成功。',
          fields: [
            textField(
              'candidateId',
              '候选 ID candidateId',
              Array.isArray(data.candidateIds) && data.candidateIds.length === 1 ? String(data.candidateIds[0]) : '',
              '须为 trial / adopted / accepted 候选；人格候选允许角色级，试用须来源于本会话范围，私聊本人暂停的规则不可核验。',
              true,
            ),
            textField('excerpt', '核验片段 excerpt', '', '必须是本条发送原文里真实出现的一段文字，服务端做包含校验。', true),
          ],
        });
      }
      return actions;
    }
    case 'personality': {
      if (status === 'active' || status === 'superseded') {
        actions.push({
          action: 'rollback',
          label: '回退到该版本',
          danger: true,
          title: '回退人格到该版本',
          description: '回退创建恢复版本并保留历史；只恢复人格与表达，不删除事实记忆与共同经历。',
          consequence: '回退后该变化暂停自动采纳，旧证据不会立即重新激活（R6）。',
          confirmationText: '回退',
          fields: [],
        });
      }
      if (canDisable) actions.push({ action: 'disable', label: '停用该版本记录', title: '停用人格版本记录', fields: [] });
      return actions;
    }
    case 'backup': {
      actions.push({
        action: 'backupPreview',
        label: '预览恢复影响',
        title: '预览该备份的恢复影响',
        description: '预览只读取：返回库版本、记录计数、当前库对比与 confirmationToken。恢复必须拿这个令牌。',
        versionMode: 'none',
        reasonMode: 'none',
        fields: [],
        resultFollowUp: { label: '用该令牌继续恢复', build: (value) => backupRestoreAction(record, value) },
      });
      actions.push(backupRestoreAction(record, null));
      return actions;
    }
    case 'takeover': {
      actions.push({
        action: 'takeover',
        label: '接管操作',
        title: '接管：准备 / 激活 / 回退',
        description: '服务端只接受 prepare、activate、rollback；已有接管记录必须带当前 expectedVersion，activate 后仍需桥接确认旧输出已关闭才生效。',
        targetKey: null,
        versionMode: 'required',
        fields: [
          textField('characterId', '角色 ID', record.characterId || '', '必须是已存在且生效的角色。', true),
          textField('scopeKey', '范围 scopeKey', record.scopeKey || '', 'canonical scope：private:<QQ> / group:<群号> / profile:<QQ>。', true),
          selectField('operation', '操作', ENUMS.takeoverOperation, 'prepare', 'prepare 准备 / activate 请求停旧并等待桥接确认 / rollback 回退接管。', true),
        ],
      });
      return actions;
    }
    case 'task':
      return [{action:'task',label:data.paused?'恢复任务':'暂停任务',title:'管理学习任务',description:'恢复任务保留原配额与最短间隔；正在处理中的任务须等待收敛。',fields:[selectField('operation','操作',[['pause','暂停'],['resume','恢复']],data.paused?'resume':'pause','暂停不会删除游标；恢复不会提前下一次可运行时间。',true)]}];
    case 'import':
    case 'binding':
    case 'recall':
    case 'usage':
    case 'audit':
    default:
      // import / task / binding / recall / usage / audit 没有服务端管理动作；这些记录只读。
      return [];
  }
}

/* ------------------------------------------------------------------ */
/* 对话框                                                              */
/* ------------------------------------------------------------------ */

function openDialog(options) {
  const dialog = document.createElement('dialog');
  dialog.className = 'actiondialog';
  const headingId = 'dialog-title-' + newRequestId();
  dialog.setAttribute('aria-labelledby', headingId);
  const head = el('div', { class: 'dialoghead' }, el('h2', { id: headingId, text: options.title }));
  if (options.subtitle) head.append(el('p', { class: 'muted small', text: options.subtitle }));
  dialog.append(head, options.body, options.footer);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    dialog.close();
  });
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}
function buildField(field, refs, record) {
  const wrap = el('div', { class: 'fieldrow' });
  const id = 'qqcm-field-' + field.name + '-' + Math.random().toString(36).slice(2, 7);
  wrap.append(el('label', { class: 'fieldlabel', for: id, text: field.label + (field.required ? '（必填）' : '') }));

  if (field.type === 'json' && field.name === 'data' && ['memory','profile','supplement','candidate','character'].includes(record?.kind)) {
    const editor = createRecordEditor(record.kind, field.value);
    wrap.append(editor.node);
    refs.set(field.name, { field, editor });
    return wrap;
  }
  let input;
  if (field.type === 'select') {
    input = el('select', { class: 'select', id });
    for (const option of field.options) {
      input.append(el('option', { value: option[0], text: option[1] + '（' + option[0] + '）' }));
    }
    input.value = field.value === undefined || field.value === null ? '' : String(field.value);
    if (input.value === '' && field.options[0]) input.value = field.options[0][0];
  } else if (field.type === 'json') {
    input = el('textarea', { class: 'textarea', id });
    try {
      input.value = JSON.stringify(field.value === undefined ? (field.shape === 'array' ? [] : {}) : field.value, null, 2);
    } catch {
      input.value = field.shape === 'array' ? '[]' : '{}';
    }
  } else if (field.type === 'number') {
    input = el('input', { class: 'input', type: 'number', id, step: '1', placeholder: field.placeholder || '' });
    if (field.value !== undefined && field.value !== null && field.value !== '') input.value = String(field.value);
  } else {
    input = el('input', { class: 'input', type: 'text', id, placeholder: field.placeholder || '' });
    if (field.value !== undefined && field.value !== null) input.value = String(field.value);
  }
  refs.set(field.name, { field, input });
  wrap.append(input);
  if (field.help) wrap.append(el('p', { class: 'fieldhelp muted small', text: field.help }));
  return wrap;
}

/** 读取一张表单字段的提交值；返回 {ok,value} 或 {ok:false,problem}。 */
function readFieldValue(entry) {
  const field = entry.field;
  if (entry.editor) {
    try { return { ok: true, value: entry.editor.read() }; }
    catch (error) { return { ok: false, problem: error.message }; }
  }
  const raw = String(entry.input.value);
  const trimmed = raw.trim();
  if (field.type === 'select') {
    if (trimmed === '') return field.required ? { ok: false, problem: field.label + '不能为空。' } : { ok: true, skip: true };
    const allowed = field.options.map((option) => option[0]);
    if (!allowed.includes(trimmed)) return { ok: false, problem: field.label + '只能取服务端枚举：' + allowed.join(' / ') };
    return { ok: true, value: trimmed };
  }
  if (field.type === 'json') {
    if (trimmed === '') return field.required ? { ok: false, problem: field.label + '不能为空。' } : { ok: true, skip: true };
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { ok: false, problem: field.label + '不是合法 JSON：' + (error && error.message ? error.message : '') };
    }
    if (field.shape === 'object' && !isPlainObject(parsed)) return { ok: false, problem: field.label + '必须是 JSON 对象。' };
    if (field.shape === 'array' && !Array.isArray(parsed)) return { ok: false, problem: field.label + '必须是 JSON 数组。' };
    if (field.shape !== 'array' && !isPlainObject(parsed) && !Array.isArray(parsed)) return { ok: false, problem: field.label + '必须是 JSON 对象或数组。' };
    return { ok: true, value: parsed };
  }
  if (field.type === 'number') {
    if (trimmed === '') return field.required ? { ok: false, problem: field.label + '不能为空。' } : { ok: true, skip: true };
    if (!/^\d+$/.test(trimmed)) return { ok: false, problem: field.label + '必须是非负整数。' };
    return { ok: true, value: Number(trimmed) };
  }
  if (trimmed === '') return field.required ? { ok: false, problem: field.label + '不能为空。' } : { ok: true, skip: true };
  if (field.type === 'list') {
    const items = trimmed
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
    if (field.choices && items.some((item) => !field.choices.includes(item))) {
      return { ok: false, problem: field.label + '只能取：' + field.choices.join(' / ') };
    }
    if (items.length === 0) return field.required ? { ok: false, problem: field.label + '不能为空。' } : { ok: true, skip: true };
    return { ok: true, value: items };
  }
  return { ok: true, value: trimmed };
}

/** 预览类操作成功后展示返回值，并提供“继续下一步”的入口。 */
function showResultDialog(title, value, followUp) {
  const body = el('div', { class: 'dialogbody' });
  body.append(el('div', { class: 'card' }, el('h5', { text: '服务端返回' }), kvList([
    ['结果', el('code', { text: value && value.id ? String(value.id) : typeof value === 'object' ? '对象' : textOf(value) })],
  ]), renderJson(value, '完整返回值')));
  body.append(el('p', { class: 'muted small', text: '返回值是服务端真实结果；页面不做二次推断，也不替你确认。' }));
  const closeButton = el('button', { type: 'button', class: 'btn', text: '关闭' });
  const nextButton = followUp && value ? el('button', { type: 'button', class: 'btn btn-primary', text: followUp.label }) : null;
  let dialog = null;
  closeButton.addEventListener('click', () => {
    if (dialog) dialog.close();
  });
  if (nextButton) {
    nextButton.addEventListener('click', () => {
      if (dialog) dialog.close();
      openActionDialog(followUp.build(value));
    });
  }
  dialog = openDialog({
    title,
    subtitle: followUp ? '预览已完成；继续操作会携带服务端刚返回的令牌与指纹。' : '以下是服务端真实返回值，页面不做二次推断。',
    body,
    footer: el('div', { class: 'dialogfoot' }, closeButton, nextButton),
  });
}

function openActionDialog(options) {
  const action = String(options.action || '');
  const requireTarget = options.requiresTarget !== false;
  const target = options.record || null;
  const fields = Array.isArray(options.fields) ? options.fields : [];
  const targetKey = !requireTarget ? null : options.targetKey === null ? null : typeof options.targetKey === 'string' ? options.targetKey : 'id';
  const versionMode = options.versionMode || (requireTarget ? 'required' : 'none');
  const reasonMode = options.reasonMode || 'required';
  const followUp = options.resultFollowUp || null;
  const requestHolder = { id: newRequestId(), payloadHash: null };
  const refs = new Map();

  const body = el('div', { class: 'dialogbody' });


  if (requireTarget && target) {
    body.append(
      el(
        'div',
        { class: 'card' },
        el('h5', { text: '目标' }),
        kvList([
          ['类型', KIND_LABELS[String(target.kind || '')] || String(target.kind || '—')],
          ['记录 ID', el('code', { text: String(target.id || '—') })],
          ['当前版本', target.version === undefined || target.version === null ? '—' : String(target.version)],
          ['状态', String(target.status || '—')],
        ]),
      ),
    );
  }

  if (fields.length > 0) {
    const fieldBox = el('div', { class: 'stack' });
    for (const field of fields) fieldBox.append(buildField(field, refs, action === 'edit' ? target : null));
    body.append(el('div', { class: 'card' }, el('h5', { text: '参数' }), fieldBox));
  }

  let versionInput = null;
  if (requireTarget && versionMode === 'required') {
    const versionCard = el('div', { class: 'card' });
    versionCard.append(el('h5', { text: '版本' }));
    versionInput = el('input', {
      class: 'input',
      type: 'number',
      min: '0',
      step: '1',
      value: target && target.version !== undefined && target.version !== null ? String(target.version) : '',
    });
    versionCard.append(
      el('div', { class: 'fieldrow' }, el('span', { class: 'fieldlabel', text: 'expectedVersion（预期版本）' }), versionInput),
      el('p', { class: 'fieldhelp muted small', text: '默认取当前版本；服务端按此做并发校验，版本不符会拒绝而不是覆盖较新更改。' }),
    );
    body.append(versionCard);
  }

  let reasonInput = null;
  if (reasonMode === 'required' || reasonMode === 'optional') {
    reasonInput = el('textarea', { class: 'textarea' });
    reasonInput.style.minHeight = '70px';
    reasonInput.placeholder = reasonMode === 'required' ? '写明为什么做这次变更（必填）' : '可选的说明（会写入服务端审计/记录）';
    body.append(
      el(
        'div',
        { class: 'card' },
        el('h5', { text: reasonMode === 'required' ? '原因（必填）' : '原因（可选）' }),
        reasonInput,
        el('p', { class: 'muted small', text: '原因只写入服务端审计；具体判定结果写进上方真实字段，不写在这里。' }),
      ),
    );
  }

  const requestCode = el('code', { text: requestHolder.id });
  body.append(
    el(
      'div',
      { class: 'card' },
      el('h5', { text: '请求 ID' }),
      kvList([['requestId', requestCode]]),
      el('p', { class: 'muted small', text: '同一 requestId 重复提交按幂等处理；payload 变化时会自动换新 ID。' }),
    ),
  );

  if (options.consequence) {
    body.append(el('div', { class: 'dialogerror' }, el('span', { class: 'errortitle', text: '影响说明' }), el('p', { text: options.consequence })));
  }

  let confirmInput = null;
  if (options.confirmationText) {
    confirmInput = el('input', { class: 'input', type: 'text', placeholder: '输入“' + options.confirmationText + '”以确认' });
    body.append(
      el(
        'div',
        { class: 'card' },
        el('h5', { text: '二次确认' }),
        confirmInput,
        el('p', { class: 'muted small', text: '这是破坏性操作，需要手动输入“' + options.confirmationText + '”。' + (options.confirmFlag ? '界面输入只是本地校验，服务端仍要求 confirm:true。' : '') }),
      ),
    );
  }

  const problems = el('ul', { class: 'problems' });
  const errorBox = el('div', { class: 'dialogerror', hidden: true });
  body.append(problems, errorBox);

  const submitButton = el('button', { type: 'button', class: 'btn btn-primary', text: '提交变更' });
  const cancelButton = el('button', { type: 'button', class: 'btn', text: '取消' });
  let dialog = null;

  cancelButton.addEventListener('click', () => {
    if (dialog) dialog.close();
  });

  submitButton.addEventListener('click', async () => {
    problems.replaceChildren();
    errorBox.hidden = true;
    errorBox.replaceChildren();

    const payload = { requestId: requestHolder.id };
    if (reasonInput) {
      payload.reason = reasonInput.value.trim();
      if (reasonMode === 'required' && payload.reason === '') problems.append(el('li', { text: '原因不能为空。' }));
    }

    if (requireTarget) {
      if (target) {
        const targetId = String(target.id || '');
        if (targetId === '') problems.append(el('li', { text: '目标记录缺少 ID：目标不明确，已停止提交。' }));
        else if (targetKey) payload[targetKey] = targetId;
      } else {
        problems.append(el('li', { text: '没有明确目标记录，已停止提交。' }));
      }
    }

    if (requireTarget && versionMode === 'required') {
      const versionRaw = versionInput ? String(versionInput.value).trim() : '';
      if (versionRaw === '') problems.append(el('li', { text: 'expectedVersion 不能为空。' }));
      else if (!/^\d+$/.test(versionRaw)) problems.append(el('li', { text: 'expectedVersion 必须是非负整数。' }));
      else if (Number(versionRaw) < 1) problems.append(el('li', { text: 'expectedVersion 必须 >= 1（服务端要求当前记录版本）。' }));
      else payload.expectedVersion = Number(versionRaw);
    }

    for (const entry of refs.values()) {
      const outcome = readFieldValue(entry);
      if (!outcome.ok) {
        problems.append(el('li', { text: outcome.problem }));
        continue;
      }
      if (outcome.skip) continue;
      payload[entry.field.name] = outcome.value;
    }

    if (options.confirmFlag) payload.confirm = true;

    if (confirmInput) {
      if (String(confirmInput.value).trim() !== options.confirmationText) {
        problems.append(el('li', { text: '确认词不匹配：请输入“' + options.confirmationText + '”。' }));
      }
    }

    if (problems.children.length > 0) return;

    const hash = stableStringify(payload);
    if (requestHolder.payloadHash !== null && requestHolder.payloadHash !== hash) {      requestHolder.id = newRequestId();
      payload.requestId = requestHolder.id;
      requestCode.textContent = requestHolder.id;
    }
    requestHolder.payloadHash = stableStringify(payload);

    submitButton.disabled = true;
    cancelButton.disabled = true;
    submitButton.textContent = '提交中…';

    try {
      const result = await api.mutate(options.action, payload);
      if (action === 'candidate') {
        // evaluate 返回学习引擎的评估结果、pause/reject 返回更新后的记录：都原样展示，不做页面推断。
        if (dialog) dialog.close();
        showResultDialog(options.title || action, result.value, null);
        if (options.onDone) options.onDone(result.value);
        return;
      }
      if (dialog) dialog.close();
      if (followUp) {
        showResultDialog(options.title || action, result.value, followUp);
      } else {
        toast('已提交：' + (options.title || options.action), 'ok');
      }
      if (options.onDone) options.onDone(result.value);
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError(String(error && error.message ? error.message : error));
      errorBox.hidden = false;
      errorBox.replaceChildren(
        el('span', { class: 'errortitle', text: '服务端未接受本次变更 · ' + apiError.code }),
        el('p', { text: apiError.message }),
        apiError.details ? renderJson(apiError.details, '错误详情') : null,
      );
      if (apiError.code === 'transport') {
        submitButton.textContent = '重试提交';
      } else {
        requestHolder.payloadHash = null;
        submitButton.textContent = '修改后重新提交';
      }
      if (apiError.status === 409) {
        problems.append(el('li', { text: '版本冲突（HTTP 409）：服务端返回 currentVersion=' + textOf(apiError.details && apiError.details.currentVersion) + '，请刷新后按新版本重试。' }));
      }
      submitButton.disabled = false;
      cancelButton.disabled = false;
    }
  });

  dialog = openDialog({
    title: options.title || options.action,
    subtitle: options.description || '',
    body,
    footer: el('div', { class: 'dialogfoot' }, cancelButton, submitButton),
  });
}

function openCreateDialog(kinds, onDone) {
  const kindList = Array.isArray(kinds) ? kinds : [kinds];

  const kindField = {
    name: 'kind',
    label: '记录类型',
    type: 'select',
    options: kindList.map((kind) => ({ value: kind, label: KIND_LABELS[kind] || kind })),
    value: kindList[0],
    required: true,
  };
  const kindInput = el('select', { class: 'select', 'aria-label': '记录类型' });
  for (const option of kindField.options) kindInput.append(el('option', { value: option.value, text: option.label, selected: option.value === kindField.value }));
  const characterInput = el('input', { class: 'input', type: 'text', placeholder: '角色 ID', value: state.filter.characterId, 'aria-label': '角色 ID' });
  const [initialScopeKind, initialScopeId = ''] = state.filter.scopeKey.split(':');
  const scopeKindInput = el('select', { class: 'select', 'aria-label': '范围类别' });
  for (const [key, label] of [['group','群聊'],['private','私聊'],['profile','个人档案'],['character','角色级']]) scopeKindInput.append(el('option', { value: key, text: label }));
  scopeKindInput.value = ['group','private','profile','character'].includes(initialScopeKind) ? initialScopeKind : 'group';
  const scopeInput = el('input', { class: 'input', type: 'text', placeholder: '填写群号或 QQ 号', value: initialScopeId, 'aria-label': '群号或 QQ 号' });
  const subjectInput = el('input', { class: 'input', type: 'text', placeholder: '主体 QQ', value: state.filter.subjectQQ, 'aria-label': '主体 QQ' });
  const syncScope = () => {
    if (kindInput.value === 'character') scopeKindInput.value = 'character';
    if (kindInput.value === 'profile') { scopeKindInput.value = 'profile'; scopeInput.value = subjectInput.value.trim(); }
    scopeKindInput.disabled = ['character','profile'].includes(kindInput.value);
    scopeInput.disabled = scopeKindInput.value === 'character' || kindInput.value === 'profile';
  };
  scopeKindInput.addEventListener('change', syncScope);
  subjectInput.addEventListener('input', syncScope);
  syncScope();
  const editor = createRecordEditor(kindInput.value, {}, true);
  let editorKind = kindInput.value;
  kindInput.addEventListener('change', () => {
    if (editor.setKind(kindInput.value)) editorKind = kindInput.value;
    else kindInput.value = editorKind;
    syncScope();
  });
  const reasonInput = el('textarea', { class: 'textarea', 'aria-label': '创建原因' });
  reasonInput.style.minHeight = '70px';
  reasonInput.placeholder = '为什么创建这条记录（必填）';

  let createRequestId = newRequestId();
  let createPayloadHash = null;
  const requestLine = el('code', { text: createRequestId });

  const problems = el('ul', { class: 'problems' });
  const errorBox = el('div', { class: 'dialogerror', hidden: true });

  const body = el(
    'div',
    { class: 'dialogbody' },
    el(
      'div',
      { class: 'card' },
      el('h5', { text: '归属' }),
      el('div', { class: 'stack' }, [
        el('div', { class: 'fieldrow' }, el('span', { class: 'fieldlabel', text: '记录类型' }), kindInput),
        el('div', { class: 'fieldrow' }, el('span', { class: 'fieldlabel', text: '角色 ID（characterId）' }), characterInput),
        el('div', { class: 'fieldrow' }, el('span', { class: 'fieldlabel', text: '会话范围' }), el('div', { class: 'scope-fields' }, scopeKindInput, scopeInput)),
        el('div', { class: 'fieldrow' }, el('span', { class: 'fieldlabel', text: '主体 QQ（subjectQQ）' }), subjectInput),
        el('p', { class: 'muted small', text: '单一归属：一次只创建一条记录，不批量跨范围。范围写法 private:<QQ> / group:<群号> / profile:<QQ>。' }),
      ]),
    ),
    el(
      'div',
      { class: 'card' },
      el('h5', { text: '内容' }),
      editor.node,
    ),
    el(
      'div',
      { class: 'card' },
      el('h5', { text: '原因（必填）' }),
      reasonInput,
      el('p', { class: 'muted small', text: '会写入服务端审计。' }),
    ),
    el('div', { class: 'card' }, el('h5', { text: '请求 ID' }), kvList([['requestId', requestLine]]), el('p', { class: 'muted small', text: '同一次提交重试复用该 ID，服务端可按幂等处理。' })),
    problems,
    errorBox,
  );

  const submitButton = el('button', { type: 'button', class: 'btn btn-primary', text: '创建' });
  const cancelButton = el('button', { type: 'button', class: 'btn', text: '取消' });
  let dialog = null;
  cancelButton.addEventListener('click', () => {
    if (dialog) dialog.close();
  });

  submitButton.addEventListener('click', async () => {
    problems.replaceChildren();
    errorBox.hidden = true;
    errorBox.replaceChildren();

    const payload = {
      requestId: createRequestId,
      kind: kindInput.value,
      characterId: characterInput.value.trim(),
      scopeKey: scopeKindInput.value === 'character' ? 'character' : scopeKindInput.value + ':' + scopeInput.value.trim(),
      subjectQQ: subjectInput.value.trim(),
      reason: reasonInput.value.trim(),
    };

    if (payload.reason === '') problems.append(el('li', { text: '原因不能为空。' }));
    if (payload.characterId === '') problems.append(el('li', { text: '角色 ID 不能为空：服务端 create 始终要求 characterId。' }));
    if (payload.scopeKey === '') {
      problems.append(el('li', { text: '范围不能为空；角色 / 控制类记录填 character，其余填 private:<QQ> / group:<群号> / profile:<QQ>。' }));
    } else if (['character', 'control'].includes(payload.kind)) {
      if (payload.scopeKey !== 'character') problems.append(el('li', { text: '角色 / 控制类记录的 scopeKey 只能填 character。' }));
    } else if (!(payload.kind==='candidate' && payload.scopeKey==='character') && !/^(private|group|profile):[1-9]\d{0,19}$/.test(payload.scopeKey)) {
      problems.append(el('li', { text: '范围必须形如 private:<QQ> / group:<群号> / profile:<QQ>。' }));
    }
    if (payload.kind === 'profile' && (payload.subjectQQ === '' || payload.scopeKey !== 'profile:' + payload.subjectQQ)) {
      problems.append(el('li', { text: '个人档案须填主体 QQ，且范围为 profile:<该 QQ>。' }));
    }
    if (payload.kind === 'supplement' && (!payload.scopeKey.startsWith('group:') || payload.subjectQQ === '')) {
      problems.append(el('li', { text: '群内补充须填 group:<群号> 范围与成员 QQ。' }));
    }

    let dataValue;
    try {
      dataValue = editor.read();
    } catch (parseError) {
      problems.append(el('li', { text: '请检查内容：' + (parseError && parseError.message ? parseError.message : '') }));
    }
    if (dataValue !== undefined && !isPlainObject(dataValue)) problems.append(el('li', { text: 'data 必须是 JSON 对象。' }));
    if (
      dataValue !== undefined &&
      isPlainObject(dataValue) &&
      !['character', 'control'].includes(payload.kind) &&
      !['text', 'rule', 'summary', 'content'].some((key) => typeof dataValue[key] === 'string' && dataValue[key].trim() !== '')
    ) {
      problems.append(el('li', { text: '服务端要求非角色 / 控制类记录在 data 里给出 text / rule / summary / content 之一。' }));
    }
    if (problems.children.length > 0) return;
    payload.data = dataValue;

    // 同一 requestId 只对应一份 payload：内容变了就换新 ID，原样重试则复用（幂等）。
    const payloadHash = stableStringify(payload);
    if (createPayloadHash !== null && createPayloadHash !== payloadHash) {
      createRequestId = newRequestId();
      payload.requestId = createRequestId;
      requestLine.textContent = createRequestId;
    }
    createPayloadHash = stableStringify(payload);

    submitButton.disabled = true;
    cancelButton.disabled = true;
    submitButton.textContent = '创建中…';
    try {
      await api.mutate('create', payload);
      toast('已创建 ' + (KIND_LABELS[kindInput.value] || kindInput.value), 'ok');
      if (dialog) dialog.close();
      if (onDone) onDone();
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError(String(error && error.message ? error.message : error));
      errorBox.hidden = false;
      errorBox.replaceChildren(
        el('span', { class: 'errortitle', text: '创建失败 · ' + apiError.code }),
        el('p', { text: apiError.message }),
        apiError.details ? renderJson(apiError.details, '错误详情') : null,
      );
      submitButton.disabled = false;
      cancelButton.disabled = false;
      submitButton.textContent = '创建';
    }
  });

  dialog = openDialog({
    title: '新建记录',
    subtitle: '填写归属、内容和变更原因。个人档案范围为 profile:QQ，角色与人格候选范围为 character。',
    body,
    footer: el('div', { class: 'dialogfoot' }, cancelButton, submitButton),
  });
}

/* ------------------------------------------------------------------ */
/* 通用筛选栏                                                          */
/* ------------------------------------------------------------------ */

function buildFilterBar(onChange) {
  const bar = el('div', { class: 'filterbar' });

  const characterInput = el('input', {
    class: 'input',
    type: 'text',
    list: 'qqcm-character-options',
    placeholder: '角色 ID（留空=全部）',
  });
  bar.append(el('div', { class: 'field' }, el('span', { class: 'fieldlabel', text: '角色' }), characterInput));

  const scopeInput = el('input', {
    class: 'input',
    type: 'text',
    placeholder: '范围，如 group:123456',
  });
  bar.append(el('div', { class: 'field' }, el('span', { class: 'fieldlabel', text: '范围 scopeKey' }), scopeInput));

  const subjectInput = el('input', { class: 'input', type: 'text', placeholder: '主体 QQ' });
  bar.append(el('div', { class: 'field' }, el('span', { class: 'fieldlabel', text: '主体 QQ' }), subjectInput));

  const statusSelect = el('select', { class: 'select' });
  for (const value of FILTER_STATUSES) {
    statusSelect.append(el('option', { value, text: value === '' ? '全部状态' : STATUS_LABELS[value] || value }));
  }
  bar.append(el('div', { class: 'field' }, el('span', { class: 'fieldlabel', text: '状态' }), statusSelect));

  const limitSelect = el('select', { class: 'select' });
  for (const value of [20, 50, 100, 200]) limitSelect.append(el('option', { value: String(value), text: '每页 ' + value + ' 条' }));
  bar.append(el('div', { class: 'field' }, el('span', { class: 'fieldlabel', text: '每页' }), limitSelect));

  const searchInput = el('input', { class: 'input', type: 'search', placeholder: '服务端检索关键词' });
  bar.append(el('div', { class: 'field' }, el('span', { class: 'fieldlabel', text: '检索' }), searchInput));

  const collect = () => {
    state.filter.characterId = characterInput.value.trim();
    state.filter.scopeKey = scopeInput.value.trim();
    state.filter.subjectQQ = subjectInput.value.trim();
    state.filter.status = statusSelect.value;
    state.filter.search = searchInput.value.trim();
    state.filter.limit = Number(limitSelect.value);
  };

  const applyButton = el('button', { type: 'button', class: 'btn', text: '应用筛选' });
  applyButton.addEventListener('click', () => {
    collect();
    onChange();
  });

  const resetButton = el('button', { type: 'button', class: 'btn btn-ghost', text: '清空筛选' });
  resetButton.addEventListener('click', () => {
    state.filter = { characterId: '', scopeKey: '', subjectQQ: '', status: '', search: '', limit: state.filter.limit };
    sync();
    onChange();
  });

  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      collect();
      onChange();
    }
  });

  bar.append(el('div', { class: 'actions' }, applyButton, resetButton));
  bar.append(el('datalist', { id: 'qqcm-character-options' }));

  let lastSignature = null;

  /**
   * 把 state.filter 写回控件。只在筛选状态真的变化时改写，
   * 避免后台重渲染把用户正在输入的内容冲掉。
   */
  function sync() {
    const signature = JSON.stringify(state.filter) + '|' + state.characters.map((item) => item.id).join(',');
    if (signature === lastSignature) return;
    lastSignature = signature;
    characterInput.value = state.filter.characterId;
    scopeInput.value = state.filter.scopeKey;
    subjectInput.value = state.filter.subjectQQ;
    statusSelect.value = state.filter.status;
    limitSelect.value = String(state.filter.limit);
    searchInput.value = state.filter.search;
    const datalist = bar.querySelector('datalist');
    if (datalist) {
      datalist.replaceChildren();
      for (const item of state.characters) datalist.append(el('option', { value: item.id, label: item.name || item.id }));
    }
  }

  sync();
  return { node: bar, sync };
}

function filterPayload(kind) {
  const payload = { kind, limit: state.filter.limit };
  if (state.filter.characterId) payload.characterId = state.filter.characterId;
  if (state.filter.scopeKey) payload.scopeKey = state.filter.scopeKey;
  if (state.filter.subjectQQ) payload.subjectQQ = state.filter.subjectQQ;
  if (state.filter.status) payload.status = state.filter.status.includes(',') ? state.filter.status.split(',') : state.filter.status;
  if (state.filter.search) payload.search = state.filter.search;
  return payload;
}

/* ------------------------------------------------------------------ */
/* 通用列表视图                                                        */
/* ------------------------------------------------------------------ */

function makeList(config) {
  return {
    id: config.id,
    label: config.label,
    mount(container) {
      let kind = config.kinds.some(item => item.kind === state.tab) ? state.tab : config.kinds[0].kind;
      let rows = [];
      let next = null;
      let cursorStack = [null];
      let cursorIndex = 0;
      let loading = false;
      /** 加载中收到的下一次请求：重置游标或按当前筛选重读。 */
      let pending = null;
      let error = null;
      let loadedOnce = false;
      let disposed = false;

      const root = el('div', { class: 'stack' });
      /** 三段固定槽位：筛选栏节点常驻，重渲染只替换头尾，避免打断输入与焦点。 */
      const headSlot = el('div');
      const listSlot = el('div', { class: 'stack' });
      /** 筛选栏只建一次。 */
      const filterBar = buildFilterBar(() => resetAndLoad());
      root.append(headSlot, filterBar.node, listSlot);
      container.append(root);

      function resetAndLoad() {
        if (loading) {
          pending = 'reset';
          return;
        }
        cursorStack = [null];
        cursorIndex = 0;
        rows = [];
        next = null;
        loadedOnce = false;
        load();
      }

      function reloadCurrent() {
        if (loading) {
          pending = pending === 'reset' ? 'reset' : 'current';
          return;
        }
        load();
      }

      /** 详情抽屉与刷新按钮用的入口：保持当前页与筛选。 */
      const reload = () => reloadCurrent();

      async function load() {
        if (disposed) return;
        if (loading) {
          pending = pending === 'reset' ? 'reset' : 'current';
          return;
        }
        loading = true;
        error = null;
        render();
        const payload = filterPayload(kind);
        const after = cursorIndex > 0 ? cursorStack[cursorIndex] : undefined;
        if (after !== undefined && after !== null) payload.after = after;
        try {
          const result = await api.query(payload);
          const value = result.value;
          if (!isPlainObject(value) || !Array.isArray(value.rows)) {
            throw new ApiError('query 返回的 value 不是 {rows,next} 结构，页面不猜测数据。', { code: 'bad-contract', details: value });
          }
          rows = value.rows;
          next = value.next === undefined ? null : value.next;
          loadedOnce = true;
        } catch (requestError) {
          rows = [];
          next = null;
          error = requestError instanceof ApiError ? requestError : new ApiError(String(requestError && requestError.message ? requestError.message : requestError));
        }
        loading = false;
        if (disposed) return;
        render();
        if (pending !== null) {
          const nextAction = pending;
          pending = null;
          if (nextAction === 'reset') resetAndLoad();
          else reloadCurrent();
        }
      }

      function gotoNext() {
        if (next === null || loading) return;
        if (cursorIndex + 1 < cursorStack.length) cursorStack = cursorStack.slice(0, cursorIndex + 1);
        cursorStack.push(next);
        cursorIndex += 1;
        load();
      }

      function gotoPrev() {
        if (cursorIndex === 0 || loading) return;
        cursorIndex -= 1;
        load();
      }

      function render() {
        if (disposed) return;
        headSlot.replaceChildren();
        listSlot.replaceChildren();

        const head = el(
          'div',
          { class: 'pagehead' },
          el('div', null, el('h2', { text: config.title || config.label }), el('p', { class: 'muted small', text: config.description || '' })),
          el(
            'div',
            { class: 'pagehead-actions' },
            el('button', { type: 'button', class: 'btn', text: '刷新', onclick: reload }),
            config.createKind
              ? el('button', { type: 'button', class: 'btn btn-primary', text: '新建记录', onclick: () => openCreateDialog(config.createKind, resetAndLoad) })
              : null,
          ),
        );
        headSlot.append(head);

        if (Array.isArray(config.notices) && config.notices.length > 0) {
          headSlot.append(el('ul', { class: 'notices' }, config.notices.map((text) => el('li', { text }))));
        }

        if (config.kinds.length > 1) {
          const tabs = el('div', { class: 'tabs' });
          for (const item of config.kinds) {
            const button = el('button', {
              type: 'button',
              class: 'tab' + (item.kind === kind ? ' is-active' : ''),
              text: item.label,
            });
            button.addEventListener('click', () => {
              if (kind === item.kind) return;
              kind = item.kind;
              state.tab = kind;
              window.location.hash = state.view + '/' + kind;
              resetAndLoad();
            });
            tabs.append(button);
          }
          headSlot.append(tabs);
        }

        filterBar.sync();

        if (error) {
          listSlot.append(
            el(
              'div',
              { class: 'errorbox' },
              el('span', { class: 'errortitle', text: '查询失败 · ' + (error.code || 'unknown') }),
              el('p', { text: error.message }),
              error.status ? el('p', { class: 'muted small', text: 'HTTP ' + error.status }) : null,
              error.details ? renderJson(error.details, '错误详情') : null,
              el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn', text: '重试', onclick: reload })),
            ),
          );
          return;
        }

        if (loading && !loadedOnce) {
          listSlot.append(el('p', { class: 'muted small', text: '正在读取服务端记录…' }));
          return;
        }

        if (!loading && rows.length === 0) {
          listSlot.append(
            el(
              'div',
              { class: 'empty' },
              el('p', { text: '当前筛选下没有记录。' }),
              el('p', { class: 'muted small', text: '这是服务端的真实结果，不是占位内容。' }),
            ),
          );
          listSlot.append(
            el(
              'div',
              { class: 'pager' },
              el('span', { class: 'muted', text: '本页 0 条 · 第 1 页' }),
              el('button', { type: 'button', class: 'btn', text: '上一页', disabled: true }),
              el('button', { type: 'button', class: 'btn', text: '下一页', disabled: true }),
              el('span', { class: 'cursor', text: '服务端没有返回记录，也没有可用的 next 游标。' }),
            ),
          );
          if (config.afterList) listSlot.append(config.afterList({ rows, reload }));
          return;
        }

        const table = el('table', { class: 'grid' });
        const headRow = el('tr');
        for (const column of config.columns) headRow.append(el('th', { text: column.label }));
        table.append(el('thead', null, headRow));

        const tbody = el('tbody');
        for (const row of rows) {
          const tr = el('tr', { tabindex: '0' });
          for (const column of config.columns) {
            const cell = el('td');
            const content = column.cell(row);
            if (content instanceof Node) cell.append(content);
            else cell.textContent = content === undefined || content === null ? '—' : String(content);
            if (column.wrap) cell.className = 'wrap';
            tr.append(cell);
          }
          const open = () => openDrawer(row, { siblings: rows, onChanged: reload });
          tr.addEventListener('click', open);
          tr.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              open();
            }
          });
          tbody.append(tr);
        }
        table.append(tbody);
        listSlot.append(el('div', { class: 'tablescroll' }, table));

        const pager = el(
          'div',
          { class: 'pager' },
          el('span', { class: 'liststatus muted', text: loading ? '正在加载…' : '本页 ' + rows.length + ' 条 · 第 ' + (cursorIndex + 1) + ' 页' }),
          el('button', { type: 'button', class: 'btn', text: '上一页', disabled: cursorIndex === 0 || loading, onclick: gotoPrev }),
          el('button', { type: 'button', class: 'btn', text: '下一页', disabled: next === null || loading, onclick: gotoNext }),
          el('span', { class: 'cursor', text: next === null ? '服务端未返回 next：没有更多记录。' : '服务端返回了 next，可继续翻页。' }),
        );
        if (cursorIndex > 0) pager.append(el('span', { class: 'cursor', text: '游标 after=' + String(cursorStack[cursorIndex]) }));
        listSlot.append(pager);

        if (config.afterList) listSlot.append(config.afterList({ rows, reload }));
      }

      load();
      return {
        dispose() {
          disposed = true;
          root.remove();
        },
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* 视图：概览                                                          */
/* ------------------------------------------------------------------ */

function buildDashboard() {
  const value = isPlainObject(state.status.value) ? state.status.value : {};
  const counts = Array.isArray(value.counts) ? value.counts : null;
  const total = (kinds, statuses) => counts === null ? null : counts.filter(row => kinds.includes(row.kind) && statuses.includes(row.status)).reduce((sum, row) => sum + Number(row.count), 0);
  const root = el('div', { class: 'dashboard stack' });
  root.append(el('div', { class: 'dashboard-caption' },
    el('span', { text: '全部角色与会话 · 状态快照' }),
    el('span', { text: value.updatedAt ? '读取于 ' + formatTime(value.updatedAt) : '尚未取得状态数据' }),
  ));
  const metrics = el('div', { class: 'metric-grid' });
  for (const item of [
    { label: '已启用记忆', kinds: ['memory'], statuses: ['active'], view: 'memory', kind: 'memory', status: 'active', detail: '查看已启用的记忆资料' },
    { label: '待确认记忆', kinds: ['memory'], statuses: ['pending'], view: 'memory', kind: 'memory', status: 'pending', detail: '核对原文，再确认启用' },
    { label: '试用中的候选', kinds: ['candidate'], statuses: ['trial'], view: 'candidate', kind: 'candidate', status: 'trial', detail: '跟踪证据与实际应用' },
    { label: '未解决冲突', kinds: ['conflict'], statuses: ['active','pending'], view: 'conflict', kind: 'conflict', status: 'active,pending', detail: '保留来源，明确适用情境' },
  ]) {
    const count = total(item.kinds, item.statuses);
    metrics.append(el('button', { type: 'button', class: 'metric-card', onclick: () => navigate(item.view, { kind: item.kind, filter: { characterId: '', scopeKey: '', subjectQQ: '', status: item.status } }) },
      el('span', { class: 'metric-label', text: item.label }),
      el('strong', { class: 'metric-value', text: count === null ? '—' : String(count) }),
      el('span', { class: 'metric-detail', text: count === null ? '状态数据未提供，点击查询' : item.detail }),
    ));
  }
  root.append(metrics);
  const columns = el('div', { class: 'dashboard-columns' });
  const todo = el('section', { class: 'card' }, el('h3', { text: '接下来处理' }), el('p', { class: 'muted small', text: '从记录出发，逐条核对和管理。' }));
  for (const item of [
    { label: '核验实际发送', detail: '对照发送原文确认候选是否被应用', count: total(['application'],['pending']), view: 'candidate', kind: 'application', status: 'pending' },
    { label: '整理旧数据归属', detail: '为隔离材料确认角色与会话范围', count: total(['memory'],['quarantine']), view: 'memory', kind: 'memory', status: 'quarantine' },
    { label: '查看召回来源', detail: '查看最近装配的记忆、预算与省略原因', count: null, view: 'recall', kind: 'recall', status: '' },
  ]) todo.append(el('button', { type: 'button', class: 'task-link', onclick: () => navigate(item.view, { kind: item.kind, filter: { characterId: '', scopeKey: '', subjectQQ: '', status: item.status } }) },
    el('span', {}, el('strong', { text: item.label }), el('span', { class: 'muted small', text: item.detail })),
    el('span', { class: 'chip', text: item.count === null ? '查看' : String(item.count) }),
  ));
  const features = el('section', { class: 'card' }, el('h3', { text: '能力状态' }), el('p', { class: 'muted small', text: '配置来自当前实例；调整开关请使用 DSH 插件配置。' }));
  const flags = el('div', { class: 'feature-grid' });
  for (const [key, label] of [['capture','消息采集'],['recall','记忆召回'],['learning','候选学习'],['trial','有限试用'],['autoAdopt','自动采纳']]) {
    const enabled = value.features?.[key];
    flags.append(el('div', { class: 'feature-row' }, el('span', { text: label }), el('span', { class: 'chip ' + (enabled === true ? 'is-ok' : 'is-off'), text: enabled === true ? '已开启' : enabled === false ? '已关闭' : '未知' })));
  }
  features.append(flags);
  const actions = el('div', { class: 'actions' });
  for (const [kind, label] of [['memory','新建记忆'],['profile','新建个人档案'],['character','新建角色']]) actions.append(el('button', { type: 'button', class: 'btn' + (kind === 'memory' ? ' btn-primary' : ''), text: label, onclick: () => openCreateDialog([kind], async () => { await loadStatus(); await loadCharacters(); if (state.view === 'overview') renderView(); }) }));
  features.append(actions);
  columns.append(todo, features);
  root.append(columns);
  return root;
}

function createOverviewView() {
  return {
    id: 'overview',
    label: '概览与状态',
    mount(container) {
      const root = el('div', { class: 'stack' });
      container.append(root);

      const render = () => {
        root.replaceChildren();
        root.append(
          el(
            'div',
            { class: 'pagehead' },
            el(
              'div',
              null,
              el('div', { class: 'eyebrow', text: 'MEMORY WORKSPACE' }),
              el('h2', { text: '把每一段相处，整理成有依据的记忆。' }),
              el('p', { class: 'muted', text: '查看资料、处理待确认内容，跟踪角色的学习与成长。' }),
            ),
            el(
              'div',
              { class: 'pagehead-actions' },
              el('button', {
                type: 'button',
                class: 'btn',
                text: '重新读取状态',
                onclick: async () => {
                  await loadStatus();
                  await loadCharacters();
                  render();
                },
              }),
            ),
          ),
        );
        root.append(buildDashboard());

        const statusCard = el('details', { class: 'card status-details' }, el('summary', { text: '连接状态与详细配置' }));
        statusCard.append(el('h3', { text: '服务端状态' }));

        if (state.status.phase === 'loading') {
          statusCard.append(el('p', { class: 'muted small', text: '正在读取…' }));
        } else if (state.status.error) {
          statusCard.append(
            el('p', { text: (state.status.summary && state.status.summary.label) + '：' + (state.status.summary && state.status.summary.detail) }),
            el('p', {
              class: 'muted small',
              text: 'error code=' + state.status.error.code + (state.status.error.status ? '，HTTP ' + state.status.error.status : ''),
            }),
            state.status.error.details ? renderJson(state.status.error.details, '错误详情') : null,
            el('p', { class: 'muted small', text: '未配置、已停用、失败、未知是不同状态；页面不会把读取失败显示成“正常”。' }),
          );
        } else if (state.status.value === null) {
          statusCard.append(el('p', { text: 'status 成功返回，但没有 value。' }));
        } else {
          statusCard.append(el('p', { class: 'muted small', text: state.status.summary ? state.status.summary.detail : '' }));
          const value = state.status.value;
          if (isPlainObject(value)) {
            const scalarRows = [];
            const nested = [];
            for (const key of Object.keys(value)) {
              const item = value[key];
              if (isPlainObject(item) || Array.isArray(item)) nested.push([key, item]);
              else scalarRows.push([key, textOf(item) === '' ? '—' : textOf(item)]);
            }
            if (scalarRows.length > 0) {
              statusCard.append(kvList(scalarRows.map(([label, text]) => [label, el('span', { class: 'text', text })])));
            }
            for (const [key, item] of nested) {
              statusCard.append(el('div', { style: { height: '8px' } }), renderJson(item, key + '（展开）'));
            }
          } else {
            statusCard.append(renderJson(value, 'status value'));
          }
        }
        root.append(statusCard);

        const jump = el('div', { class: 'card' });
        jump.append(el('h3', { text: '常用入口' }), el('p', { class: 'muted small', text: '每个入口都对应真实查询；没有数据时显示空结果或服务端错误。' }));
        const grid = el('div', { class: 'actions', style: { marginTop: '8px' } });
        for (const [id, label] of [
          ['memory', '记忆与原文'],
          ['archive', '日期归档'],
          ['profile', '个人档案'],
          ['supplement', '群内补充'],
          ['share', '共享源'],
          ['candidate', '候选与试用'],
          ['conflict', '冲突与反馈'],
          ['personality', '人格与回退'],
          ['recall', '召回记录'],
          ['usage', '用量'],
          ['audit', '审计'],
          ['backup', '备份与恢复'],
          ['import', '导入'],
          ['takeover', '接管准备'],
          ['system', '系统记录'],
        ]) {
          grid.append(
            el('button', {
              type: 'button',
              class: 'btn',
              text: label,
              onclick: () => {
                navigate(id);
              },
            }),
          );
        }
        jump.append(grid);
        root.append(jump);

        root.append(
          el(
            'div',
            { class: 'card' },
            el('h3', { text: '使用边界（简短版）' }),
            el(
              'ul',
              { class: 'notices', style: { marginBottom: '0' } },
              el('li', { text: '备份默认保留 14 天：保留期内已删除的原文仍可能存在于备份中，恢复会让它们复活。' }),
              el('li', { text: '旧 fish-memory 按 DSH Session.id 合并历史会话记忆，归属不可靠；无法确认归属的旧数据只能进入待确认区。' }),
              el('li', { text: 'DSH 旧会话里已经装配好的上下文快照不会被追溯撤回；停用或纠正从下一次装配前生效。' }),
              el('li', { text: '本页不测试模型、不调用模型：学习与采纳结果只来自服务端已记录的数据。' }),
              el('li', { text: '目标不明确的纠正不会被扩成“整批停用”，必须逐条指定记录 ID 与版本后提交。' }),
            ),
          ),
        );
      };

      render();
      return {
        dispose() {
          root.remove();
        },
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* 视图：记忆与原文                                                    */
/* ------------------------------------------------------------------ */

function createMemoryView() {
  return makeList({
    id: 'memory',
    label: '记忆与原文',
    title: '记忆与原文',
    description: '记忆是提炼结果，原文是原始材料。淡化不等于删除；原文保留至用户删除。隔离（quarantine）材料先分配归属再启用。',
    kinds: [
      { kind: 'memory', label: '记忆' },
      { kind: 'event', label: '原文' },
    ],
    createKind: ['memory'],
    notices: ['记忆按来源与重要性参与召回，普通经历随时间淡化但不会被批量清空。', '引用、转发、机器人输出与重复注入不构成新的独立证据。', 'status=quarantine 的记录来自旧数据导入，只能先分配角色与范围（分配后为 disabled），再人工启用。'],
    columns: [
      { label: '内容', wrap: true, cell: (row) => clip(pickText(row.data, ['text', 'content', 'summary', 'statement', 'rule']) || '（无正文）', 220) },
      { label: '重要性', cell: (row) => pickText(row.data, ['importance']) || '—' },
      { label: '角色', cell: (row) => row.characterId || '—' },
      { label: '范围', wrap: true, cell: (row) => row.scopeKey || '—' },
      { label: '主体', cell: (row) => row.subjectQQ || '—' },
      { label: '状态', cell: (row) => statusChip(row.status) },
      { label: '版本', cell: (row) => (row.version === undefined ? '—' : String(row.version)) },
      { label: '时间', cell: (row) => formatTime(isPlainObject(row.data) ? row.data.occurredAt || row.createdAt : row.createdAt) },
    ],
  });
}

/* ------------------------------------------------------------------ */
/* 视图：日期归档                                                      */
/* ------------------------------------------------------------------ */

function createArchiveView() {
  return {
    id: 'archive',
    label: '日期归档',
    mount(container) {
      /** 已加载的每一页原始行；上一页只是回看已读页，不重复请求。 */
      let pages = [];
      let cursors = [null];
      let pageIndex = 0;
      let next = null;
      let loading = false;
      let pending = null;
      let error = null;
      let loadedOnce = false;
      let disposed = false;
      const expanded = new Set();

      const root = el('div', { class: 'stack' });
      /** 三段固定槽位：筛选栏节点常驻，重渲染只替换头尾。 */
      const headSlot = el('div');
      const listSlot = el('div', { class: 'stack' });
      const filterBar = buildFilterBar(() => resetAndLoad());
      root.append(headSlot, filterBar.node, listSlot);
      container.append(root);

      function visibleRows() {
        const merged = [];
        for (let index = 0; index <= pageIndex && index < pages.length; index += 1) {
          for (const row of pages[index]) merged.push(row);
        }
        return merged;
      }

      function resetAndLoad() {
        if (loading) {
          pending = 'reset';
          return;
        }
        pages = [];
        cursors = [null];
        pageIndex = 0;
        next = null;
        loadedOnce = false;
        load();
      }

      async function load() {
        if (disposed) return;
        if (loading) {
          pending = pending === 'reset' ? 'reset' : 'current';
          return;
        }
        loading = true;
        error = null;
        render();
        const payload = filterPayload('memory');
        const after = pageIndex > 0 ? cursors[pageIndex] : undefined;
        if (after !== undefined && after !== null) payload.after = after;
        try {
          const result = await api.query(payload);
          const value = result.value;
          if (!isPlainObject(value) || !Array.isArray(value.rows)) {
            throw new ApiError('query 返回的 value 不是 {rows,next} 结构。', { code: 'bad-contract', details: value });
          }
          pages[pageIndex] = value.rows;
          // 翻页后若服务端返回更少的页，丢掉之后的旧页，避免拼出过期内容。
          pages = pages.slice(0, pageIndex + 1);
          next = value.next === undefined ? null : value.next;
          loadedOnce = true;
        } catch (requestError) {
          error = requestError instanceof ApiError ? requestError : new ApiError(String(requestError && requestError.message ? requestError.message : requestError));
        }
        loading = false;
        if (disposed) return;
        render();
        if (pending !== null) {
          const action = pending;
          pending = null;
          if (action === 'reset') resetAndLoad();
          else load();
        }
      }

      function render() {
        if (disposed) return;
        headSlot.replaceChildren();
        listSlot.replaceChildren();

        headSlot.append(
          el(
            'div',
            { class: 'pagehead' },
            el(
              'div',
              null,
              el('h2', { text: '记忆日期归档' }),
              el('p', {
                class: 'muted small',
                text: '按 Asia/Shanghai 来源日期分组和显示时间。导出仅包含当前已加载记录，文件标明是否仍有后续页面。',
              }),
            ),
            el('div', { class: 'pagehead-actions' }, el('button', { type: 'button', class: 'btn', text: '重新读取', onclick: resetAndLoad }),el('button',{type:'button',class:'btn',text:'导出已加载记录',disabled:loading||!loadedOnce,onclick:()=>{
              const records=visibleRows()
              const payload={schemaVersion:1,timeZone:'Asia/Shanghai',exportedAt:new Date().toISOString(),filter:{...state.filter},partial:next!==null||pageIndex<pages.length-1,next,records}
              const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json;charset=utf-8'}))
              const link=el('a',{href:url,download:'qq-memory-archive-'+dayKey(new Date().toISOString())+'.json'})
              document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),0)
            }})),
          ),
        );
        filterBar.sync();

        if (error) {
          listSlot.append(
            el(
              'div',
              { class: 'errorbox' },
              el('span', { class: 'errortitle', text: '归档读取失败 · ' + (error.code || 'unknown') }),
              el('p', { text: error.message }),
              error.details ? renderJson(error.details, '错误详情') : null,
              el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn', text: '重试', onclick: resetAndLoad })),
            ),
          );
          return;
        }

        if (loading && !loadedOnce) {
          listSlot.append(el('p', { class: 'muted small', text: '正在读取…' }));
          return;
        }

        const rows = visibleRows();
        const groups = new Map();
        for (const row of rows) {
          const data = isPlainObject(row.data) ? row.data : {};
          const key = dayKey(data.occurredAt || row.createdAt);
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(row);
        }

        if (groups.size === 0) {
          listSlot.append(el('div', { class: 'empty' }, el('p', { text: '当前筛选下没有记忆记录。' })));
        } else {
          const list = el('div', { class: 'archive' });
          const keys = Array.from(groups.keys()).sort((a, b) => String(b).localeCompare(String(a)));
          for (const key of keys) {
            const items = groups.get(key);
            const details = el('details', { class: 'daygroup', open: expanded.has(key) ? true : null });
            details.addEventListener('toggle', () => {
              if (details.open) expanded.add(key);
              else expanded.delete(key);
            });
            details.append(
              el(
                'summary',
                null,
                el('span', { class: 'day', text: key || '日期未知' }),
                el('span', { class: 'muted small', text: items.length + ' 条' }),
              ),
            );
            const body = el('div', { class: 'stack', style: { gap: '6px', marginTop: '6px' } });
            for (const row of items) {
              const data = isPlainObject(row.data) ? row.data : {};
              const item = el(
                'div',
                { class: 'card', style: { margin: '0', padding: '10px 12px', cursor: 'pointer' } },
                el(
                  'div',
                  { class: 'chips', style: { marginBottom: '4px' } },
                  statusChip(row.status),
                  el('span', { class: 'chip', text: '重要性 ' + (pickText(data, ['importance']) || '未标注') }),
                ),
                el('p', {
                  style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
                  text: clip(pickText(data, ['text', 'summary', 'content', 'statement']) || '（无正文）', 600),
                }),
                el('p', { class: 'muted small', text: (row.characterId || '—') + ' · ' + (row.scopeKey || '—') + ' · v' + (row.version ?? '?') }),
              );
              item.addEventListener('click', () => openDrawer(row, { siblings: rows, onChanged: resetAndLoad }));
              body.append(item);
            }
            details.append(body);
            list.append(details);
          }
          listSlot.append(list);
        }

        const pager = el(
          'div',
          { class: 'pager' },
          el('span', { class: 'muted', text: '已加载 ' + rows.length + ' 条 · 第 ' + (pageIndex + 1) + ' 页' }),
          el('button', {
            type: 'button',
            class: 'btn',
            text: '上一页',
            disabled: pageIndex === 0 || loading,
            onclick: () => {
              if (loading) return;
              pageIndex -= 1;
              next = pageIndex + 1 < cursors.length ? cursors[pageIndex + 1] : null;
              render();
            },
          }),
          el('button', {
            type: 'button',
            class: 'btn',
            text: '加载下一页',
            disabled: next === null || loading,
            onclick: () => {
              if (loading || next === null) return;
              cursors[pageIndex + 1] = next;
              pageIndex += 1;
              load();
            },
          }),
          el('span', {
            class: 'cursor',
            text: next === null ? '服务端未返回 next：没有更多记录。' : '继续加载会追加已读记录；上一页只回看已读页，不重复请求。',
          }),
        );
        listSlot.append(pager);
      }

      load();
      return {
        dispose() {
          disposed = true;
          root.remove();
        },
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* 视图：个人档案 / 群内补充 / 共享源                                   */
/* ------------------------------------------------------------------ */

function createProfileView() {
  return makeList({
    id: 'profile',
    label: '个人档案',
    title: '个人档案（跨群共享的“认识”）',
    description: '同一角色 + 同一 QQ 的已确认称呼与事实、共同经历摘要、有来源的印象。私聊默认独立，只有显式共享的条目才进入个人档案传播。',
    kinds: [{ kind: 'profile', label: '个人档案' }],
    createKind: ['profile'],
    columns: [
      { label: '主体 QQ', cell: (row) => row.subjectQQ || '—' },
      { label: '可见性', cell: (row) => row.data.visibility === 'public-profile' ? '同角色跨群认识' : row.data.visibility === 'private' ? '私有' : '未标记（请编辑确认来源）' },
      { label: '内容', wrap: true, cell: (row) => clip(pickText(row.data, ['summary', 'content', 'text', 'impression', 'note']) || '（无摘要）', 220) },
      { label: '角色', cell: (row) => row.characterId || '—' },
      { label: '范围', wrap: true, cell: (row) => row.scopeKey || '—' },
      { label: '来源', cell: (row) => (Array.isArray(isPlainObject(row.data) ? row.data.sourceIds : null) ? String(row.data.sourceIds.length) + ' 条引用' : '—') },
      { label: '状态', cell: (row) => statusChip(row.status) },
      { label: '版本', cell: (row) => (row.version === undefined ? '—' : String(row.version)) },
      { label: '更新', cell: (row) => formatTime(row.updatedAt) },
    ],
  });
}

function createSupplementView() {
  return makeList({
    id: 'supplement',
    label: '群内补充',
    title: '群成员补充（群内差异）',
    description: '当地身份、群昵称、玩笑、关系和互动背景保留在群成员补充中，不随个人档案跨群扩散。',
    kinds: [{ kind: 'supplement', label: '群内补充' }],
    createKind: ['supplement'],
    columns: [
      { label: '群/范围', wrap: true, cell: (row) => row.scopeKey || '—' },
      { label: '主体 QQ', cell: (row) => row.subjectQQ || '—' },
      { label: '内容', wrap: true, cell: (row) => clip(pickText(row.data, ['summary', 'content', 'text', 'nickname', 'impression']) || '（无摘要）', 220) },
      { label: '角色', cell: (row) => row.characterId || '—' },
      { label: '状态', cell: (row) => statusChip(row.status) },
      { label: '版本', cell: (row) => (row.version === undefined ? '—' : String(row.version)) },
      { label: '更新', cell: (row) => formatTime(row.updatedAt) },
    ],
  });
}

function createShareView() {
  return makeList({
    id: 'share',
    label: '共享源',
    title: '共享引用',
    description: '共享保存源记录与目标范围，检索时复核源状态。源被禁用、删除或撤销共享后，关联端停止使用；新条目不自动扩大共享。',
    kinds: [{ kind: 'share', label: '共享引用' }],
    notices: ['共享检索、跨群读取与重复注入不增加学习证据。'],
    columns: [
      {
        label: '源记录',
        wrap: true,
        cell: (row) => {
          const data = isPlainObject(row.data) ? row.data : {};
          const sourceId = data.sourceId || (Array.isArray(data.sourceIds) ? data.sourceIds[0] : '');
          return sourceId ? String(sourceId) : '—';
        },
      },
      {
        label: '字段',
        wrap: true,
        cell: (row) => {
          const fields = isPlainObject(row.data) ? row.data.fields : null;
          if (Array.isArray(fields)) return fields.join(', ') || '—';
          if (typeof fields === 'string') return fields;
          return '—';
        },
      },
      {
        label: '目标范围',
        wrap: true,
        cell: (row) => {
          const data = isPlainObject(row.data) ? row.data : {};
          return textOf(data.targetScope || data.target || row.scopeKey) || '—';
        },
      },
      { label: '角色', cell: (row) => row.characterId || '—' },
      { label: '主体', cell: (row) => row.subjectQQ || '—' },
      { label: '状态', cell: (row) => statusChip(row.status) },
      { label: '更新', cell: (row) => formatTime(row.updatedAt) },
    ],
  });
}

/* ------------------------------------------------------------------ */
/* 视图：候选 / 试用 / 证据 / 应用                                     */
/* ------------------------------------------------------------------ */

function createCandidateView() {
  return makeList({
    id: 'candidate',
    label: '候选与试用',
    title: '候选、试用与证据',
    description: '候选经去重、冲突检查后进入有限试用；S1–S6 条件由服务端策略校验，页面不代替策略放行，也不把模型自评分当概率。',
    kinds: [
      { kind: 'candidate', label: '候选' },
      { kind: 'trial', label: '试用' },
      { kind: 'evidence', label: '证据' },
      { kind: 'application', label: '实际应用' },
    ],
    createKind: ['candidate'],
    notices: ['独立证据至少 4 个、跨 3 个日期、试用至少 3 天、实际应用至少 2 次；注入不等于应用。', '机器人输出、纯引用转发、重复注入与同一段连续交流都不增加证据单位；引用后新增的自有正文可作为材料。', '可评估、暂停、驳回或恢复候选；试用与采纳由学习引擎按条件自行推进。'],
    columns: [
      {
        label: '类型',
        cell: (row) => {
          const type = pickText(row.data, ['type']);
          return type || KIND_LABELS[row.kind] || row.kind || '—';
        },
      },
      { label: '规则/内容', wrap: true, cell: (row) => clip(pickText(row.data, ['rule', 'text', 'summary', 'content', 'statement']) || '（无描述）', 220) },
      {
        label: '证据数',
        cell: (row) => {
          const data = isPlainObject(row.data) ? row.data : {};
          const ids = Array.isArray(data.evidenceIds) ? data.evidenceIds : Array.isArray(data.frozenEvidenceIds) ? data.frozenEvidenceIds : null;
          return ids ? String(ids.length) : '—';
        },
      },
      { label: '范围', wrap: true, cell: (row) => row.scopeKey || '—' },
      { label: '主体', cell: (row) => row.subjectQQ || '—' },
      { label: '状态', cell: (row) => statusChip(row.status) },
      { label: '试用开始', cell: (row) => formatTime(isPlainObject(row.data) ? row.data.trialStartedAt : null) },
      { label: '采纳时间', cell: (row) => formatTime(isPlainObject(row.data) ? row.data.acceptedAt : null) },
    ],
  });
}

/* ------------------------------------------------------------------ */
/* 视图：冲突与反馈                                                    */
/* ------------------------------------------------------------------ */

function createConflictView() {
  return makeList({
    id: 'conflict',
    label: '冲突与反馈',
    title: '冲突与反馈',
    description: '双方来源并存、进入冲突管理，不静默覆盖；feedback 记录只读查看（可编辑原文或停用），对候选与记忆的反馈在那些记录的详情里登记。',
    kinds: [
      { kind: 'conflict', label: '冲突' },
      { kind: 'feedback', label: '反馈' },
    ],
    notices: ['冲突未解决前暂停自动采纳；解决冲突不会删除任何一方来源。', '反馈记录本身只描述一次意见；要暂停某条记忆或候选，请到那条记录的详情里用「记录管理员反馈」。'],
    columns: [
      { label: '类型', cell: (row) => KIND_LABELS[row.kind] || row.kind || '—' },
      { label: '内容', wrap: true, cell: (row) => clip(pickText(row.data, ['summary', 'text', 'content', 'note', 'reason']) || '（无描述）', 240) },
      {
        label: '来源',
        cell: (row) => {
          const ids = isPlainObject(row.data) ? row.data.sourceIds : null;
          return Array.isArray(ids) ? String(ids.length) + ' 条' : '—';
        },
      },
      { label: '范围', wrap: true, cell: (row) => row.scopeKey || '—' },
      { label: '主体', cell: (row) => row.subjectQQ || '—' },
      { label: '状态', cell: (row) => statusChip(row.status) },
      { label: '更新', cell: (row) => formatTime(row.updatedAt) },
    ],
  });
}

/* ------------------------------------------------------------------ */
/* 视图：人格与回退                                                    */
/* ------------------------------------------------------------------ */

function createPersonalityView() {
  return makeList({
    id: 'personality',
    label: '人格与回退',
    title: '人格版本与回退',
    description: '人格合并才创建角色级版本，保留父版本、具体差异与快照。回退创建恢复版本并保留历史，只恢复人格与表达，不删除共同经历。',
    kinds: [{ kind: 'personality', label: '人格版本' }],
    notices: ['同一角色最多每 3 天合并一次人格变化；小幅、具体，并保留差异。', '回退后该变化暂停自动采纳，旧证据不会立即重新激活（R6）。'],
    columns: [
      { label: '角色', cell: (row) => row.characterId || '—' },
      { label: '版本', cell: (row) => 'v' + (row.version ?? '?') },
      { label: '父版本', wrap: true, cell: (row) => (isPlainObject(row.data) ? textOf(row.data.parentId) : '') || '（首个版本）' },
      {
        label: '变更',
        wrap: true,
        cell: (row) => {
          const changes = isPlainObject(row.data) ? row.data.changes : null;
          if (Array.isArray(changes)) return changes.map((item) => clip(textOf(item), 120)).join('；') || '—';
          if (isPlainObject(changes)) return Object.keys(changes).join('、') || '—';
          return '—';
        },
      },
      {
        label: '来源候选',
        cell: (row) => {
          const ids = isPlainObject(row.data) ? row.data.sourceCandidateIds : null;
          return Array.isArray(ids) ? String(ids.length) : '—';
        },
      },
      { label: '状态', cell: (row) => statusChip(row.status) },
      { label: '创建', cell: (row) => formatTime(row.createdAt) },
    ],
  });
}

/* ------------------------------------------------------------------ */
/* 视图：召回记录                                                      */
/* ------------------------------------------------------------------ */

function createRecallView() {
  return makeList({
    id: 'recall',
    label: '召回记录',
    title: '召回记录：入选与省略',
    description: '每次上下文装配记录入选、排除与理由及预算。字段以服务端记录为准；缺失时页面明确显示“未记录”，不补写理由。',
    kinds: [{ kind: 'recall', label: '召回' }],
    notices: ['停用、纠正、删除、共享撤销在下一次上下文装配前生效；已发出的回复无法追溯撤回。', 'DSH 旧会话里已装配的上下文快照不会自动改写；这里展示的是服务端记录，不是仍然生效的保证。'],
    columns: [
      { label: '角色', cell: (row) => row.characterId || '—' },
      { label: '范围/会话', wrap: true, cell: (row) => row.scopeKey || (isPlainObject(row.data) ? textOf(row.data.sessionId) : '') || '—' },
      {
        label: '入选',
        cell: (row) => {
          const selected = isPlainObject(row.data) ? row.data.selected : null;
          return Array.isArray(selected) ? String(selected.length) : '未记录';
        },
      },
      {
        label: '省略',
        cell: (row) => {
          const omitted = isPlainObject(row.data) ? row.data.omitted : null;
          return Array.isArray(omitted) ? String(omitted.length) : '未记录';
        },
      },
      {
        label: '预算',
        wrap: true,
        cell: (row) => {
          const budget = isPlainObject(row.data) ? row.data.budget : null;
          if (isPlainObject(budget)) {
            const parts = Object.keys(budget).map((key) => key + '=' + textOf(budget[key]));
            return parts.join(' · ') || '—';
          }
          return textOf(budget) || '—';
        },
      },
      { label: '时间', cell: (row) => formatTime(row.createdAt) },
    ],
  });
}

/* ------------------------------------------------------------------ */
/* 视图：用量                                                          */
/* ------------------------------------------------------------------ */

function createUsageView() {
  const usageData = row => {
    const data = isPlainObject(row.data) ? row.data : {};
    const usage = isPlainObject(data.usage) ? data.usage : {};
    return {...data, category:data.category || 'learning', requests:data.requests ?? 1, inputTokens:data.inputTokens ?? usage.inputTokens ?? null, outputTokens:data.outputTokens ?? usage.outputTokens ?? null};
  };
  return makeList({
    id: 'usage',
    label: '用量',
    title: '用量与配额',
    description: '正常聊天、记忆处理、学习分列；输入、输出、注入 token 与请求数分列。无可靠价格时费用未知，页面不估算。',
    kinds: [{ kind: 'usage', label: '用量' }],
    notices: ['配额按真实请求归属上海日期记录；请求状态不确定时保守记账并显示，不自动假定可返还。'],
    columns: [
      { label: '日期', cell: (row) => pickText(row.data, ['day']) || dayKey(row.createdAt) || '—' },
      { label: '类别', cell: (row) => ({chat:'正常聊天',memory:'本地记忆',learning:'学习／联合提炼'}[usageData(row).category] || usageData(row).category) },
      { label: '角色', cell: (row) => row.characterId || '—' },
      { label: '范围', wrap: true, cell: (row) => row.scopeKey || '—' },
      { label: '请求数', cell: (row) => numOrDash(usageData(row).requests) },
      { label: '输入 token', cell: (row) => numOrDash(usageData(row).inputTokens) },
      { label: '输出 token', cell: (row) => numOrDash(usageData(row).outputTokens) },
      { label: '注入 token', cell: (row) => numOrDash(usageData(row).injectedTokens) + (row.data?.injectedTokensEstimated ? '（估算）' : '') },
      { label: '费用', cell: (row) => row.data?.category === 'memory' ? '本地处理，无模型费用' : '未知' },
    ],
    afterList: ({ rows }) => {
      const keys = ['requests', 'inputTokens', 'outputTokens', 'injectedTokens'];
      const card = el('div', { class: 'card' });
      card.append(el('h5', { text: '当前已加载记录的分类合计' }));
      for (const [category,label] of [['chat','正常聊天'],['memory','本地记忆'],['learning','学习／联合提炼']]) {
        const data = rows.map(usageData).filter(value => value.category === category);
        card.append(el('h5', {text:label}));
        if (!data.length) { card.append(el('p',{class:'muted small',text:'暂无记录'})); continue; }
        card.append(kvList(keys.map(key => [FIELD_LABELS[key] || key, data.every(value => typeof value[key] === 'number' && Number.isFinite(value[key])) ? String(data.reduce((sum,value)=>sum+value[key],0)) + (key==='injectedTokens' && data.some(value=>value.injectedTokensEstimated) ? '（估算）' : '') : '未知（有缺失记录）'])));
      }
      card.append(el('p', { class: 'muted small', text: '只汇总已加载记录。学习与记忆联合提炼只计一次学习请求；聊天输入包含注入部分，注入列不可再与输入相加。' }));
      return card;
    },
  });
}

/* ------------------------------------------------------------------ */
/* 视图：审计                                                          */
/* ------------------------------------------------------------------ */

function createAuditView() {
  return {
    id: 'audit',
    label: '审计',
    mount(container) {
      let tab = 'audit';
      let rows = [];
      let loading = false;
      let error = null;
      let disposed = false;
      const root = el('div', { class: 'stack' });
      container.append(root);

      async function load() {
        if (disposed) return;
        loading = true;
        error = null;
        rows = [];
        render();
        try {
          const result = await api.query({ kind: tab, limit: state.filter.limit });
          const value = result.value;
          if (!isPlainObject(value) || !Array.isArray(value.rows)) {
            throw new ApiError('query 返回的 value 不是 {rows,next} 结构。', { code: 'bad-contract', details: value });
          }
          rows = value.rows;
        } catch (requestError) {
          error = requestError instanceof ApiError ? requestError : new ApiError(String(requestError && requestError.message ? requestError.message : requestError));
        }
        loading = false;
        if (!disposed) render();
      }

      function render() {
        if (disposed) return;
        root.replaceChildren();

        root.append(
          el(
            'div',
            { class: 'pagehead' },
            el(
              'div',
              null,
              el('h2', { text: '审计与管理命令' }),
              el('p', {
                class: 'muted small',
                text: '变更审计与 QQ 管理命令记录。审计使用 query kind=audit；若服务端未提供该 kind，这里显示真实错误而不是伪造审计行。',
              }),
            ),
            el('div', { class: 'pagehead-actions' }, el('button', { type: 'button', class: 'btn', text: '刷新', onclick: () => load() })),
          ),
        );

        const tabs = el('div', { class: 'tabs' });
        for (const [id, label] of [
          ['audit', '变更审计'],
          ['control', '管理命令'],
        ]) {
          const button = el('button', { type: 'button', class: 'tab' + (id === tab ? ' is-active' : ''), text: label });
          button.addEventListener('click', () => {
            if (tab === id) return;
            tab = id;
            load();
          });
          tabs.append(button);
        }
        root.append(tabs);

        if (error) {
          root.append(
            el(
              'div',
              { class: 'errorbox' },
              el('span', { class: 'errortitle', text: '读取失败 · ' + (error.code || 'unknown') }),
              el('p', { text: error.message }),
              el('p', {
                class: 'muted small',
                text:
                  tab === 'audit'
                    ? '审计由服务端 store.list(kind=audit) 直接读取；读不到说明服务端未提供或权限不足，页面不伪造审计行。'
                    : '管理命令由白名单管理员经可信 QQ 元数据触发；页面只读。',
              }),
              error.details ? renderJson(error.details, '错误详情') : null,
              el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn', text: '重试', onclick: () => load() })),
            ),
          );
          return;
        }
        if (loading) {
          root.append(el('p', { class: 'muted small', text: '正在读取…' }));
          return;
        }
        if (rows.length === 0) {
          root.append(el('div', { class: 'empty' }, el('p', { text: '服务端没有返回记录。' }), el('p', { class: 'muted small', text: '这是真实空结果。' })));
          return;
        }

        const table = el('table', { class: 'grid' });
        const headRow = el('tr');
        for (const label of ['时间', '操作者', '动作', '目标', '原因', 'requestId']) headRow.append(el('th', { text: label }));
        table.append(el('thead', null, headRow));

        const tbody = el('tbody');
        for (const row of rows) {
          const data = isPlainObject(row.data) ? row.data : {};
          const tr = el(
            'tr',
            { tabindex: '0' },
            el('td', { text: formatTime(data.at || row.createdAt) }),
            el('td', { text: textOf(data.actor) || row.characterId || '—' }),
            el('td', { text: textOf(data.action) || KIND_LABELS[row.kind] || row.kind || '—' }),
            el('td', { class: 'wrap', text: textOf(data.target) || row.scopeKey || row.subjectQQ || '—' }),
            el('td', { class: 'wrap', text: clip(textOf(data.reason), 200) || '—' }),
            el('td', { class: 'wrap', text: textOf(data.requestId) || '—' }),
          );
          tr.addEventListener('click', () => openDrawer(row, { siblings: rows }));
          tbody.append(tr);
        }
        table.append(tbody);
        root.append(el('div', { class: 'tablescroll' }, table));
        root.append(el('p', { class: 'muted small', text: '只显示服务端返回的字段；审计不复制已删除的原文。' }));
      }

      load();
      return {
        dispose() {
          disposed = true;
          root.remove();
        },
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* 视图：备份与恢复                                                    */
/* ------------------------------------------------------------------ */

function createBackupView() {
  return makeList({
    id: 'backup',
    label: '备份与恢复',
    title: '备份与恢复',
    description: '每日备份、保留 14 天（可配置时刻）。恢复前必须人工确认，并先看恢复预览：会复活的删除内容、受影响范围与时间。',
    kinds: [{ kind: 'backup', label: '备份' }],
    notices: ['备份保留期内，已删除的原文仍可能存在于备份中；恢复会让它们复活。', '一致性快照由服务端生成，页面不复制活跃数据库，也不猜测备份内容。', '恢复只回到备份那个时间点：备份之后的新变更会丢失，旧 DSH 会话快照也不会被一并回滚。'],
    afterList: ({ reload }) =>
      el(
        'div',
        { class: 'card' },
        el('h5', { text: '备份操作' }),
        el(
          'div',
          { class: 'actions' },
          el('button', {
            type: 'button',
            class: 'btn',
            text: '新建备份',
            onclick: () =>
              openActionDialog({
                action: 'backupCreate',
                title: '新建备份',
                description: '请求服务端创建一致性快照。备份时刻与保留期由服务端配置决定；页面不指定备份内容。',
                requiresTarget: false,
                reasonMode: 'none',
                fields: [textField('reason', '备份说明', 'manual', '写入服务端 backup 记录与审计；默认 manual。', true)],
                onDone: reload,
              }),
          }),
        ),
        el('p', { class: 'muted small', text: '恢复入口在每条备份的详情里：先“预览恢复影响”，再输入确认词执行恢复。' }),
      ),
    columns: [
      { label: '备份文件', wrap: true, cell: (row) => pickText(row.data, ['name']) || row.id || '—' },
      { label: '创建时间', cell: (row) => formatTime((isPlainObject(row.data) ? row.data.createdAt : null) || row.createdAt) },
      { label: '大小', cell: (row) => (isPlainObject(row.data) && typeof row.data.bytes === 'number' ? row.data.bytes + ' 字节' : '未记录') },
      { label: '原因', cell: (row) => pickText(row.data, ['reason']) || '—' },
      { label: '指纹', wrap: true, cell: (row) => clip(pickText(row.data, ['sha256']) || '—', 24) },
      { label: '状态', cell: (row) => statusChip(row.status) },
    ],
  });
}

/* ------------------------------------------------------------------ */
/* 视图：导入                                                          */
/* ------------------------------------------------------------------ */

function createImportView() {
  return makeList({
    id: 'import',
    label: '导入',
    title: '导入与预览批准',
    description: '可追溯内容按来源导入；被历史合并污染且无法确认归属的内容进入待确认区，不猜测共享范围。先预览，再批准。',
    kinds: [{ kind: 'import', label: '导入' }],
    notices: ['旧 fish-memory 按 DSH Session.id 保存，历史合并会污染归属；“这次会话看起来像同一个人”不足以确认归属。', 'importPreview 需要 records 数组与 mapping 字典；mapping 的键是记录 id，值是 {characterId, scopeKey, confirmed:true}，未映射的进入 quarantine。'],
    columns: [
      { label: '来源', wrap: true, cell: (row) => pickText(row.data, ['source', 'path', 'format']) || '—' },
      { label: '导入条数', cell: (row) => numOrDash(isPlainObject(row.data) ? (Array.isArray(row.data.ids) ? row.data.ids.length : null) : null) },
      { label: '隔离数量', cell: (row) => numOrDash(isPlainObject(row.data) ? row.data.quarantined : null) },
      { label: '指纹', wrap: true, cell: (row) => clip(pickText(row.data, ['hash']) || '—', 20) },
      { label: '状态', cell: (row) => statusChip(row.status) },
      { label: '创建', cell: (row) => formatTime(row.createdAt) },
    ],
    afterList: ({ reload }) =>
      el(
        'div',
        { class: 'card' },
        el('h5', { text: '发起导入预览' }),
        el(
          'div',
          { class: 'actions' },
          el('button', {
            type: 'button',
            class: 'btn',
            text: '预览旧数据导入',
            onclick: () =>
              openActionDialog({
                action: 'importPreview',
                title: '预览导入',
                description: '预览只读取并返回 confirmationToken 与 sha256；批准必须拿这两个值，服务端还会校验 confirm:true。',
                requiresTarget: false,
                reasonMode: 'none',
                fields: [
                  textField('source', '来源（路径或标识）', 'legacy-fish-memory', '写入 receipt.source，并参与 sha256 计算；同来源同记录重复导入按 digest 去重。', true),
                  jsonField('records', 'records（JSON 数组，1–1000 条）', [], '每条至少含 id 与 text / content / summary 之一；其余字段原样留在 raw。', 'array', true),
                  jsonField(
                    'mapping',
                    'mapping（JSON 对象：记录 id → 归属）',
                    {},
                    '例如 {"0":{"characterId":"companion","scopeKey":"group:123456","confirmed":true}}；未映射或 confirmed 不为 true 的进入 quarantine。',
                    'object',
                  ),
                ],
                resultFollowUp: { label: '用该令牌继续批准', build: (value) => importApplyAction(value) },
                onDone: reload,
              }),
          }),
        ),
        el('p', { class: 'muted small', text: '预览结果返回 confirmationToken、sha256 与命中前 30 条；未明确映射的材料进入隔离区，不会覆盖现有条目。' }),
      ),
  });
}

/* ------------------------------------------------------------------ */
/* 视图：接管准备                                                      */
/* ------------------------------------------------------------------ */

function createTakeoverView() {
  return makeList({
    id: 'takeover',
    label: '接管准备',
    title: '接管准备与开关',
    description: '按角色 + 范围登记接管状态：prepare 只做准备，activate 请求停用旧输出并等待桥接确认，rollback 回退接管。只有 acknowledged 且 status=active 后召回端才会注入。',
    kinds: [{ kind: 'takeover', label: '接管记录' }],
    notices: ['旧数据、配置与镜像回退副本需要保留；归属不可靠的旧记忆不自动使用。', '接管状态来自服务端真实记录；页面不用“已准备好”这类文案代替实际状态。', '已有接管记录时必须提交其当前 expectedVersion；没有记录时可省略。'],
    columns: [
      { label: '角色', cell: (row) => row.characterId || '—' },
      { label: '范围', wrap: true, cell: (row) => row.scopeKey || '—' },
      { label: '操作', cell: (row) => (isPlainObject(row.data) ? textOf(row.data.operation) : '') || '—' },
      { label: '目标归属', cell: (row) => (isPlainObject(row.data) ? textOf(row.data.desiredOwner) : '') || '—' },
      { label: '桥接确认', cell: (row) => (isPlainObject(row.data) && row.data.acknowledged === true ? '已确认' : '未确认') },
      { label: '状态', cell: (row) => statusChip(row.status) },
      { label: '版本', cell: (row) => (row.version === undefined ? '—' : String(row.version)) },
      { label: '更新', cell: (row) => formatTime(row.updatedAt) },
    ],
    afterList: ({ rows, reload }) =>
      el(
        'div',
        { class: 'card' },
        el('h5', { text: '接管动作' }),
        el(
          'div',
          { class: 'actions' },
          el('button', {
            type: 'button',
            class: 'btn',
            text: '准备 / 激活 / 回退某个范围',
            onclick: () => openTakeoverCreateDialog(rows, reload),
          }),
        ),
        el('p', { class: 'muted small', text: '接管没有一键完成：页面只提交服务端定义的单个操作，失败时保留材料与任务。' }),
      ),
  });
}

/** 接管动作：已有记录必须带当前 version；没有记录时可省略。 */
function openTakeoverCreateDialog(rows, onDone) {
  const existingFor = (characterId, scopeKey) =>
    rows.find((row) => row.kind === 'takeover' && row.characterId === characterId && row.scopeKey === scopeKey) || null;

  const characterInput = el('input', { class: 'input', type: 'text', placeholder: '角色 ID', value: state.filter.characterId || '' });
  const scopeInput = el('input', { class: 'input', type: 'text', placeholder: '范围，如 group:123456', value: state.filter.scopeKey || '' });
  const operationSelect = el('select', { class: 'select' });
  for (const option of ENUMS.takeoverOperation) operationSelect.append(el('option', { value: option[0], text: option[1] + '（' + option[0] + '）' }));
  const versionInput = el('input', { class: 'input', type: 'number', min: '1', step: '1', placeholder: '已有记录时必填' });
  const hint = el('p', { class: 'muted small', text: '先填角色与范围；若该范围已有接管记录，页面会要求填它的当前 version。' });

  const refreshHint = () => {
    const existing = existingFor(characterInput.value.trim(), scopeInput.value.trim());
    if (existing) {
      versionInput.value = versionInput.value === '' ? String(existing.version) : versionInput.value;
      hint.textContent = '已存在接管记录 ' + existing.id + '（当前 version=' + existing.version + '）：必须提交该版本，或直接关掉此框去列表里操作那条记录。';
    } else {
      hint.textContent = '当前页没有该角色 + 范围的接管记录，expectedVersion 会省略；若服务端另有记录会返回 EXPECTED_VERSION_REQUIRED，此时刷新列表并按记录操作。';
    }
  };
  characterInput.addEventListener('change', refreshHint);
  scopeInput.addEventListener('change', refreshHint);
  refreshHint();

  const problems = el('ul', { class: 'problems' });
  const errorBox = el('div', { class: 'dialogerror', hidden: true });
  const requestCode = el('code', { text: newRequestId() });
  const payloadHash = { value: null };

  const body = el(
    'div',
    { class: 'dialogbody' },
    el(
      'div',
      { class: 'card' },
      el('h5', { text: '操作' }),
      kvList([['服务端动作', el('code', { text: 'takeover' })], ['提交字段', el('span', { class: 'text', text: 'requestId · reason · characterId · scopeKey · operation · expectedVersion（按需）' })]]),
    ),
    el(
      'div',
      { class: 'card' },
      el('h5', { text: '归属与操作' }),
      el(
        'div',
        { class: 'stack' },
        [
          el('div', { class: 'fieldrow' }, el('span', { class: 'fieldlabel', text: '角色 ID（characterId）' }), characterInput),
          el('div', { class: 'fieldrow' }, el('span', { class: 'fieldlabel', text: '范围（scopeKey）' }), scopeInput),
          el('div', { class: 'fieldrow' }, el('span', { class: 'fieldlabel', text: '操作（operation）' }), operationSelect),
          el('div', { class: 'fieldrow' }, el('span', { class: 'fieldlabel', text: 'expectedVersion（已有记录时必填）' }), versionInput),
          hint,
        ],
      ),
    ),
    el(
      'div',
      { class: 'card' },
      el('h5', { text: '原因（必填）' }),
      (() => {
        const area = el('textarea', { class: 'textarea' });
        area.style.minHeight = '70px';
        area.placeholder = '写明为什么做这次接管操作（必填）';
        area.dataset.role = 'takeover-reason';
        return area;
      })(),
      el('p', { class: 'muted small', text: '原因写入服务端审计。' }),
    ),
    el('div', { class: 'card' }, el('h5', { text: '请求 ID' }), kvList([['requestId', requestCode]]), el('p', { class: 'muted small', text: '同一 requestId 重复提交按幂等处理；payload 变化时换新 ID。' })),
    problems,
    errorBox,
  );
  const reasonArea = body.querySelector('[data-role="takeover-reason"]');

  const submitButton = el('button', { type: 'button', class: 'btn btn-primary', text: '提交变更' });
  const cancelButton = el('button', { type: 'button', class: 'btn', text: '取消' });
  let dialog = null;
  cancelButton.addEventListener('click', () => {
    if (dialog) dialog.close();
  });

  submitButton.addEventListener('click', async () => {
    problems.replaceChildren();
    errorBox.hidden = true;
    errorBox.replaceChildren();

    const characterId = characterInput.value.trim();
    const scopeKey = scopeInput.value.trim();
    const operation = operationSelect.value;
    const reason = reasonArea.value.trim();
    const payload = { requestId: requestCode.textContent, reason, characterId, scopeKey, operation };

    if (reason === '') problems.append(el('li', { text: '原因不能为空。' }));
    if (characterId === '') problems.append(el('li', { text: '角色 ID 不能为空。' }));
    if (!/^(private|group|profile):[1-9]\d{0,19}$/.test(scopeKey)) problems.append(el('li', { text: '范围必须形如 private:<QQ> / group:<群号> / profile:<QQ>。' }));
    if (!ENUMS.takeoverOperation.some((option) => option[0] === operation)) problems.append(el('li', { text: '操作只能取 prepare / activate / rollback。' }));

    const existing = existingFor(characterId, scopeKey);
    const versionRaw = String(versionInput.value).trim();
    if (existing) {
      if (versionRaw === '') problems.append(el('li', { text: '该范围已有接管记录（version=' + existing.version + '），必须填写 expectedVersion。' }));
      else if (!/^\d+$/.test(versionRaw)) problems.append(el('li', { text: 'expectedVersion 必须是非负整数。' }));
      else if (Number(versionRaw) !== existing.version) problems.append(el('li', { text: 'expectedVersion 与当前记录版本（' + existing.version + '）不一致，请刷新后再试。' }));
      else payload.expectedVersion = Number(versionRaw);
    } else if (versionRaw !== '') {
      if (!/^\d+$/.test(versionRaw)) problems.append(el('li', { text: 'expectedVersion 必须是非负整数。' }));
      else payload.expectedVersion = Number(versionRaw);
    }

    if (problems.children.length > 0) return;

    const hash = stableStringify(payload);
    if (payloadHash.value !== null && payloadHash.value !== hash) {
      requestCode.textContent = newRequestId();
      payload.requestId = requestCode.textContent;
    }
    payloadHash.value = stableStringify(payload);

    submitButton.disabled = true;
    cancelButton.disabled = true;
    submitButton.textContent = '提交中…';
    try {
      await api.mutate('takeover', payload);
      toast('已提交接管操作：' + operation, 'ok');
      if (dialog) dialog.close();
      if (onDone) onDone();
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError(String(error && error.message ? error.message : error));
      errorBox.hidden = false;
      errorBox.replaceChildren(
        el('span', { class: 'errortitle', text: '服务端未接受本次变更 · ' + apiError.code }),
        el('p', { text: apiError.message }),
        apiError.details ? renderJson(apiError.details, '错误详情') : null,
      );
      submitButton.disabled = false;
      cancelButton.disabled = false;
      submitButton.textContent = '修改后重新提交';
    }
  });

  dialog = openDialog({
    title: '接管：准备 / 激活 / 回退',
    subtitle: '接管按角色 + 范围登记；activate 之后仍需桥接确认旧输出已关闭。',
    body,
    footer: el('div', { class: 'dialogfoot' }, cancelButton, submitButton),
  });
}

/* ------------------------------------------------------------------ */
/* 视图：系统记录                                                      */
/* ------------------------------------------------------------------ */

function createSystemView() {
  return makeList({
    id: 'system',
    label: '系统记录',
    title: '系统记录',
    description: '角色、会话绑定、任务与管理命令。会话绑定仅用于定位 DSH Session，不是长期记忆主键；缺少可靠身份时不写长期记忆。',
    kinds: [
      { kind: 'character', label: '角色' },
      { kind: 'binding', label: '会话绑定' },
      { kind: 'task', label: '任务' },
      { kind: 'control', label: '管理命令' },
    ],
    createKind: ['character'],
    columns: [
      { label: '类型', cell: (row) => KIND_LABELS[row.kind] || row.kind || '—' },
      {
        label: '摘要',
        wrap: true,
        cell: (row) => {
          const data = isPlainObject(row.data) ? row.data : {};
          const text = pickText(data, ['name', 'summary', 'note', 'reason', 'command', 'sessionId', 'provider']);
          if (text !== null) return clip(text, 160);
          const keys = Object.keys(data).slice(0, 4);
          return keys.length > 0 ? keys.map((key) => key + '=' + clip(textOf(data[key]), 40)).join(' · ') : '—';
        },
      },
      { label: '角色', cell: (row) => row.characterId || '—' },
      { label: '范围', wrap: true, cell: (row) => row.scopeKey || '—' },
      { label: '主体', cell: (row) => row.subjectQQ || '—' },
      { label: '状态', cell: (row) => statusChip(row.status) },
      { label: '版本', cell: (row) => (row.version === undefined ? '—' : String(row.version)) },
      { label: '更新', cell: (row) => formatTime(row.updatedAt) },
    ],
  });
}

/* ------------------------------------------------------------------ */
/* 视图注册与启动                                                      */
/* ------------------------------------------------------------------ */

const VIEWS = [
  createOverviewView(),
  createMemoryView(),
  createArchiveView(),
  createProfileView(),
  createSupplementView(),
  createShareView(),
  createCandidateView(),
  createConflictView(),
  createPersonalityView(),
  createRecallView(),
  createUsageView(),
  createAuditView(),
  createBackupView(),
  createImportView(),
  createTakeoverView(),
  createSystemView(),
];

function wireTopbar() {
  $('btnStatus').addEventListener('click', async () => {
    const button = $('btnStatus');
    button.disabled = true;
    try {
      await loadStatus();
      await loadCharacters();
      renderView();
      if (state.status.phase === 'ready') toast('已重新读取状态', 'ok');
    } finally { button.disabled = false; }
  });

  $('bannerClose').addEventListener('click', hideBanner);

  const openButton = $('btnOpenWindow');
  if (openButton && window.top !== window.self) {
    openButton.hidden = false;
    openButton.addEventListener('click', () => {
      window.open(window.location.href, '_blank', 'noopener');
    });
  }

  $('overlay').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (event) => {
    if ($('drawer').hidden || document.querySelector('dialog[open]')) return;
    if (event.key === 'Escape') { event.preventDefault(); closeDrawer(); }
    if (event.key === 'Tab') {
      const focusable = [...$('drawer').querySelectorAll('button, a[href], input, select, textarea, summary, [tabindex="0"]')].filter(node => !node.disabled && node.getClientRects().length);
      const first = focusable[0]; const last = focusable.at(-1);
      if (!first) { event.preventDefault(); $('drawer').focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === $('drawer'))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  window.addEventListener('hashchange', () => {
    const location = readLocation();
    if (location.view === state.view && location.kind === state.tab) return;
    closeDrawer(); state.view = location.view; state.tab = location.kind;
    buildNav(); renderView();
  });
}

async function boot() {
  const location = readLocation();
  state.view = location.view; state.tab = location.kind;
  $('content').tabIndex = -1;
  wireTopbar();
  buildNav();
  await loadStatus();
  await loadCharacters();
  renderView();
}

boot().catch((error) => {
  const content = $('content');
  if (content) {
    content.replaceChildren(
      el(
        'div',
        { class: 'errorbox' },
        el('span', { class: 'errortitle', text: '管理页面初始化失败' }),
        el('p', { text: error && error.message ? error.message : String(error) }),
      ),
    );
  }
});
