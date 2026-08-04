# canvas-activity — Specification

> Written alongside the implementation, from two suggestions the user chose off a
> shortlist. Spans both submodules, which is why it lives here rather than in the webapp's
> own `.specs/`.

## Summary

The Canvas timeline stops being a second view of the conversation list and becomes a
record of what the agent **did** — scheduled runs and facts it learned, on the same time
axis — and gains a way out: a thread can leave the timeline as a composer reference.

## The problem it fixes

Canvas fetched conversations and their histories and drew bursts of
`{conversationId, label, text, ts, count}`. It knew **when the member talked**, which the
recency-ordered sidebar already answers — so it was decoration. What it could not show is
the two things that happen while nobody is watching: the agent running a scheduled task,
and the agent learning something. Both were already stored, already timestamped, and
already carried a conversation. They had never been put on an axis.

It was also a dead end: you could look at a thread and then had to switch views and find
it again to say anything about it.

## Functional requirements

- **CA-1** `CronRun` reports the conversation that owned the task when it was scheduled.
  `CronRuns` already parsed picoclaw's `scope.values.chat` marker and dropped it; it is the
  **only** link from unattended work back to a chat. Empty when the marker is missing or
  shaped unexpectedly — a run attributed to the wrong conversation is worse than one
  attributed to none. *(crab-shell-proxy)*
- **CA-2** Scheduled runs render as squares below a lane's line, learned facts as
  triangles above it. Two **shapes**, not two colours: the lane's colour already means
  "which conversation", and a second meaning there would collide with the one the view is
  built on. Both smaller than the conversation dots — they annotate the activity rather
  than being it.
- **CA-3** Work no conversation claims gets its own strip under the lanes rather than
  being dropped: a run whose marker is missing, and facts the proxy could not attribute
  (cron, the heartbeat, two chats in flight at once). **Unattended work with no
  conversation attached is precisely what a member does not already know about.**
- **CA-4** A lane's preview offers "reference in chat": it hands the lane to the composer
  as a **span** (title, window, message count) and switches back to the chat, because
  picking a reference is the member saying they want to say something about it.
- **CA-5** The span marker follows the rule the task, run, attachment and reply markers
  follow: one bracketed line, never the referenced content.

## Non-functional requirements

- **NFR-1** The join is pure and tested, in `canvas-activity.ts`. The two sources identify
  a conversation **differently** — the graph by conversation id (`sourceSessionId`), a run
  by the proxy's derived session key. Crossing those wires attributes everything to
  nothing and the lane simply looks idle, which no screenshot reveals. A test pins that
  exact confusion.
- **NFR-2** Two bounded calls (`listTasks`, `recentChanges`), not one per conversation.
  Unlike the histories Canvas already fetches, the overlay does not scale with the
  workspace. Best-effort: a workspace with no tasks or an unpopulated graph renders as
  before.
- **NFR-3** The composer's reference slot moved from `ChatView` to the shell. Canvas
  **replaces** ChatView, so a reference picked on the timeline unmounted with the view it
  was picked from. The type moved with it, from `lib/cronTasks` to `lib/chatReference` — a
  conversation span is not a cron concept.

## Limits, stated rather than glossed

- **Tool activity is not available for user conversations.** `readMessages` drops
  `role: "tool"` entries on purpose, because a chat transcript has to match what the member
  saw. So "what tools did it use" is answerable for scheduled runs only. Surfacing it for
  conversations is a proxy change, not a webapp one.
- **Provenance has holes by construction.** Facts from cron, the heartbeat, or two
  concurrent chats carry no conversation. CA-3 is the honest handling; the landing copy
  already qualifies the same claim.
- **`recentChanges` is windowed** (30 days as wired). A fact older than the window has no
  marker even though its conversation may still be on the axis.

## Out of scope

| Thing | Why |
|---|---|
| Selecting a time RANGE across lanes | CA-4 references one lane. A multi-lane span is a bigger interaction and was not the value being tested. |
| Tool activity per conversation | Needs the proxy to expose what `readMessages` deliberately withholds. |
| Editing or re-running a task from Canvas | The whole scheduled-task surface is read-only — see [[scheduled-tasks]]. |
