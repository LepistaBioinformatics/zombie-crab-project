# Decision: Hermes is withdrawn from the shipped surface

**Date:** 2026-08-09
**Status:** Executed.
**Scope:** `zombie-crab-project` (root), `crab/crab-shell-proxy`, `crab/crab-exoskeleton-webapp`.

---

## The decision

The **Hermes harness** (Nous Research `hermes-agent`, driven over its OpenAI-compatible HTTP API) is
**removed from every shipped artifact** and demoted to a **future implementation**.

It was not removed because it did not work. It was implemented, and **verified working end-to-end
against a real z.ai/GLM deployment** — a signed-in user chatted with a Hermes agent through the
gateway. It is removed for **compatibility with the infrastructure this project actually runs on.**

## Why

| Problem | Detail |
|---|---|
| **Startup budget** | The container needs a **180s** startup deadline against the proxy's **35s** global health-wait. `Agent.StartupDeadline` exists solely because of this. |
| **Turn latency — the real blocker** | Turns sat **near mycelium's 60s `gatewayTimeout`**. Not reliably over it; *near* it. A fraction of real turns therefore time out at the gateway while the container is still working, and the user sees a failure for a turn that succeeded. **Never solved.** |
| **Image weight** | 71 bundled skills plus Chromium under `s6`, pulled **per user**. On a scale-to-zero deployment that is a per-user cold-start cost. |
| **Invocation fragility** | It must be started as `gateway run`. With the image default it exits on its own seconds after boot. |
| **Auth workaround** | It needs `GATEWAY_ALLOW_ALL_USERS=true`, or it silently returns **empty replies**. Safe only because each container is per-user — an invariant that must be re-checked if it is ever relaxed. |
| **Structural mismatch** | Everything lives in one flat `/opt/data`. Persona injection, projects and personal models are all picoclaw `config.json` / workspace-layout constructs, so Hermes was **excluded** from each of them rather than merely unimplemented. |

**The cost was never code volume.** It was that "agent" meant two things in every reader's head, and
every future change — config, admin API, model inventory, webapp tab logic, three mycelium TOMLs, two
compose files — paid that tax for a branch **no deployment exercised.**

## What was withdrawn

- **Proxy:** `internal/hermes/`, `internal/docker/provision_hermes.go`,
  `internal/docker/defaulttemplate/hermes/`, `config.HarnessHermes`, `Config.HermesImage`,
  `ModelConfig.KeyEnvName`, the secret-gating branches and `Config.DisabledAgents`, the
  `hermesAPIPort`/`endpoint` branches, the `Hermes Turner` field and `turnerFor`/`turnModelFor`.
- **Root:** the `[[hermes-glm]]` mycelium service block in `deploy/prod/config.base.toml` and
  `deploy/standalone/config.standalone.toml`; the `MYC_HERMES_GLM_TOKEN` / `PROXY_GLM_API_KEY`
  passthroughs in `docker-compose.yaml` and every `.env.example`; the Hermes commentary in the
  dokploy deploy files.
- **Webapp:** the Hermes-specific comments, the per-agent harness `<Badge>`, and the Hermes test
  fixtures.

## What was deliberately KEPT

**The generic harness seam stays dormant** (OD-1 Option A):

`Agent.Harness` (validated, `picoclaw` the only accepted value), `turn.Request` / `turn.Sink`, the
`Turner` interface, `docker.Target.Harness`, `harnessPort`/`endpoint`, the
`defaulttemplate/<harness>/` layout, the admin API's `harness` field, and the model-inventory
rejection gate with all three of its tests.

Reasons, in order of weight:

1. **Picoclaw flows through these paths today.** Touching them is the risk, not the Hermes code.
2. **`harness` is a live API contract.** The admin API publishes it, `openapi.json` documents it, and
   the webapp reads it to decide which admin tabs an agent offers.
3. **`chat-progress-events` built `turn.Sink` on this seam**, and it is in-tree.
4. **Option B would have lost coverage.** The three model-inventory rejection tests would have been
   deleted along with the gate they cover — a coverage loss dressed as a simplification.
5. **`ModelConfig.BaseURL` has a live non-Hermes consumer**: `migrate_models.go` imports it as the
   model registry's `APIBase`.

Consequence to accept honestly: **a discriminator with one legal value.** To a newcomer that reads as
scaffolding. It is the price of not refactoring the one runtime that must not break.

### Also kept: two back-compat behaviours

- The webapp treats an **absent** `harness` as picoclaw. An older proxy reports no harness at all.
- The webapp still handles `501 projects_unsupported`. The server-side 501 is gone, but a deployed
  older proxy still returns it.

Both are *version* skew, not harness variety.

## Secondary decisions made during execution

- **Dead guards were deleted, not left returning `true`.** `projectsSupported`,
  `userModelsSupported` and the `Harness != HarnessHermes` term in the persona/project bind-drift
  case were all constant-true once Hermes was gone. A trivially-true predicate is speculative
  scaffolding. **Do not re-litigate this** — a re-add writes them fresh against the new profile.
- **Test fixtures were rewritten against a synthetic harness value rather than deleted**, in both the
  proxy and the webapp. Both suites tested the *false* branch of a picoclaw-only filter through a
  Hermes agent; that branch is still live code. In the webapp this departs from HRM-37/38's literal
  wording, which said to drop the assertions.
- **Shipped feature specs were NOT rewritten.** ~20 spec docs across the three repos mention Hermes.
  They are accurate records of what was true when they shipped. They are grep survivors; this file
  and the withdrawal banners are what a reader finds instead.
- **`harness: hermes` now fails at `Load`** rather than defaulting. A stale operator config must fail
  loudly — silently defaulting would hand a user a picoclaw container under a role provisioned for
  Hermes.

## Where the implementation lives — recovery

| SHA | What |
|---|---|
| `d2f0a9a` | multi-harness support + Hermes |
| `748e0fe` | gate hermes agents on their secrets |
| `3e9e95c` | model administration rejects non-picoclaw agents |

**Read this first on a re-add:**
`crab/crab-shell-proxy/.specs/features/multi-harness-support/implementation-notes.md` — the runtime
findings from the live E2E. A deleted file is recoverable from git; *why `gateway run` instead of the
image default* was not written down anywhere until that file existed.

The design record stays at `.specs/features/multi-harness-support/` in both this repo
(`spec.md`, `investigation.md`) and the proxy (`design.md`, `tasks.md`), each carrying a withdrawal
banner.

### One behaviour worth restoring on a re-add

**`DisabledAgents`.** An agent whose required secrets were unset removed *itself* from `cfg.Agents` at
`Load` instead of failing the whole proxy — so a config declaring an agent this deployment is not
provisioned for degraded to "that agent does not exist" rather than "the proxy will not boot". Both
append sites were inside `Harness == HarnessHermes` branches, so the mechanism died with the removal.
The *idea* is good and general; it should come back, ideally not tied to one harness.

---

## Operational residue — documented, not automated

Nothing below is cleaned up by this change. All of it is harmless if ignored.

| ID | Item | Harmless if ignored? |
|---|---|---|
| HRM-48 | mycelium accounts still holding the auto-declared `hermes-glm` **guest-role grant**, now that the TOML block is gone | **Yes.** A grant to a service that no longer routes. It grants access to nothing. Cleaning it up requires a per-account revoke; not worth scripting. |
| HRM-49 | per-user Hermes **workspace directories** under `<containerDataRoot>/tenants/…` | **Yes — and none exist.** `data/tenants` was empty at baseline. The removal deliberately does **not** delete user data as a side effect; if one existed it would be left untouched. |
| HRM-50 | a pulled `nousresearch/hermes-agent` **image** | **Yes.** Not present locally at baseline. `docker image rm` if disk matters. |
| HRM-51 | a **running** Hermes container | **Yes — none exist.** Only `crabshell-alpha-…` on `sipeed/picoclaw:latest` at baseline. |
| HRM-34 | dead `MYC_HERMES_GLM_TOKEN` / `PROXY_GLM_API_KEY` vars in a local `deploy/*/.env` | **Yes.** Unread by anything now. **`deploy/standalone/.env` is gitignored and holds a real z.ai key** — operator-owned, never committed, never echoed. |

### Two failure modes to know about

- **Partial TOML update.** If mycelium still routes `hermes-glm` because only one of the deploy TOMLs
  was updated, the proxy answers the turn as an **unknown service** (no agent matches
  `x-mycelium-service-name`) — not a 500. There are **three** TOMLs, not two:
  `deploy/prod/`, `deploy/standalone/`, `deploy/dokploy/`.
- **Stale proxy config.** A `config.yaml` still declaring `harness: hermes` makes the proxy **refuse
  to start**, with an error naming `picoclaw` as the accepted value. This is intentional.

---

## Verification at execution time

Measured against a baseline captured **before** any edit, because both gates have pre-existing
failures and "green" would have been the wrong target:

| Gate | Result |
|---|---|
| proxy `go build ./...`, `go vet ./...` | clean |
| proxy `go test ./...` | passes everywhere except `internal/docker`, which fails **the same 9 `lchown … operation not permitted` tests as the baseline**, diffed name-for-name (a sandbox permission limit, unrelated to this change) |
| webapp `vitest run` | **56 files / 776 tests** — unchanged from baseline, because coverage was rewritten rather than deleted |
| webapp `tsc --noEmit` | **the same 6 pre-existing test-file errors** as baseline, diffed identical |
| webapp `next build` | succeeds |
| landing page | untouched in both locales — no file under `lib/i18n/landing.ts`, `components/landing/` or `landing.module.css` is in the diff |

Also checked after the change: `gofmt -l` in the proxy lists **exactly the same 5 pre-existing files**
as before (none of them touched by this work); the three deploy TOMLs were re-parsed with `tomllib`;
and no `.env` file was committed (TRAP-6 — `deploy/standalone/.env` is gitignored and holds a real
z.ai key). The webapp has no ESLint configuration and CI builds images only, so there is no lint gate
to run.

## Known gaps

1. **The live stack boot was NOT run** — compose up, sign in, chat with `alpha` through the gateway,
   confirm no picoclaw container was recreated. That gate needs a running deployment and **must be
   exercised before merge.**
2. **The `state.db` schema is not recorded**, though P1 story 2 criterion 2 asks for it. The proxy
   never opened that file, so neither the code nor its history holds the schema, and there was no
   running Hermes container to inspect. `implementation-notes.md` says so explicitly and gives the
   command to get it, rather than guessing at a shape a future reader would trust.
3. **`deploy/standalone/.env` still holds the dead `MYC_HERMES_GLM_TOKEN` / `PROXY_GLM_API_KEY`
   vars** (HRM-34). Operator-owned local hygiene; harmless, and never to be committed.
