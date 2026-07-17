import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { isInstanceAdmin } from "@/lib/instanceAdmin";

// Session-gated instance-admin probe for UI gating (the branding writes are
// server-side gated regardless). 401 no session; otherwise { canEdit }.
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "session_expired" }, { status: 401 });
  }
  const canEdit = await isInstanceAdmin(session.token);
  return NextResponse.json({ canEdit });
}
