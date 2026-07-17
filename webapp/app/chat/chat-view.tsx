"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createConversation, touchConversation } from "@/lib/chatSession";
import MessageContent from "@/app/chat/message-content";
import Composer from "@/app/chat/composer";
import { cva } from "class-variance-authority";
import { KeyRound, PanelRight } from "lucide-react";
import { setFragmentSid, historyQuery, type Workspace } from "@/app/chat/fragment";
import SecretsDrawer from "@/app/chat/secrets-drawer";
import UploadsSidebar from "@/app/chat/uploads-sidebar";
import AttachmentButton from "@/app/chat/attachment-button";
import { uploadMedia, parseAnexos, type Attachment } from "@/lib/media";
import { CopyButton } from "@/components/ui/copy-button";
import { Alert } from "@/components/ui/alert";
import { IconButton } from "@/components/ui/icon-button";
import { Spinner } from "@/components/ui/spinner";

// Messages render as full-width bands (same width as the composer), not
// left/right bubbles: a continuous transcript differentiated by a soft
// background tint + which side the text is indented to (right for the user,
// left for the agent). A soft gradient between bands marks each speaker change.
const messageBand = cva("group relative w-full px-6 py-3 text-fg", {
  variants: {
    role: {
      user: "bg-accent/10 pl-16 pr-6",
      assistant: "bg-elevated/40 pl-6 pr-16",
    },
  },
});

const speakerTransition = cva("h-5 w-full", {
  variants: {
    change: {
      "user-assistant": "bg-gradient-to-b from-accent/10 to-elevated/40",
      "assistant-user": "bg-gradient-to-b from-elevated/40 to-accent/10",
    },
  },
});

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// After an upload, picoclaw reloads to pick up the new workspace file. Give it a
// moment to settle before firing the turn, so the first message right after an
// attach doesn't hit the container mid-reload ("Can't reach the gateway").
const UPLOAD_SETTLE_MS = 1500;

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
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [mediaRefresh, setMediaRefresh] = useState(0);
  const [settling, setSettling] = useState(false);
  const lastUploadAtRef = useRef(0);

  // The uploads panel is a permanent right column; remember whether it's open.
  useEffect(() => {
    setFilesOpen(localStorage.getItem("chat-files-open") === "1");
  }, []);
  useEffect(() => {
    localStorage.setItem("chat-files-open", filesOpen ? "1" : "0");
  }, [filesOpen]);

  // Chat-style scroll: a brand new message pins its *top* into view (so a long
  // reply can be read from the start while it's still streaming), while the
  // very first load of a conversation jumps to the most recent message.
  const messageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [scrollToIndex, setScrollToIndex] = useState<number | null>(null);
  const creatingSid = useRef(false);

  // Always mirrors the currently-viewed session, so an in-flight stream can
  // tell whether the user is still looking at the conversation the reply
  // belongs to before it touches the (single, shared) messages state.
  const activeSidRef = useRef<string | undefined>(sessionId);
  useEffect(() => {
    activeSidRef.current = sessionId;
  }, [sessionId]);

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
    // The newly-viewed conversation isn't the one mid-send (if any) -- reset so
    // its composer isn't stuck disabled by another conversation's in-flight send.
    setSending(false);
    // Pending attachments belong to the composer of the conversation you were
    // in -- drop them when switching.
    setAttachments([]);
    setAttachError(null);
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

  // Reloads a conversation's transcript from picoclaw -- used to reconcile a
  // reply that finished after the user had navigated away and back.
  async function reloadHistory(sid: string) {
    try {
      const res = await fetch(`/api/chat/${workspace.r}/history?${historyQuery(workspace, sid)}`);
      if (!res.ok) return;
      const data = await res.json();
      const loaded = Array.isArray(data.messages) ? data.messages : [];
      if (activeSidRef.current === sid) setMessages(loaded);
    } catch {
      // leave whatever is on screen
    }
  }

  async function uploadFiles(files: FileList) {
    setAttachError(null);
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const attachment = await uploadMedia(workspace, file);
        setAttachments((prev) => [...prev, attachment]);
        setMediaRefresh((n) => n + 1); // the workspace-files panel picks it up
        lastUploadAtRef.current = Date.now();
      }
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  function removeAttachment(path: string) {
    setAttachments((prev) => prev.filter((a) => a.path !== path));
  }

  async function sendMessage() {
    const text = input.trim();
    if ((!text && attachments.length === 0) || !sessionId || sending) return;
    const sid = sessionId; // the conversation this reply belongs to

    // The turn is text-only: attachments ride along as workspace path references
    // the agent (a vision model / reader skill) can open. The visible message
    // shows the same, so the user sees what was sent.
    const refs = attachments.map((a) => `[anexo: ${a.path}]`).join("\n");
    const composed = refs ? (text ? `${text}\n\n${refs}` : refs) : text;

    // The new user message's index -- scroll its *top* into view once it (and
    // the assistant placeholder after it) render.
    setScrollToIndex(messages.length);
    setMessages((prev) => [...prev, { role: "user", content: composed }, { role: "assistant", content: "" }]);
    setInput("");
    setSending(true);
    setError(null);

    // If a file was just uploaded, wait for picoclaw to settle (reload) before
    // firing the turn, so the first message after an attach doesn't hit the
    // container mid-reload. Shows a friendly "saving your file" note meanwhile.
    const sinceUpload = Date.now() - lastUploadAtRef.current;
    const settleWait = attachments.length > 0 ? Math.max(0, UPLOAD_SETTLE_MS - sinceUpload) : 0;
    if (settleWait > 0) {
      setSettling(true);
      await new Promise((resolve) => setTimeout(resolve, settleWait));
      setSettling(false);
    }

    // If the user switches to another conversation mid-stream, we STOP painting
    // this reply (it would otherwise land in the wrong conversation) but keep
    // DRAINING the response so the turn finishes server-side and picoclaw
    // persists it -- the reply is never cut. Once detached we never repaint,
    // even if the user comes back, to avoid racing the history reload.
    let detached = false;

    try {
      const res = await fetch(`/api/chat/${workspace.r}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: composed,
          session_id: sid,
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
        if (activeSidRef.current === sid) {
          setError(errorMessage(data?.error));
          setMessages((prev) => prev.slice(0, -1)); // drop the empty assistant placeholder
        }
        return;
      }

      // The turn was accepted -- picoclaw is now running it and will persist
      // the session. ONLY now create/bump the postgres row (deferred +
      // success-gated), so clicking a chat or a failed/rejected send never
      // leaves a conversation row with no picoclaw transcript behind it.
      touchConversation(workspace, sid, composed).catch(() => {});
      setAttachments([]); // consumed by this turn

      await consumeStream(res.body, (delta) => {
        if (detached) return;
        if (activeSidRef.current !== sid) {
          detached = true; // user navigated away -- keep draining, stop painting
          return;
        }
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (!last || last.role !== "assistant") return prev;
          next[next.length - 1] = { role: "assistant", content: last.content + delta };
          return next;
        });
      });

      // Left mid-stream but came back before it finished -> pull the now-complete
      // transcript so the finished reply replaces whatever partial was shown.
      if (detached && activeSidRef.current === sid) {
        await reloadHistory(sid);
      }
    } catch {
      // Keep whatever partial content already streamed in -- only surface the
      // error banner if the user is still viewing this conversation.
      if (activeSidRef.current === sid) setError("Can't reach the gateway right now.");
    } finally {
      if (activeSidRef.current === sid) setSending(false);
    }
  }

  const composer = (
    <Composer
      value={input}
      onChange={setInput}
      onSend={sendMessage}
      sending={sending}
      loadingHistory={loadingHistory}
      sessionId={sessionId ?? ""}
      attachments={attachments}
      uploading={uploading}
      attachError={attachError}
      onPickFiles={uploadFiles}
      onRemoveAttachment={removeAttachment}
    />
  );

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-brand/30 px-4 py-2">
        <span className="min-w-0 truncate font-display text-sm font-semibold text-fg">
          agent {workspace.r}
        </span>
        <div className="flex items-center gap-1">
          <IconButton
            variant="ghost"
            size="sm"
            aria-label="Agent secrets"
            title="Agent secrets"
            onClick={() => setSecretsOpen(true)}
          >
            <KeyRound size={18} aria-hidden />
          </IconButton>
          <IconButton
            variant="ghost"
            size="sm"
            aria-label="Workspace files"
            title="Workspace files"
            onClick={() => setFilesOpen((o) => !o)}
            className="hidden md:inline-flex"
          >
            <PanelRight size={18} aria-hidden />
          </IconButton>
        </div>
      </div>

      {error && (
        <div className="px-4 pt-4">
          <Alert severity="error">{error}</Alert>
        </div>
      )}

      {settling && (
        <div className="px-4 pt-4">
          <Alert severity="info">Estamos guardando o arquivo para você…</Alert>
        </div>
      )}

      {loadingHistory ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner size={28} />
        </div>
      ) : messages.length === 0 ? (
        // Empty conversation: center the composer with a prompt to begin, so a
        // fresh chat invites a first message instead of showing a blank column.
        <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4">
          <div className="text-center">
            <h2 className="font-display text-2xl font-bold text-fg">Start a new chat</h2>
            <p className="mt-2 text-sm text-fg-muted">
              Ask agent {workspace.r} anything to get going.
            </p>
          </div>
          {composer}
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-auto px-4 py-6">
            <div className="mx-auto w-full max-w-[720px] overflow-hidden rounded-xl">
              {messages.map((m, i) => {
                const streaming = sending && i === messages.length - 1 && m.role === "assistant";
                const { text, refs } = parseAnexos(m.content);
                const prev = messages[i - 1];
                const changed = prev && prev.role !== m.role;
                return (
                  <div
                    key={i}
                    ref={(el) => {
                      messageRefs.current[i] = el;
                    }}
                  >
                    {changed && (
                      <div
                        className={speakerTransition({
                          change: `${prev.role}-${m.role}` as "user-assistant" | "assistant-user",
                        })}
                      />
                    )}
                    <div className={messageBand({ role: m.role })}>
                      <CopyButton
                        text={m.content}
                        className="absolute right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                      />
                      {text && <MessageContent content={text} />}
                      {refs.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {refs.map((r) => (
                            <AttachmentButton
                              key={r.path}
                              workspace={workspace}
                              path={r.path}
                              name={r.name}
                              tone="chip"
                            />
                          ))}
                        </div>
                      )}
                      {streaming && (
                        <span className="ml-0.5 inline-block h-4 w-[0.45em] animate-blink bg-current align-text-bottom" />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="px-4 pb-4">{composer}</div>
        </>
      )}
      </div>

      {filesOpen && (
        <UploadsSidebar
          workspace={workspace}
          refreshSignal={mediaRefresh}
          onClose={() => setFilesOpen(false)}
        />
      )}

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
