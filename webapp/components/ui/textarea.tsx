import { forwardRef } from "react";
import { cn } from "@/lib/cn";

// Styled multiline field. Auto-grow (row expansion up to a cap) is owned by
// the composer, which measures scrollHeight -- this primitive is presentation
// only, with resize disabled so the composer's measured height wins.
export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "w-full resize-none bg-transparent text-sm text-fg placeholder:text-fg-muted",
        "focus:outline-none disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";
