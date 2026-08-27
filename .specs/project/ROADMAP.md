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

## Future Considerations

- Production hardening (TLS termination, secret rotation, Docker-socket privilege — see AD-009 R2)
- Per-user (not just per-agent) lifecycle mode overrides
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
