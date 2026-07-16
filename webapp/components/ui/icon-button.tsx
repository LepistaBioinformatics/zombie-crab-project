import { forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const iconButton = cva(
  [
    "relative isolate inline-flex items-center justify-center rounded-full",
    "transition-[transform,box-shadow,opacity]",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
    "disabled:opacity-40 disabled:pointer-events-none",
    "after:pointer-events-none after:absolute after:inset-0 after:rounded-full after:bg-current after:opacity-0 after:transition-opacity hover:after:opacity-10 active:after:opacity-20",
  ],
  {
    variants: {
      variant: {
        filled: "bg-accent text-accent-fg",
        ghost: "bg-transparent text-fg",
        outlined: "border border-brand bg-transparent text-fg",
      },
      size: {
        sm: "h-8 w-8",
        md: "h-10 w-10",
        lg: "h-12 w-12",
      },
    },
    defaultVariants: { variant: "ghost", size: "md" },
  },
);

export interface IconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof iconButton> {}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, variant, size, type = "button", ...props }, ref) => (
    <button ref={ref} type={type} className={cn(iconButton({ variant, size }), className)} {...props} />
  ),
);
IconButton.displayName = "IconButton";
