import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";

// Presence check only -- real validation happens per-request in the route
// handlers (the cookie could hold a token Mycelium has since expired; that's
// caught on the first /api/chat/* call, not here, see design.md's Error
// Handling Strategy).
export function middleware(req: NextRequest) {
  const hasSession = req.cookies.has(SESSION_COOKIE);

  if (!hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = "/signin";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/chat/:path*"],
};
