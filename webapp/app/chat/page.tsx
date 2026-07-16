import { getSession } from "@/lib/session";
import WorkspacePicker from "./workspace-picker";

// /chat is the pre-chat selection screen: it lists the workspaces the caller
// may use (one card per licensed tenant/subscription/agent) and, on pick,
// enters the chat view with the choice held in the URL fragment. The path
// itself stays workspace-agnostic (workspace-selection WS-04/WS-08).
export default async function ChatSelectionPage() {
  const session = await getSession();
  return <WorkspacePicker email={session?.email ?? ""} />;
}
