import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { isInstance } from "@/lib/mycelium";
import { createConversationRow, listConversationsForWorkspace } from "@/lib/db";

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

  const conversations = await listConversationsForWorkspace(session.email, tenantId, subsAccId, role);
  return NextResponse.json({ conversations });
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
  if (!tenantId || !subsAccId || !role || !isInstance(role)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const conversation = await createConversationRow(
    crypto.randomUUID(),
    session.email,
    tenantId,
    subsAccId,
    role,
    "New chat",
  );
  return NextResponse.json({ conversation }, { status: 201 });
}
