"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createConversation, touchConversation } from "@/lib/chatSession";
import MessageContent from "@/app/chat/message-content";
import Composer from "@/app/chat/composer";
import { cva } from "class-variance-authority";
import { KeyRound } from "lucide-react";
import { setFragmentSid, historyQuery, type Workspace } from "@/app/chat/fragment";
import SecretsDrawer from "@/app/chat/secrets-drawer";
import { Alert } from "@/components/ui/alert";
import { IconButton } from "@/components/ui/icon-button";
import { Spinner } from "@/components/ui/spinner";

const messageBubble = cva("max-w-[85%] rounded-2xl px-4 py-2.5", {
  variants: {
    role: {
      user: "self-end bg-accent text-accent-fg",
      assistant: "self-start border border-brand/30 bg-elevated text-fg",
    },
  },
});

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export default function ChatView({
  workspace,
  sessionId,
}: {
  workspace: Workspace;
  sessionId: string | undefined;
}) {
  const router = useRouter();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [secretsOpen, setSecretsOpen] = useState(false);

  // Chat-style scroll: a brand new message pins its *top* into view (so a long
  // reply can be read from the start while it's still streaming), while the
  // very first load of a conversation jumps to the most recent message.
  const messageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [scrollToIndex, setScrollToIndex] = useState<number | null>(null);
  const creatingSid = useRef(false);

  // A valid workspace with no `sid` (direct nav) gets a fresh conversation (id
  // minted server-side, so it also lands in the sidebar) instead of losing the
  // chosen workspace.
  useEffect(() => {
    if (!sessionId && !creatingSid.current) {
      creatingSid.current = true;
      createConversation(workspace)
        .then((conversation) => setFragmentSid(conversation.id))
        .finally(() => {
          creatingSid.current = false;
        });
    }
  }, [workspace, sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    setError(null);
    setLoadingHistory(true);

    let cancelled = false;
    (async () => {
      try {
        const query = historyQuery(workspace, sessionId);
        const res = await fetch(`/api/chat/${workspace.r}/history?${query}`);
        if (cancelled) return;
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
        // Opening a conversation lands on the most recent message; only *new*
        // messages sent from here get the scroll-to-top-of-message treatment.
        if (loaded.length > 0) {
          requestAnimationFrame(() => setScrollToIndex(loaded.length - 1));
        }
      } catch {
        if (!cancelled) setMessages([]);
      } finally {
        if (!cancelled) setLoadingHistory(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.t, workspace.s, workspace.r, sessionId, router]);

  useEffect(() => {
    if (scrollToIndex === null) return;
    messageRefs.current[scrollToIndex]?.scrollIntoView({ behavior: "smooth", block: "start" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToIndex]);

  async function sendMessage() {
    const text = input.trim();
    if (!text || !sessionId || sending) return;

    // The new user message's index -- scroll its *top* into view once it (and
    // the assistant placeholder after it) render.
    setScrollToIndex(messages.length);
    setMessages((prev) => [...prev, { role: "user", content: text }, { role: "assistant", content: "" }]);
    setInput("");
    setSending(true);
    setError(null);

    try {
      const res = await fetch(`/api/chat/${workspace.r}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          session_id: sessionId,
          tenant_id: workspace.t,
          subs_acc_id: workspace.s,
        }),
      });

      if (res.status === 401) {
        router.push("/signin");
        return;
      }
      if (!res.ok || !res.body) {
        // Surface the proxy's real reason (403 not licensed, 409 not
        // scaffolded, 400 bad request); only genuine transport failure reads
        // "connectivity".
        const data = await res.json().catch(() => null);
        setError(errorMessage(data?.error));
        setMessages((prev) => prev.slice(0, -1)); // drop the empty assistant placeholder
        return;
      }

      // The turn was accepted -- picoclaw is now running it and will persist
      // the session. ONLY now create/bump the postgres row (deferred +
      // success-gated), so clicking a chat or a failed/rejected send never
      // leaves a conversation row with no picoclaw transcript behind it.
      touchConversation(workspace, sessionId, text).catch(() => {});

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
      // Keep whatever partial content already streamed in -- only surface the
      // error banner, don't discard the in-progress reply.
      setError("Can't reach the gateway right now.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-brand/30 px-4 py-2">
        <span className="min-w-0 truncate font-display text-sm font-semibold text-fg">
          agent {workspace.r}
        </span>
        <IconButton
          variant="ghost"
          size="sm"
          aria-label="Agent secrets"
          title="Agent secrets"
          onClick={() => setSecretsOpen(true)}
        >
          <KeyRound size={18} aria-hidden />
        </IconButton>
      </div>

      {error && (
        <div className="px-4 pt-4">
          <Alert severity="error">{error}</Alert>
        </div>
      )}

      <div className="flex-1 overflow-auto px-4 py-6">
        {loadingHistory ? (
          <div className="flex justify-center pt-8">
            <Spinner size={28} />
          </div>
        ) : (
          <div className="mx-auto flex max-w-[720px] flex-col gap-3">
            {messages.map((m, i) => {
              const streaming = sending && i === messages.length - 1 && m.role === "assistant";
              return (
                <div
                  key={i}
                  ref={(el) => {
                    messageRefs.current[i] = el;
                  }}
                  className={messageBubble({ role: m.role })}
                >
                  <MessageContent content={m.content} />
                  {streaming && (
                    <span className="ml-0.5 inline-block h-4 w-[0.45em] animate-blink bg-current align-text-bottom" />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="px-4 pb-4">
        <Composer
          value={input}
          onChange={setInput}
          onSend={sendMessage}
          sending={sending}
          loadingHistory={loadingHistory}
          sessionId={sessionId ?? ""}
        />
      </div>

      <SecretsDrawer
        workspace={workspace}
        open={secretsOpen}
        onClose={() => setSecretsOpen(false)}
      />
    </div>
  );
}

function errorMessage(raw: unknown): string {
  if (raw === "connectivity") return "Can't reach the gateway right now.";
  if (typeof raw === "string" && raw.trim()) return raw;
  return "Something went wrong sending your message.";
}

// Parses the proxy's OpenAI-style SSE stream (`data: {...}\n\n`, terminated by
// `data: [DONE]\n\n`) and calls onDelta with each chunk's
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
