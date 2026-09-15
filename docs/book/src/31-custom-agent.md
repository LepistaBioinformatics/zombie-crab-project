# Creating a custom agent

This chapter walks through adding a new agent to a deployment, from the first
directory to the first chat. It is written as one worked example: an agent
called `scribe`, running the ganglion harness. Read
[the admin guide](./30-admin-guide.md) first if you have not met tenants,
subscriptions and scopes yet.

## What an agent is

An **agent** is a named personality that members chat with. `alpha` and `beta`
are the two that ship. An agent is not a container: every member who talks to
`scribe` gets their own container, their own workspace and their own history,
all cloned from the same starting point. See
[agents and workspaces](./12-agents-and-workspaces.md) for that isolation model.

Three things have to exist before a member can reach a new agent.

1. An entry in the proxy's **agent catalog**, which names the agent, the runtime
   it uses, its lifecycle mode and its default model.
2. A **template directory** on disk, which supplies the agent's identity files.
3. A **route in the gateway**, because Mycelium is the front door and it will
   not forward a request for a service it has never heard of.

The rest of this chapter is those three, in that order, plus the environment
variables that tie them together.

## Step 1: the template directory

The proxy resolves an agent's template at `<data-root>/templates/<template>/`
(`TemplatesDir` in `crab/crab-shell-proxy/internal/config/config.go`). On the
host, `<data-root>` is `CRAB_HOST_DATA_ROOT`; inside the proxy container the
same tree is mounted at `CRAB_CONTAINER_DATA_ROOT`, which defaults to `/data`.

For a ganglion agent the part of the template that matters is `workspace/`,
because that directory is the bottom layer of the persona cascade:

```
data/templates/scribe/
└── workspace/
    ├── AGENT.md       what the agent does and how it behaves
    ├── SOUL.md        its voice
    ├── HEARTBEAT.md   its recurring task list
    └── USER.md        what the agent starts out knowing about the member
```

Those four names are the complete set. `PersonaFiles` in
`crab/crab-shell-proxy/internal/docker/persona.go` lists exactly
`AGENT.md`, `SOUL.md`, `HEARTBEAT.md` and `USER.md`, and the first three are
delivered as read-only bind mounts while `USER.md` is seeded once and then left
alone — the agent writes to it as it learns about the member.

> A ganglion agent has **no `config.json` and no `.security.yml` in its
> template**. Those are picoclaw's files. `ganglion_config.go` states it
> plainly: the harness's configuration is not seeded from
> `templates/<agent>/config.json` and never was. The proxy renders a
> configuration file for each workspace instead, and credentials arrive as
> environment variables. Do not copy a stock agent's `config.json` into a
> ganglion template; nothing will read it.

The template's `workspace/skills/` and `workspace/memory/` are likewise
picoclaw-only. `seedWorkspace` in
`crab/crab-shell-proxy/internal/docker/provision.go` copies the
`config.WorkspaceSeed` allowlist — `USER.md`, `memory/` and `skills/` — and it
is on the picoclaw creation path; `createGanglion` never calls it. To give a
ganglion agent skills, publish them as [shared skills](./13-skills-and-memory.md)
from the admin area.

A `template:` value is still **required** for every agent, whatever the harness:
`validate` in `config.go` refuses an agent that declares none. For a ganglion
agent it points at the directory holding those identity files.

## Step 2: the catalog entry

The catalog is `crab/crab-shell-proxy/config.yaml`. The Dockerfile copies it to
`/etc/crab-shell-proxy/config.yaml` and sets `CRAB_CONFIG` to that path, so the
committed file is baked into the proxy image. A deployment that mounts its own
file over that path, or points `CRAB_CONFIG` elsewhere, can edit the catalog
without rebuilding.

Add the agent under `agents:`:

```yaml
agents:
  scribe:
    harness: "ganglion"
    serviceName: "scribe"
    token: { env: "MYC_PICOCLAW_SCRIBE_TOKEN" }
    template: "scribe"
    mode: "scale-to-zero"
    idleTimeout: 30s
    model:
      provider: "deepseek"
      name: "deepseek-chat"
      apiKeyEnv: "SCRIBE_API_KEY"
```

`serviceName` must match the value Mycelium injects as
`x-mycelium-service-name`, which is the gateway's service key from step 3.
`token` is the bearer the gateway presents; the proxy rejects any request whose
`Authorization` does not match it.

**Declare `harness: "ganglion"` explicitly.** The key is optional and
`DefaultHarness` is the ganglion today (`config.go`), so omitting it would work
— but the same file argues against relying on that: every agent in this
repository's own `config.yaml` spells its harness out, because a config upgrade
should not change an agent's runtime by omission. Picoclaw is still fully
served, and `harness: "picoclaw"` is still the right value for an agent that
needs it; see [harnesses](./11-harnesses.md) for the difference.

`mode` decides the container lifecycle. `scale-to-zero` stops the container
after `idleTimeout` of no activity; `continuous` keeps it running.
`idleTimeout` must be greater than zero when the mode is `scale-to-zero`, and
`validate` refuses the agent otherwise. A ganglion agent is a good candidate for
`scale-to-zero`: it writes every turn to the transcript before the model is
called and rebuilds a missing context window from that transcript, so a stopped
container loses nothing.

The `model:` block is the agent's floor — the model a workspace runs on when the
[model inventory](./32-models-and-providers.md) resolves nothing for it. You may
also list alternatives under `models:`, which becomes the selectable allowlist;
`SelectableModels` in `config.go` returns the default followed by that list,
deduplicated by provider and name.

## Step 3: the image, and what happens without it

A ganglion agent needs `CRAB_GANGLION_IMAGE`. It has **no default**, on purpose:
the comment on `GanglionImage` in `config.go` records that a moving tag once
left a deployment running a three-week-old binary for weeks, because the harness
image is not a compose service and a redeploy never pulls it. Set it to a digest
or a per-commit tag.

When it is unset the agent does not take the proxy down. `ganglionUnprovisioned`
removes the agent from the catalog at load, records it in `DisabledAgents` with
the name of the missing setting, and the agent's routes then answer **404**. The
same happens when the agent's `apiKeyEnv` resolves to an empty value, or when
its `token` environment variable is unset. Read the proxy's boot log if a new
agent seems not to exist: the reason is there, and it names the variable.

> `docker-compose.yaml` defaults `CRAB_GANGLION_IMAGE` to
> `zombie-crab/crab-ganglion:dev`, which is a locally built tag.
> `docker-compose.prod.yaml` sets no ganglion image at all and no workflow in
> `.github/workflows/` publishes one, so a production deployment has to build
> and push the harness image itself before a ganglion agent can start.

## Step 4: the gateway route

Mycelium routes by the first path segment, and that segment is the literal
service key. Copy the `[[alpha]]` block in
`deploy/standalone/config.standalone.toml` — the service block, its
`[[alpha.secret]]` and every `[[alpha.path]]` — and rename it to `scribe`.
Callers then reach the agent at `/scribe/...`. Keep `host`,
`healthCheckPath`, the full path set and the `protectedByRoles` groups as they
are; only the name changes.

Do it in every mode you deploy, because they are separate files:
`deploy/standalone/config.standalone.toml` and `deploy/prod/config.base.toml`.

The `protectedByRoles` entries also declare the guest role. **A guest role's
name is the agent key** — the gateway declares
`protectedByRoles = [{ name = "alpha", permission = "write" }]` and Mycelium
creates those roles at boot, which is the fact
`crab/crab-exoskeleton-webapp/lib/invitations.ts` is built on. So a new agent
brings its own role into existence, and inviting someone to it is then an
ordinary invitation from the Members section of the admin area.

## Step 5: the environment

Two variables, in `.env` and never in a config file:

```
MYC_PICOCLAW_SCRIBE_TOKEN=<the same shared secret the gateway route uses>
SCRIBE_API_KEY=<the provider API key>
```

The token authenticates the gateway to the proxy. The API key never reaches a
file the agent can read: for a ganglion agent the proxy passes it as
`GANGLION_API_KEY`, or as one `GANGLION_MODEL_KEY_<NAME>` variable per model
when the inventory governs the workspace. [Models and
providers](./32-models-and-providers.md) covers that naming.

## Step 6: restart, and the first chat

The gateway configuration is mounted from `deploy/<mode>/`, so a route change
needs a restart. The agent catalog is copied into the proxy image, so a catalog
change needs a rebuild — unless your deployment mounts its own catalog, in which
case a restart is enough. Locally, the safe catch-all is to rebuild both:

```bash
docker compose up -d --build crab-shell-proxy mycelium-gateway
```

The first time a member with the `scribe` role sends a message, the proxy
creates their workspace: it makes `workspace/` with its `memory/`, `public/`,
`sessions/` and `windows/` subdirectories, mints a per-user bearer token for the
container, seeds `USER.md` from the persona cascade if anything provides one,
renders the harness's configuration file and starts the container.

Files the agent delivers back to the member go in `public/attachments/`. See
[files and delivery](./14-files-and-delivery.md).

## Checklist

- [ ] `data/templates/scribe/workspace/{AGENT.md,SOUL.md,HEARTBEAT.md,USER.md}`
- [ ] Catalog entry in `crab/crab-shell-proxy/config.yaml` with
      `harness: "ganglion"`, `serviceName`, `token`, `template`, `mode` and
      `model`
- [ ] `CRAB_GANGLION_IMAGE` set to an immutable reference
- [ ] `[[scribe]]` service block in the gateway config of every mode you deploy
- [ ] `MYC_PICOCLAW_SCRIBE_TOKEN` and the model's `apiKeyEnv` in `.env`
- [ ] Proxy rebuilt or its catalog remounted, gateway restarted
- [ ] A member invited to the `scribe` role from the Members section

## When it does not work

**The agent's routes answer 404.** Either the gateway has no `scribe` service —
check that you edited the file the mode you are running actually mounts — or the
proxy disabled the agent at load. The boot log names which.

**Requests are rejected as unauthorized.** `MYC_PICOCLAW_SCRIBE_TOKEN` in the
proxy's environment and the `token = { env = ... }` in the gateway's secret
block must resolve to the same value.

**The member chats but the agent has no personality.** `GANGLION_SYSTEM_FILE`
points at `workspace/AGENT.md` inside the container, and that file arrives as a
read-only bind from the persona cascade. If no layer of the cascade provides
`AGENT.md` — not the subscription, not the tenant, not the template — no bind is
emitted and the agent runs with no identity. Check that your template's
`workspace/AGENT.md` exists.

**A template edit did not reach an existing member.** `AGENT.md`, `SOUL.md` and
`HEARTBEAT.md` are re-resolved on every ensure, so an edit does reach them. But
`USER.md` is seeded only when the workspace has none, deliberately: it is the
file the agent writes back, and overwriting it would erase what the agent has
learned. A new value for it reaches new workspaces only.

## Where to go next

[Models and providers](./32-models-and-providers.md) explains how the model in
your catalog entry relates to the inventory an administrator manages, and which
tools an agent gets. [The admin guide](./30-admin-guide.md) covers inviting
members and giving the new agent shared skills and shared files.
