# SDD ledger — plan: .specs/features/model-registry-source-of-truth/tasks.md

Multi-repo plan. Commits land in three repos; `review-package` must run with the
CWD set to the repo the task committed in, and with an explicit OUTFILE under this
workspace so the script does not create `.superpowers/` inside a submodule.

| Tasks | Repo | CWD for git/review-package |
|---|---|---|
| T01–T15 | crab-shell-proxy | `crab/crab-shell-proxy` |
| T16 | parent | `.` |
| T17–T21 | crab-exoskeleton-webapp | `crab/crab-exoskeleton-webapp` |

Branch in all three: `feat/model-registry-source-of-truth`.

## Pre-flight scan

Four plan-mandated defects found before dispatching Task 1. Three had no design
tradeoff and were fixed in the plan directly:

- `ModelRow` wrapped in a `<div>` inside a `<ul>` — invalid markup, and the row
  itself renders an `<li>`. Reorder arrows moved inside the row; two tests added.
- `window.prompt` for the deprecation replacement — the replacement must be an
  existing active model and a free-text prompt cannot offer that list. Replaced
  with an inline picker over the active set.
- `emptyDraft` was a shared const, handing every draft the same `fallbacks` array.
  Now a factory.
- One structural question escalated to the human: see below.

## Progress

### Pre-flight ruling (human, 2026-07-25)

The plan's Global Constraint (`go vet ./... && go test ./...` must pass — it IS the
Docker build gate) collided with T10's stated three-task non-compiling window.
**Ruling: move the httpapi deletions from T14 into T10**, so every task boundary is a
green whole-module build. T10 gained steps 9b–9e (delete the old handlers and routes,
trim the `Docker` interface, update the fake, delete `admin_model_test.go`); T14 now
only adds. Committed in b891d0d and the follow-up.

### Amended gate (controller, after T01 review)

T01's reviewer flagged as ⚠️ that the report mentioned module-wide `go test` failures.
Verified: exactly 8 `internal/docker` tests fail on this host with
`chown …: operation not permitted` — they chown to another user, which needs root.
The Docker build stage runs as root, so the real gate passes there. Pre-existing and
unrelated: T01 touched only `internal/registry/`.

Local gate for every remaining task: `go build ./... && go vet ./... && go test ./...`
with ONLY these eight failing, ONLY with `operation not permitted`; every other package
`ok`. Anything else is a regression. Recorded in the plan's Global Constraints.

  TestContinuousDoesNotArmIdle, TestCreateAddsReadOnlySecretsBind,
  TestEnsureRunningColdStart, TestEnsureRunningReusesRunning,
  TestEnsureRunningSingleFlight, TestReconcileEnsuresContinuousWorkspaces,
  TestRestartWorkspaceRestartsAndRearms, TestScaleToZeroIdleStop

### T01

Task 1: complete (commits 0f4e90e..bc709db, review clean)
Task 1: minor (deferred): registry.go Model doc comment forward-references public.go, which T13 creates — plan-mandated wording
Task 1: minor (deferred): putJSON/getJSON have no caller until T02 — scaffolding the brief mandates
Task 1: minor (deferred): registry_test.go fixedNow comment sits on testRegistry rather than the closure it describes
Task 1: resolved ⚠️ — DB path: deferred by design; T08 hard-codes <containerDataRoot>/model-registry.db, a sibling of tenants/, so no chownTree pass reaches it
Task 1: resolved ⚠️ — commit trailer present (verified on bc709db)

### T02

Task 2: complete (commits bc709db..27ae3f6, review clean)
Task 2: minor (deferred): SetPositions' partial-write rollback is untested — SetPositions(["b","nope"]) then asserting b's Position unchanged would be the sharpest "rejected write wrote nothing" case; correct by construction (bbolt rolls back on non-nil return) but unexercised
Task 2: minor (deferred): TestListModelsSortsByPositionThenName never hits the ModelName tiebreak — SetPositions gives distinct positions, so the tiebreak branch is dead in the suite despite the spec calling it load-bearing
Task 2: minor (deferred): jsonUnmarshal is a one-line wrapper with a single call site — plan-mandated, zero risk
Task 2: resolved ⚠️ — commit trailer present (verified on 27ae3f6)

### T03

Task 3: review — spec ✅; 1 Important (plan-mandated), 2 minor
Task 3: ruling (human) — the in-use guard becomes ONE helper, guardUnreferenced(tx, name),
  and that governs over the brief's reference code for the REST of the plan: if a later
  brief shows the block inline again, the implementer calls the helper. Rationale: safety
  invariant, two call sites now and a third coming, and duplication lets a future
  correction land on only one side. Recorded in constraints-proxy.md.
Task 3: minor (deferred): SetStatus accepts replacedBy but never reads it — inert until T04 wires Deprecate; a caller passing a value today gets no feedback it was ignored
Task 3: minor (deferred): Referrer.Kind values are untyped string literals repeated across referrers.go and its test; a typo would not be caught by the compiler
Task 3: fix round 1/5 dispatched (resumed implementer a98642c7c4bfde1b0)
Task 3: fix round 1/5 (1 addressed, 0 open; commits 793947a..97b457d)
Task 3: minor (deferred): guardUnreferenced sits at the end of referrers.go after PutScopeDefault rather than adjacent to referrersTx as the brief intended — placement only
Task 3: complete (commits 27ae3f6..97b457d, review clean)

### T04

Task 4: review — spec ❌ on one plan-inherited test gap; 2 Important, 2 minor
Task 4: SPEC DEFECT found by the implementer, ruled by controller (no user interrupt —
  one reading made the plan self-contradictory, so it was not a genuine fork).
  FR-7/AC-5/I4 required a deprecation replacement to be `active`, but the plan's OWN
  chain test deprecates v1 -> v2 after v2 is already deprecated, which that rule
  forbids. Correct rule: reject only `disabled`. A deprecated replacement is a valid
  chain link because resolution hops onward from it — that is what lets a series of
  models be retired incrementally instead of re-pointing every predecessor each time.
  Amended spec.md FR-7 + AC-5, design.md I4, and the plan's reference code + comment.
Task 4: controller ruling — the missing stale-version test was labeled plan-mandated by
  the reviewer, but adding a test contradicts nothing: the plan's own Global Constraints
  demand post-state assertions, so the fix IMPLEMENTS the plan. Entered the loop without
  a user interrupt, unlike T03's guard duplication, where the fix did change plan code.
Task 4: minor (deferred): hop-bound asymmetry between the two walks (< vs <=) is benign and plan-inherited; undocumented
Task 4: minor (deferred): assertNoCycleTx doc comment omits its third failure mode (chain exceeding maxDeprecationHops)
Task 4: fix round 1/5 dispatched (resumed implementer a95e16df4d311636e)
Task 4: fix round 1/5 (3 addressed, 0 open; commits 853ef8d..3fe8579)
Task 4: complete (commits 97b457d..3fe8579, review clean)

### T05

Task 5: complete (commits 3fe8579..31d0249, review clean)
Task 5: minor (deferred): TestSetScopeDefaultRequiresAnActiveModel's two rejection branches assert only the error, never GetScopeDefault post-state; the later success path overwrites the key so it cannot retroactively catch a write-then-check regression — plan-mandated test body, correct by inspection
Task 5: verified — PutScopeDefault fully removed, repo-wide grep clean, T03 test amended to SetScopeDefault

### T06 — Phase A complete

Task 6: complete (commits 31d0249..b9ad8b5, review clean)
Task 6: reviewer verified BY INVERSION that both load-bearing conditions are
  load-bearing: dropping `&& !hasAssignment` would break the "existing users keep the
  deprecated model" test, and dropping the `Source == SourceExplicit` clause would break
  the "inherited is not a pin" test. Neither test passes for the wrong reason.
Task 6: minor (deferred): hasAssignment collapses "absent" and "present but corrupt" into one boolean — a corrupt record would let the hop fire for a materialized workspace; needs on-disk corruption to matter
Task 6: minor (deferred): the missing-fallback branch of the Skipped logic has no test, only the disabled-fallback branch — gap inherited from the brief's test file
PHASE A COMPLETE: internal/registry self-contained, 32 tests, go build/vet clean.

### T07 — Phase B begins

Task 7: complete (commits b9ad8b5..75cde93, review clean)
Task 7: minor (deferred, FLAG FOR FINAL REVIEW): write ordering — config.json is written
  before .security.yml, so a failure between them leaves config.json naming models whose
  key is missing or stale: the same "unbootable container" shape the design fights, via
  partial write rather than bad resolution. Writing .security.yml first fails closed (an
  extra key for a model config.json does not yet name is inert). The fix is a free
  reordering; the brief did not ask for cross-file atomicity.
Task 7: minor (deferred): the empty-chain delete(defaults,"model_fallbacks") branch is
  tested VACUOUSLY — the seed has no model_fallbacks key, so the assertion cannot observe
  a stale chain being removed. The brief calls that branch load-bearing.
Task 7: minor (deferred): pruneSecurityModelList deleting the whole model_list section when keep is empty is untested
Task 7: reviewer inversion-checked both core requirements: removing the prune call trips
  the stale-key assertion; adding api_key back to modelListEntry trips the no-key
  assertion. Neither test is a tautology.

### T08

Task 8: review — spec ❌ on the letter of "single path" (the transient T10 handoff);
  quality Approved; 2 Important, both traceable to the brief's own reference code.
Task 8: **DO NOT DEPLOY BETWEEN 0ac97d8 AND T10.** The embedded template now ships
  model_list: [], but applyModel still writes agents.defaults.model_name without adding a
  model_list entry — previously masked by the template's 30 baked-in models. A live caller
  passing a non-nil model to provision() would produce an unbootable workspace. Tests do
  not catch it because all three provision_test.go cases pass model == nil. T10 deletes
  applyModel and closes it. Accepted as transient rather than pulling T10's deletion
  forward, which would have made T10's review meaningless.
Task 8: plan inaccuracy — the brief claimed other NewManager callers were struct
  literals. Wrong: 9 function call sites across manager_test.go, model_test.go,
  shared_test.go, handlers_test.go, admin_model_test.go. Implementer fixed all in the one
  commit; reviewer confirmed none dereference the nil registry.
Task 8: controller ruling (no user interrupt) — the two Important findings are the plan
  contradicting its OWN Global Constraints ("any check that guards a write lives in the
  same transaction"), which the plan declares binding on every task. Same shape as the T04
  deprecation defect: one reading makes the plan self-inconsistent, so not a genuine fork.
  Fixed via a registry-side atomic RecordMaterialization, which also closes the swallowed
  read error. Reported to the user.
Task 8: fix round 1/5 dispatched (resumed implementer a5e34f366b67262da)
Task 8: fix round 1/5 (2 addressed, 0 open; commits 0ac97d8..23a9668) — RecordMaterialization
  does read-preserve-write in one db.Update, distinguishes ErrNotFound from real errors,
  stamps MaterializedAt from the injected clock, and touched no existing test file
Task 8: complete (commits 75cde93..23a9668, review clean)
Task 8: NOTE for T09 — the plan's Step 1 extracts the catalog from HEAD~1, but the fix
  commit shifted that: HEAD~1 is now 0ac97d8, the commit that EMPTIED the template. The
  correct source is 75cde93 (the commit before T08).

### T09

Task 9: complete (commits 23a9668..7dcd009, review clean)
Task 9: controller re-graded a reviewer finding — the reviewer listed
  "TestSuggestionCatalogParsesAndCarriesNoKeys' name overstates its assertions" as
  Important and then adjudicated it accept-as-is themselves. Reviewers do not adjudicate;
  the controller does. Re-graded MINOR: the rubric places naming polish there, and the
  reviewer's own analysis concedes the no-keys guarantee is structural and real
  (CatalogEntry has no key field, so JSON unmarshal drops one if present). Deferred to the
  final review rather than spending a fix round on a test name.
Task 9: minor (deferred): test name promises a no-keys assertion the body does not make; guarantee is structural via the struct definition
Task 9: controller verified the catalog independently — 30 entries, no model_name key, no api_key key, correct first entry

### T10 — Phase B complete

Task 10: complete (commits 7dcd009..02743fb, review clean)
Task 10: **T08's deploy hazard is CLOSED.** applyModel is deleted; the empty template no
  longer has a writer that names a model absent from model_list.
Task 10: PLAN DEFECT the implementer caught — the brief's recordingDocker double was
  insufficient: its inherited Inspect reported the container as nonexistent, so
  RestartWorkspace no-opped and the pinned-workspace Stop assertion was VACUOUS. They made
  Inspect report Exists/Running, then proved by mutation that both target tests fail under
  their intended inversions. Without that, T10's most important test was theatre.
Task 10: verified by controller — zero surviving non-test references to resolveModel,
  reapplyModel, RegisteredModel*, ModelSel, ModelTarget, EffectiveModel, SetModelOverride,
  ClearModelOverride, getModelOverride; the one applyModel hit is a doc-comment mention.
Task 10: minor (deferred): manager_test.go's testManager opens its registry with a live time.Now while the sibling helper uses a frozen clock — a future timestamp-checking test there would be flaky
Task 10: minor (deferred): ReapplyModelScope treats any GetAssignment error as "no explicit pin", swallowing a corrupt-read into "not pinned"
Task 10: technique discovered — the true gate can be run as root:
  docker run --rm -v "$PWD":/src -w /src golang:1.23 sh -c 'go vet ./... && go test ./...'
  gives zero failures module-wide, confirming the eight local failures are purely the
  host's lack of root. Recorded in constraints-proxy.md.
PHASE B COMPLETE: workspaces written from the inventory; both old systems gone; module green.

### T11 — Phase C begins

Task 11: review — spec ✅; 1 Important (plan-mandated), 3 minor, 2 ⚠️
Task 11: PLAN DEFECT the implementer caught — the brief's step 4 looped m.cfg.Agents, but
  config.Load DROPS disabled/removed agents from that map, so the loop would have silently
  orphaned exactly those agents' workspaces. They enumerated from disk instead
  (allExistingWorkspaces) and added TestMigrateCapturesAWorkspaceWhoseAgentIsNotInConfig,
  which fails against the brief's original loop. Reviewer verified the path parsing
  line-for-line against reconcile.go's existingWorkspaces: no mis-attribution risk.
  Controller applied the same correction to T12's drift check (parent commit 3108d66).
Task 11: controller adjudicated ⚠️ (dangling assignment) — SAFE. If the primary is
  unrecoverable and the assignment is `explicit`, Resolve fails at its model lookup and
  provision REFUSES, which is the "refused, not defaulted" invariant working as designed.
  If `inherited`, the cascade ignores it and the next materialization overwrites it.
Task 11: fix round 1/5 dispatched — read-error vs ENOENT conflation in captureWorkspaceModel
  (Important, plan-mandated: my reference code swallowed a real read failure into "never
  provisioned", so a workspace with a live model would silently end up unassigned and get
  re-resolved — the exact orphaning this task prevents), same shape in readLegacySel, plus
  the missing cross-source model_name collision-ordering test.
Task 11: fix round 1/5 (3 addressed, 0 open; commits 44f4fc8..50ef741) — reachability of
  the new error path proven with a real chmod 000 as uid 1003 and a RED/GREEN run against
  the actual pre-fix bug, with a t.Skipf guard so a root CI cannot false-pass
Task 11: complete (commits 02743fb..50ef741, review clean)
Task 11: minor (deferred): allExistingWorkspaces duplicates ~25 lines of glob/stat/split from reconcile.go's existingWorkspaces — a shared helper parameterized on the role segment would keep a future path-parsing fix in one place

### T12

Task 12: review — spec ✅; 1 Important (plan-mandated), 4 minor
Task 12: THIRD instance of the cfg.Agents defect, and the one the CONTROLLER missed.
  T11's implementer found it in the migration; I fixed checkModelDrift but overlooked
  normalizeDiskTemplates, which still looped m.cfg.Agents. A template used only by a
  disabled or removed agent would never be normalized — still carrying models, still
  looking like a place the truth lives. Plan text corrected at parent b952e8d (glob
  <dataRoot>/templates/*/config.json); fix round dispatched.
Task 12: fix round 1/5 dispatched — disk enumeration for normalization + a test that fails
  against the old loop; os.Stat error on the backup path now refuses to normalize rather
  than silently skipping the backup (the one failure mode this design cares most about);
  Reconcile doc comment updated.
Task 12: minor (deferred): drift_test.go sets m.cfg.Agents in a test that never reads it — inert setup carried from the brief
Task 12: minor (deferred): no test for the "template file missing" no-op branch
Task 12: fix round 1/5 (3 addressed, 0 open; commits bf1c983..075db66) — new test
  TestNormalizeDiskTemplatesCoversATemplateNoAgentDeclares confirmed to fail against the
  old loop; stat-error path now refuses to normalize before any write
Task 12: complete (commits 50ef741..075db66, review clean)
PHASE C COMPLETE: boot imports existing state, normalizes templates with backups, and
  reports drift read-only. No workspace's active model changes from migrating.
Controller applied design.md §2 correction itself (parent commit) so T13 can skip Step 10.

### T13 — Phase D begins

Task 13: review — spec ✅ on both weighted invariants (verified by direct code inspection,
  not just passing tests: PublicModel has no key-shaped field at all; api_key *string
  pointer semantics threaded through create and update). Quality: Needs fixes — 3 Important,
  2 minor.
Task 13: plan gap the implementer surfaced — PUT /v1/admin/models/{name}/status was in the
  reference code but missing from BOTH route tables (spec.md and the proxy spec). The
  webapp's enable/disable path calls it. Tables corrected.
Task 13: also corrected two stale spec claims found while there — the proxy spec still said
  APIKey is json:"-" on the wire type, and still required a deprecation replacement to be
  `active` rather than not-disabled.
Task 13: controller ruling on Finding 3 (Fallbacks overwritten unguarded, plan-mandated) —
  do NOT give Fallbacks pointer semantics. There is a principled distinction: api_key is the
  sole keep-on-absent field BECAUSE it is the only field a client can never read back. Every
  other field is readable via GET, so full-replace is coherent for them. Fix is to document
  the rule on modelRequest and pin it with a test asserting the intended full-replace
  behaviour, so it reads as chosen rather than overlooked.
Task 13: fix round 1/5 dispatched — tests for /usage and /status (both shipped untested, the
  first undisclosed), both added to the 403 gate table, plus the PUT-semantics documentation
  and pinning test.
Task 13: minor (deferred): handleAdminModelsList logs and swallows a per-model Referrers failure, reporting in_use_count 0 — the real guard runs in its own transaction so no unsafe delete, but the UI could show a false "0 in use"
Task 13: minor (deferred): GET /usage returns 200 with an empty array for a nonexistent model rather than 404 — pre-existing referrersTx behaviour, now reachable through a new route
Task 13: fix round 1/5 (3 addressed, 0 open; commits d2e6aae..488cf82)
Task 13: complete (commits 075db66..488cf82, review clean)

### T14

Task 14: DONE_WITH_CONCERNS — openapi.json had ZERO prior admin-route entries, so Step 7
  was 14 additions / 0 removals, not the brief's assumed 14/4, and there was no existing
  admin securityScheme to mirror. Plan inaccuracy, not a defect. The implementer flagged
  that T16 likely carried the same "brief assumes prior state that doesn't exist" risk.
  They were right — see T16 below.
Task 14: controller verified no response schema in openapi.json carries an api_key property
  (walked the parsed JSON), and the local gate holds.

### T16 — OBSOLETE, no work needed (verified by controller)

The implementer's T14 warning prompted an early check of T16's premise. It was wrong twice:
  1. The files MOVED. Parent commit 91c506d consolidated per-mode deploy config under
     deploy/, so fungi/mycelium/config.{base,standalone}.toml no longer exist. There are now
     THREE files: deploy/standalone/config.standalone.toml, deploy/prod/config.base.toml,
     deploy/dokploy/config.base.toml.
  2. The per-route enumeration is GONE, replaced by one wildcard per service:
     path = "/v1/admin/*" with methods = ["GET","POST","PUT","DELETE"]. Its own comment says
     the proxy enforces exact path+method per route. Verified in all three files (3/3/2
     wildcard blocks, all with the four methods).
Consequence: every route this feature adds is ALREADY routed, and there are no superseded
per-route entries to drop. Executing T16 would add redundant blocks beside a wildcard that
already covers them. Service names also changed (alpha/beta/hermes-glm, not picoclaw-*).
FR-33 and the traceability table amended at parent b475716. Task 16: complete (obsolete).
The gateway reload REMAINS a deploy step — not for new paths, but because a running gateway
holds its config in memory.
Task 14: review — spec ✅ on all three weighted requirements; 0 Critical, 0 Important,
  3 minor (openapi response-code gaps). Reviewer independently confirmed docker.ScopeTenant/
  ScopeSubscription and registry.Level* are real constant names (no drift), and that
  AuthorizeSharedScope's default case denies everyone — so a global/agent fallthrough bug
  would 403 even a proxy-admin, which is why the implementer's strengthened test discriminates.
Task 14: controller adjudicated ⚠️ — ClearModelAssignment DOES re-create the assignment as
  inherited: DeleteAssignment removes the record, so RecordMaterialization finds no prior
  assignment and writes SourceInherited. Holds by construction.
Task 14: minor (deferred): openapi PUT /model-defaults documents 404/409 that cannot fire (SetScopeDefault wraps both conditions in ErrInvalid -> 400)
Task 14: minor (deferred): openapi GET /model-defaults omits 400 though the shared authorizer returns it for a bad ?scope=
Task 14: minor (deferred): openapi DELETE /model-assignments omits 400 though the shared target resolver returns it for bad JSON/UUID
Task 14: complete (commits 488cf82..8ba67c4, review clean)

### T15

Task 15: review — spec ✅ on the rewrite; quality Needs fixes; 3 Important, 2 minor.
  Sharpest review of the run.
Task 15: PLAN DESIGN DEFECT (mine, unanticipated). Repointing validation at the inventory
  decoupled the accept-set from the apply-set. materializeModels writes a workspace's
  .security.yml model_list from only its resolved primary + chain and prunes the rest;
  setNativeSlot requires the model to be a key in that narrower map; applyNativeSecrets
  RETURNS on the first setNativeSlot error. So one native secret for an inventory-valid but
  workspace-unassigned model aborts the merge of EVERY slot in that overlay — including
  working web.* entries — on every ensure, permanently. Before the change the two sets were
  identical by construction (validation read the same file setNativeSlot writes).
Task 15: controller ruling — fix the APPLY path (skip, log, continue), not the validator.
  Narrowing validation would break the feature's purpose: a scope secret is written before
  anyone knows which workspaces will resolve to that model, and new ones appear later. Not a
  genuine fork; recorded as FR-32b in spec.md.
Task 15: reviewer caught a FAILED VERIFICATION CLAIM — the report asserted a grep confirmed
  no stale "template validates the slot" comments, but the grep excluded manager.go, where
  two of the three live, and missed one in shared.go itself. Named in the fix message: a
  report's verification claim is the evidence the controller acts on.
Task 15: reviewer also caught that the deleted TestValidateNativeSlot dropped one genuinely
  distinguishable case (model_list.<known>.other — a model_list-shaped slot whose last
  segment is not api_keys), contradicting the report's claim that both removed cases hit the
  same catch-all.
Task 15: fix round 1/5 dispatched.
Task 15: minor (deferred): sharedManager(t) fixture still builds a Manager with a nil registry — fixed in the one test body only; being closed in this fix round
Task 15: fix round 1/5 (4 addressed, 0 open; commits c142638..729cbaa) — sentinel
  errModelNotInWorkspace matched with errors.Is (not string matching); every other error
  still aborts; the skip is logged; the new test reads .security.yml back and proves the
  sibling web.brave slot lands, and was confirmed to fail against the old abort behaviour
Task 15: controller accepted a consequence the re-reviewer surfaced — the skip-and-log path
  now also covers WriteSecret's immediate-apply branch, so a native secret for an
  inventory-known but not-resolved-here model returns 200 with a log instead of 400. Correct:
  the credential IS stored in the overlay and will apply to any workspace that later resolves
  that model, so refusing the write would be wrong.
Task 15: minor (deferred): setNativeSlot now conflates a structurally corrupt model_list entry (non-map value) with "model not in this workspace", so it skips rather than aborts — the pre-fix code conflated the same two cases under one error, and the only writers never produce a non-map entry
Task 15: minor (deferred): the fix report's focused test command did not cover four tests whose call sites changed signature; the full-gate claim does cover them, but the focused run looked self-sufficient
Task 15: complete (commits 8ba67c4..729cbaa, review clean)
PHASE D COMPLETE: admin API open on the inventory; the third writer of model keys is closed.

### T17 — Phase F begins

Task 17: review — spec ❌ on one plan-mandated field omission; 2 Important, 1 minor.
Task 17: the implementer caught a contradiction in my brief — I told them to verify
  serializeDraft's blank-key behaviour while my own code made it module-private, hence
  untestable. They exported it and added three tests. Reviewer confirmed that was the right
  resolution, and that their `"api_key" in body` assertion discriminates where a
  toBeUndefined() check would not have.
Task 17: LIVE DATA-LOSS DEFECT (mine). extra_body is a readable wire field but my brief
  dropped it from ModelDraft, both draft builders and serializeDraft. Controller verified the
  proxy side the reviewer could not see: admin_models.go:140 does cur.ExtraBody =
  req.ExtraBody, an unconditional full replace. And it is not hypothetical — the embedded
  catalog's MiniMax entry carries extra_body {"reasoning_split": true}. An admin who
  registers it and later edits api_base would silently lose reasoning_split, changing
  picoclaw's behaviour with nothing in the UI to show it.
Task 17: fix round 1/5 dispatched — carry extra_body through opaquely (no form input; that
  is UI scope), plus tests that it survives both draft builders and is omitted from the body
  only when undefined. Plan text patched at the two later sites that build drafts from a
  model (T19's openEdit, T20's chain save), which had the same omission.
Task 17: minor (deferred): modelsApiError tests assert versionConflict/referrers structurally without pinning the literal message strings — brief's verbatim test, code correct
Task 17: fix round 1/5 (2 addressed, 0 open; commits 5540cdd..a47f896) — extra_body carried
  opaquely with a !== undefined guard (stricter than the api_key truthiness check, so a
  legitimately falsy value survives); regression verified by stashing lib/models.ts back and
  confirming three assertions fail
Task 17: complete (commits e8dab50..a47f896, review clean)

### T18

Task 18: complete (commits a47f896..69dd660, review clean)
Task 18: reviewer independently re-derived all 14 client-call -> BFF -> proxy mappings and
  confirmed every verb and path, plus encodeURIComponent at every point a name becomes a path
  segment. That audit substitutes for tests here: these routes have none, the proxy is not
  running, and a wrong path would only surface as a runtime 404.
Task 18: plan inaccuracy — app/api/admin/models/route.ts was listed as "create" but already
  existed, holding a dead GET-only handler for admin-model-override's selectable-models
  endpoint whose upstream T10 removed. Implementer grepped for callers, found none, overwrote;
  controller and reviewer both confirmed nothing was lost.
Task 18: NOTE FOR T19 — ModelStatus permits "deprecated" and setModelStatus accepts it, but
  the BFF status route always 400s on it by design. The panel must route retirement through
  deprecateModel, never setModelStatus("deprecated"). The plan already does this via the
  inline replacement picker.
Task 18: minor (deferred): models/route.ts POST/PUT forward the body minus agent/name without per-field checks, unlike the scope routes which build fresh objects — deliberate asymmetry (scope identifiers must not be reinterpreted; ordinary fields are the proxy's to validate)

### T19

Task 19: DONE_WITH_CONCERNS; panel rewritten, tsc and next build now fully clean (T17's
  intentional break closed). 87 tests green.
Task 19: controller RE-RATED the implementer's concern 3. They called the stale `replacement`
  state "a rejected request, not corruption". It is neither: deprecate A, pick B, then
  without cancelling click deprecate on C — `deprecating` becomes C while `replacement` stays
  B, which is a valid active model, so the button is ENABLED and one click retires C with a
  replacement never chosen for it. Nothing rejects it. That is a silent destructive action
  against the wrong target. Sent for fix before review, per the skill's rule that correctness
  concerns are addressed before the review gate.
Task 19: also sent for fix — the 409 referrer list is not rendered. The pre-emptive in-use
  badge is not a substitute: the 409 still fires when a referrer appears between the list
  loading and the click (another admin adding a fallback, a workspace materializing), and the
  admin currently sees a bare message instead of what to detach. Version-conflict message
  must also reach the user distinctly.
Task 19: deferred to final review — the agent picker is not picoclaw-filtered upstream, so a
  hermes agent could be routed to. Genuinely outside T19's scope (no brief code addresses it),
  but it collides with the constraint that the panel must not present the inventory as
  governing hermes agents.
Task 19: fix round 1 (2 addressed) then fix round 2 (3 addressed, 0 open;
  commits 69dd660..b834bf4). reorderPayload extracted pure and covered by a test that
  fails if ...inactive is dropped (asserts the name SET across both groups, not just a
  length an active-only payload could satisfy).
Task 19: controller REFUSED one reviewer finding — the replacement picker offering only
  active models is correct; my constraints wording conflated API-permits with UI-offers.
  Amended constraints-webapp.md and added FR-27c (parent aeac45d) instead of changing code.
Task 19: complete (commits 69dd660..b834bf4, review clean)

### T20

Task 20: review — spec ✅ on all seven semantics checks; 1 Critical, 1 Important, 2 minor.
Task 20: the implementer caught a bug my plan code had — FallbackEditor needed a React key,
  or React reuses the instance across target models, the useState initializer never re-runs,
  and switching targets would display and SAVE the previous model's chain onto the new one.
Task 20: the reviewer then answered the question I set — is that shape anywhere else? — and
  found it: ModelDefaultsPanel's `level` is initialised once from scope.kind and never
  resynced, while the component is designed to react to prop changes in place. Tenant ->
  subscription navigation leaves level="tenant", which stays SATISFIABLE because tenantId is
  present, so defaultScope resolves non-null to the tenant-wide scope. The admin, looking at
  one subscription with its per-user pins visible below, sets a default across every
  subscription under the tenant. Silent, broader than intended, no error.
Task 20: the implementer's report claimed this "fails safe" — true only for
  subscription -> tenant (guard fails, defaultScope null); false for the dangerous direction.
  Fix round dispatched: resync level on scope identity change (same remedy as the key fix,
  expressed as an effect since this component must keep reacting in place), plus extract
  resolveDefaultScope into a tested pure function — which is what would have caught it.
Task 20: minor (deferred): per-user pins allow deprecated models while the default select and fallbackCandidates restrict to active — verbatim brief code and defensible (a deliberate pin to a retiring model is legitimate; the resolver will not hop for an already-assigned workspace)
Task 20: minor (deferred): no test for model-row's onEditChain conditional render
Task 20: fix round 1/5 (2 addressed, 0 open; commits 3b6eba8..3b022f8) — resync effect keyed
  on scope identity only (level absent from the deps, so a manual choice survives within a
  scope); resolveDefaultScope extracted pure with 6 tests including the
  tenant-level-against-subscription-scope combination the effect exists to prevent
Task 20: the implementer also corrected their own round-1 "fails safe" claim in the report
  rather than leaving it standing — the reviewer verified the correction is substantive and
  direction-qualified, not a restatement.
Task 20: complete (commits b834bf4..3b022f8, review clean)

### T21

Task 21: review — spec ✅ on every requirement; 1 Important, 2 minor.
Task 21: THIRD instance of "the brief assumes prior state that doesn't exist" (after T14's
  openapi and T16's gateway). My brief said the panel sourced model names from a template. It
  had no picker at all — only free-text inputs; a picker had been removed in earlier commits.
  Controller verified against 3b022f8. The implementer rebuilt the picker rather than swapping
  a data source, which was necessary: a free-text field cannot satisfy "offers inventory names
  and nothing else". Reviewer judged the expansion proportionate.
Task 21: reviewer credited three things beyond the literal ask — resetting modelName when
  routedAgent changes (so a name from one agent's inventory cannot silently carry to another),
  an all-agents gate grounded in the proxy's own checkSharedSecretFormat rejection, and
  catching a now-false "use the Model tab instead" hint on the web sub-slot.
Task 21: fix round 1/5 dispatched — a listModels failure renders identically to a legitimately
  empty catalog and to still-loading, with nothing telling the admin to retry. Different admin
  actions (retry vs. go register a model) must not collapse into one UI state.
Task 21: minor (deferred): listModels is fetched on every routedAgent change even while the web sub-slot is selected
Task 21: minor (deferred): FORMAT_LABEL.native wording is cramped
Task 21: fix round 1/5 (1 addressed, 0 open; commits 7d7f3f8..0332706)
Task 21: complete (commits 3b022f8..0332706, review clean)
PHASE F COMPLETE. ALL 21 TASKS COMPLETE.

## Final verification (controller)

Proxy: go mod tidy promoted bbolt from indirect to direct (it entered via go get before any
  code imported it). Real gate as root in golang:1.23 — ZERO failures module-wide. Locally,
  only the eight documented chown failures.
Webapp: tsc clean, 112 tests, next build compiled.
api_key audit: only the request-body *string pointer and comments in internal/httpapi.
AD-013 recorded in .specs/project/STATE.md.

## Whole-branch review (opus) — THREE CRITICAL, all cross-task

C-1: the MIGRATION performed the exact overwrite the feature exists to remove.
  captureWorkspaceModel recorded `inherited` unless a legacy .crab-model.json existed, but
  candidateTx honours only `explicit`. Controller VERIFIED both halves: resolve.go:116 requires
  explicit, and the deleted registered_models.go had ZERO references to UserModelOverrideFile.
  So every user whose model an admin set through the old registry UI would be silently
  re-resolved to a scope default on the next start, or refused. Falsified AC-17's second
  clause and design §7's own justification for step 4.
C-2: config.yaml-seeded records got model=model_name and no api_base (BaseURL is hermes-only),
  and importLegacyModel was first-wins so nothing corrected them — while the doc comment
  claimed later-wins. The template's model_name != model for most entries.
C-3: applyNativeSecrets ran at provision.go:86, BEFORE resolveAndMaterialize at manager.go:206.
  Controller verified the ordering. materializeModels' setModelListEntry + prune always
  overwrote a scope admin's key with the inventory key, permanently. Inverted FR-32/CTX-MR-12
  and made T15's whole errModelNotInWorkspace mechanism address a precedence that never
  happened.
Plus 6 Important including FR-27's per-user indicator, which NO TASK had implemented — the one
  spec requirement the 21 task reviews all missed.

ONE consolidated fix wave (opus, 8 commits across both repos), then ONE scoped re-review (opus).
All findings ADDRESSED. Two implementer deviations both judged sound:
  - C-2's prescribed catalog join was IMPOSSIBLE: the catalog deliberately carries no
    model_name (T09 dropped it so the admin is never handed a colliding name). My fix
    instruction was wrong; they used the per-instance disk template, which holds the full
    mapping at step 1 and has a .pre-registry backup for re-runs.
  - C-1 deviates from FR-22's literal wording; reproducibility decides. Sound BECAUSE I-4
    shipped in the same wave — without the pin indicator it would have been a silent fleet
    freeze with no discovery path.
  - main.go making a migration failure fatal: correct, on better grounds than argued — the
    only error paths left are the bbolt read/write, i.e. an unusable DB, where every provision
    would be refused anyway. Cannot crash-loop on a bad template.

RESIDUAL (surfaced to the human at the finishing step, per the skill's no-second-wave rule):
  MEDIUM — migrate_models.go refineLegacyModel corrects cur.Model outright with no
  last-writer guard. Two workspaces with the same model_name and different model ids means
  the last one iterated wins and changes the other's active model: an AC-11 violation
  introduced by the fix wave. One-condition remedy: correct model only when
  cur.Model == cur.ModelName, which IS the config.yaml placeholder signature C-2 repairs.
  Three LOW residuals also recorded in the re-review.

## Final one-condition fix (user-directed) — commit 5f6fc21, re-review clean

Guard added: the model id is corrected only while it carries the config.yaml placeholder
(cur.Model == cur.ModelName). RED shown both ways. C-2's own tests pass unchanged.
Implementer added a log for the declined id beyond the prescribed guard — reviewer judged it
warranted and proportionate, since glob order was silently choosing between two legitimate
workspaces and that call belongs to an admin.

Reviewer CORRECTED the implementer's "unavoidable residual" framing: FR-3 is uniqueness of
model_name as a key and does not forbid minting a second derived name for the divergent
workspace, so the residual is UNADDRESSED, not unavoidable. Deferring is still reasonable —
a synthetic name would force that assignment to `explicit` (FR-22), pulling it out of AC-7
sweeps, and would rename its credential slot — but it is a deferred option, not an
impossibility. Recorded that way in AC-11.

Reviewer also found (Low): step 2's registered-models import runs BEFORE step 4 reads live
workspaces, so a stale legacy registry entry can consume the placeholder before a live
workspace's own correct id is ever seen — a cost of the first-writer-wins guard I prescribed,
not of the fix. Logged and admin-actionable. Documented in AC-11.

VERDICT: Ready to merge. Gates: proxy real gate (root, golang:1.23) zero failures; local only
the eight documented chown failures; webapp tsc clean, 112 tests, next build compiled.
