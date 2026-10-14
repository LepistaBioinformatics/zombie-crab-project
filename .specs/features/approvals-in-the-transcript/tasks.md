# approvals-in-the-transcript — Tasks

Bottom-up: the harness writes the record, the proxy serves it, the webapp draws
it. Each level is testable without the one above.

## T-1 — `domain`: the event kind and the gate outcome (harness)

- **Where:** `internal/domain/message.go`, `internal/domain/session.go`
- **What:** `EventApproval = "approval"` and `EventExpired = "expired"` beside
  the existing kinds and statuses. `Decision.Gate string`, documented as empty
  when nothing was asked and otherwise one of the four statuses.
- **Done when:** `go build ./...` passes and the field's doc says who sets it.
- **Covers:** FR-1.2, FR-2.1

## T-2 — The adapter says whether a person was asked (harness)

- **Where:** `internal/adapter/approver/proxy/proxy.go`
- **What:** the ungated short-circuit leaves `Gate` empty; the POSTed path sets
  `EventOK` or `EventDenied` from the answer.
- **Tests:** a gated call and an ungated one, asserting the field.
- **Covers:** FR-1.3

## T-3 — `Loop.approve` classifies its own two failures (harness)

- **Where:** `internal/runtime/loop.go`
- **What:** the `ctx.Done` branch sets `Gate: EventExpired`, the approver-error
  branch `Gate: EventFailed`. Both are reachable only after the adapter decided
  the call was gated, which the comment states.
- **Covers:** FR-2.1

## T-4 — The record is appended after the iteration's events (harness)

- **Where:** `internal/runtime/loop.go`
- **What:** `runTool` returns the decision; the iteration collects one event per
  gated call and `markApprovals` writes them after each `flushEvents` — the
  normal path and both early returns. Empty reason on a refusal gets a sentence
  of its own in the model-facing `Result`.
- **Tests (`internal/runtime/marker_test.go`, beside the compaction marker):**
  allowed, refused with a reason, expired; nothing for an ungated call; the
  entry carries no content and is dropped by `window.conversational`; the record
  lands after the events entry, not between the narration and it.
- **Covers:** FR-1.1, FR-1.4, FR-1.5, FR-2.2

## T-5 — The proxy stops composing a reason (proxy)

- **Where:** `internal/httpapi/approvals.go`
- **What:** drop the `"refused by the member"` substitution.
- **Tests:** the existing approvals test updated to assert the empty reason
  travels.
- **Covers:** FR-2.3

## T-6 — History serves the new kind (proxy)

- **Where:** `internal/history/history.go`
- **What:** `KindApproval`, `EventApproval`, `hasApproval`, assigned after the
  compaction check.
- **Tests (`internal/history/events_test.go`):** an approval entry is served as
  its own kind, not as a step; a transcript without one is unchanged.
- **Covers:** FR-3

## T-7 — The row (webapp)

- **Where:** `app/chat/message-rows.ts`, `app/chat/approval-row.tsx` (new),
  `app/chat/chat-view.tsx`, `lib/i18n/chat.ts`
- **What:** `KIND_APPROVAL`, the row variant before the step test,
  `approvalRecord(m)`, `landingIndex` skipping it, the divider component, en and
  pt copy.
- **Tests:** `app/chat/approval-row.test.tsx` (the four outcomes, the reason
  behind the click, arguments shown verbatim) and the grouping cases in
  `app/chat/compaction-row.test.ts`'s sibling.
- **Covers:** FR-4

## Gate

- `gofmt -l .`, `go vet ./...`, `go test ./...` in `crab-ganglion-harness` and
  `crab-shell-proxy`
- `./node_modules/.bin/vitest run` and `./node_modules/.bin/next build` in
  `crab-exoskeleton-webapp`
