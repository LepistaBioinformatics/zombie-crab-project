import { getSession } from "@/lib/session";
import ChatShell from "./chat-shell";

// /chat is the whole experience now: one persistent shell (nav drawer +
// conditional history drawer + chat view). The old full-page workspace picker
// is gone -- workspace selection lives in the nav sidebar, held in the URL
// fragment (workspace ids never hit the server).
export default async function ChatPage() {
  const session = await getSession();
  return <ChatShell email={session?.email ?? ""} />;
}
