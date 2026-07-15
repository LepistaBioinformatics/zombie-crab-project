"use client";

import Button from "@mui/material/Button";
import { useRouter } from "next/navigation";

export default function LogoutButton() {
  const router = useRouter();

  async function onLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/signin");
  }

  return (
    <Button variant="outlined" size="small" onClick={onLogout}>
      Log out
    </Button>
  );
}
