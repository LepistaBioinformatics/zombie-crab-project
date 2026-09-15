# Quick Start

This chapter takes you from a fresh clone to a conversation with your own agent
container. Follow it top to bottom. Every command here is run from the root of
the checkout, and nothing in it assumes you have used this stack before.

The path described is the shortest one that works: the development compose file,
the `alpha` agent, and one user — you. Everything else the stack can do is a
later chapter.

## Before you start

You need four things:

- **Docker**, with the Compose v2 plugin (`docker compose`, not
  `docker-compose`). The development compose file uses
  `depends_on: condition: service_completed_successfully`, which is a Compose v2
  feature.
- **Git**, because the product is assembled from four submodules and a clone
  without them builds nothing.
- **An LLM API key.** The two agents this repository ships are both configured
  for DeepSeek (`provider: "deepseek"`, `name: "deepseek-chat"` in
  `crab/crab-shell-proxy/config.yaml`), so a DeepSeek key is the least work. Changing the provider is
  [configuration](./03-configuration.md), not a code change.
- **Internet access during the build**, and patience the first time. This compose
  file builds six images from source, including Mycelium's gateway from an
  upstream git commit.

> The image builds run with `network: host` because a BuildKit container gets one
> usable DNS resolver and no fallback, and parallel builds lose lookups. That is
> already written into the compose file; you do not pass any flag for it.

## 1. Clone the repository with its submodules

```bash
git clone --recurse-submodules \
  https://github.com/LepistaBioinformatics/zombie-crab-project.git
cd zombie-crab-project
```

**How you know it worked:** `ls crab/crab-shell-proxy` lists Go source. If the
directory is empty you cloned without submodules; run
`git submodule update --init --recursive` to fix it without re-cloning.

## 2. Create your `.env`

The repository ships an annotated example per deployment mode. Copy the
standalone one, which is the local default:

```bash
cp deploy/standalone/.env.example .env
```

Now open `.env` and replace the placeholder values. Five of them matter for this
walkthrough:

| Variable | What it is for |
|---|---|
| `MYC_STANDALONE_BOOTSTRAP_SECRET` | Gates the one-time Staff claim in step 4. Unset or empty leaves the bootstrap endpoints answering 404. |
| `MYC_PICOCLAW_ALPHA_TOKEN` | The bearer token the gateway injects on `alpha`'s routes and the proxy checks. |
| `MYC_PICOCLAW_BETA_TOKEN` | The same, for the `beta` agent. You will not chat with `beta`, but see the warning below. |
| `PICOCLAW_ALPHA_API_KEY` | `alpha`'s own LLM key. This is the one that has to be real. |
| `CHAT_WEBAPP_DB_PASSWORD` | The password for the small Postgres that stores your conversation list. Any value, as long as it is the same on both sides — compose passes this one string to both the database and the app. |

Generate the secrets rather than inventing them; the example file suggests
`openssl rand -hex 32` for each, and any long random string will do.

> The picoclaw-shaped names on `alpha` are not a copy-paste error. `alpha` ran
> picoclaw once and was moved to the ganglion against the same per-user
> directories; its `serviceName` and its token were deliberately left alone,
> because the gateway routes by the first and injects the second, so renaming
> either would have been a new agent to every member rather than the same one on
> a new runtime.

> **Both agent tokens have to be set, even though you only use one agent.** The
> `beta` agent runs the picoclaw harness, and for a picoclaw agent a token that
> resolves to nothing is fatal: the proxy refuses to start rather than quietly
> removing a member's access. `alpha` runs the ganglion harness, where the same
> omission disables that one agent instead. See
> [harnesses](./11-harnesses.md) for what that difference is about.

> `PICOCLAW_BETA_API_KEY` can stay as the example's `sk-your-beta-key`. A
> picoclaw agent's key is written into the user's own configuration at
> provisioning time and a wrong one surfaces as an authentication error on the
> first message — it does not stop anything from booting. `PICOCLAW_ALPHA_API_KEY`
> is different: because `alpha` is a ganglion agent, an empty value makes the
> proxy **disable** `alpha` at boot, and its routes then answer 404.

## 3. Bring the stack up

```bash
docker compose up -d --build
```

**How you know it worked:** `docker compose ps` lists the services. Two of them
are supposed to be gone:

```
picoclaw-image    Exited (0)
ganglion-image    Exited (0)
```

Those two are build-only services. They exist so that `docker compose up`
produces the two harness images instead of leaving that as a manual step someone
forgets; each runs `/bin/true` and exits. Everything else should be `running`,
and `crab-shell-proxy` and `mycelium-gateway` should reach `healthy`.

The proxy publishes a loopback-only port in this mode, so you can check it
directly:

```bash
curl http://127.0.0.1:18080/healthz
```

Then confirm that no agent disabled itself:

```bash
docker compose logs crab-shell-proxy | grep disabled
```

Silence is the good outcome. A line of the form
`agent "alpha" disabled: … — its routes will answer 404` names the environment
variable you still have to set, and you should fix it before going on.

> The ganglion image's own build runs `go vet` and `go test` before it links the
> binary. That is deliberate — the tests are the image's acceptance check — so a
> failing test stops the stack from coming up rather than shipping a broken
> harness.

## 4. Claim the Staff account (once per deployment)

The gateway starts with no accounts at all. The first one is claimed through a
one-time web flow, gated by the bootstrap secret you set in step 2.

Open `http://localhost:8080/_adm/instance/bootstrap`, submit the bootstrap secret
and your e-mail address. The standalone deployment does not send mail: its
e-mail transport writes to the log instead. Read the six-digit code from there:

```bash
docker compose logs mycelium-gateway | grep -i bootstrap
```

Complete the claim with that code.

**How you know it worked:** the flow returns a Staff token, and the bootstrap URL
stops answering — it is a one-time endpoint and becomes a 404 once claimed.

> Use a real address you can recognise later. It is the account you will sign in
> as, and the same address has to be the one you invite in step 6.

## 5. Create a tenant and a subscription

An agent is reached inside a **tenant** (an organisation) through a
**subscription** (an account under that tenant that members belong to). Your
Staff account can create both, in Mycelium's own admin interface at
`http://localhost:8081`: sign in there as the account you just claimed, then
follow the Staff → tenant → subscription chain.

Those screens belong to Mycelium and are built from upstream sources, so this
book does not describe them click by click. What matters here is the outcome: one
tenant exists, and one subscription account exists under it.

**How you know it worked:** the subscription appears in the tenant's list in that
same interface, and you can select it in step 6.

## 6. Grant yourself the `alpha` role

Reaching an agent is a permission, not a default. The gateway declares its routes
as `protectedByRoles`, with one role named after each agent, so an account must
hold the guest role `alpha` — at **write**, which is what sending a message
needs — before anything else works. Until it does, every request is refused with
a permission error.

The roles themselves already exist: declaring them in the gateway configuration
is enough for Mycelium to create them at boot. What is manual is the grant. Do it
from the same Staff → tenant → subscription → guest-invite flow in
`http://localhost:8081`, inviting your own e-mail address to the `alpha` role
with write access.

**How you know it worked:** the invitation appears against your account in that
subscription. Once a subscription has members, the same grants can be made from
chat-webapp's own admin area — see the [admin guide](./30-admin-guide.md).

## 7. Sign in to the chat client

Open `http://localhost:3000`. This is `chat-webapp`, the member-facing client.
Sign in with the same e-mail address: there is no password, only a magic link,
and in this mode its code is logged rather than mailed:

```bash
docker compose logs mycelium-gateway | tail -50
```

On a first sign-in the app offers to create your account before it lets you into
the chat; accept, and it creates it for you against the gateway.

**How you know it worked:** you land on the chat screen instead of the sign-in
form.

## 8. Send your first message

With no workspace selected, the chat area is a picker: one row per tenant, a box
per subscription, and a tile for each agent you can reach. Pick `alpha` and send
a message.

**How you know it worked:** the agent answers — and a container that did not
exist a moment ago is now running:

```bash
docker ps --filter name=crabshell
```

You will see something like `crabshell-alpha-1a2b3c4d5e6f7890`, running as a
non-root user. The suffix is a hash of your tenant, subscription and account: a
container name is limited to 63 characters, so the identity lives in the
container's labels rather than in its name.

That container is yours. Nobody else's agent can read its files, its memory or
its conversations, because it is a different container with a different volume —
which is the whole point of the stack.

> `alpha` is configured to scale to zero. Roughly half a minute after your last
> message its container stops, freeing the memory; your next message starts it
> again with everything intact. A stopped agent is normal, not a failure.

## Where to go next

If a step did not fit your machine — a Docker version, a path, a port already in
use — [Installation](./02-installation.md) is the longer version of steps 1 to 3,
and explains what the first run writes to disk and how to wipe it. To change the
model, add an agent, or understand what you just edited in `.env`, read
[Configuration](./03-configuration.md). To understand what actually happened when
you pressed send, read [How the stack fits together](./10-architecture.md).
