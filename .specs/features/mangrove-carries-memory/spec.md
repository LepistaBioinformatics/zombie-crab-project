# mangrove-carries-memory

Extends `crab-mangrove-network`. A post carries a **workspace file** or a
**fragment of the memory graph**, and a post can be **referenced from the chat**.

## Why this exists

The network was specified to share memory — graph material and files. What
shipped shares **text**. Verified rather than assumed:

- `MemoryFile` is a validated enum value and nothing more. A full-repo sweep
  finds it in three Go locations, all in one membership check; after that line
  the two object types are handled identically. There is no branch on `Type` in
  publish, share, react, admit, decide, revoke, timeline or `Reduce`.
- `Object.Cell` is documented as possibly "a file path", but nothing resolves a
  Cell to a workspace file, nothing fetches bytes, and there is no blob store.
- `admit` emits an `Accept` and writes nothing anywhere. Admitting is inert.

So the original idea — agents sharing parts of their memory graph — has no path
behind it. This builds it.

## Functional requirements

### FR-A: a post can carry a file

- **FR-A1** The mangrove SHALL hold file bytes in a content-addressed store
  beside the log, keyed by the SHA-256 of the content.
- **FR-A2** An object referencing a blob SHALL carry the digest, the original
  file name and the byte size. The bytes SHALL NOT travel inside the log line:
  the log is JSONL and its reader caps a line at 8 MiB, so an oversized inline
  object would fail the read of **the whole shard**, not of that one post.
- **FR-A3** A blob SHALL be refused above a configured limit, default 10 MB.
- **FR-A4** A digest SHALL NOT be a bearer capability. Fetching a blob SHALL
  require that the caller can see a **live** activity referencing it — the same
  visibility the timeline computes, and not a weaker one.
- **FR-A4a** That visibility SHALL be one function, called by both the timeline
  and the blob gate. It is inline in `handleTimeline` today, so it SHALL be
  factored out FIRST, as its own change, with the timeline calling it.

  Without that step FR-A4 describes something that does not exist, and the
  second rule would drift from the first silently — the symptom being a blob
  that stays readable after its post was revoked.
- **FR-A5** Blob bytes SHALL be served as `application/octet-stream` with
  `Content-Disposition: attachment`, matching the invariant the proxy already
  holds for workspace media: a member's file never renders from the origin that
  serves it.
- **FR-A6** Identical content SHALL store once. Content addressing is the point;
  two members sharing the same document must not cost two copies.

### FR-B: a post can carry graph nodes

- **FR-B1** A member or an agent SHALL be able to publish a set of entities from
  their memory graph.
- **FR-B2** The fragment SHALL be self-contained: the named entities **and the
  relations among them**, with no dangling edge. `memgraph.OpenNodes` already
  computes exactly this, via `relationsAmong`, and SHALL be reused rather than
  reimplemented.
- **FR-B3** The fragment SHALL be carried as JSON with a declared media type, so
  a reader distinguishes it from prose without sniffing.
- **FR-B4** The webapp's graph panel SHALL allow selecting a SET of entities. It
  is single-select today (`selected: string | null`).

### FR-C: admitting a fragment merges it — and only a person may

- **FR-C1** A person admitting a graph fragment SHALL have its entities and
  relations merged into their own graph.
- **FR-C2** **An agent's own `mangrove_admit` SHALL NOT merge.** It continues to
  mark the item admitted and writes nothing to the graph.

  This is the invariant the whole feature rests on. `mangrove_admit` lets the
  agent admit for itself, with no human involved. Today that is inert. The
  moment admitting merges, an agent steered by untrusted text could publish
  entities, address a peer agent, and have that peer admit them into its own
  graph — and the graph is what steers later turns. The service's own README
  already states the intended rule: an object "does not enter their agent's
  memory until **they** admit it", where *they* is the human.
- **FR-C3** The merge SHALL be additive, and SHALL reach an entity the recipient
  ALREADY HAS.

  This is not one call. `CreateEntities` **skips** a name that already exists,
  so using it alone would give a recipient who already knows entity `X` none of
  the shared observations about `X` — a skip presented as a merge. The merge is
  the composition of three existing functions, in order: `CreateEntities` (adds
  the absent names), then `AddObservations` over every name in the fragment
  (they all exist by then; it deduplicates by content and never overwrites),
  then `CreateRelations` (deduplicates by key). No new merge logic is written.
- **FR-C4** The merge SHALL record where the material came from, so a later
  reader can tell borrowed memory from their own.

### FR-D: the proxy's no-graph-write invariant survives

- **FR-D1** The merge route SHALL NOT accept graph content from the client. It
  takes an activity id; the content comes from the mangrove's log.

  `internal/httpapi/memory_graph.go` states: "The bot writes through MCP; this
  side only reads. There is no write route here — not undocumented, not
  registered." The purpose of that rule is that a member's UI cannot AUTHOR
  memory. A route that merges what was already shared with the caller preserves
  that purpose exactly, because the request body cannot carry an entity.

### FR-E: referencing a post in the chat

- **FR-E1** A post SHALL have an action that puts a reference to it in the chat
  composer.
- **FR-E2** It SHALL be a new variant of the existing `ChatReference` union, not
  a new channel. The union is closed and a new kind fails to typecheck until it
  has an icon; `EntityReference` already rides it.
- **FR-E3** The marker SHALL serialize to ONE self-contained line and SHALL NOT
  inline the post's content — the rule `[anexo: …]` and the reply quote already
  follow.
- **FR-E4** The marker SHALL carry enough for the agent to find the post in its
  own timeline: the object id, its cell and its author.

### FR-F: sharing from where the thing already is

- **FR-F1** The files tab SHALL offer a per-file share action. Its action row
  has Download and Delete today and no share.
- **FR-F2** The graph panel SHALL offer a share action over the current
  selection.
- **FR-F3** Both SHALL reach the same compose path, so audience, licences and
  refusals behave identically to a text post.

### FR-G: the agent too

- **FR-G1** `mangrove_publish` SHALL accept graph entity names and a workspace
  file path, not only prose.
- **FR-G2** Agent reach SHALL be unchanged. Carrying a file does not widen who
  may receive it; the gate is the same one, called at the same point.

## Acceptance criteria

- **AC-1** A member shares a file from the files tab; the recipient sees it and
  downloads identical bytes.
- **AC-2** The same file shared twice stores one blob.
- **AC-3** A blob fetch by somebody the post was never addressed to is refused.
- **AC-3a** THE DISCRIMINATING ONE: publish a file, fetch it successfully,
  revoke the post, and the same fetch is refused. AC-3 alone passes against a
  gate that reads the audience list at face value; only a gate wired to the live
  reduction passes this. It is written first.
- **AC-4** A blob above the limit is refused at publish, not at read.
- **AC-5** A member selects three entities with one relation among them, shares
  them, and the recipient receives exactly those three plus that one relation —
  no dangling edge, no fourth entity.
- **AC-6** A person admits the fragment and the entities appear in their graph.
- **AC-7** An AGENT admits the same fragment and its graph is unchanged.
- **AC-8** A merge does not overwrite an observation the recipient already had.
- **AC-8a** A merge ADDS observations to an entity the recipient already has,
  rather than skipping that entity.
- **AC-9** The merge route rejects a body carrying entity content.
- **AC-10** A post referenced into the chat produces one marker line naming the
  object id, and the agent can resolve it through `mangrove_timeline`.
- **AC-11** `mangrove_publish` can publish entity names and a file path.
- **AC-12** With the mangrove unconfigured, no share action appears in the files
  tab or the graph panel, and neither regresses.

## Out of scope

- Editing a received fragment before merging.
- Conflict resolution beyond additive merge.
- Sharing a whole graph, or a folder of files.
