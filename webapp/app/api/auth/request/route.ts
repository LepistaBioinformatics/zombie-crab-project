import { NextRequest, NextResponse } from "next/server";
import { fetchMycelium, MyceliumConnectivityError } from "@/lib/mycelium";

// Simple shape check only -- Mycelium itself does the real email validation,
// and always answers 200 regardless of whether the address is registered
// (anti-enumeration, see spec.md CHAT-01 AC#1). We mirror that: this route
// never leaks which branch it took.
//
// Mycelium's own validator accepts a bare `localhost` domain (no TLD) in
// addition to normal dotted domains, specifically so a fresh local install
// without a real domain still works -- match that here or this route
// rejects addresses Mycelium itself would accept.
const EMAIL_RE = /^[^\s@]+@([^\s@]+\.[^\s@]+|localhost)$/;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email : null;

  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }

  try {
    await fetchMycelium("/_adm/beginners/users/magic-link/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
  } catch (err) {
    if (err instanceof MyceliumConnectivityError) {
      return NextResponse.json({ error: "connectivity" }, { status: 502 });
    }
    throw err;
  }

  return NextResponse.json({ sent: true });
}
