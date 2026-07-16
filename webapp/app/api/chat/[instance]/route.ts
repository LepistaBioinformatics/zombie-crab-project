import { NextRequest, NextResponse } from "next/server";
import { fetchMycelium, isInstance, MyceliumConnectivityError, upstreamError } from "@/lib/mycelium";
import { clearSession, getSession } from "@/lib/session";

export async function POST(
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

  const body = await req.json().catch(() => null);
  const message = typeof body?.message === "string" ? body.message : null;
  const sessionId = typeof body?.session_id === "string" ? body.session_id : null;
  const tenantId = typeof body?.tenant_id === "string" ? body.tenant_id : null;
  const subsAccId = typeof body?.subs_acc_id === "string" ? body.subs_acc_id : null;
  if (!message || !sessionId || !tenantId || !subsAccId) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  let res: Response;
  try {
    res = await fetchMycelium(`/picoclaw-${instance}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify({
        model: "picoclaw",
        session_id: sessionId,
        tenant_id: tenantId,
        subs_acc_id: subsAccId,
        stream: true,
        messages: [{ role: "user", content: message }],
      }),
    });
  } catch (err) {
    if (err instanceof MyceliumConnectivityError) {
      return NextResponse.json({ error: "connectivity" }, { status: 502 });
    }
    throw err;
  }

  // Auth errors are still checked on the initial response, before any
  // streaming starts -- the proxy sends these as a plain (non-SSE) JSON body
  // even for a stream:true request, since it never gets past the auth check
  // to open the event stream. A 401 clears the session (re-signin); every
  // other non-2xx surfaces the proxy's real status + message (WS-07), never
  // the connectivity mask.
  if (res.status === 401) {
    await clearSession();
    return NextResponse.json({ error: "session_expired" }, { status: 401 });
  }
  if (!res.ok) {
    const { error, status } = await upstreamError(res);
    return NextResponse.json({ error, status }, { status });
  }
  if (!res.body) {
    return NextResponse.json({ error: "connectivity" }, { status: 502 });
  }

  // From here on, pipe the proxy's own SSE bytes straight through -- the
  // client parses `data: {...}` frames itself, same OpenAI chat-completion-
  // chunk shape the proxy already emits (see server.js's `stream` branch).
  return new Response(res.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
