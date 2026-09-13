# Roadmap

**Current Milestone:** Human-usable signin + chat
**Status:** In Progress

---

## M1: Multi-tenant PicoClaw behind Mycelium

**Goal:** Two PicoClaw instances reachable only through Mycelium, with verified session identity.

### Features

**Core stack (compose + gateway + proxies)** - COMPLETE
**Health checks** - COMPLETE
**Authenticated routes / email-derived identity** - COMPLETE (superseded twice: `public` ->
`protected`/accId-based (an earlier session) -> `authenticated`/email-based (AD-006, this
session) -- see STATE.md for why `protected` didn't work out for a self-service signup flow)

---

## M2: Human-usable test client

**Goal:** A human can sign in and actually chat with alpha/beta through the gateway (not just curl).

### Features

**mycelium-chat-webapp** - COMPLETE

- `chat-webapp` (Next.js BFF: magic-link signin, automatic account creation,
  instance picker, chat, system-theme-aware UI) and `mycelium-webapp` wired
  into compose.
- Verified end-to-end against the live gateway: real magic-link flow, real
  JWT, a genuine chat reply through gateway -> proxy -> picoclaw -> LLM.
- Routes are `authenticated` (not `protectedByRoles`) -- see M3.

**chat-history** - COMPLETE

- New proxy endpoint `GET /v1/sessions/history` (locates a session's
  `.jsonl` transcript via `.meta.json` scanning, no new picoclaw API).
- Multi-conversation groundwork: session_id persistence moved from
  "one per agent" to a full client-side conversation index (superseded
  again by chat-ui-redesign below).

**chat-ui-redesign** - COMPLETE

- Alpha/beta are called "agents" in all UI copy (routing/type names
  unchanged internally).
- Persistent sidebar shell (`app/chat/layout.tsx`): logo, "New chat" +
  agent picker, search box, unified conversation list (both agents mixed,
  tagged), user menu.
- Conversation URLs now include the session id
  (`/chat/{instance}/{sessionId}`), so sidebar items deep-link to an exact
  past conversation, not just "the last one."
- Full-content search: debounced, fetches each conversation's history in
  parallel and filters by substring match, not just titles.
- Replies stream in token-by-token (SSE pass-through from the proxy's
  existing `stream: true` support, through the BFF, to a client-side
  `ReadableStream` reader) instead of waiting for the full response.
- Project logo (zombie-crab) on the sidebar and signin page.

---

## M3 (in progress): Role-scoped access per instance

**Goal:** Restrict which accounts can reach `picoclaw-alpha` vs `picoclaw-beta`.

**Why it stalled, then restarted, then simplified:** Traced during M2 (STATE.md L-006): `protected`/
`protectedByRoles` both require an existing guest membership just to resolve a profile at all,
which requires a Staff -> tenant -> subscription -> guest-invite chain. Originally deferred
entirely (AD-006); resumed 2026-07-13 to create the Staff account via a `base`-mode/Postgres
migration, since `myc-cli`'s seed-account command was the only path available at the time
(AD-007) -- then reverted the same day (AD-008) once upstream shipped a web-based bootstrap flow
that works against `standalone`/SQLite directly, making the Postgres detour unnecessary.

### Features

**DONE**:
- Reverted to `mycelium-gateway` `standalone` mode (SQLite); Staff account (`staff@localhost`)
  created via the new upstream web bootstrap flow (`GET/POST /_adm/instance/bootstrap*`,
  `staffBootstrapSecret` config) instead of `myc-cli`/Postgres (AD-008). Verified: claim flow
  returns a Staff JWT, and a subsequent ordinary magic-link login for the same account also
  succeeds -- chat-webapp's own signin works again as a result (this also resolves the
  previously-deferred SMTP/TLS issue, since standalone's stub transport doesn't touch Mailpit).

**PLANNED (not started)**:
- Log into `mycelium-webapp` as Staff, create a tenant -> subscription -> guest role for
  `alpha`/`beta`, invite a test account
- Flip routes to `protectedByRoles` (roles: `alpha`, `beta`)
- Frontend enforcement of role-based instance visibility (currently the picker shows both
  regardless of role)

---

## M4 (in progress): Per-user agent orchestration (crab-shell-proxy)

**Goal:** Adapt the `zero-scale-stateless-hermes-agent.md` scale-to-zero architecture to picoclaw:
one isolated picoclaw container per `(agent, user)`, spun up on demand and torn down when idle,
with an always-on ("continuous") mode for users who also reach their agent via picoclaw's native
Telegram / MS Teams channels.

### Features

**crab-shell-proxy (Go orchestrator)** - IMPLEMENTED, live-container E2E operator-gated

- New Go service (`crab-shell-proxy/`, future private submodule) behind mycelium; replaces the
  four static `picoclaw-alpha/beta` + `picoclaw-*-proxy` compose services. Resolves agent from
  `x-mycelium-service-name`, user from the `x-mycelium-profile` principal email; spawns/reuses
  `picoclaw-<agent>-<userhash>`, speaks Pico Protocol directly (server.js ported to Go).
- Two lifecycle modes per agent: `scale-to-zero` (idle-timeout stop) and `continuous` (never
  auto-stop). Single-flight cold start, health-wait, reconcile-on-boot, per-user config-only
  provisioning, Docker-socket lifecycle over raw HTTP. See AD-009 + `.specs/features/crab-shell-proxy/`.
- **Verified:** `docker build` (vet + full test suite), `docker compose config`, and a runtime
  smoke test of the built image (boot, /healthz, auth/identity/session paths, clean 502 when
  templates unseeded).
- **Operator-gated (T13):** seed `data/agents/templates/{alpha,beta}`, `docker compose up`, then
  exercise real chat + scale-to-zero/continuous over live containers. Create the private
  `crab-shell-proxy` repo + wire the submodule.

---

## M6 (IN PROGRESS): Agent learning — positioning instances, not listing metrics

**Goal:** a second dashboard that answers "where does each instance sit?" rather than "is
the stack healthy?". The existing `zombie-crab — stack` is organised by layer, which is
right for health and wrong for this; it stays as the general view.

**The blocker was never the dashboard.** None of the data existed: harness-sphere emits
messages, sessions and tool calls, so a "learning" dashboard built on today's metrics could
only show how much an agent *talked*. Three new collectors come first — skills, memory and
the knowledge graph — all reachable through the read-only `/data` mount that already exists.

Measured on the live workspace before speccing, and each number is a trap a plausible
implementation falls into: skills are **9 `SKILL.md` files across 10 directories**; memory
is **1 non-empty file out of 4** (three are zero-byte provisioning scaffolds, a 4×
overcount); the graph is **20 records where `wc -l` says 19**. The entity `observations`
array is the real learning volume and is not derivable from any file count.

Framing chosen by the owner: **capability × consumption** — skills against tool calls, with
graph size as point weight. Skill names may be labels (agent-authored, ~10 per instance);
entity names never can be (member content, unbounded cardinality).

**Status 2026-09-08:** collectors shipped (harness-sphere#28) and verified against the
live workspace — the four predicted numbers all landed: skills **9** (not 10), memory
files **1** (not 4), graph **10 + 10** (not 19), and 56 retained observations. The second
dashboard is provisioned. What is still open is OQ-10: what threshold makes an instance
*unsustainable*, which needs a second instance to calibrate.

See `.specs/features/agent-learning-dashboard/`.

## M5 (IN PROGRESS): Observability — harness-sphere

**Goal:** the stack stops being unobservable. Today it emits **nothing** — a strict grep
for `prometheus|opentelemetry|otel` across this repo and both submodules returned zero
hits, and the entire observability surface was three health endpoints plus unstructured
printf logs with no levels and no request ids.

**Status 2026-09-08:** no longer true. The watcher ships, exports OTLP, and an opt-in
overlay (`docker-compose.observability.yaml`) carries OTel Collector → Prometheus →
Grafana with a provisioned dashboard whose every query was verified against live data.
The scope reduction landed (−1,562 LOC). What remains is dynamic per-tenant instance
discovery — see `.specs/features/harness-sphere-zombie-crab-scope/tasks.md`, groups D and S.

`harness-sphere` (https://github.com/LepistaBioinformatics/harness-sphere) is adopted as a
third submodule and **repurposed to work exclusively for this stack** (AD-022). Two
features, deliberately sequential — the first measures what the second is designed
against.

### Features

**harness-sphere-integration (DONE, 2026-09-08)** — the tool lands as a submodule at
`crab/harness-sphere` and runs as one compose service on `zombie_net`, exporting OTLP,
**with no Rust changed**. Host and self come free; the gateway, proxy and webapp are
covered by TCP probes. Two things make it more than a drop-in: it runs as a *container*
rather than the host binary its own design principles call for (picoclaw publishes no host
ports, so a host binary is structurally blind to the agent layer), and `crab-shell-proxy`
gains one read-only endpoint, `GET /v1/instances`, because the container name hashes the
`(tenant, subscription, user)` tuple one-way and the proxy is the only holder of the
preimage — cheaper than giving the watcher a **second** Docker socket in a stack whose
most privileged service already has one. Its verification section is the point of the
feature: four questions F2's design depends on, answered by measurement. See
`.specs/features/harness-sphere-integration/`.

**harness-sphere-zombie-crab-scope (REDUCTION DONE; dynamic half designed, not started)** — the reduction
and the dynamic half. `Layer` collapses from seven to the stack's six real ones — host,
self, mycelium-gateway, proxy, exoskeleton, picoclaw — with `Container` demoted from a
peer layer to a *dimension* (everything here runs in a container; a picoclaw container's
memory is a Harness signal). `prometheus.rs` (770 LOC) and the `ingest` crate (574 LOC)
are deleted: nothing here exposes Prometheus text and nothing pushes OTLP. **Token cost
leaves with them and does not come back** — picoclaw does not write tokens to disk, and
instrumenting it is a non-goal. The dynamic half is the real work: harness-sphere's
sources are single-valued and boot-resolved (`&'static str` names, `probe()` once at
startup, a supervisor whose source set never changes), which is the exact opposite of a
proxy that creates and recreates a container per user on demand. Discovery reconciles two
surfaces that are allowed to disagree — the proxy's inventory (live containers) and the
on-disk tenant tree (provisioned workspaces, whose *path* carries the tuple, so session
metrics survive the proxy being down). See
`.specs/features/harness-sphere-zombie-crab-scope/`.

---

## Future Considerations

- Production hardening (TLS termination, secret rotation, Docker-socket privilege — see AD-009 R2)
- Per-user (not just per-agent) lifecycle mode overrides
- **ganglion-mcp-token-indirection** (RECORDED — no work scheduled) — the
  memory-graph bearer token is the one credential this stack still writes in
  plaintext to a volume, in
  `.ganglion-config.json`'s `tools.mcp.servers.memory.headers.Authorization`.
  The reason is picoclaw's (`tools.mcp.servers` has no env indirection,
  `env_file` is stdio-only) and does not apply to a harness we own. Proposal:
  carry it the way model keys already travel — a derived variable name both
  sides compute, file value kept as fallback. Defence in depth, not a live
  exposure: Landlock already keeps the file out of the agent's reach, so the
  gain is at-rest (backups, snapshots, copied user directories). OQ-1 —
  environment or a second bind — is open, because the environment is visible to
  `docker inspect`. picoclaw's record is unchanged. See
  `.specs/features/ganglion-mcp-token-indirection/`.
- **multi-harness support (DEFERRED — withdrawn 2026-08-09)** — orchestrating a
  non-picoclaw agent runtime behind the same proxy. Hermes Agent (Nous Research)
  was implemented and **verified working end-to-end**, then withdrawn for current
  infrastructure compatibility: a 180s startup deadline against a 35s global
  health-wait, and turns sitting near mycelium's 60s `gatewayTimeout` (never
  solved). The generic harness seam is kept dormant, so a re-add is "write the
  profile". Decision: `.specs/features/hermes-removal/DECISION.md`. Design record:
  `.specs/features/multi-harness-support/`. **Start from**
  `crab/crab-shell-proxy/.specs/features/multi-harness-support/implementation-notes.md`
  — the runtime findings from the live E2E.
- **conversation-tree-view** (PLANNED) — optional "Tree" view mode in the chat
  sidebar: a vertical time-ordered spine where each conversation is a colored
  lane and each message is a dot, reconciling the agent's continuous per-session
  transcript with the web's recency-first list. Visualization only (no
  `parent_id`/fork). See `.specs/features/conversation-tree-view/`.
- **canvas-timeline-view** (SPEC READY) — an alternative, graphics-forward
  "Canvas" mode (workspace-level `Traditional | Canvas` toggle, `view=canvas` in
  the fragment) whose sole view is a left→right timeline: one lane per
  conversation on a shared time axis, activity bursts as dots (same colors as the
  tree), an aggregate "agent pulse" strip above, and a pixel-art grid backdrop —
  conveying the agent's intelligence evolving over time. Preview-on-click with
  Solo + hand-off to the traditional chat. Webapp-only (reuses `created_at` from
  conversation-tree-view; no proxy change). Feel-first prototype validated
  (Timeline chosen over Deck/Tree metaphors). See
  `.specs/features/canvas-timeline-view/`.
- **turn-stream-continuity** (SPEC READY) — the *prevention* half of the cut-stream
  problem, which `long-turn-resilience`, `resume-turn-after-reload` and
  `background-turn-dock` all pointed at and all declined. Four groups: a 10s SSE
  **heartbeat** from the proxy (an SSE *comment*, so it cannot stamp `lastEventAt` and
  cannot break the band's elapsed readout — Group A therefore needs no webapp change and
  ships as a proxy-only release); removing the BFF's own inactivity bound on the streaming
  route (measure first, spec OQ-2); **re-attach to a live turn** via sequenced frames and
  a `Last-Event-ID` endpoint, with today's transcript-growth poll kept underneath as the
  floor; and waking a wait on `online`/`visibilitychange` instead of polling blind.
  Prerequisite P-0: the dock deploy + T-10 half is **done** (2026-08-27); what remains is
  the pre-heartbeat baseline, which gates T-02 and cannot be taken after it. Build order is
  A → B+D → measure → C, with T-08 as a real gate. See
  `.specs/features/turn-stream-continuity/` and STATE.md AD-017.
- **picoclaw-incremental-streaming** (INVESTIGATION) — the cause, not the symptom.
  picoclaw answers in one terminal frame (51s of measured silence), which is what makes the
  SSE idle in the first place and what makes the webapp's typewriter a simulation. The
  proxy **already** consumes deltas correctly (`internal/pico/turn.go:179` handles
  `message.update` cumulatively), and picoclaw exposes `StreamingCapable`/`bus.Streamer`
  which its pico channel implements — so the one-frame behaviour is unexplained and might
  be a config key. Cheapest high-value hour near this problem. Delivery is already solved:
  `deploy/picoclaw-glob/` + `release-picoclaw-glob` means a change is a third patch, not a
  fork. Answers "should we implement an HTTP connection in picoclaw?" — **no**, wrong hop.
  See `.specs/features/picoclaw-incremental-streaming/investigation.md`.
- **steering-messages** (INVESTIGATION) — picoclaw folds a message that arrives mid-turn
  into the running turn (`enqueueSteeringMessage`, `turn_coord.go:115`), and **this stack
  never reaches that path**: the webapp queues the second message client-side and POSTs it
  only after the first turn's reveal has drained (`turn-store.ts` `drain`/`awaitDrained`).
  The proxy imposes nothing — only the browser prevents it. Worth having on long turns (a
  correction ten seconds in, instead of a wasted five-minute answer), but it renegotiates
  the turn boundary: two POSTs for one turn with undefined wire semantics, and it stresses
  the proxy's 500ms `graceWindow` race directly. Deferred to after
  `turn-stream-continuity`, read together with `picoclaw-incremental-streaming`. **One
  thing it constrains now:** that feature's Group C frame log is keyed per conversation,
  which is only safe while the webapp queue holds — see its OQ-4. See
  `.specs/features/steering-messages/investigation.md`.

- **ganglion-reasoning-depth** (IMPLEMENTED 2026-09-10) — depth the agent chooses,
  per turn. picoclaw's `model_list[].thinking_level` adopted verbatim as the static
  floor (its six values; a seventh would break the model editor that already renders
  the field), plus `set_reasoning_depth`, which is sticky for the rest of the turn
  and dies with it. Declaring a level IS the capability declaration — there is no
  provider table, because this harness speaks one wire to every endpoint — and a
  request whose depth field an endpoint rejects is retried once without it rather
  than ending the turn. `crab-ganglion-harness#5`, `crab-shell-proxy#43`,
  `crab-exoskeleton-webapp#58`. See `.specs/features/ganglion-reasoning-depth/`.
- **ganglion-subagents** (SPEC READY) — one tool, `subagents{mode, tasks[]}`,
  taking a batch and fanning out inside a single tool call so the turn loop stays
  sequential and the call↔result pairing `compact` enforces stays intact.
  Synchronous by design: picoclaw's async path returns its result as a *different
  turn* and its status tool polls a map nothing writes. `research{question, mode}`
  is built on the same dispatcher rather than being a second mechanism — deep
  research is a fan-out plus a synthesis the PARENT performs, not a wire
  parameter. Bounds are stated as arithmetic (108 model calls at the defaults) and
  enforced at depth 0, which is where picoclaw's are not. See
  `.specs/features/ganglion-subagents/`.
- **ganglion-projects** (SHIPPED, all three slices) — closed DF-3, DF-5, DF-1 and
  DF-2, which were four `501`s in `harness_gate.go`. **A** gives a ganglion
  turn its own files, transcripts, window and `MEMORY.md` under
  `workspace/projects/<id>/` — a subdirectory of the bind it already has, so no
  new mount and **no container recreate**, at the stated cost that isolation
  between projects is a harness convention and not a kernel boundary. **B** puts
  the scheduler in the PROXY, because the ganglion runs `scale-to-zero` and a
  clock inside it would sleep through its own work — which also makes
  per-project schedules possible for the first time, something picoclaw's
  one-store-per-container cron structurally cannot do (defect B1) — shipped as
  crab-shell-proxy#46, with the store above the workspace bind so a turn steered
  by untrusted text cannot schedule its own future turns. **C** gives the harness
  a hand-written MCP client so it reaches the graph the proxy already hosts —
  `crab-ganglion-harness#8` and `crab-shell-proxy#47`, with `go.mod` still at zero
  requires, and with ONE server rather than picoclaw's one-per-project, because
  the harness registers a remote server's tools under their own names and N+1
  servers offering the same tool refuse the boot. See
  `.specs/features/ganglion-projects/` and STATE.md AD-026.
