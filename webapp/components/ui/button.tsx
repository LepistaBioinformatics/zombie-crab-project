import { forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

// M3-structured button: an `::after` overlay is the Material state layer
// (accent/current tint on hover/press) replacing MUI's ripple; the focus ring
// is the accessibility floor. `shadow: signature` opts into the Lepista
// hard-offset shadow + lift, reserved for /signin.
const button = cva(
  [
    "relative isolate inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-sans font-semibold",
    "transition-[transform,box-shadow,opacity] select-none",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
    "disabled:opacity-50 disabled:pointer-events-none",
    "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:bg-current after:opacity-0 after:transition-opacity hover:after:opacity-10 active:after:opacity-20",
  ],
  {
    variants: {
      variant: {
        filled: "border border-brand bg-accent text-accent-fg",
        outlined: "border border-brand bg-transparent text-fg",
        text: "bg-transparent text-fg",
        tonal: "border border-brand/40 bg-elevated text-fg",
      },
      size: {
        sm: "h-8 px-3 text-sm",
        md: "h-10 px-4 text-sm",
      },
      shadow: {
        none: "",
        signature:
          "shadow-[4px_4px_0_0_var(--accent-soft)] hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-[6px_6px_0_0_var(--accent-soft)] active:translate-x-0 active:translate-y-0 active:shadow-[2px_2px_0_0_var(--accent-soft)]",
      },
    },
    defaultVariants: { variant: "filled", size: "md", shadow: "none" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, shadow, type = "button", ...props }, ref) => (
    <button ref={ref} type={type} className={cn(button({ variant, size, shadow }), className)} {...props} />
  ),
);
Button.displayName = "Button";
