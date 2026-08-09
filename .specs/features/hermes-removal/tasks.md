# hermes-agent Removal — Tasks

Derived from `spec.md` under **ED-1 (OD-1 Option A)**, **ED-2 (delete dead guards)** and
**ED-3 (branch off `main`, three PRs)**.

`[P]` marks tasks that can run in parallel with their siblings. Everything else is sequential within
its phase. Phases are ordered by PR: **P → W → R**, but P and W are genuinely independent under
Option A (the `harness` admin-API field survives, so no contract couples them).

**Gate for every task:** the commands in `spec.md` §Verification, compared against the
§Baseline Refresh figures — *not* against "green". The proxy's `internal/docker` package fails 9
chown tests at baseline and must keep failing exactly those; the webapp has 6 pre-existing `tsc`
errors and must keep exactly those.

---

## Phase P — Proxy (`crab/crab-shell-proxy`, branch `chore/hermes-removal`)

### P1 — Delete the Hermes-only files

- **What:** remove the five files that exist only to serve the Hermes profile.
- **Where:** `internal/hermes/turn.go`, `internal/hermes/turn_test.go`,
  `internal/docker/provision_hermes.go`, `internal/docker/defaulttemplate/hermes/config.yaml`,
  `internal/docker/defaulttemplate/hermes/SOUL.md` (and the now-empty `internal/hermes/` and
  `internal/docker/defaulttemplate/hermes/` dirs).
- **Depends on:** nothing.
- **Done when:** the files are gone. `go build ./...` **will fail** here — P2 and P3 fix it. Do not
  chase the build green inside this task.
- **Covers:** HRM-01..05.

### P2 — Unwire Hermes from `config`

- **What:** delete `HarnessHermes`, `Config.HermesImage` + its default, `ModelConfig.KeyEnvName`,
  the two secret-gating branches, `Config.DisabledAgents`, and tighten harness validation to
  `{"", picoclaw}` with an error naming only the accepted value. Keep `Agent.Harness` and the
  `"" → picoclaw` defaulting (P1 story AC-3). Reword every doc comment that frames a field as
  picoclaw-vs-hermes to state the picoclaw fact directly.
- **Where:** `internal/config/config.go` — the constant block, `ModelConfig`, `Agent.Harness` /
  `StartupDeadline` docs, `Config.HermesImage`, `Config.DisabledAgents`, `Load`'s two
  `Harness == HarnessHermes` branches, `applyDefaults`' `HermesImage` default, `validate`'s harness
  switch.
- **Depends on:** nothing (parallel with P1 in principle; sequenced here so the build breaks once).
- **Reuses:** the existing `validate` error style — `fmt.Errorf("agent %q: …", key, …)`.
- **Done when:** `Load` rejects `harness: hermes` naming `picoclaw`; an omitted `harness` still
  defaults to picoclaw; no `HermesImage`/`KeyEnvName`/`DisabledAgents` identifier remains.
- **Tests:** P7.
- **Covers:** HRM-08..13, HRM-04 (the `KeyEnvName` consumer dies with P1).

### P3 — Collapse the harness branches in `docker` and `httpapi`

- **What:** remove every `Harness == HarnessHermes` branch and the Hermes turner plumbing, letting
  each site collapse to its picoclaw form.
  - `manager.go`: drop `hermesAPIPort`; `harnessPort` returns `PicoclawPort`; `endpoint` returns the
    `ws://…/pico/ws` form; `EnsureRunning`'s `provisionHermes`/`createHermes` branches go; reword
    the `Target` docs.
  - `handlers.go`: drop the `Hermes Turner` field, `turnerFor`, and `turnModelFor`'s Hermes branch.
  - `handlers.go:668` and `sse.go:106`: `s.turnerFor(tgt.Harness)` → `s.Pico`.
  - `main.go`: drop the `internal/hermes` import, the `Hermes:` field, and the `DisabledAgents`
    startup log (dead per TRAP-4).
- **Where:** `internal/docker/manager.go`, `internal/httpapi/handlers.go`, `internal/httpapi/sse.go`,
  `cmd/crab-shell-proxy/main.go`.
- **Depends on:** P1, P2.
- **Done when:** `go build ./... && go vet ./...` **clean**. `grep -ri hermes` over `*.go` returns
  nothing outside the tests P7 rewrites.
- **Covers:** HRM-06, HRM-07, HRM-14..18, HRM-21 (comment-only), HRM-22 (comment-only).

### P4 — Delete the dead guards (ED-2)

- **What:** `projectsSupported`, `userModelsSupported` and the `Harness != HarnessHermes` term in the
  bind-drift recreate case are all constant-true once Hermes is gone. Delete the two helpers, their
  four call sites, and the two now-unreachable `501` responses. Drop the term from the `case` in
  `manager.go`.
- **Where:** `internal/httpapi/projects.go:66,77-87,226,258`, `internal/httpapi/user_models.go:46-51,63-67`,
  `internal/docker/manager.go:305-317`.
- **Depends on:** P2 (`HarnessHermes` must already be gone).
- **Done when:** no `…Supported(agent)` predicate remains; **the persona/project bind-drift check
  still fires for picoclaw** — this is load-bearing, an admin persona save cannot reach an existing
  container without it; the 404-on-unknown-project guard is untouched.
- **Tests:** existing `internal/httpapi` and `internal/docker` suites must not regress beyond
  baseline.
- **Covers:** HRM-53, HRM-54, HRM-55.

### P5 — Reword the residual proxy comments

- **What:** comments that only make sense with two harnesses.
- **Where:** `internal/docker/provision.go:51`, `internal/docker/migrate_models.go:63,139`,
  `internal/docker/persona_test.go:321`, `internal/httpapi/admin.go:108-112`,
  `internal/httpapi/admin_model_scopes.go:41,61`, `internal/turn/turn.go` package + field docs.
- **Depends on:** P3.
- **Done when:** each comment states the picoclaw fact on its own terms. **`migrate_models.go:139`'s
  anti-orphaning rationale survives the edit** — enumerating workspaces from disk rather than from
  `cfg.Agents` is still the correct behaviour and an Edge Case depends on it. The
  `admin_model_scopes` gate itself is **kept** (Option A) with its comment corrected to say the
  inventory governs picoclaw, which is now every agent.
- **Covers:** HRM-19, HRM-20, HRM-22, HRM-57 (proxy half).

### P6 — `config.yaml`

- **What:** confirm no `hermes-glm` agent block remains, and that no `hermesImage`/`keyEnvName` key
  is referenced.
- **Where:** `config.yaml`.
- **Depends on:** P2.
- **Done when:** verified. **Expected to be a no-op** — the block is already absent at this baseline
  (spec §Baseline Refresh item 3). Record that in the commit body rather than inventing a change.
- **Covers:** HRM-24.

### P7 — Tests

- **What:**
  - `internal/config/config_test.go`: delete `hermesSample`, `TestHermesDisabledWhenSecretsMissing`,
    `TestHermesEnabledWhenSecretsPresent`. **Add** a case pinning HRM-12: an unknown harness value is
    rejected by `Load`, and an omitted one still defaults to picoclaw.
  - `internal/httpapi/admin_model_scopes_test.go`: rewrite the `hermesService` fixture to a
    **synthetic** non-picoclaw harness value (the fixtures build `config.Agent` in memory, bypassing
    `Load`, so an arbitrary string works). **Keep all three rejection tests and
    `TestAdminAgentsReportsTheHarness`** — the gate still exists under Option A (TRAP-5).
  - `internal/docker/migrate_models_test.go:225`: comment only.
  - `internal/httpapi/sse_progress_test.go`: `Harness:` fixture value stays (`[OD-1:B]` only).
- **Depends on:** P2, P3, P4, P5.
- **Done when:** `go test ./...` — every package passes except `internal/docker`, which fails
  **exactly** the 9 baseline chown tests. Diff the failing test names against the captured baseline;
  a 10th failure is a real regression, not a sandbox artefact.
- **Covers:** HRM-25, HRM-26, HRM-27.

### P8 [P] — `implementation-notes.md`: the runtime findings

- **What:** new file recording what git cannot hand back — the knowledge earned in the live E2E.
  Must cover, at minimum: the `Cmd: ["gateway","run"]` requirement and what happens without it; the
  180s startup deadline versus the 35s global health-wait; `GATEWAY_ALLOW_ALL_USERS=true` and why it
  is safe per-user; `model.base_url` being required for OpenAI-compatible providers; the
  provider-specific in-container key env name (`GLM_API_KEY` for provider `zai`) not being derivable
  from the provider; the absence of any API-only mode; the `state.db` session/message schema; and the
  unresolved turn-latency problem against the gateway's 60s timeout.
- **Where:** `.specs/features/multi-harness-support/implementation-notes.md` (proxy).
- **Depends on:** nothing.
- **Done when:** a reader can answer "what will bite me if I re-add this?" from the file alone.
- **Covers:** HRM-41. **This is the highest-value task in the whole change** — P1 story 2.

### P9 [P] — Proxy docs

- **What:** withdrawal banner on `.specs/features/multi-harness-support/{design,tasks}.md`;
  the deferral + decision entries in the proxy's own `.specs/project/{ROADMAP,STATE}.md`.
- **Where:** as listed.
- **Depends on:** nothing.
- **Done when:** the banner states implemented → verified live → withdrawn, the reason
  ("current infra compatibility"), the recovery SHAs `d2f0a9a`/`748e0fe`/`3e9e95c`, and links
  `implementation-notes.md` and root `DECISION.md`. **Shipped feature specs are not rewritten**
  (HRM-56).
- **Covers:** HRM-43, HRM-46.

### P10 — Commit and PR

- **What:** commit Phase P, open the proxy PR.
- **Depends on:** P1..P9.
- **Done when:** gates recorded in the PR body, including the baseline comparison for the chown
  failures.

---

## Phase W — Webapp (`crab/crab-exoskeleton-webapp`, branch `chore/hermes-removal`)

Independent of Phase P under Option A.

### W1 — `lib/admin.ts` and `app/admin/agent-scope.ts`

- **What:** reword the `Agent.harness` field doc and the `picoclawAgentKeys` rationale, and the four
  `agent-scope.ts` comments. **The filter itself stays** — it still correctly passes every agent, and
  the absent-`harness` case is live back-compat for an older proxy.
- **Where:** `lib/admin.ts:38-49`, `app/admin/agent-scope.ts:24,28,33,66`.
- **Depends on:** nothing.
- **Done when:** no comment names hermes; the back-compat reason is stated as *version* skew, not
  harness variety.
- **Covers:** HRM-35, HRM-36.

### W2 — Webapp tests

- **What:** drop the `{ key: "hermes-glm", harness: "hermes" }` and `{ key: "nous", harness: "hermes" }`
  fixtures and the assertions that only make sense with a second harness. **Keep** the
  "absent harness counts as picoclaw" cases in both files — an older proxy reports no harness at all.
- **Where:** `app/admin/agent-scope.test.ts:6-104`, `lib/admin.test.ts:68-79`.
- **Depends on:** W1.
- **Done when:** `vitest run` green. **`components/ui/avatar.initials.test.ts:9` is untouched**
  (TRAP-7 — a string fixture, not a harness).
- **Covers:** HRM-37, HRM-38.

### W3 — The harness badge

- **What:** `app/admin/agent-gate.tsx:69` renders `{agent.harness && <Badge>{agent.harness}</Badge>}`.
  Every agent now reports `picoclaw`, so it renders a constant badge on every agent — noise, not
  information. Remove it. Reword the two comments.
- **Where:** `app/admin/agent-gate.tsx:69`, `app/admin/admin-screen.tsx:271`, `lib/tools.ts:2`.
- **Depends on:** W1.
- **Done when:** the badge is gone; `lib/tools.ts`'s example identifier no longer uses `hermes-glm`.
- **Covers:** HRM-39.

### W4 — `projects_unsupported` back-compat (ED-4)

- **What:** the proxy's 501 disappears in P4, but a deployed older proxy still returns it. **Keep the
  handling**; reword the comments to say it is version back-compat rather than naming a harness.
- **Where:** `lib/projects.ts:60`, `app/api/projects/route.ts:10`, `app/chat/use-projects.ts:58`,
  `app/chat/projects-bar.tsx:76`.
- **Depends on:** nothing.
- **Done when:** behaviour unchanged, comments no longer imply a second harness exists.
- **Covers:** HRM-57 (webapp half), ED-4.

### W5 — Gates and PR

- **What:** `vitest run`, `tsc --noEmit`, `next build`; confirm the landing page is untouched in en
  and pt-BR (TRAP-2); commit and open the PR.
- **Depends on:** W1..W4.
- **Done when:** vitest green minus only the deliberately-removed assertions; `tsc` shows **exactly**
  the 6 baseline errors; `git diff --stat` touches **no** file under `lib/i18n/landing.ts`,
  `components/landing/`, or `landing.module.css`.
- **Covers:** P2 AC-3.

---

## Phase R — Root (`zombie-crab-project`, branch `chore/hermes-removal`)

### R1 — The two live mycelium TOMLs

- **What:** delete the `[[hermes-glm]]` service block (services, secret, every path) from both, and
  reword the surrounding commentary that enumerates agents or justifies a per-feature omission
  against the hermes harness.
- **Where:** `deploy/prod/config.base.toml`, `deploy/standalone/config.standalone.toml` — the service
  block **and** the comment sites at 7, 122, 136, 230-231, 311-312, 460-461, 531-532 (standalone;
  prod similarly — re-derive, do not trust these numbers).
- **Depends on:** nothing.
- **Done when:** no `hermes` string survives in either file, and **the `alpha` and `beta` service
  definitions are byte-identical to before** (`git diff` shows changes only in the removed block and
  the reworded comments). P1 AC-4.
- **Covers:** HRM-28, HRM-29.

### R2 — The third TOML and dokploy

- **What:** `deploy/dokploy/config.base.toml` has no block to cut, but its header explains hermes'
  *absence* relative to an upstream default that will no longer have one, and its per-feature notes
  justify themselves against the hermes harness. Same for `.env.example:36-37` and
  `crab-shell-proxy.config.yaml` — whose header also claims a hermes agent auto-disables without its
  secrets, which P2 makes **false**.
- **Where:** `deploy/dokploy/config.base.toml:15-18,159,206-207,273-274,412-413,479-480`,
  `deploy/dokploy/.env.example:36-37`, `deploy/dokploy/crab-shell-proxy.config.yaml:4-10`.
- **Depends on:** nothing.
- **Done when:** every note stands on its own without referencing a second harness, and no false
  auto-disable claim remains.
- **Covers:** HRM-52, HRM-33.

### R3 — Compose and env examples

- **What:** drop the `MYC_HERMES_GLM_TOKEN` / `PROXY_GLM_API_KEY` passthroughs and their comments;
  reword the dokploy compose comment that cites "drop hermes-glm" as the example customization.
- **Where:** `docker-compose.yaml:108-110,116-118`, `docker-compose.dokploy.yaml:87-89,150`,
  `deploy/standalone/.env.example:29,34-35`.
- **Depends on:** nothing.
- **Done when:** no hermes var or comment remains in any committed compose or example file.
- **Covers:** HRM-30, HRM-31, HRM-32.

### R3b — User-facing documentation (HRM-58)

- **What:** the gap the original mapping missed entirely, and the only part of Phase R that fixes a
  **correctness bug** rather than tidying prose. Six shipped operator docs described the stack as
  shipping three agents, told the reader to set `MYC_HERMES_GLM_TOKEN` / `PROXY_GLM_API_KEY`, listed
  `hermes-glm` among the guest-roles and in the deploy-mode comparison, and — worst —
  `CREATE_CUSTOM_AGENT.md` documented **`harness: hermes` as a valid choice**, which after P2 makes
  the proxy refuse to boot.
- **Where:** `README.md`, `README.pt-br.md`, `docs/ADMIN_GUIDE{,.pt-br}.md`,
  `docs/CREATE_CUSTOM_AGENT{,.pt-br}.md`.
- **Depends on:** P2 (the validation change is what makes the old text wrong).
- **Done when:** both locales describe picoclaw-only; `harness` is documented as *omit it*, with any
  other value called out as a deliberate hard failure and cross-linked to `DECISION.md`. **HRM-56's
  "shipped specs are not rewritten" policy does NOT apply here** — a README is read as instructions
  for the code as it is now, not as a record of what was once true.
- **Covers:** HRM-58.

### R4 — `DECISION.md`

- **What:** the record a future reader hits first.
- **Where:** `.specs/features/hermes-removal/DECISION.md` (new).
- **Depends on:** nothing.
- **Done when:** it states the reason (current-infra compatibility), what was withdrawn, the recovery
  SHAs `d2f0a9a`/`748e0fe`/`3e9e95c`, **the OD-1 choice actually made and why** (ED-1), **ED-2's
  deletion of the dead guards** so it is not re-litigated, the `DisabledAgents` behaviour worth
  restoring on a re-add (TRAP-4), and the HRM-48..51 residue list with harmless-if-ignored marked per
  item.
- **Covers:** HRM-40, HRM-48..51, P3 story.

### R5 [P] — Root docs

- **What:** withdrawal banner on `.specs/features/multi-harness-support/{spec,investigation.md}`;
  `STATE.md` decision entry **and** the correction at `STATE.md:57-60` — the "Hermes still reads it"
  claim is now false, but **the caveat it documents must survive**: `config.yaml`'s `agent.Model` is
  a migration seed with no runtime effect, which is now unconditionally true. `ROADMAP.md`: mark
  multi-harness deferred, **line 97 untouched** (TRAP-1).
- **Where:** as listed.
- **Depends on:** R4 (to cross-link).
- **Done when:** the three TRAP-1 sites have each been judged individually — the two
  `zero-scale-stateless-hermes-agent.md` references are **picoclaw's** architecture and stay.
- **Covers:** HRM-42, HRM-44, HRM-45.

### R6 — Spec bookkeeping

- **What:** commit the refreshed `spec.md` and this `tasks.md`; fill the traceability statuses.
- **Depends on:** all of P, W, R.
- **Covers:** HRM-56 (the not-rewritten policy is recorded, not executed).

### R7 — Final verification

- **What:** run the full §Verification gate set; run the survivor-list grep and check it **line by
  line** against spec.md's seven-item list; boot the stack and chat with `alpha`.
- **Depends on:** everything.
- **Done when:** every Success Criterion is ticked with evidence, or explicitly reported as not run.
- **Note:** the live stack boot needs compose up and a signed-in session. If it cannot be run in this
  environment, say so plainly rather than inferring the result from the unit tests.

### R8 — Local hygiene (operator, optional)

- **What:** remove the dead `MYC_HERMES_GLM_TOKEN` / `PROXY_GLM_API_KEY` vars from
  `deploy/standalone/.env`.
- **Depends on:** R3.
- **Note:** **TRAP-6 — that file is gitignored and holds a real z.ai key. Never commit it, never
  echo its contents.** Operator-owned; may be skipped.
- **Covers:** HRM-34.

---

## ID → Task Map

| ID | Task | ID | Task |
|---|---|---|---|
| HRM-01..05 | P1 | HRM-30..32 | R3 |
| HRM-06,07 | P3 | HRM-33 | R2 |
| HRM-08..13 | P2 | HRM-34 | R8 |
| HRM-14..18 | P3 | HRM-35,36 | W1 |
| HRM-19,20 | P5 | HRM-37,38 | W2 |
| HRM-21,22 | P3, P5 | HRM-39 | W3 |
| HRM-23 | — *out of scope, `[OD-1:B]`* | HRM-40 | R4 |
| HRM-24 | P6 *(expected no-op)* | HRM-41 | P8 |
| HRM-25..27 | P7 | HRM-42 | R5 |
| HRM-28,29 | R1 | HRM-43 | P9 |
| HRM-44,45 | R5 | HRM-52 | R2 |
| HRM-46 | P9 | HRM-53,54,55 | P4 |
| HRM-47 | superseded by HRM-56 | HRM-56 | R6 |
| HRM-48..51 | R4 | **HRM-58** | **R3b** |
| HRM-57 | P5, W4 | | |

**Unmapped:** none. **Out of scope:** HRM-23 (`[OD-1:B]`).
