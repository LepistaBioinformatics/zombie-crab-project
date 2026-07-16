import { NextRequest, NextResponse } from "next/server";
import { fetchMycelium, isInstance, MyceliumConnectivityError, upstreamError } from "@/lib/mycelium";
import { clearSession, getSession } from "@/lib/session";
import type { SessionCookie } from "@/lib/session";

// BFF for the proxy's per-(user, agent) secret store (agent-customization).
// The selected workspace lives in the URL fragment (never sent to the server),
// so the client passes tenant_id/subs_acc_id explicitly; `role` picks the
// gateway service path (`/picoclaw-<role>/v1/secrets`). The session JWT is
// attached here. The secret `value` only ever travels in the POST body -- it is
// never logged, echoed, or placed in a URL. Real 4xx reasons are surfaced via
// upstreamError (never masked as "connectivity").
async function callSecrets(
  session: SessionCookie,
  role: string,
  suffix: string,
  init: RequestInit,
): Promise<NextResponse> {
  let res: Response;
  try {
    res = await fetchMycelium(`/picoclaw-${role}/v1/secrets${suffix}`, {
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
  if (!res.ok) {
    const { error, status } = await upstreamError(res);
    return NextResponse.json({ error, status }, { status });
  }
  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data);
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "session_expired" }, { status: 401 });
  }

  const tenantId = req.nextUrl.searchParams.get("tenant_id");
  const subsAccId = req.nextUrl.searchParams.get("subs_acc_id");
  const role = req.nextUrl.searchParams.get("role");
  if (!tenantId || !subsAccId || !role || !isInstance(role)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const query = new URLSearchParams({ tenant_id: tenantId, subs_acc_id: subsAccId });
  return callSecrets(session, role, `?${query.toString()}`, { method: "GET" });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "session_expired" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const tenantId = typeof body?.tenant_id === "string" ? body.tenant_id : null;
  const subsAccId = typeof body?.subs_acc_id === "string" ? body.subs_acc_id : null;
  const role = typeof body?.role === "string" ? body.role : null;
  const format = typeof body?.format === "string" ? body.format : null;
  const name = typeof body?.name === "string" ? body.name : null;
  const value = typeof body?.value === "string" ? body.value : null;
  if (!tenantId || !subsAccId || !role || !isInstance(role) || !format || !name || value === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  return callSecrets(session, role, "", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // role is a routing detail (the path); the proxy body omits it.
    body: JSON.stringify({ tenant_id: tenantId, subs_acc_id: subsAccId, format, name, value }),
  });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "session_expired" }, { status: 401 });
  }

  const p = req.nextUrl.searchParams;
  const tenantId = p.get("tenant_id");
  const subsAccId = p.get("subs_acc_id");
  const role = p.get("role");
  const format = p.get("format");
  const name = p.get("name");
  if (!tenantId || !subsAccId || !role || !isInstance(role) || !format || !name) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const query = new URLSearchParams({
    tenant_id: tenantId,
    subs_acc_id: subsAccId,
    format,
    name,
  });
  return callSecrets(session, role, `?${query.toString()}`, { method: "DELETE" });
}
