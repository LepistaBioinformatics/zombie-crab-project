# hermes-agent Removal Specification

**Status:** **Approved for execution.** OD-1 resolved as **Option A**. See
§Execution Decisions and §Baseline Refresh — the original mapping below is kept verbatim as the
historical record, and every line number in it is superseded by the refresh.

**Decision this encodes:** Hermes (Nous Research `hermes-agent`) is withdrawn from the project for
**compatibility with the current infrastructure**, and demoted to a **future implementation**. The
feasibility investigation, the specs, and the runtime knowledge earned during the live E2E are
**kept**; only the shipped surface is withdrawn.

---

## Baseline

Mapped against these exact revisions, and **re-verified unchanged at the end of the mapping
session**. Note that both submodules moved *during* it (concurrent PR work), so treat every line
number here as indicative: re-run the greps in §Verification before editing anything.

| Repo | Revision at mapping | Notes |
|---|---|---|
| `zombie-crab-project` (root) | branch `chore/catch-pointers-up-to-merges` | working tree clean apart from submodule pointers |
| `crab/crab-shell-proxy` | `372fce9` on `main` | `chat-progress-events` has landed: `turn.Sink`/`turn.Progress` exist and `Turner.RunTurn` takes a sink |
| `crab/crab-exoskeleton-webapp` | `2dc9de5` on `feat/sidebar-panel-navigation` | **15 modified files, uncommitted.** `agent-first-admin` has landed, which widened the webapp's harness surface considerably |

**Where the implementation lives, for recovery:** `crab-shell-proxy` commits `d2f0a9a`
(multi-harness support + Hermes), `748e0fe` (gate hermes agents on their secrets), `3e9e95c`
(model administration rejects non-picoclaw agents).

---

## Execution Decisions

Taken at the start of the execution session, after re-deriving the baseline. These close OD-1 and
the two questions the spec could not anticipate.

| # | Decision | Rationale |
|---|---|---|
| **ED-1** | **OD-1 = Option A.** The Hermes profile goes; the generic harness seam stays dormant with `picoclaw` as its only legal value. | `chat-progress-events` built `turn.Sink` on that seam and it is in-tree; the `harness` field is a live admin-API contract the webapp reads; Option B would delete the three model-scope rejection tests along with the gate they cover (a coverage loss, not a simplification) and would edit live registry-import code (`migrate_models.go` reads `mc.BaseURL` into `APIBase`) for no behavioural gain. |
| **ED-2** | **Dead guards are deleted, not left returning `true`.** `projectsSupported`, `userModelsSupported` and the `Harness != HarnessHermes` term in the persona/project bind-drift case all go, with their call sites collapsed. | With Hermes gone all three are constant-true. Keeping a trivially-true predicate is exactly the speculative scaffolding the project's coding rules forbid. The two `501 Not Implemented` responses they guarded become unreachable and are removed with them. |
| **ED-3** | **Branch off `main`, three PRs.** `chore/hermes-removal` in root, proxy and webapp, each based on `origin/main`. | All three repos had `feat/user-owned-models` **already merged into `origin/main`** at the start of this session, so branching off `main` is conflict-free *and* still contains the drifted surface (`projects.go`, `user_models.go`). The stacked-PR downside the question weighed does not materialise. |
| **ED-4** | The webapp's `projects_unsupported` / 501 client handling is **kept**. | ED-2 removes the server-side 501, but a deployed older proxy still returns it. This is the same back-compat argument that preserves the absent-`harness` case (P2 AC-2). Annotated, not deleted. |

## Baseline Refresh

Re-derived at execution time. **The original §Baseline is stale — use this table.**

| Repo | Revision | Working tree |
|---|---|---|
| `zombie-crab-project` (root) | `chore/hermes-removal` off `origin/main` = `5190f25` | clean |
| `crab/crab-shell-proxy` | `chore/hermes-removal` off `origin/main` = `3250b32` | clean |
| `crab/crab-exoskeleton-webapp` | `chore/hermes-removal` off `origin/main` = `86f1f65` | clean |

### What the drift changed

1. **TRAP-3 has dissolved.** The webapp tree is clean; there is no in-flight work to collide with.
   P2 stays P2 by priority (nothing in it is *wrong* after P1) but it is no longer *blocked*, so it
   ships in this same cut.
2. **There is a THIRD mycelium TOML.** `deploy/dokploy/config.base.toml`, plus
   `deploy/dokploy/.env.example`. HRM-28/29 covered only `prod` and `standalone`. Dokploy already
   ships without a `[[hermes-glm]]` service block but carries Hermes *commentary* and dead-var
   notes. → HRM-52.
3. **HRM-24 is already satisfied.** The proxy's `config.yaml` declares only `alpha` and `beta`; the
   `hermes-glm` agent block is gone from it already. Nothing to cut.
4. **Two NEW live runtime gates appeared** — code, not comments: `internal/httpapi/projects.go:66,85,226,258`
   and `internal/httpapi/user_models.go:47-51,63`. → HRM-53, HRM-54 (resolved per ED-2).
5. **A new Hermes exclusion in the recreate path**: `internal/docker/manager.go:307-315`, the
   persona/project bind-drift case. → HRM-55 (resolved per ED-2).
6. **The `hermes` references in the two live TOMLs multiplied** well beyond the single service block
   HRM-28/29 describe — `config.standalone.toml` also at 7, 122, 136, 230-231, 311-312, 460-461,
   531-532, and `deploy/prod/config.base.toml` similarly. → folded into HRM-28/29.
7. **`docker-compose.dokploy.yaml` grew a Hermes comment block** at 87-89 on top of the HRM-32 line.
8. **Far more spec docs mention Hermes than HRM-47 lists.** → HRM-56 sets one uniform policy.
9. **New minor comment sites**: `internal/docker/provision.go:51`, `internal/docker/persona_test.go:321`,
   `internal/httpapi/handlers.go:232`, `lib/projects.ts:60`, `app/api/projects/route.ts:10`,
   `app/chat/use-projects.ts:58`, `app/chat/projects-bar.tsx:76`. → HRM-57.

### Pre-existing gate failures — measured, not assumed

Captured **before** any edit, so the after-state is comparable. Both are pre-existing and unrelated
to Hermes; neither may be treated as caused by this change, and neither may be used to excuse a new
failure.

| Gate | Baseline result |
|---|---|
| proxy `go build ./...` | clean |
| proxy `go vet ./...` | clean |
| proxy `go test ./...` | **`internal/docker` FAILS**: 9 tests, all `lchown … operation not permitted` (sandbox cannot chown). Every other package passes. |
| webapp `vitest run` | **green — 56 files, 776 tests** |
| webapp `tsc --noEmit` | **6 pre-existing errors**, all in test files, all about `project` / `sessionKey` optionality: `app/chat/{canvas-activity,conversation-bursts,conversation-filter,history-cache}.test.ts`, `app/chat/scheduled-tasks.test.tsx`. The spec's "tsc clean" gate is **not achievable** at baseline; the real gate is "still exactly these 6". |

---

## Problem Statement

`crab-shell-proxy` can orchestrate two agent runtimes: picoclaw (Pico Protocol over WebSocket) and
Hermes (OpenAI-compatible HTTP API on :8642). The Hermes path works end-to-end — it was verified
live — but it does not fit the infrastructure the project actually runs on: the container needs a
180s startup deadline against a 35s global health-wait, it must run `gateway run` with
`GATEWAY_ALLOW_ALL_USERS=true`, its turns are slow enough to sit near the gateway's 60s timeout, and
it pulls a heavyweight image (71 skills + chromium under s6) per user. Carrying it means every
layer — config, admin API, model inventory, webapp tab logic, two mycelium TOMLs, two compose files
— keeps a second branch that no deployment exercises.

The cost is not the code volume. It is that "agent" now means two things in every reader's head,
and every future change pays that tax.

## Goals

- [ ] No Hermes surface remains in any shipped artifact: no agent block, no mycelium service, no
      container spec, no turner, no env var, no admin branch.
- [ ] **Zero picoclaw regression.** Every existing picoclaw workspace keeps working, unchanged, with
      no re-provisioning and no container recreation required by this change alone.
- [ ] The decision is recorded where a future reader will hit it, with the reason ("current infra
      compatibility") and the commits that hold the implementation.
- [ ] The knowledge that is expensive to re-derive — the runtime findings from the live E2E — is
      written into the repo, not left in a session transcript.
- [ ] Re-adding Hermes later is bounded work with a written starting point.

## Out of Scope

| Excluded | Reason |
|---|---|
| Deleting `.specs/features/multi-harness-support/` (root + proxy) | It is the future-implementation record. It gets a status banner, not a delete. |
| Rewriting `investigation.md` | Its feasibility analysis stays valid. Only its status header changes. |
| Any reference to `zero-scale-stateless-hermes-agent.md` | **Different meaning.** That is the name of picoclaw's scale-to-zero *architecture pattern* — see TRAP-1. |
| The webapp's landing-page "harness" copy | Marketing prose about the product being "an AI harness stack" — unrelated to `Agent.harness`. See TRAP-2. |
| Building cleanup for dangling mycelium `hermes-glm` guest-role grants | Documented as a known residue (HRM-48), not automated. |
| Reverting the `defaulttemplate/<harness>/` directory layout | Pre-existing scaffolding, predates Hermes (`provision.go:46-47` TODO). |
| Purging existing per-user Hermes workspaces on disk | None exist (`data/tenants` is empty, no Hermes container or image present locally). Covered as a conditional operator step, HRM-49. |

---

## OD-1: ✅ RESOLVED — Option A (see ED-1)

*The fork below is kept for the reasoning it records. It no longer blocks anything.
Requirements marked `[OD-1:B]` are **out of scope** and stay unimplemented: HRM-23, the field
removals in HRM-21/22, and the deletions in HRM-26/27.*

### OD-1: Open Decision — how deep does the removal cut? ~~⚠️ BLOCKS EXECUTION~~

The **Hermes profile** goes either way. What is undecided is the **generic harness seam** underneath
it. This is the only real fork, and it must be answered before task breakdown.

**Recommendation: Option A.**

### Option A — remove the profile, keep the seam dormant (recommended)

Keep `Agent.Harness` (validated, `picoclaw` the only accepted value), `turn.Request`/`turn.Sink`,
the `Turner` interface, `docker.Target.Harness`, `harnessPort`/`endpoint`, and the
`defaulttemplate/<harness>/` layout. Delete every Hermes-specific branch inside them.

- **For:** picoclaw flows *through* these paths today (`manager.go:271,289`, `handlers.go:481`,
  `sse.go:106`), so touching them is the risky part, not the Hermes code. The `harness` field is a
  **live API contract**: `admin.go:112` publishes it, `openapi.json:1150` documents it, and the
  webapp consumes it in `lib/admin.ts:49` and `app/admin/agent-scope.ts` to decide which admin tabs
  an agent offers. Re-adding Hermes becomes "write the profile".
- **Against:** leaves a discriminator with one legal value — scaffolding for a thing that was just
  removed, which reads as dead weight to a newcomer.

### Option B — revert the seam too

Additionally drop `Agent.Harness`, `internal/turn`'s harness framing, `turnerFor`,
`Target.Harness`, `ModelConfig.BaseURL`/`KeyEnvName`, and the `harness` field in the admin API.

- **For:** genuinely smaller codebase; no vestigial abstraction.
- **Against:** it is a refactor across the whole picoclaw turn path (regression risk on the one
  runtime that must not break), it **breaks the admin API contract** so the webapp must change in
  the same cut (colliding with 15 uncommitted files, TRAP-3), and `chat-progress-events` just built
  `turn.Sink` on top of that seam. Also note `migrate_models.go:84` reads `mc.BaseURL` into the
  model registry's `APIBase` — removing the field means editing live registry-import code for no
  behavioural gain.

**Every requirement below marked `[OD-1:B]` applies only if Option B is chosen.**

---

## Traps — verified, and each one has bitten a naive `grep`/`sed`

**TRAP-1 — "hermes" is two different things.** `.specs/project/ROADMAP.md:97` and
`.specs/project/STATE.md:190` refer to the file `zero-scale-stateless-hermes-agent.md`, which names
**picoclaw's scale-to-zero architecture**. A blanket substitution silently rewrites picoclaw's
architecture record. Only `STATE.md:57-60` ("**Hermes still reads it**") is the Nous product.
**Each of the three must be judged individually.**

**TRAP-2 — "harness" false positives in the webapp.** `lib/i18n/landing.ts:54,124,174,241`,
`components/landing/diagrams.tsx:130` and `landing.module.css:477` use "harness" as **product
marketing copy** ("An AI harness stack by Lepista Bioinformatics"), in both en and pt-BR. Untouched.

**TRAP-3 — the webapp submodule has live uncommitted work.** 15 modified files on
`feat/sidebar-panel-navigation`, and `app/admin/admin-screen.tsx` is both dirty and a Hermes-comment
file. Webapp requirements are therefore **P2 and sequenced last** (HRM-20..24).

**TRAP-4 — `DisabledAgents` dies with Hermes.** Both append sites (`config.go:261`, `:291`) are
inside `Harness == HarnessHermes` branches. Remove Hermes and the mechanism can never fire: the
field, its doc comment, and the startup log at `main.go:37-38` become dead. Its *behaviour* — an
agent self-disabling when its deployment lacks its secrets — is worth preserving in the decision
record (HRM-40), because a re-add will want it back.

**TRAP-5 — deleting test fixtures can silently drop coverage.** `admin_model_scopes_test.go` uses a
Hermes agent as the *only* non-picoclaw fixture for three tests that assert the model-inventory
rejection path. Under Option A that gate still exists and must stay covered — rewrite the fixture
against a synthetic harness value, do not delete the tests. The fixtures build `config.Agent`
structs in-memory, bypassing `Load` validation, so an arbitrary value works.

**TRAP-6 — `deploy/standalone/.env` holds a real z.ai key.** Gitignored via `deploy/**/.env`
(`.gitignore:5`), confirmed by `git check-ignore`. Never commit it, never echo its contents.

**TRAP-7 — `"hermes-glm"` as a pure string fixture.** `components/ui/avatar.tsx:62` and
`components/ui/avatar.initials.test.ts:9` use the literal `"hermes-glm"` only as a sample identifier
for initials extraction (it reads as `HG`). It has nothing to do with the harness, and the test
asserts on the string, so rewriting it would change a passing test for no reason. **Untouched, and
an explicit grep survivor.** Found during execution, after the original mapping.

---

## User Stories

### P1: Hermes leaves the shipped surface ⭐ MVP

**User Story:** As an operator, I want the stack to declare and orchestrate picoclaw only, so that
there is one runtime to reason about and no dormant second path in config, routing, or admin.

**Why P1:** This is the request. Partial removal is worse than none — a half-removed harness leaves
config referencing code that is gone, or code reachable by config nothing declares.

**Acceptance Criteria**

1. WHEN the proxy starts against the shipped `config.yaml` THEN it SHALL register only picoclaw
   agents, and SHALL NOT log any disabled-agent line.
2. WHEN `config.yaml` declares `harness: hermes` for any agent THEN `Load` SHALL reject it with an
   error naming the accepted value(s) — a stale operator config must fail loudly, not boot into a
   code path that no longer exists.
3. WHEN an agent block **omits** `harness` entirely THEN it SHALL still default to picoclaw
   (`config.go:268-269`). Only *unknown* values fail. Every shipped agent block omits the field, so
   tightening validation to require it would break all of them.
4. WHEN mycelium loads either deploy TOML THEN no `hermes-glm` service, secret, or path SHALL be
   declared, and the picoclaw services (`alpha`, `beta`) SHALL be byte-identical to before.
5. WHEN an existing picoclaw workspace receives a turn after the change THEN the turn SHALL succeed
   with no container recreation and no re-provisioning.
6. WHEN `grep -ri hermes` runs across both repos THEN the only surviving hits SHALL be spec/doc
   files, the two `zero-scale-stateless-hermes-agent.md` pattern references, and (until P2 lands)
   the webapp.

**Independent Test:** boot the stack, sign in, chat with `alpha` through the gateway; then add
`harness: hermes` to a `config.yaml` copy and confirm `Load` refuses it.

---

### P1: the decision and the hard-won knowledge survive ⭐ MVP

**User Story:** As the next person to consider Hermes, I want to find why it was removed and
everything already learned, so that I neither re-litigate the decision nor re-derive the runtime
findings by debugging a container that boots and dies.

**Why P1:** The user asked for exactly this. It is also the only part of the work that git cannot
give back — a deleted file is recoverable from `d2f0a9a`, but *why `gateway run` instead of the
image default* is not written down anywhere in the repo.

**Acceptance Criteria**

1. WHEN a reader opens `.specs/features/multi-harness-support/` in either repo THEN a status banner
   SHALL state that the feature was implemented, verified live, and then withdrawn, with the reason
   and the recovery SHAs.
2. WHEN a reader looks for the runtime findings THEN a document SHALL record, at minimum: the
   `Cmd: ["gateway","run"]` requirement and what happens without it; the 180s startup deadline
   versus the 35s global health-wait; `GATEWAY_ALLOW_ALL_USERS=true` and why it is safe per-user;
   `model.base_url` being required for OpenAI-compatible providers; the provider-specific key env
   name (`GLM_API_KEY` for provider `zai`) not being derivable; the absence of any API-only mode;
   the `state.db` session/message schema; and the unresolved turn-latency problem.
3. WHEN `.specs/project/STATE.md` is read THEN it SHALL carry a decision entry for the removal, and
   its claim at `STATE.md:57-60` that "**Hermes still reads it**" SHALL be corrected — with the
   caveat it documents (that `config.yaml`'s `agent.Model` is a migration seed with no runtime
   effect) preserved, since that is now unconditionally true.
4. WHEN `.specs/project/ROADMAP.md` is read THEN multi-harness support SHALL appear as deferred, and
   line 97 SHALL be unchanged (TRAP-1).

**Independent Test:** a reader who has never seen this work can answer "why was Hermes removed?",
"where is the code?", and "what will bite me if I re-add it?" from the repo alone.

---

### P2: the webapp stops branching on Hermes

**User Story:** As a webapp maintainer, I want the admin UI to stop carrying Hermes-specific
branches, so that per-agent tab logic is not shaped by a runtime that no longer exists.

**Why P2, not P1:** nothing here is *wrong* after P1 — `agent-scope.ts` filters on
`harness === "picoclaw"`, and every agent now reports `picoclaw`, so the behaviour is already
correct. It is stale comments, a badge that stops rendering, and test fixtures for an impossible
value. And it collides with 15 uncommitted files (TRAP-3). **Under OD-1 Option B this is promoted to
P1**, because dropping the API field breaks the contract the webapp reads.

**Acceptance Criteria**

1. WHEN the admin screen renders an agent THEN it SHALL NOT depend on a Hermes-specific branch to
   pick its tab set.
2. WHEN the webapp test suite runs THEN no fixture SHALL assert Hermes-specific behaviour, and the
   "absent harness counts as picoclaw" back-compat case SHALL be kept — an older proxy still reports
   no harness at all.
3. WHEN the landing page renders THEN its "harness" copy SHALL be untouched in both locales
   (TRAP-2).
4. WHEN this work starts THEN it SHALL be a separate branch off whatever the webapp's committed HEAD
   is at that moment, never a mutation of the in-flight working tree.

**Independent Test:** `next build` + `tsc` clean, vitest green, landing page visually unchanged in
en and pt-BR.

---

### P3: operational residue is named

**User Story:** As an operator, I want to know what the removal leaves behind in live state, so that
I can decide what to clean up by hand.

**Acceptance Criteria**

1. WHEN the removal is deployed THEN the known residue SHALL be documented: mycelium accounts still
   holding the auto-declared `hermes-glm` guest-role grant, any per-user Hermes workspace directory,
   any pulled `nousresearch/hermes-agent` image, and the dead vars in a local `deploy/*/.env`.
2. WHEN an operator reads that list THEN each item SHALL say whether it is harmless-if-ignored.

---

## Requirements

### A. Proxy — files deleted outright

| ID | File | Size | Note |
|---|---|---|---|
| HRM-01 | `internal/hermes/turn.go` | 128 L | the OpenAI-passthrough turner |
| HRM-02 | `internal/hermes/turn_test.go` | 73 L | its httptest coverage |
| HRM-03 | `internal/docker/provision_hermes.go` | 216 L | profile seeding, API-key persistence, `createHermes` |
| HRM-04 | `internal/docker/defaulttemplate/hermes/config.yaml` | 16 L | bundled fallback profile |
| HRM-05 | `internal/docker/defaulttemplate/hermes/SOUL.md` | 3 L | bundled persona |

### B. Proxy — Hermes branches removed from shared files

| ID | Location | What |
|---|---|---|
| HRM-06 | `cmd/crab-shell-proxy/main.go:19,61` | `internal/hermes` import and the `Hermes:` server-field wiring |
| HRM-07 | `cmd/crab-shell-proxy/main.go:37-38` | the `DisabledAgents` startup log (dead — TRAP-4) |
| HRM-08 | `internal/config/config.go:45-52` | `HarnessHermes` constant and its doc |
| HRM-09 | `internal/config/config.go:199-201,341-342` | `Config.HermesImage` field and its `nousresearch/hermes-agent:latest` default |
| HRM-10 | `internal/config/config.go:104-108` | `ModelConfig.KeyEnvName` (only consumer is `provision_hermes.go:177`) |
| HRM-11 | `internal/config/config.go:257-261,282-291` | Hermes secret-gating branches, and with them `DisabledAgents` (`:231-235`) |
| HRM-12 | `internal/config/config.go:397-401` | harness validation: accept `picoclaw` (and `""`) only; error text updated |
| HRM-13 | `internal/config/config.go:97,100-103,115-117,132,214` | doc comments naming hermes; `Harness` field kept under OD-1:A |
| HRM-14 | `internal/docker/manager.go:55-57,153-156,172-173` | `hermesAPIPort`, and the Hermes branch in `harnessPort`/`endpoint` |
| HRM-15 | `internal/docker/manager.go:217-222,253-254` | `provisionHermes` and `createHermes` call sites in `EnsureRunning` |
| HRM-16 | `internal/docker/manager.go:62-69,277,289` | `Target` doc comments; `Harness` field kept under OD-1:A |
| HRM-17 | `internal/httpapi/handlers.go:165-167,176-179,186-189,196-200` | `Hermes Turner` field, `turnerFor`, and `turnModelFor`'s Hermes branch |
| HRM-18 | `internal/httpapi/handlers.go:481`, `internal/httpapi/sse.go:106` | dispatch sites: `turnerFor(tgt.Harness)` collapses to the picoclaw turner |
| HRM-19 | `internal/docker/migrate_models.go:63,139-140` | comments explaining Hermes-shaped inputs to the registry migration |
| HRM-20 | `internal/docker/provision.go:46-47` | stale "thread the harness once multi-harness lands" TODO — now resolved either way |
| HRM-21 | `internal/turn/turn.go:1-28,51` | field docs framed as picoclaw-vs-hermes — **comment-only under OD-1:A**. `SessionKey`/`Model` become unused-by-any-runtime, but deleting them also means deleting their two populators (`handlers.go:481`, `sse.go:106`) and `turnModelFor`, which is seam surgery, not profile removal: **field removal is `[OD-1:B]`** and otherwise deferred, so Option A does not drift into Option B by accident |
| HRM-22 | `internal/httpapi/admin.go:108-112`, `admin_model_scopes.go:41-51,61`, `openapi.json:1150` | the "inventory governs picoclaw only" gate: comments corrected under OD-1:A; **field and gate removed** under `[OD-1:B]` |
| HRM-23 | `internal/docker/default_template.go:12-28` | `[OD-1:B]` only — drop the `harness` parameter from `materializeDefaultTemplate` |
| HRM-24 | `config.yaml:84-107` | the `hermes-glm` agent block; it is the last agent in the file and runs to EOF, so the cut is clean |

### C. Proxy — tests

| ID | Location | What |
|---|---|---|
| HRM-25 | `internal/config/config_test.go:433-495` | delete `hermesSample`, `TestHermesDisabledWhenSecretsMissing`, `TestHermesEnabledWhenSecretsPresent`; add a case pinning HRM-12 (an unknown harness is rejected) |
| HRM-26 | `internal/httpapi/admin_model_scopes_test.go:191-284` | rewrite the `hermesService` fixture to a synthetic non-picoclaw value, keeping all three rejection tests and `TestAdminAgentsReportsTheHarness` (TRAP-5). Under `[OD-1:B]` these tests are deleted with the gate they cover, and that loss SHALL be stated in the commit message. |
| HRM-27 | `internal/docker/migrate_models_test.go:225`, `internal/httpapi/sse_progress_test.go:61` | comment and `Harness:` fixture value; the latter only under `[OD-1:B]` |

### D. Root repo — deploy and compose

| ID | Location | What |
|---|---|---|
| HRM-28 | `deploy/prod/config.base.toml:350-457` | delete the whole `hermes-glm` mycelium service block; it runs to EOF, so the cut is clean |
| HRM-29 | `deploy/standalone/config.standalone.toml:414-521` | same, also to EOF |
| HRM-30 | `deploy/standalone/.env.example:29,34-35` | drop `MYC_HERMES_GLM_TOKEN` and `PROXY_GLM_API_KEY` with their comments |
| HRM-31 | `docker-compose.yaml:108-110,116-118` | drop the `MYC_HERMES_GLM_TOKEN` and `PROXY_GLM_API_KEY` passthroughs and their comments |
| HRM-32 | `docker-compose.dokploy.yaml:123-124` | the comment cites "drop hermes-glm" as the example customization — reword |
| HRM-33 | `deploy/dokploy/crab-shell-proxy.config.yaml:4-10` | the header explains that the upstream default's `hermes-glm` was removed *here*; upstream no longer has one, so the whole note goes, including the now-false claim that a Hermes agent auto-disables without its secrets (HRM-11 removes that mechanism) |
| HRM-34 | `deploy/standalone/.env` | **gitignored, holds a real key (TRAP-6).** Dead vars removed as a local hygiene step, never committed. Operator-owned; may be skipped. |

### E. Webapp — P2, sequenced last

| ID | Location | What |
|---|---|---|
| HRM-35 | `lib/admin.ts:38-49` | `Agent.harness` field doc and `picoclawAgentKeys`; the filter itself stays under OD-1:A (it still correctly passes every agent) |
| HRM-36 | `app/admin/agent-scope.ts:39,52` | comments explaining why a Hermes agent gets no `model` tab |
| HRM-37 | `app/admin/agent-scope.test.ts:6-69` | the `hermes-glm` fixture and the "withholds the model registry from a hermes agent" assertions; **keep** the absent-harness back-compat case |
| HRM-38 | `lib/admin.test.ts:68-79` | same shape: `{ key: "nous", harness: "hermes" }` fixture |
| HRM-39 | `app/admin/agent-gate.tsx:69`, `app/admin/admin-screen.tsx:265`, `lib/tools.ts:2` | the harness `<Badge>` (renders nothing once every agent is picoclaw — decide badge vs. removal) and two comments |

### F. Documentation and preservation

| ID | Artifact | What |
|---|---|---|
| HRM-40 | `.specs/features/hermes-removal/DECISION.md` (new, root) | the record: reason (current-infra compatibility), what was withdrawn, recovery SHAs `d2f0a9a`/`748e0fe`/`3e9e95c`, the OD-1 choice actually made, and the residue list |
| HRM-41 | `.specs/features/multi-harness-support/implementation-notes.md` (new, proxy) | the runtime findings (P1 story 2, criterion 2) — the only content git cannot hand back usefully |
| HRM-42 | `.specs/features/multi-harness-support/spec.md` + `investigation.md` (root) | status banner: implemented → verified live → withdrawn; cross-link to HRM-40 |
| HRM-43 | `.specs/features/multi-harness-support/design.md` + `tasks.md` (proxy) | same banner |
| HRM-44 | `.specs/project/STATE.md:57-60` | correct the "**Hermes still reads it**" claim; add the removal decision entry |
| HRM-45 | `.specs/project/ROADMAP.md` | mark multi-harness deferred. **Line 97 untouched** (TRAP-1) |
| HRM-46 | proxy `.specs/project/{ROADMAP,STATE}.md` | the same two edits on the submodule's own project docs |
| HRM-47 | proxy `.specs/features/chat-progress-events/spec.md:75-80`, webapp `.specs/features/chat-responsiveness/{design.md:119-126,tasks.md:182-189}` | both name `internal/hermes` as a second `Turner` implementation that must be kept in sync ("do not let the interface change break the hermes path silently"); annotate as historical rather than rewriting shipped specs |

### G. Operational residue — documented, not automated

| ID | Item | Harmless if ignored? |
|---|---|---|
| HRM-48 | mycelium accounts holding the auto-declared `hermes-glm` guest-role after the TOML block goes | Yes — a grant to a service that no longer routes |
| HRM-49 | per-user Hermes workspace dirs under `<containerDataRoot>/tenants/…` | Yes, and **none exist**: `data/tenants` is empty at baseline |
| HRM-50 | a pulled `nousresearch/hermes-agent` image | Yes; **not present locally** at baseline |
| HRM-51 | a running Hermes container | **None exist** at baseline (only `crabshell-alpha-…` on `sipeed/picoclaw:latest`) |

### H. Drift — surface that appeared after the original mapping

Added at execution time. Every ID here is new; none is `[OD-1:B]`.

| ID | Location | What |
|---|---|---|
| HRM-52 | `deploy/dokploy/config.base.toml:15-18,159,206-207,273-274,412-413,479-480`, `deploy/dokploy/.env.example:36-37`, `deploy/dokploy/crab-shell-proxy.config.yaml` | **the third TOML.** It has no `[[hermes-glm]]` block to cut, but its header explains hermes' *absence* relative to an upstream default that will no longer have one, and its per-feature notes justify themselves against the hermes harness. Reword so each note stands on its own. Supersedes HRM-33 for the `crab-shell-proxy.config.yaml` part. |
| HRM-53 | `internal/httpapi/projects.go:66,77-87,226,258` | delete `projectsSupported` and its three call sites; the `501 projects_unsupported` becomes unreachable and goes with it (ED-2). Keep the 404-on-unknown-project misroute guard the doc comment mentions — that is a different mechanism and still live. |
| HRM-54 | `internal/httpapi/user_models.go:46-51,63-67` | delete `userModelsSupported`, its call site, and its `501` (ED-2). |
| HRM-55 | `internal/docker/manager.go:305-317` | drop the `agent.Harness != config.HarnessHermes &&` term from the persona/project bind-drift recreate case and the paragraph explaining it (ED-2). **The drift check itself must keep firing for picoclaw** — this is the one place it belongs, and removing it would strand admin persona saves. |
| HRM-56 | proxy `.specs/features/{restart-control/design.md,persona-injection/*.md,memory-graph-mcp/{spec,progress}.md,admin-bulk-instance-config/spec.md,model-registry-source-of-truth/spec.md,chat-progress-events/spec.md}`, webapp `.specs/features/{persona-injection-admin/spec.md,agent-first-admin/{spec,design,tasks}.md,admin-bulk-instance-config/{spec,tasks}.md,chat-responsiveness/{design,tasks}.md}`, root `.specs/features/**` | **uniform policy, superseding HRM-47's narrower list: shipped feature specs are NOT rewritten.** They are accurate records of what was true when they shipped. They become grep survivors, and the withdrawal banner (HRM-42/43) plus DECISION.md (HRM-40) are what a reader finds. Only `.specs/project/{ROADMAP,STATE}.md` — the *living* docs — are edited (HRM-44/45/46). |
| HRM-57 | `internal/docker/provision.go:51`, `internal/docker/persona_test.go:321`, `internal/httpapi/handlers.go:232`, webapp `lib/projects.ts:60`, `app/api/projects/route.ts:10`, `app/chat/use-projects.ts:58`, `app/chat/projects-bar.tsx:76`, `lib/tools.ts:2` | residual comments naming hermes or "a harness with no projects". Proxy side: reword to state the picoclaw fact directly. Webapp side: keep the back-compat behaviour (ED-4) and reword the comments to say *why* it is back-compat rather than naming hermes. |
| **HRM-58** | root `README.md`, `README.pt-br.md`, `docs/ADMIN_GUIDE{,.pt-br}.md`, `docs/CREATE_CUSTOM_AGENT{,.pt-br}.md` | **USER-FACING DOCS — the gap the whole mapping missed, and the only requirement here that is a correctness bug rather than tidying.** These are shipped operator documentation, so HRM-56's "shipped specs are not rewritten" policy does **not** cover them: unlike a spec, a README is read as instructions for the code as it is now. They told an operator to set `MYC_HERMES_GLM_TOKEN` / `PROXY_GLM_API_KEY` (variables nothing reads any more), advertised three agents when the stack ships two, listed `hermes-glm` in the deploy-mode comparison and the guest-role lists, and — worst — `CREATE_CUSTOM_AGENT.md` documented **`harness: hermes` as a valid choice**, which after HRM-12 makes the proxy refuse to boot. Both locales. Rewritten to describe picoclaw-only, with `harness` documented as omit-it and any other value called out as a deliberate hard failure. |

---

## Edge Cases

- WHEN a deployment's `config.yaml` still declares `harness: hermes` after the upgrade THEN the
  proxy SHALL refuse to start with an error naming the accepted harness values — silently defaulting
  such an agent to picoclaw would hand a user a picoclaw container under a role provisioned for
  Hermes.
- WHEN mycelium still routes `hermes-glm` because only one of the two TOMLs was updated THEN the
  proxy SHALL reject the turn as an unknown service (no agent matches
  `x-mycelium-service-name`), not 500.
- WHEN a Hermes workspace directory exists from a previous run THEN it SHALL be left untouched — the
  removal SHALL NOT delete user data as a side effect.
- WHEN the model-registry boot migration runs on a deployment that previously had a Hermes agent
  THEN it SHALL still enumerate workspaces from disk rather than from `cfg.Agents`, so workspaces
  under a now-undeclared role are not orphaned (`migrate_models.go:139-140` — the anti-orphaning
  step must survive the comment edit).
- WHEN an older proxy that reports no `harness` field at all serves the webapp THEN the webapp SHALL
  still treat that agent as picoclaw (existing back-compat, preserved by HRM-37).

---

## Verification

Line numbers in this spec are from the baseline and **will drift**. Re-derive before editing:

```bash
# proxy
grep -rn "hermes\|Hermes\|Harness\|harness" --exclude-dir=.git --exclude-dir=.claude .
# root
grep -rn -i "hermes" --exclude-dir=.git --exclude-dir=data .
```

Gates — **measured against the §Baseline Refresh figures, not against "green"**:

| Repo | Command | Expected |
|---|---|---|
| proxy | `go build ./... && go vet ./...` | clean |
| proxy | `go test ./...` | every package passes **except** `internal/docker`, which must fail with **exactly the same 9 `lchown … operation not permitted` tests as the captured baseline** — no more, no fewer, no different names |
| webapp | `vitest run` | **56 files / 776 tests**, minus only the assertions HRM-37/38 deliberately remove |
| webapp | `tsc --noEmit` | **exactly the same 6 pre-existing errors** listed in §Baseline Refresh |
| webapp | `next build` | succeeds |
| stack | boot compose, sign in, chat with `alpha` through the gateway | reply lands; no container recreated |
| both | `grep -ri hermes` | matches the survivor list below, exactly |

### The grep survivor list — pass/fail, not judgement

After the change, `grep -ri hermes` across both repos SHALL return hits **only** in:

1. `.specs/features/hermes-removal/**` — this spec, `tasks.md`, `DECISION.md`. The record itself.
2. `.specs/features/multi-harness-support/**` (root and proxy) — the future-implementation record,
   now banner-headed, plus `implementation-notes.md`.
3. **Any other `.specs/features/**` file** — shipped feature specs, per HRM-56's not-rewritten
   policy.
4. `.specs/project/{ROADMAP,STATE}.md` (root and proxy) — where the deferral and the decision are
   *supposed* to be named.
5. The two `zero-scale-stateless-hermes-agent.md` pattern references (TRAP-1) — **picoclaw's**
   architecture, not the Nous product.
6. `components/ui/avatar.tsx` and `components/ui/avatar.initials.test.ts` (TRAP-7) — a string
   fixture.
7. Landing-page copy using the word *harness* (TRAP-2) — which `grep -i hermes` does not match
   anyway, but is listed so the distinction stays explicit.
8. `docs/CREATE_CUSTOM_AGENT{,.pt-br}.md` — a **cross-reference** to
   `.specs/features/hermes-removal/DECISION.md`, pointing a reader who wonders why `harness` takes
   only one value at the answer. Deliberate (HRM-58).
9. `internal/config/config_test.go` — `TestUnknownHarnessIsRejected` **deliberately** names
   `harness: hermes` as the stale value `Load` must refuse, and asserts the error echoes it. This is
   the executable form of the spec's first Edge Case; the string is the test's subject, not a
   leftover. **The only legitimate `hermes` hit in Go code.**

**Any hit in a `.go`, `.ts`, `.tsx`, `.toml`, `.yaml` or `.env.example` file outside that list is a
failure.**

---

## Sequencing

Three repos, three PRs, all on `chore/hermes-removal` off each repo's `origin/main` (ED-3). The root
pointer bump depends on the proxy and webapp merges.

1. **Proxy PR** — HRM-01..27, HRM-41, HRM-43, HRM-46, HRM-53, HRM-54, HRM-55, HRM-57 (proxy half).
   Self-contained and independently verifiable.
2. **Webapp PR** — HRM-35..39, HRM-57 (webapp half). Independent of the proxy under Option A: the
   `harness` API field survives, so nothing here is contract-coupled.
3. **Root PR** — HRM-28..34, HRM-40, HRM-42, HRM-44, HRM-45, HRM-52, **HRM-58**, plus the refreshed
   spec and `tasks.md`. State plainly if the submodule pointer bump targets unmerged branches.

~~Under `[OD-1:B]`, steps 1 and 3 become one coordinated change.~~ Not applicable — ED-1 chose A.

---

## Requirement Traceability

| ID range | Area | Story | Phase | Status |
|---|---|---|---|---|
| HRM-01..05 | proxy: files deleted | P1 shipped-surface | Tasks | Pending |
| HRM-06..24 | proxy: branches removed | P1 shipped-surface | Tasks | Pending |
| HRM-25..27 | proxy: tests | P1 shipped-surface | Tasks | Pending |
| HRM-28..34 | root: deploy + compose | P1 shipped-surface | Tasks | Pending |
| HRM-35..39 | webapp | P2 | Tasks | Pending |
| HRM-40..47 | documentation + preservation | P1 knowledge | Tasks | Pending |
| HRM-48..51 | operational residue | P3 | Tasks | Pending |
| HRM-52..58 | drift (§H) | P1 / P2 | Tasks | Pending |

**Coverage:** 58 requirements. Under ED-1 (Option A), **HRM-23 is out of scope entirely**, and
HRM-21/22/26/27 apply in their comment-only form. See `tasks.md` for the ID→task map.
**Blocked on:** nothing. OD-1 resolved (ED-1).

---

## Success Criteria

- [ ] `go build`/`go vet` clean; `go test ./...` fails **only** the 9 baseline chown tests, verified
      name-for-name against the captured baseline.
- [ ] `vitest run` green; `tsc --noEmit` shows **exactly** the 6 baseline errors.
- [ ] A signed-in user chats with `alpha` through the gateway; no picoclaw container was recreated.
- [ ] A stale `harness: hermes` config is refused at startup with a clear error.
- [ ] `grep -ri hermes` across both repos returns only the documented survivors.
- [ ] `.specs/features/multi-harness-support/` still explains how to build Hermes, now with a
      withdrawal banner and the runtime findings that were never written down before.
- [ ] The landing page's "harness" copy is unchanged in en and pt-BR.
- [ ] The webapp's in-flight branch was never touched by this work.
