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
