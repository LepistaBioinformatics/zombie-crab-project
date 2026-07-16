"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { IconButton } from "@/components/ui/icon-button";

export default function LogoutButton() {
  const router = useRouter();

  async function onLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/signin");
  }

  return (
    <IconButton variant="ghost" size="sm" aria-label="Log out" title="Log out" onClick={onLogout}>
      <LogOut size={18} aria-hidden />
    </IconButton>
  );
}
