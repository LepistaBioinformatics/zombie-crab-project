# harness-sphere-integration — Tasks

Read `spec.md` and `design.md` first. Nothing here restates their reasoning.

## Status (2026-09-07)

**Groups A and B are implemented and open as draft PRs.** They are independent and were
built in parallel, as the build order below intends.

| Group | Repo | PR | State |
|---|---|---|---|
| A | `harness-sphere` | [#21](https://github.com/LepistaBioinformatics/harness-sphere/pull/21) `feat/zombie-crab-exclusive` | draft — T-01…T-05 done |
| B | `crab-shell-proxy` | [#38](https://github.com/LepistaBioinformatics/crab-shell-proxy/pull/38) `feat/instance-inventory` | draft — T-06…T-08 done |
| — | `zombie-crab-project` | [#58](https://github.com/LepistaBioinformatics/zombie-crab-project/pull/58) `docs/harness-sphere-specs` | draft — these documents |

**Not started:** Group C (blocked on A and B merging), Group D (needs a live stack),
Group E. One deviation is recorded, at T-08.

**Gate for every `harness-sphere` task:** `cargo build`, `cargo test`, `cargo clippy`
and `cargo fmt --check` clean, plus `cargo audit` (the repo already runs it in CI).
**Gate for every `crab-shell-proxy` task:** `go build ./...`, `go vet ./...`,
`go test -race ./...` green.
**Gate for every `zombie-crab-project` task:** `docker compose config` parses, and
`.github/workflows/submodule-pointers.yml` passes on the PR.

## Build order, and why it is this one

**A ∥ B → C → D → E.**

Groups A and B are **independent and can be in review at the same time** — they live in
different repositories and neither imports the other. That is the whole reason the proxy
endpoint is in F1 rather than F2 (spec FR-P8): it has the longest merge chain, so starting
it early takes it off the critical path.

Group C cannot open for merge until both A and B are on their default branches
(spec FR-M7). Opening it early *for review* is allowed by
`.claude/rules/submodule-pointers.md`, provided the PR body says which pointers are branch
heads — the CI check is what holds, not the convention.

Group D is operator-gated and needs a live deployment. It is not optional: spec FR-V2–V5
are the reason this feature exists in the shape it does, and shipping C without D leaves
F2 designing against inference — the exact failure DEC-5 was written to prevent.

**FR-V1 is already discharged** (`spec.md`, measured 2026-09-07); no task covers it.

Commits: one per task where the task stands alone, one per group otherwise. A, B and C are
three separate PRs in three repositories by construction.

---

## Group A — `harness-sphere` becomes this stack's tool (upstream repo)

### T-01 — state the exclusivity in the project documents. DONE (2026-09-07).
- **What:** rewrite `.specs/project/PROJECT.md`'s Vision, "Target stack" and Non-goals to
  name zombie-crab; add a banner to `README.md`. Record the adoption in the repo's own
  `STATE.md`, cross-referencing this stack's AD-022.
- **Why first:** every later task in this group is easier to review against a document
  that already says what the tool is for. It is also the cheapest place to discover that
  the maintainer meant something narrower than what was specified.
- **Note:** F1 does **not** delete the seven-layer tables from the README — that is F2's
  FR-R7, after the layers actually change. Prose only.
- **Satisfies:** FR-M4.

### T-02 — delete the crates.io publishing workflow. DONE (2026-09-07).
- **What:** remove `.github/workflows/publish-crates.yml`. Leave `release-pr.yml`,
  `release.yml` and `audit.yml` untouched. Drop the "so the crates are publishable to
  crates.io" justification comment on the workspace `version` fields; **keep the fields**
  — `cargo set-version` and the release flow use them.
- **Why:** DEC-7. Five generic crate names on a public registry contradict an exclusive
  tool, and the registry is the one publication that cannot be cleanly withdrawn.
- **Satisfies:** FR-M5.

### T-03 — add the Dockerfile. DONE (2026-09-07).
- **What:** two-stage build per design DEC-17 — builder on the pinned toolchain,
  `--features otlp` (no `ingest`, no `prometheus`), runtime stage minimal with a
  **non-root** user, binary only.
- **Watch for:** do **not** set `panic = "abort"` to shrink the image. The workspace
  `Cargo.toml` keeps `panic = "unwind"` deliberately, because FR-RES-03's `catch_unwind`
  containment depends on it. Shrinking the binary by breaking the resilience contract is
  the one tempting mistake here.
- **Done:** 131MB image; `id` inside it is `uid=10001(harnesssphere) gid=10001`; it boots
  `sources=3 receivers=0 exporter=stdout` and reports the host's memory
  (`system.memory.usage{used} = 10369028096`).
- **Incidental confirmation of FR-C5, worth keeping:** the run also emitted
  `harnesssphere.endpoint.up = 0` for `mycelium-gateway:8080` — unreachable, because the
  test container was not on `zombie_net`. An unreachable target therefore yields an honest
  zero rather than a dead collector, which is FR-C5's argument demonstrated instead of
  reasoned.
- **Satisfies:** FR-C6, FR-C2 (image half).

### T-04 — add `config.zombie-crab.toml`. DONE (2026-09-07).
- **What:** `host` and `self` intervals; `probe_targets` = `mycelium-gateway:8080`,
  `crab-shell-proxy:8080`, `chat-webapp:3000`. `container_cgroup`, `container_id`,
  `prometheus_scrape_url` and `watch_processes` left empty.
- **`session_dir` ships EMPTY.** It is set at deploy time by the operator, for T-14 only,
  with an inline comment saying it is a probe and not a deployment posture. A development
  checkout has no `tenants/` tree — local `data/` holds only `templates/` — so a committed
  path would resolve nowhere. **This is the seam where Group C's gate and FR-H4 part
  company:** `docker compose config` parses with the value unset, so nothing in the merge
  gate notices FR-H4 is unmet. It is discharged at T-14 and nowhere earlier.
- **Watch for:** `chat-webapp` is the **compose service name**; the repository is called
  `crab-exoskeleton-webapp` and that name does not resolve on `zombie_net`. This is the
  single most likely typo in the whole feature.
- **No secret goes in this file** (design DEC-19).
- **Depends on:** nothing.
- **Satisfies:** FR-H1–FR-H4, FR-C5 (no ordering needed).

### T-05 — confirm no Rust changed. DONE (2026-09-07) — `git diff --stat` over `crates/**` and `harnesssphere/src/**` is empty.
- **What:** `git diff --stat` on the group's branch shows no file under `crates/` or
  `harnesssphere/src/`.
- **Why it is a task and not an assumption:** DEC-5 is the property that makes Group D's
  results interpretable. A stray "while I was in there" edit costs the feature its
  falsifiability, and it is invisible unless someone looks.
- **Satisfies:** FR-H5.

---

## Group B — `GET /v1/instances` (`crab-shell-proxy`, independent of Group A)

### T-06 — the operator credential. DONE (2026-09-07).
- **What:** a new config value with a `CRAB_*` env override, absent by default;
  constant-time comparison. **When unset, the route is not registered** (design DEC-15) —
  not registered-and-401.
- **Why this and not `resolveAgent`:** design DEC-15. The short version: the profile
  header is decoded, never verified (`identity.go:67`), so an agent token is the sole gate
  on chatting as any member — a telemetry component must not hold one. And the endpoint is
  cross-agent while `resolveAgent` is single-agent, so there is no principled token to pick.
- **Done when:** with the value unset, the route 404s (absent); with it set, a wrong
  credential 401s and the right one succeeds; an **agent** token does not authorize it.
- **Satisfies:** FR-P4.

### T-07 — the handler. DONE (2026-09-07).
- **What:** `GET /v1/instances` returning the union of `docker.List(crab-shell.managed=true)`
  and the on-disk workspace glob, each entry carrying the tuple, container name, mode and a
  state from a **closed set** (running / stopped / provisioned-without-container /
  container-without-directory). Stable envelope, empty list never `null`.
- **Watch for — the requirement most likely to be violated by accident:** no container side
  effects. Do not call `EnsureRunning`, `provision`, `resolveAndMaterialize`, or anything
  reachable from them. A telemetry read that cold-starts an agent is a defect. If serving
  this needs a new registry, cache or background scan, the design has been misread — both
  halves already exist for `Reconcile`.
- **Depends on:** T-06.
- **Satisfies:** FR-P1, FR-P2, FR-P3, FR-P5, FR-P6.

### T-08 — tests, and the OpenAPI entry that was NOT added. DONE (2026-09-07).
- **What:** tests over the four states using the existing `Docker` fake (the interface is
  declared at the consumer precisely so tests can supply one), plus assertions that no
  lifecycle method is invoked.
- **Done:** 10 tests — 6 in `internal/httpapi` (including "an agent token must not open
  this route" and the no-side-effects check) and 4 in `internal/docker` (the union across
  both surfaces; the tuple coming from labels rather than the name). `go build`, `go vet`
  and `gofmt` clean on every file touched.
- **SPEC_DEVIATION — the route was deliberately NOT added to `/doc/openapi.json`.**
  That document is served **unauthenticated** and exists for mycelium tool discovery — its
  own description says the operations in it are exposed "as a discoverable tool". This
  route does not go through mycelium (harness-sphere calls the proxy directly on
  `zombie_net` with its own credential) and is not a member tool, so listing it there
  would publish the existence of a topology endpoint for free, to anyone who can fetch the
  document. Adding it would have contradicted DEC-15's whole reason for existing. Flagged
  on the PR as reversible if the maintainer disagrees.
- **Pre-existing failures, confirmed unrelated:** five tests in `internal/docker`
  (`TestScaleToZeroIdleStop`, `TestContinuousDoesNotArmIdle`,
  `TestReconcileEnsuresContinuousWorkspaces`, `TestEnsureRunningRecreatesOnPersonaDrift`,
  `TestEnsureRunningRecreatesOnImageDrift`) fail with `lchown: operation not permitted` —
  they need root. **Reproduced identically on a pristine clone of `main`** before being
  called pre-existing.
- **Satisfies:** FR-P7 (by demonstration).

---

## Group C — wire it into the stack (`zombie-crab-project`)

**Blocked on A and B both merged to their default branches** (FR-M7). CI enforces it.

### T-09 — add the submodule
- **What:** `crab/harness-sphere`, `.gitmodules` entry in the **absolute HTTPS** form.
- **Watch for:** the relative form (`../name.git`) is the *marketing* repo's convention.
  Both existing entries here are absolute HTTPS; copy those.
- **Satisfies:** FR-M1, FR-M2, FR-M3.

### T-10 — the compose service
- **What:** per design DEC-18 — `zombie_net`, `restart: unless-stopped`, non-root user,
  data root bound `:ro`, exporter by env. **No `ports`, no `depends_on`, no
  `/var/run/docker.sock`, no `/proc`, no `/sys`.**
- **Also:** `docker-compose.prod.yaml` override to the pinned
  `ghcr.io/lepistabioinformatics/harness-sphere:${HARNESS_SPHERE_TAG}` image.
- **Satisfies:** FR-C1–FR-C3, FR-C5, FR-C7.

### T-11 — env plumbing
- **What:** inline `${VAR:-default}` in compose plus entries in the **tracked**
  `deploy/standalone/.env.example` and `deploy/prod/.env.example`.
- **Watch for:** `.env` is gitignored and untracked here — a requirement written against it
  cannot be committed. The examples are the tracked surface.
- **Satisfies:** FR-C8.

### T-12 — bump the proxy pointer and record the chain
- **What:** advance `crab/crab-shell-proxy` to Group B's merge commit; add the third
  submodule and its merge order to `.claude/CLAUDE.md`.
- **Satisfies:** FR-M6, FR-M7 step 3.

---

## Group D — verification (operator-gated, needs a live stack)

This group cannot run from a development checkout: the local `data/` tree holds only
`templates/` and no `tenants/`, so there is no workspace to measure.

### T-13 — FR-V2, probes from inside the network
- **What:** `harnesssphere.endpoint.up` = 1 for all three targets.
- **Also run the restart case:** `docker compose restart harness-sphere` alone, with the
  targets already up. Both orderings should give the same answer given design DEC-18's
  reasoning; a disagreement falsifies it.

### T-14 — FR-V3, does `SessionCollector` parse this stack's transcripts
- **Depends on:** T-04 (which ships `session_dir` empty) and a live stack with at least one
  provisioned workspace. This task is where FR-H4 is actually discharged.
- **What:** set `session_dir` to a real workspace and report on **each of the three
  predicted distortions by name** — `durable/` exclusion, cron-run inflation, and the
  measured cost of the full re-read. A bare "it parsed" does not discharge this.
- **Why it is the most valuable task in the group:** it is the input to F2's DEC-13, which
  is the largest single piece of work in the whole effort.

### T-15 — FR-V4, the real cardinality
- **What:** with T-07 live, record the actual count of workspaces and containers.
- **Feeds:** F2 OQ-7 (discovery interval) and spec OQ-1 (backend choice).

### T-16 — FR-V5, privilege, asserted at runtime
- **What:** against the **running** container, confirm the effective user is not root and
  `/var/run/docker.sock` is absent from its mounts. Read off the container, not off the
  compose file — the compose file is the claim, not the evidence.

---

## Group E — `zombie-crab-project-mkt`

### T-17 — pointer bump
- **What:** advance `modules/zombie-crab-project` to Group C's merge commit.
- **Blocked on:** C merged. Its own `submodule-pointers.yml` enforces this.

---

## Not in this feature

Recorded so they are not picked up by mistake:

- Metric pruning, `Layer` remapping, deleting `prometheus.rs` / `ingest` — **F2**.
- Dynamic instance discovery and per-instance collection — **F2**.
- Harness-sphere *consuming* `GET /v1/instances` — **F2**. F1 ships the endpoint unused,
  deliberately (FR-P8).
- Choosing an OTLP backend — spec OQ-1, deferred until T-15 produces a cardinality number.
- Renaming the repository or binary — spec OQ-3.
