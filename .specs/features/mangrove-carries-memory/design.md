# Design

## DD-1 — Blob store: `blobs/<sha256>`, beside `log/` and `actors/`

A flat directory under the store dir, one file per digest, 0600, written
atomically (temp + rename) like the graph store already does. Content addressing
gives FR-A6 for free: the same document shared by two members is one file, and a
re-share is a no-op write.

**Why SHA-256 and not a random id.** A random id would need a manifest mapping
id → content, which is a second thing to keep consistent with the log. The
digest IS the identity, and the log line carrying it is the only index needed.

## DD-2 — A digest is not a capability

`GET /internal/v1/blob?digest=…` takes the caller's tuple and answers only if
the caller can see a **live** activity referencing that digest.

This reuses the timeline's visibility rather than restating it: the reduction
already decides what a tuple may see, including tombstones, holds and group
scope. A second rule here would drift from it, and the drift would be silent —
the blob would stay readable after the post was revoked.

Consequence worth stating: revoking a post removes access to its bytes for
anybody who had not already downloaded them. It does not delete the blob, since
another live post may reference the same content.

## DD-3 — `MemoryFile` finally means something

```go
type Object struct {
    ID        string
    Type      ObjectType
    Cell      string
    Content   string
    MediaType string
    // Blob names content in the blob store. Set only for MemoryFile.
    Blob     string  // sha256, hex
    FileName string  // what the member called it
    Size     int64
}
```

The publish handler gains the first real branch on `Type` in the service: a
`MemoryFile` requires `Blob`/`FileName`/`Size` and an empty `Content`; a
`MemoryNote` requires the reverse. Until now the two were validated and then
treated identically, which is how the type came to mean nothing.

## DD-4 — A graph fragment is a MemoryNote with a declared media type

Not a third `ObjectType`. The fragment IS a note — text about what is
remembered — and its shape is exactly what `mediaType` exists to declare:

```
mediaType: application/vnd.mangrove.graph+json
content:   {"entities":[…],"relations":[…]}
```

A new enum value would force a branch in every consumer that currently needs
none, to distinguish two things that store and travel identically. The media
type is the discriminator the design already has, and the composer's closed set
of two grows to three.

**The cell is DERIVED, never caller-supplied.** It is
`graph:<first 12 hex of sha256 of the sorted entity names, newline-joined>`.

The reduction is keyed by `(cell, author)` and is last-writer-wins, so the cell
decides what supersedes what. A caller-supplied label would let two unrelated
multi-node shares collide on a careless string and silently overwrite each
other — the same class of defect as the admission set that was once keyed by
activity id alone. Deriving it from the set makes collision mean what it should:
the SAME set, re-shared, which is exactly "here is my current view of these
nodes."

The prefix also keeps fragments from LWW-ing against prose. A note whose cell is
the bare entity name and a fragment about that entity are different claims and
must not supersede one another.

## DD-4a — Visibility is factored out before the blob gate exists

`handleTimeline`'s `received` arm decides, inline, whether a tuple sees an
activity: author check, audience scan for the two own-actor ids, group prefix,
admission hold, governance decision. There is no function with the shape "may
this tuple see this activity", so DD-2's "reuses the timeline's visibility" is
aspirational until one exists.

It is extracted first, in its own change, with `handleTimeline` calling it. Then
the blob gate calls the same function and the design note is true.

## DD-5 — The merge is a narrow write, and that is why it is allowed

`POST /v1/mangrove/merge {activityId}`.

The proxy states it has no graph write route. The purpose of that rule is that
the member's UI cannot AUTHOR memory — the bot writes through MCP and the
browser only reads. This route keeps that purpose intact because **the request
body cannot carry an entity**: it names an activity, the proxy reads the
fragment from the mangrove, and merges what the log holds.

The handler:
1. resolves the caller like every other mangrove member route;
2. asks the mangrove for the activity, which refuses if the caller cannot see it
   or has not admitted it as a person;
3. parses the fragment;
4. merges by composing three existing functions, in order:
   `CreateEntities` (adds absent names, skips present ones), then
   `AddObservations` over EVERY name in the fragment, then `CreateRelations`.

**The order is the design.** `CreateEntities` alone would skip an entity the
recipient already has, delivering none of its observations — a skip wearing the
word merge. Running `AddObservations` afterwards works precisely because every
name exists by then, which matters: `AddObservations` validates all its inputs
before mutating any and fails the whole call on one missing entity.

Re-adding the observations of a just-created entity costs nothing: it
deduplicates by content. `CreateRelations` deduplicates by key. All three stamp
the `source` argument, which is FR-C4.

## DD-6 — Compose grows two attachment kinds, sharing one path

The files tab and the graph panel do not each get a publish path. They hand the
composer a pending attachment and open it, so audience, licences and refusal
handling stay in one component — the one that already has tests for all three.

## DD-7 — `MangroveReference`, the fourth `ChatReference`

```ts
export interface MangroveReference {
  kind: "mangrove";
  objectId: string;
  cell: string;
  author: string;
}
```

Serializing to one line, no content inlined. The agent resolves it through
`mangrove_timeline`, which already returns the object id it names — so the
reference needs no new tool to be useful.

## DD-8 — Test strategy

- blob store: identical content stores once; a digest fetched by a stranger is
  refused; a revoked post's blob is refused; the limit is enforced at publish.
- fragment: three entities with one relation among them round-trip with no
  dangling edge and no fourth entity.
- merge: **a person merges and the graph changes; an agent admits and it does
  not.** That pair is the security property, and neither half proves it alone.
- merge: a body carrying entity content is rejected.

## DD-9 — What implementation changed about this design

Recorded because a reader comparing the design to the code would otherwise think
one of them is wrong.

**The merge report counts what ARRIVED, not what each call did.** The three-call
composition makes `AddObservations` report zero whenever an entity was new, since
`CreateEntities` brought its observations in already and the follow-up sees
duplicates. A member told "2 entities, 0 observations" would reasonably conclude
the content had been dropped, so the count sums the observations of newly created
entities with those added to existing ones. Found because the assertion was
written before the code and disagreed with it.

**The tombstone rule moved into `viewer.reach`.** While wiring the blob gate, the
discriminating test (publish, fetch, revoke, fetch refused) failed — and the
cause was not the gate. A `Delete` carried no audience, so it reached nobody but
its author, and even once addressed it landed in the HELD branch waiting for an
admission nobody gives a withdrawal. That was a shipped defect, fixed separately
on `main`, and its rule now lives in the extracted visibility function rather
than in the timeline — which is the whole reason the function was extracted.

**The agent's `file` argument is conditional on the deployment.** It appears in
the tool schema only where the proxy wired a way to read a workspace file.
An argument the model can see but never use is one it will keep trying.
