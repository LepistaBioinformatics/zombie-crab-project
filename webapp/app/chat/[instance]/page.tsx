"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import { isInstance } from "@/lib/mycelium";
import { createConversation } from "@/lib/chatSession";

// A bare /chat/{instance} visit (no conversation picked yet) always means
// "start a new one" -- the sidebar's own "New chat" flow already generates
// a session id and links straight to /chat/{instance}/{sessionId}, so this
// route only exists to handle a manually-typed or bookmarked URL the same
// way.
export default function NewConversationRedirect() {
  const params = useParams<{ instance: string }>();
  const router = useRouter();
  const instance = params.instance;

  useEffect(() => {
    if (!isInstance(instance)) {
      router.replace("/chat");
      return;
    }
    createConversation(instance).then((conversation) => {
      router.replace(`/chat/${instance}/${conversation.id}`);
    });
  }, [instance, router]);

  return (
    <Box display="flex" justifyContent="center" alignItems="center" height="100%">
      <CircularProgress size={28} />
    </Box>
  );
}
