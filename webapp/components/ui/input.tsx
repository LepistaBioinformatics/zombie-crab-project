import { forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const input = cva(
  [
    "w-full rounded-lg border border-brand bg-elevated px-3 text-sm text-fg",
    "placeholder:text-fg-muted",
    "transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft",
    "disabled:opacity-50 disabled:pointer-events-none",
  ],
  {
    variants: {
      inputSize: {
        sm: "h-9",
        md: "h-11",
      },
    },
    defaultVariants: { inputSize: "md" },
  },
);

// `size` is omitted from the native props so the cva `inputSize` variant
// doesn't collide with the numeric HTML `size` attribute.
export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size">,
    VariantProps<typeof input> {}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, inputSize, ...props }, ref) => (
    <input ref={ref} className={cn(input({ inputSize }), className)} {...props} />
  ),
);
Input.displayName = "Input";
