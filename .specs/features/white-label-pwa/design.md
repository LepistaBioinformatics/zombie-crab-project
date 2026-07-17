# white-label-pwa — Design & Contract

Split into two parallel streams with a fixed contract.

## Data / DB (`webapp/lib/db.ts`)

Additive migration in `ensureSchema()`:
```sql
CREATE TABLE IF NOT EXISTS branding (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  app_name TEXT,
  logo_light BYTEA, logo_light_type TEXT,
  logo_dark  BYTEA, logo_dark_type  TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```
Functions:
```ts
const DEFAULT_APP_NAME = "zombie-crab";
getAppName(): Promise<string>                    // app_name ?? DEFAULT_APP_NAME
setAppName(name: string | null): Promise<void>   // upsert id=1
getLogo(variant: "light"|"dark"): Promise<{ bytes: Buffer; type: string } | null>  // null → caller serves bundled default
setLogo(variant, bytes: Buffer, type: string): Promise<void>
clearLogo(variant): Promise<void>
```

## Instance-admin gate (`webapp/lib/instanceAdmin.ts`, new)
```ts
// True when the session's mycelium profile is staff or manager.
isInstanceAdmin(token: string): Promise<boolean>
```
Implementation: `myceliumRpc<{isStaff?:boolean; isManager?:boolean}>("beginners.profile.get", {}, token)`
→ `rpc.ok && !!(rpc.result?.isStaff || rpc.result?.isManager)`. (Same RPC/helper
onboarding uses; the SDK profile exposes `isStaff`/`isManager`.)

## Contract — Branding API (both streams honor exactly)
- `GET /api/branding` → `{ "appName": string }` (public).
- `GET /api/branding/logo/light` , `GET /api/branding/logo/dark` → raw image
  bytes with the stored `Content-Type`, or the bundled default
  (`public/logo-light.jpg` / `logo-dark.jpg`) when unset. `Cache-Control:
  no-cache` (so a rebrand shows quickly). Public.
- `PUT /api/branding` `{ appName: string }` → `{ appName }`. 401 no session; 403
  not instance-admin; empty string resets to default.
- `POST /api/branding/logo/{light|dark}` multipart field `file` (png/jpeg/webp/svg;
  reject others 400; cap ~1MB) → `{ ok: true }`. 401/403 as above.
- `DELETE /api/branding/logo/{light|dark}` → `{ ok: true }`. 401/403 as above.
- `GET /api/branding/can-edit` → `{ canEdit: boolean }` (session required; false
  if not instance-admin).
- `GET /manifest.webmanifest` → dynamic manifest (see FR-6). `Content-Type:
  application/manifest+json`.

## Stream A — backend (routes + db + gate)
Files: `webapp/lib/db.ts` (branding table + fns), `webapp/lib/instanceAdmin.ts`
(new), `webapp/app/api/branding/route.ts` (GET/PUT),
`webapp/app/api/branding/logo/[variant]/route.ts` (GET/POST/DELETE),
`webapp/app/api/branding/can-edit/route.ts` (GET),
`webapp/app/manifest.webmanifest/route.ts` (GET, dynamic).
- Logo GET falls back to reading the bundled file from `public/` via `fs` when
  the DB has none (or 302-redirect to `/logo-light.jpg`). Prefer redirect to the
  static default to keep it simple.
- Validate `variant ∈ {light,dark}`; sanitize; enforce content-type + size.

## Stream B — frontend (PWA + UI + admin tab)
Files: `webapp/public/sw.js` (new, minimal), `webapp/app/sw-register.tsx` (new
client component; registers `/sw.js`), `webapp/app/offline/page.tsx` (new),
`webapp/app/layout.tsx` (dynamic `generateMetadata` title from `getAppName`;
`<link rel="manifest">`, theme-color, apple-touch-icon → `/api/branding/logo/light`,
apple-mobile-web-app metas; render `<SwRegister/>`), `webapp/app/logo.tsx`
(use `/api/branding/logo/{light,dark}` via `<img>`, keep the prefers-color-scheme
toggle), a `webapp/app/brand-name.tsx` client component (fetch `/api/branding` →
appName, fallback `zombie-crab`) used where `zombie-crab` is shown, and the admin
**Branding** panel (`webapp/app/admin/branding-panel.tsx` + a tab/section in
`admin-screen.tsx`, shown only when `/api/branding/can-edit` is true).
- Service worker: precache the offline page + app shell; network-first for
  navigations with the offline page as fallback; cache-first for static assets.
  Keep it small and dependency-free. Bump a `CACHE_VERSION` const.
- NOTE `app/layout.tsx`, `app/chat/nav-sidebar.tsx`, `app/admin/admin-screen.tsx`
  are edited by OTHER agents in parallel — make additive, minimal edits; re-read
  before editing.
- `className` via cva; reuse existing UI primitives.

## Test / gate
- Webapp: `yarn tsc --noEmit` clean; `next build` compiles (manifest route, SW
  static, routes typecheck). Verify `/manifest.webmanifest` returns valid JSON
  and `/api/branding` returns the default name on an empty table.
