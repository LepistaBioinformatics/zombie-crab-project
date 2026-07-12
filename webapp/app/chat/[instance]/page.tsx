"use client";

import { useEffect, useRef, useState, FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import Box from "@mui/material/Box";
import Container from "@mui/material/Container";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import Paper from "@mui/material/Paper";
import IconButton from "@mui/material/IconButton";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import Link from "next/link";
import { isInstance } from "@/lib/mycelium";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

type ErrorKind = "invalid_instance" | "session_expired" | "role_required" | "connectivity" | null;

export default function ConversationPage() {
  const params = useParams<{ instance: string }>();
  const router = useRouter();
  const instance = params.instance;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<ErrorKind>(null);
  const sessionIdRef = useRef<string>("");

  useEffect(() => {
    if (!isInstance(instance)) {
      setError("invalid_instance");
      return;
    }
    // Fresh session_id whenever the instance changes -- conversations are
    // not shared across instances (spec.md CHAT-03 AC#3).
    sessionIdRef.current = crypto.randomUUID();
    setMessages([]);
    setError(null);
  }, [instance]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!input.trim() || !isInstance(instance)) return;

    const userMessage: ChatMessage = { role: "user", content: input };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setSending(true);
    setError(null);

    try {
      const res = await fetch(`/api/chat/${instance}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMessage.content, session_id: sessionIdRef.current }),
      });

      if (res.status === 401) {
        router.push("/signin");
        return;
      }
      if (res.status === 403) {
        setError("role_required");
        return;
      }
      if (!res.ok) {
        setError("connectivity");
        return;
      }

      const data = await res.json();
      setMessages((prev) => [...prev, { role: "assistant", content: data.content }]);
    } catch {
      setError("connectivity");
    } finally {
      setSending(false);
    }
  }

  if (error === "invalid_instance") {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Alert severity="error">Unknown instance &quot;{instance}&quot;.</Alert>
      </Container>
    );
  }

  return (
    <Container maxWidth="sm" sx={{ py: 4, display: "flex", flexDirection: "column", height: "100vh" }}>
      <Stack direction="row" alignItems="center" spacing={1} mb={2}>
        <IconButton component={Link} href="/chat" size="small">
          <ArrowBackIcon />
        </IconButton>
        <Typography variant="h6" textTransform="capitalize">
          {instance}
        </Typography>
      </Stack>

      {error === "role_required" && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          You don&apos;t have access to this instance yet -- ask an operator to assign your
          role.
        </Alert>
      )}
      {error === "connectivity" && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Can&apos;t reach the gateway right now.
        </Alert>
      )}

      <Box flex={1} overflow="auto" mb={2}>
        <Stack spacing={1.5}>
          {messages.map((m, i) => (
            <Paper
              key={i}
              variant="outlined"
              sx={{
                p: 1.5,
                alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                bgcolor: m.role === "user" ? "primary.main" : "action.hover",
                color: m.role === "user" ? "primary.contrastText" : "text.primary",
                maxWidth: "80%",
              }}
            >
              <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
                {m.content}
              </Typography>
            </Paper>
          ))}
        </Stack>
      </Box>

      <Box component="form" onSubmit={onSubmit}>
        <Stack direction="row" spacing={1}>
          <TextField
            fullWidth
            size="small"
            placeholder="Say something..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={sending}
          />
          <Button type="submit" variant="contained" disabled={sending || !input.trim()}>
            Send
          </Button>
        </Stack>
      </Box>
    </Container>
  );
}
