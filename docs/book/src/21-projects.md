# Working with projects

A project carves one agent into subjects. This chapter is for the member who has
noticed that every conversation with their agent shares the same files, the same
instructions and the same accumulated notes, and wants one subject kept apart
from the rest.

## What a project is

Your agent has one workspace: a directory on the host that holds its files, its
memory and the transcripts of everything you have said to it. A project is a
*second* workspace beside the first one, belonging to the same agent and the same
you, with its own copy of all three.

On disk a project's workspace is `workspace-<id>`, a sibling of `workspace/` and
never a child of it. Both harnesses lay it out the same way, which is the whole
reason the layout was changed to this shape —
[Agents, workspaces and projects](./12-agents-and-workspaces.md) covers what is
inside.

The app states the idea in one sentence on the projects screen: a project keeps
its own files, memory and instructions, and inherits this agent's model, skills
and credentials.

## Why you would make one

Because "this thread is about the seed-trial analysis, keep its files and its
instructions apart from my other work" is otherwise unsayable. Everything you
upload lands in one pile; every standing note you write applies to everything;
and an instruction that is right for one subject is noise in every other
conversation.

A project answers all three at once. What it is *not* is a way to give somebody
else access: a project belongs to one (tenant, subscription, agent, user) tuple,
exactly like the workspace it sits beside, and there is no sharing between
members and no delegation between projects.

## What changes inside a project

| | The agent's own workspace | A project |
|---|---|---|
| Files | Shared by every conversation outside a project | The project's own |
| Memory notes | The agent's own | The project's own |
| Instructions | The agent's identity | Identity **plus** what you wrote |
| Conversations | Listed as "General chats" | Listed under the project |
| Scheduled tasks | The agent's own | The project's own |
| Knowledge graph | One graph | The **same** graph |
| Model, skills, credentials | The agent's | Inherited, not overridable |

The scheduled-tasks row has a harness caveat: only the ganglion really files a
schedule under the project it was created in. picoclaw keeps one schedule store
per container, which is a limitation of that harness rather than a decision — see
[Scheduled tasks](./22-scheduled-tasks.md).

Two other rows are the ones people get wrong.

**The knowledge graph is not per project.** The memory pane and the knowledge
graph are two different memories with two different names. The notes you write in
the memory pane belong to the project you are in; the graph the agent builds for
itself is scoped to *you* and spans your projects — one graph server, reached with
the project named in a header rather than a separate graph per project. See
[Skills and memory](./13-skills-and-memory.md).

**Administrator-shared files stay in the main workspace.** Files and content an
operator publishes to a tenant or a subscription cascade into your agent's own
workspace only; they are not copied into project workspaces. Shared *skills*,
the model and your credentials are inherited.

A project also inherits your agent's identity rather than replacing it. The
instructions you type are added to what the agent already knows about itself, and
the app says so where you type them: "Say what this project is and how it should
behave here."

> On the ganglion harness the separation is enforced by the kernel, not by
> convention: a turn inside a project runs with its filesystem confinement rooted
> at that project's own directory, so the shell tool cannot reach the main
> workspace or any other project. That is what the sibling layout bought — a
> project under the main workspace could only ever have been a convention.

## Creating one

Open **Projects** from the sidebar. Unlike the other five destinations, this one
replaces what is in the centre of the screen rather than opening a pane beside
it — a project is a place you enter, not a panel you consult.

Press **New project** and fill in two fields:

- **Name** — for example, "Seed trial 2026". The identifier is derived from the
  name by the orchestrator; you never type one.
- **Instructions** — optional, and the thing worth spending a minute on. The
  placeholder is a good model: "Always cite the trial protocol and answer with
  the plot number first."

Saving creates the workspace. The screen then tells you the one consequence you
would otherwise discover as a slow first reply: **the agent restarts on your next
message.** A project changes what the agent's container has mounted, so the
container is rebuilt before the next turn.

Each project is a card on that screen, showing its name, its instructions and the
date it was created. The project you are currently inside is marked **Current**
rather than hidden or moved to the front — asking to see the list is not the same
as leaving where you are.

## Working inside one

Entering a project changes the scope of almost everything on screen. The
breadcrumb names it. The conversation list shows "Chats in this project" instead
of "General chats". The landing screen says "Ask anything in this project to get
going" rather than naming the agent. The Files, memory and Scheduled tasks panes
all address the project's workspace, not the agent's.

One rule catches people out: **a conversation stays in the project it started
in.** The project selector is offered when you start a conversation and locked
afterwards, because a conversation's transcript physically lives in that
project's workspace. The app says it plainly — "A conversation stays in the
project it started in."

To move work between projects, hand the file over yourself through the Files
pane. The agent cannot copy it across; from inside one project the other one is
not there.

## Editing and deleting

The pencil on a card edits the name and the instructions. Only what you changed
is sent, so renaming a project does not blank its instructions.

Deleting is the destructive one, and the confirmation says exactly what goes:
"Its files, memory and every conversation in it are removed. This cannot be
undone." Like creating, it restarts the agent on your next message.

> Deleting a project does **not** delete the scheduled tasks that were filed
> under it. They keep firing, and the orchestrator deliberately shows them again
> in the agent's own task list afterwards — a task you cannot see is a task you
> cannot stop. Delete a project's tasks before you delete the project. See
> [Scheduled tasks](./22-scheduled-tasks.md).

## Which agents have projects

Both harnesses this book covers serve projects: picoclaw builds them from its own
agent-and-dispatch machinery, and the ganglion takes the project as a request
header and works out of the matching sibling workspace. See
[Harnesses](./11-harnesses.md) for what a harness is and how one is chosen.

What does not have them is an orchestrator older than the feature. Against one of
those the web app reports the agent does not support projects, and both the
sidebar row and the screen are omitted entirely rather than shown and dead.

## Where to go next

[Scheduled tasks](./22-scheduled-tasks.md) is the one project-scoped surface with
a constraint of its own. [Agents, workspaces and projects](./12-agents-and-workspaces.md)
describes what a project workspace looks like on disk, and
[Skills and memory](./13-skills-and-memory.md) explains the two memories a
project does and does not separate.
