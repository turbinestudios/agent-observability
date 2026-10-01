# Developing the VS Code extension

User documentation is in [README.md](README.md). This page is for people
working on the extension itself. Start with [AGENTS.md](../../../AGENTS.md) at
the repo root, which covers the rules every change must keep.

## Build and test

Install once from the **repo root** (`npm install`). Then, in this folder:

```bash
npm run compile    # bundle to dist/extension.js with esbuild
npm run watch      # incremental build with sourcemaps
npm run typecheck  # tsc --noEmit (strict)
npm run lint       # eslint
npm test           # vitest, headless
npm run package    # build the .vsix
```

Press <kbd>F5</kbd> in VS Code to start an Extension Development Host, then open
**Agent Observability** in the Activity Bar.

## The SQLite engine (`node-sqlite3-wasm`)

The extension reads Copilot's SQLite database with **`node-sqlite3-wasm`**, a
WebAssembly build of SQLite. It has no native `.node` binary, so there is no
Node or Electron version to match: one `.vsix` works on every VS Code version.
(It replaced `better-sqlite3`, whose native binary failed with
`ERR_DLOPEN_FAILED` when VS Code's Electron differed from the build machine.)

Packaging rules:

- **It is external, not bundled.** esbuild leaves `node-sqlite3-wasm` out of
  `dist/extension.js`, because its loader finds the `.wasm` file next to itself.
- **It is staged into `dist/node_modules`.** npm workspaces hoist it to the
  repo root, out of reach of `.vscodeignore`, so `scripts/stageSqliteWasm.js`
  copies it into `dist/` during `compile`. Never re-add a `!node_modules/**`
  rule.
- **Check the package.** Run `npx vsce ls --no-dependencies` and make sure the
  `.wasm` file is listed.

## Where the code lives

Most of the logic is in the shared package
[`@agent-observability/core`](../../core/agent-observability-core), which the
desktop app also uses. It must not import `vscode` (that is a lint error). When
core needs something from the host, it declares an interface and this
extension implements it.

Paths below are inside core's `src/` unless marked *(extension)*.

- `config/configuration.ts`: typed access to the `agentObservability.*`
  settings through the `SettingsReader` interface. *(extension)*
  `src/config/vscodeSettings.ts` is the VS Code side and the only place that
  calls `vscode.workspace.getConfiguration`.
- *(extension)* `src/views/*.ts`: each tree view has a `getRootItems()` method
  that supplies its rows, and a `refresh()` event. The HTML renderers, such as
  `views/sessionDetailHtml.ts`, are in core and are plain string builders.
- *(extension)* `src/commands/index.ts`: command ids and handlers.
- `telemetry/*`: read-only SQLite snapshot and queries over safe metadata.
- `aggregate/*`: the aggregate engine, pseudonymizer, and the privacy contract
  test.
- `consent/*`, `sync/*`: consent checks and upload, behind `SyncStateStore`.
  *(extension)* `src/secrets/secretManager.ts` keeps the API key in
  SecretStorage, and `src/sync/globalStateSyncStateStore.ts` keeps sync state
  in `globalState`.
- Other host adapters *(extension)*: `src/log/outputChannelLogger.ts`,
  `src/live/vscodeFileWatchFactory.ts`, `src/consent/consentManager.ts`, and
  `src/chat/backends/copilotBackend.ts` (the `vscode.lm` backend; the CLI
  backends are in core).
- `cloud/*`: the **Copilot (Cloud)** source. `cloudAgentPoller.ts` runs a
  background loop (one window at a time, through a lease). It uses `ghAuth.ts`
  for tokens and `cloudApiClient.ts` to fetch tasks and logs, and writes them
  into a local folder (`cloudSink.ts`). `copilotCloudSource.ts` reads that
  folder back, and `cloudMapper.ts` and `sseParser.ts` turn the raw data into
  the shared session model. Nothing here uploads: `getAggregationRows`
  returns `[]`.

Imports across packages include the `/src/` segment, which tsc, esbuild,
vitest and Vite all resolve without extra configuration:

```ts
import { SessionSummary } from '@agent-observability/core/src/telemetry/models';
```
