import type { OhMyOpenCodeConfig } from "../config";
import type { PluginContext } from "./types";
import { PROMETHEUS_FINAL_ARTIFACT_RECOVERY_TEXT } from "../agents/prometheus/final-artifact-recovery";

import {
  clearSessionAgent,
  getMainSessionID,
  getSessionAgent,
  setMainSession,
  subagentSessions,
  syncSubagentSessions,
  updateSessionAgent,
} from "../features/claude-code-session-state";
import {
  clearPendingModelFallback,
  clearSessionFallbackChain,
  setSessionFallbackChain,
  setPendingModelFallback,
} from "../hooks/model-fallback/hook";
import { fixEmptyMessagesWithSDK } from "../hooks/anthropic-context-window-limit-recovery/empty-content-recovery-sdk";
import { extractResumeConfig, findLastUserMessage, resumeSession } from "../hooks/session-recovery/resume";
import {
  getMessageAgent,
  getMessageError,
  getMessageID,
  getMessageModel,
  getMessageRole,
} from "../hooks/session-recovery/message-accessors";
import { getRawFallbackModels } from "../hooks/runtime-fallback/fallback-models";
import {
  clearBackgroundOutputConsumptionsForParentSession,
  clearBackgroundOutputConsumptionsForTaskSession,
  restoreBackgroundOutputConsumption,
} from "../shared/background-output-consumption";
import { setContinuationMarkerSource } from "../features/run-continuation-state";
import { createInternalAgentTextPart, normalizeSDKResponse, resetMessageCursor } from "../shared";
import { getAgentConfigKey } from "../shared/agent-display-names";
import { readConnectedProvidersCache } from "../shared/connected-providers-cache";
import { log } from "../shared/logger";
import { wasRecentRuntimeFallbackContinuationDispatched } from "../shared/recent-runtime-fallback-continuation";
import { shouldRetryError, shouldSwitchFallback } from "../shared/model-error-classifier"
import { buildFallbackChainFromModels } from "../shared/fallback-chain-from-models";
import { extractRetryAttempt, normalizeRetryStatusMessage } from "../shared/retry-status-utils";
import { clearSessionModel, getSessionModel, setSessionModel } from "../shared/session-model-state";
import { clearSessionPromptParams } from "../shared/session-prompt-params-state";
import { deleteSessionTools } from "../shared/session-tools-store";
import { lspManager } from "../tools";
import { getRuntimeFallbackSessionID } from "../hooks/runtime-fallback/session-id";
import { resolveCompactionModel } from "../hooks/shared/compaction-model-resolver";

import type { CreatedHooks } from "../create-hooks";
import type { Managers } from "../create-managers";
import { pruneRecentSyntheticIdles } from "./recent-synthetic-idles";
import { normalizeSessionStatusToIdle } from "./session-status-normalizer";

type FirstMessageVariantGate = {
  markSessionCreated: (sessionInfo: { id?: string; title?: string; parentID?: string } | undefined) => void;
  clear: (sessionID: string) => void;
};

function getContinuationMarkerDirectory(ctx: PluginContext): string | null {
  return typeof ctx.directory === "string" && ctx.directory.length > 0 ? ctx.directory : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeFallbackModelID(modelID: string): string {
  return modelID
    .replace(/-thinking$/i, "")
    .replace(/-max$/i, "")
    .replace(/-high$/i, "");
}

function extractErrorName(error: unknown): string | undefined {
  if (isRecord(error) && typeof error.name === "string") return error.name;
  if (error instanceof Error) return error.name;
  return undefined;
}

function extractErrorMessage(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;

  if (isRecord(error)) {
    const candidates: unknown[] = [
      error,
      error.data,
      error.error,
      isRecord(error.data) ? error.data.error : undefined,
      error.cause,
    ];

    for (const candidate of candidates) {
      if (isRecord(candidate) && typeof candidate.message === "string" && candidate.message.length > 0) {
        return candidate.message;
      }
    }
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function extractProviderModelFromErrorMessage(message: string): { providerID?: string; modelID?: string } {
  const lower = message.toLowerCase();

  const providerModel = lower.match(/model\s+not\s+found:\s*([a-z0-9_-]+)\s*\/\s*([a-z0-9._-]+)/i);
  if (providerModel) {
    return {
      providerID: providerModel[1],
      modelID: providerModel[2],
    };
  }

  const modelOnly = lower.match(/unknown\s+provider\s+for\s+model\s+([a-z0-9._-]+)/i);
  if (modelOnly) {
    return {
      modelID: modelOnly[1],
    };
  }

  return {};
}

function buildRecoveryCompactionBody(
  pluginConfig: OhMyOpenCodeConfig,
  sessionID: string,
): { auto: true; providerID?: string; modelID?: string } {
  const sessionModel = getSessionModel(sessionID);
  if (!sessionModel?.providerID || !sessionModel?.modelID) {
    return { auto: true };
  }

  const { providerID, modelID } = resolveCompactionModel(
    pluginConfig,
    sessionID,
    sessionModel.providerID,
    sessionModel.modelID,
  );

  return { auto: true, providerID, modelID };
}

function isProviderBlockedErrorText(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("request not allowed")
    || normalized.includes("forbidden")
    || normalized.includes("unable to load site")
    || normalized.includes("cloudflare")
  );
}

type RecoveryMessagePart = {
  type?: string;
  text?: string;
  tool?: string;
  raw?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: unknown;
    error?: unknown;
    metadata?: {
      interrupted?: boolean;
    };
  };
}

type RecoveryMessage = {
  info?: {
    id?: string;
    role?: string;
    agent?: string;
    finish?: string;
    model?: { providerID: string; modelID: string };
    tools?: Record<string, boolean>;
    error?: unknown;
  };
  parts?: RecoveryMessagePart[];
}

type RecoveryResumeSessionApi = {
  promptAsync?: (args: {
    path: { id: string };
    body: { parts: Array<Record<string, unknown>> };
    query?: { directory: string };
  }) => Promise<unknown>;
  prompt?: (args: {
    path: { id: string };
    body: { parts: Array<Record<string, unknown>> };
    query?: { directory: string };
  }) => Promise<unknown>;
}

const EMPTY_ASSISTANT_PLACEHOLDER_TEXT = "[recovered empty assistant message]";
const EMPTY_ASSISTANT_RECOVERY_DELAY_MS = 5000;
const PROMETHEUS_STREAMING_DELTA_RECOVERY_DELAY_MS = 120000;
const PROMETHEUS_ABORTED_TOOL_RECOVERY_DELAY_MS = 500;
const PROMETHEUS_PROVIDER_BLOCKED_SAME_MODEL_WINDOW_MS = 10 * 60 * 1000;
const PROMETHEUS_RUNTIME_FALLBACK_RECOVERY_GUARD_MS = 10 * 60 * 1000;
const PROMETHEUS_EMPTY_TOOL_RECOVERY_TEXT = [
  "[session recovered - retry the interrupted plan write now]",
  "Your previous planning tool call was emitted without the required arguments and never executed.",
  "Do not add another explanatory assistant turn before the tool call.",
  "Immediately emit the correct tool call with complete arguments.",
  "If using Write, include the full filePath and complete markdown content.",
  "If the final payload is too large, complete the draft first and then promote it to .sisyphus/plans/{name}.md.",
  "After the write succeeds, read the final plan file and verify the ## TODOs section is populated.",
  PROMETHEUS_FINAL_ARTIFACT_RECOVERY_TEXT,
].join("\n");
const PROMETHEUS_REASONING_ONLY_RECOVERY_TEXT = [
  "[session recovered - complete plan generation now]",
  "You are in Prometheus plan-generation mode.",
  "Do not stop at reasoning.",
  "Immediately perform the next missing concrete action:",
  "1. If plan-generation todos were not registered yet, run TodoWrite now.",
  "2. If the final .sisyphus/plans/*.md plan artifact was not written or updated, write or update it now.",
  "3. Read back the final plan file and verify the ## TODOs section is populated.",
  "Only stop after the final plan artifact exists and you have produced a user-facing summary.",
  PROMETHEUS_FINAL_ARTIFACT_RECOVERY_TEXT,
].join("\n");
const PROMETHEUS_INTERRUPTED_VISIBLE_TURN_RECOVERY_TEXT = [
  "[session recovered - resume interrupted plan generation now]",
  "Your previous Prometheus turn ended prematurely before the final plan artifact was produced.",
  "Continue from the exact point of interruption instead of restarting the analysis from scratch.",
  "If there are still unread plan fragments or drafts, read them now.",
  "Then finish synthesizing the unified CI plan and write the final .sisyphus/plans/*.md artifact.",
  "Only stop after the final plan file exists, has populated ## TODOs, and you provide a concise user-facing summary.",
  PROMETHEUS_FINAL_ARTIFACT_RECOVERY_TEXT,
].join("\n");
const PROMETHEUS_CI_VISIBLE_SUMMARY_RECOVERY_TEXT = [
  "[session recovered - continue CI planning after the visible summary now]",
  "Your previous planner turn stopped after a user-facing CI state summary before the next concrete planner action happened.",
  "Do not emit another summary-only turn.",
  "Immediately continue from the verified canonical state and perform the next concrete planner action.",
  "If the current executor batch should start now, emit the task delegation now.",
  "If delegation already happened and only follow-through is missing, continue that follow-through instead of re-summarizing the same state.",
].join("\n");
const PROMETHEUS_TOOL_ONLY_TURN_RECOVERY_TEXT = [
  "[session recovered - continue plan generation after the tool call now]",
  "Your previous Prometheus turn ended on a tool-only step before the next planning action ran.",
  "Do not stop after reviewing the prior tool result.",
  "Immediately continue from that exact state and perform the next concrete action needed to finish plan generation.",
  "If background research is still needed, launch only the missing research task and continue coordinating from the latest results.",
  "If enough evidence already exists, write or update the final .sisyphus/plans/*.md artifact now.",
  "Only stop after the final plan artifact exists and you provide a concise user-facing summary.",
  PROMETHEUS_FINAL_ARTIFACT_RECOVERY_TEXT,
].join("\n");
const PROMETHEUS_CI_BOOTSTRAP_TOOL_ERROR_RECOVERY_TEXT = [
  "[session recovered - continue CI planning from the existing evidence now]",
  "Your previous CI bootstrap read was blocked because the canonical evidence set is already established on disk.",
  "Do not retry legacy .sisyphus evidence aliases, and do not reread the blocked core evidence files again.",
  "Use the current on-disk plan, dirty batch, and tracker state you already established and immediately continue the next concrete planner action.",
  "If delegation should happen now, emit the task call now.",
  "If the active plan already has the next executor batch defined, continue directly from that state instead of restarting discovery.",
].join("\n");
const SISYPHUS_CI_EMPTY_TOOL_RECOVERY_TEXT = [
  "[session recovered - continue evidence-gated CI now]",
  "Your previous CI tool call was emitted without the required arguments and never executed.",
  "Do not add another explanatory assistant turn before the tool call.",
  "Immediately emit the correct tool call with complete arguments.",
  "If the next action is a bash tool call, include the full bounded command in one shot.",
  "Do not restart the analysis from scratch.",
  "Resume from the exact current evidence/edit state and continue the unified CI batch.",
].join("\n");
const SISYPHUS_CI_REASONING_ONLY_RECOVERY_TEXT = [
  "[session recovered - continue evidence-gated CI now]",
  "You are in evidence-gated CI mode.",
  "Do not stop at reasoning.",
  "Immediately perform the next missing concrete action:",
  "1. If the current build's tracker files, `repair-log.md`, or `ci-loop-checkpoint.md` are stale or not yet updated on disk, write them now.",
  "2. Otherwise, if the first unified edit batch has not started yet, begin the edit batch now and cover the whole current failing set.",
  "3. Otherwise, run the next constrained local verification step for that same unified batch.",
  "Do not emit another prose-only or reasoning-only turn before a tool call.",
].join("\n");
const SISYPHUS_CI_INTERRUPTED_VISIBLE_TURN_RECOVERY_TEXT = [
  "[session recovered - resume the active evidence-gated CI verify chain now]",
  "Your previous Sisyphus CI turn ended after visible progress but before the next concrete tool step completed.",
  "Do not restart discovery or reread already-validated evidence.",
  "Resume from the exact current CI state and perform the next missing concrete tool action now.",
  "If you were entering the bounded local verify wave, relaunch or resume that verify wave immediately with the same contour and current dirty batch.",
  "If that verify wave already produced artifacts, continue from those artifacts instead of burning another redundant discovery pass.",
  "Do not emit another prose-only assistant turn before the next tool call.",
].join("\n");
const SISYPHUS_CI_GUARDRAIL_TOOL_ERROR_RECOVERY_TEXT = [
  "[session recovered - continue evidence-gated CI after the runtime guard now]",
  "Your previous CI exploration tool call was blocked by a runtime guard because the source-pass had already gone far enough.",
  "Do not keep exploring, and do not retry the same blocked search/read step.",
  "Immediately continue from the current dirty-batch state with the next concrete action:",
  "1. start or continue the unified edit batch, or",
  "2. if the unified batch is already in place, run or resume the bounded local rerun.",
  "Do not emit another prose-only or reasoning-only turn before a tool call.",
].join("\n");
const SISYPHUS_CI_ABORTED_VERIFY_WAVE_RECOVERY_TEXT = [
  "[session recovered - resume the launched evidence-gated CI verify wave now]",
  "Your previous Sisyphus CI turn already launched the bounded local verify wave before the session aborted.",
  "Do not restart discovery, re-read evidence, or burn a second blind rerun.",
  "Inspect the current verify artifacts and process state first, then continue from that exact verify state.",
  "If the bounded rerun is still alive, monitor it and harvest the TRX/artifacts when it finishes.",
  "If the bounded rerun died without a complete TRX, capture that failed verify state as evidence and continue the current dirty-batch loop from there.",
  "Do not emit another prose-only assistant turn before the next concrete tool action.",
].join("\n");
const recoveredEmptyAssistantMessageBySession = new Map<string, string>();
const recoveredPendingEmptyToolMessageBySession = new Map<string, string>();
const recoveredPendingEmptySisyphusToolMessageBySession = new Map<string, string>();
const recoveredSisyphusCiGuardrailToolMessageBySession = new Map<string, string>();
const recoveredPlannerCiBootstrapToolMessageBySession = new Map<string, string>();
const recoveredPlannerReasoningOnlyMessageBySession = new Map<string, string>();
const recoveredPlannerCiVisibleSummaryMessageBySession = new Map<string, string>();
const recoveredSisyphusCiReasoningOnlyMessageBySession = new Map<string, string>();
const recoveredInterruptedPlannerVisibleMessageBySession = new Map<string, string>();
const recoveredInterruptedSisyphusCiVisibleMessageBySession = new Map<string, string>();
const recoveredAbortedSisyphusCiVerifyWaveMessageBySession = new Map<string, string>();
const recoveredPlannerToolOnlyMessageBySession = new Map<string, string>();
const recoveredProviderBlockedErrorMessageBySession = new Map<string, string>();
const prometheusProviderBlockedRetryStateBySession = new Map<string, {
  providerID: string;
  modelID: string;
  startedAt: number;
  attempts: number;
}>();
const emptyAssistantRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const emptyAssistantRecoveryTimerMetaBySession = new Map<string, { messageID: string; delayMs: number }>();
const abortedToolRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const recentRecoverablePrometheusSnapshotBySession = new Map<string, AssistantRecoverySnapshot>();
type AssistantRecoverySnapshot = {
  messageID: string;
  agent?: string;
  hasVisibleContent: boolean;
  hasUserFacingContent: boolean;
  hasRecoverablePlannerInternalParts: boolean;
  hasStreamingDelta: boolean;
  pendingPrometheusTool?: string;
  pendingSisyphusCiTool?: string;
  erroredSisyphusCiGuardrailTool?: string;
  erroredPlannerCiBootstrapTool?: string;
};
const assistantRecoverySnapshotBySession = new Map<string, AssistantRecoverySnapshot>();
const RECOVERABLE_PENDING_PROMETHEUS_TOOLS = new Set(["write", "edit", "todowrite", "task"]);
const RECOVERABLE_PENDING_SISYPHUS_CI_TOOLS = new Set(["bash"]);

function clearSharedEmptyAssistantRecoveryTimer(sessionID: string): void {
  const timer = emptyAssistantRecoveryTimers.get(sessionID);
  if (!timer) return;
  clearTimeout(timer);
  emptyAssistantRecoveryTimers.delete(sessionID);
  emptyAssistantRecoveryTimerMetaBySession.delete(sessionID);
}

function clearSharedAbortedToolRecoveryTimer(sessionID: string): void {
  const timer = abortedToolRecoveryTimers.get(sessionID);
  if (!timer) return;
  clearTimeout(timer);
  abortedToolRecoveryTimers.delete(sessionID);
}

export function _resetEventRecoveryStateForTesting(): void {
  for (const sessionID of [...emptyAssistantRecoveryTimers.keys()]) {
    clearSharedEmptyAssistantRecoveryTimer(sessionID);
  }
  for (const sessionID of [...abortedToolRecoveryTimers.keys()]) {
    clearSharedAbortedToolRecoveryTimer(sessionID);
  }
  recoveredEmptyAssistantMessageBySession.clear();
  recoveredPendingEmptyToolMessageBySession.clear();
  recoveredPendingEmptySisyphusToolMessageBySession.clear();
  recoveredSisyphusCiGuardrailToolMessageBySession.clear();
  recoveredPlannerCiBootstrapToolMessageBySession.clear();
  recoveredPlannerReasoningOnlyMessageBySession.clear();
  recoveredPlannerCiVisibleSummaryMessageBySession.clear();
  recoveredSisyphusCiReasoningOnlyMessageBySession.clear();
  recoveredInterruptedPlannerVisibleMessageBySession.clear();
  recoveredInterruptedSisyphusCiVisibleMessageBySession.clear();
  recoveredAbortedSisyphusCiVerifyWaveMessageBySession.clear();
  recoveredProviderBlockedErrorMessageBySession.clear();
  prometheusProviderBlockedRetryStateBySession.clear();
  recentRecoverablePrometheusSnapshotBySession.clear();
  assistantRecoverySnapshotBySession.clear();
}

function hasRecentPrometheusRuntimeFallbackRecoveryGuard(
  sessionID: string,
  source: string,
  recoveryKind: string,
): boolean {
  const guarded = wasRecentRuntimeFallbackContinuationDispatched(sessionID, {
    guardMs: PROMETHEUS_RUNTIME_FALLBACK_RECOVERY_GUARD_MS,
  });
  if (guarded) {
    log(`[event] ${recoveryKind} recovery skipped: runtime fallback continuation already dispatched`, {
      sessionID,
      source,
    });
  }
  return guarded;
}

function normalizeProviderBlockedModelID(modelID: string | undefined): string | undefined {
  return typeof modelID === "string" && modelID.length > 0
    ? normalizeFallbackModelID(modelID)
    : undefined;
}

function touchPrometheusProviderBlockedRetryState(
  sessionID: string,
  currentModel: { providerID: string; modelID: string } | undefined,
): void {
  if (!currentModel?.providerID || !currentModel.modelID) {
    return;
  }

  const now = Date.now();
  const existingState = prometheusProviderBlockedRetryStateBySession.get(sessionID);
  const sameBlockedModel =
    !!existingState
    && existingState.providerID === currentModel.providerID
    && normalizeProviderBlockedModelID(existingState.modelID) === normalizeProviderBlockedModelID(currentModel.modelID);

  prometheusProviderBlockedRetryStateBySession.set(sessionID, {
    providerID: currentModel.providerID,
    modelID: currentModel.modelID,
    startedAt: sameBlockedModel && existingState ? existingState.startedAt : now,
    attempts: sameBlockedModel && existingState ? existingState.attempts : 0,
  });
}

function hasActivePrometheusProviderBlockedRetryWindow(sessionID: string): boolean {
  const existingState = prometheusProviderBlockedRetryStateBySession.get(sessionID);
  if (!existingState) {
    return false;
  }

  if (Date.now() - existingState.startedAt >= PROMETHEUS_PROVIDER_BLOCKED_SAME_MODEL_WINDOW_MS) {
    prometheusProviderBlockedRetryStateBySession.delete(sessionID);
    return false;
  }

  return true;
}

function isPrometheusPlannerAgent(agent: string | undefined): boolean {
  if (!agent) return false;
  const normalizedAgent = agent.toLowerCase();
  return normalizedAgent.includes("prometheus") || normalizedAgent.includes("plan builder");
}

function isAtlasPlanExecutorAgent(agent: string | undefined): boolean {
  if (!agent) return false;
  const normalizedAgent = agent.toLowerCase();
  return normalizedAgent.includes("atlas") || normalizedAgent.includes("plan executor");
}

function isSisyphusExecutorAgent(agent: string | undefined): boolean {
  if (!agent) return false;
  const normalizedAgent = agent.toLowerCase();
  return normalizedAgent.includes("sisyphus");
}

function messageIndicatesEvidenceGatedCi(message: RecoveryMessage | undefined): boolean {
  const parts = message?.parts
  if (!Array.isArray(parts) || parts.length === 0) return false
  const text = parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => (part.text ?? "").trim())
    .filter((partText) => partText.length > 0)
    .join("\n")

  if (text.length === 0) return false

  return text.includes("CI FAST PATH — ACTIVE")
    || text.includes(".sisyphus/evidence/")
    || text.includes("ci-loop-checkpoint.md")
    || text.includes("repair-log.md")
}

function assistantMessageHasUserFacingContent(parts: RecoveryMessagePart[] | undefined): boolean {
  if (!Array.isArray(parts) || parts.length === 0) return false;

  for (const part of parts) {
    const type = part?.type;
    if (!type) continue;

    if (type === "text") {
      if (typeof part.text === "string" && part.text.trim().length > 0) {
        return true;
      }
      continue;
    }

    if (type === "tool" || type === "tool_use" || type === "tool_result") {
      return true;
    }
  }

  return false;
}

function assistantMessageHasRecoverablePlannerInternalParts(parts: RecoveryMessagePart[] | undefined): boolean {
  if (!Array.isArray(parts) || parts.length === 0) return false;

  for (const part of parts) {
    const type = part?.type;
    if (!type) continue;

    if (type === "text") {
      if (typeof part.text === "string" && part.text.trim().length > 0) {
        return false;
      }
      continue;
    }

    if (type === "tool" || type === "tool_use" || type === "tool_result") {
      return false;
    }

    if (
      type === "thinking" ||
      type === "reasoning" ||
      type === "redacted_thinking" ||
      type === "meta" ||
      type === "step-start" ||
      type === "step-finish" ||
      type === "patch"
    ) {
      return true;
    }

    return true;
  }

  return false;
}

function assistantMessageHasVisibleContent(parts: RecoveryMessagePart[] | undefined): boolean {
  if (!Array.isArray(parts) || parts.length === 0) return false;

  for (const part of parts) {
    const type = part?.type;
    if (!type) continue;

    if (
      (type === "thinking" || type === "reasoning")
      && typeof part.text === "string"
      && part.text.trim().length > 0
    ) {
      return true;
    }

    if (
      type === "redacted_thinking" ||
      type === "meta" ||
      type === "compaction" ||
      type === "step-start" ||
      type === "step-finish" ||
      type === "patch"
    ) {
      continue;
    }

    if (type === "text") {
      if (typeof part.text === "string" && part.text.trim().length > 0) {
        return true;
      }
      continue;
    }

    if (type === "tool" || type === "tool_use" || type === "tool_result") {
      return true;
    }

    return true;
  }

  return false;
}

function assistantMessageHasRecoverableEmptyReasoningPrelude(parts: RecoveryMessagePart[] | undefined): boolean {
  if (!Array.isArray(parts) || parts.length === 0) return false;

  let hasStepStart = false;
  let hasEmptyReasoning = false;

  for (const part of parts) {
    const type = part?.type;
    if (!type) continue;

    if (type === "step-start") {
      hasStepStart = true;
      continue;
    }

    if (type === "reasoning" || type === "thinking") {
      if (typeof part.text === "string" && part.text.trim().length === 0) {
        hasEmptyReasoning = true;
        continue;
      }

      return false;
    }

    if (
      type === "redacted_thinking"
      || type === "meta"
      || type === "step-finish"
      || type === "patch"
      || type === "compaction"
    ) {
      continue;
    }

    if (type === "text") {
      if (typeof part.text === "string" && part.text.trim().length > 0) {
        return false;
      }
      continue;
    }

    if (type === "tool" || type === "tool_use" || type === "tool_result") {
      return false;
    }

    return false;
  }

  return hasStepStart && hasEmptyReasoning;
}

function findLastUserMessageMatching(
  messages: RecoveryMessage[],
  predicate: (message: RecoveryMessage) => boolean,
): RecoveryMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (getMessageRole(candidate) !== "user") {
      continue;
    }

    if (predicate(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function promptSimpleRecoveryContinuation(
  session: RecoveryResumeSessionApi | undefined,
  sessionID: string,
  directory: string | undefined,
  continuationText: string,
): Promise<boolean> {
  const promptInput = {
    path: { id: sessionID },
    body: { parts: [createInternalAgentTextPart(continuationText)] },
    ...(directory ? { query: { directory } } : {}),
  };

  try {
    if (typeof session?.promptAsync === "function") {
      await session.promptAsync(promptInput);
      return true;
    }
  } catch {}

  try {
    if (typeof session?.prompt === "function") {
      await session.prompt(promptInput);
      return true;
    }
  } catch {}

  return false;
}

async function resumeRecoveredPrometheusSession(
  ctx: { client: Record<string, unknown>; directory: string },
  sessionID: string,
  continuationText: string,
  resumeConfig: Parameters<typeof resumeSession>[1],
  session?: RecoveryResumeSessionApi,
): Promise<boolean> {
  const resumed = await resumeSession(ctx.client as never, resumeConfig);
  if (resumed) {
    return true;
  }

  return promptSimpleRecoveryContinuation(session, sessionID, ctx.directory, continuationText);
}

function isEmptyRecord(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}

function findRecoverablePendingPrometheusTool(
  parts: RecoveryMessagePart[] | undefined,
): { tool: string } | undefined {
  if (!Array.isArray(parts) || parts.length === 0) return undefined;

  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part?.type !== "tool" || typeof part.tool !== "string") {
      continue;
    }

    const tool = part.tool.trim().toLowerCase();
    if (!RECOVERABLE_PENDING_PROMETHEUS_TOOLS.has(tool)) {
      continue;
    }

    const status = part.state?.status;
    const isInterruptedAbortedTool =
      status === "error"
      && (
        part.state?.metadata?.interrupted === true
        || (
          typeof part.state?.error === "string"
          && part.state.error.toLowerCase().includes("tool execution aborted")
        )
      );

    if (status !== "pending" && !isInterruptedAbortedTool) {
      continue;
    }

    const raw = typeof part.raw === "string" ? part.raw.trim() : "";
    const input = part.state?.input;
    if (raw.length === 0 && (input === undefined || isEmptyRecord(input))) {
      return { tool };
    }
  }

  return undefined;
}

function findRecoverablePendingSisyphusCiTool(
  parts: RecoveryMessagePart[] | undefined,
): { tool: string } | undefined {
  if (!Array.isArray(parts) || parts.length === 0) return undefined;

  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part?.type !== "tool" || typeof part.tool !== "string") {
      continue;
    }

    const tool = part.tool.trim().toLowerCase();
    if (!RECOVERABLE_PENDING_SISYPHUS_CI_TOOLS.has(tool)) {
      continue;
    }

    if (part.state?.status !== "pending") {
      continue;
    }

    const raw = typeof part.raw === "string" ? part.raw.trim() : "";
    const input = part.state?.input;
    if (raw.length === 0 && (input === undefined || isEmptyRecord(input))) {
      return { tool };
    }
  }

  return undefined;
}

function findRecoverableErroredSisyphusCiGuardrailTool(
  parts: RecoveryMessagePart[] | undefined,
): { tool: string } | undefined {
  if (!Array.isArray(parts) || parts.length === 0) return undefined;

  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part?.type !== "tool" || typeof part.tool !== "string") {
      continue;
    }

    if (part.state?.status !== "error") {
      continue;
    }

    const errorText = typeof part.state?.error === "string" ? part.state.error.toLowerCase() : "";
    const isRecoverableGuardrailError =
      errorText.includes("post-dirty-batch exploration budget is exhausted")
      || errorText.includes("repeated dirty-batch code rereads are blocked")
      || errorText.includes("c# lsp_diagnostics is blocked");

    if (!isRecoverableGuardrailError) {
      continue;
    }

    return { tool: part.tool.trim().toLowerCase() };
  }

  return undefined;
}

function findRecoverableErroredPlannerCiBootstrapTool(
  parts: RecoveryMessagePart[] | undefined,
): { tool: string } | undefined {
  if (!Array.isArray(parts) || parts.length === 0) return undefined;

  for (const part of parts) {
    if (part?.type !== "tool" || typeof part.tool !== "string") continue;
    if (part.tool !== "read") continue;
    const status = part.state?.status;
    if (status !== "error") continue;
    const errorText = typeof part.state?.error === "string" ? part.state.error.toLowerCase() : "";
    if (!errorText) continue;
    if (
      errorText.includes("core ci evidence rereads are blocked")
      || errorText.includes("refusing legacy .sisyphus evidence alias read")
    ) {
      return { tool: part.tool };
    }
  }

  return undefined;
}

function findRecoverableLaunchedSisyphusCiVerifyWaveTool(
  parts: RecoveryMessagePart[] | undefined,
): { tool: string } | undefined {
  if (!Array.isArray(parts) || parts.length === 0) return undefined;

  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part?.type !== "tool" || typeof part.tool !== "string") {
      continue;
    }

    const tool = part.tool.trim().toLowerCase();
    if (tool !== "bash") {
      continue;
    }

    const raw = typeof part.raw === "string" ? part.raw : "";
    const inputCommand =
      isRecord(part.state?.input) && typeof part.state.input.command === "string"
        ? part.state.input.command
        : "";
    const command = `${raw}\n${inputCommand}`.toLowerCase();
    if (
      !command.includes("optimizer.playwrighttests/optimizer.playwrighttests.csproj")
      || !command.includes("dotnet test")
      || !command.includes("rerun_start")
      || !command.includes("rerun_precheck")
      || !command.includes("--results-directory")
    ) {
      continue;
    }

    return { tool };
  }

  return undefined;
}

function isInterruptedRecoverablePrometheusToolPart(
  part: RecoveryMessagePart | undefined,
): boolean {
  if (part?.type !== "tool") {
    return false;
  }

  const pendingTool = findRecoverablePendingPrometheusTool([part]);
  if (!pendingTool) {
    return false;
  }

  return part.state?.status === "error";
}

function hasNonEmptyUserFacingTextPart(parts: RecoveryMessagePart[] | undefined): boolean {
  return Array.isArray(parts) && parts.some((part) => (
    part?.type === "text"
    && typeof part.text === "string"
    && part.text.trim().length > 0
  ));
}

function isRecoverablePrometheusToolOnlyTurn(
  message: RecoveryMessage | undefined,
): boolean {
  if (!message || getMessageRole(message) !== "assistant") return false;
  if (!isPrometheusPlannerAgent(getMessageAgent(message))) return false;
  const finish = isRecord(message.info) && typeof message.info.finish === "string"
    ? message.info.finish
    : undefined;
  if (finish !== "tool-calls") return false;
  if (getMessageError(message)) return false;

  const parts = message.parts;
  if (!Array.isArray(parts) || parts.length === 0) return false;
  if (hasNonEmptyUserFacingTextPart(parts)) return false;
  if (findRecoverablePendingPrometheusTool(parts)) return false;

  let sawCompletedTool = false;
  for (const part of parts) {
    const type = part?.type;
    if (!type) return false;
    if (type === "tool") {
      const status = part.state?.status;
      if (status !== "completed") {
        return false;
      }
      sawCompletedTool = true;
      continue;
    }

    if (
      type === "reasoning"
      || type === "thinking"
      || type === "redacted_thinking"
      || type === "step-start"
      || type === "step-finish"
      || type === "meta"
      || type === "compaction"
      || type === "patch"
      || type === "tool_result"
      || type === "tool_use"
    ) {
      continue;
    }

    return false;
  }

  return sawCompletedTool;
}

function upsertAssistantRecoverySnapshot(
  sessionID: string,
  messageID: string,
  agent?: string,
): AssistantRecoverySnapshot {
  const existingSnapshot = assistantRecoverySnapshotBySession.get(sessionID);
  if (existingSnapshot?.messageID === messageID) {
    if (agent) {
      existingSnapshot.agent = agent;
    } else if (!existingSnapshot.agent) {
      existingSnapshot.agent = getSessionAgent(sessionID);
    }
    return existingSnapshot;
  }

  const snapshot: AssistantRecoverySnapshot = {
    messageID,
    agent: agent ?? existingSnapshot?.agent ?? getSessionAgent(sessionID),
    hasVisibleContent: false,
    hasUserFacingContent: false,
    hasRecoverablePlannerInternalParts: false,
    hasStreamingDelta: false,
  };
  assistantRecoverySnapshotBySession.set(sessionID, snapshot);
  return snapshot;
}

function getAssistantRecoverySnapshot(
  sessionID: string,
  expectedMessageID?: string,
): AssistantRecoverySnapshot | undefined {
  const snapshot = assistantRecoverySnapshotBySession.get(sessionID);
  if (!snapshot) return undefined;
  if (expectedMessageID && snapshot.messageID !== expectedMessageID) return undefined;
  return snapshot;
}

function rememberRecoverablePrometheusSnapshot(
  sessionID: string,
  snapshot: AssistantRecoverySnapshot | undefined,
): void {
  if (!snapshot || !isPrometheusPlannerAgent(snapshot.agent)) {
    return;
  }

  if (!snapshot.hasUserFacingContent && !snapshot.hasRecoverablePlannerInternalParts) {
    return;
  }

  recentRecoverablePrometheusSnapshotBySession.set(sessionID, { ...snapshot });
}

async function resumeCachedPendingPrometheusToolRecovery(
  ctx: { client: Record<string, unknown>; directory: string },
  sessionID: string,
  source: string,
  snapshot: AssistantRecoverySnapshot,
  agent: string | undefined,
  logLabel: string,
): Promise<boolean> {
  if (!snapshot.pendingPrometheusTool || !isPrometheusPlannerAgent(agent)) {
    return false;
  }

  const lastRecoveredMessageID = recoveredPendingEmptyToolMessageBySession.get(sessionID);
  if (lastRecoveredMessageID === snapshot.messageID) {
    log(`[event] ${logLabel} skipped: message already recovered`, {
      sessionID,
      source,
      lastMessageID: snapshot.messageID,
      tool: snapshot.pendingPrometheusTool,
    });
    return false;
  }

  const sessionApi = ctx.client as {
    session?: {
      abort?: (args: { path: { id: string } }) => Promise<unknown>;
      promptAsync?: (args: {
        path: { id: string };
        body: { parts: Array<Record<string, unknown>> };
        query?: { directory: string };
      }) => Promise<unknown>;
      prompt?: (args: {
        path: { id: string };
        body: { parts: Array<Record<string, unknown>> };
        query?: { directory: string };
      }) => Promise<unknown>;
    };
  };

  await sessionApi.session?.abort?.({ path: { id: sessionID } }).catch(() => {});

  const resumed = await resumeRecoveredPrometheusSession(
    ctx,
    sessionID,
    PROMETHEUS_EMPTY_TOOL_RECOVERY_TEXT,
    {
      sessionID,
      directory: ctx.directory,
      agent,
      model: getSessionModel(sessionID),
      continuationText: PROMETHEUS_EMPTY_TOOL_RECOVERY_TEXT,
    },
    sessionApi.session as RecoveryResumeSessionApi | undefined,
  );

  if (resumed) {
    recoveredPendingEmptyToolMessageBySession.set(sessionID, snapshot.messageID);
    log(`[event] recovered ${logLabel}`, {
      sessionID,
      source,
      messageID: snapshot.messageID,
      tool: snapshot.pendingPrometheusTool,
      agent,
    });
  }

  return resumed;
}

async function resumeCachedPendingSisyphusToolRecovery(
  ctx: { client: Record<string, unknown>; directory: string },
  sessionID: string,
  source: string,
  snapshot: AssistantRecoverySnapshot,
  agent: string | undefined,
  logLabel: string,
): Promise<boolean> {
  if (!snapshot.pendingSisyphusCiTool || !isSisyphusExecutorAgent(agent)) {
    return false;
  }

  const lastRecoveredMessageID = recoveredPendingEmptySisyphusToolMessageBySession.get(sessionID);
  if (lastRecoveredMessageID === snapshot.messageID) {
    log(`[event] ${logLabel} skipped: message already recovered`, {
      sessionID,
      source,
      lastMessageID: snapshot.messageID,
      tool: snapshot.pendingSisyphusCiTool,
    });
    return false;
  }

  const sessionApi = ctx.client as {
    session?: {
      abort?: (args: { path: { id: string } }) => Promise<unknown>;
      promptAsync?: (args: {
        path: { id: string };
        body: { parts: Array<Record<string, unknown>> };
        query?: { directory: string };
      }) => Promise<unknown>;
      prompt?: (args: {
        path: { id: string };
        body: { parts: Array<Record<string, unknown>> };
        query?: { directory: string };
      }) => Promise<unknown>;
    };
  };

  await sessionApi.session?.abort?.({ path: { id: sessionID } }).catch(() => {});

  const resumed = await resumeRecoveredPrometheusSession(
    ctx,
    sessionID,
    SISYPHUS_CI_EMPTY_TOOL_RECOVERY_TEXT,
    {
      sessionID,
      directory: ctx.directory,
      agent,
      model: getSessionModel(sessionID),
      continuationText: SISYPHUS_CI_EMPTY_TOOL_RECOVERY_TEXT,
    },
    sessionApi.session as RecoveryResumeSessionApi | undefined,
  );

  if (resumed) {
    recoveredPendingEmptySisyphusToolMessageBySession.set(sessionID, snapshot.messageID);
    log(`[event] recovered ${logLabel}`, {
      sessionID,
      source,
      messageID: snapshot.messageID,
      tool: snapshot.pendingSisyphusCiTool,
      agent,
    });
  }

  return resumed;
}

function updateAssistantRecoverySnapshotPart(
  sessionID: string,
  messageID: string,
  part: RecoveryMessagePart | undefined,
): void {
  if (!part) return;

  const snapshot = upsertAssistantRecoverySnapshot(sessionID, messageID);
  const type = part.type;
  if (!type) return;

  if (type === "text") {
    if (typeof part.text === "string" && part.text.trim().length > 0) {
      snapshot.hasVisibleContent = true;
      snapshot.hasUserFacingContent = true;
      snapshot.hasStreamingDelta = false;
    }
    rememberRecoverablePrometheusSnapshot(sessionID, snapshot);
    return;
  }

  if (type === "tool") {
    const pendingTool = findRecoverablePendingPrometheusTool([part]);
    if (pendingTool) {
      snapshot.pendingPrometheusTool = pendingTool.tool;
      rememberRecoverablePrometheusSnapshot(sessionID, snapshot);
      return;
    }

    const pendingSisyphusCiTool = findRecoverablePendingSisyphusCiTool([part]);
    if (pendingSisyphusCiTool) {
      snapshot.pendingSisyphusCiTool = pendingSisyphusCiTool.tool;
      return;
    }

    const erroredSisyphusCiGuardrailTool = findRecoverableErroredSisyphusCiGuardrailTool([part]);
    if (erroredSisyphusCiGuardrailTool) {
      snapshot.erroredSisyphusCiGuardrailTool = erroredSisyphusCiGuardrailTool.tool;
      return;
    }

    const erroredPlannerCiBootstrapTool = findRecoverableErroredPlannerCiBootstrapTool([part]);
    if (erroredPlannerCiBootstrapTool) {
      snapshot.erroredPlannerCiBootstrapTool = erroredPlannerCiBootstrapTool.tool;
      rememberRecoverablePrometheusSnapshot(sessionID, snapshot);
      return;
    }

    snapshot.hasVisibleContent = true;
    snapshot.hasUserFacingContent = true;
    snapshot.hasStreamingDelta = false;
    rememberRecoverablePrometheusSnapshot(sessionID, snapshot);
    return;
  }

  if (type === "tool_use" || type === "tool_result") {
    snapshot.hasVisibleContent = true;
    snapshot.hasUserFacingContent = true;
    snapshot.hasStreamingDelta = false;
    rememberRecoverablePrometheusSnapshot(sessionID, snapshot);
    return;
  }

  if (
    (type === "thinking" || type === "reasoning")
    && typeof part.text === "string"
    && part.text.trim().length > 0
  ) {
    snapshot.hasVisibleContent = true;
    snapshot.hasRecoverablePlannerInternalParts = true;
    rememberRecoverablePrometheusSnapshot(sessionID, snapshot);
    return;
  }

  if (
    type === "thinking"
    || type === "reasoning"
    || type === "redacted_thinking"
    || type === "meta"
    || type === "compaction"
    || type === "step-start"
    || type === "step-finish"
    || type === "patch"
  ) {
    snapshot.hasRecoverablePlannerInternalParts = true;
    rememberRecoverablePrometheusSnapshot(sessionID, snapshot);
    return;
  }

  snapshot.hasVisibleContent = true;
  snapshot.hasUserFacingContent = true;
  rememberRecoverablePrometheusSnapshot(sessionID, snapshot);
}

function hasVisibleAssistantDeltaContent(delta: unknown): boolean {
  if (typeof delta === "string") {
    return delta.trim().length > 0;
  }

  if (Array.isArray(delta)) {
    return delta.some((item) => hasVisibleAssistantDeltaContent(item));
  }

  if (!isRecord(delta)) {
    return false;
  }

  const directKeys = ["text", "delta", "value", "content", "output"];
  for (const key of directKeys) {
    if (hasVisibleAssistantDeltaContent(delta[key])) {
      return true;
    }
  }

  return false;
}

function updateAssistantRecoverySnapshotDelta(
  sessionID: string,
  messageID: string | undefined,
  delta: unknown,
): AssistantRecoverySnapshot | undefined {
  if (!hasVisibleAssistantDeltaContent(delta)) {
    return getAssistantRecoverySnapshot(sessionID, messageID);
  }

  const snapshot = messageID
    ? upsertAssistantRecoverySnapshot(sessionID, messageID)
    : getAssistantRecoverySnapshot(sessionID);
  if (!snapshot) {
    return undefined;
  }

  snapshot.hasVisibleContent = true;
  const recoveryAgent = snapshot.agent ?? getSessionAgent(sessionID)
  const isInternalStreamingDelta =
    (isPrometheusPlannerAgent(recoveryAgent) || isSisyphusExecutorAgent(recoveryAgent))
    && snapshot.hasRecoverablePlannerInternalParts
    && !snapshot.hasUserFacingContent;

  if (!isInternalStreamingDelta) {
    snapshot.hasUserFacingContent = true;
  }
  snapshot.hasStreamingDelta = true;
  return snapshot;
}

function getEmptyAssistantRecoveryDelayMs(sessionID: string, messageID: string): number {
  const snapshot = getAssistantRecoverySnapshot(sessionID, messageID);
  if (
    snapshot
    && !snapshot.pendingPrometheusTool
    && !snapshot.hasUserFacingContent
    && isPrometheusPlannerAgent(snapshot.agent ?? getSessionAgent(sessionID))
    && (
      snapshot.hasStreamingDelta
      || snapshot.hasRecoverablePlannerInternalParts
    )
  ) {
    return PROMETHEUS_STREAMING_DELTA_RECOVERY_DELAY_MS;
  }

  return EMPTY_ASSISTANT_RECOVERY_DELAY_MS;
}

function getEventPropertiesSessionID(properties: unknown): string | undefined {
  return isRecord(properties)
    ? getRuntimeFallbackSessionID(properties)
    : undefined;
}

function getMessagePartUpdatedSessionID(
  properties: Record<string, unknown> | undefined,
  part: (RecoveryMessagePart & {
    sessionID?: string;
    sessionId?: string;
  }) | undefined,
): string | undefined {
  if (typeof part?.sessionID === "string" && part.sessionID.length > 0) {
    return part.sessionID;
  }

  if (typeof part?.sessionId === "string" && part.sessionId.length > 0) {
    return part.sessionId;
  }

  return getEventPropertiesSessionID(properties);
}

function getMessagePartUpdatedMessageID(
  properties: Record<string, unknown> | undefined,
  part: (RecoveryMessagePart & {
    messageID?: string;
    messageId?: string;
  }) | undefined,
  sessionID?: string,
): string | undefined {
  if (typeof part?.messageID === "string" && part.messageID.length > 0) {
    return part.messageID;
  }

  if (typeof part?.messageId === "string" && part.messageId.length > 0) {
    return part.messageId;
  }

  if (typeof properties?.messageID === "string" && properties.messageID.length > 0) {
    return properties.messageID;
  }

  if (typeof properties?.messageId === "string" && properties.messageId.length > 0) {
    return properties.messageId;
  }

  const info = isRecord(properties?.info) ? properties.info : undefined;
  if (info) {
    if (typeof info.messageID === "string" && info.messageID.length > 0) {
      return info.messageID;
    }

    if (typeof info.messageId === "string" && info.messageId.length > 0) {
      return info.messageId;
    }

    if (typeof info.id === "string" && info.id.length > 0) {
      return info.id;
    }
  }

  if (!sessionID) {
    return undefined;
  }

  return getAssistantRecoverySnapshot(sessionID)?.messageID;
}

async function maybeRecoverIdleEmptyAssistantMessage(
  ctx: { client: Record<string, unknown>; directory: string },
  sessionID: string,
  expectedMessageID?: string,
  source = "session.status.idle",
): Promise<boolean> {
  if (hasActivePrometheusProviderBlockedRetryWindow(sessionID)) {
    log("[event] empty assistant recovery skipped: provider-blocked retry window active", {
      sessionID,
      source,
    });
    return false;
  }

  const session = ctx.client["session"] as { messages?: (args: { path: { id: string } }) => Promise<unknown> } | undefined;
  const readMessages = session?.messages;
  if (typeof readMessages !== "function") {
    log("[event] empty assistant recovery skipped: session.messages unavailable", { sessionID, source });
    return false;
  }

  const response = await readMessages({
    path: { id: sessionID },
  });
  const messages = normalizeSDKResponse(response, [] as RecoveryMessage[], {
    preferResponseOnMissingData: true,
  });
  const lastMessage = messages[messages.length - 1];
  const lastMessageID = getMessageID(lastMessage);

  if (!lastMessageID) {
    log("[event] empty assistant recovery skipped: no last message", { sessionID, source });
    return false;
  }
  if (expectedMessageID && lastMessageID !== expectedMessageID) {
    log("[event] empty assistant recovery skipped: latest message changed", {
      sessionID,
      source,
      expectedMessageID,
      lastMessageID,
    });
    return false;
  }
  const lastMessageRole = getMessageRole(lastMessage);
  if (lastMessageRole !== "assistant") {
    log("[event] empty assistant recovery skipped: latest message is not assistant", {
      sessionID,
      source,
      lastMessageID,
      role: lastMessageRole,
    });
    return false;
  }
  if (getMessageError(lastMessage)) {
    log("[event] empty assistant recovery skipped: assistant message already has error", {
      sessionID,
      source,
      lastMessageID,
    });
    return false;
  }
  if (assistantMessageHasVisibleContent(lastMessage.parts)) {
    log("[event] empty assistant recovery skipped: assistant message already has visible content", {
      sessionID,
      source,
      lastMessageID,
      partCount: Array.isArray(lastMessage.parts) ? lastMessage.parts.length : 0,
    });
    return false;
  }

  const lastRecoveredMessageID = recoveredEmptyAssistantMessageBySession.get(sessionID);
  if (lastRecoveredMessageID === lastMessageID) {
    log("[event] empty assistant recovery skipped: message already recovered", {
      sessionID,
      source,
      lastMessageID,
    });
    return false;
  }

  log("[event] attempting empty assistant recovery", {
    sessionID,
    source,
    lastMessageID,
    partCount: Array.isArray(lastMessage.parts) ? lastMessage.parts.length : 0,
  });

  const recoveryResult = await fixEmptyMessagesWithSDK({
    sessionID,
    client: ctx.client as never,
    placeholderText: EMPTY_ASSISTANT_PLACEHOLDER_TEXT,
  });
  if (!recoveryResult.fixed) {
    log("[event] empty assistant recovery failed during message patch", {
      sessionID,
      source,
      lastMessageID,
      fixedMessageIds: recoveryResult.fixedMessageIds,
      scannedEmptyCount: recoveryResult.scannedEmptyCount,
    });
    return false;
  }

  const lastUser = findLastUserMessage(messages as never);
  const resumeConfig = extractResumeConfig(lastUser as never, sessionID);
  resumeConfig.directory = ctx.directory;
  const resumed = await resumeRecoveredPrometheusSession(
    ctx,
    sessionID,
    EMPTY_ASSISTANT_PLACEHOLDER_TEXT,
    resumeConfig,
    ctx.client["session"] as RecoveryResumeSessionApi | undefined,
  );

  if (resumed) {
    recoveredEmptyAssistantMessageBySession.set(sessionID, lastMessageID);
    log("[event] recovered idle empty assistant message", {
      sessionID,
      source,
      messageID: lastMessageID,
      fixedMessageIds: recoveryResult.fixedMessageIds,
    });
  } else {
    log("[event] empty assistant recovery patched message but resume failed", {
      sessionID,
      source,
      messageID: lastMessageID,
      fixedMessageIds: recoveryResult.fixedMessageIds,
    });
  }

  return resumed;
}

async function maybeRecoverPrometheusReasoningOnlyAssistantMessage(
  ctx: { client: Record<string, unknown>; directory: string },
  sessionID: string,
  expectedMessageID?: string,
  source = "session.status.idle",
  options?: { abortBeforeResume?: boolean },
): Promise<boolean> {
  if (hasRecentPrometheusRuntimeFallbackRecoveryGuard(sessionID, source, "planner reasoning-only")) {
    return false;
  }

  if (hasActivePrometheusProviderBlockedRetryWindow(sessionID)) {
    log("[event] planner reasoning-only recovery skipped: provider-blocked retry window active", {
      sessionID,
      source,
    });
    return false;
  }

  const cachedSnapshot = getAssistantRecoverySnapshot(sessionID, expectedMessageID);
  const cachedAgent = cachedSnapshot?.agent ?? getSessionAgent(sessionID);
  const sessionApi = ctx.client as {
    session?: {
      abort?: (args: { path: { id: string } }) => Promise<unknown>;
    };
  };
  if (
    cachedSnapshot
    && isPrometheusPlannerAgent(cachedAgent)
    && !cachedSnapshot.hasUserFacingContent
    && cachedSnapshot.hasRecoverablePlannerInternalParts
  ) {
    const lastRecoveredMessageID = recoveredPlannerReasoningOnlyMessageBySession.get(sessionID);
    if (lastRecoveredMessageID === cachedSnapshot.messageID) {
      log("[event] planner reasoning-only recovery skipped: message already recovered", {
        sessionID,
        source,
        lastMessageID: cachedSnapshot.messageID,
      });
      return false;
    }

    if (options?.abortBeforeResume) {
      await sessionApi.session?.abort?.({ path: { id: sessionID } }).catch(() => {});
    }

    const resumeConfig = {
      sessionID,
      directory: ctx.directory,
      agent: cachedAgent,
      model: getSessionModel(sessionID),
      continuationText: PROMETHEUS_REASONING_ONLY_RECOVERY_TEXT,
    };
    const resumed = await resumeRecoveredPrometheusSession(
      ctx,
      sessionID,
      PROMETHEUS_REASONING_ONLY_RECOVERY_TEXT,
      resumeConfig,
      sessionApi.session as RecoveryResumeSessionApi | undefined,
    );
    if (resumed) {
      recoveredPlannerReasoningOnlyMessageBySession.set(sessionID, cachedSnapshot.messageID);
      log("[event] recovered cached planner reasoning-only message", {
        sessionID,
        source,
        messageID: cachedSnapshot.messageID,
        agent: cachedAgent,
      });
    }

    return resumed;
  }

  const session = ctx.client["session"] as {
    messages?: (args: { path: { id: string } }) => Promise<unknown>;
    abort?: (args: { path: { id: string } }) => Promise<unknown>;
    promptAsync?: (args: {
      path: { id: string };
      body: { parts: Array<Record<string, unknown>> };
    }) => Promise<unknown>;
    prompt?: (args: {
      path: { id: string };
      body: { parts: Array<Record<string, unknown>> };
    }) => Promise<unknown>;
  } | undefined;
  const readMessages = session?.messages;
  if (typeof readMessages !== "function") {
    log("[event] planner reasoning-only recovery skipped: session.messages unavailable", { sessionID, source });
    return false;
  }

  let response: unknown;
  try {
    response = await readMessages({
      path: { id: sessionID },
    });
  } catch (error) {
    log("[event] planner reasoning-only recovery skipped: session.messages failed", {
      sessionID,
      source,
      error,
    });
    return false;
  }
  const messages = normalizeSDKResponse(response, [] as RecoveryMessage[], {
    preferResponseOnMissingData: true,
  });
  const lastMessage = messages[messages.length - 1];
  const lastMessageID = getMessageID(lastMessage);
  const lastMessageAgent = getMessageAgent(lastMessage);

  if (!lastMessageID) return false;
  if (expectedMessageID && lastMessageID !== expectedMessageID) return false;
  if (getMessageRole(lastMessage) !== "assistant") return false;
  if (getMessageError(lastMessage)) return false;
  if (!isPrometheusPlannerAgent(lastMessageAgent)) return false;
  if (assistantMessageHasUserFacingContent(lastMessage.parts)) return false;
  if (
    !assistantMessageHasVisibleContent(lastMessage.parts)
    && !assistantMessageHasRecoverablePlannerInternalParts(lastMessage.parts)
  ) {
    return false;
  }

  const lastRecoveredMessageID = recoveredPlannerReasoningOnlyMessageBySession.get(sessionID);
  if (lastRecoveredMessageID === lastMessageID) {
    log("[event] planner reasoning-only recovery skipped: message already recovered", {
      sessionID,
      source,
      lastMessageID,
    });
    return false;
  }

  if (options?.abortBeforeResume) {
    await session?.abort?.({ path: { id: sessionID } }).catch(() => {});
  }

  const lastUser = findLastUserMessage(messages as never);
  const resumeConfig = extractResumeConfig(lastUser as never, sessionID);
  resumeConfig.directory = ctx.directory;
  resumeConfig.continuationText = PROMETHEUS_REASONING_ONLY_RECOVERY_TEXT;
  const resumed = await resumeRecoveredPrometheusSession(
    ctx,
    sessionID,
    PROMETHEUS_REASONING_ONLY_RECOVERY_TEXT,
    resumeConfig,
    session,
  );

  if (resumed) {
    recoveredPlannerReasoningOnlyMessageBySession.set(sessionID, lastMessageID);
    log("[event] recovered idle planner reasoning-only message", {
      sessionID,
      source,
      messageID: lastMessageID,
      agent: lastMessageAgent,
    });
  }

  return resumed;
}

async function maybeRecoverSisyphusCiReasoningOnlyAssistantMessage(
  ctx: { client: Record<string, unknown>; directory: string },
  sessionID: string,
  expectedMessageID?: string,
  source = "session.status.idle",
  options?: { abortBeforeResume?: boolean },
): Promise<boolean> {
  const session = ctx.client["session"] as {
    messages?: (args: { path: { id: string } }) => Promise<unknown>;
    abort?: (args: { path: { id: string } }) => Promise<unknown>;
    promptAsync?: (args: {
      path: { id: string };
      body: { parts: Array<Record<string, unknown>> };
    }) => Promise<unknown>;
    prompt?: (args: {
      path: { id: string };
      body: { parts: Array<Record<string, unknown>> };
    }) => Promise<unknown>;
  } | undefined;
  const readMessages = session?.messages;
  if (typeof readMessages !== "function") {
    log("[event] sisyphus CI reasoning-only recovery skipped: session.messages unavailable", { sessionID, source });
    return false;
  }

  let response: unknown;
  try {
    response = await readMessages({
      path: { id: sessionID },
    });
  } catch (error) {
    log("[event] sisyphus CI reasoning-only recovery skipped: session.messages failed", {
      sessionID,
      source,
      error,
    });
    return false;
  }

  const messages = normalizeSDKResponse(response, [] as RecoveryMessage[], {
    preferResponseOnMissingData: true,
  });
  const lastMessage = messages[messages.length - 1];
  const lastMessageID = getMessageID(lastMessage);
  const lastMessageAgent = getMessageAgent(lastMessage);
  if (!lastMessageID) return false;
  if (expectedMessageID && lastMessageID !== expectedMessageID) return false;
  if (getMessageRole(lastMessage) !== "assistant") return false;
  if (getMessageError(lastMessage)) return false;
  if (!isSisyphusExecutorAgent(lastMessageAgent)) return false;
  if (assistantMessageHasUserFacingContent(lastMessage.parts)) return false;
  if (
    !assistantMessageHasVisibleContent(lastMessage.parts)
    && !assistantMessageHasRecoverableEmptyReasoningPrelude(lastMessage.parts)
  ) {
    return false;
  }
  if (!assistantMessageHasRecoverablePlannerInternalParts(lastMessage.parts)) return false;

  const lastEvidenceGatedUser = findLastUserMessageMatching(
    messages as RecoveryMessage[],
    (message) => messageIndicatesEvidenceGatedCi(message),
  );
  const lastUser = lastEvidenceGatedUser ?? findLastUserMessage(messages as never);
  if (!messageIndicatesEvidenceGatedCi(lastUser as RecoveryMessage | undefined)) {
    return false;
  }

  const lastRecoveredMessageID = recoveredSisyphusCiReasoningOnlyMessageBySession.get(sessionID);
  if (lastRecoveredMessageID === lastMessageID) {
    log("[event] sisyphus CI reasoning-only recovery skipped: message already recovered", {
      sessionID,
      source,
      lastMessageID,
    });
    return false;
  }

  if (options?.abortBeforeResume) {
    await session?.abort?.({ path: { id: sessionID } }).catch(() => {});
  }

  const resumeConfig = extractResumeConfig(lastUser as never, sessionID);
  resumeConfig.directory = ctx.directory;
  resumeConfig.continuationText = SISYPHUS_CI_REASONING_ONLY_RECOVERY_TEXT;
  const resumed = await resumeRecoveredPrometheusSession(
    ctx,
    sessionID,
    SISYPHUS_CI_REASONING_ONLY_RECOVERY_TEXT,
    resumeConfig,
    session,
  );

  if (resumed) {
    recoveredSisyphusCiReasoningOnlyMessageBySession.set(sessionID, lastMessageID);
    log("[event] recovered idle sisyphus CI reasoning-only message", {
      sessionID,
      source,
      messageID: lastMessageID,
      agent: lastMessageAgent,
    });
  }

  return resumed;
}

async function maybeRecoverSisyphusCiPendingEmptyToolCall(
  ctx: { client: Record<string, unknown>; directory: string },
  sessionID: string,
  expectedMessageID?: string,
  source = "session.status.idle",
): Promise<boolean> {
  const cachedSnapshot = getAssistantRecoverySnapshot(sessionID, expectedMessageID);
  const cachedAgent = cachedSnapshot?.agent ?? getSessionAgent(sessionID);
  const tryCachedSnapshotRecovery = async (reason: string): Promise<boolean> => {
    if (!cachedSnapshot) {
      return false;
    }

    return resumeCachedPendingSisyphusToolRecovery(
      ctx,
      sessionID,
      `${source}:${reason}`,
      cachedSnapshot,
      cachedAgent,
      "cached pending empty sisyphus CI tool call",
    );
  };

  const session = ctx.client["session"] as {
    messages?: (args: { path: { id: string } }) => Promise<unknown>;
    abort?: (args: { path: { id: string } }) => Promise<unknown>;
    promptAsync?: (args: {
      path: { id: string };
      body: { parts: Array<Record<string, unknown>> };
      query?: { directory: string };
    }) => Promise<unknown>;
    prompt?: (args: {
      path: { id: string };
      body: { parts: Array<Record<string, unknown>> };
      query?: { directory: string };
    }) => Promise<unknown>;
  } | undefined;
  const readMessages = session?.messages;
  if (typeof readMessages !== "function") {
    log("[event] sisyphus CI empty tool recovery skipped: session.messages unavailable", { sessionID, source });
    return tryCachedSnapshotRecovery("session-messages-unavailable");
  }

  let response: unknown;
  try {
    response = await readMessages({
      path: { id: sessionID },
    });
  } catch (error) {
    log("[event] sisyphus CI empty tool recovery skipped: session.messages failed", {
      sessionID,
      source,
      error,
    });
    return tryCachedSnapshotRecovery("session-messages-failed");
  }

  const messages = normalizeSDKResponse(response, [] as RecoveryMessage[], {
    preferResponseOnMissingData: true,
  });
  const lastMessage = messages[messages.length - 1];
  const lastMessageID = getMessageID(lastMessage);
  const lastMessageAgent = getMessageAgent(lastMessage);
  if (!lastMessageID) {
    return tryCachedSnapshotRecovery("missing-latest-message");
  }
  if (expectedMessageID && lastMessageID !== expectedMessageID) return false;
  if (getMessageRole(lastMessage) !== "assistant") return false;
  if (getMessageError(lastMessage)) return false;
  if (!isSisyphusExecutorAgent(lastMessageAgent)) return false;

  const pendingTool = findRecoverablePendingSisyphusCiTool(lastMessage.parts);
  if (!pendingTool) {
    return tryCachedSnapshotRecovery("live-transcript-missing-pending-tool");
  }

  const lastEvidenceGatedUser = findLastUserMessageMatching(
    messages as RecoveryMessage[],
    (message) => messageIndicatesEvidenceGatedCi(message),
  );
  const lastUser = lastEvidenceGatedUser ?? findLastUserMessage(messages as never);
  if (!messageIndicatesEvidenceGatedCi(lastUser as RecoveryMessage | undefined)) {
    return false;
  }

  const lastRecoveredMessageID = recoveredPendingEmptySisyphusToolMessageBySession.get(sessionID);
  if (lastRecoveredMessageID === lastMessageID) {
    log("[event] sisyphus CI empty tool recovery skipped: message already recovered", {
      sessionID,
      source,
      lastMessageID,
      tool: pendingTool.tool,
    });
    return false;
  }

  await session?.abort?.({ path: { id: sessionID } }).catch(() => {});

  const resumeConfig = extractResumeConfig(lastUser as never, sessionID);
  resumeConfig.directory = ctx.directory;
  resumeConfig.continuationText = SISYPHUS_CI_EMPTY_TOOL_RECOVERY_TEXT;
  const resumed = await resumeRecoveredPrometheusSession(
    ctx,
    sessionID,
    SISYPHUS_CI_EMPTY_TOOL_RECOVERY_TEXT,
    resumeConfig,
    session as RecoveryResumeSessionApi | undefined,
  );

  if (resumed) {
    recoveredPendingEmptySisyphusToolMessageBySession.set(sessionID, lastMessageID);
    log("[event] recovered pending empty sisyphus CI tool call", {
      sessionID,
      source,
      messageID: lastMessageID,
      tool: pendingTool.tool,
      agent: lastMessageAgent,
    });
  }

  return resumed;
}

async function maybeRecoverSisyphusCiGuardrailToolError(
  ctx: { client: Record<string, unknown>; directory: string },
  sessionID: string,
  expectedMessageID?: string,
  source = "session.status.idle",
): Promise<boolean> {
  const session = ctx.client["session"] as {
    messages?: (args: { path: { id: string } }) => Promise<unknown>;
    abort?: (args: { path: { id: string } }) => Promise<unknown>;
    promptAsync?: (args: {
      path: { id: string };
      body: { parts: Array<Record<string, unknown>> };
      query?: { directory: string };
    }) => Promise<unknown>;
    prompt?: (args: {
      path: { id: string };
      body: { parts: Array<Record<string, unknown>> };
      query?: { directory: string };
    }) => Promise<unknown>;
  } | undefined;
  const readMessages = session?.messages;
  if (typeof readMessages !== "function") {
    return false;
  }

  let response: unknown;
  try {
    response = await readMessages({
      path: { id: sessionID },
    });
  } catch {
    return false;
  }

  const messages = normalizeSDKResponse(response, [] as RecoveryMessage[], {
    preferResponseOnMissingData: true,
  });
  const lastMessage = messages[messages.length - 1];
  const lastMessageID = getMessageID(lastMessage);
  const lastMessageAgent = getMessageAgent(lastMessage);
  if (!lastMessageID) return false;
  if (expectedMessageID && lastMessageID !== expectedMessageID) return false;
  if (getMessageRole(lastMessage) !== "assistant") return false;
  if (getMessageError(lastMessage)) return false;
  if (!isSisyphusExecutorAgent(lastMessageAgent)) return false;
  const latestRecoverableTool = findRecoverableErroredSisyphusCiGuardrailTool(lastMessage.parts);
  const latestMessageIsRecoverableGuardrailTurn = !!latestRecoverableTool;
  if (
    !latestMessageIsRecoverableGuardrailTurn
    && assistantMessageHasUserFacingContent(lastMessage.parts)
  ) return false;
  if (
    !latestMessageIsRecoverableGuardrailTurn
    && !assistantMessageHasRecoverablePlannerInternalParts(lastMessage.parts)
  ) return false;

  let lastRecoverableTool: { tool: string } | undefined = latestRecoverableTool;
  let lastRecoverableMessageID: string | undefined = latestMessageIsRecoverableGuardrailTurn
    ? lastMessageID
    : undefined;
  if (!lastRecoverableTool || !lastRecoverableMessageID) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (getMessageRole(candidate) !== "assistant" || !isSisyphusExecutorAgent(getMessageAgent(candidate))) {
        continue;
      }
      const recoverableTool = findRecoverableErroredSisyphusCiGuardrailTool(candidate.parts);
      if (recoverableTool) {
        lastRecoverableTool = recoverableTool;
        lastRecoverableMessageID = getMessageID(candidate);
        break;
      }
    }
  }

  if (!lastRecoverableTool || !lastRecoverableMessageID) {
    return false;
  }

  const lastEvidenceGatedUser = findLastUserMessageMatching(
    messages as RecoveryMessage[],
    (message) => messageIndicatesEvidenceGatedCi(message),
  );
  const lastUser = lastEvidenceGatedUser ?? findLastUserMessage(messages as never);
  if (!messageIndicatesEvidenceGatedCi(lastUser as RecoveryMessage | undefined)) {
    return false;
  }

  const lastRecoveredMessageID = recoveredSisyphusCiGuardrailToolMessageBySession.get(sessionID);
  if (lastRecoveredMessageID === lastMessageID || lastRecoveredMessageID === lastRecoverableMessageID) {
    return false;
  }

  await session?.abort?.({ path: { id: sessionID } }).catch(() => {});

  const resumeConfig = extractResumeConfig(lastUser as never, sessionID);
  resumeConfig.directory = ctx.directory;
  resumeConfig.continuationText = SISYPHUS_CI_GUARDRAIL_TOOL_ERROR_RECOVERY_TEXT;
  const resumed = await resumeRecoveredPrometheusSession(
    ctx,
    sessionID,
    SISYPHUS_CI_GUARDRAIL_TOOL_ERROR_RECOVERY_TEXT,
    resumeConfig,
    session as RecoveryResumeSessionApi | undefined,
  );

  if (resumed) {
    recoveredSisyphusCiGuardrailToolMessageBySession.set(sessionID, lastRecoverableMessageID);
    log("[event] recovered sisyphus CI guardrail tool error", {
      sessionID,
      source,
      messageID: lastRecoverableMessageID,
      tool: lastRecoverableTool.tool,
      agent: lastMessageAgent,
    });
  }

  return resumed;
}

async function maybeRecoverPlannerCiBootstrapToolError(
  ctx: { client: Record<string, unknown>; directory: string },
  sessionID: string,
  expectedMessageID?: string,
  source = "session.status.idle",
): Promise<boolean> {
  if (hasRecentPrometheusRuntimeFallbackRecoveryGuard(sessionID, source, "planner ci-bootstrap tool-error")) {
    return false;
  }

  const session = ctx.client["session"] as {
    messages?: (args: { path: { id: string } }) => Promise<unknown>;
    abort?: (args: { path: { id: string } }) => Promise<unknown>;
    promptAsync?: (args: {
      path: { id: string };
      body: { parts: Array<Record<string, unknown>> };
      query?: { directory: string };
    }) => Promise<unknown>;
    prompt?: (args: {
      path: { id: string };
      body: { parts: Array<Record<string, unknown>> };
      query?: { directory: string };
    }) => Promise<unknown>;
  } | undefined;
  const readMessages = session?.messages;
  if (typeof readMessages !== "function") {
    return false;
  }

  let response: unknown;
  try {
    response = await readMessages({
      path: { id: sessionID },
    });
  } catch {
    return false;
  }

  const messages = normalizeSDKResponse(response, [] as RecoveryMessage[], {
    preferResponseOnMissingData: true,
  });
  const lastMessage = messages[messages.length - 1];
  const lastMessageID = getMessageID(lastMessage);
  const lastMessageAgent = getMessageAgent(lastMessage);
  if (!lastMessageID) return false;
  if (expectedMessageID && lastMessageID !== expectedMessageID) return false;
  if (getMessageRole(lastMessage) !== "assistant") return false;
  if (getMessageError(lastMessage)) return false;
  const plannerLikeAgent = isPrometheusPlannerAgent(lastMessageAgent) || isAtlasPlanExecutorAgent(lastMessageAgent);
  if (!plannerLikeAgent) return false;

  const latestRecoverableTool = findRecoverableErroredPlannerCiBootstrapTool(lastMessage.parts);
  const latestMessageIsRecoverableGuardrailTurn = !!latestRecoverableTool;
  if (
    !latestMessageIsRecoverableGuardrailTurn
    && assistantMessageHasUserFacingContent(lastMessage.parts)
  ) return false;
  if (
    !latestMessageIsRecoverableGuardrailTurn
    && !assistantMessageHasRecoverablePlannerInternalParts(lastMessage.parts)
  ) return false;

  let lastRecoverableTool: { tool: string } | undefined = latestRecoverableTool;
  let lastRecoverableMessageID: string | undefined = latestMessageIsRecoverableGuardrailTurn
    ? lastMessageID
    : undefined;
  if (!lastRecoverableTool || !lastRecoverableMessageID) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      const candidateAgent = getMessageAgent(candidate);
      if (
        getMessageRole(candidate) !== "assistant"
        || (!isPrometheusPlannerAgent(candidateAgent) && !isAtlasPlanExecutorAgent(candidateAgent))
      ) {
        continue;
      }
      const recoverableTool = findRecoverableErroredPlannerCiBootstrapTool(candidate.parts);
      if (recoverableTool) {
        lastRecoverableTool = recoverableTool;
        lastRecoverableMessageID = getMessageID(candidate);
        break;
      }
    }
  }

  if (!lastRecoverableTool || !lastRecoverableMessageID) {
    return false;
  }

  const lastEvidenceGatedUser = findLastUserMessageMatching(
    messages as RecoveryMessage[],
    (message) => messageIndicatesEvidenceGatedCi(message),
  );
  const lastUser = lastEvidenceGatedUser ?? findLastUserMessage(messages as never);
  if (!messageIndicatesEvidenceGatedCi(lastUser as RecoveryMessage | undefined)) {
    return false;
  }

  const lastRecoveredMessageID = recoveredPlannerCiBootstrapToolMessageBySession.get(sessionID);
  if (lastRecoveredMessageID === lastMessageID || lastRecoveredMessageID === lastRecoverableMessageID) {
    return false;
  }

  await session?.abort?.({ path: { id: sessionID } }).catch(() => {});

  const resumeConfig = extractResumeConfig(lastUser as never, sessionID);
  resumeConfig.directory = ctx.directory;
  resumeConfig.continuationText = PROMETHEUS_CI_BOOTSTRAP_TOOL_ERROR_RECOVERY_TEXT;
  const resumed = await resumeRecoveredPrometheusSession(
    ctx,
    sessionID,
    PROMETHEUS_CI_BOOTSTRAP_TOOL_ERROR_RECOVERY_TEXT,
    resumeConfig,
    session as RecoveryResumeSessionApi | undefined,
  );

  if (resumed) {
    recoveredPlannerCiBootstrapToolMessageBySession.set(sessionID, lastRecoverableMessageID);
    log("[event] recovered planner CI bootstrap tool error", {
      sessionID,
      source,
      messageID: lastRecoverableMessageID,
      tool: lastRecoverableTool.tool,
      agent: lastMessageAgent,
    });
  }

  return resumed;
}

async function maybeRecoverPrometheusInterruptedVisibleAssistantMessage(
  ctx: { client: Record<string, unknown>; directory: string },
  sessionID: string,
  expectedMessageID?: string,
  source = "session.status.idle",
): Promise<boolean> {
  if (hasRecentPrometheusRuntimeFallbackRecoveryGuard(sessionID, source, "planner interrupted-visible")) {
    return false;
  }

  if (hasActivePrometheusProviderBlockedRetryWindow(sessionID)) {
    log("[event] planner interrupted-visible recovery skipped: provider-blocked retry window active", {
      sessionID,
      source,
    });
    return false;
  }

  const session = ctx.client["session"] as {
    messages?: (args: { path: { id: string } }) => Promise<unknown>;
  } | undefined;
  const readMessages = session?.messages;
  if (typeof readMessages !== "function") {
    log("[event] planner interrupted-visible recovery skipped: session.messages unavailable", { sessionID, source });
    return false;
  }

  let response: unknown;
  try {
    response = await readMessages({
      path: { id: sessionID },
    });
  } catch (error) {
    log("[event] planner interrupted-visible recovery skipped: session.messages failed", {
      sessionID,
      source,
      error,
    });
    return false;
  }

  const messages = normalizeSDKResponse(response, [] as RecoveryMessage[], {
    preferResponseOnMissingData: true,
  });
  const lastMessage = messages[messages.length - 1];
  const lastMessageID = getMessageID(lastMessage);
  const lastMessageAgent = getMessageAgent(lastMessage);
  const lastMessageFinish = isRecord(lastMessage?.info) && typeof lastMessage.info.finish === "string"
    ? lastMessage.info.finish
    : undefined;

  if (!lastMessageID) return false;
  if (expectedMessageID && lastMessageID !== expectedMessageID) return false;
  if (getMessageRole(lastMessage) !== "assistant") return false;
  if (getMessageError(lastMessage)) return false;
  if (!isPrometheusPlannerAgent(lastMessageAgent)) return false;
  if (lastMessageFinish !== "other") return false;
  if (!assistantMessageHasUserFacingContent(lastMessage.parts)) return false;

  const lastRecoveredMessageID = recoveredInterruptedPlannerVisibleMessageBySession.get(sessionID);
  if (lastRecoveredMessageID === lastMessageID) {
    log("[event] planner interrupted-visible recovery skipped: message already recovered", {
      sessionID,
      source,
      lastMessageID,
    });
    return false;
  }

  const lastUser = findLastUserMessage(messages as never);
  const resumeConfig = extractResumeConfig(lastUser as never, sessionID);
  resumeConfig.directory = ctx.directory;
  resumeConfig.continuationText = PROMETHEUS_INTERRUPTED_VISIBLE_TURN_RECOVERY_TEXT;
  const resumed = await resumeRecoveredPrometheusSession(
    ctx,
    sessionID,
    PROMETHEUS_INTERRUPTED_VISIBLE_TURN_RECOVERY_TEXT,
    resumeConfig,
    session as RecoveryResumeSessionApi | undefined,
  );

  if (resumed) {
    recoveredInterruptedPlannerVisibleMessageBySession.set(sessionID, lastMessageID);
    log("[event] recovered idle interrupted Prometheus visible turn", {
      sessionID,
      source,
      messageID: lastMessageID,
      agent: lastMessageAgent,
    });
  }

  return resumed;
}

async function maybeRecoverPrometheusCiVisibleSummaryAssistantMessage(
  ctx: { client: Record<string, unknown>; directory: string },
  sessionID: string,
  expectedMessageID?: string,
  source = "session.status.idle",
): Promise<boolean> {
  if (hasRecentPrometheusRuntimeFallbackRecoveryGuard(sessionID, source, "planner ci visible-summary")) {
    return false;
  }

  if (hasActivePrometheusProviderBlockedRetryWindow(sessionID)) {
    log("[event] planner ci visible-summary recovery skipped: provider-blocked retry window active", {
      sessionID,
      source,
    });
    return false;
  }

  const session = ctx.client["session"] as {
    messages?: (args: { path: { id: string } }) => Promise<unknown>;
    promptAsync?: (args: {
      path: { id: string };
      body: { parts: Array<Record<string, unknown>> };
      query?: { directory: string };
    }) => Promise<unknown>;
    prompt?: (args: {
      path: { id: string };
      body: { parts: Array<Record<string, unknown>> };
      query?: { directory: string };
    }) => Promise<unknown>;
  } | undefined;
  const readMessages = session?.messages;
  if (typeof readMessages !== "function") {
    return false;
  }

  let response: unknown;
  try {
    response = await readMessages({
      path: { id: sessionID },
    });
  } catch {
    return false;
  }

  const messages = normalizeSDKResponse(response, [] as RecoveryMessage[], {
    preferResponseOnMissingData: true,
  });
  const lastMessage = messages[messages.length - 1];
  const lastMessageID = getMessageID(lastMessage);
  const lastMessageAgent = getMessageAgent(lastMessage);

  if (!lastMessageID) return false;
  if (expectedMessageID && lastMessageID !== expectedMessageID) return false;
  if (getMessageRole(lastMessage) !== "assistant") return false;
  if (getMessageError(lastMessage)) return false;
  if (!isPrometheusPlannerAgent(lastMessageAgent)) return false;
  if (!assistantMessageHasUserFacingContent(lastMessage.parts)) return false;
  if (findRecoverablePendingPrometheusTool(lastMessage.parts)) return false;
  if (findRecoverableErroredPlannerCiBootstrapTool(lastMessage.parts)) return false;

  const lastEvidenceGatedUser = findLastUserMessageMatching(
    messages as RecoveryMessage[],
    (message) => messageIndicatesEvidenceGatedCi(message),
  );
  const lastUser = lastEvidenceGatedUser ?? findLastUserMessage(messages as never);
  if (!messageIndicatesEvidenceGatedCi(lastUser as RecoveryMessage | undefined)) {
    return false;
  }

  const lastRecoveredMessageID = recoveredPlannerCiVisibleSummaryMessageBySession.get(sessionID);
  if (lastRecoveredMessageID === lastMessageID) {
    return false;
  }

  const resumeConfig = extractResumeConfig(lastUser as never, sessionID);
  resumeConfig.directory = ctx.directory;
  resumeConfig.continuationText = PROMETHEUS_CI_VISIBLE_SUMMARY_RECOVERY_TEXT;
  const resumed = await resumeRecoveredPrometheusSession(
    ctx,
    sessionID,
    PROMETHEUS_CI_VISIBLE_SUMMARY_RECOVERY_TEXT,
    resumeConfig,
    session as RecoveryResumeSessionApi | undefined,
  );

  if (resumed) {
    recoveredPlannerCiVisibleSummaryMessageBySession.set(sessionID, lastMessageID);
    log("[event] recovered planner CI visible-summary stop", {
      sessionID,
      source,
      messageID: lastMessageID,
      agent: lastMessageAgent,
    });
  }

  return resumed;
}

async function maybeRecoverPrometheusToolOnlyAssistantTurn(
  ctx: { client: Record<string, unknown>; directory: string },
  sessionID: string,
  expectedMessageID?: string,
  source = "session.status.idle",
): Promise<boolean> {
  if (hasActivePrometheusProviderBlockedRetryWindow(sessionID)) {
    log("[event] planner tool-only recovery skipped: provider-blocked retry window active", {
      sessionID,
      source,
    });
    return false;
  }

  const session = ctx.client["session"] as {
    messages?: (args: { path: { id: string } }) => Promise<unknown>;
  } | undefined;
  const readMessages = session?.messages;
  if (typeof readMessages !== "function") {
    log("[event] planner tool-only recovery skipped: session.messages unavailable", { sessionID, source });
    return false;
  }

  let response: unknown;
  try {
    response = await readMessages({
      path: { id: sessionID },
    });
  } catch (error) {
    log("[event] planner tool-only recovery skipped: session.messages failed", {
      sessionID,
      source,
      error,
    });
    return false;
  }

  const messages = normalizeSDKResponse(response, [] as RecoveryMessage[], {
    preferResponseOnMissingData: true,
  });
  const lastMessage = messages[messages.length - 1];
  const lastMessageID = getMessageID(lastMessage);

  if (!lastMessageID) return false;
  if (expectedMessageID && lastMessageID !== expectedMessageID) return false;
  if (!isRecoverablePrometheusToolOnlyTurn(lastMessage)) return false;

  const lastRecoveredMessageID = recoveredPlannerToolOnlyMessageBySession.get(sessionID);
  if (lastRecoveredMessageID === lastMessageID) {
    log("[event] planner tool-only recovery skipped: message already recovered", {
      sessionID,
      source,
      lastMessageID,
    });
    return false;
  }

  const lastUser = findLastUserMessage(messages as never);
  const resumeConfig = extractResumeConfig(lastUser as never, sessionID);
  resumeConfig.directory = ctx.directory;
  resumeConfig.continuationText = PROMETHEUS_TOOL_ONLY_TURN_RECOVERY_TEXT;
  const resumed = await resumeRecoveredPrometheusSession(
    ctx,
    sessionID,
    PROMETHEUS_TOOL_ONLY_TURN_RECOVERY_TEXT,
    resumeConfig,
    session as RecoveryResumeSessionApi | undefined,
  );

  if (resumed) {
    recoveredPlannerToolOnlyMessageBySession.set(sessionID, lastMessageID);
    log("[event] recovered idle Prometheus tool-only turn", {
      sessionID,
      source,
      messageID: lastMessageID,
    });
  }

  return resumed;
}

async function maybeRecoverSisyphusCiInterruptedVisibleAssistantMessage(
  ctx: { client: Record<string, unknown>; directory: string },
  sessionID: string,
  expectedMessageID?: string,
  source = "session.status.idle",
): Promise<boolean> {
  const session = ctx.client["session"] as {
    messages?: (args: { path: { id: string } }) => Promise<unknown>;
  } | undefined;
  const readMessages = session?.messages;
  if (typeof readMessages !== "function") {
    log("[event] sisyphus CI interrupted-visible recovery skipped: session.messages unavailable", { sessionID, source });
    return false;
  }

  let response: unknown;
  try {
    response = await readMessages({
      path: { id: sessionID },
    });
  } catch (error) {
    log("[event] sisyphus CI interrupted-visible recovery skipped: session.messages failed", {
      sessionID,
      source,
      error,
    });
    return false;
  }

  const messages = normalizeSDKResponse(response, [] as RecoveryMessage[], {
    preferResponseOnMissingData: true,
  });
  const lastMessage = messages[messages.length - 1];
  const lastMessageID = getMessageID(lastMessage);
  const lastMessageAgent = getMessageAgent(lastMessage);
  const lastMessageFinish = isRecord(lastMessage?.info) && typeof lastMessage.info.finish === "string"
    ? lastMessage.info.finish
    : undefined;

  if (!lastMessageID) return false;
  if (expectedMessageID && lastMessageID !== expectedMessageID) return false;
  if (getMessageRole(lastMessage) !== "assistant") return false;
  if (getMessageError(lastMessage)) return false;
  if (!isSisyphusExecutorAgent(lastMessageAgent)) return false;
  if (lastMessageFinish !== "other") return false;
  if (!assistantMessageHasUserFacingContent(lastMessage.parts)) return false;

  const lastEvidenceGatedUser = findLastUserMessageMatching(
    messages as RecoveryMessage[],
    (message) => messageIndicatesEvidenceGatedCi(message),
  );
  const lastUser = lastEvidenceGatedUser ?? findLastUserMessage(messages as never);
  if (!messageIndicatesEvidenceGatedCi(lastUser as RecoveryMessage | undefined)) {
    return false;
  }

  const lastRecoveredMessageID = recoveredInterruptedSisyphusCiVisibleMessageBySession.get(sessionID);
  if (lastRecoveredMessageID === lastMessageID) {
    log("[event] sisyphus CI interrupted-visible recovery skipped: message already recovered", {
      sessionID,
      source,
      lastMessageID,
    });
    return false;
  }

  const resumeConfig = extractResumeConfig(lastUser as never, sessionID);
  resumeConfig.directory = ctx.directory;
  resumeConfig.continuationText = SISYPHUS_CI_INTERRUPTED_VISIBLE_TURN_RECOVERY_TEXT;
  const resumed = await resumeRecoveredPrometheusSession(
    ctx,
    sessionID,
    SISYPHUS_CI_INTERRUPTED_VISIBLE_TURN_RECOVERY_TEXT,
    resumeConfig,
    session as RecoveryResumeSessionApi | undefined,
  );

  if (resumed) {
    recoveredInterruptedSisyphusCiVisibleMessageBySession.set(sessionID, lastMessageID);
    log("[event] recovered idle interrupted Sisyphus CI visible turn", {
      sessionID,
      source,
      messageID: lastMessageID,
      agent: lastMessageAgent,
    });
  }

  return resumed;
}

async function maybeRecoverPrometheusProviderBlockedTurn(
  ctx: { client: Record<string, unknown>; directory: string },
  sessionID: string,
  expectedMessageID?: string,
  source = "session.error",
  eventError?: unknown,
  pluginConfig?: OhMyOpenCodeConfig,
): Promise<boolean> {
  const getRecoveryErrorMessageID = (lastPersistedErrorMessageID?: string): string | undefined => {
    return expectedMessageID ?? lastPersistedErrorMessageID;
  };

  const pickAlternatePaidRecoveryModel = (
    agentName: string | undefined,
    currentModel: { providerID: string; modelID: string } | undefined,
  ): { providerID: string; modelID: string } | undefined => {
    if (!agentName || !pluginConfig || !currentModel) {
      return undefined;
    }

    const rawFallbackModels = getRawFallbackModels(sessionID, agentName, pluginConfig);
    const fallbackChain = buildFallbackChainFromModels(rawFallbackModels, currentModel.providerID);
    if (!fallbackChain || fallbackChain.length === 0) {
      return undefined;
    }

    const normalizeModel = (modelID: string): string => normalizeFallbackModelID(modelID);

    for (const entry of fallbackChain) {
      const providerID = entry.providers[0];
      if (!providerID || providerID === "opencode") {
        continue;
      }

      if (
        providerID === currentModel.providerID
        && normalizeModel(entry.model) === normalizeModel(currentModel.modelID)
      ) {
        continue;
      }

      return { providerID, modelID: entry.model };
    }

    return undefined;
  };

  const pickProviderBlockedRecoveryModel = (
    agentName: string | undefined,
    currentModel: { providerID: string; modelID: string } | undefined,
  ): { providerID: string; modelID: string } | undefined => {
    if (!currentModel) {
      return undefined;
    }

    const now = Date.now();
    const normalizeModel = (modelID: string): string => normalizeFallbackModelID(modelID);
    const existingState = prometheusProviderBlockedRetryStateBySession.get(sessionID);
    const isSameBlockedModel =
      !!existingState
      && existingState.providerID === currentModel.providerID
      && normalizeModel(existingState.modelID) === normalizeModel(currentModel.modelID);

    if (
      !isSameBlockedModel
      || !existingState
      || now - existingState.startedAt < PROMETHEUS_PROVIDER_BLOCKED_SAME_MODEL_WINDOW_MS
    ) {
      prometheusProviderBlockedRetryStateBySession.set(sessionID, {
        providerID: currentModel.providerID,
        modelID: currentModel.modelID,
        startedAt: isSameBlockedModel && existingState ? existingState.startedAt : now,
        attempts: (isSameBlockedModel && existingState ? existingState.attempts : 0) + 1,
      });
      return currentModel;
    }

    const alternateRecoveryModel = pickAlternatePaidRecoveryModel(agentName, currentModel);
    if (alternateRecoveryModel) {
      prometheusProviderBlockedRetryStateBySession.set(sessionID, {
        providerID: alternateRecoveryModel.providerID,
        modelID: alternateRecoveryModel.modelID,
        startedAt: now,
        attempts: 0,
      });
      return alternateRecoveryModel;
    }

    return currentModel;
  };

  const session = ctx.client["session"] as {
    messages?: (args: { path: { id: string } }) => Promise<unknown>;
    promptAsync?: (args: {
      path: { id: string };
      body: { parts: Array<Record<string, unknown>> };
      query?: { directory: string };
    }) => Promise<unknown>;
    prompt?: (args: {
      path: { id: string };
      body: { parts: Array<Record<string, unknown>> };
      query?: { directory: string };
    }) => Promise<unknown>;
  } | undefined;
  const readMessages = session?.messages;
  if (typeof readMessages !== "function") {
    return false;
  }

  let response: unknown;
  try {
    response = await readMessages({
      path: { id: sessionID },
    });
  } catch {
    return false;
  }

  const messages = normalizeSDKResponse(response, [] as RecoveryMessage[], {
    preferResponseOnMissingData: true,
  });
  const lastMessage = messages[messages.length - 1];
  const lastMessageID = getMessageID(lastMessage);
  const lastMessageError = getMessageError(lastMessage);
  const lastMessageModel = getMessageModel(lastMessage);
  const lastMessageErrorText = extractErrorMessage(lastMessageError).toLowerCase();
  const eventErrorText = extractErrorMessage(eventError).toLowerCase();
  const lastMessageIsPersistedProviderBlockedError =
    !!lastMessageID
    && !expectedMessageID
    && getMessageRole(lastMessage) === "assistant"
    && !!lastMessageError
    && isProviderBlockedErrorText(lastMessageErrorText);
  const lastMessageMatchesExpectedError =
    !!lastMessageID
    && !!expectedMessageID
    && lastMessageID === expectedMessageID
    && getMessageRole(lastMessage) === "assistant"
    && !!lastMessageError
    && isProviderBlockedErrorText(lastMessageErrorText);
  const shouldRecoverFromPendingPersistedError =
    !lastMessageMatchesExpectedError
    && isProviderBlockedErrorText(eventErrorText);

  if (
    !lastMessageMatchesExpectedError
    && !lastMessageIsPersistedProviderBlockedError
    && !shouldRecoverFromPendingPersistedError
  ) {
    return false;
  }

  const recoveryErrorMessageID = getRecoveryErrorMessageID(lastMessageMatchesExpectedError ? lastMessageID : undefined);
  if (recoveryErrorMessageID) {
    const lastRecoveredProviderBlockedErrorMessageID =
      recoveredProviderBlockedErrorMessageBySession.get(sessionID);
    if (lastRecoveredProviderBlockedErrorMessageID === recoveryErrorMessageID) {
      return false;
    }
  }

  const blockedModel = lastMessageModel ?? getSessionModel(sessionID);
  touchPrometheusProviderBlockedRetryState(sessionID, blockedModel);

  if (wasRecentRuntimeFallbackContinuationDispatched(sessionID, {
    guardMs: PROMETHEUS_PROVIDER_BLOCKED_SAME_MODEL_WINDOW_MS,
  })) {
    log("[event] provider-blocked Prometheus recovery skipped: runtime fallback continuation already dispatched", {
      sessionID,
      source,
      errorMessageID: expectedMessageID ?? lastMessageID,
      blockedModel,
    });
    return false;
  }

  const candidateStartIndex = lastMessageMatchesExpectedError ? messages.length - 2 : messages.length - 1;
  for (let index = candidateStartIndex; index >= 0; index -= 1) {
    const candidate = messages[index];
    const candidateID = getMessageID(candidate);
    const candidateAgent = getMessageAgent(candidate);
    if (!candidateID) continue;
    if (expectedMessageID && candidateID === expectedMessageID) continue;
    if (getMessageRole(candidate) !== "assistant") continue;
    if (getMessageError(candidate)) continue;
    if (!isPrometheusPlannerAgent(candidateAgent)) continue;

    const candidateHasUserFacingContent = assistantMessageHasUserFacingContent(candidate.parts);
    const candidateHasRecoverablePlannerInternalParts =
      !candidateHasUserFacingContent
      && (
        assistantMessageHasVisibleContent(candidate.parts)
        || assistantMessageHasRecoverablePlannerInternalParts(candidate.parts)
      );
    if (!candidateHasUserFacingContent && !candidateHasRecoverablePlannerInternalParts) {
      continue;
    }

    const continuationText = candidateHasUserFacingContent
      ? PROMETHEUS_INTERRUPTED_VISIBLE_TURN_RECOVERY_TEXT
      : PROMETHEUS_REASONING_ONLY_RECOVERY_TEXT;

    const lastUser = findLastUserMessage(messages as never);
    const resumeConfig = extractResumeConfig(lastUser as never, sessionID);
    const alternateRecoveryModel = pickProviderBlockedRecoveryModel(
      candidateAgent,
      blockedModel ?? resumeConfig.model,
    );
    if (alternateRecoveryModel) {
      resumeConfig.model = alternateRecoveryModel;
    }
    resumeConfig.directory = ctx.directory;
    resumeConfig.continuationText = continuationText;
    const resumed = await resumeRecoveredPrometheusSession(
      ctx,
      sessionID,
      continuationText,
      resumeConfig,
      session as RecoveryResumeSessionApi | undefined,
    );

    if (resumed) {
      if (recoveryErrorMessageID) {
        recoveredProviderBlockedErrorMessageBySession.set(sessionID, recoveryErrorMessageID);
      }
      log("[event] recovered provider-blocked Prometheus planning turn", {
        sessionID,
        source,
        candidateID,
        errorMessageID: expectedMessageID ?? lastMessageID,
        recoveryMode: lastMessageMatchesExpectedError ? "persisted-error" : "event-error-race",
        candidateType: candidateHasUserFacingContent ? "visible" : "reasoning-only",
      });
    }

    return resumed;
  }

  const cachedRecoverableSnapshot = recentRecoverablePrometheusSnapshotBySession.get(sessionID);
  if (
    cachedRecoverableSnapshot
    && cachedRecoverableSnapshot.messageID !== expectedMessageID
    && cachedRecoverableSnapshot.messageID !== lastMessageID
    && isPrometheusPlannerAgent(cachedRecoverableSnapshot.agent)
  ) {
    if (!recoveryErrorMessageID || recoveredProviderBlockedErrorMessageBySession.get(sessionID) !== recoveryErrorMessageID) {
        const continuationText = cachedRecoverableSnapshot.hasUserFacingContent
          ? PROMETHEUS_INTERRUPTED_VISIBLE_TURN_RECOVERY_TEXT
          : cachedRecoverableSnapshot.hasRecoverablePlannerInternalParts
          ? PROMETHEUS_REASONING_ONLY_RECOVERY_TEXT
          : undefined;

      if (continuationText) {
        const lastUser = findLastUserMessage(messages as never);
        const resumeConfig = extractResumeConfig(lastUser as never, sessionID);
        const alternateRecoveryModel = pickProviderBlockedRecoveryModel(
          cachedRecoverableSnapshot.agent,
          blockedModel ?? resumeConfig.model,
        );
        if (alternateRecoveryModel) {
          resumeConfig.model = alternateRecoveryModel;
        }
        resumeConfig.directory = ctx.directory;
        resumeConfig.continuationText = continuationText;
        const resumed = await resumeRecoveredPrometheusSession(
          ctx,
          sessionID,
          continuationText,
          resumeConfig,
          session as RecoveryResumeSessionApi | undefined,
        );

        if (resumed) {
          if (recoveryErrorMessageID) {
            recoveredProviderBlockedErrorMessageBySession.set(sessionID, recoveryErrorMessageID);
          }
          log("[event] recovered provider-blocked Prometheus planning turn from cached snapshot", {
            sessionID,
            source,
            candidateID: cachedRecoverableSnapshot.messageID,
            errorMessageID: expectedMessageID ?? lastMessageID,
            candidateType: cachedRecoverableSnapshot.hasUserFacingContent ? "cached-visible" : "cached-reasoning-only",
          });
        }

        return resumed;
      }
    }
  }

  const lastUser = findLastUserMessage(messages as never);
  const lastUserAgent = getMessageAgent(lastUser as never) ?? getSessionAgent(sessionID);
  if (lastUser && isPrometheusPlannerAgent(lastUserAgent)) {
    const resumeConfig = extractResumeConfig(lastUser as never, sessionID);
    const alternateRecoveryModel = pickProviderBlockedRecoveryModel(
      lastUserAgent,
      blockedModel ?? resumeConfig.model,
    );
    if (alternateRecoveryModel) {
      resumeConfig.model = alternateRecoveryModel;
    }
    resumeConfig.directory = ctx.directory;
    resumeConfig.continuationText = PROMETHEUS_REASONING_ONLY_RECOVERY_TEXT;
    const resumed = await resumeRecoveredPrometheusSession(
      ctx,
      sessionID,
      PROMETHEUS_REASONING_ONLY_RECOVERY_TEXT,
      resumeConfig,
      session as RecoveryResumeSessionApi | undefined,
    );

    if (resumed) {
      if (recoveryErrorMessageID) {
        recoveredProviderBlockedErrorMessageBySession.set(sessionID, recoveryErrorMessageID);
      }
      log("[event] recovered provider-blocked Prometheus planning turn from root user prompt", {
        sessionID,
        source,
        errorMessageID: expectedMessageID ?? lastMessageID,
      });
    }

    return resumed;
  }

  return false;
}

async function maybeRecoverPrometheusPendingEmptyToolCall(
  ctx: { client: Record<string, unknown>; directory: string },
  sessionID: string,
  expectedMessageID?: string,
  source = "message.updated.delayed",
): Promise<boolean> {
  const cachedSnapshot = getAssistantRecoverySnapshot(sessionID, expectedMessageID);
  const cachedAgent = cachedSnapshot?.agent ?? getSessionAgent(sessionID);
  const tryCachedSnapshotRecovery = async (reason: string): Promise<boolean> => {
    if (!cachedSnapshot) {
      return false;
    }

    return resumeCachedPendingPrometheusToolRecovery(
      ctx,
      sessionID,
      `${source}:${reason}`,
      cachedSnapshot,
      cachedAgent,
      "cached pending empty planning tool call",
    );
  };

  const session = ctx.client["session"] as {
    messages?: (args: { path: { id: string } }) => Promise<unknown>;
    abort?: (args: { path: { id: string } }) => Promise<unknown>;
    promptAsync?: (args: {
      path: { id: string };
      body: { parts: Array<Record<string, unknown>> };
      query?: { directory: string };
    }) => Promise<unknown>;
    prompt?: (args: {
      path: { id: string };
      body: { parts: Array<Record<string, unknown>> };
      query?: { directory: string };
    }) => Promise<unknown>;
  } | undefined;
  const readMessages = session?.messages;
  if (typeof readMessages !== "function") {
    log("[event] empty tool recovery skipped: session.messages unavailable", { sessionID, source });
    return tryCachedSnapshotRecovery("session-messages-unavailable");
  }

  let response: unknown;
  try {
    response = await readMessages({
      path: { id: sessionID },
    });
  } catch (error) {
    log("[event] empty tool recovery skipped: session.messages failed", {
      sessionID,
      source,
      error,
    });
    return tryCachedSnapshotRecovery("session-messages-failed");
  }
  const messages = normalizeSDKResponse(response, [] as RecoveryMessage[], {
    preferResponseOnMissingData: true,
  });
  const lastMessage = messages[messages.length - 1];
  const lastMessageID = getMessageID(lastMessage);
  const lastMessageAgent = getMessageAgent(lastMessage);
  const lastMessageError = getMessageError(lastMessage);
  const lastMessageErrorName = extractErrorName(lastMessageError);
  const lastMessageErrorText = extractErrorMessage(lastMessageError).toLowerCase();

  if (!lastMessageID) {
    return tryCachedSnapshotRecovery("missing-latest-message");
  }
  if (expectedMessageID && lastMessageID !== expectedMessageID) {
    return false;
  }
  if (getMessageRole(lastMessage) !== "assistant") return false;
  if (
    lastMessageError
    && lastMessageErrorName !== "MessageAbortedError"
    && !lastMessageErrorText.includes("aborted")
  ) {
    return false;
  }

  const pendingTool = findRecoverablePendingPrometheusTool(lastMessage.parts);
  if (!pendingTool) {
    return tryCachedSnapshotRecovery("live-transcript-missing-pending-tool");
  }

  const lastUser = findLastUserMessage(messages as never);
  const isAtlasCiPendingTask =
    pendingTool.tool === "task"
    && isAtlasPlanExecutorAgent(lastMessageAgent)
    && messageIndicatesEvidenceGatedCi(lastUser as RecoveryMessage | undefined);
  if (!isPrometheusPlannerAgent(lastMessageAgent) && !isAtlasCiPendingTask) {
    return false;
  }

  const lastRecoveredMessageID = recoveredPendingEmptyToolMessageBySession.get(sessionID);
  if (lastRecoveredMessageID === lastMessageID) {
    log("[event] empty tool recovery skipped: message already recovered", {
      sessionID,
      source,
      lastMessageID,
      tool: pendingTool.tool,
    });
    return false;
  }

  await session?.abort?.({ path: { id: sessionID } }).catch(() => {});

  const resumeConfig = extractResumeConfig(lastUser as never, sessionID);
  resumeConfig.directory = ctx.directory;
  resumeConfig.continuationText = PROMETHEUS_EMPTY_TOOL_RECOVERY_TEXT;
  const resumed = await resumeRecoveredPrometheusSession(
    ctx,
    sessionID,
    PROMETHEUS_EMPTY_TOOL_RECOVERY_TEXT,
    resumeConfig,
    session as RecoveryResumeSessionApi | undefined,
  );

  if (resumed) {
    recoveredPendingEmptyToolMessageBySession.set(sessionID, lastMessageID);
    log("[event] recovered pending empty planning tool call", {
      sessionID,
      source,
      messageID: lastMessageID,
      tool: pendingTool.tool,
    });
  }

  return resumed;
}

async function maybeRecoverPrometheusAbortedToolWrapper(
  ctx: { client: Record<string, unknown>; directory: string },
  sessionID: string,
  expectedMessageID?: string,
  source = "message.updated.error",
  eventError?: unknown,
): Promise<boolean> {
  const cachedSnapshot = getAssistantRecoverySnapshot(sessionID, expectedMessageID);
  const cachedAgent = cachedSnapshot?.agent ?? getSessionAgent(sessionID);
  const tryCachedSnapshotRecovery = async (
    reason: string,
  ): Promise<boolean> => {
    if (!cachedSnapshot) {
      return false;
    }

    const resumedFromSnapshot = await resumeCachedPendingPrometheusToolRecovery(
      ctx,
      sessionID,
      `${source}:${reason}`,
      cachedSnapshot,
      cachedAgent,
      "cached aborted-tool wrapper for Prometheus planning tool call",
    );
    if (resumedFromSnapshot) {
      return true;
    }

    return false;
  };
  const session = ctx.client["session"] as {
    messages?: (args: { path: { id: string } }) => Promise<unknown>;
    abort?: (args: { path: { id: string } }) => Promise<unknown>;
    promptAsync?: (args: {
      path: { id: string };
      body: { parts: Array<Record<string, unknown>> };
      query?: { directory: string };
    }) => Promise<unknown>;
    prompt?: (args: {
      path: { id: string };
      body: { parts: Array<Record<string, unknown>> };
      query?: { directory: string };
    }) => Promise<unknown>;
  } | undefined;
  const readMessages = session?.messages;
  if (typeof readMessages !== "function") {
    log("[event] aborted-tool wrapper recovery skipped: session.messages unavailable", { sessionID, source });
    return false;
  }

  let response: unknown;
  try {
    response = await readMessages({
      path: { id: sessionID },
    });
  } catch (error) {
    log("[event] aborted-tool wrapper recovery skipped: session.messages failed", {
      sessionID,
      source,
      error,
    });
    return false;
  }

  const messages = normalizeSDKResponse(response, [] as RecoveryMessage[], {
    preferResponseOnMissingData: true,
  });
  const lastMessage = messages[messages.length - 1];
  const lastMessageID = getMessageID(lastMessage);
  const lastMessageError = getMessageError(lastMessage);
  const wrapperError = lastMessageError ?? eventError;
  const wrapperErrorName = extractErrorName(wrapperError);
  const wrapperErrorText = extractErrorMessage(wrapperError).toLowerCase();

  if (!lastMessageID) {
    return tryCachedSnapshotRecovery("missing-latest-message");
  }
  if (expectedMessageID && lastMessageID !== expectedMessageID) {
    const recoveredFromRace = await tryCachedSnapshotRecovery("pending-persisted-error");
    if (recoveredFromRace) {
      return true;
    }
    return false;
  }
  if (getMessageRole(lastMessage) !== "assistant") return false;
  if (
    wrapperErrorName !== "MessageAbortedError"
    && !wrapperErrorText.includes("aborted")
  ) {
    return false;
  }

  if (await tryCachedSnapshotRecovery("persisted-error")) {
    return true;
  }

  const recoverCandidate = async (
    candidate: RecoveryMessage,
    candidateID: string,
    errorMessageID: string,
  ): Promise<boolean> => {
    const candidateAgent = getMessageAgent(candidate);
    if (!isPrometheusPlannerAgent(candidateAgent)) {
      return false;
    }

    const pendingTool = findRecoverablePendingPrometheusTool(candidate.parts);
    if (!pendingTool) {
      return false;
    }

    const lastRecoveredMessageID = recoveredPendingEmptyToolMessageBySession.get(sessionID);
    if (lastRecoveredMessageID === candidateID) {
      log("[event] aborted-tool wrapper recovery skipped: prior broken tool already recovered", {
        sessionID,
        source,
        candidateID,
      });
      return false;
    }

    const lastUser = findLastUserMessage(messages as never);
    const resumeConfig = extractResumeConfig(lastUser as never, sessionID);
    resumeConfig.directory = ctx.directory;
    resumeConfig.continuationText = PROMETHEUS_EMPTY_TOOL_RECOVERY_TEXT;
    const resumed = await resumeRecoveredPrometheusSession(
      ctx,
      sessionID,
      PROMETHEUS_EMPTY_TOOL_RECOVERY_TEXT,
      resumeConfig,
      session as RecoveryResumeSessionApi | undefined,
    );

    if (resumed) {
      recoveredPendingEmptyToolMessageBySession.set(sessionID, candidateID);
      log("[event] recovered aborted-tool wrapper for Prometheus planning tool call", {
        sessionID,
        source,
        candidateID,
        errorMessageID,
        tool: pendingTool.tool,
      });
    }

    return resumed;
  };

  if (await recoverCandidate(lastMessage, lastMessageID, lastMessageID)) {
    return true;
  }

  for (let index = messages.length - 2; index >= 0; index -= 1) {
    const candidate = messages[index];
    const candidateID = getMessageID(candidate);
    if (!candidateID) continue;
    if (getMessageRole(candidate) !== "assistant") continue;
    if (getMessageError(candidate)) continue;

    if (await recoverCandidate(candidate, candidateID, lastMessageID)) {
      return true;
    }
  }

  return false;
}

async function maybeRecoverSisyphusCiAbortedToolWrapper(
  ctx: { client: Record<string, unknown>; directory: string },
  sessionID: string,
  expectedMessageID?: string,
  source = "message.updated.error",
  eventError?: unknown,
): Promise<boolean> {
  const cachedSnapshot = getAssistantRecoverySnapshot(sessionID, expectedMessageID);
  const cachedAgent = cachedSnapshot?.agent ?? getSessionAgent(sessionID);
  if (cachedAgent && !isSisyphusExecutorAgent(cachedAgent)) {
    return false;
  }
  const tryCachedSnapshotRecovery = async (reason: string): Promise<boolean> => {
    if (!cachedSnapshot) {
      return false;
    }

    return resumeCachedPendingSisyphusToolRecovery(
      ctx,
      sessionID,
      `${source}:${reason}`,
      cachedSnapshot,
      cachedAgent,
      "cached aborted-tool wrapper for Sisyphus CI tool call",
    );
  };

  const session = ctx.client["session"] as {
    messages?: (args: { path: { id: string } }) => Promise<unknown>;
    abort?: (args: { path: { id: string } }) => Promise<unknown>;
    promptAsync?: (args: {
      path: { id: string };
      body: { parts: Array<Record<string, unknown>> };
      query?: { directory: string };
    }) => Promise<unknown>;
    prompt?: (args: {
      path: { id: string };
      body: { parts: Array<Record<string, unknown>> };
      query?: { directory: string };
    }) => Promise<unknown>;
  } | undefined;
  const readMessages = session?.messages;
  if (typeof readMessages !== "function") {
    log("[event] sisyphus CI aborted-tool wrapper recovery skipped: session.messages unavailable", { sessionID, source });
    return tryCachedSnapshotRecovery("session-messages-unavailable");
  }

  let response: unknown;
  try {
    response = await readMessages({
      path: { id: sessionID },
    });
  } catch (error) {
    log("[event] sisyphus CI aborted-tool wrapper recovery skipped: session.messages failed", {
      sessionID,
      source,
      error,
    });
    return tryCachedSnapshotRecovery("session-messages-failed");
  }

  const messages = normalizeSDKResponse(response, [] as RecoveryMessage[], {
    preferResponseOnMissingData: true,
  });
  const lastMessage = messages[messages.length - 1];
  const lastMessageID = getMessageID(lastMessage);
  const lastMessageError = getMessageError(lastMessage);
  const wrapperError = lastMessageError ?? eventError;
  const wrapperErrorName = extractErrorName(wrapperError);
  const wrapperErrorText = extractErrorMessage(wrapperError).toLowerCase();

  if (!lastMessageID) {
    return tryCachedSnapshotRecovery("missing-latest-message");
  }
  if (expectedMessageID && lastMessageID !== expectedMessageID) {
    const recoveredFromRace = await tryCachedSnapshotRecovery("pending-persisted-error");
    if (recoveredFromRace) {
      return true;
    }
    return false;
  }
  if (getMessageRole(lastMessage) !== "assistant") return false;
  if (
    wrapperErrorName !== "MessageAbortedError"
    && !wrapperErrorText.includes("aborted")
  ) {
    return false;
  }

  if (await tryCachedSnapshotRecovery("persisted-error")) {
    return true;
  }

  const lastEvidenceGatedUser = findLastUserMessageMatching(
    messages as RecoveryMessage[],
    (message) => messageIndicatesEvidenceGatedCi(message),
  );
  const lastUser = lastEvidenceGatedUser ?? findLastUserMessage(messages as never);
  if (!messageIndicatesEvidenceGatedCi(lastUser as RecoveryMessage | undefined)) {
    return false;
  }

  const recoverCandidate = async (
    candidate: RecoveryMessage,
    candidateID: string,
    errorMessageID: string,
  ): Promise<boolean> => {
    const candidateAgent = getMessageAgent(candidate);
    if (!isSisyphusExecutorAgent(candidateAgent)) {
      return false;
    }

    const pendingTool = findRecoverablePendingSisyphusCiTool(candidate.parts);
    if (!pendingTool) {
      return false;
    }

    const lastRecoveredMessageID = recoveredPendingEmptySisyphusToolMessageBySession.get(sessionID);
    if (lastRecoveredMessageID === candidateID) {
      log("[event] sisyphus CI aborted-tool wrapper recovery skipped: prior broken tool already recovered", {
        sessionID,
        source,
        candidateID,
      });
      return false;
    }

    const resumeConfig = extractResumeConfig(lastUser as never, sessionID);
    resumeConfig.directory = ctx.directory;
    resumeConfig.continuationText = SISYPHUS_CI_EMPTY_TOOL_RECOVERY_TEXT;
    const resumed = await resumeRecoveredPrometheusSession(
      ctx,
      sessionID,
      SISYPHUS_CI_EMPTY_TOOL_RECOVERY_TEXT,
      resumeConfig,
      session as RecoveryResumeSessionApi | undefined,
    );

    if (resumed) {
      recoveredPendingEmptySisyphusToolMessageBySession.set(sessionID, candidateID);
      log("[event] recovered aborted-tool wrapper for Sisyphus CI tool call", {
        sessionID,
        source,
        candidateID,
        errorMessageID,
        tool: pendingTool.tool,
      });
      return true;
    }

    return false;
  };

  for (let index = messages.length - 2; index >= 0; index -= 1) {
    const candidate = messages[index];
    const candidateID = getMessageID(candidate);
    if (!candidateID || getMessageRole(candidate) !== "assistant") {
      continue;
    }

    const recovered = await recoverCandidate(candidate, candidateID, lastMessageID);
    if (recovered) {
      return true;
    }
  }

  return false;
}

async function maybeRecoverSisyphusCiAbortedVerifyWave(
  ctx: { client: Record<string, unknown>; directory: string },
  sessionID: string,
  expectedMessageID?: string,
  source = "message.updated.error",
  eventError?: unknown,
): Promise<boolean> {
  const cachedSnapshot = getAssistantRecoverySnapshot(sessionID, expectedMessageID);
  const cachedAgent = cachedSnapshot?.agent ?? getSessionAgent(sessionID);
  if (cachedAgent && !isSisyphusExecutorAgent(cachedAgent)) {
    return false;
  }

  const session = ctx.client["session"] as {
    messages?: (args: { path: { id: string } }) => Promise<unknown>;
    promptAsync?: (args: {
      path: { id: string };
      body: { parts: Array<Record<string, unknown>> };
      query?: { directory: string };
    }) => Promise<unknown>;
    prompt?: (args: {
      path: { id: string };
      body: { parts: Array<Record<string, unknown>> };
      query?: { directory: string };
    }) => Promise<unknown>;
  } | undefined;
  const readMessages = session?.messages;
  if (typeof readMessages !== "function") {
    log("[event] sisyphus CI aborted verify-wave recovery skipped: session.messages unavailable", { sessionID, source });
    return false;
  }

  let response: unknown;
  try {
    response = await readMessages({
      path: { id: sessionID },
    });
  } catch (error) {
    log("[event] sisyphus CI aborted verify-wave recovery skipped: session.messages failed", {
      sessionID,
      source,
      error,
    });
    return false;
  }

  const messages = normalizeSDKResponse(response, [] as RecoveryMessage[], {
    preferResponseOnMissingData: true,
  });
  const lastMessage = messages[messages.length - 1];
  const lastMessageID = getMessageID(lastMessage);
  const lastMessageError = getMessageError(lastMessage);
  const wrapperError = lastMessageError ?? eventError;
  const wrapperErrorName = extractErrorName(wrapperError);
  const wrapperErrorText = extractErrorMessage(wrapperError).toLowerCase();

  if (!lastMessageID) return false;
  if (expectedMessageID && lastMessageID !== expectedMessageID) return false;
  if (getMessageRole(lastMessage) !== "assistant") return false;
  if (wrapperErrorName !== "MessageAbortedError" && !wrapperErrorText.includes("aborted")) {
    return false;
  }

  const lastEvidenceGatedUser = findLastUserMessageMatching(
    messages as RecoveryMessage[],
    (message) => messageIndicatesEvidenceGatedCi(message),
  );
  const lastUser = lastEvidenceGatedUser ?? findLastUserMessage(messages as never);
  if (!messageIndicatesEvidenceGatedCi(lastUser as RecoveryMessage | undefined)) {
    return false;
  }

  for (let index = messages.length - 2; index >= 0; index -= 1) {
    const candidate = messages[index];
    const candidateID = getMessageID(candidate);
    if (!candidateID || getMessageRole(candidate) !== "assistant") {
      continue;
    }

    if (!isSisyphusExecutorAgent(getMessageAgent(candidate))) {
      continue;
    }

    const launchedVerifyWave = findRecoverableLaunchedSisyphusCiVerifyWaveTool(candidate.parts);
    if (!launchedVerifyWave) {
      continue;
    }

    const lastRecoveredMessageID = recoveredAbortedSisyphusCiVerifyWaveMessageBySession.get(sessionID);
    if (lastRecoveredMessageID === candidateID) {
      log("[event] sisyphus CI aborted verify-wave recovery skipped: message already recovered", {
        sessionID,
        source,
        candidateID,
      });
      return false;
    }

    const resumeConfig = extractResumeConfig(lastUser as never, sessionID);
    resumeConfig.directory = ctx.directory;
    resumeConfig.continuationText = SISYPHUS_CI_ABORTED_VERIFY_WAVE_RECOVERY_TEXT;
    const resumed = await resumeRecoveredPrometheusSession(
      ctx,
      sessionID,
      SISYPHUS_CI_ABORTED_VERIFY_WAVE_RECOVERY_TEXT,
      resumeConfig,
      session as RecoveryResumeSessionApi | undefined,
    );

    if (resumed) {
      recoveredAbortedSisyphusCiVerifyWaveMessageBySession.set(sessionID, candidateID);
      log("[event] recovered aborted verify-wave for Sisyphus CI tool call", {
        sessionID,
        source,
        candidateID,
        errorMessageID: lastMessageID,
        tool: launchedVerifyWave.tool,
      });
      return true;
    }

    return false;
  }

  return false;
}

function applyUserConfiguredFallbackChain(
  sessionID: string,
  agentName: string,
  currentProviderID: string,
  pluginConfig: OhMyOpenCodeConfig,
): void {
  const agentKey = getAgentConfigKey(agentName);
  const rawFallbackModels = getRawFallbackModels(sessionID, agentKey, pluginConfig);
  if (rawFallbackModels === undefined) return;

  if (rawFallbackModels.length === 0) {
    setSessionFallbackChain(sessionID, undefined);
    return;
  }

  const fallbackChain = buildFallbackChainFromModels(rawFallbackModels, currentProviderID);

  if (fallbackChain && fallbackChain.length > 0) {
    setSessionFallbackChain(sessionID, fallbackChain, { trustUnknownModels: true });
  }
}

function isCompactionAgent(agent: string): boolean {
  return agent.toLowerCase() === "compaction";
}

type EventInput = Parameters<NonNullable<NonNullable<CreatedHooks["writeExistingFileGuard"]>["event"]>>[0];
export function createEventHandler(args: {
  ctx: PluginContext;
  pluginConfig: OhMyOpenCodeConfig;
  firstMessageVariantGate: FirstMessageVariantGate;
  managers: Managers;
  hooks: CreatedHooks;
}): (input: EventInput) => Promise<void> {
  const { ctx, firstMessageVariantGate, managers, hooks } = args;
  const pluginContext = ctx as {
    directory: string;
    client: {
      session: {
        messages?: (input: { path: { id: string } }) => Promise<unknown>;
        abort: (input: { path: { id: string } }) => Promise<unknown>;
        promptAsync?: (input: {
          path: { id: string };
          body: { parts: Array<{ type: "text"; text: string }> };
          query: { directory: string };
        }) => Promise<unknown>;
        prompt: (input: {
          path: { id: string };
          body: { parts: Array<{ type: "text"; text: string }> };
          query: { directory: string };
        }) => Promise<unknown>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        summarize: (...args: any[]) => Promise<unknown>;
      };
    };
  };
  const isRuntimeFallbackEnabled =
    hooks.runtimeFallback !== null &&
    hooks.runtimeFallback !== undefined &&
    (typeof args.pluginConfig.runtime_fallback === "boolean"
      ? args.pluginConfig.runtime_fallback
      : (args.pluginConfig.runtime_fallback?.enabled ?? false));

  const isModelFallbackEnabled =
    hooks.modelFallback !== null && hooks.modelFallback !== undefined;

  // Avoid triggering multiple abort+continue cycles for the same failing assistant message.
  const lastHandledModelErrorMessageID = new Map<string, string>();
  const lastHandledRetryStatusKey = new Map<string, string>();
  const lastKnownModelBySession = new Map<string, { providerID: string; modelID: string }>();
  const continuationMarkerDirectory = getContinuationMarkerDirectory(args.ctx);
  const setRecoveryContinuationMarker = (
    sessionID: string,
    state: "active" | "idle",
    reason?: string,
  ): void => {
    if (!continuationMarkerDirectory) return;
    setContinuationMarkerSource(continuationMarkerDirectory, sessionID, "recovery", state, reason);
  };
  const clearEmptyAssistantRecoveryTimer = (sessionID: string): void => {
    clearSharedEmptyAssistantRecoveryTimer(sessionID);
    setRecoveryContinuationMarker(sessionID, "idle");
  };

  const clearAbortedToolRecoveryTimer = (sessionID: string): void => {
    clearSharedAbortedToolRecoveryTimer(sessionID);
  };

  const schedulePrometheusAbortedToolRecovery = (
    sessionID: string,
    expectedMessageID?: string,
    eventError?: unknown,
    source = "session.error.delayed",
  ): void => {
    clearAbortedToolRecoveryTimer(sessionID);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          abortedToolRecoveryTimers.delete(sessionID);
          if (hooks.stopContinuationGuard?.isStopped(sessionID)) {
            return;
          }

          const coordinator = hooks.runtimeFallback?._deps?.coordinator;
          coordinator?.observe(sessionID, {
            kind: "recovery_dispatched",
            recoveryKind: "aborted_tool",
          });

          const recovered = await maybeRecoverPrometheusAbortedToolWrapper(
            pluginContext,
            sessionID,
            expectedMessageID,
            source,
            eventError,
          );
          coordinator?.observe(sessionID, { kind: "recovery_result", success: recovered });
        } catch (error) {
          log("[event] delayed aborted-tool recovery failed", {
            sessionID,
            expectedMessageID,
            source,
            error,
          });
          const coordinator = hooks.runtimeFallback?._deps?.coordinator;
          coordinator?.observe(sessionID, { kind: "recovery_result", success: false });
        }
      })();
    }, PROMETHEUS_ABORTED_TOOL_RECOVERY_DELAY_MS);
    abortedToolRecoveryTimers.set(sessionID, timer);
  };

  const scheduleEmptyAssistantRecovery = (sessionID: string, messageID: string): void => {
    const previousMeta = emptyAssistantRecoveryTimerMetaBySession.get(sessionID);
    clearEmptyAssistantRecoveryTimer(sessionID);
    const delayMs = getEmptyAssistantRecoveryDelayMs(sessionID, messageID);
    setRecoveryContinuationMarker(sessionID, "active", "empty assistant recovery is pending");
    const timer = setTimeout(() => {
      void (async () => {
        try {
          emptyAssistantRecoveryTimers.delete(sessionID);
          emptyAssistantRecoveryTimerMetaBySession.delete(sessionID);

          // Phase 1: coordinator gates empty recovery decisions
          const coordinator = hooks.runtimeFallback?._deps?.coordinator;
          if (coordinator) {
            const decision = coordinator.observe(sessionID, {
              kind: "assistant_empty",
              messageID,
            });
            if (decision.action !== "recover_empty_turn" && decision.action !== "none") {
              log("[event] delayed empty assistant recovery suppressed by coordinator", {
                sessionID,
                messageID,
                coordinatorAction: decision.action,
                coordinatorReason: "reason" in decision ? decision.reason : undefined,
              });
              return;
            }
          }

          log("[event] running delayed empty assistant recovery", {
            sessionID,
            messageID,
          });

          if (hooks.stopContinuationGuard?.isStopped(sessionID)) {
            log("[event] delayed empty assistant recovery skipped: stop guard active", {
              sessionID,
              messageID,
            });
            return;
          }

          const recoverySnapshot = getAssistantRecoverySnapshot(sessionID, messageID);
          const recoveryAgent = recoverySnapshot?.agent ?? getSessionAgent(sessionID);
          if (isRuntimeFallbackEnabled && isPrometheusPlannerAgent(recoveryAgent)) {
            const recoveredPlannerReasoningOnly = await maybeRecoverPrometheusReasoningOnlyAssistantMessage(
              pluginContext,
              sessionID,
              messageID,
              "message.updated.delayed",
            );
            if (recoveredPlannerReasoningOnly) {
              return;
            }

            log("[event] delayed empty assistant recovery skipped: runtime fallback owns planner recovery", {
              sessionID,
              messageID,
              agent: recoveryAgent,
            });
            return;
          }

          // Notify coordinator that recovery is being dispatched
          coordinator?.observe(sessionID, {
            kind: "recovery_dispatched",
            recoveryKind: "empty_assistant",
          });

          const recoveredPendingTool = await maybeRecoverPrometheusPendingEmptyToolCall(
            pluginContext,
            sessionID,
            messageID,
            "message.updated.delayed",
          );
          if (recoveredPendingTool) {
            coordinator?.observe(sessionID, { kind: "recovery_result", success: true });
            return;
          }

          const recoveredPendingSisyphusTool = await maybeRecoverSisyphusCiPendingEmptyToolCall(
            pluginContext,
            sessionID,
            messageID,
            "message.updated.delayed",
          );
          if (recoveredPendingSisyphusTool) {
            coordinator?.observe(sessionID, { kind: "recovery_result", success: true });
            return;
          }

          const recoveredSisyphusGuardrailTool = await maybeRecoverSisyphusCiGuardrailToolError(
            pluginContext,
            sessionID,
            messageID,
            "message.updated.delayed",
          );
          if (recoveredSisyphusGuardrailTool) {
            coordinator?.observe(sessionID, { kind: "recovery_result", success: true });
            return;
          }

          const recoveredPlannerReasoningOnly = await maybeRecoverPrometheusReasoningOnlyAssistantMessage(
            pluginContext,
            sessionID,
            messageID,
            "message.updated.delayed",
          );
          if (recoveredPlannerReasoningOnly) {
            coordinator?.observe(sessionID, { kind: "recovery_result", success: true });
            return;
          }

          const recoveredSisyphusCiReasoningOnly = await maybeRecoverSisyphusCiReasoningOnlyAssistantMessage(
            pluginContext,
            sessionID,
            messageID,
            "message.updated.delayed",
          );
          if (recoveredSisyphusCiReasoningOnly) {
            coordinator?.observe(sessionID, { kind: "recovery_result", success: true });
            return;
          }

          const recoveredSisyphusInterruptedVisible = await maybeRecoverSisyphusCiInterruptedVisibleAssistantMessage(
            pluginContext,
            sessionID,
            messageID,
            "message.updated.delayed",
          );
          if (recoveredSisyphusInterruptedVisible) {
            coordinator?.observe(sessionID, { kind: "recovery_result", success: true });
            return;
          }

          const recovered = await maybeRecoverIdleEmptyAssistantMessage(
            pluginContext,
            sessionID,
            messageID,
            "message.updated.delayed",
          );
          coordinator?.observe(sessionID, { kind: "recovery_result", success: !!recovered });
        } catch (error) {
          log("[event] delayed empty assistant recovery failed", { sessionID, messageID, error });
        } finally {
          if (!emptyAssistantRecoveryTimers.has(sessionID)) {
            setRecoveryContinuationMarker(sessionID, "idle");
          }
        }
      })();
    }, delayMs);
    emptyAssistantRecoveryTimers.set(sessionID, timer);
    emptyAssistantRecoveryTimerMetaBySession.set(sessionID, { messageID, delayMs });
    if (previousMeta?.messageID !== messageID || previousMeta.delayMs !== delayMs) {
      log("[event] scheduled delayed empty assistant recovery", {
        sessionID,
        messageID,
        delayMs,
      });
    }
  };

  const resolveFallbackProviderID = (sessionID: string, providerHint?: string): string => {
    const sessionModel = getSessionModel(sessionID);
    if (sessionModel?.providerID) {
      return sessionModel.providerID;
    }

    const lastKnownModel = lastKnownModelBySession.get(sessionID);
    if (lastKnownModel?.providerID) {
      return lastKnownModel.providerID;
    }

    const normalizedProviderHint = providerHint?.trim();
    if (normalizedProviderHint) {
      return normalizedProviderHint;
    }

    const connectedProvider = readConnectedProvidersCache()?.[0];
    if (connectedProvider) {
      return connectedProvider;
    }

    return "opencode";
  };

  const getEventSessionID = (input: EventInput): string | undefined => {
    return getEventPropertiesSessionID(input.event.properties);
  };

  const runEventHookSafely = async (
    hookName: string,
    handler: ((input: EventInput) => unknown | Promise<unknown>) | null | undefined,
    input: EventInput,
  ): Promise<void> => {
    if (!handler) return;

    try {
      await Promise.resolve(handler(input));
    } catch (error) {
      log("[event] hook execution failed", {
        hook: hookName,
        eventType: input.event.type,
        sessionID: getEventSessionID(input),
        errorName: extractErrorName(error),
        errorMessage: extractErrorMessage(error),
      });
    }
  };

  const dispatchToHooks = async (input: EventInput): Promise<void> => {
    await runEventHookSafely("autoUpdateChecker", hooks.autoUpdateChecker?.event, input);
    await runEventHookSafely("legacyPluginToast", hooks.legacyPluginToast?.event, input);
    await runEventHookSafely("claudeCodeHooks", hooks.claudeCodeHooks?.event, input);
    await runEventHookSafely("backgroundNotificationHook", hooks.backgroundNotificationHook?.event, input);
    await runEventHookSafely("sessionNotification", hooks.sessionNotification, input);
    await runEventHookSafely("todoContinuationEnforcer", hooks.todoContinuationEnforcer?.handler, input);
    await runEventHookSafely("unstableAgentBabysitter", hooks.unstableAgentBabysitter?.event, input);
    await runEventHookSafely("contextWindowMonitor", hooks.contextWindowMonitor?.event, input);
    await runEventHookSafely("preemptiveCompaction", hooks.preemptiveCompaction?.event, input);
    await runEventHookSafely("directoryAgentsInjector", hooks.directoryAgentsInjector?.event, input);
    await runEventHookSafely("directoryReadmeInjector", hooks.directoryReadmeInjector?.event, input);
    await runEventHookSafely("rulesInjector", hooks.rulesInjector?.event, input);
    await runEventHookSafely("thinkMode", hooks.thinkMode?.event, input);
    await runEventHookSafely(
      "anthropicContextWindowLimitRecovery",
      hooks.anthropicContextWindowLimitRecovery?.event,
      input,
    );
    await runEventHookSafely("runtimeFallback", hooks.runtimeFallback?.event, input);
    await runEventHookSafely("agentUsageReminder", hooks.agentUsageReminder?.event, input);
    await runEventHookSafely("categorySkillReminder", hooks.categorySkillReminder?.event, input);
    await runEventHookSafely("interactiveBashSession", hooks.interactiveBashSession?.event, input as EventInput);
    await runEventHookSafely("ralphLoop", hooks.ralphLoop?.event, input);
    await runEventHookSafely("stopContinuationGuard", hooks.stopContinuationGuard?.event, input);
    await runEventHookSafely("compactionContextInjector", hooks.compactionContextInjector?.event, input);
    await runEventHookSafely("compactionTodoPreserver", hooks.compactionTodoPreserver?.event, input);
    await runEventHookSafely("writeExistingFileGuard", hooks.writeExistingFileGuard?.event, input);
    await runEventHookSafely("atlasHook", hooks.atlasHook?.handler, input);
    await runEventHookSafely("autoSlashCommand", hooks.autoSlashCommand?.event, input);
  };

  const recentSyntheticIdles = new Map<string, number>();
  const recentRealIdles = new Map<string, number>();
  const DEDUP_WINDOW_MS = 500;

  const shouldAutoRetrySession = (sessionID: string): boolean => {
    if (syncSubagentSessions.has(sessionID)) return true;
    const mainSessionID = getMainSessionID();
    if (mainSessionID) return sessionID === mainSessionID;
    // Headless runs (or resumed sessions) may not emit session.created, so mainSessionID can be unset.
    // In that case, treat any non-subagent session as the "main" interactive session.
    return !subagentSessions.has(sessionID);
  };

  const autoContinueAfterFallback = async (sessionID: string, source: string): Promise<void> => {
    await pluginContext.client.session.abort({ path: { id: sessionID } }).catch((error) => {
      log("[event] model-fallback abort failed", { sessionID, source, error });
    });

    const promptBody = {
      path: { id: sessionID },
      body: { parts: [{ type: "text" as const, text: "continue" }] },
      query: { directory: pluginContext.directory },
    };

    if (typeof pluginContext.client.session.promptAsync === "function") {
      await pluginContext.client.session.promptAsync(promptBody).catch((error) => {
        log("[event] model-fallback promptAsync failed", { sessionID, source, error });
      });
      return;
    }

    await pluginContext.client.session.prompt(promptBody).catch((error) => {
      log("[event] model-fallback prompt failed", { sessionID, source, error });
    });
  };

  const maybeRecoverPrometheusIdleSession = async (
    sessionID: string,
    source: string,
  ): Promise<boolean> => {
    if (
      !args.pluginConfig.experimental?.auto_resume
      || hooks.stopContinuationGuard?.isStopped(sessionID)
    ) {
      return false;
    }

    if (!isRuntimeFallbackEnabled) {
      const recoveredAbortedWrapper = await maybeRecoverPrometheusAbortedToolWrapper(
        pluginContext,
        sessionID,
        undefined,
        source,
      );
      if (recoveredAbortedWrapper) {
        return true;
      }

      const recoveredProviderBlockedTurn = await maybeRecoverPrometheusProviderBlockedTurn(
        pluginContext,
        sessionID,
        undefined,
        source,
        undefined,
        args.pluginConfig,
      );
      if (recoveredProviderBlockedTurn) {
        return true;
      }

      if (hasActivePrometheusProviderBlockedRetryWindow(sessionID)) {
        log("[event] Prometheus idle recovery skipped: provider-blocked retry window active", {
          sessionID,
          source,
        });
        return false;
      }

      const recoveredPendingTool = await maybeRecoverPrometheusPendingEmptyToolCall(
        pluginContext,
        sessionID,
        undefined,
        source,
      );
      if (recoveredPendingTool) {
        return true;
      }
    }

    const recoveredPendingSisyphusTool = await maybeRecoverSisyphusCiPendingEmptyToolCall(
      pluginContext,
      sessionID,
      undefined,
      source,
    );
    if (recoveredPendingSisyphusTool) {
      return true;
    }

    const recoveredSisyphusAbortedWrapper = await maybeRecoverSisyphusCiAbortedToolWrapper(
      pluginContext,
      sessionID,
      undefined,
      source,
    );
    if (recoveredSisyphusAbortedWrapper) {
      return true;
    }

    const recoveredSisyphusAbortedVerifyWave = await maybeRecoverSisyphusCiAbortedVerifyWave(
      pluginContext,
      sessionID,
      undefined,
      source,
    );
    if (recoveredSisyphusAbortedVerifyWave) {
      return true;
    }

    const recoveredPlannerReasoningOnly = await maybeRecoverPrometheusReasoningOnlyAssistantMessage(
      pluginContext,
      sessionID,
      undefined,
      source,
    );
    if (recoveredPlannerReasoningOnly) {
      return true;
    }

    const recoveredSisyphusCiReasoningOnly = await maybeRecoverSisyphusCiReasoningOnlyAssistantMessage(
      pluginContext,
      sessionID,
      undefined,
      source,
      { abortBeforeResume: true },
    );
    if (recoveredSisyphusCiReasoningOnly) {
      return true;
    }

    const recoveredSisyphusInterruptedVisible = await maybeRecoverSisyphusCiInterruptedVisibleAssistantMessage(
      pluginContext,
      sessionID,
      undefined,
      source,
    );
    if (recoveredSisyphusInterruptedVisible) {
      return true;
    }

    const recoveredInterruptedVisible = await maybeRecoverPrometheusInterruptedVisibleAssistantMessage(
      pluginContext,
      sessionID,
      undefined,
      source,
    );
    if (recoveredInterruptedVisible) {
      return true;
    }

    const recoveredPlannerCiVisibleSummary = await maybeRecoverPrometheusCiVisibleSummaryAssistantMessage(
      pluginContext,
      sessionID,
      undefined,
      source,
    );
    if (recoveredPlannerCiVisibleSummary) {
      return true;
    }

    const recoveredToolOnlyTurn = await maybeRecoverPrometheusToolOnlyAssistantTurn(
      pluginContext,
      sessionID,
      undefined,
      source,
    );
    if (recoveredToolOnlyTurn) {
      return true;
    }

    return maybeRecoverIdleEmptyAssistantMessage(pluginContext, sessionID, undefined, source);
  };

  return async (input): Promise<void> => {
    pruneRecentSyntheticIdles({
      recentSyntheticIdles,
      recentRealIdles,
      now: Date.now(),
      dedupWindowMs: DEDUP_WINDOW_MS,
    });

    if (input.event.type === "session.idle") {
      const sessionID = getEventPropertiesSessionID(input.event.properties);
      if (sessionID) {
        const emittedAt = recentSyntheticIdles.get(sessionID);
        if (emittedAt && Date.now() - emittedAt < DEDUP_WINDOW_MS) {
          recentSyntheticIdles.delete(sessionID);
          return;
        }
        recentRealIdles.set(sessionID, Date.now());
      }
    }

    await dispatchToHooks(input);

    const syntheticIdle = normalizeSessionStatusToIdle(input);
    if (syntheticIdle) {
      const sessionID = getEventPropertiesSessionID(syntheticIdle.event.properties);
      if (!sessionID) {
        return;
      }
      const emittedAt = recentRealIdles.get(sessionID);
      if (emittedAt && Date.now() - emittedAt < DEDUP_WINDOW_MS) {
        recentRealIdles.delete(sessionID);
        return;
      }
      recentSyntheticIdles.set(sessionID, Date.now());
      await dispatchToHooks(syntheticIdle as EventInput);
    }

    const { event } = input;
    const props = event.properties as Record<string, unknown> | undefined;

    if (event.type === "session.created") {
      const sessionInfo = props?.info as { id?: string; title?: string; parentID?: string } | undefined;

      if (!sessionInfo?.parentID) {
        setMainSession(sessionInfo?.id);
      }

      firstMessageVariantGate.markSessionCreated(sessionInfo);

      await managers.tmuxSessionManager.onSessionCreated(
        event as {
          type: string;
          properties?: {
            info?: { id?: string; parentID?: string; title?: string };
          };
        },
      );
    }

    if (event.type === "session.deleted") {
      const sessionInfo = props?.info as { id?: string } | undefined;
      if (sessionInfo?.id === getMainSessionID()) {
        setMainSession(undefined);
      }

      if (sessionInfo?.id) {
        const wasSyncSubagentSession = syncSubagentSessions.has(sessionInfo.id);
        clearSessionAgent(sessionInfo.id);
        lastHandledModelErrorMessageID.delete(sessionInfo.id);
        lastHandledRetryStatusKey.delete(sessionInfo.id);
        lastKnownModelBySession.delete(sessionInfo.id);
        clearEmptyAssistantRecoveryTimer(sessionInfo.id);
        assistantRecoverySnapshotBySession.delete(sessionInfo.id);
        recoveredPendingEmptyToolMessageBySession.delete(sessionInfo.id);
        recoveredPlannerReasoningOnlyMessageBySession.delete(sessionInfo.id);
        recoveredSisyphusCiReasoningOnlyMessageBySession.delete(sessionInfo.id);
        recoveredInterruptedPlannerVisibleMessageBySession.delete(sessionInfo.id);
        recoveredEmptyAssistantMessageBySession.delete(sessionInfo.id);
        clearPendingModelFallback(sessionInfo.id);
        clearSessionFallbackChain(sessionInfo.id);
        resetMessageCursor(sessionInfo.id);
        clearBackgroundOutputConsumptionsForParentSession(sessionInfo.id);
        clearBackgroundOutputConsumptionsForTaskSession(sessionInfo.id);
        firstMessageVariantGate.clear(sessionInfo.id);
        clearSessionModel(sessionInfo.id);
        clearSessionPromptParams(sessionInfo.id);
        recoveredProviderBlockedErrorMessageBySession.delete(sessionInfo.id);
        prometheusProviderBlockedRetryStateBySession.delete(sessionInfo.id);
        syncSubagentSessions.delete(sessionInfo.id);
        if (wasSyncSubagentSession) {
          subagentSessions.delete(sessionInfo.id);
        }
        deleteSessionTools(sessionInfo.id);
        await managers.skillMcpManager.disconnectSession(sessionInfo.id);
        await lspManager.cleanupTempDirectoryClients();
        await managers.tmuxSessionManager.onSessionDeleted({
          sessionID: sessionInfo.id,
        });
      }
    }

    if (event.type === "message.removed") {
      const messageID = props?.messageID as string | undefined;
      const sessionID = getEventPropertiesSessionID(props);
      restoreBackgroundOutputConsumption(sessionID, messageID);
    }

    if (event.type === "message.updated") {
      const info = props?.info as Record<string, unknown> | undefined;
      const sessionID = getEventPropertiesSessionID(props);
      const agent = info?.agent as string | undefined;
      const role = info?.role as string | undefined;
      const assistantMessageID = info?.id as string | undefined;
      const assistantError = info?.error;
      if (sessionID && role === "user") {
        clearEmptyAssistantRecoveryTimer(sessionID);
        clearAbortedToolRecoveryTimer(sessionID);
        assistantRecoverySnapshotBySession.delete(sessionID);
        const isCompactionMessage = agent ? isCompactionAgent(agent) : false;
        if (agent && !isCompactionMessage) {
          updateSessionAgent(sessionID, agent);
        }
        const providerID = info?.providerID as string | undefined;
        const modelID = info?.modelID as string | undefined;
        if (providerID && modelID && !isCompactionMessage) {
          lastKnownModelBySession.set(sessionID, { providerID, modelID });
          setSessionModel(sessionID, { providerID, modelID });
        }
      }

      // Model fallback: in practice, API/model failures often surface as assistant message errors.
      // session.error events are not guaranteed for all providers, so we also observe message.updated.
      if (
        sessionID
        && role === "assistant"
        && assistantMessageID
        && assistantError
        && args.pluginConfig.experimental?.auto_resume
        && !hooks.stopContinuationGuard?.isStopped(sessionID)
      ) {
        clearEmptyAssistantRecoveryTimer(sessionID);
        clearAbortedToolRecoveryTimer(sessionID);

        try {
          const recoveredSisyphusAbortedWrapper = await maybeRecoverSisyphusCiAbortedToolWrapper(
            pluginContext,
            sessionID,
            assistantMessageID,
            "message.updated.error",
            assistantError,
          );
          if (recoveredSisyphusAbortedWrapper) {
            return;
          }

          const recoveredSisyphusAbortedVerifyWave = await maybeRecoverSisyphusCiAbortedVerifyWave(
            pluginContext,
            sessionID,
            assistantMessageID,
            "message.updated.error",
            assistantError,
          );
          if (recoveredSisyphusAbortedVerifyWave) {
            return;
          }

          if (isRuntimeFallbackEnabled) {
            return;
          }

          const recoveredAbortedWrapper = await maybeRecoverPrometheusAbortedToolWrapper(
            pluginContext,
            sessionID,
            assistantMessageID,
            "message.updated.error",
            assistantError,
          );
          if (recoveredAbortedWrapper) {
            return;
          }
          schedulePrometheusAbortedToolRecovery(
            sessionID,
            assistantMessageID,
            assistantError,
            "message.updated.error.delayed",
          );

          const recoveredProviderBlockedTurn = await maybeRecoverPrometheusProviderBlockedTurn(
            pluginContext,
            sessionID,
            assistantMessageID,
            "message.updated.error",
            assistantError,
            args.pluginConfig,
          );
          if (recoveredProviderBlockedTurn) {
            return;
          }
        } catch (err) {
          log("[event] planning recovery failed in message.updated:", { sessionID, error: err });
        }
      }

      if (sessionID && role === "assistant" && !isRuntimeFallbackEnabled && isModelFallbackEnabled) {
        try {
          if (assistantMessageID && assistantError) {
            clearEmptyAssistantRecoveryTimer(sessionID);
            const lastHandled = lastHandledModelErrorMessageID.get(sessionID);
            if (lastHandled === assistantMessageID) {
              return;
            }

            const errorName = extractErrorName(assistantError);
            const errorMessage = extractErrorMessage(assistantError);
            const errorInfo = { name: errorName, message: errorMessage };

            if (shouldRetryError(errorInfo) || shouldSwitchFallback(errorInfo)) {
              // Prefer the agent/model/provider from the assistant message payload.
              let agentName = agent ?? getSessionAgent(sessionID);
              if (!agentName && sessionID === getMainSessionID()) {
                if (errorMessage.includes("claude-opus") || errorMessage.includes("opus")) {
                  agentName = "sisyphus";
                } else if (errorMessage.includes("gpt-5")) {
                  agentName = "hephaestus";
                } else {
                  agentName = "sisyphus";
                }
              }

              if (agentName) {
                const currentProvider = resolveFallbackProviderID(
                  sessionID,
                  info?.providerID as string | undefined,
                );
                const rawModel = (info?.modelID as string | undefined) ?? "claude-opus-4-6";
                const currentModel = normalizeFallbackModelID(rawModel);
                applyUserConfiguredFallbackChain(sessionID, agentName, currentProvider, args.pluginConfig);

                const setFallback = setPendingModelFallback(sessionID, agentName, currentProvider, currentModel);

                if (
                  setFallback &&
                  shouldAutoRetrySession(sessionID) &&
                  !hooks.stopContinuationGuard?.isStopped(sessionID)
                ) {
                  lastHandledModelErrorMessageID.set(sessionID, assistantMessageID);
                  await autoContinueAfterFallback(sessionID, "message.updated");
                }
              }
            }
          }
        } catch (err) {
          log("[event] model-fallback error in message.updated:", { sessionID, error: err });
        }
      }

      if (sessionID && role === "assistant" && args.pluginConfig.experimental?.auto_resume) {
        if (assistantMessageID && !assistantError) {
          prometheusProviderBlockedRetryStateBySession.delete(sessionID);
          const snapshot = upsertAssistantRecoverySnapshot(sessionID, assistantMessageID, agent);
          const shouldImmediatelyRecoverPlannerCiVisibleSummary =
            info?.finish === "stop"
            && isPrometheusPlannerAgent(snapshot.agent ?? getSessionAgent(sessionID));

          if (
            shouldImmediatelyRecoverPlannerCiVisibleSummary
            && !hooks.stopContinuationGuard?.isStopped(sessionID)
          ) {
            try {
              const recoveredPlannerCiVisibleSummary = await maybeRecoverPrometheusCiVisibleSummaryAssistantMessage(
                pluginContext,
                sessionID,
                assistantMessageID,
                "message.updated.finish-stop",
              );
              if (recoveredPlannerCiVisibleSummary) {
                return;
              }
            } catch (err) {
              log("[event] immediate planner ci visible-summary recovery failed in message.updated:", {
                sessionID,
                error: err,
              });
            }
          }

          const shouldImmediatelyRecoverPlannerReasoningOnly =
            info?.finish === "other"
            && isPrometheusPlannerAgent(snapshot.agent ?? getSessionAgent(sessionID))
            && !snapshot.hasUserFacingContent
            && snapshot.hasRecoverablePlannerInternalParts;

          if (
            shouldImmediatelyRecoverPlannerReasoningOnly
            && !hooks.stopContinuationGuard?.isStopped(sessionID)
          ) {
            try {
              const recoveredPlannerReasoningOnly = await maybeRecoverPrometheusReasoningOnlyAssistantMessage(
                pluginContext,
                sessionID,
                assistantMessageID,
                "message.updated.finish-other",
              );
              if (recoveredPlannerReasoningOnly) {
                return;
              }

              const recoveredSisyphusCiReasoningOnly = await maybeRecoverSisyphusCiReasoningOnlyAssistantMessage(
                pluginContext,
                sessionID,
                assistantMessageID,
                "message.updated.finish-other",
              );
              if (recoveredSisyphusCiReasoningOnly) {
                return;
              }
            } catch (err) {
              log("[event] immediate planner reasoning-only recovery failed in message.updated:", {
                sessionID,
                error: err,
              });
            }
          }

          const shouldImmediatelyRecoverSisyphusInterruptedVisible =
            info?.finish === "other"
            && isSisyphusExecutorAgent(snapshot.agent ?? getSessionAgent(sessionID))
            && snapshot.hasUserFacingContent;
          if (
            shouldImmediatelyRecoverSisyphusInterruptedVisible
            && !hooks.stopContinuationGuard?.isStopped(sessionID)
          ) {
            try {
              const recoveredSisyphusInterruptedVisible = await maybeRecoverSisyphusCiInterruptedVisibleAssistantMessage(
                pluginContext,
                sessionID,
                assistantMessageID,
                "message.updated.finish-other",
              );
              if (recoveredSisyphusInterruptedVisible) {
                return;
              }
            } catch (err) {
              log("[event] immediate sisyphus CI interrupted-visible recovery failed in message.updated:", {
                sessionID,
                error: err,
              });
            }
          }

          scheduleEmptyAssistantRecovery(sessionID, assistantMessageID);
        }
      }
    }

    if (event.type === "message.part.updated") {
      const part = isRecord(props?.part) ? (props?.part as RecoveryMessagePart & { sessionID?: string; sessionId?: string; messageID?: string; messageId?: string }) : undefined;
      const sessionID = getMessagePartUpdatedSessionID(props as Record<string, unknown> | undefined, part);
      const messageID = getMessagePartUpdatedMessageID(
        props as Record<string, unknown> | undefined,
        part,
        sessionID,
      );
      if (
        sessionID
        && messageID
        && args.pluginConfig.experimental?.auto_resume
      ) {
        updateAssistantRecoverySnapshotPart(sessionID, messageID, part);
        const snapshot = getAssistantRecoverySnapshot(sessionID, messageID);
        const shouldImmediatelyRecoverInterruptedPlannerTool =
          !!snapshot
          && isPrometheusPlannerAgent(snapshot.agent ?? getSessionAgent(sessionID))
          && isInterruptedRecoverablePrometheusToolPart(part);
        if (
          shouldImmediatelyRecoverInterruptedPlannerTool
          && !hooks.stopContinuationGuard?.isStopped(sessionID)
        ) {
          try {
            const recoveredPendingTool = await maybeRecoverPrometheusPendingEmptyToolCall(
              pluginContext,
              sessionID,
              messageID,
              "message.part.updated.interrupted-tool",
            );
            if (recoveredPendingTool) {
              return;
            }
          } catch (err) {
            log("[event] immediate interrupted-tool recovery failed in message.part.updated:", {
              sessionID,
              messageID,
              error: err,
            });
          }
        }
        const shouldImmediatelyRecoverSisyphusGuardrailTool =
          !!snapshot
          && isSisyphusExecutorAgent(snapshot.agent ?? getSessionAgent(sessionID))
          && !!snapshot.erroredSisyphusCiGuardrailTool;
        if (
          shouldImmediatelyRecoverSisyphusGuardrailTool
          && !hooks.stopContinuationGuard?.isStopped(sessionID)
        ) {
          try {
            const recoveredSisyphusGuardrailTool = await maybeRecoverSisyphusCiGuardrailToolError(
              pluginContext,
              sessionID,
              messageID,
              "message.part.updated.guardrail-tool",
            );
            if (recoveredSisyphusGuardrailTool) {
              return;
            }
          } catch (err) {
            log("[event] immediate sisyphus CI guardrail-tool recovery failed in message.part.updated:", {
              sessionID,
              messageID,
              error: err,
            });
          }
        }
        const shouldImmediatelyRecoverPlannerCiBootstrapTool =
          !!snapshot
          && (isPrometheusPlannerAgent(snapshot.agent ?? getSessionAgent(sessionID))
            || isAtlasPlanExecutorAgent(snapshot.agent ?? getSessionAgent(sessionID)))
          && !!snapshot.erroredPlannerCiBootstrapTool;
        if (
          shouldImmediatelyRecoverPlannerCiBootstrapTool
          && !hooks.stopContinuationGuard?.isStopped(sessionID)
        ) {
          try {
            const recoveredPlannerCiBootstrapTool = await maybeRecoverPlannerCiBootstrapToolError(
              pluginContext,
              sessionID,
              messageID,
              "message.part.updated.planner-ci-bootstrap-tool",
            );
            if (recoveredPlannerCiBootstrapTool) {
              return;
            }
          } catch (err) {
            log("[event] immediate planner CI bootstrap-tool recovery failed in message.part.updated:", {
              sessionID,
              messageID,
              error: err,
            });
          }
        }
        const plannerLikeAgent =
          isPrometheusPlannerAgent(snapshot?.agent ?? getSessionAgent(sessionID))
          || isAtlasPlanExecutorAgent(snapshot?.agent ?? getSessionAgent(sessionID));
        const shouldPreferPlannerRecovery =
          !!snapshot
          && plannerLikeAgent
          && (
            !!snapshot.pendingPrometheusTool
            || (
              !snapshot.hasUserFacingContent
              && snapshot.hasRecoverablePlannerInternalParts
            )
          );
        const shouldPreferSisyphusCiRecovery =
          !!snapshot
          && isSisyphusExecutorAgent(snapshot.agent ?? getSessionAgent(sessionID))
          && (
            !!snapshot.pendingSisyphusCiTool
            || (
              !snapshot.hasUserFacingContent
              && snapshot.hasRecoverablePlannerInternalParts
            )
          );
        if (shouldPreferPlannerRecovery || shouldPreferSisyphusCiRecovery) {
          scheduleEmptyAssistantRecovery(sessionID, messageID);
        } else if (snapshot?.hasVisibleContent) {
          clearEmptyAssistantRecoveryTimer(sessionID);
        }
      }
    }

    if ((event.type as string) === "message.part.delta") {
      const sessionID = getEventPropertiesSessionID(props);
      const messageID = (props?.messageID as string | undefined) ?? (props?.messageId as string | undefined);
      if (sessionID && args.pluginConfig.experimental?.auto_resume) {
        const snapshot = updateAssistantRecoverySnapshotDelta(sessionID, messageID, props?.delta);
        if (snapshot?.hasUserFacingContent) {
          clearEmptyAssistantRecoveryTimer(sessionID);
        } else if (snapshot?.messageID && !hooks.stopContinuationGuard?.isStopped(sessionID)) {
          scheduleEmptyAssistantRecovery(sessionID, snapshot.messageID);
        }
      }
    }

    if (event.type === "session.status") {
      const sessionID = getEventPropertiesSessionID(props);
      const status = props?.status as { type?: string; attempt?: number; message?: string; next?: number } | undefined;

      // Retry dedupe lifecycle: set key when a retry status is handled, clear it after recovery
      // (non-retry idle) so future failures with the same key can trigger fallback again.
      if (sessionID && status?.type === "idle") {
        lastHandledRetryStatusKey.delete(sessionID);
        clearEmptyAssistantRecoveryTimer(sessionID);

        try {
          const recoveredIdleSession = await maybeRecoverPrometheusIdleSession(
            sessionID,
            "session.status.idle",
          );
          if (recoveredIdleSession) {
            return;
          }
        } catch (err) {
          log("[event] idle session recovery failed in session.status:", { sessionID, error: err });
        }
      }

      if (sessionID && status?.type === "retry" && isModelFallbackEnabled && !isRuntimeFallbackEnabled) {
        try {
          const retryMessage = typeof status.message === "string" ? status.message : "";
          const parsedForKey = extractProviderModelFromErrorMessage(retryMessage);
          const retryAttempt = extractRetryAttempt(status.attempt, retryMessage);
          // Deduplicate countdown updates for the same retry attempt/model.
          // Messages like "retrying in 7m 56s" change every second but should only trigger once.
          const retryKey = `${retryAttempt}:${parsedForKey.providerID ?? ""}/${parsedForKey.modelID ?? ""}:${normalizeRetryStatusMessage(retryMessage)}`;
          if (lastHandledRetryStatusKey.get(sessionID) === retryKey) {
            return;
          }
          lastHandledRetryStatusKey.set(sessionID, retryKey);

          const errorInfo = { name: undefined as string | undefined, message: retryMessage };
          if (shouldRetryError(errorInfo) || shouldSwitchFallback(errorInfo)) {
            let agentName = getSessionAgent(sessionID);
            if (!agentName && sessionID === getMainSessionID()) {
              if (retryMessage.includes("claude-opus") || retryMessage.includes("opus")) {
                agentName = "sisyphus";
              } else if (retryMessage.includes("gpt-5")) {
                agentName = "hephaestus";
              } else {
                agentName = "sisyphus";
              }
            }

            if (agentName) {
              const parsed = extractProviderModelFromErrorMessage(retryMessage);
              const lastKnown = lastKnownModelBySession.get(sessionID);
              const currentProvider = resolveFallbackProviderID(sessionID, parsed.providerID);
              let currentModel = parsed.modelID ?? lastKnown?.modelID ?? "claude-opus-4-6";
              currentModel = normalizeFallbackModelID(currentModel);
              applyUserConfiguredFallbackChain(sessionID, agentName, currentProvider, args.pluginConfig);

              const setFallback = setPendingModelFallback(sessionID, agentName, currentProvider, currentModel);

              if (
                setFallback &&
                shouldAutoRetrySession(sessionID) &&
                !hooks.stopContinuationGuard?.isStopped(sessionID)
              ) {
                await autoContinueAfterFallback(sessionID, "session.status");
              }
            }
          }
        } catch (err) {
          log("[event] model-fallback error in session.status:", { sessionID, error: err });
        }
      }
    }

    if (event.type === "session.idle") {
      const sessionID = getEventPropertiesSessionID(props);
      if (sessionID) {
        clearEmptyAssistantRecoveryTimer(sessionID);

        try {
          const recoveredIdleSession = await maybeRecoverPrometheusIdleSession(
            sessionID,
            "session.idle",
          );
          if (recoveredIdleSession) {
            return;
          }
        } catch (err) {
          log("[event] idle session recovery failed in session.idle:", { sessionID, error: err });
        }
      }
    }

    if (event.type === "session.error") {
      try {
        const sessionID = getEventPropertiesSessionID(props);
        const error = props?.error;
        if (sessionID) {
          clearEmptyAssistantRecoveryTimer(sessionID);
          clearAbortedToolRecoveryTimer(sessionID);
        }

        const errorName = extractErrorName(error);
        const errorMessage = extractErrorMessage(error);
        const errorInfo = { name: errorName, message: errorMessage };
        const recoverableSessionRecovery = hooks.sessionRecovery;
        const sessionRecoveryCanHandleError = recoverableSessionRecovery?.isRecoverableError(error) ?? false;

        if (sessionRecoveryCanHandleError && recoverableSessionRecovery != null) {
          const messageInfo = {
            id: props?.messageID as string | undefined,
            role: "assistant" as const,
            sessionID,
            error,
          };
          const recovered = await recoverableSessionRecovery.handleSessionRecovery(messageInfo);

          if (
            recovered &&
            sessionID &&
            sessionID === getMainSessionID() &&
            !hooks.stopContinuationGuard?.isStopped(sessionID)
          ) {
            await pluginContext.client.session
              .summarize({
                path: { id: sessionID },
                body: buildRecoveryCompactionBody(args.pluginConfig, sessionID),
                query: { directory: pluginContext.directory },
              })
              .catch((err: unknown) => {
                log("[event] compaction before recovery continue failed:", { sessionID, error: err });
              });

            await pluginContext.client.session
              .prompt({
                path: { id: sessionID },
                body: { parts: [{ type: "text", text: "continue" }] },
                query: { directory: pluginContext.directory },
              })
              .catch(() => {});
          }

          if (recovered) {
            return;
          }
        }

        if (
          args.pluginConfig.experimental?.auto_resume
          && sessionID
          && !hooks.stopContinuationGuard?.isStopped(sessionID)
        ) {
          const recoveredSisyphusAbortedWrapper = await maybeRecoverSisyphusCiAbortedToolWrapper(
            pluginContext,
            sessionID,
            (props?.messageID as string | undefined) ?? (props?.messageId as string | undefined),
            "session.error",
            error,
          );
          if (recoveredSisyphusAbortedWrapper) {
            return;
          }

          const recoveredSisyphusAbortedVerifyWave = await maybeRecoverSisyphusCiAbortedVerifyWave(
            pluginContext,
            sessionID,
            (props?.messageID as string | undefined) ?? (props?.messageId as string | undefined),
            "session.error",
            error,
          );
          if (recoveredSisyphusAbortedVerifyWave) {
            return;
          }

          if (isRuntimeFallbackEnabled) {
            return;
          }

          const recoveredAbortedWrapper = await maybeRecoverPrometheusAbortedToolWrapper(
            pluginContext,
            sessionID,
            (props?.messageID as string | undefined) ?? (props?.messageId as string | undefined),
            "session.error",
            error,
          );
          if (recoveredAbortedWrapper) {
            return;
          }
          schedulePrometheusAbortedToolRecovery(
            sessionID,
            (props?.messageID as string | undefined) ?? (props?.messageId as string | undefined),
            error,
            "session.error.delayed",
          );

          const recoveredProviderBlockedTurn = await maybeRecoverPrometheusProviderBlockedTurn(
            pluginContext,
            sessionID,
            (props?.messageID as string | undefined) ?? (props?.messageId as string | undefined),
            "session.error",
            error,
            args.pluginConfig,
          );
          if (recoveredProviderBlockedTurn) {
            return;
          }
        }

        // Try model fallback for model errors (rate limit, quota, provider issues, etc.)
        if (sessionID && (shouldRetryError(errorInfo) || shouldSwitchFallback(errorInfo)) && !isRuntimeFallbackEnabled && isModelFallbackEnabled) {
          let agentName = getSessionAgent(sessionID);

          if (!agentName && sessionID === getMainSessionID()) {
            if (errorMessage.includes("claude-opus") || errorMessage.includes("opus")) {
              agentName = "sisyphus";
            } else if (errorMessage.includes("gpt-5")) {
              agentName = "hephaestus";
            } else {
              agentName = "sisyphus";
            }
          }

          if (agentName) {
            const parsed = extractProviderModelFromErrorMessage(errorMessage);
            const currentProvider = resolveFallbackProviderID(
              sessionID,
              (props?.providerID as string | undefined) || parsed.providerID,
            );
            let currentModel = (props?.modelID as string) || parsed.modelID || "claude-opus-4-6";
            currentModel = normalizeFallbackModelID(currentModel);
            applyUserConfiguredFallbackChain(sessionID, agentName, currentProvider, args.pluginConfig);

            const setFallback = setPendingModelFallback(sessionID, agentName, currentProvider, currentModel);

            if (
              setFallback &&
              shouldAutoRetrySession(sessionID) &&
              !hooks.stopContinuationGuard?.isStopped(sessionID)
            ) {
              await autoContinueAfterFallback(sessionID, "session.error");
            }
          }
        }
      } catch (err) {
        const sessionID = getEventPropertiesSessionID(props);
        log("[event] model-fallback error in session.error:", { sessionID, error: err });
      }
    }
  };
}
