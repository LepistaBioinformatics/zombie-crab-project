import { NextRequest, NextResponse } from "next/server";
import { fetchMycelium, isInstance, MyceliumConnectivityError, upstreamError } from "@/lib/mycelium";
import { clearSession, getSession } from "@/lib/session";

interface HistoryResponse {
  messages: { role: string; content: string }[];
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ instance: string }> },
) {
  const { instance } = await params;
  if (!isInstance(instance)) {
    return NextResponse.json({ error: "invalid_instance" }, { status: 400 });
  }

  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "session_expired" }, { status: 401 });
  }

  const sessionId = req.nextUrl.searchParams.get("session_id");
  const tenantId = req.nextUrl.searchParams.get("tenant_id");
  const subsAccId = req.nextUrl.searchParams.get("subs_acc_id");
  if (!sessionId || !tenantId || !subsAccId) {
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
      `/picoclaw-${instance}/v1/sessions/history?${query.toString()}`,
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

  const data = (await res.json()) as HistoryResponse;
  return NextResponse.json({ messages: data.messages ?? [] });
}
