import { cva, type VariantProps } from "class-variance-authority";
import { CircleAlert, Info } from "lucide-react";
import { cn } from "@/lib/cn";

const alert = cva("flex items-start gap-2 rounded-lg border px-3 py-2 text-sm", {
  variants: {
    severity: {
      error: "border-red-500/50 bg-red-500/10 text-fg",
      info: "border-brand/50 bg-accent/10 text-fg",
    },
  },
  defaultVariants: { severity: "info" },
});

export interface AlertProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof alert> {}

export function Alert({ className, severity = "info", children, ...props }: AlertProps) {
  const Icon = severity === "error" ? CircleAlert : Info;
  return (
    <div role="alert" className={cn(alert({ severity }), className)} {...props}>
      <Icon size={18} className="mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
