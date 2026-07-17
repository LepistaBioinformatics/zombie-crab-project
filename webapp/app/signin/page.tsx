"use client";

import { useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import Logo from "@/app/logo";
import BrandName from "@/app/brand-name";
import { Surface } from "@/components/ui/surface";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

type Step = "email" | "code";

export default function SignInPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmitEmail(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        setError("Could not reach the gateway. Is the stack running?");
        return;
      }
      setStep("code");
    } finally {
      setSubmitting(false);
    }
  }

  async function onSubmitCode(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code }),
      });
      if (res.status === 401) {
        setError("Invalid code. Try again.");
        return;
      }
      if (!res.ok) {
        setError("Could not reach the gateway. Is the stack running?");
        return;
      }
      router.push("/chat");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg">
      <Surface bordered shadow="signature" className="w-[380px] p-8">
        <div className="flex flex-col gap-6">
          <div className="flex items-center gap-3">
            <Logo size={44} />
            <div>
              <h1 className="font-display text-xl font-semibold text-fg">
                <BrandName /> chat
              </h1>
              <p className="text-sm text-fg-muted">
                Sign in with your email -- no password needed.
              </p>
            </div>
          </div>

          {error && <Alert severity="error">{error}</Alert>}

          {step === "email" && (
            <form onSubmit={onSubmitEmail}>
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="email" className="text-sm text-fg-muted">
                    Email
                  </label>
                  <Input
                    id="email"
                    type="email"
                    autoFocus
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
                <Button type="submit" variant="filled" shadow="signature" disabled={submitting}>
                  {submitting ? "Sending..." : "Send magic link"}
                </Button>
              </div>
            </form>
          )}

          {step === "code" && (
            <form onSubmit={onSubmitCode}>
              <div className="flex flex-col gap-4">
                <p className="text-sm text-fg">
                  Check <strong>{email}</strong> for a link, open it, and enter the 6-digit code
                  it shows.
                </p>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="code" className="text-sm text-fg-muted">
                    Code
                  </label>
                  <Input
                    id="code"
                    inputMode="numeric"
                    autoFocus
                    required
                    maxLength={6}
                    pattern="[0-9]{6}"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </div>
                <Button type="submit" variant="filled" shadow="signature" disabled={submitting}>
                  {submitting ? "Verifying..." : "Verify"}
                </Button>
                <Button
                  type="button"
                  variant="text"
                  onClick={() => {
                    setStep("email");
                    setError(null);
                    setCode("");
                  }}
                >
                  Back
                </Button>
              </div>
            </form>
          )}
        </div>
      </Surface>
    </div>
  );
}
