# Observability

`harness-sphere` is the stack's watcher. This chapter says what it watches, what
it shows you, how to run it with and without a metrics backend, and the two rules
about it that an operator must not break by accident.

## What it is, and what it is not

Before this service existed, the stack emitted nothing — not "not enough", but
nothing: no metrics endpoint, no collector, no dashboard. The first question
anyone asks during an incident, *was the box under pressure when that got slow?*,
had no answer.

harness-sphere is a single Rust binary that turns what it finds into standard
OpenTelemetry metrics and ships them to whatever backend you point it at. It is
exclusive to this stack, by its own README's first line: collectors with no source
here were deleted rather than left configurable.

Three things it deliberately never does, and each is worth knowing before you go
looking for the feature:

- **It holds no Docker socket.** See the rules section below.
- **It reports no token cost.** picoclaw writes no token counts to disk and
  exposes no metrics endpoint; the only path that ever existed scraped an endpoint
  this stack does not run, and it was deleted. This is not deferred work.
- **It reads no transcript content.** Message bodies are member data. It counts
  messages, sessions and tool calls; `content` is not even deserialized.

## What it watches

The stack is modelled as exactly six layers: the host, the watcher itself, and the
four things the machine runs. Two of them — Host and Watcher — are *Critical*,
meaning the watcher exits non-zero rather than run blind without them. Everything
else is *Optional*: if it is missing or misbehaving it steps aside quietly and
never takes the process down.

**The host.** CPU utilization, memory usage and utilization, and swap. These are
the real machine's numbers, not the container's, and that was measured rather than
assumed — Linux does not namespace `/proc`, so `sysinfo` inside the container
reads the host. A container capped at `-m 512m` still reported the host's 33 GB.
This is exactly why the service mounts no `/proc` and no `/sys`.

**Itself.** Its own CPU, resident memory and virtual memory. A watcher whose
memory grows without bound is a watcher about to become the incident.

**Three service endpoints, by TCP probe.** `crab/harness-sphere/config.zombie-crab.toml`
lists them by compose service name, each tagged with the layer it belongs to:
`mycelium-gateway:8080` (gateway), `crab-shell-proxy:8080` (proxy) and
`chat-webapp:3000` (webapp). Note the third: the repository is called
`crab-exoskeleton-webapp`, but `chat-webapp` is the compose service and therefore
the only name that resolves on `zombie_net`.

A target that is down reads an honest `0` rather than going absent. That is also
why the service declares no `depends_on` — ordering the watcher behind the health
of what it watches would suppress the exact signal it exists to produce.

**Per-member AI activity, from the workspace tree.** It globs
`tenants/*/subscriptions/*/agents/*/users/*` under the read-only `/data` mount and
runs one session collector per `(tenant, subscription, agent, user)` tuple, each
stamped with that tuple. From the on-disk JSONL transcripts it derives message
counts by role, conversation counts, tool-call counts, and scheduled-task runs
counted separately. Four distortions are corrected, each with a test behind it:
project conversations live in a sibling `workspace-<id>/sessions`, `sessions/durable/`
mirrors the live files one-to-one and would exactly double every number, every
cron run writes its own session file, and a transcript that shrank is re-read from
zero rather than treated as a negative delta.

The intervals are in the same config file: discovery every 30 s, sessions every
60 s, learning material every 300 s, host every 10 s, self every 30 s.

> These are **Gauges, not Counters**. The collector reports the absolute total it
> finds on disk, re-derived on each scrape, so pushing it through a Counter's
> `add()` would double-count every tick. The consequence to expect is that a value
> can legitimately fall when transcripts are rotated away.

### What it cannot see yet

The watcher reads the tenant tree on disk. It does not yet consume
crab-shell-proxy's live `GET /v1/instances` inventory, so it can tell you a
member's workspace exists and how much activity is in it, but not whether that
member's container is currently running. Per-instance liveness and per-container
CPU and memory both depend on that inventory. harness-sphere never computes the
container-name hash itself, because that would duplicate a preimage the proxy owns
and silently diverge the day the prefix or the hash changes.

## Running it

The watcher is already in the base compose file, so it runs with the stack. Out of
the box its exporter is `stdout`: it prints its signals into its own container log.
That is a deliberate default — it proves the entire pipeline with no backend to
stand up.

```bash
docker compose logs -f harness-sphere
```

To actually look at numbers over time, bring up the opt-in overlay, which adds an
OpenTelemetry Collector, Prometheus and Grafana:

```bash
docker compose -f docker-compose.yaml -f docker-compose.observability.yaml up -d
```

Grafana is then on `http://localhost:3001` (`GRAFANA_PORT`), with anonymous admin
access and no login form — it is a local backend on a loopback port, and a login
prompt in front of your own CPU graphs has no threat model behind it. If you ever
expose it beyond localhost, those three `GF_AUTH_*` lines are the first thing to
remove. Prometheus is published on `9090` so you can run a raw PromQL query when a
dashboard disagrees with what you expect.

Two dashboards are provisioned from `deploy/observability/grafana/dashboards/`,
along with the Prometheus datasource, so the stack is useful on first boot with no
clicking: *zombie-crab — stack*, organised by layer, answers "is the stack
healthy?", and *zombie-crab — learning*, organised by member, answers "where does
each instance sit?".

> **Query the underscore names.** The OTLP-to-Prometheus translation rewrites dots
> to underscores and appends a unit suffix, so what the watcher emits as
> `system.memory.usage` is scraped as `system_memory_usage_bytes`. Declare
> instruments with the dotted names; query with the translated ones.

### Why there is a collector in the middle

harness-sphere's OTLP exporter is built with `.with_tonic()`, so it speaks OTLP
over gRPC, while Prometheus's own OTLP receiver is HTTP-only. The two cannot be
wired together directly. The collector receives gRPC on `4317` and re-exposes
everything in Prometheus exposition format on `8889`, which is the single target
`deploy/observability/prometheus.yml` scrapes.

Its HTTP receiver on `4318` is there for a second producer: `crab-ganglion-harness`
speaks OTLP over HTTP with JSON encoding, which it can do with the Go standard
library alone, and the compose file passes `GANGLION_OTLP_ENDPOINT`
(default `http://otel-collector:4318`) through the proxy into each agent container.
Setting it empty disables export inside the harness rather than making it log a
failed request every turn.

> The pipeline is metrics only. harness-sphere boots `sources=3 receivers=0` — no
> traces, no logs — which is also why the SigNoz stack vendored under
> `crab/harness-sphere/deploy/signoz/` is not what this overlay uses: six services
> including ClickHouse and Zookeeper, sized for a signal that does not exist yet.

### Two settings that will bite you

**The `-f` chain is not optional on any command.** Compose applies an overlay only
when you name it. Run `docker compose up -d`, or `restart`, or `up -d harness-sphere`
without both files, and every service the overlay overrides silently falls back to
the base file — the exporter returns to `stdout` and the config bind-mount
disappears. Nothing reports this. Every container stays healthy, the watcher keeps
collecting, its logs look busy, and Grafana simply goes empty. Put this in the
`.env` at the repository root and a bare `docker compose up -d` is correct:

```bash
COMPOSE_FILE=docker-compose.yaml:docker-compose.observability.yaml
```

**Set `HARNESS_SPHERE_HOST_NAME` to the real machine's name.** The watcher reads
its hostname to fill the `host.name` resource attribute, which becomes a label on
every series. A container's hostname defaults to its own id, which changes on
every recreate — so every redeploy would fork a brand-new time series and each
panel would show the same metric once per container generation. The compose
default (`zombie-crab-host`) is stable rather than accurate, which is the
important half: a wrong-but-constant label groups correctly, a
correct-but-changing one never does.

## The two rules

These are the rules from `.claude/CLAUDE.md`, and they are stated here because an
operator who does not understand *why* will break one of them while trying to make
something work.

### It never receives a Docker socket

crab-shell-proxy already mounts `/var/run/docker.sock` and runs as root. It is the
stack's trusted control plane, and it is the most privileged component there is: a
Docker socket is start, stop and exec on any container, and a path to root on the
host.

A second socket-mounting service would double the blast radius of the stack's
worst-case compromise, for no gain — because the one thing the watcher would need
a socket *for*, mapping a running container back to its tenant, is served by the
proxy's read-only `GET /v1/instances` instead.

harness-sphere *does* run as root in this compose file (`user: "0:0"`), which
overrides the `USER 10001:10001` its own Dockerfile sets, and that one decision is
argued in place rather than assumed: crab-shell-proxy creates the
tenant tree as `root:root 0700`, and the barrier is at the top of the tree, so a
non-root watcher cannot even traverse into it. The alternatives were worse —
`chmod 0755` would make every workspace path enumerable by any local uid, and the
directory names are account UUIDs.

What keeps that narrow is three constraints that are load-bearing *together*, and
a later change must not relax them one at a time:

1. the `/data` bind stays `:ro` — it can read the tree, never write it;
2. no Docker socket, ever;
3. no published ports, so there is no inbound surface at all. Every collector
   pulls.

### `CRAB_TELEMETRY_TOKEN` is not an agent token

`CRAB_TELEMETRY_TOKEN` authorizes `GET /v1/instances` on crab-shell-proxy, and
nothing else. It is a separate, read-only credential on purpose, and an agent's
bearer token must never be substituted for it.

The reason is what an agent token is actually worth here. The Mycelium profile
header is decoded and never verified by the proxy
(`identity.SDKResolver.Resolve`), so the agent's bearer check is the *only* thing
stopping a caller who reached the proxy directly on `zombie_net` from asserting
any account id it likes. That token gates chatting **as any member of any tenant**.
Handing it to a monitoring component would let that component send messages as
other people. `handleInstances` deliberately does not go through the normal agent
resolution for the same reason, and compares the token in constant time.

Leaving it unset is supported and is the safe default. The route is then **not
registered at all** — a 404, not a 401. That is not an oversight: this endpoint
discloses the deployment's whole tenant, subscription and user topology, so a
deployment that has not opted in grows no new surface. The watcher keeps reporting
the host, itself and the three service probes; it simply cannot attribute
per-tenant instances.

Generate a fresh one with `openssl rand -hex 32`, as
`deploy/standalone/.env.example` and `deploy/prod/.env.example` both say.

## Where to go next

[Troubleshooting](./43-troubleshooting.md) covers the empty-Grafana failure and
others in symptom form. [harness-sphere](./53-harness-sphere.md) describes the
component itself, and [Deployment](./40-deployment.md) covers the compose modes
this overlay sits on.
