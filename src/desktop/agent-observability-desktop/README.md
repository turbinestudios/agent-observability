# Agent Observability — Desktop

A standalone desktop app (macOS + Windows) for reading your agent sessions,
built on the same [`@agent-observability/core`](../../core/agent-observability-core)
as the VS Code extension. Same data, same parsing, same privacy posture — but
sessions-first, and much faster to open.

It reads the same on-disk data the extension does and coexists with it; running
both at once is expected and safe.

## Why it is fast

The extension builds its session list by parsing transcripts on demand, so the
list cannot appear until hundreds of megabytes have been read. This app keeps a
persisted index at `~/.agent-observability/desktop/index.db` and does that work
once, in the background.

Measured on a real corpus (686 Claude transcripts at 805 MB, plus a 1.6 GB
Copilot archive — 230 sessions in total):

| | Time to a usable list |
| --- | --- |
| Extension, Claude (parse on demand) | 3,696 ms, capped at 150 sessions |
| Extension, Copilot (copy + WAL replay) | 68,365 ms for 47 sessions |
| Desktop, first launch | **76 ms**, then hydrates behind the list |
| Desktop, every launch after | **0.8 ms**, all 230 sessions, uncapped |

The Copilot rows match the extension's exactly — same 47 sessions, same step
counts, same titles and repositories — which is the point: the speed is worth
nothing if the data differs.

Three things make that work:

- **Discovery before parsing.** A `readdir`/`stat` walk yields ids and mtimes,
  which is enough to paint a complete, correctly-ordered list. Real counts fill
  in afterwards, newest sessions first.
- **Fingerprinting.** A file whose size, mtime, and head hash are unchanged is
  never reopened, so a no-op refresh over the whole corpus costs ~113 ms.
- **Copilot's database is read in place.** The extension cannot open it — its
  SQLite driver refuses a WAL database — so it copies all 1.6 GB and replays the
  WAL by hand on every refresh. `better-sqlite3` speaks WAL natively, so the copy
  disappears and a refresh becomes one aggregate query. Nothing is ever written
  to Copilot's file.
- **Titles are indexed once.** They live in per-workspace stores totalling ~4 GB;
  the extension rereads all of them each refresh. Here a store whose mtime has
  not moved is skipped, and a changed session file is read only far enough to
  reach its first line.
- **Nothing heavy on the UI path.** Parsing runs in a separate process; the
  interactive query is one indexed `SELECT`.

The index is a cache and holds nothing that cannot be rederived — deleting it
(or using **Rebuild index**) is always safe.

## Architecture

```
main            thin broker: window, theme, open-external, and the handshake
                that hands the renderer a direct port to the data host
renderer        React + Vite. Sessions is the left nav; other views open beside it
data host       utilityProcess owning the index, the source registry, and all parsing
```

Core's session API is synchronous, so it never runs on the main or renderer
thread — a slow parse would freeze whatever thread it lands on. It is wrapped
into promises exactly once, at the MessagePort boundary.

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
