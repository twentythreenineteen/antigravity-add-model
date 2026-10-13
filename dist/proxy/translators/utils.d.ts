/**
 * Shared translator utility functions.
 * Extracted from proxy.js to avoid duplication across translator modules.
 */
export interface GeminiParameterProperties {
    type?: string;
    properties?: GeminiParameterProperties;
    items?: GeminiParameterProperties;
    [key: string]: unknown;
}
export interface ToolCallArgs {
    CommandLine?: string;
    Cwd?: string;
    [key: string]: unknown;
}
export interface TranslatedToolCall {
    name: string;
    args: Record<string, unknown>;
}
export interface TranslatedCallInfo {
    originalName: string;
    translatedName: string;
    cmd: string;
    cwd?: string;
}
export interface MatchResult {
    Filename: string;
    LineNumber: number;
    LineContent: string;
}
export interface DirectoryItem {
    name: string;
    isDir: boolean;
    sizeBytes?: number;
}
export interface FileListResponse {
    files?: DirectoryItem[];
    children?: DirectoryItem[];
    content?: string;
    CodeContent?: string;
}
export type ToolResponse = string | DirectoryItem[] | MatchResult[] | FileListResponse;
/** Tool declarations belong to one request, never to a shared model/session cache. */
export type ToolSchemas = ReadonlyMap<string, unknown>;
export declare function collectToolSchemas(body: unknown): ToolSchemas;
/**
 * Resolve explicit legacy aliases only. Live declarations take precedence over
 * historical tool signatures; arbitrary values must never become file paths.
 */
export declare function normalizeToolArgs(name: string, args: Record<string, unknown> | null | undefined, schemas?: ToolSchemas): Record<string, unknown>;
/** Return a provider-compatible copy without changing the caller's tool schema. */
export declare function normalizeToolSchema(schema: object): Record<string, unknown>;
/**
 * Removes the invoke_subagent Model enum and rewrites its description so models
 * are free to pass any model name (including custom models), not only the
 * built-in tiers.
 */
export declare function allowAnySubagentModel(toolName: string, schema: unknown): void;
/**
 * Relaxes the invoke_subagent Model restriction across a Gemini-format tools array.
 */
export declare function relaxSubagentTools(tools: unknown): void;
/**
 * The language server only accepts the built-in tiers for the invoke_subagent
 * Model argument. When a model asks for another model (e.g. a custom model),
 * rewrite the value to 'inherit' so the spawn succeeds, and remember the
 * intended model per subagent so the proxy can reroute the spawned subagent's
 * requests. Intended models are bound to subagent conversationIds later, when
 * the invoke_subagent tool response (which lists them) flows back.
 */
export declare function rewriteSubagentModelIntent(name: string, args: Record<string, unknown> | undefined, toolCallId: string): void;
/**
 * Binds recorded invoke_subagent model intents to the subagent conversationIds
 * listed in the tool response, so later requests from those conversations are
 * rerouted to the intended custom model. Safe to call on every history replay:
 * binding is idempotent, and intents are retained so the conversation history
 * sent back to the model can be restored (see restoreSubagentModelArgs).
 */
export declare function bindSubagentIntents(name: string, toolCallId: string, response: unknown): void;
/**
 * Restores the original Model values the model asked for in invoke_subagent
 * tool calls when replaying conversation history back to the model. The proxy
 * rewrites them to 'inherit' for the language server; without restoring them,
 * the model sees its own calls as if it had used 'inherit' and retries.
 */
export declare function restoreSubagentModelArgs(name: string, toolCallId: string, args: Record<string, unknown> | undefined): void;
/**
 * Recursively converts Gemini parameter types (UPPERCASE) to lowercase format.
 * Gemini uses uppercase (STRING, NUMBER); OpenAI/Anthropic need lowercase.
 */
export declare function fixParamTypes(properties: Record<string, unknown> | undefined): void;
/**
 * Translates generic shell/terminal commands (run_command) into native Antigravity file tools.
 */
export declare function translateToolCallToNative(name: string, args: ToolCallArgs, schemas?: ToolSchemas): TranslatedToolCall;
/**
 * Formats native file tool outputs (JSON/Array) back into standard textual command-line outputs.
 */
export declare function formatTranslatedResponse(translatedInfo: TranslatedCallInfo, responseData: unknown): string;
//# sourceMappingURL=utils.d.ts.map