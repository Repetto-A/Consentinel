import assert from "node:assert/strict";
import test from "node:test";
import { PermissionKernel } from "../kernel.js";
import { demoKnownCounterparty, demoProfile, demoUnknownCounterparty, seedEvents } from "../demoFixtures.js";
import type { AgentActionRequest } from "../domain/types.js";
function seededKernel(): PermissionKernel {
  const kernel = new PermissionKernel(demoProfile);
  for (const event of seedEvents) {
    kernel.record(event);
  }
  return kernel;
}

test("an aligned delegated transfer is lower risk than a recipient swap from untrusted context", () => {
  const kernel = seededKernel();
  const known: AgentActionRequest = {
    requestId: "known",
    userId: "user_alba",
    agentId: "finance_agent",
    service: "wallet",
    action: "pay",
    resource: "usdc_transfer",
    intent: "Send 20 USDC to Juan for dinner.",
    counterparty: demoKnownCounterparty,
    amount: { value: 20, currency: "USDC" },
    dataSensitivity: "financial",
    reversibility: "compensatable",
    context: {
      source: "direct_user",
      sourceTrust: "trusted",
      originalUserRequest: "Send 20 USDC to Juan for dinner.",
      expectedCounterparty: demoKnownCounterparty,
      expectedAmount: { value: 20, currency: "USDC" }
    }
  };
  const novel: AgentActionRequest = {
    ...known,
    requestId: "novel",
    intent: "Send 20 USDC to Juan using the wallet address from the latest email.",
    counterparty: demoUnknownCounterparty,
    context: {
      source: "email",
      sourceTrust: "untrusted",
      originalUserRequest: "Send 20 USDC to Juan for dinner.",
      expectedCounterparty: demoKnownCounterparty,
      expectedAmount: { value: 20, currency: "USDC" }
    }
  };

  const knownDecision = kernel.assess(known);
  const novelDecision = kernel.assess(novel);

  assert.ok(knownDecision.riskScore < novelDecision.riskScore);
  assert.equal(novelDecision.outcome, "step_up");
  assert.ok(novelDecision.signals.some((signal) => signal.name === "risk.permission_viability"));
  assert.ok(novelDecision.signals.every((signal) => Number.isFinite(signal.weight)));
  assert.ok(novelDecision.signals.every((signal) => Number.isFinite(signal.contribution)));
});

test("a large amount spike requires step-up even when the recipient is familiar", () => {
  const kernel = seededKernel();
  const request: AgentActionRequest = {
    requestId: "amount_spike",
    userId: "user_alba",
    agentId: "finance_agent",
    service: "wallet",
    action: "pay",
    resource: "usdc_transfer",
    intent: "Send 350 USDC to Juan because the dinner total changed in a follow-up chat.",
    counterparty: demoKnownCounterparty,
    amount: { value: 350, currency: "USDC" },
    dataSensitivity: "financial",
    reversibility: "irreversible",
    context: {
      source: "chat",
      sourceTrust: "mixed",
      originalUserRequest: "Send 20 USDC to Juan for dinner.",
      expectedCounterparty: demoKnownCounterparty,
      expectedAmount: { value: 20, currency: "USDC" }
    }
  };

  const decision = kernel.assess(request);

  assert.equal(decision.outcome, "step_up");
  assert.ok(decision.signals.some((signal) => signal.name === "policy.hard_violation"));
});

test("step-up challenge is bound to the action hash", () => {
  const kernel = seededKernel();
  const request: AgentActionRequest = {
    requestId: "step_up",
    userId: "user_alba",
    agentId: "finance_agent",
    service: "wallet",
    action: "pay",
    resource: "usdc_transfer",
    intent: "Send 20 USDC to Juan using the wallet address from the latest email.",
    counterparty: demoUnknownCounterparty,
    amount: { value: 20, currency: "USDC" },
    dataSensitivity: "financial",
    reversibility: "compensatable",
    context: {
      source: "email",
      sourceTrust: "untrusted",
      originalUserRequest: "Send 20 USDC to Juan for dinner.",
      expectedCounterparty: demoKnownCounterparty,
      expectedAmount: { value: 20, currency: "USDC" }
    }
  };

  const decision = kernel.assess(request);
  assert.equal(decision.outcome, "step_up");

  const challenge = kernel.createStepUpChallenge(request, decision, new Date("2026-05-09T12:00:00.000Z"));
  assert.equal(challenge.boundActionHash, decision.actionHash);
  assert.equal(challenge.channel, "passkey");
});

test("decision signals expose weights and contributions consistent with the computed score", () => {
  const kernel = seededKernel();
  const request: AgentActionRequest = {
    requestId: "signal_weights",
    userId: "user_alba",
    agentId: "finance_agent",
    service: "wallet",
    action: "pay",
    resource: "usdc_transfer",
    intent: "Send 20 USDC to Juan for dinner.",
    counterparty: demoKnownCounterparty,
    amount: { value: 20, currency: "USDC" },
    dataSensitivity: "financial",
    reversibility: "compensatable",
    context: {
      source: "direct_user",
      sourceTrust: "trusted",
      originalUserRequest: "Send 20 USDC to Juan for dinner.",
      expectedCounterparty: demoKnownCounterparty,
      expectedAmount: { value: 20, currency: "USDC" }
    }
  };

  const decision = kernel.assess(request);
  const totalContribution = decision.signals.reduce((sum, signal) => sum + signal.contribution, 0);

  assert.ok(decision.signals.some((signal) => signal.name === "credit.trusted_device"));
  assert.ok(decision.signals.some((signal) => signal.name === "credit.familiarity" && signal.weight < 0));
  assert.ok(Math.abs(totalContribution - decision.riskScore) < 0.000001);
});
