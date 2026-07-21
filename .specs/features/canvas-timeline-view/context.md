# canvas-timeline-view — Context (user decisions)

Gray areas resolved with the user during Specify, after a **feel-first
standalone prototype** (three visual metaphors) was explored. Prototype:
`canvas-mode.html` (Artifact) — Deck / Tree(by-metric) / Timeline, pixel-art
grid background, golden-angle dots reused from the tree.

## Decisions

- **DEC-CANV-01 — Metaphor: Timeline.** Of the three explored (Deck of newest-left
  columns, Tree branching by metric, left→right Timeline), the user picked the
  **Timeline** as "o mais amigável". Deck and Tree are *not* built; the Timeline
  is the sole Canvas view. Time flows left→right (oldest left, newest right).

- **DEC-CANV-02 — Activation: workspace-level toggle.** A `Traditional | Canvas`
  control at the workspace level (not a third value of the in-sidebar
  `List | Tree` toggle). Choosing Canvas **replaces both the history sidebar and
  the chat view** with a full-width canvas. Persisted in the URL fragment as
  `view=canvas` so a reload / shared link keeps it. The user can return to the
  traditional chat at any time.

- **DEC-CANV-03 — Data: message `created_at`, capped by time window.** The
  timeline axis is driven by per-message `created_at` (same source the tree
  uses), fetched via the existing `getHistory` and collapsed into visits/bursts.
  Rendering is bounded by a visible **time window** with right-pagination, so a
  workspace with many conversations/messages stays light.

- **DEC-CANV-04 — Content: preview (last N), transcript on demand.** Each lane
  shows a light preview (title + last user/agent exchange) on select; the full
  transcript is not rendered inline. "Full transcript" hands off to the
  traditional chat opened at that conversation (`setFragmentSid`), and "Solo"
  isolates a single lane within the timeline.

- **DEC-CANV-05 — Reuse the tree's model + colors.** Burst aggregation and
  `laneColorFor` (tag color when set, else golden-angle hash) come from
  `conversation-tree.tsx`; the shared logic is extracted so the timeline and the
  tree stay identical in "pontinhos" and identity color. The layout is
  re-derived at 90° (horizontal), not shared.

- **DEC-CANV-06 — "Evolution" affordance: Agent pulse.** An aggregate
  message-volume-over-time strip sits above the lanes (the "faixa/tree acima"
  from the brief), conveying the agent getting busier over time — the
  "inteligência evoluindo" north star. Lane lifespan lines animate drawing
  left→right on load (reduced-motion aware).

- **DEC-CANV-07 — Background: pixel-art quadriculado.** A fine graph-paper grid
  (fine cell + stronger every-Nth) via CSS, theme-aware, behind the canvas.

## Pipeline depth

Large — `spec.md` (traceable IDs) → `design.md` → `tasks.md` → execute. Chosen
by the user; multi-component (new view, fragment key, perf/pagination, toggle).
Webapp-only: `created_at` is already surfaced end-to-end by
[[conversation-tree-view]], so **no proxy/Go change is required**.
