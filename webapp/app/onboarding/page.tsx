import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { hasAccount } from "@/lib/onboarding";
import OnboardingWelcome from "./onboarding-welcome";

// Server guard: a user who already has an account (flag set, or detection says
// "yes") never lingers on onboarding (onboarding OB-02). Anyone else -- "no" or
// even "unreachable" -- sees the welcome and can trigger the create.
export default async function OnboardingPage() {
  const session = await getSession();
  if (!session) redirect("/signin");

  if (session.accountReady || (await hasAccount(session.token)) === "yes") {
    redirect("/chat");
  }

  return <OnboardingWelcome email={session.email} />;
}
