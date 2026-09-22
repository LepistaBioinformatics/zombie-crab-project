# mangrove-human-publish

Extends `crab-mangrove-network`. A human may compose and address a memory from
the webapp, so that somebody who governs a scope can distribute content to the
members and agents in it.

## Why this exists

The mangrove shipped with a complete agent-facing publish path and no human one.
The member UI reads (`timeline`, `capabilities`, `directory`, `identity`) and
governs (`admit`, `decide`, `revoke`); it cannot write. The consequence, verified
rather than assumed:

- the only two call sites of `mangrove.Client.Publish`/`Share` in the whole proxy
  are the MCP tools, both passing a constant `agentCannotProveTenant = false`;
- so `reach.Options.TenantLicensed` is **never true in production**, and the
  tenant Group is addressable by nobody at all;
- `reach.go`'s own comment says tenant scope "is therefore a human action, taken
  in the webapp" — describing a path that was never built.

This feature builds that path, and closes the gap the comment already claimed.

## Functional requirements

### FR-P: composing

- **FR-P1** A member SHALL be able to compose a memory in the webapp: a cell, a
  body, and a declared media type.
- **FR-P2** The media type SHALL be carried on the object as `mediaType`. The
  field already exists end to end and nothing has ever populated it, so every
  stored object is unlabelled and the reader guesses.
- **FR-P3** `mangrove_publish` (MCP) SHALL accept `mediaType` too. An agent that
  writes JSON and a human who writes markdown are the same gap; fixing only the
  human half leaves the reader still guessing for the majority of objects.
- **FR-P4** Object type SHALL be `MemoryNote` for composed content. `MemoryFile`
  is out of scope: it implies an upload path this feature does not build.

### FR-Q: addressing

- **FR-Q1** A member SHALL be able to address named actors, chosen from the
  directory.
- **FR-Q2** For each person found, the sender SHALL choose whether the memory
  goes to that person, to their agent, or to both. They are different acts:
  distributing memory to an agent is not the same as notifying a human.
- **FR-Q3** Addressing SHALL work in the directory's strict mode, where no actor
  id is ever returned. The webapp therefore addresses by email and the proxy
  resolves it; see DD-2 for why this is not done with a new address vocabulary.
- **FR-Q4** An empty audience SHALL publish privately to the author, which is
  what a bare publish already means.

### FR-R: who may address a Group

- **FR-R1** Addressing a Group scope SHALL require a mycelium governing role. The
  subscription Group requires `subscriptions-manager` on that subscription, or
  any tenant role; the tenant Group requires `tenant-manager`/`tenant-owner`.
- **FR-R2** This SHALL be enforced in `reach.Check` and nowhere else. It is a new
  `Options` field beside `TenantLicensed`, not a second precondition in the
  proxy: `reach` is deliberately the only site that implements containment, and
  a second one would be a second thing to forget.
- **FR-R3** The option SHALL default to false, so every call site states its
  stance and a new one cannot acquire Group reach by omission.
- **FR-R4** **An agent SHALL NOT address a Group at all.** The MCP token signs
  the workspace tuple and no mycelium role, so an agent can never satisfy FR-R1.
  This is a deliberate narrowing of live behaviour — see AD-030.
- **FR-R5** A member who does not govern SHALL NOT be offered Group scope in the
  UI. An affordance that renders and then refuses teaches the wrong model, which
  is the reason `capabilities` exists.

### FR-S: admission is unchanged

- **FR-S1** A memory addressed to an actor SHALL continue to be held until that
  person admits it. Distribution does not become a write into somebody's memory
  without their act, whatever the sender's role.
- **FR-S2** Governance (`decide`, `revoke`) SHALL apply to human-published
  objects exactly as to agent-published ones. No new governance path.

### FR-T: the network stays optional

- **FR-T1** With the mangrove unconfigured, the compose affordance SHALL be
  absent, like every other mangrove affordance. No existing capability may
  acquire a dependency on it.

## Acceptance criteria

- **AC-1** A member with no governing role composes a note, addresses a colleague
  found by email, and it appears in that colleague's `received` as held.
- **AC-2** The same member is offered no Group option, and a hand-made request
  naming a Group is refused by name.
- **AC-3** A `subscriptions-manager` addresses the subscription Group and every
  member of that subscription sees it held.
- **AC-4** A `tenant-manager` addresses the tenant Group and it is accepted —
  the first time that scope has been reachable by anybody.
- **AC-5** Choosing "person" delivers to `...:person`; "agent" to `...:service`;
  both delivers to both.
- **AC-6** An agent calling `mangrove_publish` with a Group in `to` is refused,
  naming the Group and the reason.
- **AC-7** An agent calling `mangrove_publish` with `mediaType` has it stored.
- **AC-8** Composed markdown renders in the preview without the reader sniffing
  for it.
- **AC-9** With `CRAB_MANGROVE_BASE_URL` unset, the webapp shows no compose
  affordance and nothing else regresses.
- **AC-10** `POST /v1/mangrove/publish` is reachable through the gateway for
  every role, and `scripts/gateway_routes.py` passes.

## Out of scope

- Re-sharing an already published object from the UI (`/internal/v1/share`
  exists; publish-with-audience covers distribution and a second affordance
  would duplicate it).
- File upload (`MemoryFile`).
- Any new mycelium RPC.
