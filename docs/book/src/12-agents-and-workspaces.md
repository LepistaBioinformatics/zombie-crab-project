# Agents, workspaces and projects

An agent is one thing to the person using it and a different thing on disk. This
chapter covers both, then the directory layout the proxy writes, and finally the
one place where the two harnesses deliberately diverge.

## What an agent is to a member

When you sign in to the chat client you do not pick a model or a container. You
pick an **agent** — `alpha`, `beta`, whatever this deployment declares — and you
get a conversation with it.

With no workspace selected, the chat area becomes a picker: one row per tenant,
a box per subscription inside it, and the agents you can reach as tiles showing
your permissions on each (an eye for read, a pencil for write). Clicking one
opens a fresh conversation.

An agent is therefore a *kind* of assistant, shared in name across everyone who
can reach it, and private in substance to each of them. Two members chatting with
`alpha` are talking to the same persona, the same model configuration and the
same administrator-published skills — in two different containers, with two
different memories, two different file trees, and no path between them.

Your agent is keyed on your **account id**, not your email. Emails are mutable
and are kept only as a human-readable marker for operators; change your email and
your agent and its history stay yours.

## What an agent is on disk

The proxy's unit of isolation is a four-part key: tenant, subscription, role (the
agent key) and user account id. That key names one directory:

```text
<data root>/tenants/<tenant>/subscriptions/<subscription>/agents/<agent>/users/<user>/
```

Every component is sanitized before it becomes a path segment, so nothing in a
request can grow a separator or a `..`. The directory is created lazily, on the
member's first chat — or up front for a whole subscription if the optional
`subscriptionAccount.created` webhook is registered with mycelium.

That directory is what this book calls the **user directory**. It belongs to the
proxy. Some of it is mounted into the agent's container; some of it deliberately
is not.

## The layout

```text
<user dir>/                       the proxy's, NOT necessarily mounted
├── config.json                   harness configuration, proxy-written
├── .security.yml                 picoclaw only
├── .projects.json                proxy-owned: which projects exist
├── .schedules.json               proxy-owned: scheduled tasks (ganglion)
├── .crab-owner.json              proxy-owned: who this workspace belongs to
├── .crab-model.json              proxy-owned: this member's model choice
├── .crab-mode.json               proxy-owned: this instance's lifecycle override
├── workspace/                    THE MAIN AGENT
│   ├── AGENT.md SOUL.md HEARTBEAT.md USER.md
│   ├── memory/  public/  sessions/  ...
└── workspace-<project-id>/       ONE PER PROJECT, A SIBLING OF workspace/
    ├── AGENT.md SOUL.md HEARTBEAT.md USER.md
    └── memory/  public/  sessions/  ...
```

Two rules make this layout worth learning rather than looking up.

**Every harness lays its per-user directory out the same way.** A path that means
one thing under picoclaw means the same thing under any other harness this stack
spawns. That is not a courtesy to picoclaw; it is what lets the proxy read and
write these directories with one set of functions instead of one per harness. A
per-harness branch that is *missing* does not fail loudly — it reads a directory
that never existed and reports that the member has no history, no files and no
scheduled tasks.

**The dotfiles above `workspace/` are the proxy's, not the agent's.** They decide
which project identities exist, which model is used, whether the container may
be kept alive, and what is scheduled. An agent able to edit them could route a
peer's conversations to itself, pick the endpoint its own keys are sent to, or
keep its own container running indefinitely. So they sit outside what the agent
can reach — by two different mechanisms, depending on the harness.

`.crab-owner.json` is a small JSON marker recording the full workspace tuple and
the owner's email, so an operator can find which human a container belongs to.
It is needed because the container's *name* cannot carry that information: the
full tuple is two UUIDs, which exceeds the 63-character DNS label limit.

## A project workspace is a sibling

When a member creates a project, the proxy creates a second agent identity for
them with its own workspace:

```text
workspace-<project-id>       correct
workspace/projects/<id>      WRONG
```

**`workspace-<id>` is a sibling of `workspace/`, never a child of it.** The name
is not a preference. picoclaw derives a named agent's workspace as
`<defaults.workspace>/../workspace-<id>` when the agent config does not set one,
so its own tooling resolves that path independently of anything the proxy writes.
The proxy's `WorkspaceSegment` helper returns `workspace` for the empty project
and `workspace-<id>` otherwise, and it **does not branch on the harness**.

It used to. The ganglion kept projects under the main workspace for one release,
to spare itself a second bind, and the cost was that one function was really two
pretending to be one — every caller that reached for a project's sessions, its
public directory or its media inherited the split, and a caller that forgot did
not fail: it read a directory that never existed. The legacy child path survives
only so cleanup code can find a subtree written before the migration. Nothing may
create one.

Each project's workspace has its own persona files, its own memory, its own
sessions and its own `public/` directory. A project's history is not reachable by
asking for the main workspace's, which is the point: a project scopes the
transcripts, the context window and the files. See
[Working with projects](./21-projects.md) for the member-facing side.

## What the two harnesses mount, and why it matters

The layout is shared. **The bind set is not**, and that difference is
load-bearing rather than incidental.

**picoclaw mounts the whole user directory.** It has its own
`restrict_to_workspace` setting, which keeps its agent inside `workspace/`, so
the proxy's own state can sit beside the workspace and still be out of reach.
The proxy additionally binds a read-only `.secrets` view into each workspace, one
per project as well as the main one, plus the persona cascade and the shared
skills root.

**The ganglion mounts each workspace separately** — `workspace/`, and one bind
per `workspace-<id>` — and nothing above them.

The reason is that the ganglion has no `restrict_to_workspace`, and could not
usefully have one. Its only filesystem tool is `/bin/sh -c <string>`: there is no
path argument to refuse, and any denylist of `..` or `/etc` is defeated by
`$(echo L2V0Yw== | base64 -d)`. What confines it instead is a Landlock domain
around each command, whose only read-write hierarchy is the turn's workspace —
plus the container boundary itself. So **proxy-owned state has to be on the other
side of the boundary rather than merely adjacent to it.**

The first version of the ganglion path did use one wide bind, and the cost was
concrete: it put the container's own bearer token one level above the shell's
working directory, where `cat ../.crab-ganglion.json` read it.

The clearest illustration is `.schedules.json`. It is not a log — it is a
standing instruction to the proxy to wake a container and run a turn, on a timer,
forever. Inside a ganglion bind, a turn steered by untrusted text could write
one. For picoclaw a store inside the workspace is harmless, because the agent
writing it is the same process that would have to act on it. Here the agent and
the actor are different processes.

Two consequences follow from the per-workspace binds:

- **The bind set changes when the project set does**, and a bind set is fixed at
  container creation. So the proxy checks for drift on every ensure and recreates
  the container when the projects no longer match — otherwise a project created
  since the container started would be invisible inside it, and the turn would
  run against a directory the proxy never reads.
- **The administrator's shared skills are mounted into every workspace**, not
  only the main one, because the Landlock root is the turn's workspace. A skills
  index pointing at files a project turn cannot open is worse than no index.

## What a ganglion workspace contains

A ganglion workspace is seeded with `memory/`, `public/`, `sessions/` and
`windows/`. It is picoclaw's set minus what only picoclaw has, plus one of its
own:

- **no `cron/`** — the proxy holds the ganglion's schedules, above the bind;
- **no `.secrets/`** — credentials reach this harness as environment variables,
  not as files;
- **`windows/`** is the ganglion's own, holding each conversation's context
  window on disk. It has no picoclaw equivalent.

`USER.md` is seeded only if the workspace does not already have one. It is the
one persona file the agent writes back, so overwriting it on every ensure would
erase what the agent learned about the member every time the container was
recreated — which, for a scale-to-zero agent, is routinely.

Inside the container the data root is `/data/.ganglion`, and only its `workspace`
children are bound. The credential key file and the model registry land beside
that root, read-only, outside every workspace: the workspace is the only
hierarchy a command can reach, so a writable model list would let a tool steered
by untrusted text choose the endpoint the deployment's own keys are sent to.

## Where to go next

[Skills and memory](./13-skills-and-memory.md) covers what lives inside
`memory/` and `skills/`; [Files and delivery](./14-files-and-delivery.md) covers
`public/`. [Working with projects](./21-projects.md) is the member's view of the
sibling workspaces described here.
