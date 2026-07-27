# FINAL fix wave — model-registry-source-of-truth

One consolidated pass over the whole-branch review. Two repos, branch
`feat/model-registry-source-of-truth` in each. Nothing committed in the parent.

- `crab/crab-shell-proxy` — 5 commits, `bf11c1f`…`3e9e95c`
- `crab/crab-exoskeleton-webapp` — 3 commits, `e117ccc`…`0779619`

All three Critical findings were real as described. **One remedy detail could not be
implemented as written** (C-2's catalog join key does not exist); the substitute is
described under C-2 and is strictly better data. Nothing else was refused.

---

## Critical

### C-1 — the migration performed the overwrite the feature exists to prevent

**Confirmed.** `captureWorkspaceModel` recorded `SourceExplicit` only when a legacy
`.crab-model.json` existed, and the deleted `ApplyRegisteredModelToUser` never wrote
one (zero references to `UserModelOverrideFile` in the old `registered_models.go`).
So every user an admin set through the old registry UI imported as `inherited`, and
because `candidateTx` only honours `explicit`, the next `EnsureRunning` re-resolved
them from the cascade.

**Fix** (`internal/docker/migrate_models.go`, `internal/registry/resolve.go`):

- New `Registry.ScopeCandidate(ref)` reports what the **scope cascade alone** selects
  — no per-user assignment, no deprecation hop. It shares `candidateTx` with
  `Resolve`, so the migration's question and runtime resolution cannot drift. No hop
  is correct here: once an inherited assignment exists, `Resolve` stops hopping too,
  so hopping at capture time would mis-classify a workspace running a deprecated
  scope default.
- `captureWorkspaceModel` decides `Source` by **reproducibility**: an override file is
  still an unconditional pin; otherwise, if `ScopeCandidate` returns exactly the
  captured primary the assignment stays `inherited` (the workspace keeps tracking its
  scope, AC-7 still sweeps it), and if it returns anything else — or errors, including
  `ErrNoModelResolvable` — the workspace is recorded `explicit` and logged. Promotion
  only; nothing is ever demoted.

**Tests.**

- `TestMigrateKeepsAModelTheOldRegistryUISetThroughASubsequentResolve` — a workspace
  with its own model and no override file, plus a tenant default pointing elsewhere.
  Asserts the assignment **and** that `Resolve` afterwards returns the workspace's own
  model.
- `TestMigrateRecordsAWorkspaceTheCascadeReproducesAsInherited` — the narrowing half:
  a workspace whose model *is* its scope default stays `inherited`.
- `TestMigrateCapturesEveryWorkspacesCurrentModelAndChain` **flipped** to expect
  `explicit`. Its fixture gives the cascade no default at all, so `inherited` there
  meant "re-resolve me from a cascade that resolves nothing" — it encoded the defect.
  The flip is not a substitute for the new test; both are present.

**RED evidence** (source fix reverted to the pre-fix source decision, test unchanged):

```
--- FAIL: TestMigrateKeepsAModelTheOldRegistryUISetThroughASubsequentResolve (0.04s)
    migrate_models_test.go:423: Resolve = "tenant-default", want ui-chosen;
        the migration let the tenant default overwrite it
FAIL
```

**Deviation to record.** FR-22 says literally "as an `inherited` assignment when no
explicit override was imported for it". This replaces override-file-presence with
reproducibility as the test. Two consequences, both intended: (a) a migrated
workspace whose model no scope reproduces becomes immune to scope-default sweeps
(AC-7) until an admin unpins it — that is the point, the alternative is losing the
model; (b) AC-11's "no workspace's active model changes" is now true through the
*next resolve* as well, not only immediately after the pass.

### C-2 — config.yaml-seeded records carried a wrong `model` and no `api_base`

**Confirmed.** `config.ModelConfig` has no `api_base` for picoclaw (`BaseURL` is
hermes-only) and no field at all for the provider's model id; both lived in the
template's `model_list`, where `model_name != model` for most entries. Recovery never
fired: `importLegacyModel` returned early on an existing name (backfilling only an
empty `APIKey`) and `captureWorkspaceModel` skipped any name already in the inventory.

**Fix** (`internal/docker/migrate_models.go`): `refineLegacyModel` lets a later source
correct an existing record — `api_base`/`auth_method` backfilled when empty, `model`
corrected outright (a wrong model id is not a preference, it is a request the provider
rejects), and a **non-empty `api_key` never overwritten**. It aborts its own
transaction via a sentinel when nothing would change, so a no-op refine does not bump
`Version`/`UpdatedAt`. Two call sites now reach it: `importLegacyModel`'s existing-name
branch (unconditionally, not only when a key is present), and `captureWorkspaceModel`
for a name already in the inventory. The doc comment at the top of the file was
rewritten to state the semantics that now hold ("later sources win for the definition
fields; a non-empty api_key is never overwritten").

**Where the remedy differs from the finding.** The finding asked for a fallback via
"the embedded `model-catalog.json` matched by `provider`+`model_name`". **That join key
does not exist**: all 30 catalog entries carry `provider`/`model`/`api_base` and no
name, and four places state that deliberately (FR-9, design §6 "provider, model,
api_base only", `model_catalog.go:13-15`, and the webapp's `CatalogEntry`). Adding a
`model_name` to the catalog would change a documented cross-repo wire contract, so it
was not done. Instead, for a declared model **no workspace runs**, the definition is
read from the per-instance disk template `<dataRoot>/templates/<agent>/config.json` —
which still holds the full `model_name → provider/model/api_base` mapping at step 1,
because step 5 normalizes it later, and from its `config.json.pre-registry` backup on a
re-run. That is per-instance truth rather than a generic suggestion, i.e. strictly
better data than the catalog would have given. It is not a template *import* (FR-20): a
template-only model no source declares is still dropped; only the definition of a model
`config.yaml` already declares is corrected.

**Tests.**

- `TestMigrateCorrectsAConfigYamlSeedFromAWorkspacesOwnModelList` — the test the
  finding asked for: a `config.yaml`-seeded name that also appears in a workspace's
  `model_list` with a different `model` and a real `api_base` ends up with the
  workspace's values, and the seed's env-sourced key survives.
- `TestMigrateCorrectsAConfigYamlSeedFromTheDiskTemplate` — the no-workspace case.

**RED evidence** (both corrections reverted, tests unchanged):

```
--- FAIL: TestMigrateCorrectsAConfigYamlSeedFromAWorkspacesOwnModelList (0.05s)
    migrate_models_test.go:500: model = "claude-sonnet-4.6", want claude-sonnet-4-6
        — the workspace's own model id must win over the config.yaml seed's model_name
    migrate_models_test.go:504: api_base = "", want the workspace's — the seed has none to give
--- FAIL: TestMigrateCorrectsAConfigYamlSeedFromTheDiskTemplate (0.03s)
    migrate_models_test.go:544: imported = {model:"nearai-glm" api_base:""},
        want the template's real definition
FAIL
```

### C-3 — the native key overlay precedence was inverted

**Confirmed.** `provision` ran `applyNativeSecrets` and `resolveAndMaterialize` ran
after it; `materializeModels` rewrites every `.security.yml` `model_list` entry and
prunes the rest, so the inventory key overwrote the overlay from the next ensure
onward, permanently. `reapplyWorkspace` never applied the overlay at all.

**Fix** (`internal/docker/materialize.go`, `provision.go`, `manager.go`): the overlay
is applied at the **end of `resolveAndMaterialize`**, reading
`config.EffectiveSecretsDir(...)` — so every path that materializes gets it, including
both re-apply paths. The call in `provision` is removed, along with its now-unused
`secretsDir`/`logf` parameters (three test call sites updated); `EnsureRunning` still
calls `syncEffectiveSecrets` first, because that dir is the bind-mount source and the
overlay's source. Order inside `resolveAndMaterialize`: materialize → record assignment
→ apply overlay → `chownTree`.

**Tests.**

- `TestNativeKeyOverlayWinsOverTheInventoryKeyOnEveryMaterialization` — a scope-level
  `model_list.<m>.api_keys` for a model the workspace **does** resolve to survives a
  full materialize cycle **and a second `resolveAndMaterialize`** (that second
  assertion is what proves the inversion is gone), with the pico token intact.
- `TestMaterializeAppliesAnOverlayForAModelThisWorkspaceDoesNotHave` — FR-32b's skip
  still holds on the new ordering: an inapplicable model slot does not abort the merge
  and take a working `web.*` slot with it.
- `TestApplyNativeSecretsSkipsModelNotInThisWorkspace` still passes (unchanged).

**RED evidence** (overlay moved back before `materializeModels`, i.e. the old
provision→materialize order; test unchanged):

```
--- FAIL: TestNativeKeyOverlayWinsOverTheInventoryKeyOnEveryMaterialization (0.04s)
    provision_model_test.go:229: after first materialize, key = "sk-inventory",
        want the scope admin's sk-scope-admin
    provision_model_test.go:236: after re-materialization, key = "sk-inventory"
        — the inventory key reclaimed the slot
FAIL
```

---

## Important

**I-1 — schema marker written after a failed capture.** `migrateModelRegistry` now
counts capture failures and returns without `SetSchemaVersion` when any occurred,
logging that the whole pass will re-run. Test:
`TestMigrateWithholdsTheSchemaMarkerWhenACaptureFailed` — asserts version 0 after an
unreadable workspace, then that a clean re-run captures it and sets the marker.
(Skips when running as root, where file mode does not gate the owner's read — the same
caveat the pre-existing `TestMigrateLogsAnUnreadableWorkspaceConfig…` carries.)

**I-2 — migration raced request serving.** `Reconcile` no longer runs the migration;
`Manager.MigrateModels()` is exported and `main.go` calls it **synchronously before
`ListenAndServe`**. The drift check, container adoption and continuous start stay in
the background goroutine, so `/healthz` does not wait on container work. Removing the
migration from `Reconcile` also matters for I-1: leaving it there would re-run the
whole pass in the background immediately after a capture-failure boot.
*Behaviour change beyond the finding, called out deliberately:* a migration error is
now `logger.Fatalf` instead of a non-fatal log. `reconcile.go`'s own comment already
argued for this ("continuing would provision workspaces against an empty inventory and
refuse every one of them"), and the marker is withheld on capture failures so a restart
retries. No test — `main.go` has none in this repo.

**I-3 — hermes agents reachable through model administration.** Server-side gate first:
`rejectNonPicoclawAgent` returns 400 with a message naming the harness, wired into
`resolveAssignmentTarget` (POST/DELETE `/v1/admin/model-assignments`) and into
`authorizeScopeDefault` for `scope=agent` **writes only** (a GET of a stored value is
harmless and lets a UI render it). `GET /v1/admin/agents` now reports `harness`. Webapp:
`picoclawAgentKeys` filters the model tab's picker, and a shared choice that is a hermes
agent falls back to "all agents" on that tab. Tests:
`TestModelAssignmentRejectedForANonPicoclawAgent` (both methods, and asserts **nothing
was written**), `TestAgentModelDefaultRejectedForANonPicoclawAgent` (plus the positive
control that the picoclaw agent still succeeds), `TestAdminAgentsReportsTheHarness`,
`picoclawAgentKeys` cases in `lib/admin.test.ts`.

**I-4 — FR-27's per-user override indicator.** New `GET /v1/admin/model-assignments`
(`tenant_id`, `subs_acc_id`; `AuthorizeUserManagement`) backed by
`Registry.AssignmentsUnder`, a BFF `GET` on the existing route, `listModelAssignments`
+ `pinnedModel` + `assignmentIndex` in `lib/models.ts`, and the indicator in the panel:
each row shows the recorded model and whether it is a pin or the cascade, the select
initialises from the stored pin, Unpin is disabled with nothing to unpin, and both
actions refresh. Documented in `openapi.json`.
*Deliberate departure from the "agent comes from the routed service" principle
(`admin_model_scopes.go:16-18`):* the listing spans agents under the pair. A
subscription's users may each sit under a different agent, and the panel pins by
`u.role`, so a routed-agent-only read would render exactly those users as unpinned —
under-serving the requirement. Authority checked is authority over the (tenant,
subscription), which is what `AuthorizeUserManagement` expresses, and a model name is
not a credential. Tests: `TestModelAssignmentListReportsPinsAndItsGate` (403 for the
wrong tier; explicit vs inherited distinguished; no key-shaped content),
`TestAssignmentsUnderSpansAgentsAndStopsAtTheSubscription`,
`pinnedModel`/`assignmentIndex` cases in `lib/models.test.ts`.

**I-5 — stale copy.** `agent-target-select.tsx`'s `registry` hint rewritten: the
inventory is proxy-wide, the picker chooses the request's route, a per-user pin
addresses the agent that user's workspace runs under, and hermes agents are not listed.

**I-6 — silent no-op when `agents.defaults` is absent.** Both `materializeModels` and
`normalizeTemplateFile` now create the structure via the existing `childMap` helper
instead of skipping. Tests: `TestMaterializeCreatesAMissingAgentsDefaults`,
`TestNormalizeTemplateFileCreatesAMissingAgentsDefaults`.

---

## Triaged minors

**Swallowed reads that can override a pin.** `ReapplyModelScope` now branches on
`errors.Is(err, registry.ErrNotFound)` and **skips the workspace** (logging) on any
other error, rather than treating it as "no pin" and restarting it. `Resolve`'s
`hasAssignment` likewise distinguishes absent from unreadable and returns the error.
Test: `TestResolveSurfacesACorruptAssignmentInsteadOfReadingItAsAbsent`. The
`ReapplyModelScope` branch is **not** unit-tested: the `docker` package has no way to
corrupt a registry record (no exported seam, and the store is private), and closing the
registry makes every call fail, so the test could not distinguish the two code paths.
The equivalent branch in `Resolve` is covered.

**Materialization write order — corrected remedy implemented.** `materializeModels`
now writes `.security.yml` with **old ∪ new** keys, then `config.json`, then prunes
`.security.yml` to the new set. Every intermediate state names a model whose key is
present. Test: `TestMaterializeLeavesEveryIntermediateStateBootable` — makes the
`config.json` write fail and asserts the fail-safe state (outgoing key still present,
incoming key already written). Skips as root, where file mode does not gate the owner's
own write; it is a non-root-only observation, noted in the test comment.

**`Resolve` hard-failed on a dangling cascade level.** `candidateTx` now skips a level
whose default names a model the inventory does not have and reports it on
`Resolution.SkippedLevels`, which `resolveAndMaterialize` logs — the registry stays
logger-free, same shape as the existing `Skipped`. An **explicit pin** naming a missing
model deliberately stays a hard failure: falling through to a scope default there would
silently replace a deliberate choice, and I2 blocks a delete that would create it. Test:
`TestResolveSkipsADanglingCascadeLevelAndContinues`.

**Deprecated scope default invisible in the select.** `defaultOptions` in
`lib/models.ts` returns the active models plus the current default when it is no longer
active, badged "(retired — current default)". Tests: three `defaultOptions` cases.

---

## Explicitly carried (untouched, as instructed)

The deprecation hop keying on "has any assignment"; `config.Agent.FindModel` now
unused; assignments never garbage-collected for torn-down workspaces; remaining
test-coverage gaps; pre-existing openapi status-code inaccuracies. `/v1/admin/agents`
is still absent from `openapi.json` — a pre-existing gap that predates this feature;
only the two routes this wave touched were documented.

---

## Gates

### crab-shell-proxy — local

```
$ go build ./...
BUILD OK
$ go vet ./...
VET OK
$ go test ./...   # 8 failures, all documented, all chown-related
--- FAIL: TestContinuousDoesNotArmIdle
--- FAIL: TestCreateAddsReadOnlySecretsBind
--- FAIL: TestEnsureRunningColdStart
--- FAIL: TestEnsureRunningReusesRunning
--- FAIL: TestEnsureRunningSingleFlight
--- FAIL: TestReconcileEnsuresContinuousWorkspaces
--- FAIL: TestRestartWorkspaceRestartsAndRearms
--- FAIL: TestScaleToZeroIdleStop
# every other package: ok
```

Exactly the eight names in `constraints-proxy.md`, no others. Each traces to
`chown …: operation not permitted` (`TestEnsureRunningSingleFlight` and
`TestReconcileEnsuresContinuousWorkspaces` report the downstream assertion —
`createN = 0` / `create=0 start=0` — with the chown error logged on the lines above,
which is how they failed before this wave too).

### crab-shell-proxy — the real gate (root, golang:1.23)

```
$ docker run --rm -v "$PWD":/src -w /src golang:1.23 sh -c 'go vet ./... && go test ./...'
?   	.../cmd/crab-shell-proxy	[no test files]
?   	.../internal/turn	[no test files]
ok  	.../internal/authz	0.002s
ok  	.../internal/config	0.006s
ok  	.../internal/docker	2.315s
ok  	.../internal/hermes	0.003s
ok  	.../internal/history	0.005s
ok  	.../internal/httpapi	1.753s
ok  	.../internal/identity	0.015s
ok  	.../internal/pico	0.001s
ok  	.../internal/registry	1.659s
```

**Fully green, zero failures.**

### crab-exoskeleton-webapp

```
$ yarn tsc --noEmit
Done in 1.21s.                     # no diagnostics

$ yarn test
 Test Files  11 passed (11)
      Tests  112 passed (112)

$ yarn next build
 ✓ Compiled successfully / Linting and checking validity of types …
Done in 16.94s.                    # no errors, no warnings
```

---

## Commits

crab-shell-proxy:

| Commit | Scope |
|---|---|
| `bf11c1f` | `fix(registry): a dangling cascade level skips, a corrupt assignment surfaces` — dangling level, corrupt assignment, `ScopeCandidate`, `AssignmentsUnder` |
| `af43230` | `fix(docker): the migration must not overwrite what a workspace already runs` — C-1, C-2, I-1 |
| `b1c28b0` | `fix(docker): the native key overlay is applied after materialization` — C-3, write order, I-6, `ReapplyModelScope` read |
| `ca7e6cf` | `fix: seed the model inventory before the server listens` — I-2 |
| `3e9e95c` | `feat(httpapi): model administration rejects non-picoclaw agents; pins are readable` — I-3 server half, I-4 server half, openapi |

crab-exoskeleton-webapp:

| Commit | Scope |
|---|---|
| `e117ccc` | `feat(models): read the stored per-user pins, and each agent's harness` — BFF GET, client, `defaultOptions`, `picoclawAgentKeys`, tests |
| `3010e4e` | `fix(admin): show which users are pinned, and stop offering hermes agents` — I-4 UI, I-3 UI filter, I-5 copy, deprecated-default select |
| `0779619` | `fix(admin): key the pin selection by agent and user` — the row's local pick state was keyed by account id alone while the stored pin is keyed by agent + account id, so a selection bled between two agents' rows for the same user |

## Unfixed / not done

1. **C-2's catalog-matched fallback** — unimplementable as specified (the catalog has
   no `model_name` to join on, by documented design). Replaced with the per-instance
   disk template, which carries the same mapping and is per-instance truth. See C-2.
2. **A unit test for `ReapplyModelScope`'s corrupt-read branch** — the `docker` package
   cannot produce that error state through any exported registry API. The analogous
   `Resolve` branch is tested.
3. **No test for `main.go`'s ordering** — the command has no test harness in this repo;
   the split is a five-line reordering plus the exported `MigrateModels`.

---

# Addendum — post-review Medium defect introduced by this wave

Scoped re-review returned "all findings addressed" with the three deviations judged
sound, and flagged **one new Medium defect the wave itself introduced**. Fixed here.
Proxy only; the webapp is untouched.

Commit: `5f6fc21` — `fix(docker): one workspace's model id must not overwrite another's`

## The defect

`refineLegacyModel` (`internal/docker/migrate_models.go`) corrected `cur.Model`
**outright**, with no last-writer guard, while `api_base`/`auth_method` were
backfill-only and `api_key` was never overwritten. Because C-2's fix made
`captureWorkspaceModel` call it for **every** name already in the inventory, and step
4 iterates workspaces in `filepath.Glob` order, two workspaces carrying the same
`model_name` with different `model` ids resolved to **last-writer-wins** — and the
winner's id was then materialized into every other workspace using that name at its
next start.

Reachable on a legacy instance: `provision` never re-seeds a returning user, and the
old registry UI wrote per-user `model_list` entries from a free-text field. Concretely,
`u1` running `{claude-sonnet-4.6 → claude-sonnet-4-5}` alongside `u2` running
`{claude-sonnet-4.6 → claude-sonnet-4-6}` had `u1`'s active model id changed by the
migration alone — a direct AC-11 violation, in the same direction C-2 exists to fix.
Before this wave it was impossible, because `captureWorkspaceModel` skipped names
already present.

## The fix

`model` is corrected **only while it still carries the config.yaml-seed placeholder**,
i.e. `cur.Model == cur.ModelName` — which is precisely the state step 1 creates
(`Model: mc.Name`, because `config.ModelConfig` has no real model id for picoclaw). The
first source with a real id repairs it; no later workspace can flip a real id.
`api_base`, `auth_method` and `api_key` handling is **unchanged**.

One addition beyond the prescribed guard: because `model_name` is unique (FR-3), one
record cannot serve two different ids, so the residual disagreement is **logged**
(`model %q keeps model id %q; another source declares %q — one inventory record cannot
serve both, review`) instead of being resolved silently by glob order. Which of the two
workspaces is right is the admin's call. The log is asserted by the new test.

## C-2's own tests

**Both pass unchanged, no adjustment needed.**
`TestMigrateCorrectsAConfigYamlSeedFromAWorkspacesOwnModelList` exercises exactly the
placeholder path the guard preserves (`Model == ModelName` at refine time), and
`TestMigrateCorrectsAConfigYamlSeedFromTheDiskTemplate` never reaches `refineLegacyModel`
at all — step 1 enriches at creation time. The full `TestMigrate*` set (15 tests) passes.

## The test

`TestMigrateDoesNotLetOneWorkspacesModelIDOverwriteAnothers` — a `config.yaml` seed for
`claude-sonnet-4.6` (so the placeholder path is what gets repaired) plus two workspaces
under the same subscription disagreeing about the id behind that name (`u1` →
`claude-sonnet-4-5`, `u2` → `claude-sonnet-4-6`; `filepath.Glob` sorts, so `u1` is
visited first). Asserts: the record holds a real id that the later workspace did **not**
replace, the placeholder was genuinely repaired (`Model != ModelName`), the declined id
was logged, and **neither workspace's `config.json` changed** (AC-11 — the migration only
reads).

### RED evidence

Guard reverted to the unguarded correction, test unchanged:

```
--- FAIL: TestMigrateDoesNotLetOneWorkspacesModelIDOverwriteAnothers (0.05s)
    migrate_models_test.go:669: model = "claude-sonnet-4-6", want claude-sonnet-4-5
        — a real model id must not be overwritten by another workspace's
    migrate_models_test.go:685: the declined model id was not logged; logs = [migrate models:
        superseded files are no longer read (...); they are left on disk for rollback]
FAIL
```

## Gates

### Local

```
$ go build ./...
BUILD OK
$ go vet ./...
VET OK
$ go test ./...
--- FAIL: TestContinuousDoesNotArmIdle
--- FAIL: TestCreateAddsReadOnlySecretsBind
--- FAIL: TestEnsureRunningColdStart
--- FAIL: TestEnsureRunningReusesRunning
--- FAIL: TestEnsureRunningSingleFlight
--- FAIL: TestReconcileEnsuresContinuousWorkspaces
--- FAIL: TestRestartWorkspaceRestartsAndRearms
--- FAIL: TestScaleToZeroIdleStop
ok  	.../internal/authz        ok  	.../internal/config
ok  	.../internal/hermes       ok  	.../internal/history
ok  	.../internal/httpapi      ok  	.../internal/identity
ok  	.../internal/pico         ok  	.../internal/registry
```

The eight documented `internal/docker` chown failures, no others.

### The real gate (root, golang:1.23)

```
$ docker run --rm -v "$PWD":/src -w /src golang:1.23 sh -c 'go vet ./... && go test ./...'
?   	.../cmd/crab-shell-proxy	[no test files]
?   	.../internal/turn	[no test files]
ok  	.../internal/authz	0.003s
ok  	.../internal/config	0.008s
ok  	.../internal/docker	2.426s
ok  	.../internal/hermes	0.003s
ok  	.../internal/history	0.005s
ok  	.../internal/httpapi	1.784s
ok  	.../internal/identity	0.016s
ok  	.../internal/pico	0.002s
ok  	.../internal/registry	1.758s
```

**Fully green, zero failures.**

## Residual, stated plainly

Two workspaces disagreeing about the id behind one `model_name` cannot **both** be
preserved by a single inventory record — `model_name` is unique by design (FR-3), and it
is also the `.security.yml` credential key, so that uniqueness is not negotiable. The
guard makes the outcome deterministic and stops a *correct* id being overwritten, but the
second workspace will still be re-materialized onto the record's id at its next start.
That is inherent to consolidating two divergent workspaces into one record, not
something the guard can remove; the new log line is what puts it in front of an admin.
Fully resolving it would need per-workspace records (i.e. dropping FR-3), which is out of
scope for this branch.
