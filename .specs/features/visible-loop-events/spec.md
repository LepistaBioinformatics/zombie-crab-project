# visible-loop-events — Spec

**Spans:** `crab-ganglion-harness` (what a turn records) + `crab-shell-proxy`
(what the history serves) + `crab-exoskeleton-webapp` (how a step run renders).
**Size:** Large. A new durable shape, a new wire field, and a tool-level extension.

## The report

> When the harness is running the investigation steps — the "10 steps" over the final
> answer — it only shows the text steps. But it does several tool executions and
> processing stages in the loop. I want all of them to appear in the front end.

**Where, decided:** the **step run**, the collapsed block above the answer. Not the live
progress band. That band shows one line, replaced per event, and is unmounted the moment
the first word of the answer is revealed; turning it into a growing log is a change to
what it is, and the file already records a motion experiment removed there for reading as
agitation. The example in the report is the collapsed block, and that block survives a
reload. The live band is deliberately out of scope — see the note at the end.

**What, decided:** the tool that ran and how it ended, its arguments, sub-agent starts and
finishes, and model/depth changes. All four were asked for explicitly.

## Why the block cannot show this today

Three separate reasons, and all three have to go.

**FR-0.1 — An iteration that called a tool and narrated nothing writes NO ENTRY.**
`record` returns early when `msg.Content == ""`, and the proxy's `readMessages` drops an
entry whose content and reasoning are both blank. So a silent tool frame is not a step
missing its label; it is a step that does not exist.

**FR-0.2 — The tool calls ARE on disk and are thrown away on the way out.** The harness
writes `tool_calls` (name and arguments) on every narration entry. The proxy's
`jsonlEntry` declares them `[]json.RawMessage` and reads only their PRESENCE, as the
`KindStep` marker; the wire `Message` has no field for them.

**FR-0.3 — The outcome is nowhere.** Tool results reach the context window and only the
window — *"the served transcript records what the member saw, and they never saw this"*.
Sub-agent starts and finishes, model fallbacks and depth changes exist as live progress
frames and nothing else. All of them are gone the moment the stream ends.

## FR-1 — One event record, appended after the batch

**FR-1.1** The harness gains `Message.Events []TurnEvent`, and the loop appends ONE
transcript entry per iteration carrying the iteration's events — after the tool batch has
finished, so an event can report how it ended.

**FR-1.2** The narration entry keeps being written BEFORE the tools run, unchanged. That
placement is load-bearing: *"a tool call is the part of a turn that can take minutes and
die, and the sentence explaining why it was made has to survive that."* An iteration
therefore writes up to two entries — the narration, then the events — and a turn that dies
mid-tool still has the narration and the step marker, with no events. Degrading to what
the block shows today is the correct failure.

**FR-1.3** The events entry carries no content. It is not narration; a sentence
synthesized in the harness would also be a sentence in the wrong language — the harness
has no locale, and every word the member reads here is rendered by the webapp from the
event's fields.

**FR-1.4** `TurnEvent` is one flat shape for every kind, because the block renders them
as one list:

| field | meaning |
|---|---|
| `kind` | `tool`, `subagent`, `model`, `depth` |
| `name` | the tool's name, the child's label, the model's name |
| `arguments` | the call's arguments, capped (FR-3) |
| `status` | `ok`, `denied`, `failed` — empty where the kind has no outcome |
| `detail` | the failure's text, the depth's reason, the fallback's cause |

## FR-2 — Where each kind comes from

**FR-2.1 `tool`** — the loop already has everything: the call's name and arguments before
it runs, and `Denied` / an error after. It already collects `domain.ToolOutcome` per call
for the Learner; this is the same information, kept rather than only counted.

**FR-2.2 `subagent`** — the loop cannot see inside a tool, so `domain.Result` gains an
optional `Events []TurnEvent` a tool may return, and the `subagents` dispatcher fills it
with one per child from the `SubReport`s it already builds for `render`. The loop appends
whatever a tool hands back. This keeps the loop generic: no tool is named in it.

**FR-2.3 `model`** — `tryChain` already emits a progress frame naming the model that did
not answer and the one being tried next. The same facts become an event.

**FR-2.4 `depth`** — the loop already detects a depth change mid-batch and emits a
progress frame with the reason. Same facts, same place.

## FR-3 — Arguments are capped in the harness

A `write_file` call's arguments contain the whole file; a `shell` call's contain the
command. Written whole, a transcript would grow by the size of everything the agent wrote.

**FR-3.1** The harness truncates `arguments` before writing, to a short single-line form,
and marks a truncation so the block can say so rather than implying the call was small.

**FR-3.2** The cap is in the harness, not in the proxy or the client. The bytes must not
reach disk — capping downstream would save nothing.

## FR-4 — The proxy serves them

**FR-4.1** `jsonlEntry` parses `tool_calls` and the new `events` instead of counting raw
messages, and the wire `Message` gains `events`.

**FR-4.2** `readMessages` keeps an entry that carries events even when its content and
reasoning are empty. This is the filter that drops FR-0.1's silent frames today.

**FR-4.3** An events-only entry is `KindStep`. It is not an answer and must never be
promoted into one — `keepAnswerlessTurns`'s `speaks()` already requires non-empty content,
so this holds by construction rather than by a new rule. A turn whose only entries are
events renders as a step block with no answer, which is the honest rendering of a turn
that said nothing.

**FR-4.4** A narration entry's own `tool_calls` are served as `tool` events with no
status, so a member reading a transcript written before this feature still sees which
tools a step asked for. Nothing is backfilled and no old file is rewritten.

## FR-5 — The block renders them

**FR-5.1** `StepRun` renders each step's narration as it does now, with the step's events
beneath it as a list — tool name, a compact argument line, and the outcome.

**FR-5.2** Every word is localized in the webapp. `status` and `kind` map to copy in both
locales; `name`, `arguments` and `detail` are data and are rendered verbatim, in mono.

**FR-5.3** The run's label counts what a member would call a step. The events entry is not
one more step — it is the same step's detail — so the collapsed label must not double.

**Where the merge happens: `toRows`, in the webapp.** An events entry arrives as its own
`KindStep` message, so `toRows` folds it into the preceding step's item rather than adding
one. It is the right seam: `message-rows.ts` is pure and already tested, and the three
rules that would otherwise disagree about what a step is — the run's label, `rowRole`'s
spacing, and `landingIndex`'s scroll target — all live in that one file. Merging in the
proxy instead would put it inside `readMessages`, where `keepAnswerlessTurns` walks spans
and would meet a shape it has never seen.

**FR-5.5** An events entry with no preceding step in the run stands on its own. It happens
when the very first iteration narrates nothing, and dropping it would hide exactly the
silent tool call FR-0.1 exists to recover.

**FR-5.4** A long argument line does not wrap the block open. It truncates in place, and
the whole value is available on hover/title, the way the key list does it.

## Out of scope

**The live progress band.** Decided above. It keeps showing the latest event; the tool
name it already carries is unchanged.

**Compaction and iteration boundaries.** Runtime bookkeeping. "Window compacted, 8
messages dropped" is not something a member can act on, and the two events that ARE worth
that space — model and depth — are in.

**Tool results.** The event says how a call ended, not what it returned. A tool's output
is frequently the whole content of a page or a file, it reaches the model through the
window, and putting it in the transcript would make the block the biggest thing in the
conversation.

**picoclaw.** Its transcripts carry no events, and FR-4.4 is what keeps its steps
rendering exactly as they do today.
