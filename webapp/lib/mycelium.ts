// Server-side only -- the browser never talks to mycelium-gateway directly
// (BFF pattern, see .specs/features/mycelium-chat-webapp/context.md AD-001).
export const MYCELIUM_INTERNAL_URL =
  process.env.MYCELIUM_INTERNAL_URL ?? "http://mycelium-gateway:8080";

export const INSTANCES = ["alpha", "beta"] as const;
export type Instance = (typeof INSTANCES)[number];

export function isInstance(value: string): value is Instance {
  return (INSTANCES as readonly string[]).includes(value);
}

export class MyceliumConnectivityError extends Error {}

// Wraps fetch() against mycelium-gateway so every route handler distinguishes
// "the gateway answered" (even with 401/403/500) from "couldn't reach it at
// all" -- the two need different error shapes downstream (design.md's Error
// Handling Strategy).
export async function fetchMycelium(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(`${MYCELIUM_INTERNAL_URL}${path}`, init);
  } catch (err) {
    throw new MyceliumConnectivityError(
      err instanceof Error ? err.message : "fetch failed",
    );
  }
}
