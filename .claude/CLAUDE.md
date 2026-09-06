# zombie-crab-project — Claude Code instructions

Monorepo-wide rules. Each submodule has its own `.claude/CLAUDE.md` for rules that
only apply inside it; this file holds what applies across the stack.

## Open this repo's PR only after its submodules' PRs are merged

`crab/crab-shell-proxy` and `crab/crab-exoskeleton-webapp` are separate
repositories with their own PRs. **Do not open — or even commit — a pointer bump
here until the commit it points at is a merge on that submodule's `main`.**

**Why.** A pointer recorded against a PR branch head is stale the moment that PR
merges: the merge commit is a different sha, and the branch it named can be
deleted. This repository then lands describing a proxy or a webapp that no branch
points at any more, and the fix is a second PR that exists only to move a line.
That happened on 2026-09-06 — #54 was opened with both pointers at branch heads
and needed `08971f8` before it could merge, and the repo above this one merged a
pointer at a PR-branch commit and needed a correction PR of its own.

**While waiting:** open the submodule PRs, report the merge order, and commit
nothing here. An unpushed commit that has to be amended is worse than no commit —
a rebase or a branch switch can strand it.

**Unless the maintainer asks otherwise.** "Open all of them now so I can review
the whole chain" is a legitimate request. When it is made, the PR body must say
which pointers are branch heads and what has to be advanced before it lands.

**When they are merged:** `git -C crab/<name> checkout main && git pull
--ff-only`, then commit the bump naming the merge commits and their PR numbers.

The repository ABOVE this one (`zombie-crab-project-mkt`, which carries this one
as a submodule) has the same rule for the same reason, in its own
`.claude/CLAUDE.md`. The chain is merged bottom-up, one level at a time.

## Calling mycelium

**Always call mycelium over JSON-RPC. Never add a new call to its REST surface.**

Mycelium's gateway exposes both a REST API and a JSON-RPC 2.0 endpoint at
`POST /_adm/rpc`. The two are not interchangeable, and REST is the wrong default:

- The REST `beginners` endpoints are **external-identity-provider only**. For a
  magic-link user they answer `400 "Invalid provider"`. The RPC dispatcher resolves
  the internal issuer instead, so it is the only transport that works for this
  deployment's own users. This was established empirically, not assumed — see
  `crab/crab-exoskeleton-webapp/.specs/features/onboarding/context.md`.
- The RPC surface is broader and named consistently. Whole operations (guest
  invite/uninvite, account get) have no equivalent this stack can reach over REST.

### How

Envelope: `{"jsonrpc": "2.0", "method": "<name>", "params": {...}, "id": 1}` with
`Authorization: Bearer <session token>`. Params are **camelCase**.

In `crab-exoskeleton-webapp`, this means `myceliumRpc()` from `lib/mycelium.ts` —
never a new `fetchMycelium()` path. Its one legitimate REST use is the pre-session
magic-link request/verify pair, which has no token to authenticate RPC with.

### Finding method names — never guess one

The authoritative registry is `ports/api/src/rpc/method_names.rs` in the mycelium
checkout, and `rpc.discover` returns an OpenRPC self-description at runtime. An
invented method name fails at runtime only, and the failure looks like a
permissions problem. Look it up.

Note that RPC names do not always match REST vocabulary: REST's `uninvite_guest`
is `subscriptionsManager.guests.revokeUserGuestToSubscriptionAccount` over RPC.

### Wire shapes that have already caused bugs

Check the Rust DTO before trusting a field's shape — the reference
`mycelium-webapp` TypeScript types have been wrong about several of these:

- **`Parent<T, Id>` is an externally tagged enum**: `{"record": {...}}` or
  `{"id": "<uuid>"}` — *not* a flat object. Reading it flat silently produced
  unlabelled roles and hid a whole UI affordance.
- **`Email` is `{username, domain}`**, not a string.
- **A permission** arrives as either its `0`/`1` discriminant or its string form
  (`"read"`/`"write"`), depending on the serializer. Normalize both, and match
  exactly — `"overwrite"` contains `"write"`.
- **List results** may be a bare array or a paginated envelope
  `{count, skip, size, records}`. Unwrap both.
- **Page sizes default small** (10 for guest roles). Pass `pageSize` explicitly;
  a truncated list looks like missing data, not like an error.

### Where this rule does not apply

Requests routed through **crab-shell-proxy** — `/{agent}/v1/...` and
`/alpha/v1/admin/...` — are the proxy's own HTTP API, not mycelium's. Those stay
REST. "Talk to mycelium over JSON-RPC" is not "convert the proxy to JSON-RPC".
