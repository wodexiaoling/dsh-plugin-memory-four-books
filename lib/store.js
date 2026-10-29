/**
 * 记忆四册 · 存储层
 *
 * 直接移植李小灵记忆架构（C:\Users\李志鹏\Desktop\self-agent\记忆总线.py），
 * 只做复制，不改动原文件一个字。结构对照：
 *
 *   支线  <dataDir>/支线/<来源>.jsonl     原始流水，只增不改，事实底稿
 *   总线  <dataDir>/四册/记忆核心.md       五分区：当天 / 红线 / 进行 / 常识 / 档案
 *   索引  <dataDir>/四册/MEMORY_INDEX.md   一行一条线：条数｜话头｜最近一句
 *   档案  <dataDir>/四册/档案库.md         A 主题全文 / C 下沉结论
 *   日志  <dataDir>/四册/memory_changelog.md  只追加
 *   台账  <dataDir>/归纳台账.jsonl         每次归纳的痕迹
 *
 * 三条设计铁律（原样继承）：
 *   ① 任何函数不许抛异常（记性坏了也不能拖垮对话），出错静默降级
 *   ② 支线只增不改；总线可重写；核心只由人手改，程序只读
 *   ③ 归档只降级不删除（从「进行」降进「档案」，行还在）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bm25Index } from './search.js';

export const SECTIONS = ['当天', '红线', '进行', '常识', '档案'];

export const SECTION_TITLE = {
  当天: '# 当天（今天的话 · 原样一字不裁 · 过零点才归档）',
  红线: '# 红线（绝不能做）',
  进行: '# 进行中（当前在办 / 待办 / 最近决策）',
  常识: '# 常识（长期有效的偏好 · 结论 · 踩坑）',
  档案: '# 档案（久远的事，一行摘要）',
};

// 标签 → 分区（顺序命中，跟记忆总线.py 的 TAG_RULES 一致）
const TAG_RULES = [
  ['红线', ['红线', '禁止', '绝不能', '绝不许']],
  ['进行', ['进行', '待办', '任务', '进展', '项目', '计划', '决策', '决定', '当前']],
  ['常识', ['偏好', '用户偏好', '教训', '踩坑', '结论', '经验', '约定', '常识', '通用', '记住']],
];

// 容量上限：超了就往下压（进行 → 档案；档案 → 只留摘要行）
export const CAP = { 当天: 400, 红线: 40, 进行: 80, 常识: 260, 档案: 800 };

const MAX_LINE = 160;      // 总线是"整体记忆"，不是原文仓库：每条只留一句摘要
const MIN_CORE = 6;        // 去掉标点后短于此长度，基本是应答，不值得背

const CHAT_ONLY = [
  '在吗', '在么', '在不在', '早', '晚安', '早安', '午安', '收到', '好的', '好嘞', '谢谢',
  '多谢', '辛苦', '吃了吗', '吃饭', '睡了', '困了', '哈哈', '嘿嘿', '嗯嗯', '好呀', '可以',
  '行吧', '没事', '在呢', '我在',
];

// 元内容：防止把"目录/工具输出回显"再吃回记忆（自我污染）
const META_MARK = [
  '# 目录（', '事件档：memory/', '## 全部记录（原样保留）', '同一件事串成一支',
  '细节见事件档', 'logs/工具输出', 'read_file.txt',
];

const ts = () => new Date().toLocaleString('sv-SE').slice(0, 16); // 2026-10-29 20:05

/** 数据目录：默认放在 DSH_HOME 下的 memory-four-books（可用 Config dataDir 覆盖） */
export function resolveDataDir(configured) {
  if (configured && String(configured).trim()) return path.resolve(String(configured));
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'memory-four-books');
}

// ---------------------------------------------------------------- 小工具

function safeName(s) {
  const t = String(s || '未知').replace(/[^\w\u4e00-\u9fa5-]/g, '_');
  return (t || '未知').slice(0, 40);
}

/** 把一条记忆炼成一行摘要：保留日期与标签，正文取第一个句号内的要点 */
export function digest(text, limit = MAX_LINE) {
  try {
    let t = String(text || '').trim();
    let date = '';
    let tag = '';
    const m = t.match(/^\[(\d{4}-\d{2}-\d{2})[^\]]*\]\s*(\[[^\]]*\])?/);
    if (m) {
      date = m[1];
      tag = (m[2] || '').replace(/^\[|\]$/g, '').trim();
      t = t.slice(m[0].length).trim();
    }
    t = t.replace(/\s+/g, ' ');
    let first = '';
    for (const sep of ['。', '；', '！', '\n']) {
      const i = t.indexOf(sep);
      if (i > 0 && (!first || i < first.length)) first = t.slice(0, i);
    }
    let base = first.length >= 20 && first.length <= t.length ? first : t;
    base = base.slice(0, limit);
    if (t.length > base.length) base += '…';
    const head = (date ? `[${date}]` : '') + (tag ? `[${tag}]` : '');
    return (head + ' ' + base).trim();
  } catch {
    return String(text || '').slice(0, limit);
  }
}

/** 归一化：去时间戳、去空白，用于判重 */
export function norm(text) {
  let s = String(text || '').replace(/\[\d{4}-\d{2}-\d{2}[^\]]*\]/g, '');
  s = s.replace(/[\s，。、,.!！?？:：;；\-—]+/g, '');
  return s.slice(0, 50);
}

/** 值得单独立条吗？（有信息量 → 记；纯寒暄/自我污染 → 不记） */
export function worthKeeping(text) {
  try {
    const t = String(text || '').trim();
    for (const mk of META_MARK) if (t.includes(mk)) return false;
    if (/（\d+ 条( · [0-9~\-]+)?）/.test(t)) return false;
    // 注意：JS 的 \W 不认汉字，会把中文全部删掉，必须用 Unicode 属性类
    const core = t.replace(/[\s\p{P}\p{S}_]+/gu, '');
    if (core.length < MIN_CORE) return false;
    if (new Set(core).size <= 2) return false;
    if (core.length < 12 && CHAT_ONLY.some((k) => t.includes(k))) return false;
    return true;
  } catch {
    return Boolean(String(text || '').trim());
  }
}

/** 标签 + 正文前 60 字 → 分区
 *
 * 红线是「永久注入、永不删除」的特权区，判定必须保守：
 * 只认显式 tag，或正文以「红线」开头。正文里偶然出现「禁止」不再进红线——
 * 误判一次，脏东西会永远挂在最贵的位置。
 */
export function classify(tag, text) {
  const t = String(tag || '');
  if (t.includes('红线')) return '红线';
  if (/^\s*(\[[^\]]*\])?\s*红线/.test(String(text || ''))) return '红线';

  const hay = `${t} ${String(text || '').slice(0, 60)}`;
  for (const [sec, kws] of TAG_RULES) {
    if (sec === '红线') continue;
    for (const kw of kws) if (hay.includes(kw)) return sec;
  }
  return '常识';
}

/** 主题线：优先用显式 tag，退而用首句前 12 字 */
export function topicOf(text, tag) {
  if (tag && tag !== '通用') return String(tag).slice(0, 20);
  const t = String(text || '').replace(/^\[[^\]]*\]\s*/, '').trim();
  const head = t.split(/[。；！\n]/)[0] || t;
  return head.slice(0, 14) || '杂项';
}

/** 时间衰减：跟原件对齐，半衰期 120 天，下限锁死 0.4（再老也保底带着四成） */
const DECAY_HALF_LIFE_DAYS = 120;
const DECAY_FLOOR = 0.4;

export function decayOf(dateStr) {
  if (!dateStr) return 1;
  const t = new Date(dateStr + 'T00:00:00').getTime();
  if (!isFinite(t)) return 1;
  // 按「整天差」算，不按小时：今天的记忆就该是满权
  const days = Math.floor((Date.now() - t) / 86400000);
  if (!isFinite(days) || days <= 0) return 1;
  return DECAY_FLOOR + (1 - DECAY_FLOOR) * Math.exp(-days / DECAY_HALF_LIFE_DAYS);
}

/** 从一条记忆里取日期：[YYYY-MM-DD] 开头，或 meta.t 的前 10 位 */
export function dateOf(text, meta) {
  const m = String(text || '').match(/\[(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  if (meta && meta.t) {
    const m2 = String(meta.t).match(/^(\d{4}-\d{2}-\d{2})/);
    if (m2) return m2[1];
  }
  return '';
}

// ---------------------------------------------------------------- 存储

export class MemoryStore {
  constructor(dataDir, options = {}) {
    this.dir = dataDir;
    this.lineDir = path.join(dataDir, '支线');
    this.bookDir = path.join(dataDir, '四册');
    this.busFile = path.join(this.bookDir, '记忆核心.md');
    this.indexFile = path.join(this.bookDir, 'MEMORY_INDEX.md');
    this.archiveFile = path.join(this.bookDir, '档案库.md');
    this.changelogFile = path.join(this.bookDir, 'memory_changelog.md');
    this.ledgerFile = path.join(dataDir, '归纳台账.jsonl');

    // 可调参数
    this.dayMaxChars = Number(options.dayMaxChars) > 0 ? Number(options.dayMaxChars) : 8000;
    this.indexMaxDocs = Number(options.indexMaxDocs) > 0 ? Number(options.indexMaxDocs) : 20000;

    this._cache = { stamp: '', docs: null, index: null };
    this._injectCache = { stamp: '', text: '' };
  }

  ensure() {
    fs.mkdirSync(this.lineDir, { recursive: true });
    fs.mkdirSync(this.bookDir, { recursive: true });
    if (!fs.existsSync(this.changelogFile)) {
      fs.writeFileSync(
        this.changelogFile,
        '# 记忆变更日志（只追加）\n\n> 每次记忆文件被改动，默默追加一行：时间 | 动作 | 对象 | 备注\n\n',
        'utf8',
      );
    }
  }

  // ---------- 支线（原始流水） ----------

  appendLine(source, role, content, tag = '通用') {
    try {
      this.ensure();
      const text = String(content || '').trim();
      if (!text) return false;
      const item = { t: ts(), role: String(role || 'sys'), tag: String(tag || '通用'), text };
      fs.appendFileSync(path.join(this.lineDir, safeName(source) + '.jsonl'), JSON.stringify(item) + '\n', 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  readLine(source) {
    try {
      const p = path.join(this.lineDir, safeName(source) + '.jsonl');
      if (!fs.existsSync(p)) return [];
      return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  lineSources() {
    try {
      this.ensure();
      return fs.readdirSync(this.lineDir).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6)).sort();
    } catch {
      return [];
    }
  }

  // ---------- 总线（五分区） ----------

  readSections() {
    const data = Object.fromEntries(SECTIONS.map((s) => [s, []]));
    try {
      if (!fs.existsSync(this.busFile)) return data;
      const raw = fs.readFileSync(this.busFile, 'utf8');
      let cur = null;
      for (const ln of raw.split('\n')) {
        const st = ln.trim();
        if (!st) continue;
        if (st.startsWith('# ')) {
          cur = null;
          for (const sec of SECTIONS) {
            if (st.includes(sec) && (st.includes(SECTION_TITLE[sec].slice(2)) || st.startsWith(`# ${sec}`))) {
              cur = sec;
              break;
            }
          }
          continue;
        }
        if (cur && st.startsWith('- ')) data[cur].push(st.slice(2).trim());
      }
    } catch {
      /* 读坏了就返回空，绝不抛 */
    }
    return data;
  }

  writeSections(data) {
    try {
      this.ensure();
      const parts = ['# 记忆核心（红线 + 进行中 + 真结论）', '', `> 生成：${ts()}`, ''];
      for (const sec of SECTIONS) {
        const rows = data[sec] || [];
        if (!rows.length && sec !== '当天') continue;
        parts.push(SECTION_TITLE[sec]);
        for (const r of rows) parts.push('- ' + r);
        parts.push('');
      }
      const tmp = this.busFile + '.tmp';
      fs.writeFileSync(tmp, parts.join('\n'), 'utf8');
      fs.renameSync(tmp, this.busFile);
      this._cache.stamp = '';
      this._injectCache = { stamp: '', text: '' };
    } catch {
      /* 写不进去就别写，不能炸 */
    }
  }

  // ---------- 台账 ----------

  readLedger() {
    try {
      if (!fs.existsSync(this.ledgerFile)) return {};
      const map = {};
      for (const ln of fs.readFileSync(this.ledgerFile, 'utf8').split('\n')) {
        if (!ln.trim()) continue;
        try {
          const r = JSON.parse(ln);
          if (r && r.来源) map[r.来源] = Number(r.到) || 0;
        } catch { /* 坏行跳过 */ }
      }
      return map;
    } catch {
      return {};
    }
  }

  appendLedger(entry) {
    try {
      this.ensure();
      fs.appendFileSync(this.ledgerFile, JSON.stringify(entry) + '\n', 'utf8');
    } catch { /* 静默 */ }
  }

  appendChangelog(action, target, note = '') {
    try {
      this.ensure();
      fs.appendFileSync(this.changelogFile, `${ts()} | ${action} | ${target} | ${note}\n`, 'utf8');
    } catch { /* 静默 */ }
  }

  // ---------- 归纳 ----------

  /**
   * 把各支线未归纳的增量并进总线。
   * @returns {{新增:number, 跳过:number, 分区:object, 消息:string}}
   */
  consolidate({ perSource = 80, archiveDays = 3 } = {}) {
    try {
      this.ensure();
      const data = this.readSections();
      const ledger = this.readLedger();
      const today = new Date().toISOString().slice(0, 10);
      const report = { 新增: 0, 跳过: 0, 下沉: 0, 分区: {}, 消息: '' };
      let 变化 = 0;

      // 0) 跨零点的当天档整块下沉（李小灵：当天的话原样全量，过零点才归档）
      const 当天 = data['当天'];
      if (当天.length) {
        const keep = [];
        for (const row of 当天) {
          const m = row.match(/^\[(\d{4}-\d{2}-\d{2})/);
          const d = m ? m[1] : '';
          const old = d && (Date.now() - new Date(d + 'T00:00:00').getTime()) / 86400000 >= archiveDays;
          if (old) {
            const sec = classify('', row) === '红线' ? '红线' : classify('', row);
            data[sec === '当天' ? '常识' : sec].push(row);
            report.分区[sec] = (report.分区[sec] || 0) + 1;
            report.下沉++;
            变化++;
          } else {
            keep.push(row);
          }
        }
        data['当天'] = keep;
      }

      // 1) 收增量
      for (const src of this.lineSources()) {
        const lines = this.readLine(src);
        const from = ledger[src] || 0;
        const fresh = lines.slice(from).slice(0, perSource);
        if (!fresh.length) continue;

        const seen = new Set();
        for (const sec of SECTIONS) for (const r of data[sec]) seen.add(norm(r));

        for (const item of fresh) {
          const raw = String(item.text || '');
          if (!worthKeeping(raw)) { report.跳过++; continue; }
          const line = digest(raw);
          const key = norm(line);
          if (!key || seen.has(key)) { report.跳过++; continue; }
          seen.add(key);

          // 新条目先进「当天」；红线直接归红线区（永不衰减）
          const sec = classify(item.tag, raw);
          // digest 已经带了 [日期]，不要再套一层时间戳
          const row = line;
          if (sec === '红线') {
            data['红线'].push(`[红线] ${line}`);
            report.分区['红线'] = (report.分区['红线'] || 0) + 1;
          } else {
            data['当天'].push(row);
            report.分区['当天'] = (report.分区['当天'] || 0) + 1;
          }
          report.新增++;
          变化++;
        }

        ledger[src] = Math.min(from + perSource, lines.length);
        this.appendLedger({ 时间: ts(), 来源: src, 到: ledger[src], 新增: fresh.length, 分区: report.分区 });
      }

      // 2) 当天档字节保险：条数没超但字太多，也会撑爆提示词，把最老的沉进「进行」
      {
        let size = (data['当天'] || []).reduce((a, r) => a + r.length + 3, 0);
        while (size > this.dayMaxChars && data['当天'].length > 1) {
          const r = data['当天'].shift();
          size -= r.length + 3;
          data['进行'].push(r);
        }
      }

      // 3) 容量压制：超上限从最老的往下压
      for (const sec of SECTIONS) {
        const cap = CAP[sec] || 400;
        const rows = data[sec];
        if (rows.length <= cap) continue;
        const overflow = rows.length - cap;
        const sunk = rows.splice(0, overflow);
        if (sec === '档案') continue;              // 档案到底了，只保留摘要行
        const target = sec === '进行' ? '常识' : '档案';
        for (const r of sunk) data[target].push(r);
      }
      // 档案超限：从最老的掐掉，但先把掐掉的记进档案库 C 段（不丢内容）
      if (data['档案'].length > CAP['档案']) {
        const drop = data['档案'].splice(0, data['档案'].length - CAP['档案']);
        this._appendArchive('C', drop);
      }

      // 没有实质变化就不写盘：自动归纳每十分钟跑一次，不能每次都改文件
      // （改了 mtime 就会让注入缓存失效，白读一遍）
      if (!变化) {
        report.消息 = '没有新流水，跳过';
        return report;
      }

      this.writeSections(data);
      this.appendChangelog('归纳', `新增 ${report.新增} 条`, `跳过 ${report.跳过} 条`);
      this._writeIndex(data);
      this._cache.stamp = '';

      report.消息 = `归纳完成：新增 ${report.新增} 条，跳过 ${report.跳过} 条（寒暄/重复/元内容）`;
      return report;
    } catch (e) {
      return { 新增: 0, 跳过: 0, 分区: {}, 消息: '归纳失败（已静默降级）：' + (e && e.message ? e.message : String(e)) };
    }
  }

  _appendArchive(sectionName, rows) {
    try {
      this.ensure();
      let raw = '';
      if (fs.existsSync(this.archiveFile)) raw = fs.readFileSync(this.archiveFile, 'utf8');
      if (!raw.trim()) {
        raw = '# 档案库（历史原样 · 按需查）\n\n# A. 主题事件全文\n\n# B. 原始流水（见 支线/*.jsonl 事实底稿）\n\n# C. 核心下沉结论\n\n';
      }
      const marker = sectionName === 'C' ? '# C. 核心下沉结论' : '# A. 主题事件全文';
      const i = raw.indexOf(marker);
      const block = rows.map((r) => '- ' + r).join('\n');
      raw = i >= 0
        ? raw.slice(0, i + marker.length) + '\n' + block + '\n' + raw.slice(i + marker.length)
        : raw + '\n' + block + '\n';
      fs.writeFileSync(this.archiveFile, raw, 'utf8');
    } catch { /* 静默 */ }
  }

  /** 索引：一行一条主题线（条数｜话头｜最近一句） */
  _writeIndex(data) {
    try {
      this.ensure();
      const lines = ['# 记忆索引（每次必读 · 只读这一页）', '',
        '> 一行一条：**线名（多少条）｜什么话头该翻它｜最近说到的一句人话 → 去哪本册子**。',
        '> 硬上限 8 KB；超了先砍条目、绝不砍字。', `> 生成：${ts()}`, ''];
      lines.push('## 核心（每次都在脑子里，不用翻）', '');
      lines.push(`- **红线 / 进行中 / 结论** → \`记忆核心.md\`（红线 ${(data['红线'] || []).length} · 进行 ${(data['进行'] || []).length} · 常识 ${(data['常识'] || []).length} · 当天 ${(data['当天'] || []).length} · 档案 ${(data['档案'] || []).length}）`);
      lines.push('', '## 主题线（要细节才翻 → `档案库.md`）', '');

      // 用支线里的 tag 当主题线
      const topics = new Map();
      for (const src of this.lineSources()) {
        for (const it of this.readLine(src)) {
          if (!worthKeeping(it.text)) continue;   // 寒暄别占索引版面
          const tp = topicOf(it.text, it.tag);
          const cur = topics.get(tp) || { n: 0, last: '' };
          cur.n++;
          cur.last = String(it.text || '').slice(0, 40);
          topics.set(tp, cur);
        }
      }
      const sorted = [...topics.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 40);
      for (const [tp, v] of sorted) {
        lines.push(`- **${tp}**（${v.n} 条）｜最近：${v.last.replace(/\n/g, ' ')}… → \`档案库.md#${tp}\``);
      }
      if (!sorted.length) lines.push('- （还没有主题线，先用 memory_remember 记一条）');
      lines.push('', '- **原始流水**（全量）→ `支线/*.jsonl`', '- **核心下沉结论** → `档案库.md` C 段');
      fs.writeFileSync(this.indexFile, lines.join('\n') + '\n', 'utf8');
    } catch { /* 静默 */ }
  }

  // ---------- 注入 ----------

  /**
   * 生成给系统提示词的记忆块。
   * 核心区全量 → 当天（不裁）→ 红线（不裁）→ 进行 → 常识，超预算按尾部裁剪。
   */
  buildInject(budget = 15000) {
    try {
      // 缓存：记忆核心.md 没变就不重解析。它每个模型步都会被调一次。
      let stamp = '0';
      try { stamp = String(fs.statSync(this.busFile).mtimeMs); } catch { /* 没有文件 */ }
      const key = stamp + '|' + budget;
      if (this._injectCache.stamp === key) return this._injectCache.text;

      const data = this.readSections();
      const parts = [];
      let used = 0;

      // 顺序照李小灵定案：当天（不裁）→ 红线（不裁）→ 进行 → 常识
      const order = [['当天', -1], ['红线', -1], ['进行', 30], ['常识', 70]];
      for (const [sec, tailN] of order) {
        let rows = data[sec] || [];
        if (!rows.length) continue;
        if (tailN >= 0) rows = rows.slice(-tailN);

        const title = '### ' + SECTION_TITLE[sec].replace(/^#\s*/, '');
        let block = [title].concat(rows.map((r) => '- ' + r)).join('\n');
        if (sec === '当天' && block.length > 60000) {
          block = title + '\n（当天档过长，此处只贴末尾）\n' + block.slice(-60000);
        }

        // 只有「进行 / 常识」允许按预算裁尾；当天和红线全量
        if (used + block.length > budget && sec !== '当天' && sec !== '红线') {
          const keep = [];
          let room = budget - used;
          for (const r of [...rows].reverse()) {
            if (room - (r.length + 3) < 0) break;
            keep.unshift(r);
            room -= r.length + 3;
          }
          if (!keep.length) continue;
          block = [title].concat(keep.map((r) => '- ' + r)).join('\n');
        }
        parts.push(block);
        used += block.length;
      }

      if (!parts.length) {
        const empty = '### 记忆四册（还没内容）\n- 用 `memory_remember` 记第一条，用 `memory_recall` 查旧账。';
        this._injectCache = { stamp: key, text: empty };
        return empty;
      }
      const out = '## 记忆四册（长期记忆 · 本机四册架构）\n\n' + parts.join('\n\n');
      this._injectCache = { stamp: key, text: out };
      return out;
    } catch {
      return '';
    }
  }

  // ---------- 检索 ----------

  /** 支线文件指纹：文件数 + 总字节。只增不改，所以字节数变就是有新流水 */
  _lineStamp() {
    try {
      const files = fs.readdirSync(this.lineDir).filter((f) => f.endsWith('.jsonl'));
      let total = 0;
      for (const f of files) {
        try { total += fs.statSync(path.join(this.lineDir, f)).size; } catch { /* 跳过 */ }
      }
      return files.length + ':' + total;
    } catch {
      return '0:0';
    }
  }

  /** 全库文档：五分区 + 支线流水（超量时只保留最近的那批，避免检索越来越慢） */
  _docs() {
    let stamp = this._lineStamp();
    for (const f of [this.busFile, this.archiveFile]) {
      try { stamp += '|' + fs.statSync(f).mtimeMs; } catch { stamp += '|0'; }
    }
    if (this._cache.stamp === stamp && this._cache.docs) return this._cache.docs;

    const docs = [];
    const data = this.readSections();
    for (const sec of SECTIONS) {
      (data[sec] || []).forEach((text, i) => {
        docs.push({ id: `${sec}#${i}`, title: sec, text, meta: { 分区: sec } });
      });
    }

    // 支线原始流水（事实底稿）
    const flat = [];
    for (const src of this.lineSources()) {
      this.readLine(src).forEach((it, i) => flat.push({ src, i, it }));
    }
    const start = Math.max(0, flat.length - this.indexMaxDocs);
    for (const { src, i, it } of flat.slice(start)) {
      if (!worthKeeping(it.text)) continue;
      docs.push({
        id: `支线/${src}#${i}`,
        title: src,
        text: String(it.text || ''),
        meta: { 来源: src, t: it.t },
      });
    }

    this._cache = { stamp, docs, index: null };
    return docs;
  }

  /** BM25 召回 + 时间衰减（老事按半衰期 120 天打折，下限 0.4，不会彻底查不到） */
  recall(query, k = 6) {
    try {
      const docs = this._docs();
      if (!docs.length) return { 问: query, 命中: [], 说明: '记忆还是空的' };
      if (!this._cache.index) {
        this._cache.index = new Bm25Index();
        this._cache.index.build(docs);
      }
      // 先多取几倍，乘完衰减再重排，免得「分高但太老」的挤掉正解
      const raw = this._cache.index.search(query, Math.min(docs.length, Math.max(k * 4, k)));
      const hits = raw
        .map((h) => {
          const f = decayOf(dateOf(h.text, h.meta));
          return { ...h, score: Math.round(h.score * f * 1000) / 1000, 衰减: Math.round(f * 100) / 100 };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
      return { 问: query, 命中: hits };
    } catch (e) {
      return { 问: query, 命中: [], 错误: String(e && e.message ? e.message : e) };
    }
  }

  // ---------- 状态 ----------

  status() {
    const data = this.readSections();
    const size = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
    return {
      数据目录: this.dir,
      四册: {
        记忆核心: { 路径: this.busFile, 字节: size(this.busFile) },
        MEMORY_INDEX: { 路径: this.indexFile, 字节: size(this.indexFile) },
        档案库: { 路径: this.archiveFile, 字节: size(this.archiveFile) },
        变更日志: { 路径: this.changelogFile, 字节: size(this.changelogFile) },
      },
      分区条数: Object.fromEntries(SECTIONS.map((s) => [s, (data[s] || []).length])),
      上限: CAP,
      支线: this.lineSources().map((s) => ({ 来源: s, 条数: this.readLine(s).length })),
    };
  }
}
