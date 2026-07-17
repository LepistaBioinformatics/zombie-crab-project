"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createConversation, touchConversation, syncSessionRefs } from "@/lib/chatSession";
import MessageContent from "@/app/chat/message-content";
import Composer from "@/app/chat/composer";
import { cva } from "class-variance-authority";
import { KeyRound, PanelRight, Reply } from "lucide-react";
import { setFragmentSid, historyQuery, type Workspace } from "@/app/chat/fragment";
import SecretsDrawer from "@/app/chat/secrets-drawer";
import UploadsSidebar from "@/app/chat/uploads-sidebar";
import AttachmentButton from "@/app/chat/attachment-button";
import { uploadMedia, parseAnexos, type Attachment } from "@/lib/media";
import { CopyButton } from "@/components/ui/copy-button";
import { Alert } from "@/components/ui/alert";
import { IconButton } from "@/components/ui/icon-button";
import { Spinner } from "@/components/ui/spinner";

// Full-width bands (composer width), clearly attributed: a colored origin bar —
// accent cyan on the RIGHT for the user (::after), violet on the LEFT for the
// agent (::before) — plus distinct background tints and text indented to that
// side. No soft gradient between speakers (sharp boundary); the gap does the
// separating.
// Chromotherapy: the agent's messages carry a warm-yellow skin so they stand
// out and stick in memory. Light mode tints the whole band light yellow with a
// stronger (still light) yellow origin bar; dark mode keeps the neutral band but
// turns the text and bar yellow. The user's messages stay cyan, only shifting
// their text to a soft blue in dark mode.
const messageBand = cva("group relative w-full py-3 text-fg", {
  variants: {
    role: {
      user: "bg-accent/12 pl-16 pr-8 max-md:pl-4 max-md:pr-4 dark:text-[#90CAF9] after:absolute after:inset-y-0 after:right-0 after:w-[3px] after:bg-accent after:content-['']",
      assistant:
        "bg-[#fef9e742] dark:bg-elevated/70 pl-8 pr-16 max-md:pl-4 max-md:pr-4 dark:text-[#c9c7be] before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-[#ad9d67] before:content-['']",
    },
  },
});

// A clear gap when the speaker changes (distinct blocks), tight when the same
// speaker continues (one flowing message).
const bandGap = cva("", {
  variants: { changed: { true: "mt-4", false: "mt-0.5" } },
  defaultVariants: { changed: false },
});

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// A message the composer is quoting (Telegram-style reply). Pico is text-only
// and the transcript is reloaded from picoclaw, so a reply is carried as a
// markdown blockquote embedded in the sent message -- it persists and gives the
// agent the referenced context.
export interface ReplyTo {
  role: "user" | "assistant";
  content: string;
}

const QUOTE_MAX = 280;

// Turns the referenced message into a one-line attributed blockquote. Anexo
// refs are stripped (only the prose is quoted) and newlines collapsed so the
// quote stays a single tidy `>` line regardless of the original's length.
function buildQuote(reply: ReplyTo): string {
  const who = reply.role === "user" ? "Você" : "Agente";
  const { text } = parseAnexos(reply.content);
  const oneLine = text.replace(/\s+/g, " ").trim();
  const snippet = oneLine.length > QUOTE_MAX ? `${oneLine.slice(0, QUOTE_MAX - 1)}…` : oneLine;
  return `> **${who}:** ${snippet}`;
}

// After an upload, picoclaw reloads to pick up the new workspace file. Give it a
// moment to settle before firing the turn, so the first message right after an
// attach doesn't hit the container mid-reload ("Can't reach the gateway").
const UPLOAD_SETTLE_MS = 1500;

// Sending a turn retries on transport / gateway failure (fetch throws or a 5xx)
// with exponential backoff -- 1s, then doubling, capped -- up to
// MAX_SEND_ATTEMPTS, showing a discreet notice while it retries. A 4xx
// (auth/validation) is terminal and surfaced at once, never retried.
const MAX_SEND_ATTEMPTS = 10;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30000;
const retryDelay = (attempt: number) => Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const [replyTo, setReplyTo] = useState<ReplyTo | null>(null);
  const [retrying, setRetrying] = useState<number | null>(null);
  // On touch (no hover), tapping a message opens its action row below the card;
  // holds the index of the message whose actions are open (mobile only).
  const [openActions, setOpenActions] = useState<number | null>(null);
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
    setRetrying(null);
    // Pending attachments belong to the composer of the conversation you were
    // in -- drop them when switching.
    setAttachments([]);
    setAttachError(null);
    setReplyTo(null);
    setOpenActions(null);
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
    // the agent (a vision model / reader skill) can open, and a reply rides as a
    // leading markdown blockquote. The visible message shows the same, so the
    // user sees exactly what was sent and the quote persists on reload.
    const refs = attachments.map((a) => `[anexo: ${a.path}]`).join("\n");
    const quote = replyTo ? buildQuote(replyTo) : "";
    const composed = [quote, text, refs].filter(Boolean).join("\n\n");

    // The new user message's index -- scroll its *top* into view once it (and
    // the assistant placeholder after it) render.
    setScrollToIndex(messages.length);
    setMessages((prev) => [...prev, { role: "user", content: composed }, { role: "assistant", content: "" }]);
    setInput("");
    setReplyTo(null);
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
      const body = JSON.stringify({
        message: composed,
        session_id: sid,
        tenant_id: workspace.t,
        subs_acc_id: workspace.s,
      });

      // Retry the send until picoclaw accepts the turn (a streamable body):
      // transport failures and 5xx are retried with exponential backoff; a 4xx
      // is terminal (its real reason is surfaced and we stop).
      let stream: ReadableStream<Uint8Array> | null = null;
      let terminal = false;
      for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS && !terminal; attempt++) {
        try {
          const r = await fetch(`/api/chat/${workspace.r}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          });
          if (r.status === 401) {
            router.push("/signin");
            return;
          }
          if (r.ok && r.body) {
            stream = r.body; // accepted -- stop retrying
            break;
          }
          if (r.status < 500) {
            // 4xx: the proxy's real reason (403 not licensed, 409 not
            // scaffolded, 400 bad request). Retrying won't help.
            const data = await r.json().catch(() => null);
            if (activeSidRef.current === sid) setError(errorMessage(data?.error));
            terminal = true;
            break;
          }
          // 5xx / missing body -> fall through to the backoff retry
        } catch {
          // network/transport error -> fall through to the backoff retry
        }
        if (attempt < MAX_SEND_ATTEMPTS) {
          if (activeSidRef.current === sid) setRetrying(attempt);
          await sleep(retryDelay(attempt));
        }
      }
      if (activeSidRef.current === sid) setRetrying(null);

      if (!stream) {
        // A terminal 4xx already set its error; otherwise every attempt failed.
        if (activeSidRef.current === sid) {
          if (!terminal) {
            setError("Still can't reach the gateway after several attempts. Try again shortly.");
          }
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

      await consumeStream(stream, (delta) => {
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

      // The turn is done and picoclaw has persisted the session -- resolve and
      // store the proxy session ids on the postgres row (best-effort). Not
      // gated on the active sid: the reply drained even if the user navigated
      // away, so its refs are still correct.
      syncSessionRefs(workspace, sid).catch(() => {});
    } catch {
      // Keep whatever partial content already streamed in -- only surface the
      // error banner if the user is still viewing this conversation.
      if (activeSidRef.current === sid) setError("Can't reach the gateway right now.");
    } finally {
      if (activeSidRef.current === sid) {
        setSending(false);
        setRetrying(null);
      }
    }
  }

  // The message index + reply + copy, reused by the desktop (hover, bottom-right)
  // and mobile (tap-to-open, below the card) placements. The index rides in the
  // same cluster as the buttons.
  const renderActions = (m: ChatMessage, index: number) => (
    <>
      <span className="select-none self-center px-1 text-[11px] font-semibold tabular-nums text-fg-muted">
        {index + 1}
      </span>
      <IconButton
        variant="ghost"
        size="sm"
        aria-label="Responder a esta mensagem"
        title="Responder"
        onClick={() => setReplyTo({ role: m.role, content: m.content })}
      >
        <Reply size={15} aria-hidden />
      </IconButton>
      <CopyButton text={m.content} />
    </>
  );

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
      replyTo={replyTo}
      onCancelReply={() => setReplyTo(null)}
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
          >
            <PanelRight size={18} aria-hidden />
          </IconButton>
        </div>
      </div>

      {retrying !== null && (
        <div className="flex items-center justify-center gap-2 px-4 py-1.5 text-xs text-fg-muted">
          <Spinner size={12} />
          <span>Couldn&apos;t reach the gateway — retrying… (attempt {retrying} of {MAX_SEND_ATTEMPTS})</span>
        </div>
      )}

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
            <div className="mx-auto w-full max-w-[720px]">
              {messages.map((m, i) => {
                const streaming = sending && i === messages.length - 1 && m.role === "assistant";
                const { text, refs } = parseAnexos(m.content);
                const prev = messages[i - 1];
                const changed = Boolean(prev && prev.role !== m.role);
                return (
                  <div
                    key={i}
                    ref={(el) => {
                      messageRefs.current[i] = el;
                    }}
                    className={bandGap({ changed })}
                  >
                    <div
                      className={messageBand({ role: m.role })}
                      onClick={() =>
                        setOpenActions((cur) => (cur === i ? null : i))
                      }
                    >
                      {m.content.trim() !== "" && (
                        // Desktop only: transparent toolbar at the message's
                        // bottom-right, revealed on hover. Mobile uses the tapped
                        // row below the card instead (rendered after the band).
                        <div className="absolute bottom-1.5 right-1.5 z-10 hidden items-center gap-0.5 opacity-0 transition-opacity md:flex md:group-hover:opacity-100 md:group-focus-within:opacity-100">
                          {renderActions(m, i)}
                        </div>
                      )}
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
                    {/* Mobile only: tapping the card opens this action row below
                        it (before the next message); no hover on touch. */}
                    {m.content.trim() !== "" && openActions === i && (
                      <div className="flex items-center gap-0.5 px-2 py-1 md:hidden">
                        {renderActions(m, i)}
                      </div>
                    )}
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
