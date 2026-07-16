import { NextRequest, NextResponse } from "next/server";
import { fetchMycelium, MyceliumConnectivityError, upstreamError } from "@/lib/mycelium";
import { clearSession, getSession } from "@/lib/session";

// Public tenant metadata lookup. Mycelium exposes this as a gateway-native
// route (`GET /_adm/beginners/tenants/{id}`) that requires a Bearer token --
// so it goes through the BFF with the session's JWT, same pattern as
// /api/subscriptions. Used to resolve a tenant's display name from its uuid,
// fetched lazily per tenant so the sidebar never blocks on it.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "session_expired" }, { status: 401 });
  }

  const { id } = await params;

  let res: Response;
  try {
    res = await fetchMycelium(`/_adm/beginners/tenants/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${session.token}` },
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

  const tenant = await res.json();
  return NextResponse.json({ tenant });
}
