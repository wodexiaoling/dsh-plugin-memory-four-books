/**
 * 记忆四册 · Harness 插件入口（Host 端）
 *
 * 把李小灵的记忆架构复制成一个可安装的插件：
 *   1) 四册：记忆核心 / MEMORY_INDEX / 档案库 / memory_changelog
 *   2) 五分区：当天 · 红线 · 进行 · 常识 · 档案（容量压制，只降级不删除）
 *   3) 注入：systemPrompt.section() 每个模型步都带「红线 + 当天 + 进行 + 常识」
 *   4) 工具：memory_recall / memory_remember / memory_consolidate / memory_status
 *
 * 只做复制：不读、不写李小灵原本的任何文件。
 */

import { MemoryStore, resolveDataDir, SECTIONS, CAP, worthKeeping, norm } from './lib/store.js';

export const name = 'memory-four-books';

// 硬依赖：工具注册表必须有；系统提示词注入也走它（缺了这两个插件没有意义）
export const inject = ['tools', 'systemPrompt'];

/** 从一条 UserMessage 里抽出纯文本（content 可能是字符串，也可能是 block 数组） */
function textOf(msg) {
  if (!msg) return '';
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

// 这些是框架/框架插件注入的"假用户消息"，不是人说的话，不能进记忆
const INJECTED_MARKS = ['<system-reminder>', '<runtime-context>', '<goal>', '<command-', '<attached'];

const TOOL = {
  recall: 'memory_recall',
  remember: 'memory_remember',
  consolidate: 'memory_consolidate',
  status: 'memory_status',
};

/** 工具统一的结果渲染：把结构化返回值转成一段可读文本 */
const textBlocks = (title, body) => [{ type: 'text', text: `**${title}**\n\n${body}` }];

export function apply(ctx, config = {}) {
  const dataDir = resolveDataDir(config.dataDir);
  const store = new MemoryStore(dataDir, {
    dayMaxChars: config.dayMaxChars,
    indexMaxDocs: config.indexMaxDocs,
  });

  const budget = Number(config.injectBudget) > 0 ? Number(config.injectBudget) : 15000;
  const injectEnabled = config.inject !== false;
  const sectionOrder = Number.isFinite(config.sectionOrder) ? Number(config.sectionOrder) : 45;

  // 启动就建目录，保证首次使用不会因为目录不存在出岔子
  try { store.ensure(); } catch { /* 静默 */ }

  // 运行状态（给 memory_status 看）
  const runtime = { 自动记录: 0, 自动归纳: 0, 上次归纳: 0 };

  // ---------------------------------------------------------------- 1) 注入
  if (injectEnabled && ctx.systemPrompt) {
    ctx.systemPrompt.section({
      name: 'memory-four-books',
      order: sectionOrder,
      // 每次组装提示词时重读，保证「当天」是最新的
      text: () => {
        try {
          return store.buildInject(budget);
        } catch {
          return '';
        }
      },
    });
  }

  // ---------------------------------------------------------------- 2) 自动记流水
  // 原件是靠各入口自动调「支线写」留底的。这里挂 agent/pre-step：
  // 每次有消息要进入模型前，把人说的话抄进支线。只读不改，永远 return next()。
  if (config.autoRecord !== false) {
    const seen = new Set();
    const MAX_SEEN = 5000;

    ctx.on('agent/pre-step', (payload, next) => {
      try {
        for (const msg of (payload && payload.messages) || []) {
          const text = textOf(msg).trim();
          if (text.length < 8) continue;
          if (text.startsWith('<') || INJECTED_MARKS.some((m) => text.includes(m))) continue;
          if (!worthKeeping(text)) continue;

          const key = norm(text);
          if (!key || seen.has(key)) continue;
          if (seen.size > MAX_SEEN) seen.clear();   // 只防内存，不追求完美去重
          seen.add(key);

          if (store.appendLine('对话', 'user', text, '通用')) runtime.自动记录++;
        }
      } catch { /* 记录失败绝不能影响对话 */ }
      return next();
    });
  }

  // ---------------------------------------------------------------- 3) 自动归纳
  // 每分钟醒一次，距上次归纳超过 N 分钟才真跑；没有新流水就直接跳过不写盘。
  if (config.autoConsolidate !== false) {
    const minutes = Math.max(1, Number(config.consolidateMinutes) || 10);
    let nextAt = 0;
    const timer = setInterval(() => {
      try {
        if (Date.now() < nextAt) return;
        nextAt = Date.now() + minutes * 60000;   // 严格每 N 分钟一次，空跑也推进
        const r = store.consolidate({ perSource: 200 });
        if (r && (r.新增 || r.下沉)) {
          runtime.上次归纳 = Date.now();
          runtime.自动归纳++;
        }
      } catch { /* 静默：归纳坏了不能拖垮进程 */ }
    }, 60000);
    if (typeof timer.unref === 'function') timer.unref();
    ctx.effect(() => () => clearInterval(timer));
  }

  // ---------------------------------------------------------------- 4) 工具
  ctx.effect(() => ctx.tools.register({
    name: TOOL.recall,
    description:
      '在「记忆四册」里按关键词检索长期记忆（红线/进行中/常识/档案 + 原始流水）。' +
      '需要回想过去说过什么、定过什么规矩、踩过什么坑时用它。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词，可以是自然语言，也可以是几个词' },
        k: { type: 'number', description: '返回条数，默认 6，最多 30' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          问: { type: 'string' },
          命中: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                score: { type: 'number' },
                id: { type: 'string' },
                title: { type: 'string' },
                text: { type: 'string' },
                meta: { type: 'object' },
              },
            },
          },
        },
      },
      render(args, value) {
        const hits = (value && value.命中) || [];
        if (!hits.length) return textBlocks('记忆召回', `没找到跟「${(args && args.query) || ''}」相关的记忆。`);
        const body = hits
          .map((h, i) => `${i + 1}. [${h.meta && h.meta.分区 ? h.meta.分区 : h.title}]（分 ${h.score}）${h.text}`)
          .join('\n\n');
        return textBlocks(`记忆召回：${(args && args.query) || ''}`, body);
      },
    },
    async execute(args) {
      const q = String((args && args.query) || '').trim();
      const k = Math.min(30, Math.max(1, Number(args && args.k) || 6));
      if (!q) return { 问: '', 命中: [], 错误: '要给关键词' };
      return store.recall(q, k);
    },
  }), 'memory-four-books.recall');

  ctx.effect(() => ctx.tools.register({
    name: TOOL.remember,
    description:
      '往「记忆四册」记一条长期记忆。会先落进原始流水（支线），再由归纳分成当天/红线/进行/常识/档案。' +
      '记用户偏好、决定、项目进展、踩过的坑。寒暄和废话会被归纳自动跳过。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记的内容，一句话说清楚，带上关键信息' },
        tag: { type: 'string', description: '主题标签，比如 偏好/项目/教训/红线，默认「通用」' },
        source: { type: 'string', description: '来源，比如 对话/网页/子代理，默认「对话」' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, 摘要: { type: 'string' }, 路径: { type: 'string' } },
      },
      render(args, value) {
        return textBlocks('已记下', (value && value.摘要) || String((args && args.text) || ''));
      },
    },
    async execute(args) {
      const text = String((args && args.text) || '').trim();
      if (!text) return { ok: false, 摘要: '空内容没记' };
      const ok = store.appendLine((args && args.source) || '对话', 'user', text, (args && args.tag) || '通用');
      store.appendChangelog('追加', (args && args.tag) || '通用', text.slice(0, 40));
      return { ok, 摘要: text.slice(0, 120), 路径: dataDir };
    },
  }), 'memory-four-books.remember');

  ctx.effect(() => ctx.tools.register({
    name: TOOL.consolidate,
    description:
      '跑一次记忆归纳：把原始流水的增量摘要化、去重、分到五区，并把超上限的老条目往下压（只降级不删除）。' +
      '平时可以隔一阵跑一次，或在会话结束前跑。',
    parameters: {
      type: 'object',
      properties: {
        perSource: { type: 'number', description: '每个来源本次最多归纳多少条，默认 80' },
        archiveDays: { type: 'number', description: '当天档超过几天算旧账下沉，默认 3' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          新增: { type: 'number' },
          跳过: { type: 'number' },
          分区: { type: 'object' },
          消息: { type: 'string' },
        },
      },
      render(args, value) {
        return textBlocks('记忆归纳', (value && value.消息) || '完成');
      },
    },
    async execute(args) {
      return store.consolidate({
        perSource: Math.min(500, Math.max(1, Number(args && args.perSource) || 80)),
        archiveDays: Math.max(0, Number(args && args.archiveDays) || 3),
      });
    },
  }), 'memory-four-books.consolidate');

  ctx.effect(() => ctx.tools.register({
    name: TOOL.status,
    description: '看「记忆四册」的现状：各分区条数、上限、文件大小、各来源流水条数。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object' },
      render(args, value) {
        const v = value || {};
        const rows = SECTIONS.map((s) => `${s}：${(v.分区条数 && v.分区条数[s]) || 0} / ${CAP[s]}`).join('\n');
        const auto = [
          `自动记录：${config.autoRecord === false ? '关' : '开'}（已抄 ${runtime.自动记录} 条）`,
          `自动归纳：${config.autoConsolidate === false ? '关' : `开，每 ${Math.max(1, Number(config.consolidateMinutes) || 10)} 分钟检查一次`}（已跑 ${runtime.自动归纳} 次）`,
          runtime.上次归纳 ? `上次归纳：${new Date(runtime.上次归纳).toLocaleString('sv-SE').slice(0, 16)}` : '上次归纳：还没跑过',
        ].join('\n');
        return textBlocks(
          '记忆四册 · 现状',
          `${rows}\n\n${auto}\n\n数据目录：${v.数据目录 || ''}\n\n支线：${(v.支线 || []).map((x) => x.来源 + '(' + x.条数 + ')').join('、') || '还没有'}`,
        );
      },
    },
    async execute() {
      return store.status();
    },
  }), 'memory-four-books.status');
}
