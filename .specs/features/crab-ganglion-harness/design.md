# crab-ganglion-harness — Design

**Status:** Designed. Not implemented.
**Date:** 2026-09-09.
**Reads:** `spec.md` (this directory) for requirements; the parent monorepo's
`.specs/features/own-go-harness/investigation.md` for why.

This document decides **structure and contracts**. It does not decide task order — that is
`tasks.md`, which does not exist yet.

---

## 1. Module layout

Mirrors `harness-sphere`'s crate split, which is this house's existing hexagonal precedent:
`domain` (model, ports, pure policy) → `runtime` (the use case) → adapters → binary.

```
crab/crab-ganglion-harness/
├── cmd/crab-ganglion/
│   └── main.go              # composition root: the ONLY file where adapters meet
├── internal/
│   ├── domain/              # AR-1: standard library ONLY
│   │   ├── message.go       # Message, Role, ToolCall, Usage
│   │   ├── session.go       # SessionKey, Transcript, Window
│   │   ├── action.go        # ActionRequest, Decision  (approval)
│   │   └── ports.go         # the five ports, and nothing else
│   ├── runtime/             # the agent loop; imports domain only
│   │   ├── loop.go          # iterate: provider → tools → provider …
│   │   ├── compact.go       # when and how the Window is rebuilt
│   │   └── stream.go        # delta fan-out to the sink
│   └── adapter/
│       ├── httpsse/         # DRIVING adapter: POST /v1/chat/completions, GET /health
│       ├── provider/openai/ # Provider — streaming, OpenAI-compatible
│       ├── store/jsonl/     # TranscriptStore — append-only
│       ├── store/window/    # ContextStore — derived, rewritable
│       ├── tool/            # ToolExecutor + the Tool registry (fractal, §3)
│       │   ├── registry.go
│       │   └── exec/        # first Tool adapter: process execution
│       ├── approver/proxy/  # Approver — calls back to crab-shell-proxy
│       └── telemetry/otlp/  # Telemetry
└── Dockerfile
```

**AR-1 is enforced by a test, not by intent** — a unit test walks `internal/domain`'s imports
and fails on anything outside the standard library. `harnesssphere-domain` holds the line with
two dependencies; Go's stdlib makes zero reachable, so zero is the bar.

**AR-4 is enforced the same way:** no package under `adapter/` may import another package under
`adapter/`. Both checks are cheap and they are the whole difference between an architecture and
an adjective.

---

## 2. The domain: five ports

```go
package domain

// Provider is the LLM. Streaming is not optional — FR-2 is the reason this
// harness exists in its current shape.
type Provider interface {
    Complete(ctx context.Context, req Completion) (Stream, error)
}

// Stream yields deltas as the provider emits them. Next returns io.EOF when the
// completion is done; Usage is valid only after that.
type Stream interface {
    Next(ctx context.Context) (Delta, error)
    Usage() Usage
    Close() error
}

// TranscriptStore is append-only and complete. It has no Truncate, no Rewrite
// and no Compact, and that absence is FR-9 expressed as a type.
type TranscriptStore interface {
    Append(ctx context.Context, key SessionKey, m Message) error
    Read(ctx context.Context, key SessionKey) ([]Message, error)
}

// ContextStore holds the DERIVED window the model actually sees. Rewriting it is
// normal; it can be rebuilt from the transcript at any time.
type ContextStore interface {
    Load(ctx context.Context, key SessionKey) (Window, error)
    Save(ctx context.Context, key SessionKey, w Window) error
}

// ToolExecutor runs one tool call. It is a port so the loop never learns how a
// tool is implemented, and so a denied action (Approver) can be answered with a
// Result instead of an error.
type ToolExecutor interface {
    Available(ctx context.Context) []ToolSchema
    Invoke(ctx context.Context, call ToolCall) (Result, error)
}

// Approver decides whether a proposed action may run. FR-7.
type Approver interface {
    Request(ctx context.Context, a ActionRequest) (Decision, error)
}

// Telemetry is a port so the domain and runtime never import OTel. FR-10.
type Telemetry interface {
    Span(ctx context.Context, name string, attrs ...Attr) (context.Context, func(error))
    Usage(ctx context.Context, u Usage, attrs ...Attr)
}
```

### The FR-9 invariant is structural

`TranscriptStore` exposes no way to shorten anything. Compaction writes to `ContextStore`,
a different port with a different file. **It is not possible to truncate the served transcript
by compacting the context window, because the code that compacts cannot reach it.**

This is the design answer to the measured picoclaw failure — 102 entries in the live file
against 465 in the proxy's `durable/` fold-forward — and it is what lets `internal/history`'s
738-line fold-forward retire rather than being reimplemented here.

---

## 2.1 The driving side is a port too — `Ingress`

Added 2026-09-09, when Telegram entered scope: *"fora o http/sse o único conector que você
precisará é o telegram, que deverá ser um módulo adicional, não instalação nativa."*

Two driving adapters means the driving side cannot be "the HTTP server"; it has to be a port,
or the second one becomes a special case.

```go
// domain — a driving port: something that brings turns in.
type Ingress interface {
    // Serve runs until ctx is done. It calls the handler once per inbound turn.
    Serve(ctx context.Context, h TurnHandler) error
}

type TurnHandler func(ctx context.Context, t Turn, sink Sink) error
```

`httpsse` implements `Ingress`. So does Telegram. The loop is reached identically by both and
knows about neither.

**"Módulo adicional, não instalação nativa" is read as: the core binary contains no Telegram
code and no Telegram dependency.** picoclaw compiles every channel in — Telegram, Discord,
Slack — and we use one; that is precisely the "installed natively" shape being rejected. So:

```
crab-ganglion-harness/
├── go.mod                    # the core: HTTP/SSE only
└── ingress/telegram/
    └── go.mod                # its OWN module — separate binary, separate deps
```

The Telegram binary is a **client of the harness's own HTTP/SSE API**. It is deployable beside
a container or centrally, carries its own token handling, and cannot bloat the core image
(AC-3) or its cold start (AC-1).

**DEC-5 — this layout is an interpretation, and it is cheap to reverse.** If deployment wants
Telegram *inside* the per-user container instead — picoclaw's model, one bot token per user
written by `internal/docker/provision.go` the way `channel_list` is today — then it becomes a
second `Ingress` adapter compiled into the core, and the provisioner grows a token sink. The
port is what makes that a swap rather than a redesign. **Open as DQ-5**; nothing in v1 depends
on the answer, because v1 ships `httpsse` alone.

---

## 3. Fractal: the tool subsystem repeats the pattern

`ToolExecutor` is one port with one adapter (`tool/registry.go`). Inside it, the same shape
again:

```go
// adapter/tool
type Tool interface {
    Name() string
    Schema() domain.ToolSchema
    Invoke(ctx context.Context, args json.RawMessage) (domain.Result, error)
}
```

`registry.go` satisfies `domain.ToolExecutor` by dispatching to one `Tool` per name; `exec/` is
the first and only `Tool` in v1. Adding `web_fetch` (DF-6) is a new file implementing `Tool` and
one registration line — it is not a change to the loop, the port, or the registry.

That nesting is what AR-3 means. **A wrapper that introduces no port is a layer, and review
rejects it.** The provider subsystem repeats the pattern for vendor differences; nothing else
in v1 has more than one implementation, so nothing else nests.

---

## 4. One turn, end to end

```
POST /v1/chat/completions  (httpsse)
  │
  ├─ Telemetry.Span("turn")
  ├─ TranscriptStore.Append(user message)        ← durable BEFORE any model call
  ├─ ContextStore.Load  → Window
  │
  └─ runtime.Loop, iteration i < maxIterations:
       ├─ Provider.Complete(Window + tools)  → Stream
       ├─ for Delta := range Stream:
       │     ├─ content  → sink.Content(delta)   → SSE chunk        (FR-2)
       │     └─ thought  → sink.Progress{thought}                    (FR-4)
       ├─ Telemetry.Usage(Stream.Usage())                            (FR-8)
       ├─ TranscriptStore.Append(assistant message)
       │
       ├─ if no tool calls → DONE
       └─ for each ToolCall:
            ├─ sink.Progress{Kind:"tool", Tool:name}
            ├─ Approver.Request(...)  ─── if gated ──▶ §5
            ├─ ToolExecutor.Invoke(...)  (or the denial Result)
            └─ TranscriptStore.Append(tool result)
       └─ runtime.compact(Window) if over budget → ContextStore.Save
```

**The turn ends when the handler returns.** No grace window, no typing heuristic, no
cancellation dance — the 500ms race in `internal/pico/turn.go` has no analogue here because
there is no out-of-band signal to interpret.

**The transcript is written before the model is called and after every step.** A crash mid-turn
loses the answer, never the question.

---

## 5. Approval — the flow that justified the build

```
runtime                    Approver(adapter)         crab-shell-proxy
   │                            │                          │
   ├─ ActionRequest ───────────▶│                          │
   │  {tool, args, sessionKey}  ├─ POST /alpha/v1/approvals▶│
   │                            │                          ├─ resolve member (mycelium)
   │  sink.Progress{placeholder}│                          ├─ ask / apply policy
   │  every 10s while waiting ◀─┤◀──── Decision ───────────┤
   │                            │                          │
   ├─ allowed → ToolExecutor.Invoke
   └─ denied  → Result{denied, reason} fed back to the loop
```

Four decisions, each with its reason:

**DEC-1 — The harness never decides who may approve.** It asks; the proxy resolves identity,
because the proxy is where mycelium's unforgeable account id already lands. The harness has no
information the proxy lacks and no way to obtain it — the same argument that made
`GATEWAY_ALLOW_ALL_USERS` correct for Hermes and would make an in-harness policy engine wrong
here.

**DEC-2 — A denial is a `Result`, not an error.** The agent is told "that was refused, because
X" and can react — pick another approach, or explain. A denial that aborts the turn throws away
the work already done and teaches the agent nothing.

**DEC-3 — Waiting emits progress every 10s.** This is not cosmetic. A blocked approval is
exactly the silent-stream failure `turn-stream-continuity` documents, and an approval can
legitimately take minutes. Interval matches that spec's FR-3 for the same reason: the tightest
plausible hop, not the gateway's 60s.

**DEC-4 — Timeout denies, and the timeout is well under the turn timeout.** Fail closed. A
timed-out approval is a denial with reason `"no answer"`, so DEC-2's path handles it and the
turn still completes with an explanation instead of hanging until the turn budget dies.

*Which actions are gated is configuration, not code* — the `Approver` adapter is asked for every
tool call and answers `allow` immediately for anything the policy does not gate, so v1 can ship
with an empty gate list and the path still exercised.

---

## 6. Proxy integration

The seam is dormant and live; this is where it wakes.

| Change | File | Shape |
|---|---|---|
| `HarnessGanglion = "ganglion"` | `internal/config/config.go:45` | new const |
| Accept it in validation | `internal/config/config.go:445` | new `case` in a switch with one today |
| Select the runner | `internal/httpapi/handlers.go` | see below |
| Container profile | `internal/docker/manager.go` | image/port/mount/user/health from a profile |
| Provisioner | `internal/docker/provision.go` | own template set; generic `dotenv` sink for keys |
| Approvals endpoint | `internal/httpapi` | new route, DEC-1 |
| `DisabledAgents` | `internal/config` | restore (FR-18) |

`Server` carries `Pico Turner` today. **Do not rename it and do not build a registry** — add a
second field and one resolver:

```go
type Server struct {
    Pico     Turner  // unchanged
    Ganglion Turner  // new
}

func (s *Server) turnerFor(a config.Agent) Turner {
    if a.Harness == config.HarnessGanglion {
        return s.Ganglion
    }
    return s.Pico
}
```

Two harnesses do not justify a map; the third one is when that changes. `internal/pico` is not
touched (D-3).

---

## 7. Deferred features answer 501 at one place

Each DF-* item is refused by the **proxy**, not by the harness, in the handler that would have
served it, keyed on `agent.Harness`. The Hermes work did exactly this and the reason holds: a
feature that stores a setting the harness never reads is worse than one that refuses — the
member is told it worked.

A single helper keeps the refusals uniform and greppable:

```go
func requireHarness(a config.Agent, kinds ...string) error // → 501, naming the harness
```

---

## 8. Build and delivery

- **Static binary, `CGO_ENABLED=0`, distroless or scratch base.** AC-1 (<10s cold start) and
  AC-3 (<150MB) both fall out of this; the Hermes failures they answer were s6 + Chromium + 71
  bundled skills, none of which exist here.
- **No supervisor, no `--init`.** One process, PID 1, signal handling in `main`.
- **Non-root, uid 1000**, matching what the proxy already chowns per-user volumes to.
- **Immutable tag (FR-19).** `ghcr.io/lepistabioinformatics/crab-ganglion:<commit-sha>`, and
  `CRAB_GANGLION_IMAGE` names that sha. Never a moving tag — the three weeks of a wrong picoclaw
  binary on `srv1519807` is the whole argument, and it cost nothing to avoid at the start.

---

## 9. Testing

The port split is what makes this testable without Docker, and that is most of its value:

- **`domain`** — pure; table tests, no fakes needed.
- **`runtime`** — the loop against five in-memory fakes. Every interesting case is reachable
  here: tool call, denial, timeout-denial, compaction boundary, iteration cap, provider error
  mid-stream. **This is where the coverage lives.**
- **`adapter/*`** — thin by construction; each tested against its real protocol, none against
  the loop.
- **Golden SSE test** — the one integration test that matters, pinning FR-3 byte-compatibility
  against recorded proxy output. This does not exist for picoclaw either (spec OQ-2), so it is
  new work, and it is the only thing standing between a harness swap and a silent regression in
  the webapp.

---

## Open questions for the tasks phase

- **DQ-1** — `Window` rebuild policy: summarize-and-drop, or drop-oldest with a running summary?
  The measured picoclaw behaviour (102 kept of 465, one merged summary) is a data point, not a
  target. Affects `runtime/compact.go` only — the port split means getting it wrong is
  recoverable.
- **DQ-2** — Does the approvals endpoint (DEC-1) need to survive a proxy restart mid-wait, or is
  a denial-on-timeout acceptable for v1? DEC-4 says the latter; worth confirming before it is
  built.
- **DQ-3** — Module location: third git submodule under `crab/` like both siblings, or a
  directory in this repo (spec OQ-4). Submodule matches the pattern and adds a pointer to the
  chain.
- **DQ-4** — Does `turn.Request` need a field for the approval correlation id, or does
  `SessionID` + tool call id suffice? Adding a field to the shared struct is seam surgery and
  should be avoided if the existing pair is enough.
- **DQ-5** — Telegram placement (DEC-5): separate binary consuming the harness API, or a second
  `Ingress` compiled in with a per-user bot token provisioned the way picoclaw's `channel_list`
  is? The first is what v1 assumes; the second matches picoclaw and needs a proxy-side token
  sink. v1 ships neither, so this can be answered late.
