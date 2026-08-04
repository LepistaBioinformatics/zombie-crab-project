# scheduled-tasks — Specification

## Summary

A **Tasks** panel in the chat's right sidebar that lists the agent's scheduled
tasks (picoclaw cron jobs) together with their past executions, and renders any
execution's full transcript. Read-only. The panel also lets the user **reference**
a task or a specific execution into the chat composer, so they can ask the agent
about it in the conversation.

Registered as one more row in the right sidebar's section menu, alongside
Memory / Graph / Files — the same "click a row, see what you need to see" idiom
that surface already uses.

The feature spans both submodules: `crab-shell-proxy` gains the read endpoints
(none exist today), `crab-exoskeleton-webapp` gains the panel and the composer
slot.

## Grounding (verified in source and against live data — do not re-derive)

Scheduled tasks are a **picoclaw** feature. The proxy neither models nor exposes
them today: none of the ~60 routes in `internal/httpapi/handlers.go:273-385`
mentions cron, task, or schedule, and no Go code reads the `cron` key the proxy
seeds into each workspace's template config
(`internal/docker/defaulttemplate/picoclaw/config.json:346-351`).

**The job store is host-readable JSON.** `<UserWorkspace>/workspace/cron/jobs.json`,
mode `0600 root:root`. The whole `UserWorkspace` is bind-mounted into the agent
container (`internal/docker/manager.go:455`), so the proxy reads the file directly
from the data root — exactly as `internal/history` already reads session
transcripts. **No `docker exec`, no running container required.** Verified against
the live deployment at
`data/tenants/<t>/subscriptions/<s>/agents/<agent>/users/<u>/workspace/cron/jobs.json`.

Record shape, obtained empirically from `sipeed/picoclaw:latest` (the image
`internal/config/config.go:370` defaults to) by creating jobs and dumping the
store — not recalled, not inferred:

```json
{ "version": 1, "jobs": [{
  "id": "9abd3e01bd0a082a",
  "name": "Daily summary",
  "enabled": true,
  "schedule": { "kind": "cron",  "expr": "0 18 * * *" },
  "payload": { "kind": "agent_turn", "message": "Summarize logs",
               "channel": "pico", "to": "pico:<chatId>" },
  "state": { "nextRunAtMs": 1785780000000 },
  "createdAtMs": 1785766614402,
  "updatedAtMs": 1785766614402,
  "deleteAfterRun": false }]}
```

- `schedule.kind` ∈ `cron` (`expr`) | `every` (`everyMs`) | `at` (`atMs`). The
  first two were produced and observed; `at` is the `at_seconds` one-shot kind,
  present in the binary's field set but with no CLI flag today
  (`…/skills/picoclaw-agent/SKILL.md:149-150`).
- `state` field set, extracted from the binary: `nextRunAtMs`, `lastRunAtMs`,
  `lastStatus`, `lastError`. Only `nextRunAtMs` was observed populated (no run
  happened in the probe), so **`lastStatus` values are unknown** — see NFR-2.
- `payload.channel`/`payload.to` appear only when delivery flags are passed.
  `payload.kind` was only ever observed as `agent_turn`; the template config also
  carries `allow_command`, so other kinds may exist — see NFR-3.
- Job ids are 16 hex chars.

**Execution results live in the session transcripts.** Each cron *run* gets its
own session file pair in `<UserWorkspace>/workspace/sessions`
(`internal/config/config.go:499` `SessionsDir`), named
`agent_cron-<jobId>-<runUUID>.{jsonl,meta.json}` with key
`agent:cron-<jobId>-<runUUID>` (`internal/history/history.go:53`). Verified against
4 real runs across 3 distinct job ids. **The first hex segment is the job id** —
two runs of the same daily job share `e520b224e7714d16` — which is what makes
"tasks and their results" a single joined view.

The `.meta.json` carries `created_at`, `updated_at` (run start / last write) and
`count` (number of transcript entries). Cron metas have an empty `summary` and
carry the alias `agent:main:direct:cron`, where a user session carries
`agent:main:direct:pico-user`. Both stamp the **originating chat's**
`scope.values.chat`.

**The existing history endpoint deliberately excludes them.**
`findSessionFiles` skips any meta whose key has the `agent:cron-` prefix
(`internal/history/history.go:291`). The comment at `:256-263` records the bug it
fixed: `agent_cron-…` sorts before `sk_v1_…` in `os.ReadDir` order, so any
conversation owning a cron task resolved to a cron transcript and the user's real
one was never read. **This filter is load-bearing and must not be removed,
parameterized, or unified with the new read path.** See NFR-1.

**One-shot jobs vanish from the store after running** (`deleteAfterRun`).
Confirmed by the user's own session summary: *"ela rodou por volta das 21:02 e foi
removida automaticamente"*, for a job id that still has a run transcript on disk.
So run transcripts outlive their job records and **orphan runs are a normal
state**, not a defect.

**Reading a transcript needs a new reader.** `history.readMessages` (`:311`) keeps
only plain conversational turns, dropping entries with role `tool` (`:318`); this
panel shows tool activity.

**The chat payload is plain text only.** `turn-store.ts:364-369` posts
`{message, session_id, tenant_id, subs_acc_id}`, and
`app/api/chat/[instance]/route.ts:19-26` validates exactly those. There is no
attachments or context array. The established mechanism is a *context slot* on
`ChatView` that `compose()` serializes into the text — `chat-view.tsx:386-392`
already does this for attachments (`[anexo: <path>]`) and replies
(`buildQuote`, `:93-99`, truncated at 280 chars). `replyTo` (`:132`, set from the
message action row at `:521`, rendered as a dismissible banner at
`composer.tsx:188-209`) is the precedent for a sibling component pushing a
structured reference in. **A reference feature therefore needs no backend change.**

**The right sidebar's section registry** is `app/chat/uploads-sidebar.tsx`:
the `Section` union (`:149`), `SECTION_ORDER` (`:151`), the `SECTIONS` record of
`{Icon, label(t), blurb(t)}` (`:153-176`), and the detail-slot dispatch
(`:700-707`), navigated by a sliding two-pane track (`:186-199`). `initialSection`
(`:231-240`) is the test seam. The `active` prop passed to `MemoryGraphPanel`
(`:704`) is dead — it is always `true` inside its own mount guard.

**Data fetching has no SWR / react-query** (`package.json:17-29`): a thin client
wrapper per domain in `lib/`, `workspaceQuery` + `get<T>` helpers
(`lib/memoryGraph.ts:111-127`), errors thrown as stable codes translated by
`errorText`, and `useEffect` + `let cancelled` with deps on the primitives
`workspace.t/.s/.r` — never the `workspace` object, which `ChatShell` rebuilds
every render (`memory-graph-panel.tsx:151-154`).

**Auth pattern to clone**: `internal/httpapi/restart.go` — `tenant_id` and
`subs_acc_id` as query UUIDs, the caller's workspace key derived from the mycelium
profile and never from the request (`restartCallerKey`, `:138`), and the read
authorization itself (`authorizeRestartRead`, `:162`).

## Functional requirements

- **ST-1** The proxy exposes `GET /v1/cron/tasks?tenant_id=&subs_acc_id=`,
  returning the caller's own workspace's scheduled tasks read from
  `jobs.json`: id, name, enabled, schedule (kind + its parameter), the payload's
  message and delivery target, `deleteAfterRun`, and the `state` timestamps.
  A missing store file is an **empty list, not an error** — a workspace whose
  agent never had a task has no `cron/` directory.
- **ST-2** The same response includes, per task, the list of its **executions**,
  discovered by scanning `SessionsDir` for `agent_cron-<jobId>-<runUUID>` metas
  and grouping by the job-id segment. Each execution carries its run id, start
  (`created_at`), last write (`updated_at`), entry count, and the run's prompt
  (the transcript's first entry).
- **ST-3** Executions whose job id is absent from `jobs.json` are returned in a
  separate **orphan** grouping, keyed by job id and labelled as a removed task.
  Their display name comes from the run's prompt, since no job record survives.
- **ST-4** The proxy exposes `GET /v1/cron/runs?tenant_id=&subs_acc_id=&run=<basename>`,
  returning one execution's full transcript **including** `role: "tool"` entries
  and each assistant entry's `tool_calls` and `model_name`.
- **ST-4b** Both routes are declared in the **mycelium gateway config**, once per
  agent service, in every deploy profile. A proxy route the gateway does not know
  answers `400 {"error":"Request path does not match any service"}` — the webapp
  never reaches the proxy at all. The gateway matches by path with a `*` that covers
  exactly one following segment, so one `/v1/cron/*` block serves both endpoints;
  the gate is the role NAME (read), matching `/v1/restart`, because the proxy
  authorizes these with its read chain, and `methods` is `["GET"]` only.
- **ST-5** The right sidebar gains a **Tasks** section: a row in the section menu
  (icon + label + blurb) that opens the panel, following the existing registry
  and slide-track navigation.
- **ST-6** The panel lists tasks with their schedule in human form (cron
  expression, `every N`, or a one-shot instant), enabled state, last and next run
  instants, and `lastStatus`/`lastError` when the store carries them. Each task
  expands to its executions.
- **ST-6b** The panel header carries a **refresh** control, mirroring the files
  tree's, because the agent schedules tasks between visits and a member who just
  asked for one must be able to pick it up without leaving the panel. It re-reads the
  list only: the open execution and the expanded tasks survive, since a refresh means
  "look again", not "start over". Its counter is separate from the files tree's, so
  refreshing one does not re-list the other.
- **ST-6c** Tasks that have already run and will not run again are **hidden by
  default**, behind a switch the member can turn off. "Will not run again" requires
  all three of: no `nextRunAtMs`, at least one run on record, and a one-shot-shaped
  schedule (`deleteAfterRun` or the `at` kind). A **recurring** task is never hidden,
  even disabled — disabling is reversible and picoclaw may simply not have recomputed
  the next instant, so hiding it would read as deletion. Orphan groups are finished by
  definition and are hidden by the same switch. The control always states how many
  rows are out of sight, and when everything is filtered the panel says so rather than
  claiming the workspace has no tasks.
- **ST-6d** A task shows only its **3 most recent** executions, with a
  show-more/show-fewer toggle naming how many older ones remain. A daily task
  accumulates one run per day indefinitely; the cap is per group, so expanding one
  long history leaves the others alone.
- **ST-7** Selecting an execution renders its transcript inside the panel, with
  its own back affordance to the task list. User and assistant content render as
  markdown through the existing message renderer; `tool` entries and assistant
  `tool_calls` render **collapsed by default**, expandable individually.
- **ST-8** Each execution row shows its start instant, duration
  (`created_at`→`updated_at`) and entry count. It shows **no success/failure
  mark** — that signal is not recorded per run (see NFR-2). The `lastStatus` /
  `lastError` from the store are shown on the **task**, where they belong.
- **ST-9** The panel offers a **reference in chat** action on a task and on an
  execution. It sets a reference slot on `ChatView`, shown as a dismissible
  banner in the composer, and `compose()` serializes it into the outgoing message
  text as a self-contained marker:
  - task → `[tarefa agendada: "<name>" (<jobId>) — <schedule>, última execução <instant>]`
  - execution → `[execução: "<name>" (<jobId>), run <runId>, <instant>]`

  The transcript itself is **never** inlined. The reference carries enough for the
  agent to answer without a lookup, plus the ids it needs to dig further — it owns
  the store and the transcripts on its own filesystem, and its `picoclaw-agent`
  skill documents `picoclaw cron list`.
- **ST-10** The panel is **workspace-scoped**, like Memory / Graph / Files — it is
  not filtered by the active conversation. A chat filter would hide tasks that
  deliver elsewhere, and orphan runs have no surviving chat link at all. Where a
  task declares a delivery target, the panel shows it.

## Non-functional requirements

- **NFR-1** The `agent:cron-` skip in `findSessionFiles`
  (`internal/history/history.go:291`) stays exactly as it is. The new cron reader
  is a **separate exported function** in the same package, carrying a comment that
  names the bug the filter fixed, so a future editor does not unify the two paths.
  A regression test asserts cron sessions still never reach
  `/v1/sessions/history`.
- **NFR-2** Nothing displayed is inferred. Per-run success is not recorded
  anywhere, so it is not shown. `lastStatus` is treated as an **opaque string,
  displayed verbatim** — no value was ever observed, so no code branches on one.
- **NFR-3** The store parser tolerates unknown fields and unobserved enum values
  (any `schedule.kind`, any `payload.kind`) by degrading to a readable rendering
  rather than failing the whole list. A `version` other than `1` is an explicit
  error, not an optimistic parse.
- **NFR-4** The `run` parameter of ST-4 is validated against the set of
  discovered run basenames. Request input is never joined into a filesystem path.
- **NFR-5** The list endpoint reads only metas and each transcript's **first
  line**; full transcripts (observed up to 112 KB) are read only by ST-4, on
  demand.
- **NFR-6** Panel i18n lands in both the `en` and `pt` dicts of
  `lib/i18n/chat.ts` (`parity.test.ts` enforces parity). Effects follow the
  `let cancelled` + primitive-deps idiom.
- **NFR-7** The panel lives in its own component file, like `memory-editor` and
  `memory-graph-panel` — not inline in `uploads-sidebar.tsx` the way `files` is.
- **NFR-8** Every icon-only control carries a `title` as well as an `aria-label`. The
  `aria-label` serves a screen reader; without the `title` a sighted member gets no
  tooltip and has to guess what the icon does.

## Communicating it

- **ST-12** The landing page carries a section for the feature (`landing.scheduled`,
  index 08, between templates and files), and the READMEs describe it under "In the
  chat client". Both are bounded by the same three facts the panel is bounded by, and
  `components/landing/landing-accuracy.test.ts` asserts them against the copy in both
  locales: the panel never offers to create or manage a task, it says scheduling
  happens by asking the agent, and it never claims to report whether a run succeeded.
  The figure omits any success tick for the same reason.
- **ST-12b** Not documented in `docs/`. `ADMIN_GUIDE.md` covers admin surfaces and
  scheduled tasks are not admin-managed; a member guide does not exist and inventing
  one is a separate decision.

## Out of scope

- **Any write to `jobs.json`** — creating, editing, enabling, disabling or
  removing a task. Deferred deliberately: the picoclaw gateway holds its schedule
  in memory, and whether it reloads an externally edited store is **unverified**.
  If it does not, a UI toggle would lie until the container restarts, which drags
  in the proxy's restart-notice machinery. Creating and changing tasks stays with
  the agent, which already does it. A v2 must verify reload behavior first.
- Admin-scoped views of other users' tasks. This is the member surface only.
- Un-filtering cron sessions from the conversation history (NFR-1).
- Any change to how picoclaw schedules or executes jobs.

## Edge cases

- No `cron/` directory or no `jobs.json` → empty list, no error (ST-1).
- `jobs.json` with `"jobs": []` but run transcripts on disk → all runs are orphans
  (ST-3). Observed in the live deployment: both agents' stores are empty while 4
  run transcripts exist.
- A run's `.jsonl` missing while its `.meta.json` exists (or the reverse) → the
  run is listed from whichever side exists, with the missing part reported as
  unavailable rather than dropping the row silently.
- A task never run → no executions, `lastRunAtMs` absent; only `nextRunAtMs` shows.
- A disabled task → listed, visually distinct, `nextRunAtMs` may be stale.
- Two runs of one job started in the same minute → distinct `runUUID`, so distinct
  rows; ordering falls back to the run id when instants tie.
- A transcript ending mid-tool-call (process died) → rendered as-is; no completion
  claim either way (NFR-2).
- Very long tool results in a narrow, resizable column → collapsed by default,
  and expanded content scrolls within its own container.

## Requirement traceability

| Req | Where |
|---|---|
| ST-1 | `internal/config` path helper, `internal/cron` store reader, `internal/httpapi/cron.go` |
| ST-2 | `internal/history` cron-run discovery, joined in the list handler |
| ST-3 | same, orphan grouping |
| ST-4 | `internal/history` cron transcript reader, `internal/httpapi/cron.go` |
| ST-4b | `deploy/{standalone,prod,dokploy}` gateway configs, one block per agent |
| ST-5 | `app/chat/uploads-sidebar.tsx` registry, `lib/i18n/chat.ts` |
| ST-6 | `app/chat/scheduled-tasks-panel.tsx`, `lib/cronTasks.ts`, `app/api/cron/tasks` |
| ST-7 | `app/chat/scheduled-tasks-panel.tsx`, `app/api/cron/runs` |
| ST-8 | `app/chat/scheduled-tasks-panel.tsx` |
| ST-9 | `app/chat/chat-view.tsx` (slot + `compose`), `app/chat/composer.tsx` (banner), `uploads-sidebar.tsx` (`onReference` prop) |
| ST-10 | `app/chat/scheduled-tasks-panel.tsx` |

## Success criteria

- The panel lists a workspace's real state without erroring and without inventing a
  task record. The reference fixture is the saved snapshot at
  `/tmp/zombie-debugging/sessions`: **4 runs across 3 job ids**, all of them orphans
  (no job record survives), newest first.
- Opening the run `agent_cron-e520b224e7714d16-5e055123-…` from that snapshot
  renders its 34 entries — 23 of them `tool` entries — with its 23 tool calls
  collapsed (11 `web_search`, 8 `web_fetch`, and one each of `write_file`,
  `read_file`, `edit_file`, `message`). Counted from the transcript, not from the
  run's own summary, which claims 8 searches and is wrong.
- Referencing that run inserts a banner in the composer and puts a single
  self-contained marker line in the sent message; the transcript is not inlined.
- A conversation that owns cron tasks still loads its own history correctly —
  the regression this feature must not reintroduce.
- Gates green: `go test ./...` in the proxy, `yarn build` + `yarn test` in the
  webapp.

**Limit of the runtime check, stated so nobody mistakes it for coverage.** The live
data tree is currently *empty of both halves*:

- both agents' job stores are `{"version":1,"jobs":[]}` — the jobs that produced the
  known run transcripts were `deleteAfterRun`;
- and a root-privileged `find data -name 'agent_cron-*.meta.json'` returns **nothing**,
  so there are no cron session files under `data/` either. The 4 runs used as the
  fixture live in a saved snapshot at `/tmp/zombie-debugging/sessions`, not in the
  live tree.

The agent containers are also stopped. So a runtime pass against this deployment
exercises **only the empty state**. The live-task row (schedule rendering, enabled
state, next/last run, `lastStatus`), the orphan group, the execution rows and the
whole transcript view are covered by unit tests plus a verified run of the Go
readers against the snapshot — not by UAT. Exercising them for real means starting
the containers and asking the agent to schedule something.
