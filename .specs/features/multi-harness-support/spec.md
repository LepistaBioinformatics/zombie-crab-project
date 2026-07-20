# multi-harness-support Specification

## Problem Statement

`crab-shell-proxy` orchestrates one agent runtime — **picoclaw** — and its coupling is baked into
every layer: config field names (`PicoclawImage/Port/User/Home`), the container spec
(`<HOME>/.picoclaw`, `PICOCLAW_GATEWAY_HOST`), the wire protocol (Pico Protocol over WebSocket), the
provisioning file set (`config.json` + `.security.yml`), and the history reader (`*.jsonl` +
`*.meta.json`, plus a `durable/` workaround for picoclaw's in-memory-session reset). "Agent" today
means "a picoclaw instance" — there is **no notion of a harness kind**.

We want the proxy to orchestrate **other agent runtimes alongside picoclaw**, with **Nous Research's
Hermes Agent** (`nousresearch/hermes-agent`) as the first concrete target. Hermes fits the existing
scale-to-zero model unusually well: it exposes an **OpenAI-compatible HTTP API server** (port 8642)
and persists sessions to **disk** (`state.db`), so the two hardest layers (protocol, scale-to-zero)
are *simpler* than for picoclaw. The work is introducing the harness-kind seam the proxy lacks and
implementing the Hermes profile on top of it. See `investigation.md` for the full feasibility map.

## Goals

- [ ] A **harness-kind discriminator** per agent (`harness: picoclaw | hermes-agent`), defaulting to
      `picoclaw`, so existing agents and behavior are unchanged (zero regression).
- [ ] Per-harness **runtime profile** (image, port, data-mount path, container user, env, health
      path, protocol) replacing the global `Picoclaw*` constants.
- [ ] A signed-in user can chat end-to-end with a **Hermes-backed agent** through the proxy, with the
      same per-`(agent, user)` container + volume isolation picoclaw already has.
- [ ] Hermes turns run as a **near-passthrough** to Hermes' OpenAI-compatible `/v1/chat/completions`
      (streaming + non-streaming), reusing the proxy's existing OpenAI SSE surface.
- [ ] **Scale-to-zero is clean for Hermes**: stop/start preserves the transcript (disk-backed), so no
      `continuous` mode and no `durable/` workaround are required for it.

## Out of Scope

| Feature | Reason |
| --- | --- |
| Porting picoclaw off the Pico Protocol | picoclaw keeps its existing turner unchanged; the seam is additive |
| A third harness implementation | Validate the seam with Hermes first; extensibility is proven (P3), not built out |
| Hermes native channels (Telegram/Discord/Slack/WhatsApp) ingress through the proxy | Same rationale as CTX-01 for picoclaw — those are the agent's own outbound channels |
| Hermes web dashboard (port 9119) exposure | Not needed for the API chat path; would be a separate operator decision |
| Building the Go mycelium SDK | Unchanged dependency; this feature consumes whatever profile mycelium injects |
| Migrating existing picoclaw agents/data | picoclaw remains the default kind; no migration |
| Kubernetes / non-Docker orchestration | Stack is docker-compose, matching the existing proxy |

---

## User Stories

### P1: Harness-kind config seam (picoclaw unchanged) ⭐ MVP

**User Story**: As the operator, I want to declare an agent's runtime kind in config so the proxy can
orchestrate a non-picoclaw harness, without changing how existing picoclaw agents behave.

**Why P1**: Nothing else can exist without a way to *select* a harness. This is the seam every other
story rides on, and it must be back-compatible or it breaks the live stack.

**Acceptance Criteria**:

1. WHEN an agent entry omits `harness` THEN the system SHALL treat it as `picoclaw` and behave exactly
   as today (image, mount, protocol, provisioning, history all unchanged).
2. WHEN an agent entry sets `harness: hermes-agent` THEN the system SHALL resolve that agent's runtime
   profile (image, port, data-mount, user, env, health path, protocol) from the Hermes profile rather
   than the picoclaw constants.
3. WHEN an agent entry sets an unknown `harness` value THEN the system SHALL fail fast at config load
   with a clear error, not at first request.
4. WHEN the proxy runs the existing picoclaw agents (alpha/beta) after this change THEN their build,
   unit tests, and runtime behavior SHALL be unchanged (regression guard).

**Independent Test**: Load config with `alpha` (no `harness`) and a new `hermes-x`
(`harness: hermes-agent`); the picoclaw test suite passes untouched and config validation accepts both;
an unknown kind is rejected at load.

---

### P1: On-demand Hermes container lifecycle ⭐ MVP

**User Story**: As a signed-in user calling a Hermes-backed agent, I want my own isolated Hermes
container started on first request and reused after, so my agent state is private to me.

**Why P1**: The core spin-up/isolation slice for the new harness — the picoclaw analog of CSP-01/02/05.

**Acceptance Criteria**:

1. WHEN a chat request arrives for a `hermes-agent` agent `A` and principal email `E` THEN the system
   SHALL target container `<prefix>-<A>-<userhash>` and create/start it if absent, using image
   `nousresearch/hermes-agent:latest`, the per-user profile mounted at `/opt/data`, env
   `API_SERVER_ENABLED=true`, `API_SERVER_HOST=0.0.0.0`, `API_SERVER_PORT=8642`, and a generated
   `API_SERVER_KEY`.
2. WHEN the Hermes container is started THEN the system SHALL run it as the non-root `hermes` user
   (UID 10000) via `PUID`/`PGID` (or `HERMES_UID`/`HERMES_GID`) and chown the per-user dir to that
   uid, reusing the existing `picoclawUser`-style handling.
3. WHEN a Hermes container is starting THEN the system SHALL wait until `GET /health` returns
   `{"status":"ok"}` on port 8642 before proxying, within the configured startup deadline.
4. WHEN two different principal emails call the same Hermes agent THEN the system SHALL route each to a
   distinct container + `/opt/data` volume (no cross-user state).

**Independent Test**: With a profile for `alice@x`, POST to the Hermes agent's chat route; observe
`<prefix>-hermes-x-<hash(alice)>` come up via `docker ps` and become health-ready. Repeat for `bob@x`;
observe a second, separate container + volume.

---

### P1: Hermes turn via OpenAI passthrough ⭐ MVP

**User Story**: As a signed-in user, I want my chat turn forwarded to the Hermes API server and the
reply streamed back, so I can actually converse with the agent.

**Why P1**: Without running a turn there is no feature. This is where Hermes is *simpler* than
picoclaw — no bespoke protocol.

**Acceptance Criteria**:

1. WHEN a turn runs against a `hermes-agent` container THEN the system SHALL POST to
   `http://<container>:8642/v1/chat/completions` with `Authorization: Bearer <API_SERVER_KEY>` and the
   OpenAI request body, rather than opening a Pico Protocol WebSocket.
2. WHEN the request sets `stream: true` THEN the system SHALL relay Hermes' SSE `chat.completion.chunk`
   events through the proxy's existing SSE surface unchanged, and terminate with `data: [DONE]`.
3. WHEN Hermes emits `hermes.tool.progress` events THEN the system SHALL handle them without corrupting
   the OpenAI stream (relay or drop — decided in design).
4. WHEN a turn runs THEN the shared `Turner`/`Target` contract SHALL carry a transport-neutral
   endpoint + auth token (not the picoclaw-specific `wsURL`/`picoToken`), selected by harness kind.

**Independent Test**: Send a streaming and a non-streaming chat completion to a Hermes agent; both
return a real model reply in OpenAI shape; the picoclaw path still returns via Pico-WS.

---

### P1: Hermes provisioning + session identity ⭐ MVP

**User Story**: As the operator, I want a Hermes agent's per-user profile seeded and its provider key
injected the first time a user chats, and I want the user's conversations scoped correctly.

**Why P1**: A container that can't authenticate to a model or that leaks sessions across users is not
usable. This is the picoclaw analog of provisioning + session isolation.

**Acceptance Criteria**:

1. WHEN a Hermes user's profile is first created THEN the system SHALL seed the flat default-profile
   template (`config.yaml`, `SOUL.md`, `memories/`, custom `skills/`) into `/opt/data`, copying only on
   first provision, and SHALL NOT seed runtime/isolation state (`sessions/`, `state.db*`, `logs/`,
   `cache/`, `*_cache.json`, `auth.json`/`auth.lock`, `bin/`, `sandboxes/`).
2. WHEN a Hermes agent pins a provider/model THEN the system SHALL write `model.default`,
   `model.provider`, and **`model.base_url`** into `config.yaml`, and inject the provider key via the
   generic env/`dotenv` sink under the **provider-specific env name** the agent declares (e.g.
   `GLM_API_KEY` for `provider: zai`) — NOT the picoclaw-only `native` `.security.yml` sink.
3. WHEN a turn runs THEN the system SHALL set `X-Hermes-Session-Key` to the stable per-`(user, agent)`
   scope the proxy already derives, and `X-Hermes-Session-Id` to the conversation id.
4. WHEN two conversations for the same user run THEN each SHALL use a distinct `X-Hermes-Session-Id`
   (isolated transcript) while sharing the same `X-Hermes-Session-Key` (long-term memory scope).

**Independent Test**: First chat seeds `/opt/data` and the key lands in `.env`; two conversations for
one user stay separate; a second user is fully isolated.

---

### P2: Scale-to-zero for Hermes (no continuous, no durable workaround)

**User Story**: As the operator, I want idle Hermes containers to stop and cold-start cleanly with the
transcript intact, so Hermes gets scale-to-zero without picoclaw's in-memory caveat.

**Why P2**: A valuable simplification, but the P1 slice (chat works) is demonstrable first.

**Acceptance Criteria**:

1. WHEN a `hermes-agent` container is stopped by the idle timer and later cold-started THEN the user's
   prior conversation history SHALL still be present and resumable (disk-backed `state.db`).
2. WHEN a Hermes agent is configured `continuous` THEN it SHALL still work, but continuous SHALL NOT be
   required for correctness (unlike picoclaw, whose in-memory session forces it).
3. WHEN turns run for a Hermes agent THEN the proxy SHALL still maintain a durable proxy-owned
   append-only transcript (the same hybrid pattern as picoclaw, OQ-1) — here as a safety net that also
   mitigates Hermes `state.db` corruption (OQ-3), not because of an in-memory reset.

**Independent Test**: Set a short idle timeout on a Hermes agent, chat, let it stop, chat again —
history is intact and no `durable/` files were needed.

---

### P2: Hermes history/`/v1/sessions/history` parity

**User Story**: As the existing chat-webapp, I want conversation history for Hermes agents to render
the same way it does for picoclaw, so the client needs no per-harness special-casing.

**Why P2**: Parity avoids client churn. OQ-1 is **resolved**: use the **same hybrid, file-based
strategy as picoclaw** (durable proxy-owned transcript + read from the harness's on-disk session
store), adapted to Hermes' on-disk format.

**Acceptance Criteria**:

1. WHEN `GET /v1/sessions/history` is called for a Hermes conversation THEN the system SHALL return
   that conversation's messages for the correct user, read from Hermes' on-disk session store under
   `/opt/data` (`state.db` / `sessions/`), preferring the durable proxy-owned transcript when present
   and falling back to Hermes' own files — mirroring picoclaw's `Read()` precedence.
2. WHEN history is read for a Hermes agent THEN a **harness-appropriate on-disk reader** SHALL be used
   behind the history seam (Hermes stores full history in SQLite `state.db`, NOT picoclaw's
   `*.jsonl`/`*.meta.json`); the picoclaw reader SHALL NOT be assumed.
3. WHEN a turn passes through the proxy THEN the proxy MAY build the durable transcript directly from
   the passthrough traffic (it sees every user/assistant message), avoiding any dependency on parsing
   Hermes internals for the durable copy.

**Independent Test**: Chat with a Hermes agent, reload the webapp, history renders identically to a
picoclaw agent with no client change; after a stop/cold-start the durable transcript still returns the
full conversation even if `state.db` is unavailable.

---

### P3: Extensible to further OpenAI-compatible harnesses

**User Story**: As the operator, I want a future OpenAI-compatible runtime to be addable mostly by
config + a small profile, so the seam proves general, not Hermes-specific.

**Why P3**: Confidence in the abstraction; not required to ship Hermes.

**Acceptance Criteria**:

1. WHEN a new OpenAI-compatible harness is added THEN it SHALL reuse the generic Docker client, the
   OpenAI passthrough turner, the `dotenv` secret sink, and the health-check seam, requiring only a new
   runtime profile (+ provisioner if its config format differs).

---

## Edge Cases

- WHEN a Hermes cold start exceeds the startup deadline (never health-ready) THEN the system SHALL fail
  the request `502` and not leak a half-started container (parity with CSP-17).
- WHEN two concurrent requests for the same `(hermes agent, user)` arrive during a cold start THEN the
  system SHALL single-flight the start exactly once (parity with CSP-15).
- WHEN `API_SERVER_KEY` is missing/too short (<8 chars) THEN the system SHALL generate a valid key at
  provision, never start a Hermes container without auth.
- WHEN a config sets `harness: hermes-agent` but also picoclaw-only fields (e.g. a `native` secret
  slot) THEN the system SHALL reject or ignore them with a clear message (no silent misconfig).
- WHEN Hermes' `state.db` is corrupt on cold start (upstream issue #5563) THEN the system SHALL surface
  a clear error rather than silently serving an empty/wrong transcript.
- WHEN the Docker daemon is unreachable THEN behavior SHALL match the existing picoclaw path (`502`,
  proxy stays up).

---

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| MHS-01 | P1: `harness` discriminator, default picoclaw | - | Pending |
| MHS-02 | P1: per-harness runtime profile resolution | - | Pending |
| MHS-03 | P1: unknown harness rejected at config load | - | Pending |
| MHS-04 | P1: picoclaw regression guard (unchanged) | - | Pending |
| MHS-05 | P1: Hermes container create/start (image/mount/env) | - | Pending |
| MHS-06 | P1: Hermes non-root user (UID 10000 / PUID-PGID) | - | Pending |
| MHS-07 | P1: Hermes `/health` health-wait | - | Pending |
| MHS-08 | P1: Hermes per-user container + volume isolation | - | Pending |
| MHS-09 | P1: Hermes turn = OpenAI passthrough to :8642 | - | Pending |
| MHS-10 | P1: SSE relay parity (chunks + [DONE]) | - | Pending |
| MHS-11 | P1: `hermes.tool.progress` handling | - | Pending |
| MHS-12 | P1: transport-neutral Turner/Target contract | - | Pending |
| MHS-13 | P1: Hermes template seed (config.yaml/.env), first-provision-only | - | Pending |
| MHS-14 | P1: provider key via generic dotenv sink | - | Pending |
| MHS-15 | P1: X-Hermes-Session-Key / X-Hermes-Session-Id mapping | - | Pending |
| MHS-16 | P2: Hermes scale-to-zero, transcript intact, no durable workaround | - | Pending |
| MHS-17 | P2: continuous supported but not required for Hermes | - | Pending |
| MHS-18 | P2: Hermes history parity (strategy per OQ-1) | - | Pending |
| MHS-19 | P3: extensible to further OpenAI-compatible harnesses | - | Pending |
| MHS-20 | Edge: startup-deadline / single-flight / API_SERVER_KEY / state.db-corrupt / daemon-down | - | Pending |

**Status values:** Pending → In Design → In Tasks → Implementing → Verified
**Coverage:** 20 total, 0 mapped to tasks ⚠️ (spec phase)

---

## Open Questions

- **OQ-1 — history strategy — RESOLVED (2026-07-20):** use the **same hybrid, file-based strategy as
  picoclaw** — a durable proxy-owned append-only transcript preferred over reading the harness's own
  on-disk session store. For Hermes the on-disk source is SQLite `state.db` (+ `sessions/`) under
  `/opt/data`, so the reader is harness-specific (SQLite, not jsonl). See MHS-18.

- **OQ-2 — Hermes `config.yaml`/env schema — RESOLVED (2026-07-20)** by inspecting a real
  `nousresearch/hermes-agent` profile (GLM/z.ai key, one CLI turn). Confirmed facts:
  1. **Model pin** (`config.yaml`):
     ```yaml
     model:
       default: glm-4.7-flash        # plain model name (NOT a provider/model slug for zai)
       provider: zai
       base_url: https://api.z.ai/api/paas/v4   # REQUIRED for OpenAI-compatible providers
     ```
     → the proxy's per-agent model config must carry **`base_url`** too (today's `ModelConfig` only
     has provider/name/apiKeyEnv — add `base_url`).
  2. **Provider key env** (`.env`): `GLM_API_KEY=…`. The env name is **provider-specific and not
     derivable from the provider string** ("zai" → `GLM_API_KEY`); it comes from Hermes' provider
     registry (`cache/model_catalog.json`). → each Hermes agent config must declare the in-container
     env var name to inject the key under (MHS-14). Injecting via container `-e` is simpler than
     writing `.env`.
  3. **API server is env-driven** — confirmed: no top-level `api_server` section; only
     `gateway.api_server.max_concurrent_runs`. Enable/host/port/key are env (`API_SERVER_*`), so the
     container spec (MHS-05) is correct. Note request-level `stream:true` drives SSE; the top-level
     `streaming.enabled` governs platform edit-in-place, not the API.
  4. **Seed allowlist** — first-provision seed: `config.yaml`, `.env` (or inject key via env), `SOUL.md`,
     `memories/`, and custom `skills/` (bundled skills are populated by the image itself). **NEVER
     seed** (isolation/runtime): `sessions/`, `state.db*`, `logs/`, `cache/`, `*_cache.json`,
     `auth.json`/`auth.lock`, `bin/`, `sandboxes/`, `workspace/` runtime state.
  5. **Data-dir layout** — **flat**: the default profile lives directly at `/opt/data`
     (`/opt/data/{config.yaml,.env,SOUL.md,memories/,skills/,sessions/,state.db}`). Named profiles
     would go under `/opt/data/profiles/<name>/`. One per-user container → use the flat default profile.
  6. **History schema** (SQLite `state.db`, schema_version 16):
     - `sessions(id TEXT PK, source, user_id, model, system_prompt, title, started_at REAL,
       ended_at REAL, message_count, parent_session_id, archived, …)`. `id` = `YYYYMMDD_HHMMSS_<hex>`
       (`source='cli'` → 6-hex, api/gateway → 8-hex). `parent_session_id` supports rewind/branching.
     - `messages(id INTEGER PK, session_id → sessions.id, role, content, tool_call_id, tool_calls,
       tool_name, timestamp REAL, finish_reason, reasoning*, active, compacted, observed)`, index
       `(session_id, timestamp)`. FTS5 mirror tables exist for `session_search`.
     - **History reader query** (OQ-1/MHS-18): `SELECT role, content, timestamp FROM messages WHERE
       session_id=? AND active=1 AND role IN ('user','assistant') AND content IS NOT NULL AND
       content<>'' ORDER BY timestamp;` (skip `tool`/empty rows, mirroring picoclaw's filter).

  *Report:* `/tmp/hermess-setup/hermes-report.txt` (operator's machine).

- **OQ-3 — `state.db` robustness under the per-user container model** (informs MHS-16.3, MHS-20 edge).
  Mitigated in part by the durable proxy-owned transcript (OQ-1).
- **OQ-4 — resource footprint** (informs idle policy): Hermes bundles browser/vision;
  `--shm-size=1g`, higher memory limits may be needed.
- **Dependency** — coordinate with `shared-workspaces` / the Go mycelium SDK where workspace/secret
  seeding overlaps.

---

## Success Criteria

- [ ] A signed-in user chats end-to-end with a `hermes-agent` agent through the proxy (streaming +
      non-streaming), with per-user container + volume isolation verified via `docker ps`.
- [ ] Existing picoclaw agents (alpha/beta) build, test, and run unchanged (zero regression).
- [ ] A Hermes agent scale-to-zero stops on idle and cold-starts with history intact, using no
      `durable/` workaround.
- [ ] The provider key reaches Hermes via `.env`/env (generic sink), never via `.security.yml`.
- [ ] Two conversations for one user stay isolated (distinct `X-Hermes-Session-Id`) while sharing
      long-term memory scope (same `X-Hermes-Session-Key`).
