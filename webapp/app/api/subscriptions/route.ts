import { NextResponse } from "next/server";
import { fetchMycelium, isInstance, MyceliumConnectivityError, upstreamError } from "@/lib/mycelium";
import { clearSession, getSession } from "@/lib/session";

interface Subscription {
  tenantId: string;
  subsAccId: string;
  accName: string;
  role: string;
  perm: string;
  verified: boolean;
  scaffolded: boolean;
}

interface DiscoveryResponse {
  subscriptions: Subscription[];
}

// Workspace discovery. The `/picoclaw-alpha/v1/subscriptions` proxy route is
// `protected` (any member) and agent-agnostic -- alpha is just the vehicle,
// the response lists every workspace the caller is licensed into regardless
// of agent. We keep only the ones whose role maps to a configured agent
// (INSTANCES): a role with no agent can't be chatted (would 403), so it has
// no card (workspace-selection resolved point 3).
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "session_expired" }, { status: 401 });
  }

  let res: Response;
  try {
    res = await fetchMycelium("/picoclaw-alpha/v1/subscriptions", {
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

  const data = (await res.json()) as DiscoveryResponse;
  const subscriptions = (data.subscriptions ?? []).filter((s) => isInstance(s.role));
  return NextResponse.json({ subscriptions });
}
