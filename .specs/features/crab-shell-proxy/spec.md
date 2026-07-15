# crab-shell-proxy Specification

## Problem Statement

Today the stack runs a **fixed** set of picoclaw instances (alpha, beta), each a *shared*
container with a Node sidecar (`picoclaw-openai-proxy`) doing OpenAI↔Pico-WS translation, and
isolation faked in-proxy via `sha256(email::session_id)`. We want the model from
`zero-scale-stateless-hermes-agent.md`: **one picoclaw container per user**, spun up on demand
and torn down when idle (scale-to-zero) — but adapted to picoclaw, driven by this project's
**mycelium profile** identity (not the reference's naive `X-User-Id`), and with a **continuous
mode** for users who also reach their agent through picoclaw's native Telegram / MS Teams
channels (which need the container alive to receive messages).

The orchestrator that manages Docker container lifecycle and speaks Pico Protocol is a new
**Go** service, `crab-shell-proxy`, living in its own private submodule.

## Goals

- [ ] A single Go service (`crab-shell-proxy`) behind mycelium that, per request, resolves the
      `(agent, user)` and ensures a dedicated `picoclaw-<agent>-<userhash>` container is running,
      then proxies the OpenAI-compatible call to it — cold-starting the container if needed.
- [ ] Two configurable lifecycle modes per instance: **scale-to-zero** (idle-timeout stop) and
      **continuous** (never auto-stop).
- [ ] Identity derived from the mycelium `x-mycelium-profile` header (principal owner email),
      with a clean seam for the parallel Go mycelium SDK and a self-contained fallback decoder.
- [ ] Behavior parity with `picoclaw-openai-proxy/server.js`: OpenAI `/v1/chat/completions`
      (streaming + non-streaming), `/v1/models`, `/v1/sessions/history`, `/healthz`.
- [ ] Container-level per-user isolation (own data volume per `(agent, user)`).

## Out of Scope

| Feature | Reason |
| --- | --- |
| Connector (Telegram/Teams) ingress routing through the proxy | CTX-01: those are picoclaw's own outbound channels; they never touch the proxy |
| Building the Go mycelium SDK | User is building it in parallel; this feature defines the seam + ships a fallback decoder (CTX-04) |
| Creating the private `crab-shell-proxy` GitHub repo / wiring the submodule | Outward-facing; operator step, not done unilaterally (CTX / advisor note) |
| Kubernetes / non-Docker orchestration | Reference targets Docker; this stack is docker-compose |
| Migrating mycelium off standalone/SQLite | Unrelated; unchanged by this feature |
| Role-scoped access changes (M3 `protectedByRoles` chain) | Orthogonal; the proxy consumes whatever profile mycelium injects |

---

## User Stories

### P1: On-demand per-user agent container (scale-to-zero) ⭐ MVP

**User Story**: As a signed-in user calling the chat API, I want my own isolated picoclaw
container to be started automatically on my first request and reused on subsequent ones, so my
agent state is private to me without an operator pre-provisioning a container.

**Why P1**: This is the core vertical slice — without on-demand spin-up + proxying, there is no
feature. Everything else layers on top.

**Acceptance Criteria**:

1. WHEN a `/v1/chat/completions` request arrives with a valid `x-mycelium-profile` header for
   agent `A` and principal email `E` THEN the system SHALL derive a stable `userhash` from `E`
   and target container `picoclaw-<A>-<userhash>`.
2. WHEN that container does not exist or is stopped THEN the system SHALL create/start it
   (cold start) with the agent's config template and a per-user data volume mounted, and wait
   until picoclaw is health-ready before proxying.
3. WHEN the target container is running THEN the system SHALL open a Pico Protocol WebSocket to
   it, run the turn, and return an OpenAI-compatible response (non-streaming) or SSE stream
   (`stream: true`), matching `server.js` behavior.
4. WHEN the `x-mycelium-profile` header is absent or undecodable THEN the system SHALL respond
   `401` without starting any container.
5. WHEN two different principal emails call the same agent THEN the system SHALL route each to a
   distinct container + distinct data volume (no cross-user state).

**Independent Test**: With a mycelium profile header for `alice@x`, POST a chat completion to
`/picoclaw-alpha/v1/chat/completions`; observe `picoclaw-alpha-<hash(alice)>` come up via
`docker ps` and a real reply stream back. Repeat for `bob@x`; observe a second, separate
container.

---

### P1: Scale-to-zero idle teardown ⭐ MVP

**User Story**: As the operator, I want idle per-user containers to stop automatically after a
configurable period so the host doesn't accumulate RAM usage from abandoned sessions.

**Why P1**: Scale-to-zero is the defining property of the reference architecture and the reason
this isn't just "one static container per user forever."

**Acceptance Criteria**:

1. WHEN a request completes for a scale-to-zero instance THEN the system SHALL (re)start an
   inactivity timer of the configured duration for that container.
2. WHEN the inactivity timer for a container expires with no intervening request THEN the system
   SHALL `docker stop` that container (data volume preserved).
3. WHEN a new request arrives for a stopped container THEN the system SHALL cold-start it again
   (per P1 story 1) and the user's prior data SHALL still be present.
4. WHEN the proxy process restarts THEN it SHALL reconcile existing labeled containers (adopt
   running ones, re-arm timers) rather than orphaning them.

**Independent Test**: Set idle timeout to a short value, send one request, watch `docker ps`
show the container stop after the timeout; send another request and confirm the same volume's
history is intact.

---

### P2: Continuous (always-on) mode

**User Story**: As a user who also talks to my agent through Telegram / MS Teams, I want my
container to stay running continuously so those native channels keep receiving messages, so my
agent is reachable outside the API too.

**Why P2**: Needed for the connector use case, but the API path (P1) is demonstrable and
valuable on its own first.

**Acceptance Criteria**:

1. WHEN an instance is configured `mode = continuous` THEN the system SHALL NOT arm the idle
   timer for its containers.
2. WHEN a continuous-mode container is not running and a request (or startup reconcile) occurs
   THEN the system SHALL start it and leave it running.
3. WHEN the proxy starts up THEN it SHALL ensure all configured continuous-mode containers that
   should exist are started (so connectors work without a prior API call).
4. WHEN mode is `scale-to-zero` THEN behavior SHALL be exactly the P1 idle-teardown behavior.

**Independent Test**: Configure an agent/user as continuous, restart the proxy with no API
traffic, confirm the container is up and stays up past the scale-to-zero timeout.

---

### P2: OpenAI-compat surface parity (models + history)

**User Story**: As the existing chat-webapp, I want `/v1/models` and `/v1/sessions/history` to
work against the new proxy unchanged, so no client changes are needed.

**Why P2**: chat-webapp already depends on these; parity avoids client churn. Not P1 only
because a raw chat turn (P1) proves the core first.

**Acceptance Criteria**:

1. WHEN `GET /v1/models` is called THEN the system SHALL return the OpenAI-compatible model list
   (matching `server.js`).
2. WHEN `GET /v1/sessions/history?session_id=...` is called with a valid profile THEN the system
   SHALL return that conversation's message history from the correct user's container volume,
   using the same `.meta.json` scope-marker scan `server.js` uses.
3. WHEN `GET /healthz` is called THEN the system SHALL report its own liveness and (unauth'd) not
   require a profile header.

**Independent Test**: Point chat-webapp at the new route; sign in, chat, reload — history
renders; model picker lists the model.

---

### P3: Config-driven agent catalog

**User Story**: As the operator, I want to declare agents (alpha, beta, …), their picoclaw
config templates, and their lifecycle modes/timeouts in one config, so adding an agent doesn't
require code changes.

**Why P3**: The MVP can hardcode alpha/beta; a clean catalog is a quality-of-life improvement.

**Acceptance Criteria**:

1. WHEN the operator adds an agent entry (name, image, config template, mode, idle timeout) to
   config THEN the system SHALL route and orchestrate it without code changes.
2. WHEN an agent's mode/timeout is changed and the proxy is restarted THEN new lifecycle behavior
   SHALL apply on the next request.

---

## Edge Cases

- WHEN a cold start exceeds a startup deadline (picoclaw never becomes health-ready) THEN the
  system SHALL fail the request with a `502` and not leak a half-started container.
- WHEN two concurrent requests for the *same* `(agent, user)` arrive during a cold start THEN the
  system SHALL start the container exactly once (single-flight) and both requests SHALL proceed.
- WHEN `docker stop` races with an incoming request for the same container THEN the system SHALL
  serialize so the request either waits for a clean restart or is retried, never proxies to a
  container mid-stop.
- WHEN the Docker daemon is unreachable THEN the system SHALL return `502` with a clear message
  and never crash the proxy.
- WHEN the principal email contains characters invalid for a Docker name THEN the system SHALL
  sanitize/hash it into a valid, collision-resistant name.
- WHEN the per-user data volume/dir does not yet exist THEN the system SHALL create it before
  first container start.
- WHEN a request body has no `session_id` THEN the system SHALL respond `400` (as `server.js`
  does), since conversation isolation requires it.

---

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| CSP-01 | P1: On-demand spin-up | Design | Pending |
| CSP-02 | P1: Cold start + health wait | Design | Pending |
| CSP-03 | P1: Pico-WS turn + OpenAI response/SSE (server.js parity) | Design | Pending |
| CSP-04 | P1: Profile-derived identity + 401 on missing | Design | Pending |
| CSP-05 | P1: Per-user container + volume isolation | Design | Pending |
| CSP-06 | P1: Idle-timer arm/reset | Design | Pending |
| CSP-07 | P1: Idle-timeout docker stop, volume preserved | Design | Pending |
| CSP-08 | P1: Reconcile-on-restart (adopt/re-arm) | Design | Pending |
| CSP-09 | P2: Continuous mode (no idle timer) | Design | Pending |
| CSP-10 | P2: Startup ensure continuous containers running | Design | Pending |
| CSP-11 | P2: /v1/models parity | Design | Pending |
| CSP-12 | P2: /v1/sessions/history parity | Design | Pending |
| CSP-13 | P2: /healthz unauthenticated | Design | Pending |
| CSP-14 | P3: Config-driven agent catalog | Design | Pending |
| CSP-15 | Edge: single-flight cold start | Design | Pending |
| CSP-16 | Edge: stop/request race serialization | Design | Pending |
| CSP-17 | Edge: Docker-unreachable + startup-deadline handling | Design | Pending |
| CSP-18 | Edge: name sanitization/hash | Design | Pending |

**Status values:** Pending → In Design → In Tasks → Implementing → Verified
**Coverage:** 18 total, all mapped to tasks and implemented. Unit-verified (build + test):
CSP-01,03,04,05,06,07,08,09,10,11,12,13,14,15,16,17,18. Runtime-verified against the real binary
(smoke): CSP-01/03(routing+identity+session),04,11,13. **Operator-gated (T13, live picoclaw
containers):** the "real chat reply / lifecycle over live containers" leaf of
CSP-02/03/05/06/07/09/10 — needs seeded templates + LLM keys.

---

## Success Criteria

- [ ] Two distinct signed-in emails hitting `/picoclaw-alpha/...` each get their own container +
      volume, verified via `docker ps` and isolated history.
- [ ] A scale-to-zero container stops after its idle timeout and cold-starts cleanly on the next
      request with data intact.
- [ ] A continuous-mode container stays up across the idle timeout and across a proxy restart.
- [ ] chat-webapp works end-to-end against the new proxy with no client code changes.
- [ ] The Go turn-completion logic reproduces `server.js` streaming/finalize behavior under test.
