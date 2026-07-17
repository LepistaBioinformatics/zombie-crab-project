import { NextRequest, NextResponse } from "next/server";
import { fetchMycelium, isInstance, MyceliumConnectivityError, upstreamError } from "@/lib/mycelium";
import { clearSession, getSession } from "@/lib/session";

// BFF for the proxy's media upload (media-upload). The browser posts multipart
// with `role` + `tenant_id`/`subs_acc_id` (from the fragment) + `file`; `role`
// picks the gateway service path and is NOT forwarded. The session JWT is
// attached here. Real 4xx (413 too large, 400 bad type/name, 403 unlicensed)
// are surfaced via upstreamError, never masked as connectivity.
// Lists the files currently in the caller's workspace uploads dir (names +
// sizes, never contents) for the uploads sidebar.
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "session_expired" }, { status: 401 });
  }

  const role = req.nextUrl.searchParams.get("role");
  const tenantId = req.nextUrl.searchParams.get("tenant_id");
  const subsAccId = req.nextUrl.searchParams.get("subs_acc_id");
  if (!role || !isInstance(role) || !tenantId || !subsAccId) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const query = new URLSearchParams({ tenant_id: tenantId, subs_acc_id: subsAccId });
  let res: Response;
  try {
    res = await fetchMycelium(`/picoclaw-${role}/v1/media?${query.toString()}`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
  } catch (err) {
    if (err instanceof MyceliumConnectivityError) {
      return NextResponse.json({ error: "connectivity" }, { status: 502 });
    }
    throw err;
  }

  if (res.status === 401) {
    await clearSession();
    return NextResponse.json({ error: "session_expired" }, { status: 401 });
  }
  if (!res.ok) {
    const { error, status } = await upstreamError(res);
    return NextResponse.json({ error, status }, { status });
  }
  const data = await res.json();
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "session_expired" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const role = form.get("role");
  const tenantId = form.get("tenant_id");
  const subsAccId = form.get("subs_acc_id");
  const file = form.get("file");
  if (
    typeof role !== "string" ||
    !isInstance(role) ||
    typeof tenantId !== "string" ||
    typeof subsAccId !== "string" ||
    !(file instanceof File)
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const upstream = new FormData();
  upstream.set("tenant_id", tenantId);
  upstream.set("subs_acc_id", subsAccId);
  upstream.set("file", file, file.name);

  let res: Response;
  try {
    // No explicit Content-Type: fetch sets the multipart boundary for a
    // FormData body.
    res = await fetchMycelium(`/picoclaw-${role}/v1/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.token}` },
      body: upstream,
    });
  } catch (err) {
    if (err instanceof MyceliumConnectivityError) {
      return NextResponse.json({ error: "connectivity" }, { status: 502 });
    }
    throw err;
  }

  if (res.status === 401) {
    await clearSession();
    return NextResponse.json({ error: "session_expired" }, { status: 401 });
  }
  if (!res.ok) {
    const { error, status } = await upstreamError(res);
    return NextResponse.json({ error, status }, { status });
  }
  const data = await res.json();
  return NextResponse.json(data);
}
