# picoclaw-as-library Specification

> **⚠️ NOT APPROVED — parked at the user's request (2026-08-12).**
>
> This is a **holding record**, not a plan to execute. It exists so the findings survive and a
> future session starts from evidence instead of re-deriving it. Nothing here is scheduled, and
> the feasibility work stops at the investigation.
>
> **Read `investigation.md` first** — it carries the evidence; this file carries only the
> requirements that evidence implies, plus what is still unknown.

**Status:** Parked (pre-approval). Investigation complete, no design, no tasks, no code.
**Blocked on:** BQ-1 below — a goal question only the user can answer.
**picoclaw analysed:** `v0.3.1` (MIT), the tag `deploy/picoclaw-glob/Dockerfile` pins.

---

## Problem Statement

Reaching picoclaw requires `crab-shell-proxy/internal/pico` (404 LOC) to translate the
OpenAI-compatible REST surface into the Pico Protocol over WebSocket. The request was to
implement that REST layer **by extending picoclaw** — consuming picoclaw as a Go library so
zombie-crab carries only extension code.

The investigation found the extension mechanism is real, but the premise about scope is not: the
translation layer is 1.7% of the proxy, and the remainder cannot move.

---

## Verdict, in one line per part

| Part | Answer | Evidence |
|---|---|---|
| Can a REST layer be built as a picoclaw extension? | **Yes** — public, tested out-of-tree channel API | `investigation.md` §2 |
| Would zombie-crab then hold *only* extension code? | **No** | §0, §4, §6.1 |
| Does it reduce code? | **No — 2–4× more** | §8 |
| Is there a real reason to do it anyway? | **Yes — the turn boundary stops being a 500 ms guess** | §5 |

**Topology decided:** **A — in-container extension.** The extended binary replaces the stock
picoclaw image per user; the proxy keeps all orchestration. **B (embedding picoclaw in the proxy
process) is rejected** — it is the shared-process model `crab-shell-proxy/README.md` rejects, and
would reverse the project's stated isolation posture. See §1.

---

## Requirements

Written as what an implementation *would* have to satisfy. **None are committed.**

### Functional

- **R-1** The extended binary MUST register its channel through picoclaw's public out-of-tree API
  (`config.RegisterChannelSettings` + `channels.RegisterFactory`) from `init()`, with no edits to
  picoclaw source. *(Feasibility established: §2.1–2.2.)*
- **R-2** The channel MUST expose its HTTP routes via `channels.WebhookHandler`, mounted on the
  gateway's existing server — no second listener, no extra published port. *(§2.3.)*
- **R-3** The OpenAI-compatible surface (`POST /v1/chat/completions` streaming and not,
  `GET /v1/models`, `GET /v1/sessions/history`) MUST stay **byte-compatible** with what the proxy
  serves today. The webapp and mycelium sit in front of it; any drift is a user-visible
  regression. *(See OQ-2.)*
- **R-4** Streaming MUST use `StreamingCapable.BeginStream` → `bus.Streamer`, and MUST derive
  end-of-turn from `Finalize` — **not** from a timing heuristic. This is the point of the exercise.
  *(§5.)*
- **R-5** Progress signals (thoughts, tool calls, typing) and attachments MUST keep reaching the
  client, mapped from the in-process calls rather than sniffed from a `kind` string. The existing
  `turn.Progress` / `turn.Attachment` contract defines what clients already consume.
- **R-6** The proxy MUST reach the new binary through a second implementation of
  `httpapi.Turner` (`handlers.go:231`), behind `Agent.harness`, coexisting with `internal/pico`.
  `internal/pico` is deleted **only after** a live comparison on a real agent. *(§7.)*

### Constraints inherited from picoclaw — not negotiable by this work

- **R-7** Concurrency is capped by `agents.defaults.max_parallel_turns`, **default 1**
  (`pkg/agent/agent_init.go:61-75`). The deployment MUST set this explicitly; leaving the default
  serialises every conversation of an agent. *(§3.1.)*
- **R-8** Turns serialize **per session key**; a second request for a conversation already
  mid-turn is folded into it as a *steering message*, not answered as an independent completion
  (`pkg/agent/agent.go:180-245`). The REST surface MUST reject, queue, or explicitly document this
  — it cannot answer both. *(§3.1.)*
- **R-9** picoclaw sessions remain **in-memory and reset on restart**. `internal/history`'s
  proxy-side `durable/<sessionKey>.jsonl` fold-forward MUST stay. Moving REST inside does not fix
  persistence. *(§6.2.)*

### Out of scope — permanently, not "later"

- **R-10** Container lifecycle, scale-to-zero, volume provisioning, secrets, skills, mycelium
  identity/authz, the model registry, the admin API (`/alpha/v1/admin/...`), memgraph, projects,
  cron and the MCP server stay in `crab-shell-proxy`. There is no picoclaw seam for them because
  picoclaw is the thing being orchestrated. *(§4.)*

### The two patches

- **R-11** `deploy/picoclaw-glob/`'s patches touch **unexported** functions
  (`routing.ruleMatchesView`, `agent.isVisionUnsupportedError`) — verified, no exported hook for
  either. They therefore cannot become extension code under any topology. Preferred handling:
  `go.mod` `replace` → thin fork (drift detection moves into Go tooling, instead of `git apply`
  failing inside a Docker layer), with upstream PRs attempted in parallel. *(§6.1.)*

---

## Blocking question

- **BQ-1 — What is the actual goal?** The request was framed as *"eu gostaria que no zombie crab
  tivéssemos somente o código de extensão"*. The investigation shows that outcome is unreachable,
  and that the work **adds** ~1,100–1,700 lines against 404 deleted. If the goal was less code to
  maintain, this does not deliver it and should be dropped. If the goal is the correct turn
  boundary and compile-time coupling to picoclaw, it delivers exactly that and the cost is known.
  **Nothing proceeds until this is answered.**

---

## Open questions (for a design phase that has not been authorised)

- **OQ-1** Does a mid-turn client disconnect cleanly reap the pending request without wedging the
  agent? `takePendingStop` (`pkg/agent/agent_stop.go`) is clearly the lever; it was not traced end
  to end.
- **OQ-2** How is R-3's byte-compatibility *verified*? A golden-response test against the current
  proxy is the obvious answer and does not exist today.
- **OQ-3** Does `/v1/sessions/history` move into the channel, or stay proxy-side reading the
  volume? R-9 argues it stays; a channel *can* read picoclaw's session store directly, which may
  be cleaner.
- **OQ-4** Is a PR to `sipeed/picoclaw` for the two patches in scope, or explicitly not?
- **OQ-5** Where does the extended binary live — a third submodule, or a directory under `crab/`?

---

## Traceability

| Requirement | Evidence in `investigation.md` | Verified? |
|---|---|---|
| R-1, R-2 | §2.1–2.3 | Yes — symbols read in v0.3.1 |
| R-3 | — | No — OQ-2 |
| R-4, R-5 | §2.5, §5 | Partly — `BeginStream` exists and pico uses it; the SSE mapping is a sketch |
| R-6 | §7 | Yes — `Turner` seam exists and is in use |
| R-7, R-8 | §3.1 | Yes — read in `pkg/agent` |
| R-9 | §6.2 | Yes |
| R-10 | §0, §4 | Yes — measured |
| R-11 | §6.1 | Yes — absence of hooks confirmed |
