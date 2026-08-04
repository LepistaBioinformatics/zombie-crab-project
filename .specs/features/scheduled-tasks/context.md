# scheduled-tasks — Context (user decisions)

Gray areas resolved with the user during Specify, after establishing empirically
that the feature had no backend at all (the request was phrased as a frontend-only
panel). Two facts were verified before any design was proposed: the job store's
on-disk shape (by creating jobs in a throwaway `sipeed/picoclaw:latest` container
and dumping the file) and the task↔run join key (from 4 real run transcripts the
user provided at `/tmp/zombie-debugging/sessions`).

## Decisions

- **DEC-ST-01 — Results mean the full transcript.** Asked whether "resultado"
  meant status only, the delivered message, or the whole run, the user chose
  **status + full transcript**: the task list carries status, and clicking an
  execution renders the entire transcript including tool activity. This is what
  makes the panel a real component rather than a status readout, and it is why the
  new reader cannot reuse `history.readMessages` (which drops `tool` entries).

- **DEC-ST-02 — Read-only in v1.** Asked whether the panel should also
  enable/disable/remove or create tasks, the user chose **read-only**. The stated
  reason, accepted: writing `jobs.json` from outside risks diverging from the
  picoclaw gateway's in-memory timers, and whether the gateway reloads an
  externally edited store is unverified. If it does not reload, a UI toggle would
  lie until the container restarts, which pulls in the proxy's restart-notice
  machinery and roughly doubles the scope. Creating and changing tasks stays with
  the agent, which already knows how. A v2 must verify reload behavior first.

- **DEC-ST-03 — No inferred success mark on past executions.** The mockup the user
  approved showed a `✓` with a duration on every execution row. That was corrected
  during Specify: per-run success is recorded nowhere. Offered the choice between
  omitting the mark and showing a labelled heuristic ("concluído"/"incompleto",
  derived from whether the transcript ends on an assistant entry with no pending
  tool call), the user chose **omit**. Executions therefore show instant, duration
  and entry count only. `lastStatus`/`lastError` show on the task, where the store
  actually records them, and `lastStatus` is displayed verbatim as an opaque
  string because no real value was ever observed.

- **DEC-ST-04 — References in chat, added mid-Specify.** The user asked to be able
  to reference scheduled tasks in the chat. Since the outgoing payload is plain
  text only, this needs **no backend change** — it becomes a third context slot on
  `ChatView`, mirroring the existing `replyTo`. Both granularities are
  referenceable (a task and a single execution); the serialized marker is
  self-contained (name, id, schedule or instant) and **never** inlines the
  transcript, which can reach 112 KB. `buildQuote` already established
  truncated-inline-snippet as the house style, and the agent can read the store
  and transcripts from its own filesystem when it needs more.

- **DEC-ST-05 — Workspace-scoped, not chat-scoped.** Decided rather than asked,
  and stated for the record: the panel lists the whole workspace's tasks, matching
  Memory / Graph / Files on that surface. Filtering by the active conversation
  would hide tasks whose delivery target is another chat, and orphan runs (from
  `deleteAfterRun` jobs) have no surviving chat link to filter on.

## Assumptions

- **A-ST-01 — The proxy can read `jobs.json`.** The file is `0600 root:root`; the
  proxy container runs as root and already reads root-owned files under `/data`
  (session transcripts, the restart store). Verified structurally, not by running
  the endpoint. If a future deployment drops the proxy to non-root, this breaks
  the same way the existing history reader would.
- **A-ST-02 — `payload.kind` beyond `agent_turn` may exist.** Only `agent_turn`
  was observed. The template config carries `allow_command`, so command jobs are
  plausible. Handled by degrading to a readable rendering (NFR-3) rather than by
  guessing the shape.
- **A-ST-03 — `schedule.kind: "at"` follows the observed pattern** (`atMs`
  alongside the kind). The field name comes from the binary's string set; no `at`
  job was produced, because the CLI has no flag for it.

## Pipeline depth

Large: two submodules, a new Go package, two endpoints, a new panel with internal
navigation, and a composer change. Full Specify → Design → Tasks → Execute.
