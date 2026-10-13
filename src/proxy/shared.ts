/**
 * Shared state module for proxy orchestration.
 * Extracted from proxy.js to decouple translators from main orchestration.
 */

// ─── Types ────────────────────────────────────────────────────────────────

export interface StreamContext {
  accumulatedText: string;
  accumulatedReasoning: string;
  toolCalls: Record<number, { id: string; name: string; arguments: string }>;
}

export interface StateTimestamps {
  streamCtx: Map<string, number>;
  toolCallIds: Map<string, number>;
  translatedCalls: Map<string, number>;
  reasoning: Map<string, number>;
  subagentIntents: Map<string, number>;
  subagentOverrides: Map<string, number>;
}

export interface TranslatedCallInfo {
  originalName: string;
  translatedName: string;
  cmd: string;
  cwd: string;
}

// ─── State ────────────────────────────────────────────────────────────────

/** modelName → { "functionName": "original_tool_call_id" } */
export const modelToolCallIds = new Map<string, Record<string, string>>();

/** modelName → preserved reasoning_content from previous turn */
export const modelReasoningContent = new Map<string, string>();

/** streamId → { accumulatedText, accumulatedReasoning, toolCalls } */
export const activeStreamContexts = new Map<string, StreamContext>();

/** toolCallId → { originalName, translatedName, cmd, cwd } */
export const translatedToolCalls = new Map<string, TranslatedCallInfo>();

/**
 * toolCallId → intended subagent model names aligned with the invoke_subagent
 * Subagents array ('' keeps the tier the model chose). Populated when the proxy
 * rewrites a custom Model value to 'inherit' so the language server accepts it.
 */
export const subagentIntents = new Map<string, string[]>();

/** subagent conversationId → intended model name for that subagent's requests. */
export const subagentModelOverrides = new Map<string, string>();

/** State entry timestamps for periodic cleanup */
export const stateTimestamps: StateTimestamps = {
  streamCtx: new Map(),
  toolCallIds: new Map(),
  translatedCalls: new Map(),
  reasoning: new Map(),
  subagentIntents: new Map(),
  subagentOverrides: new Map(),
};

// ─── Helpers ──────────────────────────────────────────────────────────────

export function touchStateTimestamp(map: Map<string, number>, key: string): void {
  map.set(key, Date.now());
}

// ─── Periodic Cleanup (managed lifecycle) ─────────────────────────────────

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function startCleanupInterval(): void {
  if (cleanupInterval) return; // already running
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    const STREAM_TTL = 600_000; // 10 minutes for active stream contexts
    const TOOL_TTL = 1_800_000; // 30 minutes for tool call IDs & reasoning
    const SUBAGENT_OVERRIDE_TTL = 21_600_000; // 6 hours; subagents may run long

    for (const [key, ts] of stateTimestamps.streamCtx) {
      if (now - ts > STREAM_TTL) {
        activeStreamContexts.delete(key);
        stateTimestamps.streamCtx.delete(key);
      }
    }
    for (const [key, ts] of stateTimestamps.subagentIntents) {
      if (now - ts > TOOL_TTL) {
        subagentIntents.delete(key);
        stateTimestamps.subagentIntents.delete(key);
      }
    }
    for (const [key, ts] of stateTimestamps.subagentOverrides) {
      if (now - ts > SUBAGENT_OVERRIDE_TTL) {
        subagentModelOverrides.delete(key);
        stateTimestamps.subagentOverrides.delete(key);
      }
    }
    for (const [key, ts] of stateTimestamps.toolCallIds) {
      if (now - ts > TOOL_TTL) {
        modelToolCallIds.delete(key);
        stateTimestamps.toolCallIds.delete(key);
      }
    }
    for (const [key, ts] of stateTimestamps.translatedCalls) {
      if (now - ts > TOOL_TTL) {
        translatedToolCalls.delete(key);
        stateTimestamps.translatedCalls.delete(key);
      }
    }
    for (const [key, ts] of stateTimestamps.reasoning) {
      if (now - ts > TOOL_TTL) {
        modelReasoningContent.delete(key);
        stateTimestamps.reasoning.delete(key);
      }
    }
  }, 300_000);
  // Importing translator/model-management helpers must not keep a CLI process alive.
  cleanupInterval.unref?.();
}

export function stopCleanupInterval(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

// Auto-start for backward compatibility (will be replaced by proxy.ts lifecycle)
startCleanupInterval();
