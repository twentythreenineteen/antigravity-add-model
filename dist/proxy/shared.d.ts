/**
 * Shared state module for proxy orchestration.
 * Extracted from proxy.js to decouple translators from main orchestration.
 */
export interface StreamContext {
    accumulatedText: string;
    accumulatedReasoning: string;
    toolCalls: Record<number, {
        id: string;
        name: string;
        arguments: string;
    }>;
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
/** modelName → { "functionName": "original_tool_call_id" } */
export declare const modelToolCallIds: Map<string, Record<string, string>>;
/** modelName → preserved reasoning_content from previous turn */
export declare const modelReasoningContent: Map<string, string>;
/** streamId → { accumulatedText, accumulatedReasoning, toolCalls } */
export declare const activeStreamContexts: Map<string, StreamContext>;
/** toolCallId → { originalName, translatedName, cmd, cwd } */
export declare const translatedToolCalls: Map<string, TranslatedCallInfo>;
/**
 * toolCallId → intended subagent model names aligned with the invoke_subagent
 * Subagents array ('' keeps the tier the model chose). Populated when the proxy
 * rewrites a custom Model value to 'inherit' so the language server accepts it.
 */
export declare const subagentIntents: Map<string, string[]>;
/** subagent conversationId → intended model name for that subagent's requests. */
export declare const subagentModelOverrides: Map<string, string>;
/** State entry timestamps for periodic cleanup */
export declare const stateTimestamps: StateTimestamps;
export declare function touchStateTimestamp(map: Map<string, number>, key: string): void;
export declare function startCleanupInterval(): void;
export declare function stopCleanupInterval(): void;
//# sourceMappingURL=shared.d.ts.map