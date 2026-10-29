# dsh-plugin-memory-four-books

DeepSeek Harness 的分层长期记忆插件。

它不把一大坨历史塞进每一次提示词，而是把记忆分成**五个有先后的层**，只注入装得下的部分：最贵的信息（红线）永远在场，便宜的细节留在硬盘上等模型来问。

零依赖、纯 Markdown + JSONL、不联网、不起后台服务、不建数据库。

## 安装

```bash
dsh plugin --profile <你的 profile> add github:wodexiaoling/dsh-plugin-memory-four-books
```

只走 GitHub 分发，没有发到 npm。`dsh` 会把仓库拉进 profile 并当 bundle 挂上。

以后更新：

```bash
dsh plugin --profile <你的 profile> remove dsh-plugin-memory-four-books
dsh plugin --profile <你的 profile> add github:wodexiaoling/dsh-plugin-memory-four-books
```

## 它怎么跑

```
你说话
   ↓
agent/pre-step ──→ 过滤后追加进 支线/对话.jsonl
   ↓
模型继续
   ↓
每 10 分钟 ──→ 归纳 ──→ 真有变化才写层
```

**自动留底。** 你发的每条消息都会先过一遍筛子（寒暄、重复、系统注入的上下文都丢掉），然后追加进只增不改的流水。

**自动归纳。** 每十分钟把流水摘要成一行一条、去重、分到五个层。**不删任何东西**——老条目只是往下一层沉。

**分层注入。** 每个模型步之前重拼一次提示词块：

| 层 | 注入策略 | 上限 |
|---|---|---|
| 当天 | 永远全量，一字不裁 | 400 条 |
| 红线 | 永远全量，永不衰减 | 40 条 |
| 进行中 | 最新 30 条 | 80 条 |
| 常识 | 最新 70 条 | 260 条 |
| 档案 | 按需查 | 800 条 |

这个块按文件 mtime 缓存：记忆没变，一个字节都不会多花。

**BM25 召回。** `memory_recall` 对全部层 + 原始流水建 BM25 索引（中文 2-gram，`k1=1.5 b=0.75`），再乘一个 120 天半衰期的时间衰减（下限 0.4）——老事还查得到，但挤不掉新事。

## 工具

| 工具 | 干什么 |
|---|---|
| `memory_recall` | 按关键词查记忆 |
| `memory_remember` | 按标签记一条 |
| `memory_consolidate` | 立刻跑一次归纳 |
| `memory_status` | 看各层条数、上限、文件大小、自动化状态 |

## 配置

全部可选，写在插件那一行的 `config` 里：

| 字段 | 默认 | 含义 |
|---|---|---|
| `dataDir` | `$DSH_HOME/memory-four-books` | 记忆放哪 |
| `inject` | `true` | 是否往提示词里注入 |
| `injectBudget` | `15000` | 注入块的字符预算 |
| `sectionOrder` | `45` | 提示词段的排序位 |
| `autoRecord` | `true` | 是否自动抄你说的话 |
| `autoConsolidate` | `true` | 是否定时归纳 |
| `consolidateMinutes` | `10` | 定时间隔 |
| `dayMaxChars` | `8000` | 当天层的字节保险 |
| `indexMaxDocs` | `20000` | 检索索引最多保留多少条流水 |

## 数据在哪

```
$DSH_HOME/memory-four-books/
  支线/对话.jsonl            只增不改的流水
  四册/记忆核心.md            五个层（被注入的就是它）
  四册/MEMORY_INDEX.md       一行一条主题线
  四册/档案库.md             档案
  四册/memory_changelog.md   只追加的变更日志
  归纳台账.jsonl             归纳台账
```

全是纯 UTF-8 文本。可以打开看、手动改、备份、直接删——派生文件都能从流水重建。

## 隐私

**这个插件会把你说的话记在本机。** 数据不出机器：插件不联网、不起服务。记忆以**明文**存在 `dataDir` 下。

只想手动记的话，设 `"autoRecord": false`。

## 已知限制

- 记忆是整个 profile 共享的，**不按工作区分库**。
- 不加密。
- 不进 session log，所以 fork 会话不会 fork 记忆。
- 中文/英文支持最好；其他文字按单字 n-gram 兜底，召回质量会下降。
- 依赖 DSH `>= 0.2.0`（用到 `agent/pre-step` 和 `systemPrompt.section`）。

## 许可证

MIT
