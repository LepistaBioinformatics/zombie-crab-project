import { myceliumRpc, MyceliumConnectivityError } from "@/lib/mycelium";

// Server-side only. Detects whether the signed-in user already has a mycelium
// account, mirroring the reference mycelium-webapp Onboarding: profileGet() then
// accountsGet(), over JSON-RPC (/_adm/rpc). The internal (magic-link) account
// endpoints only work via RPC (the REST ones are external-provider-only).
// `beginners.accounts.get` returns the account object or null — a non-null
// result means the user has an account (verified empirically for a magic-link
// user; no invitation needed). A transport failure stays distinct from
// account-less: never route to onboarding because the gateway was unreachable.
export async function hasAccount(token: string): Promise<"yes" | "no" | "unreachable"> {
  try {
    // Mirror the reference ordering; the account is the decisive signal.
    await myceliumRpc("beginners.profile.get", { withUrl: false }, token);
    const acc = await myceliumRpc<unknown>("beginners.accounts.get", {}, token);
    return acc.ok && acc.result ? "yes" : "no";
  } catch (err) {
    if (err instanceof MyceliumConnectivityError) return "unreachable";
    return "no";
  }
}
