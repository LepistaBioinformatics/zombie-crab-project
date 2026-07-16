# workspace-filter Specification

**Scope: Medium** (chat-webapp only, client-side). Brief spec — design/tasks
implicit in Execute.

## Problem Statement

The first (leftmost) sidebar (`app/chat/nav-sidebar.tsx`) lists the workspaces
the user is licensed for (from the `GET /api/subscriptions` discovery — the
`workspace-selection` feature). As a user accumulates workspaces the flat list is
hard to scan; there is no way to narrow it.

## Goal

- [ ] A filter/search control in the first sidebar that narrows the shown
      workspaces as the user types, over the already-loaded discovery list —
      purely client-side, no new request.

## Out of Scope
| Item | Reason |
| --- | --- |
| Server-side / proxy filtering | The discovery list is small + already client-held |
| Changing discovery (`/v1/subscriptions`) | Consumed as-is |
| Filtering conversations (the other sidebar) | Different list; not requested |

---

## Requirements (traceable)

| ID | Requirement |
| --- | --- |
| WF-01 | A text filter input in `nav-sidebar.tsx`, above the workspace list. |
| WF-02 | Typing filters the list case-insensitively by the fields the card shows — account name (`accName`), agent/role, and (if shown) tenant. Substring match. |
| WF-03 | An empty filter shows the full list; a filter matching nothing shows a "no matches" empty state (distinct from the "no workspaces" empty state). |
| WF-04 | Filtering is client-side over the already-fetched discovery result — no extra `/api/subscriptions` call per keystroke. |
| WF-05 | The currently-selected workspace (from the fragment) stays visually indicated even while filtering; selecting a filtered result works as before. |
| WF-06 | `className` via class-variance-authority variants (project convention). |

## Acceptance / Success Criteria
- [ ] Typing in the filter narrows the workspace list live; clearing restores it.
- [ ] A no-match filter shows a distinct empty state; the real empty (no
      licensed workspaces) is unchanged.
- [ ] No network request fires on keystroke.
- [ ] `next build` green.

## Notes
- `nav-sidebar.tsx` is recent front work (another agent). Coordinate on
  implementation; the filter is additive (an input + a filtered render).
