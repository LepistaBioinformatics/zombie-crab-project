# crab-mangrove-network — Tasks

**Spec:** `spec.md` · **Design:** `design.md`
**Status:** Slices 1 and 2 SHIPPED (crab-mangrove-network@30925b3, on `main`). Slices 2 and 3 open.

Three repositories. Slice 1 is self-contained and blocks nothing; slices 2 and 3 are **siblings**
that both gate this repository's pointer bump.

Gate for every Go task: `go build ./... && go vet ./... && go test ./...` from the module root.

---

## Slice 1 — `crab-mangrove-network` (new public repository) — DONE

Shipped as the repository's first commit. `go build`, `go vet`, `gofmt -l` and
`go test -race` all pass; CI enforces all four plus the zero-dependency posture.

### T1.1 (done) — Repository and module skeleton
- **What:** create the public repo, `go.mod` (module
  `github.com/LepistaBioinformatics/crab-mangrove-network`, go 1.25, **no requires** — DD-1), dual
  licence files, `.gitignore`, `.specs/`.
- **Done when:** `go build ./...` passes on an empty tree and `git log` has one commit on `main`.
- **Note:** must exist on `main` before any pointer here may be committed
  (`.claude/rules/submodule-pointers.md`).

### T1.2 (done) — `internal/actor`
- **What:** actor ids derived from `accId`; `Person`/`Service` documents; `attributedTo` on the
  `Service` only; ed25519 keypair generation; private keys at `keys/<id>.ed25519`, mode 0600, never
  served.
- **Reuses:** the `SanitizeID` path rule (copied, not imported — separate module).
- **Covers:** FR-A1, A2, A4, A5.
- **Tests:** ids derive from `accId` and not email; a `Person` carries no `attributedTo`; the key
  file is 0600 and absent from every HTTP response.

### T1.3 (done) — `internal/activity`
- **What:** the 14 AS2 types from FR-C1; canonical serialisation; `Sign`/`Verify` over
  `id|type|actor|to|cc|object|published`.
- **Covers:** FR-A4, C1, H3 (the envelope interface, defined and unimplemented, with the
  `recipients[]` reasoning in the source).
- **Tests:** `TestSignatureCoversAddressing` — mutate `to` on a signed activity, verification must
  fail. This is the negative test the source model demanded.

### T1.4 (done) — `internal/reach`: the B6 gate — **the single enforcement point**
- **What:** one exported function. Input: the caller's verified tuple + the requested `to`/`cc`.
  Output: ok, or a refusal naming the offending addressee.
- **Depends on:** T1.2.
- **Covers:** FR-B1, B1a, B6, B6a, B6b; DD-3's table.
- **Tests:** `TestOutOfReachAddresseeRefusesWholeActivity` (three addressees, one bad → whole thing
  refused, nothing written); `TestTenantScopeRefusedFromAgentToken`; a test asserting every widening
  verb routes through this one function.

### T1.5 (done) — `internal/mangrovelog`: append-only store + reduction
- **What:** JSONL per `(tenant, subscription)`; append verifies the signature first; LWW reduction
  keyed by `(cell, author)`.
- **Depends on:** T1.3.
- **Covers:** FR-G1..G4.
- **Tests:** `TestTwoAuthorsSameCellBothSurvive`; append refuses an unsigned or badly-signed line;
  `Like` count surfaces as evidence weight, never as a truth flag.

### T1.6 (done) — `internal/httpapi`: the internal surface
- **What:** the endpoints the façade calls, authenticated by `MANGROVE_TOKEN` (HMAC bearer). Publish,
  share, timeline, fetch, follow, react, admit. Every handler takes the tuple from the request body
  the proxy signed — **never** an actor id.
- **Depends on:** T1.4, T1.5.
- **Covers:** FR-A3, C2, C3, E3, E4, F1..F5, B7.
- **Tests:** `TestForgedActorIsRefused`; `TestAdmitRequiredBeforeIngest`; widening an existing
  object's visibility is refused with a reason (FR-C3); a bot cannot `Undo` its human's `Delete` or
  `Block`.

### T1.7 (done) — `cmd/crab-mangrove-network` + Dockerfile
- **What:** boot, env (`MANGROVE_LISTEN`, `MANGROVE_STORE_DIR`, `MANGROVE_TOKEN`), graceful shutdown. Refuse to
  boot with `MANGROVE_TOKEN` unset, naming the variable — the mangrove is not reachable without a caller
  credential, and a silent open port is worse than a refusal.
- **Depends on:** T1.6.

### T1.8 (done) — `README.md`: experimental notice + threat model
- **What:** the notice that this is an **experimental** project, at the top, unmissable; the FR-H1
  declaration of what is *not* protected; the FR-H2 forward-secrecy limit (which also appears in the
  code, not only here).
- **Covers:** FR-H1, H2, AC-6.

---

## Slice 2 — `crab-shell-proxy` (sibling) — DONE

Shipped as crab-shell-proxy#68 (`ca691a4`).

### T2.1 (done) — `mangrove_*` tools on the existing `/v1/mcp`
- **What:** the seven tools from DD-4, registered **only** when `CRAB_MANGROVE_BASE_URL` and
  `CRAB_MANGROVE_TOKEN` are both set.
- **Covers:** FR-D1..D6, D3a, J1, J2.
- **Tests:** `TestNoMangroveToolsWhenUnconfigured`; a collision test over the whole registered set;
  `TestGanglionConfigStillOneServer` beside the existing per-project test.

### T2.2 (done) — subscription membership endpoint
- **What:** the one thing DD-3 needs from the proxy.
- **Reuses:** `ListSubscriptionUsers` (`internal/docker/shared.go:310-333`) as-is.

### T2.3 (done) — gate `mangrove_publish` / `mangrove_share`
- **What:** add both to the gated-tool list. **No wire change** — the approver contract is fixed by
  published image tags.
- **Covers:** FR-E1, AC-5.

---

## Slice 3 — `crab-exoskeleton-webapp` (sibling)

### T3.1 — the destination
- **What:** extend `Destination`/`asDestination` with one value, guard intact.
- **Covers:** FR-I1, I2, I3; AC-12, AC-22.

### T3.2 — the three readings
- **What:** Received / Published / Pending decisions, scope filter. Pending is **absent** without a
  governing role, not empty.
- **Covers:** FR-I4, I5, I6; AC-10, AC-13.

### T3.3 — empty vs unreachable
- **Covers:** FR-I8, J0; AC-14, AC-24.

---

## Slice 4 — this repository

### T4.1 — submodule pointer + compose + docs
- **Blocked by:** slices 2 and 3 merging to their default branches. The pointer check
  (`.github/workflows/submodule-pointers.yml`) fails a PR otherwise.

---

## Traceability

| Requirement group | Tasks |
|---|---|
| FR-A actors | T1.2, T1.3, T1.6 |
| FR-B scopes, containment | T1.4, T2.2 |
| FR-C activities | T1.3, T1.6 |
| FR-D MCP delivery | T2.1, T2.3 |
| FR-E human authority | T1.6, T2.3, T3.2 |
| FR-F approval | T1.6, T3.2 |
| FR-G log | T1.5 |
| FR-H threat model | T1.3, T1.8 |
| FR-I webapp tab | T3.1, T3.2, T3.3 |
| FR-J optionality | T1.7, T2.1, T3.1, T3.3 |

---

## What slice 1 actually shipped, against what it promised

Two things came out different from the plan, both stricter:

**DD-3 landed harder than written.** The design said the tenant Group is refused
on the agent path. The implementation makes that the *only* way an agent can be
refused a scope it might plausibly have expected, and pins it with
`TestTenantScopeRefusedFromAgentToken` plus its positive twin
`TestTenantScopeAllowedForALicensedHuman`. An agent cannot broadcast tenant-wide
at all.

**The signature covers more than the design listed.** `design.md` named
`id|type|actor|to|cc|object|published`. The implementation signs the whole
activity minus the signature, so `target` and `inReplyTo` are covered too, and a
field added later is covered without anybody remembering to add it. The test
table includes `target` for that reason.

**A compose service exists, behind the `mangrove` profile.** Added so the service can
actually be run and poked at:
`docker compose --profile mangrove up -d --build crab-mangrove-network`. A profile is the
cheapest honest way to hold FR-J: not "starts but does nothing", not "starts and
errors" — simply absent from `docker compose up` unless asked for. Verified:
`config --services` omits it by default and includes it with the profile.

**The proxy still has no `CRAB_MANGROVE_BASE_URL`,** so nothing reaches the mangrove from
an agent yet. That is the correct state rather than an unfinished one — until
slice 2 exists there is nothing to configure.

**What can and cannot be exercised today, found by running it.** Self-scope and
own-subscription-scope publishing, the containment refusals, the per-author
reduction and the pending state all work against the mangrove alone. **Addressing a
named colleague does not**, because the reachability gate has to answer "does
this person have a workspace under a subscription the caller shares" and the only
source for that is T2.2's membership endpoint. With the proxy absent the gate
fails CLOSED rather than assuming membership — correct, and it makes T2.2 a
prerequisite for exercising the direct-share dimension at all. `scripts/smoke.sh`
reports that section as a skip with the reason, rather than as a pass.

---

## What slice 2 shipped, against what it promised

**Five tools, not seven.** DD-4 named `mangrove_follow` and `mangrove_fetch`, and neither
has an endpoint on the service — they were specified against a surface that does
not exist, so they are dropped rather than invented. `decide` and `revoke` do
exist but are human actions with no agent path. What ships: `mangrove_publish`,
`mangrove_share`, `mangrove_timeline`, `mangrove_react`, `mangrove_admit`.

**The agent path hard-codes `tenantLicensed=false`**, as a named constant rather
than a literal, so DD-3's consequence is visible where it is enforced rather than
only where it is argued. `TestAgentCallsNeverClaimTenantLicence` drives a real
MCP call and reads the wire.

**Gating is conditional on the mangrove being configured.** `mangrove_publish` and
`mangrove_share` join `schedule_create` in `GANGLION_GATED_TOOLS` only when the mangrove
is on — a gated tool that does not exist is a name the harness checks on every
call and can never match. `mangrove_timeline`, `mangrove_react` and `mangrove_admit` are not
gated: two read, and admit only moves something into this member's own memory
that their person already chose to receive.

**The optionality test came for free.** The existing golden schema test counts
advertised tools and its harness configures no mangrove, so it now proves FR-J2
without being taught anything about this feature. A new
`newHarnessWithMangrove` constructor exists precisely so that stays true.

**Still not exercisable end to end from an agent** until slice 3 gives the human
somewhere to answer the gate and read what arrived.
