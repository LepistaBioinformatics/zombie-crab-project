import { cookies } from "next/headers";

export const SESSION_COOKIE = "myc_session";

export interface SessionCookie {
  token: string;
  email: string;
}

export async function setSession(session: SessionCookie): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, JSON.stringify(session), {
    httpOnly: true,
    sameSite: "lax",
    // This stack has no TLS in front of any service (mycelium-gateway's own
    // `tls = "disabled"`, see mycelium/config.standalone.toml) -- a `Secure`
    // cookie here would be set but never sent back by the browser over
    // plain HTTP, silently breaking every session (verified empirically:
    // curl doesn't care and hid this, a real browser would).
    secure: false,
    path: "/",
  });
}

export async function getSession(): Promise<SessionCookie | null> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.token === "string" && typeof parsed?.email === "string") {
      return parsed as SessionCookie;
    }
    return null;
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
