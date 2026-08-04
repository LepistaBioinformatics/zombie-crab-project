# scheduled-tasks Tasks

Spans both submodules. Gates: in `crab/crab-shell-proxy` — `go build ./...` +
`go test ./...`; in `crab/crab-exoskeleton-webapp` — `yarn build` (Next
type-check) + `yarn test` (vitest). `[P]` = parallelizable.

Read-only throughout: **no task may write `jobs.json`** (DEC-ST-02), and **no task
may touch the `agent:cron-` skip at `internal/history/history.go:291`** (NFR-1).

---

## T01 — `CronFile` path helper — ST-1
- **What:** in `internal/config/config.go`, add
  `CronFile(root, tenantID, subsAccID, role, userAccID) string` →
  `filepath.Join(UserWorkspace(...), "workspace", "cron", "jobs.json")`, placed
  next to `SessionsDir` (`:497-502`) with a doc comment in the same voice.
- **Reuses:** `UserWorkspace` (`config.go:492`).
- **Done when:** `go build ./...` green.
- **Depends on:** —

## T02 — `internal/cron` store reader — ST-1, NFR-2, NFR-3 [P]
- **What:** new package with the `Job` / `Schedule` / `Payload` / `State` types from
  design.md and `Load(path) ([]Job, error)`. Missing file → `(nil, nil)`.
  `version != 1` → error naming the version found. Unknown `schedule.kind` /
  `payload.kind` keep their string and carry no parameter. `LastStatus` is a plain
  string — nothing in this package or its callers compares it to a literal.
  Expose **no writer**.
- **Done when:** table tests cover the three schedule kinds, an unknown schedule
  kind, an unknown `payload.kind`, unknown extra fields, `"jobs": []`, a missing
  file, and a bad `version`; `go test ./...` green.
- **Depends on:** —

## T03 — cron run discovery + transcript reader — ST-2, ST-4, NFR-1, NFR-5 [P]
- **What:** in `internal/history`, add `CronRuns(sessionsDir) ([]CronRun, error)`
  (scan `*.meta.json`, keep only `agent:cron-` keys, split `JobID` / `RunID`,
  carry `Basename`, `StartedAt`, `UpdatedAt`, `Count`, and `Prompt` read with a
  line scanner — first line only) and
  `ReadCronRun(sessionsDir, basename) ([]CronEntry, error)` (full transcript,
  **keeping** `role: "tool"` entries plus `ToolCalls`, `ModelName`, `CreatedAt`).
  A meta whose `.jsonl` is missing yields a row with an empty `Prompt` and a flag.
  Both carry a comment pointing at the `history.go:256-263` rationale and stating
  the `:291` skip stays.
- **Reuses:** `metaFile` (`history.go:31`), `cronSessionPrefix` (`:53`),
  `jsonlEntry` (`:56`).
- **Done when:** tests assert job/run id extraction from real key shapes, two runs
  of one job grouping under one id, a meta without its `.jsonl` still yielding a
  row, and `ReadCronRun` keeping `tool` entries and `tool_calls`. **Plus the
  regression:** cron metas still never reach `/v1/sessions/history` and
  `FindSessionFile` still resolves the user's own session when cron runs share its
  marker — extend the existing case at `history_test.go:251-296` so deleting the
  filter breaks a test that names why. `go test ./...` green.
- **Depends on:** —

## T04 — `/v1/cron/tasks` and `/v1/cron/runs` — ST-1, ST-2, ST-3, ST-4, NFR-4
- **What:** new `internal/httpapi/cron.go` with both handlers and the response DTOs
  from design.md, registered in `handlers.go` beside the other member `GET /v1/...`
  routes. Auth cloned from `restart.go` — required `tenant_id` / `subs_acc_id`
  query UUIDs, read access on tenant + resolved agent role + subscription,
  workspace key from the mycelium profile and **never** from the request. Join runs
  to tasks by job id; the remainder becomes `orphans` grouped by job id. Sort runs
  by `startedAt` desc, tie-broken by `runId`. The `run` parameter is looked up in
  the `CronRuns` set and rejected if absent — it never reaches `filepath.Join`.
- **Reuses:** `restartCallerKey` (`restart.go:138`) and `authorizeRestartRead`
  (`:162`) as the auth shape, `CronFile` (T01),
  `cron.Load` (T02), `CronRuns` / `ReadCronRun` (T03), `config.SessionsDir`.
- **Done when:** tests cover missing/invalid `tenant_id`/`subs_acc_id`, a `run` not
  in the discovered set, the task↔run join, the orphan grouping, an empty store
  with runs on disk (all orphans), and that the workspace key is not taken from the
  request. `go build ./... && go test ./...` green.
- **Depends on:** T01, T02, T03

## T04b — declare both routes in the mycelium gateway — ST-4b
- **What:** in `deploy/standalone/config.standalone.toml`,
  `deploy/prod/config.base.toml` and `deploy/dokploy/config.base.toml`, add one
  `[[<agent>.path]]` block per agent service (`alpha`, `beta`, and `hermes-glm`
  where present) for `path = "/v1/cron/*"`, `methods = ["GET"]`,
  `group = { protectedByRoles = [{ name = "<agent>" }] }`,
  `secretName = "<agent>-authorization-header"`, `acceptInsecureRouting = true`.
  Place it between the `/v1/restart` and `/v1/admin/*` blocks, matching the
  existing order. **One** wildcard block, not two: `*` covers exactly one following
  segment, which is both `tasks` and `runs`, and the proxy exposes no bare
  `/v1/cron` — a second block sharing a path would make the gateway answer
  "Multiple routes found".
- **Reuses:** the `/v1/restart` block as the gate shape (role name = read, which is
  the chain the cron handlers authorize with).
- **Done when:** every config still parses, and each agent service lists exactly one
  `/v1/cron/*` route. Without this the webapp gets
  `400 {"error":"Request path does not match any service"}` from the gateway and
  never reaches the proxy.
- **Depends on:** T04

## T05 — webapp client + BFF routes — ST-1, ST-4
- **What:** `lib/cronTasks.ts` with the DTO mirrors, `listTasks(workspace)` and
  `readRun(workspace, basename)`; BFF passthroughs at
  `app/api/cron/tasks/route.ts` and `app/api/cron/runs/route.ts` forwarding the
  session token and the tenant/subs/role params.
- **Reuses:** `workspaceQuery` + `get<T>` (`lib/memoryGraph.ts:111-127`), the
  existing media/memory BFF routes as the passthrough template, `errorCode` /
  `errorText`.
- **Done when:** `yarn build` green; types match T04's DTOs field for field.
- **Depends on:** T04

## T06 — panel: task list — ST-6, ST-8, ST-10, NFR-6, NFR-7
- **What:** new `app/chat/scheduled-tasks-panel.tsx` rendering the task list:
  schedule in human form (`cron` → expression, `every` → interval, `at` → instant,
  unknown → raw kind), enabled state, last/next run, `lastStatus`/`lastError`
  verbatim when present, and a per-task expand revealing its executions (instant,
  duration, entry count — **no success mark**). Orphans as a trailing group
  labelled as removed tasks, named by the run's prompt. Load in a `useEffect` with
  `let cancelled` and deps on `workspace.t`, `workspace.s`, `workspace.r`. Styling
  via `cva` variants, not inline conditional `className`. No `active` prop.
- **Reuses:** `listTasks` (T05), the effect/error idiom from
  `memory-graph-panel.tsx:133-154`.
- **Done when:** `yarn build` green; renders against the live deployment's real
  state (empty store + 4 orphan runs across 3 job ids) without erroring.
- **Depends on:** T05

## T07 — panel: transcript view — ST-7
- **What:** `selectedRun` state switching the panel to the transcript, with a back
  row to the list. User/assistant content through the existing message markdown
  renderer; `tool` entries and assistant `tool_calls` collapsed by default behind a
  one-line summary (name + count), each individually expandable, expanded content
  scrolling in its own `overflow-x` container so the narrow column never overflows
  horizontally.
- **Reuses:** `readRun` (T05), the chat message markdown renderer.
- **Done when:** opening `agent_cron-e520b224e7714d16-5e055123-…` renders its 34
  entries with its 23 tool calls collapsed; `yarn build` green.
- **Depends on:** T06

## T08 — sidebar registration + i18n — ST-5, NFR-6 [P after T06]
- **What:** in `app/chat/uploads-sidebar.tsx`, add `"tasks"` to the `Section` union
  (`:149`) and `SECTION_ORDER` (`:151`), a `SECTIONS` entry (`:153-176`) with a
  lucide icon plus `label(t)` / `blurb(t)`, and the panel in the detail slot
  (`:700-707`). Add the keys to **both** the `en` and `pt` dicts of
  `lib/i18n/chat.ts`, keeping label and blurb under their separate sub-keys as the
  existing entries do.
- **Done when:** the row appears in the section menu and opens the panel;
  `yarn test` green (`parity.test.ts` passes); `yarn build` green.
- **Depends on:** T06

## T09 — reference a task or execution into the chat — ST-9
- **What:** add a `taskRef` slot to `chat-view.tsx` beside `replyTo` (`:132`),
  cleared by `enqueue` (`:408-416`) with the other slots; a third segment in
  `compose()` (`:386-392`) serializing one line —
  `[tarefa agendada: "<name>" (<jobId>) — <schedule>, última execução <instant>]`
  for a task, `[execução: "<name>" (<jobId>), run <runId>, <instant>]` for an
  execution, **never the transcript**. Add an `onReference` prop to
  `UploadsSidebar` (`:222-241`, its first outbound value), threaded to the panel,
  which gains the reference action on task and execution rows. Add the dismissible
  composer banner mirroring `:188-209` with the same auto-focus (`:157-159`) and a
  prop pair matching `replyTo` / `onCancelReply`.
- **Reuses:** the `replyTo` slot end to end; `buildQuote` (`:93-99`) as the
  serialization precedent.
- **Done when:** unit tests assert each marker serializes to one line, that a
  reference + text + attachment compose in a stable order, and that `enqueue`
  clears the slot. No change to `turn-store.ts` or `app/api/chat/[instance]`.
  `yarn build` + `yarn test` green.
- **Depends on:** T08

## T10 — states + panel render test — edges, NFR-6 [P after T08]
- **What:** empty (no tasks and no runs), loading, and error states, using stable
  error codes through `errorText`. A malformed store shows the error and renders no
  partial list. A missing `.jsonl` shows the run row with its transcript marked
  unavailable. Add the panel render test in the established style —
  `renderToStaticMarkup` under the `node` environment, driven through
  `initialSection="tasks"`, asserting against `chatCopy.en`.
- **Reuses:** `uploads-sidebar.track.test.tsx:26-44` as the template.
- **Done when:** `yarn test` + `yarn build` green.
- **Depends on:** T08

---

## Verification (feature-level)

- Proxy: `go build ./... && go test ./...`
- Webapp: `yarn build && yarn test`
- Runtime (UAT): log in via magic link → right sidebar → **Tasks**. Against this
  deployment this reaches the **empty state only**, and that is all it proves. Then
  reopen a conversation that owns cron tasks and confirm its own history still
  loads — the regression this feature must not reintroduce.
- **What UAT cannot reach here.** The live data tree has empty job stores *and* no
  cron session files (`find data -name 'agent_cron-*.meta.json'` as root returns
  nothing); the 4-run fixture lives in a saved snapshot at
  `/tmp/zombie-debugging/sessions`, and the agent containers are stopped. So the task
  row, the orphan group, the execution rows and the transcript view are covered by
  unit tests plus a verified run of the Go readers against that snapshot — never
  report a clean end-to-end UAT for them. Reaching them for real means starting the
  containers and asking the agent to schedule something.

## Progress (2026-08-03)

T01–T10 implemented, plus **T04b, which the original design missed entirely**: the
proxy endpoints were specified without registering them in the mycelium gateway, so
the first real request answered `400 {"error":"Request path does not match any
service"}` — the gateway rejected the path before the proxy was ever reached. Found
by the user at runtime, not by any gate here, because nothing in either submodule's
test suite exercises gateway routing. Fixed across all three deploy profiles (8
blocks: alpha/beta/hermes-glm in standalone and prod, alpha/beta in dokploy) and
written up as ST-4b so the next proxy route does not repeat it.

Gates: proxy `go build ./... && go vet ./...` clean,
`go test ./internal/...` green except **9 pre-existing** `internal/docker` failures
(`lchown … operation not permitted` — needs privileges, reproduced on a clean tree
with this work stashed, unrelated to this feature). Webapp `yarn build` clean,
`yarn test` 610 passed / 44 files (was 602 / 43).

The Go readers were additionally run against the **real** session data in the saved
snapshot at `/tmp/zombie-debugging/sessions`: 4 runs, 3 distinct job ids,
newest-first ordering, all four transcripts present, and run
`e520b224e7714d16-5e055123` yielding its 34 entries with 23 tool entries and 23 tool
calls. That is where the "8 web_search" figure was corrected — it came from the run's
own self-reported summary and disagrees with its transcript.

**That snapshot is not the live tree**, and the distinction matters for what can be
claimed: the live `data/` has empty job stores *and* no cron session files at all, so
the populated UI paths (task row, orphan group, execution rows, transcript view,
reference marker end to end) were never exercised in a browser. They rest on the unit
tests and on that reader run. Corrected here after the artifacts initially described
the snapshot's 4 runs as the live deployment's state.

Two deviations from the written design, both deliberate:

- **DEV-1 — `lib/proxyRead.ts` extracted.** `proxyGraphRead` hardcoded
  `/v1/memory-graph`, and its own comment records that the session/401/role-allowlist
  logic must not drift between copies. Rather than duplicate it for cron, the core
  moved to `lib/proxyRead.ts` and `proxyGraphRead` became a 3-line delegate. No
  call-site or behavior change; the 4 memory-graph routes are untouched.
- **DEV-2 — three i18n strings allowlisted, not translated.**
  `scheduledTasks.schedule.cron`, `.lastStatus` and `.toolCall` are identical in
  `en` and `pt` ("cron" and "status" are loanwords; the third is a bare
  interpolation of a tool's own name). `parity.test.ts` requires such strings to be
  listed in `SHARED` with a justification, which is the sanctioned mechanism.

## Follow-up round (2026-08-03), all from using the running app

Added after the first pass, spec'd as ST-6c and ST-6d:

- **Hide finished tasks** — a switch, defaulting to hidden. The predicate is
  `isFinished` in `lib/cronTasks.ts`, unit-tested, and deliberately narrow: a
  recurring task is never hidden even when disabled with no next run, because
  disabling is reversible and hiding it would read as deletion. Orphan groups go with
  the same switch. The control names how many rows are hidden, and an
  everything-filtered state says so instead of reusing the "no tasks yet" copy.
- **Cap executions at 3** with show-more/show-fewer, per group. Extracted `RunList`
  since both the task and the orphan paths render it. The cap slices from the FRONT
  because `CronRuns` serves newest-first — a test asserts that, and the fixture is
  built newest-first for the same reason.

Two gaps found by the user in the running app, both fixed and both now spec'd
(ST-6b, NFR-8):

- **No way to refresh.** The panel loaded once per visit, so a task the member had
  just asked the agent for only appeared after leaving and re-entering the section.
  Added a header refresh control mirroring the files tree's, with its own counter (a
  shared one would re-list the files tree on every task refresh). The reload
  deliberately keeps the open run and the expanded tasks, which is why resetting that
  navigation moved out of the load effect into its own workspace-change effect.
- **An unlabelled icon button.** The per-task "reference in chat" control is
  icon-only and had `aria-label` but no `title`, so it gave a sighted member no
  tooltip at all. Both reference controls now carry both.

Not covered by tests, stated rather than glossed:

- `compose()`'s segment ORDER (quote → task ref → prose → attachment refs) is a
  closure over component state and is not unit-testable without restructuring
  `ChatView`. `buildTaskRef` is exported and tested directly, including that each
  marker stays one bracketed line; the ordering itself rests on the build.
- `scheduleText` likewise closes over the dict and the instant formatter.
  `humanDuration`, the only branching logic it delegates to, is exported and has four
  assertions covering all its branches.
- **The live-task row cannot be verified this way.** No job record exists on disk
  (both stores are empty; the jobs were `deleteAfterRun`) and the agent containers
  are stopped. Verifying schedule rendering, enabled state and `lastStatus` on a
  real task means starting the containers and asking the agent to create one.
  Otherwise that path rests on T02's and T06's unit tests — say so in the report
  rather than reporting a clean UAT.
