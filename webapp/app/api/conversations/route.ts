import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { isInstance } from "@/lib/mycelium";
import { listConversationsForWorkspace } from "@/lib/db";

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

// No POST create route: conversation ids are minted client-side and the row is
// created lazily on the first sent message (PATCH /api/conversations/[id]), so
// opening a conversation never writes a ghost row.
