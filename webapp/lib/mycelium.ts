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

// JSON-RPC 2.0 call to mycelium's /_adm/rpc, mirroring the reference
// mycelium-webapp `rpcCall`. The beginners account endpoints must go over RPC
// for an internal (magic-link) user: the REST create_default_account is
// external-provider-only ("Invalid provider" 400), whereas the RPC dispatcher
// resolves the internal issuer (verified empirically). Throws
// MyceliumConnectivityError on transport failure (via fetchMycelium); otherwise
// returns a discriminated result ({error} envelopes and non-2xx both -> ok:false).
export type RpcResult<R> =
  | { ok: true; result: R }
  | { ok: false; status: number; message: string };

export async function myceliumRpc<R>(
  method: string,
  params: unknown,
  token: string,
): Promise<RpcResult<R>> {
  const res = await fetchMycelium("/_adm/rpc", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  if (!res.ok) {
    const { error, status } = await upstreamError(res);
    return { ok: false, status, message: error };
  }
  const json = await res.json().catch(() => null);
  if (json?.error) {
    return { ok: false, status: 400, message: json.error.message ?? "rpc error" };
  }
  return { ok: true, result: json?.result as R };
}
