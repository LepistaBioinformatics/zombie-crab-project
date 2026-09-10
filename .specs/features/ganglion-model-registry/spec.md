# ganglion-model-registry — Specification (authoritative)

**Status:** Implemented across all three repositories. See "Implementation status" below.
**Date:** 2026-09-10.
**Spans:** `crab-ganglion-harness`, `crab-shell-proxy`, `crab-exoskeleton-webapp`.
**Closes:** `crab-ganglion-harness` spec DF-4 ("personal model overrides — answers 501").

## Problem

The stack already owns a full model inventory: `model-registry-source-of-truth`
built a bbolt-backed registry with CRUD, a five-level resolution cascade
(personal model > user pin > subscription > tenant > agent > global), deprecation
with a named replacement, usage tracking that blocks deletion, and per-model
fallback chains. `user-owned-models` added member-registered models on top, with
a connectivity probe and admin policy locks.

**None of it reaches a ganglion agent.** A ganglion container's model comes from
one static field in the proxy's own `config.yaml` — `agent.Model` — shipped as
three environment variables at container create:

```
GANGLION_MODEL, GANGLION_BASE_URL, GANGLION_API_KEY
```

The harness reads exactly one model, one endpoint, one key
(`internal/config/config.go`), and `runtime.Loop.Model` overrides every turn's own
`Model` field (`loop.go:412-420`), so even the per-turn seam the domain already
has is inert.

Three gates enforce that today, and each is correct **only while the harness
cannot read a registry**:

| Gate | Effect |
|---|---|
| `rejectNonPicoclawAgent` (`admin_model_scopes.go:37`) | `400` on per-user model assignment for a ganglion agent |
| `picoclawOnly[featurePersonalModel]` (`harness_gate.go`) | `501` on the whole member-facing `/v1/models/mine` surface |
| `PICOCLAW_ONLY = ["model", "config"]` (webapp `agent-scope.ts`) | the Model tab is absent for a ganglion agent |

The proxy's own comment states the reason, and it is a good one: *"A harness that
read its model from somewhere else would take an assignment nothing ever
consults: the write restarts the container for nothing and leaves a phantom
workspace referrer that blocks delete and disable of that model forever."*

So this feature is not "build a registry". It is **teach the harness to read one,
then remove the three gates that exist because it could not.**

## Compatibility — what the word means here

The requirement is *"compatível com o picoclaw para permitir que o webapp e proxy
e tudo mais permita eu gerenciar usando as mesmas ferramentas"*.

**Compatible means the same configuration format drives both harnesses. It does
not mean identical runtime behaviour.** Written down once, because it will
otherwise be re-argued at every divergence: picoclaw's fallback engine consults a
cooldown tracker and a rate-limiter registry (`pkg/providers/fallback.go`);
ganglion's will not in v1. Both read the same `model_list`.

Concretely, ganglion adopts picoclaw's schema, verified against
`pkg/config/config.go:760-798`:

```jsonc
{
  "model_list": [
    { "model_name": "primary",       // the alias the rest of the config names
      "provider": "deepseek",        // routes to a protocol adapter
      "model": "deepseek-chat",      // the id sent on the wire
      "api_base": "https://api.deepseek.com/v1",
      "enabled": true,
      "fallbacks": ["backup"],       // other model_name entries
      "extra_body": {},
      "custom_headers": {},
      "request_timeout": 0,
      "api_keys": ["enc://…"] }      // OPTIONAL here — see FR-4
  ],
  "agents": { "defaults": {
      "model_name": "primary",
      "model_fallbacks": ["backup"] } }
}
```

## Functional requirements — the harness

**FR-1 — a config file, read-only, outside the workspace.** The harness reads
structural configuration from a JSON file at `GANGLION_CONFIG_FILE` (default
`/data/.ganglion/config.json`). It is mounted read-only and **must live outside
the workspace bind**, exactly as `credential.key` already does — otherwise the
shell tool could rewrite the model list, and a tool steered by untrusted natural
language would be choosing its own provider endpoint.

**FR-1.1** — absence of the file is not an error. A deployment that sets only the
three environment variables keeps working unchanged; they synthesize a
single-entry `model_list` named `default`. This is the back-compatibility floor
and it has a test.

**FR-1.2** — decoding is **lenient**. picoclaw's real `config.json` carries
`channel_list`, `cron`, `heartbeat`, `agents.dispatch`, `tools.*` and much more
ganglion has no types for. Unknown keys are ignored, never rejected.

**FR-1.3** — an `api_keys` value equal to picoclaw's `[NOT_HERE]` sentinel
(written by its `SecureString.MarshalJSON`) is treated as absent, not as a key.

**FR-2 — a model registry in the harness.** `model_list` resolves into an ordered
candidate chain: `agents.defaults.model_name`, then
`agents.defaults.model_fallbacks`, then the primary entry's own `fallbacks`,
de-duplicated, `enabled: false` skipped. Every candidate carries its own
`provider`, `model`, `api_base`, key and `extra_body`.

**FR-3 — per-turn selection.** `domain.Turn.Model` is honoured. A turn naming a
`model_name` in the list runs on it; a turn naming nothing runs on the default
chain; a turn naming an unknown model runs on the default chain **and says so in
a `Progress` frame** rather than failing — a member should not lose a turn to a
stale client.

**FR-4 — keys.** Two sources, in order:

1. `GANGLION_MODEL_KEY_<SLUG>`, where `<SLUG>` is `model_name` upper-cased with
   every character outside `[A-Z0-9]` replaced by `_`. This is the path the proxy
   uses. Values may be `enc://`.
2. An inline `api_keys[0]` in the file, `enc://` or plaintext.

`GANGLION_API_KEY` remains the key for the synthesized `default` entry (FR-1.1).
A candidate resolving to no key is **skipped with a named log line**, never
attempted — an unauthenticated call wastes a turn and returns a provider error
that reads like a model problem.

**FR-4.1 — `enc://` accepts picoclaw's domain too.** The two schemes are
byte-identical but for the HKDF `info` string (`picoclaw-credential-v1` against
`ganglion-credential-v1`); both are `salt(16)‖nonce(12)‖ciphertext`,
AES-256-GCM, `ikm = HMAC-SHA256(SHA256(keyfile), passphrase)`, `HKDF-SHA256` to
32 bytes. Decryption tries the ganglion domain first and picoclaw's second, so a
value produced by picoclaw's own `credential.Encrypt` — same passphrase, same key
file — resolves here. **Sealing always uses the ganglion domain.** The trade-off
is deliberate and stated: domain separation is given up between two contexts that
already share both factors and one writer, in exchange for one credential format
across the stack.

**FR-5 — fallback on failure.** When a candidate fails **before any byte of the
answer has been emitted**, the next is tried. Once content or a tool call has
reached the sink, the turn is committed to that model and the error surfaces — a
half-answer must never be silently restarted under a different model, which would
put two voices in one bubble.

**FR-5.1** — every hop emits a `Progress` frame naming the model that failed and
the one being tried; exhausting the chain returns the **last** provider error,
not a synthetic one.

**FR-6 — reload without recreate.** The file is re-read when its mtime changes,
checked at turn start. A model change must not require destroying the container —
that is what makes an admin edit feel instant. A malformed file on reload is
**rejected and logged, the previous configuration kept**: a running agent never
degrades because of a bad edit.

## Functional requirements — the proxy

**FR-7 — materialize for ganglion.** `resolveAndMaterialize` gains a ganglion
branch: the same `registry.Resolve` result that produces picoclaw's `config.json`
+ `.security.yml` produces `<userDir>/.ganglion/config.json` plus the
`GANGLION_MODEL_KEY_*` variables. **`registry.Resolve` itself is untouched** —
one resolver, two sinks.

**FR-8 — the config bind.** `ganglionBinds` gains
`<userDir>/.ganglion/config.json:/data/.ganglion/config.json:ro`, and
`ganglionBindDrift` learns it, so an existing container is recreated once and
never again for this reason.

**FR-9 — remove the three gates.**
- `rejectNonPicoclawAgent` stops refusing a ganglion agent.
- `picoclawOnly[featurePersonalModel]` drops ganglion, closing DF-4.
- `authorizeScopeDefault`'s asymmetry is fixed in passing: today a
  tenant/subscription-level scope default on a ganglion agent is **accepted and
  then never consulted**, which is the precise failure the agent-level gate
  exists to prevent. It becomes correct rather than being removed.

**FR-10 — a key is a recreate, a model is not.** Env is fixed at create time; the
config file is not. Changing which model a workspace runs rewrites the file and
the harness picks it up (FR-6). Introducing a model whose key the container does
not yet carry requires a recreate, and the proxy must perform it rather than
leave a candidate that can only ever be skipped.

## Functional requirements — the webapp

**FR-11** — `PICOCLAW_ONLY` becomes `["config"]`. The Config tab addresses
picoclaw's whole config tree through a bulk key editor; ganglion reads a strict
subset, so it stays withheld and this feature does not change that.

**FR-12** — the Model tab renders for a ganglion agent with **no new component**.
The inventory, the cascade ladder and the fallback chain editor are
harness-agnostic already; what changed is that the proxy stopped refusing the
writes.

**FR-13** — the member-facing personal-model surface appears for ganglion members,
because the proxy stopped answering `501`.

## Acceptance criteria

- **AC-1** A ganglion agent with no config file behaves exactly as before — same
  three env vars, same single model. Verified by test, not by inspection.
- **AC-2** An admin changes a workspace's model; the running ganglion container
  answers the next turn on the new model **without being recreated**.
- **AC-3** A primary whose key is revoked falls through to its fallback within one
  turn, and the member sees which model answered.
- **AC-4** The shell tool cannot read the config file — asserted the way
  `TestACommandCannotReadTheHarnessEnvironmentThroughProc` asserts the env: by
  running a command under the sandbox and checking it is denied.
- **AC-5** A picoclaw `config.json` copied verbatim into a ganglion agent loads:
  every key ganglion does not understand ignored, every key it does understand
  honoured.

## Out of scope

**Provider protocols beyond OpenAI-compatible HTTP.** picoclaw dispatches ~42
protocol identifiers; ganglion has one adapter and this feature adds none. A
`provider` naming a non-OpenAI-compatible protocol is accepted, recorded and
routed through the OpenAI-compatible client — which is what picoclaw itself does
for 30 of its 42. Anthropic-native, Bedrock, Gemini and the CLI-based providers
are a separate feature with their own adapter work.

**Cooldown tracking and rate-limiter registries.** picoclaw has them; v1 does not.

## Open questions

- **OQ-1** — Should a ganglion member be allowed a custom endpoint
  (`ScopePolicy.AllowCustomEndpoint`)? The policy exists and defaults to refused.
  Nothing here changes it; adopting it for ganglion is a deploy-time decision.
- **OQ-2** — `model_probe`'s SSRF guard was written for the proxy calling on a
  member's behalf. The harness now calls member-influenced endpoints too, from
  inside the agent network. The guard is **not** ported in v1: an endpoint
  reaching the harness came from an admin, or from a probe the proxy already
  vetted. Revisit if a member-supplied endpoint can ever bypass the probe.

---

## Implementation status (2026-09-10)

| Requirement | State |
|---|---|
| FR-1, FR-1.1, FR-1.2, FR-1.3 | **done** — `internal/config/file.go`, with a real picoclaw `config.json` as a test fixture |
| FR-2, FR-3 | **done** — `Registry.Chain`, `domain.ModelChain` |
| FR-4 | **done** — environment first, inline `api_keys` second |
| FR-4.1 | **done** — and it is the finding that made a single credential format possible. The two schemes differ in one string |
| FR-5, FR-5.1 | **done** — abandoned only while nothing has reached the member; mutation-checked |
| FR-6 | **done** — mtime at turn start; a failed reload keeps the running registry |
| FR-7, FR-8, FR-10 | **done** — `internal/docker/ganglion_config.go`, the config bind, `ganglionSecretDrift` |
| FR-9 | **done** — `rejectUngovernedAgent` over an allowlist, `alsoServedBy`, and the every-level fix |
| FR-11, FR-12, FR-13 | **done** — `INVENTORY_ONLY` + `inventoryGovernedAgentKeys` |
| AC-1, AC-3, AC-4, AC-5 | **asserted by test** |
| AC-2 | **not measured against a live container.** The mechanism is tested on both sides — the proxy rewrites only on a real change, the router reloads on mtime — but nobody has yet changed a model in the admin screen and watched a running `zcrab-g` answer on it |

**Two things a reviewer should not assume are covered.**

The harness has still never spoken to a real provider: every provider test is
`httptest` with a recorded stream, which the `crab-ganglion-harness` spec already
records and this feature does not change.

`internal/docker`'s suite carries **10 pre-existing failures** in this sandbox,
all `lchown … operation not permitted`. The branch was diffed against `main` by
failing test NAME and the set is identical — but that means these paths are
verified by reading and by their pure helpers, not by execution.
