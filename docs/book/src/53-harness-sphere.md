# harness-sphere

`harness-sphere` is the watcher. This page describes it as a component: what it
observes, the three things it will never do, and how its code is arranged.

## What it is

HarnessSphere is a single self-contained Rust binary that watches one stack —
the machine it runs on, itself, and the services zombie-crab runs — and turns
what it finds into standard OpenTelemetry metrics, shipped to whatever backend
you point it at. The binary is called `harnesssphere`, with three `s`, and the
repository is `crab/harness-sphere`.

It exists because before it there was nothing. Not "not enough": the stack
emitted no metrics, had no collector and no dashboard, so the first question
anyone asks during an incident — was the machine under pressure when that got
slow — had no answer at all. Because the watcher sits on the same host and the
same timeline as everything else, it can answer the one thing separate tools
cannot: whether an agent slowed down because of the agent, or because of the
machine underneath it.

> **It is exclusive to this stack.** It began as a general-purpose watcher and is
> now the observability component of zombie-crab-project. Collectors with no
> source here were deleted rather than left configurable, and there is no flag
> that brings them back. Publishing to crates.io is disabled; binary releases
> continue.

## What it is responsible for

The stack is modelled as exactly six layers: the host, the watcher itself, the
gateway, the proxy, the webapp, and the agent containers. There is deliberately
no catch-all variant — a seventh kind of thing appearing should break the build
rather than file itself under "other".

Two layers are Critical and the rest are Optional, and the distinction is the
whole resilience model. Host and Watcher are Critical: if one fails
persistently, past a configurable threshold so that a single hiccup is forgiven,
the watcher flushes what it can and exits non-zero, loudly. Everything else
degrades, backs off and retries, and never brings the process down. A target
that is not responding reads an honest zero rather than going absent, which is
why the watcher needs no startup ordering and survives booting before the things
it watches.

Everything is pull. There is no receive path, because nothing in this stack
pushes telemetry at it and a receiver with no sender is code that can only ever
be wrong. Host and self metrics come from `sysinfo`; liveness comes from an
active TCP connect per tick; container CPU and memory come from reading cgroup
v2 kernel files directly; and per-member activity comes from globbing the tenant
tree and reading the on-disk JSONL transcripts incrementally.

That last one is the interesting part, and it has four corrections in it, each
with a test. A project's conversations live in a sibling `workspace-<id>`
directory, and missing it dropped 42% of the conversations on the workspace that
was measured. A `sessions/durable/` directory mirrors the live files one to one,
so counting it exactly doubles every number. Every scheduled-task run writes its
own session file, which drifts a count of conversations into a count of
conversations plus every cron run since provisioning. And a transcript that
shrank is re-read from zero rather than treated as a negative delta.

Message *content* is never read into a signal. Counts, names and sizes only.

## What it is not responsible for

**It never receives a Docker socket, by design.** The proxy already holds one and
runs as root; a second socket-holding service would double the blast radius of
the stack's worst-case compromise. A socket is start, stop and exec on any
container and a path to host root, and everything the watcher would need one
*for* — mapping a container to its tenant — is served by the proxy's read-only
`GET /v1/instances` inventory instead.

**It does not report token cost.** picoclaw writes no token counts to disk and
exposes no metrics endpoint, and the only path that ever existed was scraping an
endpoint this stack does not run. That scraper has been deleted. This is not
deferred; it is gone. Token accounting is one of the two capabilities that
justified writing [crab-ganglion-harness](./51-crab-ganglion-harness.md), and it
will arrive from that direction rather than this one.

**It does not read transcript content.** Message bodies are member data.

**It does not change anything.** Every collector pulls, the service publishes no
ports, and there is no inbound surface at all.

> The proxy's `telemetryToken`, supplied as `CRAB_TELEMETRY_TOKEN`, gates the
> inventory route and is **not** an agent token — an agent's bearer token must
> never be used in its place. With it unset the route is not registered at all,
> answering 404 rather than 401, and that is the safe default rather than an
> oversight.

## How it is run in this stack

The development compose file builds the service from the submodule and runs it
with a read-only bind of the proxy's data root at `/data`, a stable hostname,
and no published ports. Three details there are argued at length in the compose
file and are worth reading before you change any of them.

The service is given `user: "0:0"` in this stack, even though its own Dockerfile
runs as uid 10001. The reason is that the proxy creates the tenant tree as
`root:root` mode 0700, and the barrier is at the top of the tree rather than at
its leaves, so a non-root watcher cannot traverse it at all. Three constraints
keep that grant narrow and are load-bearing together: the `/data` bind stays
read-only, there is never a Docker socket, and there are no published ports.

The hostname is pinned because `host.name` is a label. A container's hostname
defaults to its own id, which changes on every recreate, so every redeploy would
fork a new time series — five had accumulated in a single evening of iteration.
A wrong-but-constant label groups correctly; a correct-but-changing one never
does.

There is deliberately no `depends_on`. Ordering the watcher behind the health of
the things it watches would suppress the exact signal it exists to produce.

To actually look at the numbers, the product repository carries an opt-in
overlay with an OpenTelemetry Collector, Prometheus and Grafana:

```bash
docker compose -f docker-compose.yaml -f docker-compose.observability.yaml up -d
```

> When you write queries, remember that the names in this book are the emitted
> OTel names. The OTLP-to-Prometheus translation rewrites dots to underscores and
> appends a unit suffix, so what the watcher emits as `system.memory.usage` is
> scraped as `system_memory_usage_bytes`.

## How it is built and tested

Rust, a Cargo workspace, edition 2024. `rust-toolchain.toml` asks for stable
with `rustfmt` and `clippy`.

```bash
cargo build --release
./target/release/harnesssphere config.example.toml   # prints signals to your terminal
```

The stdout exporter is the default and proves the whole pipeline with no backend
to stand up. For a real backend, build with the OTLP adapter — `otlp` is the
only feature the binary declares:

```bash
cargo build --release --features otlp
```

Be aware of what CI does and does not check here. `audit.yml` runs
`cargo audit --deny warnings` when a manifest or lockfile changes, weekly on a
schedule, and on dispatch. `deepseek-pr-review.yml` posts an automated review
comment on every pull request. `release-image.yml` builds and pushes the image.
None of them runs `cargo test` or `cargo clippy`, and the Dockerfile builds the
binary without running the suite. Tests exist — `crates/runtime/tests/` and
`harnesssphere/tests/` — but running them is on you.

The release profile is tuned small, with `opt-level = "z"`, link-time
optimization and stripping. Panic unwinding is kept on purpose, because the
resilience model depends on catching a panic inside a collector before it can
escape.

## How the code is laid out

The repository is hexagonal, and the ganglion's architecture rules were modelled
on this crate split.

```
crates/domain/       canonical signal model, ports, pure policies — no I/O, no OpenTelemetry
crates/runtime/      supervisor, scheduler, circuit breaker, batching drain
crates/collectors/   host and self (Critical); process, endpoint probe, session, container (Optional)
crates/export/       stdout by default, OTLP behind the `otlp` feature
harnesssphere/       the binary: config, wiring, run
```

The domain holding zero OpenTelemetry dependency is not tidiness. It keeps the
important logic — the circuit breaker, the criticality policy, the enrichment —
unit-testable without a network, and it keeps a pre-1.0 SDK that is still
changing from leaking into the core.

Configuration is a TOML file passed as the first argument, with a few
environment-variable overrides: `HARNESSSPHERE_EXPORTER`,
`OTEL_EXPORTER_OTLP_ENDPOINT` and `RUST_LOG`. Every Optional collector is off
until configured, so a fresh run shows Host and Self only. This stack's own
configuration is `config.zombie-crab.toml`, which probes the gateway, the proxy
and the webapp, and deliberately leaves the single-valued container keys empty —
pointing them at one arbitrary instance would produce a metric that describes
one tenant and reads like it describes the stack.

## Where to go next

[Observability](./42-observability.md) covers what the numbers mean and how to
read them. [Deployment](./40-deployment.md) covers running the stack with the
observability overlay attached.
