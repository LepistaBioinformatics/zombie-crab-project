# crab-shell-proxy Tasks

Verification note (R4): no host Go toolchain — the gate for every code task is
`docker build ./crab-shell-proxy` succeeding through its `go vet` + `go test ./...` stage.
Runtime gates use `docker compose up` + curl with a hand-crafted `x-mycelium-profile`.

## Status (updated after implementation)

T01–T12 **DONE**. `docker build --network=host ./crab-shell-proxy` passes vet + all tests across
config, identity, pico, history, docker, httpapi. Compose validates (`docker compose config -q`).
Runtime smoke test (built image, real Docker socket): boot OK, `/healthz` 200, `404`/`401`/`400`
error paths correct, and a **valid zstd+base64 profile** decodes → email → session validation →
provisioning (fails cleanly with a 502 "seed config.json" because templates aren't seeded — the
expected operator step, not a bug).

**Docker client (`internal/docker/client.go`) verified against a REAL daemon** via the
`//go:build integration` test (`go test -tags integration ./internal/docker`, run in a golang
container with `/var/run/docker.sock` mounted): `EnsureImage` (pull + present-fast-path),
`Create` (bind + network + labels + cmd), `Start`, `Inspect`, `List`-by-label, `Stop`, `Remove`
all round-trip correctly through the hand-written raw-HTTP encoding — using a throwaway `alpine`,
no picoclaw/LLM keys needed. This is the riskiest new code and is now proven end to end.

T13 (full picoclaw spawn + real LLM reply, scale-to-zero/continuous lifecycle over live
containers) is **OPERATOR-GATED**: it needs the config-only templates seeded at
`data/agents/templates/{alpha,beta}` (root-owned files + real API keys — see compose comment) and
the stack brought up. Lifecycle/single-flight/idle-timer logic is covered by unit tests against a
faked Docker; the live-container leaf remains to be exercised by the operator.

Legend: `[P]` = parallelizable with siblings at the same depth.

---

## Phase 0 — Scaffold

### T01 — Go module + repo skeleton
- **What:** `crab-shell-proxy/` dir, `go.mod` (`github.com/LepistaBioinformatics/crab-shell-proxy`, Go 1.23),
  package dirs per design §3, `git init`, `.gitignore`, minimal `main.go` that loads config and
  serves `/healthz`.
- **Done when:** `docker build ./crab-shell-proxy` succeeds; container answers `/healthz` 200.
- **Reuses:** —  **Depends on:** —  **Maps:** CSP-13

### T02 — Multi-stage Dockerfile with test stage
- **What:** golang build stage running `go vet ./...` and `go test ./...`; slim runtime stage.
- **Done when:** `docker build` fails if a test fails (verified by a temporary failing test).
- **Depends on:** T01  **Maps:** R4

---

## Phase 1 — Core libraries (parallelizable)

### T03 [P] — Config loader (D8)  — CSP-14
- **What:** `internal/config`: YAML + env-var resolution (`{env: VAR}`), agent catalog, durations,
  data roots, network, image.
- **Done when:** unit test loads a sample config, resolves a token from env, parses durations,
  errors on unknown agent mode.
- **Depends on:** T01

### T04 [P] — Identity resolver (D2)  — CSP-04, CSP-18
- **What:** `internal/identity`: `IdentityResolver` iface + `fallbackResolver`
  (base64→zstd→json→principal email); `UserHash(email)`.
- **Done when:** unit test decodes a real captured `x-mycelium-profile` value → expected email;
  empty/garbage → `""`; `UserHash` stable + Docker-name-safe.
- **Depends on:** T01

### T05 [P] — Pico-WS turn client (D7)  — CSP-03, R1
- **What:** `internal/pico`: port `server.js` `runTurn` (thought/tool_calls/placeholder filter,
  typing grace, 500 ms finalize, turn timeout, streaming callback).
- **Done when:** `turn_test.go` replays recorded frame sequences (plain answer; answer
  interleaved with tool_calls; typing stop/start churn) and asserts final text + delta order
  match server.js semantics.
- **Depends on:** T01

### T06 [P] — History scan (D9)  — CSP-12
- **What:** `internal/history`: `.meta.json` scope-marker scan + `.jsonl` read (string
  user/assistant turns only), parity with server.js.
- **Done when:** unit test over a fixture sessions dir returns expected ordered messages;
  missing dir → empty.
- **Depends on:** T01

---

## Phase 2 — Orchestration

### T07 — Docker lifecycle manager (D4/D5/D6)  — CSP-01,02,05,06,07,15,16,17
- **What:** `internal/docker`: `EnsureRunning` (single-flight, inspect/create/start,
  per-user provisioning per D5, health-poll, startup-deadline cleanup), idle-timer arm/stop,
  stop/request race mutex, labels, Docker-unreachable → error not panic.
- **Done when:** build + vet pass; unit tests cover name/label building, provisioning file copy
  + token injection (over a temp dir), single-flight (one create under N concurrent calls, faked
  Docker iface). Runtime verified in T12.
- **Depends on:** T03, T04
- **Tests:** table + concurrency test with a `DockerClient` interface fake.

### T08 — Reconcile + continuous ensure (D6)  — CSP-08,09,10
- **What:** `internal/docker/reconcile.go`: boot adoption of `crab-shell.managed` containers,
  re-arm scale-to-zero timers, continuous-agent startup ensure by walking existing per-user dirs.
- **Done when:** unit test (faked Docker + temp dirs) adopts running, re-arms only scale-to-zero,
  starts continuous.
- **Depends on:** T07

---

## Phase 3 — HTTP surface + wiring

### T09 — OpenAI HTTP handlers (D9)  — CSP-03,04,11,13
- **What:** `internal/httpapi`: `/v1/chat/completions` (auth→email→session_id→EnsureRunning→turn,
  JSON + SSE), `/v1/models`, `/healthz`; agent+token resolution from headers (D1).
- **Done when:** handler unit tests (httptest) with a faked manager: 401 no profile, 400 no
  session_id, 200 JSON, SSE framing correct, 502 on manager error.
- **Depends on:** T05, T07

### T10 — sessions/history endpoint (D9)  — CSP-12
- **What:** `/v1/sessions/history` handler wiring T06 to the per-user dir.
- **Done when:** httptest returns messages for a fixture; 401 no profile; 400 no session_id.
- **Depends on:** T06, T09

### T11 — main wiring (D3-D9)
- **What:** `cmd/.../main.go`: config → resolver → manager → reconcile → http; graceful shutdown.
- **Done when:** `docker build` green; container boots, `/healthz` 200, reconcile logs on start.
- **Depends on:** T08, T09, T10

---

## Phase 4 — Stack integration (sequential, runtime-verified)

### T12 — docker-compose + mycelium config + env (D10)
- **What:** remove 4 picoclaw*/proxy services; add `crab-shell-proxy` (docker.sock + data root
  mounts, HOST_DATA_ROOT, tokens, healthcheck, zombie_net); point both mycelium services'
  `host` at `crab-shell-proxy:8080`; seed `data/agents/templates/{alpha,beta}`; update
  `.env.example`.
- **Done when:** `docker compose config` valid; `docker compose up -d` healthy.
- **Depends on:** T11  **Maps:** CSP-01, D10

### T13 — Runtime verification (P1 + P2) — direct to crab-shell-proxy
- **Ceiling (STATE.md L-006):** a request *through mycelium* needs an account holding the
  `alpha`/`beta` guest role (Staff→tenant→subscription→invite chain M3 hasn't built), so the
  achievable gate is a **hand-crafted `x-mycelium-profile` + `x-mycelium-service-name` header
  hitting crab-shell-proxy directly** (bypassing mycelium). Do NOT claim a mycelium-path e2e.
- **What:** with hand-crafted headers, exercise: two emails → two containers + volumes (CSP-05);
  chat reply streams (CSP-03);
  idle stop + cold restart with data intact (CSP-06/07); continuous stays up across timeout +
  restart (CSP-09/10); history renders (CSP-12).
- **Done when:** each acceptance test in spec §Success Criteria observed; results logged in STATE.
- **Depends on:** T12  **Maps:** all P1/P2 CSP IDs

---

## Dependency graph

```
T01 ─┬─ T02
     ├─ T03 ─┐
     ├─ T04 ─┼─ T07 ─ T08 ─┐
     ├─ T05 ─┼──────── T09 ─┼─ T11 ─ T12 ─ T13
     └─ T06 ─┴──────── T10 ─┘
```

Parallel batches: {T03,T04,T05,T06} after T01; T07 after T03,T04; T09 after T05,T07.
