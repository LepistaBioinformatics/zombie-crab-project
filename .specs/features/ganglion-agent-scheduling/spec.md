# ganglion-agent-scheduling — Specification

**Status:** Draft
**Size:** Large (proxy MCP tools + store fields + bounds; harness skill; webapp panel; docs)
**Depends on:** `ganglion-approval-endpoint`. The owner sequenced this behind it
deliberately, and the dependency is not administrative — see finding 5.

---

## Problem

**Nobody can create a scheduled task on the ganglion.** Not the agent, and not the
member.

The agent cannot because the store is above its bind and the write route needs
credentials no container holds. That is deliberate, and stated as intent rather
than left to geometry (`httpapi/cron_write.go:11-13`):

> The member is the author here, not the agent. The store is above the workspace
> bind, so nothing inside the container can reach it: a turn steered by untrusted
> text cannot schedule its own future turns.

The member cannot because no surface exists: every `/v1/cron/*` block in every
deploy profile declares `methods = ["GET"]`, the BFF exports only `GET`, and the
Tasks panel has no create control. The book says so in a table — *"Nothing a
member touches creates one yet"* (`docs/book/src/22-scheduled-tasks.md:93-97`) —
and calls it "the honest state of things".

So the write half of the cron API, shipped and ganglion-only, has no caller. Its
own 501 message for picoclaw reads *"its agent creates them itself"*, which
describes picoclaw's model, not this one.

## Goal

A ganglion agent can create, list and remove its own scheduled tasks, asking the
member's permission each time it creates one, under bounds that exist because
nothing bounds this today.

## Key findings (verified, not assumed)

1. **The capability already exists on the proxy.** `POST`, `PATCH` and `DELETE
   /v1/cron/tasks` are registered (`httpapi/handlers.go:381-383`), ganglion-only
   (`cron_write.go:60-65`), and validated (`cron/owned.go:170-200`). Nothing in
   this feature needs a new scheduler, a new store or a new file format.

2. **The container cannot call those routes, and should not be made able to.**
   They require `x-mycelium-service-name`, `Bearer <agent.ResolvedToken>` and
   `x-mycelium-profile`. `ResolvedToken` is never written into any container file
   — its only uses are the config declaration, the config assignment and the
   comparison (`httpapi/handlers.go:584`). Handing one to a container would not
   open "scheduling": the profile header is **decoded, never verified**
   (`config/config.go:355-359`), so an agent token is the gate on *chatting as any
   member of any tenant*.

3. **Writes originated in a container already have a shipped path, and it is
   MCP.** `/v1/mcp` is reached with a stateless HMAC token carrying
   `tenant/subs/role/user[/project]` (`mcptoken/token.go:115-144`), verified before
   the payload is interpreted (`:82-113`). **No tool takes a scope parameter** —
   the token is the only way a scope enters the package
   (`mcpserver/server.go:161-164`), so a caller cannot name another member's
   workspace. The memory graph writes through exactly this; the "no write route"
   comment at `handlers.go:392-393` is about the REST surface being read-only
   *because* MCP is the write path, not about container writes being forbidden.

4. **Reachability was never the gate.** `ganglion-agent-confinement/spec.md:104-106`:
   *"The agent can reach the proxy over the network. Both harnesses join
   `m.cfg.Network`. Reachability is not authorization."* Landlock here is
   filesystem-only — `HandledAccessNet` is declared and never assigned
   (`landlock.go:83-87,170`). An agent can already `curl` the cron route today and
   gets 401.

5. **Approval makes the harm shape unreachable, without a quota doing it.** The
   loop asks the approver synchronously, emits a heartbeat while waiting, and
   **denies on timeout** (`runtime/loop.go:882-921`, DEC-4). The harm this whole
   boundary was built against is *unobserved persistence* — a turn talked into
   something buying re-entry that survives the conversation, runs unattended for up
   to 30 minutes, and can wake its own stopped container
   (`config/config.go:781-785`, `cron_scheduler.go:6-11,50-54`). An unattended turn
   has no member watching, so an approval request from one goes unanswered and the
   deadline refuses it. **The dangerous case fails closed by construction; the
   legitimate one — the member asked, in the conversation — approves naturally.**

6. **The store records nothing about who wrote a task**, and the write path assumes
   the member did: *"Trusted verbatim from the member, refused only for shape"*
   (`cron_write.go:103-105`). An agent-authored task would today be
   indistinguishable from a member's in the store, in `GET /v1/cron/tasks`, and in
   the panel.

7. **There are no bounds to inherit.** No per-workspace task cap — the create
   appends unconditionally and nothing counts `len(jobs)` (`cron_write.go:133-135`).
   No rate limit anywhere in the proxy except `probeLimiter`, which governs model
   connectivity probes. No constraint on what a scheduled prompt may contain. The
   only lifecycle-aware bound is `MinEveryMs = 60000`, and its reasoning transfers
   directly (`cron/owned.go:24-31`): *"every fire may COLD-START a container that
   scale-to-zero has stopped, so a ten-second interval is a request to keep an
   agent permanently warm by the back door."*

8. **The agent is currently told the opposite, in a file the proxy ships into its
   container.** `docker/managed/skills/ganglion-workspace/SKILL.md:40-41`:
   *"There is no `cron/` either: your scheduled work is held outside this tree,
   where you cannot reach it."* Implementing this means rewriting what the agent is
   taught about itself.

9. **A skill's description reaches the model at every turn.** A `SKILL.md` under
   the admin root or `<workspace>/skills` is rendered into the system prompt as one
   bullet — name, description, path — with the header telling the agent the line is
   only a summary and to read the file (`adapter/skills/skills.go:172-220`). Three
   constraints: the description must be **one physical line** (the parser is
   `strings.Cut` per line, not YAML), the index shares an **8 KiB budget** and
   evicts the oldest skill by mtime when over, and the admin's copy wins a name
   collision.

## Non-goals

| Excluded | Reason |
|---|---|
| A member-facing create form | A different product decision, not this one. It needs all five gateway blocks to stop being `GET`-only, a BFF write path, a form, and the read-only prose and its enforcing test undone. Worth doing; not folded in here. |
| Changing FR-B4 | The owner kept it: a fired task delivers to nobody, and the panel is where a member reads what happened. Agent-created tasks behave the same as any other. |
| Letting the agent edit a task's schedule or message | Create and remove only. An edit is how a benign task becomes something else without a second approval. |
| Reaching `.schedules.json` from inside the container | The store stays above the bind. This feature adds a scoped API call, not a mount. |
| picoclaw | Its agent already schedules its own jobs through its own CLI, into a store inside its workspace. Nothing here changes that. |
| A content filter on the scheduled prompt | Named as a bound that does not exist, and deliberately not added: a filter on natural language is a promise that cannot be kept. Approval is the control. |

## Requirements

### FR-1 — The tools

1. The proxy's existing MCP server SHALL offer three tools: create a scheduled
   task, list this workspace's scheduled tasks, and remove one by id.
2. **No tool SHALL take a tenant, subscription, role, user or project parameter.**
   The scope comes from the token, as it does for every existing tool there
   (finding 3). A project is narrowed by the `X-Ganglion-Project` header the server
   already honours, never by an argument.
3. The create tool's parameters SHALL mirror the write route's body — schedule
   kind, its one parameter, an optional timezone, the message, an optional name,
   and delete-after-run — and SHALL be validated by the same `cron.Validate` the
   member-facing route uses. **One validator, not two.**
4. A second MCP server SHALL NOT be added. An unreachable MCP server fails the
   container's boot (`cmd/crab-ganglion/main.go:180-187`), and a second hard boot
   dependency would take a member's ordinary conversation down with it.

### FR-2 — Approval on create

1. The create tool SHALL be gated: its name SHALL be added to the container's
   `GANGLION_GATED_TOOLS`, so `Loop.runTool` asks before invoking.
2. A refusal SHALL reach the model as the ordinary denial `Result`, which the agent
   can relay to the member — not as a turn failure (DEC-2).
3. WHEN no approver endpoint is configured THEN the container SHALL refuse to boot,
   naming the variable — the posture AD-025 D-2 established for `evolution.apply`,
   for the same reason: a gate with no enforcer is a sentence that changes nothing.
4. List and remove SHALL NOT be gated. Reading one's own schedule grants nothing,
   and removing is the direction that reduces standing instructions.

### FR-3 — Provenance

1. The stored record SHALL carry who created the task: the member directly, or the
   agent with the approving member's account id.
2. `GET /v1/cron/tasks` SHALL report it, and the Tasks panel SHALL show it. A
   member looking at a task they did not type SHALL be able to tell.
3. Provenance SHALL be written by the proxy from what it established, never taken
   from a tool argument.
4. Records written before this feature SHALL read as member-authored, which is what
   they are.

### FR-4 — Bounds

All four exist because none exists today (finding 7).

1. **A per-workspace ceiling on the number of scheduled tasks.** Reaching it SHALL
   refuse the create with a message naming the ceiling, and SHALL apply to both
   authors — a cap only the agent feels would leave the same disk unbounded.
2. **A higher minimum interval for agent-created recurring tasks** than the
   member's 60 seconds. The existing floor exists to stop a schedule keeping a
   scaled-to-zero agent permanently warm; that argument is stronger when the agent
   is the one asking.
3. **A rate limit on creation**, per workspace. A turn can otherwise create tasks as
   fast as it can call the tool, and each one is a standing instruction.
4. A refusal from any bound SHALL be a `Result` the model reads and can explain,
   not an error.

### FR-5 — What the agent is told

1. A skill SHALL describe scheduling: what a scheduled task is, that it delivers to
   nobody and is read in the panel, that creating one asks the member, and the
   bounds it will be refused by.
2. Its `description` SHALL be **one physical line** and SHALL be written to make the
   agent open the file, not to carry the instructions (finding 9).
3. It SHALL ship from the admin skills root, so it survives a container recreate
   and cannot be shadowed by a workspace file of the same name.
4. `ganglion-workspace/SKILL.md:40-41` SHALL be corrected: the schedule is still
   outside the tree, and is now reachable through a tool. The current sentence would
   otherwise tell the agent it cannot do something it can.

### FR-6 — Documentation and the copy that contradicts this

1. `docs/book/src/22-scheduled-tasks.md` SHALL be rewritten where it says a ganglion
   task cannot come into being, that asking the agent will not work, and that the
   store's unreachability means a turn cannot schedule its own future turns. That
   last one SHALL be replaced with what is actually true after this: the store is
   still unreachable, and creating a task requires a member's answer.
2. The paired `docs/book/po/pt-BR.po` entries SHALL be updated with it — a stale
   entry silently falls back to English in the published book.
3. The webapp's read-only copy SHALL be updated in **both** locales
   (`lib/i18n/chat.ts`, `scheduledTasks.hint`) and in `lib/cronTasks.ts`.
4. `components/landing/landing-accuracy.test.ts` asserts the landing never offers
   to create a task from the interface. That assertion stays true — this feature
   adds no interface control — but the sentence *"scheduling happens by asking the
   agent"* becomes true for the ganglion for the first time, so the test's premises
   SHALL be re-read rather than assumed.

### NFR

1. **No new credential reaches the container.** The MCP token already exists,
   already carries the scope, and is already bound read-only outside the workspace.
2. **No mount changes.** `ganglionBinds` is untouched, and `ganglionBindDrift`
   keeps hunting the old wide bind.
3. **The validator is shared** with the member-facing route, so the two authors
   cannot drift apart.
4. **Go gate:** `gofmt`, `go vet`, `go test -race`, `go build`. Webapp gate:
   `yarn test` and `yarn build`.

## What this reverses, stated plainly

`cron_write.go:11-13` says the agent must not be able to schedule its own future
turns, because a turn steered by untrusted text could. That sentence is correct
about the risk and this feature does not pretend otherwise.

What changes is that the turn no longer decides alone. The store stays where it
is; the path is a scoped token to one endpoint; and the act of creating requires an
answer from the member, synchronously, inside a deadline that denies. The
injected-text case is the unattended case, and the unattended case has nobody to
answer it.

The sentence should be rewritten to say that, not deleted.
