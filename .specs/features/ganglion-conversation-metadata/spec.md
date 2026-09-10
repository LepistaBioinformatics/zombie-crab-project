# ganglion-conversation-metadata — Spec

**Status:** Specified. Not implemented.
**Date:** 2026-09-10.
**Spans:** `crab/crab-ganglion-harness` (writes), `crab-shell-proxy` (reads),
`crab/crab-exoskeleton-webapp` (stops owning).
**Depends on:** `ganglion-scale-to-zero` **H-1**. The proxy cannot read metadata out of a
ganglion volume it cannot yet read transcripts out of. H-1 pays for both.

## The premise, corrected

The request was *"o proxy é obrigado a armazenar informações parciais como nome e tags dos
chats … assim o proxy poderia ser simplificado."*

**The proxy stores none of this.** Its only database is `internal/registry` (bbolt: models,
deprecation, referrers). Conversation metadata lives in the **chat-webapp's Postgres**:

```sql
conversations      (id, email, instance, title, updated_at, tenant_id,
                    subs_acc_id, alias, session_key, session_file, project)
conversation_tags  (conversation_id, name, value, metadata JSONB)
```

Two consequences that change the shape of the work:

- **The proxy is not simplified by this — it grows.** Something has to read the files, and
  that something is the proxy. What simplifies is the **webapp**.
- The single-source-of-truth argument still holds, and it is not theoretical.

## The problem is real and already has a workaround in the tree

`lib/db.ts:149` names it: *"the postgres/picoclaw divergence"*. Rows were created on
conversation-open with no transcript behind them, and the listing query still carries
`title <> 'New chat'` to hide them.

That is the whole case in one line: **the metadata and the thing it describes are written
by different components, at different moments, with no transaction between them.** The
create-on-open flow was changed to create-on-first-message to narrow the window; the window
is narrower, not closed, and the workaround is still load-bearing.

A harness that writes the transcript can write its metadata beside it, in the same place,
and the two cannot disagree.

## The decision that shapes everything

**The harness owns the WRITE. The proxy reads the FILES. No listing ever wakes a
container.**

This is the only version compatible with `ganglion-scale-to-zero`, and the tension is worth
stating because the obvious design fails it: if the sidebar asked the container for its
conversations, opening the webapp would cold-start every one of a member's agents. A cold
start to render a sidebar is worse than the divergence being fixed.

The pattern is not new — it is exactly how transcripts already reach the proxy.

```
harness  ──writes──▶  <userDir>/<segment>/sessions/<key>.meta.json
proxy    ──reads the volume──▶  GET /v1/conversations
webapp   ──consumes──▶  sidebar
```

## Requirements

**CM-1 — The harness writes conversation metadata beside the transcript**, in the same
directory and under the same durability rules as `ganglion-scale-to-zero` D-1 (fsynced
before the call returns). Title, tags, and updated-at at minimum.

**CM-2 — Metadata is written in the same turn that creates the conversation.**
No separate upsert, no second component, no window. This is the requirement that closes the
divergence; everything else here is plumbing.

**CM-3 — The proxy serves the listing by reading the volume**, never by calling a
container. A stopped agent's conversations list exactly like a running one's.

**CM-4 — A rename reaches the harness's file.**
Renaming is a member action, so it arrives at the proxy; the proxy must not write the file
behind the harness's back (that reintroduces two writers). Either the proxy forwards it —
which wakes the container, acceptable for an explicit user action, unlike a sidebar render
— or the harness picks up a rename request left for it. **RESOLVED (DQ-1): the proxy
forwards to the container.** One writer, invariant intact. Waking on an explicit member
action costs the 0.2s measured in `ganglion-scale-to-zero` SZ-3. Accepted cost: a rename
fails when the container cannot start — a new failure mode, and an honest one.

**CM-5 — One file per conversation, beside its transcript. No index.**
Measured 2026-09-10 on the NVMe volume: listing **600 conversations by opening 600 files
costs 3.0ms**; a single index file costs 1.4ms. The index saves 1.6ms and reintroduces a
reconciliation problem *inside* the harness — two representations of the same fact, which
is precisely what this feature exists to eliminate. Trading the invariant for 1.6ms is a
bad trade, and it would be a bad trade at ten times the difference.

**CM-6 — Existing Postgres rows are migrated, not stranded.**
Members have renamed conversations; those titles are real data. A one-time import from
`conversations`/`conversation_tags` into the harness files, keyed by `session_key`, runs
before the webapp stops reading its own table.

**CM-7 — Picoclaw agents are unaffected.**
This is a ganglion capability. A picoclaw conversation keeps its Postgres row, and the
webapp keeps reading it for those agents. The two paths coexist until picoclaw is retired
or grows the same file, which is not this work.

**CM-8 — The webapp stops being the source of truth for ganglion conversations**, and its
`title <> 'New chat'` workaround is removed for them. Keeping the filter for picoclaw rows
is fine; keeping it for ganglion would mean the divergence it guards against still exists.

## Out of scope

- **Retiring the `conversations` table.** It still serves picoclaw agents (CM-7) and holds
  `project`, which is a proxy/webapp concept the ganglion answers 501 for (DF-3).
- **Making picoclaw write its own metadata.** It has no seam for it; that is the ownership
  problem the whole harness exists to escape.
- **Tags as a member-facing feature.** This moves where tags live. It does not add UI.

## Acceptance

| # | Criterion |
|---|---|
| AC-1 | A new ganglion conversation appears in the sidebar with its title, and the title came from the harness's file |
| AC-2 | Listing a member's conversations does not start any stopped container — asserted, not observed by eye |
| AC-3 | A conversation cannot exist in the listing without a transcript, and vice versa, with no title filter hiding the difference |
| AC-4 | Renamed titles from Postgres survive the migration |
| AC-5 | Picoclaw conversations list and rename exactly as before |

## Questions closed on 2026-09-10

- **DQ-1 — RESOLVED: the proxy forwards a rename to the container.** See CM-4. One writer
  keeps the invariant this feature exists for; the 0.2s wake is acceptable on an explicit
  member action, unlike a sidebar render. The rejected alternative — a request file the
  harness consumes later — never fails and never wakes anything, but it puts a second
  writer in the directory and leaves the member staring at an unchanged title until the
  agent next runs.

- **DQ-2 — RESOLVED: one file per conversation.** See CM-5, with the measurement.

- **DQ-3 — RESOLVED: the proxy is read-only against these files, and that is an
  invariant, not an implementation detail.** It follows from DQ-1 and is worth stating as
  a rule because the cheap shortcut — having the proxy write the file directly — is
  exactly the two-writer divergence this feature removes, reproduced in a new medium.
