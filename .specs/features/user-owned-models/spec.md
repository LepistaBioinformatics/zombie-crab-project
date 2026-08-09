# user-owned-models — Specification (authoritative)

A member registers their own model — provider, endpoint URL and API key — from the
secrets side-curtain, proves it answers before saving, and switches between it and
whatever their administrator provides.

Cross-repo. This file is the authoritative statement; the per-repo slices record
what changes where:

- `crab/crab-shell-proxy/.specs/features/user-owned-models/spec.md`
- `crab/crab-exoskeleton-webapp/.specs/features/user-owned-models/spec.md`

## Problem

Every model a workspace can run comes from the admin inventory
(`model-registry-source-of-truth`). A member with their own API key has no way to
use it: `native-secrets-admin-only` R6 removed the model-key slot from the drawer
and pointed at the admin's Model tab, which a non-admin cannot open.

The reason that restriction existed is still true — a member who writes a broken
model configuration into their own workspace bricks their own agent, and nothing
in the UI explains why. So the feature that returns the capability has to carry
the guard rails the removed one lacked.

## What is being built

- **R1** A member registers one or more personal models: `provider`, `model`,
  `api_base`, `api_key`, optional `extra_body`. The key is write-only — no API
  response ever carries it back.
- **R2** Before saving, the member runs a connectivity test that sends a real
  minimal completion to the endpoint they typed. **Save is disabled until a test
  has run** for the current field values; a failed test does not block the save,
  it demands a confirmation and stores the failure alongside the record (the user
  decision: an endpoint being briefly down must not make a correct model
  unsaveable).
- **R3** Editing any field invalidates the previous test result. The button state
  is derived from the draft's content, never from "a test happened at some point".
- **R4** A member chooses, at any time, between the model their administrator
  provides and each of their own. Switching back is one click and destroys
  nothing.
- **R5** When a personal model is selected, the model the admin cascade *would*
  have resolved is materialized as picoclaw's `agents.defaults.model_fallbacks`.
  A personal model that fails at runtime therefore degrades to the organisation's
  model instead of leaving the member with an agent that cannot answer.
- **R6** An administrator sees every personal model under their authority — owner,
  provider, `api_base`, last test result — never the key, and may **disable** one.
  A disabled personal model stops resolving and its owner falls back to the
  cascade.
- **R7** An administrator may **lock** a scope (global / agent / tenant /
  subscription): inside a locked scope no personal model resolves, whatever the
  member selected. The most specific policy wins; unset everywhere means allowed.
- **R8** Saving, selecting or deselecting never force-restarts a running
  container. It raises the same restart notice a secret write raises
  (`restart-control` DEC-3) and the member presses the button when ready.

## Resolution order

The proxy's cascade gains one rung at the top:

```
personal selection (when the scope allows it, and the model is enabled)
  > explicit admin pin > subscription > tenant > agent > global
```

A personal model wins over an admin pin **by decision** — the member's key is the
member's, and the lock in R7 is the control an administrator keeps. The lock is
scope-level and coarse on purpose: a per-user allow list would be a second pin
mechanism competing with the first.

## The test

The probe is `POST {api_base}/chat/completions` with
`{model, messages:[{role:"user",content:"ping"}], max_tokens:16, stream:false}`
and `Authorization: Bearer <key>` — byte-for-byte the request picoclaw's own
provider makes (`pkg/providers/openai_compat/provider.go:478`, v0.3.1). It is run
by crab-shell-proxy, not by the browser: the key must not leave the server side,
and no browser can reach an arbitrary provider without CORS.

**Only OpenAI-compatible providers may be registered by a member.** picoclaw
routes `azure`, `bedrock`, `gemini`, `anthropic-messages` and every `oauth`/CLI
provider through different clients, so the probe would not be the request the
container makes — a green test would mean nothing. Those stay admin-only, where
the definition is set by someone who can read the container logs.

### What the test does NOT prove

The container sends tool definitions, streaming and a large context; the probe
sends one short message. An endpoint that answers the probe can still refuse a
real turn. R5's automatic fallback exists because of exactly this gap, and the UI
says so rather than promising the model works.

Fidelity of the network path is good but not perfect: crab-shell-proxy and the
per-user containers sit on the same docker network (`zombie_net`) and egress
through the same NAT, so public reachability is representative. A difference in
per-container egress policy, if one is ever introduced, would break that
equivalence silently.

## Security requirements

- **S1** The probe accepts `https` only — including across redirects, which it
  follows up to 5 hops because picoclaw does — and rejects the request when the
  resolved IP is loopback, private, link-local, unique-local or the cloud metadata
  address. The check runs at **dial** time, on every connection including redirect
  hops, so a name that resolves inward is caught however it was reached. Without
  it, any member turns the proxy into an internal port scanner.
- **S2** The probe is rate-limited per caller and bounded by a short timeout and a
  response-size cap. The response body is never echoed back — only a status code,
  a latency and an error class.
- **S3** A personal model can never be referenced by anything outside its owner:
  not a scope default, not another model's `fallbacks` or `replaced_by`. This is
  structural (a separate store), not a check someone has to remember.
- **S4** A personal API key is never returned by any endpoint, admin included.

## Out of scope

- oauth / azure / bedrock / gemini registration by a member (admin inventory
  covers them).
- A personal fallback chain of the member's own choosing. The single automatic
  fallback of R5 is the whole chain.
- Sharing a personal model with another member, and any quota/billing accounting.
- Hermes agents: they never read picoclaw's `config.json`, so the routes answer
  501 there, exactly as `agent-projects` does.
