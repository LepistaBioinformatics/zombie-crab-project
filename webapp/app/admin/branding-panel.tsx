"use client";

import { useEffect, useRef, useState } from "react";
import { cva } from "class-variance-authority";
import { RotateCcw, Save, Upload } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

type Variant = "light" | "dark";

const preview = cva("h-16 w-16 rounded-lg border border-brand/30 object-contain", {
  variants: {
    tone: {
      light: "bg-white",
      dark: "bg-neutral-900",
    },
  },
});

// Instance branding admin panel (FR-10): edit the app name and upload / reset
// the light and dark logos. Server-side authz is the real gate; this panel is
// only reachable when /api/branding/can-edit is true.
export default function BrandingPanel() {
  const [appName, setAppName] = useState("");
  const [loading, setLoading] = useState(true);
  const [savingName, setSavingName] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [bust, setBust] = useState(() => Date.now());
  const [busy, setBusy] = useState<Variant | null>(null);
  const [pendingLogoReset, setPendingLogoReset] = useState<Variant | null>(null);
  const [pendingNameReset, setPendingNameReset] = useState(false);
  const lightInput = useRef<HTMLInputElement>(null);
  const darkInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/branding")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.appName) setAppName(data.appName as string);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function refreshPreviews() {
    setBust(Date.now());
  }

  async function saveName(name: string, resetting: boolean) {
    setSavingName(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/branding", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appName: name }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json();
      setAppName((data?.appName as string) ?? "");
      setNotice(resetting ? "App name reset to default." : "App name saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the app name.");
    } finally {
      setSavingName(false);
    }
  }

  async function uploadLogo(variant: Variant, file: File) {
    setBusy(variant);
    setError(null);
    setNotice(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`/api/branding/logo/${variant}`, { method: "POST", body });
      if (!res.ok) throw new Error(await errorMessage(res));
      refreshPreviews();
      setNotice(`${variant === "light" ? "Light" : "Dark"} logo updated.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(null);
      if (variant === "light" && lightInput.current) lightInput.current.value = "";
      if (variant === "dark" && darkInput.current) darkInput.current.value = "";
    }
  }

  async function resetLogo(variant: Variant) {
    setPendingLogoReset(null);
    setBusy(variant);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/branding/logo/${variant}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await errorMessage(res));
      refreshPreviews();
      setNotice(`${variant === "light" ? "Light" : "Dark"} logo reset to default.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reset failed.");
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size={28} />
      </div>
    );
  }

  const variants: { key: Variant; label: string; ref: React.RefObject<HTMLInputElement | null> }[] = [
    { key: "light", label: "Light logo", ref: lightInput },
    { key: "dark", label: "Dark logo", ref: darkInput },
  ];

  return (
    <div className="flex max-w-xl flex-col gap-6">
      {error && <Alert severity="error">{error}</Alert>}
      {notice && <Alert severity="info">{notice}</Alert>}

      <section className="flex flex-col gap-2">
        <h2 className="font-display text-sm font-semibold text-fg">App name</h2>
        <p className="text-xs text-fg-muted">
          Shown across the UI, the document title and the PWA. Leave empty to fall back to the
          default.
        </p>
        <div className="flex items-center gap-2">
          <Input
            value={appName}
            placeholder="zombie-crab"
            onChange={(e) => setAppName(e.target.value)}
            disabled={savingName}
          />
          <Button
            variant="filled"
            size="sm"
            disabled={savingName}
            onClick={() => saveName(appName, false)}
          >
            <Save size={16} aria-hidden />
            Save
          </Button>
          <Button
            variant="outlined"
            size="sm"
            disabled={savingName}
            onClick={() => setPendingNameReset(true)}
          >
            <RotateCcw size={16} aria-hidden />
            Reset
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-sm font-semibold text-fg">Logos</h2>
        <p className="text-xs text-fg-muted">
          PNG, JPEG, WebP or SVG, up to ~1MB. Served as-is; the light logo also drives the PWA icon
          and favicon.
        </p>
        {variants.map((v) => (
          <div
            key={v.key}
            className="flex items-center gap-4 rounded-lg border border-brand/30 bg-elevated px-3 py-3"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/branding/logo/${v.key}?t=${bust}`}
              alt={`${v.label} preview`}
              className={preview({ tone: v.key })}
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-fg">{v.label}</p>
              <input
                ref={v.ref}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadLogo(v.key, f);
                }}
              />
            </div>
            <Button
              variant="tonal"
              size="sm"
              disabled={busy === v.key}
              onClick={() => v.ref.current?.click()}
            >
              <Upload size={16} aria-hidden />
              {busy === v.key ? "Working…" : "Upload"}
            </Button>
            <IconButton
              variant="ghost"
              size="sm"
              aria-label={`Reset ${v.label} to default`}
              title="Reset to default"
              disabled={busy === v.key}
              onClick={() => setPendingLogoReset(v.key)}
            >
              <RotateCcw size={16} aria-hidden />
            </IconButton>
          </div>
        ))}
      </section>

      <ConfirmDialog
        open={pendingNameReset}
        title="Reset app name?"
        message="The app name will fall back to the default (zombie-crab) everywhere."
        confirmLabel="Reset"
        onConfirm={() => {
          setPendingNameReset(false);
          saveName("", true);
        }}
        onCancel={() => setPendingNameReset(false)}
      />

      <ConfirmDialog
        open={pendingLogoReset !== null}
        title="Reset logo?"
        message="This logo will fall back to the bundled default."
        confirmLabel="Reset"
        onConfirm={() => pendingLogoReset && resetLogo(pendingLogoReset)}
        onCancel={() => setPendingLogoReset(null)}
      />
    </div>
  );
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const data = await res.json();
    if (typeof data?.error === "string") return data.error;
  } catch {
    // fall through to status text
  }
  if (res.status === 401) return "Your session expired. Sign in again.";
  if (res.status === 403) return "You don't have permission to edit branding.";
  return `Request failed (${res.status}).`;
}
