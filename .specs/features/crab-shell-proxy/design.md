# crab-shell-proxy Design

Adapts `zero-scale-stateless-hermes-agent.md` to picoclaw, driven by this project's mycelium
profile identity. Decisions from `context.md` (CTX-01..05) are assumed. All requirement IDs
refer to `spec.md`.

---

## 1. Topology (target state)

```
Client ── HTTPS+JWT ──► mycelium-gateway :8080
                          │  routes /picoclaw-alpha/* and /picoclaw-beta/*
                          │  → SAME downstream host  crab-shell-proxy:8080
                          │  injects: x-mycelium-service-name: picoclaw-<agent>
                          │           x-mycelium-profile: base64(zstd(json(Profile)))
                          │           Authorization: Bearer <per-agent token>
                          ▼
              ┌─────────────────────────────────────────────┐
              │ crab-shell-proxy  (Go, this feature)         │
              │  • resolve agent  ← x-mycelium-service-name  │
              │  • resolve user   ← x-mycelium-profile email │
              │  • ensure picoclaw-<agent>-<userhash> up     │  ── Docker API (/var/run/docker.sock)
              │  • Pico-WS turn  ⇄  OpenAI HTTP/SSE           │
              │  • lifecycle: scale-to-zero | continuous     │
              └───────────────┬─────────────────────────────┘
                              │ ws://picoclaw-<agent>-<userhash>:18790/pico/ws  (zombie_net DNS)
                              ▼
              ┌─────────────────────────────────────────────┐
              │ picoclaw-<agent>-<userhash>  (bare picoclaw) │
              │  /root/.picoclaw ← host data/agents/<a>/<h>/ │
              │  native channels (telegram/teams) dial OUT   │
              └─────────────────────────────────────────────┘
```

The four current services (`picoclaw-alpha`, `picoclaw-alpha-proxy`, `picoclaw-beta`,
`picoclaw-beta-proxy`) are **replaced** by the single `crab-shell-proxy` plus the per-user
containers it spawns. The `picoclaw-openai-proxy` submodule stays in the repo as the **behavior
reference** for the Go port but is no longer wired into compose.

---

## 2. Key design decisions

### D1 — Agent resolution: `x-mycelium-service-name` header  (CSP-01)
Traced in mycelium `ports/api/src/router/initialize_downstream_request.rs:213`:
`.insert_header((MYCELIUM_SERVICE_NAME, service.name))`. mycelium strips the first path segment
(`adapters/mem_db/.../shared.rs::extract_path_parts`), so the proxy **cannot** read the agent
from the path — but it receives `x-mycelium-service-name: picoclaw-alpha` / `picoclaw-beta`.
The proxy strips the configured prefix (`picoclaw-`) to get the agent key `alpha` / `beta`, and
cross-checks the injected `Authorization: Bearer` token matches that agent's configured token
(rejects a caller that bypassed mycelium).

### D2 — Identity: mycelium profile → principal email  (CSP-04, CTX-04)
Exactly `server.js`'s decode: `base64 → zstd-decompress → JSON → owners.find(isPrincipal).email`
(fallback: first owner). Behind a Go interface so the parallel Go SDK can replace it:

```go
type IdentityResolver interface {
    // PrincipalEmail decodes the mycelium profile header value into the
    // signed-in principal's email. Returns "" (not error) when absent/undecodable.
    PrincipalEmail(profileHeader string) string
}
```
Ship `fallbackResolver` (self-contained zstd+base64+json, no SDK dependency) as the default so
the feature is not blocked on the SDK. When the SDK lands, a `sdkResolver` implements the same
interface and is swapped in one place.

### D3 — Naming & isolation  (CSP-05, CSP-18)
- `userhash = hex(sha256(lowercase(email)))[:16]`  (Docker-name-safe, collision-resistant).
- container name = `picoclaw-<agent>-<userhash>`.
- per-user data dir (host) = `${HOST_DATA_ROOT}/<agent>/<userhash>/` bind-mounted to
  `/root/.picoclaw` in the picoclaw container. This dir is the isolation boundary (SQLite
  memory, sessions, workspace all live here, per user).
- Conversation-within-user isolation still uses `sessionIdFor(email, session_id)` =
  `sha256(email::session_id)[:32]` handed to picoclaw as `session_id` (parity with server.js;
  keeps `/v1/sessions/history`'s `.meta.json` scope-marker scan working unchanged).

### D4 — Sibling-container pattern + Docker socket  (CSP-01, security)
crab-shell-proxy runs as a container but creates *sibling* containers via the host Docker
daemon. Therefore:
- It mounts `/var/run/docker.sock` (⚠️ **most privileged component in the stack** — documented
  security note; it can control the host daemon).
- Bind-mount **sources** passed to the Docker API are **host** paths, so the proxy is configured
  with `HOST_DATA_ROOT` = the absolute *host* path of the data root (from `.env`), distinct from
  where that same dir is mounted **inside** the proxy (`CONTAINER_DATA_ROOT`, e.g. `/data/agents`)
  for reading history and writing per-user config templates.
- Spawned containers are attached to the existing `zombie_net` network (name resolved from
  compose project) so the proxy reaches them by container name over Docker DNS.
- Every managed container gets labels for reconciliation:
  `crab-shell.managed=true`, `crab-shell.agent=<agent>`, `crab-shell.user=<userhash>`,
  `crab-shell.mode=<scale-to-zero|continuous>`.

### D5 — Per-user provisioning
On first start for `(agent, userhash)`, if the data dir has no `config.json`:
1. copy the agent's **template dir** (`${CONTAINER_DATA_ROOT}/templates/<agent>/`, seeded once by
   the operator) into the per-user data dir — **config-only allowlist**: exactly `config.json`
   and `.security.yml`. ⚠️ **Never `cp -r` a live `data/alpha`/`data/beta`**: those are the
   *shared* instances today and their `workspace/sessions/` holds real conversation history —
   copying it would preload every new user's container with everyone else's sessions (cross-user
   data leak). `workspace/`, `logs/`, `.picoclaw.pid` are explicitly excluded; picoclaw recreates
   `workspace/` empty on first gateway run;
2. **read** the pico token from the copied `.security.yml` (same nested-`pico:`→`token:` scan
   `server.js` uses) and hold it in memory to open the Pico WS. (Deviation from an earlier draft
   that *generated* a per-container token and rewrote the YAML: reused-from-template is lower risk
   — no YAML mutation — and the pico token is channel auth, not user identity; isolation is
   container/volume-level, so sharing the operator-set template token across a user's containers
   is acceptable.)
3. start the container; picoclaw creates `workspace/` itself and runs `picoclaw gateway`
   (entrypoint skips onboarding because `config.json` is present).

If the data dir already has `config.json` (returning user), read the existing pico token from
its `.security.yml` and start as-is.

### D6 — Lifecycle manager  (CSP-02, 06, 07, 08, 09, 10, 15, 16, 17)
A single goroutine-safe `Manager` keyed by container name:

- `EnsureRunning(ctx, agent, userhash) (endpoint, picoToken, error)` — **single-flight** per key
  (`golang.org/x/sync/singleflight` or a per-key mutex map): concurrent first-hits start the
  container exactly once. Steps: inspect → if missing, create (provision per D5) → if stopped,
  start → poll `GET http://<name>:18790/health` until 2xx or **startup deadline** (config,
  e.g. 60s) → on deadline, stop+remove the half-started container and return `502`.
- **Disarm on request entry, re-arm on completion**: on entering `EnsureRunning` for a
  scale-to-zero container, cancel any pending idle timer; re-arm only after the turn completes.
  (Prevents a previously-armed timer firing mid-turn if `idleTimeout` is ever set below
  `turnTimeout`.) On fire: `docker stop <name>` (data dir preserved). **continuous** instances
  never arm (CTX-01/CTX-05).
- Stop/request race (CSP-16): a per-key mutex guards inspect→start and stop so a request never
  proxies to a container mid-stop; a stop in progress is awaited, then the container is
  restarted.
- Reconcile on boot (CSP-08): list containers with label `crab-shell.managed=true`; adopt
  running ones (re-arm scale-to-zero timers from `now`); for **continuous** agents, ensure their
  expected containers are started (CSP-10) — note: without traffic the proxy only knows a
  continuous container "should exist" if its data dir already exists, so startup-ensure walks
  existing per-user data dirs of continuous agents and starts each.
- Docker-unreachable (CSP-17): any Docker API error surfaces as `502` with a clear message; the
  proxy process never panics.

### D7 — Pico Protocol WS client (highest-risk port)  (CSP-03, CTX-03)
Direct 1:1 port of `server.js`'s `runTurn`, preserving the tuned completion logic:
- dial `ws://<name>:18790/pico/ws?session_id=<sid>` with subprotocol `token.<picoToken>`
  (`github.com/coder/websocket` or `nhooyr.io/websocket`);
- send `{type:"message.send", session_id, payload:{content}}`;
- accumulate `message.create`/`message.update` payloads, **skipping** `kind=="thought"`,
  `kind=="tool_calls"`, and `placeholder==true`;
- `typing.start` → cancel finalize grace; `typing.stop` → arm a 500 ms finalize grace, but only
  once real plain content has arrived (`hasPlainContent`);
- `TURN_TIMEOUT_MS` (default 120s) hard cap; `error` frame → reject;
- streaming: emit deltas via a callback the HTTP layer turns into SSE chunks.

This logic is documented as fiddly; it gets dedicated unit tests driven by recorded frame
sequences (see TESTING notes in tasks).

### D8 — Configuration (agent catalog)  (CSP-14)
YAML file (`config.yaml`, mounted) + env overrides:
```yaml
listen: ":8080"
hostDataRoot: "/abs/host/path/data/agents"   # HOST_DATA_ROOT (bind-mount source root)
containerDataRoot: "/data/agents"            # where the same dir is mounted in this proxy
network: "zombie-crab-project_zombie_net"
picoclawImage: "docker.io/sipeed/picoclaw:latest"
picoclawPort: 18790
startupDeadline: "60s"
turnTimeout: "120s"
agents:
  alpha:
    serviceName: "picoclaw-alpha"      # matches x-mycelium-service-name
    token: { env: "MYC_PICOCLAW_ALPHA_TOKEN" }
    template: "alpha"                  # templates/alpha
    mode: "scale-to-zero"              # or "continuous"
    idleTimeout: "15m"
  beta:
    serviceName: "picoclaw-beta"
    token: { env: "MYC_PICOCLAW_BETA_TOKEN" }
    template: "beta"
    mode: "scale-to-zero"
    idleTimeout: "15m"
```
Mode/timeout are per agent for the MVP; a future refinement can override per user.

### D9 — HTTP surface  (CSP-03, 11, 12, 13)
`net/http`, parity with `server.js`:
- `POST /v1/chat/completions` — auth (bearer matches agent) → resolve email (401 if none) →
  require `session_id` (400) → `EnsureRunning` → `runTurn` → JSON or SSE. **Cold-start vs
  mycelium `gatewayTimeout=60`:** `startupDeadline` is set to ~35s (comfortably under 60) so a
  cold start never races mycelium's 504. For `stream:true`, **flush the SSE 200 headers + the
  initial `{role:"assistant"}` chunk BEFORE `EnsureRunning`** (server.js ordering) so the
  connection is held open through the cold start. A non-streaming cold start that exceeds
  `startupDeadline` returns `502` (documented; clients should prefer `stream:true`).
- `GET  /v1/models` — static OpenAI list.
- `GET  /v1/sessions/history?session_id=` — resolve email → compute key → scan that user's
  `${CONTAINER_DATA_ROOT}/<agent>/<userhash>/workspace/sessions/*.meta.json` for
  `scope.values.chat == "direct:pico:<key>"` → read the `.jsonl`, keep only string
  user/assistant turns.
- `GET  /healthz` — unauthenticated; reports proxy liveness (and optionally per-request-agent
  container health). Used by mycelium's health dispatcher (`healthCheckPath="/healthz"`).

### D10 — External wiring changes
- **mycelium/config.standalone.toml**: both `picoclaw-alpha` and `picoclaw-beta` services set
  `host = "crab-shell-proxy:8080"` (was the per-agent sidecar). Paths/secrets/`protectedByRoles`
  unchanged. (Two service keys retained so `x-mycelium-service-name` distinguishes the agent.)
- **docker-compose.yaml**: remove the 4 picoclaw*/picoclaw*-proxy services; add `crab-shell-proxy`
  (build `./crab-shell-proxy`, mount docker.sock + data root, env HOST_DATA_ROOT/tokens,
  healthcheck `/healthz`, on `zombie_net`). `mycelium-gateway.depends_on` → `crab-shell-proxy`.
- **.env / .env.example**: add `HOST_DATA_ROOT`, keep `MYC_PICOCLAW_*_TOKEN`.

---

## 3. crab-shell-proxy repo layout (Go)

```
crab-shell-proxy/
  go.mod
  cmd/crab-shell-proxy/main.go      # wire config → manager → http server
  internal/config/config.go         # D8 schema load + env resolve
  internal/identity/identity.go     # D2 IdentityResolver + fallbackResolver
  internal/identity/identity_test.go
  internal/docker/manager.go        # D4/D5/D6 lifecycle (Docker SDK)
  internal/docker/reconcile.go      # D6 boot reconcile + continuous ensure
  internal/pico/turn.go             # D7 Pico-WS client (server.js port)
  internal/pico/turn_test.go        # recorded-frame parity tests
  internal/httpapi/handlers.go      # D9 OpenAI surface
  internal/httpapi/sse.go
  internal/history/history.go       # D9 sessions/history scan
  Dockerfile                        # multi-stage golang build → slim runtime, runs as ROOT
                                    # (uid 0): needs docker.sock (root:docker 660), must read
                                    # root-owned 0600 template files, and write bind-mount dirs
                                    # root-running picoclaw then reads. A nonroot image fails all
                                    # three at runtime. debian-slim runtime (not distroless).
  README.md
```
Module path: `github.com/sgelias/crab-shell-proxy` (private). Built entirely inside Docker (no
host Go toolchain); `go test ./...` runs as a Dockerfile stage so CI/`docker build` exercises it.

---

## 4. Risks / open items

- **R1 (highest):** Pico-WS completion logic parity — mitigated by D7 unit tests against
  recorded frames captured from a live picoclaw.
- **R2:** Docker socket privilege — documented; acceptable for this dev/self-host stack, flagged
  for production hardening.
- **R3:** Reconcile of continuous containers with no traffic depends on the per-user data dir
  already existing — a brand-new continuous user still needs one API call (or an operator
  pre-seed) to first materialize the dir. Documented limitation.
- **R4:** Go toolchain absent locally → all build/test verification happens via `docker build` /
  `docker compose build`. Execution gate uses container builds, not host `go`.
- **R5:** Submodule/private-repo creation is an operator step (not done unilaterally); until then
  the code lives as a plain `crab-shell-proxy/` dir with its own `git init`.
```
