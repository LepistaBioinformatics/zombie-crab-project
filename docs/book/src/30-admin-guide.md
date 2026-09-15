# Admin guide

This chapter is for whoever runs a deployment day to day: adding people, giving
their agents material to work with, deciding which model they get, and repairing
one member's configuration when it goes wrong. It assumes the stack is already
installed — see [installation](./02-installation.md) if it is not.

## Tenants, subscriptions and scopes

Identity in this stack comes from **Mycelium**, an external API gateway. A
**tenant** is an organisation; a **subscription** is one account under a tenant,
and it is the only level at which a member list exists. A tenant may have many
subscriptions.

Everything an administrator publishes is published at a **scope**, which is
either a tenant or a subscription. A tenant scope reaches everyone under it; a
subscription scope reaches only that subscription. Where both have something to
say, the narrower one wins.

What you may administer depends on your tier, resolved from the Mycelium profile
on every request (`CallerTier` in
`crab/crab-shell-proxy/internal/authz/authz.go`). Instance staff are
authoritative everywhere; a `tenant-owner` or `tenant-manager` over one tenant
and every subscription under it; a `subscriptions-manager` over exactly one
subscription. The admin area lists only the scopes you can manage, and the proxy
checks again on every write — the interface narrowing itself is a convenience,
not the gate.

## The shape of the admin area

The admin area lives in the chat webapp, at `/admin`. It has two top-level
items: **Workspaces**, which is everything scoped, and **Branding**, which is
instance-wide (`railItems` in
`crab/crab-exoskeleton-webapp/app/admin/admin-nav.ts`).

Under Workspaces you choose an **agent first**, then a scope. That order is
deliberate: agents come from the proxy's configuration and exist before any
tenant does, so asking for the scope first implied that agents were a property
of a subscription. Every section then acts on that (agent, scope) pair.

The sections are **Files, Secrets, Skills, Persona, Model, Config** and
**Members**, in that order (`SECTION_TABS` in
`crab/crab-exoskeleton-webapp/app/admin/tabs.ts`). Which of them a given agent
offers is decided in `agent-scope.ts`, and today a ganglion agent and a picoclaw
agent both offer all seven. There is also a legacy "all agents" address holding
shared content written before content became per-agent; it offers the content
sections only, because a persona write, a model assignment and an invitation all
need a real agent to attach to.

The mental model is worth stating once: you edit **shared** material at a scope,
the proxy merges the scopes into an **effective** view on disk, and each
member's container mounts that view **read-only**. One member never sees
another's private workspace.

## Files

Files uploaded here reach every member's agent under the scope, as read-only
bind mounts at `workspace/.shared/<layer>` inside the container — one directory
per layer, named `tenant`, `subscription`, `tenant-agent` and
`subscription-agent` (`sharedFileBinds` in
`crab/crab-shell-proxy/internal/docker/shared.go`). The agent can read them; it
cannot change them.

Files are the one section whose writes need no container restart. The mount is
live, so a new file appears in every running container immediately, and the
proxy deliberately does not recreate the container — doing so used to truncate a
member's conversation mid-turn.

## Secrets

Secrets are credentials the agents need without them being baked into an image
or a template. Four formats are supported
(`crab/crab-shell-proxy/internal/docker/secrets.go`):

| Format | Where it lands |
|---|---|
| `dotenv` | a `.env` file of `NAME=value` lines |
| `json` | a `secrets.json` object |
| `file` | one file per secret, content is the value |
| `native` | a named slot in the harness's own configuration |

The first three are for a skill that reads a credential from somewhere
conventional. The `native` format fills a slot the runtime itself knows about,
and only two slot shapes are accepted: `web.<provider>` for a search provider's
key, and `model_list.<model>.api_keys` for a model the inventory already knows
(`validateNativeSlot`). Anything else is refused.

A `web.<provider>` secret is what turns on an agent's web search. The provider
names the two harnesses accept are not identical, so read
[models and providers](./32-models-and-providers.md) before registering one.

Secrets are write-only over the API. You can list the names that exist; nothing
reads a value back out.

## Skills

A **skill** is a folder containing a `SKILL.md` — YAML front matter with a
`name` and a `description`, then a Markdown body — plus whatever supporting
files it needs. [Skills and memory](./13-skills-and-memory.md) explains what
they are for.

Publish one at a scope either by writing its `SKILL.md` inline or by uploading a
**zip** of the folder; the proxy accepts a `file` part or a `body` part and
refuses a request carrying neither. You can download any published skill back as
a zip.

Skills merge across four layers in ascending precedence: tenant, tenant+agent,
subscription, subscription+agent (`syncEffectiveSkills` in
`crab/crab-shell-proxy/internal/docker/skills.go`). A skill folder present at
more than one layer is taken from the most specific one, entire — the layers do
not merge file by file. The merged result is written into a directory whose
inode is kept stable, so an edit reaches running containers without recreating
them.

## Persona

Four files define an agent's identity, and the set is fixed and closed
(`PersonaFiles` in `crab/crab-shell-proxy/internal/docker/persona.go`):

| File | What it is | How it is delivered |
|---|---|---|
| `AGENT.md` | what the agent does and how it behaves | read-only mount |
| `SOUL.md` | its voice | read-only mount |
| `HEARTBEAT.md` | its recurring task list | read-only mount |
| `USER.md` | what is known about the member | seeded only |

The set is closed because these endpoints write into a workspace root: an
arbitrary filename here would be an arbitrary file write reaching every
container under the scope.

The first three are resolved per workspace in precedence order —
subscription+agent, then tenant+agent, then the agent's template
(`resolvePersonaSources`) — and mounted read-only. This is precedence, not a
merge: two `AGENT.md` files cannot be combined into one identity. A member
cannot edit them, and an edit inside the container never survives a restart.

`USER.md` is the exception, because the agent writes to it: it is where the
agent accumulates what it learns about the member. Setting it here defines what
a **new** workspace starts from, and never overwrites an existing one.

Each row says whether the file is set at this scope or inherited. The editor
preloads what the agent actually runs, resolved down the cascade, so you edit a
real identity rather than a blank page; saving is what makes it this scope's.
Clearing it lets the workspace fall back to the broader scope, or to the
template.

## Model

An administrator controls two separate things here: an **inventory** of models
the deployment can serve, and a **cascade** that decides which of them a given
workspace resolves to.

The inventory is one list for the whole proxy, held in one file —
`model-registry.db` under the proxy's data root. A model is registered once,
with its credentials, and every scope points at that record rather than holding
a copy. A record carries a provider, a model name used as the handle everywhere
else, the identifier actually sent to the endpoint, an API base URL, a
write-only API key and that model's own ordered **fallback chain**.

The fallback chain is a property of the model, not of a scope: it names other
registered models to try after this one. The editor offers only active models as
candidates, because the resolver skips a non-active fallback anyway. The order
the inventory list is *displayed* in is presentation only and has no effect on
resolution.

A model has one of three statuses. **Active** is offered normally. **Disabled**
is reversible and requires that nothing references the model — no workspace, no
scope default, no other model's chain — so the proxy refuses with the list of
referrers when something does, and the same check blocks deleting a model.
**Deprecated** is for a model people are still using: it requires you to name a
replacement, and that replacement is followed only for workspaces that have not
already materialised the deprecated model. That single condition is what
produces "new members get the successor, existing members keep what they have"
without a second code path.

### The cascade

Six levels decide which model a workspace gets. Read downwards; each covers
fewer people than the one above and overrides it (`Resolve` in
`crab/crab-shell-proxy/internal/registry/resolve.go`):

```
global             the whole instance
agent              every tenant running this agent
tenant             one tenant
subscription       one subscription
user (a pin)       one person, set by an administrator
the member's own   one person, registered by themselves
```

The narrowest level that names a model wins, and that is what a newly
provisioned workspace lands on. Levels below a cleared one stay set and take
over, which is why the panel draws the whole ladder rather than one level at a
time: you can see what your write overrides and what clearing it would fall back
to. A level you lack the authority to read is drawn as unreadable rather than as
unset — an instance-wide level you cannot see may still be covering your scope.

**You may only write the level your scope is sitting on.** With a subscription
selected you can edit the subscription level and individual pins; with a tenant
selected you can edit the tenant level and nothing else (`editableLevels` in
`crab/crab-exoskeleton-webapp/lib/models.ts`). The agent and global levels are
readable here and not writable here — the agent level is labelled with the
selected agent's name but reaches every tenant running that agent, which inside
a screen whose rail says "this subscription" reads as something far narrower
than it is. The first global or agent default has to be written out of band.

A **pin** is one person, outranking every administrator-set level above it. Use
it for an individual; to move a group, set their scope's level instead. Pins
live under a subscription, and a person appears only once they have a workspace
— that is, after their first chat.

> A scope default naming a model that no longer exists is **skipped** and the
> cascade carries on to the next level, because a stale default imported at boot
> would otherwise refuse every workspace under that tenant. A **pin** naming a
> missing model is not skipped; it is a hard failure, because it was set
> deliberately.

If nothing resolves at all, what happens depends on the harness. A picoclaw
workspace is **refused** and nothing is written, because picoclaw fails at
startup when its default names a model absent from its model list, so a silent
default would produce a permanently unbootable container. A ganglion workspace
falls back to the model declared in the agent's own catalog entry, and that
fallback is deliberately not recorded as an assignment.

### Members' own models

A member can register models of their own, with their own API keys, and a
personal model **outranks every level above it, including an administrator's
pin**. Their key, their choice — the administrator's control here is a scope
lock, not a per-person veto.

That lock has two independent switches, each of which can be set, cleared, or
left to inherit from a wider scope (`ScopePolicy` in
`crab/crab-shell-proxy/internal/registry/usermodels.go`):

| Switch | Unset everywhere means |
|---|---|
| may members use their own models at all | **allowed** |
| may they name an endpoint outside the catalogue | **denied** |

The defaults are deliberately opposite. Personal models are the point of the
feature, so they are allowed unless someone objects; a member who cannot name an
endpoint cannot aim the instance at one, which is a whole class of risk rather
than a governed instance of it. The policy has its own cascade — subscription,
tenant, agent, global — and the first level that *sets* a switch decides it.
Flipping a policy restarts nothing; it takes effect the next time each workspace
is prepared.

Separately, the User models list lets you disable one member's one model. It
starts enabled: the switch is an intervention, not a gate to pass. Disabling it
re-prepares every workspace that was using it and raises a restart notice rather
than forcing a bounce. Members have no such switch of their own — their way to
stop using a model is to stop selecting it.

A member may register at most ten models, must supply both an endpoint and a key
for each, and may only choose from a provider list narrower than the admin
inventory's: the OpenAI-compatible family, with the OAuth and vendor-specific
providers deliberately absent.

What happens once a workspace has a model — the fallback chain at turn time, the
vision chain, image generation, and which tools appear — is
[models and providers](./32-models-and-providers.md).

## Config

This section reaches the runtime configuration of one member's instance, or of
one key across a whole subscription.

**Bulk** works on one subscription at a time. You name a dotted path to a single
value, read the current distribution first — what each member holds now — and
only then write. Instances whose key is absent, blocked by a conflicting path,
or whose configuration cannot be read are excluded from the write and listed so
you can repair them one at a time.

Keys the **proxy owns** are refused, because a change there could not survive —
the proxy rewrites them every time it prepares a workspace. `ManagedConfigPaths`
in `crab/crab-shell-proxy/internal/docker/instance_config.go` is the list: the
model list, the default provider, model name and fallbacks, the workspace path,
the context manager, the pico channel switch and the proxy's own memory-graph
MCP entry.

**Single instance** opens one member's configuration as formatted JSON or as a
tree, validates it and writes it back.

How that write reaches a ganglion agent differs from picoclaw. A picoclaw
workspace's `config.json` is seeded once and then edited in place, so an edit
simply stays. A ganglion workspace's configuration is **rendered whole every
time the container is prepared**, so an edit written into the file would be gone
on the next turn. The proxy therefore stores the edit in a per-instance
**overlay** beside the file and re-applies it on every render
(`crab/crab-shell-proxy/internal/docker/ganglion_overlay.go`). A broken overlay
is logged and skipped rather than treated as fatal.

> The overlay is also the only route by which `agents.defaults.image_model` or
> `agents.defaults.image_gen_model` can reach a ganglion agent. The proxy's
> renderer never emits either key, so neither appears in the bulk key picker —
> which is generated from that renderer — and both have to be added by hand in
> the single-instance editor. The editor diffs the whole document and records
> every changed leaf that is neither malformed nor proxy-owned, and these two
> are neither. See [models and providers](./32-models-and-providers.md).

A configuration change lands on the instance's next start. The restart control
in the menu decides how that bounce happens: **now**, the default; **schedule**,
which bounces the scope at a time you pick; or **notice**, which leaves the
moment to the member, who sees a pending-restart notice in chat
(`crab/crab-shell-proxy/internal/httpapi/restart_policy.go`). The change itself
always propagates immediately — only the container bounce is deferred.

An instance can also be pinned to a different **lifecycle mode** than its agent
declares. The reason it exists is scheduled tasks that run from timers inside a
container: one member who needs a daily report is a reason to keep one container
running without forcing the whole agent to.

## Members

The Members section lists the people in the selected **subscription**, with the
instances and stored files each of them has. A tenant scope has no member list,
because membership is a subscription-level fact.

Inviting is Mycelium's guest machinery, reached over JSON-RPC; the webapp stores
no invitation state of its own. Two facts make it work
(`crab/crab-exoskeleton-webapp/lib/invitations.ts`):

- **A guest role's name is the agent key.** The gateway declares
  `protectedByRoles = [{ name = "alpha", permission = "write" }]` and Mycelium
  creates those roles at boot, so "invite someone to agent `alpha`" is literally
  "guest them with the role named `alpha`".
- **The permission lives on the role**, not on the invitation call. Choosing
  read or write is choosing which role id to send. Write is what chatting
  requires; read is view-only.

The form does not ask which agent, and that is a fix rather than an omission: it
uses the agent you selected at the gate. It used to carry an agent picker of its
own, three fields deep, which meant two agent selections on one screen and the
one that decided access was the invisible one. Revoking is done from the
person's own row in the roster, not from the invite form.

You can see the metadata of a member's private files — name, size, modified time
— and delete one. There is deliberately **no** way to open, download or preview
a member's private file from here, at any tier. The panel exposes no such
affordance and the proxy has no such endpoint.

## Branding

Branding is instance-wide and is not scoped to any tenant, agent or
subscription. It sets the application name and lets you upload or reset a light
logo, a dark logo and an application icon. It appears only for callers who may
edit it, because a console offering one thing a caller cannot use reads as a
broken screen rather than as an answer about their authority. The proxy is the
real gate.

## Where to go next

[Models and providers](./32-models-and-providers.md) is the other half of the
Model section. [Creating a custom agent](./31-custom-agent.md) covers adding an
agent for these sections to administer. [Troubleshooting](./43-troubleshooting.md)
collects the failures people actually report.
