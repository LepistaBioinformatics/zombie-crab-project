# Tasks

## Slice 0 — factor out visibility (`crab-mangrove-network`)

- **T0** Extract the `received` arm's inline visibility decision into one
  function, and have `handleTimeline` call it. No behaviour change; the existing
  timeline tests are the proof. *Covers*: FR-A4a, DD-4a. **Its own commit** — the
  blob gate must call a function that already exists and is already exercised.

## Slice 1 — the blob store (`crab-mangrove-network`)

- **T1** `internal/blob`: content-addressed store, atomic write, size limit.
- **T2** `Object` gains `Blob`/`FileName`/`Size`; publish branches on `Type` for
  the first time. *Covers*: FR-A1..A3, FR-A6, DD-3.
- **T3** `POST /internal/v1/blob` and `GET /internal/v1/blob`, the read gated by
  timeline visibility. *Covers*: FR-A4, FR-A5, DD-2.
- **T4** Tests, revoked-refused FIRST: publish, fetch, revoke, fetch refused.
  A stranger being refused passes against a gate that reads the audience list at
  face value; only the revoked case discriminates. *Covers*: AC-3a.

## Slice 2 — the proxy (`crab-shell-proxy`) — depends on Slice 1

- **T5** `internal/mangrove`: blob upload/fetch on the client.
- **T6** `POST /v1/mangrove/publish` accepts `file` (a workspace media path) and
  `entities` (graph entity names); resolve, then publish. *Covers*: FR-A, FR-B1,
  FR-B2, FR-F3.
- **T7** `GET /v1/mangrove/blob` — proxy the fetch, octet-stream, attachment.
- **T8** `POST /v1/mangrove/merge` — the narrow write. *Covers*: FR-C1, FR-C3,
  FR-C4, FR-D1, DD-5.
- **T9** `mangrove_publish` accepts `entities` and `file`. *Covers*: FR-G.
- **T10** Tests, including **the pair**: a person merges and the graph changes;
  an agent admits and it does not. *Covers*: FR-C2, AC-6, AC-7.

## Slice 3 — the gateway (`zombie-crab-project`) — depends on T7, T8

- **T11** `POST /v1/mangrove/merge` and `GET /v1/mangrove/blob` in both configs,
  one entry per role, named not wildcarded.
- **T12** `scripts/gateway_routes.py` reports **102** routes, not merely exit 0.
  Two routes are being added to a checked surface of 100; asserting the number
  is what distinguishes a real pass from a vacuous one.

## Slice 4 — the webapp (`crab-exoskeleton-webapp`) — depends on Slice 2

- **T13** Graph panel: multi-select. *Covers*: FR-B4.
- **T14** Files tab: per-file share action. *Covers*: FR-F1.
- **T15** Graph panel: share the selection. *Covers*: FR-F2.
- **T16** Compose: file and fragment attachments. *Covers*: DD-6.
- **T17** Mangrove tab: download a file, merge a fragment, reference in chat.
- **T18** `MangroveReference` as the fourth `ChatReference`. *Covers*: FR-E.
- **T19** i18n both catalogues; parity green.

## Slice 5 — the chain

- **T20** Merge bottom-up, bump each pointer at a commit on the default branch.
- **T21** `STATE.md`: AD-031 for D-4, the security property.
