# per-instance-lifecycle-mode

**Status:** Specified and implemented. Date: 2026-09-10. Size: Large.

Three asks, in the order they were made:

1. the member must be able to SEE when their scheduled tasks are disabled by scale-to-zero;
2. the lifecycle mode must be settable **per instance**, with a default for all;
3. an admin must be able to set it from the admin interface.

## Why it is worth doing

Scheduled tasks fire from timers **inside the container**. A scale-to-zero instance is
stopped most of the time, so it fires none — its tasks are real, listed, and inert.

Today that is decided for a whole agent. Either every member of `gamma` pays for a
container that never stops, or nobody on it gets a working schedule. **One member who
needs a daily report is a reason to keep one container up, not forty.**

## Ask 1 — the member's notice

The proxy has reported `fires` on `GET /v1/cron/tasks` since the scale-to-zero work.
Nothing read it: `lib/cronTasks.ts` did not declare the field and the panel did not
render it. So the list was true, and the conclusion a member drew from it was not.

**FR-1.** The scheduled-tasks panel shows a warning when the proxy reports `fires:false`.

**FR-2.** The field is OPTIONAL in the client type. A proxy older than `fires` sends
nothing, and `undefined` must read as "no claim either way" — treating it as `false`
would warn every member of an older deployment about a problem they do not have. Only an
explicit `false` renders the notice.

The notice sits **above** the list and above the empty state, because it describes the
whole panel: a member with no tasks yet, about to ask the agent for one, still needs to
know it will not fire.

## Ask 2 — the mode, per instance

**Two layers, and deliberately not three.** `agents.<key>.mode` in `config.yaml` already
IS "um valor padrão para todos" — for every instance of that agent. This adds the
exception for one instance. A third, global-across-agents default would have to reconcile
with the per-agent rule that scale-to-zero requires a positive `idleTimeout`, and nothing
asked for it.

| ID | Requirement |
|---|---|
| FR-3 | An instance may pin `continuous` or `scale-to-zero`; absent, it follows its agent. |
| FR-4 | Clearing the override returns the instance to the agent default. |
| FR-5 | **Every** lifecycle branch resolves per instance. |
| FR-6 | The override is unreachable by the agent. |
| FR-7 | `scale-to-zero` is refused where the agent declares no `idleTimeout`. |

### FR-5 is the one that matters

There were **five** places branching on `agent.Mode`, plus a sixth reading a container
label. An override reaching four of them would produce an instance that is scale-to-zero
for the idle timer and continuous for the reconciler — a container stopped and restarted
in a loop, with nothing naming the cause. All six now go through `Manager.ModeFor`.

Two of them were wrong in a way the chokepoint exposed:

- `reconcile.go`'s adopt loop skipped any container whose **agent** default was not
  scale-to-zero, so an overridden instance would never have had its timer armed.
- `reconcile.go`'s pre-warm loop skipped whole **agents** before ever looking at a
  workspace, so a single instance overridden to continuous on a scale-to-zero agent would
  never have been brought up.

### FR-6 — where the file lives

`<userDir>/.crab-mode.json`, beside `.crab-model.json` and `.crab-owner.json` and **above**
`workspace/`. picoclaw's `restrict_to_workspace` and the ganglion's Landlock domain both
stop there. This matters more than it does for a model selection: **an agent able to write
this file could keep its own container alive indefinitely.**

### The transition is the part that fails silently

The store write and the idle-timer move are ONE operation (`Manager.SetMode`). Apart, three
of the four cases are silent:

| From → to | If the timer is not moved |
|---|---|
| continuous → scale-to-zero | no timer armed; the container runs forever and nothing says the setting did not take |
| scale-to-zero → continuous | a timer is still armed; the container is stopped once more after the admin was told it was done. Reconcile heals it — on the reconcile interval, not now |
| either, no container | harmless; the only one that is |

### What the chokepoint costs

Two hot-path questions, both checked rather than assumed:

- **`Reconcile` walks every agent now**, where it used to skip whole agents whose default
  was not continuous. It runs **ONCE, at startup** — `cmd/crab-shell-proxy/main.go` calls
  it in a single background goroutine, not on a ticker — so this is a bounded one-time
  cost of (agents x one filesystem glob), and there is no per-tick profile to protect.
  Had it been on a timer the loop would need inverting: walk workspaces once, resolve per
  workspace. It is not.
- **`ArmIdle` now reads the override file**, and it runs after every completed turn — two
  call sites, `sse.go` and the non-streaming handler, one per turn each. One `os.ReadFile`
  of a ~20 byte file against a turn that just spent seconds talking to a provider. Left
  uncached deliberately: a cache would need an invalidation path from the admin write, and
  the feature does not warrant that machinery. **If `ArmIdle` ever becomes per-delta rather
  than per-turn, this needs revisiting.**

### `LabelMode` stops being read

The label is stamped at create time, and a mode change never touches an existing
container — so it goes stale the instant an override is set. `Instances()` now resolves
instead. The label is still written (it costs nothing and reads well in `docker inspect`),
and `TestNothingBranchesOnTheModeLabel` scans the package source so a NEW reader cannot
reintroduce the staleness quietly.

## Ask 3 — the admin interface

`GET`/`PUT /v1/admin/users/mode`, gated exactly like the sibling instance-config editor:
user-management authority, an explicit `agent` parameter rather than the addressed agent,
no path or name parameter of any kind.

The view reports four things rather than one, and each has a reason:

| Field | Why it is separate |
|---|---|
| `effective` | what the instance runs as; the only field to branch on |
| `override` | "continuous, inherited" and "continuous, pinned" are identical today and diverge the moment the agent default moves |
| `agentDefault` | what clearing would leave |
| `scaleToZeroAllowed` | so the UI disables a choice the write would refuse, instead of offering it |
| `fires` | the same fact the member's panel shows, so an admin acting on their report sees what they see |

**The control lives on the instance row, not inside the config editor.** This is not part
of `config.json` — it is proxy-owned state — and an admin following up "my scheduled tasks
never ran" should not have to open a JSON editor to find it. The row states the
consequence, not the setting: *"Schedules fire from timers inside the container, so an
instance that shuts down when idle runs none of them."*

## The notice is as fresh as the last fetch

`fires` is read when the panel loads. An admin flipping an instance to continuous while a
member has the panel open does not update it — the warning stays until the next fetch,
which the panel's existing refresh control already triggers.

Recorded so a stale warning is not later read as a bug in the resolver. A push channel for
this would be more machinery than a setting changed a handful of times a year deserves.

## AC

- **AC-1** — `fires:false` renders the member's notice; `true` and **absent** render nothing.
- **AC-2** — An override beats the agent default; an empty value clears it.
- **AC-3** — Setting scale-to-zero arms the idle timer; setting continuous cancels it.
- **AC-4** — A malformed or unrepresentable override falls back instead of failing.
- **AC-5** — The override path is outside the agent's workspace.
- **AC-6** — No source file branches on `Labels[LabelMode]`.
- **AC-7** — The admin endpoint refuses a non-manager, and surfaces a refusal as a 400 naming the cause.
- **AC-8** — The control hides scale-to-zero when the agent cannot represent it.

## Evidence

| | |
|---|---|
| proxy | `go vet` clean; **10** failures, all the pre-existing `lchown` sandbox limit — **one fewer than baseline**, which still carried `TestLoadDisablesAGanglionAgentWhoseKeyIsUnset` |
| webapp | 1479 tests pass across 116 files, i18n parity included; `next build` succeeds |
| AC-1 | mutation-checked — with the notice removed from the panel the positive case fails |

## Deliberately not done

**Members cannot set their own mode.** It decides whether a container runs permanently,
which is a cost and capacity decision. It stays with whoever already holds user-management
authority.

**No restart policy on the write.** Unlike `users/config`, the effect is complete on the
proxy side the moment `SetMode` returns — the timer moves with the write, and there is
nothing for a bounce to deliver.
