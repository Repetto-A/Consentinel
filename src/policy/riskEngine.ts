import { actionHash } from "../domain/narrative";
import type {
  AgentActionRequest,
  CounterpartyRouteTrust,
  DecisionSignal,
  IntentDriftResult,
  NormalizedX402Context,
  PermissionDecision,
  PermissionOutcome,
  ProjectedEffect,
  SimilarAction,
  UserTrustProfile
} from "../domain/types";
import type { GraphEvidence } from "../memory/behaviorGraph";

export interface RiskEngineInput {
  request: AgentActionRequest;
  profile: UserTrustProfile;
  graph: GraphEvidence;
  similarActions: SimilarAction[];
  projectedEffects: ProjectedEffect[];
  intentDrift: IntentDriftResult;
  normalizedX402?: NormalizedX402Context;
}

interface Thresholds {
  allow: number;
  audit: number;
  stepUp: number;
}

const thresholdsByMode: Record<UserTrustProfile["conservatism"], Thresholds> = {
  fast: { allow: 0.52, audit: 0.66, stepUp: 0.88 },
  balanced: { allow: 0.38, audit: 0.52, stepUp: 0.78 },
  paranoid: { allow: 0.24, audit: 0.36, stepUp: 0.62 }
};

export class RiskEngine {
  assess(input: RiskEngineInput): PermissionDecision {
    const { request, profile, graph, similarActions, projectedEffects, intentDrift, normalizedX402 } = input;
    const signals: DecisionSignal[] = [...graph.signals];
    const hardViolations = hardPolicyViolations(request, profile, graph, normalizedX402);
    const baseRisk = baseActionRisk(request);
    const sensitivityRisk = sensitivityRiskScore(request);
    const reversibilityRisk = reversibilityRiskScore(request);
    const amountRisk = amountRiskScore(request, profile, graph.amountMultiple);
    const contextRisk = permissionViabilityRisk(request, intentDrift);
    const vectorRisk = vectorNoveltyRisk(similarActions);
    const routeTrustRisk = routeTrustRiskScore(graph.routeTrust, graph.newRouteForKnownIdentity);
    const x402Risk = x402RiskScore(normalizedX402);
    const blastRadius = projectedEffects.length
      ? projectedEffects.reduce((sum, effect) => sum + effect.severity * effect.confidence, 0) / projectedEffects.length
      : 0.05;
    const familiarityCredit = graph.familiarityScore * 0.28;
    const trustedDeviceCredit = profile.trustedDevice ? 0.05 : 0;

    signals.push(
      weightedSignal("risk.base_action", baseRisk, 0.16, `Base risk for action=${request.action}.`),
      weightedSignal(
        "risk.sensitivity",
        sensitivityRisk,
        0.12,
        `Data sensitivity risk for ${request.dataSensitivity}.`
      ),
      weightedSignal(
        "risk.reversibility",
        reversibilityRisk,
        0.11,
        `Reversibility risk for ${request.reversibility}.`
      ),
      weightedSignal(
        "risk.amount",
        amountRisk,
        0.13,
        request.amount
          ? `Amount risk for ${request.amount.value} ${request.amount.currency}, including autonomous spend policy.`
          : "No value transfer amount was attached."
      ),
      weightedSignal(
        "risk.intent_drift",
        intentDrift.score,
        0.12,
        `${intentDrift.provider} drift evaluation: ${intentDrift.reasoning}`
      ),
      weightedSignal("risk.permission_viability", contextRisk.score, 0.16, contextRisk.rationale),
      weightedSignal(
        "risk.route_trust",
        routeTrustRisk,
        0.09,
        graph.routeTrust
          ? `Exact route trust=${graph.routeTrust}; newRouteForKnownIdentity=${graph.newRouteForKnownIdentity}.`
          : "No concrete route trust applies to this action."
      ),
      weightedSignal(
        "risk.vector_novelty",
        vectorRisk,
        0.1,
        similarActions.length
          ? `Top precedent similarity is ${similarActions[0]?.similarity.toFixed(2)}.`
          : "No prior vector precedents exist for this user."
      ),
      weightedSignal(
        "risk.projected_blast_radius",
        blastRadius,
        0.17,
        "Estimated downstream impact if this permission is granted."
      ),
      weightedSignal("credit.familiarity", graph.familiarityScore, -0.28, "Risk reduction from known graph relationships."),
      weightedSignal(
        "credit.trusted_device",
        profile.trustedDevice ? 1 : 0,
        -0.05,
        profile.trustedDevice
          ? "Risk reduction from a device already trusted by the user profile."
          : "No trusted-device credit applies to this request."
      )
    );

    if (normalizedX402) {
      signals.push(
        weightedSignal(
          "risk.x402_payment_context",
          x402Risk,
          0.05,
          `x402 ${normalizedX402.scheme} on ${normalizedX402.network}; requested/max ratio=${normalizedX402.requestedToMaximumRatio.toFixed(2)}.`
        )
      );
    }

    for (const violation of hardViolations) {
      signals.push(weightedSignal("policy.hard_violation", 1, 0.22, violation));
    }

    const rawScore =
      baseRisk * 0.16 +
      sensitivityRisk * 0.12 +
      reversibilityRisk * 0.11 +
      amountRisk * 0.13 +
      intentDrift.score * 0.12 +
      contextRisk.score * 0.16 +
      routeTrustRisk * 0.09 +
      vectorRisk * 0.1 +
      x402Risk * 0.05 +
      blastRadius * 0.17 -
      familiarityCredit -
      trustedDeviceCredit +
      hardViolations.length * 0.22;

    const riskScore = clamp(rawScore, 0, 1);
    const outcome = chooseOutcome(riskScore, profile, hardViolations);
    const requiredStepUp = outcome === "step_up" ? profile.preferredStepUp : undefined;

    return {
      requestId: request.requestId,
      outcome,
      riskScore,
      actionHash: actionHash(request),
      signals,
      similarActions,
      projectedEffects,
      requiredStepUp,
      explanation: explainOutcome(outcome, riskScore, hardViolations, request, intentDrift, normalizedX402, graph)
    };
  }
}

function chooseOutcome(
  riskScore: number,
  profile: UserTrustProfile,
  hardViolations: string[]
): PermissionOutcome {
  if (hardViolations.some((violation) => violation.startsWith("DENY:"))) return "deny";
  if (hardViolations.some((violation) => violation.startsWith("STEP_UP:"))) return "step_up";

  const thresholds = thresholdsByMode[profile.conservatism];
  if (riskScore < thresholds.allow) return "allow";
  if (riskScore < thresholds.audit) return "allow_with_audit";
  if (riskScore < thresholds.stepUp) return "step_up";
  return "deny";
}

function hardPolicyViolations(
  request: AgentActionRequest,
  profile: UserTrustProfile,
  graph: GraphEvidence,
  normalizedX402?: NormalizedX402Context
): string[] {
  const violations: string[] = [];
  const context = request.context;

  if (request.action === "share" && request.dataSensitivity === "secret") {
    violations.push("DENY: secret data cannot be shared autonomously.");
  }

  if (request.action === "delete" && request.reversibility === "irreversible") {
    violations.push("DENY: irreversible delete requires a separate recovery workflow.");
  }

  if (request.amount && request.amount.value > profile.maxAutonomousSpend.value * 4) {
    violations.push("STEP_UP: amount exceeds four times the user's autonomous spend ceiling.");
  }

  if (request.amount && graph.newCounterparty && request.amount.value > profile.maxAutonomousSpend.value) {
    violations.push("STEP_UP: new counterparty exceeds autonomous spend ceiling.");
  }

  if (graph.newRouteForKnownIdentity && isUntrustedNewRoute(graph.routeTrust)) {
    violations.push("STEP_UP: new wallet route for a known identity requires first-use verification.");
  }

  if (
    hasExpectedCounterparty(request) &&
    hasActualCounterparty(request) &&
    !counterpartyMatchesDelegation(request) &&
    context?.sourceTrust === "untrusted"
  ) {
    violations.push("STEP_UP: action diverges from the delegated recipient under untrusted context.");
  }

  if (normalizedX402 && !normalizedX402.withinConfiguredSpend) {
    violations.push("STEP_UP: x402 payment request exceeds the delegated payment envelope.");
  }

  return violations;
}

function baseActionRisk(request: AgentActionRequest): number {
  const actionRisk: Record<AgentActionRequest["action"], number> = {
    read: 0.12,
    write: 0.28,
    send: 0.42,
    pay: 0.58,
    share: 0.54,
    delete: 0.74,
    trade: 0.66,
    configure: 0.68
  };
  return actionRisk[request.action] + (request.x402 ? 0.06 : 0);
}

function sensitivityRiskScore(request: AgentActionRequest): number {
  const sensitivity: Record<AgentActionRequest["dataSensitivity"], number> = {
    public: 0.05,
    internal: 0.18,
    personal: 0.36,
    financial: 0.56,
    secret: 0.86
  };
  return sensitivity[request.dataSensitivity];
}

function reversibilityRiskScore(request: AgentActionRequest): number {
  const reversibility: Record<AgentActionRequest["reversibility"], number> = {
    reversible: 0.08,
    compensatable: 0.34,
    irreversible: 0.78
  };
  return reversibility[request.reversibility];
}

function amountRiskScore(
  request: AgentActionRequest,
  profile: UserTrustProfile,
  amountMultiple: number
): number {
  if (!request.amount) return 0.04;

  const spendRatio = request.amount.value / Math.max(profile.maxAutonomousSpend.value, 1);
  const ratioRisk = Math.min(spendRatio, 2) / 2;
  const anomalyRisk = amountMultiple > 0 ? Math.min(Math.max(amountMultiple - 1, 0) / 4, 1) : 0.24;

  return clamp(ratioRisk * 0.72 + anomalyRisk * 0.28, 0, 1);
}

function vectorNoveltyRisk(similarActions: SimilarAction[]): number {
  if (!similarActions.length) return 0.62;
  const top = similarActions[0];
  const deniedNeighborPenalty = similarActions.some((action) => action.outcome === "deny" && action.similarity > 0.72)
    ? 0.22
    : 0;
  return clamp(1 - Math.max(top.similarity, 0) + deniedNeighborPenalty, 0, 1);
}

function permissionViabilityRisk(
  request: AgentActionRequest,
  intentDrift: IntentDriftResult
): { score: number; rationale: string } {
  const context = request.context;
  if (!context) {
    return {
      score: clamp(0.18 + intentDrift.score * 0.3, 0, 1),
      rationale: `No explicit delegated-action context was supplied, so viability relies on behavior plus ${intentDrift.provider} drift scoring.`
    };
  }

  const sourceRisk: Record<NonNullable<AgentActionRequest["context"]>["sourceTrust"], number> = {
    trusted: 0.04,
    mixed: 0.34,
    untrusted: 0.72
  };

  const counterpartyMismatch =
    hasExpectedCounterparty(request) && hasActualCounterparty(request) ? (counterpartyMatchesDelegation(request) ? 0 : 1) : 0;

  const amountMismatch =
    context.expectedAmount && request.amount
      ? clamp((request.amount.value / Math.max(context.expectedAmount.value, 1) - 1) / 2, 0, 1)
      : 0;

  const score = clamp(
    sourceRisk[context.sourceTrust] * 0.3 +
      counterpartyMismatch * 0.3 +
      amountMismatch * 0.15 +
      intentDrift.score * 0.25,
    0,
    1
  );

  const rationale = [
    `Source=${context.source} trust=${context.sourceTrust}.`,
    counterpartyMismatch
      ? `Requested counterparty ${request.counterparty ?? "none"} differs from the delegated recipient or identity.`
      : "Requested counterparty matches delegated expectations, including known identity aliases when present.",
    context.expectedAmount && request.amount
      ? `Requested amount is ${request.amount.value} vs expected ${context.expectedAmount.value}.`
      : "No explicit expected amount was supplied.",
    `${intentDrift.provider} drift score=${intentDrift.score.toFixed(2)} confidence=${intentDrift.confidence.toFixed(2)}.`
  ].join(" ");

  return { score, rationale };
}

function x402RiskScore(normalizedX402?: NormalizedX402Context): number {
  if (!normalizedX402) return 0;

  const spendRisk = normalizedX402.withinConfiguredSpend
    ? clamp(normalizedX402.requestedToMaximumRatio * 0.42, 0, 0.42)
    : 0.86;
  const networkRisk = normalizedX402.network === "any" ? 0.12 : 0.04;
  const schemeRisk = normalizedX402.scheme === "any" ? 0.08 : 0.03;

  return clamp(spendRisk + networkRisk + schemeRisk, 0, 1);
}

function routeTrustRiskScore(
  routeTrust: CounterpartyRouteTrust | undefined,
  newRouteForKnownIdentity: boolean
): number {
  if (!routeTrust) return 0;

  switch (routeTrust) {
    case "verified":
      return 0.04;
    case "known_historical":
      return 0.14;
    case "claimed":
      return newRouteForKnownIdentity ? 0.82 : 0.66;
    case "unknown":
      return newRouteForKnownIdentity ? 0.88 : 0.72;
  }
}

function explainOutcome(
  outcome: PermissionOutcome,
  riskScore: number,
  violations: string[],
  request: AgentActionRequest,
  intentDrift: IntentDriftResult,
  normalizedX402?: NormalizedX402Context,
  graph?: GraphEvidence
): string {
  const driftText = `${intentDrift.provider} drift=${intentDrift.score.toFixed(2)} confidence=${intentDrift.confidence.toFixed(2)}.`;
  const x402Text = normalizedX402
    ? ` x402 ratio=${normalizedX402.requestedToMaximumRatio.toFixed(2)} network=${normalizedX402.network} scheme=${normalizedX402.scheme}.`
    : "";
  const routeText = graph?.routeTrust
    ? ` routeTrust=${graph.routeTrust} newRouteForKnownIdentity=${graph.newRouteForKnownIdentity}.`
    : "";

  if (outcome === "deny") {
    return `Denied ${request.action} on ${request.service}: ${violations.join(" ") || "risk exceeded deny threshold."} ${driftText}${routeText}${x402Text}`.trim();
  }

  if (outcome === "step_up") {
    return `Step-up required before ${request.action} on ${request.service}; risk=${riskScore.toFixed(2)} and action must be verified out-of-band. ${driftText}${routeText}${x402Text}`.trim();
  }

  if (outcome === "allow_with_audit") {
    return `Allowed with audit because risk=${riskScore.toFixed(2)} is moderate but within policy. ${driftText}${routeText}${x402Text}`.trim();
  }

  return `Allowed autonomously because risk=${riskScore.toFixed(2)} is low for this user's track record. ${driftText}${routeText}${x402Text}`.trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalize(input: string): string {
  return input.trim().toLowerCase();
}

function hasExpectedCounterparty(request: AgentActionRequest): boolean {
  return Boolean(request.context?.expectedCounterpartyIdentity || request.context?.expectedCounterparty);
}

function hasActualCounterparty(request: AgentActionRequest): boolean {
  return Boolean(request.counterpartyIdentity || request.counterparty);
}

function counterpartyMatchesDelegation(request: AgentActionRequest): boolean {
  if (request.context?.expectedCounterpartyIdentity && request.counterpartyIdentity) {
    return normalize(request.context.expectedCounterpartyIdentity) === normalize(request.counterpartyIdentity);
  }

  if (request.context?.expectedCounterparty && request.counterparty) {
    return normalize(request.context.expectedCounterparty) === normalize(request.counterparty);
  }

  return false;
}

function weightedSignal(name: string, score: number, weight: number, rationale: string): DecisionSignal {
  return {
    name,
    score,
    weight,
    contribution: score * weight,
    rationale
  };
}

function isUntrustedNewRoute(routeTrust: CounterpartyRouteTrust | undefined): boolean {
  return routeTrust === "claimed" || routeTrust === "unknown";
}
