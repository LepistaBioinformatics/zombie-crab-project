# crab-shell-proxy

This page describes the orchestrator as a component: what it owns, what it
deliberately does not, and how its code is arranged. Read it before you open the
repository for the first time.

## What it is

`crab-shell-proxy` is a small Go service that sits between the Mycelium gateway
and the agent containers. It reads which agent a request is for and which member
made it, makes sure that member's own container is running, and relays the
conversation to it. The repository is `crab/crab-shell-proxy`, its Go module is
`github.com/LepistaBioinformatics/crab-shell-proxy`, and the compose service has
the same name as the directory.

It is the component that holds the Docker socket, and it runs as root. The
Dockerfile's runtime stage says why in as many words: it has to reach the socket
(`root:docker`, mode 0660), read root-owned template files, and write per-user
data directories. Everything else in the stack is arranged so that it does not
need those privileges, because this one component already has them. The README's
security note puts it plainly: the proxy is the trusted control plane, and the
agents it spawns are the non-root, sandboxed part.

> A *harness* is the program inside an agent container that actually talks to
> the model and runs tools. The proxy orchestrates harnesses; it is not one. See
> [Harnesses](./11-harnesses.md).

## What it is responsible for

**Resolving identity into a container.** The gateway verifies the caller's token
and injects a profile header. The proxy takes the agent from the injected
service name and the member from the profile's `accId`, and ensures there is one
container and one directory for the resulting `(tenant, subscription, agent,
user)` tuple. The account id is used rather than the email because an email is
mutable; the email is kept only as a human-readable marker in
`.crab-owner.json`.

**Lifecycle.** An agent is declared either `scale-to-zero`, where the container
cold-starts on the member's first request and is stopped after an idle window,
or `continuous`, where it is never stopped automatically. Both are configured
per agent in `config.yaml`.

**Choosing the harness.** Each agent declares which runtime answers for it:

```yaml
agents:
  alpha:
    serviceName: "alpha"
    harness: "ganglion"
    template: "alpha"
    mode: "scale-to-zero"
    idleTimeout: 30s
```

`internal/pico` runs a turn against picoclaw over its WebSocket protocol;
`internal/ganglion` runs one against the ganglion over HTTP with SSE. Which of
the two is used is decided by that one key. An agent that declares no `harness:`
key gets the ganglion: the config loader in `internal/config/config.go` fills an
empty `harness:` in with `DefaultHarness` before it validates anything, and
`requireHarnessFeature` in `internal/httpapi/harness_gate.go` reads the same
constant. Declare the key explicitly in every agent you write anyway — a ganglion
agent with no image is disabled rather than started, so inheriting the default on
an unprepared host takes that agent out of service.

**Telling the truth about what a harness cannot do.** `harness_gate.go` keeps a
table of features that are not universal, and a feature the agent's harness
cannot serve answers `501` naming the harness rather than quietly succeeding.
The file records the incident that produced the rule: a harness once accepted
project creation it did not implement, so a project could be created, stored and
listed while changing nothing about the agent that answered.

**Everything done *to* a container.** Volume provisioning and ownership, secrets
materialization, the model registry, the memory-graph MCP server, scheduled
tasks and the admin API all live here. The harness specification states this as
a permanent boundary: a harness inside a container has no business starting,
stopping or provisioning anything, including itself.

**The HTTP surface.** The member-facing part is OpenAI-shaped —
`POST /v1/chat/completions`, `GET /v1/models`, `GET /v1/sessions/history` — with
`GET /healthz` for liveness and `GET /doc/openapi.json` for the OpenAPI
document embedded in the binary. Administration lives under `/v1/admin/...`, and `GET /v1/instances`
is a read-only inventory of running instances, which exists so that nothing else
in the stack has to ask Docker itself.

## What it is not responsible for

It does not authenticate anyone. Identity arrives already verified from the
gateway, and the proxy's job is to trust that header rather than to reproduce
the check.

It does not run the agent loop. Deciding which tool to call, when to stop, and
what the answer is belongs to the harness.

It does not render anything. The member-facing UI is
[crab-exoskeleton-webapp](./52-crab-exoskeleton-webapp.md), which reaches the
proxy through the gateway and never talks to an agent container directly.

It does not collect metrics about the stack. That is
[harness-sphere](./53-harness-sphere.md), and the division is load-bearing:
because the proxy already holds a Docker socket, nothing else in the stack is
given one.

## How it is built and tested

The build is the test gate. The Dockerfile's build stage runs `go vet ./...` and
`go test ./...` before it links the binary, so a failing test means no image is
produced and therefore nothing is published. `release-image.yml` is the only
workflow in the repository; it builds and pushes that image on a push to `main`
or a version tag. There is no separate pull-request workflow, which means the
checks a contributor runs locally are the same ones that gate the image:

```bash
go vet ./... && go test ./...
```

A second suite talks to a real Docker daemon and is kept behind a build tag, so
it does not run in the command above and does not run in the image build either:

```bash
go test -tags integration ./internal/docker -run TestIntegration -v
```

`config.yaml` is baked into the image at `/etc/crab-shell-proxy/config.yaml` and
holds environment-variable *names* rather than values, so one image stays usable
across deployments. See [Configuration](./03-configuration.md).

## How the code is laid out

`cmd/crab-shell-proxy/main.go` is the entry point; everything else is under
`internal/`. The packages worth knowing before you start reading:

| Package | What lives there |
|---|---|
| `config` | the agent catalog, defaults and validation, and the path helpers for a member's directory |
| `httpapi` | every route, including the harness feature gate |
| `docker` | the hand-written Docker Engine API client and everything done to a container or its volume |
| `pico` | running a turn against picoclaw |
| `ganglion` | running a turn against crab-ganglion-harness |
| `registry` | models, their cascade, and who may use which |
| `history` | reading transcripts back out of a member's directory |
| `memgraph`, `mcpserver`, `mcptoken` | the memory graph and the MCP endpoint agents reach it through |
| `cron`, `projects`, `restart`, `authz`, `identity`, `turn` | scheduled tasks, projects, restart control, authorization, the profile header, and the shared turn types |

`internal/docker` is by a wide margin the largest package, which is a fair
signal of where the work is: most of what this service does is careful
filesystem and container manipulation on behalf of someone whose request it has
already trusted.

## Where to go next

[Harnesses](./11-harnesses.md) explains the two runtimes and how one is chosen.
[Agents, workspaces and projects](./12-agents-and-workspaces.md) describes the
directory layout this service reads and writes. If you are about to change the
code, [Working on the stack](./60-development.md) has the build and test
commands for every repository in one place.
