# white-label-pwa — Specification

## Summary

Two capabilities in the chat-webapp:

1. **PWA** — make the app installable (manifest + service worker + icons +
   offline fallback), so it can be added to a home screen and loads fast.
2. **White-label** — an instance-admin screen to set a custom **app name** and
   **logo** (light + dark). Defaults are `zombie-crab` + the bundled logos; admins
   can override them so the deployment ships with its own brand. The custom name
   and logo drive the UI, the document title, the PWA manifest, the icons, and
   the favicon.

Webapp-only (no proxy/mycelium changes beyond reading the caller's profile).

## Decisions (from discussion)
- **Per-instance** branding (one brand for the whole deployment), editable only
  by **instance admins** (`isStaff || isManager`). Fits PWA's one-manifest-per-
  origin nature.
- **Light + dark logo** variants (mirrors today's `Logo`); no image-processing
  dependency — uploaded images are served as-is; the PWA icon uses the light one.

## Functional requirements

### Branding storage & API
- **FR-1** Branding is a postgres singleton: `app_name`, `logo_light`(+type),
  `logo_dark`(+type). Unset name → `zombie-crab`; unset logo → the bundled
  `/logo-{light,dark}.jpg`.
- **FR-2** `GET /api/branding` (public) → `{ appName }` (custom or default).
- **FR-3** `GET /api/branding/logo/{light|dark}` (public) → the custom image
  bytes, or the bundled default when unset. Cacheable.
- **FR-4** Writes are **instance-admin only** (403 otherwise), verified from the
  session token via mycelium `beginners.profile.get` (`isStaff||isManager`):
  - `PUT /api/branding` `{ appName }` (empty → reset to default).
  - `POST /api/branding/logo/{light|dark}` (multipart `file`) → store.
  - `DELETE /api/branding/logo/{light|dark}` → reset to default.
- **FR-5** `GET /api/branding/can-edit` → `{ canEdit }` (instance-admin check),
  for UI gating.

### PWA
- **FR-6** `GET /manifest.webmanifest` (dynamic) reflects branding: `name`/
  `short_name` from the app name, `icons` (192/512, `purpose: "any maskable"`)
  pointing at the branding light-logo endpoint, `display: "standalone"`,
  `start_url: "/chat"`, `scope: "/"`, theme/background colors.
- **FR-7** A **service worker** makes the app installable and caches the app
  shell, with an **offline fallback** page. Chat itself needs the network — no
  offline chat; the SW just keeps the shell usable and fast.
- **FR-8** The document `<head>` links the manifest, sets `theme-color`, an
  `apple-touch-icon` (branding light logo) and `apple-mobile-web-app-*` metas;
  the document title uses the app name.

### UI
- **FR-9** The `Logo` component and every visible app-name string
  (`zombie-crab` in the nav header, admin header, signin) use the branding
  (name from `/api/branding`, logos from the logo endpoints, default fallback).
- **FR-10** A **Branding** section in the admin area (visible only when
  `can-edit`): edit the name, upload/preview/reset the light and dark logos.

## Non-functional
- **NFR-1** Defaults must work with an empty `branding` table (fresh install
  shows `zombie-crab` + bundled logos) — additive migration.
- **NFR-2** No new heavyweight dependencies (no `sharp`, no `next-pwa`); a hand-
  written manifest route + minimal service worker.
- **NFR-3** Branding writes are server-side gated on instance-admin; the UI gate
  is convenience only.

## Out of scope
- Per-tenant branding (PWA is per-origin; instance-scope only).
- Offline chat / background sync.
- Auto-generating icon sizes from one upload (serve uploaded images as-is).
- Theming colors/fonts (name + logo only in v1).
