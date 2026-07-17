import { myceliumRpc } from "@/lib/mycelium";

// Server-side only. True when the session's mycelium profile is staff or
// manager -- the instance-admin gate for white-label branding writes. Reads the
// same `beginners.profile.get` RPC onboarding uses; the SDK profile exposes
// `isStaff`/`isManager`. Any transport/RPC failure (rpc.ok === false) denies.
export async function isInstanceAdmin(token: string): Promise<boolean> {
  const rpc = await myceliumRpc<{ isStaff?: boolean; isManager?: boolean }>(
    "beginners.profile.get",
    {},
    token,
  );
  return rpc.ok && !!(rpc.result?.isStaff || rpc.result?.isManager);
}
