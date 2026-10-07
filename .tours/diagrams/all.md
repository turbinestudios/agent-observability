```mermaid
sequenceDiagram
    autonumber
    actor Dev
    participant Main as Electron main
    participant Host as Data host
    participant Idx as CopilotIndexer
    participant Cop as Copilot DB
    participant Index as IndexDb
    participant View as Sessions view
    rect rgb(255,236,179)
    Dev->>Main: Launch the app
    end
    Main->>View: hand over a MessagePort
    Host->>Idx: background index pass
    Idx->>Cop: read-only open
    Cop-->>Idx: session aggregates
    Idx->>Index: upsertChangedSessions(rows)
    View->>Host: sessions.list
    Host-->>Index: IndexDb.listSessions()
    Index-->>View: SessionRow[]
```

```mermaid
sequenceDiagram
    autonumber
    actor Dev
    participant Main as Electron main
    participant Host as Data host
    participant Idx as CopilotIndexer
    participant Cop as Copilot DB
    participant Index as IndexDb
    participant View as Sessions view
    Dev->>Main: Launch the app
    rect rgb(255,236,179)
    Main->>View: hand over a MessagePort
    end
    Host->>Idx: background index pass
    Idx->>Cop: read-only open
    Cop-->>Idx: session aggregates
    Idx->>Index: upsertChangedSessions(rows)
    View->>Host: sessions.list
    Host-->>Index: IndexDb.listSessions()
    Index-->>View: SessionRow[]
```

```mermaid
sequenceDiagram
    autonumber
    actor Dev
    participant Main as Electron main
    participant Host as Data host
    participant Idx as CopilotIndexer
    participant Cop as Copilot DB
    participant Index as IndexDb
    participant View as Sessions view
    Dev->>Main: Launch the app
    Main->>View: hand over a MessagePort
    rect rgb(255,236,179)
    Host->>Idx: background index pass
    end
    Idx->>Cop: read-only open
    Cop-->>Idx: session aggregates
    Idx->>Index: upsertChangedSessions(rows)
    View->>Host: sessions.list
    Host-->>Index: IndexDb.listSessions()
    Index-->>View: SessionRow[]
```

```mermaid
sequenceDiagram
    autonumber
    actor Dev
    participant Main as Electron main
    participant Host as Data host
    participant Idx as CopilotIndexer
    participant Cop as Copilot DB
    participant Index as IndexDb
    participant View as Sessions view
    Dev->>Main: Launch the app
    Main->>View: hand over a MessagePort
    Host->>Idx: background index pass
    rect rgb(255,236,179)
    Idx->>Cop: read-only open
    end
    Cop-->>Idx: session aggregates
    Idx->>Index: upsertChangedSessions(rows)
    View->>Host: sessions.list
    Host-->>Index: IndexDb.listSessions()
    Index-->>View: SessionRow[]
```

```mermaid
sequenceDiagram
    autonumber
    actor Dev
    participant Main as Electron main
    participant Host as Data host
    participant Idx as CopilotIndexer
    participant Cop as Copilot DB
    participant Index as IndexDb
    participant View as Sessions view
    Dev->>Main: Launch the app
    Main->>View: hand over a MessagePort
    Host->>Idx: background index pass
    Idx->>Cop: read-only open
    rect rgb(255,236,179)
    Cop-->>Idx: session aggregates
    end
    Idx->>Index: upsertChangedSessions(rows)
    View->>Host: sessions.list
    Host-->>Index: IndexDb.listSessions()
    Index-->>View: SessionRow[]
```

```mermaid
sequenceDiagram
    autonumber
    actor Dev
    participant Main as Electron main
    participant Host as Data host
    participant Idx as CopilotIndexer
    participant Cop as Copilot DB
    participant Index as IndexDb
    participant View as Sessions view
    Dev->>Main: Launch the app
    Main->>View: hand over a MessagePort
    Host->>Idx: background index pass
    Idx->>Cop: read-only open
    Cop-->>Idx: session aggregates
    rect rgb(255,236,179)
    Idx->>Index: upsertChangedSessions(rows)
    end
    View->>Host: sessions.list
    Host-->>Index: IndexDb.listSessions()
    Index-->>View: SessionRow[]
```

```mermaid
sequenceDiagram
    autonumber
    actor Dev
    participant Main as Electron main
    participant Host as Data host
    participant Idx as CopilotIndexer
    participant Cop as Copilot DB
    participant Index as IndexDb
    participant View as Sessions view
    Dev->>Main: Launch the app
    Main->>View: hand over a MessagePort
    Host->>Idx: background index pass
    Idx->>Cop: read-only open
    Cop-->>Idx: session aggregates
    Idx->>Index: upsertChangedSessions(rows)
    rect rgb(255,236,179)
    View->>Host: sessions.list
    end
    Host-->>Index: IndexDb.listSessions()
    Index-->>View: SessionRow[]
```

```mermaid
sequenceDiagram
    autonumber
    actor Dev
    participant Main as Electron main
    participant Host as Data host
    participant Idx as CopilotIndexer
    participant Cop as Copilot DB
    participant Index as IndexDb
    participant View as Sessions view
    Dev->>Main: Launch the app
    Main->>View: hand over a MessagePort
    Host->>Idx: background index pass
    Idx->>Cop: read-only open
    Cop-->>Idx: session aggregates
    Idx->>Index: upsertChangedSessions(rows)
    View->>Host: sessions.list
    rect rgb(255,236,179)
    Host-->>Index: IndexDb.listSessions()
    end
    Index-->>View: SessionRow[]
```

```mermaid
sequenceDiagram
    autonumber
    actor Dev
    participant Main as Electron main
    participant Host as Data host
    participant Idx as CopilotIndexer
    participant Cop as Copilot DB
    participant Index as IndexDb
    participant View as Sessions view
    Dev->>Main: Launch the app
    Main->>View: hand over a MessagePort
    Host->>Idx: background index pass
    Idx->>Cop: read-only open
    Cop-->>Idx: session aggregates
    Idx->>Index: upsertChangedSessions(rows)
    View->>Host: sessions.list
    Host-->>Index: IndexDb.listSessions()
    rect rgb(255,236,179)
    Index-->>View: SessionRow[]
    end
```

```mermaid
sequenceDiagram
    autonumber
    actor Dev
    participant Panel as SessionDetail
    participant Rend as DetailRenderer
    participant Svc as TelemetryService
    participant DB as TelemetryDatabase
    participant Html as sessionDetailHtml
    rect rgb(255,236,179)
    Dev->>Panel: Click a session
    end
    Panel->>Rend: sessions.detail
    Rend->>Svc: getSessionDetail(key)
    Svc->>DB: getSessionDetail()
    DB-->>Svc: SessionDetail (turns, tokens)
    Rend->>Html: renderSessionDetailHtml()
    Html->>Html: renderTokenTrend(modelTurns)
    Html-->>Rend: HTML + SVG trend graph
    Rend-->>Dev: document in a sandboxed iframe
```

```mermaid
sequenceDiagram
    autonumber
    actor Dev
    participant Panel as SessionDetail
    participant Rend as DetailRenderer
    participant Svc as TelemetryService
    participant DB as TelemetryDatabase
    participant Html as sessionDetailHtml
    Dev->>Panel: Click a session
    rect rgb(255,236,179)
    Panel->>Rend: sessions.detail
    end
    Rend->>Svc: getSessionDetail(key)
    Svc->>DB: getSessionDetail()
    DB-->>Svc: SessionDetail (turns, tokens)
    Rend->>Html: renderSessionDetailHtml()
    Html->>Html: renderTokenTrend(modelTurns)
    Html-->>Rend: HTML + SVG trend graph
    Rend-->>Dev: document in a sandboxed iframe
```

```mermaid
sequenceDiagram
    autonumber
    actor Dev
    participant Panel as SessionDetail
    participant Rend as DetailRenderer
    participant Svc as TelemetryService
    participant DB as TelemetryDatabase
    participant Html as sessionDetailHtml
    Dev->>Panel: Click a session
    Panel->>Rend: sessions.detail
    rect rgb(255,236,179)
    Rend->>Svc: getSessionDetail(key)
    end
    Svc->>DB: getSessionDetail()
    DB-->>Svc: SessionDetail (turns, tokens)
    Rend->>Html: renderSessionDetailHtml()
    Html->>Html: renderTokenTrend(modelTurns)
    Html-->>Rend: HTML + SVG trend graph
    Rend-->>Dev: document in a sandboxed iframe
```

```mermaid
sequenceDiagram
    autonumber
    actor Dev
    participant Panel as SessionDetail
    participant Rend as DetailRenderer
    participant Svc as TelemetryService
    participant DB as TelemetryDatabase
    participant Html as sessionDetailHtml
    Dev->>Panel: Click a session
    Panel->>Rend: sessions.detail
    Rend->>Svc: getSessionDetail(key)
    rect rgb(255,236,179)
    Svc->>DB: getSessionDetail()
    end
    DB-->>Svc: SessionDetail (turns, tokens)
    Rend->>Html: renderSessionDetailHtml()
    Html->>Html: renderTokenTrend(modelTurns)
    Html-->>Rend: HTML + SVG trend graph
    Rend-->>Dev: document in a sandboxed iframe
```

```mermaid
sequenceDiagram
    autonumber
    actor Dev
    participant Panel as SessionDetail
    participant Rend as DetailRenderer
    participant Svc as TelemetryService
    participant DB as TelemetryDatabase
    participant Html as sessionDetailHtml
    Dev->>Panel: Click a session
    Panel->>Rend: sessions.detail
    Rend->>Svc: getSessionDetail(key)
    Svc->>DB: getSessionDetail()
    rect rgb(255,236,179)
    DB-->>Svc: SessionDetail (turns, tokens)
    end
    Rend->>Html: renderSessionDetailHtml()
    Html->>Html: renderTokenTrend(modelTurns)
    Html-->>Rend: HTML + SVG trend graph
    Rend-->>Dev: document in a sandboxed iframe
```

```mermaid
sequenceDiagram
    autonumber
    actor Dev
    participant Panel as SessionDetail
    participant Rend as DetailRenderer
    participant Svc as TelemetryService
    participant DB as TelemetryDatabase
    participant Html as sessionDetailHtml
    Dev->>Panel: Click a session
    Panel->>Rend: sessions.detail
    Rend->>Svc: getSessionDetail(key)
    Svc->>DB: getSessionDetail()
    DB-->>Svc: SessionDetail (turns, tokens)
    rect rgb(255,236,179)
    Rend->>Html: renderSessionDetailHtml()
    end
    Html->>Html: renderTokenTrend(modelTurns)
    Html-->>Rend: HTML + SVG trend graph
    Rend-->>Dev: document in a sandboxed iframe
```

```mermaid
sequenceDiagram
    autonumber
    actor Dev
    participant Panel as SessionDetail
    participant Rend as DetailRenderer
    participant Svc as TelemetryService
    participant DB as TelemetryDatabase
    participant Html as sessionDetailHtml
    Dev->>Panel: Click a session
    Panel->>Rend: sessions.detail
    Rend->>Svc: getSessionDetail(key)
    Svc->>DB: getSessionDetail()
    DB-->>Svc: SessionDetail (turns, tokens)
    Rend->>Html: renderSessionDetailHtml()
    rect rgb(255,236,179)
    Html->>Html: renderTokenTrend(modelTurns)
    end
    Html-->>Rend: HTML + SVG trend graph
    Rend-->>Dev: document in a sandboxed iframe
```

```mermaid
sequenceDiagram
    autonumber
    actor Dev
    participant Panel as SessionDetail
    participant Rend as DetailRenderer
    participant Svc as TelemetryService
    participant DB as TelemetryDatabase
    participant Html as sessionDetailHtml
    Dev->>Panel: Click a session
    Panel->>Rend: sessions.detail
    Rend->>Svc: getSessionDetail(key)
    Svc->>DB: getSessionDetail()
    DB-->>Svc: SessionDetail (turns, tokens)
    Rend->>Html: renderSessionDetailHtml()
    Html->>Html: renderTokenTrend(modelTurns)
    rect rgb(255,236,179)
    Html-->>Rend: HTML + SVG trend graph
    end
    Rend-->>Dev: document in a sandboxed iframe
```

```mermaid
sequenceDiagram
    autonumber
    actor Dev
    participant Panel as SessionDetail
    participant Rend as DetailRenderer
    participant Svc as TelemetryService
    participant DB as TelemetryDatabase
    participant Html as sessionDetailHtml
    Dev->>Panel: Click a session
    Panel->>Rend: sessions.detail
    Rend->>Svc: getSessionDetail(key)
    Svc->>DB: getSessionDetail()
    DB-->>Svc: SessionDetail (turns, tokens)
    Rend->>Html: renderSessionDetailHtml()
    Html->>Html: renderTokenTrend(modelTurns)
    Html-->>Rend: HTML + SVG trend graph
    rect rgb(255,236,179)
    Rend-->>Dev: document in a sandboxed iframe
    end
```

```mermaid
sequenceDiagram
    autonumber
    participant Cop as Copilot DB
    participant Board as LiveBoardService
    participant Watch as ClaudeWatcher
    participant Ctrl as LiveUpdateController
    participant Idx as Index pass
    participant View as Workspace view
    rect rgb(255,236,179)
    Cop->>Board: DB / WAL file change
    end
    Board->>Ctrl: signal()
    Watch->>Ctrl: file change → signal()
    Ctrl->>Board: debounced onRefresh
    Board->>Idx: requestIndex()
    Board-->>View: workspace.live snapshot
```

```mermaid
sequenceDiagram
    autonumber
    participant Cop as Copilot DB
    participant Board as LiveBoardService
    participant Watch as ClaudeWatcher
    participant Ctrl as LiveUpdateController
    participant Idx as Index pass
    participant View as Workspace view
    Cop->>Board: DB / WAL file change
    rect rgb(255,236,179)
    Board->>Ctrl: signal()
    end
    Watch->>Ctrl: file change → signal()
    Ctrl->>Board: debounced onRefresh
    Board->>Idx: requestIndex()
    Board-->>View: workspace.live snapshot
```

```mermaid
sequenceDiagram
    autonumber
    participant Cop as Copilot DB
    participant Board as LiveBoardService
    participant Watch as ClaudeWatcher
    participant Ctrl as LiveUpdateController
    participant Idx as Index pass
    participant View as Workspace view
    Cop->>Board: DB / WAL file change
    Board->>Ctrl: signal()
    rect rgb(255,236,179)
    Watch->>Ctrl: file change → signal()
    end
    Ctrl->>Board: debounced onRefresh
    Board->>Idx: requestIndex()
    Board-->>View: workspace.live snapshot
```

```mermaid
sequenceDiagram
    autonumber
    participant Cop as Copilot DB
    participant Board as LiveBoardService
    participant Watch as ClaudeWatcher
    participant Ctrl as LiveUpdateController
    participant Idx as Index pass
    participant View as Workspace view
    Cop->>Board: DB / WAL file change
    Board->>Ctrl: signal()
    Watch->>Ctrl: file change → signal()
    rect rgb(255,236,179)
    Ctrl->>Board: debounced onRefresh
    end
    Board->>Idx: requestIndex()
    Board-->>View: workspace.live snapshot
```

```mermaid
sequenceDiagram
    autonumber
    participant Cop as Copilot DB
    participant Board as LiveBoardService
    participant Watch as ClaudeWatcher
    participant Ctrl as LiveUpdateController
    participant Idx as Index pass
    participant View as Workspace view
    Cop->>Board: DB / WAL file change
    Board->>Ctrl: signal()
    Watch->>Ctrl: file change → signal()
    Ctrl->>Board: debounced onRefresh
    rect rgb(255,236,179)
    Board->>Idx: requestIndex()
    end
    Board-->>View: workspace.live snapshot
```

```mermaid
sequenceDiagram
    autonumber
    participant Cop as Copilot DB
    participant Board as LiveBoardService
    participant Watch as ClaudeWatcher
    participant Ctrl as LiveUpdateController
    participant Idx as Index pass
    participant View as Workspace view
    Cop->>Board: DB / WAL file change
    Board->>Ctrl: signal()
    Watch->>Ctrl: file change → signal()
    Ctrl->>Board: debounced onRefresh
    Board->>Idx: requestIndex()
    rect rgb(255,236,179)
    Board-->>View: workspace.live snapshot
    end
```

```mermaid
sequenceDiagram
    autonumber
    participant Panel as DetailRenderer
    participant Local as detectTurnDeviations
    participant Group as turnGrouping
    participant Det as WorkflowDeviationDetector
    participant Match as contentMatcher
    rect rgb(255,236,179)
    Panel->>Local: detectTurnDeviations(detail)
    end
    Local->>Group: groupInteractionsByTurn()
    Local->>Det: detectForTurnsWithDefaults()
    Det->>Match: matchesPredicate / content
    Match-->>Det: match result
    Det-->>Local: WorkflowDeviation[][]
    Local-->>Panel: markers rendered
```

```mermaid
sequenceDiagram
    autonumber
    participant Panel as DetailRenderer
    participant Local as detectTurnDeviations
    participant Group as turnGrouping
    participant Det as WorkflowDeviationDetector
    participant Match as contentMatcher
    Panel->>Local: detectTurnDeviations(detail)
    rect rgb(255,236,179)
    Local->>Group: groupInteractionsByTurn()
    end
    Local->>Det: detectForTurnsWithDefaults()
    Det->>Match: matchesPredicate / content
    Match-->>Det: match result
    Det-->>Local: WorkflowDeviation[][]
    Local-->>Panel: markers rendered
```

```mermaid
sequenceDiagram
    autonumber
    participant Panel as DetailRenderer
    participant Local as detectTurnDeviations
    participant Group as turnGrouping
    participant Det as WorkflowDeviationDetector
    participant Match as contentMatcher
    Panel->>Local: detectTurnDeviations(detail)
    Local->>Group: groupInteractionsByTurn()
    rect rgb(255,236,179)
    Local->>Det: detectForTurnsWithDefaults()
    end
    Det->>Match: matchesPredicate / content
    Match-->>Det: match result
    Det-->>Local: WorkflowDeviation[][]
    Local-->>Panel: markers rendered
```

```mermaid
sequenceDiagram
    autonumber
    participant Panel as DetailRenderer
    participant Local as detectTurnDeviations
    participant Group as turnGrouping
    participant Det as WorkflowDeviationDetector
    participant Match as contentMatcher
    Panel->>Local: detectTurnDeviations(detail)
    Local->>Group: groupInteractionsByTurn()
    Local->>Det: detectForTurnsWithDefaults()
    rect rgb(255,236,179)
    Det->>Match: matchesPredicate / content
    end
    Match-->>Det: match result
    Det-->>Local: WorkflowDeviation[][]
    Local-->>Panel: markers rendered
```

```mermaid
sequenceDiagram
    autonumber
    participant Panel as DetailRenderer
    participant Local as detectTurnDeviations
    participant Group as turnGrouping
    participant Det as WorkflowDeviationDetector
    participant Match as contentMatcher
    Panel->>Local: detectTurnDeviations(detail)
    Local->>Group: groupInteractionsByTurn()
    Local->>Det: detectForTurnsWithDefaults()
    Det->>Match: matchesPredicate / content
    rect rgb(255,236,179)
    Match-->>Det: match result
    end
    Det-->>Local: WorkflowDeviation[][]
    Local-->>Panel: markers rendered
```

```mermaid
sequenceDiagram
    autonumber
    participant Panel as DetailRenderer
    participant Local as detectTurnDeviations
    participant Group as turnGrouping
    participant Det as WorkflowDeviationDetector
    participant Match as contentMatcher
    Panel->>Local: detectTurnDeviations(detail)
    Local->>Group: groupInteractionsByTurn()
    Local->>Det: detectForTurnsWithDefaults()
    Det->>Match: matchesPredicate / content
    Match-->>Det: match result
    rect rgb(255,236,179)
    Det-->>Local: WorkflowDeviation[][]
    end
    Local-->>Panel: markers rendered
```

```mermaid
sequenceDiagram
    autonumber
    participant Panel as DetailRenderer
    participant Local as detectTurnDeviations
    participant Group as turnGrouping
    participant Det as WorkflowDeviationDetector
    participant Match as contentMatcher
    Panel->>Local: detectTurnDeviations(detail)
    Local->>Group: groupInteractionsByTurn()
    Local->>Det: detectForTurnsWithDefaults()
    Det->>Match: matchesPredicate / content
    Match-->>Det: match result
    Det-->>Local: WorkflowDeviation[][]
    rect rgb(255,236,179)
    Local-->>Panel: markers rendered
    end
```
