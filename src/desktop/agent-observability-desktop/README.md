# Agent Observability — Desktop

A standalone desktop app (macOS + Windows) for reading your agent sessions,
built on the same [`@agent-observability/core`](../../core/agent-observability-core)
as the VS Code extension. Same data, same parsing, same privacy posture — but
sessions-first, and much faster to open.

It reads the same on-disk data the extension does and coexists with it; running
both at once is expected and safe.

## Indexing performance

The extension builds its session list by parsing transcripts on demand, so the
list cannot appear until hundreds of megabytes have been read. This app keeps a
persisted index at `~/.agent-observability/desktop/index.db` and does that work
once, in the background.

Historical measurements on a real corpus (686 Claude transcripts at 805 MB,
plus a 1.6 GB Copilot archive — 230 sessions in total). These measure first
indexed rows and query execution, **not current end-to-end startup time**:

| | Indexer / list-query time |
| --- | --- |
| Extension, Claude (parse on demand) | 3,696 ms, capped at 150 sessions |
| Extension, Copilot (copy + WAL replay) | 68,365 ms for 47 sessions |
| Desktop, first indexed rows | **76 ms**, before full hydration |
| Desktop, warm list query | **0.8 ms**, all 230 sessions, uncapped |

The Copilot rows match the extension's exactly — same 47 sessions, same step
counts, same titles and repositories — which is the point: the speed is worth
nothing if the data differs.

The index uses the following optimizations:

- **Discovery before parsing.** A `readdir`/`stat` walk yields ids and mtimes,
  which is enough to paint a complete, correctly-ordered list. Real counts fill
  in afterwards, newest sessions first.
- **Claude fingerprinting.** A main transcript whose size and mtime are
  unchanged is not parsed again by the indexer.
- **Copilot's database is indexed in place.** The extension cannot open it — its
  SQLite driver refuses a WAL database — so it copies all 1.6 GB and replays the
  WAL by hand on every refresh. `better-sqlite3` speaks WAL natively, so the copy
  disappears from indexing, which uses aggregate queries. Nothing is ever
  written to Copilot's file.
- **Titles are indexed once.** They live in per-workspace stores totalling ~4 GB;
  the extension rereads all of them each refresh. Here a store whose mtime has
  not moved is skipped, and a changed session file is read only far enough to
  reach its first line.
- **Stable Copilot revisions.** Unchanged source metadata and database/WAL
  fingerprints preserve each row's revision, cached detail, and persisted
  analysis. Only changed rows are pushed to the renderer. Any database/WAL
  change conservatively invalidates the Copilot source set, including
  attribute-only edits and child activity invisible in summary counts.
- **Native detail and analysis reads.** These now read the archive in place too,
  using core's unchanged queries and schema validation. A short-lived read-only
  transaction pins each request's view, including related context queries, and
  closes before returning. WAL-only commits are visible to the next request;
  no idle reader prevents checkpointing. Titles come from the persisted local
  index overlaid on archived names, not a scan of workspace chat content.

Background indexing and analysis run in a dedicated worker thread with its own
SQLite WAL connection. The interactive data host reads the saved index while
the worker parses and writes short transactions. Startup waits only for the
interactive readiness queries, not the background pass; even on a first install
navigation is available while the list fills in. A warm list query alone still
does not measure end-to-end startup or large-detail rendering.

Refresh storms coalesce into one follow-up run. Deletion, rebuilding, and
settings/context-analysis changes serialize behind worker termination before
mutating the index, so an old pass cannot put removed rows or old verdicts back.
The worker finishes any archive-maintenance lease before becoming interruptible.
Late events from stopped workers are ignored, and row notifications are read
and decorated by the broker with the latest names, tags, notes, and hidden state.
Crashes report an error and can be retried with Refresh, without a restart loop.
Claude hydration commits each summary and its file fingerprint together, so an
interrupted worker cannot mark old counts as current and skip the next retry.

Copilot change tokens are an additive index sidecar, so upgrading does not
rebuild the index. The first refresh establishes a baseline for existing rows;
later unchanged refreshes reuse it. Unknown tokens or a database changing during
a read force revalidation instead of preserving potentially stale analysis.

The index is a cache and holds nothing that cannot be rederived — deleting it
(or using **Rebuild index**) is always safe.

The extension still uses its WASM snapshot reader. The desktop does not silently
fall back to copying when a native source cannot be read: it reports the failure
or uses another resolved native source. Startup retains cleanup of temporary
snapshots left behind by older desktop releases.

## Architecture

```
main            thin broker: window, theme, open-external, and the handshake
                that hands the renderer a direct port to the data host
renderer        React + Vite. Sessions is the left nav; other views open beside it
data host       utilityProcess serving interactive index queries, details, and AI requests
background      worker thread indexing/analyzing with its own WAL connection
```

Core's session API is synchronous, so it never runs on the main or renderer
thread — a slow parse would freeze whatever thread it lands on. It is wrapped
into promises exactly once, at the MessagePort boundary.

Only the broker initializes/migrates the index. Background workers require an
already-initialized schema and are disposable after each pass. The worker entry
is bundled beside the broker and shipped by the existing `out/**` package rule.
User-requested large detail/combined renders still run synchronously in the
broker; deduplicating those calculations and rendering large timelines lazily
remain separate performance work.

## Development

```bash
npm install            # at the repo root; this is a workspace
npm run dev     -w agent-observability-desktop   # hot reload
npm run build   -w agent-observability-desktop
npm test        -w agent-observability-desktop
```

Benchmarks (bundle first, then run):

```bash
npx esbuild scripts/benchmark.ts --bundle --platform=node --format=cjs \
  --external:better-sqlite3 --outfile=scripts/benchmark.js && node scripts/benchmark.js
```

`compare.ts` runs the extension's approach and this one over the same corpus,
which is where the table above comes from.

## Installing a release

Builds are **unsigned**, so both platforms will warn on first launch:

- **macOS** — "cannot be opened because it is from an unidentified developer".
  Right-click the app and choose **Open**, then confirm. Or clear the quarantine
  flag: `xattr -cr "/Applications/Agent Observability.app"`. Download the `arm64`
  build for Apple Silicon and `x64` for Intel; the wrong one will not launch.
- **Windows** — SmartScreen shows "Windows protected your PC". Choose
  **More info** → **Run anyway**.

## Privacy

Identical to the extension: raw session content is read locally and never
uploaded. The only outbound path is opt-in aggregate sync, which stays gated on
explicit consent plus an API key. See [AGENTS.md](../../../AGENTS.md).
