# visible-loop-events — Design

Three repos, one shape travelling through them. The shape is `TurnEvent`, and every
decision below is about keeping it the same thing at all three hops.

## The shape

```go
// crab-ganglion-harness/internal/domain
type TurnEvent struct {
    Kind      string          `json:"kind"`                // tool | subagent | model | depth
    Name      string          `json:"name,omitempty"`
    Arguments string          `json:"arguments,omitempty"` // capped, see §3
    Status    string          `json:"status,omitempty"`    // ok | denied | failed
    Detail    string          `json:"detail,omitempty"`
}
```

`Arguments` is a STRING, not `json.RawMessage`, and that is the cap's doing: a truncated
JSON document is not JSON, and typing it as raw would put a value on disk that every
reader has to defend against. It is a display string from the moment it is written.

`Message.Events []TurnEvent \`json:"events,omitempty"\`` carries them. `omitempty` keeps
every existing line byte-identical.

## 1. The harness — where each event is made

`Loop.Run`'s iteration gains one local slice, flushed once at the end of the batch.

| Event | Where it is appended |
|---|---|
| `tool` | in the per-call loop: name and arguments before `runTool`, status after — `ok`, `denied` from `res.Denied`, `failed` with the error's text in `Detail` |
| `subagent` | from `res.Events`, appended after the call's own `tool` event |
| `model` | in `tryChain`, beside the existing fallback progress frame |
| `depth` | beside the existing depth-change progress frame |

`model` and `depth` are made inside `completeWithFallback` / the call loop, which do not
own the slice. They reach it the way the sink does: a per-turn collector on the context.
A `*[]TurnEvent` on the context, appended under the turn's own goroutine — the loop is
sequential, and the one place that is not (`subagents`, which fans out) returns its events
through `Result` rather than reaching for the collector.

**The flush** goes exactly where the media append already goes — after the whole batch,
before `compact`. FR-1.2 keeps the narration write where it is.

```go
// after the batch, before compact
if len(events) > 0 {
    _ = c.Transcript.Append(ctx, t.SessionID, domain.Message{
        Role: domain.RoleAssistant, Events: events, CreatedAt: c.Now(),
    })
}
```

A failed append is logged, never fatal: the events are commentary, and losing the turn
over them would be the worst possible trade.

### 2. `Result.Events`

`domain.Result` gains `Events []TurnEvent`. Verified to survive the trip: `Registry.Invoke`
returns `t.Invoke(...)` and `filtered.Invoke` returns `f.inner.Invoke(...)` — the struct is
returned by value and never rebuilt, so a new field is not silently dropped.

`subagents` fills it from the `SubReport`s it already builds for `render`: one event per
child, `Name` = the label, `Status` = `ok`/`failed`, `Detail` = the error. Nothing else
fills it, and the loop names no tool.

### 3. The cap

```go
const maxEventArgs = 200 // runes
```

Applied in the harness, on the way to `TurnEvent`, with a trailing `…` when it bites. A
`write_file` call carries the whole file in its arguments; uncapped, a transcript would
grow by everything the agent ever wrote.

The JSON is flattened to one line first (whitespace collapsed), so the cap measures what
will be shown rather than the document's indentation.

## 4. The proxy — two filters and a parse

`jsonlEntry` stops declaring `ToolCalls []json.RawMessage` and parses what it needs:

```go
ToolCalls []struct {
    Function struct{ Name, Arguments string } `json:"function"`
    Name     string                           `json:"name"`
} `json:"tool_calls"`
Events []Event `json:"events"`
```

Two spellings for the name because two writers produce this file: picoclaw nests it under
`function`, the ganglion writes `name` flat (`domain.ToolCall`). Reading both is what keeps
FR-4.4 true for either harness's older transcripts.

**The drop filter** (`readMessages`) gains one clause: an entry with no content and no
reasoning is kept when it carries events. Everything else about it is unchanged.

**The step marker** already covers both: `len(e.ToolCalls) > 0` marks the narration entry,
and the events entry is marked because it carries events. Both are `KindStep`; neither can
be promoted by `keepAnswerlessTurns`, whose `speaks()` requires non-empty content.

**FR-4.4** synthesizes `tool` events with no status from a narration entry's own
`tool_calls`, so a transcript written before this feature still names its tools.

## 5. The webapp — the merge, then the render

**`message-rows.ts`.** `ChatMessage` gains `events?: TurnEvent[]`. `toRows`'s step branch
folds an events-only message into the previous item of the current run:

```ts
if (m.kind === "step" && !m.content && m.events?.length) {
  const last = rows[rows.length - 1];
  if (last?.row === "steps" && last.items.length > 0) {
    const prev = last.items[last.items.length - 1];
    prev.events = [...(prev.events ?? []), ...m.events];
    return;
  }
}
```

The item, not the message: the message keeps its own index, which scroll refs and the
tree's `msg` anchor are keyed by, and the merged item carries both. FR-5.5's orphan falls
through to the ordinary step path.

`landingIndex` and `rowRole` need no change — a merged message is no longer its own item,
so nothing counts it.

**`StepRun`.** Each item renders its narration as now, with its events beneath as a list:
an icon per kind, the name in mono, the capped arguments in mono and `truncate` with the
full value on `title`, and the status as a short localized word.

**Copy.** `kind` and `status` map to both locales. `name`, `arguments` and `detail` are
data and are never translated.

## Gates

- harness: `go test ./...`
- proxy: `go test ./internal/history ./internal/httpapi`
- webapp: `./node_modules/.bin/vitest run` + `npx next build`
