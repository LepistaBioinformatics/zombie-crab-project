import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { hasAccount } from "@/lib/onboarding";
import ChatShell from "./chat-shell";
import ConnectivityError from "./connectivity-error";

// /chat is the whole experience now: one persistent shell (nav drawer +
// conditional history drawer + chat view). The old full-page workspace picker
// is gone -- workspace selection lives in the nav sidebar, held in the URL
// fragment (workspace ids never hit the server).
//
// Before rendering the shell we make sure the user has a mycelium account
// (onboarding OB-02): an account-less user is sent to onboarding; a transport
// failure shows a real error (never onboarding); the flag caches a "yes" so
// this probes at most once per session.
export default async function ChatPage() {
  const session = await getSession();
  if (!session) return <ChatShell email="" />;

  if (!session.accountReady) {
    const status = await hasAccount(session.token);
    if (status === "no") redirect("/onboarding");
    if (status === "unreachable") return <ConnectivityError />;
  }

  return <ChatShell email={session.email} />;
}
