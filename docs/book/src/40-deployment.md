# Deployment

This chapter is for whoever runs the stack on a machine. It describes the two
deployment modes that exist, what each one is for, and the exact command that
brings each up. It also states plainly where production is not finished yet, so
that you find out here rather than from a failed container.

## What a mode is

The stack is a set of Docker Compose services. A *mode* is a combination of
compose files and one `.env` file at the repository root. There is one base file
that always participates, `docker-compose.yaml`, and overlays that change some of
its services without replacing them.

Two modes ship as profiles, each with its own directory under `deploy/` holding
that mode's `.env.example` and the gateway configuration it mounts:

| | standalone (the default) | prod |
|---|---|---|
| Command | `docker compose up -d` | `docker compose -f docker-compose.yaml -f docker-compose.prod.yaml up -d` |
| Mycelium | built from source at `MYCELIUM_GIT_REF` | published image at `MYCELIUM_IMAGE_TAG` |
| Mycelium storage | SQLite in the `mycelium-data` volume | a dedicated `mycelium-postgres` service |
| E-mail | stub transport: magic links are written to the log | real SMTP |
| Gateway config | `deploy/standalone/config.standalone.toml` | `deploy/prod/config.base.toml` |

A third file, `docker-compose.observability.yaml`, is not a mode. It is an opt-in
overlay that gives the watcher somewhere to send its metrics; it is described in
[Observability](./42-observability.md).

> Both profiles pin the same Mycelium release. `deploy/standalone/.env.example`
> builds the commit `9298ecb44a69ced91cb2d7d3356a716aedca858b`, described there as
> the commit tagged `9.0.0-rc.13`, and `deploy/prod/.env.example` pulls
> `MYCELIUM_IMAGE_TAG=9.0.0-rc.13`. Move them together. The gateway configuration
> is shared vocabulary between the two, and a version skew between what you test
> and what you deploy is where it breaks.

## Development on a laptop: standalone

Copy the profile's environment file to the repository root and edit it:

```bash
cp deploy/standalone/.env.example .env
```

The values you must set before the first `up` are the per-agent bearer tokens
(`MYC_PICOCLAW_ALPHA_TOKEN`, `MYC_PICOCLAW_BETA_TOKEN`), each agent's own LLM key
(`PICOCLAW_ALPHA_API_KEY`, `PICOCLAW_BETA_API_KEY`) and
`MYC_STANDALONE_BOOTSTRAP_SECRET`, which gates the one-time Staff claim. A bearer
token is what Mycelium injects on a request for that agent and what
crab-shell-proxy validates; the LLM key is read from the proxy's environment and
never written into an image or a committed file.

Then:

```bash
docker compose up -d --build
```

Standalone builds rather than pulls. Everything under `crab/` — the proxy, the
chat webapp, the ganglion harness, the watcher — is built from your working tree,
which is the point of the mode: what runs is what you have checked out. Mycelium
is the exception. `fungi/mycelium/Dockerfile.standalone` builds `mycelium-api`
from the upstream git repository at the pinned `MYCELIUM_GIT_REF` with no local
source, and `fungi/mycelium-webapp` does the same for its admin UI. That is also
why the pin and prod's `MYCELIUM_IMAGE_TAG` have to move together.

`deploy/standalone/.env.example` deliberately carries no image tags, because
`CRAB_SHELL_PROXY_TAG` and `CHAT_WEBAPP_TAG` do nothing in a mode that builds.

### The two build-only services

Two services in `docker-compose.yaml` are not servers. `picoclaw-image` and
`ganglion-image` each build one image, run `/bin/true`, and exit zero;
`crab-shell-proxy` declares `condition: service_completed_successfully` on both,
so the images are guaranteed to exist before anything can spawn a container from
them.

They exist because the agent containers are created by crab-shell-proxy over the
Docker socket, not by Compose, so Compose would otherwise never build or fetch
them. Their absence is also what one of the failures in
[Troubleshooting](./43-troubleshooting.md) is about.

> `ganglion-image`'s build runs `go vet` and `go test` before it links the binary.
> A failing test therefore stops the stack from coming up. `docker-compose.yaml`
> states that this is the intent for a development compose file: the tests are the
> image's acceptance check.

### Resetting to zero

To wipe every per-user agent and all templates and let the stack rebuild itself:

```bash
docker compose down
docker rm -f $(docker ps -aq --filter 'name=crabshell') 2>/dev/null
sudo rm -rf data/templates data/tenants data/effective-secrets \
            data/effective-skills data/user-secrets data/registered-models
docker compose up -d --build
```

The `docker rm` line is needed because the per-user containers were spawned by the
proxy rather than by Compose, so `docker compose down` does not know about them.
The `sudo` is needed because the on-disk tree under `data/` is written by the
proxy as root. The `--build` is not optional: the fallback template the proxy
re-seeds a wiped `data/` from is embedded in the proxy binary.

Accounts and roles are not in `data/`. They live in named volumes —
`mycelium-data` for Mycelium's own SQLite database and `chat-webapp-postgres-data`
for the conversation list — so your login survives the wipe. Adding `-v` to
`docker compose down` resets those too, and you would then re-run the Staff
bootstrap. See [Database and migrations](./41-database.md).

## Production: the prod overlay

```bash
cp deploy/prod/.env.example .env
docker compose -f docker-compose.yaml -f docker-compose.prod.yaml up -d
```

The overlay changes four services. `mycelium-gateway`, `crab-shell-proxy`,
`chat-webapp` and `harness-sphere` each get `build: !reset null` and an `image:`
pointing at a published GHCR image. The `!reset` matters: a plain `image:` next to
an inherited `build:` would still build the image locally if it happened to be
missing, and the whole posture of this mode is that these four are pulled, never
built.

> `!reset` requires Docker Compose v2.24 or newer. This is a prerequisite for the
> prod mode, not a detail — an older Compose will not understand the file.

Two more things the overlay does are easy to miss and both are deliberate:

- `crab-shell-proxy` gets `ports: !reset []`. The base file publishes the proxy on
  `127.0.0.1:18080` for direct testing, and `ports` *concatenates* across `-f`
  layers rather than replacing, so without the reset that port would stay live.
  In production the gateway must be the only entry point, loopback included.
- `mycelium-webapp` is still built here. It is a browser-side single-page app
  whose API URL is baked in at build time through the `VITE_MYCELIUM_API_URL`
  build argument, so it cannot be a generic prebuilt image.

### Production has no published ganglion image today

This is the one thing to be explicit about, because a reader who deploys to a
server and configures a ganglion agent can hit it.

`docker-compose.prod.yaml` does not set `CRAB_GANGLION_IMAGE`, and
`deploy/prod/.env.example` does not mention it either. Because prod is an overlay
on the base file, what actually reaches the proxy is the base file's default,
`zombie-crab/crab-ganglion:dev` — a tag that exists only on a machine that built
it. The agent is therefore not disabled; it is pointed at a name no registry
resolves.

Two consequences follow. First, the prod command inherits the `ganglion-image`
build-only service unchanged, since the overlay resets only the four services
above. A prod `up -d` on a host that carries the submodule sources will *build*
the ganglion locally, which is not what "published images" leads you to expect and
which requires the source tree and a Go build on that host. Second, in any
situation where that build-only service does not run — a `docker compose up -d
crab-shell-proxy` on its own, a `docker system prune` that removed the local tag,
or a deployment that only pulls — the proxy's `EnsureImage` finds nothing locally,
falls through to a registry pull, and that pull 404s. Every ganglion agent is dead
until someone builds the image by hand.

> Immutable ganglion images do exist. `crab/crab-ganglion-harness`'s own
> `.github/workflows/release.yml` publishes
> `ghcr.io/lepistabioinformatics/crab-ganglion:sha-<short-sha>` on every push to
> `main`, deliberately with no `:latest` and no tag that is ever rebuilt. What is
> missing is the wiring: nothing in the prod profile points at one. The only
> release workflow in *this* repository's `.github/workflows/` is
> `release-picoclaw-glob.yml`, which publishes the patched picoclaw image.
>
> Until the profile catches up, set `CRAB_GANGLION_IMAGE` in your production
> `.env` to a specific `sha-` tag or a digest, and **`docker pull` it before you
> bring the stack up**. `crab/crab-shell-proxy`'s `internal/config/config.go` asks
> for an immutable reference and explains why: a moving tag once left a host
> running a three-week-old binary, silently, because `EnsureImage` never pulls
> what is already present.
>
> The pull is not optional housekeeping. The inherited `ganglion-image` service
> takes its `image:` from whatever you set while keeping its `build:` context, so
> if that reference is absent locally, `up` will build the checked-out submodule
> source and tag *those* bytes with the published name — which is the exact
> wrong-bytes-under-a-trusted-name failure the immutable reference exists to
> prevent.

Note also that an agent which declares no `harness:` key at all is a ganglion
agent today (`DefaultHarness` in `crab/crab-shell-proxy/internal/config/config.go`),
so it needs `CRAB_GANGLION_IMAGE` as well. Declare the harness explicitly on every
agent; the config shipped in this repository does, for that reason.

### Before a prod deploy

- **`CRAB_HOST_DATA_ROOT` must be an absolute host path.** crab-shell-proxy hands
  it to the host Docker daemon as the bind-mount source for the containers it
  spawns, so a path that only exists inside the proxy will not resolve.
- **Set `noreplyEmail` and `supportEmail` in `deploy/prod/config.base.toml` to the
  same address as `MYC_SMTP_USERNAME`.** Gmail rejects a mismatched `From`. The
  SMTP port is fixed at 465 in that file rather than being an environment
  variable, because Mycelium parses it as a number and an environment value is a
  string.
- **If you front the stack with a hostname**, change `domainUrl` and
  `allowedOrigins` in the same file *together with* `mycelium-webapp`'s
  `VITE_MYCELIUM_API_URL` build argument. The admin UI calls the gateway directly
  from the browser, so a mismatch between the two is a CORS wall.
- **The agent catalog is baked into the proxy image** in both modes
  (`crab/crab-shell-proxy/config.yaml`), so adding or dropping an agent means
  rebuilding it. Binding your own file over `/etc/crab-shell-proxy/config.yaml` is
  supported if you would rather mount it.
- **Every routed agent needs its bearer token set.** Leaving one empty makes the
  gateway advertise the agent and inject an empty bearer, which fails at request
  time rather than at boot.

## There is no Dokploy profile

There used to be a third profile, `docker-compose.dokploy.yaml` with its own
`deploy/dokploy/` directory, and it was removed rather than moved. The deployment
it was written for now lives in a separate repository, deploys only the CRAB half
of the stack, and had drifted into being the real source of truth while this copy
was maintained on faith.

If you are deploying on Dokploy, start from `prod`, which is the closest profile,
and add the Traefik labels and external network your installation needs.
`git log -- docker-compose.dokploy.yaml deploy/dokploy/` still has the original.

## Where to go next

Production on Postgres needs a one-time schema step before anyone can sign in —
that is [Database and migrations](./41-database.md). Once the stack is up,
[Observability](./42-observability.md) covers the watcher and the optional metrics
backend, and [Troubleshooting](./43-troubleshooting.md) collects the failures
people actually run into.
