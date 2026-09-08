# harness-sphere-zombie-crab-scope — Spec

**Status:** **PARTIALLY IMPLEMENTED (2026-09-08).**

- **Scope reduction (FR-R1–R8) — DONE**, harness-sphere#23. Net −1,562 LOC: `crates/ingest`
  and `collectors/src/prometheus.rs` deleted, `Layer` cut to the six of DEC-8.
- **Dynamic discovery (FR-D) and session collection (FR-S) — NOT STARTED.** No longer
  blocked: F1's measurements exist, and **F1 OQ-6 resolved 2026-09-08** (the watcher runs
  as a privileged daemon), which was the one open question that changed this feature's
  shape.
- **F2 OQ-6 (per-container counters), OQ-7 (discovery interval), OQ-8 (cron) remain open.**
  Note there are two OQ-6s in this feature pair and they are unrelated: F1's is about
  filesystem permissions and is now closed; this document's is about cgroup counters and
  is not.
**Spans:** `harness-sphere` (the substantial change — reduction and dynamic discovery) +
`zombie-crab-project` (compose, submodule pointer). `crab-shell-proxy` is **not** touched:
F1 already shipped the endpoint this feature consumes (F1 FR-P8).
**Date:** 2026-09-07.
**Predecessor:** `harness-sphere-integration`. Read it first — its DEC-1 through DEC-4 are
this feature's premises and are not restated here.

## Problem

F1 lands a watcher that works and watches the wrong shape of world.

**HarnessSphere was designed for one host running one harness.** Every optional collector
is configured by a single-valued, boot-resolved TOML field: `container_cgroup` names *one*
cgroup, `container_id` *one* id, `session_dir` *one* directory, `prometheus_scrape_url`
*one* endpoint. `SourceDescriptor.name` is `&'static str`. `SignalSource::probe()` runs
**once, at boot**, and the runtime supervisor spawns one task per source at startup and
never revises the set.

**zombie-crab is the opposite of that.** `crab-shell-proxy` creates a picoclaw container
per `(tenant, subscription, agent, user)` on the first turn that needs it
(`EnsureRunning`, `manager.go:188`), destroys and recreates it on persona/project/image
drift, and adopts whatever it finds at boot by listing
`docker.List(crab-shell.managed=true)`. **Docker is the registry — there is no instance
table.** The set of things worth watching is discovered at runtime and changes while the
watcher runs.

So the tool that F1 installs can see the host, itself, and the three fixed compose
services, and is structurally blind to the layer the project exists to run.

**And roughly a third of it has no source in this stack.** `prometheus.rs` (770 LOC)
scrapes a Prometheus exposition endpoint; nothing here exposes one. The `ingest` crate
(574 LOC) receives pushed OTLP; nothing here pushes any. `Layer::Api` and `Layer::Tools`
have no collector that fills them from a zombie-crab source. Carrying that is not neutral:
it is surface that has to keep compiling, keep passing `cargo audit`, and keep being read
by anyone changing the parts that do work.

## Goals

- Every picoclaw instance the proxy creates is observed, attributed to its tenant,
  subscription, agent and user, without harness-sphere holding a Docker socket.
- An instance that appears is watched within one discovery interval; one that disappears
  stops reporting, and does so visibly rather than by leaving a series frozen at its last
  value.
- The metric set is exactly the six domains this stack has: **mycelium-gateway, proxy,
  exoskeleton, picoclaw, hospedeiro, self.** Nothing that no zombie-crab component can
  produce survives.
- The tool's own documents say what it now is.

## Non-goals

- **No instrumentation added to any zombie-crab component.** Not picoclaw, not the webapp,
  not mycelium, and not the proxy beyond F1's inventory endpoint. Everything is observed
  from outside or derived from disk.
- **No Docker socket for harness-sphere**, ever. F1 DEC-3 is a premise, not a
  reconsideration.
- **No `session_id` in any metric attribute.** F1 DEC-4, likewise.
- No alerting, no SLOs, no dashboards beyond what the submodule already vendors.
- No repository, binary or crate rename (F1 DEC-7 / OQ-3).
- Not fixing the stack's missing reaper. F2 makes abandoned workspaces *visible*
  (F1 OQ-4); reaping them is the stack's problem, not the watcher's.

## Decisions

### DEC-8 — Six layers, and they are the user's six words

`Layer` today is `Host, Watcher, Container, Gateway, Harness, Tools, Api`. It becomes
exactly:

| Layer | What it is | Component |
|---|---|---|
| `Host` | the machine underneath | *hospedeiro* |
| `Watcher` | harness-sphere observing itself | *self* |
| `Gateway` | the authenticated front door | `mycelium-gateway` |
| `Proxy` | the orchestrator | `crab-shell-proxy` |
| `Webapp` | the member-facing UI | `chat-webapp` (repo: `crab-exoskeleton-webapp`) |
| `Harness` | the per-user agent containers | `picoclaw` |

`Api` and `Tools` are **deleted**: no zombie-crab source fills either.

**`Container` is deleted as a layer and kept as a dimension**, which is the one
non-obvious move here. Everything in this stack that runs, runs in a container — the
gateway, the proxy, the webapp and every picoclaw. "Container" was never a peer of
"Gateway"; it was the *mechanism* by which a gateway's resource use is measured. So cgroup
counters are emitted **on the layer of whatever the container is**, and a picoclaw
container's memory is a `Harness` signal, not a `Container` one. This is what makes
"metrics of the proxy" and "metrics of picoclaw" answerable as written, instead of
requiring a join between two layers to ask one question.

**`tool.calls` survives the deletion of `Tools`.** It has a real source here — picoclaw's
session JSONL, which the proxy's own parser confirms carries `tool_calls[]`
(`internal/history/history.go:73-86`). It moves under `Harness`. Deleting the layer must
not delete the signal; they are separate facts and it would be easy to conflate them.

### DEC-9 — `prometheus.rs` and the `ingest` crate are deleted, and the second one is a consequence of a choice

`prometheus.rs` (770 LOC) scrapes an OpenClaw diagnostics endpoint. **Nothing in this
stack exposes Prometheus text**: zero grep hits stack-wide, and picoclaw's recorded HTTP
surface is `/health`, `/ready`, `/reload` plus per-channel webhooks. It is dead code
against a component this stack does not run.

`ingest` (574 LOC) is a working OTLP receiver for metrics, traces, logs and histograms,
verified upstream against SigNoz. **It is dead here for a different reason, and the
difference matters:** it is dead *because F1 DEC-3 chose the pull-based inventory endpoint
over instrumenting the proxy to push OTLP*. Had that gone the other way, `ingest` would
have become the primary intake and this deletion would be exactly wrong.

Recorded that way deliberately: if the proxy is ever instrumented, the thing to do is
restore this crate from history, not rebuild it. Its `gen_ai.*` semconv mapping and its
resource-identity merge are the parts worth not rewriting.

**What is lost, stated plainly:** `gen_ai.client.token.usage` — token cost — leaves with
`prometheus.rs`, and this stack has no other path to it. Picoclaw does not write tokens to
disk (harness-sphere's own STATE.md establishes this: *"tokens are NOT derivable —
PicoClaw doesn't write token cost to disk"*). Token accounting is **not available and this
feature does not make it available**; it would need instrumentation inside picoclaw, which
is a non-goal. Anyone who reads "AI observability" and expects a token bill should read
this paragraph first.

### DEC-10 — Discovery reconciles two surfaces, and they are allowed to disagree

A picoclaw instance is visible two ways, and neither alone is right:

1. **F1's `GET /v1/instances`** — the live containers, with the tuple recovered from the
   six `crab-shell.*` labels. Authoritative for *running*, and the only source of the
   container name, because the name hashes the tuple one-way (`manager.go:139-149`).
2. **The on-disk tenant tree** — `tenants/*/subscriptions/*/agents/<role>/users/*`, which
   the proxy's own `existingWorkspaces` globs. **The path itself encodes the full tuple**,
   so session metrics can be attributed with no proxy call at all. Authoritative for
   *provisioned*, including workspaces whose container has never existed.

The reconciliation is the feature, not a detail. A workspace on disk with no container is
**provisioned-not-running** and is reported as such — it is exactly what `POST
/v1/accounts` produces, since it scaffolds directories and creates no container. A
container with no directory is a stack fault and must surface as one, not be silently
dropped.

**The disk surface was intended as the fallback, and this is a resilience property, not an
optimization:** if the proxy is down or its endpoint fails, session metrics keep flowing
with full attribution and only the liveness/resource signals degrade. A watcher whose
telemetry disappears when the thing it watches breaks is worthless at the moment it
matters.

> **AMENDED 2026-09-07 — that fallback does not currently exist, and this decision cannot
> be implemented as written.** F1's FR-V3 measured it against the live stack: `data/tenants`
> is `root:root 0700`, so a non-root watcher cannot traverse it at all. The mount is
> read-only and present; the process simply cannot enter. Neither uid 10001 (the watcher)
> nor uid 1000 (what the proxy chowns workspace leaves to) can reach a `sessions/`
> directory, because traversal is barred at the top before leaf ownership matters.
>
> **Consequence for this decision:** the two-surface reconciliation still stands as the
> right shape, but its *resilience* claim is currently false, and FR-D3, FR-D5 and the
> whole FR-S group were blocked on F1 OQ-6. **UNBLOCKED 2026-09-08: OQ-6 resolved to
> running the watcher as a privileged daemon, so the disk surface is reachable and this
> decision stands in full.** The outcome that would have collapsed it to one surface —
> "the proxy serves session counts over its API" — was considered and not chosen,
> precisely because it would have made the resilience property above **lost, not
> deferred**.
>
> **One thing the same measurement settled in this decision's favour:** the on-disk path
> really does carry the full tuple, and there are **two** session directories per
> workspace, not one — `workspace/sessions` and `workspace-<project>/sessions`. See FR-S5,
> which was right and is now specific.

### DEC-11 — Sources become dynamic: owned names, per-instance probe, a mutable supervisor

Three concrete changes, all forced by DEC-10 and all easy to under-scope:

- `SourceDescriptor.name` becomes an owned `String`. `&'static str` cannot name
  `session:<tenant>/<subs>/<agent>/<user>`.
- `probe()` stops being a boot gate and becomes **per-instance, at discovery**. Its
  `ProbeResult::Fatal` variant stays reachable only for Critical sources (`Host`,
  `Watcher`); a per-instance probe failing is `Unavailable`, which degrades that instance
  and nothing else. The existing criticality policy already expresses this — it just never
  had a caller that ran after boot.
- The runtime supervisor gains **add-source and remove-source at runtime**. Today it
  spawns one task per source at startup and the set is fixed for the process lifetime.

Removal must actually stop the task and drop the source. A supervisor that only ever adds
turns every recreated container — and drift-recreate is a routine event in this stack —
into a permanent extra task and a permanently stale series.

### DEC-12 — A retired instance goes absent, not silent

When an instance disappears, its series must not simply stop being written. A gauge that
stops updating reads as "unchanged" on every dashboard and in every alert rule, so a
container that died at 92% memory looks like a container sitting calmly at 92% forever.

The last write for a retired instance is an explicit terminal signal, so the difference
between *gone* and *quiet* is in the data rather than in the reader's assumption. The exact
shape is a design question (a zeroed `up` gauge is the cheap answer); the requirement is
that the distinction exists.

### DEC-13 — The session collector is rewritten, not re-pathed

F1 FR-V3 measures this; the rewrite is expected regardless of the measurement's detail,
because four things are wrong at once and only the first is a path:

1. **One directory → N.** One `SessionCollector` per workspace, or one that fans out; either
   way `session_dir` as a scalar is gone.
2. **`durable/` excluded.** The proxy keeps its own append-only transcripts at
   `sessions/durable/<sessionKey>.jsonl`. Today's non-recursive `read_dir` already skips
   them; the exclusion becomes explicit and tested, because the cost of a future recursive
   walk is silently double-counting every message.
3. **Cron runs excluded.** `harness.sessions` counts `*.jsonl` files, and **every scheduled-task
   run writes its own session file** (`history.go`, `cronSessionPrefix = "agent:cron-"`).
   A workspace with two daily tasks accrues files forever, so uncorrected the metric drifts
   from "conversations" to "conversations plus every cron run since provisioning". The
   paired `.meta.json` `key` is what distinguishes them — the same discriminator the proxy
   uses, for the same reason.
4. **Incremental reads.** `collect()` calls `read_to_string` on every transcript on every
   tick. At one workspace that is a rounding error; at N workspaces × M conversations ×
   a year of history it is unbounded IO on a fixed interval, and it grows with the
   stack's success. Track per-file offset and read the tail. **Caveat that must be
   handled, not assumed away:** picoclaw's older in-memory store *rewrote* its live file,
   so a file can shrink. A shrunk file means re-read from zero, not a negative delta.
   (v0.3.1 runs the JSONL store, which appends — but `PICOCLAW_TAG` is a variable and the
   store choice is upstream's, not this stack's.)

### DEC-14 — The probe collector learns which layer it is probing

`EndpointProbeCollector` already takes `Vec<String>` of targets, so multi-target is not the
change. It stamps `Layer::Gateway` on **every** target
(`crates/collectors/src/probe.rs:29`). Under DEC-8 that would file the proxy, the webapp
and every picoclaw instance under "gateway", which makes five of the six layers
unanswerable. Targets become `(address, layer, attributes)`.

This is also how per-instance liveness works with no Docker socket: the inventory gives the
container name, the name resolves on `zombie_net`, and `crabshell-<role>-<hash>:18790` is
probeable directly.

## Requirements

### Scope reduction (FR-R)

**FR-R1** `crates/collectors/src/prometheus.rs` is deleted, with its `prometheus` feature,
its `Cargo.toml` entry, its fixture (`tests/fixtures/openclaw_prometheus.txt`), its
composition-root wiring, and its four config fields (`prometheus_scrape_url`,
`prometheus_token_file`, `prometheus_harness_name`, `prometheus_interval_secs`).

**FR-R2** The `ingest` crate is deleted: workspace member, dependency entries, the
`ingest` feature, the `Receiver` port if nothing else implements it, and the
`ingest_enabled` / `ingest_endpoint` config fields.

**FR-R3** `Layer` is exactly `Host, Watcher, Gateway, Proxy, Webapp, Harness` (DEC-8).
`as_str()` and every match are exhaustive with no fallback arm — the compiler finding
every site is the point.

**FR-R4** Every retained metric belongs to one of the six layers and has a live source in
this stack. Any metric whose only producer was deleted goes with it. `gen_ai.*` and
`harnesssphere.openclaw.*` are gone (DEC-9).

**FR-R5** `harnesssphere.tool.calls` is retained under `Harness` (DEC-8).

**FR-R6** `config.example.toml` describes only fields that still exist, and
`config.zombie-crab.toml` from F1 is updated to match.

**FR-R7** `harness-sphere`'s own `.specs/project/PROJECT.md`, `STATE.md` and `README.md`
describe six layers and one stack. The README's layer tables lose the deleted rows rather
than marking them unsupported — a table row that says "not available here" is a promise
this feature is deciding not to make.

**FR-R8** `cargo build`, `cargo test` and `cargo audit` pass with no reference to a
deleted module, feature or field.

### Dynamic discovery (FR-D)

**FR-D1** A discovery source reconciles F1's `GET /v1/instances` against the on-disk tenant
tree (DEC-10) on a configurable interval, and yields the set of instances to watch.

**FR-D2** Each instance carries the full tuple as attributes — `crab.tenant`,
`crab.subscription`, `crab.agent`, `crab.user` — with the user as the mycelium account
UUID, never the email (F1 DEC-4).

**FR-D3** An instance present on disk but absent from the inventory is watched for session
metrics and reported as provisioned-not-running. It is not dropped.

**FR-D4** An instance in the inventory with no directory is surfaced as an anomaly, not
dropped.

**FR-D5** If the inventory endpoint is unreachable, session metrics continue from the disk
surface alone, and the failure is itself a `Watcher`-layer signal (DEC-10). Harness-sphere
must not exit, degrade its Critical sources, or stop discovering.

**FR-D6** A newly discovered instance is being collected within one discovery interval,
with no restart.

**FR-D7** A retired instance's task is stopped and its source dropped (DEC-11), and its
final emission distinguishes *gone* from *quiet* (DEC-12).

**FR-D8** `SourceDescriptor.name` is an owned `String` and is unique per instance
(DEC-11).

**FR-D9** `probe()` runs per instance at discovery. A failing per-instance probe yields
`Unavailable` and degrades only that instance; `Fatal` remains reachable only from
`Host` and `Watcher` (DEC-11).

**FR-D10** The runtime supervisor supports add and remove at runtime, and removal actually
terminates the task (DEC-11).

**FR-D11** Per-instance liveness comes from probing `<container-name>:18790` on
`zombie_net`, using the name the inventory reports (DEC-14). Harness-sphere never computes
the name hash itself — that would duplicate a preimage the proxy owns, and silently
diverge the day the prefix or the hash changes.

**FR-D12** `EndpointProbeCollector` targets carry their own layer and attributes (DEC-14).

**FR-D13** Discovery is bounded and cheap: it is a list operation and a directory glob, not
a walk of every transcript. Session *content* is read by the session collector on its own
cadence, which is slower.

### Session collection (FR-S)

**FR-S1** One logical session source per workspace, attributed by FR-D2's tuple (DEC-13.1).

**FR-S2** `sessions/durable/` is excluded, explicitly and with a test (DEC-13.2).

**FR-S3** Cron-originated sessions are excluded from `harness.sessions` via the paired
`.meta.json` `key` prefix `agent:cron-` (DEC-13.3).

**FR-S4** Transcripts are read incrementally by tracking a per-file offset. **A file that
shrank is re-read from zero, not treated as a negative delta** (DEC-13.4).

**FR-S5** Per-project workspaces are covered. **Confirmed against the live stack
2026-09-07, with the naming rule this requirement previously lacked:** the sibling
directory is **`workspace-<project>`**, not `<project>`, and its session ids carry the
`p.<project>.` prefix — e.g. `workspace-chat-ux/sessions/durable/p.chat-ux.<key>.jsonl`.

A collector that globs only `workspace/sessions` silently omits every project
conversation. **In the one workspace measured that is 5 of 12 — 42%.** The failure has no
error and no warning; it is a smaller number that looks correct, which is why this is a
requirement rather than a note.

**FR-S6** No transcript *content* is emitted — only counts. Message bodies are member data
and metrics are not the place for them. (Harness-sphere's upstream backlog carries a
GenAI content redaction item, GA-05, for the opt-in content path; this feature has no
content path at all, which is the stronger position.)

### Deployment (FR-C)

**FR-C9** Compose gains whatever mount FR-D's resource collection settles on
(F1 OQ-2) — and nothing more.

**CORRECTED 2026-09-08.** This requirement said F1 FR-C2's "no Docker socket, non-root"
survives unchanged. **Only half of that is still true.**

- **"No Docker socket" survives, unweakened.** It was always the load-bearing half: a
  socket grants *control* over every container and a path to host root.
- **"Non-root" does not survive.** F1 OQ-6 resolved to running the watcher as a privileged
  daemon, because the tenant tree is `root:root 0700` and every alternative either weakened
  `0700` on the host or destroyed DEC-10's resilience.

Three constraints replace it and are load-bearing — a later change must not relax them one
at a time: the `/data` bind stays **`:ro`**, there is **no Docker socket**, and the watcher
opens **no listening port**.

The compose change (`user: "0:0"`) lands **with FR-S**, not before: while `session_dir` is
empty, root is a privilege with no consumer.

**FR-C10** New configuration keys follow the existing `.env` convention with documented
defaults.

**FR-C11** The submodule pointer bump obeys `.claude/rules/submodule-pointers.md`:
harness-sphere's PR merges to its `main` first, then this repository's pointer names the
merge commit, then the marketing repository's.

## Open questions

**OQ-6 — Where do per-container resource counters come from?** Inherited unresolved from
F1 OQ-2, and it is this feature's first design question. The current preference, to be
confirmed against F1's measurements rather than adopted now: the proxy reports each
container's id or cgroup path alongside the inventory, and harness-sphere reads a
**read-only `/sys/fs/cgroup` bind**. That is a far weaker grant than a Docker socket — it
reads counters and cannot start, stop or inspect anything — and it reuses
`ContainerCollector` as it stands. The alternative worth pricing is shipping without
per-container CPU/memory and covering the harness layer with probes and session metrics
alone, which is genuinely less useful but needs no new mount at all.

**OQ-7 — What is the discovery interval, and what does it cost at real scale?** Depends on
F1 FR-V4's workspace count. Too slow and a short-lived container is never seen; too fast
and every tick is an authenticated HTTP call plus a glob. No number is defensible before
the measurement.

**OQ-8 — Is `harness.sessions` still the right metric once cron is excluded?** Excluding
cron makes it mean "conversations". But cron runs are real agent activity, and dropping
them entirely trades one distortion for a blind spot. A separate cron-run counter may be
the honest answer; deferred rather than guessed.

**OQ-9 — Does anything upstream still want the generic tool?** F1 DEC-1 accepted that this
feature ends harness-sphere's generic life. FR-R1/FR-R2 are the point of no return —
after them, re-generalizing means reverting a large deletion. Worth one explicit
confirmation at the moment those tasks are picked up, not because the decision is in doubt
but because it is the last cheap moment to change it.
