import { randomUUID } from "node:crypto";
import { isAddress, type Address } from "viem";
import { demoProfile, seedEvents } from "../demoFixtures";
import type {
  AgentActionRequest,
  PermissionDecision,
  StepUpRejectionReason,
  TrackRecordEvent,
  UserTrustProfile
} from "../domain/types";
import { PermissionKernel } from "../kernel";
import type { IntentDriftEvaluator } from "../intent/intentDrift";
import { RuntimeEventBus } from "./eventBus";
import {
  defaultDurableEventRepository,
  defaultPendingStepUpRepository,
  type DurableEventRepository,
  type PendingStepUpRepository
} from "./repositories";
import type { DurableRuntimeEvent, PendingOperation, PendingStepUp, RuntimePermissionEvent } from "./types";
import {
  WalletConfigError,
  basescanAddrUrl,
  basescanTxUrl,
  describeWalletAvailability,
  getPublicClient,
  getUsdcAddress,
  getUsdcBalance,
  getWalletAddress,
  prepareUsdcTransfer
} from "../wallet/wallet";
import { normalizeUsername } from "../stepup/presentation";

interface KernelRuntimeOptions {
  durableEvents?: DurableEventRepository;
  pendingStepUps?: PendingStepUpRepository;
  intentDriftEvaluator?: IntentDriftEvaluator;
  clock?: () => Date;
  eventBus?: RuntimeEventBus;
  profile?: UserTrustProfile;
  seedTrackEvents?: TrackRecordEvent[];
}

type WalletOperationMode = "direct" | "resumed";

export class KernelRuntime {
  private readonly durableEvents: DurableEventRepository;
  private readonly pendingStepUps: PendingStepUpRepository;
  private readonly eventBus: RuntimeEventBus;
  private readonly profile: UserTrustProfile;
  private readonly seedTrackEvents: TrackRecordEvent[];
  private readonly clock: () => Date;
  private readonly intentDriftEvaluator?: IntentDriftEvaluator;
  private kernel: PermissionKernel;
  private readonly seenDurableEventIds = new Set<string>();
  private readonly seenTrackEventIds = new Set<string>();
  private initPromise?: Promise<void>;

  constructor(options: KernelRuntimeOptions = {}) {
    this.durableEvents = options.durableEvents ?? defaultDurableEventRepository();
    this.pendingStepUps = options.pendingStepUps ?? defaultPendingStepUpRepository();
    this.eventBus = options.eventBus ?? new RuntimeEventBus();
    this.profile = options.profile ?? demoProfile;
    this.seedTrackEvents = options.seedTrackEvents ?? seedEvents;
    this.clock = options.clock ?? (() => new Date());
    this.intentDriftEvaluator = options.intentDriftEvaluator;
    this.kernel = this.newKernel();
  }

  subscribe(listener: (event: RuntimePermissionEvent) => void): () => void {
    return this.eventBus.subscribe(listener);
  }

  async recordTrackEvent(event: TrackRecordEvent, source: "seed" | "runtime" | "manual" = "manual") {
    await this.ensureInitialized();
    await this.appendDurableEvent({
      id: durableId("track", event.eventId),
      kind: "track_recorded",
      recordedAt: this.clock().toISOString(),
      source,
      trackEvent: event
    });

    return { ok: true, eventId: event.eventId };
  }

  async assessAgentAction(request: AgentActionRequest) {
    await this.ensureInitialized();
    const evaluation = await this.evaluate(request);

    return {
      decision: evaluation.decision,
      events: evaluation.events,
      graphEvidence: evaluation.graphEvidence,
      intentDrift: evaluation.intentDrift,
      similarActions: evaluation.similarActions,
      projectedEffects: evaluation.projectedEffects,
      normalizedX402: evaluation.normalizedX402
    };
  }

  async createStandaloneStepUpChallenge(request: AgentActionRequest) {
    await this.ensureInitialized();
    const evaluation = await this.evaluate(request);
    if (evaluation.decision.outcome !== "step_up") {
      return {
        ok: false,
        reason: `Decision was ${evaluation.decision.outcome}; no step-up challenge is required.`,
        decision: evaluation.decision,
        events: evaluation.events
      };
    }

    const challenge = await this.createPendingStepUp(
      request,
      evaluation.decision,
      {
        kind: "standalone_assessment",
        request
      },
      this.clock()
    );

    return {
      ok: true,
      stepUpStatus: "pending" as const,
      decision: evaluation.decision,
      events: evaluation.events,
      challengeId: challenge.challengeId,
      challenge
    };
  }

  async explainPermissionMemory(request: AgentActionRequest) {
    await this.ensureInitialized();
    const explanation = this.kernel.explainMemory(request);
    return {
      graph: explanation.graph,
      similarActions: explanation.similarActions,
      vectorMemorySize: explanation.vectorMemorySize,
      graphSnapshot: explanation.graphSnapshot
    };
  }

  async getWalletBalance(request: AgentActionRequest) {
    await this.ensureInitialized();
    const evaluation = await this.evaluate(request);

    if (evaluation.decision.outcome === "deny") {
      return {
        ok: false,
        status: "blocked",
        decision: evaluation.decision,
        events: evaluation.events
      };
    }

    if (evaluation.decision.outcome === "step_up") {
      const challenge = await this.createPendingStepUp(
        request,
        evaluation.decision,
        {
          kind: "wallet_read_balance",
          request
        },
        this.clock()
      );

      return {
        ok: false,
        status: "step_up_required",
        stepUpStatus: "pending" as const,
        decision: evaluation.decision,
        events: evaluation.events,
        challengeId: challenge.challengeId,
        challenge
      };
    }

    const availability = describeWalletAvailability();
    if (!availability.available) {
      return {
        ok: false,
        status: "wallet_unavailable",
        reason: availability.reason,
        decision: evaluation.decision,
        events: evaluation.events,
        missing: availability.missing
      };
    }

    const walletAddress = getWalletAddress();
    const balance = await getUsdcBalance();

    return {
      ok: true,
      status: "allowed",
      decision: evaluation.decision,
      events: evaluation.events,
      address: walletAddress,
      balance,
      asset: "USDC",
      explorer: basescanAddrUrl(walletAddress)
    };
  }

  async prepareWalletTransfer(
    request: AgentActionRequest,
    now = this.clock(),
    mode: WalletOperationMode = "direct",
    stepUpOperationKind: PendingOperation["kind"] = "wallet_prepare_transfer"
  ) {
    await this.ensureInitialized();
    const evaluation = await this.evaluate(request);

    if (evaluation.decision.outcome === "deny") {
      return {
        ok: false,
        status: "blocked",
        reason: "Decision was deny; wallet transfer was not prepared.",
        decision: evaluation.decision,
        events: evaluation.events
      };
    }

    if (evaluation.decision.outcome === "step_up") {
      const challenge = await this.createPendingStepUp(
        request,
        evaluation.decision,
        {
          kind: stepUpOperationKind,
          request
        },
        now
      );

      return {
        ok: false,
        status: "step_up_required",
        stepUpStatus: "pending" as const,
        reason: "Wallet transfer requires step-up before preparation can produce an executable payload.",
        decision: evaluation.decision,
        events: evaluation.events,
        challengeId: challenge.challengeId,
        challenge
      };
    }

    const preparation = this.prepareTransferPayload(request);
    await this.persistPreparation(request, evaluation.decision, preparation, mode);

    return {
      ok: true,
      status: "prepared",
      stepUpStatus: mode === "resumed" ? ("verified" as const) : undefined,
      decision: evaluation.decision,
      events: evaluation.events,
      preparation
    };
  }

  async mockExecuteWalletTransfer(request: AgentActionRequest, now = this.clock(), mode: WalletOperationMode = "direct") {
    await this.ensureInitialized();
    const prepared = await this.prepareWalletTransfer(request, now, mode, "wallet_mock_execute_transfer");
    if (!prepared.ok) {
      return {
        ...prepared,
        reason:
          prepared.status === "blocked"
            ? "Decision was deny; mock wallet transfer was not executed."
            : prepared.reason
      };
    }

    const preparation = prepared.preparation;
    if (!preparation) {
      return {
        ok: false,
        status: "invalid_request",
        reason: "Wallet transfer execution requires a prepared transaction payload.",
        decision: prepared.decision,
        events: prepared.events
      };
    }

    const executionTrackEvent = this.buildTrackRecordEvent(request, now.toISOString(), mode === "resumed" ? "passkey" : "none");
    if (mode === "direct") {
      await this.recordTrackEvent(executionTrackEvent, "runtime");
    }

    const execution = {
      mode: "mock" as const,
      eventId: executionTrackEvent.eventId,
      hash: `0x${prepared.decision.actionHash}`,
      from: preparation.from,
      to: preparation.to,
      amount: request.amount?.value ?? 0,
      asset: request.amount?.currency ?? "USDC",
      transaction: preparation.transaction
    };

    await this.appendDurableEvent({
      id: durableId("wallet_execute", execution.eventId),
      kind: "wallet_transfer_mock_executed",
      recordedAt: now.toISOString(),
      requestId: request.requestId,
      actionHash: prepared.decision.actionHash,
      mode,
      execution: {
        eventId: execution.eventId,
        hash: execution.hash,
        from: execution.from,
        to: execution.to,
        amount: execution.amount,
        asset: execution.asset
      }
    });

    this.emit({
      type: "wallet.transfer_mock_executed",
      ts: now.getTime(),
      requestId: request.requestId,
      actionHash: prepared.decision.actionHash,
      to: execution.to,
      amount: execution.amount,
      asset: execution.asset,
      txHash: execution.hash,
      mode
    });

    return {
      ok: true,
      status: "mock_executed",
      stepUpStatus: mode === "resumed" ? ("verified" as const) : undefined,
      decision: prepared.decision,
      events: prepared.events,
      preparation,
      execution
    };
  }

  async beginPasskeyStepUp(challengeId: string, username: string, authChallenge: string) {
    await this.ensureInitialized();
    const pending = await this.requirePendingStepUp(challengeId);
    this.assertStepUpStillActive(pending, challengeId);

    if (pending.channel === "voice_biometric_callback") {
      if (pending.status !== "phone_confirmed") {
        throw new Error(`Step-up ${challengeId} still needs verbal confirmation before biometric validation can begin.`);
      }
    } else if (pending.status !== "pending") {
      throw new Error(`Step-up ${challengeId} is ${pending.status}, not pending.`);
    }

    if (!this.matchesVerificationUsername(username, pending.verificationUsername)) {
      throw new Error(`Step-up ${challengeId} is reserved for another user.`);
    }

    const updated: PendingStepUp = {
      ...pending,
      authChallenge,
      challengeOwnerUsername: pending.verificationUsername
    };
    await this.pendingStepUps.upsert(updated);
    return updated;
  }

  async getPendingStepUp(challengeId: string) {
    await this.ensureInitialized();
    return this.pendingStepUps.get(challengeId);
  }

  async getPendingStepUpByHandoffCode(handoffCode: string) {
    await this.ensureInitialized();
    return this.pendingStepUps.getByHandoffCode(handoffCode);
  }

  async confirmPhoneStepUp(
    challengeId: string,
    provider: "elevenlabs" | "manual" = "manual",
    now = this.clock()
  ) {
    await this.ensureInitialized();
    const pending = await this.requirePendingStepUp(challengeId);

    if (pending.channel !== "voice_biometric_callback") {
      throw new Error(`Step-up ${challengeId} is bound to ${pending.channel}, not voice callback.`);
    }

    if (pending.status === "phone_confirmed" || pending.status === "verified" || pending.status === "completed") {
      return {
        ok: true as const,
        status: pending.status,
        challengeId,
        stepUp: pending,
        next: {
          action: "open_whatsapp_verification_link" as const,
          message: "Abrí el WhatsApp enviado y terminá la verificación con passkey."
        }
      };
    }

    this.assertStepUpStillActive(pending, challengeId);

    if (pending.status !== "pending") {
      throw new Error(`Step-up ${challengeId} is ${pending.status}, not pending.`);
    }

    const updated: PendingStepUp = {
      ...pending,
      status: "phone_confirmed",
      phoneConfirmedAt: now.toISOString(),
      phoneConfirmationProvider: provider
    };
    await this.pendingStepUps.upsert(updated);

    await this.appendDurableEvent({
      id: durableId("stepup_phone_confirmed", challengeId),
      kind: "step_up_phone_confirmed",
      recordedAt: now.toISOString(),
      challengeId,
      requestId: pending.request.requestId,
      actionHash: pending.decision.actionHash,
      provider
    });

    this.emit({
      type: "step_up.phone_confirmed",
      ts: now.getTime(),
      requestId: pending.request.requestId,
      challengeId,
      channel: pending.channel,
      provider
    });

    return {
      ok: true as const,
      status: "phone_confirmed" as const,
      challengeId,
      stepUp: updated,
      next: {
        action: "open_whatsapp_verification_link" as const,
        message: "Abrí el WhatsApp enviado y terminá la verificación con passkey."
      }
    };
  }

  async rejectStepUp(challengeId: string, reason: StepUpRejectionReason, now = this.clock()) {
    await this.ensureInitialized();
    const pending = await this.requirePendingStepUp(challengeId);

    if (pending.status === "rejected") {
      return {
        ok: true as const,
        status: "rejected" as const,
        challengeId,
        reason: pending.rejectedReason ?? reason
      };
    }

    this.assertStepUpStillActive(pending, challengeId);

    if (pending.status !== "pending" && pending.status !== "phone_confirmed") {
      throw new Error(`Step-up ${challengeId} is ${pending.status}, and can no longer be rejected.`);
    }

    const updated: PendingStepUp = {
      ...pending,
      status: "rejected",
      rejectedAt: now.toISOString(),
      rejectedReason: reason
    };
    await this.pendingStepUps.upsert(updated);

    await this.appendDurableEvent({
      id: durableId("stepup_rejected", challengeId),
      kind: "step_up_rejected",
      recordedAt: now.toISOString(),
      challengeId,
      requestId: pending.request.requestId,
      actionHash: pending.decision.actionHash,
      reason
    });

    this.emit({
      type: "step_up.rejected",
      ts: now.getTime(),
      requestId: pending.request.requestId,
      challengeId,
      channel: pending.channel,
      reason
    });

    return {
      ok: true as const,
      status: "rejected" as const,
      challengeId,
      reason
    };
  }

  async completeVerifiedStepUp(
    challengeId: string,
    username: string,
    now = this.clock()
  ) {
    await this.ensureInitialized();
    const pending = await this.requirePendingStepUp(challengeId);
    this.assertStepUpStillActive(pending, challengeId);

    if (pending.channel === "voice_biometric_callback") {
      if (pending.status !== "phone_confirmed") {
        throw new Error(`Step-up ${challengeId} still needs verbal confirmation before biometric verification can complete.`);
      }
    } else if (pending.status !== "pending") {
      throw new Error(`Step-up ${challengeId} is ${pending.status}, not pending.`);
    }

    if (
      pending.challengeOwnerUsername &&
      !this.matchesVerificationUsername(username, pending.challengeOwnerUsername)
    ) {
      throw new Error(`Step-up ${challengeId} is owned by another user.`);
    }

    if (!this.matchesVerificationUsername(username, pending.verificationUsername)) {
      throw new Error(`Step-up ${challengeId} is reserved for another user.`);
    }

    const verifiedTrackEvent = this.buildTrackRecordEvent(pending.request, now.toISOString(), "passkey");
    await this.recordTrackEvent(verifiedTrackEvent, "runtime");

    await this.appendDurableEvent({
      id: durableId("stepup_verified", challengeId),
      kind: "step_up_verified",
      recordedAt: now.toISOString(),
      challengeId,
      requestId: pending.request.requestId,
      actionHash: pending.decision.actionHash,
      verifiedByUsername: username,
      trackEvent: verifiedTrackEvent
    });

    this.emit({
      type: "step_up.verified",
      ts: now.getTime(),
      requestId: pending.request.requestId,
      challengeId,
      channel: pending.channel,
      verifiedByUsername: username
    });

    const verified: PendingStepUp = {
      ...pending,
      status: "verified",
      verifiedAt: now.toISOString(),
      verifiedByUsername: username
    };
    await this.pendingStepUps.upsert(verified);

    let resumed:
      | Awaited<ReturnType<KernelRuntime["resumeWalletReadBalance"]>>
      | Awaited<ReturnType<KernelRuntime["resumeWalletPrepareTransfer"]>>
      | Awaited<ReturnType<KernelRuntime["resumeWalletMockExecuteTransfer"]>>
      | Awaited<ReturnType<KernelRuntime["resumeStandaloneAssessment"]>>;

    if (pending.operation.kind === "wallet_read_balance") {
      resumed = await this.resumeWalletReadBalance(pending, now);
    } else if (pending.operation.kind === "wallet_prepare_transfer") {
      resumed = await this.resumeWalletPrepareTransfer(pending, now);
    } else if (pending.operation.kind === "standalone_assessment") {
      resumed = await this.resumeStandaloneAssessment(pending, now);
    } else {
      resumed = await this.resumeWalletMockExecuteTransfer(pending, now);
    }

    const completed: PendingStepUp = {
      ...verified,
      status: "completed",
      completedAt: now.toISOString()
    };
    await this.pendingStepUps.upsert(completed);

    return resumed;
  }

  async cancelPendingStepUp(
    challengeId: string,
    username: string,
    now = this.clock()
  ) {
    await this.ensureInitialized();
    const pending = await this.requirePendingStepUp(challengeId);
    if (pending.status !== "pending") {
      throw new Error(`Step-up ${challengeId} is ${pending.status}, not pending.`);
    }

    if (pending.challengeOwnerUsername && pending.challengeOwnerUsername !== username) {
      throw new Error(`Step-up ${challengeId} is owned by another user.`);
    }

    await this.appendDurableEvent({
      id: durableId("stepup_canceled", challengeId),
      kind: "step_up_canceled",
      recordedAt: now.toISOString(),
      challengeId,
      requestId: pending.request.requestId,
      actionHash: pending.decision.actionHash,
      canceledByUsername: username
    });

    this.emit({
      type: "step_up.canceled",
      ts: now.getTime(),
      requestId: pending.request.requestId,
      challengeId,
      channel: pending.channel,
      canceledByUsername: username
    });

    const canceled: PendingStepUp = {
      ...pending,
      status: "canceled",
      canceledAt: now.toISOString(),
      canceledByUsername: username
    };
    await this.pendingStepUps.upsert(canceled);

    return { canceled: true as const, challengeId };
  }

  async getWalletOverview() {
    await this.ensureInitialized();
    const availability = describeWalletAvailability();
    if (!availability.available) {
      return {
        configured: false as const,
        reason: availability.reason ?? "wallet unavailable",
        missing: availability.missing
      };
    }

    const publicClient = getPublicClient();
    const walletAddress = getWalletAddress();
    const usdcAddress = getUsdcAddress();
    const [balance, currentBlock] = await Promise.all([getUsdcBalance(), publicClient.getBlockNumber()]);

    const fromBlock = currentBlock > 2_000n ? currentBlock - 2_000n : 0n;
    const transferEvent = {
      type: "event",
      name: "Transfer",
      inputs: [
        { name: "from", type: "address", indexed: true },
        { name: "to", type: "address", indexed: true },
        { name: "value", type: "uint256", indexed: false }
      ]
    } as const;

    const [sent, received] = await Promise.all([
      publicClient.getLogs({
        address: usdcAddress,
        event: transferEvent,
        args: { from: walletAddress },
        fromBlock,
        toBlock: currentBlock
      }),
      publicClient.getLogs({
        address: usdcAddress,
        event: transferEvent,
        args: { to: walletAddress },
        fromBlock,
        toBlock: currentBlock
      })
    ]);

    const txs = [...sent, ...received]
      .sort((a, b) => {
        const ab = a.blockNumber ?? 0n;
        const bb = b.blockNumber ?? 0n;
        if (ab === bb) return Number((b.logIndex ?? 0) - (a.logIndex ?? 0));
        return Number(bb - ab);
      })
      .slice(0, 8)
      .map((log) => {
        const isSend = log.args.from?.toLowerCase() === walletAddress.toLowerCase();
        const value = log.args.value ?? 0n;
        return {
          hash: log.transactionHash ?? "",
          direction: isSend ? ("out" as const) : ("in" as const),
          counterparty: (isSend ? log.args.to : log.args.from) ?? "",
          amount: (Number(value) / 1_000_000).toFixed(2),
          blockNumber: Number(log.blockNumber ?? 0n),
          basescanUrl: log.transactionHash ? basescanTxUrl(log.transactionHash) : null
        };
      });

    return {
      configured: true as const,
      address: walletAddress,
      addressUrl: basescanAddrUrl(walletAddress),
      balance,
      currency: "USDC" as const,
      blockNumber: Number(currentBlock),
      txs
    };
  }

  private newKernel() {
    return new PermissionKernel(this.profile, {
      intentDriftEvaluator: this.intentDriftEvaluator,
      clock: this.clock
    });
  }

  private async ensureInitialized() {
    if (!this.initPromise) {
      this.initPromise = this.initialize();
    }

    await this.initPromise;
    await this.syncFromStorage();
  }

  private async initialize() {
    await this.syncFromStorage();
    const durableEvents = await this.durableEvents.list();
    const hasTrackHistory = durableEvents.some((event) => event.kind === "track_recorded");
    if (!hasTrackHistory) {
      for (const event of this.seedTrackEvents) {
        await this.appendDurableEvent({
          id: durableId("track", event.eventId),
          kind: "track_recorded",
          recordedAt: this.clock().toISOString(),
          source: "seed",
          trackEvent: event
        });
      }
    }

    await this.syncFromStorage();
    await this.expirePendingStepUps();
  }

  private async syncFromStorage() {
    const durableEvents = await this.durableEvents.list();
    for (const event of durableEvents) {
      if (this.seenDurableEventIds.has(event.id)) continue;
      this.seenDurableEventIds.add(event.id);
      if (event.kind === "track_recorded" && !this.seenTrackEventIds.has(event.trackEvent.eventId)) {
        this.kernel.record(event.trackEvent);
        this.seenTrackEventIds.add(event.trackEvent.eventId);
      }
    }
  }

  private async expirePendingStepUps() {
    const now = this.clock().getTime();
    const pending = await this.pendingStepUps.list();
    for (const stepUp of pending) {
      if (
        (stepUp.status === "pending" || stepUp.status === "phone_confirmed") &&
        new Date(stepUp.expiresAt).getTime() <= now
      ) {
        await this.pendingStepUps.upsert({
          ...stepUp,
          status: "expired"
        });
      }
    }
  }

  private async evaluate(request: AgentActionRequest) {
    const evaluation = await this.kernel.decide(request);
    const ts = this.clock().getTime();

    this.emit({
      type: "permission.request_started",
      ts,
      requestId: request.requestId,
      agentId: request.agentId,
      action: request.action,
      service: request.service,
      intent: request.intent
    });

    for (const event of evaluation.events) {
      this.emit({
        type: "permission.trace_event",
        ts,
        requestId: request.requestId,
        eventType: event.type,
        summary: event.summary,
        payload: event.payload
      });
    }

    this.emit({
      type: "permission.decision_made",
      ts,
      requestId: request.requestId,
      outcome: evaluation.decision.outcome,
      riskScore: evaluation.decision.riskScore,
      explanation: evaluation.decision.explanation
    });

    await this.appendDurableEvent({
      id: durableId("decision", request.requestId, evaluation.decision.actionHash, ts.toString()),
      kind: "decision_recorded",
      recordedAt: new Date(ts).toISOString(),
      requestId: request.requestId,
      actionHash: evaluation.decision.actionHash,
      decision: {
        outcome: evaluation.decision.outcome,
        riskScore: evaluation.decision.riskScore,
        explanation: evaluation.decision.explanation,
        requiredStepUp: evaluation.decision.requiredStepUp
      }
    });

    return evaluation;
  }

  private async createPendingStepUp(
    request: AgentActionRequest,
    decision: PermissionDecision,
    operation: PendingOperation,
    now: Date
  ) {
    const challenge = this.kernel.createStepUpChallenge(request, decision, now);
    const pending: PendingStepUp = {
      ...challenge,
      createdAt: now.toISOString(),
      request,
      decision,
      operation,
      status: "pending"
    };

    await this.pendingStepUps.upsert(pending);
    this.emit({
      type: "step_up.challenge_created",
      ts: now.getTime(),
      requestId: request.requestId,
      challengeId: challenge.challengeId,
      channel: challenge.channel,
      prompt: challenge.prompt,
      expiresAt: challenge.expiresAt
    });

    return pending;
  }

  private prepareTransferPayload(request: AgentActionRequest) {
    if (!request.counterparty) {
      throw new Error("Wallet transfer preparation requires an explicit destination address.");
    }

    if (!isAddress(request.counterparty)) {
      throw new Error("Wallet transfer preparation requires a valid EVM destination address.");
    }

    if (!request.amount) {
      throw new Error("Wallet transfer preparation requires an explicit amount.");
    }

    try {
      return prepareUsdcTransfer(request.counterparty as Address, request.amount.value.toString());
    } catch (error) {
      if (error instanceof WalletConfigError) {
        throw error;
      }

      throw error;
    }
  }

  private async persistPreparation(
    request: AgentActionRequest,
    decision: PermissionDecision,
    preparation: ReturnType<KernelRuntime["prepareTransferPayload"]>,
    mode: WalletOperationMode
  ) {
    await this.appendDurableEvent({
      id: durableId("wallet_prepare", request.requestId, decision.actionHash, mode),
      kind: "wallet_transfer_prepared",
      recordedAt: this.clock().toISOString(),
      requestId: request.requestId,
      actionHash: decision.actionHash,
      mode,
      preparation: {
        asset: preparation.asset,
        amount: preparation.amount,
        amountBaseUnits: preparation.amountBaseUnits,
        from: preparation.from,
        to: preparation.to,
        transaction: preparation.transaction
      }
    });

    this.emit({
      type: "wallet.transfer_prepared",
      ts: this.clock().getTime(),
      requestId: request.requestId,
      actionHash: decision.actionHash,
      to: preparation.to,
      amount: preparation.amount,
      asset: preparation.asset,
      mode
    });
  }

  private buildTrackRecordEvent(
    request: AgentActionRequest,
    occurredAt: string,
    verifiedWith: TrackRecordEvent["verifiedWith"]
  ): TrackRecordEvent {
    return {
      eventId: `evt_exec_${randomUUID().slice(0, 12)}`,
      occurredAt,
      request,
      outcome: "allow",
      verifiedWith
    };
  }

  private async resumeWalletReadBalance(pending: PendingStepUp, now: Date) {
    const availability = describeWalletAvailability();
    if (!availability.available) {
      return {
        ok: false,
        status: "wallet_unavailable",
        reason: availability.reason,
        stepUpStatus: "verified" as const,
        challengeId: pending.challengeId,
        decision: pending.decision,
        missing: availability.missing
      };
    }

    const walletAddress = getWalletAddress();
    const balance = await getUsdcBalance();

    return {
      ok: true,
      status: "allowed",
      stepUpStatus: "verified" as const,
      challengeId: pending.challengeId,
      decision: pending.decision,
      address: walletAddress,
      balance,
      asset: "USDC",
      explorer: basescanAddrUrl(walletAddress)
    };
  }

  private async resumeStandaloneAssessment(pending: PendingStepUp, _now: Date) {
    const assessment = await this.assessAgentAction(pending.request);

    return {
      ok: true,
      status: "assessed",
      stepUpStatus: "verified" as const,
      challengeId: pending.challengeId,
      assessment
    };
  }

  private async resumeWalletPrepareTransfer(pending: PendingStepUp, now: Date) {
    const preparation = this.prepareTransferPayload(pending.request);
    await this.persistPreparation(pending.request, pending.decision, preparation, "resumed");

    return {
      ok: true,
      status: "prepared",
      stepUpStatus: "verified" as const,
      challengeId: pending.challengeId,
      decision: pending.decision,
      preparation
    };
  }

  private async resumeWalletMockExecuteTransfer(pending: PendingStepUp, now: Date) {
    const preparation = this.prepareTransferPayload(pending.request);
    await this.persistPreparation(pending.request, pending.decision, preparation, "resumed");

    const execution = {
      mode: "mock" as const,
      eventId: `evt_exec_${pending.decision.actionHash.slice(0, 12)}`,
      hash: `0x${pending.decision.actionHash}`,
      from: preparation.from,
      to: preparation.to,
      amount: pending.request.amount?.value ?? 0,
      asset: pending.request.amount?.currency ?? "USDC",
      transaction: preparation.transaction
    };

    await this.appendDurableEvent({
      id: durableId("wallet_execute", execution.eventId, "resumed"),
      kind: "wallet_transfer_mock_executed",
      recordedAt: now.toISOString(),
      requestId: pending.request.requestId,
      actionHash: pending.decision.actionHash,
      mode: "resumed",
      execution: {
        eventId: execution.eventId,
        hash: execution.hash,
        from: execution.from,
        to: execution.to,
        amount: execution.amount,
        asset: execution.asset
      }
    });

    this.emit({
      type: "wallet.transfer_mock_executed",
      ts: now.getTime(),
      requestId: pending.request.requestId,
      actionHash: pending.decision.actionHash,
      to: execution.to,
      amount: execution.amount,
      asset: execution.asset,
      txHash: execution.hash,
      mode: "resumed"
    });

    return {
      ok: true,
      status: "mock_executed",
      stepUpStatus: "verified" as const,
      challengeId: pending.challengeId,
      decision: pending.decision,
      preparation,
      execution
    };
  }

  private async appendDurableEvent(event: DurableRuntimeEvent) {
    await this.durableEvents.append(event);
    this.seenDurableEventIds.add(event.id);
    if (event.kind === "track_recorded" && !this.seenTrackEventIds.has(event.trackEvent.eventId)) {
      this.kernel.record(event.trackEvent);
      this.seenTrackEventIds.add(event.trackEvent.eventId);
    }
  }

  private emit(event: RuntimePermissionEvent) {
    this.eventBus.emit(event);
  }

  private async requirePendingStepUp(challengeId: string) {
    const pending = await this.pendingStepUps.get(challengeId);
    if (!pending) {
      throw new Error(`Unknown step-up challenge ${challengeId}.`);
    }

    return pending;
  }

  private assertStepUpStillActive(pending: PendingStepUp, challengeId: string) {
    if (pending.status === "expired") {
      throw new Error(`Step-up ${challengeId} has expired.`);
    }

    if (pending.status === "rejected") {
      throw new Error(`Step-up ${challengeId} was rejected.`);
    }

    if (pending.status === "completed") {
      throw new Error(`Step-up ${challengeId} is already completed.`);
    }

    if (new Date(pending.expiresAt).getTime() <= this.clock().getTime()) {
      const expired = { ...pending, status: "expired" as const };
      void this.pendingStepUps.upsert(expired);
      throw new Error(`Step-up ${challengeId} has expired.`);
    }
  }

  private matchesVerificationUsername(username: string, verificationUsername: string) {
    return normalizeUsername(username) === normalizeUsername(verificationUsername);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __consentinelRuntime: KernelRuntime | undefined;
}

export function getSharedKernelRuntime() {
  if (!globalThis.__consentinelRuntime) {
    globalThis.__consentinelRuntime = new KernelRuntime();
  }

  return globalThis.__consentinelRuntime;
}

function durableId(...parts: string[]) {
  return parts.join(":");
}
