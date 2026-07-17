import { NextRequest, NextResponse } from "next/server";
import { proxyAdminJson, requireSession } from "@/lib/adminProxy";

// Shared secrets at a scope: write / list-names / delete. Like the per-user
// secret store this is WRITE-ONLY over the API -- GET returns names only, never
// a value (FR-5.1). The value travels only in the POST body, never in a URL.

const SCOPES = ["tenant", "subscription"] as const;
type ScopeKind = (typeof SCOPES)[number];

function isScope(value: unknown): value is ScopeKind {
  return typeof value === "string" && (SCOPES as readonly string[]).includes(value);
}

function scopeQuery(scope: ScopeKind, tenantId: string, subsAccId: string | null): URLSearchParams | null {
  if (scope === "subscription" && !subsAccId) return null;
  const q = new URLSearchParams({ scope, tenant_id: tenantId });
  if (scope === "subscription" && subsAccId) q.set("subs_acc_id", subsAccId);
  return q;
}

export async function GET(req: NextRequest) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;

  const p = req.nextUrl.searchParams;
  const scope = p.get("scope");
  const tenantId = p.get("tenant_id");
  const subsAccId = p.get("subs_acc_id");
  if (!isScope(scope) || !tenantId) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const query = scopeQuery(scope, tenantId, subsAccId);
  if (!query) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  return proxyAdminJson(session, `/shared-secrets?${query.toString()}`, { method: "GET" });
}

export async function POST(req: NextRequest) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;

  const body = await req.json().catch(() => null);
  const scope = body?.scope;
  const tenantId = typeof body?.tenant_id === "string" ? body.tenant_id : null;
  const subsAccId = typeof body?.subs_acc_id === "string" ? body.subs_acc_id : null;
  const format = typeof body?.format === "string" ? body.format : null;
  const name = typeof body?.name === "string" ? body.name : null;
  const value = typeof body?.value === "string" ? body.value : null;
  if (!isScope(scope) || !tenantId || !format || !name || value === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (scope === "subscription" && !subsAccId) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const payload: Record<string, string> = { scope, tenant_id: tenantId, format, name, value };
  if (scope === "subscription" && subsAccId) payload.subs_acc_id = subsAccId;

  return proxyAdminJson(session, "/shared-secrets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function DELETE(req: NextRequest) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;

  const p = req.nextUrl.searchParams;
  const scope = p.get("scope");
  const tenantId = p.get("tenant_id");
  const subsAccId = p.get("subs_acc_id");
  const format = p.get("format");
  const name = p.get("name");
  if (!isScope(scope) || !tenantId || !format || !name) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const query = scopeQuery(scope, tenantId, subsAccId);
  if (!query) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  query.set("format", format);
  query.set("name", name);

  return proxyAdminJson(session, `/shared-secrets?${query.toString()}`, { method: "DELETE" });
}
