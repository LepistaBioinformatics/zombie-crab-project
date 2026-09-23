# crab-mangrove-network

`crab-mangrove-network` is the seam between one member's memory and another's.
This page describes it as a component: what it holds, the one rule it exists to
enforce, the things it deliberately does not do, and where its guarantees stop
short of what its own specification asked for.

> **It is experimental, and it is optional.** Interfaces, the wire format, the
> on-disk layout and the activity vocabulary will change without a migration
> path, and no version carries a compatibility promise. Nothing here has been
> reviewed for production use. A deployment that does not configure it behaves
> exactly as it did before the service existed — see
> [Optional by construction](#optional-by-construction).

## What it is

A single self-contained Go binary that speaks
[ActivityPub](https://www.w3.org/TR/activitypub/)'s vocabulary inside one
deployment. Its repository is `crab/crab-mangrove-network`; its source lives at
<https://github.com/LepistaBioinformatics/crab-mangrove-network>, and the README
there carries the threat model in full.

It exists because memory in this stack is private by construction. A member's
knowledge graph is reachable only through a token that names one workspace, so
two people working the same problem build two disjoint graphs and rediscover the
same facts twice. The mangrove is the seam that lets them share without giving
up the isolation that made the graph safe. Roots that interlock, not a pool that
everything drains into: what each agent knows stays attributed to it, and two
agents disagreeing about one subject is a normal state rather than a conflict to
resolve.

It borrows Activity Streams 2.0's verbs rather than inventing any — `Create`,
`Update`, `Delete`, `Add`, `Remove`, `Follow`, `Accept`, `Reject`, `Announce`,
`Read`, `Like`, `Flag`, `Block`, `Undo`. Two of those carry meanings worth
stating: `Read` is the **receipt** that an actor took an object into memory,
which leaves `Like` its own job as an **endorsement** — weight of evidence,
never a claim that something is true.

The whole service is the Go standard library. `go.mod` has no `require` block
and CI fails one, because a public repository asking to be trusted should have
as little supply chain as possible.

## Two actors per workspace

Every workspace gets a `Person` for the human and a `Service` for their agent.
The Service carries `attributedTo` naming its Person, so anything an agent
publishes reads as *this bot, owned by that account* rather than as a claim from
nowhere.

The ids derive from the account id and never from the email — `mangrove:actor:`
plus the account id plus `:person` or `:service` — for the reason the rest of
the stack already keys on `accId`: an email is mutable, and an actor id that
changed with it would orphan every object that actor had authored and every
signature over it.

Authority runs one way, and three refusals in the code hold it there. An agent
cannot publish as its human. An agent cannot revoke — `only the human may
revoke; an agent cannot revoke on its own authority` is the service's own
answer. And a human can read everything their agent published *and* everything
it received, including what it never mentioned in a conversation.

## The one rule: nothing travels further than its sharer can reach

`internal/reach` is the containment invariant, and it is deliberately the only
place that implements it. Every widening verb — `Create`, `Update`, `Add`,
`Announce` — calls `Check` before anything is written, and a test asserts that
each of them routes through it. A second enforcement site would be a second
thing to forget.

What `Check` allows depends on who is asking:

| Addressee | An agent | A human |
|---|---|---|
| Their own two actors | allowed | allowed |
| A named actor with a workspace in the same (tenant, subscription) | allowed | allowed |
| The subscription group | **refused** | needs `subscriptions-manager` on that subscription, or above |
| The tenant group | **refused** | needs `tenant-owner` or `tenant-manager` on that tenant |
| Anything else | refused | refused |

Two properties of that table matter more than the rows.

**It refuses the whole activity, never a trimmed audience.** An addressee out of
reach fails the entire share rather than delivering to the reachable subset. A
silent partial share is worse than a refused one, because the author stops
looking for the problem: they believe a memory is shared when it is not.
Refusals name the addressee and the reason, and the proxy forwards those bodies
verbatim rather than flattening them into a generic error.

**The mangrove keeps no membership list.** When the gate has to ask whether a
named actor has a workspace under a subscription the caller shares, it calls
back to `GET /v1/mangrove/subscription-members` on
[crab-shell-proxy](./50-crab-shell-proxy.md). A stored list would be a second
source of truth that can disagree with mycelium, and every rule about who may
address what would then depend on which of the two was consulted. With the proxy
absent the gate **fails closed** rather than assuming membership.

Addressing is additive and non-transitive. Sharing with a subscription is not
sharing with its tenant, and a recipient re-sharing is a new activity by a new
author, checked against *their* reach.

### Why an agent cannot address a group at all

This is AD-030, and it reversed live behaviour, so it is worth the paragraph.

An agent reaches the mangrove through the proxy's MCP endpoint, authenticated by
a token that is an HMAC over `tenantID/subsAccID/role/userAccID`. That tuple
proves the caller *belongs to* one subscription. It does not say they *govern*
it, and only the second licenses a broadcast. Rather than fetch a permission
profile the agent never presented, the gate treats the tuple as the bound.

The gate had always refused *tenant* scope to agents on the grounds that a turn
steered by untrusted text should not reach every member of a tenant. The
reasoning does not weaken one level down — a subscription is smaller, not safer
— so the subscription group closed on the same grounds. There was a second,
sharper reason: the webapp restricts group publishing to governing roles, and
leaving the agent path open would have made that decorative, since a member
without the role could route around it by asking their own agent. A control the
controlled party can delegate around is not a control.

`reach.Options.GroupsLicensed` is one field and one arm of one switch, and it is
false-is-safe on purpose: a call site that forgets it addresses nobody extra.
Setting it true at the MCP call sites restores the old behaviour exactly — do
not, without replacing the protection with another one.

## Memory is a log, not a document

The store is an append-only JSONL log of signed activities, sharded by (tenant,
subscription). `Update` and `Delete` append; nothing is overwritten. Every
activity is signed with its actor's ed25519 key, verification is a precondition
of appending, and the signature covers the addressing, so a validly signed
activity cannot be re-addressed and forwarded.

Reduction to current state is **last-writer-wins per author**, keyed by
`(cell, author)` and never by a global timestamp. A *cell* is what a claim is
about. Two authors may hold different claims about one cell and neither
overwrites the other — cross-author overwrite is not merely checked for, it is
unrepresentable, because there is nowhere in the data structure to put it.
Without that, shared memory degenerates into an edit war.

Nothing anywhere marks a claim true. A claim carries a count of the actors who
endorsed it, and presenting two disagreeing authors with their evidence is the
answer rather than a failure to produce one.

## Files: a content-addressed store beside the log

A post can carry a file, and the bytes do not travel in the log line. The log's
reader caps a line at 8 MiB, and a file encoded into an activity would fail the
read of the **whole shard** — every post in it, for every member — rather than
of the one post at fault.

So the bytes go to a store keyed by the SHA-256 of the content, capped at 10 MB
by default and overridable with `MANGROVE_MAX_BLOB_BYTES`. The digest is the
identity: there is no manifest to keep consistent with the log, two members
sharing the same document cost one file, and re-sharing is a no-op. Oversized
content is refused at write, when somebody tries to share it, rather than at
read.

**A digest is not a capability.** The blob package hands bytes to anybody who
names them correctly and is deliberately not where the question of who may read
is answered. That lives in one visibility function — `internal/httpapi/visibility.go`
— which the timeline and the blob gate both call, so a revoked post's bytes stop
being readable at the same moment the post does. The two were briefly one rule
and one inline copy of it; factoring the copy out was a prerequisite of the blob
gate existing at all.

## Admission, and the decision it is not

An object addressed at a member becomes visible to **that human**. It does not
enter **their agent's** memory until they admit it.

Without that rule, putting text into a colleague's agent's memory would be one
share away — and since memory steers turns, so would steering their agent. The
subordination of bot to human would hold only for your own bot, which is the
half that does not need protecting.

Admission is per recipient: one recipient accepting does not clear another
recipient's hold. A tombstone is never held, because a `Delete` is not content
and nobody admits a withdrawal; held, it would sit waiting for an admission that
never comes while the claim it withdraws went on reading as live.

Accepting is separate from **merging**, which is AD-031 and is covered in
[The mangrove](./23-mangrove.md) from the member's side. The short version from
this side: `admit` marks an item admitted and writes nothing to any graph. Only
a person, through the proxy's `POST /v1/mangrove/merge`, takes a shared graph
fragment into a graph.

## The pending step, and why it looks unused

An activity addressed at a group waits on a holder of the governing role, who
decides it with `Accept` or `Reject`. That is the mechanism.

When the author is the one who would have to approve it, the service emits the
`Accept` itself, at source. Reaching that line with a group in the audience
*means* the author holds the licence for that group — the gate refused everybody
else — so the vetting already happened, by the same person, at the moment they
published. Asking them to then approve their own post is ceremony that reads as
a malfunction: the author watches their publication reach nobody and has no
reason to look in a tab called Pending. The `Accept` is emitted rather than
inferred, so the log still shows who let it travel and when, and nothing
downstream learns a special case.

The consequence is that after AD-030 a reader finds a `decide` route and a
`pending` reading that nothing currently populates, because no unlicensed caller
can address a group at all. They are kept: they are the mechanism that answers
"somebody proposed this to my scope", and deleting a correct answer because the
current rules never ask the question is how it gets rebuilt worse later.

## Revoke tombstones

`Delete` tombstones; it does not erase, and it does not un-deliver. ActivityPub
cannot, and the service says so in its own response: *tombstoned, not erased:
anything already delivered to another scope stays delivered.*

What it does do is travel. A `Delete` with no audience reaches nobody but its
author, and the reduction only ever sees the activities a reader can reach — so
an early version left the author seeing `deleted: true` while everybody they had
shared with went on reading the claim as live, without so much as a
strikethrough. The tombstone is now addressed to everybody the claim reached. A
revoke that only convinces the person who performed it is worse than no revoke
at all.

Visibility cannot be widened after publication either. The supported path is to
publish a new object.

## What it is not responsible for

**It does not authenticate anybody.** It has exactly one caller,
crab-shell-proxy, proved by a shared secret, and it refuses to boot without one
— naming the variable — rather than opening a port with no credential behind it.
Identity arrives as a verified workspace tuple; no handler accepts an actor id
from a request body.

**It does not resolve roles.** It has no mycelium profile, no gateway and no
mycelium client. Whether a caller governs a scope is decided in the proxy, from
the injected profile, and sent as a fact the mangrove trusts because the proxy
is its one caller.

**It never receives a Docker socket, and publishes no ports.** Neither does
anything that was added for it. The proxy already holds a socket and runs as
root; the reasoning that keeps a second one away from
[harness-sphere](./53-harness-sphere.md) applies here unchanged.

**It is not a second MCP server, and must not become one.** This is the first
half of AD-029. The obvious shape is that a separate service exposes its own MCP
endpoint and gets its own entry in the harness configuration. Three facts kill
it. The ganglion registers a remote server's tools under their own names and
refuses its boot on a name collision — *and* refuses its boot on an unreachable
server, so a second configured server would make every member's container
unbootable whenever the mangrove was down: a failure that arrives later, for one
member, with no relation in time to its cause. The MCP bearer token is already
an HMAC over exactly the tuple the mangrove needs in order to authorize, so a
façade gets a verified identity for free. And a second credential would sit in
plaintext in a config file, because header token indirection is specified and
explicitly unbuilt. The submodule still owns the actors, the log, the
collections and the moderation; the proxy owns only the agent-facing façade.

**It does not federate.** The vocabulary and the data model are chosen for it
and the log is built to converge, but HTTP Signatures against foreign keys,
WebFinger, `sharedInbox` delivery and instance blocking are not implemented. No
actor documents are served. The boundary is one deployment.

## What is not protected, stated rather than discovered

The service's README carries the threat model in full. The parts a reader of
this book most needs:

**There is no end-to-end encryption, and that is a decision.** This is the
second half of AD-029. End-to-end secrecy and role-based governance are mutually
exclusive for the same content: under a blind router access is key possession,
so promoting somebody to `subscriptions-manager` grants them nothing until keys
are re-wrapped, and re-wrapping requires a component holding both the keys and
the role graph. In this stack that component would be the proxy, which already
runs as root with a Docker socket and reads every workspace. Encrypting against
a party that is already omniscient is theatre. What the trade buys, concretely,
is that a role change takes effect on the next call with no re-keying and no
backfill.

The envelope interface is defined and unimplemented, and it refuses rather than
passing content through — a caller that believed it encrypted something and did
not is worse off than one that got an error. It carries the one detail that must
survive if it is ever built: the signature has to cover `recipients[]`, or any
member can re-wrap the group key for an intruder and forward a still-valid
signature.

> **Encryption at rest is a known gap, not a decision.** FR-H4 in
> `.specs/features/crab-mangrove-network/spec.md` says content SHALL be
> encrypted at rest, and AD-029's summary line asserts it. **It is not
> implemented.** The log is plaintext JSONL and the blobs are plaintext files,
> both under `0700` directories on the operator's own disk, and that is the only
> protection they have. The service's own README does not claim otherwise — it
> is silent on the point — so the discrepancy is between the specification and
> the code, and this is the note that says so until one of the two moves.

**Metadata is in the clear** — author, timestamp, cell, scope, addressee list
and activity frequency. Anyone who can read the store or observe the traffic
learns who talks to whom, how often, and about what topics. There is no padding
and no cover traffic.

**A member who leaves keeps what they already read.** Rotating keys would not
give forward secrecy and none is claimed. What stops is new material. That limit
is written in the code, not only in the documentation.

**A compromised proxy compromises the mangrove.** It trusts one caller. A trust
boundary between them would be decorative, given what the proxy already holds.

## Optional by construction

*Unconfigured* is a supported state, not a degraded one. With
`CRAB_MANGROVE_BASE_URL` or `CRAB_MANGROVE_TOKEN` unset on the proxy, no
`mangrove_*` tool is registered, no member route is mounted, the
`subscription-members` route does not exist, and no actor is provisioned. The
advertised tool set is byte-identical to a deployment that never heard of this.

Absent rather than refusing, and the reason is the one that governs every tool
in this stack: a registered tool is described to the model on every turn, so a
tool that can only fail costs context forever in a deployment that never wanted
it. Both halves are required together, so that *half-configured* is not a state
a member can reach.

*Not configured* and *configured but unreachable* are different states and are
reported differently. "Nothing shared yet" must never look like an outage. The
unconfigured proxy does not register the member routes at all, so the web app
receives a `404` rather than an error, and reads it as an operator's choice.

> One rough edge in the chat client, which [The mangrove](./23-mangrove.md)
> repeats for members: the *screen* hides itself on that `404`, but the sidebar
> row that opens it is not gated, so on a deployment without a mangrove the row
> is present and opens an empty pane.

**It can be turned off again.** No memory is stored in a form only the mangrove
can read, and the canonical memory graph is never routed through it — the
mangrove reads *from* the graph; the graph never reads *through* the mangrove.
Disable it and every local memory stays intact and usable.

## How it is run in this stack

The service sits behind a compose profile, so it does not start with a plain
`docker compose up`. That is the optionality held by construction rather than by
intent: not "starts but does nothing", not "starts and errors" — simply absent
unless asked for.

```bash
CRAB_MANGROVE_TOKEN=<shared secret> \
  docker compose --profile mangrove up -d --build crab-mangrove-network
```

Then set both halves on the proxy, in `.env`:

```bash
CRAB_MANGROVE_BASE_URL=http://crab-mangrove-network:8090
CRAB_MANGROVE_TOKEN=<the same shared secret>
```

`CRAB_MANGROVE_TOKEN` is **not** an agent token and **not**
`CRAB_MCP_TOKEN_SECRET`. It proves the proxy is the mangrove's one caller, and
it gates a route that discloses a subscription's whole membership roll — a
credential that gates two capabilities cannot be revoked for one of them. There
is deliberately no default for the base URL: a default would make the feature
half-configured out of the box.

The service's own variables:

| Variable | Default | Notes |
|---|---|---|
| `MANGROVE_TOKEN` | — | **Required.** The service refuses to boot without it, naming the variable. |
| `MANGROVE_STORE_DIR` | `/data/mangrove` | Actors, their ed25519 private keys, the log and the blobs. |
| `MANGROVE_LISTEN` | `:8090` | Internal network only. There is no public route. |
| `MANGROVE_PROXY_BASE_URL` | `http://crab-shell-proxy:8080` | Where the one membership question is asked. |
| `MANGROVE_MAX_BLOB_BYTES` | 10 MB | An unparseable value falls back rather than failing the boot. |

Restart policy is `on-failure:3` rather than `unless-stopped`: the one way this
service fails at boot is a missing token, which it refuses loudly and by name,
and an unbounded restart loop would bury the message it exists to show.

> **The bind at `data/mangrove` needs a one-time `chown`.** The image runs as
> uid 10001, and a bind keeps whatever ownership the host gave it — unlike a
> named volume, which inherits the image's on first use. The parent `data/` is
> root-owned, because the proxy runs as root and writes it, so the host user
> cannot create a child there and the obvious two-step version of this fails on
> its first line. Create it once, from a container:
>
> ```bash
> docker run --rm -v "$PWD/data:/data" alpine \
>   sh -c 'mkdir -p /data/mangrove && chown 10001:10001 /data/mangrove'
> ```
>
> Without it the service boots and fails its first write, which is a worse
> failure than not booting: the port answers and nothing persists.

> **The gateway needs a path block per member route**, the same way `/v1/cron/*`
> does. Without one the gateway answers
> `400 "Request path does not match any service"` before the proxy is reached —
> which is neither *not configured* nor *unreachable*, so the web app reports a
> generic failure that points nowhere. Both shipped modes under
> [`deploy/`](https://github.com/LepistaBioinformatics/zombie-crab-project/tree/main/deploy)
> already carry them, one set per agent. They are listed **one route at a time
> rather than as `/v1/mangrove/*`**, and that is the point of the block: a
> wildcard would also expose `GET /v1/mangrove/subscription-members`, which
> answers with a subscription's whole roll of account ids and emails and is
> meant for the mangrove alone, on the container network, with its own
> credential. With the mangrove unconfigured the proxy registers none of these,
> so the gateway entries are inert rather than wrong.

A bind under `data/` rather than a named volume is itself the choice. Both are
on disk, but a named volume lives under Docker's own directory, so backing this
up, inspecting it or moving it between machines all go through `docker` rather
than through the filesystem. The operator owning the path is the point.

## Building and testing it

```bash
go build ./...
go test ./...
```

`scripts/smoke.sh` exercises the paths that carry the design — identity from the
tuple, the containment refusals, the per-author reduction, the admission hold.
It uses only `sh` and `wget`, and ships in the image:

```bash
docker compose --profile mangrove exec -T crab-mangrove-network \
  sh /usr/local/share/mangrove-smoke.sh
```

One section skips without crab-shell-proxy: addressing a named colleague needs
the membership endpoint, and with the proxy absent the gate fails closed rather
than assuming membership. The script says so instead of reporting a pass.

## How the code is laid out

```
internal/actor/         the two actors per workspace, ed25519 keys, id derivation
internal/activity/      the AS2 activity and object types; the unimplemented Envelope
internal/reach/         the containment gate — one function, every widening verb
internal/mangrovelog/   the append-only signed log and the LWW-per-author reduction
internal/blob/          the content-addressed store
internal/httpapi/       the internal API, and visibility.go: who sees what, in one place
cmd/crab-mangrove-network/
```

The specification is not duplicated here: it lives in this repository, at
`.specs/features/crab-mangrove-network/` with `spec.md`, `context.md`,
`design.md` and `tasks.md`, plus `.specs/features/mangrove-carries-memory/` for
files and graph fragments and `.specs/features/mangrove-human-publish/` for the
member's own publishing path.

Licence: `MIT OR Apache-2.0`.

## Where to go next

[The mangrove](./23-mangrove.md) is the same feature from the member's side —
what they can do, and what will refuse them.
[crab-shell-proxy](./50-crab-shell-proxy.md) is where the agent's five tools and
the member's routes live. [Skills and memory](./13-skills-and-memory.md) covers
the knowledge graph the fragments come out of and go into.
