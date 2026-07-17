import { NextResponse } from "next/server";
import { myceliumRpc, MyceliumConnectivityError } from "@/lib/mycelium";
import { getSession, setSession } from "@/lib/session";

// Explicit account creation, triggered by the onboarding "Vamos começar" button
// (onboarding OB-04). Mirrors the reference mycelium-webapp Onboarding:
// accountsCreate -> RPC `beginners.accounts.create` over /_adm/rpc. The RPC path
// resolves the internal (magic-link) issuer; the REST POST /_adm/beginners/accounts
// is external-provider-only ("Invalid provider"), and POST /_adm/beginners/users
// creates only the user, not the account — both verified empirically.
export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "session_expired" }, { status: 401 });
  }

  let created;
  try {
    created = await myceliumRpc("beginners.accounts.create", { name: session.email }, session.token);
  } catch (err) {
    if (err instanceof MyceliumConnectivityError) {
      return NextResponse.json({ error: "connectivity" }, { status: 502 });
    }
    throw err;
  }

  if (!created.ok) {
    return NextResponse.json(
      { error: created.message, status: created.status },
      { status: created.status || 502 },
    );
  }

  await setSession({ ...session, accountReady: true });
  return NextResponse.json({ ok: true });
}
