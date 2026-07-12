import { NextRequest, NextResponse } from "next/server";
import { fetchMycelium, isInstance, MyceliumConnectivityError } from "@/lib/mycelium";
import { clearSession, getSession } from "@/lib/session";

interface ChatCompletionResponse {
  choices: { message: { role: string; content: string } }[];
}

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
  if (!message || !sessionId) {
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
        messages: [{ role: "user", content: message }],
      }),
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
  if (res.status === 403) {
    return NextResponse.json({ error: "role_required" }, { status: 403 });
  }
  if (!res.ok) {
    return NextResponse.json({ error: "connectivity" }, { status: 502 });
  }

  const data = (await res.json()) as ChatCompletionResponse;
  const content = data.choices?.[0]?.message?.content ?? "";

  return NextResponse.json({ content });
}
