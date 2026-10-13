/**
 * Antigravity Local Proxy Server.
 * Routes requests to Google, OpenAI, Anthropic, Ollama, and custom provider endpoints.
 * Intercepts model lists to inject user-defined custom models.
 */

import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import log from 'electron-log';

// ─── Types ────────────────────────────────────────────────────────────────

export interface CustomModel {
  name: string;
  displayName: string;
  description: string;
  provider: string;
  apiKey: string;
  apiUrl: string;
  externalModelName: string;
  allowUnauthorized?: boolean;
  encrypted?: boolean;
  _slug?: string;
  timeout?: number;
  maxRetries?: number;
  enabled?: boolean;
  apiFormat?: import('./providers').ApiFormat;
  fallbackModels?: string[];
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  thinkingBudget?: number;
  maxOutputTokens?: number;
  contextWindow?: number;
  idleTimeout?: number;
  retryBudgetMs?: number;
  circuitBreaker?: import('./proxy/circuitBreaker').CircuitBreakerOptions;
  customHeaders?: Record<string, string>;
  encryptedHeaders?: boolean;
  extraBody?: Record<string, unknown>;
  rawUrl?: boolean;
  gateway?: boolean;
  supportsVision?: boolean;
  supportsThinking?: boolean;
  googleProject?: string;
  googleAccounts?: import('./googleAccounts').GoogleAccount[];
  googlePool?: import('./googleAccounts').GooglePoolOptions;
  encryptedGoogleAccounts?: boolean;
}

interface GeminiRequestBody {
  [key: string]: unknown;
  model?: string;
  modelId?: string;
  model_id?: string;
  sessionId?: string;
  conversationId?: string;
  labels?: Record<string, unknown>;
  request?: GeminiRequestBody;
  systemInstruction?: { parts: { text?: string }[] };
  contents?: {
    parts?: { text?: string; functionCall?: unknown; functionResponse?: unknown; thought?: boolean }[];
    role?: string;
  }[];
  tools?: unknown[];
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
  };
}

// ─── Imports ──────────────────────────────────────────────────────────────

let server: http.Server | null = null;
let proxyPort = 0;
let startingProxy: Promise<number> | null = null;
let stoppingProxy: Promise<void> | null = null;
let serviceDataDirectory: string | undefined;
let shutdownGraceMs: number | undefined;
let cloudCodeRouting: CloudCodeRouting | undefined;

export interface ProxyStartOptions {
  /** Fixed loopback port for the IDE service; no automatic port fallback. */
  port?: number;
  dataDirectory?: string;
  /** Addon-owned HTTP management routes. Return true when handled. */
  handleManagement?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean;
  /** Node service only: bound shutdown of unfinished management HTTP bodies. */
  shutdownGraceMs?: number;
  /** IDE account bootstrap uses PROD, then the account's declared Cloud Code tier. */
  ideCloudCodeRouting?: boolean;
}

// Shared cross-turn state
import {
  modelToolCallIds,
  modelReasoningContent,
  activeStreamContexts,
  translatedToolCalls,
  stateTimestamps,
  startCleanupInterval,
  stopCleanupInterval,
} from './proxy/shared';

// Model configuration & capability detection
import { detectModelCapabilities } from './proxy/modelUtils';
import { CloudCodeRouting } from './proxy/cloudCodeRouting';
import { catalogModelSlug, catalogDisplayNames, localModelSlug, mergeCloudCodeCatalog } from './proxy/modelCatalog';
import { allocateModelIdentities, ModelIdentity } from './modelIdentity';

// Custom request transport and model storage
import { runCustomModelRequest, getProxyMetrics, stopCustomRequests } from './proxy/customRequest';
import { readModelConfig, writeJsonAtomic } from './modelStore';
import { getRequiredProxyPort, listenProxy } from './proxy/listen';
import { subagentRouting, SubagentRoutingError } from './proxy/subagentRouting';
import type { SubagentModelResolver, SubagentRoutingContext } from './proxy/subagentRouting';
import { resolveConfiguredSubagentModel } from './proxy/subagentModels';

// Dynamic imports (stays require for Electron-specific modules)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cryptoStore = require('./cryptoStore');

// ─── Model Helpers ────────────────────────────────────────────────────────

function getCustomModelsPath(): string {
  const geminiDir =
    serviceDataDirectory || path.join(require('electron').app.getPath('home'), '.gemini', 'antigravity');
  return path.join(geminiDir, 'custom_models.json');
}

function modelIdentities(models: CustomModel[], upstream?: unknown): Map<string, ModelIdentity> {
  try {
    // Include disabled entries so toggling an effort variant cannot reassign another model's identity.
    const saved = readModelConfig(getCustomModelsPath()).filter(
      (model) => typeof model.name === 'string' && model.name,
    );
    const configured = [...new Map([...saved, ...models].map((model) => [model.name, model])).values()];
    return new Map(
      allocateModelIdentities(path.dirname(getCustomModelsPath()), configured, upstream).map((identity) => [
        identity.name,
        identity,
      ]),
    );
  } catch (error) {
    log.error(
      '[Proxy] Native model identities unavailable; custom models remain accessible by their direct aliases:',
      error,
    );
    return new Map(
      models.map((model) => [model.name, { name: model.name, catalogId: catalogModelSlug(model, models) }]),
    );
  }
}

function matchCustomModel(models: CustomModel[], ...selectors: unknown[]): CustomModel | undefined {
  const identities = modelIdentities(models);
  // Named aliases remain available even when the finite native enum pool is exhausted.
  for (const selector of selectors) {
    if (typeof selector !== 'string') continue;
    const exact = models.find((model) => model.name === selector);
    if (exact) return exact;
    const named = models.find(
      (model) =>
        identities.get(model.name)?.catalogId === selector.replace(/^models\//, '') ||
        localModelSlug(model) === selector.replace(/^models\//, ''),
    );
    if (named) return named;
  }
  return models.find((model) => {
    const identity = identities.get(model.name);
    return (
      identity?.placeholderId &&
      selectors.some(
        (selector) =>
          selector === identity.placeholderId ||
          selector === `models/${identity.placeholderId}` ||
          selector === identity.placeholderValue,
      )
    );
  });
}

function customCloudCodeCatalog(upstream: unknown = {}): Record<string, unknown> {
  const models = loadCustomModels();
  const identities = modelIdentities(models, upstream);
  const labels = catalogDisplayNames(models, upstream);
  return mergeCloudCodeCatalog(
    upstream,
    models
      .filter((model) => identities.get(model.name)?.placeholderId)
      .map((model) => {
        const identity = identities.get(model.name)!;
        const slug = identity.catalogId;
        const cap = detectModelCapabilities(model);
        const capabilities = getAdvertisedModelCapabilities(model);
        return {
          slug,
          mapEntry: {
            displayName: labels.get(model.name),
            ...capabilities,
            recommended: true,
            maxTokens: cap.maxTokens,
            maxOutputTokens: cap.maxOutputTokens,
            tokenizerType: 'LLAMA_WITH_SPECIAL',
            model: identity.placeholderId,
            apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
            modelProvider: 'MODEL_PROVIDER_GOOGLE',
          },
          listEntry: {
            name: 'models/' + slug,
            version: '1.0',
            displayName: labels.get(model.name),
            description: model.description,
            ...capabilities,
            inputTokenLimit: cap.maxTokens,
            outputTokenLimit: cap.maxOutputTokens,
            supportedGenerationMethods: ['generateContent', 'countTokens'],
          },
        };
      }),
  );
}

function getAdvertisedModelCapabilities(model: CustomModel) {
  const cap = detectModelCapabilities(model);
  const nativeGoogle =
    !model.gateway &&
    (model.apiFormat === 'google' || (!model.apiFormat && ['google', 'google-cloudcode'].includes(model.provider)));
  return {
    supportsImages: cap.supportsImages,
    supportsThinking: cap.isThinking,
    supportsVideo: false,
    supportedMimeTypes: {
      ...(cap.supportsImages
        ? {
            'image/png': true,
            'image/jpeg': true,
            'image/webp': true,
            'image/gif': true,
            ...(nativeGoogle ? { 'image/heic': true, 'image/heif': true } : {}),
          }
        : {}),
      'text/plain': true,
      'text/markdown': true,
      'text/html': true,
      'text/css': true,
      'text/xml': true,
      'text/csv': true,
      'application/json': true,
      'application/pdf': true,
      'application/x-javascript': true,
      'application/x-typescript': true,
      'application/x-python-code': true,
      'application/x-ipynb+json': true,
    },
  };
}

// ─── Model Loading ────────────────────────────────────────────────────────

function loadCustomModels(): CustomModel[] {
  const filePath = getCustomModelsPath();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { validateCustomModel } = require('./schemaValidator');

  if (!fs.existsSync(filePath)) {
    const defaultModels = {
      models: [
        {
          name: 'models/gpt-4o',
          displayName: 'GPT-4o (OpenAI via Proxy)',
          description: 'OpenAI GPT-4o model redirected through proxy',
          provider: 'openai',
          apiKey: process.env.OPENAI_API_KEY || 'YOUR_OPENAI_API_KEY',
          apiUrl: 'https://api.openai.com/v1/chat/completions',
          externalModelName: 'gpt-4o',
        },
        {
          name: 'models/claude-3-5-sonnet',
          displayName: 'Claude 3.5 Sonnet (Anthropic via Proxy)',
          description: 'Anthropic Claude 3.5 Sonnet model redirected through proxy',
          provider: 'anthropic',
          apiKey: process.env.ANTHROPIC_API_KEY || 'YOUR_ANTHROPIC_API_KEY',
          apiUrl: 'https://api.anthropic.com/v1/messages',
          externalModelName: 'claude-3-5-sonnet-latest',
        },
        {
          name: 'models/llama3',
          displayName: 'Llama 3 (Local Ollama)',
          description: 'Local Ollama Llama 3 model run on your machine',
          provider: 'ollama',
          apiUrl: 'http://localhost:11434/v1/chat/completions',
          externalModelName: 'llama3',
        },
      ],
    };
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      (defaultModels.models as CustomModel[]).forEach((m) => {
        (m as unknown as Record<string, unknown>).encrypted = false;
      });
      const encrypted = cryptoStore.encryptModels(defaultModels.models);
      fs.writeFileSync(filePath, JSON.stringify({ models: encrypted }, null, 2), 'utf-8');
    } catch (e) {
      log.error('[Proxy] Failed to write default custom_models.json', e);
    }
    return cryptoStore.decryptModels(defaultModels.models);
  }

  try {
    const models = readModelConfig(filePath) as CustomModel[];

    // Auto-migration check
    const unprotected = (value: unknown) =>
      typeof value === 'string' && value && value !== 'none' && !/^(enc:|fallback:|local-gcm:)/.test(value);
    const needsMigration = models.some(
      (m) =>
        (!m.encrypted && unprotected(m.apiKey)) ||
        (!m.encryptedHeaders && Object.values(m.customHeaders || {}).some(unprotected)) ||
        (!m.encryptedGoogleAccounts &&
          (m.googleAccounts || []).some((account) =>
            [account.accessToken, account.refreshToken, account.clientSecret].some(unprotected),
          )),
    );
    if (needsMigration) {
      log.info('[Proxy] Plaintext custom_models.json detected. Migrating to encrypted format...');
      cryptoStore.backupFile(filePath);
      const encryptedModels = cryptoStore.encryptModels(models);
      for (const model of encryptedModels) {
        if (model.customHeaders && !model.encryptedHeaders) {
          model.customHeaders = Object.fromEntries(
            Object.entries(model.customHeaders).map(([name, value]) => [
              name,
              unprotected(value) ? cryptoStore.encryptString(value) : value,
            ]),
          );
          model.encryptedHeaders = true;
        }
        if (model.googleAccounts && !model.encryptedGoogleAccounts) {
          model.googleAccounts = model.googleAccounts.map((account) => {
            const encrypted = { ...account };
            for (const field of ['accessToken', 'refreshToken', 'clientSecret'])
              if (unprotected(encrypted[field])) encrypted[field] = cryptoStore.encryptString(encrypted[field]);
            return encrypted;
          });
          model.encryptedGoogleAccounts = true;
        }
      }
      try {
        writeJsonAtomic(filePath, { models: encryptedModels });
        log.info('[Proxy] Successfully migrated custom_models.json to encrypted format.');
        // Continue through validation and enabled filtering below.
      } catch (err) {
        log.error('[Proxy] Failed to write encrypted custom_models.json during migration:', err);
      }
    }

    const decrypted = cryptoStore.decryptModels(models) as CustomModel[];
    for (const model of decrypted) {
      if (/^(DECRYPTION_FAILED|enc:|fallback:|local-gcm:)/.test(model.apiKey || '')) {
        model.enabled = false;
        log.warn('[Proxy] Skipping a model whose API key could not be decrypted');
        continue;
      }
      if (model.googleAccounts) {
        model.googleAccounts = model.googleAccounts.flatMap((account) => {
          const decryptedAccount = { ...account };
          for (const field of ['accessToken', 'refreshToken', 'clientSecret'] as const) {
            const value = decryptedAccount[field];
            if (!value) continue;
            if (model.encryptedGoogleAccounts) decryptedAccount[field] = cryptoStore.decryptString(value);
            if (/^(DECRYPTION_FAILED|enc:|fallback:|local-gcm:)/.test(decryptedAccount[field] || '')) {
              log.warn('[Proxy] Skipping a Google account whose credentials could not be decrypted');
              return [];
            }
          }
          return [decryptedAccount];
        });
        model.encryptedGoogleAccounts = false;
      }
      if (model.encryptedHeaders && model.customHeaders) {
        model.customHeaders = Object.fromEntries(
          Object.entries(model.customHeaders).map(([key, value]) => {
            const decryptedHeader = cryptoStore.decryptString(value);
            if (/^(DECRYPTION_FAILED|enc:|fallback:|local-gcm:)/.test(decryptedHeader || '')) {
              model.enabled = false;
              log.warn('[Proxy] Skipping a model whose custom header could not be decrypted');
            }
            return [key, decryptedHeader];
          }),
        );
        model.encryptedHeaders = false;
      }
    }

    // Validate all models
    const validModels: CustomModel[] = [];
    for (let i = 0; i < decrypted.length; i++) {
      const validation = validateCustomModel(decrypted[i]) as { valid: boolean; error?: string };
      if (validation.valid) {
        if (decrypted[i].enabled !== false) validModels.push(decrypted[i]);
      } else {
        log.warn(`[Proxy] Skipping invalid model at index ${i}: ${validation.error}`);
      }
    }
    if (validModels.length < decrypted.length) {
      log.info(
        `[Proxy] Loaded ${validModels.length}/${decrypted.length} valid models (${decrypted.length - validModels.length} skipped)`,
      );
    }

    return validModels;
  } catch (e) {
    log.error('[Proxy] Failed to parse custom_models.json', e);
    return [];
  }
}

// ─── Google Proxy ─────────────────────────────────────────────────────────

function forwardingHeaders(source: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const headers = { ...source };
  const nominated = String(headers.connection || '')
    .split(',')
    .map((name) => name.trim().toLowerCase());
  for (const name of [
    ...nominated,
    'connection',
    'keep-alive',
    'transfer-encoding',
    'te',
    'trailer',
    'upgrade',
    'proxy-authenticate',
    'proxy-authorization',
  ]) {
    delete headers[name];
  }
  return headers;
}

/**
 * Rewrites one SSE `data:` payload from Google so a stock-model parent can
 * still hand a custom model to invoke_subagent. Non-data lines pass through;
 * malformed JSON is left untouched rather than corrupting the stream.
 */
function rewriteGoogleSseLine(
  line: string,
  subagent: { context: SubagentRoutingContext; resolve: SubagentModelResolver },
): string {
  if (!line.startsWith('data:')) return line;
  const rest = line.slice('data:'.length);
  const indent = rest.match(/^[ \t]*/)?.[0] || '';
  const payload = rest.slice(indent.length);
  if (!payload || payload === '[DONE]') return line;
  try {
    const chunk = JSON.parse(payload);
    if (chunk && Array.isArray(chunk.candidates)) {
      chunk.candidates = chunk.candidates.map((candidate: unknown) =>
        subagentRouting.rewriteCandidate(candidate, subagent.context, subagent.resolve),
      );
    }
    return `data:${indent}${JSON.stringify(chunk)}\n`;
  } catch {
    return line;
  }
}

function proxyToGoogle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  reqBody: Buffer,
  subagent?: { context: SubagentRoutingContext; resolve: SubagentModelResolver },
): void {  const isCloudCodeUrl = req.url!.includes('v1internal') || req.url!.includes('daily-cloudcode');
  const targetUrl = isCloudCodeUrl
    ? cloudCodeRouting?.resolve(req.headers) || 'https://daily-cloudcode-pa.googleapis.com'
    : 'https://generativelanguage.googleapis.com';
  const parsedUrl = new URL(req.url!, targetUrl);

  const headers = forwardingHeaders(req.headers);
  headers['host'] = parsedUrl.host;
  // Incoming request bodies have already been buffered and decoded by Node.
  // Never replay their chunked wire framing together with a content length.
  headers['content-length'] = String(reqBody.length);

  const isGeneration = req.url!.includes('generateContent') || req.url!.includes('streamGenerateContent');
  const shouldBufferAndModify = isCloudCodeUrl && !isGeneration;
  const rewritesSubagents = isGeneration && Boolean(subagent);

  // The subagent rewrite parses the streamed body, so it must be uncompressed.
  if (shouldBufferAndModify || rewritesSubagents) {
    delete headers['accept-encoding'];
  }

  const options: https.RequestOptions = {
    method: req.method,
    headers: headers as Record<string, string>,
  };

  const proxyReq = https.request(parsedUrl, options, (proxyRes) => {
    // P0-5: Timeout for Google proxy requests (60s)
    proxyReq.setTimeout(60_000, () => {
      log.error('[Proxy] Google proxy request timed out after 60s');
      proxyReq.destroy();
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Google API request timed out' } }));
      }
    });

    if (shouldBufferAndModify) {
      const responseChunks: Buffer[] = [];
      proxyRes.on('data', (chunk) => responseChunks.push(chunk));
      proxyRes.on('end', () => {
        const fullResBody = Buffer.concat(responseChunks);
        let text: string;
        const encoding = proxyRes.headers['content-encoding'];
        if (encoding === 'gzip') {
          try {
            const zlib = require('zlib');
            text = zlib.gunzipSync(fullResBody).toString('utf-8');
          } catch (e) {
            log.error('[Proxy] gunzipSync failed:', e);
            text = fullResBody.toString('utf-8');
          }
        } else {
          text = fullResBody.toString('utf-8');
        }

        log.info(
          `[Proxy] Response for ${req.url} (status: ${proxyRes.statusCode}, encoding: ${encoding}, length: ${text.length})`,
        );
        // P0-3: Response body content is NOT logged to disk. Only metadata.

        if (cloudCodeRouting && parsedUrl.pathname === '/v1internal:loadCodeAssist') {
          try {
            cloudCodeRouting.observe(req.headers, proxyRes.statusCode || 500, JSON.parse(text));
          } catch {
            /* Invalid responses must not change the account's upstream routing. */
          }
        }

        const proxyHost = req.headers.host || 'localhost';
        text = text.replace(/https:(\/\/)daily-cloudcode-pa\.googleapis\.com/g, `http:$1${proxyHost}`);
        text = text.replace(/https:(\/\/)cloudcode-pa\.googleapis\.com/g, `http:$1${proxyHost}`);
        text = text.replace(/https:(\/\/)generativelanguage\.googleapis\.com/g, `http:$1${proxyHost}`);

        const modifiedHeaders = forwardingHeaders(proxyRes.headers);
        delete modifiedHeaders['content-encoding'];

        const modifiedBuffer = Buffer.from(text, 'utf-8');
        modifiedHeaders['content-length'] = String(modifiedBuffer.length);

        res.writeHead(proxyRes.statusCode || 200, modifiedHeaders as Record<string, string>);
        res.end(modifiedBuffer);
      });
    } else if (rewritesSubagents) {
      const outHeaders = forwardingHeaders(proxyRes.headers);
      delete outHeaders['content-length'];
      res.writeHead(proxyRes.statusCode || 200, outHeaders as Record<string, string>);
      const isStream = req.url!.includes('streamGenerateContent') || req.url!.includes('alt=sse');
      if (!isStream) {
        const chunks: Buffer[] = [];
        proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
        proxyRes.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            res.end(JSON.stringify(subagentRouting.rewriteResponse(body, subagent.context, subagent.resolve)));
          } catch (e) {
            log.error('[Proxy] Failed to rewrite native subagent response:', e);
            res.end(Buffer.concat(chunks).toString('utf8'));
          }
        });
        return;
      }
      proxyRes.setEncoding('utf8');
      let buffer = '';
      proxyRes.on('data', (chunk: string) => {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl + 1);
          buffer = buffer.slice(nl + 1);
          res.write(rewriteGoogleSseLine(line, subagent));
        }
      });
      proxyRes.on('end', () => {
        if (buffer) res.write(rewriteGoogleSseLine(buffer, subagent));
        res.end();
      });
      proxyRes.on('error', (err) => {
        log.error('[Proxy] Google stream error:', err);
        if (!res.writableEnded) res.end();
      });
    } else {
      res.writeHead(proxyRes.statusCode || 200, forwardingHeaders(proxyRes.headers));
      proxyRes.pipe(res);
    }
  });

  proxyReq.on('error', (err) => {
    log.error('[Proxy] Google Forwarding Error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Proxy forwarding failed: ' + err.message } }));
  });

  if (reqBody) {
    proxyReq.write(reqBody);
  }
  proxyReq.end();
}

// ─── File Data Resolver ────────────────────────────────────────────────────

async function resolveFileData(
  body: GeminiRequestBody,
  reqHeaders: Record<string, string | string[] | undefined>,
): Promise<void> {
  const contents = body.contents;
  if (!contents) return;
  const authHeader = (reqHeaders['authorization'] || reqHeaders['Authorization'] || '') as string;
  for (const item of contents) {
    if (!item.parts) continue;
    for (let i = 0; i < item.parts.length; i++) {
      const p = item.parts[i] as Record<string, unknown>;
      const fd = p.fileData as { mimeType?: string; fileUri?: string } | undefined;
      if (!fd?.fileUri) continue;
      // Keep image bytes/URLs intact for the wire-format translator. In particular,
      // never decode a binary image as UTF-8 or send incoming Google credentials
      // to an arbitrary image URL. Remote images must be accessible to the provider.
      if (
        (typeof fd.mimeType === 'string' && /^image\//i.test(fd.mimeType.trim())) ||
        /^data:image\//i.test(fd.fileUri)
      )
        continue;
      try {
        const uri = fd.fileUri;
        let fileContent = '';
        if (uri.startsWith('file://')) {
          const fp = uri.replace('file://', '').replace(/\//g, path.sep);
          if (fs.existsSync(fp)) fileContent = fs.readFileSync(fp, 'utf-8');
        } else if (authHeader && uri.startsWith('https://')) {
          fileContent = await downloadFileContent(uri, authHeader);
        }
        if (fileContent) {
          (item.parts[i] as Record<string, unknown>) = { text: '[File content]:\n\n' + fileContent };
        }
      } catch (e) {
        log.warn('[Proxy] File resolve failed:', (e as Error).message);
      }
    }
  }
}

function downloadFileContent(url: string, authHeader: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    (u.protocol === 'https:' ? https : http)
      .request(
        {
          hostname: u.hostname,
          path: u.pathname + u.search,
          method: 'GET',
          headers: { Authorization: authHeader },
          timeout: 30000,
        },
        (res) => {
          if (res.statusCode !== 200) {
            reject(new Error('HTTP ' + res.statusCode));
            return;
          }
          let d = '';
          res.on('data', (c: Buffer) => (d += c.toString()));
          res.on('end', () => resolve(d));
        },
      )
      .on('error', reject)
      .end();
  });
}

// ─── Custom Model Request Handler ─────────────────────────────────────────

function handleCustomModelRequest(
  res: http.ServerResponse,
  model: CustomModel,
  body: GeminiRequestBody,
  isStream: boolean,
  cloudEnvelope = true,
): void {
  void runCustomModelRequest(
    res,
    model,
    body as import('./proxy/requestOptions').GeminiBody,
    isStream,
    loadCustomModels(),
    cloudEnvelope,
  );
}

// ─── Protobuf Utilities ────────────────────────────────────────────────────

interface ProtoField {
  tag: number; // full tag (field_number << 3 | wire_type)
  wireType: number;
  fieldNum: number;
  value: number | Buffer | ProtoField[];
  start: number;
  end: number;
}

function readVarint(buf: Buffer, offset: number): { value: number; bytes: number } {
  let result = 0;
  let shift = 0;
  let bytes = 0;
  while (offset + bytes < buf.length) {
    const byte = buf[offset + bytes];
    result |= (byte & 0x7f) << shift;
    bytes++;
    if (!(byte & 0x80)) break;
    shift += 7;
  }
  return { value: result >>> 0, bytes };
}

function encodeVarint(value: number): Buffer {
  const parts: number[] = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    parts.push(b);
  } while (v !== 0);
  return Buffer.from(parts);
}

function parseProto(buf: Buffer, offset: number, end: number): ProtoField[] {
  const fields: ProtoField[] = [];
  let pos = offset;
  while (pos < end) {
    const start = pos;
    const tagVarint = readVarint(buf, pos);
    const tag = tagVarint.value;
    const wireType = tag & 0x07;
    const fieldNum = tag >>> 3;
    pos += tagVarint.bytes;

    if (wireType === 0) {
      const v = readVarint(buf, pos);
      fields.push({ tag, wireType, fieldNum, value: v.value, start, end: pos + v.bytes });
      pos += v.bytes;
    } else if (wireType === 2) {
      const lenVarint = readVarint(buf, pos);
      pos += lenVarint.bytes;
      const len = lenVarint.value;
      const children = parseProto(buf, pos, pos + len);
      const hasChildren = children.length > 0;
      fields.push({
        tag,
        wireType,
        fieldNum,
        value: hasChildren ? children : buf.subarray(pos, pos + len),
        start,
        end: pos + len,
      });
      pos += len;
    } else if (wireType === 1) {
      fields.push({ tag, wireType, fieldNum, value: buf.subarray(pos, pos + 8), start, end: pos + 8 });
      pos += 8;
    } else if (wireType === 5) {
      fields.push({ tag, wireType, fieldNum, value: buf.subarray(pos, pos + 4), start, end: pos + 4 });
      pos += 4;
    } else {
      break;
    }
  }
  return fields;
}

function encodeProtoBuf(fields: { tag: number; value: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  for (const field of fields) {
    const tagBuf = encodeVarint(field.tag);
    const data = field.value;
    const lenBuf = encodeVarint(data.length);
    parts.push(tagBuf, lenBuf, data);
  }
  return Buffer.concat(parts);
}

function findModelEntryFieldTag(fields: ProtoField[]): number | null {
  const tagCounts = new Map<number, number>();
  for (const f of fields) {
    if (f.wireType === 2) {
      tagCounts.set(f.tag, (tagCounts.get(f.tag) || 0) + 1);
    }
  }
  let bestTag: number | null = null;
  let bestCount = 0;
  for (const [tag, count] of tagCounts) {
    if (count > bestCount) {
      bestCount = count;
      bestTag = tag;
    }
  }
  if (bestTag !== null && bestCount >= 2) {
    // Verify it has nested messages
    const sample = fields.find((f) => f.tag === bestTag && Array.isArray(f.value));
    if (sample) return bestTag;
  }
  return bestTag;
}

function extractFieldMapping(entry: ProtoField[]): Map<number, 'string' | 'varint' | 'bytes'> {
  const mapping = new Map<number, 'string' | 'varint' | 'bytes'>();
  for (const f of entry) {
    if (f.wireType === 2 && Buffer.isBuffer(f.value)) {
      mapping.set(f.fieldNum, 'string');
    } else if (f.wireType === 0) {
      mapping.set(f.fieldNum, 'varint');
    } else if (f.wireType === 2 && Array.isArray(f.value)) {
      mapping.set(f.fieldNum, 'bytes');
    }
  }
  return mapping;
}

function encodeModelEntryForGetModels(
  name: string,
  displayName: string,
  mapping: Map<number, 'string' | 'varint' | 'bytes'>,
): Buffer {
  const fields: { tag: number; value: Buffer }[] = [];
  for (const [fieldNum, protoType] of mapping) {
    if (protoType === 'string') {
      const tag = (fieldNum << 3) | 2;
      if (fieldNum === 1) {
        fields.push({ tag, value: Buffer.from(name, 'utf-8') });
      } else if (fieldNum === 2) {
        fields.push({ tag, value: Buffer.from(displayName, 'utf-8') });
      } else {
        fields.push({ tag, value: Buffer.alloc(0) });
      }
    } else if (protoType === 'varint') {
      const tag = (fieldNum << 3) | 0;
      fields.push({ tag, value: encodeVarint(0) });
    } else {
      const tag = (fieldNum << 3) | 2;
      fields.push({ tag, value: Buffer.alloc(0) });
    }
  }
  return encodeProtoBuf(fields);
}

// ─── GetAvailableModels Proxy Handler ───────────────────────────────────────

function handleGetAvailableModelsProxy(res: http.ServerResponse, reqBody: Buffer, lsUrl: string): void {
  let lsParsed: URL;
  try {
    lsParsed = new URL(lsUrl);
    if (!['http:', 'https:'].includes(lsParsed.protocol)) throw new Error('Invalid protocol');
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid language server URL' } }));
    return;
  }
  const client = lsParsed.protocol === 'https:' ? https : http;

  const options: https.RequestOptions = {
    method: 'POST',
    hostname: lsParsed.hostname,
    port: lsParsed.port || (lsParsed.protocol === 'https:' ? '443' : '80'),
    path: lsParsed.pathname + lsParsed.search,
    headers: {
      'Content-Type': 'application/grpc-web+proto',
      Accept: 'application/grpc-web+proto',
      'Content-Length': String(reqBody.length),
    },
    rejectUnauthorized: false,
  };

  const lsReq = client.request(options, (lsRes) => {
    const chunks: Buffer[] = [];
    lsRes.on('data', (chunk: Buffer) => chunks.push(chunk));
    lsRes.on('end', () => {
      const responseBuf = Buffer.concat(chunks);
      const customModels = loadCustomModels();
      const identities = modelIdentities(customModels);
      let modifiedBuf = responseBuf;

      if (customModels.length > 0 && responseBuf.length > 6) {
        try {
          const flags = responseBuf[0];
          const msgLen = responseBuf.readUInt32BE(1);
          if (5 + msgLen <= responseBuf.length) {
            const msgBody = responseBuf.subarray(5, 5 + msgLen);
            const parsed = parseProto(msgBody, 0, msgBody.length);
            const modelTag = findModelEntryFieldTag(parsed);

            if (modelTag !== null) {
              const sampleEntry = parsed.find((f) => f.tag === modelTag && Array.isArray(f.value));
              if (sampleEntry && Array.isArray(sampleEntry.value)) {
                const fieldMapping = extractFieldMapping(sampleEntry.value);
                const newParts: Buffer[] = [msgBody];

                for (const m of customModels) {
                  const placeholderId = identities.get(m.name)?.placeholderId;
                  if (!placeholderId) continue;
                  const entry = encodeModelEntryForGetModels('models/' + placeholderId, m.displayName, fieldMapping);
                  const tagBuf = encodeVarint(modelTag);
                  const lenBuf = encodeVarint(entry.length);
                  newParts.push(tagBuf, lenBuf, entry);
                  log.info(`[Proxy] Injected into GetAvailableModels: ${m.displayName} => ${placeholderId}`);
                }

                const newMsgBody = Buffer.concat(newParts);
                const newHeader = Buffer.alloc(5);
                newHeader[0] = flags;
                newHeader.writeUInt32BE(newMsgBody.length, 1);
                modifiedBuf = Buffer.concat([newHeader, newMsgBody]);
              }
            }
          }
        } catch (err) {
          log.error('[Proxy] Failed to inject models into GetAvailableModels:', err);
        }
      }

      res.writeHead(lsRes.statusCode || 200, {
        'Content-Type': 'application/grpc-web+proto',
        'Content-Length': String(modifiedBuf.length),
      });
      res.end(modifiedBuf);
    });

    lsRes.on('error', (err) => {
      log.error('[Proxy] LS error for GetAvailableModels:', err.message);
      if (!res.headersSent) {
        res.writeHead(502);
        res.end();
      }
    });
  });

  lsReq.setTimeout(30_000, () => {
    log.error('[Proxy] GetAvailableModels forward timed out');
    lsReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504);
      res.end();
    }
  });

  lsReq.on('error', (err) => {
    log.error('[Proxy] GetAvailableModels forward error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502);
      res.end();
    }
  });

  lsReq.write(reqBody);
  lsReq.end();
}

// ─── Main Request Handler ─────────────────────────────────────────────────

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  let requestUrl: URL;
  try {
    req.url = (req.url || '/').replace(/^.*\/dummy_path_padding/, '');
    // Strip binary patch padding (from LS hostname replacement)
    req.url = req.url.replace(/\/v1internal\/x{7}/, '');
    // This listener routes fixed upstreams; authority-form targets must never replace them.
    if (!req.url.startsWith('/') || /^[\\/]{2}/.test(req.url)) throw new Error('Invalid target');
    requestUrl = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid request target' } }));
    return;
  }

  // Health check
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) {
    const memUsage = process.memoryUsage();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        uptime: process.uptime(),
        port: proxyPort,
        memory: {
          rssMB: Math.round(memUsage.rss / 1024 / 1024),
          heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
          heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
        },
        state: {
          activeStreamContexts: activeStreamContexts.size,
          modelToolCallIds: modelToolCallIds.size,
          translatedToolCalls: translatedToolCalls.size,
          modelReasoningContent: modelReasoningContent.size,
        },
        timestamp: new Date().toISOString(),
      }),
    );
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(getProxyMetrics()));
    return;
  }

  // P0-4: Enforce maximum request body size to prevent memory exhaustion DoS
  const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB
  let bodyLength = 0;
  let bodyRejected = false;

  const bodyChunks: Buffer[] = [];
  req.on('data', (chunk) => {
    bodyLength += chunk.length;
    if (bodyLength > MAX_BODY_SIZE) {
      if (!bodyRejected) {
        bodyRejected = true;
        log.warn(`[Proxy] Request body exceeds ${MAX_BODY_SIZE / 1024 / 1024}MB limit (${req.method} ${req.url})`);
        req.destroy();
        if (!res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ error: { message: `Request body too large. Maximum: ${MAX_BODY_SIZE / 1024 / 1024}MB` } }),
          );
        }
      }
      return;
    }
    bodyChunks.push(chunk);
  });
  req.on('end', () => {
    if (bodyRejected) return;

    const fullBody = Buffer.concat(bodyChunks);
    const bodyStr = fullBody.toString('utf-8');

    log.info(`[Proxy] Request: ${req.method} ${req.url}`);

    // 0. Intercept GetAvailableModels (redirected from Electron webRequest)
    if (req.url!.startsWith('/GetAvailableModels')) {
      const gavParsed = new URL(req.url!, 'http://127.0.0.1');
      const lsUrl = gavParsed.searchParams.get('ls');
      if (lsUrl) {
        handleGetAvailableModelsProxy(res, fullBody, lsUrl);
        return;
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing ls parameter' }));
      return;
    }

    // 1. Intercept /v1internal:fetchAvailableModels
    if (req.url!.includes('/v1internal:fetchAvailableModels')) {
      log.info('[Proxy] Intercepting fetchAvailableModels request');

      const targetUrl = cloudCodeRouting?.resolve(req.headers) || 'https://daily-cloudcode-pa.googleapis.com';
      const parsedUrl = new URL(req.url!, targetUrl);
      const fwdHeaders = forwardingHeaders(req.headers);
      fwdHeaders['host'] = parsedUrl.host;
      fwdHeaders['content-length'] = String(fullBody.length);
      delete fwdHeaders['accept-encoding'];

      const fwdOptions: https.RequestOptions = {
        method: req.method,
        headers: fwdHeaders as Record<string, string>,
      };

      let responded = false;
      const reply = (catalog: unknown = {}) => {
        if (responded || res.headersSent || res.writableEnded || res.destroyed) return;
        responded = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(customCloudCodeCatalog(catalog)));
      };
      const googleReq = https.request(parsedUrl, fwdOptions, (googleRes) => {
        const chunks: Buffer[] = [];
        let length = 0;
        googleRes.on('data', (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          length += bytes.length;
          if (length > 8 * 1024 * 1024) {
            reply();
            googleReq.destroy();
            return;
          }
          chunks.push(bytes);
        });
        googleRes.on('error', () => reply());
        googleRes.on('aborted', () => reply());
        googleRes.on('end', () => {
          if (!googleRes.statusCode || googleRes.statusCode < 200 || googleRes.statusCode >= 300) {
            reply();
            return;
          }
          try {
            reply(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reply();
          }
        });
      });
      // Install before headers arrive: an upstream that never sends headers still gets a bounded fallback.
      googleReq.setTimeout(30_000, () => {
        reply();
        googleReq.destroy();
      });
      googleReq.on('error', () => reply());

      if (fullBody && fullBody.length > 0) {
        googleReq.write(fullBody);
      }
      googleReq.end();
      return;
    }

    // 2. Intercept /v1beta/models or /v1/models list request
    if (req.method === 'GET' && (req.url!.endsWith('/models') || req.url!.includes('/models?'))) {
      log.info('[Proxy] Intercepting models list request');

      const targetUrl = 'https://generativelanguage.googleapis.com';
      const parsedUrl = new URL(req.url!, targetUrl);
      const mdlHeaders: Record<string, string | string[] | undefined> = {
        ...(req.headers as Record<string, string | string[] | undefined>),
      };
      mdlHeaders['host'] = 'generativelanguage.googleapis.com';
      delete mdlHeaders['connection'];
      delete mdlHeaders['accept-encoding'];

      const mdlOptions: https.RequestOptions = { method: 'GET', headers: mdlHeaders as Record<string, string> };

      const googleReq = https.request(parsedUrl, mdlOptions, (googleRes) => {
        // P0-5: Timeout for models list forward request (30s)
        googleReq.setTimeout(30_000, () => {
          log.error('[Proxy] Models list forward request timed out');
          googleReq.destroy();
          if (!res.headersSent) {
            const customModels = loadCustomModels();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                models: customModels.map((m) => ({
                  name: m.name,
                  displayName: m.displayName,
                  description: m.description,
                  ...getAdvertisedModelCapabilities(m),
                  supportedGenerationMethods: ['generateContent'],
                })),
              }),
            );
          }
        });

        let googleBody = '';
        googleRes.on('data', (chunk) => (googleBody += chunk));
        googleRes.on('end', () => {
          try {
            const googleJson = JSON.parse(googleBody) as { models?: unknown[] };
            const customModels = loadCustomModels();

            const mappedCustom = customModels.map((m) => ({
              name: m.name,
              version: '1.0',
              displayName: m.displayName,
              description: m.description,
              ...getAdvertisedModelCapabilities(m),
              inputTokenLimit: detectModelCapabilities(m).maxTokens,
              outputTokenLimit: detectModelCapabilities(m).maxOutputTokens,
              supportedGenerationMethods: ['generateContent', 'countTokens'],
              temperature: 0.7,
              topP: 0.9,
              topK: 40,
            }));

            if (googleJson.models) {
              googleJson.models = [...mappedCustom, ...googleJson.models];
            } else {
              googleJson.models = mappedCustom;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(googleJson));
          } catch (err) {
            log.error('[Proxy] Google list models failed, returning custom models list only:', err);
            const customModels = loadCustomModels();
            const mappedCustom = customModels.map((m) => ({
              name: m.name,
              version: '1.0',
              displayName: m.displayName,
              description: m.description,
              ...getAdvertisedModelCapabilities(m),
              inputTokenLimit: detectModelCapabilities(m).maxTokens,
              outputTokenLimit: detectModelCapabilities(m).maxOutputTokens,
              supportedGenerationMethods: ['generateContent', 'countTokens'],
            }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ models: mappedCustom }));
          }
        });
      });

      googleReq.on('error', (err) => {
        log.error('[Proxy] Google models list request error:', err);
        const customModels = loadCustomModels();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            models: customModels.map((m) => ({
              name: m.name,
              displayName: m.displayName,
              description: m.description,
              ...getAdvertisedModelCapabilities(m),
              supportedGenerationMethods: ['generateContent'],
            })),
          }),
        );
      });
      googleReq.end();
      return;
    }

    // 3. Intercept Cloud Code generation stream or non-stream requests
    const isCloudCodeStream =
      req.url!.includes('/v1internal:streamGenerateContent') || req.url!.includes('/v1internal:generateContent');
    if (req.method === 'POST' && isCloudCodeStream) {
      try {
        const reqJson = JSON.parse(bodyStr) as Record<string, unknown>;
        const modelName = reqJson.model;
        const modelId = reqJson.modelId ?? reqJson.model_id;
        log.info(
          `[Proxy] Cloud Code generation request model: ${modelName}, modelId: ${modelId}, url: ${req.url}, bodyKeys: ${Object.keys(reqJson).join(',')}`,
        );
        {
          const customModels = loadCustomModels();
          const actualGeminiBody = { ...((reqJson.request || reqJson) as GeminiRequestBody) };
          if (typeof reqJson.sessionId === 'string') actualGeminiBody.sessionId = reqJson.sessionId;
          if (typeof reqJson.conversationId === 'string') actualGeminiBody.conversationId = reqJson.conversationId;
          if (!actualGeminiBody.labels && reqJson.labels && typeof reqJson.labels === 'object')
            actualGeminiBody.labels = reqJson.labels as Record<string, unknown>;
          const prepared = subagentRouting.prepareRequest(
            actualGeminiBody,
            (selector) => resolveConfiguredSubagentModel(customModels, selector)?.name,
          );
          const matchedCustomModel = prepared.modelName
            ? resolveConfiguredSubagentModel(customModels, prepared.modelName)
            : matchCustomModel(customModels, modelName, modelId);
          if (matchedCustomModel) {
            log.info(
              `[Proxy] Intercepting Cloud Code generation for custom model: ${modelName} => ${matchedCustomModel.displayName}`,
            );
            const isStream = req.url!.includes('streamGenerateContent') || req.url!.includes('alt=sse');
            // Resolve fileData URIs then route to translator
            resolveFileData(
              prepared.body as GeminiRequestBody,
              req.headers as Record<string, string | string[] | undefined>,
            ).then(() => {
              handleCustomModelRequest(res, matchedCustomModel, prepared.body as GeminiRequestBody, isStream);
            });
            return;
          }
          // Restore a switched parent's history, keeping the native tool schema.
          const nativeBody = {
            ...((reqJson.request || reqJson) as Record<string, unknown>),
            contents: prepared.body.contents,
          };
          const forwarded = reqJson.request ? { ...reqJson, request: nativeBody } : { ...reqJson, ...nativeBody };
          proxyToGoogle(req, res, Buffer.from(JSON.stringify(forwarded)), {
            context: prepared.context,
            resolve: (selector) => resolveConfiguredSubagentModel(customModels, selector)?.name,
          });
          return;
        }
      } catch (err) {
        if (err instanceof SubagentRoutingError) {
          res.writeHead(err.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: err.message } }));
          return;
        }
        log.error('[Proxy] Failed to parse Cloud Code stream body:', err);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid Cloud Code generation request body' } }));
        return;
      }
    }

    // 4. Intercept standard generateContent / streamGenerateContent request
    const generateMatch = req.url!.match(/\/(?:v1|v1beta)\/(models\/[^:]+):generateContent/);
    const streamMatch = req.url!.match(/\/(?:v1|v1beta)\/(models\/[^:]+):streamGenerateContent/);

    const isGenerate = !!generateMatch;
    const isStandardStream = !!streamMatch;

    if (req.method === 'POST' && (isGenerate || isStandardStream)) {
      let matchedModelName: string;
      try {
        matchedModelName = decodeURIComponent(isGenerate ? generateMatch![1] : streamMatch![1]);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid model URL encoding' } }));
        return;
      }
      const customModels = loadCustomModels();
      try {
        const geminiBody = JSON.parse(bodyStr) as GeminiRequestBody;
        const prepared = subagentRouting.prepareRequest(
          geminiBody,
          (selector) => resolveConfiguredSubagentModel(customModels, selector)?.name,
        );
        const matchedCustomModel = prepared.modelName
          ? resolveConfiguredSubagentModel(customModels, prepared.modelName)
          : matchCustomModel(customModels, matchedModelName);
        if (matchedCustomModel) {
          resolveFileData(
            prepared.body as GeminiRequestBody,
            req.headers as Record<string, string | string[] | undefined>,
          ).then(() => {
            handleCustomModelRequest(
              res,
              matchedCustomModel,
              prepared.body as GeminiRequestBody,
              isStandardStream,
              false,
            );
          });
          return;
        }
        proxyToGoogle(req, res, Buffer.from(JSON.stringify({ ...geminiBody, contents: prepared.body.contents })), {
          context: prepared.context,
          resolve: (selector) => resolveConfiguredSubagentModel(customModels, selector)?.name,
        });
        return;
      } catch (e) {
        log.error('[Proxy] JSON parse error in request body:', e);
        res.writeHead(e instanceof SubagentRoutingError ? e.status : 400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: e instanceof SubagentRoutingError ? e.message : 'Invalid JSON request body' },
          }),
        );
        return;
      }
    }

    // 5. Fallback: transparent proxy to Google
    proxyToGoogle(req, res, fullBody);
  });
}

// ─── Server Start/Stop ────────────────────────────────────────────────────

export async function startProxy(options: ProxyStartOptions = {}): Promise<number> {
  if (stoppingProxy) await stoppingProxy;
  if (server?.listening && proxyPort) return proxyPort;
  if (startingProxy) return startingProxy;

  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) {
    throw new Error('Proxy port must be an integer between 1 and 65535');
  }
  serviceDataDirectory = options.dataDirectory ? path.resolve(options.dataDirectory) : undefined;
  shutdownGraceMs = options.shutdownGraceMs;
  cloudCodeRouting = options.ideCloudCodeRouting ? new CloudCodeRouting() : undefined;
  const requiredPort = options.port ?? getRequiredProxyPort(require('electron').app.getAppPath());
  const newServer = http.createServer((req, res) => {
    if (!options.handleManagement?.(req, res)) handleRequest(req, res);
  });
  server = newServer;
  startCleanupInterval();
  startingProxy = listenProxy(newServer, requiredPort ?? 50999, requiredPort === undefined)
    .then((port) => {
      proxyPort = port;
      log.info(`[Proxy] Server listening on http://127.0.0.1:${proxyPort}`);
      return proxyPort;
    })
    .catch((error) => {
      stopCleanupInterval();
      server = null;
      proxyPort = 0;
      log.error('[Proxy] Startup failed:', error);
      throw error;
    })
    .finally(() => {
      startingProxy = null;
    });
  return startingProxy;
}

export function stopProxy(): Promise<void> {
  if (stoppingProxy) return stoppingProxy;
  stoppingProxy = (async () => {
    // A shutdown requested during startup must also close the listener once ready.
    if (startingProxy) {
      try {
        await startingProxy;
      } catch {
        // A failed start already cleared its server and cleanup interval.
      }
    }
    stopCleanupInterval();
    stopCustomRequests();
    subagentRouting.clear();
    cloudCodeRouting?.clear();
    if (server) {
      const closingServer = server;
      await new Promise<void>((resolve) => {
        const timer =
          shutdownGraceMs === undefined
            ? undefined
            : setTimeout(() => closingServer.closeAllConnections(), shutdownGraceMs);
        timer?.unref?.();
        closingServer.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      log.info('[Proxy] Server stopped');
    }
    server = null;
    proxyPort = 0;
  })().finally(() => {
    stoppingProxy = null;
  });
  return stoppingProxy;
}

export function getProxyPort(): number {
  return proxyPort;
}
