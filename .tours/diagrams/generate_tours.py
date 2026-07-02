#!/usr/bin/env python
"""
Generate per-flow sequence-diagram CodeTours for agent-observability.

For every end-to-end flow this emits:
  * one highlighted Mermaid variant per numbered step (the current step's
    message wrapped in a colored `rect`), all concatenated into a single
    `all.md` so `mmdc` renders every diagram in one Chromium launch;
  * one `.tours/<id>.tour` file whose steps embed the rendered SVG at the top,
    reference the step number in the diagram, and anchor to the real code line.

Every diagram message is a numbered step (autonumber), so request AND response
arrows each get their own step + code anchor — matching how these flows were
already toured.

Render step (run after this script):
  npx -y @mermaid-js/mermaid-cli@latest -i .tours/diagrams/all.md \
      -o .tours/diagrams/d.svg -c .tours/diagrams/mermaid-config.json -b white
  -> writes .tours/diagrams/d-1.svg ... d-N.svg in global step order.

Shrink step (run after mmdc): mmdc emits `width="100%"` + a large `max-width`,
which CodeTour (embedding each SVG as an <img>) renders at full size, forcing
the reader to scroll. Give each SVG an explicit, capped pixel width/height so it
displays smaller in the step. Because these sequence diagrams are landscape and
CodeTour scrolls vertically, the cap is applied to whichever dimension binds
first (height-first), keeping every step's diagram within one screen:
  python .tours/diagrams/generate_tours.py --shrink            # default caps
  python .tours/diagrams/generate_tours.py --shrink 320 760    # height width
"""
import glob
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TOURS_DIR = os.path.join(ROOT, ".tours")
DIAG_DIR = os.path.join(TOURS_DIR, "diagrams")
os.makedirs(DIAG_DIR, exist_ok=True)

# On-screen caps (px) for the embedded diagrams in a tour step. Height is the
# meaningful limit (CodeTour scrolls vertically); width is a safety bound.
SVG_HEIGHT_CAP = 320
SVG_WIDTH_CAP = 760


def shrink_svgs(height_cap=SVG_HEIGHT_CAP, width_cap=SVG_WIDTH_CAP):
    """Rewrite each rendered d-*.svg so it displays smaller in a CodeTour step.

    mmdc emits `width="100%"` plus a `max-width` equal to the diagram's natural
    width. Because CodeTour embeds the SVG as an <img>, a percentage width is
    unreliable and the image renders at that large natural size. We replace the
    root <svg> width/height with explicit pixels derived from the viewBox,
    scaled down so it fits within height_cap x width_cap (aspect preserved,
    never upscaled). The viewBox is left intact, so re-running with different
    caps re-derives from the original geometry.
    """
    n = 0
    for path in sorted(glob.glob(os.path.join(DIAG_DIR, "d-*.svg"))):
        with open(path, encoding="utf-8") as fh:
            svg = fh.read()
        vb = re.search(r'viewBox="[-\d.]+ [-\d.]+ ([-\d.]+) ([-\d.]+)"', svg)
        if not vb:
            continue
        cw, ch = float(vb.group(1)), float(vb.group(2))
        scale = min(width_cap / cw, height_cap / ch, 1.0)
        w = round(cw * scale)
        h = round(ch * scale)

        def fix(m, w=w, h=h):
            tag = re.sub(r'\s(?:width|height)="[^"]*"', "", m.group(0))
            if 'style="' in tag:
                tag = re.sub(
                    r'style="[^"]*"',
                    f'style="max-width:{w}px;background-color:white;"',
                    tag,
                )
            return f'<svg width="{w}" height="{h}"' + tag[len("<svg"):]

        svg = re.sub(r"<svg[^>]*>", fix, svg, count=1)
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(svg)
        n += 1
    print(f"shrunk {n} svgs (height<={height_cap}px, width<={width_cap}px)")


if "--shrink" in sys.argv:
    nums = [int(a) for a in sys.argv[1:] if a.isdigit()]
    if len(nums) >= 2:
        shrink_svgs(nums[0], nums[1])
    elif len(nums) == 1:
        shrink_svgs(nums[0])
    else:
        shrink_svgs()
    sys.exit(0)


def P(alias, label, actor=False):
    return (alias, label, actor)


def S(a, b, txt, file, line, title, desc, ret=False):
    return dict(a=a, b=b, txt=txt, file=file, line=line, title=title, desc=desc, ret=ret)


# Short workspace-relative path roots.
EXT = "src/extension/agent-observability-vscode/src"
DASH = "src/dashboard/AgentObservability.Dashboard"

FLOWS = [
    # 01 ──────────────────────────────────────────────────────────────────────
    dict(
        id="flow-01-copilot-session-read",
        title="1: Copilot session read",
        desc_tour="End-to-end: how opening the extension turns on-disk Copilot telemetry into rows in the Sessions view. Every step embeds the numbered sequence diagram and points at the exact code for that step.",
        parts=[P("Dev", "Dev", actor=True), P("Ext", "extension.ts"), P("View", "Sessions view"), P("Reg", "SourceRegistry"), P("Src", "CopilotSource"), P("DB", "TelemetryDatabase")],
        steps=[
            S("Dev", "Ext", "Open the extension", f"{EXT}/extension.ts", 63, "Step 1 — Open the extension",
              "Opening the workspace fires the extension's single entry point, `activate()`. Everything downstream — sources, views, live updates — is wired here, and the read-only, privacy-first pipeline starts: nothing is read from disk until a view actually asks for it."),
            S("Ext", "Reg", "activate() builds registry", f"{EXT}/extension.ts", 77, "Step 2 — Build the SourceRegistry",
              "`activate()` builds a `SourceRegistry` over the two telemetry sources — `CopilotSource` and the Claude source. The registry is the seam the views talk to, so no view ever knows which on-disk database it is really reading from."),
            S("Ext", "View", "register tree providers", f"{EXT}/extension.ts", 199, "Step 3 — Register the tree views",
              "The Sessions tree is registered with `createTreeView(..., { canSelectMany: true })` so several sessions can be selected and combined. Registration only wires the provider — still no telemetry is read yet."),
            S("View", "Reg", "getChildren()", f"{EXT}/views/sessionsView.ts", 34, "Step 4 — getChildren() lazy trigger",
              "When the user expands the Sessions view, VS Code calls `getChildren`. This is the lazy trigger — the first point where the extension actually goes looking for data."),
            S("Reg", "Src", "listSessions()", f"{EXT}/views/sessionsView.ts", 85, "Step 5 — View asks the source for sessions",
              "Drilling into a repository, `getSessions` calls `source.listSessions(repository, limit)`. The view holds no data of its own; it always pulls from the source on demand."),
            S("Src", "DB", "readonly snapshot + query", f"{EXT}/telemetry/snapshot.ts", 72, "Step 6 — Read-only snapshot",
              "Reads never touch Copilot's live database directly. `createReadonlySnapshot` copies the on-disk DB (replaying its WAL) into a throwaway read-only snapshot, so queries can't race with or mutate the original file."),
            S("DB", "Src", "session rows", f"{EXT}/telemetry/database.ts", 417, "Step 7 — Summary query returns rows", ret=True,
              desc="`TelemetryDatabase.listSessions` runs the summary query against the snapshot and returns one row per session — counts, durations, token totals — but no raw prompt or completion text."),
            S("Src", "View", "SessionRow[]", f"{EXT}/sources/sessionSource.ts", 107, "Step 8 — Source returns SessionSummary[]", ret=True,
              desc="`CopilotSource.listSessions` hands the `SessionSummary[]` back up through the registry to the view, unchanged. The source is a thin adapter over `TelemetryService`."),
            S("View", "Dev", "render session tree", f"{EXT}/views/sessionsView.ts", 50, "Step 9 — Paint the session tree", ret=True,
              desc="Finally the view turns those summaries into tree items in `getRoots`/`getRepositories`, and the Sessions panel paints. The loop stays lazy: collapse and re-expand and the whole chain runs again."),
        ],
    ),
    # 02 ──────────────────────────────────────────────────────────────────────
    dict(
        id="flow-02-session-detail-token-trend",
        title="2: Session detail & token trend",
        desc_tour="End-to-end: one click on a session, through the ONE method that reads raw content, to the inline SVG token-trend graph. Every step embeds the numbered sequence diagram and points at the exact code for that step.",
        parts=[P("Dev", "Dev", actor=True), P("Panel", "sessionDetailPanel"), P("Svc", "TelemetryService"), P("DB", "TelemetryDatabase"), P("Html", "sessionDetailHtml")],
        steps=[
            S("Dev", "Panel", "Click a session", f"{EXT}/views/sessionDetailPanel.ts", 253, "Step 1 — Click a session",
              "Clicking a session invokes the panel's `render(panel, sourceId, sessionKey)`. The first render mounts the full webview document; later renders live-update just the body (see step 9)."),
            S("Panel", "Svc", "getSessionDetail(key)", f"{EXT}/views/sessionDetailPanel.ts", 258, "Step 2 — Ask the source for detail",
              "`render` asks the owning source for the full detail with `source.getSessionDetail(sessionKey)`. This is the click-to-data hop; the panel itself stores nothing."),
            S("Svc", "DB", "getSessionDetail()", f"{EXT}/telemetry/telemetryService.ts", 426, "Step 3 — Service delegates to the DB",
              "The Copilot source forwards to `TelemetryService.getSessionDetail`, which opens a read-only snapshot and delegates down to the database layer."),
            S("DB", "Svc", "SessionDetail (turns, tokens)", f"{EXT}/telemetry/database.ts", 639, "Step 4 — The ONLY raw-content read", ret=True,
              desc="`TelemetryDatabase.getSessionDetail` is, per its own comment just above (line 630), the ONLY method that reads raw content — prompts, completions, tool I/O. It assembles a `SessionDetail` that stays in-process and never reaches aggregation or sync."),
            S("Svc", "Panel", "SessionDetail", f"{EXT}/views/sessionDetailPanel.ts", 263, "Step 5 — Detail lands in the panel", ret=True,
              desc="Back in the panel, `const detail = result.value` holds the assembled turns, token counts, and turn tree. From here on everything is pure, local rendering."),
            S("Panel", "Html", "renderSessionDetailHtml()", f"{EXT}/views/sessionDetailPanel.ts", 279, "Step 6 — Render the document",
              "On first mount the panel sets `panel.webview.html = renderSessionDetailHtml(detail, ...)`, building the whole document — styles, tabs, and a per-render nonce for the content security policy."),
            S("Html", "Html", "renderTokenTrend(modelTurns)", f"{EXT}/views/sessionDetailHtml.ts", 362, "Step 7 — Call renderTokenTrend",
              "Inside the content, `renderSessionDetailContent` calls `renderTokenTrend(modelTurns, trendSessions)` to draw the per-turn token trend graph."),
            S("Html", "Panel", "HTML + SVG trend graph", f"{EXT}/views/sessionDetailHtml.ts", 472, "Step 8 — Build the inline SVG", ret=True,
              desc="`renderTokenTrend` (defined here) buckets the model turns and emits an inline SVG — input, cached, and output token polylines — with an empty state when there are fewer than two points. No client-side JS or chart library is involved."),
            S("Panel", "Dev", "webview shows detail", f"{EXT}/views/sessionDetailPanel.ts", 273, "Step 9 — Mount or live-update the webview", ret=True,
              desc="The rendered HTML reaches the webview. On the first render the document is mounted; on later renders the panel posts a `{ type: 'update' }` message so the in-page controller swaps the body without a reload — preserving open collapsibles, the active tab, and scroll."),
        ],
    ),
    # 03 ──────────────────────────────────────────────────────────────────────
    dict(
        id="flow-03-live-updates",
        title="3: Live updates",
        desc_tour="End-to-end: how a Copilot OTLP span or a Claude transcript write becomes a near-real-time view refresh, coalesced behind one debounce. Every step embeds the numbered sequence diagram and points at the exact code for that step.",
        parts=[P("Cop", "Copilot OTLP"), P("Recv", "OtlpReceiver"), P("LiveS", "LiveOtlpService"), P("Ctrl", "LiveUpdateController"), P("Watch", "ClaudeWatcher"), P("View", "Views/panels")],
        steps=[
            S("Cop", "Recv", "POST OTLP spans", f"{EXT}/otel/otlpReceiver.ts", 54, "Step 1 — Receive OTLP spans",
              "Copilot is configured to export OTLP over HTTP to a local port. `OtlpReceiver` is that endpoint — a tiny embedded HTTP server the extension owns, listening only on localhost. Nothing leaves the machine."),
            S("Recv", "LiveS", "decode → onSpans", f"{EXT}/otel/otlpReceiver.ts", 105, "Step 2 — Decode and forward",
              "A `/v1/traces` POST is decoded and the resulting span rows are handed to the injected `onSpans` callback. The receiver knows nothing about views or databases — it just decodes and forwards."),
            S("LiveS", "Ctrl", "signal()", f"{EXT}/otel/liveOtlpService.ts", 95, "Step 3 — Ingest, then signal",
              "`LiveOtlpService.onSpans` ingests the rows into the live store, then calls `this.deps.signal()` to tell the shared controller new activity arrived. It never refreshes anything itself."),
            S("Watch", "Ctrl", "file change → signal()", f"{EXT}/live/claudeWatcher.ts", 68, "Step 4 — The other producer signals too",
              "`ClaudeWatcher` watches Claude's transcript directories. Each filesystem event calls the same `signal()` — so Copilot spans and Claude file writes feed one controller, not two competing refresh loops."),
            S("Ctrl", "View", "debounced refresh", f"{EXT}/live/liveUpdateController.ts", 65, "Step 5 — Coalesce with one debounce",
              "`LiveUpdateController.signal` folds a burst of signals into a single debounced flush (default 400 ms), so a storm of spans or file appends becomes one refresh instead of hundreds."),
            S("View", "Ctrl", "re-query telemetry", f"{EXT}/live/liveUpdateController.ts", 21, "Step 6 — Re-query and repaint", ret=True,
              desc="When the debounce fires, the controller invokes its `onRefresh` callback — wired by the extension to re-run the read pipeline (flow 1). The views re-query the read-only snapshot and repaint in near-real-time."),
        ],
    ),
    # 04 ──────────────────────────────────────────────────────────────────────
    dict(
        id="flow-04-telemetry-archiving",
        title="4: Telemetry archiving",
        desc_tour="End-to-end: the single-writer background sweep that copies new Copilot spans into a durable local archive before Copilot rotates them away, then prunes to the retention window. Every step embeds the numbered sequence diagram and points at the exact code for that step.",
        parts=[P("Timer", "Sweep timer"), P("Arch", "CopilotArchiver"), P("Lease", "WriterLease"), P("Snap", "readonly snapshot"), P("Store", "Archive DB")],
        steps=[
            S("Timer", "Arch", "start() / tick()", f"{EXT}/otel/copilotArchiver.ts", 92, "Step 1 — Schedule the sweep",
              "`CopilotArchiver.start` schedules a periodic `tick`. Copilot rotates its telemetry databases and prunes old rows, so the archiver's job is to copy new spans into a durable local archive before they vanish."),
            S("Arch", "Lease", "tryAcquire() elect writer", f"{EXT}/otel/copilotArchiver.ts", 125, "Step 2 — Elect a single writer",
              "Each tick first calls `lease.tryAcquire()`. A `WriterLease` elects ONE writer across all open VS Code windows, so several windows never archive the same spans concurrently."),
            S("Lease", "Arch", "writer or reader", f"{EXT}/otel/copilotArchiver.ts", 127, "Step 3 — Writer or reader", ret=True,
              desc="If another window holds the lease, this instance is a pure reader — it drops its store and returns. Only the elected writer falls through to sweep."),
            S("Arch", "Store", "open IngestStore(archive)", f"{EXT}/otel/copilotArchiver.ts", 132, "Step 4 — Open the archive store",
              "The writer lazily opens the archive database (`new IngestStore(archiveDbPath)`) — the append-only local store that outlives Copilot's own rotation."),
            S("Arch", "Snap", "snapshot each Copilot source", f"{EXT}/otel/copilotArchiver.ts", 172, "Step 5 — Snapshot each source",
              "For every Copilot source (never the archive itself), `sweepOnce` takes a read-only snapshot via `snapshotFactory` — the same WAL-replaying copy the views use, so archiving never mutates or races Copilot's live DB."),
            S("Snap", "Arch", "new spans above watermark", f"{EXT}/otel/copilotArchiver.ts", 181, "Step 6 — Read only new spans", ret=True,
              desc="Using the per-source watermark, `readSpansSince(reader, since)` reads only spans newer than the last sweep — incremental, so a large DB is never re-copied every tick."),
            S("Arch", "Store", "write new spans", f"{EXT}/otel/copilotArchiver.ts", 183, "Step 7 — Append and advance the watermark",
              "New spans are appended with `store.writeSpans(rows)`, and the watermark advances (minus a small grace) so the next sweep resumes exactly where this one stopped."),
            S("Arch", "Store", "prune(retention)", f"{EXT}/otel/copilotArchiver.ts", 143, "Step 8 — Prune to retention",
              "After sweeping, `store.prune(retentionMs, now)` drops spans older than the retention window. Pruned rows sit below the watermark, so pruning never triggers a re-ingest loop."),
        ],
    ),
    # 05 ──────────────────────────────────────────────────────────────────────
    dict(
        id="flow-05-deviation-markers",
        title="5: Workflow deviation markers",
        desc_tour="End-to-end: how one session's interactions are grouped by turn and matched against configured workflows to produce the deviation markers shown in the detail panel. Every step embeds the numbered sequence diagram and points at the exact code for that step.",
        parts=[P("Panel", "session detail"), P("Local", "LocalDeviationDetector"), P("Group", "turnGrouping"), P("Det", "WorkflowDeviationDetector"), P("Match", "contentMatcher")],
        steps=[
            S("Panel", "Local", "detectForSession(turns)", f"{EXT}/deviation/localDeviations.ts", 45, "Step 1 — Detect for a session",
              "`LocalDeviationDetector.detectForSession` is the entry point for one session's markers. It runs entirely on local content — nothing here is ever uploaded."),
            S("Local", "Group", "groupInteractionsByTurn()", f"{EXT}/deviation/turnGrouping.ts", 23, "Step 2 — Group interactions by turn",
              "`groupInteractionsByTurn` slices the flat interaction list into per-turn buckets using the turn start timestamps, so a deviation can be attributed to the turn that caused it."),
            S("Local", "Det", "detectForTurns(turns, config)", f"{EXT}/deviation/deviationDetector.ts", 108, "Step 3 — Walk each workflow's steps",
              "`WorkflowDeviationDetector.detectForTurns` walks each configured workflow's ordered steps against the turn's interactions, tracking how far the actual sequence matched."),
            S("Det", "Match", "matchesPredicate / content", f"{EXT}/deviation/deviationDetector.ts", 317, "Step 4 — Match a step predicate",
              "`matchesPredicate` tests one interaction against a step predicate — tool name, phase, and optional content constraints. Metadata predicates work everywhere; content predicates consult the local lookup."),
            S("Match", "Det", "match result", f"{EXT}/deviation/contentMatcher.ts", 78, "Step 5 — Content match, on-device", ret=True,
              desc="When a predicate includes a content rule, `matchesContent` applies the equals / contains / regex test against the LOCAL span or transcript text. That content is read on-device and never leaves it."),
            S("Det", "Local", "WorkflowDeviation[]", f"{EXT}/deviation/localDeviations.ts", 82, "Step 6 — Return per-turn deviations", ret=True,
              desc="`detectForTurns` returns the per-turn `WorkflowDeviation` lists — missing steps, out-of-order steps, or forbidden actions — back to the caller."),
            S("Local", "Panel", "markers rendered", f"{EXT}/views/sessionDetailPanel.ts", 264, "Step 7 — Render the markers", ret=True,
              desc="In the detail panel, `detectTurnDeviations` produces the markers that `renderSessionDetailHtml` (flow 2) paints beside each turn — the visible outcome of the whole detection chain."),
        ],
    ),
    # 06 ──────────────────────────────────────────────────────────────────────
    dict(
        id="flow-06-divergence-notifications",
        title="6: Divergence notifications",
        desc_tour="End-to-end: how the notifier turns newly-detected workflow divergences into capped warning toasts with an Open-session action, without re-alerting on a startup backlog. Every step embeds the numbered sequence diagram and points at the exact code for that step.",
        parts=[P("Dev", "Dev", actor=True), P("Live", "Live update"), P("Notif", "DivergenceNotifier"), P("Local", "LocalDeviationDetector"), P("Code", "VS Code UI")],
        steps=[
            S("Live", "Notif", "refresh() after new data", f"{EXT}/notify/workflowDivergenceNotifier.ts", 75, "Step 1 — Hook the refresh fan-out",
              "`WorkflowDivergenceNotifier.refresh` is wired into the same live refresh fan-out as the views (flow 3). After every refresh it calls `scan()`."),
            S("Notif", "Local", "scan() for divergences", f"{EXT}/notify/workflowDivergenceNotifier.ts", 90, "Step 2 — Scan settled turns",
              "`scan` is a no-op unless notify-on-divergence is enabled and workflows are configured. It collects divergences only from SETTLED turns of recent sessions in configured repos — so an in-flight task isn't reported as \"missing later steps\"."),
            S("Local", "Notif", "new deviations vs baseline", f"{EXT}/notify/workflowDivergenceNotifier.ts", 106, "Step 3 — Diff against the baseline", ret=True,
              desc="`selectNewDivergences` diffs the located set against the `seen` baseline, so only genuinely NEW divergences surface. The first scan primes the baseline silently — no backlog of toasts on startup."),
            S("Notif", "Code", "showWarningMessage()", f"{EXT}/notify/workflowDivergenceNotifier.ts", 190, "Step 4 — Present the warnings",
              "`notify` shows at most a capped number of toasts per scan, each describing one new divergence (workflow name, type, description), with a single overflow summary for the rest."),
            S("Code", "Dev", "notification + Open session", f"{EXT}/notify/workflowDivergenceNotifier.ts", 196, "Step 5 — Warning + Open session action", ret=True,
              desc="Each toast is `showWarning(message, 'Open session')` — a VS Code warning with one action button. The message is built from local metadata only."),
            S("Dev", "Notif", "openSession() → detail panel", f"{EXT}/notify/workflowDivergenceNotifier.ts", 198, "Step 6 — Open the session",
              "If the user clicks Open session, `openSession(sourceId, sessionKey)` opens the detail panel (flow 2) for that session — closing the loop from alert to evidence."),
        ],
    ),
    # 07 ──────────────────────────────────────────────────────────────────────
    dict(
        id="flow-07-aggregate-sync",
        title="7: Aggregate sync (producer)",
        desc_tour="End-to-end: the opt-in, consent-gated path that rolls raw interactions into privacy-preserving aggregate buckets and POSTs them to the dashboard. This is the only code that sends anything off the machine. Every step embeds the numbered sequence diagram and points at the exact code for that step.",
        parts=[P("Sched", "SyncScheduler"), P("Engine", "SyncEngine"), P("Agg", "aggregator"), P("Client", "syncClient"), P("Cloud", "Dashboard API")],
        steps=[
            S("Sched", "Engine", "scheduled sync tick", f"{EXT}/sync/scheduler.ts", 29, "Step 1 — Scheduled sync tick",
              "`SyncScheduler` fires a periodic tick (and one on activation) that drives the opt-in cloud sync. This is the ONLY path that sends anything off the machine."),
            S("Engine", "Engine", "computeCanSync() gate", f"{EXT}/sync/syncEngine.ts", 195, "Step 2 — The consent gate",
              "`computeCanSync` is the hard gate: sharing enabled, explicit consent recorded, and an API key present in SecretStorage. If any is missing, the run stops here — nothing is built or sent."),
            S("Engine", "Agg", "buildBatch(rows)", f"{EXT}/aggregate/aggregator.ts", 124, "Step 3 — Roll into aggregate buckets",
              "`buildBatch` rolls raw interactions into 30-minute buckets keyed by repo / model / developer — counts, duration sums, token sums, and a fixed-bound latency histogram. No prompt, completion, path, or identity text is included."),
            S("Engine", "Engine", "computeDeveloperId (HMAC)", f"{EXT}/aggregate/pseudonymizer.ts", 49, "Step 4 — Pseudonymous developer id",
              "The only identity-derived value shipped is `computeDeveloperId` — an HMAC of a per-install salt and the identity input. It is irreversible and stable, so the dashboard can count developers without ever seeing one."),
            S("Engine", "Client", "sendBatch(batch)", f"{EXT}/sync/syncClient.ts", 94, "Step 5 — Send the batch",
              "`SyncClient.sendBatch` serializes the batch and POSTs it with a Bearer key. The body is never logged or echoed; transport errors are scrubbed of the URL, headers, and key before surfacing."),
            S("Client", "Cloud", "POST /api/ingest/aggregate", f"{EXT}/sync/syncClient.ts", 101, "Step 6 — Hardcoded ingestion path",
              "The target is `POST {dashboardUrl}/api/ingest/aggregate` — the path is a hardcoded constant, not a user setting, so the destination can't be silently redirected."),
            S("Cloud", "Client", "200 accepted", f"{EXT}/sync/syncClient.ts", 117, "Step 7 — Map the response", ret=True,
              desc="`mapStatus` turns the HTTP response into a typed outcome — 200 becomes success, 401/400 permanent failures, 429/5xx transient. The key is scrubbed from any human-readable detail."),
            S("Client", "Engine", "result", f"{EXT}/sync/syncEngine.ts", 284, "Step 8 — Advance or retry", ret=True,
              desc="Back in the engine, a success advances the watermark (and best-effort triggers flow 10); a permanent or retries-exhausted failure leaves the watermark unchanged so the same window retries next run — idempotent on the server."),
        ],
    ),
    # 08 ──────────────────────────────────────────────────────────────────────
    dict(
        id="flow-08-dashboard-ingestion",
        title="8: Dashboard ingestion",
        desc_tour="End-to-end: the server side of the sync — authenticate the key, derive the org, validate the strict aggregate contract, and upsert buckets idempotently. Every step embeds the numbered sequence diagram and points at the exact code for that step.",
        parts=[P("Ext", "Extension (syncClient)"), P("Api", "IngestionEndpoints"), P("Auth", "IngestionAuthenticator"), P("Val", "AggregateBatchValidator"), P("Store", "TableAggregateStore")],
        steps=[
            S("Ext", "Api", "POST /api/ingest/aggregate", f"{DASH}/Services/Ingestion/IngestionEndpoints.cs", 29, "Step 1 — The ingest endpoint",
              "The dashboard exposes `POST /api/ingest/aggregate`. This minimal-API handler is the server side of flow 7's upload."),
            S("Api", "Auth", "AuthenticateAsync(key)", f"{DASH}/Services/Ingestion/IngestionAuthenticator.cs", 86, "Step 2 — Authenticate the key",
              "`AuthenticateAsync` hashes the presented Bearer key and compares it in constant time against stored key records. A dummy comparison runs even when the key is unknown, so timing can't reveal validity."),
            S("Auth", "Api", "OrgId or 401", f"{DASH}/Services/Ingestion/IngestionEndpoints.cs", 109, "Step 3 — Org from the key, or 401", ret=True,
              desc="A failed key returns 401. On success the handler carries the `OrgId` from the KEY RECORD — never from the payload — so a batch can't claim another org."),
            S("Api", "Val", "Validate(batch)", f"{DASH}/Services/Ingestion/AggregateBatchValidator.cs", 58, "Step 4 — Validate the strict contract",
              "`Validate` enforces the aggregate contract: the batch and every bucket are `additionalProperties:false`, so any unexpected (potentially raw) field is rejected, plus range and shape checks."),
            S("Val", "Api", "ok or rejected", f"{DASH}/Services/Ingestion/IngestionEndpoints.cs", 139, "Step 5 — Reject on any error", ret=True,
              desc="Any validation error returns a 400 ValidationProblem and the batch is dropped — nothing partially valid is stored."),
            S("Api", "Store", "UpsertBucketsAsync(orgId)", f"{DASH}/Services/Ingestion/IngestionEndpoints.cs", 146, "Step 6 — Upsert, scoped to the org",
              "A clean batch is persisted with `store.UpsertBucketsAsync(auth.OrgId!, batch)` — again scoped to the authenticated org, never the payload."),
            S("Store", "Api", "stored", f"{DASH}/Services/Ingestion/TableAggregateStore.cs", 29, "Step 7 — Idempotent storage write", ret=True,
              desc="`TableAggregateStore.UpsertBucketsAsync` writes each bucket to Azure Table Storage under a deterministic key, so re-sending the same window is idempotent (upsert, not duplicate)."),
            S("Api", "Ext", "200 accepted", f"{DASH}/Services/Ingestion/IngestionEndpoints.cs", 148, "Step 8 — 200 accepted", ret=True,
              desc="The handler returns `200 Ok` with the accepted bucket count and batch id — the success flow 7 waits for before advancing its watermark."),
        ],
    ),
    # 09 ──────────────────────────────────────────────────────────────────────
    dict(
        id="flow-09-dashboard-analytics",
        title="9: Dashboard analytics",
        desc_tour="End-to-end: how the Overview page turns stored aggregate buckets into KPIs and charts, including an approximate P95 reconstructed from fixed-bound histograms. Every step embeds the numbered sequence diagram and points at the exact code for that step.",
        parts=[P("Viewer", "Viewer", actor=True), P("Page", "Index.razor"), P("Svc", "AggregateAnalyticsService"), P("Store", "TableAggregateStore"), P("Charts", "Radzen charts")],
        steps=[
            S("Viewer", "Page", "Open dashboard \"/\"", f"{DASH}/Pages/Index.razor", 1, "Step 1 — Open the Overview",
              "Opening the dashboard root (`/`) renders the Overview page — a Blazor Server component that pulls metrics on init and every 60 seconds."),
            S("Page", "Svc", "GetDashboardMetricsAsync(24h)", f"{DASH}/Pages/Index.razor", 104, "Step 2 — Ask for metrics",
              "`LoadAsync` calls `Analytics.GetDashboardMetricsAsync(24h)`. The page holds no data of its own — it asks the analytics service for a ready-to-render DTO."),
            S("Svc", "Store", "QueryBucketsAsync(range)", f"{DASH}/Services/Ingestion/TableAggregateStore.cs", 46, "Step 3 — Query the org's buckets",
              "The service reads the org's buckets for the window via `QueryBucketsAsync(orgId, from, to)`. Only aggregate buckets exist in storage — there is no raw content to read."),
            S("Store", "Svc", "aggregate buckets", f"{DASH}/Services/Analytics/AggregateAnalyticsService.cs", 51, "Step 4 — Aggregate the buckets", ret=True,
              desc="`GetDashboardMetricsAsync` filters out unknown-repo buckets, then sums interaction counts and durations and counts distinct repos/developers — reproducing the legacy overview semantics over buckets."),
            S("Svc", "Svc", "MergeHistogram + ApproximateP95", f"{DASH}/Services/Analytics/AggregateAnalyticsService.cs", 96, "Step 5 — Approximate P95 from histograms",
              "P95 latency is `ApproximateP95(MergeHistogram(...))`: fixed-bound histograms are summed element-wise across buckets, then the 0.95 crossing bound is read off. Approximate by construction — raw latencies were never shipped."),
            S("Svc", "Page", "DashboardMetrics", f"{DASH}/Services/Analytics/AggregateAnalyticsService.cs", 92, "Step 6 — Pack the DTO", ret=True,
              desc="The results are packed into a `DashboardMetrics` DTO — totals, averages, P95, active repos/devs, request-volume series, and model breakdown — and returned to the page."),
            S("Page", "Charts", "bind series", f"{DASH}/Pages/Index.razor", 56, "Step 7 — Bind the series",
              "The page binds the series to Radzen charts, e.g. `RadzenColumnSeries Data=@metrics.RequestVolume`."),
            S("Charts", "Viewer", "rendered charts", f"{DASH}/Pages/Index.razor", 23, "Step 8 — Render, then poll", ret=True,
              desc="Once `metrics` is non-null, the metric cards and charts render. A 60-second `PeriodicTimer` re-runs `LoadAsync`, so the Overview stays current without a manual refresh."),
        ],
    ),
    # 10 ──────────────────────────────────────────────────────────────────────
    dict(
        id="flow-10-context-insights-sync",
        title="10: Context-insights sync",
        desc_tour="End-to-end: the secondary, best-effort upload that reports per-customization-file counts (never contents) for the same window as the aggregate batch, and its strict server-side validation. Every step embeds the numbered sequence diagram and points at the exact code for that step.",
        parts=[P("Engine", "SyncEngine"), P("Client", "syncClient"), P("Api", "IngestionEndpoints"), P("Val", "ContextInsightsValidator"), P("Store", "TableContextInsightStore")],
        steps=[
            S("Engine", "Client", "sendContextInsights(rows)", f"{EXT}/sync/syncEngine.ts", 388, "Step 1 — Best-effort secondary send",
              "After a successful aggregate sync (flow 7), the engine sends a SEPARATE context-insights batch for the same window via `client.sendContextInsights(batch)`. It is fully isolated — any failure here never affects the aggregate result."),
            S("Client", "Api", "POST /api/ingest/context-insights", f"{EXT}/sync/syncClient.ts", 132, "Step 2 — POST context-insights",
              "`SyncClient.sendContextInsights` mirrors `sendBatch` byte-for-byte in transport, auth, and scrubbing — only the path differs: `POST {dashboardUrl}/api/ingest/context-insights`."),
            S("Api", "Val", "Validate(batch)", f"{DASH}/Services/Ingestion/ContextInsightsBatchValidator.cs", 47, "Step 3 — Validate the contract",
              "Server-side, `Validate` enforces the context-insights contract — `additionalProperties:false` at every level, so only repo-relative customization-file paths and counts are accepted, never file contents."),
            S("Val", "Api", "errors or ok", f"{DASH}/Services/Ingestion/IngestionEndpoints.cs", 194, "Step 4 — Reject on error", ret=True,
              desc="Validation failures return a 400 ValidationProblem; the batch is rejected whole."),
            S("Api", "Store", "UpsertRowsAsync(orgId)", f"{DASH}/Services/Ingestion/IngestionEndpoints.cs", 201, "Step 5 — Upsert rows, scoped to org",
              "A valid batch is stored with `store.UpsertRowsAsync(auth.OrgId!, batch)`, scoped to the authenticated org from the key record — never the payload."),
            S("Store", "Api", "stored (idempotent rowKey)", f"{DASH}/Services/Ingestion/TableContextInsightStore.cs", 29, "Step 6 — Idempotent row write", ret=True,
              desc="`TableContextInsightStore.UpsertRowsAsync` upserts each row under a deterministic row key, so re-sending the same window is idempotent."),
            S("Api", "Client", "200 accepted", f"{DASH}/Services/Ingestion/IngestionEndpoints.cs", 203, "Step 7 — 200 accepted", ret=True,
              desc="The handler returns `200 Ok` with the accepted row count and batch id, completing the secondary upload."),
        ],
    ),
    # 11 ──────────────────────────────────────────────────────────────────────
    dict(
        id="flow-11-context-hotspots",
        title="11: Context hotspots",
        desc_tour="End-to-end: how per-file context-insight rows are scored by a transparent four-signal composite and ranked into the hotspots view. Every step embeds the numbered sequence diagram and points at the exact code for that step.",
        parts=[P("Viewer", "Viewer", actor=True), P("Page", "ContextHotspots.razor"), P("Svc", "ContextHotspotService"), P("Store", "TableContextInsightStore"), P("Charts", "Radzen bars")],
        steps=[
            S("Viewer", "Page", "Open \"/context-hotspots\"", f"{DASH}/Pages/ContextHotspots.razor", 1, "Step 1 — Open the hotspots page",
              "The `/context-hotspots` page ranks which customization files (instructions, prompts, agents, hooks) most deserve attention — from aggregate signals only, never file contents."),
            S("Page", "Svc", "GetRepositoriesAsync(lookback)", f"{DASH}/Pages/ContextHotspots.razor", 170, "Step 2 — Load repositories",
              "On load, `ReloadAsync` calls `Hotspots.GetRepositoriesAsync(Lookback)` to populate the repository filter for the selected sprint window."),
            S("Page", "Svc", "GetHotspotsAsync(repo, lookback)", f"{DASH}/Pages/ContextHotspots.razor", 172, "Step 3 — Request the hotspots",
              "It then calls `GetHotspotsAsync(repo, Lookback)` for the ranked files — optionally scoped to one repository."),
            S("Svc", "Store", "QueryRowsAsync(range)", f"{DASH}/Services/Ingestion/TableContextInsightStore.cs", 46, "Step 4 — Query context-insight rows",
              "The service reads the org's context-insight rows for the window via `QueryRowsAsync(orgId, from, to)`. These rows are per-file aggregate counts, not content."),
            S("Store", "Svc", "context-insight rows", f"{DASH}/Services/Analytics/ContextHotspotAnalyticsService.cs", 75, "Step 5 — Group by file", ret=True,
              desc="`GetHotspotsAsync` pulls those rows into memory and groups them by repository + context file, summing applied / skipped / token / error / deviation counts."),
            S("Svc", "Svc", "composite HotspotScore", f"{DASH}/Services/Analytics/ContextHotspotAnalyticsService.cs", 121, "Step 6 — Composite hotspot score",
              "Each file gets four sub-scores normalized to 0–1 — skip rate, friction, token weight, frequency — combined into a transparent 0–100 `composite` (weights 30 / 30 / 20 / 20)."),
            S("Svc", "Page", "ContextHotspot[]", f"{DASH}/Services/Analytics/ContextHotspotAnalyticsService.cs", 149, "Step 7 — Rank the hotspots", ret=True,
              desc="Files are ordered by descending `HotspotScore` (with deterministic tie-breakers) into the `ContextHotspot[]` returned to the page."),
            S("Page", "Charts", "bind TopBars", f"{DASH}/Pages/ContextHotspots.razor", 160, "Step 8 — Project the top bars",
              "The page projects the top 10 hotspots into `TopBars` for the chart."),
            S("Charts", "Viewer", "ranked hotspot bars", f"{DASH}/Pages/ContextHotspots.razor", 72, "Step 9 — Render the ranked bars", ret=True,
              desc="`RadzenBarSeries Data=@TopBars` renders the ranked hotspot bars, and the table below lists every file with its sub-scores — explicitly framed as co-occurrence, a prompt to investigate, not a claim of cause."),
        ],
    ),
    # 12 ──────────────────────────────────────────────────────────────────────
    dict(
        id="flow-12-ai-helper",
        title="12: AI Helper chat",
        desc_tour="End-to-end: the in-panel assistant that grounds a question in the repo's own customization files and streams an answer from the user's Copilot license — behind a one-time disclosure gate. Every step embeds the numbered sequence diagram and points at the exact code for that step.",
        parts=[P("Dev", "Dev", actor=True), P("Web", "Chat webview"), P("Prov", "ChatViewProvider"), P("Ctx", "ContextLoader"), P("LM", "languageModelClient"), P("Cop", "Copilot model")],
        steps=[
            S("Dev", "Web", "Ask a question", f"{EXT}/chat/webview/chatViewProvider.ts", 69, "Step 1 — The chat webview",
              "The AI Helper is a webview view. `resolveWebviewView` mounts the chat UI the user types into. It runs on the user's own GitHub Copilot license via the VS Code Language Model API."),
            S("Web", "Prov", "postMessage send", f"{EXT}/chat/webview/chatViewProvider.ts", 102, "Step 2 — Route the send",
              "Submitting a question posts a `{ type: 'send' }` message; `onMessage` routes it to `handleTurn(text)`. Quick-command buttons take the same path with a preset prompt."),
            S("Prov", "Prov", "ensureDisclosed() gate", f"{EXT}/chat/webview/chatViewProvider.ts", 132, "Step 3 — The disclosure gate",
              "`handleTurn` first awaits `ensureDisclosed()` — a one-time consent gate explaining that the question plus selected LOCAL context is sent to the model. Declining stops the turn right here."),
            S("Prov", "Ctx", "buildPreamble → loadMany()", f"{EXT}/chat/webview/chatViewProvider.ts", 202, "Step 4 — Build a grounded preamble",
              "`buildPreamble` selects relevant customization files for the question and loads them with `contextLoader.loadMany(names)`, grounding the answer in the repo's own conventions."),
            S("Prov", "LM", "streamRequest(model, messages)", f"{EXT}/chat/languageModelClient.ts", 31, "Step 5 — Start the streaming request",
              "`streamRequest(model, messages, onDelta, token)` maps the assembled turns to Copilot chat messages and starts the streaming send."),
            S("LM", "Cop", "model.sendRequest()", f"{EXT}/chat/languageModelClient.ts", 42, "Step 6 — Call the Language Model API",
              "`model.sendRequest(...)` calls the VS Code Language Model API. The first call may trigger VS Code's built-in per-extension Copilot consent prompt."),
            S("Cop", "LM", "streamed deltas", f"{EXT}/chat/languageModelClient.ts", 43, "Step 7 — Stream the deltas", ret=True,
              desc="The response is consumed as an async stream — `for await (const chunk of response.text)` yields deltas as the model produces them."),
            S("LM", "Prov", "onDelta chunks", f"{EXT}/chat/webview/chatViewProvider.ts", 165, "Step 8 — Accumulate chunks", ret=True,
              desc="Each delta is appended to the accumulator in the `onDelta` callback back in the provider."),
            S("Prov", "Web", "assistantHtml (throttled)", f"{EXT}/chat/webview/chatViewProvider.ts", 160, "Step 9 — Throttled HTML render", ret=True,
              desc="Rendering is throttled: at most once per `RENDER_THROTTLE_MS`, the accumulated markdown is converted to HTML and posted as `assistantHtml`, so the bubble updates smoothly without re-rendering on every token."),
            S("Web", "Dev", "rendered answer", f"{EXT}/chat/webview/chatViewProvider.ts", 178, "Step 10 — Final answer", ret=True,
              desc="A final render flushes the complete answer and `assistantDone` marks the turn finished. The full response shows in the webview; only the question and selected local context ever left for the model."),
        ],
    ),
]

HL = "rect rgb(255,236,179)"


def diagram(flow, hi):
    lines = ["sequenceDiagram", "    autonumber"]
    for alias, label, is_actor in flow["parts"]:
        kw = "actor" if is_actor else "participant"
        if alias == label:
            lines.append(f"    {kw} {alias}")
        else:
            lines.append(f"    {kw} {alias} as {label}")
    for i, s in enumerate(flow["steps"], 1):
        arrow = "-->>" if s["ret"] else "->>"
        msg = f"    {s['a']}{arrow}{s['b']}: {s['txt']}"
        if i == hi:
            lines.append(f"    {HL}")
            lines.append(msg)
            lines.append("    end")
        else:
            lines.append(msg)
    return "\n".join(lines)


# Assign global step indices; build all.md (for mmdc) + the tour files.
md_blocks = []
g = 0
total_steps = sum(len(f["steps"]) for f in FLOWS)
for fi, flow in enumerate(FLOWS):
    n = len(flow["steps"])
    labels = {alias: label for alias, label, _ in flow["parts"]}
    tour_steps = []
    for i, s in enumerate(flow["steps"], 1):
        g += 1
        md_blocks.append("```mermaid\n" + diagram(flow, i) + "\n```")
        img = f".tours/diagrams/d-{g}.svg"
        arrow_txt = f"{labels[s['a']]} \u2192 {labels[s['b']]}: {s['txt']}"
        desc = (
            f"![{flow['title']}]({img})\n\n"
            f"**\u25b6 Step {i} of {n} in the sequence diagram \u2014 `{arrow_txt}`**\n\n"
            f"{s['desc']}"
        )
        tour_steps.append({"title": s["title"], "file": s["file"], "line": s["line"], "description": desc})
    tour = {
        "$schema": "https://aka.ms/codetour-schema",
        "title": flow["title"],
        "description": flow["desc_tour"],
    }
    if fi == 0:
        tour["isPrimary"] = True
    if fi + 1 < len(FLOWS):
        tour["nextTour"] = FLOWS[fi + 1]["title"]
    tour["steps"] = tour_steps
    with open(os.path.join(TOURS_DIR, f"{flow['id']}.tour"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(tour, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

# Combined markdown for a single mmdc launch (LF endings).
with open(os.path.join(DIAG_DIR, "all.md"), "w", encoding="utf-8", newline="\n") as fh:
    fh.write("\n\n".join(md_blocks) + "\n")

# Mermaid render config: no mirrored actors at the bottom (shorter diagrams).
cfg = {
    "theme": "default",
    "sequence": {"mirrorActors": False, "actorMargin": 46, "boxMargin": 8},
    "themeVariables": {"fontSize": "15px"},
}
with open(os.path.join(DIAG_DIR, "mermaid-config.json"), "w", encoding="utf-8", newline="\n") as fh:
    json.dump(cfg, fh, indent=2)

print(f"flows={len(FLOWS)} tours written, total_steps={total_steps}, diagrams={g}")
assert g == total_steps
