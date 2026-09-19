# ganglion-approval-endpoint — Specification

**Status:** Draft
**Size:** Medium (proxy endpoint + a member-facing answer in the chat; design inline)
**Blocks:** `ganglion-agent-scheduling`, which the owner sequenced behind this.
**Closes:** DC-1, recorded open in `ganglion-agent-confinement/spec.md:119-122,248-250`
("carried into `crab-ganglion-harness` FR-7 / OQ-3, which has no code yet").

---

## Problem

The ganglion can ask permission before running a tool. It has asked since the
approver adapter shipped: `Loop.runTool` calls `approve` on every tool call, the
gate list comes from `GANGLION_GATED_TOOLS`, the timeout from
`GANGLION_APPROVAL_TIMEOUT_SECONDS`, and the request goes to
`GANGLION_APPROVAL_ENDPOINT`.

Nothing answers it. No proxy route accepts that request, so the variable is unset
everywhere, the gate list is empty, and `Client.Request` short-circuits
`Allowed: true, "not gated"` before it builds a body. The whole path runs on every
call and decides nothing — which is exactly how it was designed to avoid rotting
(`approver/proxy/proxy.go:22-25`), but it means "this tool requires approval" is a
sentence with no enforcer behind it.

One capability is already blocked by the gap. Evolution's `apply` mode requires an
approver and refuses to boot without one, naming the variable
(`cmd/crab-ganglion/main.go:437-452`) — the deliberate choice recorded in AD-025
D-2, because a gate with no enforcer is worse than no gate. So `apply` cannot be
turned on at all today.

And the next capability the owner wants — an agent that can schedule its own
future turns — is one the stack currently refuses on the grounds that a turn
steered by untrusted text must not be able to do it. Approval is what makes that
refusal reconsiderable.

## Goal

A member can allow or refuse a gated tool call from the conversation it happens
in, and the proxy — not the harness — decides who was allowed to answer.

## Key findings (verified, not assumed)

1. **The contract is already fixed, by shipped code.** `POST` to the endpoint with
   `Authorization: Bearer <GANGLION_TOKEN>` and a body of
   `{session_key, session_id, tool_call_id, tool, arguments}`
   (`approver/proxy/proxy.go:78-84`); the reply must decode to
   `{allowed, reason, by}` (`:86-90`). Anything else is a decode error, which the
   loop turns into a denial. **This spec does not get to choose the shapes** — a
   different one means changing a harness that is already published as immutable
   image tags.

2. **A refusal is not a failure.** DEC-2: the loop turns `Allowed: false` into a
   `Result` the model reads — `The action %q was not approved: %s` — and the turn
   continues (`runtime/loop.go:868-874`). So a denial is something the agent can
   explain to the member, not a broken turn.

3. **A timeout denies.** DEC-4, `runtime/loop.go:885-887` and `:920-921`: on
   `ctx.Done()` the decision is `Allowed: false, "no answer from an approver in
   time"`. Fail closed is already the behaviour; this spec must not weaken it.

4. **The wait is already visible.** DEC-3: while waiting, the loop emits a
   `ProgressPlaceholder` every `ApprovalHeartbeat` reading
   `waiting for approval to run <tool>` (`loop.go:908-914`), because a silent
   stream for minutes is the failure `turn-stream-continuity` documents. The chat
   already receives an event; what it lacks is a control to answer with.

5. **The default timeout is 300 seconds** (`config/config.go:103`). That is the
   window a member has to answer, and it is long enough that the answer has to
   come from a person who is looking at the conversation.

6. **DC-1 is the constraint, stated where it was decided**
   (`ganglion-agent-confinement/spec.md:119-122`):
   *"The approvals endpoint must not treat a harness-presented bearer as
   authorization for a decision. The harness presents identity; the proxy decides
   from its own state and mycelium's account id. A token the agent can read is not
   an authorization token."*
   `GANGLION_TOKEN` is a per-user random bearer the proxy minted and stored in
   `.crab-ganglion.json` (`docker/ganglion.go:331-361`). It identifies the
   container. It must not be read as "the member consents".

7. **`SessionKey` is `<userAccID>:<role>`** — the same shape the scheduler builds
   (`httpapi/cron_scheduler.go:298`). It names the workspace, which is what lets
   the proxy find the member without trusting anything in the body.

## Non-goals

| Excluded | Reason |
|---|---|
| An approval policy engine in the harness | DEC-1: the harness never decides who may approve. It has no information the proxy lacks and no way to obtain it. |
| Approving from anywhere but the conversation the call happened in | The member has to see what they are allowing. An out-of-band queue turns a decision about one tool call into a list of rows with no context. |
| Asynchronous approval that outlives the turn | The turn is blocked on the answer, with a 300-second deadline the harness owns. A decision that arrives after the deadline has nothing to allow. |
| Gating any tool by default | `GANGLION_GATED_TOOLS` stays empty in this feature. What gets gated is the next feature's decision, not this one's. |
| Approval for picoclaw | picoclaw has no approver port. |

## Requirements

### FR-1 — The endpoint

1. The proxy SHALL accept `POST /v1/approvals` with the body shape at finding 1,
   and SHALL answer `{allowed, reason, by}`.
2. The route SHALL identify the calling container the way the container can prove
   and no further: the bearer presented is `GANGLION_TOKEN`, which the proxy
   minted per user and can therefore match against its own record.
3. **That match SHALL establish which workspace is asking, and nothing more.**
   It SHALL NOT be read as the member's consent (finding 6, DC-1).
4. A request whose bearer matches no known workspace SHALL be refused with 401 and
   a body carrying no detail — the same posture `/v1/mcp` takes
   (`mcpserver/server.go:148-156`).

### FR-2 — Who answers

1. The proxy SHALL resolve the member from `session_key`'s account id against its
   own state, never from anything else in the request.
2. Only that member SHALL be offered the decision.
3. The recorded `by` SHALL be the answering member's account id, so the harness's
   `Decision.By` carries a fact the proxy established rather than a string the
   container supplied.

### FR-3 — How the member answers

1. The pending request SHALL reach the member in the conversation the tool call
   belongs to, identified by `session_id`.
2. The member SHALL see the tool name and its arguments — what they are allowing,
   not merely that something is pending.
3. The chat SHALL offer allow and refuse, and SHALL let the member give a reason
   on refusal, which becomes `reason` and therefore reaches the model.
4. WHEN no member is attached to that conversation THEN the request SHALL simply
   go unanswered; the harness's deadline denies it (finding 3). **This is the
   behaviour, not a gap:** an unattended turn is exactly the case where nobody
   should be granting anything.

### FR-4 — Fail closed, everywhere

1. The proxy SHALL NOT answer `allowed: true` on any path that did not receive a
   member's explicit allow.
2. A proxy-side error, an unknown session, or an unresolvable member SHALL produce
   a refusal with a reason, never a silent allow and never a 500 the harness would
   turn into a denial with an opaque message.
3. The harness's own timeout remains the outer bound. The proxy SHALL NOT hold a
   request open past it in a way that leaks a goroutine or a connection per
   abandoned call.

### FR-5 — Visibility after the fact

1. An answered request SHALL be recorded with the tool, the arguments, the
   decision, the reason and the answering member.
2. That record SHALL be readable by the member, so "what did I approve" is
   answerable later. Where it is displayed is the next feature's concern; that it
   is written is this one's.

### NFR

1. **No new credential reaches the container.** This feature adds a route the
   container already has a bearer for; it mints nothing new.
2. **Gates stay empty.** Shipping this must change no agent's behaviour until a
   tool name is added to `GANGLION_GATED_TOOLS`.
3. **Go gate:** `gofmt -l .` silent, `go vet ./...`, `go test -race ./...`,
   `go build ./...` — and the same tests run inside the Dockerfile.

## Open question

**OQ-1 — how the pending request reaches an attached browser.** The turn is a
stream the member is already watching, and the harness already emits a placeholder
into it. Whether the control rides that stream or is fetched alongside it is a
design decision this spec does not make. What it fixes is the requirement: the
member sees it in the conversation, with the arguments, inside the deadline.
