import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { touchConversationRow } from "@/lib/db";

// Called right after a message is sent -- bumps recency ordering and, the
// first time, derives the conversation's title from that message.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "session_expired" }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const firstUserMessageIfNew = typeof body?.message === "string" ? body.message : "";

  await touchConversationRow(id, session.email, firstUserMessageIfNew);
  return NextResponse.json({ ok: true });
}
