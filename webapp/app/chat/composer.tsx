"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { ArrowUp } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { IconButton } from "@/components/ui/icon-button";

const MAX_HEIGHT = 200; // ~8 rows, then the field scrolls internally

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  sending: boolean;
  loadingHistory: boolean;
  sessionId: string;
}

// The signature element: a large, inviting chat box (rounded surface, violet
// border, cyan focus ring) with the send action integrated as a circular
// accent button. Owns auto-grow and the autofocus-on-open behavior.
export default function Composer({
  value,
  onChange,
  onSend,
  sending,
  loadingHistory,
  sessionId,
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow with content up to a cap.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  // Focus when a conversation is opened (sessionId change) and once its history
  // finishes loading -- the field is intentionally never disabled during load,
  // so the caret lands here with no extra click. Not keyed on messages, so a
  // streaming reply never yanks focus back.
  useEffect(() => {
    if (!loadingHistory) ref.current?.focus();
  }, [sessionId, loadingHistory]);

  const canSend = value.trim().length > 0 && !sending && !loadingHistory;

  return (
    <div className="mx-auto w-full max-w-[720px]">
      <div className="flex items-end gap-2 rounded-2xl border border-brand bg-elevated px-3 py-2 transition-shadow focus-within:ring-2 focus-within:ring-accent-soft">
        <Textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (canSend) onSend();
            }
          }}
          placeholder="Message your agent…  (Shift+Enter for a new line)"
          className="max-h-[200px] py-1.5 leading-relaxed"
        />
        <IconButton
          variant="filled"
          size="md"
          aria-label="Send message"
          disabled={!canSend}
          onClick={onSend}
          className="mb-0.5 shrink-0"
        >
          <ArrowUp size={20} aria-hidden />
        </IconButton>
      </div>
    </div>
  );
}
