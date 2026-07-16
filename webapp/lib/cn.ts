import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// Standard cva companion: clsx resolves conditionals, tailwind-merge dedupes
// conflicting utilities (last wins) so variant + override classNames compose.
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
