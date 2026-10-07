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
CORE = "src/core/agent-observability-core/src"
DESK = "src/desktop/agent-observability-desktop/src"

FLOWS = [
    # 01 ──────────────────────────────────────────────────────────────────────
    dict(
        id="flow-01-copilot-session-read",
        title="1: Copilot session read",
        desc_tour="End-to-end: how launching the desktop app turns on-disk Copilot telemetry into rows in the Sessions view. Every step embeds the numbered sequence diagram and points at the exact code for that step.",
        parts=[P("Dev", "Dev", actor=True), P("Main", "Electron main"), P("Host", "Data host"), P("Idx", "CopilotIndexer"), P("Cop", "Copilot DB"), P("Index", "IndexDb"), P("View", "Sessions view")],
        steps=[
            S("Dev", "Main", "Launch the app", f"{DESK}/main/index.ts", 127, "Step 1 — Fork the data host",
              "Launching the app runs `startDataHost`, which forks the data host as an Electron `utilityProcess`. Every read, parse and index pass happens there — off the main process and out of the renderer — and the read-only, privacy-first pipeline starts: nothing leaves the machine."),
            S("Main", "View", "hand over a MessagePort", f"{DESK}/main/index.ts", 141, "Step 2 — Connect the renderer to the data host",
              "`connectRendererToDataHost` creates a `MessageChannelMain` and gives one end to the data host and the other to the page (the preload transfers it with `window.postMessage`). From then on the two talk directly; main is out of the path entirely."),
            S("Host", "Idx", "background index pass", f"{DESK}/datahost/background/worker.ts", 114, "Step 3 — The index pass runs each source",
              "The data host's background worker runs one indexer per enabled source in turn; for Copilot that is `CopilotIndexer.run()`. The renderer never waits on this pass — rows stream in as they are found."),
            S("Idx", "Cop", "read-only open", f"{DESK}/datahost/indexer/copilotIndexer.ts", 215, "Step 4 — Read-only open",
              "Copilot's database is somebody else's live file, so it is opened `readonly` with `fileMustExist`: it is never created, migrated or written. A candidate that cannot be opened is reported and skipped, without hiding the others."),
            S("Cop", "Idx", "session aggregates", f"{DESK}/datahost/indexer/copilotIndexer.ts", 234, "Step 5 — One consistent read", ret=True,
              desc="All summaries for a source are read inside one `db.transaction`, so they describe the same SQLite snapshot even while Copilot keeps committing spans. Only per-session aggregates come back — counts, durations, token totals — never raw prompt or completion text."),
            S("Idx", "Index", "upsertChangedSessions(rows)", f"{DESK}/datahost/indexer/copilotIndexer.ts", 316, "Step 6 — Upsert into the local index",
              "The rows land in the app's own `IndexDb`, and only rows that actually changed are reported through `onRows`. The data host re-emits those as a `sessions.upserted` event, so an open list patches in place instead of re-querying."),
            S("View", "Host", "sessions.list", f"{DESK}/renderer/src/views/sessions/useSessions.ts", 127, "Step 7 — The view asks for a page",
              "The Sessions view's `useSessions` hook calls `dataHost.call('sessions.list', ...)` over the port. The view holds no data of its own; it always pulls a page from the data host on demand."),
            S("Host", "Index", "IndexDb.listSessions()", f"{DESK}/datahost/indexer/indexDb.ts", 511, "Step 8 — Query the index", ret=True,
              desc="`IndexDb.listSessions` answers from the local index — filters, hidden sessions and the rename/tag overlays applied in SQL — so listing never opens Copilot's database at all. The data host decorates the rows and returns them."),
            S("Index", "View", "SessionRow[]", f"{DESK}/renderer/src/views/sessions/SessionsView.tsx", 369, "Step 9 — Paint the session list", ret=True,
              desc="Finally the view renders each row as a `SessionRowItem` inside a virtualized list, and the Sessions panel paints. The loop stays lazy: the next index pass pushes only the rows that changed."),
        ],
    ),
    # 02 ──────────────────────────────────────────────────────────────────────
    dict(
        id="flow-02-session-detail-token-trend",
        title="2: Session detail & token trend",
        desc_tour="End-to-end: one click on a session, through the local-only detail query, to the inline SVG token-trend graph. Every step embeds the numbered sequence diagram and points at the exact code for that step.",
        parts=[P("Dev", "Dev", actor=True), P("Panel", "SessionDetail"), P("Rend", "DetailRenderer"), P("Svc", "TelemetryService"), P("DB", "TelemetryDatabase"), P("Html", "sessionDetailHtml")],
        steps=[
            S("Dev", "Panel", "Click a session", f"{DESK}/renderer/src/views/sessions/SessionsView.tsx", 380, "Step 1 — Click a session",
              "Clicking a row's `onSelect` sets the selection, and the right-hand pane mounts a `SessionDetail` keyed by source and session id — so a new selection always starts a fresh load."),
            S("Panel", "Rend", "sessions.detail", f"{DESK}/renderer/src/views/sessions/SessionDetail.tsx", 91, "Step 2 — Ask the data host for the document",
              "`SessionDetail` calls `dataHost.call('sessions.detail', source, sessionId, theme)`. In the data host that lands on `DetailRenderer.renderDocument`; the renderer process itself stores nothing."),
            S("Rend", "Svc", "getSessionDetail(key)", f"{DESK}/datahost/detail/detailRenderer.ts", 287, "Step 3 — Ask the source for detail",
              "`DetailRenderer` looks the owning source up in core's `SourceRegistry` and asks it for `getSessionDetail(sessionId)`. The Copilot source forwards straight to `TelemetryService`. Parses are memoized by index stamp, so reopening a session is cheap."),
            S("Svc", "DB", "getSessionDetail()", f"{CORE}/telemetry/telemetryService.ts", 721, "Step 4 — Service delegates to the DB",
              "`TelemetryService.getSessionDetail` delegates to the database layer. The desktop injects a native backend whose short-lived read transaction pins a consistent view of the archive without copying it; the source database is never written."),
            S("DB", "Svc", "SessionDetail (turns, tokens)", f"{CORE}/telemetry/database.ts", 879, "Step 5 — Local-only detail assembly", ret=True,
              desc="`TelemetryDatabase.getSessionDetail` assembles prompts, responses, turns, and agent-tree totals for local display. The tree traversal and numeric write deltas are reused across rollups within the immutable read view; raw tool arguments are discarded. Raw detail stays in-process and is only ever rendered on this machine."),
            S("Rend", "Html", "renderSessionDetailHtml()", f"{DESK}/datahost/detail/detailRenderer.ts", 117, "Step 6 — Render the document",
              "`renderDocument` calls core's `renderSessionDetailHtml(detail, deviations, ...)`, building the whole document — styles, tabs, and a per-render nonce for the content security policy."),
            S("Html", "Html", "renderTokenTrend(modelTurns)", f"{CORE}/views/sessionDetailHtml.ts", 1070, "Step 7 — Call renderTokenTrend",
              "The content's tree-summary card calls `renderTokenTrend(modelTurns, trendSessions)` to draw the per-turn token trend graph. Charts stay eager; event rows in large timelines are deferred until their disclosure opens."),
            S("Html", "Rend", "HTML + SVG trend graph", f"{CORE}/views/sessionDetailHtml.ts", 1307, "Step 8 — Build the inline SVG", ret=True,
              desc="`renderTokenTrend` buckets model turns into inline SVG with an empty state for fewer than two points. The nonce-authorized controller handles legend filtering and lazy event pagination without an external chart library."),
            S("Rend", "Dev", "document in a sandboxed iframe", f"{DESK}/renderer/src/views/sessions/SessionDetail.tsx", 332, "Step 9 — Mount or live-update the frame", ret=True,
              desc="The document is stashed behind a URL and loaded into an iframe sandboxed to `allow-scripts` only, so it cannot touch the app's DOM, storage or preload bridge. Later refreshes post a `{ type: 'update' }` message that swaps the body while preserving open sections, the active tab, and scroll."),
        ],
    ),
    # 03 ──────────────────────────────────────────────────────────────────────
    dict(
        id="flow-03-live-updates",
        title="3: Live updates",
        desc_tour="End-to-end: how a Copilot database write or a Claude transcript append becomes a near-real-time refresh of the desktop's live board, coalesced behind one debounce. Every step embeds the numbered sequence diagram and points at the exact code for that step.",
        parts=[P("Cop", "Copilot DB"), P("Board", "LiveBoardService"), P("Watch", "ClaudeWatcher"), P("Ctrl", "LiveUpdateController"), P("Idx", "Index pass"), P("View", "Workspace view")],
        steps=[
            S("Cop", "Board", "DB / WAL file change", f"{DESK}/datahost/live/liveBoard.ts", 331, "Step 1 — Watch Copilot's database",
              "The live board watches Copilot's database and its `-wal` file as plain files. Nothing is installed into Copilot — no hooks, no exporters — because it already writes these files. Nothing leaves the machine."),
            S("Board", "Ctrl", "signal()", f"{DESK}/datahost/live/liveBoard.ts", 333, "Step 2 — Signal, don't refresh",
              "Each change arms a quiet-period re-index and calls `controller.signal()` to say new activity arrived. The watcher never recomputes anything itself."),
            S("Watch", "Ctrl", "file change → signal()", f"{CORE}/live/claudeWatcher.ts", 68, "Step 3 — The other producer signals too",
              "`ClaudeWatcher` watches Claude's transcript directories. Each filesystem event calls the same `signal()` — so Copilot writes and Claude file appends feed one controller, not competing refresh loops. The Copilot CLI and JetBrains stores register the same way."),
            S("Ctrl", "Board", "debounced onRefresh", f"{CORE}/live/liveUpdateController.ts", 65, "Step 4 — Coalesce with one debounce",
              "`LiveUpdateController.signal` folds a burst of signals into a single debounced flush (`LIVE_DEBOUNCE_MS`, 750 ms on the desktop), so a storm of span commits or file appends becomes one `recompute` instead of hundreds."),
            S("Board", "Idx", "requestIndex()", f"{DESK}/datahost/live/liveBoard.ts", 312, "Step 5 — Quiet-period re-index",
              "Once the files have been quiet for a moment, `armReindex` asks for an index pass (flow 1) so the Sessions list and the dashboard pick up the change without a manual Refresh. The request is never awaited: the board's own status comes from the transcript tail."),
            S("Board", "View", "workspace.live snapshot", f"{DESK}/renderer/src/views/workspace/useLiveBoard.ts", 25, "Step 6 — Push and repaint", ret=True,
              desc="`recompute` re-derives each session's status and emits a `workspace.live` event only when something really changed. The renderer's `useLiveBoard` hook swaps in the new snapshot and the live board repaints in near-real-time."),
        ],
    ),
    # 05 ──────────────────────────────────────────────────────────────────────
    dict(
        id="flow-05-deviation-markers",
        title="5: Workflow deviation markers",
        desc_tour="End-to-end: how one session's interactions are grouped by turn and matched against workflows to produce the deviation markers shown in the session detail. Every step embeds the numbered sequence diagram and points at the exact code for that step.",
        parts=[P("Panel", "DetailRenderer"), P("Local", "detectTurnDeviations"), P("Group", "turnGrouping"), P("Det", "WorkflowDeviationDetector"), P("Match", "contentMatcher")],
        steps=[
            S("Panel", "Local", "detectTurnDeviations(detail)", f"{DESK}/datahost/analysis/turnDeviations.ts", 23, "Step 1 — Detect for a session",
              "`detectTurnDeviations` is the single place the app decides what \"abnormal\" means: the detail view and the background analyzer both call it, so the list badge and the opened session always agree. It runs entirely on local content — nothing here is ever uploaded."),
            S("Local", "Group", "groupInteractionsByTurn()", f"{CORE}/deviation/turnGrouping.ts", 23, "Step 2 — Group interactions by turn",
              "`groupInteractionsByTurn` slices the flat interaction list into per-turn buckets using the turn start timestamps, so a deviation can be attributed to the turn that caused it."),
            S("Local", "Det", "detectForTurnsWithDefaults()", f"{CORE}/deviation/localDeviations.ts", 117, "Step 3 — Walk each workflow's steps",
              "`LocalDeviationDetector.detectForTurnsWithDefaults` hands the turns to `WorkflowDeviationDetector.detectForTurns` with the repository's configured workflows — or core's synthesized default when none is configured — which walks each workflow's ordered steps against the turn's interactions."),
            S("Det", "Match", "matchesPredicate / content", f"{CORE}/deviation/deviationDetector.ts", 244, "Step 4 — Match a step predicate",
              "`matchesPredicate` tests one interaction against a step predicate — operation, agent, model, tool name, and success. Metadata predicates work everywhere; content predicates consult the local lookup."),
            S("Match", "Det", "match result", f"{CORE}/deviation/contentMatcher.ts", 78, "Step 5 — Content match, on-device", ret=True,
              desc="When a predicate includes a content rule, `matchesContent` applies the equals / contains / regex test against the LOCAL span or transcript text. That content is read on-device to compute a boolean and never leaves it."),
            S("Det", "Local", "WorkflowDeviation[][]", f"{DESK}/datahost/analysis/turnDeviations.ts", 46, "Step 6 — Return per-turn deviations", ret=True,
              desc="The detector returns per-turn `WorkflowDeviation` lists, aligned by index to the session's turns — missing steps, out-of-order steps, or forbidden actions — back to the caller."),
            S("Local", "Panel", "markers rendered", f"{DESK}/datahost/detail/detailRenderer.ts", 317, "Step 7 — Render the markers", ret=True,
              desc="`DetailRenderer` stores the result as `deviations` beside the parsed detail, and `renderSessionDetailHtml` (flow 2) paints them beside each turn — the visible outcome of the whole detection chain."),
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
