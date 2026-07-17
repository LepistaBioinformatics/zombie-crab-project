import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { isInstanceAdmin } from "@/lib/instanceAdmin";
import { getAppName, setAppName } from "@/lib/db";

// Force-dynamic: this GET takes no request arg and would otherwise be cached /
// prerendered at build (running a DB query at build time), so a rebrand would
// keep serving the build-time name. Always run per-request.
export const dynamic = "force-dynamic";

// Public read of the instance app name (custom or default). Used by the UI and
// the dynamic manifest.
export async function GET() {
  const appName = await getAppName();
  return NextResponse.json({ appName });
}

// Instance-admin write of the app name. Body `{ appName: string }`; an empty
// string resets to the default. 401 no session; 403 not instance-admin.
export async function PUT(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "session_expired" }, { status: 401 });
  }
  if (!(await isInstanceAdmin(session.token))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (typeof body?.appName !== "string") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  await setAppName(body.appName);
  return NextResponse.json({ appName: await getAppName() });
}
