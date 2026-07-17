# Design — Chat UI Material 3 Refactor + Workspace Shell

Traces `spec.md`. No backend changes; every `/api/*` route and payload is untouched.

## 1. Design plan (frontend-design)

The brief pins the direction (Material 3 structure + Lepista skin), so the freedom is in
execution, not identity. The plan below is the calibration reference; every color/type decision in
code derives from it.

**Color** — Lepista tokens, arranged into an M3 tonal hierarchy (surface steps carry the depth
that MUI elevation used to):

| Token | Light | Dark | Role |
|---|---|---|---|
| `--bg` | `#ffffff` | `#14171a` | app background (M3 surface) |
| `--surface-1` | `#f7f9fa` | `#1b1f23` | sidebars, cards (surface container) |
| `--surface-2` | `#eef3f5` | `#232a30` | raised/selected rows, composer field |
| `--accent` | `#64C5EB` | `#64C5EB` | primary accent (cyan) |
| `--accent-soft` | `#9AD9F0` | `#9AD9F0` | state-layer / signature shadow tint |
| `--border` | `#663a88` | `#a988c9` | structural violet border (brand) |
| `--fg` | `#0a2933` | `#e6eef2` | text primary |
| `--fg-muted` | `#5a6b72` | `#9fb0b7` | secondary text |

State layer = `--accent` at 8% (hover) / 12% (focus) / 16% (press), composited over the surface —
the M3 state-layer idiom replacing MUI ripples.

**Type** — the three faces already self-hosted via `next/font` in `layout.tsx` (kept):
- **Bricolage Grotesque** (`--font-display`): section eyebrows (WORKSPACES), headings, brand.
- **Hanken Grotesk** (`--font-sans`): all UI/body text.
- **Space Mono** (`--font-mono`): code blocks, ids, the access badge text.

**Layout** — three columns, an M3 navigation-drawer + secondary-drawer + content pane:

```
┌──────────────┬───────────────┬──────────────────────────────┐
│ NAV DRAWER   │ HISTORY DRAWER│  CHAT VIEW                    │
│ (always)     │ (if workspace)│                              │
│  ▸ brand     │  New chat  +  │   ┌───── conversation ─────┐ │
│              │  search       │   │  (centered, readable   │ │
│  WORKSPACES  │  ─ CONVERS. ─ │   │   measure ~720px)      │ │
│  ▾ Tenant A  │  • Session 1  │   │                        │ │
│    ▾ Acct X  │  • Session 2  │   └────────────────────────┘ │
│      • alpha●│  • Session 3  │                              │
│      • beta  │               │   ┌── composer (signature)─┐ │
│  ▾ Tenant B  │               │   │ [ type a message… ] (↑)│ │
│    …         │               │   └────────────────────────┘ │
│  ─────────── │               │                              │
│  user@… ⏻    │               │                              │
│  ~280px      │  ~300px       │  flex                        │
└──────────────┴───────────────┴──────────────────────────────┘
```

When no workspace is selected: history drawer is absent, chat view shows the empty/welcome state.

**Signature** — the **composer**: a large rounded surface (`--surface-2`) with a violet 1px border,
an auto-growing textarea, and the send action as an integrated circular accent button that lifts on
hover; on focus the field gets a soft cyan ring (`--accent-soft`). This is the one element carrying
the "inviting chat box" boldness the user asked for. Everything else stays quiet: flat surfaces,
1px violet borders, 8px radius. The neobrutalist hard-offset shadow stays reserved for `/signin`
only (per the Lepista rule in the old `theme.ts`) — not in the dashboard shell.

## 2. Tooling migration (MUI+Emotion → Tailwind + cva)

**Remove** (package.json): `@mui/material`, `@mui/icons-material`, `@mui/material-nextjs`,
`@emotion/react`, `@emotion/styled`.

**Add:** `tailwindcss` + `@tailwindcss/postcss` (Tailwind v4, CSS-first config — its `@theme`/
CSS-variable model is exactly the token approach above; no `tailwind.config.js` needed),
`class-variance-authority`, `clsx`, `tailwind-merge`, and `lucide-react` (icon set replacing
`@mui/icons-material` — clean, tree-shakeable, Material-adjacent line icons).

> Verification note (knowledge chain): the exact Tailwind v4 + Next 15 wiring
> (`postcss.config.mjs` → `@tailwindcss/postcss`, `@import "tailwindcss"` in `globals.css`,
> `@theme` block) is confirmed against Tailwind docs via Context7 in task T02 before relying on it.
> If v4 integration proves fragile in this Docker/Next setup, fall back to Tailwind v3.4 with a
> classic `tailwind.config.ts` — the token names above are unchanged either way.

**`app/globals.css`** (new): `@import "tailwindcss";`. **Dark mode must actually flip** — the v4
footgun is that a literal value in `@theme { --color-bg: #fff }` is baked at build time, so a later
`@media (prefers-color-scheme: dark)` override on the same custom prop never reaches the generated
utility. Use the **semantic-var + `@theme inline`** pattern:

```css
:root { --bg:#ffffff; --surface-1:#f7f9fa; /* …light values… */ }
@media (prefers-color-scheme: dark) { :root { --bg:#14171a; --surface-1:#1b1f23; /* …dark… */ } }
@theme inline {                 /* `inline` keeps the utilities pointing at the vars, not the values */
  --color-bg: var(--bg);
  --color-surface-1: var(--surface-1);
  /* accent/border/fg/… ; radius 8px ; font families → --font-display/sans/mono */
}
```

Plus base resets and a reduced-motion guard (`@media (prefers-reduced-motion: reduce)` zeroing
transitions). Imported once in `app/layout.tsx`.

`app/page.tsx` (root redirect `/chat`↔`/signin`) is already MUI-free — verified, no change needed.
`middleware.ts` matches `/chat/:path*` — deleting `/chat/session` does not affect auth gating,
verified, no change needed.

**`lib/cn.ts`** (new): `cn(...inputs) = twMerge(clsx(inputs))` — standard cva companion.

## 3. Component library (cva primitives)

New dir `webapp/components/ui/`. Each is a small cva component; no business logic. These replace the
MUI components 1:1 in usage.

| File | Replaces | Variants |
|---|---|---|
| `button.tsx` | `@mui/material/Button` | `variant: filled \| outlined \| text \| tonal`; `size: sm \| md`; M3 state layer + focus ring |
| `icon-button.tsx` | icon `Button`/`IconButton` | round, state layer; used by send, collapse chevrons, logout |
| `input.tsx` | `TextField` (single-line) | outlined field w/ violet border + cyan focus ring (search, email, code) |
| `textarea.tsx` | `TextField multiline` | auto-grow (rows via `field-sizing` / scrollHeight), used by composer |
| `badge.tsx` | `Chip` | `tone: accent \| neutral`; small pill; used for agent tag + access badge |
| `surface.tsx` | `Paper`/`Card` | tonal level `1 \| 2`; optional `bordered`; `signatureShadow` opt-in prop for signin |
| `spinner.tsx` | `CircularProgress` | sizes; CSS `animate-spin`, respects reduced motion |
| `alert.tsx` | `Alert` | `severity: error \| info`; used for signin + chat errors |

The `signatureShadow` helper (hard-offset cyan shadow + hover-lift) moves from `lib/theme.ts` into
`surface.tsx`/`button.tsx` as an opt-in cva variant, used only on `/signin`.

## 4. Shell architecture

Fragment state (DEC-4) is unchanged — `app/chat/fragment.ts` stays as-is (it has no MUI). The shell
is a single `/chat` route; `/chat/session` is deleted.

```
app/chat/
  page.tsx            server: getSession() → <ChatShell email=…/>          (rewritten)
  chat-shell.tsx      client: reads useFragment(); owns the 3-column grid   (NEW)
  nav-sidebar.tsx     first sidebar: brand, <section> list, user footer     (NEW)
  workspace-nav.tsx   "Workspaces" section: fetch → dedup+group → tree      (NEW)
  history-sidebar.tsx second sidebar: conversation list+search+new          (from sidebar.tsx)
  chat-view.tsx       messages column + streaming (from session/page.tsx)   (moved)
  composer.tsx        the signature chat box, owns autofocus                (NEW, extracted)
  empty-state.tsx     no-workspace welcome                                  (NEW)
  message-content.tsx markdown, no MUI                                      (rewritten)
  logout-button.tsx   no MUI                                                (rewritten)
  fragment.ts         unchanged
  workspace-picker.tsx  DELETED
  session/            DELETED (page.tsx → chat-view.tsx, layout.tsx removed)
```

**`ChatShell`** (client): reads `useFragment()`; derives `workspace = toWorkspace(fragment)`.
- Always renders `<NavSidebar>`.
- If `workspace`: renders `<HistorySidebar workspace>` + `<ChatView workspace sessionId>`.
- Else: renders `<EmptyState>` in the content pane, no history sidebar.
- CSS grid with columns `280px [300px?] 1fr`; sidebars collapse to overlay/hidden on narrow
  viewports (responsive floor); content pane always present.

**Selection flow (WS-3):** clicking an agent leaf in `WorkspaceNav` builds `{t,s,r}`, creates a
conversation (`createConversation`, as the old picker did), and sets the full fragment via
`fragmentHash`-style write (a new `setWorkspaceAndSid(workspace, sid)` helper added to
`fragment.ts`, or reuse `window.location.hash = …`). This makes `ChatShell` re-render with the
workspace present → history drawer opens, chat view mounts, composer autofocuses (CHAT-3).

**`/signin` redirect** stays `router.push("/chat")`. Any internal links that pointed at
`/chat/session#…` (workspace-picker's `router.push(\`/chat/session${fragmentHash(…)}\`)`) are
removed with the picker.

## 5. Workspace dedup + grouping

New pure module `lib/subscriptions.ts` (testable, no React):

```ts
import type { Instance } from "@/lib/mycelium";

export interface Subscription {          // shape from /api/subscriptions (unchanged)
  tenantId: string; subsAccId: string; accName: string;
  role: string; perm: string; verified: boolean; scaffolded: boolean;
}

export interface AgentLeaf {
  tenantId: string; subsAccId: string; accName: string;
  role: Instance;                         // the chattable agent
  perms: string[];                        // union, normalized ("read","write")
  verified: boolean; scaffolded: boolean; // OR-reduced across merged rows
}
export interface AccountGroup { subsAccId: string; accName: string; agents: AgentLeaf[]; }
export interface TenantGroup  { tenantId: string; accounts: AccountGroup[]; }

// key = tenantId | subsAccId | role  → perm is NOT part of identity (DEC-3)
export function groupWorkspaces(subs: Subscription[]): TenantGroup[];
export function accessLabel(perms: string[]): string; // "read" | "write" | "read·write"
```

- Rows are collapsed on `tenantId|subsAccId|role`; `perm` is normalized case-insensitively into a
  set (`read`/`write`), `verified`/`scaffolded` OR-reduced. `accessLabel` renders the badge text.
- `perm` casing/values come from an external feed (crab-shell-proxy) — this is a system boundary,
  so `accessLabel` normalizes defensively (lowercase, dedup, sorted read-then-write). **When the
  perm set is empty, `accessLabel` returns empty and the leaf renders NO badge** (mirrors the old
  picker's `sub.perm ?` guard) — don't show a raw/blank token.
- Account labels fall back to `subsAccId` when `accName` is blank (the picker used
  `accName || subsAccId`); apply the same fallback on the account group header.
- The `/api/subscriptions` route already filters to `isInstance(role)`; grouping does no filtering.
- `WorkspaceNav` fetches `/api/subscriptions` (same call the picker made), maps through
  `groupWorkspaces`, and renders collapsible tenant/account headers with agent leaves. Single-child
  groups render expanded. Loading/empty/error states live here (WS-5).

## 6. History sidebar

`history-sidebar.tsx` is `sidebar.tsx`'s conversation logic, minus the workspace chip/brand/switch
button (those move to the nav sidebar) and restyled. Preserved verbatim in behavior: the
`listConversations` + `onConversationsUpdated` effect, the debounced full-content search
(`historyQuery` + `/api/chat/[role]/history`), the loading affordance, active-item marker, New chat
(`createConversation` → `setFragmentSid`). Only presentation changes. It receives `workspace` as a
prop from `ChatShell` (guaranteed non-null since it only renders when selected).

## 7. Chat view + composer

`chat-view.tsx` = `session/page.tsx`'s logic, MUI stripped. The streaming `sendMessage`,
`consumeStream`, scroll-to-message behavior, history load, and error handling are preserved exactly.

`composer.tsx` (extracted, the signature element):
- Auto-growing `<textarea>` (Enter=send, Shift+Enter=newline — preserved), send as an integrated
  circular accent `IconButton` (lucide `ArrowUp` / `Send`), disabled while `sending || loadingHistory`
  or empty.
- **Autofocus (CHAT-3) — deliberate deviation from "port identically":** the old `session/page.tsx`
  disables the field with `disabled={sending || loadingHistory}`. Keeping that verbatim breaks the
  requirement: every session click starts a history fetch, so at the moment the focus effect fires
  `loadingHistory` is `true`, the textarea is disabled, and `.focus()` no-ops on a disabled element.
  Fix: **the textarea is NOT disabled during `loadingHistory`** (users can type while history loads);
  only the **send control** is gated on `sending || loadingHistory || empty`. The autofocus
  `useEffect` fires on `sessionId` change AND on the `loadingHistory` → false transition, guarded so
  message-stream updates don't re-steal focus.
- Centered column (`max-w-[720px] mx-auto`) shared with the message list so composer and messages
  align. Composer anchored to the bottom of the chat view; message list scrolls above it.

Message bubbles: user = accent fill (`--accent`, dark contrast text) right-aligned; assistant =
`--surface-2` tonal left-aligned, with the blinking-cursor span during streaming. `message-content.tsx`
re-implements the same react-markdown component map with Tailwind classes (mono font for code via
`font-mono`, `--surface-2` for code blocks).

## 8. Peripheral screens (MISC)

- `providers.tsx`: **deleted** (no MUI ThemeProvider/CssBaseline/AppRouterCacheProvider needed).
  `layout.tsx` keeps the `next/font` wiring and adds `import "./globals.css"`, renders `{children}`
  directly.
- `signin/page.tsx`: rebuilt with `surface.tsx` (signature-shadow variant on), `input`, `button`,
  `alert` — same two-step flow, autofocus, error copy.
- `logo.tsx`: two `next/image`s toggled by `prefers-color-scheme` via Tailwind
  (`block dark:hidden` / `hidden dark:block`) — but note current app uses `media` scheme with **no**
  `dark` class strategy; globals.css will define dark via `@media`, and the logo swap uses the same
  `@media` (a tiny CSS utility or the `dark:` variant configured for media). Verified in T02.
- `logout-button.tsx`, `message-content.tsx`: no-MUI rewrites (see §3, §7).

## 9. Testing / verification

The webapp has **no test runner** (no test script in package.json). Verification is:
1. `groupWorkspaces` / `accessLabel` are pure — a throwaway `node`/`tsx` check on sample rows
   (incl. a read+write duplicate) during T for the data model, output pasted into the task result.
2. `grep -r "@mui\|@emotion" webapp/app webapp/lib webapp/components` returns empty (DS-1).
3. `next build` (or `yarn build`) passes with no type errors — the primary gate.
4. Runtime drive via the `verify`/`run` skill: sign in → shell → pick a workspace with a
   read+write dup (appears once, `read·write` badge) → second sidebar opens → click a session →
   composer focused → send → reply streams → search → toggle OS dark mode.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Tailwind v4 + Next 15 Docker build friction | T02 verifies against docs first; v3.4 fallback documented (§2). |
| `perm` string values unknown (case/spelling) | `accessLabel` normalizes at the boundary; badge degrades to raw token if unrecognized. |
| Losing a subtle behavior in the MUI strip (scroll pinning, search debounce, stream parsing) | chat-view/history-sidebar are *moved* logic, not rewritten; only JSX/classNames change. |
| `next/image` optimization (L-008) | unchanged — `images.unoptimized` already set; logo swap logic preserved. |
| Focus-steal on autofocus during streaming | guard the composer autofocus effect on `sessionId` change only, not on message updates. |
