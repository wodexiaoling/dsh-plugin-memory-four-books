/**
 * BM25 检索（移植自李小灵「云脑」brain.py 的纯标准库实现）
 *
 * 设计要点（原样搬过来）：
 *  - 中文走 2-gram（跳过标点空格），英文/数字走词
 *  - k1 = 1.5, b = 0.75，idf 用 log(1 + (N - df + 0.5) / (df + 0.5))
 *  - 零依赖，几毫秒一次，50 万字量级够用
 */

const WORD_RE = /[A-Za-z0-9_]{2,}/g;
const CJK_RE = /[\u4e00-\u9fff]/g;

/** 把一段文字切成检索用的 token 数组 */
export function tokenize(text) {
  const s = String(text || '');
  const out = [];

  // 英文/数字词：直接小写入表
  const words = s.match(WORD_RE);
  if (words) for (const w of words) out.push(w.toLowerCase());

  // 汉字：只取 2-gram（单字时退化成一个）
  const han = s.match(CJK_RE);
  if (han) {
    for (let i = 0; i < han.length - 1; i++) out.push(han[i] + han[i + 1]);
    if (han.length === 1) out.push(han[0]);
  }
  return out;
}

export class Bm25Index {
  constructor() {
    this.docs = [];   // [{ id, title, text, meta }]
    this.tf = [];     // 每篇词频
    this.df = new Map(); // 词 -> 文档频率
    this.avgdl = 1;
    this.N = 0;
  }

  /** 全量重建索引（数据量小，重建比增量维护简单且不会漂） */
  build(docs) {
    this.docs = docs;
    this.tf = [];
    this.df = new Map();
    let total = 0;
    for (const d of docs) {
      const toks = tokenize(`${d.title || ''} ${d.text || ''}`);
      const c = new Map();
      for (const t of toks) c.set(t, (c.get(t) || 0) + 1);
      this.tf.push(c);
      for (const t of c.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
      total += toks.length;
    }
    this.N = docs.length;
    this.avgdl = this.N ? total / this.N : 1;
    return this.N;
  }

  /**
   * 检索 top-k。
   * @returns {{score:number, id:string, title:string, text:string, meta:object}[]}
   */
  search(query, k = 6) {
    const qt = tokenize(query);
    if (!qt.length || !this.N) return [];

    const k1 = 1.5;
    const b = 0.75;
    const scores = new Map();

    for (const t of new Set(qt)) {
      const df = this.df.get(t);
      if (!df) continue;
      const idf = Math.log(1 + (this.N - df + 0.5) / (df + 0.5));
      for (let i = 0; i < this.tf.length; i++) {
        const c = this.tf[i];
        const f = c.get(t);
        if (!f) continue;
        let dl = 0;
        for (const v of c.values()) dl += v;
        if (!dl) dl = 1;
        const cur = scores.get(i) || 0;
        scores.set(i, cur + (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * dl) / this.avgdl)));
      }
    }

    return [...scores.entries()]
      .sort((a, b2) => b2[1] - a[1])
      .slice(0, k)
      .map(([i, sc]) => ({
        score: Math.round(sc * 1000) / 1000,
        id: this.docs[i].id,
        title: this.docs[i].title,
        text: this.docs[i].text.slice(0, 600),
        meta: this.docs[i].meta || {},
      }));
  }
}

/** 把一句话切出 2~3 字的关键片段（用于「按需召回」的关键词匹配，比 BM25 更轻） */
const STOP_CHARS = new Set(
  '的了是在有和与就都也还把被给对从到而且之其所以这个那个我你他她它们很没有不么呢吧啊哦嗯会要能可如若因由因为于为上下里外中时',
);
const COMMON_GRAMS = new Set([
  '老大', '什么', '这个', '那个', '怎么', '可以', '已经', '就是', '不是', '我们', '他们',
  '一个', '没有', '因为', '所以', '但是', '而且', '如果', '现在', '今天', '时候', '问题',
  '东西', '这样', '那样', '还是', '然后', '自己', '一下', '过来', '出来', '起来', '上去',
  '下来', '知道', '觉得',
]);

export function grams(query, hi = 3) {
  const cleaned = String(query || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, ' ').trim();
  const out = new Set();
  if (!cleaned) return out;
  for (const token of cleaned.split(/\s+/)) {
    if (/^[A-Za-z0-9]+$/.test(token)) {
      if (token.length >= 2) out.add(token.toLowerCase());
      continue;
    }
    for (let size = 2; size <= hi; size++) {
      for (let i = 0; i <= token.length - size; i++) {
        const g = token.slice(i, i + size);
        let allStop = true;
        for (const ch of g) if (!STOP_CHARS.has(ch)) { allStop = false; break; }
        if (allStop || COMMON_GRAMS.has(g)) continue;
        out.add(g);
      }
    }
  }
  return out;
}
