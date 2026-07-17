import { NextRequest, NextResponse } from "next/server";
import { proxyAdminJson, requireSession } from "@/lib/adminProxy";

// A user's private files: list (METADATA ONLY -- name/size/modified, never
// bytes) and delete. There is deliberately NO content route here and NO
// write/edit route: a caller strictly above the user may list and delete but
// never read or modify the bytes of a private file (FR-7 privacy invariant),
// regardless of tier (including Instance). Do not add one.
export async function GET(req: NextRequest) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;

  const p = req.nextUrl.searchParams;
  const tenantId = p.get("tenant_id");
  const subsAccId = p.get("subs_acc_id");
  const userAccId = p.get("user_acc_id");
  if (!tenantId || !subsAccId || !userAccId) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const query = new URLSearchParams({
    tenant_id: tenantId,
    subs_acc_id: subsAccId,
    user_acc_id: userAccId,
  });
  return proxyAdminJson(session, `/users/files?${query.toString()}`, { method: "GET" });
}

export async function DELETE(req: NextRequest) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;

  const p = req.nextUrl.searchParams;
  const tenantId = p.get("tenant_id");
  const subsAccId = p.get("subs_acc_id");
  const userAccId = p.get("user_acc_id");
  const name = p.get("name");
  if (!tenantId || !subsAccId || !userAccId || !name) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const query = new URLSearchParams({
    tenant_id: tenantId,
    subs_acc_id: subsAccId,
    user_acc_id: userAccId,
    name,
  });
  return proxyAdminJson(session, `/users/files?${query.toString()}`, { method: "DELETE" });
}
