# Design

## The cross-repo contract

Three repositories agree on a directory name and a set of JSON field names. The harness
writes, the proxy reads, the webapp renders. **Nothing type-checks this agreement**, and
drift would surface as a permanently empty sheet rather than as an error — so it is
pinned by a test on each side, the way `TestSecretPrefixMatchesTheHarness` pins
`CRAB_SECRET__`.

### The record

`<turn workspace>/.tool-audit/<conversation>/<id>.json`

```json
{
  "id":         "1727300000123456789-00",
  "call_id":    "call_abc123",
  "name":       "sh",
  "arguments":  "{\"command\":\"…the whole thing…\"}",
  "output":     "…the whole result, as the tool returned it…",
  "status":     "ok",
  "detail":     "",
  "started_at": "2026-09-25T22:15:30.123456789Z",
  "ended_at":   "2026-09-25T22:15:31.456789012Z"
}
```

- `id` — minted by the harness (FR-1.4). `<unix-nanos>-<call index within the iteration>`:
  monotonic within a conversation, sorts chronologically, needs no state to generate, and
  is already `safe()` by construction.
- `call_id` — the provider's, **which may be empty**. Kept for correlation, never used as
  a key.
- `arguments` — the raw `call.Args`, uncapped, as the provider sent them.
- `output` — absent until the call returns; absent forever if the turn died inside it.
- `status` — the same vocabulary `TurnEvent` uses: `ok` / `denied` / `failed`, empty while
  the call is still running.

### The event

`domain.TurnEvent` gains **one** field, mirrored in the proxy's `history.Event` and the
webapp's `TurnEvent`:

```go
// AuditID names this call's record under .tool-audit. Minted here, not the
// provider's id, which may be empty.
AuditID string `json:"audit_id,omitempty"`
```

`omitempty` matters: every transcript written before this ships has no such field, and
every event that is not a tool call has no record.

## Why a second store (FR-1.1), restated as code

`.tool-output` is reachable by the model: `Put` returns a path relative to the turn
workspace and `clampToPointer` writes it into the window, where `elide` leaves it after
compaction. Compressing that file would dangle a pointer a resumed conversation still
holds. `.tool-audit` is never named to the model, so its files can be renamed freely.

## Harness

| Piece | Where |
|---|---|
| `toolaudit.Store` (Put, Complete, Sweep) | `internal/adapter/store/toolaudit/` |
| `domain.ToolAuditStore` port | `internal/domain/` beside `ToolOutputStore` |
| minting + the two writes | `internal/runtime/loop.go`, around the existing `events.Add` / `Finish` pair |
| the boot sweep | `cmd/crab-ganglion/main.go`, where the other stores are constructed |

The loop already has the two moments the record needs: the pre-call `events.Add`
(`loop.go:336`) and the four `Finish` calls (`loop.go:362-385`). The record is written and
completed at the same points, so no new control flow is introduced.

## Proxy

| Piece | Where |
|---|---|
| `config.ToolAuditDir(root, …, segment)` | `internal/config/config.go`, beside `SessionsDir` |
| `handleSessionsToolCall` | `internal/httpapi/handlers.go`, beside `handleSessionsHistory` |
| `Event.AuditID` passthrough | `internal/history/history.go` |

The handler reuses history's identity and workspace resolution verbatim — the same
`SessionKey`, the same tenant/subs/segment query parameters, the same account-switching
guard — so the two routes cannot disagree about whose directory they are reading.

## Webapp

| Piece | Where |
|---|---|
| `TurnEvent.auditId` | `app/chat/message-rows.ts` |
| the timeline and the rows | `app/chat/chat-view.tsx` (`StepRun`, `StepEvents`) |
| the sheet | a new `app/chat/tool-call-sheet.tsx`, wrapping the existing `BottomSheet` |
| the BFF route | `app/api/chat/[instance]/tool-call/route.ts` |

The sheet owns its own fetch and its own loading and empty states, so `chat-view.tsx`
gains one piece of state (which event is open) and nothing else.

## Degradation, in one table

| Situation | What the row does | What the sheet says |
|---|---|---|
| ganglion, after this ships | opens | command and output |
| turn died inside the call | opens | command, and "no output recorded" |
| transcript predates this | no pointer, row does not open | — |
| picoclaw (agent `beta`) | no pointer, row does not open | — |
| `kind` is model / depth / subagent | never opens (FR-6.4) | — |
