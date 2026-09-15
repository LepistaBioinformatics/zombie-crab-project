# Troubleshooting

Each entry below is a symptom you can actually observe, the cause behind it, and
what to do. They are all failures this stack has real evidence for, recorded in
the compose files, the configuration files or the proxy's own code. If your
problem is not here, the boot log of `crab-shell-proxy` is almost always the right
first place to look — it names missing variables on purpose.

## A ganglion agent stops answering, and the proxy logs a failed image pull

**Symptom.** Chatting with an agent that runs the ganglion harness fails. The
proxy's log carries a pull error naming the image, typically
`zombie-crab/crab-ganglion:dev`. Other agents are unaffected. It often starts
right after a `docker system prune`, or on a server that was deployed by pulling
images rather than building them.

**Cause.** `EnsureImage` in `crab/crab-shell-proxy/internal/docker/client.go` has
a fast path: it asks the daemon for the image locally and, if it is there, returns
without contacting any registry. That is what lets a locally built tag work at
all. It does not stop there when the image is missing — it falls through to
`POST /images/create`, a real registry pull, which 404s on a tag no registry has.

The default `CRAB_GANGLION_IMAGE` is `zombie-crab/crab-ganglion:dev`, a name that
exists only on the machine that built it. A prune removes unused images, this one
goes, and the agent is dead until the tag comes back.

**Fix.** Rebuild the tag. The `ganglion-image` service in `docker-compose.yaml`
exists for exactly this: it is a build-only service that produces the image, runs
`/bin/true` and exits, and `crab-shell-proxy` waits for its completion. `picoclaw-image`
does the same for the other harness, so both are recovered by the same command:

```bash
docker compose up -d --build
```

On a server, prefer the durable fix: set `CRAB_GANGLION_IMAGE` in your `.env` to a
published immutable reference — `crab/crab-ganglion-harness`'s release workflow
publishes `ghcr.io/lepistabioinformatics/crab-ganglion:sha-<short-sha>` — and pull
it. See [Deployment](./40-deployment.md) for why that reference must be immutable
rather than a moving tag.

## Nothing comes up at all: the gateway never becomes healthy

**Symptom.** `docker compose up -d` returns, but `mycelium-gateway` sits waiting
and `chat-webapp` never starts. Nothing is reachable.

**Cause.** `mycelium-gateway` declares `depends_on: crab-shell-proxy: condition:
service_healthy`, and `chat-webapp` in turn depends on the gateway being healthy,
so a proxy that exits at boot takes the whole stack with it.

The proxy exits fatally for a small, specific set of reasons. Its `validate()`
rejects a configuration with no `hostDataRoot`, no `network`, an agent with no
`serviceName` or no `template`, or an agent naming a harness it does not
orchestrate. Separately, a **picoclaw** agent whose bearer token cannot be
resolved from the environment is fatal — deliberately, because silently dropping
one would lock a member out with no boot-time signal.

**Fix.**

```bash
docker compose logs crab-shell-proxy
```

The failure names what is missing. Set it in `.env` and bring the stack up again.

## One agent's routes answer 404 and everything else works

**Symptom.** A single agent behaves as though it does not exist — its routes
return 404 — while the other agents are fine and the proxy is healthy.

**Cause.** A **ganglion** agent removes itself at load instead of taking the proxy
down, and this is the designed behaviour rather than a bug. One config file can
describe several deployments, and an agent that reaches a host with no key for it
degrades to "that agent does not exist" rather than "the proxy will not boot",
which would take every other agent down too. There are three reasons it can
happen: `CRAB_GANGLION_IMAGE` is unset, the agent's model `apiKeyEnv` variable is
unset, or its bearer token cannot be resolved.

Nothing is silently downgraded. The proxy prints one line per disabled agent at
boot: `agent "<key>" disabled: <reason> — its routes will answer 404`, where the
reason names the setting, for example that `ganglionImage` (or
`CRAB_GANGLION_IMAGE`) is unset and has no default on purpose.

**Fix.** Read the boot log for `disabled`, set the variable it names, and restart
the proxy.

> An agent that declares no `harness:` key is a ganglion agent today
> (`DefaultHarness` in `crab/crab-shell-proxy/internal/config/config.go`), so it is
> subject to all three checks. Declare the harness explicitly on every agent — a
> config upgrade should not change a runtime by omission.

## Creating a scheduled task answers 501

**Symptom.** The Tasks panel, or a direct API call, refuses to create, change,
disable or delete a scheduled task with a `501 Not Implemented` and a message like:

```
creating scheduled tasks over this API is not available on the picoclaw
harness (agent beta): its agent creates them itself
```

**Cause.** `crab/crab-shell-proxy/internal/httpapi/cron_write.go` refuses every
cron *write* route for an agent whose harness is not the ganglion. On picoclaw the
harness owns the job store and holds the live schedule in memory, so a toggle in
the panel could disagree with the timers actually running. On the ganglion the
proxy owns the schedule, above the container, so it can serve the writes honestly.
The *read* routes are served on both harnesses, which is why you can still see a
picoclaw agent's tasks and their run history.

**Fix.** On a picoclaw agent, ask the agent in chat to create, change or remove
the task; it owns them. If you want the panel's write controls, use an agent on
the ganglion harness. See [Scheduled tasks](./22-scheduled-tasks.md).

> The general mechanism is `requireHarnessFeature` in
> `internal/httpapi/harness_gate.go`: a feature a harness cannot serve answers 501
> naming the harness, rather than quietly succeeding. That rule exists because a
> withdrawn harness once let projects be created, stored, listed and reported
> active while changing nothing about the agent that answered. As the tables in
> that file stand today it reserves nothing from either shipped harness, so the
> cron write above is the 501 you will actually meet.

## The gateway answers `400 "Request path does not match any service"`

**Symptom.** A request through `mycelium-gateway` is rejected before the proxy is
ever reached, with that exact text.

**Cause.** Mycelium routes by the first path segment, matched against a service
key in its TOML config, and then matches the rest of the path against that
service's `[[<agent>.path]]` blocks. A path with no matching block is refused
here. This is what happens when a proxy route exists but the gateway config was
not extended to allow it — the `/v1/cron/*` read routes are the usual example, and
all the profiles under `deploy/` already carry a block per agent for them.

**Fix.** Add the matching `[[<agent>.path]]` block to the gateway config your mode
mounts (`deploy/standalone/config.standalone.toml` or `deploy/prod/config.base.toml`)
and recreate the gateway.

> The same error text appears for an unrelated reason: Mycelium's own `/health`
> route only handles `GET` and rejects `HEAD` with this message. If you are
> probing it with something that sends `HEAD` — `wget --spider`, for instance —
> the 400 is about the method, not about routing. Both healthchecks in
> `docker-compose.yaml` use a plain `GET` for this reason.

## Grafana is empty and every container is healthy

**Symptom.** The dashboards load, the panels render, and there is no data. No
container is unhealthy, no log shows an error, and harness-sphere's own log looks
busy.

**Cause.** The `-f` chain was omitted on some command. Compose applies an overlay
only when you name it, so `docker compose up -d`, `restart`, or even
`up -d harness-sphere` without both files reverts every service the overlay
overrides back to `docker-compose.yaml`. For harness-sphere that means the
exporter goes back to `stdout` and its config bind-mount disappears, so it prints
metrics into its own logs instead of sending them. Nothing anywhere reports this.

**Fix.** Bring it up naming both files, and then remove the footgun by putting
this in the `.env` at the repository root, after which a bare `docker compose up -d`
is correct:

```bash
COMPOSE_FILE=docker-compose.yaml:docker-compose.observability.yaml
```

See [Observability](./42-observability.md).

## The agent says it saved a file, and the Files panel does not list it

**Symptom.** The agent reports writing a document, and nothing appears in the
member's Files panel. The file really was written — it is simply somewhere the
interface does not look.

**Cause.** `public/` inside a workspace is the only directory a member's interface
lists, and `public/attachments/` is where an agent is told to write deliverables.
A managed memory file (`FILE_DELIVERY.md`) carries that rule into every workspace
and is read on every turn, precisely because a file written outside `public/` is
invisible to the member no matter how the deployment is configured.

**Fix.** Ask the agent to move or re-save the file under `public/attachments/`,
naming the path. Do not write to `uploads/`: that is the directory's former name,
kept in the code only so a one-time migration can recognise a workspace predating
the rename.

> A related surprise: the paperclip notice the proxy appends when a file is
> delivered is stream-only and is never persisted. After a page reload, the only
> account of a delivered file is whatever the model itself wrote in its reply,
> which is why the managed rule also tells it to name the path out loud.

## The Map and Entities tabs stay empty

**Symptom.** The knowledge graph never records anything. No error is shown and
nothing is logged about it.

**Cause.** `CRAB_MCP_TOKEN_SECRET` is empty. That value signs the bearer token a
spawned agent presents back to the proxy's own MCP endpoint. Unset is a supported
and deliberate state: `/v1/mcp` is not registered, no MCP server block is written
into any workspace, and everything else behaves normally. A deployment that forgot
the secret must get no memory rather than an unauthenticated endpoint reachable by
every container on the network.

**Fix.** Generate one with `openssl rand -hex 32`, set it in `.env`, and recreate
the proxy. Both `.env.example` files spell this out.

## harness-sphere cannot attribute instances, or `/v1/instances` 404s

**Symptom.** The watcher reports the host, itself and the three service probes,
but nothing per tenant. A direct request to `GET /v1/instances` on the proxy
returns 404.

**Cause.** `CRAB_TELEMETRY_TOKEN` is empty, so the route is **not registered at
all** — absent, not 401. This endpoint discloses the deployment's whole tenant,
subscription and user topology, so a deployment that has not opted in grows no new
surface.

**Fix.** Generate a fresh secret with `openssl rand -hex 32` and set it. Do **not**
reuse an agent's bearer token for this: an agent token gates chatting as any
member of any tenant, and the reasoning is in [Observability](./42-observability.md).

## `rm -rf data/...` fails with Permission denied

**Symptom.** Wiping the on-disk state during a reset fails.

**Cause.** crab-shell-proxy creates the tenant tree as root, `0700`, so the
directories are not yours.

**Fix.** Use `sudo` for that one command, as the reset sequence in
[Deployment](./40-deployment.md) does. This is also why harness-sphere runs as
root with a read-only bind: nothing else could traverse the tree.

## No sign-in e-mail arrives in standalone

**Symptom.** You request a magic link, or the Staff bootstrap code, and no e-mail
ever comes.

**Cause.** Standalone has no real SMTP. It ships a stub transport that writes the
message to the log instead of sending it — a deliberate property of the mode.

**Fix.** Read it out of the gateway's log. Sign-in links land in the same place.

```bash
docker compose logs mycelium-gateway | grep -i bootstrap
```

## Nobody can sign in to a fresh prod deployment

**Symptom.** The prod stack is up, the gateway is running, and authentication does
not work.

**Cause.** Mycelium's Postgres adapter has no embedded migrations, unlike its
SQLite one, so a freshly created database has no schema.

**Fix.** Run the one-time, two-step schema application described in
[Database and migrations](./41-database.md). Both steps are required at the
release this repository pins; the second is not optional.

## Where to go next

If the failure is about how a deployment is assembled, [Deployment](./40-deployment.md)
is the fuller account. If it is about what the watcher does or does not show,
[Observability](./42-observability.md) covers that surface. For the behaviour of
the two harnesses themselves, see [Harnesses](./11-harnesses.md).
