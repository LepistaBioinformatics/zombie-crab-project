"use client";

import { FormEvent, useEffect, useState } from "react";
import { cva } from "class-variance-authority";
import { KeyRound, Trash2, X } from "lucide-react";
import {
  listSecrets,
  setSecret,
  deleteSecret,
  SECRET_FORMATS,
  WEB_PROVIDERS,
  SECRET_NAME_RE,
  type SecretNames,
  type SecretFormat,
} from "@/lib/secrets";
import type { Workspace } from "./fragment";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";

const backdrop = cva("fixed inset-0 z-40 bg-black/40 transition-opacity", {
  variants: { open: { true: "opacity-100", false: "pointer-events-none opacity-0" } },
});

const panel = cva(
  "fixed inset-y-0 right-0 z-50 flex w-[380px] max-w-[90vw] flex-col border-l border-brand bg-surface shadow-xl transition-transform",
  { variants: { open: { true: "translate-x-0", false: "translate-x-full" } } },
);

const selectClass =
  "h-11 w-full rounded-lg border border-brand bg-elevated px-3 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft";

const FORMAT_LABEL: Record<SecretFormat, string> = {
  dotenv: "dotenv (.env)",
  json: "json",
  file: "file",
  native: "native (picoclaw slot)",
};

export default function SecretsDrawer({
  workspace,
  open,
  onClose,
}: {
  workspace: Workspace;
  open: boolean;
  onClose: () => void;
}) {
  const [secrets, setSecrets] = useState<SecretNames | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [format, setFormat] = useState<SecretFormat>("dotenv");
  const [nativeKind, setNativeKind] = useState<"web" | "model">("web");
  const [provider, setProvider] = useState<string>(WEB_PROVIDERS[0]);
  const [model, setModel] = useState("");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = () => listSecrets(workspace).then(setSecrets);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSecrets(null);
    setLoadError(null);
    listSecrets(workspace)
      .then((s) => {
        if (!cancelled) setSecrets(s);
      })
      .catch((e: Error) => {
        if (!cancelled) setLoadError(e.message);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspace.t, workspace.s, workspace.r]);

  // The slot/name actually submitted, built from the format-specific inputs.
  function targetName(): string {
    if (format === "native") {
      return nativeKind === "web" ? `web.${provider}` : `model_list.${model.trim()}.api_keys`;
    }
    return name.trim();
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    const finalName = targetName();

    if (format !== "native" && !SECRET_NAME_RE.test(finalName)) {
      setSubmitError("Name may only contain letters, numbers, and . _ -");
      return;
    }
    if (format === "native" && nativeKind === "model" && !model.trim()) {
      setSubmitError("Enter the model name.");
      return;
    }
    if (!value) {
      setSubmitError("Enter a value.");
      return;
    }

    setSubmitting(true);
    try {
      await setSecret(workspace, { format, name: finalName, value });
      setValue(""); // never keep the value around after submit
      await refresh();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  async function onDelete(fmt: SecretFormat, secretName: string) {
    if (!window.confirm(`Delete "${secretName}"? The agent will restart.`)) return;
    setBusy(secretName);
    setLoadError(null);
    try {
      await deleteSecret(workspace, { format: fmt, name: secretName });
      await refresh();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  const applying = submitting || busy !== null;
  const groups = SECRET_FORMATS.map((fmt) => ({ fmt, names: secrets?.[fmt] ?? [] })).filter(
    (g) => g.names.length > 0,
  );
  const isEmpty = secrets !== null && groups.length === 0;

  return (
    <>
      <div className={backdrop({ open })} onClick={onClose} aria-hidden />

      <aside className={panel({ open })} role="dialog" aria-label="Agent secrets">
        <div className="flex items-center gap-2 border-b border-brand/30 px-4 py-3">
          <KeyRound size={18} className="text-accent" aria-hidden />
          <h2 className="flex-1 font-display text-base font-semibold text-fg">Agent secrets</h2>
          <IconButton variant="ghost" size="sm" aria-label="Close" onClick={onClose}>
            <X size={18} aria-hidden />
          </IconButton>
        </div>

        <div className="flex-1 overflow-auto px-4 py-4">
          <p className="mb-4 text-xs leading-relaxed text-fg-muted">
            Saved for <strong className="text-fg">you</strong> on{" "}
            <strong className="text-fg">agent {workspace.r}</strong> — kept across this agent&apos;s
            subscriptions and future sessions, not per conversation. Values are write-only: they are
            never shown or retrieved. Saving or deleting <strong className="text-fg">restarts the
            agent</strong> (a live turn is briefly interrupted).
          </p>

          {applying && (
            <div className="mb-3">
              <Alert severity="info">Applying — the agent is restarting…</Alert>
            </div>
          )}

          <form onSubmit={onSubmit} className="mb-6 flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-fg-muted">Format</span>
              <select
                className={selectClass}
                value={format}
                onChange={(e) => setFormat(e.target.value as SecretFormat)}
              >
                {SECRET_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {FORMAT_LABEL[f]}
                  </option>
                ))}
              </select>
            </label>

            {format === "native" ? (
              <>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-fg-muted">Slot</span>
                  <select
                    className={selectClass}
                    value={nativeKind}
                    onChange={(e) => setNativeKind(e.target.value as "web" | "model")}
                  >
                    <option value="web">Web search provider</option>
                    <option value="model">Model API key</option>
                  </select>
                </label>
                {nativeKind === "web" ? (
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-fg-muted">Provider</span>
                    <select
                      className={selectClass}
                      value={provider}
                      onChange={(e) => setProvider(e.target.value)}
                    >
                      {WEB_PROVIDERS.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-fg-muted">Model</span>
                    <Input
                      inputSize="md"
                      placeholder="e.g. deepseek-chat"
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                    />
                    <span className="text-[11px] text-fg-muted">
                      Slot: <code className="font-mono">model_list.{model.trim() || "<model>"}.api_keys</code>
                    </span>
                  </label>
                )}
              </>
            ) : (
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-fg-muted">Name</span>
                <Input
                  inputSize="md"
                  placeholder="e.g. OPENAI_API_KEY"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
            )}

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-fg-muted">Value</span>
              <Input
                inputSize="md"
                type="password"
                autoComplete="off"
                placeholder="Secret value (write-only)"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </label>

            {submitError && <Alert severity="error">{submitError}</Alert>}

            <Button type="submit" variant="filled" disabled={submitting}>
              {submitting ? "Saving…" : "Save secret"}
            </Button>
          </form>

          <div className="mb-2 flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 bg-accent" aria-hidden />
            <span className="font-display text-xs font-semibold uppercase tracking-wide text-fg-muted">
              Set secrets
            </span>
          </div>

          {loadError && <Alert severity="error">{loadError}</Alert>}

          {!loadError && secrets === null && (
            <div className="flex justify-center py-4">
              <Spinner size={20} />
            </div>
          )}

          {isEmpty && (
            <p className="py-3 text-sm text-fg-muted">No secrets set for this agent yet.</p>
          )}

          {groups.map((group) => (
            <div key={group.fmt} className="mb-4">
              <div className="mb-1">
                <Badge tone="neutral">{group.fmt}</Badge>
              </div>
              <ul className="flex flex-col gap-1">
                {group.names.map((secretName) => (
                  <li
                    key={secretName}
                    className="flex items-center gap-2 rounded-lg border border-brand/30 bg-elevated px-3 py-1.5"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">
                      {secretName}
                    </span>
                    <IconButton
                      variant="ghost"
                      size="sm"
                      aria-label={`Delete ${secretName}`}
                      disabled={busy === secretName}
                      onClick={() => onDelete(group.fmt, secretName)}
                    >
                      <Trash2 size={15} aria-hidden />
                    </IconButton>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </aside>
    </>
  );
}
