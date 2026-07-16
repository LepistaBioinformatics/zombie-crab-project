"use client";

import { useState } from "react";
import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { IconButton } from "@/components/ui/icon-button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export default function LogoutButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onLogout() {
    setLoading(true);
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/signin");
  }

  return (
    <>
      <IconButton
        variant="ghost"
        size="sm"
        aria-label="Log out"
        title="Log out"
        onClick={() => setOpen(true)}
      >
        <LogOut size={18} aria-hidden />
      </IconButton>
      <ConfirmDialog
        open={open}
        title="Log out?"
        message="You'll need to sign in again with a magic link."
        confirmLabel={loading ? "Logging out…" : "Log out"}
        onConfirm={onLogout}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}
