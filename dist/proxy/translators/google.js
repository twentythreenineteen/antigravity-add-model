"use strict";
/**
 * Google AI Studio Translator.
 *
 * Google AI Studio speaks Gemini format natively, so request/response
 * translation is a passthrough. The main addition is SSE streaming chunk
 * parsing and proper endpoint URL handling.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.mapGeminiToGoogle = mapGeminiToGoogle;
exports.mapGoogleToGemini = mapGoogleToGemini;
exports.mapGoogleChunkToGemini = mapGoogleChunkToGemini;
exports.getGoogleApiUrl = getGoogleApiUrl;
// ─── Types ────────────────────────────────────────────────────────────────
const utils_1 = require("./utils");
const shared_1 = require("../shared");
// ─── Request Translation (Passthrough) ────────────────────────────────────
const SUBAGENT_FALLBACK_KEY = 'google_subagent_bridge';
/**
 * Google AI Studio uses the same Gemini format — just pass through.
 * The caller handles URL routing (streamGenerateContent vs generateContent).
 */
function mapGeminiToGoogle(geminiBody, _modelName) {
    // Native Gemini identifies the model and streaming method in the URL.
    const body = { ...geminiBody };
    delete body.model;
    delete body.modelId;
    delete body.model_id;
    delete body.stream;
    delete body.sessionId;
    delete body.conversationId;
    (0, utils_1.relaxSubagentTools)(body.tools);
    rewriteSubagentHistory(body.contents);
    return body;
}
/** Restores intended Model values in invoke_subagent history and binds spawned conversationIds. */
function rewriteSubagentHistory(contents) {
    if (!Array.isArray(contents))
        return;
    for (const item of contents) {
        if (!item.parts)
            continue;
        for (const p of item.parts) {
            if (p.functionCall && p.functionCall.name === 'invoke_subagent') {
                (0, utils_1.restoreSubagentModelArgs)('invoke_subagent', p.functionCall.id || 'call_invoke_subagent', p.functionCall.args);
            }
            if (p.functionResponse && p.functionResponse.name === 'invoke_subagent') {
                const modelTCIds = shared_1.modelToolCallIds.get(SUBAGENT_FALLBACK_KEY) || {};
                (0, utils_1.bindSubagentIntents)('invoke_subagent', p.functionResponse.id || modelTCIds['invoke_subagent'] || 'call_invoke_subagent', p.functionResponse.response);
            }
        }
    }
}
// ─── Response Translation (Passthrough) ───────────────────────────────────
/**
 * Google AI Studio returns Gemini-format responses directly.
 * Pass through, rewriting invoke_subagent Model values (custom model names are
 * not accepted by the language server) and recording the intended models.
 */
function mapGoogleToGemini(googleRes, _modelName) {
    rewriteSubagentIntentResponses(googleRes);
    return googleRes;
}
/** Rewrites invoke_subagent Model args in a Gemini-format response. */
function rewriteSubagentIntentResponses(googleRes) {
    const res = googleRes;
    if (!res || !Array.isArray(res.candidates))
        return;
    for (const candidate of res.candidates) {
        const parts = candidate.content?.parts;
        if (!Array.isArray(parts))
            continue;
        for (const p of parts) {
            if (!p.functionCall || p.functionCall.name !== 'invoke_subagent')
                continue;
            const key = p.functionCall.id || 'call_invoke_subagent';
            (0, utils_1.rewriteSubagentModelIntent)('invoke_subagent', p.functionCall.args, key);
            const modelTCIds = shared_1.modelToolCallIds.get(SUBAGENT_FALLBACK_KEY) || {};
            modelTCIds['invoke_subagent'] = key;
            shared_1.modelToolCallIds.set(SUBAGENT_FALLBACK_KEY, modelTCIds);
            (0, shared_1.touchStateTimestamp)(shared_1.stateTimestamps.toolCallIds, SUBAGENT_FALLBACK_KEY);
        }
    }
}
// ─── Streaming Chunk Translation ──────────────────────────────────────────
/**
 * Parse a Google AI Studio SSE streaming chunk into a Gemini candidate.
 *
 * Google AI Studio streams JSON chunks like:
 *   {"candidates":[{"content":{"parts":[{"text":"Hello"}],"role":"model"},...}]}
 *
 * Each chunk contains complete candidate objects (not deltas).
 */
function mapGoogleChunkToGemini(chunk, _modelName) {
    if (!chunk || typeof chunk !== 'object')
        return null;
    const data = chunk;
    rewriteSubagentIntentResponses(data);
    // Extract first candidate
    if (!data.candidates || data.candidates.length === 0)
        return null;
    const candidate = data.candidates[0];
    // Check if there's actual content to emit
    const parts = candidate.content?.parts;
    if (!parts || parts.length === 0) {
        // Might be a final chunk with just finishReason
        if (candidate.finishReason) {
            return {
                content: { parts: [], role: 'model' },
                finishReason: candidate.finishReason,
                index: candidate.index ?? 0,
            };
        }
        return null;
    }
    return {
        content: candidate.content,
        finishReason: candidate.finishReason || 'OTHER',
        index: candidate.index ?? 0,
        safetyRatings: candidate.safetyRatings,
    };
}
// ─── URL Helpers ──────────────────────────────────────────────────────────
/**
 * Constructs the correct Google AI Studio endpoint URL based on streaming mode.
 *
 * Google AI Studio uses different endpoints:
 *   - Non-streaming: :generateContent
 *   - Streaming:     :streamGenerateContent
 *
 * If the user's URL already contains one of these endpoints, it's kept as-is.
 */
function getGoogleApiUrl(baseUrl, modelName, isStream) {
    const url = new URL(baseUrl);
    let pathname = url.pathname.replace(/\/+$/, '').replace(/:(?:streamGenerateContent|generateContent)$/, '');
    const modelsIndex = pathname.lastIndexOf('/models/');
    const existingModel = modelsIndex >= 0 ? pathname.slice(modelsIndex + 8) : '';
    const chosenModel = (modelName || '').replace(/^models\//, '') || decodeURIComponent(existingModel);
    if (!chosenModel)
        throw new Error('Google endpoint requires a model name');
    if (modelsIndex >= 0)
        pathname = pathname.slice(0, modelsIndex);
    else if (pathname.endsWith('/models'))
        pathname = pathname.slice(0, -7);
    if (!pathname)
        pathname = '/v1beta';
    url.pathname = `${pathname}/models/${encodeURIComponent(chosenModel)}:${isStream ? 'streamGenerateContent' : 'generateContent'}`;
    if (isStream)
        url.searchParams.set('alt', 'sse');
    else if (url.searchParams.get('alt') === 'sse')
        url.searchParams.delete('alt');
    return url.toString();
}
//# sourceMappingURL=google.js.map