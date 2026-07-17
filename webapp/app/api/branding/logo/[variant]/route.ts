import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { isInstanceAdmin } from "@/lib/instanceAdmin";
import { getLogo, setLogo, clearLogo } from "@/lib/db";

// Uploaded logos are served as-is (no image processing), so only these
// browser-safe raster/vector image types are accepted; anything else is 400.
const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
]);
const MAX_BYTES = 1024 * 1024; // ~1MB cap; large uploads are rejected 400.

function parseVariant(raw: string): "light" | "dark" | null {
  return raw === "light" || raw === "dark" ? raw : null;
}

// Public. Serves the custom logo bytes, or 302-redirects to the bundled default
// static file when unset. Cache-Control no-cache so a rebrand shows quickly.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ variant: string }> },
) {
  const variant = parseVariant((await params).variant);
  if (!variant) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const logo = await getLogo(variant);
  if (!logo) {
    return NextResponse.redirect(
      new URL(`/logo-${variant}.jpg`, _req.nextUrl.origin),
      302,
    );
  }

  return new NextResponse(new Uint8Array(logo.bytes), {
    status: 200,
    headers: {
      "content-type": logo.type,
      "cache-control": "no-cache",
    },
  });
}

// Instance-admin. Multipart field `file` (png/jpeg/webp/svg, ~1MB). Stores the
// bytes as-is. 401 no session; 403 not instance-admin; 400 bad variant/type/size.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ variant: string }> },
) {
  const variant = parseVariant((await params).variant);
  if (!variant) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "session_expired" }, { status: 401 });
  }
  if (!(await isInstanceAdmin(session.token))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json({ error: "unsupported_type" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "too_large" }, { status: 400 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  await setLogo(variant, bytes, file.type);
  return NextResponse.json({ ok: true });
}

// Instance-admin. Resets the variant to the bundled default. 401/403 as above.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ variant: string }> },
) {
  const variant = parseVariant((await params).variant);
  if (!variant) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "session_expired" }, { status: 401 });
  }
  if (!(await isInstanceAdmin(session.token))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  await clearLogo(variant);
  return NextResponse.json({ ok: true });
}
