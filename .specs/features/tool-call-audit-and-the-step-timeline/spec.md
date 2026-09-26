# The step timeline, and a durable record of every tool call

Spans three repositories. The webapp half is what was asked for; the harness and
proxy halves exist because the thing it asks to show is not recorded anywhere today.

## The request

> Improve the step messages in the chat. Today when I click one they open each step in
> sequence, but it is hard to tell where each step begins and ends, and what the step's
> index number is. Make each step a stage in a timeline, and make each tool execution
> visually more separated from the next, distinguished above all on hover. Also create a
> way for the member to click a tool and see the full command and the output, all in a
> bottom curtain like the one that already exists.

Followed, when told the third part needs all three repositories:

> Let's go with that option, to make sure everything is auditable in the harness. We
> will generate a lot of extra files, so also create a way for the harness to compress
> the output files that were generated long ago and have not been edited since.

## What is there now

`chat-view.tsx` renders a run of steps as one `<details>`, with each step's narration and
a flat `<ul>` of one-line events under it. A step has no number, no boundary of its own,
and no hover state. `StepEvents` shows `kind`, `name`, a truncated `arguments` and a
status word.

**Neither the command nor the output is available to it.**

- `arguments` on a `TurnEvent` is a **display string capped at 200 runes** by the harness
  (`loop.go:1061`, `maxEventArgs = 200`). The cap is deliberate and stays: the comment
  says an uncapped event log "would grow a transcript by everything the agent ever
  wrote".
- The **output is never written to the transcript at all**. `loop.go:390` — *"The tool
  result goes to the window only. The served transcript records what the member saw, and
  they never saw this."* Its only copies are the derived window file, which compaction
  elides and rewrites, and `.tool-output/<conv>/<call>.txt` for results over 8 KiB.
- **Nothing in the rendered chain carries a tool-call id**, so even a reachable file
  could not be joined to a row.

## FR-1 — every tool call leaves a durable record (harness)

### FR-1.1 — a second store, not `.tool-output`

`.tool-output` is **not** extended to become this. It is the agent's scratch: the path it
returns is handed to the model inside the window, and `elide` leaves that path in
`windows/<conv>.window.json`, which persists. Two policies collide on it:

- **Compression breaks live pointers.** Gzipping `x.txt` to `x.txt.gz` dangles a pointer
  an old conversation still holds when it is resumed.
- **Retention is inverted.** `Retain = 128` deletes exactly what an audit must keep, and
  its own comment justifies deleting *because* the directory is agent scratch.

So the audit record is `.tool-audit/<conv>/<id>.json`, with its own policy. Scratch stays
pruned and uncompressed; audit is kept and compressed. The cost is duplicate bytes for
results over 8 KiB, and that is the right trade: the two directories answer two questions.

### FR-1.2 — what a record holds

The tool's name, the **full uncapped arguments**, the output, the status, and when it
started and finished. The full arguments are here rather than in the transcript, which
keeps the 200-rune cap and its reasoning untouched: history stays light, and the weight
sits behind a click.

**AC-1.2.1** — a record exists for every tool call, whatever its size. The 8 KiB offload
threshold governs `.tool-output` and has nothing to do with this.
**AC-1.2.2** — a record exists for a call in a **silent** iteration. `loop.go:477` returns
early without writing narration when `msg.Content == ""`, so the transcript has no
`tool_calls` entry for those; the audit record does not depend on narration.

### FR-1.3 — written at the start, completed at the end

The record is written **before the call runs**, carrying the command, and rewritten when
it returns, carrying the output and the outcome. This mirrors why the event itself is
added pre-call (`loop.go:336`): **the call that kills a turn is the one most worth
auditing**, and a record written only on success would be missing exactly then.

The rewrite is temp-file-plus-rename, so a reader never sees half a record.

**AC-1.3.1** — a turn cancelled inside a tool leaves a record with the command and no
output, rather than no record.
**AC-1.3.2** — a failed write never fails the turn. Same rule as the offload: this moves
bytes, it does not change what the agent is told.

### FR-1.4 — the id is minted by the harness

`domain.ToolCall.ID` comes from the provider, and **may be empty**: `openai.go:283`
assigns it only when non-empty and has no fallback. `safe("")` returns `"_"`, so keying on
it would collapse every such call in a conversation into one file, silently.

The harness mints its own id, unique within a conversation, and carries the provider's id
inside the record for correlation. The minted id is what appears on `TurnEvent`.

**AC-1.4.1** — two calls in one conversation never share a record, whatever the provider
sent, including when it sent nothing.

### FR-1.5 — it is not tamper-evident, and the spec says so

The record is written by the harness, inside the container, under a directory in the
agent's own bind. The ganglion's only tool is `/bin/sh -c` with no path restriction, so a
turn steered by untrusted text can rewrite it.

**This is not a new weakness**: the transcript itself lives in `workspace/sessions/` in
the same bind and is already what the member reads. The record is therefore exactly as
trustworthy as the history beside it, and no more.

A tamper-evident version is **additive later** — the harness streams records out over the
turn stream and the proxy writes them outside the sandbox. It is not a rewrite of this,
and it is out of scope. A hash chain is not the answer: it would live in the same
writable bind.

## FR-2 — old records are compressed, not deleted (harness)

**Nothing is deleted.** Deleting is what makes `.tool-output` unsuitable, so the audit
store must not inherit it. Growth is real, and compression is the mitigation the request
asks for.

A sweep gzips records whose mtime is older than a fixed age. It runs **at harness boot**,
which is frequent: containers scale to zero, so a boot is ordinary rather than rare.

**AC-2.1** — a record older than the threshold becomes `<id>.json.gz` and the original is
removed.
**AC-2.2** — the compressed file **keeps the original's mtime**. "Not edited since" has to
stay true of the file after the sweep, or the next sweep reads its own work as new.
**AC-2.3** — compression is temp-file-plus-rename, then unlink. A crash mid-sweep leaves
either the original or the compressed copy, never neither.
**AC-2.4** — the age threshold is a constant, not configuration. A knob nobody has asked
to turn is a knob to maintain.
**AC-2.5** — the sweep covers **project workspaces too**. A project's root is a SIBLING
(`workspace-<id>`) and **one process serves every project** — `ProjectRoot` picks the root
per turn from the context, it does not start a second harness. So the sweep walks the
siblings itself; anything else leaves every project's records uncompressed forever, which
is the growth this exists to bound. This was written the other way first, with a comment
asserting each project swept itself on its own boot. No such boot happens.

## FR-3 — one route serves a record (proxy)

`GET /v1/sessions/tool-call`, beside `/v1/sessions/history`.

**AC-3.1** — the user directory is derived from the caller's identity, exactly as history
derives it through `identity.SessionKey(ident.AccID, …)`. Never from a query parameter.
**AC-3.2** — the id is put through the proxy's own `safe()` rule before it reaches a path.
A record id arrives from a URL; a reader that trusted it is one refactor from serving any
file under the root.
**AC-3.3** — it reads `<id>.json`, then `<id>.json.gz`, and decompresses transparently.
Reading in that order means a sweep renaming the file between the two stats yields the
compressed copy rather than a 404.
**AC-3.4** — it honours the project workspace segment, as history does.
**AC-3.5** — an absent record is a clean "not recorded", not an error. Every pre-change
call, and every call under picoclaw, is one.

### FR-3.1 — the gateway route is enumerated, not inherited

The gateway config lists paths **one by one**: `/v1/sessions/history` and
`/v1/sessions/resolve` are separate `[[<role>.path]]` blocks. A new path under the same
prefix is **not** routed by being under it.

It needs its own block in **five places** — three roles in
`deploy/standalone/config.standalone.toml`, two in `deploy/prod/config.base.toml` — plus
production mycelium, which reads its config at boot and therefore needs its own deploy.

This is written down because it has already cost once: the read-receipt feature shipped
with three services correct and the route unrouted in exactly these blocks.

## FR-4 — the step run is a timeline (webapp)

**AC-4.1** — each step carries its **index within the run**, shown. Numbered per run
rather than per turn: steps merge only with immediate neighbours (`toRows`), so one turn
can produce two runs, and a number continuing across an answer in between would count
something the member cannot see.
**AC-4.2** — each step has a visible start and end: a marker on a spine, and its own
bounded block, rather than a paragraph in a stream.
**AC-4.3** — the run's header keeps its count, which is what tells a member whether the
closed block is worth opening.

## FR-5 — tool rows are separated, and answer the pointer (webapp)

**AC-5.1** — each event is its own bounded row, not a line in a list.
**AC-5.2** — hover distinguishes one row from its neighbours. This is the request's
emphasis, and it is also the affordance: a row that opens something has to look like it
does before it is clicked.
**AC-5.3** — the row keeps what it shows today. The truncated arguments are still the
scannable evidence; the sheet is for when that is not enough.

## FR-6 — the sheet (webapp)

Clicking a tool row opens the existing `BottomSheet`, showing the full command and the
output.

**AC-6.1** — it is the same component the mangrove and the file list already use. Not a
second sheet that drifts from it.
**AC-6.2** — the record is fetched **when the sheet opens**, never with the history. The
whole point of the 200-rune cap is that a transcript does not carry this weight.
**AC-6.3** — a record that does not exist says so plainly, and says why where it can:
before this change, under picoclaw, or a call whose turn never finished.
**AC-6.4** — only `kind: "tool"` rows open a sheet. A model fallback and a depth change
have no command and no output; a row that opened an empty sheet would be worse than one
that does not open.

## Security

**The output can contain a member's own secrets.** A `CRAB_SECRET__` value reaches the
agent's environment by design, and `env` or `cat .env` puts it in a tool result — which
this feature now keeps indefinitely and serves over HTTP.

The route is **member-scoped**: it serves the caller's own records and there is no admin
surface for it. That is the same boundary the member's own transcript already has, and
the same decision already taken when the secret channel was accepted. It is stated here
so it is a decision and not an oversight.

## Out of scope

- Making the record tamper-evident (FR-1.5).
- **`status: "ok"` on a non-zero exit.** A tool error only becomes `"failed"` when the
  tool returns a Go error, which aborts the turn; `exec.go:169` records a non-zero exit as
  ordinary content — *"A non-zero exit is information for the agent, not a harness
  failure"*. So a command that exited 1 reads as `ok` in the UI. The sheet makes this
  visible for the first time, because the output carries `[exit: N]`. Changing the status
  semantics is a separate decision and a separate change.
- Backfilling records for calls made before this ships.
- picoclaw. Agent `beta` runs it and writes no audit record; its rows degrade per AC-6.3.
