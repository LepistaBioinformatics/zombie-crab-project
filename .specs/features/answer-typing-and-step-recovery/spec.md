# answer-typing-and-step-recovery — Spec

**Spans:** `crab-shell-proxy` (the streaming-mode header) + `crab-exoskeleton-webapp`
(cut-stream recovery).
**Caused by:** `thinking-vs-answer-messages` — the change that gave the ganglion its
visible steps. Both defects below are consequences of it that nothing was watching for.
**Size:** Medium. Two small changes, each in the one place that states a fact that
stopped being true.

## The report

> when the agent fires subagents the chat is released as if it had already finished;
> then when I send a message, out of nowhere it prints the whole old message with no
> typing.

One sentence, two defects. Neither is in the code the report points at.

## Defect 1 — the ganglion says it streams, and no longer does

`streamingModeFor` (`crab-shell-proxy/internal/httpapi/sse.go`) answers `native` for a
ganglion agent and `terminal` for picoclaw. The webapp reads that header once per turn
(`turn-store.ts`, `nativeStreaming`) and branches on it: `native` paints each delta as it
arrives, `terminal` buffers and hands the text to the reveal driver — the typewriter.

The header was true when it was written. It stopped being true when the steps landed.
`loop.go`'s `complete` now holds a frame's content until the frame ENDS, because an
iteration's text is narration or answer depending on how it ends and nothing says which
until it does. The answer therefore leaves the harness in ONE emission
(`sink.EmitContent(msg.Content)`), becomes ONE `content` delta
(`httpsse.go`'s `Content` sink), and reaches the browser whole.

So the webapp takes the `native` branch for a stream that is terminal in every respect,
and paints the entire answer in a single patch. That is the report's "prints the whole
message with no typing", exactly.

**FR-1.1** `streamingModeFor` reports `terminal` for the ganglion. The header states a
fact about how content arrives, and the fact is now the same for both harnesses.

**FR-1.2** No webapp change. Its terminal branch is the reveal driver, which is the
behaviour being asked for, and it is already covered
(`turn-store.test.ts`, "still animates a terminal harness").

**FR-1.3** The steps are untouched. They travel as `x_crab_progress`, which this header
says nothing about.

**Consequence, stated rather than discovered later:** the reveal is paced by
`revealPlan` — up to `REVEAL_TOTAL_MS` (5.3s) for a long answer — and `running` stays
true until the buffer drains, so the caret keeps blinking for up to five seconds after
the answer is already durable. That is exactly what picoclaw does today, so it is
consistent rather than new.

## Defect 2 — a cut stream ends the turn at the first STEP

`recover()` (`turn-store.ts`) polls the durable transcript after a cut. In the
`runTurn` path it has no `stillActive` probe, and its rule is:

> the first growth IS the reply: the cut happened while the turn was finishing, so one
> repaint ends the wait.

That rule reads the transcript's LENGTH as a completion signal. It was written against
picoclaw, which appends one assistant message per turn — its inline tool entries are
dropped by `history.go`'s `readMessages` (role is neither user nor assistant), so they
never move the count.

The ganglion moves it on every iteration. `record` appends each narration frame as its
own assistant message carrying `tool_calls`, and `readMessages` keeps it, marking it
`KindStep`. A turn that fires subagents writes ten or more of those before it answers —
the live transcripts show fourteen steps in one turn.

So after a cut, the first poll sees growth, `recover` returns, `runTurn`'s `finally`
sets `arrivalDone`, `finishIfDrained` clears `running`, and the conversation is released
while the turn is still running upstream. The real answer lands in the transcript minutes
later and is first seen on the next history load — which is what sending another message
triggers. That is the report's first half AND its "out of nowhere", and it explains why
subagents are when it shows: a long turn is the one that gets cut.

**FR-2.1** Recovery ends when the PROXY says the turn is over, never because the
transcript grew. `GET /v1/turns/active` already answers that question and the resume path
already uses it for this exact reason.

**FR-2.2** Growth while the turn is still active repaints, so the steps that landed
during the cut appear. It does not end the wait.

**FR-2.3** The two modes collapse into one. `recover` had a `stillActive`-present branch
and a `stillActive`-absent branch; with both callers passing one, the second branch is
the bug and nothing else.

**FR-2.4** A probe that cannot answer is not an answer. Only an explicit `active: false`
ends the wait — a failed request means the turn is still running as far as anyone knows,
and ending on it would rebuild the defect out of a dropped packet.

**FR-2.5** Nothing about the budget changes: `RECOVERY_BUDGET_MS` still bounds the wait
and `turn_lost` is still reported when NOTHING ever arrived.

## The two halves fix different things, and saying so matters

Both defects live in one sentence of the report, so it is easy to read them as one fix.
They are not.

**FR-1 restores typing for a turn whose stream survives to the end** — the ordinary
case. The answer arrives as a content delta, the reveal driver paces it, the caret
blinks while it does.

**FR-2 does not restore typing.** A recovered answer arrives through `onReplyDone` →
history reload, and a reloaded transcript is painted whole. What FR-2 buys is that the
answer appears **promptly and in its own turn**, rather than surfacing whenever
something reloaded the history next — which, for a member who sends nothing, is never.

So a member whose turns are dominated by cuts will still see some answers arrive
un-typed after this lands, and that is the design rather than the fix failing. Typing
for a recovered answer would mean feeding a reloaded transcript through the reveal
driver, which reveals text the member may have already read. `turn-stream-continuity`
is the spec that attacks the cut itself.

## Out of scope

**Making the ganglion stream the answer for real.** It would mean emitting content before
the frame ends and re-marking it as narration when a tool call turns up, which is the
reflow `loop.go:700` exists to prevent — and it would break the steps this same request
asks to keep. The owner already chose steps over token-by-token arrival. The request here
is that the answer LOOK typed, and the reveal driver is what does that.

**Preventing the cut.** `turn-stream-continuity` is the spec for that, and it is still
unimplemented. This one makes a cut survivable for a harness that writes as it goes.
