# Scheduled tasks

A scheduled task is a message your agent sends to itself on a timer. This chapter
explains what one is, what the **Scheduled tasks** pane shows you, and the one
awkward fact about them: reading tasks works on both harnesses, but creating,
editing and deleting them over the API is ganglion-only, and any other harness
answers `501`.

## What a scheduled task is

A task is a stored record: a name, a schedule, and a message. When the schedule
comes due, that message is replayed as an ordinary turn — the agent reads it,
works, and writes a transcript — and nobody is waiting at the other end. The
result is stored and read back later from the pane. A job fired by the
orchestrator's own scheduler, which is how the ganglion works, is delivered to
nobody at all by design.

Three kinds of schedule exist, and the pane names each of them the way the record
does: a cron expression (`Cron 0 7 * * 1`), a repeating interval (`Every 6h`), or
a single instant (`Once at …`). A task can also be marked to remove itself after
it runs, which the pane shows as "Removes itself after running".

> This is unattended work. The message is replayed on every occurrence, forever,
> with nobody reading the result, which is why the orchestrator caps it at 8 KiB
> and bounds one fired turn at thirty minutes.

## The pane

Open **Scheduled tasks** from the sidebar and it appears beside the conversation,
so you can read a past run without losing the chat you are in. Its own subtitle
states the scope honestly: "What the agent runs on a schedule, and what each run
produced. Read-only: ask the agent to create or change a task."

Each task shows when it next runs, when it last ran, whether it is disabled, and
where it delivers if its record names a target. Under it are its runs. Clicking
one opens that run's transcript — the messages, the tool calls and their results
— and **Back to tasks** returns you to the list.

Two things about runs are worth knowing before you read too much into them:

- **Only the most recent run of a live task records a status.** Earlier runs show
  how long they took and how much they logged, and nothing more. There are no
  success ticks next to them because the store carries no per-run outcome to draw
  one from.
- **A run can outlive its task.** A task that removes itself after running leaves
  its transcripts behind, so the pane groups those under "Removed task" — the
  task is no longer scheduled, but the work it did is still on record.

The pane also offers **Hide finished**, which folds away tasks that already ran
and will not run again, a **Check for new tasks** refresh (the agent may schedule
something between two visits), and a **Reference in chat** control on any task or
run. That last one drops the task or the run into the composer's context slot, so
you can ask about it in the conversation beside you without copying anything.

## Who can create one, and where

This is the part that depends on your agent's harness. A harness is the program
inside the agent container that actually runs the loop; the two this book covers
are picoclaw and the ganglion, and [Harnesses](./11-harnesses.md) explains how
one is chosen.

**Reading works on both.** That is deliberate, and the orchestrator's own code
says why: hiding a schedule that will not fire is strictly worse than showing it
and saying so, because a task you cannot see is a task you cannot stop. So
`GET /v1/cron/tasks` and `GET /v1/cron/runs` are served whatever the harness, and
they need no running container.

**Writing is ganglion-only.** `POST`, `PATCH` and `DELETE` on `/v1/cron/tasks`
are refused for any other harness with a `501`, naming it:

```
creating scheduled tasks over this API is not available on the
"picoclaw" harness (agent "beta"): its agent creates them itself
```

That is not a bug and it is not a stub. On picoclaw the schedule lives in timers
inside the container, in the agent's own memory, where the orchestrator cannot
see them — so writing picoclaw's job file from outside would produce a record you
can read and a timer that never changed. A `501` is worse to receive and far
better to debug.

The reason the ganglion can be written is the mirror image. It has no scheduler at
all; the orchestrator holds the schedule, in a file kept *above* the container's
workspace mount, and fires the jobs itself. There is no second writer to disagree
with.

Keeping that file out of the container is also a safety property, and it still is.
The agent cannot read or write the schedule as a file. What it can do is *ask* —
and asking stops the turn until you answer.

**The web app writes neither.** However your agent is configured, the pane is
read-only: there is no create button anywhere in the chat. A task comes into
being by asking the agent, on both harnesses now:

| Your agent runs | How a task comes into being |
|---|---|
| picoclaw | You ask the agent in a conversation; it schedules its own job |
| the ganglion | You ask the agent; it asks you to approve, and then schedules it |

The difference in that second row is the approval, and it is worth spelling out.

When a ganglion agent decides to schedule something, the turn stops. A card
appears in the conversation showing what would run and when, with **Allow** and
**Refuse**. Nothing is created until you answer. If you refuse, you can say why,
and the agent reads your reason — so it can explain itself rather than reporting
an error. If you are not at the screen, nothing happens: the request is refused
after a few minutes and the agent is told nobody answered.

That last part is the point rather than a limitation. A scheduled run is a turn
nobody is watching, and a turn nobody is watching is exactly the one that should
not be able to schedule more of itself. An agent that has been talked into
something by a web page it read cannot get past a person who is not there.

The limits are the other half. A ganglion agent may not schedule anything more
frequent than every fifteen minutes, may not create more than five tasks in an
hour, and cannot take the workspace past twenty tasks in total. It also cannot
*edit* a task — only create, list and remove — because an edit is how a task you
approved becomes a different task without a second approval.

Tasks the agent created are marked as such in the record, along with who approved
them. A task you did not type is one you can always tell apart from one you did.

## What the difference actually costs you

If you only ever read your tasks, the harness barely shows. Where it shows is
whether the schedule fires at all.

A picoclaw schedule is in-process timers, so a stopped container fires nothing.
On an agent configured to shut down when idle, the tasks are real, listed, and
**inert** — and the pane says so rather than letting you assume the task ran:

> These tasks are not running. This instance shuts down when idle, and a schedule
> only fires while it is up. The tasks below are still recorded — an administrator
> has to switch this instance to continuous for them to run.

A ganglion schedule is held by the orchestrator, which is always up and which
*starts* the container to deliver the turn. Scale-to-zero is precisely what that
design was built around, so the notice never appears for a ganglion agent.

Three more properties of the orchestrator's scheduler are worth knowing, because
they are choices rather than accidents:

- **A job is claimed before it runs, not recorded after.** An orchestrator that
  dies mid-turn loses that run rather than re-firing it on every boot. For
  unattended work a missed daily summary is a gap; a re-fired one is an agent
  doing real work twice with nobody watching.
- **A schedule that was slept through fires once.** Replaying every missed
  occurrence would deliver a weekend of hourly turns at once.
- **Two scheduled turns never overlap in one workspace.** A job that comes due
  while another of yours is running is left due and picked up on the next pass.
  Your own messages are unaffected in both directions — a scheduled run neither
  blocks them nor is blocked by them.

## Tasks and projects

Scheduled tasks are scoped like everything else in a
[project](./21-projects.md): inside a project you see that project's tasks and
nothing else, and outside one you see the tasks that belong to the agent's own
workspace. Per-project schedules are something only the ganglion can do — on
picoclaw every project's jobs land in one store, which is a limitation of that
harness rather than a decision.

One consequence is worth repeating from the projects chapter. Deleting a project
drops its routing but **not** its scheduled jobs, so they keep firing. Rather than
let them become invisible, the orchestrator lists a deleted project's orphaned
jobs in the agent's own task list, where you can still find and stop them.

## Where to go next

[Harnesses](./11-harnesses.md) explains the choice this whole chapter turns on
and why an unstated `harness:` key still means picoclaw today.
[Working with projects](./21-projects.md) covers the scoping, and the
[Admin guide](./30-admin-guide.md) covers the instance mode an administrator must
change to make a picoclaw schedule fire.
