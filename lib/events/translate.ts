import { biometricCopy, detectBiometricMethod } from "@/lib/auth/device";
import type { KernelStreamEvent } from "./types";

export type ActivityStatus =
  | "thinking"
  | "approved"
  | "blocked"
  // Single step-up status. The actual auth method (FaceID, TouchID, huella)
  // is decided client-side by detectBiometricMethod() and surfaced in
  // statusLabel/actionPrompt at translate time.
  | "needs_biometric";

export type TechLineKind =
  | "request"
  | "trace"
  | "decision"
  | "step_up_created"
  | "step_up_verified"
  | "step_up_phone_confirmed"
  | "step_up_rejected"
  | "step_up_canceled"
  | "wallet_prepared"
  | "wallet_executed"
  | "error";

export interface TechnicalLine {
  ts: number;
  kind: TechLineKind;
  text: string;
}

export interface TranslatedRequest {
  requestId: string;
  startedAt: number;
  // What the assistant is trying to do, in plain language.
  headline: string;
  subline?: string;
  // Kernel narrating its reasoning, in casual first-person.
  reasoning: string[];
  status: ActivityStatus;
  statusLabel: string;
  // CTA copy for step-up scenarios.
  actionPrompt?: string;
  // Set when the kernel asked for a passkey step-up that hasn't been
  // verified yet. The PendingCard uses this to drive WebAuthn.
  passkeyChallengeId?: string;
  // Raw events translated to dev-mode lines (for the per-card expand).
  technicalLines: TechnicalLine[];
}

type RequestStartedEvent = Extract<KernelStreamEvent, { type: "permission.request_started" }>;
type TraceEvent = Extract<KernelStreamEvent, { type: "permission.trace_event" }>;
type DecisionEvent = Extract<KernelStreamEvent, { type: "permission.decision_made" }>;
type StepUpChallengeEvent = Extract<KernelStreamEvent, { type: "step_up.challenge_created" }>;
type StepUpVerifiedEvent = Extract<KernelStreamEvent, { type: "step_up.verified" }>;
type StepUpCanceledEvent = Extract<KernelStreamEvent, { type: "step_up.canceled" }>;
type WalletExecutedEvent = Extract<KernelStreamEvent, { type: "wallet.transfer_mock_executed" }>;
type RuntimeErrorEvent = Extract<KernelStreamEvent, { type: "runtime.error" }>;

interface ScenarioCopy {
  headline: (req: RequestStartedEvent) => string;
  subline?: (req: RequestStartedEvent) => string | undefined;
  // One reasoning line per trace event, in order. If the kernel emits
  // more trace events than copy lines, the rest fall through to using
  // the trace event's `summary` field directly.
  evidenceCopy: string[];
}

// Hand-crafted copy for the known demo requestIds (matches src/demoFixtures.ts).
// Anything outside this map falls back to the generic translator below.
// Voice: kernel ("yo, Consentinel") talking ABOUT the agent ("tu asistente"),
// rioplatense casual first-person.
const SCENARIO_COPY: Record<string, ScenarioCopy> = {
  req_demo_aligned_transfer: {
    headline: () => "Tu asistente quiere mandarle 20 USDC a Juan",
    subline: () => '"for dinner"',
    evidenceCopy: [
      "Lo conozco — le mandaste varias veces esta semana.",
      "Y me lo pediste vos directo, no vino de un mail.",
    ],
  },
  req_demo_recipient_swap: {
    headline: () => "Tu asistente quiere mandarle 20 USDC a una wallet nueva",
    subline: () => "(la pista vino de un mail que recibió)",
    evidenceCopy: [
      "Esa wallet no la vi nunca — nunca le mandaste nada.",
      "El monto coincide con lo que pediste, pero el destinatario cambió en el camino. Puede ser phishing.",
    ],
  },
  req_demo_amount_spike: {
    headline: () => "Tu asistente quiere mandarle 350 USDC a Juan",
    subline: () => "(después de un follow-up que cambió el total)",
    evidenceCopy: [
      "Algo no me cierra — a Juan le mandás 20 USDC por vez como mucho, esto es 17 veces más.",
      "Y tu política dice que no apruebo solo arriba de 75 USD.",
    ],
  },
  req_demo_claimed_new_wallet: {
    headline: () => "Tu asistente quiere mandarle 20 USDC a Juan, a una wallet nueva",
    subline: () => "(dice que es de él)",
    evidenceCopy: [
      "El destinatario dice ser Juan pero la wallet es nueva — nunca le mandaste plata ahí.",
      "El monto coincide con lo habitual, así que no es spike. La pista vino de él directo.",
    ],
  },
};

export function groupByRequest(
  events: KernelStreamEvent[]
): Map<string, KernelStreamEvent[]> {
  const groups = new Map<string, KernelStreamEvent[]>();
  for (const event of events) {
    if (event.type === "ping") continue;
    // runtime.error events without a requestId can't be attached to a card.
    const requestId = "requestId" in event ? event.requestId : undefined;
    if (!requestId) continue;
    const list = groups.get(requestId) ?? [];
    list.push(event);
    groups.set(requestId, list);
  }
  return groups;
}

export function translateRequest(
  events: KernelStreamEvent[]
): TranslatedRequest | null {
  const requestEvent = events.find(
    (e): e is RequestStartedEvent => e.type === "permission.request_started"
  );
  if (!requestEvent) return null;

  const decisionEvent = events.find(
    (e): e is DecisionEvent => e.type === "permission.decision_made"
  );
  const walletExecuted = events.find(
    (e): e is WalletExecutedEvent => e.type === "wallet.transfer_mock_executed"
  );
  const stepUpVerified = events.find(
    (e): e is StepUpVerifiedEvent => e.type === "step_up.verified"
  );
  const stepUpCanceled = events.find(
    (e): e is StepUpCanceledEvent => e.type === "step_up.canceled"
  );
  const runtimeError = events.find(
    (e): e is RuntimeErrorEvent => e.type === "runtime.error"
  );

  const copy = SCENARIO_COPY[requestEvent.requestId];

  const headline = copy?.headline(requestEvent) ?? genericHeadline(requestEvent);
  const subline = copy?.subline?.(requestEvent);

  // Build reasoning from trace events. Use scenario copy for the first N,
  // fall back to the trace's `summary` field for the rest.
  const traceEvents = events.filter(
    (e): e is TraceEvent => e.type === "permission.trace_event"
  );
  const reasoning: string[] = [];
  for (let i = 0; i < traceEvents.length; i++) {
    const scenarioLine = copy?.evidenceCopy[i];
    reasoning.push(scenarioLine ?? traceEvents[i].summary);
  }

  // Most recent passkey challenge (if any). We only expose it while
  // the user still needs to act — once step_up.verified arrives, we
  // stop offering the button.
  const passkeyChallenge = [...events]
    .reverse()
    .find(
      (e): e is StepUpChallengeEvent =>
        e.type === "step_up.challenge_created" && e.channel === "passkey"
    );

  // Status — runtime errors win, then wallet executed, then decision.
  // step_up.verified collapses needs_biometric back into thinking until
  // the wallet event arrives.
  let status: ActivityStatus = "thinking";
  let statusLabel = "Pensando…";
  let actionPrompt: string | undefined;
  let passkeyChallengeId: string | undefined;

  if (runtimeError) {
    status = "blocked";
    statusLabel = "Algo falló";
  } else if (walletExecuted) {
    status = "approved";
    statusLabel = "Aprobado";
  } else if (decisionEvent) {
    if (
      decisionEvent.outcome === "allow" ||
      decisionEvent.outcome === "allow_with_audit"
    ) {
      status = "approved";
      statusLabel = "Aprobado";
    } else if (decisionEvent.outcome === "deny") {
      status = "blocked";
      statusLabel = "Bloqueado";
    } else if (decisionEvent.outcome === "step_up") {
      if (stepUpCanceled) {
        // User explicitly rejected. Final state.
        status = "blocked";
        statusLabel = "Rechazado por vos";
      } else if (stepUpVerified) {
        // User already confirmed; we're back to thinking until wallet executes.
        status = "thinking";
        statusLabel = "Confirmaste — procesando…";
      } else {
        status = "needs_biometric";
        const method = detectBiometricMethod();
        const bio = biometricCopy(method);
        statusLabel = bio.status;
        actionPrompt = bio.action;
        if (passkeyChallenge) {
          passkeyChallengeId = passkeyChallenge.challengeId;
        }
      }
    }
  }

  const technicalLines = events
    .filter(
      (e): e is Exclude<KernelStreamEvent, { type: "ping" }> => e.type !== "ping"
    )
    .map(translateToTechLine);

  return {
    requestId: requestEvent.requestId,
    startedAt: requestEvent.ts,
    headline,
    subline,
    reasoning,
    status,
    statusLabel,
    actionPrompt,
    passkeyChallengeId,
    technicalLines,
  };
}

export function translateAll(events: KernelStreamEvent[]): TranslatedRequest[] {
  const groups = groupByRequest(events);
  const translated: TranslatedRequest[] = [];
  for (const [, group] of groups) {
    const t = translateRequest(group);
    if (t) translated.push(t);
  }
  // Newest first — the eye lands on the most recent action.
  translated.sort((a, b) => b.startedAt - a.startedAt);
  return translated;
}

// ---------- generic fallbacks ----------

function genericHeadline(req: RequestStartedEvent): string {
  const intent = req.intent.replace(/\.$/, "");
  return `Tu asistente quiere ${intent.toLowerCase()}`;
}

function translateToTechLine(
  e: Exclude<KernelStreamEvent, { type: "ping" }>
): TechnicalLine {
  switch (e.type) {
    case "permission.request_started":
      return {
        ts: e.ts,
        kind: "request",
        text: `REQUEST ${e.agentId} ${e.action} ${e.service} — ${e.intent}`,
      };
    case "permission.trace_event":
      return {
        ts: e.ts,
        kind: "trace",
        text: `${e.eventType}: ${e.summary}`,
      };
    case "permission.decision_made":
      return {
        ts: e.ts,
        kind: "decision",
        text: `${e.outcome.toUpperCase()} risk=${e.riskScore.toFixed(2)} ${e.explanation}`,
      };
    case "step_up.challenge_created":
      return {
        ts: e.ts,
        kind: "step_up_created",
        text: `STEP-UP requested via ${e.channel} (id=${e.challengeId.slice(0, 8)}…)`,
      };
    case "step_up.verified":
      return {
        ts: e.ts,
        kind: "step_up_verified",
        text: `STEP-UP verified via ${e.channel}${
          e.verifiedByUsername ? ` by ${e.verifiedByUsername}` : ""
        }`,
      };
    case "step_up.phone_confirmed":
      return {
        ts: e.ts,
        kind: "step_up_phone_confirmed",
        text: `STEP-UP phone confirmed via ${e.channel} (${e.provider})`,
      };
    case "step_up.rejected":
      return {
        ts: e.ts,
        kind: "step_up_rejected",
        text: `STEP-UP rejected via ${e.channel} — ${e.reason}`,
      };
    case "step_up.canceled":
      return {
        ts: e.ts,
        kind: "step_up_canceled",
        text: `STEP-UP canceled via ${e.channel}${
          e.canceledByUsername ? ` by ${e.canceledByUsername}` : ""
        }`,
      };
    case "wallet.transfer_prepared":
      return {
        ts: e.ts,
        kind: "wallet_prepared",
        text: `WALLET prepared: ${e.amount} ${e.asset} → ${e.to.slice(0, 10)}…`,
      };
    case "wallet.transfer_mock_executed":
      return {
        ts: e.ts,
        kind: "wallet_executed",
        text: `WALLET executed: ${e.amount} ${e.asset} → ${e.to.slice(
          0,
          10
        )}… (tx ${e.txHash.slice(0, 10)}…)`,
      };
    case "runtime.error":
      return {
        ts: e.ts,
        kind: "error",
        text: `ERROR: ${e.message}`,
      };
    default: {
      const _exhaustive: never = e;
      return _exhaustive;
    }
  }
}

export function formatRelativeTime(then: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - then);
  const s = Math.round(diff / 1000);
  if (s < 5) return "ahora";
  if (s < 60) return `hace ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h}h`;
  return new Date(then).toLocaleDateString();
}

export function formatTechLine(line: TechnicalLine): string {
  const ts = new Date(line.ts).toTimeString().slice(0, 8);
  return `[${ts}] ${line.text}`;
}
