# ganglion-subagents — Specification

**Status:** Draft
**Size:** Large (one harness; no proxy or webapp change in v1)
**Repos touched:** `crab-ganglion-harness`

---

## Problem

A ganglion turn is one model, one context, one thread. Everything the agent needs
to know has to fit in the window it already has, and everything it does happens in
sequence. There is no way to say "read these six documents and tell me what they
disagree about" without reading all six into one window, and no way to explore two
approaches without doing one after the other.

The request is for the harness to have **native, programmatic sub-agent dispatch**
— parallel and sequential — so the behaviour is predictable rather than emergent.

## Grounding (verified in picoclaw v0.3.1 source — do not re-derive)

picoclaw has four tools: `subagent{task,label}` (synchronous), `spawn{task,label,
agent_id}` (asynchronous), `spawn_status{task_id?}`, and `delegate{agent_id,task}`
(synchronous, to a named registry agent). A child is **not** a process or a
container: `spawnSubTurn` (`pkg/agent/subturn.go:269-515`) shallow-copies the
`AgentInstance`, swaps in an ephemeral in-memory session store capped at 50
messages, sets `NoHistory: true`, and calls the ordinary turn loop in a goroutine.
The child returns its **final assistant message only**.

**Three of those four are wired wrong, and this spec exists partly to not copy
them.** All three were confirmed at source level:

1. **`spawn_status` is dead.** `SubagentManager.tasks` is written only in
   `SubagentManager.Spawn`, and `grep -rn "\.Spawn(" --include='*.go' . | grep -v
   _test.go` returns **nothing** — no non-test caller. In the shipped wiring the
   tool always answers `"No subagents have been spawned yet."`
2. **`spawn`'s result never reaches the turn that spawned it.** `asyncCallback`
   (`pipeline_execute.go:515-553`) republishes the child's output as a **new
   inbound message** on channel `"system"`, sender `async:spawn` — a fresh turn.
   The `pendingResults` channel that would inject it into the running turn is
   `nil` at depth 0, because `newTurnState` sets neither `concurrencySem` nor
   `pendingResults`; `deliverSubTurnResult` therefore takes the `resultChan ==
   nil` branch and emits `agent.subturn.orphan`.
3. **The concurrency cap does not apply at the depth that matters.** `max_concurrent`
   (default 5) is enforced on `parentTS.concurrencySem`, which is nil at depth 0 —
   so **first-level sub-agents are uncapped**. The cap bites only from depth 1
   down. `max_depth` (default 3) does hold. Separately, `cfg.Tools` filtering is
   documented in `docs/architecture/subturn.md:252-261` and **never read** by
   `spawnSubTurn`.

Also: the child's context is `context.WithTimeout(context.Background(), …)`, so
**cancelling the parent does not cancel the child**.

**What that means for this spec.** "Compatible with picoclaw" is the standing
constraint for anything the webapp or the proxy manages — model records, search
providers, config keys. Sub-agent *tools* are managed by neither: they are names
in a schema the model sees, and nothing outside the harness reads them. So the
compatibility surface here is the **config keys**, which are adopted verbatim
(FR-14), and the tool shape is chosen for the property the request actually asked
for — *previsível*.

## Grounding (verified in the harness — do not re-derive)

- Tool calls are dispatched **strictly sequentially** (`loop.go:217`), and
  `compact`/`dropOrphanTools` enforce that every tool call is followed by its
  result. Making the loop itself concurrent would break that invariant.
- `domain.Sink` is a **struct of nil-able func fields** with no mutex, and the
  content/reasoning coalescers have no mutex either. CI runs `go test -race`.
  N children streaming into one parent sink is a race the gate would catch.
- The tool port is inward (`internal/adapter/tool/registry.go:18`); the outward
  port is `domain.ToolExecutor`. AR-4 forbids an adapter importing another
  adapter — and `internal/runtime` is not an adapter, so a tool importing the
  loop would pass the machine check while inverting the hexagon anyway.
- The tool set is fixed at boot (`cmd/crab-ganglion/main.go:264-279`).
- `MaxIterations` defaults to **12** and is the **only** bound on a turn. There is
  no token budget anywhere in the harness.

---

## Decisions

**D-1 — One tool, taking a batch, with an explicit mode.**

`subagents{mode, tasks[]}` replaces picoclaw's four. One tool call fans out
internally and returns **one** tool result, which is what keeps `loop.go:217`
sequential and the call↔result pairing intact. Parallelism inside one call is
also the only way to get it: the loop dispatches tool calls one after another, so
"the model emits four tool calls" would be four serial children.

A one-element `tasks` list is the synchronous single-child case, so nothing is
lost by not having a second tool.

**D-2 — Everything is synchronous. There is no `spawn_status`.**

The tool returns when the batch is done. This is the whole of "previsível": the
model reads the result in the same turn it asked for it, and a batch's outcome is
a function of the batch, not of when the model happens to poll. picoclaw's async
path is the one that leaks results into a different turn and the one whose status
tool is dead; neither is worth reproducing.

The cost is stated: a batch that takes four minutes holds the turn for four
minutes. FR-9's per-child timeout and FR-12's progress line are what make that
tolerable, and OQ-2 records the case this does not serve.

**D-3 — Children stream nothing. The dispatcher narrates, from one goroutine.**

Children run with a **silent sink**. The dispatcher owns a single collector that
emits one `ProgressThought` per child as it starts and finishes, serialised
through the dispatcher's own goroutine — so exactly one goroutine ever touches the
parent's sink, and `-race` stays green.

Interleaving four children's token streams into one transcript would be
unreadable anyway; what a member needs is to know the fan-out is alive.

**D-4 — A child's transcript is in memory and is never persisted.**

Children use in-memory transcript and window stores. Two reasons, and the second
is the load-bearing one: a child writing `<id>.jsonl` into `workspace/sessions/`
would make the proxy's history endpoint report conversations no member ever had;
and the child's *finding* is already persisted — it is inside the parent's tool
result, which is in the parent's transcript.

**D-5 — Parent cancellation cancels the children.**

The child context derives from the parent's. picoclaw deliberately does the
opposite (`context.Background()`), which is how it ends up with orphaned results
and `Critical: true` children outliving the turn that made them. A member who
stops a turn expects the work to stop.

**D-6 — The bounds are enforced at depth 0, and the worst case is arithmetic
somebody wrote down.**

See NFR-1. This is the direct answer to picoclaw defect 3.

---

## Requirements

### The dispatch port

**FR-1** — A new outward port, `domain.SubAgent`:

```go
// SubAgent runs one child turn to completion and returns what it concluded.
type SubAgent interface {
    Run(ctx context.Context, task SubTask) (SubReport, error)
}

type SubTask struct {
    Label   string
    Task    string
    Context string // findings handed down in sequential mode; empty in parallel
}

type SubReport struct {
    Label      string
    Answer     string
    Iterations int
    Usage      Usage
    Err        error
}
```

The tool holds this port; the implementation over `runtime.Loop` is constructed in
`cmd/crab-ganglion/main.go`, the composition root and the only place adapters
meet. The tool does **not** import `internal/runtime`.

**FR-2** — Depth travels in the context: `domain.WithDepth(ctx, n)` and
`domain.Depth(ctx) int`. `domain.Turn` is not widened, because depth is a property
of *how this turn was started*, not of the turn the ingress received. `context` is
stdlib, so AR-1 holds.

**FR-3** — The sink travels the same way: `domain.WithSink(ctx, Sink)` and
`domain.SinkFrom(ctx) Sink`, set by `Loop.runTool` before it invokes a tool. A
tool that does not ask for it is unaffected; `SinkFrom` on a context without one
returns the zero `Sink`, whose emit helpers are already nil-safe.

### The tool

**FR-4** — Tool name **`subagents`**. Schema:

```json
{ "type": "object",
  "properties": {
    "mode": { "type": "string", "enum": ["parallel", "sequential"],
              "description": "parallel: every task runs at once, independently. sequential: each task runs after the previous one and receives its findings." },
    "tasks": { "type": "array", "minItems": 1, "maxItems": 8,
      "items": { "type": "object",
        "properties": {
          "task":  { "type": "string", "description": "The complete instruction. The sub-agent sees NONE of this conversation, so say everything it needs." },
          "label": { "type": "string", "description": "Short name for this task, shown to the member and used to label the result." } },
        "required": ["task"] } } },
  "required": ["mode", "tasks"] }
```

**FR-5** — `mode: "parallel"` runs all tasks concurrently, bounded by
`max_concurrent` (FR-14). Each child's `SubTask.Context` is empty. Results are
returned **in the order the tasks were given**, never in completion order, so the
same batch produces the same result text twice.

**FR-6** — `mode: "sequential"` runs tasks in order, and each child after the
first receives the previous children's answers in `SubTask.Context`. This is what
makes the mode different from a serialised parallel batch, and it is the mode for
a plan whose later steps depend on earlier ones.

**FR-7** — In sequential mode a **failed or timed-out child stops the sequence**.
The result reports which step failed, and the remaining tasks are reported as not
run. A step that depends on a step that failed cannot produce a trustworthy
answer, and running it anyway is how a chain produces a confident wrong result.

**FR-8** — In parallel mode a failed child **does not fail the batch**. Its slot
reports the failure and the others report their answers.

**FR-9** — Each child has its own timeout (`default_timeout_minutes`, FR-14). A
child that exceeds it is cancelled and reported as timed out; in parallel mode the
batch continues.

**FR-10** — The result text is deterministic and labelled:

```
Ran 3 sub-agents (parallel).

[1] schema-drift — ok (4 steps)
<answer>

[2] migration-risk — ok (6 steps)
<answer>

[3] rollback-plan — FAILED: context deadline exceeded after 5m0s
```

Each answer is truncated at `max_answer_runes` (default 4000) **by rune, not by
byte** — picoclaw truncates `ForUser` with a byte slice on a UTF-8 string
(`subagent.go:436-439`) and can split a rune. Truncation is marked in the text.

**FR-11** — `Invoke` returns a `domain.Result` and **never** an error, including
when every child fails. This is the rule every tool in this harness follows.

**FR-12** — The dispatcher emits, through the sink obtained in FR-3 and from its
own single goroutine: one line when the batch starts naming the mode and count,
one line per child on completion naming its label and outcome. No child token ever
reaches the parent's sink (D-3).

### Bounds

**FR-13** — A child inherits: the system prompt (persona and skills), the
workspace, the model chain, and the tool set. A child does **not** inherit the
conversation window — it starts with its task and nothing else. `SubTask.Task` is
the whole of what it knows about why it exists, which is why FR-4's schema says so
in the description the model reads.

**FR-14** — Configuration, using picoclaw's key paths verbatim so a single
`config.json` serves both harnesses:

| Key | Default | Meaning |
|---|---|---|
| `tools.subagent.enabled` | `true` | Registers the tool at all |
| `agents.defaults.subturn.max_depth` | `1` | Depth at which a child may itself dispatch |
| `agents.defaults.subturn.max_concurrent` | `5` | Children running at once, **enforced at depth 0** |
| `agents.defaults.subturn.default_timeout_minutes` | `5` | Per child |
| `agents.defaults.subturn.max_child_iterations` | `6` | A child's `MaxIterations` |
| `agents.defaults.subturn.max_children_per_turn` | `16` | Whole-turn budget across the tree |

`max_depth` defaults to **1**, not picoclaw's 3: at depth 1 a child cannot
dispatch, which is what makes NFR-1's arithmetic small enough to state. Raising it
is allowed and its cost is documented there.

`max_concurrent` keeps picoclaw's default of 5, and — unlike picoclaw's — is
enforced at depth 0, where every real fan-out happens.

**FR-15** — When a child is at `max_depth`, the `subagents` tool is **absent from
its schema list**, not present-and-refusing. A tool the model can see and cannot
use costs a turn to discover.

**FR-16** — `max_children_per_turn` is a counter for the **whole turn across the
whole tree**, not per call. A call that would exceed it runs the children that fit
and reports the rest as not run, naming the budget. A model that calls `subagents`
on every one of its 12 iterations cannot start 96 children.

**FR-17** — Exhausting `max_concurrent` **queues**; it does not fail. picoclaw
returns `ErrConcurrencyTimeout` after 30s; a batch of 8 with a cap of 5 is an
ordinary request, not an error.

### research

**FR-18** — A tool named **`research`**, registered **only when `web_search` is
configured** (nil means absent, the `imagegen` precedent). Schema:

```json
{ "type": "object",
  "properties": {
    "question": { "type": "string" },
    "mode": { "type": "string", "enum": ["quick", "deep"],
              "description": "quick: search and read directly. deep: break the question into sub-questions, research each in parallel, and return the findings together." },
    "breadth": { "type": "integer", "minimum": 2, "maximum": 6,
                 "description": "Sub-questions in deep mode. Default 4." } },
  "required": ["question"] }
```

**FR-19** — `quick` runs one child with the question, `web_search` and
`web_fetch`, and a prompt that tells it to search, read the most promising
results, and report with URLs.

**FR-20** — `deep` runs three phases: one child decomposes the question into
`breadth` sub-questions; those are researched by a **parallel** batch; the
findings are returned to the **parent**, labelled and with their sources.

**FR-21** — The parent writes the answer. `research` returns findings, never
prose addressed to the member. The parent is the only participant that has the
conversation, and a synthesis written by a child that has never seen it will
answer a question nobody asked.

**FR-22** — Every finding carries the URLs it came from, and the result says so
in a line the model can quote. A research tool whose output cannot be checked is
worse than a search tool whose output can.

**FR-23** — `research` spends from the same `max_children_per_turn` budget as
`subagents`. It is a caller of the same dispatcher, not a second one.

---

## Non-functional

**NFR-1 — The worst case is stated, not discovered.** At the defaults, one turn
is bounded by: 12 parent completions + 16 children × 6 iterations = **108 model
calls**. Raising `max_depth` to picoclaw's 3 makes the tree three levels deep and
the bound is then `max_children_per_turn` × `max_child_iterations` per level —
which is why the default is 1 and why raising it belongs to an operator who has
read this line.

There is no token budget, because the harness has none to build on. That gap is
named here rather than half-solved: `max_children_per_turn` bounds *calls*, and a
call with a 200k window is not the same size as one with 2k.

**NFR-2** — `go test -race ./...` passes. This is not a formality: D-3 exists
because of it, and a test that runs a parallel batch under `-race` is the check.

**NFR-3** — Zero new dependencies. `go.mod` stays at zero requires.

**NFR-4** — With `tools.subagent.enabled: false` the harness behaves exactly as
today, and no code on the turn path is reached.

**NFR-5** — A child never writes to `workspace/sessions/` or `workspace/windows/`
(D-4). A proxy history call after a fan-out returns the same conversations it
would have returned without one.

---

## Acceptance criteria

**AC-1** — A parallel batch of three tasks against three fake providers produces
one tool result naming all three, **in task order**, and the same batch run twice
produces the same text.

**AC-2** — A parallel batch of three, where the second child's provider always
errors, still reports the first and third answers (FR-8).

**AC-3** — A sequential batch of three, where the second fails, reports step 2 as
failed and step 3 as **not run**, and the third child's provider is never called.
A mutation that continues the sequence makes this fail.

**AC-4** — In sequential mode, the second child's prompt **contains the first
child's answer**; in parallel mode it does not. This is the assertion that
discriminates the two modes — a test that only checks timing would pass for a
sequential implementation of both.

**AC-5** — A batch of 8 with `max_concurrent: 2` never has more than 2 children
running at once (asserted with a counter inside the fake provider), and all 8
complete (FR-17).

**AC-6** — A child at `max_depth` receives a tool schema list that does **not**
contain `subagents` (FR-15).

**AC-7** — With `max_children_per_turn: 3`, a call requesting 5 tasks runs 3 and
reports 2 as not run naming the budget; a second call in the same turn runs none.

**AC-8** — Cancelling the parent context mid-batch cancels the children: the fake
providers observe a cancelled context, and the tool returns a result rather than
an error (D-5, FR-11).

**AC-9** — After a batch, `workspace/sessions/` contains exactly the parent
conversation's file and nothing else (NFR-5).

**AC-10** — `go test -race` on a test that runs a 6-way parallel batch while the
parent sink records emissions is clean, and the recorded emissions contain one
line per child (D-3, FR-12).

**AC-11** — An answer containing multi-byte characters truncated at the limit ends
on a rune boundary and is valid UTF-8 (FR-10).

**AC-12** — With no web provider configured, `research` is absent from the tool
schemas while `subagents` is present (FR-18).

**AC-13** — `research{mode:"deep",breadth:3}` produces one decomposition child, 3
research children, and **no** synthesis child; the tool result contains the three
findings and their URLs (FR-20, FR-21, FR-22).

---

## Out of scope

- **Asynchronous dispatch and a status tool.** D-2. The case it would serve is
  OQ-2.
- **Cross-agent delegation** (picoclaw's `delegate`, `subagents.allow_agents`).
  A ganglion container runs one agent; there is no registry of others to delegate
  to. If `ganglion-projects` gives a container more than one project scope, that
  is the moment to revisit, and the proxy's `agent-projects` spec already
  deliberately leaves `subagents.allow_agents` unset for the same isolation
  reason.
- **A different model for children.** picoclaw's `subagents.model` exists;
  ganglion's children use the same chain. A cheaper model for fan-out work is an
  obvious next step and an easy one — it is left out so that v1 has one variable.
- **Per-child tool restriction.** picoclaw documents `cfg.Tools` and never reads
  it; implementing it correctly means deciding what a child may do to the
  workspace, which is a security question and not a scheduling one.
- **A token budget.** NFR-1.

---

## Open questions

**OQ-1 — Should a child be able to write to the workspace?** Today it inherits
the full tool set, which includes `shell`. Two children writing the same file
concurrently is a data race the harness cannot see, and the Landlock domain will
not stop it because both are inside the workspace. Recommendation for v1: leave it
inherited and document it, because the alternative — a read-only child — makes the
most obvious use ("go fix the tests in these four packages") impossible. Revisit
with `ganglion-projects`, which introduces per-project subtrees and therefore a
natural place to give a child a narrower root.

**OQ-2 — What serves a genuinely long fan-out?** D-2 holds the turn for the
duration of the batch. A twenty-minute research job wants to be a background task
whose result arrives later — which is `scheduled-tasks` shaped, not `subagents`
shaped, and is why `ganglion-projects` puts the scheduler in the proxy. If that
lands, "run this batch as a scheduled task" is the answer and no async tool is
needed here.
