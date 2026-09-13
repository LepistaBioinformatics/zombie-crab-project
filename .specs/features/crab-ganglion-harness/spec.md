# crab-ganglion-harness — Spec

**Status:** Specified; the proxy side and the harness core are implemented.
See "Implementation status" below.
**Date:** 2026-09-09.
**Spans:** a new module `crab/crab-ganglion-harness` + integration in `crab-shell-proxy`.
**Feasibility record:** `zombie-crab-project-mkt/.specs/features/own-go-harness/investigation.md`
(pt-BR, in the parent monorepo). **Read its §2.5 for why this is being built** — this spec does
not re-argue the case, it states what must be true.

## Problem

The stack's agent runtime is picoclaw, a third party. Five reasons to replace it were audited
in the investigation and three did not survive: the WebSocket→SSE translation is not what
degrades the experience, connection cuts are a four-hop problem that lives elsewhere
(`turn-stream-continuity`), and the context loss was an upstream bug already fixed — delivered
late only because a mutable image tag was never re-pulled.

What survived is narrower and harder: **two capabilities have no extension point at all.**

- **Approval flows.** Tool execution today is picoclaw's static path guard — binary, defined
  upstream, with no notion of who the member is. Suspending a turn to ask an approver and
  resuming lives in `pkg/agent`, which the out-of-tree channel API does not reach.
- **Token accounting.** Declared permanently unobtainable by this stack's own dashboard:
  *"picoclaw writes no token counts to disk … It is not coming later."* No per-tenant billing,
  quota, budget alert or cost attribution is possible while that holds.

Both are design decisions of the agent loop. Owning the loop is the only way to have them.

## Decisions already taken

| # | Decision | Where it was made |
|---|---|---|
| D-1 | Name: `crab-ganglion-harness`; harness kind `ganglion`; image `crab-ganglion` | investigation §8.1 |
| D-2 | **Rewrite**, using picoclaw as a design reference — not a fork, not a vendored copy | investigation OQ-2 |
| D-3 | **Alternative to picoclaw, not a replacement.** picoclaw stays the default while this stabilizes | user, 2026-09-09 |
| D-4 | Hexagonal, modular, fractal — modelled on `harness-sphere`'s crate split | user, 2026-09-09 |
| D-5 | First target is a **new `agents:` entry**, not a flip of an existing one; **same model** (`deepseek-chat`) | user, 2026-09-09 |

**D-5 in full, because it is easy to get wrong.** The deployed config declares exactly **one**
proxy agent — `zcrab` (`deploy/dokploy/crab-shell-proxy.config.yaml`), which is why the remote
containers are named `crabshell-zcrab-*`. Setting `harness: ganglion` on `zcrab` would not be
coexistence; it would be a cutover of the only agent in production, against D-3. So the first
target is a **second entry** — same `model.provider`/`model.name` (`deepseek`/`deepseek-chat`)
and same template, differing only in `harness` — so that a comparison between the two isolates
the harness as the variable.

*Not decided here, and deliberately:* **who is routed to that entry.** `serviceName` matches the
`x-mycelium-service-name` mycelium injects, so the audience is mycelium routing configuration at
deploy time, not a requirement of this spec. It becomes a real decision only at EX-1, where the
exit criterion needs actual traffic to mean anything.

D-2 is the reason D-4 is a requirement and not a preference: approval and token accounting are
the two things that justified the rewrite, and they are only *design* rather than *surgery* if
the ports exist to hang them on.

---

## Architecture requirements

**AR-1 — The domain package imports nothing outside the standard library.**
This is the enforceable form of "hexagonal", and it is checkable in review in a way the word
is not. The precedent is in-house: `harnesssphere-domain` is *"canonical model, ports and pure
policies"* and depends on exactly `async-trait` + `thiserror`. The Go equivalent is a domain
package holding entities, port interfaces and pure policy — no HTTP, no SQL, no Docker, no
provider SDK, no OTel.

**AR-2 — Five ports, named here so adapters cannot be invented ad hoc.**

| Port | Driven side | First adapter |
|---|---|---|
| `Provider` | out | OpenAI-compatible HTTP, streaming |
| `SessionStore` | out | append-only JSONL on the mounted volume |
| `ToolExecutor` | out | in-container process execution |
| `Approver` | out | callback to `crab-shell-proxy` (FR-7) |
| `Telemetry` | out | OTLP |

The driving side is the HTTP/SSE server, which is an adapter like any other: it depends on the
domain, never the reverse.

**AR-3 — Fractal: a subsystem with more than one implementation repeats AR-1/AR-2 internally.**
The tool subsystem defines a `Tool` port with one adapter per tool; the provider subsystem
defines the vendor differences behind `Provider`. "Fractal" means this nesting, not additional
layers — a wrapper that adds no port is a layer to reject in review.

**AR-4 — No dependency may cross from an adapter into another adapter.**
Adapters know the domain and nothing else about each other. This is what keeps a second
provider, a second store, or a second approval channel from becoming a refactor.

---

## Functional requirements — the harness

### Turn surface

**FR-1 — HTTP with SSE natively; one turn per request.**
No protocol translation, no WebSocket, no sidecar. The turn ends when the handler returns —
this is what retires `internal/pico`'s `graceWindow = 500ms`, a heuristic
`picoclaw-as-library` §5 calls *"tuned rather than solved"*.

**FR-2 — Content is streamed as the provider emits it, at FRAME granularity.**

*Narrowed on 2026-09-13, from token-level to frame-level, by the owner's decision in
`crab-ganglion-harness` PR #15.* Restoring visible thinking steps requires the harness to
know whether an iteration's text is narration (the frame ends in `tool_calls`) or the
answer — and that is not knowable before the stream ends: `domain.Delta` carries content
and reasoning only, `Stream.Message` is valid only after EOF, and "no call yet" is not
evidence. The proxy measured **7 of 112 turns** delivering a whole reply in the same frame
that carried a trailing call.

So a frame is buffered and classified once. Narration leaves the content run entirely and
arrives as progress; the answer arrives in one emission. The alternative — emit
optimistically and regroup on reload — is the reply visibly rewriting itself, which is the
failure the one-message-per-turn shape was bought to avoid.

**This is a real cost and it lands hardest on the simple turn**, which has no tools and
therefore no steps to fill the silence: its reply now arrives whole rather than word by
word. Recorded here rather than in a commit message because a later reader comparing this
product to a token-streaming one will otherwise think it regressed by accident.

*The original rationale carried an untested assumption, kept below so nobody reads it as
verified:*
`picoclaw-incremental-streaming/investigation.md` §3(a)–(c) has **not been run**, and it might
show that picoclaw's one-frame behaviour was a config key all along. That would make streaming
available without this harness. It does not undo D-2 — FR-7 and FR-8 carry the decision and
neither depends on streaming — but FR-2 must not be cited as a reason this was necessary.

**FR-3 — The wire format is byte-compatible with what the proxy serves today.**
The webapp and mycelium sit in front; any drift is a user-visible regression. The proxy already
consumes deltas correctly (`internal/pico/turn.go:179` does cumulative-content bookkeeping per
`MessageID` and emits only the new suffix), so a delta-emitting harness needs no webapp change.
Verification is OQ-2 — no golden-response test exists today.

**FR-4 — Progress signals map to the existing `turn.Progress` contract**
(`Kind` ∈ `thought | tool | placeholder | typing`), from typed in-process calls rather than
sniffed from a string.

### The loop

**FR-5 — Multi-iteration tool calling**, bounded by an explicit iteration cap that is reported
when hit. picoclaw's equivalent ended a turn with no answer at all and recorded it only in a
summary; a turn that stops because it hit the cap must say so.

**FR-6 — Sessions are disk-backed and survive container restart**, in the mounted per-user
volume. Not in memory, not in a store that resets.

**FR-7 — Approval flow: the loop can suspend mid-turn, ask, and resume.**
The `Approver` port takes a proposed action and returns allow/deny before the `ToolExecutor`
runs. The first adapter calls back to `crab-shell-proxy`, which owns member identity — the
harness never resolves who may approve, it only asks. A denied action returns to the loop as a
result the agent can react to, not as a turn failure. **This is one of the two capabilities
that justified the build.**

**FR-8 — Token accounting is emitted per turn.**
Prompt, completion and total, read from the provider's `usage` field, attributed to the turn
and available to `Telemetry`. **The second capability that justified the build.**

**FR-9 — Compacting the context window never truncates the served transcript.**
Two artifacts, not one contested file: the transcript is append-only and complete; the context
window is derived. This is stated as an invariant because the live evidence is on record —
`workspace-chat-ux/sk_v1_c2cff018…` held **102** entries in picoclaw's live file against **465**
unique in the proxy's `durable/` fold-forward, a 363-entry gap caused by compaction rewriting
the file. Satisfying FR-9 is what retires `internal/history`'s fold-forward (738 LOC).

**FR-10 — Native OTLP telemetry.**
Spans for the turn, the provider call, and each tool call; token counts from FR-8 as metrics.
This is what replaces reading session JSONL from disk on a 60s timer — `harness-sphere` keeps
its multi-tenant discovery and learning metrics, and loses the archaeology.

**FR-11 — Persona and system prompt** are read from the mounted volume, cascading the same way
the proxy already materializes them.

**FR-12 — `GET /health`** for the proxy's existing `HealthChecker`.

---

## Functional requirements — proxy integration

The seam is dormant but live; the Hermes work paid for it. These are the places it wakes up.

**FR-13 — `HarnessGanglion = "ganglion"`** alongside `HarnessPicoclaw`, and a `case` in the
validation switch at `internal/config/config.go:445` — which today accepts exactly one value.

**FR-14 — A second `Turner`** (`internal/httpapi/handlers.go:236`), selected by harness kind.
`internal/pico` stays live and untouched throughout (D-3).

**FR-15 — A container profile** supplying image, port, mount destination, user and health path,
instead of the `Picoclaw*` constants.

**FR-16 — A provisioner** writing this harness's own config; the generic `dotenv`/`json`/`file`
secret sinks already cover provider keys, so picoclaw's `native` `.security.yml` sink is simply
unused.

**FR-17 — `turn.Request.SessionID`, `SessionKey` and `Model` are read.**
All three are populated and unread today, kept after the Hermes removal because they describe
the turn rather than the runner. This harness uses them.

**FR-18 — Restore `DisabledAgents`.**
An agent whose token or provider key is unset removes itself from `cfg.Agents` at `Load` rather
than failing the whole proxy. Both append sites lived inside `Harness == HarnessHermes` branches
and died with that removal; `multi-harness-support/implementation-notes.md` §10 recommends
bringing it back, and a second harness is when it starts mattering again.

**FR-19 — The image is referenced by an immutable tag or digest.**
Not a moving tag. This is a requirement and not a note because the failure already happened:
the Dokploy host ran the wrong picoclaw binary for **three weeks** — `0.3.1-glob` republished
2026-09-06 and never re-pulled, because the harness image is not a compose service and
`EnsureImage` only pulls what is absent. Nothing logged, nothing drifted, nothing failed. A
harness of our own under a moving tag reproduces that exactly. See OQ-8 of the investigation;
fixing the general case is separate work and is **not** blocked by this spec.

---

## Acceptance criteria

Derived from the four reasons the Hermes harness was withdrawn — the only precedent of an
alternative harness in this deployment, and therefore the bar.

| # | Criterion | Which Hermes failure it answers |
|---|---|---|
| AC-1 | Cold start (create → health OK) **< 10s**, inside the global 35s `startupDeadline`, with no per-agent override | 180s vs 35s |
| AC-2 | First content byte on the SSE **< 5s** on a typical turn | turn latency near the 60s `gatewayTimeout` |
| AC-3 | Final image **< 150 MB** | heavyweight per-user image |
| AC-4 | A named exit criterion, met or explicitly extended (see Coexistence) | a second branch no deployment exercised |

**AC-2 is not the whole of the latency problem, and this spec does not claim it is.** Keeping
the stream from ever going idle is `turn-stream-continuity` Group A, needed whichever harness
runs. What FR-2 does is shorten the silence at the source rather than fill it with pings.

**AC-2 is measured differently since FR-2 was narrowed.** "First content byte" on a turn that
uses tools is now the first narration step, which arrives as progress and is what the member
actually reads while the work runs. On a turn with no tools there is no earlier byte than the
answer itself, so AC-2 there measures the whole completion. The 5s target is kept and the
change in what it measures is stated rather than left for someone to discover in a graph.

---

## Deferred — answered `501`, not silently missing

The Hermes work established the pattern: a feature that a harness cannot serve answers `501`
rather than blocking the launch or, worse, storing a setting that changes nothing. Each of these
gets a requirement ID so the gap is tracked.

| # | Deferred | Why it is safe to defer |
|---|---|---|
| DF-1 | MCP client | no agent in the first target needs it |
| DF-2 | Memory graph writes | proxy-side `memgraph` is unaffected; the agent simply does not write |
| DF-3 | Projects (`agents.list` + dispatch) | picoclaw `config.json` constructs; Hermes answered `501` here too |
| DF-4 | Personal model overrides | same |
| DF-5 | Scheduled tasks / cron sessions | proxy-side; no harness surface in v1 |
| DF-6 | Built-in `web_search` / `web_fetch` | first target is tool-light; adding a tool is one `Tool` adapter (AR-3) |

### NOT a gap: persona

Reported in use — *"quando entro na area de admin do gamma não vejo a aba de config, só no
picoclaw"*. Two of the three withheld admin sections were withheld correctly; the third
was a regression this feature introduced and nobody noticed.

| Section | Withheld from a ganglion agent? | Why |
|---|---|---|
| `config` | **correctly** | `config.json` is picoclaw's file. `provisionGanglion` writes no config at all — the harness reads its whole configuration from the environment — so a key edited here would mean nothing to it. |
| `model` | **correctly** | the registry materializes into `.security.yml` and `config.json`, and the proxy REFUSES an assignment for any other harness (`rejectNonPicoclawAgent`), naming the reason. A form here would post a write the proxy 400s. |
| `persona` | **wrongly** | fixed |

The webapp's `PICOCLAW_ONLY` list justified hiding persona with *"the identity files are
picoclaw's workspace layout, delivered on the picoclaw create path"*. That was true when
it was written and stopped being true when `createGanglion` grew `personaBindStrings`:
a ganglion container mounts `AGENT.md`, `SOUL.md` and `HEARTBEAT.md` read-only over its
workspace, and `GANGLION_SYSTEM_FILE` points the harness at `AGENT.md`, re-read every
turn. The proxy's persona routes were never harness-gated either — `picoclawOnly` lists
projects, personal models and the memory graph, never persona.

So the **one screen that edits a ganglion agent's identity was unreachable**, for agents
whose identity this feature had wired the cascade up to deliver. The gate was a webapp
list that nothing kept in agreement with the create path it described.

Removing persona from `PICOCLAW_ONLY` surfaced a second dependency: the legacy all-agents
entry had been losing persona for free through that list, and its reason is different —
the proxy refuses an agent-less persona write, which is about the ADDRESS, not the
harness. It is now excluded where that argument actually applies. Caught by
`agent-scope.test.ts`, not by review.

**A deferred feature must answer `501` with the harness named.** Storing a setting that has no
effect is the failure mode this table exists to prevent.

---

## Out of scope — permanently

Container lifecycle, scale-to-zero, volume provisioning and chown, secrets materialization,
mycelium identity and authz, the model registry, the admin API (`/alpha/v1/admin/...`),
memgraph, projects, cron and the MCP server stay in `crab-shell-proxy`. These are done *to* a
container; a harness inside one has no business starting, stopping or provisioning anything,
including itself. Measured and argued in `picoclaw-as-library/investigation.md` §4 and it
applies here unchanged.

---

## Coexistence and exit

D-3 is right and is also how the Hermes harness died — *"a second branch no deployment
exercised"*. What separates a healthy coexistence from a dead branch is a criterion written
before, not after.

- **EX-1** — The D-5 agent entry runs on `ganglion` in production and carries real member
  traffic. Who that is, is the routing decision D-5 leaves open — but "nobody" does not satisfy
  EX-1.
- **EX-2** — It carries that traffic for a stated period with AC-1..AC-3 holding.
- **EX-3** — FR-7 and FR-8 are exercised by that agent, not merely implemented. They are the
  reasons this exists; an exit that has not used them proves nothing.
- **EX-4** — Then, and only then, a decision to make `ganglion` the default, or to extend the
  period with a stated reason, or to withdraw it the way Hermes was withdrawn — with a
  `DECISION.md`.

`internal/pico` is deleted only after EX-4 chooses "default", never before.

---

## Open questions

- **OQ-1 — RESOLVED (2026-09-09), see D-5.** A new `agents:` entry beside `zcrab`, same model,
  `harness: ganglion`. Its audience stays a deploy-time routing decision.
- **OQ-2 — How is FR-3's byte-compatibility verified?** A golden-response test against the
  current proxy is the obvious answer and does not exist today. Inherited from
  `picoclaw-as-library` OQ-2, still unanswered.
- **OQ-3 — What does the `Approver` port's first adapter speak?** FR-7 says it calls back to the
  proxy; the shape of that call, and what happens when the approver never answers, is design.
- **OQ-4 — Where does the module live** — a third git submodule under `crab/`, like its two
  siblings, or a directory in this repo? The two siblings are submodules, which argues for one;
  a submodule is also a third pointer in the chain to move.
- **OQ-5 — Does `picoclaw-incremental-streaming` §3(a)–(c) change FR-2's rationale?** Cheap,
  unrun, and it should be run regardless of this spec.

---

## Implementation status (2026-09-10)

`crab-ganglion-harness` at `2fd0348`; `crab-shell-proxy` on `feat/ganglion-harness`.

| Requirement | State |
|---|---|
| FR-1, FR-2, FR-4, FR-5, FR-6, FR-9, FR-12 | **done** in the harness, with tests |
| FR-7 approval | **harness side done** (port, loop suspension, heartbeat, fail-closed timeout). The proxy endpoint it calls is **not built** — OQ-3 is still open, and v1 ships an empty gate list so the path runs allow-all |
| FR-8 token accounting | **accumulated and delivered to the port**; the OTLP adapter is a no-op, so nothing leaves the process yet |
| FR-10 OTLP | **not done** |
| FR-3 byte-compatibility | plausible, **unverified** — the golden test of OQ-2 does not exist |
| FR-11 persona | `GANGLION_SYSTEM_FILE` points at the cascade's `AGENT.md`; read per turn |
| FR-13..FR-17 | **done** — harness kind, second `Turner`, container profile, provisioning, both session headers |
| FR-18 `DisabledAgents` | **done** — ganglion only; picoclaw deliberately exempt |
| FR-19 immutable tag | **enforced by absence of a default**: a ganglion agent with no `ganglionImage` fails the load |
| DF-1..DF-6 | projects and personal models answer **501**; cron and the memory graph are declared in the gate but their handlers are **not yet wired to it** |
| AC-1, AC-3 | plausible — the binary is 9.6 MB static, no supervisor. **Not measured against a real cold start** |
| AC-2, AC-4 | not measured; EX-1..EX-4 not started |

**The harness has never spoken to a real provider.** Every provider test is against
`httptest` with a recorded stream.

## Traceability

| Requirement | Source | Verified? |
|---|---|---|
| FR-1, FR-4 | investigation §2.1, §3.1 | Yes — `turn.Sink` is a delta contract today |
| FR-2 | investigation §2.1 | **Rationale rests on an unrun test** — OQ-5 |
| FR-3 | `internal/pico/turn.go:179` | Yes for the consumer; OQ-2 for the format |
| FR-7, FR-8 | investigation §2.5 A1, A2 | Yes — A2 quoted from the stack's own dashboard |
| FR-9 | investigation §3.3 | Yes — measured, 102 vs 465 |
| FR-10 | investigation §2.5 A3, B | Yes — `harness-sphere` is 4,503 LOC of external observation |
| FR-13..FR-17 | investigation §5 | Yes — every symbol read in the current tree |
| FR-18 | `multi-harness-support/implementation-notes.md` §10 | Yes |
| FR-19 | investigation §2.3 field evidence | Yes — confirmed on `srv1519807` |
| AC-1..AC-4 | `hermes-removal/DECISION.md`, `implementation-notes.md` §4, §9 | Yes |
| AR-1..AR-4 | `harness-sphere` crate split | Yes — `harnesssphere-domain` deps read |
