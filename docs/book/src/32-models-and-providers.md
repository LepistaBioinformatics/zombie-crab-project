# Models and providers

This chapter explains how a turn ends up talking to a particular model, what
happens when that model fails, and why two members of the same deployment can
see different tools in the same agent. It is written for the ganglion harness,
which is the one this book teaches; see [harnesses](./11-harnesses.md) for the
other one.

Two systems are involved and it helps to keep them apart. The **proxy** decides
*which models a workspace has* — that is the inventory and the cascade described
in [the admin guide](./30-admin-guide.md). The **harness** decides, turn by
turn, *which of those models actually answers*. This chapter is about the second
half, plus the plumbing that carries credentials between the two.

## How the harness learns about models

Every time the proxy makes sure a member's container is ready, it resolves that
workspace's model from the inventory and writes a configuration file into the
member's directory: `.ganglion-config.json`. The file is bound into the
container **read-only** at `/data/.ganglion/config.json`, and
`GANGLION_CONFIG_FILE` points the harness at it
(`crab/crab-shell-proxy/internal/docker/ganglion_config.go`).

It is read-only, and it sits above the one directory the container can write,
for a specific reason: a model list the agent could edit would let a tool
steered by untrusted text choose the endpoint its own API keys are sent to.

The file's shape is picoclaw's `config.json`, deliberately, so that one admin
screen manages both harnesses. The harness reads `model_list`,
`agents.defaults.model_name`, `agents.defaults.model_fallbacks`,
`agents.defaults.image_model`, `agents.defaults.image_gen_model`, `tools.web.*`
and `tools.mcp`, and ignores everything else it finds. A missing file is not an
error: the harness synthesizes a one-entry list named `default` from three
environment variables and behaves as it did before the file existed
(`LoadRegistry` in `crab/crab-ganglion-harness/internal/config/file.go`).

## The three chains

A turn asks the registry for an ordered list of candidate models. Which list it
gets depends on the **kind** of turn (`Kind` in the same file):

| Kind | Configured by | Falls back to the text chain? |
|---|---|---|
| text | `agents.defaults.model_name` + `model_fallbacks` | it *is* the text chain |
| vision | `agents.defaults.image_model` + `image_model_fallbacks` | **yes** |
| image generation | `agents.defaults.image_gen_model` + `image_gen_model_fallbacks` | **no** |

### The text chain

`Chain` builds the candidate list as follows. If the turn named a model the
registry actually knows, that model goes first. Otherwise the list starts with
`model_name` followed by `model_fallbacks`. Then — for every entry already in
the list — that entry's own `fallbacks` are appended, one level deep. Entries
that are disabled or unknown are dropped, and duplicates are collapsed.

> A turn naming a model the registry does not have is the *ordinary* case, not
> an anomaly: the proxy fills the turn's model field with a placeholder. So the
> harness resolves it silently to the default chain rather than reporting
> anything to the member.

The one-level rule is worth noticing. A fallback's fallbacks are not walked
recursively, and the expansion iterates over a snapshot, so a cycle in the
configuration cannot hang a turn.

An administrator does not edit this file to change the chain. `model_fallbacks`
is written by the proxy from the chain declared on the inventory record of the
model that resolved, so the chain is edited in the Model section of
[the admin guide](./30-admin-guide.md).

### The vision chain

A turn is a vision turn when any message in the context window carries an
attachment (`hasAttachments` in `crab/crab-ganglion-harness/internal/runtime/loop.go`).

If `image_model` names an entry, that chain answers. If it does not, the
registry **returns the text chain instead**. That is not a courtesy: whether a
model can see is a property of the model, not of a slot, so a deployment whose
only model happens to be multimodal needs no second entry and should not be made
to write one.

### The image-generation chain

This one does **not** fall back. If `image_gen_model` names nothing, the chain
is empty. The reason is stated in the code: a text model asked to generate an
image returns prose describing one, which is worse than an absent tool because
it looks like success.

The consequence is the next section.

> The proxy's renderer writes `model_name`, `model_fallbacks`, `model_list`,
> `tools.web` and `tools.mcp` — and **not** `image_model` or `image_gen_model`
> (`ganglionConfigDoc` in
> `crab/crab-shell-proxy/internal/docker/ganglion_config.go`). For a ganglion
> agent those two keys reach a workspace only by being added by hand in the
> single-instance editor of the Config section, which stores them in the
> per-instance overlay. Neither is a proxy-owned key, so the overlay keeps them
> and re-applies them on every render. A vision or image-generation chain is
> therefore per member on this harness, not something a scope can set.

## What a fallback means at turn time

A chain is not a retry loop around the whole turn. `completeWithFallback` in
`loop.go` states the rule: **a candidate is abandoned only while nothing has
reached the member.** Once a single byte of content has been emitted, the turn
is committed to that model and its failure surfaces — restarting under another
model would splice two voices into one reply, and the member has already read
the first half of the first one.

When the chain runs out, the error the member sees is the **last** provider's,
not a synthetic summary. An operator needs the reason the final attempt failed,
and "all 3 models failed" would bury it.

There is one degradation on top of that, and it is a feature rather than
politeness. If the whole chain fails on a turn that carries an image, the image
is dropped and the turn is retried **once**, text-only, with the model told what
happened. The member sees a progress note saying the image could not be read and
gets a degraded answer that says so.

The reason this exists is that the alternative is permanent. The media reference
stays in the conversation history, so a harness that simply failed would fail
the same way on every later turn in that conversation. This stack met exactly
that in production.

## Which agent tools exist

This is the question members actually ask — "why can't my agent search the web",
"why can't it make me an image" — and the honest answer is that the tool
registry is **conditional**. A tool whose prerequisites are not configured is
not present at all. It is not present-and-failing, because a tool the model is
told about and that can never answer is worse than no tool: it spends a turn
discovering the absence.

`tools()` in `crab/crab-ganglion-harness/cmd/crab-ganglion/main.go` is the whole
decision:

| Tool | Present when |
|---|---|
| shell | always |
| `load_image` | always |
| `set_reasoning_depth` | always |
| `web_search`, `web_fetch` | at least one search provider is enabled **and** ready |
| `generate_image` | the image-generation chain has at least one entry **with an API key** |
| subagent dispatch | sub-agent fan-out is enabled with non-zero budgets |
| `research` | subagent dispatch exists **and** a search provider is configured |
| memory graph tools | the proxy minted an MCP token for the workspace |

`load_image` is unconditional on purpose: an image in the workspace is something
any deployment can have. Whether a model can *see* the result is decided by the
vision chain at completion time, not here.

`research` needs both a dispatcher and search, because without search it is a
model asked to recall — which is the failure it exists to replace.

The harness logs each of these decisions at boot. If a member reports a missing
capability, the container's first few log lines say which tools were enabled and
which were not.

### Why search in particular is easy to get wrong

Two lists of provider names have to agree and they do not fully overlap.

The **proxy** accepts a `native` shared secret at slot `web.<provider>` for
these: `brave`, `tavily`, `kagi`, `gemini`, `perplexity`, `glm_search` and
`baidu_search` (`webProviders` in
`crab/crab-shell-proxy/internal/docker/secrets.go`). Every one of them is
written into the ganglion's configuration as `tools.web.<name>: {enabled: true}`
with its key passed separately.

The **harness** implements four: `brave`, `tavily`, `searxng` and `duckduckgo`,
in that preference order when `tools.web.provider` is unset
(`WebProviderNames` in `file.go`). Anything else in the file is ignored.

So of the providers an administrator can register through the Secrets section,
only `brave` and `tavily` will actually give a ganglion agent a search tool.
Registering a `kagi` or `perplexity` key produces a configuration that looks
correct and yields no tool.

Readiness differs per provider too (`providers.go`): `brave` and `tavily` need a
key, `searxng` needs a `base_url` and no key, and `duckduckgo` needs only to be
enabled. A provider block with no `enabled: true` is off — declaring
`"brave": {}` leaves it present and disabled, which matches picoclaw's own
examples.

## Provider keys

Credentials never travel in the configuration file. The proxy splits structure
from secrets the way picoclaw does: the file carries endpoints and names, the
environment carries keys, one variable per model.

There are three places a key can come from.

**The agent's own key.** Each agent in `crab/crab-shell-proxy/config.yaml`
names an `apiKeyEnv`, and the proxy reads that variable from its own
environment. For a ganglion agent this becomes `GANGLION_API_KEY`, alongside
`GANGLION_MODEL` and `GANGLION_BASE_URL`. This trio is the floor: what a
workspace runs on when the inventory resolves nothing for it.

If that variable is unset, a ganglion agent is **disabled at load**. The proxy
records the reason, naming the variable, and the agent's routes answer 404
rather than the proxy refusing to boot. A picoclaw agent is deliberately not
subject to this — its key is written into a per-user file and an empty one
surfaces as an auth error on the first model call.

**An inventory model's key.** When the cascade resolves a model from the
inventory, its key is passed as `GANGLION_MODEL_KEY_<NAME>`, one variable per
model in the chain. The name is derived by upper-casing the model name and
replacing everything outside `A-Z0-9` with an underscore. Both sides compute it
independently — `ganglionModelKeyEnv` in the proxy and `KeyEnvVar` in the
harness — and the two agreeing is the entire contract. Two model names differing
only in punctuation collide, which is accepted: the alternative is an encoding
nobody can read in `docker inspect` output, which is where these get debugged.

**A search provider's key.** Same scheme, different prefix:
`GANGLION_WEB_KEY_<PROVIDER>`, from the `native` shared secret at slot
`web.<provider>`.

The harness resolves a key from the environment **first** and only then from the
file. The environment wins because that is the path the proxy uses, and because
a key that never enters a file cannot be read by anything that gets pointed at
the file by mistake.

A model in a chain whose key is empty is simply not offered to the
image-generation tool — `imagegen.New` filters candidates on a non-empty key and
returns no tool when none survive. On the text chain the effect is different: the
candidate is attempted and fails at call time, and the chain moves on.

> Keys may also be stored encrypted. A value beginning `enc://` is resolved
> inside the container from two factors that arrive by different routes — a
> passphrase in `GANGLION_KEY_PASSPHRASE` and a key file bound read-only from
> the host. They are deliberately of different kinds: both as environment would
> mean one `docker inspect` yields the plaintext.

## Where a model's endpoint comes from

The ganglion is given a base URL and posts to it; it has no internal table
mapping a provider name to an address. Picoclaw did have one, so an agent
migrated from picoclaw arrives naming a provider, naming no endpoint, and used
to fail on its first turn with `unsupported protocol scheme ""`.

The proxy fills the gap from three sources, in order
(`resolveGanglionEndpoints` in
`crab/crab-shell-proxy/internal/docker/ganglion.go`):

1. The **inventory record's own `api_base`**, which is final. A custom model is
   custom precisely because its endpoint is not its provider's default.
2. The **agent's `baseUrl`** from `config.yaml`.
3. The **provider's default**, from an embedded catalog of about thirty
   provider/model pairs (`ProviderEndpoint`, `model-catalog.json`).

Fallback entries are filled too, not just the primary — a chain whose second
entry has no endpoint is a chain that works until the day it is needed. A
primary with no endpoint anywhere is refused where an operator can see it.

Two caveats from `provider_endpoint.go`. Azure's catalogue entry is a
fill-in-the-blank shape rather than an address, so it is excluded from the
fallback table. And the local runtimes — `ollama`, `lmstudio`, `vllm`,
`github-copilot` — have localhost entries, which inside a container means the
*container*, not the host; using one of those means setting an explicit
`baseUrl`.

## Reasoning depth

A model entry may declare `thinking_level`, one of `off`, `low`, `medium`,
`high`, `xhigh` or `adaptive`. Declaring the key **is** the capability
declaration: a model with no `thinking_level` is never sent a depth field by any
path, because the harness cannot discover whether an endpoint accepts one and
the operator can.

An unrecognised value is treated as absent and produces a warning, rather than
being read as `off`. That distinction matters: a typo that silently meant "think
less" would look like a working configuration right up to the bill.

If a model rejects a reasoning field mid-chain, the field is removed and the
**same** model is asked once more, rather than the chain burning its budget on a
field nobody asked for.

## Where to go next

[The admin guide](./30-admin-guide.md) covers registering models and choosing
who gets which. [Creating a custom agent](./31-custom-agent.md) shows where an
agent's default model is declared.
[Troubleshooting](./43-troubleshooting.md) collects the symptoms these
mechanisms produce.
