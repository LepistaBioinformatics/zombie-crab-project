# Installation

This is the long version of the first three steps of the
[quick start](./01-quick-start.md). Read it when that page did not fit your
machine, when you want to know what the stack writes to your disk, or when you
need to put an environment back to zero.

## Prerequisites

**Docker Engine with the Compose v2 plugin.** The command is `docker compose`,
with a space. The development compose file waits on build-only services with
`depends_on: condition: service_completed_successfully`, which the v1
`docker-compose` script does not understand. If you also intend to run the
production overlay, you need **Compose 2.24 or newer**: `docker-compose.prod.yaml`
uses the `!reset` tag to drop the base file's `build:` and its development port
publication, and older versions do not parse it.

**Git.** The product is four submodules — the orchestrator, the harness, the web
client and the watcher — and the compose file builds from their working trees.

**Enough room to build.** A first `up --build` compiles seven images from
source: the patched picoclaw, the ganglion harness, the proxy, the chat client,
the watcher, the Mycelium gateway (built from an upstream git commit) and
Mycelium's admin interface. Only Postgres is pulled ready-made. Expect the first
run to take a while and every later one to be fast.

**Free host ports.** In the default configuration the stack publishes 8080 for
the gateway, 3000 for the chat client, 8081 for Mycelium's admin interface, and
127.0.0.1:18080 for the proxy's development-only port. The databases and the
agent containers publish nothing at all: they are reachable only from inside the
stack's own network.
Each published port is an environment variable (`MYCELIUM_PORT`,
`CHAT_WEBAPP_PORT`, `MYCELIUM_WEBAPP_PORT`), so a collision is an edit to `.env`,
not a problem. If you change `MYCELIUM_WEBAPP_PORT`, change `allowedOrigins` in
the gateway configuration with it — the admin interface is a browser-side
application that calls the gateway directly, and a mismatch is a CORS wall.

**An LLM key.** Both shipped agents are configured for DeepSeek. The provider is
configuration, not code; see [models and providers](./32-models-and-providers.md).

## Cloning with submodules

```bash
git clone --recurse-submodules \
  https://github.com/LepistaBioinformatics/zombie-crab-project.git
```

If you already cloned without that flag, the submodule directories exist but are
empty. Fill them in place:

```bash
git submodule update --init --recursive
```

`--recursive` matters: the submodules are named in `.gitmodules` at this level,
but this repository is itself the middle of a chain and the habit is worth
keeping.

## What is in the repository

```
docker-compose.yaml               the whole stack, standalone/development default
docker-compose.prod.yaml          production overlay (published images, Postgres)
docker-compose.observability.yaml opt-in metrics backend (collector, Prometheus, Grafana)
deploy/                           per-mode configuration
  standalone/                       .env.example + the gateway config this mode mounts
  prod/                             the same pair for production
  observability/                    collector, Prometheus and Grafana configuration
  picoclaw-glob/                    the Dockerfile and patches for the picoclaw image
crab/                             the crab side, one submodule per component
  crab-shell-proxy/                 the orchestrator (Go) — holds the Docker socket
  crab-ganglion-harness/            this project's own agent runtime (Go)
  crab-exoskeleton-webapp/          the chat client; its compose service is chat-webapp
  harness-sphere/                   the watcher; observability only, never a Docker socket
fungi/                            the Mycelium side: gateway and admin UI Dockerfiles
docs/                             task guides and this book
data/                             everything the running stack writes (gitignored)
```

Two names are worth fixing in your head now, because they differ from the
directory they live in. The chat client's repository is
`crab-exoskeleton-webapp`, but its compose service — and therefore the name in
every `docker compose` command — is `chat-webapp`. And `deploy/` holds two
deployment *modes*, standalone and prod; `observability/` and `picoclaw-glob/`
are configuration for an overlay and for an image build, not modes you can bring
the stack up in.

## What the first run creates

Nothing under `data/` is in git, and the directory does not need to exist before
you start. The proxy creates what it needs as it goes, as `root`, because it is
the component holding the Docker socket.

- `data/templates/<agent>/` — the per-agent seed cloned into each new user's
  directory. For a picoclaw agent the proxy **bootstraps this itself** from a
  default template compiled into its own binary, so a fresh checkout works with
  no seeding step. A ganglion agent gets no template at all: the template is a
  picoclaw configuration file plus its security file, and writing one for the
  ganglion would leave two files nothing reads.
- `data/tenants/<tenant>/subscriptions/<subscription>/agents/<agent>/users/<account>/`
  — one isolated workspace per member per agent. This is the tree that gets
  bind-mounted into the agent containers, and the only place a member's
  conversations, memory and files live.
- `data/user-secrets/` and `data/effective-secrets/` — a member's own secret
  store, and the merged view of it with whatever an administrator shared at the
  tenant or subscription level. The merged view is what gets mounted into a
  container, read-only.
- `data/effective-skills/`, `data/effective-persona/`, `data/managed-skills/` —
  the same idea for skills and for the agent's identity files. See
  [skills and memory](./13-skills-and-memory.md).
- `data/restart/` — restart markers, deliberately outside the tenant tree so that
  an agent cannot read or write its own.
- `data/model-registry.db` — the proxy's model registry, a single embedded
  database file beside the directories.

Two Docker named volumes are created as well, and they are not under `data/`:
`mycelium-data` holds the gateway's own SQLite database, which is where accounts,
tenants and roles live, and `chat-webapp-postgres-data` holds the conversation
list the chat client keeps. The chat client creates its own tables on first use,
so there is no migration step for it.

> The production deployment is different in exactly one painful way: Mycelium's
> Postgres backend has no embedded migrations, so its schema has to be applied by
> hand once, after the first start. SQLite applies its own. See
> [the database chapter](./41-database.md).

## Running from somewhere other than the project root

The proxy hands the Docker daemon a **host** path as the bind-mount source for
every container it spawns, so that path has to be one the daemon can resolve —
not a path inside the proxy container. The compose file defaults it to
`${PWD}/data`, which is correct when you run `docker compose` from the project
root and wrong otherwise. If you run from elsewhere, set it explicitly in `.env`:

```bash
CRAB_HOST_DATA_ROOT=/absolute/path/to/zombie-crab-project/data
```

## Resetting to a clean state

To wipe every per-user agent and all templates and let the stack rebuild itself,
stop the stack, remove the containers the proxy spawned outside compose, delete
the on-disk state, and bring it back up:

```bash
docker compose down

# the agents are not compose services, so compose does not remove them
docker rm -f $(docker ps -aq --filter 'name=crabshell') 2>/dev/null

# the tree is written by root-owned processes, hence sudo
sudo rm -rf data/templates data/tenants data/user-secrets data/effective-secrets \
            data/effective-skills data/effective-persona data/managed-skills \
            data/restart data/model-registry.db

docker compose up -d --build
```

`--build` is not optional here. The default template the proxy re-bootstraps from
is embedded in its binary, so an image that predates a template change would
restore the old one.

Then sign in and send a message: the proxy provisions your user again from
nothing. **Your login survives**, because accounts, tenants and roles are in the
`mycelium-data` volume rather than in `data/`, and so does your conversation list.
Add `-v` to `docker compose down` only if you want those gone too — you would
then have to claim the Staff account again from the beginning.

## Where to go next

[Configuration](./03-configuration.md) covers every file you have just copied or
edited and what each variable does. [Deployment](./40-deployment.md) covers the
production overlay and how the two modes differ. If something did not come up,
[troubleshooting](./43-troubleshooting.md) collects the failures people actually
hit.
