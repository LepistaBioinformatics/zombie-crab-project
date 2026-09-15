# Skills and memory

Two things let an agent be more than a model with a chat box: **skills**, which
are procedures it can look up, and **memory**, which is what it keeps between
conversations. This chapter explains both, where they live on disk, and which
copy wins when two of them have the same name.

## What a skill is

A skill is a directory containing a file called `SKILL.md`. The file opens with a
small frontmatter block naming it and describing when to use it:

```markdown
---
name: quarterly-report
description: Build the quarterly sales report from the shared CSV exports. Use when the user asks for a quarterly report or for sales numbers by quarter.
---

# Quarterly report

1. Read the latest export from `workspace/.shared/subscription/`...
```

Only `name` and `description` are read. The format is picoclaw's, unchanged, so a
skill written for one harness loads in the other — the ganglion says so in its
own `internal/skillfile` package, which exists precisely to keep one definition
of the format for the code that reads skills and the code that writes them.

A skill's name must match `^[a-z0-9][a-z0-9._-]{0,63}$` when an administrator
uploads one, and `shared-content` is reserved — it is the name of a skill the
platform itself ships.

## The two roots, and which one wins

Inside a workspace there are two places a skill can live:

```text
<workspace>/skills/<name>/SKILL.md          yours, writable
<workspace>/shared-skills/<name>/SKILL.md   the administrator's, read-only
```

`skills/` belongs to the agent. It is where a skill the agent wrote for itself
lands, and where an operator-approved evolution pass writes its drafts.

`shared-skills/` is a read-only bind mount the proxy creates from what
administrators published. Read-only at the *mount*, which is a kernel guarantee
the agent cannot argue with: Landlock only ever narrows access, so it can never
grant a write into a read-only bind.

> The two paths above are what a ganglion workspace looks like, and they are what
> the shipped `skill-creator` skill tells the agent. Both harnesses are served
> from the same merged directory on the host, so one administrator action reaches
> both; picoclaw mounts it at its own skills root rather than inside the
> workspace, because that is where picoclaw looks.

**A name present in both resolves to the administrator's copy**, and the shadowed
workspace copy is logged so an operator can see which one won. The rule is stated
in the ganglion's skill loader and again, in plain words, in the `skill-creator`
skill the agent itself reads. The other way round would let an agent overwrite an
administrator's instruction by writing a file with the same name — a privilege
escalation dressed up as a merge rule.

> There is a second, separate merge that happens before any of this. An
> administrator can publish skills at four scopes, and the proxy flattens them
> into the single read-only directory it mounts: tenant, then tenant-for-this-
> agent, then subscription, then subscription-for-this-agent, with the later
> source winning by name. That cascade decides what `shared-skills/` *contains*;
> the rule above decides what happens when its contents collide with the agent's
> own.

## Only the index reaches the prompt

This is the part that changes how you write a skill.

Every turn is given an **index** of the available skills — one line each, name
and description and the path to the body — and nothing more. The bodies stay on
disk, and the agent reads the one it needs with its shell tool, which already
reaches the workspace. In the ganglion the index is bounded at 8 KiB by default,
roughly two thousand tokens: enough for a few dozen skills at a sentence each,
small enough that the index never competes with the conversation for room.

Two consequences follow, and they are the whole craft of writing one:

- **The description is the skill.** It is the only part that decides whether the
  body is ever opened. Write it as the situation it answers, not as a title. "Use
  when the user asks for a file exported or sent" finds its moment; "File
  utilities" does not.
- **The body can be long, and costs nothing until it is read.** Do not compress a
  procedure into hints to save room. Room is not what you are saving.

Putting every body into every turn's prompt would spend the context window on
instructions for work this turn is not doing, which is how a skill library stops
being an asset and becomes a tax.

## What ships in the box

The proxy embeds a small set of operator-managed documents in its own binary and
bind-mounts them **read-only** into every workspace it creates. The agent can
neither edit them nor keep an edit past a restart.

Three of them are skills:

| Skill | What it covers | Where it ships |
|---|---|---|
| `shared-content` | Where administrator-published files and secrets live, the rule never to copy a secret elsewhere, and where to write a file the member can download. | both harnesses |
| `skill-creator` | How to write, revise or review a `SKILL.md` for this workspace. | both harnesses |
| `ganglion-workspace` | The one writable tree, what the shell can and cannot reach, and which commands the Alpine image actually has. | ganglion only |

`ganglion-workspace` is the only harness-specific entry, and the gating is the
same principle the 501 gate uses one level up: a document describing this
container's shell, its image and its layout is a description of the *wrong
machine* for the other harness, and an agent acting on a capability it was told
about rather than one it has is exactly the failure to avoid. It stands in for
picoclaw's own bundled workspace skill, which a ganglion agent never gets because
a ganglion agent is provisioned with no template at all.

> The two shipped skills overlap slightly and disagree in one place on purpose.
> `shared-content` describes a `.secrets/` directory; a ganglion workspace has
> none, because credentials reach that harness as environment variables. The
> `ganglion-workspace` skill says so in its own words and tells the agent to read
> the environment instead. It is an acknowledged divergence, not a bug.

## Memory

An agent's memory in this stack is files in `workspace/memory/`, plus an optional
graph. They are not interchangeable, and the difference is which one the member
can see.

### The memory files

**`memory/MEMORY.md`** is the agent's own notebook — what it has learned, and
what it writes to.

**`memory/MEMORY_CUSTOM.md`** is the **member's** file. It holds their standing
notes for the agent: preferences, context, instructions they want kept in mind.
The member edits it directly from the chat client's Workspace panel, at any time,
between turns. The proxy writes it on their behalf, through a kernel-confined
handle so a swapped path component fails the syscall rather than redirecting a
root-owned write. An absent file is an empty document, not an error.

Because the member can change it between any two turns, the shipped
`shared-content` skill tells the agent to re-read the current file whenever it is
relevant rather than trusting what it remembers of it.

Three more files in `memory/` are the operator's, mounted read-only:

- **`CONTEXT_RECOVERY.md`** tells the agent that its live context can be reset
  when the container restarts — idle scale-down, a settings change, a redeploy —
  and that the complete history is preserved for it in
  `workspace/sessions/durable/<session-key>.jsonl`, an append-only file that only
  ever grows. If the agent seems to be missing earlier messages, it is instructed
  to read that file back rather than guess.
- **`FILE_DELIVERY.md`** is the rule about where a produced file goes. See
  [Files and delivery](./14-files-and-delivery.md).
- **`MEMORY_ROUTING.md`** says which memory to write to, and is mounted **only
  when the memory graph is enabled**. With no graph the agent has no
  `mcp_memory_*` tools at all, and a document telling it to prefer them would be
  actively wrong — worse than silent.

These are memory files rather than skills for a reason worth understanding.
Skills are loaded by relevance: the agent has to decide to go looking for one, so
a rule that must apply on *every* turn would only be found at the moment it was
least needed. The memory directory is read every turn.

### The memory graph

When it is enabled, the agent also has a knowledge graph: entities, observations
about them, and named relations between them. It is the memory the member can
browse, search and audit from the chat client, and it is the only one that
records which conversation a fact came from.

It is served by the proxy itself. The proxy writes an MCP server block named
`memory` into the workspace's `config.json`, pointing at its own `/v1/mcp` route
with a bearer token that carries the workspace scope plus an HMAC over it — so
the proxy stores no tokens, and rotating the signing secret revokes every issued
token at once. The ganglion has an MCP client of its own and reaches the same
graph a picoclaw container in the same workspace would.

The graph is scoped to the **member** and spans their projects, rather than being
a separate graph per project.

The tools the agent gets are all prefixed `mcp_memory_`:
`mcp_memory_create_entities`, `mcp_memory_add_observations`,
`mcp_memory_create_relations`, `mcp_memory_search_nodes`,
`mcp_memory_semantic_search`, `mcp_memory_read_graph` and
`mcp_memory_open_nodes`. `MEMORY_ROUTING.md` gives the agent three rules
about using them, each of which came from watching it get them wrong: search
before you create, because creating ignores a name that already exists and two
spellings produce two entities no single query reunites; create the relation too,
because an entity with no relations is a point nothing leads to; and keep
`entityType` consistent, because the member filters the list by it.

**Enabling it is one environment variable**, `CRAB_MCP_TOKEN_SECRET`, and
**leaving it unset is supported**: the `/v1/mcp` route is not registered at all,
no MCP block is written into any workspace, and everything else behaves as
before. That is deliberate — a deployment that forgot the secret must get no
memory rather than an unauthenticated endpoint reachable by every container on
the network.

> Facts go in the graph; the agent's own working notes go in `MEMORY.md`. The
> routing document also forbids the agent from claiming a save it did not make,
> which was written after it was observed appending to `MEMORY.md` and then
> telling the member it had written to the graph as well.

## Where to go next

[Files and delivery](./14-files-and-delivery.md) for `public/`, the other
member-visible directory in a workspace, and the [Admin
guide](./30-admin-guide.md) for publishing shared skills and files at a scope.
