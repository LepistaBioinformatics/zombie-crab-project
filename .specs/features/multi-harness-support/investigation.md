# multi-harness-support — Feasibility Investigation

**Status:** Investigation (pre-spec). No implementation committed.
**Question:** Can `crab-shell-proxy` orchestrate agent runtimes *other than* picoclaw, and
specifically what does it take to run **Nous Research's Hermes Agent** (`nousresearch/hermes-agent`)?
**Verdict:** **Feasible, and unusually clean.** Hermes' OpenAI-compatible API server + disk-backed
session store make it an *easier* integration than picoclaw in the two hardest layers (protocol and
scale-to-zero). The work is real but mostly a refactor to introduce a "harness kind" seam that does
not exist today.

---

## 0. Name-collision flag (read first)

There are **two unrelated things called "hermes"** in play:

1. **The pattern** — the repo adapts a scale-to-zero doc named `zero-scale-stateless-hermes-agent.md`.
   `conversation-tree-view/context.md:94` states plainly: *"'hermes' ... is the name of the
   stateless/scale-to-zero architecture pattern, not an agent here."* This is the `crab-shell-proxy`
   architecture, already implemented for picoclaw.
2. **The product** — `nousresearch/hermes-agent`, an open-source self-hosted AI agent (Nous Research;
   repo created 2025-07-22, actively developed, ~218k★, image `nousresearch/hermes-agent:latest`
   verified present), a genuine *alternative harness* to picoclaw.

**This document is about #2** (confirmed with the requester). The name match with #1 is a coincidence.
The requester's framing — *"outros harness além do picoclaw ... hermes agent especificamente"* — is
read as: **(a)** introduce a harness-agnostic seam, with **(b)** the Nous product as the first
concrete non-picoclaw target.

---

## 1. Hermes Agent — the external runtime (facts)

| Aspect | Hermes Agent | picoclaw (today) |
|---|---|---|
| Image | `nousresearch/hermes-agent:latest` | `docker.io/sipeed/picoclaw:latest` |
| Programmatic interface | **OpenAI-compatible HTTP API server** (`API_SERVER_ENABLED=true`) | Pico Protocol (JSON-over-WebSocket) |
| Port | `8642` (`API_SERVER_PORT`, bind `API_SERVER_HOST=0.0.0.0`) | `18790` (`/pico/ws`) |
| Auth | Bearer token, `API_SERVER_KEY` (≥8 chars) | WS subprotocol `token.<token>` |
| Turn endpoint | `POST /v1/chat/completions` (also `/v1/responses`, `/api/sessions/{id}/chat`) | `message.send` frame over WS |
| Streaming | SSE, standard `chat.completion.chunk` + custom `hermes.tool.progress` | Pico frames (`message.create/update`, `typing.*`) |
| Health | `GET /health` → `{"status":"ok"}` (also `/v1/health`) | `GET /health` on `18790` |
| Profile/data dir | single mount `/opt/data` (host `~/.hermes`): `config.yaml`, `.env`, `sessions/`, `skills/`, `memories/`, `state.db` | `<HOME>/.picoclaw/workspace/`: `config.json`, `.security.yml`, `AGENT.md`, `SOUL.md`, `memory/`, `skills/`, `sessions/` |
| Session persistence | **SQLite `state.db` on disk** — full message history + metadata (FTS5), resumable by ID across restarts | **in-memory** SQLite; **resets on restart** (reason `continuous` mode exists) |
| Non-root user | `hermes` UID 10000; host mapping via `PUID`/`PGID` or `HERMES_UID`/`HERMES_GID`; `HERMES_ALLOW_ROOT_GATEWAY=1` | `picoclawUser` (`1000:1000`), `HOME=<PicoclawHome>` |
| Session scoping headers | `X-Hermes-Session-Id` (transcript namespace, rotates on /new), `X-Hermes-Session-Key` (stable long-term memory scope) | derived pico session id (`identity.SessionKey`) |
| Provider keys | env / `.env` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, any OpenAI-compatible endpoint) | written into `.security.yml` `model_list.<name>.api_keys` |

**Two facts that drive the verdict (verified against Hermes docs):**

- **Sessions are disk-backed and reloadable.** `state.db` lives inside the mounted profile and holds
  full history + metadata; sessions resume by id. → A stop/start does **not** lose the transcript.
- **Session headers map 1:1 onto the proxy's identity model.** `X-Hermes-Session-Key` = stable
  per-`(user, agent)` scope (what the proxy already derives); `X-Hermes-Session-Id` = per-conversation
  transcript. The proxy can drive both per turn.

---

## 2. Current coupling in `crab-shell-proxy` (why this is a refactor)

The proxy has **no "harness kind" concept** — "agent" means "a picoclaw instance". picoclaw specifics
are spread across five layers. Existing seams that a second harness can reuse **as-is**:

- `Docker` interface + generic Engine-API client — `internal/docker/client.go` (fully harness-agnostic;
  `CreateSpec` already has a generic `Cmd []string`).
- `HealthChecker` func type — `internal/docker/manager.go:50` (pluggable; default assumes `/health`).
- `Turner` interface — `internal/httpapi/handlers.go:92` (a "run a turn" seam — but its param names
  `wsURL`/`picoToken` leak picoclaw).
- Generic secret sinks `dotenv`/`json`/`file` — `internal/docker/secrets.go` (runtime-neutral; only the
  `native` `.security.yml` sink is picoclaw-specific).
- `Resolver` (identity) — `internal/identity/identity.go:48` (mycelium-coupled, harness-neutral).

Where the work lands (no seam today):

| Area | picoclaw-hardcoded today | Ref |
|---|---|---|
| **Config / agent kind** | no runtime discriminator; global `PicoclawImage/Port/User/Home`; `Model` maps to picoclaw `model_list` | `internal/config/config.go:92,170,275,487`; `config.yaml:26-68` |
| **Container spec** | mount `<Home>/.picoclaw`; env `PICOCLAW_GATEWAY_HOST`; `PicoclawUser`; ws path `/pico/ws` | `internal/docker/manager.go:107,185-276` |
| **Provisioning / config files** | `templateFiles = {config.json, .security.yml}`; writes `channel_list.pico`, `agents.defaults`, `model_list`; `pico-` token | `internal/docker/provision.go:24,89-138,159-194` |
| **Wire protocol** | full Pico Protocol state machine (frames, `token.<t>` subprotocol, typing grace window) | `internal/pico/turn.go` (whole file) |
| **History / sessions** | reads `*.jsonl`+`*.meta.json`, `direct:pico:` marker, `durable/` workaround for in-memory reset | `internal/history/history.go:20-117,155-184` |

---

## 3. What needs to be implemented

### 3.1 Harness-agnostic seam (needed for *any* second runtime — interpretation-independent)

1. **Runtime-kind discriminator** on the agent config: `harness: picoclaw | hermes` (default
   `picoclaw` for back-compat). Move the global `Picoclaw*` fields into a per-harness profile
   (`image`, `port`, `user`, `home`, `protocol`, `dataMount`, health path). `config.go`/`config.yaml`.
2. **Generalize `Turner`** — rename `wsURL`/`picoToken` → transport-neutral `endpoint`/`authToken`;
   make `Target` (`manager.go:52`) carry a generic endpoint+token instead of `WSEndpoint`/`PicoToken`.
   Select the concrete turner by harness kind.
3. **Harness-specific container-spec builder** — factor `create()` (`manager.go:185`) so mount path,
   env, user, and health check come from the harness profile, not constants.
4. **Harness-specific provisioner** — factor `provision.go` so the template file set and the
   config-writing logic are per-harness.
5. **Harness-specific history reader** — behind a small interface, or bypassed entirely for harnesses
   whose transcripts are readable via API (see 3.2).

### 3.2 Hermes-specific implementation (the concrete first target)

Ordered easiest → hardest:

1. **Turner = near-passthrough (BIG WIN).** The proxy's inbound API is *already* OpenAI-shaped
   (`sse.go` emits `chat.completion.chunk`), and the original design even ran a `picoclaw-openai-proxy`
   sidecar doing OpenAI↔Pico translation — now ported into `pico/turn.go`. For Hermes there is **no
   translation**: forward to `POST http://<container>:8642/v1/chat/completions` with
   `Authorization: Bearer <API_SERVER_KEY>` and stream the SSE straight through (dropping/relaying
   `hermes.tool.progress`). This turner is *simpler* than the Pico one.
2. **Container spec.** Image `nousresearch/hermes-agent:latest`; mount profile at `/opt/data`; env
   `API_SERVER_ENABLED=true`, `API_SERVER_HOST=0.0.0.0`, `API_SERVER_PORT=8642`, `API_SERVER_KEY=<gen>`;
   user via `PUID`/`PGID` (or `HERMES_UID`/`HERMES_GID`) → reuse existing `PicoclawUser`-style chown;
   health `GET /health`.
3. **Provisioning.** Template = `config.yaml` + `.env` (not `config.json`/`.security.yml`). Provider
   API keys go into `.env` / env — which the **existing generic `dotenv` secret sink already covers**,
   so the picoclaw-only `native` sink is simply not used for Hermes.
4. **Session mapping.** Per turn, set `X-Hermes-Session-Key` = the proxy's stable per-`(user, agent)`
   key and `X-Hermes-Session-Id` = the conversation id. No custom session-id-in-query hack.
5. **History.** Two options: (a) read Hermes `state.db`/`sessions/` for the tree/history UI (new
   format-specific reader), or (b) rely on Hermes server-side history + the proxy's own conversation
   store. **The fragile `durable/` workaround is not needed** — Hermes persists to disk.

### 3.3 Architectural payoffs unlocked by Hermes

- **Scale-to-zero becomes the clean default** for Hermes: stop/start does not lose the transcript
  (disk-backed `state.db`), so `continuous` mode + the in-memory-reset workaround are unnecessary.
- **No sidecar** and **no bespoke wire protocol** — the OpenAI surface collapses the hardest layer.
- Non-root UID 10000 + `PUID`/`PGID` is a direct analog of the existing `picoclawUser` handling.

---

## 4. Open questions / risks / dependencies

- **OQ-1 — history strategy.** Does the tree/history UI need to read Hermes transcripts directly
  (parse `state.db`/`sessions/`), or can it rely on the proxy's own conversation records + Hermes API?
  Decides whether 3.2.5 is a new reader or a no-op. *(Recommend: proxy-owned records; treat Hermes as
  stateless-per-turn via full `messages` array, or via `X-Hermes-Session-Id` resume.)*
- **OQ-2 — model/provider config.** Confirm the exact `config.yaml` schema for pinning
  provider+model (vs. `API_SERVER_MODEL_NAME`) so provisioning writes the right file. *(Fetch the
  Hermes `configuration` + `docker` docs before implementing 3.2.3.)*
- **OQ-3 — `state.db` robustness.** Upstream reports exist of `state.db` corruption / session-replay
  token waste under heavy use (Hermes issue #5563). Validate under the per-`(user, agent)` container
  model before relying on scale-to-zero in production.
- **OQ-4 — resource footprint.** Hermes bundles browser automation/vision; docs suggest
  `--shm-size=1g`, `--memory=4g`. Heavier than picoclaw → revisit per-container limits and the
  scale-to-zero idle policy.
- **Dependency — shared-workspaces / Go mycelium SDK.** Per project memory, some workspace/secret work
  is gated on a Go mycelium SDK being built first. Confirm whether this refactor must wait on or
  coordinate with that. (See STATE.md and the `shared-workspaces` spec.)
- **Naming hygiene.** Because the repo already overloads "hermes" (the pattern), the config kind and
  docs should use an unambiguous label (e.g. `harness: hermes-agent`) to avoid confusion with
  `zero-scale-stateless-hermes-agent.md`.

---

## 5. Rough effort sizing (indicative, not a commitment)

| Chunk | Size | Notes |
|---|---|---|
| Config harness-kind seam (3.1.1) | M | mechanical but touches config surface + defaults/back-compat |
| Generalize `Turner`/`Target` (3.1.2) | S–M | rename + kind-based selection |
| Container-spec builder split (3.1.3) | M | factor `create()` by harness profile |
| Provisioner split (3.1.4) | M | template set + config writer per harness |
| Hermes turner (3.2.1) | S | near-passthrough to `/v1/chat/completions` |
| Hermes container + provisioning + sessions (3.2.2–3.2.4) | M | reuses generic dotenv sink + chown |
| History reader / strategy (3.1.5 + 3.2.5) | M–L | depends on OQ-1 |

**Bottom line:** the blocker was never the protocol — Hermes' OpenAI API makes that the easy part.
The real cost is introducing the harness-kind abstraction the proxy lacks today (§3.1). Everything
Hermes-specific then rides on existing seams (Docker client, dotenv secrets, chown, OpenAI SSE).

---

## 6. Sources & confidence

**Confidence:** The `crab-shell-proxy` coupling map (§2) is grounded in the actual code (file:line refs
verified). The **Hermes facts (§1) are research-grade, not tested against a running instance** —
sourced from Hermes docs + GitHub on 2026-07-20. Existence ground-truthed: `NousResearch/hermes-agent`
repo (created 2025-07-22, ~218k★) and image `nousresearch/hermes-agent:latest` both confirmed present.
Behavioral claims (session persistence, header semantics, exact config schema) should be validated
against a live container before implementation — see OQ-1..3.

- Hermes docs: `https://hermes-agent.nousresearch.com/docs/` — API server (`/user-guide/features/api-server`),
  Docker (`/user-guide/docker`), Sessions (`/user-guide/sessions`), Configuration (`/user-guide/configuration/`)
- Hermes repo: `https://github.com/NousResearch/hermes-agent` (session-key PR #20199; robustness issue #5563)
- Image: `https://hub.docker.com/r/nousresearch/hermes-agent`
- picoclaw / Pico Protocol: `https://github.com/sipeed/picoclaw`, `https://docs.picoclaw.io/`
