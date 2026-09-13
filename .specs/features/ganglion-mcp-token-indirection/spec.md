# ganglion-mcp-token-indirection — Specification

**Status:** Proposed. Nothing implemented.
**Date:** 2026-09-13.
**Spans:** `crab-ganglion-harness`, `crab-shell-proxy`.
**Does not touch:** picoclaw's `config.json`, or `crab-exoskeleton-webapp`.

## Problem

Every ganglion workspace has a bearer token sitting in plaintext in a file on a
volume:

```jsonc
// <userDir>/.ganglion-config.json
"tools": { "mcp": { "servers": { "memory": {
  "url": "http://crab-shell-proxy:8080/v1/mcp",
  "headers": { "Authorization": "Bearer <scope>.<mac>" }
} } } }
```

The proxy writes it on every ensure — `ganglionMCPBlock` calls the same
`desiredMCPServer` (`internal/docker/mcp_config.go:38`) that serves picoclaw's
`config.json`, so one render reaches both harnesses.

Every other credential in this system already avoids that. Model keys travel as
environment, one variable per model, under a name both sides derive from the
model name (`ganglionModelKeyEnv` in the proxy, `config.KeyEnvVar` in the
harness). The config file carries endpoints and names; the environment carries
secrets. The MCP header is the one place that rule is not followed.

## Why it is that way, and why that reason does not apply here

The reason is written down in `internal/mcptoken`'s package comment, and it is
about picoclaw, not about us:

> the token has to sit in plaintext in the workspace's config.json, because
> picoclaw offers no env indirection for tools.mcp.servers (context.md E-3) —
> env_file is stdio-only.

That is a true statement about a third-party binary we do not control, and it is
what drove the token's design: stateless, deterministic, carrying its own scope
plus a MAC, so the proxy stores nothing and the same workspace always renders the
same bytes (a churning file would recreate the container on every ensure).

**The ganglion is ours.** It has no such limitation — only an unimplemented
alternative. `internal/config/file.go:81`:

```go
// Headers are sent verbatim. Authorization is never overridden from here.
```

and `loadMCP` (`file.go:849`) passes `srv.Headers` straight through to the client
(`internal/adapter/mcp/mcp.go:334`). No environment lookup, no `enc://`
resolution — unlike `resolveKey`, which sits a few hundred lines above in the
same file and does exactly this for model keys.

So the ganglion inherited a picoclaw constraint it does not have.

## Honest accounting of what this buys

**This is defence in depth, not a fix for a live exposure.** Stating it plainly
so the work is not justified with a threat that does not exist.

The agent cannot read the file today. `.ganglion-config.json` is bound at
`/data/.ganglion/config.json`, outside `workspace/`, and the harness's Landlock
ruleset grants only the workspace — asserted by
`TestACommandCannotReadTheModelRegistryFile`, which tries `cat <path>`,
`cat ../config.json`, `ls <dataDir>` and a base64-obfuscated variant.

What changes:

| | today | after |
|---|---|---|
| readable by the agent's shell | no (Landlock) | no (Landlock **and** `scrubEnv`) |
| visible in `docker inspect` | no (it is a file) | no (see FR-5) |
| readable with host filesystem access | **yes, plaintext** | no — the file holds no secret |
| readable from a volume backup or snapshot | **yes, plaintext** | no |
| survives in a copied user directory | **yes** | no |

The last three are the real gain: the token stops being an at-rest secret on a
volume that gets backed up, copied between environments, and inspected by
whoever can read the data root. It also removes the one exception to a rule the
rest of the system follows, which is worth something on its own — an exception
is what the next person copies.

**Counter-consideration, settled.** Moving a secret into a process environment
is normally a downgrade, because a child process inherits it and
`/proc/self/environ` is readable. Neither applies here: the shell tool's
environment is an **allowlist** — `scrubEnv` keeps only `PATH`, `HOME`, `TERM`,
`LANG`, `TZ` (`internal/adapter/tool/exec/exec.go:204-229`) — and `/proc` is
outside the Landlock ruleset for the same reason `/data/.ganglion` is. This is
the mechanism that already protects `GANGLION_MODEL_KEY_*`, which are strictly
more valuable than a scope token for one member's memory graph.

## Scope

The ganglion renders exactly **one** MCP server: `memory`, with the member's
unscoped token (`ganglionMCPBlock`). The per-project servers picoclaw gets
(`ProjectMCPServerName`) are not written for a ganglion agent, because its graph
is per member and spans that member's projects. So this feature has one secret
per workspace to relocate, not N.

The design is still specified per (server, header) rather than hardcoding
`memory` + `Authorization`, because an operator may add a sibling server by hand
and should get the same facility — but no proxy code paths beyond `memory` are
required by this spec.

## Requirements

### FR-1 — The harness resolves a header from the environment first

`loadMCP` gains, for each server and each header, the same precedence
`resolveKey` already uses for model keys:

1. the environment variable whose name is derived from (server name, header
   name) — if set and non-empty, it is the value;
2. otherwise the literal value in the file, unchanged.

The file value staying as a fallback is what keeps a hand-written config and any
already-deployed workspace working, and it is what lets this ship without a
flag day.

### FR-2 — One derivation, written twice, tested against itself

```
GANGLION_MCP_HEADER_<SERVER>_<HEADER>
```

with the slug rule `config.KeyEnvVar` already uses: uppercase, and every
character outside `[A-Z0-9]` becomes `_`. So `memory` + `Authorization` is
`GANGLION_MCP_HEADER_MEMORY_AUTHORIZATION`.

The proxy derives the same name. As with `KeyEnvVar`, **the two derivations
agreeing is the entire contract**, and the collision the slug rule admits
(`a-b` and `a_b`) is accepted for the same reason: the alternative is an
encoding nobody can read in a `docker inspect`.

A test in each repository asserts the derivation against a shared table of
cases, including the collision, so neither side can be changed alone.

### FR-3 — The proxy writes the reference, not the secret

For a **ganglion** agent, `ganglionMCPBlock` emits the server record with no
`Authorization` header, and `ganglionSecretEnv` gains
`GANGLION_MCP_HEADER_MEMORY_AUTHORIZATION=<token>`.

`desiredMCPServer` is picoclaw's record and keeps emitting the header verbatim.
The two paths diverge here; today they share the function. The shared shape
(`"command": ""` included) is retained for everything else, because the harness
reads picoclaw's record and one record serving both is still the point.

### FR-4 — The rendered file must stay stable

The existing idempotence check compares the rendered block against what is on
disk to decide whether the container is recreated. A record without the header
is still a fixed function of the workspace, so this property is preserved — but
it must be preserved **explicitly**, by a test that renders twice with the same
inputs and asserts identical bytes, because the failure mode (a container
recreated on every turn) is invisible in a unit test that renders once.

### FR-5 — The token must not reach `docker inspect`

The container environment is visible to anyone who can query the Docker daemon,
and today the MCP token is not there. Moving it into the environment must not
make `docker inspect` the new leak.

This is the one requirement that could make the feature a net loss, and it is
the reason FR-5 exists as a requirement rather than a note. Two candidate
answers, to be settled in design (see OQ-1):

- **(a)** Accept it, on the grounds that `GANGLION_MODEL_KEY_*` — a provider
  credential with real money behind it — is already there, so the MCP scope
  token is strictly less sensitive than what that surface already carries.
- **(b)** Bind it as a file at a path outside the workspace, the way
  `credential.key` already is, and have the harness read the token from that
  file. This keeps it off both surfaces, at the cost of a second bind.

(a) is the smaller change and is consistent with what the environment already
holds. (b) is strictly better and is the shape the two-factor `enc://` scheme
already established. This spec does not pick one.

### FR-6 — Rollout must not 401 a running container

A workspace whose file still carries the header and whose container has no
variable set must keep working (FR-1's fallback covers this). A workspace
rendered by the new proxy against an **old** harness image would break — the
harness would find no header anywhere — so the harness change ships first and
the proxy change is gated on the deployed `CRAB_GANGLION_IMAGE` carrying it.

Stated because the two repositories deploy independently, and the failure is a
member's memory server silently 401ing.

### FR-7 — No new admin surface

`tools.mcp.servers.memory` is already in `ManagedConfigPaths`
(`internal/docker/instance_config.go:54`), so the instance and bulk config
editors already refuse it. Nothing in this feature is admin-editable, and the
overlay (`.ganglion-overlay.json`) must not record the header's absence as an
admin edit.

## Non-requirements

- **Rotation.** Unchanged: the token is deterministic and rotation is rotating
  `CRAB_MCP_TOKEN_SECRET`. This feature moves where the value is carried, not
  how it is produced or invalidated.
- **Expiry.** The token still does not expire. Adding an expiry means the proxy
  re-rendering on a timer, which is the churn the stateless design exists to
  avoid — a separate decision, not this one.
- **picoclaw.** Its `config.json` keeps the plaintext header. The constraint
  that put it there is still true of that binary.

## Open questions

- **OQ-1 — environment or a second bind?** FR-5(a) or FR-5(b). (b) is better and
  costs one more bind plus a path constant; (a) is nearly free and leans on a
  surface that already carries larger secrets. Needs a decision before design.
- **OQ-2 — does an operator-added sibling server get this too?** FR-1 and FR-2
  are written per (server, header) so it would work, but no proxy path writes
  one, and an operator today puts the value in the file by hand. Worth
  confirming that "your hand-written header still works" is the intended answer
  rather than a gap.
- **OQ-3 — is the at-rest gain worth the divergence?** This is the first place
  the ganglion's rendered record deliberately differs from picoclaw's. The
  parity rule (`.claude/rules/harness-layout.md`) says the layout is shared and
  the bind set is not; a differing *record* is neither, and this spec is the
  precedent either way.

## Verification

- A command in the sandbox cannot read the token: extend
  `TestACommandCannotReadTheModelRegistryFile`'s command table with `env`,
  `printenv`, `cat /proc/self/environ` and `cat /proc/1/environ`, asserting the
  token does not appear. This test must be written **before** the change and
  must pass both before and after — it is the claim the whole feature rests on.
- Round-trip: the proxy's derived name and the harness's derived name agree over
  a shared table of server/header pairs.
- Idempotence: two renders with the same inputs produce identical bytes (FR-4).
- Fallback: a config carrying a literal header and no variable resolves to the
  literal (FR-1, FR-6).
- End to end on a live workspace: the memory graph answers a tool call from a
  ganglion container whose `.ganglion-config.json` holds no credential.
