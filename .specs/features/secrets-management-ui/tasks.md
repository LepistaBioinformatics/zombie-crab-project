# secrets-management-ui Tasks

Frontend feature (chat-webapp), implemented by the separate frontend agent.
Gate: `next build` (typecheck + compile) green — via
`docker build --network=host -t zombie-crab-project-chat-webapp:latest ./webapp`
— plus manual click-through against a running stack (needs the gateway rebuilt
so `/v1/secrets` is routed). `[P]` = parallelizable.

---

### T01 — BFF `/api/secrets` proxy (GET/POST/DELETE) — SM-04
- **What:** `app/api/secrets/route.ts` mirroring `app/api/subscriptions/route.ts`:
  `getSession` (401), `isInstance(role)` (400), `fetchMycelium` to
  `/picoclaw-<role>/v1/secrets` with the JWT; `upstreamError` for real 4xx (no
  connectivity mask); never log/echo `value`.
- **Done when:** the three methods forward correctly; a proxy 400/403 surfaces
  its message; typecheck passes.
- **Depends on:** — (reuses `lib/mycelium.ts`)

### T02 — Secrets drawer shell + toggle — SM-01
- **What:** a slide-over drawer opened from the chat view; disabled when there is
  no fragment workspace; reads `tenant/subs/role` via `app/chat/fragment.ts`.
- **Done when:** opens/closes from the chat; scoped to the current workspace;
  no-workspace state handled.
- **Depends on:** — (fragment helper exists)

### T03 — List names + delete — SM-03
- **What:** on open, `GET /api/secrets` and render names grouped by format
  (never values); per-secret delete (confirm → `DELETE` → refresh); empty state.
- **Done when:** names render grouped, no value shown; delete removes + refreshes;
  empty state shows.
- **Depends on:** T01, T02

### T04 — Guided inject form — SM-02
- **What:** format selector; `native` → web-provider dropdown (fixed set) + model
  dropdown for `model_list.<model>.api_keys`, NO `channel_list`; `dotenv|json|file`
  → free-text name (client-validate `^[A-Za-z0-9._-]+$`); `value` (password-style,
  cleared on success). Submit → `POST /api/secrets` → refresh + clear.
- **Done when:** each format submits to the right shape; native uses dropdowns;
  channel_list never offered; 400/403 shows the real message.
- **Depends on:** T01, T02

### T05 [P] — Surfacing copy + restart/applying state — SM-05
- **What:** an "applying — the agent restarts (a live turn is briefly
  interrupted)" indicator during POST/DELETE; copy that secrets persist for
  (you, this agent) across subscriptions and are write-only (never shown).
- **Done when:** the restart indicator shows during apply; the scope/write-only
  copy is present.
- **Depends on:** T03, T04

### T06 [P] — cva className convention — SM-06
- **What:** all new components use class-variance-authority variants (drawer
  open/closed, format tabs, rows, buttons); no inline conditional/interpolated
  `className`.
- **Done when:** no inline conditional/interpolated `className` in the new files;
  build green.
- **Depends on:** applied within T02–T05

### T07 — Verify
- **What:** `next build` green; manual: open drawer, inject a `dotenv` secret →
  name appears (no value) + agent restarts; a `native` web key via dropdown;
  channel_list absent; a 400/403 shows the real message; delete removes + restarts.
- **Done when:** spec §Success Criteria observed. **Note:** live path needs the
  gateway rebuilt (routes `/v1/secrets`).
- **Depends on:** T01–T06

---

## Dependency graph
```
T01 ─┬─ T03 ─┬─ T05 ─┐
T02 ─┴─ T04 ─┘        ├─ T07
        T06 (within T02–T05)
```
