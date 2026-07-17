import { NextResponse } from "next/server";
import { proxyAdminJson, requireSession } from "@/lib/adminProxy";

// The scopes the caller may administer (FR-8): tenants where the caller is
// Tenant/Instance tier, subscriptions where the caller is Subscription tier or
// above. The proxy resolves this from the injected profile -- no params. Used
// by the admin screen for visibility and to populate the scope pickers.
export async function GET() {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  return proxyAdminJson(session, "/scopes", { method: "GET" });
}
