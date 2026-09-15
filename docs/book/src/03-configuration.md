# Configuration

Four files decide how this stack behaves. This chapter says which one owns what,
walks through the agent catalogue in detail — because that is where you define an
agent — and lists the environment variables worth knowing.

## The four surfaces

| File | Owns | How it reaches the running stack |
|---|---|---|
| `.env` at the repository root | secrets, published ports, image references | read by compose |
| `crab/crab-shell-proxy/config.yaml` | the **agent catalogue**: which agents exist, their harness, model and lifecycle | copied into the proxy image at build time |
| `deploy/<mode>/config.*.toml` | the gateway: which routes exist, which role protects each, which token is injected | bind-mounted into the gateway |
| `docker-compose*.yaml` | which services run, what they mount, what environment they get | the compose command itself |

The one thing to internalise: the agent catalogue is **baked into the proxy
image**, so adding or removing an agent means rebuilding the proxy. The gateway
configuration is **mounted**, so a change there needs only a restart of that one
service. They have to agree — an agent that exists in one and not the other is
either an advertised route with nothing behind it or an agent nobody can reach.

## The agent catalogue: `config.yaml`

This is the file you edit to define an agent. Everything else in it has a working
default; the `agents:` map does not.

Here is a complete agent, with the lines that matter:

```yaml
agents:
  alpha:
    serviceName: "alpha"                       # must match the gateway's service key
    harness: "ganglion"                        # which runtime answers
    token: { env: "MYC_PICOCLAW_ALPHA_TOKEN" } # read from the environment, never inline
    template: "alpha"                          # <dataRoot>/templates/alpha
    mode: "scale-to-zero"                      # or "continuous"
    idleTimeout: 30s
    model:
      provider: "deepseek"
      name: "deepseek-chat"
      apiKeyEnv: "PICOCLAW_ALPHA_API_KEY"      # the key lives in the environment
```

**`serviceName`** is the value Mycelium injects as `x-mycelium-service-name` when
it forwards a request, and it is the only thing that tells the proxy which agent
was addressed. Mycelium takes the first path segment of the incoming URL as the
service name and strips it before forwarding, so a member calling `/alpha/v1/...`
reaches the agent whose `serviceName` is `alpha`. A request carrying a service
name no agent claims is answered `404` with a message telling you to come through
the gateway.

**`harness`** selects the runtime. The two accepted values are `"ganglion"` and
`"picoclaw"`; anything else fails the load with a message naming both. An agent
that declares no harness at all gets the **ganglion**, which is what
`config.DefaultHarness` says. **Declare it explicitly on every agent** anyway, as
every agent in this repository's own catalogue does: a runtime is not something a
configuration should choose by omission, and an omission here does not degrade
gracefully. A ganglion agent with no image is disabled rather than started, so an
agent that inherits the default on a host with no `CRAB_GANGLION_IMAGE` stops
answering instead of quietly running something else. The boot log says so, and
names both ways out. See [harnesses](./11-harnesses.md) for how the two runtimes
differ.

**`token`** shows the pattern this file uses for every secret: `{ env: "NAME" }`
reads the value from the proxy's environment at load time, so nothing
confidential is ever written here or baked into the image. A bare string is also
accepted, and is the wrong choice outside a test.

**`template`** names a subdirectory of `<dataRoot>/templates/`. For a picoclaw
agent the proxy bootstraps a missing template from a default compiled into its
binary. A ganglion agent has no template on disk: it is configured through the
environment and files written per user.

**`mode`** and **`idleTimeout`** are the lifecycle. `scale-to-zero` stops the
container after the idle window and starts it again on the next message, with
everything preserved. `continuous` never stops it, which is what picoclaw's
native connectors need — they dial out from inside the container, so the proxy
cannot see that activity to keep the agent alive. For a ganglion agent there is
no such side door and the mode is a plain cost decision. `idleTimeout` must be
greater than zero when the mode is `scale-to-zero`; it is ignored otherwise.

**`model`** pins the provider and the model name and, crucially, names the
environment variable holding the key rather than the key itself. Each agent has
its own, so two agents can use different providers and independent credentials.
An optional `baseUrl` overrides the endpoint the proxy would otherwise resolve
from the provider — what you want when you run a gateway or a regional endpoint
in front of the provider.

### What happens when a ganglion agent is not fully configured

This is the behaviour most likely to surprise you, and it is deliberate.

A **ganglion** agent removes itself from the catalogue, at boot, when this
environment cannot run it: no image reference, no token, or an empty value behind
its `model.apiKeyEnv`. It does not take the proxy down, and it is not silent —
the boot log carries a line naming the agent and the missing setting, and the
agent's routes then answer `404`:

```
agent "alpha" disabled: PICOCLAW_ALPHA_API_KEY is unset (the agent's model apiKeyEnv) — its routes will answer 404
```

The reasoning is that one config file should be able to describe several
deployments. A ganglion agent reaching a host with no key for it degrades to
"that agent does not exist" rather than "the proxy will not boot", which would
take every other agent down with it.

A **picoclaw** agent behaves differently on purpose: a token it cannot resolve is
fatal, because silently dropping one would remove a member's access with no
signal beyond a log line nobody reads until they are locked out. Its model key,
by contrast, may be empty — it is written into the member's own configuration at
provisioning time and surfaces as an authentication error on the first message.

### The settings around the catalogue

The rest of `config.yaml` is machine-shaped and mostly supplied by compose. The
values worth knowing:

- **`hostDataRoot`** is the absolute path **on the host** of the data tree. The
  proxy hands it to the Docker daemon as the bind-mount source for the containers
  it spawns, so a path that only exists inside the proxy will not resolve. This
  is what `CRAB_HOST_DATA_ROOT` overrides.
- **`containerDataRoot`** is where that same tree is mounted inside the proxy.
  Defaults to `/data`.
- **`network`** is the Docker network spawned containers join. The compose file
  pins the network's real name to `zombie_net` so it stays stable regardless of
  the compose project name.
- **`startupDeadline`** (default 35 seconds) bounds a cold start.
  **`turnIdleTimeout`** (default 120 seconds, set to 600 in the shipped file)
  bounds how long the harness may stay **silent** — not how long a turn may take.
  A long tool-using turn narrates constantly and resets it on every frame.
- **`containerPrefix`** (default `crabshell`) prefixes every container the proxy
  manages. The name is `<prefix>-<agent>-<hash>`; the harness is recorded in the
  container's labels, not in its name.
- **`mediaMaxBytes`** (default 10 MiB) is the only thing an upload is checked
  against.

Several fields can be overridden from the environment so the committed file stays
portable: `CRAB_HOST_DATA_ROOT`, `CRAB_CONTAINER_DATA_ROOT`, `CRAB_NETWORK`,
`CRAB_LISTEN`, `CRAB_PICOCLAW_IMAGE`, `CRAB_PICOCLAW_USER`, `CRAB_PICOCLAW_HOME`,
`CRAB_GANGLION_IMAGE`, `CRAB_MCP_BASE_URL` and `GANGLION_OTLP_ENDPOINT`.

## The gateway configuration

`deploy/standalone/config.standalone.toml` and `deploy/prod/config.base.toml`
configure Mycelium. Per agent, the shape is a service block naming the downstream,
a secret block holding the bearer token, and one path block per route:

```toml
[[alpha]]
host = "crab-shell-proxy:8080"
healthCheckPath = "/healthz"

[[alpha.secret]]
name = "alpha-authorization-header"
authorizationHeader = { headerName = "Authorization", prefix = "Bearer", token = { env = "MYC_PICOCLAW_ALPHA_TOKEN" } }

[[alpha.path]]
group = { protectedByRoles = [{ name = "alpha", permission = "write" }] }
path = "/v1/chat/completions"
secretName = "alpha-authorization-header"
methods = ["POST"]
```

Three things follow from that block. The **service key** (`alpha`) is both the
first path segment callers use and the `serviceName` the proxy matches. The
**role** named in `protectedByRoles` is created automatically at boot from this
declaration — but granting it to an account is a human action, and until then
every request is refused. And the **token** is resolved from the environment per
request, so the committed file holds no secrets.

Adding a route means adding a path block. A route the gateway does not know about
is refused before the proxy ever sees it, with a message about the path matching
no service — which reads like a routing bug and is really a missing block.

## Environment variables

The full, commented list is `deploy/standalone/.env.example`; copy that file
rather than writing one from scratch. These are the ones whose behaviour is not
obvious from the name:

| Variable | Effect |
|---|---|
| `MYC_PICOCLAW_<AGENT>_TOKEN` | The bearer the gateway injects and the proxy checks, per agent. |
| `PICOCLAW_<AGENT>_API_KEY` | That agent's own LLM key, referenced by name from `config.yaml`. |
| `MYC_STANDALONE_BOOTSTRAP_SECRET` | Gates the one-time Staff claim. Empty leaves those endpoints answering 404. |
| `CRAB_WEBHOOK_SECRET` | Authenticates Mycelium's account-created webhook to the proxy. |
| `CRAB_MCP_TOKEN_SECRET` | **Empty disables the memory graph** — the endpoint is not registered and no server block is written into any workspace. Nothing warns you; the memory screens simply stay empty. |
| `CRAB_TELEMETRY_TOKEN` | **Empty means the workspace-inventory route is not registered at all** — 404, not 401. Never reuse an agent token here: an agent token gates chatting as any member, and a monitoring component must not hold one. |
| `CRAB_GANGLION_IMAGE` | The ganglion image. It has no default in the proxy, on purpose; the development compose file supplies one it builds itself. |
| `CRAB_HOST_DATA_ROOT` | The host path of the data tree. Must be absolute and must be a path the Docker daemon can see. |
| `START_AT_SIGNIN` | Set to `1` and the chat client's landing page is never served: `/` becomes the sign-in screen. |
| `COMPOSE_FILE` | Makes an overlay the default for every compose command. The observability overlay effectively requires it — see [observability](./42-observability.md). |

Two of those deserve repeating as a rule, because they share it: an unset secret
means the feature is **absent**, not unguarded. A deployment that forgot a value
grows no new surface, rather than an endpoint behind a guessable guard.

> A ganglion workspace has no `.secrets/` directory. Credentials reach that
> harness as environment variables on the container instead, which is why the
> proxy binds each workspace separately and nothing above it. Under picoclaw the
> merged secret view is mounted read-only at `workspace/.secrets`. See
> [agents and workspaces](./12-agents-and-workspaces.md).

## Where to go next

[Creating a custom agent](./31-custom-agent.md) walks the catalogue edit and the
matching gateway block end to end. [Models and providers](./32-models-and-providers.md)
covers model chains and per-member overrides. [Deployment](./40-deployment.md)
covers what changes in production.
