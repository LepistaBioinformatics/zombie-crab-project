import { NextRequest, NextResponse } from "next/server";
import { fetchMycelium, MyceliumConnectivityError } from "@/lib/mycelium";
import { setSession } from "@/lib/session";

// Mycelium's verify response returns `email` as a structured object
// ({ username, domain }), not a plain string -- verified empirically against
// the real endpoint (the reference mycelium-webapp's own TS types call it a
// string, which doesn't match what the server actually sends).
interface VerifyResponse {
  token: string;
  email: string | { username: string; domain: string };
}

function displayEmail(email: VerifyResponse["email"], fallback: string): string {
  if (typeof email === "string") return email;
  if (email && typeof email === "object") return `${email.username}@${email.domain}`;
  return fallback;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email : null;
  const code = typeof body?.code === "string" ? body.code : null;

  if (!email || !code) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  let res: Response;
  try {
    res = await fetchMycelium("/_adm/beginners/users/magic-link/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code }),
    });
  } catch (err) {
    if (err instanceof MyceliumConnectivityError) {
      return NextResponse.json({ error: "connectivity" }, { status: 502 });
    }
    throw err;
  }

  if (res.status === 401) {
    return NextResponse.json({ error: "invalid_code" }, { status: 401 });
  }
  if (!res.ok) {
    return NextResponse.json({ error: "connectivity" }, { status: 502 });
  }

  const data = (await res.json()) as VerifyResponse;
  const resolvedEmail = displayEmail(data.email, email);

  // A magic-link JWT only proves identity -- it does NOT provision an
  // account (verified empirically: a fresh verify's JWT hits chat routes
  // with "authenticated but has not an account"). CHAT-01 AC#5 requires no
  // separate signup step from the user's point of view, so this call
  // happens transparently here. Best-effort: for a returning user this
  // 201-or-conflict is not fatal to login either way, so any non-2xx is
  // swallowed rather than failing the whole signin.
  try {
    await fetchMycelium("/_adm/beginners/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${data.token}`,
      },
      body: JSON.stringify({ email }),
    });
  } catch {
    // connectivity failure here still leaves the caller signed in; the
    // account-creation gap (if any) surfaces as a clear 403 on first chat
    // attempt instead of silently failing signin.
  }

  await setSession({ token: data.token, email: resolvedEmail });

  return NextResponse.json({ authenticated: true, email: resolvedEmail });
}
