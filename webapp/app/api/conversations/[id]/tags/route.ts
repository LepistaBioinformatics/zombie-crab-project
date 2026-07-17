import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { listTags, upsertTag, deleteTag, Tag } from "@/lib/db";

// Owner-scoped read of a conversation's tags. Returns an empty list for a
// non-owner/unknown id (a safe read; only writes 404).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "session_expired" }, { status: 401 });
  }

  const { id } = await params;
  const tags = await listTags(id, session.email);
  return NextResponse.json({ tags });
}

// Owner-scoped upsert of one tag (unique by name). Body `{ name, value?,
// metadata? }`; value defaults to null and metadata to {} so the stored Tag
// always matches the contract shape. A non-owner/unknown id 404s.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "session_expired" }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const tag: Tag = {
    name,
    value: typeof body?.value === "string" ? body.value : null,
    metadata:
      body?.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
        ? body.metadata
        : {},
  };

  const upserted = await upsertTag(id, session.email, tag);
  if (!upserted) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, tag });
}

// Owner-scoped remove of one tag by `?name=`. A non-owner/unknown id or an
// unknown tag name 404s.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "session_expired" }, { status: 401 });
  }

  const { id } = await params;
  const name = req.nextUrl.searchParams.get("name");
  if (!name) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const deleted = await deleteTag(id, session.email, name);
  if (!deleted) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
