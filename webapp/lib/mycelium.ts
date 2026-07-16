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

// The proxy answered but not with 2xx (e.g. 400 bad request, 403 not
// licensed, 409 not scaffolded). Surface its real status + message so the UI
// can show why -- distinct from `connectivity`, which is reserved strictly
// for a caught MyceliumConnectivityError (workspace-selection WS-07). The
// proxy's error body shape isn't fixed, so we probe the common fields and
// fall back to the raw text / status text.
export async function upstreamError(res: Response): Promise<{ error: string; status: number }> {
  const raw = await res.text();
  let message = raw.trim();
  try {
    const parsed = JSON.parse(raw);
    // crab-shell-proxy nests the reason as { error: { message } }; the gateway's
    // own errors use a bare string { error }. Handle both.
    const e = parsed?.error;
    message =
      (typeof e === "string" ? e : e?.message) ??
      parsed?.message ??
      parsed?.detail ??
      message;
  } catch {
    // not JSON -- keep the raw text
  }
  return { error: message || res.statusText || "request failed", status: res.status };
}

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
