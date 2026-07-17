import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { setAlias } from "@/lib/db";

// Owner-scoped alias set/clear. Body `{ alias: string }`; an empty string clears
// the alias. Deliberately separate from rename so it never touches the title or
// recency. A non-owner/unknown id 404s.
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
  if (typeof body?.alias !== "string") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const updated = await setAlias(id, session.email, body.alias);
  if (!updated) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
