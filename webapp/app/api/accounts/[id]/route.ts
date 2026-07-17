import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { myceliumRpc } from "@/lib/mycelium";

// Resolve a subscription account's display name by id, backed by the mycelium
// `subscriptionsManager.accounts.get` RPC. That use case authorizes staff/manager
// OR a TenantManager/SubscriptionsManager with read access on the tenant, so a
// tenant admin can resolve the names of subscriptions under their tenant (the
// tenant_id scopes the read for non-instance callers). Used by the admin scope
// tree to show names instead of uuids.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "session_expired" }, { status: 401 });
  }

  const { id } = await params;
  const tenantId = req.nextUrl.searchParams.get("tenant_id") ?? undefined;

  const rpc = await myceliumRpc<{ name?: string } | null>(
    "subscriptionsManager.accounts.get",
    { tenantId, accountId: id },
    session.token,
  );
  if (!rpc.ok) {
    return NextResponse.json({ error: rpc.message, status: rpc.status }, { status: rpc.status });
  }
  const name = rpc.result && typeof rpc.result.name === "string" ? rpc.result.name : null;
  return NextResponse.json({ name });
}
