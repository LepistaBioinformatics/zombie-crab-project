# ganglion-projects — Specification

**Status:** Draft
**Size:** Complex — **three slices, each shippable alone**
**Repos touched:** `crab-ganglion-harness`, `crab-shell-proxy`, `crab-exoskeleton-webapp`

| Slice | What | Depends on |
|---|---|---|
| **A — scoped workspace** | A ganglion turn runs inside a project: its own files, transcripts, window and `MEMORY.md` | nothing |
| **B — scheduled tasks** | Per-project schedules, with the clock in the **proxy** | A |
| **C — the memory graph** | An MCP client in the harness, reaching the proxy's existing graph server | A |

Slice A alone closes DF-3 and turns three `501`s into working routes. B closes
DF-5 and fixes a defect picoclaw structurally cannot fix. C closes DF-1 and DF-2.

---

## Problem

The request was for "projects with memory, a graph, scheduled tasks and separate
files in an exclusive workspace, like picoclaw — but use a different mechanism if
one is needed."

Two corrections to the premise, both verified at source, and both in the
requester's favour:

**1. picoclaw has no projects.** A search of v0.3.1 for `project` as a type,
field, config key or tool returns nothing but OAuth `project_id`. Its scoping
units are *agents* — one workspace directory each, resolved by
`resolveAgentWorkspace` (`pkg/agent/instance.go:365-377`) — and a `SessionScope`
over channel/account/dimensions. **Projects are ours.** They live in
`crab-shell-proxy/.specs/features/agent-projects/`, are built on picoclaw's
`agents.list` plus a glob-matching patch to `agents.dispatch`, and are already
shipped for picoclaw.

**2. picoclaw has no knowledge graph either.** `grep -i 'knowledge.?graph'` over
the tree returns zero. `pkg/seahorse` is a hierarchical **conversation-summary**
DAG over SQLite with `short_grep`/`short_expand` — no entities, no relations. The
graph is also ours: a proxy-hosted MCP server at `/v1/mcp` with fifteen tools
(`crab-shell-proxy/.specs/features/memory-graph-mcp/`), injected into each
picoclaw workspace as `tools.mcp.servers.memory`.

So the ask is not "port a picoclaw feature". It is **give the ganglion harness
what our own proxy already offers picoclaw**, which is exactly the DF-1/DF-2/DF-3/
DF-5 row of `.specs/features/crab-ganglion-harness/spec.md`. Today
`internal/httpapi/harness_gate.go` lists `featureProjects` and
`featureMemoryGraph` as `picoclawOnly`, so a ganglion agent gets a `501` naming
the harness — which is honest, and is the thing to remove.

**And the invitation to use a different mechanism has two concrete targets.**

---

## The two places picoclaw's mechanism is the wrong one to copy

**T-1 — picoclaw's cron is one store per container, and cannot be per project.**
`pkg/gateway/gateway.go:843` builds the store path from `cfg.WorkspacePath()` —
the **default** workspace, not the routed agent's — so every project's schedule
lands in one `cron/jobs.json`. This is already recorded as defect **B1** in
`agent-projects-scope-fixes`, with the root cause confirmed and marked
unfixable from our side. A fired job also runs in a throwaway session
(`agent:cron-<jobid>-<uuid>`), so it never joins the member's conversation.

**T-2 — the ganglion runs `scale-to-zero`, so a clock inside it does not tick.**
`crab-shell-proxy/config.yaml:126` sets `mode: "scale-to-zero"` for the `gamma`
agent with a 15s idle timeout, and the comment there says exactly why: it is *the
point* of the ganglion. A scheduler inside the harness would be asleep whenever it
had work. This is the same wall `ganglion-evolution` hit, where
`cmd/crab-ganglion/main.go` turns `cold_path_trigger: scheduled` under
`scale-to-zero` into a boot refusal rather than a silent no-op.

Both point the same way: **slice B puts the clock in the proxy**, which is awake,
owns the container lifecycle, and can wake a stopped container to deliver a turn.
That is the different mechanism the request invited, and it makes per-project
schedules possible for the first time in this stack.

---

## Grounding in the harness (verified — do not re-derive)

- The workspace is `filepath.Join(cfg.DataDir, "workspace")`
  (`cmd/crab-ganglion/main.go:98`), and the `workspace` segment is mandatory
  because the proxy reads transcripts there. Under it: `sessions/` (`main.go:110`),
  `windows/` (`main.go:118`), `skills/`, `state/evolution/`, `media/`, `.tmp/`.
- **The stores are keyed by `ConversationID` alone** (`jsonl.go:46`,
  `window.go:27`). `domain.SessionKey` is carried through `Turn` and reaches the
  `Learner` and the `Approver` but **keys nothing on disk**. There is no per-scope
  directory concept today.
- Scope arrives in headers the proxy sets, and `httpsse.go:205` states the rule:
  *"The harness never derives them: the proxy owns the preimage, and computing it
  twice is how two components silently disagree."*
- The Landlock rule set is computed from **one** workspace root
  (`exec/sandbox.go:38`).
- The container mounts **one** bind, the workspace (`ganglionWorkspaceBind`), and
  proxy-owned state is deliberately kept *above* it so the shell tool cannot read
  it.
- `go.mod` has **zero** requires.

---

## Decisions

**D-1 — A project is a subdirectory of the existing workspace, not a new bind.**

picoclaw's projects are one bind per project, and creating or deleting one
**recreates the container** (`agent-projects` FR-10). Ganglion uses
`workspace/projects/<id>/` under the bind it already has. Consequences, all of
them intended:

- No new mount, so **no container recreate** on project create or delete. For a
  `scale-to-zero` agent whose container may not even exist, "recreate to add a
  project" is a strange thing to have to do.
- `SandboxRules` still computes from one root, so the sandbox needs no change.
- **The cost, stated plainly: this is not a kernel boundary.** Landlock grants the
  whole workspace tree, so the shell tool inside project A can `cd
  ../b` and read project B. Isolation between projects is a harness-enforced
  convention — the same kind of confinement `loadimage.go` documents when it says
  `resolve()` *is* the whole boundary — not a container or LSM guarantee. It
  separates a member's own work from their own other work. It is **not** a
  security boundary and must not be described to a member as one.

**D-2 — The project is a header. The harness never derives it.**

`X-Ganglion-Project`, set by the proxy, following `httpsse.go:205` verbatim. The
proxy's picoclaw path already encodes the project into the session id as
`p.<id>.<key>` (`agent-projects` FR-8), and the harness deliberately does **not**
parse that: it is picoclaw's routing convention, it would make the harness depend
on a string format owned elsewhere, and two components deriving the same thing is
the failure `httpsse.go` names.

**D-3 — An unknown project is refused, never silently degraded to the main
workspace.** Same rule as the proxy's FR-8a, for the same reason: writing a
member's conversation into the wrong workspace is worse than an error.

**D-4 — Memory is a file, and ganglion has none today.**

picoclaw's memory is plain Markdown — `<workspace>/memory/MEMORY.md` plus daily
notes — injected into the prompt and edited with the ordinary file tools. There is
**no memory tool**. Ganglion gets the same: `MEMORY.md` at the project root,
appended to the system prompt by `skills.Prompt`, edited by the `shell` tool the
agent already has. No new tool, no new store, and a file the member can read.

Worth naming: this is the **first memory the ganglion harness has ever had**. Its
only persistence today is the transcript and the window.

**D-5 — The graph is reached, not rebuilt.**

The proxy already hosts the graph and its fifteen tools over MCP streamable HTTP.
Slice C gives the harness a minimal MCP client — `initialize`, `tools/list`,
`tools/call` over JSON-RPC — and registers the server's tools into the tool
registry. Hand-written, because `go.mod` has zero requires and adding the MCP SDK
to reach three methods would be the largest dependency decision in the project's
history taken as a side effect of a memory feature.

---

## Requirements — Slice A: the scoped workspace

### Harness

**FR-A1** — `domain.Turn` gains `Project string`. Empty means the main workspace
and today's behaviour, unchanged.

**FR-A2** — The ingress reads `X-Ganglion-Project`, falling back to a `project`
field on the JSON body, mirroring how `sessionID` already works.

**FR-A3** — A project id is validated on arrival against
`^[a-z0-9][a-z0-9_-]{0,63}$`, the same alphabet the proxy generates
(`agent-projects` FR-5a). A value failing it is refused with 400. The id becomes a
path segment, so this is the only thing standing between a header and a traversal.

**FR-A4** — Layout, for project `<id>`:

```
workspace/
  sessions/                     # unchanged: the main workspace
  windows/
  projects/<id>/
    sessions/
    windows/
    files/                      # the member-visible working directory
    media/
    MEMORY.md
```

**FR-A5** — `jsonl.Store` and `window.Store` resolve their path from
`(project, conversationID)` rather than from `conversationID` alone. A turn with
no project reads and writes exactly the paths it does today — asserted
byte-for-byte, because this is the change that could silently orphan every
existing transcript.

**FR-A6** — `projects` is a reserved name in the main workspace. A conversation id
cannot produce a path under it, and `filepath.Clean` on the resolved path must
still be inside the intended root or the store refuses.

**FR-A7** — The system prompt for a project turn is the persona and skills as
today, plus the project's `MEMORY.md` when it is non-empty, plus the project
instructions the proxy seeds (FR-A11). Order: persona, project instructions,
memory, skills index — persona first, as `skills.Prompt` already guarantees.

**FR-A8** — `MEMORY.md` is read per turn through the same TTL cache
`skills.Prompt` already uses, so a turn does not re-read the disk per iteration
and an edit the agent makes is visible on the next turn.

**FR-A9** — The `shell` tool's working directory for a project turn is
`projects/<id>/files`. The Landlock domain is unchanged and still grants the whole
workspace (D-1).

**FR-A10** — `generate_image` writes to `projects/<id>/media` and `load_image`
resolves against `projects/<id>` for a project turn. The two must agree, as they
already do for the main workspace.

### Proxy

**FR-A11** — On every ensure for a **ganglion** workspace, the proxy creates
`workspace/projects/<id>/{sessions,windows,files,media}` for each project in
`.projects.json` and writes the project's instructions where FR-A7 reads them.
This mirrors `composeProjectAgentMD` and is fully derived from the store, so an
edit the agent makes to that file is reverted on the next ensure — the same
tradeoff, documented in the same place.

**FR-A12** — The chat path sends `X-Ganglion-Project` when the request names a
project, and sends nothing when it does not.

**FR-A13** — The history reader resolves a ganglion project transcript at
`workspace/projects/<id>/sessions/<conversation>.jsonl`.

**FR-A14** — `featureProjects` gains a `alsoServedBy` row for
`config.HarnessGanglion`. The row is added rather than the `picoclawOnly` entry
being deleted, so a fourth harness is still refused by default — the reason that
table is structured that way.

**FR-A15** — Creating or deleting a project for a ganglion agent **must not**
recreate or restart the container (D-1). `ganglionBindDrift` must not see a
difference, because there is none.

### Webapp

**FR-A16** — In the same change as FR-A14, `app/admin/agent-scope.ts` is checked
and, if a projects section exists there, adjusted. This is not optional diligence:
the last two gate changes — `persona`, then `model` — **both** leaked a tab to the
legacy all-agents store, and both were caught by the same test after the fact. The
question to answer explicitly is whether the section is withheld for a *harness*
reason (`PICOCLAW_ONLY`) or an *address* reason (`LEGACY_TABS`), and to state it
where it applies.

**FR-A17** — The project selector already exists for picoclaw agents and is not
harness-gated in the UI; the work is verifying it, not building it.

---

## Requirements — Slice B: scheduled tasks, with the clock in the proxy

**FR-B1** — Schedules are stored **by the proxy**, per project, at
`<user data dir>/.schedules.json` — beside `.projects.json`, above `workspace/`,
and therefore unreachable by the agent. One file per (tenant, subscription, agent,
user), with each record naming its project (or none, for the main workspace).

**FR-B2** — The record shape is picoclaw's, verbatim, so the existing read-only
`/v1/cron/*` surface and the webapp Tasks panel keep working unchanged:
`{id, name, enabled, schedule{kind, expr|everyMs|atMs, tz}, payload{kind, message,
channel, to}, state{nextRunAtMs, lastRunAtMs, lastStatus, lastError}, createdAtMs,
updatedAtMs, deleteAfterRun}`, in an envelope `{version, jobs[]}`. One field is
added: `project`.

**FR-B3** — The proxy runs one scheduler. On a due job it **ensures the container
is running** — waking a `scale-to-zero` agent — and delivers the job's message as
an ordinary turn on the job's project.

**FR-B4** — A fired job **delivers to nobody**. Its run is stored and read from
the Tasks panel, exactly as a picoclaw run is today. *(Owner's decision,
2026-09-10: "a tarefa não responde a ninguém. Elas ficam salvas e posso
visualizar na sidebar igual no picoclaw.")*

This is smaller than what this spec first proposed and it is better, because the
whole read surface already exists and is harness-blind:
`history.CronRuns(sessionsDir)` discovers runs, `history.ReadCronRun` serves one
transcript, `/v1/cron/runs` exposes both, and the webapp's Tasks panel renders
them. Nothing on that path needs to change.

**FR-B5** — A run is written where that reader already looks. The proxy runs the
turn with the conversation id `agent:cron-<jobID>-<runID>` — picoclaw's own
shape, so `splitCronKey` reads it unchanged — and the harness writes
`<sessionsDir>/<basename>.jsonl` as it does for any conversation.

**FR-B5a** — The **proxy** writes the run's `<basename>.meta.json`, because it
is the only participant that knows the job, the run and the originating scope,
and because the ganglion has no concept of a scheduled turn at all. This is the
one piece of the reader's contract the harness does not already satisfy: it
writes transcripts, never metas.

**FR-B5b** — A run belongs to its project's sessions directory, so a project's
schedules are listed under that project and the main workspace's under none. This
is the part picoclaw structurally cannot do (T-1).

**FR-B6** — `lastStatus` and `lastError` are written on every run. The webapp's
Tasks panel already renders them and `agent-projects-scope-fixes` records that
their possible values were never observed; the proxy writing them makes them
knowable.

**FR-B7** — The write routes (`POST`/`PATCH`/`DELETE` on `/v1/cron/tasks`) are
new. Reading stays as it is. Permissions match the surrounding surface: read
requires `read`, mutation requires `write`.

**FR-B8** — This slice is **ganglion-only in v1**. picoclaw keeps its own in-container
cron, because moving it would mean two schedulers racing over one `jobs.json`.
The spec records that unifying them later is the obvious follow-up and that B1
would be fixed for picoclaw too by the same code.

**FR-B9** — A schedule that fires while a turn is already running is **queued,
not dropped and not interleaved**. A run has its own conversation id (FR-B5), so
it cannot corrupt a member's window — but two turns at once in one container
share a workspace, and the ganglion's own single-flight is per conversation.

---

## Requirements — Slice C: the memory graph

**FR-C1** — A minimal MCP client in the harness: `initialize`, `tools/list`,
`tools/call` over JSON-RPC 2.0 on streamable HTTP `POST`, plus `DELETE` to close
the session. Hand-written, stdlib only (D-5). It handles both a JSON response body
and an SSE-framed one, because the transport permits either.

**FR-C2** — Configuration is read from `tools.mcp.servers.<name>` in the same
`config.json` the harness already reads — picoclaw's exact shape, `command: ""`
included, so the proxy's existing writer serves both harnesses:

```json
"tools": { "mcp": { "enabled": true, "servers": { "memory": {
  "enabled": true, "command": "", "type": "http",
  "url": "http://crab-shell-proxy:8080/v1/mcp",
  "headers": { "Authorization": "Bearer <token>" } } } } }
```

**FR-C3** — Only `type: "http"` is supported. A `command`-based (stdio) server is
**refused at boot naming the server**, not ignored: the ganglion container has no
package manager and no way to run one, and a silently absent memory is the failure
mode this whole gate table exists to prevent.

**FR-C4** — Tools discovered from the server are registered into the tool registry
under their own names, with the server's own schemas. The harness does not
re-declare the fifteen graph tools; a change on the server side reaches the agent
without a harness release.

**FR-C5** — A tool name collision with a built-in tool is refused at boot naming
both. Silently shadowing `shell` from a remote server is not a thing that should
be possible.

**FR-C6** — An MCP call that fails returns a `domain.Result` describing the
failure. It never fails the turn, and it never fails boot after boot succeeded —
if the graph is unreachable mid-turn the agent is told and carries on.

**FR-C6a** — The graph is scoped per member and spans that member's projects
(OQ-1). No tool parameter names a project, and the bearer's payload is unchanged,
so a ganglion container reaches exactly the graph a picoclaw container in the
same workspace would.

**FR-C7** — The proxy's per-workspace MCP writer runs for ganglion workspaces too,
writing the block into the ganglion `config.json` via `ganglionConfigDoc`. The
bearer token is minted exactly as it is for picoclaw, from the same secret, so no
new credential path exists.

**FR-C8** — `featureMemoryGraph` gains an `alsoServedBy` row for ganglion, under
the same rule as FR-A14, and FR-A16's webapp check applies again.

---

## Non-functional

**NFR-1** — A ganglion agent with **zero** projects behaves byte-identically to
today: same paths, same files, same requests. This is the regression bar.

**NFR-2** — Zero new dependencies in the harness. `go.mod` stays at zero requires,
FR-C1 included.

**NFR-3** — No slice requires a container recreate. A ganglion agent under
`scale-to-zero` may have no container at all when a project is created.

**NFR-4** — The isolation claim is accurate everywhere it appears. D-1 is a
convention, and no requirement, API description or UI string may call it
containment.

**NFR-5** — `go test -race ./...` clean; the four CI steps unchanged.

---

## Acceptance criteria

**AC-A1** — A turn with no project writes exactly the paths it writes today, with
the same bytes. A mutation that changes the unscoped path makes this fail.

**AC-A2** — A turn with `X-Ganglion-Project: demo` writes its transcript to
`workspace/projects/demo/sessions/`, and the main `workspace/sessions/` is
untouched.

**AC-A3** — `X-Ganglion-Project: ../../etc` is refused with 400 and creates no
directory (FR-A3, FR-A6).

**AC-A4** — A project turn's system prompt contains the project's `MEMORY.md`
content and the project instructions; the same agent's non-project turn contains
neither.

**AC-A5** — Two projects' transcripts do not mix: a conversation id used in both
yields two files and two independent histories.

**AC-A6** — `GET /v1/sessions/history?project=demo` against a ganglion agent
returns the project transcript, and the unscoped call does not (matching the
picoclaw AC-5 it mirrors).

**AC-A7** — Creating a project on a ganglion agent does not restart the container
(FR-A15) and does not 501 (FR-A14).

**AC-A8** — `agentTabs` for a ganglion agent and for the legacy all-agents entry
are both asserted after FR-A14, by the test that caught `persona` and `model`.

**AC-B1** — A job due now on a **stopped** ganglion container starts it and
delivers the turn (FR-B3). This is the acceptance criterion the whole slice
exists for.

**AC-B2** — Two projects each with a schedule produce two jobs whose runs write
into their own project's transcript — the case picoclaw structurally cannot serve.

**AC-B3** — A fired job's run appears in `GET /v1/cron/runs` and its transcript
is served by the existing run endpoint, with **no** new conversation in
`GET /v1/sessions/history` (FR-B4, FR-B5). The second half is the assertion that
discriminates: a run that also created a conversation would still pass a test
that only checked the panel.

**AC-B4** — A job that fires while a member's turn is running on the same
project runs **after** it, and neither window is corrupted (FR-B9).

**AC-C1** — With the MCP block present, `tools/list` results appear in the tool
schemas the model sees, and a `tools/call` round-trips against a fake MCP server.

**AC-C2** — A `command`-based server entry fails boot with a message naming the
server and the reason (FR-C3). A mutation that ignores it instead makes this fail.

**AC-C3** — A server offering a tool named `shell` fails boot naming both
(FR-C5).

**AC-C4** — An MCP server that returns 500 mid-turn produces a tool result the
model can read, and the turn completes (FR-C6).

**AC-C5** — The same `.security`-style bearer written for a picoclaw workspace
authenticates a ganglion workspace's MCP calls, from the same secret (FR-C7).

---

## Out of scope

- **Per-project model or skill overrides.** The proxy's own `agent-projects`
  deferred both; the registry cascade has the levels, and a project would become a
  fifth.
- **Sharing a project between members.** A project belongs to one
  `(tenant, subscription, agent, user)` tuple, like the workspace it lives in.
- **Cross-project delegation.** `ganglion-subagents` leaves this out for the same
  isolation reason the proxy leaves `subagents.allow_agents` unset.
- **Moving picoclaw's cron into the proxy.** FR-B8.
- **A kernel-level boundary between projects.** D-1, NFR-4. Doing it properly
  means a Landlock root per project, which means the sandbox is rebuilt per turn
  rather than at boot — a real option, and a separate feature with its own
  measurements.

---

## Open questions

**OQ-1 — RESOLVED. The graph matches picoclaw's scope.** *(Owner, 2026-09-10:
"igual no picoclaw, global ou por projeto.")*

picoclaw's graph — which is ours, hosted by the proxy — is scoped per MEMBER:
the MCP bearer's payload is `tenantID/subsAccID/role/userAccID` and carries no
project dimension. So matching picoclaw means **per member, spanning a member's
projects**, and slice C needs no change to a security-critical path that
`memory-graph-mcp` FR-4.2 specified carefully and that both harnesses share.

**The assumption this records, so it can be corrected rather than discovered:**
"global or per project" is read as naming the two shapes rather than requesting
both now, with picoclaw's behaviour as the anchor. Per-project is therefore
**deliberately additive**: it is one more field in the token payload, with its
own injectivity argument, and slice C is built so that adding it later changes
the payload and nothing else. If the intent was to offer the member the choice in
v1, that is a small extension of C and not a redesign of it.

**OQ-2 — RESOLVED, and it made slice B smaller.** See FR-B4. A fired job
delivers to nobody; its run is stored and read from the Tasks panel, which
already exists end to end. The three conversation-delivery shapes this section
used to weigh are all withdrawn.

**OQ-3 — Does the member see project files anywhere?**

The webapp has a workspace/Files panel for picoclaw. FR-A4 puts a project's
working files in `projects/<id>/files`, and whether that panel is pointed at it is
a webapp question this spec does not answer. Named so it is not discovered as a
gap after slice A ships.
