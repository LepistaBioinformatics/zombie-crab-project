import { NextResponse } from "next/server";
import { fetchMycelium, MyceliumConnectivityError, upstreamError } from "@/lib/mycelium";
import { clearSession, getSession } from "@/lib/session";
import type { SessionCookie } from "@/lib/session";

// Every /v1/admin/* endpoint is agent-agnostic: shared content is stored under
// tenant/subscription scope, not per-role. We still route through a picoclaw
// service so the proxy's resolveAgent bearer guard runs -- alpha is just the
// vehicle (same pattern as /api/subscriptions). Authorization (caller tier vs
// target scope) is enforced server-side in the proxy from the injected profile;
// this BFF only forwards the session JWT and surfaces the real status.
const ADMIN_BASE = "/picoclaw-alpha/v1/admin";

export async function requireSession(): Promise<SessionCookie | NextResponse> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "session_expired" }, { status: 401 });
  }
  return session;
}

// Forwards to an admin endpoint and returns the upstream response untouched, so
// callers can either JSON it or stream its body (the file-download route). A
// caught connectivity failure and an expired session are normalized to the
// stack-wide error shapes ({error:"connectivity"} / {error:"session_expired"}).
export async function forwardAdmin(
  session: SessionCookie,
  suffix: string,
  init: RequestInit = {},
): Promise<Response | NextResponse> {
  let res: Response;
  try {
    res = await fetchMycelium(`${ADMIN_BASE}${suffix}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${session.token}` },
    });
  } catch (err) {
    if (err instanceof MyceliumConnectivityError) {
      return NextResponse.json({ error: "connectivity" }, { status: 502 });
    }
    throw err;
  }

  if (res.status === 401) {
    await clearSession();
    return NextResponse.json({ error: "session_expired" }, { status: 401 });
  }
  return res;
}

// The common case: forward, surface upstream 4xx/5xx, echo the JSON body.
export async function proxyAdminJson(
  session: SessionCookie,
  suffix: string,
  init: RequestInit = {},
): Promise<NextResponse> {
  const out = await forwardAdmin(session, suffix, init);
  if (out instanceof NextResponse) return out;
  if (!out.ok) {
    const { error, status } = await upstreamError(out);
    return NextResponse.json({ error, status }, { status });
  }
  const data = await out.json().catch(() => ({}));
  return NextResponse.json(data);
}
