import type { AgentActionRequest, TrackRecordEvent, UserTrustProfile } from "./domain/types";
import { x402ContextFromEndpoint } from "./payments/x402";

export const demoKnownCounterparty = "0x9f2c4a6b8d0e1f2233445566778899aabbccddee";
export const demoUnknownCounterparty = "0x4a8b1c2d3e4f5061728394a5b6c7d8e9f0011223";
export const demoClaimedNewRoute = "0x7d31c4b5a697887766554433221100ffeeddccbb";

export const demoProfile: UserTrustProfile = {
  userId: "user_alba",
  conservatism: "balanced",
  trustedDevice: true,
  maxAutonomousSpend: { value: 75, currency: "USD" },
  preferredStepUp: "passkey",
  phoneE164: "+12015348061"
};

export const seedEvents: TrackRecordEvent[] = [
  event("evt_001", "2026-05-01T10:15:00.000Z", {
    requestId: "req_seed_001",
    userId: "user_alba",
    agentId: "finance_agent",
    service: "wallet",
    action: "pay",
    resource: "usdc_transfer",
    intent: "Send 20 USDC to Juan for dinner.",
    counterparty: demoKnownCounterparty,
    counterpartyIdentity: "juan",
    counterpartyRouteTrust: "known_historical",
    amount: { value: 20, currency: "USDC" },
    dataSensitivity: "financial",
    reversibility: "compensatable",
    context: {
      source: "direct_user",
      sourceTrust: "trusted",
      originalUserRequest: "Send 20 USDC to Juan for dinner.",
      expectedCounterparty: demoKnownCounterparty,
      expectedCounterpartyIdentity: "juan",
      expectedCounterpartyRouteTrust: "known_historical",
      expectedAmount: { value: 20, currency: "USDC" }
    }
  }),
  event("evt_002", "2026-05-02T15:30:00.000Z", {
    requestId: "req_seed_002",
    userId: "user_alba",
    agentId: "finance_agent",
    service: "wallet",
    action: "pay",
    resource: "usdc_transfer",
    intent: "Send 20 USDC to Juan for dinner.",
    counterparty: demoKnownCounterparty,
    counterpartyIdentity: "juan",
    counterpartyRouteTrust: "known_historical",
    amount: { value: 20, currency: "USDC" },
    dataSensitivity: "financial",
    reversibility: "compensatable",
    context: {
      source: "direct_user",
      sourceTrust: "trusted",
      originalUserRequest: "Send 20 USDC to Juan for dinner.",
      expectedCounterparty: demoKnownCounterparty,
      expectedCounterpartyIdentity: "juan",
      expectedCounterpartyRouteTrust: "known_historical",
      expectedAmount: { value: 20, currency: "USDC" }
    }
  }),
  event("evt_003", "2026-05-03T15:30:00.000Z", {
    requestId: "req_seed_003",
    userId: "user_alba",
    agentId: "finance_agent",
    service: "wallet",
    action: "pay",
    resource: "usdc_transfer",
    intent: "Send 18 USDC to Juan for dinner after splitting the tip.",
    counterparty: demoKnownCounterparty,
    counterpartyIdentity: "juan",
    counterpartyRouteTrust: "known_historical",
    amount: { value: 18, currency: "USDC" },
    dataSensitivity: "financial",
    reversibility: "compensatable",
    context: {
      source: "direct_user",
      sourceTrust: "trusted",
      originalUserRequest: "Send Juan the dinner split.",
      expectedCounterparty: demoKnownCounterparty,
      expectedCounterpartyIdentity: "juan",
      expectedCounterpartyRouteTrust: "known_historical",
      expectedAmount: { value: 20, currency: "USDC" }
    }
  })
];

export const demoRequests: AgentActionRequest[] = [
  {
    requestId: "req_demo_aligned_transfer",
    userId: "user_alba",
    agentId: "finance_agent",
    service: "wallet",
    action: "pay",
    resource: "usdc_transfer",
    intent: "Send 20 USDC to Juan for dinner.",
    counterparty: demoKnownCounterparty,
    counterpartyIdentity: "juan",
    counterpartyRouteTrust: "known_historical",
    amount: { value: 20, currency: "USDC" },
    dataSensitivity: "financial",
    reversibility: "compensatable",
    context: {
      source: "direct_user",
      sourceTrust: "trusted",
      originalUserRequest: "Send 20 USDC to Juan for dinner.",
      expectedCounterparty: demoKnownCounterparty,
      expectedCounterpartyIdentity: "juan",
      expectedCounterpartyRouteTrust: "known_historical",
      expectedAmount: { value: 20, currency: "USDC" }
    }
  },
  {
    requestId: "req_demo_recipient_swap",
    userId: "user_alba",
    agentId: "finance_agent",
    service: "wallet",
    action: "pay",
    resource: "usdc_transfer",
    intent: "Send 20 USDC to Juan using the wallet address mentioned in the latest email thread.",
    counterparty: demoUnknownCounterparty,
    counterpartyRouteTrust: "unknown",
    amount: { value: 20, currency: "USDC" },
    dataSensitivity: "financial",
    reversibility: "compensatable",
    context: {
      source: "email",
      sourceTrust: "untrusted",
      originalUserRequest: "Send 20 USDC to Juan for dinner.",
      expectedCounterparty: demoKnownCounterparty,
      expectedCounterpartyIdentity: "juan",
      expectedCounterpartyRouteTrust: "known_historical",
      expectedAmount: { value: 20, currency: "USDC" }
    }
  },
  {
    requestId: "req_demo_amount_spike",
    userId: "user_alba",
    agentId: "finance_agent",
    service: "wallet",
    action: "pay",
    resource: "usdc_transfer",
    intent: "Send 350 USDC to Juan because the dinner total changed in a follow-up message.",
    counterparty: demoKnownCounterparty,
    counterpartyIdentity: "juan",
    counterpartyRouteTrust: "known_historical",
    amount: { value: 350, currency: "USDC" },
    dataSensitivity: "financial",
    reversibility: "irreversible",
    context: {
      source: "chat",
      sourceTrust: "mixed",
      originalUserRequest: "Send 20 USDC to Juan for dinner.",
      expectedCounterparty: demoKnownCounterparty,
      expectedCounterpartyIdentity: "juan",
      expectedCounterpartyRouteTrust: "known_historical",
      expectedAmount: { value: 20, currency: "USDC" }
    },
    x402: x402ContextFromEndpoint("https://wallet.example/transfer", { value: 350, currency: "USDC" }, {
      network: "base",
      scheme: "exact"
    })
  },
  {
    requestId: "req_demo_claimed_new_wallet",
    userId: "user_alba",
    agentId: "finance_agent",
    service: "wallet",
    action: "pay",
    resource: "usdc_transfer",
    intent: "Send 20 USDC to Juan using the new wallet he just sent me.",
    counterparty: demoClaimedNewRoute,
    counterpartyIdentity: "juan",
    counterpartyRouteTrust: "claimed",
    amount: { value: 20, currency: "USDC" },
    dataSensitivity: "financial",
    reversibility: "compensatable",
    context: {
      source: "direct_user",
      sourceTrust: "trusted",
      originalUserRequest: "Send 20 USDC to Juan for dinner.",
      expectedCounterparty: demoKnownCounterparty,
      expectedCounterpartyIdentity: "juan",
      expectedCounterpartyRouteTrust: "known_historical",
      expectedAmount: { value: 20, currency: "USDC" }
    }
  }
];

function event(
  eventId: string,
  occurredAt: string,
  request: AgentActionRequest,
  outcome: TrackRecordEvent["outcome"] = "allow"
): TrackRecordEvent {
  return {
    eventId,
    occurredAt,
    request,
    outcome,
    verifiedWith: "none"
  };
}
