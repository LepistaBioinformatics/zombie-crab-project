import { NextRequest, NextResponse } from "next/server";
import { fetchMycelium, isInstance, MyceliumConnectivityError } from "@/lib/mycelium";
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
  if (!sessionId) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  let res: Response;
  try {
    res = await fetchMycelium(
      `/picoclaw-${instance}/v1/sessions/history?session_id=${encodeURIComponent(sessionId)}`,
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
  if (res.status === 403) {
    return NextResponse.json({ error: "role_required" }, { status: 403 });
  }
  if (!res.ok) {
    return NextResponse.json({ error: "connectivity" }, { status: 502 });
  }

  const data = (await res.json()) as HistoryResponse;
  return NextResponse.json({ messages: data.messages ?? [] });
}
