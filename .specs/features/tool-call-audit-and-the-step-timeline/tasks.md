# Tasks

Bottom-up: the harness writes before the proxy can read, and the proxy serves before the
webapp can ask. The webapp's FR-4 and FR-5 are independent of all of it and can land
first if the chain stalls.

## Harness — `crab-ganglion-harness`

- **H1** — `domain.TurnEvent.AuditID`, and the `domain.ToolAuditStore` port.
  *Done when* the field serialises with `omitempty` and an old transcript still decodes.
- **H2** — `toolaudit.Store`: `Put` (command, at start), `Complete` (output + status, at
  end), both temp-file-plus-rename. `safe()` on both path segments.
  *Tests* — a record round-trips; a `Complete` with no prior `Put` does not panic; two
  calls with an EMPTY provider id get two records (FR-1.4 / AC-1.4.1).
- **H3** — mint the id and wire the two calls into `loop.go` beside the existing
  `events.Add` / `Finish`. A store error never fails a turn (AC-1.3.2).
  *Tests* — a turn cancelled inside a tool leaves a record with a command and no output
  (AC-1.3.1); a silent iteration still leaves one (AC-1.2.2).
- **H4** — `Sweep`: gzip records older than the constant, `Chtimes` to carry the mtime,
  rename then unlink. Called at boot in `main.go`.
  *Tests* — an old record compresses and keeps its mtime (AC-2.2); a fresh one is left
  alone; a second sweep is a no-op rather than re-compressing its own output.
- **Gate** — `go build ./... && go test ./...`.

## Proxy — `crab-shell-proxy`

- **P1** — `config.ToolAuditDir`, mirroring `SessionsDir`'s segment handling.
- **P2** — `history.Event.AuditID` passthrough, so the id reaches the webapp.
- **P3** — `GET /v1/sessions/tool-call`: identity-derived directory, `safe()` on the id,
  `.json` then `.json.gz`, absent is a clean empty answer (FR-3).
  *Tests* — a traversal id is refused; a gzipped record is served decompressed; an absent
  one answers "not recorded" rather than 500.
- **P4** — **the contract test**: the directory name and the JSON field names match the
  harness's, read from its source. Without it, drift is an empty sheet.
- **Gate** — `go build ./... && go test ./...`. `internal/docker` has 10 pre-existing
  `lchown` failures on this host; the count must not grow.

## Gateway routing — `zombie-crab-project`

- **G1** — a `[[<role>.path]]` block for `/v1/sessions/tool-call` in all five places:
  three roles in `deploy/standalone/config.standalone.toml`, two in
  `deploy/prod/config.base.toml`. Run the routes check (FR-3.1).
- **G2** — note in the report that production mycelium reads its config at boot and needs
  its own deploy.

## Webapp — `crab-exoskeleton-webapp`

- **W1** — `TurnEvent.auditId`; the BFF route, added to the route allow-list.
  *Test* — the allow-list and the client agree, the way `mangrove-actions.test.ts` does.
- **W2** — the timeline: numbered steps on a spine, bounded blocks (FR-4).
- **W3** — tool rows as bounded rows with a hover state (FR-5).
- **W4** — `tool-call-sheet.tsx`: fetch on open, loading, "not recorded", the command and
  the output (FR-6). Only for `kind: "tool"` with an `auditId`.
- **Gate** — `./node_modules/.bin/vitest run` and `./node_modules/.bin/next build`.
  `yarn lint` does not run here and `tsc` has 7 pre-existing errors; neither count may
  grow.
