# crab-reef-network — Specification

**Status:** Slice 1 implemented; slices 2 (proxy facade) and 3 (webapp tab) open
**Size:** Complex (a fifth submodule + a proxy MCP façade + a webapp surface + mycelium role reads)
**Depends on:** nothing shipped blocks it. It reuses `internal/mcpserver`, `internal/mcptoken`,
`internal/authz` and the approver contract that `ganglion-approval-endpoint` answers.
**Context:** `context.md` — the decisions behind this, and which of them the owner made directly.

---

## Problem

**Memory in this stack is private by construction, and there is no seam to widen.**

`internal/memgraph` is a per-member knowledge graph the proxy hosts itself at `POST /v1/mcp`
(`internal/mcpserver/server.go:1-8`). The bearer token that reaches it is a stateless HMAC over
`tenantID/subsAccID/role/userAccID[/project]` (`internal/mcptoken/token.go:80-89`), so the scope of a
read is decided by the token's own contents. That is the right shape for isolation and the wrong
shape for sharing: there is no value of that token that means "this subscription", and no route that
would honour one. Two members of the same subscription, running agents against the same problem,
build two disjoint graphs and rediscover the same facts twice.

**And the agent has no identity to share under.** Verified across both modules: there is no code
path in which an agent's own identity substitutes for a human's. A human sees "their agent's"
content because the workspace is keyed by *their own* `AccID` under a given `(tenantID, subsAccID,
role)` — the human acts as themself against the agent. `Identity` carries `AccID`, `Email` and the
decoded `*mycelium.Profile` (`internal/identity/identity.go:33-41`) and nothing else; there is no
actor, no key, no addressable endpoint. An agent that publishes *to other agents* needs all three,
and needs them to be visibly subordinate to a human, or the first question anyone asks about a
published claim — "who said this, and who is answerable for it?" — has no answer.

**There is also no governance surface.** The stack already knows who may administer what:
`internal/authz/authz.go:29-33` names the three slugs it observes — `tenant-owner`,
`tenant-manager`, `subscriptions-manager` — and `CallerTier` (`authz.go:40-67`) resolves a caller's
tier by walking `p.LicensedResources.ToLicensesVector()`. Nothing consumes that for content. Sharing
memory without it would mean inventing a second membership model beside mycelium's, which is the
failure this repository has avoided everywhere else.

## Goal

Agents share memory with each other as **identified, human-owned actors**, governed by the mycelium
roles that already exist, over ActivityPub's standard vocabulary — and a human can read, approve and
revoke everything their agent published or received, including what it never mentioned in chat.

**And none of it is compulsory.** The reef is an optional part of the deployment: unconfigured, it
registers nothing and changes nothing, and a stack that enables it can disable it again without
losing memory. See FR-J.

---

## Key findings (verified, not assumed)

**1. Identity is `accId`, and the workspace tuple is already inside the MCP token.**
`identity.go:1-13` is explicit that the isolation key is `Profile.accId` (a stable UUID) and *never*
the email, "because the email is mutable". The tuple an actor needs is `docker.WorkspaceKey{TenantID,
SubsAccID, Role, UserAccID}` (`internal/docker/manager.go:32-38`) — and that is exactly what
`mcptoken.Mint` signs (`token.go:80-89`). **The façade in FR-D therefore receives a verified
workspace tuple on every call without any new authentication mechanism.** This is the single
strongest reason for the delivery shape chosen below.

**2. The ganglion registers remote MCP tools under their own names and refuses the boot on a
collision.** `cmd/crab-ganglion/main.go:605-611`. AD-028 records the consequence in full: the
ganglion's `.ganglion-config.json` carries exactly one server, `memory`
(`internal/docker/ganglion_config.go:278-314`), and picoclaw's one-per-project fan-out must not be
copied into it. Worse, an **unreachable** MCP server fails the whole container boot
(`main.go:190`). A second server is therefore not a neutral addition: it makes every member's
container unbootable whenever the new service is down.

**3. `tools.mcp.servers.memory` and `tools.mcp.enabled` are in `ManagedConfigPaths`**
(`internal/docker/instance_config.go:73-74`) — the admin config editors refuse to let anyone edit
them. There is **no admin-configurable MCP server mechanism** in this stack; the `admin-shared-*`
scope cascade exists for skills, files and secrets, and has no MCP analogue.

**4. The ganglion's MCP client is streamable HTTP only, and stdio is refused at boot.**
`internal/adapter/mcp/mcp.go:1-16` (JSON-RPC 2.0 over streamable HTTP, protocol `2025-06-18`,
standard library only); a `command`-bearing entry is refused at load with the server named
(`internal/config/file.go:820-870`). Per-call project scoping already exists as the
`X-Ganglion-Project` header, taken from the turn context and **never from a tool argument**
(`mcp.go:317-333`) — the same discipline this spec applies to actor identity in FR-D4.

**5. The tool-approval contract is fixed by published image tags and this spec does not get to
change it.** `POST` with `Authorization: Bearer <GANGLION_TOKEN>` and a body of `{session_key,
session_id, tool_call_id, tool, arguments}`; the reply must decode to `{allowed, reason, by}`
(`approver/proxy/proxy.go:78-90`). A refusal is not a broken turn — the loop hands the model
`The action %q was not approved: %s` and continues (`runtime/loop.go:868-874`) — and a timeout
denies (`loop.go:885-887`). Anything this feature needs from a human at tool time must fit inside
`arguments`.

**6. MCP header token indirection is specified and explicitly unbuilt.**
`.specs/features/ganglion-mcp-token-indirection/spec.md:3` is stamped *"RECORDED — nothing
implemented, and no work scheduled"*. Today the bearer token sits in plaintext in the config file,
and what keeps the agent from reading it is placement plus Landlock plus `scrubEnv`, not
indirection. **This feature must not assume indirection exists, and must not be the reason it
becomes urgent** — which it would be if the reef introduced a second, differently-scoped credential.

**7. What ActivityPub gives, and where it breaks.** Reuse rather than reinvent: a `Group` actor for
a shared scope, `Follow`/`Accept`/`Reject` for membership, `Add`/`Remove` for collection membership,
`to`/`cc` for addressing, `sharedInbox` for delivery. It breaks in four documented places, and this
spec answers each rather than inheriting it: there is **no confidentiality**, only obscurity (D-2
answers this by declaring the trust model instead of faking one); there is **no visibility
downgrade** after publication (FR-C3); **`Group` is convention, not specification** (FR-B makes
membership derived, not asserted); and **moderation is where projects of this shape die** (FR-F
makes it a first-class requirement, not an appendix).

**8. AS2 already has the verbs the owner wanted to improvise — checked against the vocabulary, not
recalled.** [Activity Streams 2.0 Vocabulary][as2v] §3.1 defines 29 activity types, and every verb
this spec uses is among them. The two that matter:

> **`Read`** — *"Indicates that the `actor` has read the `object`."*
> **`Like`** — *"Indicates that the `actor` likes, recommends or endorses the `object`."*

The owner offered `Like`-as-read-receipt as an example rather than a requirement. `Read` is the
exact standard verb for a receipt, which leaves `Like`'s own definition — *recommends or endorses* —
free to carry the handoff model's *"confiança é peso de evidência, nunca predicado de verdade"*.
`Flag`, `Accept`, `Reject`, `Announce`, `Add`, `Remove`, `Follow` and `Undo` are likewise all §3.1
types. **No custom verb is needed in v1.** See FR-C.

`attributedTo` is defined with a domain of `Link | Object` (§4), and every actor type — `Person`,
`Service`, `Group`, `Application` — *extends* `Object` (§3.2). FR-A2's use of `attributedTo` on a
`Service` actor is therefore valid vocabulary rather than an extension.

[as2v]: https://www.w3.org/TR/activitystreams-vocabulary/

---

## Non-goals

| Excluded | Reason |
|---|---|
| Server-to-server federation across deployments | D-1: the v1 boundary is one deployment. HTTP Signatures, WebFinger, `sharedInbox` delivery and instance blocking are designed for and left unbuilt. |
| End-to-end encryption / a blind group router | D-2: mutually exclusive with mycelium-role governance of content. The envelope interface stays defined and unimplemented, with the reason in the code. |
| MLS or a per-message ratchet | No forward secrecy in v1, declared rather than implied. The handoff model's own §7 says to leave the interface and not the implementation. |
| A second MCP server in `.ganglion-config.json` or picoclaw's `config.json` | Finding 2: AD-028's collision rule plus boot-fail coupling. FR-D delivers through the existing one instead. |
| Replacing or absorbing `internal/memgraph` | The reef *shares* the graph; private memory keeps exactly the shape and isolation it has today. |
| Public-internet social features (discovery, hashtags, a public timeline) | This is a memory substrate for one deployment's agents, not a Mastodon. |
| Changing the approver wire contract | Finding 5: fixed by published image tags. |
| Retroactive re-keying on a role change | Made unnecessary by D-2, and named here so nobody builds it. |

---

## Requirements

### FR-A — Actors: a bot subordinate to a human

**A1.** Every provisioned workspace SHALL have exactly two actors: a `Person` for the human and a
`Service` for the agent. Both actor ids SHALL be derived from `UserAccID` (the mycelium account
UUID), never from the email — the email is mutable and `identity.go:1-13` already forbids it as a
key.

**A2.** The `Service` actor SHALL carry `attributedTo` naming its `Person` actor, and SHALL be
`type: Service` so that any AS2 consumer reads it as non-human. AS2 has no normative "this bot
belongs to that person" property; `attributedTo` is defined on `Object`, which `Actor` extends, so
this is valid vocabulary rather than an extension. Recorded as D-5 in `context.md` with the
rejected alternative.

**A3.** An agent SHALL NOT be able to act as any actor other than its own `Service`. The actor is
resolved from the verified workspace tuple carried by the MCP token (finding 1) and SHALL NOT be
readable from a tool argument — the same rule `X-Ganglion-Project` already follows
(`mcp.go:317-333`), and the same rule the whole stack follows for identity (`PROJECT.md:20`: never
from client-declared fields).

**A4.** Each actor SHALL hold a signing keypair. Every activity the reef emits SHALL be signed by
its author's key over a canonical serialisation, and signature verification SHALL be a precondition
of accepting an activity into the log (FR-G). Private keys SHALL be stored where no container can
reach them — above the workspace bind, beside `credential.key`, which is where the stack already
puts secrets an agent must not read (`internal/config/file.go:26-35`).

**A5.** The human SHALL NOT be required to hold or manage a key, an inbox, or a client. The `Person`
actor exists so that authorship and ownership are expressible; the human reads and acts through the
webapp (FR-E), not through a fediverse client.

### FR-B — Scopes and governance: membership is derived, never asserted

**B1.** An object SHALL be addressable to any combination of the following, using AS2's own `to`
and `cc` — the reef SHALL NOT invent an addressing mechanism beside them:

| Target | Backed by | Meaning |
|---|---|---|
| **Self** | the author's own collection | Private. The default, and what an unaddressed publish means. |
| **A specific actor** | a `Person` or `Service` actor URI | Direct share with one named colleague or one named agent. Subject to B7. |
| **A subscription** | a `Group` actor per subscription | Everyone licensed on that subscription. |
| **A tenant** | a `Group` actor per tenant | Everyone licensed on that tenant. |

A `Group`'s id SHALL be derived from the mycelium id of the thing it represents. The list is open to
extension — further dimensions may be added as `Group` actors — but every addition SHALL be
constrained by B6, which is what makes adding one safe.

**B1a.** Addressing SHALL be **additive and non-transitive**. Sharing an object with a subscription
does not share it with that subscription's tenant, and sharing with one actor does not entitle that
actor to re-address it — an `Announce` by a recipient is a new activity by a new author, and is
itself checked against B6.

**B2.** Governance SHALL use the role slugs the stack already observes and SHALL NOT invent new
ones: `subscriptions-manager` governs its subscription's `Group`; `tenant-manager` and
`tenant-owner` govern their tenant's `Group` (`internal/authz/authz.go:29-33`). A caller with
`p.HasAdminPrivileges()` resolves to instance tier and governs all of them (`authz.go:40-67`).

**B3.** Membership SHALL be **derived from the mycelium profile at call time, not stored**. A
`Follow` from an actor whose profile does not license the target subscription or tenant SHALL be
answered with `Reject`. The reef SHALL NOT maintain a membership list that can disagree with
mycelium — one source of truth, checked on every call.

**B4.** A role change SHALL take effect on the next call, with no re-keying, no re-wrapping and no
backfill. This is a direct consequence of D-2 and is the concrete benefit bought by not doing
end-to-end encryption.

**B5.** The reef SHALL NOT read a role from anything a caller supplies. Roles come from the decoded
`*mycelium.Profile`; where the reef needs a fact the profile does not carry, it SHALL be fetched
over mycelium **JSON-RPC** (`POST /_adm/rpc`, camelCase params) and never over REST, per
`.claude/CLAUDE.md`. Method names SHALL be looked up in `ports/api/src/rpc/method_names.rs` or via
`rpc.discover` and never guessed — see OQ-3.

**B6 — the containment invariant.** **No share SHALL cross a boundary the sharer's own permissions
do not already reach.** For every activity, the reef SHALL compute the author's **reachable
addressee set** from their mycelium profile at call time, and SHALL refuse the activity if any
entry in `to`/`cc` falls outside it. The reachable set is:

- their own actors;
- every actor licensed on a subscription the author is themself licensed on;
- every `Group` for a subscription or tenant the author is themself licensed on;
- for an instance-tier caller (`p.HasAdminPrivileges()`, `internal/authz/authz.go:40-67`),
  everything — that tier already administers the whole deployment.

Holding a governing role widens what an author may **decide** (FR-F) and does not, by itself, widen
what they may **address**. The two are separate powers and conflating them is how a moderation
capability quietly becomes a distribution capability.

**B6a.** A refusal SHALL be an error that **names the offending addressee and why it is out of
reach**. The reef SHALL NOT silently drop unreachable addressees from the list and deliver to the
remainder: a publish that appears to succeed while reaching fewer actors than the author intended is
worse than a refusal, because the author believes the memory is shared and it is not.

**B6b.** The invariant SHALL be enforced in **one** function, called on every path that addresses an
object — `Create`, `Add`, `Announce` and any future verb that widens reach. A second enforcement
site is a second thing to forget. A test SHALL assert that each of those paths refuses an
out-of-reach addressee.

**B7 — a direct share reaches a human before it reaches their agent.** An object addressed to a
`Person` SHALL become visible to that human in the webapp tab (FR-I), and SHALL NOT be ingested by
their `Service` actor until the human admits it — either per object, or by a standing rule they set.
An object addressed directly to a `Service` SHALL be held the same way unless that `Service`'s owner
has already admitted that author.

The reason is the one the owner stated: the agent is subordinate to the human. If any member could
push memory straight into a colleague's agent, then steering somebody else's agent would be a share
away, and the subordination in FR-E would hold only for one's own bot.

**B8.** Revoking an author's license SHALL remove their ability to address that scope on the next
call (FR-B4), and SHALL NOT retroactively withdraw objects already delivered — FR-C3 and FR-H1 say
why that cannot be promised. OQ-5 owns the custody question.

### FR-C — Activities: the standard verbs, mapped exactly

**C1.** The lifecycle SHALL use these AS2 activities with these meanings, and SHALL NOT introduce a
custom verb in v1:

| Activity | Object | Meaning in the reef |
|---|---|---|
| `Create` | `MemoryNote`, `MemoryFile` | Publish a memory object authored by this actor. |
| `Update` | the same object | Supersede it. The prior version is retained (FR-G1); this is a new log entry, not a mutation. |
| `Delete` | the same object | Tombstone. See C3 — it SHALL NOT claim erasure from anything already delivered. |
| `Add` | object → `Group` collection | Share an already-published object into a wider scope. Subject to FR-F. |
| `Remove` | object → `Group` collection | Unshare from that scope. Does not delete the object. |
| `Follow` / `Accept` / `Reject` | `Group` | Request, grant or refuse membership of a scope. Decided by FR-B3, not by preference. |
| `Announce` | object | Re-share another actor's object into this actor's own scope, preserving attribution. |
| `Read` | object | **Receipt/ingest confirmation** — this actor has taken the object into its memory. The standard verb; see finding 8. |
| `Like` | object | **Endorsement** — evidence weight, not a truth predicate. Never a read receipt. |
| `Flag` | object or actor | Report to the governing role holder (FR-F4). |
| `Block` | actor | Stop accepting this actor's objects. See FR-E4. |
| `Undo` | `Follow`, `Like`, `Announce`, `Block`, `Read` | Revoke a prior activity by the same actor. |

**C2.** `Read` SHALL be emitted by the harness-facing layer when an object is actually taken into an
agent's working memory, and SHALL NOT be emitted merely because an object appeared in a timeline
listing. A receipt that fires on delivery rather than on ingestion is a receipt for nothing.

**C3.** Widening the visibility of an already-published object SHALL be refused as an operation.
ActivityPub cannot un-deliver, and `Update` does not revoke replicas already sent. The reef SHALL
answer such a request with an error naming the reason, and the documentation SHALL state it. The
supported path is to publish a new object at the wider scope.

### FR-D — Delivery: one MCP server, a `reef_` namespace on the proxy

**D1.** Agents SHALL reach the reef **only** through the MCP server the proxy already hosts at
`POST /v1/mcp`. The number of MCP servers written into `.ganglion-config.json` and into picoclaw's
`config.json` SHALL remain exactly one. The reef submodule is a service on `zombie_net`; the proxy
is its agent-facing façade. Rationale: findings 2, 3 and 6 — a second server re-opens AD-028's
collision surface, couples every container's boot to a new service's liveness, and would need a
second credential in a config file for which token indirection does not exist.

**D2.** Every reef tool name SHALL be prefixed `reef_` and SHALL NOT collide with any of the 18
memgraph tools (`internal/mcpserver/tools.go:169-372`), the three `schedule_*` tools
(`tools.go:401-446`), or any ganglion built-in. A test SHALL assert the full registered tool set is
collision-free, because the failure mode is a container that stops booting.

**D3.** The v1 tool surface SHALL be, at minimum: `reef_publish`, `reef_share`, `reef_unshare`,
`reef_timeline`, `reef_fetch`, `reef_follow`, `reef_unfollow`, `reef_ack`, `reef_endorse`,
`reef_flag`. Exact schemas are a design concern; the constraint here is that each maps to exactly
one FR-C activity and none of them takes an actor id.

**D3a — the surface is a budget, not a wish list.** Every registered tool costs context on **every
turn**, enabled or not used. The graph already contributes 18 tools
(`internal/mcpserver/tools.go:169-372`) plus three `schedule_*` (`tools.go:401-446`). The v1 reef
surface SHALL therefore be as small as the FR-C mapping allows: **a tool that only wraps another
SHALL NOT exist**, and near-identical verbs SHOULD be folded into one tool with a discriminating
argument rather than shipped separately. `reef_ack`, `reef_endorse` and `reef_flag` are the obvious
candidates to fold, and `reef_follow`/`reef_unfollow` differ only by `Undo`. Design owns the final
count; this clause owns the pressure on it.

**D4.** Authorization for every tool call SHALL derive from the MCP token's workspace tuple
(finding 1). A tool SHALL NOT accept a caller-supplied actor, tenant, subscription or role, and
SHALL NOT trust the `X-Ganglion-Project` header for anything but project scoping.

**D5.** The reef SHALL degrade rather than fail. If the reef service is unreachable, the `reef_*`
tools SHALL return an error the model can read and the container SHALL still boot and chat — the
opposite of the second-MCP-server shape, where unreachability is a boot failure (`main.go:190`).

**D6.** Whether `reef_*` tools are offered to picoclaw agents as well as ganglion agents in v1 is
open — see OQ-4. The requirement that binds now is D1: whichever answer, the server count stays one.

### FR-E — Human authority over the bot

**E1.** `reef_publish` and `reef_share` SHALL be gated tools, using the shipped approver contract
unchanged (finding 5). The human answers from the conversation the call happened in; a denial
continues the turn with a result the model can explain; a timeout denies. This spec adds no new
approval wire.

**E2.** A human SHALL be able to read, in the webapp, everything their `Service` actor published
**and** everything it received — including objects the agent never surfaced in chat. "The agent is
subordinate to the human" is not a slogan the spec can leave unenforced; this is the enforcement.

**E3.** A human SHALL be able to `Delete`, `Remove` or `Undo` anything their bot authored or
asserted, and the bot SHALL NOT be able to reverse a human's revocation. Authority is asymmetric by
design.

**E4.** A `Block` asserted by a human SHALL apply to their bot's inbox too. A bot SHALL NOT be able
to `Undo` a human's `Block`.

### FR-F — Approval across a scope boundary

**F1.** Publishing or `Add`ing an object into a scope **wider than the author's own member scope**
SHALL enter a pending state until a holder of that scope's governing role (FR-B2) decides it. Within
the author's own member scope, nothing is pending — the human gate in E1 is the only check.

**F2.** The decision SHALL be expressed as `Accept` or `Reject` on the pending activity. These are
the standard verbs and no queue-specific vocabulary is needed.

**F3.** A `Reject` SHALL NOT be modelled as a failure. It is a result the author's agent can read
and explain, mirroring the approver loop's own treatment (`runtime/loop.go:868-874`).

**F4.** A `Flag` SHALL be delivered to the governing role holders of the flagged object's widest
scope, and SHALL be visible to them in the webapp. Moderation is a first-class requirement here
(finding 7), not a stub.

**F5.** The reef SHALL record, for every `Accept` and `Reject`, which account decided it and when.
The author is not the only party who needs to be answerable.

### FR-G — The log and convergence

**G1.** Memory SHALL be an **append-only log of signed activities**, not a mutable document store.
`Update` and `Delete` append; they do not overwrite. Reduction to current state is a read-time
operation.

**G2.** State reduction SHALL be **last-writer-wins per author per cell**, never last-writer-wins by
global timestamp. Each author has authority over their own cells and no author's write SHALL
silently overwrite another's. Without this, shared memory degenerates into an edit war.

**G3.** Divergence between two readers SHALL be treated as a normal state that converges, not as an
error to be prevented. This matters even inside one deployment, because it is what makes D-1's
deferred S2S step an extension rather than a rewrite.

**G4.** Trust SHALL be modelled as weight of evidence — how much, from whom — and never as a
boolean truth predicate on a memory object.

### FR-H — The threat model, declared

**H1.** The reef's `README` SHALL state explicitly what is **not** protected: the proxy and the reef
read all content in the clear; a member who leaves keeps everything they already read; metadata
(author, timestamp, scope, frequency) is visible to anyone who can see the store or the traffic.

**H2.** The forward-secrecy limit SHALL be stated **in the code**, not only in documentation:
new material stops reaching a departed member, and material they already read remains theirs. This
is the industry-standard position and is defensible precisely because it is written down.

**H3.** The envelope interface from the handoff model SHALL be defined and left unimplemented, with
the reason for deferring it in the source rather than as a TODO. If it is ever implemented, its
signature SHALL cover `recipients[]` — omitting that is the documented break that lets any member
re-wrap the group key for an intruder and forward a still-valid signature.

**H4.** Content SHALL be encrypted at rest. In-transit protection inside `zombie_net` follows the
deployment's existing posture and SHALL be stated rather than assumed.

### FR-I — The webapp tab

**I1.** `crab-exoskeleton-webapp` SHALL offer a **tab of its own** where a member browses what is
shared on the network. This is the surface that makes FR-E2 real; without it, "the human can see
what the agent published and received" is a property of an API nobody looks at.

**I2.** It SHALL be a centre-pane **`Destination`**, alongside `projects` — not a sixth workspace
`Section`. The distinction is already load-bearing in that codebase: the five sections (`memory`,
`graph`, `tasks`, `files`, `secrets` — `app/chat/workspace-sections.ts:15-17`) open *beside* a
conversation under the fragment's `rs` key, and are scoped **by** a workspace, while `projects`
*replaces* the centre pane under `v` (`app/chat/destination.ts:8-20`,
`app/chat/sidebar-destinations.tsx:23-42`). The reef is scoped by subscription and tenant, spans
workspaces, and is not read alongside one conversation, so it belongs with `projects`.

**I3.** Adding the destination SHALL extend `Destination` and `asDestination`
(`app/chat/destination.ts:21-36`) **without weakening the guard**. That function deliberately
refuses every string it does not know, because `v` is text a member can hand-edit or receive in a
link, and the same unchecked cast on `rs` once crashed a panel. A second accepted value does not
make the check redundant.

**I4.** The tab SHALL present, at minimum, three readings, each filterable by scope
(member / subscription / tenant):

1. **Received** — what this member's `Service` actor has been given, including objects it never
   surfaced in a conversation (FR-E2).
2. **Published** — what it authored, with each object's current scope and pending state (FR-F1).
3. **Pending decisions** — shown only to a member whose mycelium role governs the scope
   (FR-B2), listing cross-scope publications awaiting `Accept` or `Reject` (FR-F2) and anything
   `Flag`ged to them (FR-F4).

**I5.** The pending-decisions reading SHALL be absent, not merely empty, for a member holding no
governing role. An affordance that renders and then refuses teaches the wrong model of who decides.

**I6.** The tab SHALL expose the human's revocation authority from FR-E3 — `Delete`, `Remove`,
`Undo` on anything their own bot authored or asserted — and SHALL make clear, where an object has
already been delivered to another scope, that revocation tombstones rather than erases (FR-C3).

**I7.** Every read SHALL go through the BFF with the member's own mycelium session token, as every
other proxy read in that app already does (`lib/proxyRead.ts:60-63`). The webapp SHALL NOT hold a
reef credential of its own, and SHALL NOT read the agent's MCP token.

**I8.** The tab SHALL render a reachable-but-empty reef and an unreachable reef as two different
states, consistent with FR-D5 — the stack degrades rather than failing, and "nothing shared yet"
must not look like "the service is down".

### FR-J — Optional, with no lock-in

The reef is an **optional** part of the deployment. A stack that never configures it SHALL behave
exactly as it does today, and a stack that configures it SHALL remain able to stop.

**J0 — three states, not two.** *Not configured* and *configured but unreachable* are different and
SHALL NOT be conflated. Unconfigured means the feature does not exist for this deployment: nothing
registers, nothing renders. Unreachable means it exists and is down: tools are present and return
errors, and the tab says so (FR-D5, FR-I8). Collapsing them would either show members a tab for a
feature their operator never enabled, or make a genuine outage look like a configuration choice.

**J1 — unset is supported and is the safe default.** The reef SHALL be enabled by explicit
configuration, and its absence SHALL be a supported state rather than a degraded one. This is the
pattern the stack already uses twice and states in the compose file: `CRAB_MCP_TOKEN_SECRET` unset
disables the memory graph entirely — *"no `/v1/mcp` route, no MCP block written into any workspace,
and everything else behaves exactly as before"* (`docker-compose.yaml:235-238`) — and
`CRAB_TELEMETRY_TOKEN` unset leaves the inventory route unregistered, answering 404 rather than 401,
which `.claude/CLAUDE.md` names as *"the safe default, not an oversight"*. The reef SHALL follow it
rather than invent a third convention.

**J2 — unconfigured registers nothing.** With the reef unconfigured: no `reef_*` tool SHALL be
registered on `/v1/mcp`; no actor, keypair or collection SHALL be provisioned for any member; no
reef route SHALL be registered; and the webapp destination SHALL be **absent**, not present and
disabled. A tool that exists only to refuse still occupies a name, still appears in the model's tool
list, and still spends context on every turn.

**J3 — the harness is untouched.** With the reef unconfigured, the number of MCP servers in
`.ganglion-config.json` and in picoclaw's `config.json` SHALL be unchanged, the registered tool set
SHALL be byte-identical to today's, and container boot SHALL be unaffected. FR-D1 keeps the server
count at one whether the reef is on or off; J3 additionally requires that turning it on does not
change the *file* either, beyond what the façade already writes.

**J4 — nothing else depends on it.** No existing capability SHALL acquire the reef as a dependency.
`internal/memgraph`, the scheduler, projects, files, secrets, approvals and chat SHALL each work
exactly as they do now with the reef absent. In particular, **private memory SHALL NOT be routed
through the reef** — the reef reads and publishes *from* the graph; the graph does not read *through*
the reef.

**J5 — it can be turned off again.** Disabling a previously-enabled reef SHALL leave every local
memory graph and every workspace file intact and fully usable by the existing tools. No object SHALL
be stored in a form only the reef can read, and no local memory SHALL be replaced by a reference the
reef alone can resolve. Anything a member received and admitted into their own memory SHALL survive
as ordinary local memory.

**J6 — the failure of a share is not the failure of a turn.** Neither an unconfigured nor an
unreachable reef SHALL fail a turn, fail a boot, or block a tool the member was already using. The
worst outcome SHALL be a `reef_*` call returning a readable error — the same treatment a denied
approval gets (`runtime/loop.go:868-874`).

**J7 — a test asserts the disabled path.** The unconfigured case SHALL be covered by a test, not
only by inspection, for the reason AD-028 gives about failures that arrive later and for one member:
an optional feature's disabled path is the one nobody exercises by hand.

---

## Acceptance criteria

| # | Criterion |
|---|---|
| **AC-1** | An agent that passes an actor id belonging to another member is refused; the actor is taken from the MCP token's tuple alone. |
| **AC-2** | A `Follow` from an account whose mycelium profile does not license the target subscription is answered `Reject`, with no membership stored. |
| **AC-3** | Two authors writing the same cell converge, and neither overwrites the other. |
| **AC-4** | A human's `Delete` of their bot's object removes it from every scope, and a subsequent `Undo` by the bot fails. |
| **AC-5** | With the gate configured and no approver answering, `reef_publish` is denied — fail closed, matching the shipped loop. |
| **AC-6** | The reef's `README` names the exposed metadata and every unprotected case in H1. |
| **AC-7** | A test asserts `.ganglion-config.json` still declares exactly one MCP server after the reef ships, and that the registered tool set has no name collision. |
| **AC-8** | Revoking `subscriptions-manager` from an account removes its ability to `Accept` on that `Group` on the next call, with no re-keying step anywhere. |
| **AC-9** | With the reef service stopped, a ganglion container still boots and chats; only `reef_*` calls return errors. |
| **AC-10** | A human can list, in the webapp, an object their agent received and never mentioned in a conversation. |
| **AC-11** | The reef tab opens from the sidebar as a centre-pane destination, and `SECTION_ORDER` (`app/chat/workspace-sections.ts:17`) still holds exactly five — no sixth section appears beside a conversation. |
| **AC-12** | A hand-edited fragment carrying an unknown `v` still resolves to no destination; adding the reef value does not make `asDestination` accept arbitrary strings. |
| **AC-13** | A member with no governing role sees no pending-decisions reading at all — not an empty one. |
| **AC-14** | With the reef service stopped, the tab shows an unreachable state distinct from the empty state, and the rest of the app is unaffected. |
| **AC-15** | A member addressing a subscription they are not licensed on is refused, and the error names that addressee. |
| **AC-16** | A member addressing a list of three actors, one of them out of reach, gets a refusal — **not** a partial delivery to the other two. |
| **AC-17** | Holding `subscriptions-manager` on subscription A does not let its holder address subscription B; deciding and addressing are separate powers (B6). |
| **AC-18** | `Create`, `Add` and `Announce` each refuse an out-of-reach addressee, and each reaches that refusal through the same single enforcement function (B6b). |
| **AC-19** | An object addressed directly to a colleague's `Person` appears in that colleague's tab and is **not** present in their agent's memory until they admit it. |
| **AC-20** | An object shared with a subscription is not readable from that subscription's tenant scope by someone licensed only on the tenant's *other* subscription (B1a, non-transitivity). |
| **AC-21** | With the reef unconfigured: no `reef_*` tool is in the registered MCP tool set, `.ganglion-config.json` declares one server, `SECTION_ORDER` holds five, and no reef destination resolves. |
| **AC-22** | With the reef unconfigured, the webapp shows no reef destination at all — not a disabled or empty one. |
| **AC-23** | Enabling the reef and then disabling it leaves every memory graph and workspace file intact and usable by the existing tools; nothing is left as a reef-only reference. |
| **AC-24** | An unconfigured reef and an unreachable reef are distinguishable from the outside: the first registers no tool, the second returns a readable error from one. |

---

## Open questions

**OQ-1 — Language and runtime for the submodule.** The handoff model says to choose and justify.
The recommendation is **Go**: the reef must decode the same `*mycelium.Profile` the proxy decodes,
`mycelium-sdk-go` is already a dependency, the two Go services already share idioms, and v1 needs no
federation plumbing (D-1), which is where a TypeScript framework such as Fedify would otherwise
earn its keep. Not decided here because it belongs to Design.

**OQ-2 — Does the reef own its store, or reuse the proxy's?** The objects are memgraph nodes and
workspace files (D-3), both of which live on the proxy's side today. A separate store is cleaner
and adds a synchronisation problem; a shared one is simpler and couples two repositories' schemas.

**This question is narrower than it looks, and Design should not re-open the part FR-J already
closed.** J4 requires the dependency to run one way — the reef reads *from* the graph, the graph
never reads *through* the reef — and J5 forbids storing any object in a form only the reef can read.
Together they rule out the reef holding the **canonical** copy of a shared memory object. What
remains genuinely open is whether it keeps its own **derived** store (the activity log, actor
records, collection membership, delivery state), and where that lives.

**OQ-3 — Which mycelium RPC methods resolve the role facts the profile does not carry.** The
profile carries `LicensedResources`, which may be sufficient. Where it is not, the method names must
be read from `ports/api/src/rpc/method_names.rs` or `rpc.discover`. **No method name is to be
invented** — the failure looks like a permissions problem and surfaces only at runtime.

**OQ-4 — Are `reef_*` tools offered to picoclaw agents in v1, or ganglion-only?** picoclaw's
`config.json` already carries one memory server per project (`mcp_config.go:67-75`), a different
shape from the ganglion's single server, and its MCP block is a third-party binary's contract.
Ganglion-only is the smaller first slice.

**OQ-5 — What happens to shared memory when a member leaves a subscription?** H2 fixes the
confidentiality answer (what they read stays read). What is unresolved is custody: whether objects
they authored into a subscription scope remain, are reattributed, or are tombstoned — and who
decides.

---

## Prerequisite

**Met.** `crab/crab-reef-network` now exists as a public repository under
`MIT OR Apache-2.0`, and the pointer committed here names `da560a1` on its default branch — so
`.github/workflows/submodule-pointers.yml` is satisfied rather than merely not consulted.

What is *not* yet met is the rest of the chain: slices 2 and 3 are siblings in their own
repositories, and this repository's pointers to `crab-shell-proxy` and `crab-exoskeleton-webapp`
stay where they are until those merge.
