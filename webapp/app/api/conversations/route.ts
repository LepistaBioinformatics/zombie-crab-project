import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { isInstance } from "@/lib/mycelium";
import { createConversationRow, listConversationsForEmail } from "@/lib/db";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "session_expired" }, { status: 401 });
  }

  const conversations = await listConversationsForEmail(session.email);
  return NextResponse.json({ conversations });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "session_expired" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const instance = typeof body?.instance === "string" ? body.instance : null;
  if (!instance || !isInstance(instance)) {
    return NextResponse.json({ error: "invalid_instance" }, { status: 400 });
  }

  const conversation = await createConversationRow(
    crypto.randomUUID(),
    session.email,
    instance,
    "New chat",
  );
  return NextResponse.json({ conversation }, { status: 201 });
}
