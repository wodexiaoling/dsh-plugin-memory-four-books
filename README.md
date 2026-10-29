# dsh-plugin-memory-four-books

Layered long-term memory for DeepSeek Harness.

Instead of dumping a huge history file into every prompt, this plugin keeps memory in **five ordered tiers** and only injects what fits. Expensive information (red lines) is always present; cheap details wait on disk until the model asks for them.

Zero dependencies. Plain Markdown and JSONL on disk. No network calls, no background services, no database.

## Install

```bash
dsh plugin --profile <your-profile> add github:wodexiaoling/dsh-plugin-memory-four-books
```

The plugin is distributed through GitHub only — it is not published on npm. `dsh` clones the repository into the profile and links it as a bundle.

To update later:

```bash
dsh plugin --profile <your-profile> remove dsh-plugin-memory-four-books
dsh plugin --profile <your-profile> add github:wodexiaoling/dsh-plugin-memory-four-books
```

## How it works

```
you type
   ↓
agent/pre-step ──→ filtered and appended to 支线/对话.jsonl
   ↓
model runs
   ↓
every 10 min ──→ consolidate ──→ writes tiers only when something changed
```

**Automatic capture.** Every message you send is filtered (greetings, duplicates and injected runtime context are dropped) and appended to an append-only journal.

**Automatic consolidation.** Every ten minutes the journal is summarised into one line per entry, de-duplicated and sorted into tiers. Nothing is deleted — old entries move down a tier.

**Tiered injection.** Before every model step the plugin rebuilds a prompt block from the tiers:

| Tier | Injected | Cap |
|---|---|---|
| 当天 / today | always, never truncated | 400 entries |
| 红线 / red lines | always, never truncated, never decayed | 40 entries |
| 进行中 / in progress | latest 30 | 80 entries |
| 常识 / common sense | latest 70 | 260 entries |
| 档案 / archive | only on demand | 800 entries |

The block is cached by file mtime, so an unchanged memory costs nothing.

**BM25 recall.** `memory_recall` runs a BM25 index (Chinese 2-gram, `k1=1.5 b=0.75`) over every tier plus the raw journal, then applies a 120-day half-life decay with a floor of `0.4` so old entries stay findable but stop crowding out recent ones.

## Tools

| Tool | Purpose |
|---|---|
| `memory_recall` | search memory by keyword |
| `memory_remember` | store one entry under a tag |
| `memory_consolidate` | run consolidation now |
| `memory_status` | tier counts, caps, file sizes, automation state |

## Config

All fields are optional; set them in the plugin row's `config`:

| Field | Default | Meaning |
|---|---|---|
| `dataDir` | `$DSH_HOME/memory-four-books` | where memory lives |
| `inject` | `true` | inject the tier block into prompts |
| `injectBudget` | `15000` | character budget for the injected block |
| `sectionOrder` | `45` | order of the prompt section |
| `autoRecord` | `true` | capture user messages automatically |
| `autoConsolidate` | `true` | run consolidation on a timer |
| `consolidateMinutes` | `10` | timer interval |
| `dayMaxChars` | `8000` | byte guard for the "today" tier |
| `indexMaxDocs` | `20000` | max journal rows kept in the search index |

## Where data lives

```
$DSH_HOME/memory-four-books/
  支线/对话.jsonl            append-only journal
  四册/记忆核心.md            the five tiers (this is what gets injected)
  四册/MEMORY_INDEX.md       one line per topic
  四册/档案库.md             archive
  四册/memory_changelog.md   append-only change log
  归纳台账.jsonl             consolidation ledger
```

Everything is plain UTF-8. Open it, edit it, back it up, delete it — the plugin rebuilds derived files from the journal.

## Privacy

**This plugin records what you type, locally.** No data leaves the machine: the plugin makes no network requests and starts no server. Memory is stored unencrypted in `dataDir`.

Disable capture with `"autoRecord": false` if you only want manual `memory_remember`.

## Limits

- Memory is shared by every session and subagent in a profile. It is not scoped per workspace.
- It is not encrypted.
- It is not part of the session log, so forking a session does not fork its memory.
- Japanese/Chinese/English text is supported; other scripts fall back to single-character n-grams and recall quality drops.
- The plugin assumes DSH `>= 0.2.0` (uses `agent/pre-step` and `systemPrompt.section`).

## License

MIT
