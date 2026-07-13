"use client";

import { useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import Logo from "@/app/logo";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";
import Stack from "@mui/material/Stack";
import { signatureShadow, signatureShadowSx } from "@/lib/theme";

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
    <Box
      display="flex"
      minHeight="100vh"
      alignItems="center"
      justifyContent="center"
      bgcolor="background.default"
    >
      <Paper variant="outlined" sx={{ p: 4, width: 380, boxShadow: signatureShadow }}>
        <Stack spacing={3}>
          <Stack direction="row" spacing={1.5} alignItems="center">
            <Logo size={44} />
            <Box>
              <Typography variant="h5" fontWeight={600}>
                zombie-crab chat
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Sign in with your email -- no password needed.
              </Typography>
            </Box>
          </Stack>

          {error && <Alert severity="error">{error}</Alert>}

          {step === "email" && (
            <Box component="form" onSubmit={onSubmitEmail}>
              <Stack spacing={2}>
                <TextField
                  label="Email"
                  type="email"
                  autoFocus
                  required
                  fullWidth
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <Button type="submit" variant="contained" disabled={submitting} sx={signatureShadowSx}>
                  {submitting ? "Sending..." : "Send magic link"}
                </Button>
              </Stack>
            </Box>
          )}

          {step === "code" && (
            <Box component="form" onSubmit={onSubmitCode}>
              <Stack spacing={2}>
                <Typography variant="body2">
                  Check <strong>{email}</strong> for a link, open it, and enter the 6-digit code
                  it shows.
                </Typography>
                <TextField
                  label="Code"
                  inputMode="numeric"
                  autoFocus
                  required
                  fullWidth
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  slotProps={{ htmlInput: { maxLength: 6, pattern: "[0-9]{6}" } }}
                />
                <Button type="submit" variant="contained" disabled={submitting} sx={signatureShadowSx}>
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
              </Stack>
            </Box>
          )}
        </Stack>
      </Paper>
    </Box>
  );
}
