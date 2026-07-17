"use client";

import { FormEvent, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import {
  listSharedSecrets,
  setSharedSecret,
  deleteSharedSecret,
  type ScopeRef,
} from "@/lib/admin";
import {
  SECRET_FORMATS,
  WEB_PROVIDERS,
  SECRET_NAME_RE,
  type SecretNames,
  type SecretFormat,
} from "@/lib/secrets";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

const selectClass =
  "h-11 w-full rounded-lg border border-brand bg-elevated px-3 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft";

const FORMAT_LABEL: Record<SecretFormat, string> = {
  dotenv: "dotenv (.env)",
  json: "json",
  file: "file",
  native: "native (picoclaw slot)",
};

// Shared secrets at a scope: write / list-names / delete. Injected as env into
// every container below the scope (FR-5). WRITE-ONLY over the API -- values are
// never listed or retrieved (FR-5.1), only names.
export default function SharedSecretsPanel({ scope }: { scope: ScopeRef }) {
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
  const [pendingDelete, setPendingDelete] = useState<{ fmt: SecretFormat; name: string } | null>(null);

  const refresh = () => listSharedSecrets(scope).then(setSecrets);

  useEffect(() => {
    let cancelled = false;
    setSecrets(null);
    setLoadError(null);
    listSharedSecrets(scope)
      .then((s) => {
        if (!cancelled) setSecrets(s);
      })
      .catch((e: Error) => {
        if (!cancelled) setLoadError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [scope.kind, scope.tenantId, scope.subsAccId]);

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
      await setSharedSecret(scope, { format, name: finalName, value });
      setValue("");
      await refresh();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  async function onDelete(fmt: SecretFormat, secretName: string) {
    setPendingDelete(null);
    setBusy(secretName);
    setLoadError(null);
    try {
      await deleteSharedSecret(scope, { format: fmt, name: secretName });
      await refresh();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  const groups = SECRET_FORMATS.map((fmt) => ({ fmt, names: secrets?.[fmt] ?? [] })).filter(
    (g) => g.names.length > 0,
  );
  const isEmpty = secrets !== null && groups.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs leading-relaxed text-fg-muted">
        Injected as environment into every container below this scope, merged under each user&apos;s
        own secrets. Values are write-only: never shown or retrieved. Writing or deleting restarts
        running containers under the scope.
      </p>

      <form onSubmit={onSubmit} className="flex flex-col gap-3">
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
                  Slot:{" "}
                  <code className="font-mono">
                    model_list.{model.trim() || "<model>"}.api_keys
                  </code>
                </span>
              </label>
            )}
          </>
        ) : (
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-fg-muted">Name</span>
            <Input
              inputSize="md"
              placeholder="e.g. SHARED_API_KEY"
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
          {submitting ? "Saving…" : "Save shared secret"}
        </Button>
      </form>

      <div className="flex items-center gap-2">
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

      {isEmpty && <p className="py-3 text-sm text-fg-muted">No shared secrets at this scope yet.</p>}

      {groups.map((group) => (
        <div key={group.fmt}>
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
                  onClick={() => setPendingDelete({ fmt: group.fmt, name: secretName })}
                >
                  <Trash2 size={15} aria-hidden />
                </IconButton>
              </li>
            ))}
          </ul>
        </div>
      ))}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete shared secret?"
        message={
          pendingDelete
            ? `"${pendingDelete.name}" will be removed. Containers below this scope restart to drop it.`
            : undefined
        }
        confirmLabel="Delete"
        onConfirm={() => pendingDelete && onDelete(pendingDelete.fmt, pendingDelete.name)}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
