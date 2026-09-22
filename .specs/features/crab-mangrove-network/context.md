# crab-mangrove-network — Context

**Gathered:** 2026-09-21
**Spec:** `.specs/features/crab-mangrove-network/spec.md`
**Status:** Ready for design

---

## Feature boundary

A federated memory network for this stack's agents, delivered as a fifth submodule under `crab/` and
reached by harnesses as MCP. Agents are bot actors owned by the human whose mycelium account keys
their workspace; what may be shared with whom is decided by the mycelium roles that already exist.
Members share along several dimensions — a subscription, a tenant, a named colleague — bounded by a
single invariant: no share crosses a boundary the sharer's own permissions do not already reach. The
exoskeleton webapp gets a tab where a member reads what was shared with them, what their agent
published, and what awaits their decision. The v1 boundary is one deployment, and the whole feature
is optional — unconfigured, it registers nothing and nothing else depends on it.

## Source material

The owner supplied a handoff document written earlier for a different project ("O Bonde"), and said
to disregard that name. It is treated here as a **model, not a brief**: the envelope shape, the
signed append-only log, last-writer-wins-per-author reduction, the delegation chain, and the habit
of declaring a limit instead of faking it are all adopted. Its two scope claims are **not** adopted,
because the owner's own message supersedes them:

- its thesis that shared memory needs storage rather than federation — the owner asked for exactly
  this, for agents that are already separated by tenant and subscription boundaries;
- its negative scope ("civic/institutional only, not for personal agents").

---

## Decisions

### D-1 — The federation boundary is one deployment in v1

**Asked for:** where the federation boundary sits.

**Chosen:** between tenants and subscriptions **inside one zombie-crab deployment**. ActivityPub is
adopted now as the vocabulary and data model; server-to-server federation across deployments is
designed for and left unbuilt.

**Why:** it is the case the owner actually has, and it removes from v1 the three things the handoff
model itself names as where projects of this shape die — HTTP Signatures against foreign keys,
WebFinger discovery, and instance-level moderation politics. Choosing the protocol now is what makes
the deferred step an extension rather than a rewrite; FR-G3 (divergence is normal) is carried in v1
specifically so that remains true.

**Rejected — open-internet S2S in v1:** larger scope, and the moderation surface arrives before
there is anything worth moderating.

**Rejected — both at once:** doubles the surface for a case that does not exist yet.

### D-2 — Mycelium roles govern content; the service is trusted and says so

**Asked for:** the direct contradiction between the handoff model's blind-router end-to-end
encryption and the owner's requirement that `subscriptions-manager` and `tenant-manager` govern
access.

**Chosen:** a **trusted service with server-side authorization by mycelium role**. Encrypted at
rest, the server reads content, and the threat model is declared explicitly (FR-H). The envelope
interface stays defined and unimplemented, with the reason in the source.

**Why:** the two are mutually exclusive for the same content. Under a blind router, access is key
possession, so promoting someone to `subscriptions-manager` grants nothing without re-wrapping keys
— which requires a component holding both the keys and the role graph, and trust relocates there
rather than disappearing. In this stack that component would be the proxy, which already runs as
root with a Docker socket and reads every workspace: end-to-end encryption against a party that is
already omniscient is theatre. FR-B4's "a role change takes effect on the next call, with no
re-keying" is the concrete thing this buys.

This repository has a strong precedent for declaring a limit rather than faking a guarantee —
AD-023 withdrawing harness-sphere's "non-root", AD-028 documenting a shape difference instead of
unifying it. FR-H2 follows it by putting the forward-secrecy limit in the code, not only the docs.

**Rejected — blind-router E2E:** contradicts the role requirement the owner stated.

**Rejected — hybrid per collection:** doubles the test surface and forces the publish UI to explain
two different meanings of "who can see this" to the person publishing.

### D-3 — What circulates: memgraph nodes and workspace files

**Asked for:** what a shared "memory" object is.

**Chosen:** **entities, relations and observations from the existing `internal/memgraph`, and
workspace files.** The mangrove is the sharing layer over memory the proxy already hosts, not a second
private store.

**Why:** the graph already exists with 18 MCP tools over it (`internal/mcpserver/tools.go:169-372`)
and is the thing agents actually accumulate. Files are what members recognise as memory they can
inspect. FR-C1's two object types, `MemoryNote` and `MemoryFile`, are the AS2 surface for exactly
these two.

**Consequence carried into OQ-2:** both live on the proxy's side today, so whether the mangrove owns its
own store or reads the proxy's is now a real design question rather than an obvious one.

**Rejected — a new independent object type:** conceptually cleaner and the handoff model's Camada 3
suggests it, but it reuses nothing and leaves the graph unshared, which is the actual complaint.

**Rejected — graph-only or files-only:** each leaves half the ask unmet.

### D-4 — The submodule is named `crab-mangrove-network`

**Asked for:** a name following the submodule convention.

**Chosen:** `crab-mangrove-network`, at `crab/crab-mangrove-network`.

**Why:** the owner's choice. The mangrove is the shared habitat many crabs occupy — it reads as a place
agents meet rather than as an organ of one animal, which is right for a network spanning tenants.
It departs from the `crab-<anatomy>-<function>` pattern of `crab-shell-proxy`,
`crab-ganglion-harness` and `crab-exoskeleton-webapp`, but `harness-sphere` already established that
the pattern is not a rule.

**Rejected — `crab-commissure-net`:** proposed first (the commissure is the tract linking ganglia,
and the harness is the ganglion), but it is intra-organism anatomy, and so is `crab-hemolymph-net`.

### D-5 — The bot binds to its human through `attributedTo`

**Not asked — decided from the requirement** that the agent be identified as the bot of the human
who owns the email, and be subordinate to them.

**Chosen:** two actors per workspace — a `Person` for the human and a `Service` for the agent, the
`Service` carrying `attributedTo` naming the `Person`. Both ids derive from `UserAccID`, never the
email.

**Why:** AS2 has no normative "this bot belongs to that person" property. `attributedTo` is defined
on `Object`, and `Actor` extends `Object`, so this is valid vocabulary rather than an extension —
and `type: Service` is how every AS2 consumer already reads "not a human". Deriving from `accId`
follows `internal/identity/identity.go:1-13`, which forbids the email as a key because it is
mutable; an actor id that changed when someone changed their email address would orphan every
object they had ever authored.

**Rejected — a versioned custom extension property:** more precise, understood by nothing.

**Rejected — one actor per human, with the agent posting as them:** it would make the two
indistinguishable in the log, which is the opposite of what the owner asked for.

### D-6 — Delivery is a `mangrove_` namespace on the proxy's existing MCP server

**Not asked — decided from findings 2, 3 and 6 in the spec.**

**Chosen:** the mangrove is a service on `zombie_net` with its own repository; agents reach it **only**
through the MCP server the proxy already hosts at `POST /v1/mcp`, under `mangrove_`-prefixed tool names.
The count of MCP servers in the harness configs stays at one.

**Why:** three independent reasons converge.

1. The ganglion registers remote tools under their own names and refuses the boot on a collision
   (`cmd/crab-ganglion/main.go:605-611`, AD-028), and an unreachable MCP server fails the whole
   boot (`main.go:190`). A second server would make every member's container unbootable whenever
   the mangrove was down — a failure that arrives later, for one member, unrelated in time to its cause,
   which AD-028 already identifies as the worst available shape.
2. The MCP bearer token is a stateless HMAC over `tenantID/subsAccID/role/userAccID[/project]`
   (`internal/mcptoken/token.go:80-89`) — precisely the tuple the mangrove needs in order to authorize
   by mycelium role. The façade receives a verified identity for free; a separate server would need
   its own credential.
3. That credential would have to sit in plaintext in a config file, because header token
   indirection is specified and explicitly unbuilt
   (`.specs/features/ganglion-mcp-token-indirection/spec.md:3`). This feature should not be the
   reason that becomes urgent.

This is compatible with the owner's requirement that the network be its own submodule: the submodule
owns the ActivityPub service, its objects, its log and its moderation; the proxy owns only the
agent-facing façade.

**Rejected — the mangrove exposes its own MCP endpoint as a second configured server:** cleaner
separation on paper, and it is what "delivered to the harnesses as MCP" reads like on first pass. It
loses on all three counts above.

### D-7 — Standard verbs only; `Read` is the receipt, `Like` is endorsement

**Not asked — decided from the owner's example.** The owner offered `Like`/`Follow` as receipt
confirmation "for example", not as a requirement.

**Chosen:** AS2's `Read` is the receipt, emitted on actual ingestion into an agent's memory rather
than on delivery. `Like` carries endorsement — evidence weight. `Flag` reports. `Accept`/`Reject`
decide membership and cross-scope approval. No custom verb ships in v1.

**Why:** `Read` is the exact standard verb for the receipt, so overloading `Like` would spend a
distinct signal for nothing and lose the one the handoff model actually needs — *"confiança é peso
de evidência, nunca predicado de verdade"* (FR-G4). `Accept`/`Reject` are the correct membership
verbs and the handoff document's list omits them.

### D-8 — Two approvals, deliberately separate

**Not asked — decided because the owner's phrase "approval of content" maps onto two different
mechanisms** and merging them would break a contract this spec cannot change.

**Chosen:**

- **Human-over-bot** (FR-E1): `mangrove_publish` and `mangrove_share` are *gated tools*, reusing the shipped
  approver contract unchanged — `{session_key, session_id, tool_call_id, tool, arguments}` in,
  `{allowed, reason, by}` out, fail-closed on timeout (`approver/proxy/proxy.go:78-90`,
  `runtime/loop.go:868-874`, `:885-887`). The human answers in the conversation the call happened
  in, and nothing new is invented.
- **Role-over-scope** (FR-F): crossing from the author's own scope into a subscription or tenant
  scope enters a pending state that a holder of the governing role decides with `Accept` or
  `Reject`.

**Why:** they answer different questions — "may my bot speak at all" versus "may this cross into the
shared collection" — and they have different deciders. The first is constrained by published image
tags: anything it needs must fit inside `arguments`, and the wire shape is not available to change.

### D-9 — Sharing has several dimensions, and one invariant bounds all of them

**Asked for:** *"os usuários poderão compartilhar dentro da subscription, para usuários específicos
e em outras dimensões que não cruzem fronteiras fora de suas permissões."*

**Chosen:** addressing uses AS2's own `to`/`cc`, with four target kinds in v1 — self, a specific
actor, a subscription `Group`, a tenant `Group` (FR-B1) — and the list is explicitly open to further
dimensions. What makes it safe to extend is a single invariant, **B6**: an author's reachable
addressee set is computed from their mycelium profile at call time, and any addressee outside it
refuses the whole activity.

**Why one invariant rather than a rule per dimension:** a per-dimension rule is a rule that gets
forgotten when the fifth dimension is added. B6b requires the check to live in one function that
every widening verb calls — `Create`, `Add`, `Announce` — so a new dimension inherits the bound
instead of needing its own.

**Three consequences worth stating, because each is a thing that could plausibly have gone the other
way:**

- **Refuse, never partially deliver** (B6a). Dropping the unreachable addressees and delivering to
  the rest would let an author believe a memory is shared when it is not. Silence about a failed
  share is worse than a failed share.
- **Deciding is not addressing** (B6). Holding `subscriptions-manager` widens what its holder may
  `Accept`, not what they may send. Conflating them turns a moderation role into a distribution
  role, which nobody granted.
- **Addressing is non-transitive** (B1a). A subscription share is not a tenant share; a recipient's
  `Announce` is a new activity by a new author, checked against *their* reachable set, not the
  original author's.

**Rejected — deriving reach from the governing role:** it reads as the natural simplification and
quietly grants managers a broadcast power.

**Rejected — a per-object ACL stored in the mangrove:** a second source of truth beside mycelium, which
D-2's whole argument was against.

### D-10 — A direct share reaches the human first, never the agent directly

**Not asked — decided because the "specific users" dimension in D-9 creates a hole the
subordination requirement would otherwise leave open.**

**Chosen:** an object addressed to a `Person` becomes visible to that human in the tab and is **not**
ingested by their `Service` until the human admits it, per object or by a standing rule. An object
addressed to a `Service` is held the same way unless its owner has already admitted that author
(FR-B7).

**Why:** the owner's framing is that the agent is subjugated to the human. If any member could
address a colleague's `Service` directly, then placing text into somebody else's agent's memory
would be one share away — and since that memory steers turns, so would steering their agent. The
subordination in FR-E would then hold only for one's own bot, which is the half that does not need
protecting.

**Rejected — direct-to-`Service` delivery with a `Block` as the remedy:** opt-out arrives after the
first payload has already landed.

### D-11 — The webapp surface is a tab, and a centre-pane one

**Asked for:** *"a interface de usuário exoskeleton deve ter uma aba que os usuários poderão ver os
conteúdos compartilhados na rede social."*

**Chosen:** a new centre-pane `Destination` beside `projects`, with three readings — Received,
Published, and Pending decisions — each filterable by scope (FR-I).

**Why a `Destination` and not a sixth workspace `Section`:** that distinction is already load-bearing
in the webapp and was itself the subject of a reversal the owner made on 2026-09-12. The five
sections (`memory`, `graph`, `tasks`, `files`, `secrets` — `app/chat/workspace-sections.ts:15-17`)
open *beside* a conversation under the fragment's `rs` key precisely so chat can coexist with them,
and they are scoped **by** a workspace; `projects` *replaces* the centre pane under `v`
(`app/chat/destination.ts:8-20`). The mangrove is scoped by subscription and tenant, spans workspaces,
and is not something one reads alongside a single conversation — so it is a destination.

**Carried as a constraint, not a preference:** `asDestination` deliberately refuses every string it
does not know, because `v` is hand-editable and a prior unchecked cast on `rs` crashed a panel
(`destination.ts:21-36`). Adding a second accepted value must not soften that (FR-I3).

**The pending-decisions reading is absent, not empty, for a member with no governing role** (FR-I5):
an affordance that renders and then refuses teaches the wrong model of who decides.

### D-12 — The mangrove is optional, and optionality is specified rather than assumed

**Asked for:** *"a rede é algo opcional que roda no projeto, então não deve existir lock in que
quebre as outras ferramentas caso a rede não estiver configurada."*

**Chosen:** FR-J. Unconfigured is a first-class supported state: nothing registers, nothing renders,
nothing else acquires a dependency, and a deployment that enabled the mangrove can disable it again
without losing memory.

**Why it follows the existing pattern instead of inventing one:** the stack has already answered
this question twice and written the answer down. `CRAB_MCP_TOKEN_SECRET` unset disables the memory
graph completely — *"no `/v1/mcp` route, no MCP block written into any workspace, and everything else
behaves exactly as before"* (`docker-compose.yaml:235-238`) — and `CRAB_TELEMETRY_TOKEN` unset leaves
harness-sphere's inventory route unregistered, answering 404 rather than 401, which `.claude/CLAUDE.md`
calls *"the safe default, not an oversight"*. A third convention for the same question would be a
third thing to remember.

**The distinction that does the work (J0):** *not configured* and *configured but unreachable* are
different states. Conflating them either shows members a tab for something their operator never
enabled, or makes a real outage look like a deliberate configuration. The first registers nothing;
the second registers tools that return readable errors (FR-D5, FR-I8).

**What "no lock-in" was read to mean, concretely** — three claims that are testable rather than
aspirational:

- **Nothing else depends on it** (J4). Private memory is not routed through the mangrove; the mangrove reads
  *from* the graph, the graph does not read *through* the mangrove. That direction is what keeps the
  dependency one-way.
- **It can be turned off again** (J5). No object is stored in a form only the mangrove can read, and
  admitted memory survives as ordinary local memory. An optional feature you cannot leave is not
  optional.
- **A disabled tool is not a registered tool** (J2). A `mangrove_*` tool that exists only to refuse still
  occupies a name, still appears in the model's tool list, and still spends context every turn.

**Rejected — registering the tools always and having them error when unconfigured:** simpler to
build, and it charges every turn of every member of every deployment that never wanted the feature.

**Rejected — treating unconfigured as a special case of unreachable:** one fewer branch, and it
turns an operator's choice into what looks like an outage.

---

## Agent's discretion

The owner set D-1 through D-4 directly, and stated the requirements behind D-9 and D-11; the rest
were decided from findings in `spec.md` and are open to reversal. Taken as discretion during design:
the runtime and language (OQ-1, recommendation recorded), the store topology (OQ-2), the exact MCP
tool schemas behind the FR-D3 names, the on-disk log format, and the visual treatment of the three
readings in the tab (FR-I4) — their existence is fixed, their presentation is not.

## Specific references

- `/home/sgeliasp/Downloads/prompt-handoff-memoria-federada.md` — the handoff model. Adopted for
  structure; its scope claims superseded, and its project name dropped at the owner's instruction.
- The owner's framing that the agent is "subjugated" to the human: taken literally and made
  enforceable in FR-E3 and FR-E4, where authority is asymmetric — a bot cannot reverse its human.

## Deferred ideas

- **Cross-deployment S2S federation** — D-1. The interface is designed for; the implementation is
  a later milestone.
- **Envelope encryption with a signature covering `recipients[]`** — D-2/FR-H3. Defined,
  unimplemented, with the break it guards against recorded so that a future implementation does not
  reintroduce it.
- **MLS / per-message ratchet for real forward secrecy** — out of v1 entirely; the limit is declared
  instead (FR-H2).
- **A delegation-chain grant (WIMSE / OAuth `delegation_chain`) as the membership credential** —
  the handoff model's §5. Superseded in v1 by D-2: mycelium's licensed resources already are the
  verifiable, scoped, time-bound credential, and a second one would be a second source of truth.
  Worth revisiting when D-1's boundary moves, because a foreign deployment has no mycelium profile
  to present.
- **Offering `mangrove_*` to picoclaw agents** — OQ-4.
