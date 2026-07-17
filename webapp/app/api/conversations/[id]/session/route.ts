import { NextRequest, NextResponse } from "next/server";
import { fetchMycelium, isInstance, MyceliumConnectivityError, upstreamError } from "@/lib/mycelium";
import { clearSession, getSession } from "@/lib/session";
import { setSessionRefs } from "@/lib/db";

interface ResolveResponse {
  sessionKey: string;
  sessionFile: string;
}

// Resolves the proxy session identifiers behind a conversation and stores them
// on the owner's row. Body `{ tenant_id, subs_acc_id, role, session_id }`; calls
// the proxy `GET /v1/sessions/resolve` through the `picoclaw-<role>` service
// (same BFF pattern as chat/history), then persists via setSessionRefs
// (owner-scoped). sessionFile is "" until picoclaw has written the transcript.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "session_expired" }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const sessionId = typeof body?.session_id === "string" ? body.session_id : null;
  const tenantId = typeof body?.tenant_id === "string" ? body.tenant_id : null;
  const subsAccId = typeof body?.subs_acc_id === "string" ? body.subs_acc_id : null;
  const role = typeof body?.role === "string" ? body.role : null;
  if (!sessionId || !tenantId || !subsAccId || !role || !isInstance(role)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const query = new URLSearchParams({
    session_id: sessionId,
    tenant_id: tenantId,
    subs_acc_id: subsAccId,
  });

  let res: Response;
  try {
    res = await fetchMycelium(
      `/picoclaw-${role}/v1/sessions/resolve?${query.toString()}`,
      { headers: { Authorization: `Bearer ${session.token}` } },
    );
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
  if (!res.ok) {
    const { error, status } = await upstreamError(res);
    return NextResponse.json({ error, status }, { status });
  }

  const data = (await res.json()) as ResolveResponse;
  const stored = await setSessionRefs(id, session.email, data.sessionKey, data.sessionFile);
  if (!stored) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ sessionKey: data.sessionKey, sessionFile: data.sessionFile });
}
