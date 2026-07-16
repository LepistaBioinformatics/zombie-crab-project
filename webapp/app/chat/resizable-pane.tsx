"use client";

import { MouseEvent, ReactNode } from "react";
import { cva } from "class-variance-authority";
import { ChevronRight } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";

// A sidebar column that, on DESKTOP (md+), can be resized by dragging its right
// edge (clamped between `minWidth` and a max) and collapsed to a thin rail (the
// collapse control lives in the bar's own header; this renders the rail's
// expand affordance). On MOBILE it is an off-canvas overlay drawer (unchanged)
// — collapse/resize don't apply there. Width is driven by the `--pane-w` CSS
// var so it only takes effect at md+ (mobile keeps a fixed overlay width).
const pane = cva(
  "relative z-40 border-r border-brand/30 bg-surface max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:w-[300px] max-md:shadow-xl max-md:transition-transform md:shrink-0",
  {
    variants: {
      open: { true: "max-md:translate-x-0", false: "max-md:-translate-x-full" },
      collapsed: { true: "md:w-12", false: "md:w-[var(--pane-w)]" },
    },
    defaultVariants: { open: false, collapsed: false },
  },
);

const content = cva("h-full", {
  variants: { collapsed: { true: "md:hidden", false: "" } },
  defaultVariants: { collapsed: false },
});

const rail = cva("hidden h-full items-start justify-center pt-3", {
  variants: { collapsed: { true: "md:flex", false: "md:hidden" } },
  defaultVariants: { collapsed: false },
});

const MAX_WIDTH = 480;

export default function ResizablePane({
  ariaLabel,
  open,
  collapsed,
  width,
  minWidth,
  onExpand,
  onResize,
  children,
}: {
  ariaLabel: string;
  open: boolean;
  collapsed: boolean;
  width: number;
  minWidth: number;
  onExpand: () => void;
  onResize: (width: number) => void;
  children: ReactNode;
}) {
  function startResize(e: MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;

    const onMove = (ev: globalThis.MouseEvent) => {
      const next = startWidth + (ev.clientX - startX);
      // Clamp between min and max -- at the minimum it just stops shrinking; it
      // does not collapse (collapse is an explicit header action).
      onResize(Math.max(minWidth, Math.min(next, MAX_WIDTH)));
    };
    const cleanup = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", cleanup);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", cleanup);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  return (
    <aside
      aria-label={ariaLabel}
      style={{ "--pane-w": `${width}px` } as React.CSSProperties}
      className={pane({ open, collapsed })}
    >
      <div className={content({ collapsed })}>{children}</div>

      <div className={rail({ collapsed })}>
        <IconButton variant="ghost" size="sm" aria-label={`Expand ${ariaLabel}`} onClick={onExpand}>
          <ChevronRight size={18} aria-hidden />
        </IconButton>
      </div>

      {!collapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${ariaLabel}`}
          onMouseDown={startResize}
          className="absolute inset-y-0 right-0 hidden w-1.5 cursor-col-resize hover:bg-accent/40 md:block"
        />
      )}
    </aside>
  );
}
