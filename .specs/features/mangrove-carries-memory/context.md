# Context — decisions taken with the project owner

## D-1 — A blob store in the mangrove, not inline bytes, not a reference

**Asked**: the recipient is in another workspace; how do the bytes cross?
**Chosen**: a content-addressed store beside the log, the activity carrying the
digest. Limit 10 MB.
**Rejected**:
- *base64 inline*. It needs no storage code, but the log is JSONL and its reader
  buffers a line to 8 MiB. A 6 MB file becomes ~8 MB encoded and breaks the read
  of the whole shard — every post in it, not just that one. A failure mode out of
  all proportion to its cause.
- *a reference the proxy resolves*. Nothing is duplicated and revoking really
  cuts access, but it makes the proxy serve a file from workspace A to a member
  of workspace B on the strength of a mangrove activity. The mangrove would
  become an authority over the proxy's files, which it deliberately is not.

## D-2 — Admitting a graph fragment merges it into the recipient's graph

**Asked**: what does admitting actually do to the recipient's memory?
**Chosen**: it creates the entities and relations in their graph. Without this
the network shares notes about memory rather than memory.
**Rejected**: readable-only (leaves the original purpose unbuilt); a separate
second "incorporate" action (defensible, but two steps for the act the whole
feature exists to perform).

## D-3 — The agent gets the same reach

**Asked**: tools for the agent too, or webapp only?
**Chosen**: `mangrove_publish` accepts entity names and a file path. Sharing
memory between agents was the network's stated purpose; leaving it to a human
button inverts the intent.
**Rejected**: webapp-only, and nodes-but-not-files. Reach is unchanged either
way — the gate is the same one at the same point — so the marginal risk is that
an agent can put a workspace file in front of peers it could already address.

## D-4 — Only a person's admit merges. An agent's does not.

**Asked** (raised after D-2, when the two decisions were seen together): who
triggers the merge?
**Chosen**: the human, in the webapp. The agent's `mangrove_admit` keeps working
and keeps writing nothing to the graph.

**This one was not a preference.** `mangrove_admit` admits as the SERVICE actor
with no human in the loop. Combined with D-2 and D-3 the chain would be: agent A,
steered by untrusted text in its turn, publishes entities → addresses agent B →
B admits → the entities are in B's graph. The graph is what steers later turns,
so that is memory poisoning between agents with nobody watching.

It is not a new restriction either. The service's README already says an object
"does not enter their agent's memory until **they** admit it", where *they* is
the human. Admitting is inert today, so nothing enforced it; the merge is what
makes it load-bearing.
