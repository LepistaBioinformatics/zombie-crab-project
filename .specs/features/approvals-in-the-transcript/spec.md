# approvals-in-the-transcript — Specification

**Status:** Draft
**Size:** Large (three repos: harness writes the record, proxy serves it, webapp draws it)
**Closes:** `ganglion-approval-endpoint/spec.md` FR-5.2 — "that record SHALL be
readable by the member... where it is displayed is the next feature's concern".
This is that feature.

---

## Problem

A gated tool call is the only thing in this product that stops an agent and asks
a person. It is also the only thing that leaves no trace.

Two halves of the same gap:

1. **The request is transient.** `ApprovalCard` polls `/api/approvals` every
   three seconds while a turn runs. The pending request lives in the proxy's
   memory (`approvalStore`, deliberately not persisted) and is dropped the moment
   the harness's deadline passes or the container goes away. A member who steps
   away for six minutes comes back to a conversation where nothing happened and
   no explanation of why.
2. **The answer is not in the conversation.** Clicking Allow or Refuse resolves
   the request, the card vanishes, and the only record written is a JSONL line
   under the proxy's data root (`recordApproval`) that no screen reads. The
   transcript the member scrolls says nothing about the decision they made.

The agent is told — a refusal reaches it as a `Result` it can explain (DEC-2).
The member is not.

## Goal

Every approval decision is a durable row in the conversation it happened in,
written by the component that knows the outcome, rendered the way the compaction
divider is rendered: a quiet rule across the column, with the detail behind a
click.

## Key findings (verified in code, not assumed)

1. **The precedent exists and works.** `Loop.markCompaction`
   (`runtime/offload.go`) appends an assistant message with no content and one
   event of kind `compact`. `crab-shell-proxy`'s `readMessages` stamps it
   `KindCompact` so it cannot be mistaken for narration, and the webapp's
   `toRows` gives it its own row variant, which `CompactionRow` draws. Four
   files, one shape, already shipped.

2. **Only the harness sees all four outcomes.** The proxy records answered
   requests and nothing else: on `r.Context().Done()` it calls
   `Approvals.remove(p.ID)` and writes no line, so a request that expired — the
   first half of the problem above — is invisible to it. `Loop.approve` sees the
   allow, the refusal, the timeout (`ctx.Done`) and the transport failure.
   **The record is therefore the harness's to write**, and merging the proxy's
   audit file into the served history would be a second source of truth that is
   missing exactly the case the member complained about.

3. **An events-only entry is invisible to the model, by existing rule.**
   `window.conversational` drops `Content == "" && len(Events) > 0` whole, and
   nils `ToolCalls` on everything else. So a record in this shape cannot leak
   into a rebuilt window and cannot orphan a tool run, wherever it sits in the
   file.

4. **It still must not sit mid-iteration, for a rendering reason.** `toRows`
   folds an events-only step into the step before it. An approval entry written
   between the narration and the iteration's events entry breaks that merge, and
   one iteration renders as "1 step · divider · 1 step". The record goes in
   **after** the iteration's `flushEvents`, on every exit path.

5. **Nothing today can tell "a person was asked" from "nothing was gated".**
   `proxy.Client.Request` short-circuits `Decision{Allowed: true, Reason: "not
   gated"}` and `allowAll` returns `Decision{Allowed: true}`. Both are
   indistinguishable from a real allow at the call site, so a record keyed off
   `Allowed` alone would put a divider under every tool call in the product.
   `domain.Decision` needs one new field, set only where a request was actually
   POSTed.

6. **The harness has no locale.** Every string a member reads is rendered by the
   webapp from codes. `"no answer from an approver in time"` and `"refused by
   the member"` are English sentences the harness and the proxy compose for the
   *model*; neither may reach the screen.

## Non-goals

| Excluded | Reason |
|---|---|
| Showing the row the instant the member clicks | The record is written into the transcript, and the transcript is reloaded when the turn ends. An optimistic row would be a second rendering path for the same event, drawn from state the server has not confirmed. See OQ-1. |
| Keeping the pending card alive past the harness's deadline | There is nothing left to answer: the turn resumed, denied, minutes ago. The record is what replaces it. |
| Recording the evolution engine's `evolution.apply` approval | It is asked outside any turn (`evolution.go:316`) and carries no `SessionID`. There is no conversation to write it into. Stated so the gap is known, not fixed here. |
| Backfilling past approvals from the proxy's audit file | Finding 2: a second source of truth, missing the expiries, in a different order. |
| Changing what is gated | `GANGLION_GATED_TOOLS` is untouched. |

## Requirements

### FR-1 — The harness records every decision it asked a person for

1. WHEN a tool call's approval request reached an approver THEN the harness SHALL
   append one transcript entry per decision: role `assistant`, **no content**,
   carrying exactly one event of kind `approval`.
2. The event SHALL carry the tool's `Name`, its `Arguments` through `eventArgs`
   (flattened and capped, as every other event's are), and a `Status` of
   `ok`, `denied`, `expired` or `failed`.
3. WHEN the call was never gated THEN nothing SHALL be written. A product with an
   empty gate list SHALL produce no approval rows at all.
4. The entry SHALL be appended after the iteration's `flushEvents`, on the normal
   path and on both early returns (cancelled, failed), so a turn that died inside
   the approved tool still records the approval that let it run.
5. A failed append SHALL emit a progress line and SHALL NOT fail the turn, the
   rule `markCompaction` already follows: the record is commentary, and the turn
   has done its work.

### FR-2 — The four outcomes are distinguishable, and carry no English

1. `ok` — a member allowed it. `denied` — a member refused it. `expired` — the
   harness's deadline passed with no answer. `failed` — the approver could not be
   reached or did not answer intelligibly.
2. `Detail` SHALL carry the member's own reason and nothing else. On `expired`
   and `failed` it SHALL be empty: the reasons the harness composes on those
   paths are written for the model.
3. The proxy SHALL stop substituting `"refused by the member"` for an empty
   reason. The harness SHALL compose the model-facing sentence for a refusal with
   no reason, so dropping the substitution costs the model nothing and keeps an
   English sentence out of a pt-BR member's own refusal.

### FR-3 — The proxy serves it as its own kind

1. `readMessages` SHALL stamp an assistant entry carrying an `approval` event
   with `Kind: "approval"`, assigned last, for the reason `KindCompact` is
   assigned last: it arrives in the same shape as a silent tool call and would
   otherwise be filed as narration and collapsed into a run.
2. Nothing else about the entry SHALL be interpreted. `Status` and `Detail` pass
   through like every other event field.

### FR-4 — The webapp draws it as a divider

1. `toRows` SHALL give the entry its own row variant, tested before the step
   test, so it never joins a run of steps.
2. The row SHALL state the outcome and the tool on one line, in the member's
   language, composed from `Status` — never from `Detail`.
3. The arguments, and the member's reason when there is one, SHALL be behind a
   click, like the compaction row's explanation. The arguments are shown verbatim
   and SHALL NOT be parsed: `eventArgs` truncates, so they may not be JSON.
4. `landingIndex` SHALL skip it, as it skips a compaction record: opening a
   conversation on a note about a decision lands the member beside the
   transcript instead of in it.
5. Copy SHALL exist in both locales and SHALL differ between them (the parity
   test).

### NFR

1. **No new transport, route or credential.** One new event kind travelling a
   path that already carries four.
2. **Go gate:** `gofmt -l .` silent, `go vet ./...`, `go test ./...` in both Go
   repos.
3. **Webapp gate:** `./node_modules/.bin/vitest run` and
   `./node_modules/.bin/next build`. (`yarn lint` does not run in this repo and
   `tsc` has seven pre-existing errors — neither is a gate here.)

## Checked and found to need nothing

- **The conversation tree, Canvas and the content filter.** All three read
  `history-cache`, which keeps only `content.trim() !== ""`. An approval record
  has no content by construction, so none of them can draw it as a blank node.
- **`search_history`.** `recall.go` skips an entry with empty content, so the
  record is not findable by the agent — which is right: the agent was told the
  outcome as a tool result at the time.
- **The webapp's blank filter** (`app/api/chat/[instance]/history/route.ts`)
  already keeps an entry carrying events, for the silent tool call and the
  compaction record. It keeps this one for the same clause.
- **When the row appears.** `turn-store`'s painter fires when a turn fully
  finishes and `ChatView` reloads the transcript, so the record appears at the
  end of the turn without reopening the conversation — the same moment the
  compaction divider appears today.

## Open question

**OQ-1 — the gap between the click and the row.** The record reaches the screen
when the turn ends and the history reloads, which may be minutes after the member
answered. Closing it means either pushing the event down the turn stream or
inserting an optimistic row from `ApprovalCard`. Both are a second rendering path
for one event, and neither is worth it until someone says the wait is the
problem. The decision is recorded durably the moment it is made; only its
*appearance* waits.
