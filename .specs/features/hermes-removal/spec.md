# hermes-agent Removal Specification

**Status:** Specified — NOT approved for execution. This document maps the work; it does not
authorize it. Nothing has been removed.

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

## OD-1: Open Decision — how deep does the removal cut? ⚠️ BLOCKS EXECUTION

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

Gates:

| Repo | Command | Expected |
|---|---|---|
| proxy | `go build ./... && go vet ./... && go test ./...` | green, **except** the pre-existing `internal/docker` chown failures caused by a sandbox permission limit. Confirm they are the *same* failures as before the change (`git stash -u` comparison) — they must not mask a real one. |
| webapp | `next build`, `tsc --noEmit`, `vitest run` | green |
| stack | boot compose, sign in, chat with `alpha` through the gateway | reply lands; no container recreated |
| both | `grep -ri hermes` | survivors are only spec/doc files, the two `zero-scale-stateless-hermes-agent.md` pattern refs, and the webapp until P2 lands |

---

## Sequencing

Three repos, three PRs. The root pointer bump depends on the proxy merge.

1. **Proxy PR** — HRM-01..27, HRM-41, HRM-43, HRM-46. Self-contained and independently verifiable.
2. **Root PR** — HRM-28..34, HRM-40, HRM-42, HRM-44, HRM-45, HRM-47. Either omit the submodule
   pointer bump or state plainly that it targets an unmerged proxy branch.
3. **Webapp PR (P2)** — HRM-35..39, branched off the webapp's committed HEAD at that time, after the
   in-flight work has landed.

Under `[OD-1:B]`, steps 1 and 3 become one coordinated change: the admin API contract breaks, so the
webapp cannot lag.

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

**Coverage:** 51 requirements, 0 mapped to tasks (no `tasks.md` yet), 0 verified.
**Blocked on:** OD-1. HRM-22, HRM-23, HRM-26, HRM-27 and the P2 priority all change shape with it.

---

## Success Criteria

- [ ] `go build`/`go vet`/`go test` green in the proxy (chown failures confirmed pre-existing).
- [ ] A signed-in user chats with `alpha` through the gateway; no picoclaw container was recreated.
- [ ] A stale `harness: hermes` config is refused at startup with a clear error.
- [ ] `grep -ri hermes` across both repos returns only the documented survivors.
- [ ] `.specs/features/multi-harness-support/` still explains how to build Hermes, now with a
      withdrawal banner and the runtime findings that were never written down before.
- [ ] The landing page's "harness" copy is unchanged in en and pt-BR.
- [ ] The webapp's in-flight branch was never touched by this work.
