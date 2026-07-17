import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { isInstance } from "@/lib/mycelium";
import {
  upsertConversationRow,
  renameConversation,
  deleteConversationRow,
  TITLE_MAX_LENGTH,
} from "@/lib/db";

// Called right after a message is sent. Creates the conversation row on the
// first message (deferred creation, so opening a chat never writes a ghost) and
// bumps recency on later ones. Carries the workspace (tenant/subs/role) because
// the row may not exist yet.
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
  const message = typeof body?.message === "string" ? body.message : "";
  const tenantId = typeof body?.tenant_id === "string" ? body.tenant_id : null;
  const subsAccId = typeof body?.subs_acc_id === "string" ? body.subs_acc_id : null;
  const role = typeof body?.role === "string" ? body.role : null;
  if (!tenantId || !subsAccId || !role || !isInstance(role)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  await upsertConversationRow(id, session.email, tenantId, subsAccId, role, message);
  return NextResponse.json({ ok: true });
}

// Dedicated rename path -- a `{ title }`-only body, deliberately separate from
// the PATCH message-upsert so it can never bump recency or overwrite a title
// from a message. Owner-scoped in the db helper; a non-owner/unknown id 404s.
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "session_expired" }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const title = (typeof body?.title === "string" ? body.title : "").trim();
  if (!title || title.length > TITLE_MAX_LENGTH) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const renamed = await renameConversation(id, session.email, title);
  if (!renamed) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, title });
}

// Removes a conversation from the caller's sidebar index (owner-scoped). Only
// the postgres row is deleted -- picoclaw's transcript is untouched (no
// session-delete on the proxy).
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "session_expired" }, { status: 401 });
  }

  const { id } = await params;
  const deleted = await deleteConversationRow(id, session.email);
  if (!deleted) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
