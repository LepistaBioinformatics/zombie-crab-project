# harness-sphere-integration — Spec

**Status:** SPEC. Not implemented. One verification item, FR-V1, is already DISCHARGED —
it was settled by experiment during specification rather than deferred to deployment.
**Spans:** `zombie-crab-project` (compose service, submodule pointer) +
`crab/crab-shell-proxy` (one new read endpoint) + `harness-sphere` (configuration and
project documents only — **no Rust code changes in this feature**, see DEC-5).
**Date:** 2026-09-07.
**Successor:** `harness-sphere-zombie-crab-scope` (F2), which prunes the tool's scope and
teaches it dynamic instances. **This feature exists to answer F2's empirical questions**,
and its verification section is therefore the point of it, not a formality.
**Upstream:** https://github.com/LepistaBioinformatics/harness-sphere @ `main` (v0.2.0).

## Problem

**This stack emits no telemetry at all.** Not "not enough" — none. A strict grep for
`prometheus|opentelemetry|go\.opentelemetry|otelhttp|promhttp|\botel\b` across every file
type in this repository and both submodules returns **zero hits**; `go.mod` carries no
telemetry dependency and `crab-exoskeleton-webapp/package.json` has neither
`@opentelemetry/*` nor `prom-client`.

What exists instead:

- Three health endpoints: `GET /healthz` on the proxy (`internal/httpapi/handlers.go:419`),
  `GET /health` on mycelium, `GET /health` on each picoclaw (`:18790`, recorded surface is
  `/health`, `/ready`, `/reload` only).
- Unstructured printf logs. `main.go` builds
  `log.New(os.Stdout, "crab-shell-proxy ", log.LstdFlags|log.Lmsgprefix)` and threads it
  everywhere as `logf func(format string, args ...any)`. **No levels, no JSON, no
  request/correlation id.** One access-log line per request from `withLogging`
  (`handlers.go:462`), which records method, path, status, rounded duration and the
  service name — and deliberately skips `/healthz`.
- No metrics endpoint, no traces, no aggregation, no dashboard, no alerting, and no
  monitoring service anywhere in `docker-compose.yaml` or `docker-compose.prod.yaml`.

The gap this leaves is specific to what this stack *is*. `crab-shell-proxy` spawns one
picoclaw container **per (tenant, subscription, agent, user)** — containers that are not
in compose, that outlive `docker compose up`, and that nothing counts. Today nobody can
answer:

- How many agent containers are running right now, and for whom?
- Which tenant is consuming the host's memory?
- Did a cold start miss its 35s `startupDeadline`, and how often?
- Is a workspace's container up but its harness wedged?
- Is the host itself about to run out of RAM before any of this degrades?

Every one of those is invisible, and the stack's answer to all of them today is to read
`docker ps` by hand and correlate it against a stdout log with no request ids.

## Goals

- `harness-sphere` is a submodule of `zombie-crab-project` and runs as a service in the
  stack, exporting OTLP.
- The host, the watcher itself, the gateway, the proxy and the webapp are observable with
  no code change to any of them.
- **The questions F2 depends on are answered by measurement, not by reasoning.** One
  (FR-V1) was settled at the desk during specification; the rest need a live deployment.
  See "Verification".

## Non-goals

- **No metric pruning and no scope reduction.** The tool lands as it is. Deleting
  `prometheus.rs` / `ingest`, remapping `Layer`, and cutting the metric set are all F2.
- **No dynamic instance discovery.** F1 observes what static TOML can name: the host, the
  watcher, and the fixed compose services. Per-user picoclaw containers are **out of scope
  for F1** and are the whole point of F2.
- **No changes to picoclaw.** The four patches in `deploy/picoclaw-glob/` add no
  instrumentation and this feature adds none. Picoclaw stays a black box observed from
  outside.
- No changes to `crab-exoskeleton-webapp`.
- No alerting, no SLOs, no on-call routing.
- No renaming of the `harness-sphere` repository, its binary, or its crates. See DEC-7.

## Decisions

### DEC-1 — The upstream repository is repurposed in place, not forked (user-directed)

Asked directly, the maintainer chose to modify `LepistaBioinformatics/harness-sphere`
itself rather than fork it and leave a generic tool upstream.

**What made this cheap, checked rather than assumed:** the repository has **0 stars, 0
forks, 0 watchers, 0 open issues**, and `harnesssphere` **does not exist on crates.io**
(the `publish-crates` workflow is manual and was only ever dry-run — its own STATE.md
says "real publish not yet run"). The only published artifacts are GitHub binary releases
through v0.2.0. **There is no external consumer to break.**

**The cost, stated so it is not discovered later:** the generic seven-layer vision in
`harness-sphere/.specs/project/PROJECT.md` — "every layer of a host running the
Claw/Harness ecosystem" — stops being true the moment F2 lands. A future need for a
generic watcher means forking *back out*, from a tree that has had a third of its
collectors deleted. That is accepted knowingly.

### DEC-2 — It runs as a compose service on `zombie_net`, not as a host binary

This contradicts harness-sphere's own first design principle ("single binary, static and
portable", which reads as a systemd unit on the host), and it is not a preference.

**The picoclaw instances publish no host ports.** `manager.go`'s `CreateSpec` sets no
port bindings, and `18790` is reachable only on `zombie_net`. The proxy's `18080` is
loopback-only and explicitly marked TEMPORARY in `docker-compose.yaml` —
`docker-compose.prod.yaml` drops it with `ports: !reset []`. So a binary running on the
host cannot probe the agent layer at all, and in production cannot probe the proxy either.
A watcher that cannot see the layer it exists for is not a watcher.

**The host layer survives the move, which is the objection this would otherwise raise.**
`HostCollector` reads through `sysinfo::System` (`crates/collectors/src/host.rs:10,26`),
which reads `/proc/meminfo` and `/proc/stat` — and in Docker those files are **not
namespaced**: a container reads the host's values. So "hospedeiro" works from inside the
container **with no `/proc` or `/sys` bind at all**. This is **not** an inference from the
collector's source — it was measured before this spec was finished, against a container
capped at 512 MB that reported the host's 33 GB anyway. See FR-V1, which is discharged.

### DEC-3 — Instance identity comes from the proxy, not from a second Docker socket (user-directed)

The container name is `crabshell-<role>-<sha256(tenant::subs::user)[:16]>`
(`manager.go:139-149`). The hash is one-way, and the code says so in its own comment:
*"tenant/subscription/user are recovered from the container labels and the
.crab-owner.json marker, not the name."* So anything wanting per-tenant attribution of a
running container needs either the Docker API or someone who already has it.

`crab-shell-proxy` already has it. It mounts `/var/run/docker.sock` and runs as root — it
is the most privileged service in the stack. Giving **harness-sphere its own socket mount
would create a second one**, doubling the blast radius of the stack's worst-case
compromise to gain a mapping the proxy already holds in memory.

Asked to choose, the maintainer took the read-only inventory endpoint. Harness-sphere
stays the collector; the proxy answers one question it is uniquely able to answer.

**What this does not buy:** the inventory names containers; it does not carry cgroup
counters. F2 must still get per-container CPU/memory from somewhere, and DEC-3
deliberately leaves that open rather than pre-deciding it — see OQ-2.

### DEC-4 — Attribution is the full tuple; `session_id` is never a metric attribute (user-directed)

Every instance-scoped metric carries `crab.tenant`, `crab.subscription`, `crab.agent`,
`crab.user`. That is one series per container, which is exactly the granularity the stack
already creates, and it is the only granularity that answers "which user is burning the
host" in a multi-tenant deployment.

**`session_id` is excluded by rule, not by omission.** Conversations grow without bound
and **nothing prunes them** — the repository already records this defect against the
in-memory registry (`background-turn-dock/spec.md:446`, OQ-3). A conversation-keyed metric
would inherit an unbounded key space from a component that is known not to reap it.

The `crab.user` label is the mycelium **account UUID**, never the email. The proxy already
draws this line: the email is kept only in `.crab-owner.json` for operator traceability,
and identity resolution yields `Profile.accId`.

### DEC-5 — F1 changes no Rust in harness-sphere, and that is what makes it falsifiable

It would be faster to prune and rewire in one pass. It would also mean the first run
against the stack tests a tree that no longer resembles the one whose behaviour is
documented, so a failure would have two candidate causes.

F1 ships **configuration only** into harness-sphere: a `config.zombie-crab.toml`, a
`Dockerfile`, and project-document edits. Everything that stops working is then either a
deployment fact or a genuine upstream limitation — and both are exactly what F2 needs to
know.

### DEC-6 — The vendored SigNoz stack is not brought into this repository

`harness-sphere/deploy/signoz/` vendors a full SigNoz deployment (ClickHouse, collector,
dashboards) and was verified end-to-end upstream. It stays inside the submodule, unused by
`docker-compose.yaml`. This stack's compose gains **one** service.

**Where the signals go in F1 is deliberately left to the operator** via
`HARNESSSPHERE_EXPORTER` / `otlp_endpoint` — `stdout` proves the pipeline with no backend
at all, and pointing it at the vendored SigNoz is one env var. Choosing and hardening a
backend is neither F1 nor F2.

### DEC-7 — crates.io publishing is disabled; the name and binary are kept

`publish-crates.yml` is removed and the workspace `version` fields lose their
"publishable" justification. Five generically-named crates (`harnesssphere-domain`,
`-collectors`, `-runtime`, `-export`, `-ingest`) on a public registry contradict a tool
that is exclusive to one stack, and the registry is the one publication that cannot be
withdrawn cleanly.

Binary releases (`release-pr.yml` / `release.yml`) are **kept** — they are how the image
gets a pinned artifact.

The repository, the binary and the crates keep their names. Renaming is outward-facing,
breaks the release pipeline, and can be done later at the same cost; doing it now would
mix a rename into the one change whose failures must stay legible.

## Requirements

### Submodule and repository (FR-M)

**FR-M1** `harness-sphere` is added as a submodule of `zombie-crab-project` at
`crab/harness-sphere`, alongside `crab/crab-shell-proxy` and
`crab/crab-exoskeleton-webapp`.

**FR-M2** The `.gitmodules` entry uses the **absolute HTTPS** form
(`https://github.com/LepistaBioinformatics/harness-sphere.git`), matching the two existing
entries in this repository. The relative form (`../name.git`) is the *parent* marketing
repository's convention and must not be copied down.

**FR-M3** The pointer names a commit reachable from `harness-sphere`'s default branch, per
`.claude/rules/submodule-pointers.md`. On first add this is trivially satisfied
(`main` @ v0.2.0). It is enforced by `.github/workflows/submodule-pointers.yml`, so a
violation cannot merge regardless of what any instruction file says.

**FR-M4** `harness-sphere/.specs/project/PROJECT.md` states the exclusivity: the vision,
the "Target stack" and the non-goals name `zombie-crab` and stop claiming a generic
Claw/Harness ecosystem. `README.md` gains a banner to the same effect.

**FR-M5** `.github/workflows/publish-crates.yml` is deleted (DEC-7). `release-pr.yml`,
`release.yml` and `audit.yml` are untouched.

**FR-M6** This repository's `.claude/CLAUDE.md` records the third submodule and the chain
it introduces, so the merge order stays discoverable from the file that already documents
the other two.

**FR-M7** **The merge chain is four repositories deep and has two independent child
merges gating one parent PR.** Spelled out because `.claude/rules/submodule-pointers.md`
describes a chain with one child at a time, and this feature is the first to have two:

1. `harness-sphere` PR → its `main` (config, Dockerfile, project documents, FR-M5's
   workflow deletion).
2. `crab-shell-proxy` PR → its `main` (FR-P). **Independent of step 1** — neither blocks
   the other, and they can be in review simultaneously.
3. **One** `zombie-crab-project` PR that adds the new submodule at a `main` commit of
   harness-sphere, bumps the `crab-shell-proxy` pointer to its merge commit, and adds the
   compose service.
4. `zombie-crab-project-mkt` pointer bump.

Steps 1 and 2 must both be merged before step 3 can pass
`.github/workflows/submodule-pointers.yml`. Opening step 3 early for review is explicitly
allowed by the rules file, provided the PR body says which pointers are branch heads.

### Deployment (FR-C)

**FR-C1** One new compose service, `harness-sphere`, built from `./crab/harness-sphere`,
joined to `zombie_net`. It publishes **no host ports**.

**FR-C2** It runs as a **non-root** user and mounts **no Docker socket** (DEC-3). If an
implementation task adds `/var/run/docker.sock` to this service, the task is wrong.

**FR-C3** It mounts **no `/proc` and no `/sys`** bind for host metrics (DEC-2 — the
container's own `/proc` is already the host's). A bind may only be added if FR-V1
falsifies this, and then the spec is amended rather than the deployment quietly widened.

**FR-C4** It mounts the proxy's data root **read-only** at a fixed path, for the session
collector. The source is the same host path `CRAB_DATA_ROOT` names for the proxy.

**FR-C5** **No `depends_on` ordering is required, and adding
`condition: service_healthy` would be wrong.** Boot ordering was investigated as a risk —
the runtime probes each source once at startup — and the risk does not exist for the
collectors F1 runs. `EndpointProbeCollector::probe()` (`crates/collectors/src/probe.rs:44`)
**never touches the network**: it returns `Ready` when the target list is non-empty and
`NotApplicable` when it is empty. Reachability is decided per tick inside `collect()`,
which emits `harnesssphere.endpoint.up = 0` for a target that is down and returns `Ok`. So
a gateway that is not yet listening produces an honest `up = 0`, not a dead collector, and
starts reporting `up = 1` on the tick after it comes up.

Ordering `depends_on: service_healthy` would instead delay the watcher until the things it
watches are healthy — which is precisely backwards for a component whose job includes
recording that they were not.

`restart: unless-stopped`, matching the stack's other long-lived services.

**FR-C5a** **`ProbeResult::NotApplicable` permanently drops a source**
(`crates/runtime/src/lib.rs:198-201` — it logs and `return`s from the task). `Unavailable`
does not: it trips the circuit breaker (`trip_open()`) and the collect loop keeps running
under backoff that saturates at 60s, so an `Unavailable` source recovers on its own.

This distinction is recorded here because it is invisible at the call site and it is a
loaded gun for F2: a per-instance source that answers `NotApplicable` is gone for the
process lifetime, which for a dynamically discovered instance means *never watched again
until harness-sphere restarts*. F1 must not introduce a collector that can return
`NotApplicable` for a recoverable condition.

**FR-C6** The image is built from a Dockerfile added to the `harness-sphere` repository,
producing a static binary with the `otlp` feature. `ingest` and `prometheus` features stay
**off** — nothing in this stack pushes OTLP or exposes a Prometheus endpoint.

**FR-C7** `docker-compose.prod.yaml` swaps the build for a pinned
`ghcr.io/lepistabioinformatics/harness-sphere:${HARNESS_SPHERE_TAG}` image, matching how
the other three services are overridden there.

**FR-C8** Every new setting follows the stack's actual env convention, which is **not**
"add it to `.env`": `.env` is gitignored and untracked, so a requirement written against it
cannot be committed. The convention is an inline compose default —
`${HARNESS_SPHERE_TAG:-...}`, as `docker-compose.yaml` already does in 28 places — plus an
entry in the tracked `deploy/standalone/.env.example` and `deploy/prod/.env.example`.

### Proxy inventory endpoint (FR-P)

**FR-P1** `GET /v1/instances` on `crab-shell-proxy` returns every managed workspace: the
tuple (`tenant_id`, `subs_acc_id`, `agent`, `user_acc_id`), the container name, its mode
(`continuous` / `scale-to-zero`), and its Docker state.

**FR-P2** It is **read-only and has no container side effects**. It must not call
`EnsureRunning`, `provision`, `resolveAndMaterialize`, or anything that can create, start,
stop or remove a container. A telemetry read that can cold-start an agent is a defect, not
a feature. This mirrors FR-P7 of `background-turn-dock`, which drew the same line for the
same reason.

**FR-P3** It derives its answer from `docker.List(crab-shell.managed=true)` and the six
labels (`manager.go:21-28`) — the same source `Reconcile` already trusts. It does not
re-derive the tuple from the container name, which is impossible (DEC-3).

**FR-P4** The endpoint is authenticated. It is **not** added to the unauthenticated set —
`/healthz` and `/doc/openapi.json` are unauthenticated for specific documented reasons
(mycelium's health dispatcher and its tool discovery), and neither applies here. This
endpoint discloses the full tenant/subscription/user topology of the deployment.

**Which credential is an open design question, not a detail (OQ-5), because the obvious
answer does not fit.** Every authenticated route on this proxy goes through
`resolveAgent`, which resolves **one** agent from `x-mycelium-service-name` and validates
*that agent's* `ResolvedToken`. `GET /v1/instances` is inherently **cross-agent** — it
lists every workspace of every agent — so "reuse the existing check" does not answer the
question of which agent's token authorizes a list spanning all of them.

This is exactly where the `background-turn-dock` precedent stops applying. Its FR-P2
reproduces `resolveAgent` verbatim *because that endpoint is scoped to a single agent*.
This one is not, and copying the pattern without noticing the difference would produce a
route whose authorization is meaningless. Two candidate shapes, to be settled in
`design.md`:

- **Per-agent scoping.** The endpoint stays single-agent and harness-sphere calls it once
  per agent key, which it can read from its own config. Reuses `resolveAgent` honestly,
  costs one request per agent, and needs no new credential.
- **A distinct operator credential.** One call, one answer, but a new secret to provision,
  rotate and scope — and it would be the first credential in the proxy that is not an
  agent's.

**FR-P5** A workspace that exists on disk but has no container is reported with an
explicit absent state, not omitted. "Provisioned but never started" is a real and
interesting condition — `POST /v1/accounts` scaffolds directories and creates no container
— and silence cannot distinguish it from "the proxy failed to answer".

**FR-P6** The response is a stable JSON envelope with an empty list, never `null`, when
nothing is running.

**FR-P7** No existing route, and no behaviour of `EnsureRunning`, `Reconcile`,
`turnRegistry` or `BounceScope`, changes.

**FR-P8** F1 **defines and ships** this endpoint but harness-sphere does not yet consume
it — consumption is F2's dynamic discovery. Shipping it in F1 is deliberate: it is the
only part of F2 that lives in another repository and therefore has the longest merge
chain, and having it on `main` early removes that chain from F2's critical path.

### Harness-sphere configuration (FR-H)

**FR-H1** A `config.zombie-crab.toml` in the submodule configures, using only fields that
exist today: `host` and `self` (Critical, always on), `probe_targets` for the fixed
services, and `session_dir`.

**FR-H2** `probe_targets` names the compose services by their **compose names on
`zombie_net`** — `mycelium-gateway:8080`, `crab-shell-proxy:8080`, `chat-webapp:3000`.
Note that `chat-webapp` is the compose service name for the repository called
`crab-exoskeleton-webapp`; a spec or config using the repository name will not resolve.

**FR-H3** `container_cgroup`, `container_id`, `prometheus_scrape_url` and
`watch_processes` are left empty. Each is single-valued and boot-resolved, which is
precisely why F2 exists; setting one to an arbitrary instance in F1 would produce a metric
that silently describes one tenant and looks like it describes the stack.

**FR-H4** `session_dir` **ships empty and is set at deploy time**, pointed at one known
workspace's `sessions/` directory for FR-V3's measurement **only**, with an inline comment
saying it is a probe and not a deployment posture.

It cannot ship populated: a development checkout has no `tenants/` tree (the local `data/`
holds only `templates/`), so any committed path would be a guess that resolves nowhere.
This is why FR-V3 is operator-gated rather than part of the merge gate — Group C can pass
`docker compose config` with this unset, and FR-H4 is only genuinely discharged at T-14.

**FR-H5** No `harnesssphere-*` crate source file is modified (DEC-5).

## Verification

These are the point of the feature. Each is a question F2's design depends on. FR-V1 has
been discharged by experiment; the rest are still answered by inference and need a live
deployment.

**FR-V1 — Does the host layer survive containerization? — DISCHARGED 2026-09-07, before
implementation. It does.**

Measured rather than reasoned, because a wrong answer changes the deployment shape and it
was cheap to settle at the desk. `cargo build --bin harnesssphere` inside `rust:1.96-slim`
against the upstream tree, then run **in a container capped at `-m 512m`** with
`exporter = "stdout"` and only the two Critical sources enabled:

```
METRIC UpDownCounter system.memory.usage = 10055008256 By [("system.memory.state","used")]
METRIC UpDownCounter system.memory.usage = 23262818304 By [("system.memory.state","available")]
METRIC Gauge       system.memory.utilization = 0.3017906416522267
```

The host, sampled seconds earlier: `MemTotal 33317826560`, used `10037673984`, available
`23280152576`. The values agree, and `0.3018 ≈ 10.055e9 / 33.32e9` confirms the
denominator is the host's total. **The 512 MB cgroup limit was ignored entirely** —
`sysinfo` 0.39.3 reads `/proc/meminfo`, which Docker does not namespace.

DEC-2 and FR-C3 hold: **no `/proc` or `/sys` bind is required for host metrics.**

**The converse, recorded so it is not mistaken for a defect later:** harness-sphere
therefore *cannot* see its own container's limit through `HostCollector`. If the watcher's
own cgroup ceiling ever needs watching, that is `ContainerCollector`'s job and a separate
mount, not a fix to this collector. Nothing in F1 needs it.

Two side observations from the same run, worth keeping: the binary boots with
`sources=2 receivers=0 exporter=stdout` — Critical `host` and `self`, no ingest — and the
`self` collector's `process.*` metrics describe the watcher process correctly from inside
the container.

**FR-V2 — Are the compose services probeable from inside `zombie_net`? — DISCHARGED
2026-09-07 against the live stack. Yes.**

All three FR-H2 targets report `harnesssphere.endpoint.up = 1`, with probe durations
between 0.4ms and 6ms.

**The first tick is the more valuable half of this result, and it confirms FR-C5/DEC-18
in production rather than in argument:**

```
harnesssphere.endpoint.up = 1 [server.address = mycelium-gateway:8080]
harnesssphere.endpoint.up = 0 [server.address = crab-shell-proxy:8080]   <- first tick
harnesssphere.endpoint.up = 1 [server.address = chat-webapp:3000]
...
harnesssphere.endpoint.up = 1 [server.address = crab-shell-proxy:8080]   <- next tick
```

The proxy was not yet listening when the watcher started. The collector emitted an honest
zero, stayed alive, and recovered on the following tick — **with no `depends_on`, no
restart, and no intervention.** Had the service been ordered behind
`condition: service_healthy`, that first `up = 0` — a true statement about the stack —
would have been suppressed instead of recorded. This is the argument FR-C5 made from
reading `probe.rs`, now observed.

**FR-V5 — Non-root and no socket — DISCHARGED 2026-09-07 against the running container.**

Asserted against the container, not read off the compose file:

```
$ docker exec <harness-sphere> id
uid=10001(harnesssphere) gid=10001 groups=10001

$ docker inspect <harness-sphere> --format '{{range .Mounts}}...'
<data root> -> /data  rw=false
```

Exactly one mount, read-only, and **zero** `docker.sock` mounts. FR-C2 holds.

**FR-V3 — Does `SessionCollector` parse this stack's transcripts? — BLOCKED, and not for
the reason the spec predicted. The watcher cannot read the transcripts at all.**

Measured 2026-09-07 against the live stack, from inside the running container:

```
$ docker exec <harness-sphere> ls /data
effective-persona  effective-secrets  effective-skills  managed-skills
model-registry.db  restart  templates  tenants  user-secrets

$ docker exec <harness-sphere> ls -la /data/tenants
ls: cannot open directory '/data/tenants': Permission denied
```

On the host: `data/tenants` is **`root:root 0700`**. Only root can traverse it. The proxy
writes that tree as root and `chown`s the per-user workspace subtrees to `1000:1000` for
the picoclaw containers (`picoclawUser: "1000:1000"`), but **traversal is barred at the
top**, so what the leaves are owned by never comes into play. Neither uid 10001 nor uid
1000 can reach a `sessions/` directory.

**This is F1 doing its job.** DEC-5 shipped the tool unchanged so that the first live run
would separate deployment facts from upstream limitations. This is a deployment fact, it
was invisible to inference, and it would have been discovered halfway through building
F2's session work instead.

**What it invalidates, stated in full rather than minimized:**

- FR-H4 and FR-C4 are satisfied as written — the data root *is* mounted read-only — and
  are nonetheless **insufficient**. Mounting a tree the process cannot traverse is not
  access.
- **F2 DEC-10's resilience claim is false as deployed.** It says the on-disk surface is the
  fallback that keeps session metrics flowing with full attribution when the proxy is
  down. It cannot: the disk surface is unreadable by a non-root watcher, whether the proxy
  is up or not.
- F2 FR-D3, FR-D5 and the whole FR-S group rest on that surface and must be re-planned.

**The fix is a genuine fork and is deliberately not chosen here — see OQ-6.**

### What the tree actually contains (measured 2026-09-07, root-assisted)

The permission wall blocks the *watcher*, not an operator, so the tree was inspected
directly to settle the predictions. **Counts, names and sizes only — no transcript content
was read**, which is the same line FR-S6 draws for the metrics themselves.

**An unpredicted finding, and the most consequential one: there are TWO session
directories for a single workspace, not one.**

```
.../users/<u>/workspace/sessions           7 live *.jsonl,  7 *.meta.json
.../users/<u>/workspace-chat-ux/sessions   5 live *.jsonl,  5 *.meta.json
```

The second is a **project** workspace. F2's FR-S5 predicted that project conversations
live in sibling directories and would be missed by a collector globbing only
`workspace/sessions` — this confirms it and supplies the naming rule that requirement was
missing: the sibling is **`workspace-<project>`**, not `<project>`. The durable filenames
carry the matching session prefix (`p.chat-ux.<key>.jsonl`), agreeing with the proxy's
`ProjectSessionID` scheme.

**In this deployment that is 5 of 12 conversations — 42% — that a naive glob would drop
silently.** Not an error, not a warning: a smaller number that looks correct.

**Distortion 1 (`durable/`) — confirmed, with a magnitude.** Present in both directories,
mirroring the live files exactly 1:1 (7↔7 and 5↔5). `SessionCollector`'s non-recursive
`read_dir` therefore excludes it correctly *today*. The risk the original text flagged is
now quantified: a walk that ever became recursive would **exactly double** every count,
which is a failure mode that looks plausible rather than obviously broken.

**Distortion 2 (cron inflation) — predicted, NOT observed.** Zero `*.meta.json` files
carry the `agent:cron-` key in either directory. The stack has no scheduled tasks running
yet, so the inflation is **latent, not manifest**. Recorded as predicted-and-unconfirmed
rather than quietly dropped: the mechanism in the proxy's `history.go` is unchanged, so it
will appear the day cron is used, and F2 OQ-8 still needs answering.

**FR-V4 — cardinality — DISCHARGED. One workspace.** One tenant, one subscription, one
agent (`alpha`), one user. The label budget argued for in DEC-4 is not merely defensible
here, it is trivially so — and F2 OQ-7's discovery-interval question is unconstrained by
volume at this scale. **This number will not stay 1**, so it bounds nothing permanently;
what it does establish is that F2 need not optimize for cardinality before it works.

**Still unmeasured:** the leaf directory modes (which decide whether OQ-6's option 1 is
viable at all) and the live-bytes total (distortion 3, the per-tick re-read cost).

**FR-V3 (original text, retained — the shape argument still stands)** This is the
richest zero-instrumentation signal available and the one most likely to need real work.

The shape is already known to be compatible, from the proxy's own parser rather than from
assumption: `internal/history/history.go:73-86` reads picoclaw's JSONL as
`{role, content, created_at, tool_calls[], reasoning_content}`, and `SessionCollector`
reads exactly `role` and `tool_calls`.

**Three specific distortions are predicted here, and the measurement must report on each
by name — a bare "it parsed" does not discharge FR-V3:**

1. **`durable/` must be excluded.** The proxy maintains its own append-only transcripts at
   `sessions/durable/<sessionKey>.jsonl` (`history.go`, `durableDir`). `SessionCollector`
   uses a non-recursive `read_dir`, so it should skip them already — confirm it does,
   because if it ever recurses, every message is counted twice.
2. **Cron sessions inflate the count.** `harnesssphere.harness.sessions` counts `*.jsonl`
   files. **Every scheduled-task run gets its own session file** (`history.go`,
   `cronSessionPrefix = "agent:cron-"`), so a workspace with two daily tasks accrues files
   forever and the metric stops meaning "conversations". The paired `.meta.json` carries
   the `key` that distinguishes them.
3. **Every transcript is re-read in full, every interval.** `collect()` calls
   `read_to_string` on each file on every tick. Record the measured cost against a real
   workspace — this is the number that decides whether F2 needs incremental reads or can
   defer them.

**FR-V4 — What does the tuple actually cost?** With FR-P1 live, record the real count of
workspaces and containers in the target deployment. DEC-4's cardinality budget is
currently justified by an argument ("bounded by real users"); this replaces it with a
number, and it is the input to F2's decision on collection cadence.

**FR-V5 — Non-root and no socket, confirmed at runtime.** The service's effective user is
not root and `/var/run/docker.sock` is absent from its mounts (FR-C2). Asserted against
the running container, not read back off the compose file.

## Open questions

**OQ-1 — Where do the signals land in a real deployment?** DEC-6 defers this. `stdout`
proves F1. A durable backend (the vendored SigNoz, or an existing collector) is a separate
decision with retention, storage and access-control consequences, and it should be made
with FR-V4's cardinality number in hand rather than before it.

**OQ-2 — Where do per-container CPU/memory come from in F2?** DEC-3 removes the Docker
socket, which is also how `ContainerCollector` would learn a container's cgroup path.
Candidates, none yet chosen: the proxy reporting the cgroup path alongside FR-P1's
inventory; harness-sphere deriving it from a read-only `/sys/fs/cgroup` bind plus a
container id from the inventory; or accepting that F2 ships without per-container resource
counters and covers the agent layer with probes and session metrics only. **This is F2's
first design question and F1 must not pre-empt it.**

**OQ-3 — Does the exclusivity turn stop at documents?** DEC-1 repurposes the repository,
but F1 only changes prose. If the maintainer later wants the *name* to say it too, the
rename is cheap and independent — deliberately left undone so F1's failures stay legible
(DEC-7).

**OQ-5 — Which credential authorizes `GET /v1/instances`?** Raised in FR-P4 and repeated
here so it is not lost in a requirement: the endpoint is cross-agent and every existing
authenticated route on this proxy is single-agent, so `resolveAgent` does not answer it.
Per-agent scoping (harness-sphere calls once per agent key) versus a distinct operator
credential. **This must be settled in `design.md` before FR-P is implemented** — it is the
only F1 requirement whose shape is genuinely undecided, and it changes both the route and
the caller.

**OQ-6 — How does the watcher reach the session transcripts, given `tenants/` is
`root:root 0700`?** Raised by FR-V3's measurement. This is the largest open question in
either feature now, because F2's entire session-collection group depends on the answer and
the answer changes its shape. Four candidates, none chosen:

1. **Loosen `tenants/` to `0755`** (traversal only; leaves stay `1000:1000`) and run the
   watcher as uid 1000. Cheapest, and the one to be most suspicious of: `0700` is
   consistent throughout the proxy's tree-building, so it reads as deliberate isolation
   rather than an accident. Weakening it makes every workspace path enumerable by any
   local uid, and the directory names are account UUIDs.
2. **Give the watcher a supplementary group** that can traverse. Narrower than (1), but
   still requires changing what the proxy sets, and adds a group to provision.
3. **Run the watcher as root.** Rejected on sight: it contradicts FR-C2 and dissolves the
   privilege argument the whole design is built on. Recorded only so it is visibly
   rejected rather than quietly available.
4. **The proxy serves session counts over its API**, as a sibling of `GET /v1/instances`,
   and the disk surface is abandoned. Most consistent with DEC-3's reasoning — the proxy is
   the component that already has the privilege, so do not manufacture a second one — and
   it needs no permission change anywhere.

**Option 4's real cost, which must not be glossed:** it kills F2 DEC-10's resilience
property outright. Session metrics would then stop when the proxy stops, rather than
degrading to disk-only. A watcher that goes blind exactly when the thing it watches breaks
is the failure mode DEC-10 was written to avoid — so choosing (4) means accepting that
trade explicitly, not forgetting it was ever offered.

**OQ-4 — Nothing reaps abandoned workspaces.** There is no reaper and no GC: containers
are stopped on idle only in `scale-to-zero` mode, and both agents ship as `continuous`, so
in practice nothing is ever stopped or removed except on drift-recreate. An abandoned
user's directory and container persist indefinitely and will be counted forever. This is a
pre-existing stack property, not something F1 introduces — but F1's metrics are the first
thing that will make it *visible*, and it is recorded here so the first sight of it is
recognized rather than diagnosed.
