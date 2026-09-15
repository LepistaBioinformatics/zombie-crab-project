# How the stack fits together

This chapter explains the shape of the system: which piece does what, why the
pieces are separate, and where the security boundary actually is. Read it once
before anything else in this section; every later chapter assumes it.

## The problem the shape solves

An AI agent reads and writes files, runs commands, and keeps long-lived memory,
all steered by natural language it did not write. Run one agent for several
people in one process and one prompt injection, one path-traversal bug or one
leaky tool is enough for one person to reach another person's conversations,
files and secrets.

So the stack does not share an agent. Every user gets their own container, with
their own directory on disk, and the thing that decides who you are is not the
same thing that runs your agent.

## Three layers

The stack is three layers, each with exactly one job.

```text
   your browser
        |
        v
+--------------------------------------------+
|  1. EDGE  --  mycelium gateway             |   the only thing exposed
|     authenticates, enforces RBAC,          |
|     injects a verified account profile     |
+--------------------------------------------+
        |  x-mycelium-service-name: alpha
        |  profile (accId, tenant, subscription)
        v
+--------------------------------------------+
|  2. ORCHESTRATION  --  crab-shell-proxy    |   holds the Docker socket
|     resolves (tenant, subscription,        |   runs as root
|     agent, user), starts that user's       |
|     container, proxies the turn            |
+--------------------------------------------+
        |  docker.sock            ^
        v                         |  HTTP / WebSocket on zombie_net
+--------------------------------------------+
|  3. AGENT  --  one harness container       |   non-root, one per user
|     per (tenant, subscription, agent,      |   own volume, own memory
|     user); ganglion or picoclaw            |
+--------------------------------------------+
```

Alongside those three, two more services run but are not in the request path:
`chat-webapp`, the member-facing chat UI, and `harness-sphere`, the watcher.

### 1. Mycelium, the edge

Mycelium is an external API gateway, developed separately from this project and
built or pulled as part of the stack. It is the only way into the agent API:
every request that reaches crab-shell-proxy came through it, and the proxy trusts
nothing else about who is calling. It verifies the caller's token, enforces
role-based access, and injects a **verified** account profile into the request
before forwarding it.

The chat client and mycelium's own admin UI publish ports of their own, because
they are browser applications a person opens. That is not a second door into the
agents — both call the gateway like any other client.

That last word is the point. The caller never tells the proxy who they are;
mycelium tells the proxy, server-side, and identity flows *down* from a trusted
source rather than *up* from a request body. The routes are role-protected, so
an account must hold the matching guest role to reach an agent at all.

> A **tenant** is an organization in mycelium. A **subscription** is an account
> under a tenant that members are invited into. The pair, plus the member's own
> account id, is what makes one person's agent distinct from another's.

Mycelium's gateway also exposes a JSON-RPC endpoint at `POST /_adm/rpc` that the
chat webapp uses for identity and membership operations. Requests routed through
crab-shell-proxy are the proxy's own REST API and are a separate surface.

### 2. crab-shell-proxy, the orchestrator

The proxy reads which agent was addressed from the injected service name and
which user is calling from the profile's account id, then ensures that user's
own container is running — starting it on demand, stopping it when idle — and
proxies the turn.

Its unit of isolation is a four-part key: tenant, subscription, role (the agent
key, such as `alpha`), and user account id. That tuple is `WorkspaceKey` in
`internal/docker/manager.go`, and it names both a directory on disk and a
container.

The container name is `<prefix>-<role>-<hash>`, where the hash is a SHA-256 over
the tenant, subscription and user ids. The full tuple carries two UUIDs and would
exceed the 63-character DNS label limit, which would make the container
unreachable by its own name on the Docker network — so the identity lives in the
container's labels and in a `.crab-owner.json` marker in the user's directory,
not in the name.

### 3. The agent, behind a harness contract

The third layer is not one program. It is a **harness**: an agent runtime behind
a fixed contract, chosen per agent. Two are supported — `crab-ganglion-harness`,
which this project wrote, and picoclaw, which it started with and is now
deprecating. Which one an agent runs is declared in the proxy's `config.yaml`.
See [Harnesses](./11-harnesses.md) for the choice and its consequences.

## Who holds the Docker socket

This is the whole security argument, so it gets its own section.

**crab-shell-proxy holds the Docker socket and runs as root.** It is the only
component that does. The Docker socket is the host daemon: whoever can write to
it can start, stop and exec into any container, and from there reach host root.
That makes the proxy the most privileged piece of the stack and its trusted
control plane.

Everything the proxy spawns is the opposite. Agent containers run as a non-root
uid (`picoclawUser: "1000:1000"` in the proxy's `config.yaml`), get their own
process, network and mount namespaces, and get a bind of their own directory and
nothing else. If one user's agent is fully compromised — prompt-injected into
running hostile code — it still cannot read another user's files, memory or
conversations. Different container, different directory, no shared surface. The
isolation is enforced by the kernel, not by application code deciding what to
show whom.

`harness-sphere`, the observability watcher, **never receives a Docker socket**,
and that is a deliberate standing rule rather than an oversight. It runs as root
in order to traverse the proxy-created tenant tree, and three constraints keep
that narrow: its `/data` bind is read-only, it publishes no ports, and it gets no
socket. A second socket holder would double the blast radius of the stack's worst
compromise. What it would need the socket for — attributing a container to its
tenant — is served instead by `GET /v1/instances` on the proxy, behind its own
token.

> The stack is tuned to be easy to read and run locally, not hardened. Before
> exposing it, isolate the socket (a restricted socket proxy, or a dedicated
> host), terminate TLS at the edge, and rotate the tokens and keys in `.env`.

## What each repository is responsible for

This repository is a thin top level — the compose files, the deploy profiles, the
docs and the `fungi/` build overlays for the mycelium side — plus four git
submodules under `crab/`.

| Repository | Responsibility |
|---|---|
| `crab/crab-shell-proxy` | The orchestrator. Holds the socket, owns the on-disk layout, serves the HTTP API. Go. |
| `crab/crab-ganglion-harness` | This project's own agent runtime. A static Go binary on Alpine. |
| `crab/crab-exoskeleton-webapp` | The member-facing chat client. Next.js. Its compose service is `chat-webapp`, not the repository name. |
| `crab/harness-sphere` | The watcher. Observability only, exclusive to this stack. Rust. |

Mycelium is not a submodule. The `fungi/` directory holds Dockerfiles that fetch
mycelium and its admin UI from upstream at image-build time.

Each submodule has its own remote, its own pull requests and its own default
branch, and the chain is merged bottom-up: a pointer here may only name a commit
reachable from that submodule's default branch, and a CI check enforces it.

## Two things a deployment reader should know now

**The agent containers are not started by compose.** The proxy creates them
through the Docker API, one per member per agent, outside any compose project.
`docker ps` shows them as `crabshell-<agent>-<hash>`, and `docker compose down`
does not remove them.

**Production has no published ganglion image.** `docker-compose.prod.yaml` pulls
published images for mycelium, the proxy, the chat webapp and harness-sphere, and
sets no `CRAB_GANGLION_IMAGE`; no workflow in this repository publishes one. The
development compose builds the image locally under the tag
`zombie-crab/crab-ganglion:dev`, which exists only on the machine that built it.
A production deployment running ganglion agents has to supply that image itself.

## Where to go next

[Harnesses](./11-harnesses.md) explains the agent layer and how one is chosen.
[Agents, workspaces and projects](./12-agents-and-workspaces.md) covers what the
proxy actually writes to disk. For the components as components, see
[crab-shell-proxy](./50-crab-shell-proxy.md) and
[harness-sphere](./53-harness-sphere.md).
