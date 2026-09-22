# Tasks

Four repositories, one dependency chain: the gate flag must exist before the
proxy can set it, and the route must exist before the webapp can call it.

## Slice 1 — the gate (`crab-mangrove-network`)

- **T1** `internal/reach/reach.go`: add `Options.GroupsLicensed`; the
  subscription-Group arm refuses without it.
  *Done when*: `go test ./...` passes and the own-subscription tests fail when
  the flag is removed from the call. *Covers*: FR-R1, FR-R2, FR-R3.
- **T2** `internal/reach/reach_test.go`: update the three call sites that assert
  own-subscription is reachable; add a regressor for an agent-shaped call (no
  options) being refused by name. *Covers*: FR-R4.
- **T3** Package doc: the reach table now has a Groups row. *Covers*: FR-R4.

## Slice 2 — the route (`crab-shell-proxy`) — depends on Slice 1

- **T4** `internal/mangrove/client.go`: `GroupsLicensed` on `base`; new param on
  `Publish`/`Share`.
- **T5** `internal/mcpserver/mangrove_tools.go`: `mediaType` on
  `mangrovePublishIn` and through to `Object`; pass the two licences as named
  false constants. *Covers*: FR-P3, FR-R4, AC-6, AC-7.
- **T6** `internal/httpapi/mangrove_directory.go`: lift the email→accId map out
  of `resolveAudience` into a helper both callers use.
- **T7** `internal/httpapi/mangrove_publish.go`: `POST /v1/mangrove/publish` —
  resolve caller, expand `toEmails`, set both licences from `governs`/
  `tenantLicensed`, publish `AsPerson`. *Covers*: FR-P1, FR-P2, FR-Q1..Q4, FR-S1.
- **T8** `internal/httpapi/handlers.go`: register it inside the mangrove block,
  so it stays absent when the mangrove is unconfigured. *Covers*: FR-T1.
- **T9** Tests: tier × audience table. *Covers*: AC-1..AC-5.

## Slice 3 — the gateway (`zombie-crab-project`) — depends on T8

- **T10** `deploy/prod/config.base.toml` and
  `deploy/standalone/config.standalone.toml`: one `POST /v1/mangrove/publish`
  entry per role, named rather than wildcarded, for the reason the existing
  mangrove block gives.
- **T11** `scripts/gateway_routes.py` passes with the submodule initialized.
  *Covers*: AC-10.

## Slice 4 — compose (`crab-exoskeleton-webapp`) — depends on T7's body shape

- **T12** `lib/mangrove.ts`: `publish()` and its types.
- **T13** `app/api/mangrove/[action]/route.ts`: `publish: "POST"`.
- **T14** `app/chat/mangrove-compose.tsx`: cell, body, media type, audience.
  Group options only when `capabilities` allows. *Covers*: FR-P1, FR-Q2, FR-R5.
- **T15** `app/chat/mangrove-screen.tsx`: compose as its own flag beside People;
  on success switch to `published` and reload. *Covers*: DD-5.
- **T16** i18n in both catalogues; parity test green with no new allowlist entry
  unless the strings genuinely collide.
- **T17** Tests: renders/hides on capabilities, body shape, person/agent choice.

## Slice 5 — the chain

- **T18** Merge bottom-up, bump each pointer at a commit on the child's default
  branch, per `.claude/rules/submodule-pointers.md`.
- **T19** `STATE.md`: AD-030 for the levelling decision (D-5), which is the one
  breaking change here.
