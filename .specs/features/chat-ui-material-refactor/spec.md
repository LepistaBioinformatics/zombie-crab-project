# Chat UI — Material 3 Refactor + Workspace Shell

**Scope:** Large — full styling migration (MUI+Emotion → Tailwind + class-variance-authority),
a routing/layout restructure (kill the workspace-picker page, fold it into a two-rail sidebar
shell), a client-side workspace data-model change (dedup by identity, group by tenant/account/
agent), and a reworked chat composer. Full spec + design + task breakdown.

**Supersedes the styling and shell decisions of** `.specs/features/chat-ui-redesign/` — the
conversation-index, search, streaming, and "agents not instances" behaviors from that feature are
**kept as-is**; this feature only changes the *look* (design system) and the *shell* (how you get
to a conversation). No backend/BFF contract changes.

## User Decisions (from /tlc-spec-driven discuss)

- **Design system — Material 3 structure + Lepista skin (DEC-1).** Adopt Material Design 3
  *anatomy* (navigation rail + drawer patterns, state-layer hover/focus/press, tonal surface
  hierarchy, M3 component structure) implemented in Tailwind + cva. Keep the **Lepista brand
  tokens**: cyan accent `#64C5EB`, violet border `#663a88`, Bricolage Grotesque (display) /
  Hanken Grotesk (body) / Space Mono (mono), ~8px radius. Not stock Google purple/Roboto.
- **Full MUI rip-out (DEC-2).** Remove `@mui/material`, `@mui/icons-material`,
  `@mui/material-nextjs`, `@emotion/react`, `@emotion/styled`, and `lib/theme.ts` in this pass.
  Every screen (chat, signin, providers, logo) ends on Tailwind + cva. No hybrid.
- **Merge permissions, show a badge (DEC-3).** The subscriptions feed returns one row per
  permission (a workspace with read + write shows as two/three entries today). Collapse to one
  workspace per `tenant + account + agent`; display a small access badge (`read` / `write` /
  `read·write`) on the entry. Permission is not a workspace-identity axis.
- **Fragment state stays (DEC-4).** The selected workspace + session continue to live only in the
  URL fragment (`#t=..&s=..&r=..&sid=..`), never sent to the server — this is a deliberate privacy
  property (workspace ids never appear in request logs). The shell stays a single `/chat` route;
  no new path segments.

## Problem Statement

Today the app is two screens: a full-page **workspace picker** (`/chat`) and a **chat view**
(`/chat/session`) with a single history sidebar. Three problems:

1. The picker is a dead-end page — you pick, you leave it, you can't switch without a round-trip
   back to it (`SwapHoriz` button → `/chat`).
2. The picker lists **raw subscription rows**, so one real workspace appears multiple times (once
   per permission), and there's no grouping — a flat list of cards with no tenant/account
   structure.
3. The visual layer is MUI's Material defaults fought back down to a bespoke Lepista look through
   heavy `sx`/theme overrides — the user wants a clean Material 3 structure expressed directly in
   Tailwind + cva, and a chat composer that reads as a real, inviting chat box rather than a
   text field with a Send button.

## User Stories

### DS — Design system: Material 3 structure, Lepista skin

**Acceptance Criteria:**
1. WHEN any page renders THEN it SHALL be styled with Tailwind utility classes and cva component
   variants — no `@mui/*` or `@emotion/*` import remains anywhere in `webapp/` (DEC-2).
2. THE Tailwind theme SHALL expose the Lepista tokens as the source of truth: `accent` (`#64C5EB`),
   `accent-soft` (`#9AD9F0`), `border-brand` (`#663a88`), radius `8px`, and font families wired to
   the existing `--font-display` / `--font-sans` / `--font-mono` CSS variables (DEC-1).
3. Interactive surfaces SHALL use an M3-style **state layer** (a low-opacity accent overlay on
   hover/focus/press) rather than MUI ripples, and SHALL show a visible keyboard-focus ring.
4. Light and dark schemes SHALL both be supported, driven by `prefers-color-scheme` (matching the
   current `media`-based behavior — no JS theme toggle), with no flash of the wrong scheme.
5. `lib/theme.ts` SHALL be deleted; `app/providers.tsx` SHALL no longer wrap the tree in MUI
   providers (only whatever Tailwind/font wiring remains, if any).

### SHELL — Two-rail sidebar shell

**Acceptance Criteria:**
1. WHEN the user is anywhere under `/chat` THEN a **first sidebar** (navigation) SHALL always be
   visible, containing everything that is *not* a chat session: branding, the workspace navigator,
   and the user/account controls (email + logout). Room is reserved for future sections (SHELL-6).
2. WHEN no workspace is selected THEN only the first sidebar SHALL be visible and the main area
   SHALL show an empty/welcome state prompting the user to pick a workspace.
3. WHEN a workspace is selected THEN a **second sidebar** (conversation history for that workspace)
   SHALL open between the first sidebar and the chat view, and the chat view SHALL become active.
4. WHEN no workspace is selected THEN the second sidebar SHALL NOT be rendered (it only exists for
   a selected workspace) (DEC-4 + user requirement).
5. The old full-page picker route behavior SHALL be gone: `/chat` renders the shell (with empty
   state), not a standalone card grid, and there SHALL be no "switch workspace → go to /chat"
   round-trip — switching happens in the first sidebar in place.
6. THE first sidebar SHALL be organized into labeled **sections**; the first section is
   "Workspaces" (WS). The section structure SHALL make adding later sections (e.g. Settings)
   a matter of adding a section, not restructuring the sidebar.

### WS — Workspace navigator (grouped, deduped)

**Acceptance Criteria:**
1. THE "Workspaces" section SHALL group the caller's workspaces hierarchically by **tenant →
   account → agent**, where the **agent** is the selectable leaf (the thing that maps to a
   chattable `{t, s, r}` workspace) (DEC-3).
2. Subscription rows that differ only in permission SHALL be collapsed into a single agent leaf
   keyed by `tenantId + subsAccId + role`; the leaf SHALL show an access badge summarizing the
   union of permissions (`read`, `write`, or `read·write`) (DEC-3).
3. WHEN the user clicks an agent leaf THEN it SHALL become the selected workspace: the fragment's
   `t/s/r` update, the second sidebar opens for it, and (as today) a conversation is
   opened/created so the chat view is immediately usable (SHELL-3, CHAT-3).
4. THE currently selected agent leaf SHALL be visually marked as active (M3 selected state).
5. WHEN the subscriptions feed is loading, empty, or errors THEN the section SHALL show the
   corresponding state (spinner / "no workspaces yet, ask an operator" / a readable error) — same
   states the old picker covered (workspace-selection WS-07), now inline in the sidebar.
6. Tenant and account group headers SHALL be collapsible; a group with a single child MAY render
   expanded by default. (Grouping labels use `accName` for account; tenant/agent use their ids/
   role names as today — no new backend field is required.)

### HIST — Conversation history (second sidebar)

**Acceptance Criteria:**
1. THE second sidebar SHALL show, for the selected workspace only, the same conversation list the
   current sidebar shows: New chat action, full-content search box, the recency-ordered list, and
   per-item agent tag — all behaviors from `chat-ui-redesign` are preserved (list, search debounce,
   loading affordance, active-item marker, most-recent-first).
2. WHEN the user clicks a conversation THEN it SHALL open in the chat view (existing
   `setFragmentSid` behavior) AND the composer SHALL become active/focused (CHAT-3).
3. THE search/list logic SHALL be scoped to the selected workspace exactly as today
   (`listConversations(workspace)`), not across workspaces.

### CHAT — Chat composer & conversation view

**Acceptance Criteria:**
1. THE composer SHALL read as a real chat box: a large, prominent, rounded input surface with the
   send affordance integrated into it (not a separate detached button), an auto-growing multiline
   field (Enter = send, Shift+Enter = newline, preserved), and a placeholder in the interface's
   voice.
2. THE composer SHALL be wider and more present than today's `maxWidth="sm"` field — a centered
   conversation column with a comfortable reading measure, and a composer that anchors the bottom
   of the chat view.
3. WHEN a conversation is opened (a session is clicked, or a new chat is created) THEN the composer
   SHALL auto-focus so the user can type immediately without a click (user requirement: "a caixa
   fica ativa e o usuário só precisa digitar").
4. THE composer SHALL show its disabled/sending state clearly (e.g. the send control disabled while
   a reply streams) and SHALL keep the streaming reply's blinking-cursor affordance.
5. Message bubbles SHALL keep the existing distinction (user vs assistant alignment + surface tint)
   re-expressed in the new token system, and markdown rendering (`MessageContent`) SHALL be
   preserved with the same element coverage (headings, lists, links, inline/block code).
6. WHEN a stream errors mid-flight THEN partial content SHALL be kept and a readable error shown
   (unchanged from `chat-ui-redesign` CHAT streaming AC).

### MISC — Peripheral screens on the new system

**Acceptance Criteria:**
1. `/signin` SHALL be rebuilt in Tailwind + cva, preserving its two-step (email → 6-digit code)
   flow, autofocus, error states, and the Lepista signature hard-offset shadow treatment (the one
   screen where that motion/depth is intentional).
2. THE `Logo` and `LogoutButton` components SHALL be reimplemented without MUI, preserving the
   dark/light logo swap (`prefers-color-scheme`, no JS/flash) and logout behavior.
3. `MessageContent` SHALL render the same markdown element set without `@mui/material`.

## Out of Scope

| Item | Reason |
|---|---|
| Backend/BFF/proxy contract changes | Pure frontend refactor; all `/api/*` routes and their shapes are unchanged. |
| Renaming/deleting conversations | Not asked; list stays read/append-only (carried from chat-ui-redesign). |
| Cross-device conversation sync | Server-scoped index already exists; unchanged. |
| Role-based filtering of which agents are chatable | Deferred in ROADMAP M3; unrelated. |
| A JS light/dark toggle | Keep `prefers-color-scheme` only, matching current behavior (DEC-1). |
| New workspace sections beyond "Workspaces" | Only the Workspaces section ships now; the shell just leaves room for later ones (SHELL-6). |
| Search relevance ranking / match highlighting | Substring filter is enough (carried from chat-ui-redesign). |

## Success Criteria

- [ ] `grep -r "@mui\|@emotion" webapp/app webapp/lib` returns nothing; `lib/theme.ts` is gone.
- [ ] Tailwind builds; `yarn build` (or `next build`) succeeds with no type errors.
- [ ] The workspace-picker page is gone; `/chat` shows the shell with an empty state.
- [ ] One workspace that has separate read + write subscription rows appears **once**, with a
      `read·write` badge — not twice.
- [ ] Workspaces are grouped under tenant → account headers, agent as the clickable leaf.
- [ ] Selecting a workspace opens the second sidebar; deselecting/empty hides it.
- [ ] Clicking a conversation focuses the composer with no extra click.
- [ ] The composer visibly reads as a large, integrated chat box, not a small field + Send button.
- [ ] Streaming, search, recency ordering, and dark/light all still work.
- [ ] Keyboard focus is visible on every interactive element; reduced-motion is respected.
