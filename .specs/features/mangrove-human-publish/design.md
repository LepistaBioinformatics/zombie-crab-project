# Design

## DD-1 — The mangrove service needs no protocol change

`POST /internal/v1/publish` already accepts `as: "person"`, `object.mediaType`
and `to[]`, and already returns `pending`. Verified in `handlePublish`. The only
change inside `crab-mangrove-network` is the containment gate itself (DD-3).

This matters for sequencing: the public, experimental repo takes one small
security-relevant commit, not a feature.

## DD-2 — Addressing by email uses a structured body, NOT a new address prefix

The directory's strict mode returns `{email}` and no id, by design — a member
confirms reachability without learning an id. So the webapp cannot build
`mangrove:actor:<acc>:person` itself, and the person/agent choice (FR-Q2) has to
survive the round trip somehow.

**Rejected: a new `email-person:` address prefix.** `resolveAudience` is shared
with the agent path — `mangrove_share` runs its target through the same helper —
so extending the prefix vocabulary would widen the *agent's* addressing as a side
effect of a human-path feature. Inventing wire vocabulary is the expensive
option, not the cheap one: it needs a parser, a validator, and every future
consumer has to learn it.

**Chosen**: the new route's body carries the choice structurally, and the handler
expands it:

```json
{
  "cell": "...", "content": "...", "mediaType": "text/markdown",
  "to": ["mangrove:group:subscription:<id>"],
  "toEmails": [{"email": "a@b.c", "person": true, "agent": true}]
}
```

Nothing else consumes this body; it is the proxy's own HTTP API. The email→accId
map is lifted out of `resolveAudience` so both callers share one lookup, which is
a refactor of existing code rather than a new abstraction.

## DD-3 — `Options.GroupsLicensed`, beside `TenantLicensed`

```go
type Options struct {
    TenantLicensed  bool // licensed on Tuple.TenantID
    GroupsLicensed  bool // governs the subscription: may address a Group at all
}
```

The subscription-Group arm of `reach.Check` gains `if !opt.GroupsLicensed →
Refusal`. The tenant arm keeps its own check; `TierTenant >= TierSubscription`,
so a tenant manager satisfies both from the same identity.

Both fields are false-is-safe and neither is settable from an agent token. The
parallel naming is deliberate: a reader who understands one understands the
other, and a third scope would follow the same shape.

**One gate, still.** FR-R2 is the point — the rule goes where containment already
lives, not into the proxy handler. `reach.go`'s doctrine is that a second
enforcement site is a second thing to forget.

## DD-4 — The proxy carries identity into the options

`POST /v1/mangrove/publish` resolves the caller the way the other member routes
do, then:

```go
tenantLicensed(ident, key)  // TierTenant+   -> Options.TenantLicensed
governs(ident, key)         // TierSubscription+ -> Options.GroupsLicensed
```

Both helpers already exist and already back `GET /v1/mangrove/capabilities`, so
the UI's view of what it may offer and the gate's view of what it will accept are
computed from one function each. They cannot drift.

The MCP tools pass neither, under a named constant that says why.

## DD-5 — Compose lives beside People, not inside a reading

`MangroveScreen` already distinguishes readings (`received`/`published`/
`pending`, which fetch the timeline) from People (which does not). Compose is the
same kind of thing as People: its own flag, no timeline fetch, no membership in
the reading union. On a successful publish it switches to `published` and
reloads, which is the one place the two interact.

Group options are rendered from `capabilities`, which the screen already holds.

## DD-6 — Test strategy

- `reach`: the existing own-subscription tests must FAIL without
  `GroupsLicensed: true` — if a test passes both ways it is not covering the
  flag. Plus a new one asserting an agent-shaped call is refused.
- proxy: table test over the four tiers × three audience kinds.
- webapp: compose renders/hides on capabilities; person/agent selection builds
  the right body; i18n parity.
