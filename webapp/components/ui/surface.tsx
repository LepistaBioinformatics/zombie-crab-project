import { forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

// Flat tonal surface (M3 surface-container steps) with an optional violet
// structural border. `shadow: signature` is the Lepista hard-offset cyan
// shadow, reserved for /signin.
const surface = cva("rounded-lg", {
  variants: {
    level: {
      1: "bg-surface",
      2: "bg-elevated",
    },
    bordered: {
      true: "border border-brand",
      false: "",
    },
    shadow: {
      none: "",
      signature: "shadow-[4px_4px_0_0_var(--accent-soft)]",
    },
  },
  defaultVariants: { level: 1, bordered: false, shadow: "none" },
});

export interface SurfaceProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof surface> {}

export const Surface = forwardRef<HTMLDivElement, SurfaceProps>(
  ({ className, level, bordered, shadow, ...props }, ref) => (
    <div ref={ref} className={cn(surface({ level, bordered, shadow }), className)} {...props} />
  ),
);
Surface.displayName = "Surface";
