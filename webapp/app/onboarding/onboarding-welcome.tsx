"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Logo from "@/app/logo";
import { Surface } from "@/components/ui/surface";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

export default function OnboardingWelcome({ email }: { email: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onStart() {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/onboarding", { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(
          data?.error === "connectivity"
            ? "Não foi possível falar com o gateway. O sistema está no ar?"
            : data?.error || "Algo deu errado ao criar a sua conta. Tente novamente.",
        );
        return;
      }
      router.push("/chat");
    } catch {
      setError("Algo deu errado ao criar a sua conta. Tente novamente.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-4">
      <Surface bordered shadow="signature" className="w-[440px] max-w-full p-8">
        <div className="flex flex-col gap-6">
          <div className="flex items-center gap-3">
            <Logo size={44} />
            <div>
              <h1 className="font-display text-xl font-semibold text-fg">
                Bem-vindo ao zombie-crab
              </h1>
              <p className="text-sm text-fg-muted">{email}</p>
            </div>
          </div>

          <div className="flex flex-col gap-3 text-sm leading-relaxed text-fg">
            <p>
              Estamos quase lá. Ao clicar em <strong>Vamos começar</strong>, a sua
              conta será criada e você entrará no aplicativo.
            </p>
            <p className="text-fg-muted">
              Uma dica sobre o que vem a seguir: os seus workspaces e agentes só
              aparecem depois que um administrador convidar você para um deles. Até
              lá, é normal ver a lista vazia — não é um erro.
            </p>
          </div>

          {error && <Alert severity="error">{error}</Alert>}

          <Button
            type="button"
            variant="filled"
            shadow="signature"
            disabled={submitting}
            onClick={onStart}
          >
            {submitting ? "Criando a sua conta..." : "Vamos começar"}
          </Button>
        </div>
      </Surface>
    </div>
  );
}
