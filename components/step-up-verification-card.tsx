"use client";

import { useEffect, useState } from "react";
import type { StepUpChallengeView } from "@/lib/step-up/challenge-view";
import { cn } from "@/lib/utils";

interface StepUpVerificationCardProps {
  initialChallenge: StepUpChallengeView;
}

export function StepUpVerificationCard({ initialChallenge }: StepUpVerificationCardProps) {
  const [challenge, setChallenge] = useState(initialChallenge);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"verify" | "reject" | null>(null);
  const [resumedStatus, setResumedStatus] = useState<string | null>(null);

  useEffect(() => {
    if (challenge.isTerminal) return;

    const interval = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/step-up/verify/${encodeURIComponent(challenge.handoffCode)}`, {
          cache: "no-store"
        });
        if (!response.ok) return;
        const data = (await response.json()) as { challenge?: StepUpChallengeView };
        if (data.challenge) {
          setChallenge(data.challenge);
        }
      } catch {
        // Keep the current UI state; user can still retry manually.
      }
    }, 3000);

    return () => window.clearInterval(interval);
  }, [challenge.handoffCode, challenge.isTerminal]);

  async function refreshChallenge() {
    const refreshRes = await fetch(`/api/step-up/verify/${encodeURIComponent(challenge.handoffCode)}`, {
      cache: "no-store"
    });
    if (refreshRes.ok) {
      const data = (await refreshRes.json()) as { challenge?: StepUpChallengeView };
      if (data.challenge) {
        setChallenge(data.challenge);
      }
    }
  }

  async function handleVerify() {
    setBusy("verify");
    setError(null);

    try {
      const res = await fetch("/api/step-up/passkey/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId: challenge.challengeId })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "no se pudo aprobar el permiso");
      }

      const finished = (await res.json()) as {
        resumed?: { status?: string };
      };
      setResumedStatus(finished.resumed?.status ?? null);
      await refreshChallenge();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleReject() {
    setBusy("reject");
    setError(null);

    try {
      const res = await fetch("/api/step-up/passkey/reject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId: challenge.challengeId })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "no se pudo rechazar el permiso");
      }

      await refreshChallenge();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const isActionable = !challenge.isTerminal;

  return (
    <div className="w-full max-w-2xl rounded-3xl border border-border bg-surface p-6 shadow-[0_24px_80px_rgba(0,0,0,0.35)]">
      <div className="flex flex-wrap items-center gap-3">
        <span className="rounded-full border border-border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-muted">
          step-up
        </span>
        <span className="rounded-full border border-border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-text">
          {challenge.handoffCode}
        </span>
        <span className={cn("rounded-full px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em]", statusBadge(challenge.status))}>
          {statusLabel(challenge.status)}
        </span>
      </div>

      <div className="mt-6 space-y-3">
        <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-muted">
          operación a validar
        </p>
        <h1 className="text-2xl font-medium text-text">
          {challenge.spokenOperationSummary}
        </h1>
        {challenge.spokenRiskHint ? (
          <p className="rounded-2xl border border-stepup/40 bg-stepup/10 px-4 py-3 text-sm text-stepup">
            {challenge.spokenRiskHint}
          </p>
        ) : null}
        <p className="text-sm text-muted">
          Ya te identificaste con passkey al entrar. Aprobá si reconocés esta operación, o rechazala si no fuiste vos.
        </p>
      </div>

      <div className="mt-6 rounded-2xl border border-border bg-bg/60 p-4">
        {isActionable ? (
          <div className="flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              onClick={handleVerify}
              disabled={busy !== null}
              className="rounded-md border border-allow bg-allow/10 px-4 py-2 font-mono text-sm text-allow transition hover:bg-allow/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "verify" ? "aprobando…" : "Aceptar"}
            </button>
            <button
              type="button"
              onClick={handleReject}
              disabled={busy !== null}
              className="rounded-md border border-deny bg-deny/10 px-4 py-2 font-mono text-sm text-deny transition hover:bg-deny/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "reject" ? "rechazando…" : "Rechazar"}
            </button>
          </div>
        ) : null}

        {challenge.status === "completed" ? (
          <div className="space-y-2 text-allow">
            <p className="text-sm">La operación quedó validada y el kernel ya reanudó el flujo protegido.</p>
            {resumedStatus ? (
              <p className="font-mono text-xs uppercase tracking-[0.18em] text-allow/80">
                resultado reanudado · {resumedStatus}
              </p>
            ) : null}
          </div>
        ) : null}

        {challenge.status === "rejected" ? (
          <p className="text-sm text-deny">
            Esta validación fue rechazada. El permiso quedó bloqueado y no puede completarse desde este enlace.
          </p>
        ) : null}

        {challenge.status === "expired" ? (
          <p className="text-sm text-deny">
            Este challenge expiró. Si la operación sigue siendo válida, el agente tiene que generar uno nuevo.
          </p>
        ) : null}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3 text-xs text-muted">
        <span>Vence: {formatExpiry(challenge.expiresAt)}</span>
      </div>

      {error ? (
        <p className="mt-4 rounded-2xl border border-deny/30 bg-deny/10 px-4 py-3 text-sm text-deny">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function statusLabel(status: StepUpChallengeView["status"]) {
  switch (status) {
    case "pending":
      return "esperando confirmación";
    case "phone_confirmed":
      return "esperando passkey";
    case "completed":
      return "completado";
    case "rejected":
      return "rechazado";
    case "expired":
      return "expirado";
    case "verified":
      return "verificado";
    default:
      return status;
  }
}

function statusBadge(status: StepUpChallengeView["status"]) {
  switch (status) {
    case "pending":
    case "phone_confirmed":
      return "border border-stepup/40 bg-stepup/10 text-stepup";
    case "completed":
    case "verified":
      return "border border-allow/40 bg-allow/10 text-allow";
    case "rejected":
    case "expired":
      return "border border-deny/40 bg-deny/10 text-deny";
    default:
      return "border border-border bg-surface text-text";
  }
}

function formatExpiry(expiresAt: string) {
  const date = new Date(expiresAt);
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}
