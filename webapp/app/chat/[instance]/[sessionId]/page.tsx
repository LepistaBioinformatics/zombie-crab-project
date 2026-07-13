"use client";

import { useEffect, useRef, useState, FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import Box from "@mui/material/Box";
import Container from "@mui/material/Container";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import Paper from "@mui/material/Paper";
import CircularProgress from "@mui/material/CircularProgress";
import { isInstance } from "@/lib/mycelium";
import { touchConversation } from "@/lib/chatSession";
import MessageContent from "@/app/chat/message-content";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

type ErrorKind = "invalid_instance" | "session_expired" | "role_required" | "connectivity" | null;

export default function ConversationPage() {
  const params = useParams<{ instance: string; sessionId: string }>();
  const router = useRouter();
  const instance = params.instance;
  const sessionId = params.sessionId;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [error, setError] = useState<ErrorKind>(null);

  // Chat-style scroll: a brand new message pins its *top* into view (so a
  // long reply can be read from the start while it's still streaming/
  // growing, instead of being force-scrolled to the bottom on every delta),
  // while the very first load of a conversation jumps straight to the most
  // recent message.
  const messageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [scrollToIndex, setScrollToIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!isInstance(instance)) {
      setError("invalid_instance");
      return;
    }
    setError(null);
    setLoadingHistory(true);

    (async () => {
      try {
        const res = await fetch(
          `/api/chat/${instance}/history?session_id=${encodeURIComponent(sessionId)}`,
        );
        if (res.status === 401) {
          router.push("/signin");
          return;
        }
        if (!res.ok) {
          setMessages([]);
          return;
        }
        const data = await res.json();
        const loaded = Array.isArray(data.messages) ? data.messages : [];
        setMessages(loaded);
        // Opening a conversation lands on the most recent message, same as
        // any chat app -- only *new* messages sent from here on get the
        // scroll-to-top-of-message treatment below.
        if (loaded.length > 0) {
          requestAnimationFrame(() => setScrollToIndex(loaded.length - 1));
        }
      } catch {
        setMessages([]);
      } finally {
        setLoadingHistory(false);
      }
    })();
  }, [instance, sessionId, router]);

  useEffect(() => {
    if (scrollToIndex === null) return;
    messageRefs.current[scrollToIndex]?.scrollIntoView({ behavior: "smooth", block: "start" });
    // Deliberately not depending on `messages` -- the target message's ref
    // is already attached by the time this runs (same commit), and we don't
    // want every streamed delta re-triggering a smooth-scroll animation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToIndex]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    sendMessage();
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || !isInstance(instance) || sending) return;

    // The new user message's index -- scroll its *top* into view once it
    // (and the assistant placeholder after it) actually render.
    setScrollToIndex(messages.length);
    setMessages((prev) => [...prev, { role: "user", content: text }, { role: "assistant", content: "" }]);
    setInput("");
    setSending(true);
    setError(null);
    // Fire-and-forget -- bumping recency/title shouldn't block sending the
    // actual message.
    touchConversation(sessionId, text).catch(() => {});

    try {
      const res = await fetch(`/api/chat/${instance}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, session_id: sessionId }),
      });

      if (res.status === 401) {
        router.push("/signin");
        return;
      }
      if (res.status === 403) {
        setError("role_required");
        setMessages((prev) => prev.slice(0, -1)); // drop the empty assistant placeholder
        return;
      }
      if (!res.ok || !res.body) {
        setError("connectivity");
        setMessages((prev) => prev.slice(0, -1));
        return;
      }

      await consumeStream(res.body, (delta) => {
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = {
            role: "assistant",
            content: next[next.length - 1].content + delta,
          };
          return next;
        });
      });
    } catch {
      // Keep whatever partial content already streamed in -- only surface
      // the error banner, don't discard the in-progress reply (spec.md
      // "Streamed replies" AC#2).
      setError("connectivity");
    } finally {
      setSending(false);
    }
  }

  if (error === "invalid_instance") {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Alert severity="error">Unknown agent &quot;{instance}&quot;.</Alert>
      </Container>
    );
  }

  return (
    <Box display="flex" flexDirection="column" height="100%">
      {error === "role_required" && (
        <Alert severity="warning" sx={{ m: 2, mb: 0 }}>
          You don&apos;t have access to this agent yet -- ask an operator to assign your role.
        </Alert>
      )}
      {error === "connectivity" && (
        <Alert severity="error" sx={{ m: 2, mb: 0 }}>
          Can&apos;t reach the gateway right now.
        </Alert>
      )}

      <Box flex={1} overflow="auto" p={2}>
        {loadingHistory ? (
          <Box display="flex" justifyContent="center" pt={4}>
            <CircularProgress size={28} />
          </Box>
        ) : (
          <Stack spacing={1.5} maxWidth="sm" mx="auto">
            {messages.map((m, i) => (
              <Paper
                key={i}
                ref={(el: HTMLDivElement | null) => {
                  messageRefs.current[i] = el;
                }}
                variant="outlined"
                sx={{
                  p: 1.5,
                  alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                  // 5-8% accent tint on neutral, per the Lepista design
                  // system's surface guidance -- not a flat grey.
                  bgcolor: m.role === "user" ? "primary.main" : "rgba(100, 197, 235, 0.08)",
                  color: m.role === "user" ? "primary.contrastText" : "text.primary",
                  maxWidth: "80%",
                }}
              >
                <MessageContent content={m.content} />
                {sending && i === messages.length - 1 && m.role === "assistant" && (
                  <Box
                    component="span"
                    sx={{
                      display: "inline-block",
                      width: "0.5em",
                      height: "1em",
                      ml: 0.25,
                      bgcolor: "currentColor",
                      verticalAlign: "text-bottom",
                      animation: "blink 1s step-start infinite",
                      "@keyframes blink": { "50%": { opacity: 0 } },
                    }}
                  />
                )}
              </Paper>
            ))}
          </Stack>
        )}
      </Box>

      <Box component="form" onSubmit={onSubmit} p={2} pt={0}>
        <Stack direction="row" spacing={1} maxWidth="sm" mx="auto" alignItems="flex-end">
          <TextField
            fullWidth
            multiline
            minRows={1}
            maxRows={8}
            size="small"
            placeholder="Say something... (Shift+Enter for a new line)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            disabled={sending || loadingHistory}
          />
          <Button type="submit" variant="contained" disabled={sending || loadingHistory || !input.trim()}>
            Send
          </Button>
        </Stack>
      </Box>
    </Box>
  );
}

// Parses the proxy's OpenAI-style SSE stream (`data: {...}\n\n`, terminated
// by `data: [DONE]\n\n`) and calls onDelta with each chunk's
// choices[0].delta.content as it arrives.
async function consumeStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const line = frame.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice("data:".length).trim();
      if (payload === "[DONE]") return;

      try {
        const parsed = JSON.parse(payload);
        const delta: string | undefined = parsed?.choices?.[0]?.delta?.content;
        if (delta) onDelta(delta);
      } catch {
        // skip a malformed frame rather than aborting the whole stream
      }
    }
  }
}
