# Tasks — Chat UI Material 3 Refactor + Workspace Shell

Traces `spec.md` / `design.md`. `[P]` = parallelizable with siblings. Gate for every code task:
`cd webapp && yarn build` (next build, no type errors) unless noted. Global final gate adds
`grep -rn "@mui\|@emotion" webapp/app webapp/lib webapp/components` → empty.

Dependency graph:
```
T01 → T02 → T03 ┐
        └→ T04 ─┤
T02,T03 ────────┼→ T05 ─┐
T03,T04 ────────┼→ T06 ─┤
T02,T03 ────────┼→ T07 ─┼→ T09 → T11
T02,T03 ────────┼→ T08 ─┘        ↑
T03 ────────────┴→ T10 ──────────┘
```

---

## Phase 1 — Tooling & tokens

### T01 — Swap dependencies
- **What:** In `webapp/package.json` remove `@mui/material`, `@mui/icons-material`,
  `@mui/material-nextjs`, `@emotion/react`, `@emotion/styled`. Add `tailwindcss`,
  `@tailwindcss/postcss`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`.
  Run `yarn install`.
- **Where:** `webapp/package.json`, `yarn.lock`.
- **Depends on:** —
- **Reuses:** —
- **Done when:** `yarn install` completes; MUI/Emotion no longer in `node_modules/.yarn-integrity`
  resolution (removed from package.json). Build will break until T02+ — expected.
- **Gate:** `yarn install` exits 0. (No build yet.)

### T02 — Tailwind v4 wiring + token layer
- **What:** Add `postcss.config.mjs` (`@tailwindcss/postcss`). Create `app/globals.css`:
  `@import "tailwindcss"`, a `@theme` block exposing `accent`, `accent-soft`, `border-brand`,
  surfaces, `fg`/`fg-muted`, radius `8px`, and the `--font-display/sans/mono` families; `:root`
  light values + `@media (prefers-color-scheme: dark)` dark values; base reset; reduced-motion
  guard. Import `globals.css` in `app/layout.tsx` and **remove** the `<Providers>` wrapper (render
  `{children}` directly; keep `next/font` vars on `<html>`). Add `lib/cn.ts`. Delete
  `app/providers.tsx` and `lib/theme.ts`.
- **Where:** `webapp/postcss.config.mjs` (new), `app/globals.css` (new), `app/layout.tsx`,
  `lib/cn.ts` (new); delete `app/providers.tsx`, `lib/theme.ts`.
- **Depends on:** T01
- **Reuses:** existing `next/font` setup in `layout.tsx`.
- **Verify first (knowledge chain):** confirm Tailwind v4 + Next 15 App Router wiring via Context7 —
  and specifically that **dark-mode tokens actually flip**, not just that the build passes. Use the
  `:root`/`@media` + `@theme inline { --color-*: var(--*) }` pattern (design §2); a literal value in
  `@theme` bakes at build and the `@media` override never reaches the utility. If v4 fails in the
  Docker/Next build, fall back to Tailwind v3.4 + `tailwind.config.ts` (same token names) and note it.
- **Note:** `app/page.tsx` (root redirect) is already MUI-free — no edit needed, but confirm no new
  import sneaks in.
- **Done when:** a temporary `<div className="bg-accent text-fg rounded-[8px]">` renders with the
  cyan token AND flipping OS dark mode changes `--bg` at runtime (inspect computed style, not just
  a passing build).
- **Gate:** `yarn build` passes (layout + a minimal page). Signin/chat may be temporarily broken
  (still importing MUI) — acceptable mid-migration; note which files still break.

---

## Phase 2 — Primitives & data model (parallel)

### T03 — cva UI primitives  [P]
- **What:** Build `webapp/components/ui/`: `button.tsx` (variants filled/outlined/text/tonal, sizes,
  M3 state layer + focus ring, opt-in `signatureShadow`), `icon-button.tsx`, `input.tsx`,
  `textarea.tsx` (auto-grow), `badge.tsx` (accent/neutral), `surface.tsx` (tonal 1/2, bordered,
  signatureShadow prop), `spinner.tsx`, `alert.tsx` (error/info). All use `cn()` + cva. No business
  logic. Move the `signatureShadow` hard-offset-shadow recipe here from the deleted `theme.ts`.
- **Where:** `webapp/components/ui/*.tsx`.
- **Depends on:** T02
- **Reuses:** `lib/cn.ts`, tokens from `globals.css`.
- **Done when:** each primitive renders with correct variants on a scratch page; keyboard focus
  ring visible; state layer on hover.
- **Gate:** `yarn build` passes.

### T04 — Workspace dedup + grouping  [P]
- **What:** `lib/subscriptions.ts`: `Subscription` type, `AgentLeaf`/`AccountGroup`/`TenantGroup`,
  `groupWorkspaces(subs)` collapsing on `tenantId|subsAccId|role` (perm → union set,
  verified/scaffolded OR-reduced), and `accessLabel(perms)` → `read|write|read·write` (defensive
  normalization; **empty perm set → empty string / no badge**). Account header label falls back to
  `subsAccId` when `accName` is blank.
- **Where:** `webapp/lib/subscriptions.ts` (new).
- **Depends on:** T02 (only for repo state; logically independent of tokens)
- **Reuses:** `Instance`/`isInstance` from `lib/mycelium.ts`.
- **Done when:** a throwaway `npx tsx`/`node` check over sample rows including a read+write
  duplicate returns a single leaf with `read·write`; two agents under one account stay distinct;
  two accounts under one tenant nest correctly. Paste the output in the task result.
- **Gate:** purity check output + `yarn build` passes.

---

## Phase 3 — Shell

### T05 — Nav sidebar + shell frame + empty state
- **What:** `chat-shell.tsx` (client: `useFragment` → 3-column grid, conditional history drawer),
  `nav-sidebar.tsx` (brand/logo header, sectioned layout with a "WORKSPACES" section slot, user
  footer with email + `LogoutButton`), `empty-state.tsx` (welcome + "pick a workspace" prompt).
  Wire `page.tsx` to `getSession()` → `<ChatShell email>`. Rewrite `logout-button.tsx` (no MUI).
  Section structure must make adding future sections trivial (SHELL-6).
- **Where:** `app/chat/chat-shell.tsx`, `nav-sidebar.tsx`, `empty-state.tsx` (new); `app/chat/page.tsx`,
  `app/chat/logout-button.tsx` (rewritten).
- **Depends on:** T02, T03
- **Reuses:** `getSession`, `useFragment`/`toWorkspace`, `Logo` (rewritten in T10 — stub/import ok),
  primitives.
- **Done when:** `/chat` with no fragment shows nav sidebar + empty state, no history drawer, no
  MUI; logout works.
- **Gate:** `yarn build` passes.

### T06 — Workspace navigator (grouped, deduped, selectable)
- **What:** `workspace-nav.tsx`: fetch `/api/subscriptions` (same call the picker used), map via
  `groupWorkspaces`, render collapsible tenant → account headers with agent leaves + access badge;
  active-leaf marker; loading/empty/error states (WS-5). On leaf click: build `{t,s,r}`,
  `createConversation`, write full fragment (add `setWorkspace(workspace, sid)` to `fragment.ts`).
  Mount inside the nav sidebar's Workspaces section.
- **Where:** `app/chat/workspace-nav.tsx` (new); `app/chat/fragment.ts` (add setter);
  `nav-sidebar.tsx` (mount).
- **Depends on:** T04, T05
- **Reuses:** `createConversation`, `fragment.ts`, `badge`/`surface`/`spinner`/`alert` primitives.
- **Done when:** a read+write-duplicated workspace shows once with `read·write`; clicking a leaf
  opens the history drawer + chat view; 401 routes to `/signin`; empty/error states render.
- **Gate:** `yarn build` passes.

### T07 — History sidebar (port)
- **What:** `history-sidebar.tsx`: port `sidebar.tsx`'s conversation logic **behavior-identically**
  (list effect, `onConversationsUpdated`, debounced full-content search via `historyQuery` +
  `/api/chat/[role]/history`, loading affordance, active marker, New chat → `createConversation` →
  `setFragmentSid`), minus the brand/switch/workspace-chip (now in nav sidebar). Restyle with
  primitives. Receives `workspace` prop from `ChatShell`.
- **Where:** `app/chat/history-sidebar.tsx` (from `sidebar.tsx`).
- **Depends on:** T02, T03
- **Reuses:** `lib/chatSession.ts` (unchanged), `fragment.ts`, primitives, lucide icons.
- **Done when:** list, search, new chat, active marker all work as before, no MUI.
- **Gate:** `yarn build` passes.

### T08 — Chat view + composer
- **What:** `chat-view.tsx`: port `session/page.tsx`'s streaming/scroll/history/error logic
  **behavior-identically**, MUI stripped, centered `max-w-[720px]` column, bubbles in new tokens.
  Extract `composer.tsx` (signature): auto-grow textarea, integrated circular accent send button,
  Enter=send/Shift+Enter=newline, disabled/sending states, blinking-cursor affordance, and
  **autofocus (CHAT-3):** the textarea is NOT disabled during `loadingHistory` (only the send
  control is gated); the focus effect fires on `sessionId` change AND the `loadingHistory`→false
  transition, guarded against mid-stream focus-steal. This is a conscious deviation from "port
  identically" — see design §7. Rewrite
  `message-content.tsx` (react-markdown map, no MUI, `font-mono` code, `--surface-2` blocks).
- **Where:** `app/chat/chat-view.tsx` (from `session/page.tsx`), `app/chat/composer.tsx` (new),
  `app/chat/message-content.tsx` (rewritten).
- **Depends on:** T02, T03
- **Reuses:** `createConversation`/`touchConversation`, `fragment.ts`, `consumeStream` logic, primitives.
- **Done when:** opening a session focuses the composer; sending streams a reply; markdown renders;
  error keeps partial content; composer reads as a large integrated chat box.
- **Gate:** `yarn build` passes.

### T09 — Assemble shell + delete dead code
- **What:** In `chat-shell.tsx` mount `<HistorySidebar>` + `<ChatView>` when a workspace is
  selected, `<EmptyState>` otherwise. **Delete** `app/chat/workspace-picker.tsx`,
  `app/chat/session/page.tsx`, `app/chat/session/layout.tsx`, and the old `app/chat/sidebar.tsx`.
  Remove any `/chat/session` links. Verify fragment selection → drawer open → chat active end to
  end. (`middleware.ts` matcher is `/chat/:path*` — deleting `/chat/session` needs no middleware
  change, verified.)
- **Where:** `app/chat/chat-shell.tsx`; delete listed files.
- **Depends on:** T05, T06, T07, T08
- **Reuses:** all shell components.
- **Done when:** full flow works from a single `/chat` route; deleted files gone; no dangling imports.
- **Gate:** `yarn build` passes.

---

## Phase 4 — Peripherals

### T10 — Signin, logo, message-content on the new system  [P with T06–T08]
- **What:** Rewrite `signin/page.tsx` (surface w/ signatureShadow, input, button, alert; two-step
  flow, autofocus, error copy preserved), `logo.tsx` (two `next/image`s, `prefers-color-scheme`
  swap, no MUI). (`message-content.tsx` handled in T08; `logout-button.tsx` in T05 — listed here for
  completeness of the MUI sweep.)
- **Where:** `app/signin/page.tsx`, `app/logo.tsx` (rewritten).
- **Depends on:** T03
- **Reuses:** primitives, existing `/api/auth/*` calls (unchanged).
- **Done when:** signin flow works end to end; logo swaps with OS theme; no MUI.
- **Gate:** `yarn build` passes.

---

## Phase 5 — Verify

### T11 — Gates + runtime drive
- **What:** Run the DS-1 grep gate, the build gate, and a runtime drive (verify/run skill): signin →
  shell → pick a read+write-duplicated workspace (appears once, `read·write` badge) → history
  drawer opens → click a session → composer auto-focused → send → reply streams → search → OS dark
  mode toggle. Fix any regression found.
- **Where:** whole app.
- **Depends on:** T09, T10
- **Done when:** every `spec.md` Success Criterion checkbox passes.
- **Gate:** `grep -rn "@mui\|@emotion" webapp/app webapp/lib webapp/components` empty; `yarn build`
  passes; runtime drive clean.
