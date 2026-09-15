# Harnesses

A harness is the program that actually is the agent: it holds the conversation,
calls the model, runs tools, and writes what it learned to disk. This chapter
explains what a harness is in this stack, why there are two of them, how one is
chosen per agent, and what happens when a harness cannot serve something the API
was asked for.

## What a harness is here

crab-shell-proxy does not contain an agent. It resolves who is calling, makes
sure that person's container is running, and forwards the turn to whatever is
inside it. What is inside is the harness.

The proxy talks to a harness over a fixed contract — start the container, wait
for it to answer a health check on a known port, send the turn, stream the reply
back — so the agent layer can be replaced without touching the gateway or the
orchestrator. That claim stopped being theoretical when a second implementation
appeared.

## The two harnesses

**crab-ganglion-harness** — this project's own runtime, written once picoclaw's
limits started to cost more than they saved. A static Go binary on Alpine, spoken
to over native HTTP with server-sent events. It reads its whole configuration
from the environment plus one read-only file, and it owns exactly one directory.
Its only filesystem tool is a shell, and each command it runs is confined to the
turn's workspace by the kernel (Landlock), so `..` and `/etc` are not refused by
a string check — they do not exist as far as the command is concerned.

**picoclaw** — where this project started. A container spoken to over the Pico
Protocol WebSocket, configured through a `config.json` and a `.security.yml` that
the proxy writes into each user's directory at provisioning time. It does not run
stock here: the image is a patched build, because upstream matches dispatch
selectors by exact string equality and per-project agents need a wildcard.

**picoclaw is being deprecated, and the ganglion is the harness to use.** The
proxy's own source says so: `HarnessPicoclaw` is documented as "the harness being
deprecated -- still fully served, still the right value to declare for an agent
that needs it, but no longer what an omitted key means." New work goes to the
ganglion, and this book teaches the ganglion.

## Choosing one, per agent

The choice is a single key on each agent in the proxy's `config.yaml`:

```yaml
agents:
  alpha:
    serviceName: "alpha"
    harness: "ganglion"
    token: { env: "MYC_PICOCLAW_ALPHA_TOKEN" }
    template: "alpha"
    mode: "scale-to-zero"
    idleTimeout: 30s
```

Two accepted values, `"ganglion"` and `"picoclaw"`. Anything else fails the
config load outright with a message naming the agent — a stale config naming a
runtime the proxy no longer orchestrates would otherwise hand a member a
container provisioned for something else.

**Declare it explicitly, on every agent.** An omitted key does resolve, but
relying on that means a future change to the default silently changes which
program answers your members.

### What an omitted key means today

An agent that declares no `harness:` gets `config.DefaultHarness`, and
**`DefaultHarness` is the ganglion** (`internal/config/config.go`). The empty
value is replaced in `applyDefaults`, before validation runs, so nothing
downstream of the config load ever sees an empty string.

The flip is recent and deliberate — the constant's own comment records the
reasoning: the exit criteria in the harness spec are met, every feature the gate
once reserved for picoclaw is now served by the ganglion, and the documentation
teaches this harness, so a default that disagreed with the documentation would
cost somebody an afternoon.

> The consequence an operator must know: an agent that declared nothing used to
> be a picoclaw agent and is now a ganglion one, so it needs
> `CRAB_GANGLION_IMAGE` set. A missing image does not crash the proxy — see
> below — but it does take that agent out of service.

### A ganglion agent that cannot run

A ganglion agent is checked at load for two things it cannot work without: an
image reference, and a resolved API key when the agent declares an `apiKeyEnv`.
If either is missing, that **one agent is disabled** — its routes answer 404 and
the boot log names the exact variable to set. It is not a fatal error, because a
single misconfigured test agent once put the proxy in a crash loop and took the
working agents down with it. The image is never defaulted to a moving tag, on
purpose.

picoclaw agents are not subject to that check: a picoclaw agent's key is written
into a per-user `.security.yml` at provisioning time, and an empty one surfaces
as an auth error on the first model call, which is what every existing deployment
already depends on.

## The feature gate, honestly

Some capabilities the API exposes began life as picoclaw constructs — they were
fields in a picoclaw `config.json` — and a harness that does not read that file
cannot serve them by pretending to. The rule is stated in
`internal/httpapi/harness_gate.go` and it is short: **a feature a harness cannot
serve answers `501`, naming the harness. It never quietly succeeds.**

That rule exists because of a real failure. An earlier third harness shipped with
projects and personal models unimplemented, and both were picoclaw config
constructs it never read — so a project could be created, stored, listed and
reported active while changing nothing about the agent that answered. The member
was told it worked. A 501 is worse to receive and far better to debug.

Four features are named in the gate:

| Feature | Gate name |
|---|---|
| Projects | `projects` |
| Personal model selection | `personal model selection` |
| The memory graph | `the memory graph` |
| Scheduled tasks | `scheduled tasks` |

The first three are listed in a table called `picoclawOnly`. The table is
deliberately an **allowlist of what works**, not a denylist of what does not: a
third harness added later is refused by default and has to be declared feature by
feature, which fails in the safe direction.

A second table, `alsoServedBy`, records the harnesses that have since grown one
of those features — and **the ganglion is listed for all three**. Projects,
personal model selection and the memory graph all work on the ganglion today.
Two tables rather than one deletion, because both statements stay true: the
feature is still a picoclaw construct in origin, and a harness that has not
implemented it is still refused.

So the practical position is this: **with the two harnesses this stack ships,
`requireHarnessFeature` refuses nothing.** The 501 is what a third harness would
get on its first day, before anyone declared what it can do. That is the state
the gate is designed to produce, not a gap.

`scheduled tasks` is declared in the gate and deliberately **absent** from
`picoclawOnly`. The read routes under `/v1/cron/*` need no running container and
are never gated: showing an inert schedule is better than hiding one, and the
response reports the truth about when a task fires rather than refusing.

## Cron writes are ganglion-only

Creating, editing and deleting a scheduled task over the API is a separate gate,
written inline in `cronWriteScope` (`internal/httpapi/cron_write.go`) rather than
in the feature table — and it is the one place where the two harnesses genuinely
differ today.

The check is `agent.Harness != config.HarnessGanglion`, and anything else gets a
501 saying "creating scheduled tasks over this API is not available on the
`picoclaw` harness (agent `<key>`): its agent creates them itself."

The reason is ownership. On picoclaw the schedule lives in timers inside the
container that this process cannot see; writing its `jobs.json` from outside
would produce a record the member can see and a timer that never changed. On the
ganglion the **proxy** owns the schedule, in a file above the container's bind,
so it can both write it and fire it. That placement also means a turn steered by
untrusted text cannot schedule its own future turns.

On picoclaw, the surface that still works is asking the agent in conversation.
See [Scheduled tasks](./22-scheduled-tasks.md) for the member-facing story.

## Other differences worth knowing

- **Templates.** A picoclaw agent is seeded from a template directory (the proxy
  embeds a default and auto-bootstraps a missing one). A ganglion agent is
  provisioned with **no template at all**, on purpose: the template is a picoclaw
  `config.json` plus a `.security.yml`, and seeding one there would leave two
  files nothing reads.
- **Secrets.** picoclaw receives credentials as files under `.secrets/`. The
  ganglion receives them as environment variables, and a ganglion workspace has
  no `.secrets/` directory at all.
- **What gets mounted.** The two harnesses share one on-disk layout and differ in
  what they bind into the container. That difference is load-bearing and is
  covered in [Agents, workspaces and projects](./12-agents-and-workspaces.md).
- **Lifecycle.** Each agent is `scale-to-zero` or `continuous`. picoclaw's native
  connectors dial out from inside the container and bypass the proxy, so an agent
  reached that way must be `continuous`. A ganglion agent has no such side door,
  so the mode is a plain cost decision there.

## A production caveat

There is no published ganglion image. The development compose builds one under
`zombie-crab/crab-ganglion:dev`, a tag that lives only on the machine that built
it, and `docker-compose.prod.yaml` sets no `CRAB_GANGLION_IMAGE`. If you deploy
with the prod profile and run ganglion agents, supplying that image is your job.

## Where to go next

[Agents, workspaces and projects](./12-agents-and-workspaces.md) for what each
harness sees on disk, [Scheduled tasks](./22-scheduled-tasks.md) for the cron
surface, and [crab-ganglion-harness](./51-crab-ganglion-harness.md) for the
runtime itself.
